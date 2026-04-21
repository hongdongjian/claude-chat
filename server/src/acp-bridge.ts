import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type Client,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp";
import { logger } from "./logger.js";

export type BridgeHandlers = {
  onSessionUpdate: (n: SessionNotification) => void | Promise<void>;
  onRequestPermission: (p: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  onReadTextFile?: (p: ReadTextFileRequest) => Promise<ReadTextFileResponse>;
  onWriteTextFile?: (p: WriteTextFileRequest) => Promise<WriteTextFileResponse>;
};

// In-process full-duplex pipe between agent and client using Web Streams.
// `a` carries messages from the client side to the agent side.
// `b` carries messages from the agent side to the client side.
function createInMemoryPipe(): { agentStream: Stream; clientStream: Stream } {
  const a = new TransformStream<AnyMessage, AnyMessage>();
  const b = new TransformStream<AnyMessage, AnyMessage>();
  return {
    agentStream: { readable: a.readable, writable: b.writable },
    clientStream: { readable: b.readable, writable: a.writable },
  };
}

export type AcpBridge = {
  client: ClientSideConnection;
  dispose: () => Promise<void>;
};

export async function createAcpBridge(handlers: BridgeHandlers): Promise<AcpBridge> {
  const { agentStream, clientStream } = createInMemoryPipe();

  let agent: ClaudeAcpAgent | null = null;
  const agentConn = new AgentSideConnection(
    (conn) => {
      agent = new ClaudeAcpAgent(conn);
      return agent;
    },
    agentStream,
  );

  const clientImpl: Client = {
    sessionUpdate: async (n) => {
      await handlers.onSessionUpdate(n);
    },
    requestPermission: (p) => handlers.onRequestPermission(p),
    readTextFile: handlers.onReadTextFile,
    writeTextFile: handlers.onWriteTextFile,
  };

  const client = new ClientSideConnection(() => clientImpl, clientStream);

  await client.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {
        readTextFile: !!handlers.onReadTextFile,
        writeTextFile: !!handlers.onWriteTextFile,
      },
    },
    clientInfo: { name: "claude-chat", version: "0.1.0" },
  });
  logger.info({ protocolVersion: PROTOCOL_VERSION }, "acp bridge initialized");

  return {
    client,
    dispose: async () => {
      logger.debug("acp bridge disposing");
      // Tear down all sessions on the agent side first — this cancels
      // in-flight queries and kills the spawned claude CLI child process.
      // Without this, closing only the in-memory streams leaves orphan
      // `claude --resume ...` processes accumulating under the server pid.
      try {
        await agent?.dispose();
      } catch (err) {
        logger.warn({ err }, "agent.dispose() failed");
      }
      try {
        await agentStream.writable.close();
      } catch {
        // ignore
      }
      try {
        await clientStream.writable.close();
      } catch {
        // ignore
      }
      void agentConn;
      logger.debug("acp bridge disposed");
    },
  };
}
