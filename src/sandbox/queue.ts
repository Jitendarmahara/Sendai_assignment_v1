import { acquireLease } from "../k8s/lease.ts";
import { podEvents } from "./events.ts";
import { log } from "../log.ts";
const MAX_WAIT_MS = 15_000;
interface QueueItem {
  toolCallId: string;
}
const queue: QueueItem[] = [];

export async function waitForPod(
  requestId: string,
  sessionId: string,
  toolCallId: string,
  maxWaitMs: number = MAX_WAIT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const item: QueueItem = { toolCallId };
    queue.push(item);
    log("info", "queue.wait.started", { requestId, sessionId, toolCallId, queueLength: queue.length });

    let settled = false;
    const cleanup = () => {
      const idx = queue.indexOf(item);
      if (idx !== -1) queue.splice(idx, 1);
      podEvents.off("released", tryNext);
      clearTimeout(timer);
    };
    const tryNext = async () => {
      if (settled) return;
      if (queue[0] !== item) return;
      try {
        const pod = await acquireLease(requestId, sessionId, toolCallId);
        settled = true;
        cleanup();
        log("info", "queue.wait.completed", { requestId, sessionId, toolCallId, pod });
        resolve(pod);
      } catch {
        //pod  not avaliable wait for the next released
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      log("warn", "queue.wait.timeout", { requestId, sessionId, toolCallId });
      reject(new Error("CAPACITY_TIMEOUT"));
    }, maxWaitMs);

    podEvents.on("released", tryNext);
  });
}
