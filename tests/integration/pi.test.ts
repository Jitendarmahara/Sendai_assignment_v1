import { test, expect } from "vitest";
import { RealPiClient } from "../../src/pi/pi.ts";

test("real Pi SDK chat path triggers sandbox tool execution", async () => {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY must be set to run the Pi SDK smoke test");
  }

  const client = new RealPiClient();
  const result = await client.runChat({
    requestId: "smoke-req",
    sessionId: "smoke-session",
    message: "Run a command to show the current working directory inside the sandbox.",
  });

  expect(result.toolCalls.length).toBeGreaterThan(0);
  expect(result.toolCalls.some((t) => t.status === "completed")).toBe(true);
}, 30_000);
