import { coordinationApi } from "../src/k8s/client.ts";

const NAMESPACE = "pi-agent";

export async function isFree(pod: string): Promise<boolean> {
  const lease = await coordinationApi.readNamespacedLease({ name: pod, namespace: NAMESPACE });
  return !lease.spec?.holderIdentity;
}
