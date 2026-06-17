import * as k8s from "@kubernetes/client-node";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

// kind uses self-signed certs — disable TLS verification for local dev
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

const kc = new k8s.KubeConfig();

// loadFromCluster() doesn't throw when the in-cluster env vars are missing —
// it silently builds a broken "https://undefined:undefined" config. Detect
// in-cluster mode explicitly via the mounted ServiceAccount token instead.
const SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
if (existsSync(SA_TOKEN_PATH)) {
  kc.loadFromCluster();
} else {
  // Running locally (tests, dev). The default kubeconfig user for kind
  // authenticates via client TLS certificates, which Bun's fetch() doesn't
  // pass through the way @kubernetes/client-node expects — requests would
  // silently land as system:anonymous. Mint a short-lived bearer token for
  // the same namespace-scoped ServiceAccount the deployed pod uses instead,
  // so local runs exercise the same RBAC permissions as production.
  kc.loadFromDefault();
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error("No current cluster found in kubeconfig");

  const token = execSync("kubectl create token pi-agent-sa -n pi-agent", {
    encoding: "utf-8",
  }).trim();

  kc.loadFromOptions({
    clusters: [{ ...cluster, skipTLSVerify: true }],
    users: [{ name: "pi-agent-local", token }],
    contexts: [{ name: "pi-agent-local", cluster: cluster.name, user: "pi-agent-local" }],
    currentContext: "pi-agent-local",
  });
}

export { kc };
export const coreApi = kc.makeApiClient(k8s.CoreV1Api);
export const coordinationApi = kc.makeApiClient(k8s.CoordinationV1Api);
