# CLAUDE.md

给 Claude Code 在本仓库工作时的向导。

## 项目

`claude-chat` —— 浏览器端的 Claude Code 聊天客户端。Web UI 通过单条 WebSocket
和 Node 后端通讯；后端为每条 WS 连接用 ACP（Agent Client Protocol）桥接一个
Claude Code 子进程，并把会话元信息持久化到 SQLite。面向用户的介绍与环境变量
表见 `README.md`。

## 目录结构（pnpm workspace）

```
shared/   前后端共享的 WS 协议类型
server/   Fastify + ws + ACP 桥 + SQLite（Node、TS、ESM）
web/      Vite + React + Tailwind + zustand
scripts/  dev.sh（start/stop/logs）、local.env（环境变量覆盖）
docs/     PLAN.md、设计笔记
```

- `pnpm-workspace.yaml` 声明三个子包
- `tsconfig.base.json` 放共享 TS 设置，各子包 extends

## 常用命令

```bash
# 安装（仓库根）
pnpm install

# 开发（两个终端，或直接用 scripts/dev.sh）
pnpm dev:server     # tsx watch server/src/main.ts
pnpm dev:web        # vite（5173 端口，把 /ws 代理到 :3000）

# 托管式开发（自动加载 scripts/local.env，后台运行，日志在 .run/logs/）
scripts/dev.sh start | stop | restart | status | logs [server|web|both]

# 全量构建
pnpm -r build

# 测试（server 有基于 node:test 的单测）
cd server && pnpm test
```

## 运行时架构

- **每条 WS 连接一份 ACP bridge**。`server/src/ws-gateway.ts` 在连接建立时创建
  bridge、断开时 `dispose`；会话存在于 bridge 内。**副作用：浏览器刷新会取消
  该连接下所有正在执行的 prompt**（见 `socket.on("close")` 的 cancel 循环）。
- **workspaceId 与 sessionId 不同**。`workspaceId` 是对用户稳定的 id（进入 URL
  的 `?w=`、作 DB 主键）；`sessionId` 是 Claude CLI 内部 id，可被替换。当
  `loadSession` 失败（常因用户发首条 prompt 前就刷新，Claude CLI 从未落盘该会
  话），服务端会用同一 cwd `newSession` 兜底，更新 `sessions.session_id`，并通
  过 `session.loaded { previousSessionId }` 告知前端把 store key 迁移过去。
- **持久化**。`~/.claude-chat/db.sqlite`（元信息）+
  `~/.claude-chat/workspaces/<workspaceId>/`（每会话 cwd）。Claude CLI 自己把
  对话 JSONL 写在 `~/.claude/projects/<cwd-slug>/`。
- **错误必须对用户可见**。服务端发的 `error` WS 消息在前端会渲染成右下角红色
  Toast（`web/src/components/layout/Toasts.tsx`）；收到 error 或 WS 断开时，
  store 同时会把卡住的 `promptRunning` 清零。

## 约定

- TypeScript strict，仅 ESM，不得引入 CommonJS
- zustand（`web/src/store/sessions.ts`）一律不可变更新 —— 永远返回新对象，不要
  原地改 state
- 日志统一用 `pino`。`LOG_FILE` 已设 ⇒ 只写文件；未设 ⇒ 仅输出 stdout（dev 下
  pino-pretty，prod 下 JSON）
- Claude CLI 子进程由 `@agentclientprotocol/claude-agent-acp` 启动，不要自己
  spawn
- `scripts/local.env` 是开发环境变量的唯一入口。该文件已 gitignore——协议级别
  的变量增删应更新 README 的环境变量表
- 不要重新引入 slash-command UI：Claude CLI 会把首字符 `/` 视为内置命令，因
  此 composer 对 `/` 开头的用户文本会 prepend 零宽空格（U+200B）来抑制这一
  行为

## 写代码时

- 文件保持小而聚焦，一个关注点一个文件。宁可新建也别把单文件扩到 800 行以上
- 改动 WS 协议必须同步更新 `shared/src/protocol.ts` + server + web 三侧，完成
  前跑 `pnpm -r build`
- 不要加"以防万一"的错误处理 / 兼容 shim；只处理真实发生过的失败路径
- 结束前做类型检查：`cd server && npx tsc --noEmit` 与
  `cd web && npx tsc --noEmit`
