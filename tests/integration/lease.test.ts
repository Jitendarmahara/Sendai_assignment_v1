import { test, expect, afterEach } from "vitest";
import { V1MicroTime } from "@kubernetes/client-node";
import { acquireLease, releaseLease, PODS, NAMESPACE } from "../../src/k8s/lease.ts";
import { coordinationApi } from "../../src/k8s/client.ts";
import { runInSandbox } from "../../src/sandbox/runner.ts";
import { isFree } from "../helpers.ts";

let acquiredInTest: string[] = [];

afterEach(async () => {
  await Promise.all(acquiredInTest.map((pod) => releaseLease(pod).catch(() => {})));
  acquiredInTest = [];
});

test("acquires a free pod", async () => {
  const pod = await acquireLease("req-1", "sess-1", "tool-1");
  acquiredInTest.push(pod);
  expect(PODS).toContain(pod);
});

test("releases the pod after successful tool execution", async () => {
  const { pod } = await runInSandbox("req-2", "sess-2", "tool-2", ["pwd"]);
  expect(await isFree(pod)).toBe(true);
});

test("releases the pod after tool failure", async () => {
  await expect(
    runInSandbox("req-3", "sess-3", "tool-3", ["ls", "/no/such/dir"])
  ).rejects.toThrow();
  const frees = await Promise.all(PODS.map(isFree));
  expect(frees.every(Boolean)).toBe(true);
});

test("releases the pod after timeout", async () => {
  await expect(
    runInSandbox("req-4", "sess-4", "tool-4", ["sh", "-c", "sleep 2"], 200)
  ).rejects.toThrow("TOOL_TIMEOUT");
  const frees = await Promise.all(PODS.map(isFree));
  expect(frees.every(Boolean)).toBe(true);
}, 10_000);

test("concurrent acquireLease calls never return the same pod", async () => {
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => acquireLease(`req-c${i}`, `sess-c${i}`, `tool-c${i}`))
  );
  acquiredInTest.push(...results);
  expect(new Set(results).size).toBe(results.length);
});

test("recovers an expired lease", async () => {
  const pod = PODS[0]!;
  const stale = await coordinationApi.readNamespacedLease({ name: pod, namespace: NAMESPACE });
  stale.spec = {
    ...stale.spec,
    holderIdentity: "stale-instance:stale-req:stale-sess:stale-tool",
    acquireTime: new V1MicroTime(new Date(Date.now() - 10_000)),
    renewTime: new V1MicroTime(new Date(Date.now() - 10_000)),
    leaseDurationSeconds: 1,
  };
  await coordinationApi.replaceNamespacedLease({ name: pod, namespace: NAMESPACE, body: stale });

  const acquired = await acquireLease("req-recover", "sess-recover", "tool-recover");
  acquiredInTest.push(acquired);
  expect(acquired).toBe(pod);
});
