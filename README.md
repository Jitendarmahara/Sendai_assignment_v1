# Pi Agent — Kubernetes-Leased Sandbox Execution

A chat agent backend built on the **Pi TypeScript SDK** (`@earendil-works/pi-coding-agent`). When the model needs to run a tool (`shell.run`, `fs.read`, `env.inspect`), execution happens **inside a real Kubernetes pod**, never on the API server's own machine. A fixed pool of 8 warm pods is shared across all requests, coordinated through Kubernetes `Lease` objects so two requests can never run on the same pod at once.

> **Runtime note:** this is the Node.js/npm build of the project. A Bun-based variant exists with the same feature set but a different tool-execution mechanism (`kubectl` subprocess instead of the native WebSocket exec API) — see [Tool Execution](#6-tool-execution) for why.

---

## Status

All core requirements are implemented and verified against a live `kind` cluster:

- ✅ `POST /chat`, `GET /pods`, `GET /health` — implemented to the specified response shapes
- ✅ Real Pi TypeScript SDK agent loop (`@earendil-works/pi-coding-agent`), not a mock — backed by Gemini 2.5 Flash since Pi-specific credentials weren't provided (see [Pi SDK Integration](#9-pi-sdk-integration))
- ✅ All 3 required tools — `shell.run`, `fs.read`, `env.inspect` — with command/path allowlisting
- ✅ 8 warm sandbox pods (`sandbox-runner-0..7`) via a `StatefulSet`, one Kubernetes `Lease` per pod as the lock source of truth, optimistic-concurrency acquisition
- ✅ FIFO queue with a bounded 15s max wait and the specified `sandbox_capacity_timeout` error shape
- ✅ 45s lease expiry gives automatic crash recovery, no watchdog process needed
- ✅ Namespace-scoped RBAC, no cluster-admin, no privileged containers, resource limits on every pod
- ✅ 11/11 required automated tests passing — `npm test` (unit) + `npm run test:integration` (real cluster)

---

## Contents

1. [Setup & Local Testing](#1-setup--local-testing)
2. [API Reference](#2-api-reference)
3. [Architecture](#3-architecture)
4. [Design: Pod Locking with Kubernetes Leases](#4-design-pod-locking-with-kubernetes-leases)
5. [FIFO Queue & Timeouts](#5-fifo-queue--timeouts)
6. [Tool Execution](#6-tool-execution)
7. [Tools and Allowlisting](#7-tools-and-allowlisting)
8. [Pi SDK Integration](#8-pi-sdk-integration)
9. [Kubernetes Manifests](#9-kubernetes-manifests)
10. [Testing](#10-testing)
11. [Observability](#11-observability)
12. [Security Posture](#12-security-posture)
13. [Known Limitations](#13-known-limitations)
14. [Production Considerations](#14-production-considerations)

---

## 1. Setup & Local Testing

### Prerequisites
Node.js 22+, `npm`, `docker`, `kind`, `kubectl`, a Gemini API key.

### 1. Create the cluster
```bash
kind create cluster --name pi-agent
kubectl config use-context kind-pi-agent
```

### 2. Apply manifests
```bash
kubectl apply -f manifests/namespace.yaml
kubectl apply -f manifests/serviceaccount.yaml
kubectl apply -f manifests/role.yaml
kubectl apply -f manifests/rolebinding.yaml
kubectl apply -f manifests/statefulset.yaml
kubectl apply -f manifests/leases.yaml
kubectl apply -f manifests/service.yaml
kubectl rollout status statefulset/sandbox-runner -n pi-agent
```

### 3. Create the Gemini credential secret
```bash
kubectl create secret generic ai-credentials \
  --from-literal=GEMINI_API_KEY=your-real-key \
  -n pi-agent
```

### 4. Build and load the API image, then deploy
```bash
npm install
docker build -t pi-agent-npm:dev .
kind load docker-image pi-agent-npm:dev --name pi-agent
kubectl apply -f manifests/deployment.yaml
kubectl rollout status deployment/pi-agent -n pi-agent
```

### 5. Expose the service locally
```bash
kubectl port-forward svc/pi-agent 3000:3000 -n pi-agent
```
Leave this running in its own terminal — every `curl`/test run below depends on this tunnel being open.

### 6. Verify it's working
```bash
curl -s http://localhost:3000/health | jq
# {"ok":true,"kubernetes":"connected","sandboxPodsReady":8}

curl -s http://localhost:3000/pods | jq
# {"pods":[{"name":"sandbox-runner-0","ready":true,"lease":{"status":"free"}}, ...]}

curl -s -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What pod are you running in, what user, and what is the working directory?"}' | jq
# {"sessionId":"...","message":"I am running in pod `sandbox-runner-0` ... as user `nobody` ...",
#  "toolCalls":[{"toolCallId":"...","tool":"env.inspect","pod":"sandbox-runner-0","status":"completed"}]}
```

### 7. Run the tests
```bash
npm test                  # unit tests — no cluster needed
npm run test:integration  # needs the live cluster from steps 1-4
```

### Running the API directly on your machine (no Docker image needed)
```bash
cp .env.example .env
# edit .env, set GEMINI_API_KEY
npm run start    # node --env-file=.env src/http/server.ts
```
This still talks to the cluster created in steps 1–3 — `src/k8s/client.ts` detects it isn't running inside a pod and mints a short-lived bearer token for the same namespace-scoped `pi-agent-sa` ServiceAccount the deployed pod uses, so it exercises the exact same RBAC permissions as production.

---

## 2. API Reference

### `POST /chat`
```bash
curl -s -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "session-123", "message": "list the files in the sandbox"}' | jq
```
```json
{
  "sessionId": "session-123",
  "message": "The sandbox contains package.json and src/.",
  "toolCalls": [
    { "toolCallId": "tool-abc", "tool": "shell.run", "pod": "sandbox-runner-3", "status": "completed" }
  ]
}
```
If no pod becomes available within the queue's 15s max wait, the response is a 503:
```json
{ "error": { "code": "sandbox_capacity_timeout", "message": "No sandbox pod became available within 15 seconds." } }
```

### `GET /pods`
Returns current pool state — pod readiness and live Lease state for all 8 pods.
```bash
curl -s http://localhost:3000/pods | jq
```
```json
{
  "pods": [
    { "name": "sandbox-runner-0", "ready": true, "lease": { "status": "free" } },
    { "name": "sandbox-runner-1", "ready": true, "lease": { "status": "leased", "holderIdentity": "api-1:req-123:session-abc:tool-xyz", "expiresAt": "2026-06-01T12:00:45.000Z" } }
  ]
}
```

### `GET /health`
```json
{ "ok": true, "kubernetes": "connected", "sandboxPodsReady": 8 }
```
Checks that the cluster is reachable and counts `Running` pods labeled `app=sandbox-runner`. It is not lease-aware — for live lock state use `/pods`.

---

## 3. Architecture

```
                         ┌─────────────────────────────┐
  POST /chat ───────────▶│   pi-agent Deployment (1 pod) │
                         │                               │
                         │  RealPiClient (Pi SDK)         │
                         │   └─ Gemini 2.5 Flash model    │
                         │   └─ tool calls: shell_run,    │
                         │      fs_read, env_inspect      │
                         │        │                       │
                         │        ▼                       │
                         │  tools/index.ts (allowlists)   │
                         │        │                       │
                         │        ▼                       │
                         │  sandbox/runner.ts             │
                         │   acquire → exec → release     │
                         │        │            │           │
                         │        ▼            │           │
                         │  k8s/lease.ts       │           │
                         │  (Lease objects)    │           │
                         └────────┼────────────┼───────────┘
                                  │            │
                                  ▼            ▼
                     ┌─────────────────────────────────┐
                     │  StatefulSet: sandbox-runner-0..7  │
                     │  (8 warm pods)                     │
                     │  8 Lease objects (1 per pod)       │
                     └─────────────────────────────────┘
```

The chat/model layer never touches sandbox pods directly. Every tool call funnels through a single choke point — `runInSandbox()` — that guarantees a pod is exclusively leased, used, and released, regardless of whether the tool call succeeds, fails, or times out.

---

## 4. Design: Pod Locking with Kubernetes Leases

### Why `Lease` objects

| Option | Problem |
|---|---|
| In-memory lock (e.g. a `Set` of busy pod names) | Only works within a single process. With 2+ API replicas, two replicas can both think a pod is free. If the process crashes holding the lock, it's lost with no recovery path. |
| Redis lock | Works across replicas, but adds another stateful service to operate, duplicating state Kubernetes already tracks. |
| Pod annotation as the lock | No built-in optimistic-concurrency contract for this use case, and mixes "what is this pod" with "who holds it right now." |
| Kubernetes `Lease` (used here) | Purpose-built for this: `holderIdentity`, `acquireTime`, `renewTime`, `leaseDurationSeconds`, with resourceVersion-based optimistic concurrency already provided by the API server. No extra infrastructure. |

### Optimistic concurrency

Every Kubernetes object carries a `resourceVersion`. Writing an object requires sending back the version you last read; if anyone else wrote to it in between, the server rejects the write with **HTTP 409 Conflict** rather than silently overwriting it — a compare-and-swap, for free, from etcd's consistency guarantees exposed through the API server.

```
src/k8s/lease.ts — acquireLease()
  for each pod in [sandbox-runner-0 .. 7]:
    read the Lease (captures its current resourceVersion)
    if free or expired:
        try to replace it with our holderIdentity
        → success: we own the pod, return it
        → 409 conflict: someone else won the race, try the next pod
  if all 8 are busy: throw NO_POD_AVAILABLE
```

### `holderIdentity` format

```
holderIdentity = "<instance-id>:<requestId>:<sessionId>:<toolCallId>"
```
A single string that answers "who holds this pod and why" just by reading the Lease. `instance-id` is generated once per process start, so multiple API replicas (a future state) remain distinguishable.

### Lease expiry & crash recovery

Each Lease carries `leaseDurationSeconds: 45`. On every scan, a lease is treated as free if:
```
!holder || !acquireTime || (now - acquireTime) > leaseDurationSeconds * 1000
```
This is what makes crash recovery automatic: if the API pod dies mid-tool-call while holding a lease, that lease is never explicitly released — but 45 seconds later, any request scanning pods sees it as expired and reclaims it. No watchdog process, no manual cleanup; it's a property of the read path. Covered by `tests/integration/lease.test.ts` ("recovers an expired lease").

### Implementation notes

Two issues surfaced during development, worth being aware of when reading this code:

- `@kubernetes/client-node`'s `ApiException` exposes the HTTP status as `.code`, not `.statusCode`. Checking the wrong field meant a genuine 409 conflict fell through to `throw` instead of `continue`-ing to the next pod — invisible under sequential testing, only visible under real concurrent load.
- `Lease.spec.acquireTime`/`renewTime` require `MicroTime` formatting (6-digit fractional seconds, `.000000Z`). A plain `Date.toISOString()` only produces 3 digits and the API server rejects it with 400. Fixed by using the client library's `V1MicroTime` class.

---

## 5. FIFO Queue & Timeouts

When all 8 leases are busy, a tool call doesn't fail immediately — it waits up to **15 seconds** for a pod to free up.

```
src/sandbox/events.ts    — a single shared EventEmitter (podEvents)
src/sandbox/queue.ts     — waitForPod(): pushes into an in-memory array, listens for "released"
src/sandbox/runner.ts    — runInSandbox()'s finally block: releaseLease() then podEvents.emit("released")
```

Every release fires `"released"`. Every queued waiter listens, but only the waiter at the front of the queue (`queue[0]`) is allowed to act on it — everyone else no-ops. This is what makes it FIFO: even though all waiters hear every release, only the oldest one attempts `acquireLease()`. If it succeeds, it removes itself; the next release event lets the new front-of-queue waiter go.

```
9th request, all 8 pods busy
    → pushed into queue, queue.length = 1
    → 15s timer starts
    → "released" fires → front-of-queue tries acquireLease()
        → success → resolve, remove from queue, return the pod
        → OR 15s elapses first → reject with CAPACITY_TIMEOUT
```

**Why process-local is acceptable here:** the assignment scopes this to a single API replica, so a process-local array + EventEmitter is sufficient — there is only one process making acquisition decisions. With 2+ replicas this breaks down, since each replica's queue has no visibility into the others'; see [Production Considerations](#14-production-considerations) for the fix.

`runInSandbox()` (`src/sandbox/runner.ts`) is the single function every tool call passes through:
```
acquireLease()                          // throws NO_POD_AVAILABLE if all 8 busy
  → if NO_POD_AVAILABLE: waitForPod()   // queue, up to 15s
execInPod() raced against a 30s timeout
finally: releaseLease() + emit("released")   // always runs
```
Centralizing release in one `finally` block means it's structurally guaranteed regardless of whether the tool succeeded, threw, or timed out — none of the 3 tools have to remember to release a pod themselves.

---

## 6. Tool Execution

`src/k8s/exec.ts` uses `@kubernetes/client-node`'s native `Exec` class — the WebSocket `pods/exec` API — rather than shelling out to `kubectl`.

**Trade-offs:**
- No extra binary in the sandbox image, no subprocess spawn per call.
- This is the documented SDK usage pattern, not a workaround.
- Requires the namespace `Role` to grant `get` on `pods/exec` (in addition to `create`) — this cluster authorizes the exec WebSocket against `get`, while `kubectl exec`/the Bun variant's subprocess approach use `create`.
- Runtime-coupled: `@kubernetes/client-node` resolves `WebSocket` through `isomorphic-ws`, which is the real `ws` npm package under Node but resolves to Bun's own internal WebSocket shim under Bun. That shim only reads TLS options from a nested `options.tls.*` shape rather than the flat `ca`/`cert`/`key`/`rejectUnauthorized` fields `KubeConfig.applyToHTTPSOptions()` produces, so the cluster's auth/cert never reaches the TLS layer — this is why the Bun variant uses a `kubectl` subprocess instead.
- A 30s timeout in `runner.ts` stops the API service from waiting on the call, but does not forcibly terminate the exec connection or the command still running in the pod (see [Known Limitations](#13-known-limitations)).

---

## 7. Tools and Allowlisting

`src/tools/index.ts` wraps `runInSandbox()` with input validation. This is not a sandbox by itself — containment comes from the pod's `securityContext` (non-root, no privilege escalation, resource limits) plus the allowlist preventing arbitrary commands from ever reaching the pod's `pods/exec` endpoint.

- **`shell.run`** — only `pwd`, `ls`, `cat`, `whoami`, and the exact string `node --version` are allowed. Any path argument to `cat`/`ls` runs through the same path validator as `fs.read`.
- **`fs.read`** — rejects absolute paths and any path containing a `..` segment. Implemented as `cat <path>` under the hood.
- **`env.inspect`** — the only tool with no user-controlled input, so it skips validation and runs a fixed `sh -c "pwd && whoami && (node --version || echo n/a)"`.

A rejected command fails before any Lease is acquired or pod touched — invalid input costs nothing against the pool's capacity. Every tool call logs a `tool.call.requested` line before validation runs, so rejected attempts are still visible in the logs.

---

## 8. Pi SDK Integration

**`src/pi/client.ts`** defines the SDK-agnostic contract:
```typescript
interface PiClient {
  runChat(input: ChatInput): Promise<ChatResult>;
}
```

**`src/pi/pi.ts`** implements `RealPiClient` using the real `@earendil-works/pi-coding-agent` SDK — `createAgentSession()`, `defineTool()`, `session.prompt()`. The 3 sandbox tools are registered as custom tools with an explicit `tools: [...]` allowlist passed to `createAgentSession()`. This has a security side effect worth noting: providing an explicit allowlist excludes the SDK's own built-in tools (`read`, `bash`, `edit`, `write`), which would otherwise execute **locally on the API server's filesystem** — exactly what the Kubernetes sandboxing exists to prevent.

**Model:** Pi-specific credentials were not provided for this assignment. The Pi SDK supports multiple providers (Anthropic, OpenAI, Gemini, and others) via `getModel()`, so Gemini 2.5 Flash (`google` / `gemini-2.5-flash`, configured through `GEMINI_API_KEY`) is used as the live model. The `PiClient`/`RealPiClient` abstraction is what makes this swap a one-line change — nothing else in the codebase depends on which provider is configured.

**Tool naming:** the model sees underscore-named tools (`shell_run`, `fs_read`, `env_inspect`) since dots aren't universally safe in function-calling schemas. The API response maps them back to the dotted format (`shell.run`, `fs.read`, `env.inspect`) via a lookup table in `pi.ts`.

**Response construction:** `session.subscribe()` collects every `tool_execution_end` event into a `toolCalls[]` array. After `session.prompt()` resolves, the last assistant message's text content is extracted and returned alongside the tool call summary.

**Scope:** each request creates a fresh, in-memory session (`SessionManager.inMemory()`) and disposes it after one turn. `sessionId` is round-tripped in the response but does not maintain multi-turn context across separate `/chat` calls.

---

## 9. Kubernetes Manifests

| File | Purpose |
|---|---|
| `namespace.yaml` | `pi-agent` namespace — everything is scoped here, nothing cluster-wide. |
| `serviceaccount.yaml` | `pi-agent-sa` — identity the API pod runs as. |
| `role.yaml` | Namespace-scoped `Role`: `get/list/watch` pods, `get/create` pods/exec, `get` pods/log, `get/list/create/update/patch` leases. No wildcard verbs, no cluster-admin. |
| `rolebinding.yaml` | Binds the Role to the ServiceAccount, in-namespace only. |
| `statefulset.yaml` | 8 replicas (`sandbox-runner-0..7`), `node:22-alpine`, `sleep infinity`, `runAsUser: 65534`, `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, CPU/memory requests and limits set. A StatefulSet (not a Deployment) specifically because it guarantees stable, predictable pod names — the Lease-per-pod model depends on `sandbox-runner-0` always being named `sandbox-runner-0`. |
| `leases.yaml` | 8 `coordination.k8s.io/v1` Lease objects, one per pod, `leaseDurationSeconds: 45`. |
| `deployment.yaml` | The API service, 1 replica, reads `GEMINI_API_KEY` from a Secret. |
| `service.yaml` | ClusterIP, port 3000, routes to the deployment. |
| `secret.yaml` | Template for the `ai-credentials` Secret — never commit a real key here, only the placeholder. |

**Network traffic assumptions:** the API pod needs **egress** to the Kubernetes API server (in-cluster) and to `generativelanguage.googleapis.com` over HTTPS/443, and needs **ingress** on port 3000 to receive `/chat`/`/pods`/`/health` requests via the `Service`. The sandbox pods need **no egress at all** — they never initiate outbound connections — and only need **ingress** for the `pods/exec` WebSocket stream the API server proxies in through the kubelet; nothing else ever connects to them directly. No `NetworkPolicy` is currently applied; see [Production Considerations](#14-production-considerations).

---

## 10. Testing

```bash
npm test                  # unit tests — no cluster needed, pure validation logic
npm run test:integration  # real cluster required — Leases, real pods, real Pi SDK call
```

`tests/unit/tools.test.ts` exercises only the synchronous-throw validation paths in `shell.run`/`fs.read` (disallowed command, absolute path, path traversal) — no network dependency, runs in under a second. Everything else needs a live cluster (real `Lease` objects, real WebSocket `pods/exec`, a real Gemini API call) and lives in `tests/integration/`.

`vitest.config.ts` sets `fileParallelism: false`: the integration test files share the same 8 real cluster pods/leases, and Vitest parallelizes test files by default, which caused cross-file contention (`NO_POD_AVAILABLE` from one file's tests stealing pods another file's test expected to be free).

### Required test coverage

| # | Test | File |
|---|---|---|
| 1 | Acquiring a free pod | `lease.test.ts` |
| 2 | Release after success | `lease.test.ts` |
| 3 | Release after failure | `lease.test.ts` |
| 4 | Release after timeout | `lease.test.ts` |
| 5 | Concurrent calls never double-acquire | `lease.test.ts` (5-way concurrent) |
| 6 | >8 concurrent calls enter the queue | `queue.test.ts` |
| 7 | Queued call runs once a pod frees | `queue.test.ts` |
| 8 | Queued call times out after max wait | `queue.test.ts` |
| 9 | Expired lease recovery | `lease.test.ts` |
| 10 | `/pods` reflects live Lease state | `pods.test.ts` |
| 11 | Real Pi SDK chat triggers sandbox execution | `pi.test.ts` |

---

## 11. Observability

`src/log.ts` is a minimal structured JSON logger — one line per event, no external logging framework. Every required event is emitted:

```
chat.request.started / chat.request.completed
tool.call.requested
queue.wait.started / queue.wait.completed / queue.wait.timeout
lease.acquire.attempted / lease.acquired / lease.conflict / lease.released
tool.execution.started / tool.execution.completed / tool.execution.failed / tool.execution.timeout
```

Every line carries `requestId`, `sessionId`, and `toolCallId` where applicable, so a single request's full lifecycle can be filtered out of the logs by request ID across every layer of the system.

---

## 12. Security Posture

- No arbitrary shell execution — fixed allowlist in `shellRun()`.
- Path allowlist in `fsRead()` / `validatePath()` — rejects absolute paths and `..` traversal.
- Namespace-scoped RBAC — `Role`/`RoleBinding`, no `ClusterRole`, no wildcard verbs.
- No cluster-admin permissions anywhere.
- No `hostPath` mounts in the StatefulSet.
- No privileged containers — `allowPrivilegeEscalation: false`, `runAsNonRoot: true`, `runAsUser: 65534`.
- Resource requests/limits set on every sandbox pod (`cpu: 50m/200m`, `memory: 64Mi/128Mi`).

---

## 13. Known Limitations

- **Orphaned exec connections on timeout.** When `runInSandbox()`'s timeout fires, the underlying WebSocket exec connection and whatever it's running inside the pod keep running in the background — execution is abandoned, not cancelled. Harmless for the current allowlisted commands (all finish in milliseconds), but a real gap if the allowlist ever grew to include longer-running tools.
- **No conversation history across `/chat` calls.** Each request creates and disposes a fresh in-memory Pi SDK session. `sessionId` is round-tripped but not used to maintain multi-turn context.
- **`releaseLease()` doesn't verify the caller still holds the lease before clearing it.** In the normal path this is fine, but a release that's delayed long enough for the lease to expire and be reacquired by someone else could clear that new holder's ownership instead of its own.
- **`acquireLease()` always scans pods starting from `sandbox-runner-0`.** Correct, but contention concentrates on the first pod in the list under load rather than being spread across the pool.
- **`/pods` and `/health` do a full pod list plus 8 sequential lease reads on every call.** Fine at this scale; a `Watch`-based cache would be preferable if polled frequently.
- **The pool size (8) is hardcoded** in `lease.ts`, the StatefulSet replica count, and the Lease manifests — three places that have to stay in sync rather than one source of truth.

---

## 14. Production Considerations

**Process-local queue.** Sufficient for a single API replica. With 2+ replicas, each replica's queue is invisible to the others, so FIFO only holds within one replica — a request on a less-loaded replica could be served ahead of one that's been waiting longer on a busier replica. The fix is a shared queue all replicas can see: a Redis list (`BLPOP`) or sorted set keyed by enqueue timestamp for true global ordering, or a CRD + controller pattern if staying fully Kubernetes-native.

**Lease renewal for long-running tools.** A lease is currently acquired once and released once. A tool that runs longer than `leaseDurationSeconds` (45s) needs its holder to periodically `PATCH` `renewTime` as a heartbeat, or another request could see the lease as expired and steal the pod mid-execution — the same pattern Kubernetes' own leader-election library uses.

**API process crashes.** Lease expiry handles recovering the *lock*, but not the *caller* — if the process crashes mid-request, the client gets a dropped connection with no retry. A production version would want the request itself to be resumable/idempotent, keyed by `requestId`, so a retry doesn't double-execute a tool that already ran.

**Execution history / audit.** Today the only durable record is structured logs and the transient Lease `holderIdentity`. Production should write every execution to a durable store (`requestId, toolCallId, pod, command, exitCode, startedAt, endedAt`) independent of log retention.

**Pod image hardening.** Currently a general-purpose Alpine image with a shell. If the allowlist ever grows, a purpose-built minimal image with only the allowed binaries present (no shell) limits what a hypothetical allowlist bypass could reach.

**Network isolation.** No `NetworkPolicy` exists today. Production should default-deny pod egress/ingress in the namespace, then explicitly allow: API pod → Kubernetes API server, API pod → the model provider's API over 443. Sandbox pods need no exceptions since they never initiate outbound traffic.

**Per-tenant limits.** Today there's one global pool of 8, shared by everyone. Multi-tenant production needs either a reserved slice per tenant or a fair-share scheduler with an explicit quota check before a request is even allowed to enqueue.

**Metrics and alerts.** Missing today: queue depth over time, queue wait time (p50/p99), lease hold duration distribution, 409-conflict rate (a contention proxy), `sandbox_capacity_timeout` rate (a pool-undersized signal), and pod-not-ready count. Each structured log event in [Observability](#11-observability) is already shaped to scrape into Prometheus counters/histograms with `requestId`/`pod` as labels.
