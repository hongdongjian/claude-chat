import { describe, it, expect, vi } from "vitest";

// The real ClaudeAcpAgent would spawn the Claude Code child process via the
// Anthropic SDK. For unit tests we replace it with a minimal agent that only
// answers `initialize` so `createAcpBridge` can complete the handshake.
vi.mock("@agentclientprotocol/claude-agent-acp", async () => {
  const { PROTOCOL_VERSION } = await import("@agentclientprotocol/sdk");
  class StubAgent {
    constructor(_conn: unknown) {}
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: false, sse: false },
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        authMethods: [],
      };
    }
    async newSession() {
      return { sessionId: "stub-sess" };
    }
    async loadSession() {
      return {};
    }
    async prompt() {
      return { stopReason: "end_turn" };
    }
    async cancel() {
      return {};
    }
    async setSessionModel() {
      return {};
    }
    async setSessionMode() {
      return {};
    }
  }
  return { ClaudeAcpAgent: StubAgent };
});

const { createAcpBridge } = await import("../src/acp-bridge.js");

describe("createAcpBridge", () => {
  it("initializes and exposes client", async () => {
    const bridge = await createAcpBridge({
      onSessionUpdate: () => {},
      onRequestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    });
    expect(bridge.client).toBeDefined();
    expect(typeof bridge.client.newSession).toBe("function");
    await bridge.dispose();
  });

  it("dispose is idempotent (no throw on double close)", async () => {
    const bridge = await createAcpBridge({
      onSessionUpdate: () => {},
      onRequestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    });
    await bridge.dispose();
    await expect(bridge.dispose()).resolves.toBeUndefined();
  });
});
