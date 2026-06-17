import { test, expect, afterEach } from "vitest";
import { acquireLease, releaseLease, PODS } from "../../src/k8s/lease.ts";
import { waitForPod } from "../../src/sandbox/queue.ts";
import { podEvents } from "../../src/sandbox/events.ts";

let heldPods: string[] = [];

afterEach(async () => {
  await Promise.all(heldPods.map((p) => releaseLease(p).catch(() => {})));
  heldPods = [];
});

async function occupyAllPods(): Promise<void> {
  heldPods = await Promise.all(
    PODS.map((_, i) => acquireLease(`occupy-${i}`, `occupy-sess-${i}`, `occupy-tool-${i}`))
  );
}

test("more than 8 concurrent callers: the 9th enters the FIFO queue and times out if nothing frees up", async () => {
  await occupyAllPods();
  expect(heldPods.length).toBe(8);

  await expect(waitForPod("req-9", "sess-9", "tool-9", 300)).rejects.toThrow("CAPACITY_TIMEOUT");
}, 10_000);

test("a queued caller acquires a pod once one frees up", async () => {
  await occupyAllPods();

  const waiterPromise = waitForPod("req-10", "sess-10", "tool-10", 5_000);

  setTimeout(async () => {
    const podToFree = heldPods.shift()!;
    await releaseLease(podToFree);
    podEvents.emit("released");
  }, 200);

  const acquired = await waiterPromise;
  heldPods.push(acquired); // re-acquired by the queue waiter — track it for cleanup too
  expect(PODS).toContain(acquired);
}, 10_000);
