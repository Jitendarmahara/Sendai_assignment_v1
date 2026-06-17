import { test, expect, afterEach } from "vitest";
import { getPodsStatus } from "../../src/k8s/pods.ts";
import { acquireLease, releaseLease, PODS } from "../../src/k8s/lease.ts";

let acquiredInTest: string[] = [];

afterEach(async () => {
  await Promise.all(acquiredInTest.map((pod) => releaseLease(pod).catch(() => {})));
  acquiredInTest = [];
});

test("/pods reports correct shape and ready status for all 8 pods", async () => {
  const pods = await getPodsStatus();
  expect(pods.length).toBe(8);
  expect(pods.map((p) => p.name)).toEqual(PODS);
  for (const p of pods) {
    expect(p.ready).toBe(true);
    expect(["free", "leased"]).toContain(p.lease.status);
  }
});

test("/pods reflects a lease we hold as leased with our holderIdentity", async () => {
  const held = await acquireLease("req-pods", "sess-pods", "tool-pods");
  acquiredInTest.push(held);

  const pods = await getPodsStatus();
  const entry = pods.find((p) => p.name === held);

  expect(entry?.lease.status).toBe("leased");
  if (entry?.lease.status === "leased") {
    expect(entry.lease.holderIdentity).toContain("req-pods");
    expect(entry.lease.expiresAt).toBeDefined();
  }
});
