# TASK-616 Appendix G — Zero-Downtime Deployment & High Availability

**Date**: 2026-08-07 · **Status**: Draft for owner decision — nothing applied.

---

## G0. The headline: the drain is dead code, and it's one line of YAML

**Verified directly, 2026-08-07.** All three probes on `hope-api` point at the same endpoint:

```
base/api.yaml:97   startupProbe   → /api/v1/health
base/api.yaml:103  readinessProbe → /api/v1/health
base/api.yaml:110  livenessProbe  → /api/v1/health
```

And `/api/v1/health` — `health.controller.ts:154-180` — **returns HTTP 200 unconditionally**. It computes a `status` string (`'unhealthy'` / `'degraded'` / `'healthy'`) and puts it *in the response body*. It never throws:

```ts
check() {
  const isShuttingDown = this.shutdownService.isShuttingDown;
  let status: string;
  if (isShuttingDown) status = 'unhealthy';   // ← a string in the body, not a status code
  ...
  return { status, ... };                      // ← always 200
}
```

The correct endpoints exist and work properly, one line above:

```ts
@Get('ready')     → throws ServiceUnavailableException (503) when !isReady   // :124-137
@Get('startup')   → throws 503 while initializing                            // :139-152
@Get('live')      → returns 200, pure process check                          // :115-122
```

**Three consequences, all live today:**

1. **The readiness gate can never close.** `GracefulShutdownService` sets `_isReady = false` and waits 5 s before shutdown — but nothing observes it, so the pod is never removed from Service endpoints. The entire graceful-drain implementation is unreachable code.
2. **The liveness probe can never fail.** A deadlocked event loop is never detected or restarted.
3. **The startup probe can never fail.** Traffic can arrive before initialization finishes.

**Fix — three lines:**

```yaml
startupProbe:   { httpGet: { path: /api/v1/health/startup, port: 8868 } }
readinessProbe: { httpGet: { path: /api/v1/health/ready,   port: 8868 }, periodSeconds: 5, failureThreshold: 2 }
livenessProbe:  { httpGet: { path: /api/v1/health/live,    port: 8868 } }
```

Every other zero-downtime mechanism in this document is downstream of that gate working.

### G0.0 Scope correction — this affects **four** services, not one

Verified 2026-08-07 while drafting [TASK-627](../TASK-627-Service-Health-Probes-And-Lifecycle-Standards/README.md). The same defect class is present in three more services, each of which **already has a working `/health/ready` endpoint that its manifest never calls**:

| Service | Manifest probe paths | Correct endpoint that exists | Effect |
|---|---|---|---|
| `api` | `/api/v1/health` × 3 | `/health/ready` (`health.controller.ts:124`) | Readiness can never fail |
| `nlp` | `/api/v1/health` × 3 | `/health/ready` (`nlp/api/v1/rest/monitoring.py:86`) | Readiness can never fail |
| `smr` | `/api/v1/health/live` × 3 | `/health/ready` (`smr/api/endpoints/health.py:111`) — with unit tests asserting it returns non-200 when unhealthy | **Readiness probe points at the *liveness* endpoint** |
| `tts` | `/api/v1/health/live` × 3 | `/health/ready` | Same |
| `guardrail` | `/api/health/live` + `/api/health/ready` ✅ | — | **Manifest is correct.** But TASK-627 reports the endpoint itself never returns non-200 even on Redis failure — an *endpoint* bug rather than a wiring bug |

So the earlier statement that "guardrail and harness are already correct" was true of **manifest wiring only**. The fix is a per-service probe repoint across four services plus an endpoint fix in guardrail — still S effort, but four diffs rather than one.

`stt` also registers a **second, competing SIGTERM handler** (`apps/stt/src/stt/main.py:267-273`) at module import time, mirroring the `instrumentation.ts` bug below. If it wins the race against uvicorn's, the ASGI lifespan `shutdown` never runs and `shutdown_streaming()` is skipped entirely.

### G0.1 The second blocker: a competing SIGTERM handler that force-kills at 25 s

Also verified. `apps/api/src/instrumentation.ts` — preloaded via `node --import ./dist/instrumentation.js` (`package.json:12`) — registers **its own** SIGTERM handler:

```ts
:50-52   const timeout = setTimeout(() => { ... process.exit(1); }, 25_000);
:64      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
```

So two uncoordinated handlers race. Nest's budget is ~35 s (5 s drain + 30 s `SHUTDOWN_TIMEOUT_MS`); OTel force-exits at 25 s. **`terminationGracePeriodSeconds: 60` in `api.yaml:24` is fiction — the real budget is 25 s**, and a slow collector flush hard-kills the pod mid-drain, severing every WebSocket and SSE stream.

Fix: remove the `process.exit(1)` and register the OTel flush through `GracefulShutdownService.registerCleanupCallback` — which already exists and **is never called from anywhere**.

---

## G1. Per-service summary

`tGPS` = `terminationGracePeriodSeconds`. On k8s 1.34 use the native `preStop.sleep` action, not `exec: sh -c sleep`.

| Service | Current | Recommended | tGPS | preStop | Blocker to zero-downtime |
|---|---|---|---|---|---|
| **api** | Rolling `mU:0 mS:1`, replicas 1 | Same, **replicas 2** | 60 → **150** | 10s → **15s** | **P0 probe path**; then the 25 s force-exit; then the in-process WS session `Map` |
| **stt-v2** | **`Recreate`** | Rolling `mU:0 mS:1` after time-slicing | 60 → **120** | 10s → **15s** | Single-GPU assumption → up to **900 s** gap per deploy. Also crash-looping now |
| **stt-v2-worker** | **`Recreate`**, **no probes** | Rolling `mU:0 mS:1` | 60 → **620** | → **0s** | Actor `time_limit` 600 s vs tGPS 60 → SIGKILL mid-job. Redis redelivers, so *lost work, not lost data* |
| **smr** | Rolling `mU:0 mS:1` | Same | unset (30) → **60** | none → **15s** | Drains 30 s but httpx timeout is 300 s; tGPS 30 = SIGKILL exactly at the drain deadline |
| **guardrail** | Rolling | Same | unset → **60** | none → **15s** | None structural — probes already correct |
| **nlp** | Rolling | Same | unset → **45** | none → **15s** | None. Easiest service to make truly zero-downtime |
| **tts** | Rolling | Same | unset → **60** | none → **15s** | None (`/ws/tts/stream` lives in `hope-api`, not here) |
| **harness** | Rolling | Same | unset → **45** | none → **15s** | None — probes already correct |
| **harness-worker** | **does not exist** | New Deployment | → **150** | **0s** | Workflows don't execute in-cluster at all |
| **admin-console** | Rolling | Same | unset → **45** | none → **15s** | Next.js `server.js` exits on SIGTERM without draining — no handler exists |

**Also load-bearing:** there is **no Ingress for `hope-api`** — it's `NodePort 30088`. The Ingress patches in all three overlays match nothing. So there is no ingress-level draining, no TLS, and no LB deregistration to coordinate. `preStop` is the entire remedy today.

---

## G2. WebSocket and SSE — the SDK is better than you'd expect, and the server defeats it

`SttWebSocketClient` implements a real resume protocol: `{type:'resume', sessionId, lastSeq}`, exponential backoff with 50% jitter (5 attempts, 1 s → 30 s), and it re-mints a single-use ticket before reopening. The server matches it: a 200-entry resume buffer, a 15 s grace window, `rebindSession()`.

**And it's all per-process.** On SIGTERM the gateway eagerly destroys every session *without* waiting for its own grace window. The reconnect lands on a pod that has never heard of that session id, so it builds a fresh one and replies `resume_failed: unknown_session` — which the client treats as **terminal**. Nothing retries.

The WS gateway also **never checks `isShuttingDown` before accepting new connections**. `GracefulShutdownService` and `SttWsGateway` are two independent `OnModuleDestroy` hooks with no coordination.

### User-visible impact today

The microphone keeps recording through the outage and the audio is **silently discarded** — `StreamingBackendSTTProvider.processAudio` returns early when disconnected rather than queuing. (The *deprecated* provider had a real `audioQueue`; the live one doesn't.)

A clinician mid-consultation sees captions freeze, the indicator go amber then red, and captions never resume. Roughly **20–35 s of speech is lost from the live transcript, then it stops permanently.** Already-rendered transcript survives in the store; already-persisted data is safe.

### Fixes

**Server** — (a) fix the probe paths (G0); (b) neutralize the OTel handler (G0.1); (c) gate `handleConnection` on `isShuttingDown`, closing with 1001; (d) on shutdown, send `{type:'server_draining'}` + close 1012 and wait ~2 s *before* finalizing, so clients reconnect while the readiness gate is already closed; (e) **the real fix — move `SessionInfo` into Redis.** The consumer-group design already anticipates this: the group name is a stable constant (`WS_RESULT_CONSUMER_GROUP = 'captions'`) precisely so a new pod resumes from Redis's own cursor. **The Redis layer is already cross-pod-ready; only the `Map` isn't.**

**Client** — (1) buffer audio during disconnect (port the `audioQueue` from the deprecated provider); (2) treat `unknown_session` as recoverable — create a new session and emit a gap marker instead of going terminal; (3) **send `Last-Event-ID`** — `SSEClient` uses native `EventSource` but then closes and reconstructs it, defeating the browser's built-in reconnect, so every reconnect replays the task stream from `0-0`. The server already honors the header end-to-end; (4) retry 5xx on session-create and ticket-refresh — a rolling update produces exactly those codes, and `AgenticClient.request()` has no retry.

---

## G3. Redis Streams — real continuity for one path, and a foundation that can vanish

Both directions use consumer groups properly (`XGROUP CREATE` + `XREADGROUP` + `XAUTOCLAIM`), and STT has a startup recovery scan for lapsed workers.

**Covers**: STT pod restart mid-stream; gateway restart in the *result* direction; slow-consumer backpressure.

**Does not cover**, in severity order:

1. **Redis has persistence disabled and `allkeys-lru` eviction.** A Redis restart loses every stream, hash and consumer group — *and* every refresh token, so **all users are logged out**. Worse, `allkeys-lru` doesn't respect pending-entry semantics: a stream holding unacked audio can simply be evicted. **This is the largest single availability risk on the platform.**
2. **The browser→gateway hop isn't covered at all** — Redis Streams begin *at* the gateway.
3. **WS session identity isn't in Redis** — the stream survives; the right to read it doesn't.
4. **In-process decoder state is lost** — VAD/RNNoise restart cold. The docstring promises a 2 s audio replay to warm them; that is a TODO, not an implementation.
5. **The `@Sse()` routes bypass Redis Streams entirely** — they're bare Pub/Sub relays with no cursor and no replay.

### ⚠️ Redis is sized below a single session — added 2026-08-07

Verified directly:

```
infrastructure/docker/docker-compose.yml:183-186
  --maxmemory 64mb
  --maxmemory-policy allkeys-lru
  --appendonly no
  --save ""

streamingAudioBridge.service.ts:21   AUDIO_STREAM_MAXLEN = 10000
```

At ~2560 B per audio frame, one session's audio stream alone is **≈25 MB** against a **64 MB total budget** — a budget shared with refresh tokens, rate-limit counters, BullMQ sys-event jobs, and the config-invalidation caches.

**Two concurrent consultations exceed it.** `allkeys-lru` then evicts whatever is least recently used, which includes **refresh tokens (logging users out) and WS session bindings** — during *ordinary use*, not merely on restart. This reframes the Redis risk: it is not only a restart-durability problem, it is a capacity problem that bites at two concurrent users.

> **Scope limit, stated honestly**: this is the **local-dev compose** file. The production/staging Redis runs on VM 420/421 and its configuration is in neither repo — still open question §G10.2. So this is *not* proof of production's settings. It **is** the configuration governing `hope-v2-dev`, which is the namespace currently serving `api-staging.taphuynh.dev`. Confirm the VM 420/421 config before assuming either way.

### Correction — the eviction claim below was overstated

An earlier revision of this section asserted that `allkeys-lru` "does not respect consumer-group pending-entry semantics: a stream holding unacked audio can simply be evicted." Primary-source research ([redis-streams research](../TASK-628-STT-Pipeline-Production-Readiness-And-Test-Coverage/redis-streams-delivery-semantics-research.md)) found the **word "stream" does not appear anywhere on the Redis eviction page**. Redis documents no eviction/stream interaction at all.

The defensible statements are narrower, and one is stronger than what I originally wrote:

- Eviction operates on **whole keys**, so an `allkeys-*` policy can evict the entire stream key including group state and PEL. *(Inference from key-level framing — not a documented Redis behavior.)*
- **`noeviction` fails closed on the producer side, which is the behavior you want**: `XADD` carries `denyoom` while `XACK`/`XCLAIM`/`XAUTOCLAIM` do not, and the eviction page states `noeviction` returns an error on commands that cache new data while *"commands that only read existing data still work as normal."* So at `maxmemory`, ingest is rejected while consumers can still drain and ack. *(Assembled from two primary sources.)*
- **Trimming is the real silent-loss mechanism**, and it *is* documented: when an entry is trimmed while pending, *"the PELs retain the deleted entries' IDs, but the actual entry payload is no longer available… Redis will return a null value."* Redis **8.2+** adds `ACKED` trim mode — *"only removes entries that were read and acknowledged by all consumer groups"* — which is the fix, subject to a version check.

### The PHI conflict that has to be named

Persistence is off *deliberately* — the compose comment says it's "the safest posture if Redis ever caches PHI." But Redis is now also the durability mechanism for in-flight clinical audio **and** the store of record for refresh tokens. Those two positions are incompatible. Either:

- **(a)** enable AOF on a LUKS-encrypted volume, accepting encrypted-at-rest PHI in Redis; or
- **(b)** keep persistence off and formally accept that a Redis restart loses all in-flight consultations and logs out every user — then move refresh tokens to Postgres so sessions at least survive.

**(a) is the right answer** given what Redis is now asked to do. Either way, change `maxmemory-policy` to `noeviction` for the streams DB.

---

## G4. GPU — the premise is wrong

The manifests **don't request GPUs**. Access is attempted via `runtimeClassName: nvidia` plus `NVIDIA_VISIBLE_DEVICES: "nvidia.com/gpu=0"` — which is a *resource name*, not a valid device selector for that variable. Live: zero pods request `nvidia.com/gpu`, and **both GPUs read 0% while STT crash-loops**.

So `strategy: Recreate` buys downtime to protect a constraint the scheduler isn't enforcing and the workload may not even be using. **Establish whether STT is actually on GPU before optimizing its rollout** — if it's silently on CPU, the whole singleton constraint dissolves.

| Option | Downtime/deploy | Verdict |
|---|---|---|
| `Recreate` (today) | Up to **900 s** (startup budget) | Honest about the constraint, brutal in effect |
| `RollingUpdate maxSurge:0` | Identical | **Pointless** — same downtime, more config |
| **Time-slicing → `maxSurge:1 mU:0`** | **Zero** for new sessions | **Correct answer** |

Three real caveats: time-slicing gives **no memory isolation** (measure resident VRAM first — two Whisper pods on one 16 GB card can OOM the device); the **GPU Operator doesn't watch the ConfigMap**, so a device-plugin restart is required; and **surge doubles model-load I/O against `/mnt/data`, at 89% and already the cause of a DiskPressure eviction wave.** Reclaim disk first, or the surge pod fails to start and the rollout stalls — though with `maxUnavailable: 0` that at least fails safe.

### G4.1 Activation runbook

Authored as part of the GPU scheduling pass (files: `deployment/k8s/base/gpu-time-slicing.yaml`, `stt-v2.yaml`, `stt-v2-worker.yaml`, `ollama.yaml`). Nothing below has been applied to the cluster — this is the sequence for whoever does.

**Evidence gathered (read-only, 2026-08-07):** `ssh gpu nvidia-smi` — GPU0 3930 MiB used / 16380 MiB total, GPU1 3753 MiB used / 16380 MiB total; `--query-compute-apps` showed one ~3.9 GiB process on GPU0 (stt-v2) and a 3626 MiB + 116 MiB pair on GPU1 (stt-v2-worker + a companion process). Resident VRAM per STT pod is therefore **~4 GiB**, not measured-and-guessed. `replicas: 3` in the time-slicing ConfigMap was chosen from that number: at most 3 pods can ever land on one physical card (the device plugin only ever advertises 3 slices per card, regardless of how kubelet packs them), so the worst case is 3 x ~4 GiB = ~12 GiB against 16 GiB — a ~4 GiB margin, which matters because Ollama's larger catalog entries were not GPU-resident at measurement time and its real footprint under load is unverified. `replicas: 4` (the generic SOTA-doc default) would zero out that margin.

**0. Pre-flight — disk pressure must be clear first.** Surge doubles concurrent model-load I/O against `/mnt/data`, which was at 89% and had already triggered a DiskPressure eviction wave. A surge pod that can't pull/mmap its model while disk is under pressure fails to become Ready — with `maxUnavailable: 0` that stalls the rollout rather than dropping traffic, but it still blocks the deploy. Check before touching anything else:
```bash
kubectl describe node dell | grep -A3 Conditions   # DiskPressure must be False
ssh gpu df -h /mnt/data                             # reclaim headroom if still >85%
```

**1. Apply the time-slicing ConfigMap directly — NOT through the app kustomize tree.** `gpu-time-slicing.yaml` targets the `gpu-operator` namespace, a cluster-wide operator namespace, not one of `hope-v2-{dev,staging,prod}`. All three overlays set a Kustomize-global `namespace:` transformer that rewrites the namespace of every resource under `base/`, including this one, if it were added to `base/kustomization.yaml`'s `resources:` list. **Do not register it there** — apply it standalone, the same way the GPU Operator itself sits outside this repo's kustomize tree:
```bash
kubectl apply -f deployment/k8s/base/gpu-time-slicing.yaml
```

**2. Patch the ClusterPolicy to activate it.** The Operator only reads this config when the ClusterPolicy points at it:
```bash
kubectl patch clusterpolicies.nvidia.com/cluster-policy -n gpu-operator \
  --type merge \
  -p '{"spec":{"devicePlugin":{"config":{"name":"time-slicing-config","default":"any"}}}}'
```

**3. Restart the device-plugin DaemonSet — the Operator does not watch the ConfigMap.** Editing or applying the ConfigMap alone changes nothing; the running device-plugin pods keep advertising the old (non-time-sliced) device count until they restart and re-read it:
```bash
kubectl rollout restart daemonset/nvidia-device-plugin-daemonset -n gpu-operator
kubectl rollout status daemonset/nvidia-device-plugin-daemonset -n gpu-operator
```
**This restart is itself a brief disruption** — the device plugin re-registers with kubelet, and `nvidia.com/gpu` allocatable briefly disappears from the node during the swap. Any GPU pod actively starting during that window can fail to schedule. Do this in a maintenance window, not mid-deploy.

**4. Verify the new allocatable count before touching workloads:**
```bash
kubectl get node dell -o jsonpath='{.status.allocatable.nvidia\.com/gpu}'
# expect 6 (2 physical x replicas: 3), not the original 2
```
If it still reads 2, the device-plugin restart in step 3 hasn't completed or the ClusterPolicy patch in step 2 didn't land — do not proceed to workload changes.

**5. Only then roll out the workload changes** (`stt-v2.yaml`, `stt-v2-worker.yaml`, `ollama.yaml`): the malformed `NVIDIA_VISIBLE_DEVICES` env var removed, real `resources.requests/limits: {nvidia.com/gpu: "1"}` added, `runtimeClassName: nvidia` kept, and `stt-v2`/`stt-v2-worker` moved from `Recreate` to `RollingUpdate` (`maxUnavailable: 0, maxSurge: 1`). If step 4's allocatable count is still 2 when this lands, the surge pod for `stt-v2` or `stt-v2-worker` will sit `Pending` (no GPU to schedule onto) — harmless under `maxUnavailable: 0` (old pod keeps serving) but the rollout will stall exactly like it would pre-time-slicing.

**Rollback:** revert the `strategy` to `Recreate` in the two Deployments if GPU OOMs appear under DCGM monitoring post-cutover; the time-slicing ConfigMap and ClusterPolicy patch can stay in place (extra unused slices are harmless) or be reverted with the inverse `kubectl patch` setting `default` back to unset.

---

## G5. Migrations — the convention is real, the enforcement is absent

Across 70 migrations: 30 `DROP COLUMN`, 2 `DROP TABLE`, 12 `SET NOT NULL`, 20 inline backfills, **0 `ADD COLUMN NOT NULL` without a default** (all safe), and **0 uses of `CREATE INDEX CONCURRENTLY` across 122 index creations**.

The discipline is visibly real — the `task_576` contract migration documents that its paired expand *copied, never moved* rows, and is marked "requires explicit owner approval." **But the expand/contract pair sits one hour apart in the same directory**, and `prisma migrate deploy` applies both in one batch. Safety currently rests on a human reading a comment. No CI gate checks migration SQL.

**Two migrations are blocking regardless of strategy**: a full `AuditLog` rewrite under `ACCESS EXCLUSIVE` (enum type swap), and six plain `CREATE INDEX` on live PHI tables. No rolling-update strategy helps — that's hard downtime.

### `migrate.sh` is actively destructive today

```sh
if [ "$NODE_ENV" = "production" ] || [ "$NODE_ENV" = "staging" ]; then
  prisma migrate deploy
else
  prisma db push        # ← dev overlay sets NODE_ENV=development
fi
tsx .../index.js        # ← full seed, unconditionally, EVERY run
```

`db push` reconciles by force and **drops columns without a migration record**. The unconditional seed re-runs all 25 phases, and plain upserts (`seedGlobalSetting`, `seedPromptTemplate`, `seedRateLimitSettings`) **overwrite admin-edited config back to seed defaults on every sync.** Fix this regardless of anything else here.

### The `_version` / OCC interaction

Three migrations bump `_version` in a backfill. `_version` is the source of the strong `ETag`, and `RequiresIfMatchGuard` returns **412** on drift. So **any admin holding a page open across such a deploy gets a spurious "someone else modified this record"** on save. Not corruption — OCC working as designed — but a deploy-correlated 412 storm that reads as a bug. Rule: a migration may bump `_version` only when it genuinely changes a user-visible field.

---

## G6. Temporal workers

**Workflow durability is a non-issue** — a workflow parked at the clinician gate is a durable server-side timer (24 h SLA, 12 h escalations, ~60 h max), not an in-process wait. A worker restart replays history and re-establishes it.

**Ordering rule**: `preStop + graceful_shutdown_timeout < tGPS`. The longest activity is 900 s with a 60 s heartbeat. Two options: wait out the worst case (`timeout=900`, `tGPS=930`, 15-minute drains), or **rely on heartbeat + retry** (`timeout=120`, `tGPS=150`) — activities over 120 s are cancelled and rescheduled on a surviving worker with heartbeat details intact. **Take the second**; the cost is re-executing a partial inference, not a failed workflow. Use `maxSurge: 1` so the queue is never unattended.

**Versioning: stay on `workflow.patched()`.** It's used seriously — 11 call sites, each with reasoning about whether the change adds a workflow command. Worker Versioning's rainbow deployments need 3–4 concurrent worker Deployments, which a single node at 89% disk cannot afford. But **`deprecate_patch()` is never called anywhere** despite a code comment planning for it — with a 60 h max gate window, any patch older than ~3 days is safe to deprecate. Do that cleanup, or markers accumulate forever.

**Hard rule**: run `test_replay_compat` before shipping any `workflows.py` change. That's the gate that makes `patched()` safe.

---

## G7. Probes, PDBs, HPA signals

**Probe semantics**: `readinessProbe` removes a pod from endpoints without restarting it — **this is the entire zero-downtime mechanism**, since `maxUnavailable: 0` blocks the rollout until the new pod is Ready. `livenessProbe` *kills* the container, so it must be a pure process check — never a dependency check. `apps/api`'s design is right: `/health/ready` checks only in-memory flags, and dependency probing is confined to the authenticated `/health/services`. Keep that split.

**The endpoint-propagation race**: SIGTERM and EndpointSlice removal happen *concurrently*, so requests can arrive at an already-terminating pod. `preStop` sleep is the remedy — the container keeps serving normally while kubelet waits. **Rule: `preStop ≥ readiness periodSeconds × failureThreshold + propagation margin`.** Use **15 s**: costs nothing, and it's the right number the moment a second node or an ALB appears.

**PDBs — an important correction.** PDBs govern **voluntary** disruptions only (drain, autoscaler, upgrades). They have **no effect on rolling updates**. Use `maxUnavailable: 1`, not the current `minAvailable: 1`:

| replicas | `minAvailable: 1` | `maxUnavailable: 1` |
|---|---|---|
| 1 | **0 disruptions → node drain hangs forever** | 1 allowed → drain proceeds |
| 5 (HPA max) | 4 allowed — too permissive | 1 allowed — correct |

Never give a PDB to single-replica stateful pods (`hope-vault`, `hope-temporal`) — it makes the node undrainable.

**HPA signals — CPU is wrong for almost everything here.** The prod HPA uses CPU at 70%.

| Service | Right signal | Why CPU fails |
|---|---|---|
| api | Concurrent WS sessions | A gateway holding 200 idle sockets uses ~0% CPU **while at capacity — CPU scaling would scale *down* a saturated pod** |
| stt-v2 | `active_sessions / max_streams` (the counter already exists) | GPU-bound work shows low host CPU |
| stt-v2-worker | Dramatiq queue depth (KEDA) | Only thing correlated with user-visible latency |
| smr | In-flight generations | SMR mostly *waits* on LM Studio |
| nlp | CPU is fine | Genuinely CPU-bound NER |

Use **KEDA** for the queue-driven ones. For `stt-v2`, a 900 s startup makes HPA useless for bursts — use it for capacity floor, with `scaleDown.stabilizationWindowSeconds: 600`.

**Argo Rollouts: still not justified**, and for a sharper reason than resource cost — **Rollouts solves progressive traffic shifting, which is not your problem.** Your problem is connection draining and session affinity. It would add a controller and change nothing about a clinician losing 30 s of speech.

---

## G8. What single-node can and cannot deliver

**Can**: zero-downtime for stateless request/response traffic (`replicas: 2` + `maxUnavailable: 0` + a working readiness gate + `preStop` is real redundancy against process failure — `hope-api` restarted 3× in 6 h, and every one would have been invisible); rolling deploys with no dropped requests; correct expand/contract migration behavior; Temporal workflow durability; GPU surge via time-slicing.

**Cannot**: any node-failure tolerance; meaningful PDBs; anti-affinity (`required` makes the second replica permanently `Pending` — **always use `preferred`** so one manifest works at 1 node and at 3); k3s control-plane HA (SQLite, single server); storage redundancy (the `hostPath` model cache also **pins both STT pods to this node forever**); real surge headroom at 89% disk.

**Honest summary: single-node delivers *deployment* availability, not *infrastructure* availability.** That's worth having — most outages are deploys and crashes, not hardware. But don't describe it as HA to anyone clinical.

---

## G9. Ranked by (downtime eliminated ÷ effort)

| # | Change | Effort | Why here |
|---|---|---|---|
| **1** | **Point the probes at `/health/ready`, `/health/live`, `/health/startup`** | **S** (3 lines) | The drain code already exists and is unreachable. Highest ratio on the list by a wide margin |
| **2** | **Remove `process.exit(1)` from `instrumentation.ts`**; route OTel flush through `registerCleanupCallback` | **S** | Makes tGPS mean anything. Prerequisite for everything else |
| **3** | **Triage the live incident** — reclaim `/mnt/data`, fix the STT crash-loop, reap dead pods | **S–M** | Zero-downtime work on a crash-looping cluster is wasted |
| **4** | **Fix `migrate.sh`** — always `migrate deploy`; gate the seed behind `RUN_SEED=true` | **S** | Actively destructive today |
| **5** | **`replicas: 2`** for the 7 stateless services | **S** | Verify memory headroom first |
| **6** | **`preStop: 15s` + correct tGPS** on the 6 services with neither | **S** | The endpoint-propagation race |
| **7** | **Split the single-endpoint probes** on nlp, tts, smr, admin-console | **S** | Same class of bug as #1 |
| **8** | **`maxUnavailable: 1` PDBs** on every stateless workload | **S** | Correct at both cluster shapes |
| **9** | **CI gate rejecting destructive migration SQL** without `-- @contract-approved:` | **S** | Convention alone will eventually fail |
| **10** | **Gate WS `handleConnection` on `isShuttingDown`; send close 1012** | **M** | Small change, large UX difference |
| **11** | **Client: buffer audio + recover from `unknown_session`** | **M** | **The highest-value user-visible fix** — eliminates the 20–35 s of lost clinical speech |
| **12** | **GPU time-slicing + real `nvidia.com/gpu` requests** | **M** | Up to 900 s per STT deploy. Blocked on #3 |
| **13** | **Redis persistence decision + `noeviction`** | **M** | The largest SPOF blast radius. Needs a PHI policy decision |
| **14** | **`SSEClient` sends `Last-Event-ID`** | **M** | Server already supports it fully |
| **15** | **Deploy the harness worker** (`timeout=120`, `tGPS=150`) | **M** | Not downtime — *missing functionality* |
| **16–20** | Argo sync waves; `CREATE INDEX CONCURRENTLY`; WS session state into Redis; Vault HA; second node | **M–L** | #20 is the only one that makes "HA" honest |

---

## G10. Open questions

1. **Is `hope-stt-v2` actually using the GPU?** Both GPUs at 0%, malformed `NVIDIA_VISIBLE_DEVICES`, no pod requesting the resource. If it's silently on CPU, `Recreate` can be dropped today.
2. **What is the production Redis config?** The only config in either repo is local-dev compose; the research docs contradict it (`appendonly yes` vs `no`).
3. **How much VRAM does one STT pod hold resident?** Determines whether time-slicing `replicas: 4` is safe.
4. **Did expand and contract migrations ever ship in the same deploy?** `task_569` → `task_576` are one hour apart in the same directory.
5. **What's the concurrent-WS-session ceiling per API pod?** Needed for the HPA signal. Nothing bounds gateway-side sockets today.
6. **Which Temporal is authoritative** — in-cluster or host-Docker? Two schedulers on one task queue is a correctness hazard.
7. **Does uvicorn's SIGTERM handler win over STT's module-level one?** If STT's wins, the ASGI lifespan `shutdown` never runs and `shutdown_streaming()` is skipped.
8. **How long may one SMR generation legitimately stream?** Three different bounds exist for one thing: 300 s proxy cap, 30 s drain, 300 s httpx timeout.
