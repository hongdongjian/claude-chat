# Claude Chat 完整实施方案

> 基于 `@agentclientprotocol/claude-agent-acp` 的 Web 聊天客户端。
> 用户在浏览器新建会话 → 对应一个 Claude Code session → 实时看到思考/工具调用/结果 → 持续交互。

---

## 1. 总体架构

```
┌──────────────┐   WebSocket (JSON)   ┌──────────────────┐   in-process   ┌───────────────────┐
│  Web 前端    │ ◄──────────────────► │  Web 后端         │ ◄────────────► │ ClaudeAcpAgent    │
│ React/Vite   │                       │  Fastify + WS    │                │ (lib 直接 import)  │
│ 聊天 UI      │                       │  AcpBridge       │                │ + Claude Agent SDK │
└──────────────┘                       └──────────────────┘                └───────────────────┘
```

**关键决策**：方案 A —— **进程内 TransformStream 对接**。
不 `spawn` 子进程，而是在后端同一进程里：
- 用 `new AgentSideConnection(factory, agentStream)` 跑 `ClaudeAcpAgent`
- 用 `new ClientSideConnection(handlers, clientStream)` 扮演客户端
- 两条 stream 交叉接线形成内存全双工管道

好处：零序列化开销、类型全走 TS、调试方便、部署简单。

---

## 2. 依赖 `claude-agent-acp` 的核心事实（已代码验证）

| 事实 | 位置 |
|---|---|
| `ClaudeAcpAgent` 由 `lib.ts` 导出为 library | `src/lib.ts:2` |
| Agent 实现 ACP 的 `initialize / newSession / loadSession / prompt / cancel` | `src/acp-agent.ts:364,496,537,576,1050` |
| 反向推送消息走 `client.sessionUpdate(...)` | `src/acp-agent.ts:651` 等多处 |
| 权限请求走 `client.requestPermission(...)` | `src/acp-agent.ts:1274,1332` |
| 文件读写请求由 client 端 `readTextFile / writeTextFile` 回调处理 | ACP SDK 接口 |
| stdio 入口（参考实现）：`AgentSideConnection(factory, ndJsonStream(stdout, stdin))` | `src/acp-agent.ts:2502-2512` |

**sessionUpdate 类型枚举（前端需渲染）**：
- `agent_message_chunk` / `user_message_chunk`
- `agent_thought_chunk`
- `tool_call` / `tool_call_update`
- `plan`
- `usage_update`
- `current_mode_update` / `config_option_update` / `available_commands_update`

---

## 3. 前后端通信协议（WS JSON）

### Client → Server
```ts
{ type: "session.new",    title?: string, mcpServers?: {...}[] }   // cwd 由后端自动分配
{ type: "session.prompt", sessionId: string, text: string, attachments?: {...}[] }
{ type: "session.cancel", sessionId: string }
{ type: "permission.reply", requestId: string, outcome: "allow_once" | "allow_always" | "reject" }
```

### Server → Client
```ts
{ type: "session.created",    sessionId: string, workspaceId: string, cwd: string }
{ type: "session.update",     sessionId: string, update: <原样透传 ACP SessionUpdate> }
{ type: "permission.request", requestId: string, sessionId: string, toolCall: {...}, options: [...] }
{ type: "error",              message: string, code?: string }
```

前端渲染按 `update.sessionUpdate` 字段分派 —— 与 ACP 原生结构一致，未来接其它 ACP agent 可复用。

---

## 4. 项目结构

```
claude-chat/
├── package.json                 # pnpm workspaces 根
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── README.md
├── docs/
│   └── PLAN.md                  # 本文件
├── shared/
│   └── src/protocol.ts          # WS 消息类型（前后端共享）
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── main.ts              # Fastify 启动
│       ├── ws-gateway.ts        # 每连接创建 AcpBridge
│       ├── acp-bridge.ts        # ★ TransformStream + AgentSideConnection + ClientSideConnection
│       ├── fs-bridge.ts         # readTextFile/writeTextFile（cwd 白名单）
│       ├── permission-broker.ts # requestId ↔ resolve 队列
│       └── logger.ts
└── web/
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.ts
    ├── components.json          # shadcn 配置
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx              # AppShell
        ├── globals.css          # 字体 @import + CSS 变量
        ├── lib/
        │   ├── ws-client.ts
        │   └── ansi.ts
        ├── store/
        │   ├── sessions.ts      # zustand
        │   └── permissions.ts
        └── components/
            ├── layout/AppShell.tsx
            ├── sidebar/SessionList.tsx
            ├── chat/ChatWindow.tsx
            ├── chat/UserBubble.tsx
            ├── chat/AssistantBubble.tsx
            ├── chat/ThoughtBlock.tsx
            ├── tools/ToolCallCard.tsx
            ├── tools/DiffView.tsx
            ├── tools/TerminalView.tsx
            ├── plan/PlanPanel.tsx
            ├── permission/PermissionDialog.tsx
            ├── composer/Composer.tsx
            ├── composer/FileMention.tsx
            ├── composer/SlashMenu.tsx
            └── topbar/UsageBar.tsx
```

---

## 5. 后端关键实现（伪代码骨架）

### 5.1 `acp-bridge.ts`（核心）

```ts
import { AgentSideConnection, ClientSideConnection } from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp";

export function createAcpBridge(handlers: {
  onSessionUpdate: (n: SessionNotification) => void;
  onPermissionRequest: (p: PermissionRequest) => Promise<PermissionResponse>;
  onReadTextFile:  (p: ReadTextFileRequest)  => Promise<ReadTextFileResponse>;
  onWriteTextFile: (p: WriteTextFileRequest) => Promise<WriteTextFileResponse>;
}) {
  // 内存全双工管道：两条 TransformStream 交叉接线
  const a = new TransformStream();   // client → agent 方向
  const b = new TransformStream();   // agent → client 方向

  const agentStream  = { readable: a.readable, writable: b.writable };
  const clientStream = { readable: b.readable, writable: a.writable };

  // Agent 端
  new AgentSideConnection(
    (client) => new ClaudeAcpAgent(client),
    agentStream,
  );

  // Client 端（我们扮演的角色）
  const client = new ClientSideConnection(
    {
      sessionUpdate:   async (n) => handlers.onSessionUpdate(n),
      requestPermission: handlers.onPermissionRequest,
      readTextFile:      handlers.onReadTextFile,
      writeTextFile:     handlers.onWriteTextFile,
    },
    clientStream,
  );

  return client;  // 暴露给上层调用 initialize / newSession / prompt / cancel
}
```

### 5.2 `ws-gateway.ts`

```ts
fastify.get("/ws", { websocket: true }, (socket, req) => {
  const permissionBroker = new PermissionBroker();
  const workspaceMgr = new WorkspaceManager({ root: process.env.CHAT_WORKSPACES_ROOT! });
  const fsBridge = new FsBridge({ resolveRootForSession: (sid) => sessions.get(sid)!.cwd });

  const client = createAcpBridge({
    onSessionUpdate: (n) =>
      socket.send(JSON.stringify({ type: "session.update", sessionId: n.sessionId, update: n.update })),
    onPermissionRequest: (p) => permissionBroker.ask(socket, p),
    onReadTextFile:  (p) => fsBridge.read(p),
    onWriteTextFile: (p) => fsBridge.write(p),
  });

  // 初始化
  await client.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });

  // sessionId → { workspaceId, cwd }
  const sessions = new Map<string, { workspaceId: string; cwd: string }>();

  socket.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    switch (msg.type) {
      case "session.new": {
        // ★ 方案 A：我们自己生成 workspaceId 作为目录名
        const workspaceId = crypto.randomUUID();
        const cwd = await workspaceMgr.create(workspaceId);  // mkdir + 可选 git init
        const { sessionId } = await client.newSession({ cwd, mcpServers: msg.mcpServers ?? [] });
        sessions.set(sessionId, { workspaceId, cwd });
        await db.insertSession({
          workspaceId, sessionId, cwd,
          title: msg.title ?? "New session",
          createdAt: Date.now(), lastActiveAt: Date.now(),
        });
        socket.send(JSON.stringify({ type: "session.created", sessionId, workspaceId, cwd }));
        break;
      }
      case "session.prompt": {
        await client.prompt({ sessionId: msg.sessionId, prompt: [{ type: "text", text: msg.text }] });
        await db.touchSession(msg.sessionId);
        break;
      }
      case "session.cancel": {
        await client.cancel({ sessionId: msg.sessionId });
        break;
      }
      case "permission.reply": {
        permissionBroker.resolve(msg.requestId, msg.outcome);
        break;
      }
    }
  });
});
```

### 5.3 `fs-bridge.ts`（安全要点）

- **只允许访问该 session 的 workspace 目录**（`sessions.get(sid).cwd` 以下）。
- **必须限制在 `CHAT_WORKSPACES_ROOT` 总根下**（双重校验）。
- 解析路径后做 `path.resolve` 前缀检查 + `fs.realpath` 防符号链接穿越。
- 写入做大小上限（默认 5MB，可配置）。

### 5.4 `workspace-manager.ts`（新增）

职责：工作目录的生命周期管理。

```ts
export class WorkspaceManager {
  constructor(private opts: { root: string; autoGitInit?: boolean }) {}

  async create(workspaceId: string): Promise<string> {
    const cwd = path.join(this.opts.root, workspaceId);
    await fs.mkdir(cwd, { recursive: true });
    if (this.opts.autoGitInit) await execFile("git", ["init"], { cwd });
    return cwd;
  }

  async archive(workspaceId: string): Promise<void> { /* 打 tar 归档 */ }
  async remove(workspaceId: string): Promise<void>  { /* rm -rf，谨慎 */ }
  resolvePath(workspaceId: string, relOrAbs: string): string {
    const cwd = path.join(this.opts.root, workspaceId);
    const resolved = path.resolve(cwd, relOrAbs);
    if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
      throw new Error("Path escapes workspace root");
    }
    return resolved;
  }
}
```

### 5.5 `permission-broker.ts`

- Map<requestId, { resolve }>；超时（默认 120s）自动 reject。
- 同一连接内允许多个并发权限请求（队列渲染）。

---

## 6. 前端关键组件

### 6.1 全局布局（`AppShell`）
- `ResizablePanelGroup` 三栏：`SessionList` (240px) / `ChatWindow` (flex) / `PlanPanel` (320px，可隐藏)
- 顶栏：项目名 + `UsageBar` + 设置
- 底部：`Composer`

### 6.2 消息模型
```ts
type AssistantMessage = {
  id: string;
  role: "assistant";
  textChunks: string[];         // agent_message_chunk 累加
  thoughts: string[];           // agent_thought_chunk
  toolCalls: Map<string, ToolCallState>;
  plan?: PlanEntry[];
};
type ToolCallState = {
  id: string;
  name: string;
  status: "pending" | "running" | "success" | "failed";
  input: unknown;
  output?: unknown;
  diff?: { path: string; patch: string };
  terminal?: { chunks: string[]; exitCode?: number };
};
```

### 6.3 流式渲染要点
- 收到 `agent_message_chunk` → append 到**当前**对话的最后一条 assistant message。若无则创建。
- `tool_call` → 建卡；`tool_call_update` → 按 `toolCallId` 查找更新。
- 使用 `React.memo` + stable key 防止整列重渲染。
- `ScrollArea` 维护 `isPinnedToBottom` 状态；用户手动上滚后显示"新消息"浮标。

### 6.4 Composer
- `Textarea` 自动高度，Enter 发送，Shift+Enter 换行。
- `@` 触发：POST `/api/fs/search?cwd=...&q=...` 列出文件，选中插入 `resource_link` attachment。
- `/` 触发：显示 `available_commands_update` 推送的命令。
- 运行中显示 "⏹ Stop"，点击发 `session.cancel`。

---

## 7. 设计系统（dark mode 开发者风）

### 颜色 CSS 变量
```css
:root {
  --bg:            #0F172A;
  --surface:       #1E293B;
  --border:        #334155;
  --fg:            #F8FAFC;
  --fg-muted:      #94A3B8;
  --accent:        #22C55E;  /* 主 CTA / 成功 */
  --info:          #3B82F6;  /* 工具运行中 */
  --warning:       #F59E0B;  /* 权限请求 */
  --destructive:   #EF4444;
  --ring:          #22C55E;
}
```

### 字体
```css
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap');
:root {
  --font-sans: 'IBM Plex Sans', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
}
```
- UI/正文：IBM Plex Sans 14px
- 代码 / 工具输出 / 思考 / 文件路径：JetBrains Mono 13px
- 标题：Sans 15–16px / weight 600

### shadcn 组件映射

| 用途 | shadcn |
|---|---|
| 布局 | `resizable` |
| 会话列表 / 聊天滚动 | `scroll-area` |
| 消息卡片 | `card` |
| 思考折叠 | `collapsible` |
| 工具调用详情 | `accordion` + `badge` |
| 权限弹窗 | `dialog` |
| 输入框 | `textarea` |
| 文件/命令选择 | `command` + `popover` |
| Token 进度 | `progress` |
| 连接状态 | `badge` |

---

## 8. 流式聊天 UX 准则

1. **首字节反馈 < 200ms**：发送后立即插入 assistant 空气泡 + 光标动画。
2. **流式 append 不重排**：`contain: layout` 稳定容器。
3. **自动滚底但尊重用户滚动**：检测上滚暂停跟随，底部浮标回到底。
4. **思考折叠优先**：`agent_thought_chunk` 默认折叠，标题给预览。
5. **工具卡片状态色**：pending=灰、running=蓝+脉冲、success=绿、failed=红+展开。
6. **权限请求模态**：禁用 Composer，快捷键 `Enter=Allow Once`、`Esc=Reject`。
7. **取消按钮**：运行中发送键变 "⏹ Stop"。
8. **差量 diff**：超 50 行折叠 + "展开全部"。
9. **Mono 保留给代码**：正文 Sans，代码/diff/终端/路径用 Mono。
10. **reduced-motion**：脉冲、光标闪烁走系统偏好。

---

## 9. 实施里程碑

| 阶段 | 交付内容 | 验收标准 |
|---|---|---|
| **M1** | 项目骨架、WS 连通、`AcpBridge` 方案 A、纯文本流式回复、基础深色样式、单会话 | 浏览器输入问题能收到流式文本回答 |
| **M2** | `tool_call` 卡片 + diff + 终端输出 + 权限弹窗 + `fs-bridge` | Claude 执行 Read/Edit/Bash 工具可见，权限请求可批准/拒绝 |
| **M3** | 思考折叠、Plan 面板、UsageBar、Composer `@`/`/`、取消按钮 | 完整单会话体验 |
| **M4** | 多会话切换、会话列表持久化、MCP 配置、slash commands、loadSession 恢复 | 支持多会话并行/切换 |
| **M5** | 认证、SQLite 元信息、Docker、部署脚本 | 可上线部署 |

---

## 10. 技术选型

| 模块 | 选型 | 理由 |
|---|---|---|
| 后端 | **Fastify** + `@fastify/websocket` | 轻量、TS 友好 |
| 前端 | **Vite + React + TS** | 主流 |
| 状态 | **Zustand** | 流式 append 简单 |
| UI | **Tailwind + shadcn/ui** + **Radix** | 无障碍开箱即用 |
| 图标 | **Lucide** | 与 shadcn 配套，SVG |
| Diff | **diff + react-diff-view**（或自实现轻量版） | M2 再定 |
| ANSI | **ansi-to-html** | 终端输出着色 |
| 包管理 | **pnpm workspaces** | 共享 types |
| ACP | `@agentclientprotocol/sdk` + `@agentclientprotocol/claude-agent-acp` | 核心依赖 |

---

## 11. 风险与注意点

1. **Claude 原生二进制**：`@anthropic-ai/claude-agent-sdk` 依赖平台相关 `claude` 二进制（见 `claudeCliPath`）。部署时 npm 安装不能 `--omit=optional`，或设置 `CLAUDE_CODE_EXECUTABLE`。
2. **认证**：服务器需要先 `claude /login` 或走 gateway 模式（`baseUrl/headers`）。Web 端不建议做交互登录。
3. **cwd 沙箱**：每 session 的 `cwd` 决定文件读写范围，必须做严格白名单，避免越权。
4. **并发模型**：一个浏览器 = 一个 WS；一个 WS 内可多 session。`ClaudeAcpAgent` 每连接一实例（与 stdio 模式一致）。
5. **大输出**：`tool_call_update` 里的 diff/终端输出可能很大，前端要虚拟滚动或折叠。
6. **断线重连**：WS 断开后应尝试恢复 session，`loadSession` 可用于恢复历史。
7. **workspaceId ≠ sessionId**：目录名用我们自己的 `workspaceId`（UUID）而非 agent 的 `sessionId`。因为 `newSession` 必须先传 `cwd` 才能拿到 `sessionId`，用 agent 的 sessionId 建目录要 `rename` 已建好的目录，会破坏 agent 内部 `Session.cwd` 状态。两者在 SQLite 里用 `sessions` 表关联即可。

---

## 12. 配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CHAT_WORKSPACES_ROOT` | `~/.claude-chat/workspaces` | **所有 session 的工作目录总根**，每个 session 在此下创建 `{workspaceId}/` 子目录 |
| `CHAT_DB_PATH` | `~/.claude-chat/db.sqlite` | 会话元信息持久化 |
| `CHAT_AUTO_GIT_INIT` | `false` | 新 workspace 是否自动 `git init` |
| `CHAT_WORKSPACE_TTL_DAYS` | `30` | 无活动超过 N 天的 workspace 进入归档流程 |
| `CHAT_MAX_WRITE_SIZE` | `5242880` (5MB) | 单次文件写入上限 |
| `CLAUDE_CODE_EXECUTABLE` | 自动检测 | 指定 claude 原生二进制路径 |
| `PORT` | `3000` | Fastify 端口 |

### SQLite 元信息表

```sql
CREATE TABLE sessions (
  workspace_id   TEXT PRIMARY KEY,   -- 我们自己的 UUID，同时是目录名
  session_id     TEXT NOT NULL UNIQUE, -- agent 返回的 sessionId
  cwd            TEXT NOT NULL,
  title          TEXT,
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  archived_at    INTEGER
);
```

### 目录布局

```
$CHAT_WORKSPACES_ROOT/
├── 550e8400-e29b-41d4-a716-446655440000/   ← workspaceId
│   ├── .git/                                 （可选）
│   └── <用户任务产生的文件>
├── 7c9e6679-7425-40de-944b-e07fc1f90ae7/
│   └── ...
└── _archive/                                 （过期归档）
    └── 2025-01-15_old-workspace.tar.gz
```

### 清理策略

- 定时任务（cron / 启动时扫描）：`last_active_at < now - TTL` 的 workspace → 打包到 `_archive/` 并从数据库标记 `archived_at`。
- 手动：前端"删除会话" → 删 DB 记录 + `WorkspaceManager.remove()`（前端二次确认）。

---

## 13. 下一步

各里程碑详细清单（按顺序推进）：

### M1 · 最小可跑通（目标：问一句话 → 看到流式回答）

- [ ] 初始化 pnpm workspace（`root` / `server` / `web` / `shared`）
- [ ] 配置 `tsconfig.base.json` + ESLint + Prettier
- [ ] 安装依赖：`@agentclientprotocol/sdk`、`@agentclientprotocol/claude-agent-acp`、`fastify`、`@fastify/websocket`
- [ ] `shared/src/protocol.ts`：定义 WS 消息类型
- [ ] `server/src/acp-bridge.ts`：TransformStream 对 + `AgentSideConnection` + `ClientSideConnection`
- [ ] `server/src/workspace-manager.ts`：创建 workspace 目录
- [ ] `server/src/ws-gateway.ts`：跑通 `initialize → newSession → prompt`
- [ ] `server/src/main.ts`：Fastify 启动
- [ ] 前端：Vite + React + TS + Tailwind + shadcn 初始化
- [ ] `AppShell` 三栏布局（Plan 面板可先留空）
- [ ] `SessionList`（静态占位）+ "新建会话" 按钮
- [ ] `ChatWindow` + `UserBubble` + `AssistantBubble`（仅处理 `agent_message_chunk`）
- [ ] `Composer`（纯文本发送，Enter 发送）
- [ ] `ws-client.ts` 封装 + Zustand store
- [ ] 端到端验证：浏览器输入问题 → 看到流式文本回答

### M2 · 工具调用与权限（目标：Claude 可用工具改代码）

- [ ] `fs-bridge.ts`：实现 `readTextFile` / `writeTextFile`，路径白名单
- [ ] `permission-broker.ts`：requestId 队列 + 超时
- [ ] 前端 `ToolCallCard`：根据 `tool_call` / `tool_call_update` 渲染卡片
  - [ ] 状态徽章（pending/running/success/failed）
  - [ ] 参数 JSON 预览（折叠）
  - [ ] `Accordion` 展开详情
- [ ] `DiffView` 组件（Edit 工具的 diff 展示，unified 格式）
- [ ] `TerminalView` 组件（Bash 工具输出 + ANSI 着色）
- [ ] `PermissionDialog`：模态 + `Allow Once` / `Always` / `Reject` + 快捷键
- [ ] Queue 化多个权限请求
- [ ] 端到端验证：让 Claude Read/Edit 一个文件，Bash 跑命令

### M3 · 思考/计划/用量/取消（目标：完整单会话体验）

- [ ] `ThoughtBlock`：`agent_thought_chunk` 默认折叠
- [ ] `PlanPanel`：响应 `plan` sessionUpdate
- [ ] `UsageBar`：响应 `usage_update`，顶栏进度条 + 数字
- [ ] `Composer` 增强：
  - [ ] `@` 文件提及 → 后端 `/api/fs/search?workspaceId=...&q=...`
  - [ ] `/` slash 命令 → 响应 `available_commands_update`
- [ ] 运行中发送键切换为 "⏹ Stop" → 发 `session.cancel`
- [ ] 自动滚底 + "↓ New messages" 浮标
- [ ] `prefers-reduced-motion` 支持

### M4 · 多会话与持久化（目标：真正"多会话并行"的产品）

- [ ] SQLite（`better-sqlite3`）初始化 `sessions` 表
- [ ] `session.new` 写库；`session.prompt` 更新 `last_active_at`
- [ ] 启动时列出所有未归档会话
- [ ] 左侧 `SessionList` 联动：显示标题/最后活动时间/workspaceId 短哈希
- [ ] 切换会话：WS 侧保持同一 agent 实例，前端切换当前 sessionId 渲染
- [ ] `loadSession` 恢复历史消息（利用 agent 自带的 `replaySessionHistory`）
- [ ] 会话重命名 / 删除（含 `WorkspaceManager.remove()` 二次确认）
- [ ] MCP servers 配置 UI（per-session）
- [ ] 归档清理定时任务（`CHAT_WORKSPACE_TTL_DAYS`）

### M5 · 生产化（目标：可上线部署）

- [ ] 单用户认证（环境变量 token 或简单登录页）
- [ ] Nginx/Caddy 反代 + HTTPS + WS 升级
- [ ] Dockerfile（注意 `@anthropic-ai/claude-agent-sdk` 原生二进制需要安装平台依赖）
- [ ] docker-compose（含持久化挂载 `$CHAT_WORKSPACES_ROOT` 和 `$CHAT_DB_PATH`）
- [ ] 健康检查 `/healthz`
- [ ] 日志轮转（pino + logrotate）
- [ ] 错误上报（可选：Sentry）
- [ ] README 部署指南
