#!/usr/bin/env bash
# claude-chat dev control script.
# Usage:
#   scripts/dev.sh start   # start server + web in background
#   scripts/dev.sh stop    # stop both
#   scripts/dev.sh restart
#   scripts/dev.sh status
#   scripts/dev.sh logs [server|web]   # tail -f the log (default: both)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${ROOT}/.run"
LOG_DIR="${RUN_DIR}/logs"
mkdir -p "${LOG_DIR}"

# Load local.env (scripts/local.env by default) before anything else so
# subsequent defaults can still be overridden by the caller's environment.
# CLAUDE_CHAT_ENV_FILE lets you point at a different file for e.g. CI.
ENV_FILE="${CLAUDE_CHAT_ENV_FILE:-${ROOT}/scripts/local.env}"
if [[ -f "${ENV_FILE}" ]]; then
  echo "[env] loading ${ENV_FILE}"
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
else
  echo "[env] no env file at ${ENV_FILE} (skipping)"
fi

SERVER_PID="${RUN_DIR}/server.pid"
WEB_PID="${RUN_DIR}/web.pid"
SERVER_LOG="${LOG_DIR}/server.log"
WEB_LOG="${LOG_DIR}/web.log"

SERVER_PORT="${PORT:-3000}"
WEB_PORT="${WEB_PORT:-5173}"

# CLAUDE_CHAT_AUTO_ALLOW_ALL: honor whatever local.env set; otherwise default
# to "1" (auto-allow) to preserve prior dev.sh behavior.
export CLAUDE_CHAT_AUTO_ALLOW_ALL="${CLAUDE_CHAT_AUTO_ALLOW_ALL:-1}"

is_alive() {
  local pid_file="$1"
  [[ -f "${pid_file}" ]] || return 1
  local pid
  pid="$(cat "${pid_file}")"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

start_one() {
  local name="$1" cmd="$2" pid_file="$3" log_file="$4"
  if is_alive "${pid_file}"; then
    echo "[${name}] already running (pid=$(cat "${pid_file}"))"
    return 0
  fi
  echo "[${name}] starting..."
  # Run detached from this shell; its own children (tsx/vite) will live on.
  ( cd "${ROOT}" && nohup bash -c "${cmd}" >"${log_file}" 2>&1 & echo $! >"${pid_file}" )
  sleep 0.4
  if is_alive "${pid_file}"; then
    echo "[${name}] pid=$(cat "${pid_file}")  log=${log_file}"
  else
    echo "[${name}] failed to start — see ${log_file}"
    return 1
  fi
}

stop_one() {
  local name="$1" pid_file="$2"
  if ! is_alive "${pid_file}"; then
    echo "[${name}] not running"
    rm -f "${pid_file}"
    return 0
  fi
  local pid
  pid="$(cat "${pid_file}")"
  echo "[${name}] stopping pid=${pid} (+ descendants)"
  # Walk the descendant tree and TERM bottom-up. Do NOT use pgid kill — server
  # and web share the parent shell's pgid when launched from the same script.
  local descendants
  descendants="$(collect_descendants "${pid}")"
  for d in ${descendants}; do
    kill -TERM "${d}" 2>/dev/null || true
  done
  kill -TERM "${pid}" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8; do
    is_alive "${pid_file}" || break
    sleep 0.3
  done
  if is_alive "${pid_file}"; then
    echo "[${name}] force-killing"
    for d in ${descendants}; do
      kill -KILL "${d}" 2>/dev/null || true
    done
    kill -KILL "${pid}" 2>/dev/null || true
  fi
  # Even if the top pid is gone, descendants may linger (tsx watcher, vite).
  for d in ${descendants}; do
    kill -KILL "${d}" 2>/dev/null || true
  done
  rm -f "${pid_file}"
}

collect_descendants() {
  # Emit all descendants of $1 (children, grandchildren, …) in leaf-first order.
  local root="$1"
  local queue="${root}"
  local all=""
  while [[ -n "${queue}" ]]; do
    local next=""
    for p in ${queue}; do
      local kids
      kids="$(pgrep -P "${p}" 2>/dev/null || true)"
      next="${next} ${kids}"
      all="${all} ${kids}"
    done
    queue="${next# }"
  done
  # reverse order so leaves go first
  echo "${all}" | tr ' ' '\n' | awk 'NF' | tac 2>/dev/null || echo "${all}" | tr ' ' '\n' | awk 'NF' | awk '{a[NR]=$0} END{for(i=NR;i>0;i--) print a[i]}'
}

status_one() {
  local name="$1" pid_file="$2" port="$3"
  if is_alive "${pid_file}"; then
    echo "[${name}] running pid=$(cat "${pid_file}")  port=${port}"
  else
    echo "[${name}] stopped"
  fi
}

case "${1:-}" in
  start)
    start_one "server" "pnpm dev:server" "${SERVER_PID}" "${SERVER_LOG}"
    start_one "web"    "pnpm dev:web"    "${WEB_PID}"    "${WEB_LOG}"
    echo
    echo "server:  http://127.0.0.1:${SERVER_PORT}/healthz"
    echo "web:     http://localhost:${WEB_PORT}/"
    echo "logs:    scripts/dev.sh logs"
    ;;
  stop)
    stop_one "web"    "${WEB_PID}"
    stop_one "server" "${SERVER_PID}"
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    status_one "server" "${SERVER_PID}" "${SERVER_PORT}"
    status_one "web"    "${WEB_PID}"    "${WEB_PORT}"
    ;;
  logs)
    target="${2:-both}"
    case "${target}" in
      server) tail -F "${SERVER_LOG}" ;;
      web)    tail -F "${WEB_LOG}" ;;
      both|"") tail -F "${SERVER_LOG}" "${WEB_LOG}" ;;
      *) echo "usage: $0 logs [server|web|both]"; exit 2 ;;
    esac
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs [server|web|both]}"
    exit 2
    ;;
esac
