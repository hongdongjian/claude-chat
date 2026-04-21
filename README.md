# Claude Chat

基于 [`@agentclientprotocol/claude-agent-acp`](https://github.com/anthropics/agent-client-protocol) 的浏览器端 Claude Code 聊天客户端。

- 浏览器里新建会话 → 后端进程内桥接到 Claude Code SDK → 实时看到思考、工具调用、文件读写、终端输出与最终答复。
- 多会话并行，SQLite 持久化历史；刷新页面会取消当前任务并重建连接，但会话仍在，重新发送即可继续。
- 支持图片粘贴上传、权限请求弹窗、`ask_user` MCP 交互、会话重命名与清理。
- URL 携带 `?w=<workspaceId>`，刷新和分享可回到同一会话。

## 先决条件

1. **Node.js ≥ 22**（使用内置 `node:sqlite`，需 22.5+ 或 23+）、**pnpm ≥ 10**
2. 机器上已登录 Claude（`claude /login`），或通过 `CLAUDE_CODE_EXECUTABLE` 指定可用的 claude 二进制
3. `@anthropic-ai/claude-agent-sdk` 的平台相关原生二进制需要被安装（`pnpm install` 时**不要** 加 `--omit=optional`）

## 快速开始

```bash
# 1. 安装依赖（根目录一次搞定，pnpm workspace）
pnpm install

# 2. 开发模式：后端 + 前端分别启动
pnpm dev:server   # 终端 1，默认 ws://127.0.0.1:3000/ws
pnpm dev:web      # 终端 2，打开 http://localhost:5173
```

前端 Vite dev server 会把 `/ws` 代理到后端，直接访问 5173 即可。

## 构建与生产运行

```bash
# 一次构建全部子包
pnpm -r build

# 生产启动后端（静态资源由反向代理或另配 Vite preview 服务）
NODE_ENV=production \
PORT=3000 HOST=0.0.0.0 \
LOG_FILE=/var/log/claude-chat/server.log \
node server/dist/main.js
```

## 环境变量

### 后端（`server/`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP / WebSocket 监听端口 |
| `HOST` | `127.0.0.1` | 绑定地址，部署到外网用 `0.0.0.0` |
| `NODE_ENV` | 未设 | 设为 `production` 关闭 pino-pretty，走 JSON 输出 |
| `CHAT_WORKSPACES_ROOT` | `~/.claude-chat/workspaces` | 每个 session 的独立工作目录根 |
| `CHAT_DB_PATH` | `~/.claude-chat/db.sqlite` | SQLite 元信息数据库路径 |
| `CHAT_AUTO_GIT_INIT` | `false` | 新 workspace 目录是否自动 `git init` |
| `CHAT_MAX_WRITE_SIZE` | `5242880`（5 MB） | `writeTextFile` 工具单次写入上限（字节） |
| `CLAUDE_CODE_EXECUTABLE` | 自动检测 | Claude Code CLI 二进制路径 |
| `CLAUDE_CHAT_AUTO_ALLOW_ALL` | `true` | **危险**：自动同意所有工具权限请求；用于本机无人值守场景 |
| `LOG_LEVEL` | `info` | pino 日志级别 |
| `LOG_FILE` | 未设 | 设置后启用文件落盘，父目录自动创建。未设时输出到 stdout|
| `LOG_ROTATE_FREQUENCY` | `daily` | `daily` / `hourly` / 数字毫秒 |
| `LOG_ROTATE_SIZE` | `20m` | 单文件大小上限（触发轮转） |
| `LOG_ROTATE_MAX` | `14` | 保留历史文件数，超出删最旧 |


### 前端（`web/`）

开发模式无需额外变量；`vite.config.ts` 里已配置 `/ws` 代理。生产部署只需把 `web/dist/` 交给任意静态服务器，并用反向代理把 `/ws` 转发到后端。

## 目录结构

```
claude-chat/
├── shared/          # 前后端共享的 WS 协议类型
├── server/          # Fastify + WebSocket + ACP 桥接 + SQLite
│   ├── src/
│   │   ├── main.ts          # 入口
│   │   ├── ws-gateway.ts    # WS 路由 / 会话生命周期
│   │   ├── acp-bridge.ts    # 进程内 ACP 管道
│   │   ├── fs-bridge.ts     # 受限的 readTextFile / writeTextFile
│   │   ├── logger.ts        # pino + pino-roll
│   │   └── db.ts, workspace.ts, ...
│   └── dist/                # tsc 输出
├── web/             # Vite + React + Tailwind 聊天界面
│   └── src/
│       ├── App.tsx
│       ├── components/  # layout / sidebar / chat / composer / permission
│       └── store/       # zustand
├── scripts/         # 辅助脚本
└── docs/PLAN.md     # 设计与里程碑
```

## 常见操作

- **新会话**：侧栏 `+ New`。
- **刷新行为**：当前实现下 WebSocket 断开（刷新、关 tab、网络抖动）会取消正在跑的 prompt 并销毁后端 ACP bridge，所以**正在执行的任务会被打断**。页面重新连接后会自动回到 URL `?w=` 指向的会话，可以继续发送新消息；如果原会话的 Claude CLI 侧已经落盘过历史，会自动恢复历史对话。
- **批量清理历史会话**：侧栏"SESSIONS"标题栏的回收站图标 → 一键删除所有离线（saved）会话及其 workspace 目录（**不可恢复**）。
- **工具权限**：Claude 触发危险工具时会弹 `PermissionDialog`，允许/拒绝；或在受信环境开 `CLAUDE_CHAT_AUTO_ALLOW_ALL=true`。
- **停止当前任务**：输入框右侧变红色 Stop 按钮时点击。
