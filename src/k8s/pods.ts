import { coreApi, coordinationApi } from "./client.ts";

const NAMESPACE = "pi-agent";
const POD_NAMES = Array.from({ length: 8 }, (_, i) => `sandbox-runner-${i}`);
const LEASE_DURATION = 45;

interface PodStatus {
  name: string;
  ready: boolean;
  lease:
    | { status: "free" }
    | { status: "leased"; holderIdentity: string; expiresAt: string };
}

export async function getPodsStatus(): Promise<PodStatus[]> {
  const podList = await coreApi.listNamespacedPod({
    namespace: NAMESPACE,
    labelSelector: "app=sandbox-runner",
  });

  const readyByName = new Map<string, boolean>();
  for (const pod of podList.items) {
    const name = pod.metadata?.name;
    if (name) readyByName.set(name, pod.status?.phase === "Running");
  }

  const results: PodStatus[] = [];

  for (const name of POD_NAMES) {
    const lease = await coordinationApi.readNamespacedLease({ name, namespace: NAMESPACE });
    const holder = lease.spec?.holderIdentity;
    const acquireTime = lease.spec?.acquireTime;
    const duration = lease.spec?.leaseDurationSeconds ?? LEASE_DURATION;

    const isLeased = !!holder && !!acquireTime;

    results.push({
      name,
      ready: readyByName.get(name) ?? false,
      lease: isLeased
        ? {
            status: "leased",
            holderIdentity: holder!,
            expiresAt: new Date(
              new Date(acquireTime as unknown as string).getTime() + duration * 1000
            ).toISOString(),
          }
        : { status: "free" },
    });
  }

  return results;
}
