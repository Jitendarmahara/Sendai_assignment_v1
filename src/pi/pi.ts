import { Type } from "typebox";
import { getModel } from "@earendil-works/pi-ai";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  defineTool,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { shellRun, fsRead, envInspect } from "../tools/index.ts";
import type { ChatInput, ChatResult, PiClient, ToolCallSummary } from "./client.ts";

const MODEL_PROVIDER = "google";
const MODEL_ID = "gemini-2.5-flash";

const TOOL_NAME_MAP: Record<string, string> = {
  shell_run: "shell.run",
  fs_read: "fs.read",
  env_inspect: "env.inspect",
};

function buildTools(requestId: string, sessionId: string) {
  const shellRunTool = defineTool({
    name: "shell_run",
    label: "Shell Run",
    description:
      "Run an allowlisted shell command inside a leased sandbox pod. Allowed: pwd, ls, cat <path>, node --version, whoami.",
    parameters: Type.Object({
      command: Type.String({ description: "Command to run, e.g. 'ls' or 'cat package.json'" }),
    }),
    execute: async (toolCallId, params) => {
      const result = await shellRun(requestId, sessionId, toolCallId, params.command);
      return {
        content: [{ type: "text" as const, text: result.output }],
        details: { pod: result.pod },
      };
    },
  });

  const fsReadTool = defineTool({
    name: "fs_read",
    label: "FS Read",
    description: "Read a file from the sandbox filesystem at a relative path (no absolute paths, no .. traversal).",
    parameters: Type.Object({
      path: Type.String({ description: "Relative file path, e.g. 'package.json'" }),
    }),
    execute: async (toolCallId, params) => {
      const result = await fsRead(requestId, sessionId, toolCallId, params.path);
      return {
        content: [{ type: "text" as const, text: result.output }],
        details: { pod: result.pod },
      };
    },
  });

  const envInspectTool = defineTool({
    name: "env_inspect",
    label: "Env Inspect",
    description: "Inspect the sandbox environment: pod name, namespace, working dir, user, runtime versions.",
    parameters: Type.Object({}),
    execute: async (toolCallId) => {
      const result = await envInspect(requestId, sessionId, toolCallId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: { pod: result.pod },
      };
    },
  });

  return [shellRunTool, fsReadTool, envInspectTool];
}

export class RealPiClient implements PiClient {
  private authStorage = AuthStorage.create();
  private modelRegistry = ModelRegistry.create(this.authStorage);

  async runChat(input: ChatInput): Promise<ChatResult> {
    const { requestId, sessionId, message } = input;

    const model = getModel(MODEL_PROVIDER, MODEL_ID);
    if (!model) throw new Error(`Model not found: ${MODEL_PROVIDER}/${MODEL_ID}`);

    const tools = buildTools(requestId, sessionId);
    const toolCalls: ToolCallSummary[] = [];

    const { session } = await createAgentSession({
      model,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.inMemory(),
      tools: tools.map((t) => t.name),
      customTools: tools,
    });

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        const details = event.result?.details as { pod?: string } | undefined;
        toolCalls.push({
          toolCallId: event.toolCallId,
          tool: TOOL_NAME_MAP[event.toolName] ?? event.toolName,
          ...(details?.pod !== undefined ? { pod: details.pod } : {}),
          status: event.isError ? "failed" : "completed",
        });
      }
    });

    try {
      await session.prompt(message);
    } finally {
      unsubscribe();
    }

    const lastAssistant = [...session.messages]
      .reverse()
      .find((m): m is AssistantMessage => m.role === "assistant");

    const text = lastAssistant
      ? lastAssistant.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("")
      : "";

    session.dispose();

    return { sessionId, message: text, toolCalls };
  }
}
