export interface ChatInput {
  requestId: string;
  sessionId: string;
  message: string;
}

export interface ToolCallSummary {
  toolCallId: string;
  tool: string;
  pod?: string;
  status: "completed" | "failed";
}

export interface ChatResult {
  sessionId: string;
  message: string;
  toolCalls: ToolCallSummary[];
}

export interface PiClient {
  runChat(input: ChatInput): Promise<ChatResult>;
}
