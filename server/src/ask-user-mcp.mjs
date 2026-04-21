#!/usr/bin/env node
// Stdio MCP server exposing a single tool `ask_user`. Spawned by the Claude
// Agent SDK via ACP's mcpServers list. Each tool call is forwarded over HTTP
// to the parent claude-chat server, which relays the question through
// WebSocket to the browser and waits for the user's reply.
//
// Pure ESM JS (no TypeScript) so `node <abs-path>` works without tsx in both
// dev and prod.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const URL_ = process.env.CLAUDE_CHAT_ASK_URL;
const TOKEN = process.env.CLAUDE_CHAT_ASK_TOKEN;

if (!URL_ || !TOKEN) {
  process.stderr.write(
    "ask-user-mcp: CLAUDE_CHAT_ASK_URL and CLAUDE_CHAT_ASK_TOKEN required\n",
  );
  process.exit(2);
}

const TOOL_NAME = "ask_user";

const TOOL_SCHEMA = {
  type: "object",
  required: ["question"],
  properties: {
    question: {
      type: "string",
      description: "The question to display to the user. Should be clear and specific.",
    },
    options: {
      type: "array",
      description:
        "Optional list of choices. If omitted or empty, the user is asked for free-form text.",
      items: {
        type: "object",
        required: ["id", "label"],
        properties: {
          id: { type: "string", description: "Stable machine-readable identifier" },
          label: { type: "string", description: "Short label shown to the user" },
          description: { type: "string", description: "Optional longer explanation" },
        },
      },
    },
    multiSelect: {
      type: "boolean",
      description: "If true, the user may pick multiple options.",
      default: false,
    },
  },
};

async function relayAsk(args) {
  const resp = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ask-token": TOKEN },
    body: JSON.stringify({
      question: args.question,
      options: args.options ?? [],
      multiSelect: !!args.multiSelect,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`ask_user relay failed: ${resp.status} ${body}`);
  }
  const payload = await resp.json();
  if (payload.kind === "cancelled") {
    return { text: "User cancelled the question without answering." };
  }
  const suffix = payload.text ? ` (${payload.text})` : "";
  return { text: `User selected: ${payload.optionId}${suffix}` };
}

const server = new Server(
  { name: "claude-chat-ask-user", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: TOOL_NAME,
      description:
        "Ask the human user a question and wait for their reply. Use this whenever you need confirmation, clarification, or a decision from the user before proceeding. Provide structured options when possible.",
      inputSchema: TOOL_SCHEMA,
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== TOOL_NAME) {
    throw new Error(`unknown tool: ${req.params.name}`);
  }
  const args = req.params.arguments ?? {};
  if (!args.question || typeof args.question !== "string") {
    return {
      isError: true,
      content: [{ type: "text", text: "ask_user: missing required 'question' string" }],
    };
  }
  try {
    const { text } = await relayAsk(args);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      isError: true,
      content: [
        { type: "text", text: `ask_user failed: ${err?.message ?? String(err)}` },
      ],
    };
  }
});

await server.connect(new StdioServerTransport());
