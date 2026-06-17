import { acquireLease, releaseLease } from "../k8s/lease.ts";
import { execInPod } from "../k8s/exec.ts";
import { waitForPod } from "./queue.ts";
import { podEvents } from "./events.ts";
import { log } from "../log.ts";

const EXEC_TIMEOUT_MS = 30_000;

export async function runInSandbox(
  requestId: string,
  sessionId: string,
  toolCallId: string,
  command: string[],
  timeoutMs: number = EXEC_TIMEOUT_MS
): Promise<{ pod: string; output: string }> {
  let pod: string;
  try {
    pod = await acquireLease(requestId, sessionId, toolCallId);
  } catch (e: any) {
    if (e?.message === "NO_POD_AVAILABLE") {
      pod = await waitForPod(requestId, sessionId, toolCallId);
    } else {
      throw e;
    }
  }

  log("info", "tool.execution.started", { requestId, sessionId, toolCallId, pod, command });

  try {
    const output = await Promise.race([
      execInPod(pod, command),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("TOOL_TIMEOUT")), timeoutMs)
      ),
    ]);
    log("info", "tool.execution.completed", { requestId, sessionId, toolCallId, pod });
    return { pod, output };
  } catch (e: any) {
    if (e?.message === "TOOL_TIMEOUT") {
      log("warn", "tool.execution.timeout", { requestId, sessionId, toolCallId, pod });
    } else {
      log("error", "tool.execution.failed", { requestId, sessionId, toolCallId, pod, error: String(e) });
    }
    throw e;
  } finally {
    await releaseLease(pod).catch(() => {});
    podEvents.emit("released");
  }
}