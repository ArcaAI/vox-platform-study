# TASK-993 — Platform Capacity & Rate Limits for 10 Tenants × 100 Concurrent Users

| Field | Value |
|---|---|
| **Status** | In Progress |
| **Type** | infrastructure / bugfix |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-09-19 |
| **Trigger** | Local testing repeatedly hits rate limits; platform must serve 10 tenants × 100 concurrent users plus several machine integrations. |

---

## 1. Requirement Analysis

Two requirements, one root system:

1. **Immediate** — local testing keeps hitting rate limits. Find the real cause, not a workaround.
2. **Target** — the platform must sustain **10 tenants × 100 concurrent users = 1,000 concurrent
   humans**, plus **several applications/systems integrated** via API keys and service accounts.

Working load model (stated as an assumption, to be replaced by measurement — see §6):
a clinically active console user issues ~10 requests/min (page loads, TanStack queries, SSE
ticket mints, polling). 1,000 users ⇒ **~10,000 req/min ≈ 167 req/s** steady-state at the
gateway, excluding audio streams and machine integrations.

**Out of scope:** pricing/packaging changes beyond the entitlement numbers needed to hit the
target; any new external runtime dependency (forbidden by `09-infrastructure-devops.md`).

---

## 2. Current State Evaluation

Every claim below was verified against code at `dev-2.2` (`5369f79c5`). Live probes were run
against the running dev gateway on `:8868`.

### 2.1 The five-rank cascade collapses into two live ranks

`TieredThrottlerGuard` (`apps/api/src/modules/throttle/tiered-throttler.guard.ts`) implements a
5-rank precedence. **Ranks 1, 2 and 4 are empty**: `seed/12-rate-limit-settings.ts` writes 9
`GlobalSetting` rows (kill-switch + 4 tiers × limit/ttl) and deliberately **zero
`RateLimitRule` rows**. Only rank 3 (plan) and rank 5 (decorator / tier baseline) are live.

### 2.2 DEFECT D-1 — every rank-5 request in the world shares one bucket per route

- `@nestjs/throttler@6.5.0` keys on `req.ip` (`dist/throttler.guard.js:141`).
- Express `trust proxy` is **never set**. `main.ts:180` calls `.set('etag', false)` and nothing else.
- ⇒ `req.ip` is the raw socket address.

**Live proof** (dev gateway, three distinct forwarded client IPs, one shared counter):

```
XFF=203.0.113.1  -> X-RateLimit-Remaining: 28
XFF=198.51.100.7 -> X-RateLimit-Remaining: 27
XFF=192.0.2.44   -> X-RateLimit-Remaining: 26
```

Locally that is `127.0.0.1` for everything — **this is the reported symptom**. In the cluster
(`cloudflared → Traefik → pod`) it is the Traefik pod IP for 100% of traffic, so all 1,000 users
would share `POST /auth/login` at **5/min** and `POST /auth/refresh` at **60/min**.

### 2.3 DEFECT D-2 — a breach is a 60-second hard lockout, not a rolling window

`blockDuration = routeOrClass || namedThrottler.blockDuration || ttl` (`throttler.guard.js:84`).
None is configured, so `blockDuration = ttl = 60_000`. The Redis Lua
(`throttler-storage-redis.service.js:41-49`) sets a block key for that duration; every later
request in the bucket is refused until it expires. Combined with D-1 that is a **platform-wide
60-second outage per breach**.

### 2.4 FINDING F-1 — an authenticated tenant gets ONE bucket for ALL routes and ALL users

For a rank-2/3 resolution the guard keys `t:<tenantId>` with **no route component**
(`tiered-throttler.guard.ts:243-253`). The plan limit is therefore the tenant's entire budget:

| Plan | maxUsers | maxConcurrentSessions | rateLimitTier | Limit (whole tenant) |
|---|---|---|---|---|
| STARTER | 5 | 5 | strict | **10 req/min** |
| TRIAL / PRO | 25 | 25 | default | **100 req/min** |
| ENTERPRISE | 100 | 100 | relaxed | **300 req/min** |
| plan = `null` | → STARTER | → 5 | → strict | **10 req/min** |

Source: `entitlements.constants.ts:283-354`, mirrored in `seed/15-entitlements.ts:267-343`
(hand-synced, pinned by `plan-matrix-parity.test.ts`). No plan sets an absolute
`rateLimitPerMinute`; each names a tier whose baseline supplies the number.

**Consequences for the target.** 100 users/tenant only fits ENTERPRISE (`PRO.maxUsers = 25`).
ENTERPRISE then allows **300 req/min across 100 doctors = 3 requests per user per minute**,
shared with every integration on that tenant. `maxUsers: 100` and `maxConcurrentSessions: 100`
sit exactly on the target, so the 101st user/session is refused. This is live, not theoretical:
`ENTITLEMENTS_GLOBAL_ENABLED_DEFAULT = true` (`entitlements.constants.ts:137`), seeded ON
everywhere except test/CI.

> Stale comment to correct: `entitlements.descriptors.ts:20` still says the code default is OFF.

### 2.5 DEFECT D-3 — `RateLimit` advisory header reports quota as "remaining"

`rate-limit-headers.interceptor.ts:38` emits `r=<limitValue>` and `t=<windowSeconds>`, both
static. Per `draft-ietf-httpapi-ratelimit-headers`, `r` is **remaining** and `t` is **seconds to
reset**. Live: `X-RateLimit-Remaining: 29` alongside `RateLimit: "default";r=30;t=60`. An
integrator reading the modern header sees full headroom forever and can never self-pace.

### 2.6 DEFECT D-4 — `Retry-After` is mis-named on non-default tiers

`throttler.guard.js:121` emits `Retry-After` + the tier suffix, so the `heavy` tier answers
`Retry-After-heavy`. `@arcaai/vox-node` reads `retry-after` (`core/errors.ts:557`), so every
heavy-tier 429 (agent invoke, workflow runs, agent bench) falls back to blind jitter backoff.

### 2.7 DEFECT D-5 — a vendor 429 in `apps/text` is never retried and surfaces as 422

- `is_provider_invalid_request()` returns `True` for **any** 4xx, including 429
  (`retry_handler.py:158-161`).
- `should_retry()` refuses that class **unconditionally, before the attempt-ceiling check**
  (`retry_handler.py:179-203`).
- The catch-all raises **`HTTPException(422, code=PROVIDER_INVALID_REQUEST)`**
  (`generate.py:1099-1102`), with **no `Retry-After`**.
- `retry_after_from(...)` at `generate.py:734` sits *after* the `should_retry` break, so for a
  429 it is **unreachable** — the Retry-After parser is dead code for the case it was written for.
- The failure still calls `cb.record_failure()` (`generate.py:1059`), so a vendor 429 storm opens
  the circuit breaker (`failure_threshold=5`) and the service then 503s for 30s.
- `vox-node` retries 408/429/5xx only, so a 422 is non-retryable there too.

The surrounding "D5" comment shows the 4xx→422 mapping was deliberate (a malformed body should
not read as "provider is down"); 429 and 408 were swept in with it by accident.

### 2.8 Runtime ceilings beneath the limiter

| Ceiling | Value | Source |
|---|---|---|
| Gateway replicas | **1**, single Node process, no cluster/worker_threads, PM2 `instances: 1` | `base/api.yaml:40`, `ecosystem.config.js` |
| Prisma pool | **`PRISMA_PG_MAX=5`** per process, 5s acquire timeout | `client.ts:63-70` |
| Postgres | `max_connections=200` (cluster), `100` (local compose) | `base/postgres.yaml:47`, `docker-compose.yml:72` |
| BullMQ | **concurrency 1 on all 11 processors** (bullmq default; no `@Processor` passes options) | `worker.js:40` |
| STT streams | 20 (single RTX A2000 dev profile) / 40 / 100 (A100); per-process `CapacityGuard` → 503 | `execution_profile.py:165,189,211` |
| Python services | **all single-process uvicorn**, no `--workers` anywhere | all six Dockerfiles |
| harness LLM | **`HARNESS_LLM_MAX_CONCURRENCY=1`** per endpoint — global serialization | `llm_concurrency.py:53,90` |
| harness activities | `HARNESS_MAX_CONCURRENT_ACTIVITIES=8` | `core/config.py:685` |
| text per-provider | user lane semaphore 4, queue 200, wait 60s; judge lane 2, no queue | `runtime_defaults.py:49,117,135` |
| guardrail | admission gate 256, batch fan-out 16, queue 4 | `core/config.py:87-102,197` |
| nlp | inference 4, peer calls 8 | `core/config.py:347,358` |
| axios → Python | **no custom agent ⇒ `keepAlive: false`**, new TCP handshake per call | all 4 `HttpModule.register` sites |
| harness → peers | **fresh `httpx.AsyncClient` per call**, no pooling | `activities.py:296,314,323,415,796` |
| Redis (cluster) | `maxmemory 512mb`, policy **`noeviction`** (refuses writes under pressure) | `components/data-tier/redis.yaml:73-80` |
| Redis (local) | `64mb`, `allkeys-lru` — **different posture, local will not reproduce** | `docker-compose.yml` |
| ioredis | `enableOfflineQueue` never set (default true) + `maxRetriesPerRequest: null` ⇒ unbounded in-process queueing during an outage | multiple clients |

`apps/text` is **deliberately** single-worker: `GenerationHub` is process-local, and the
Dockerfile records a measured 4/8 truncated stream resumes under `--workers 4`. Multi-worker is
blocked on a cross-process `XREAD BLOCK` tail. Do not "fix" it by adding workers.

### 2.9 Capacity gap

| Ceiling | Capacity | vs. ~167 req/s target |
|---|---|---|
| Rate limit (ENTERPRISE × 10) | 3,000 req/min = **50 req/s** | **3.3× short** |
| Prisma pool (5 conns) | ~250 q/s theoretical, several queries per request | short |
| Gateway process | 1 event loop, `replicas: 1` | no headroom, **no HA** |
| BullMQ audit + summaries | 1 job at a time | unbounded backlog |
| STT concurrent streams | 20 (dev GPU) / 100 (A100) | short if recording |

### 2.10 Cluster reality (verified in `hope-v2-deployment@main`)

**Correction to §2.8: HPAs DO exist.** They are co-located inside each workload's own base file,
`autoscaling/v2`, all on `Resource / cpu / averageUtilization: 75`:

| HPA | min / max |
|---|---|
| `hope-api` | 1 / 3 |
| `hope-admin-console` | 1 / 3 |
| `hope-guardrail`, `hope-nlp`, `hope-harness`, `hope-tts` | 1 / 3 |
| `hope-harness-worker` | 1 / 2 |
| `hope-stt`, `hope-stt-worker`, `hope-text` | **1 / 1** (GPU-bound / process-local `GenerationHub`) |

No VPA, no KEDA anywhere. **Every PDB is `minAvailable: 0`** — they exist so HPA/Argo health
checks have a target, and protect nothing.

**But the HPA cannot fire on the real bottleneck.** The gateway is I/O-bound — it waits on the
5-connection Prisma pool, Redis and the Python services. Under pool exhaustion, requests queue
while **CPU stays low**, so a CPU-at-75% trigger never trips. The platform will 429 and time out
at `replicas: 1` without ever scaling. A correct trigger is a saturation signal (pool-wait,
in-flight requests, p95 latency), not CPU.

**Resources (dev-effective):** `hope-api` 500m/2 CPU, 512Mi/2Gi mem. Postgres 500m/4, 2Gi/8Gi,
`max_connections=200`, `shared_buffers=2GB`, PVC 60Gi. `hope-stt` + `hope-stt-worker` hold 1 GPU
each (2 of the 6 time-sliced units).

**`PRISMA_PG_MAX` is not set in the deployment repo at all** — the app default of 5 applies in
the cluster. `base/postgres.yaml:42` sized `max_connections=200` *expecting* 5/replica.
`RATE_LIMIT_*` and `NODE_OPTIONS` are likewise unset anywhere in the repo.

### 2.11 DEFECT D-1 revised — the client IP is in `CF-Connecting-IP`, not `X-Forwarded-For`

This changes the fix. Per `docs/cloudflare-tunnel.md:109-110`, Cloudflare's edge stamps
**`CF-Connecting-IP`** before the request enters the tunnel. Traefik's own TCP peer is the
**cloudflared pod** (2 replicas), so any `X-Forwarded-For` Traefik sets reflects cloudflared, not
the browser — and no `forwardedHeaders.trustedIPs` is configured anywhere.

⇒ Enabling Express `trust proxy` alone is **not** the fix; it would trust a header that carries
the wrong address, and would trust it from any caller. The tracker must prefer `CF-Connecting-IP`
from the trusted ingress path, and must not be spoofable by a direct caller.

### 2.12 F-2 — the reconnect storm already observed, and why it will cascade

`base/dashboards/platform.json:1175` records a measured symptom:

> "on 2026-09-18 a fixed ~128s drop cadence produced **341 reconnects against 33 sessions**."

Echoed in `base/alert-rules.yaml:1021-1029`, which notes it is **not yet alertable** (the gateway
publishes session state to Redis, not Prometheus) and is an open TASK-989 follow-up. No timeout is
configured on either the cloudflared or the Traefik hop in the repo, so the ~128s cadence is an
unconfigured default somewhere in the chain.

**This connects to the rate limiter.** Every WS/SSE reconnect mints a fresh single-use
`POST /auth/stream-ticket`, which rides the **default tier at 100/min**. 341 reconnects in the
observed window already approaches that ceiling at 33 sessions. Scaled to 1,000 users the
reconnect storm becomes self-sustaining: drops → ticket mints → 429 → failed reconnects → retries.
**Fixing the rate limits without fixing the drop cadence converts one failure into two.**

### 2.13 Redis: local and cluster have deliberately DIFFERENT postures (not docs drift)

Checked directly, because the lane report claimed the rule files were stale and they are not:

| Where | Config | Verdict |
|---|---|---|
| Local compose (`infrastructure/docker/docker-compose.yml:277-282`) | `--appendonly no --save ""`, `maxmemory 64mb`, `allkeys-lru` | persistence genuinely disabled — `09-infrastructure-devops.md:33` is **correct** |
| Cluster (`hope-v2-deployment` `components/data-tier/redis.yaml:46-81`) | AOF `everysec` on an 8Gi PVC, `maxmemory 512mb`, **`noeviction`** | persistence deliberately ENABLED; the manifest comment records that the old `emptyDir` design silently dropped BullMQ jobs already accepted with a 2xx |

No rule file claims anything about the CLUSTER Redis persistence, so there is nothing to correct
there. The real hazard is the divergence itself: **local dev evicts (`allkeys-lru`), the cluster
refuses writes (`noeviction`)**. The throttler counters, the socket registry and every BullMQ queue
write to that instance, so a memory-pressure failure mode exists in production that local testing
can never reproduce. Sizing that headroom is lane E's item 4.

---

## 3. Implementation Plan

Lanes A–C are unambiguous defects and need no policy input. Lanes D–E depend on owner decisions
in §5.

| Lane | Scope | Files owned |
|---|---|---|
| **A** | D-1 client-IP tracker (`CF-Connecting-IP`, see §2.11 — NOT plain `trust proxy`), D-3 header correctness, D-4 Retry-After tier naming | `apps/api/src/main.ts`, `apps/api/src/modules/throttle/**` |
| **B** | D-5 vendor 429: retry it, pass it through as 429 + `Retry-After`, keep it off the breaker | `apps/text/src/text/services/retry_handler.py`, `apps/text/src/text/api/endpoints/generate.py`, `apps/text/src/text/core/exception_handlers.py` + tests |
| **C** | Connection reuse: `keepAlive` agent on all 4 gateway `HttpModule.register` sites | `apps/api/src/modules/{agent,speech,streaming,text-compat}/*.module.ts` |
| **D** | Capacity defaults: `PRISMA_PG_MAX`, BullMQ concurrency, plan entitlement numbers, per-principal bucketing | `.env.dev`/`.env.sample`, `entitlements.constants.ts`, `seed/15-entitlements.ts`, `redis.service.module.ts`, processors |
| **E** | Cluster: HPA trigger metric (§2.10), `PRISMA_PG_MAX`, PDB `minAvailable`, Redis memory, the ~128s drop (§2.12) | **`hope-v2-deployment` repo** (separate checkout, merge target `main`) |

TDD per lane: failing test first, then minimal fix, then refactor. Each lane runs its own gates
(`lint` / `typecheck` / `test` / `build` for the packages it touches) and reports pasted output.

---

## 4. Verification Criteria

- [ ] A: two distinct forwarded client IPs receive **independent** counters (the §2.2 probe inverts).
- [ ] A: `RateLimit` `r=` decrements in step with `X-RateLimit-Remaining`; `t=` counts down.
- [ ] A: a heavy-tier 429 carries a plain `Retry-After`.
- [ ] B: a simulated vendor 429 is retried with backoff, honors `Retry-After`, and surfaces as
      **429 + Retry-After** (not 422); a 400 still surfaces as 422; the breaker does not trip on 429.
- [ ] C: gateway→Python calls reuse sockets (connection count flat under repeated calls).
- [ ] D/E: per §5 answers.
- [ ] No regression: `pnpm test:unit`, affected package builds, `pnpm lint`.

---

## 5. Owner Decisions — ANSWERED 2026-09-19

| # | Decision | Answer |
|---|---|---|
| **OD-1** | Headroom over the load model | **3×, then load-test to confirm.** Baseline revised up: a console screen fires 10–15 TanStack queries, so an active user is ~30–50 req/min, not 10. |
| **OD-2** | Bucketing model | **Two-level: per-principal bucket under a tenant-wide aggregate ceiling.** The plan number becomes a capacity guard, not a per-user budget. |
| **OD-3** | Scaling | **Fix the pool + drive the HPA off a saturation signal**, not CPU. |
| **OD-4** | ENTERPRISE `maxUsers` / `maxConcurrentSessions` headroom | Decided by the orchestrator: both currently sit exactly ON the 100-user target, which fails the stated requirement. Lane D raises them with headroom and justifies the figure. |

### Superseded — the original question set

| # | Decision | Why it could not be defaulted |

| # | Decision | Why it cannot be defaulted |
|---|---|---|
| **OD-1** | Per-plan rate limits for the target. Current ENTERPRISE = 300/min for 100 users. | Pricing/packaging, not engineering. |
| **OD-2** | Bucketing model: keep one tenant-wide counter, or add a **per-principal** bucket under a tenant-wide ceiling. | Changes documented semantics (`tiered-throttler.guard.ts:245-247` states tenant-wide is intentional). Recommended: two-level. |
| **OD-3** | Gateway HPA ceiling (now 1/3) and the trigger metric. CPU-at-75% cannot fire on an I/O-bound bottleneck (§2.10). | Cost + a custom/saturation metric is new infrastructure. |
| **OD-4** | ENTERPRISE `maxUsers` / `maxConcurrentSessions` headroom above the literal target of 100. | Packaging. |

---

## 6. Open / Not Yet Measured

- The 10 req/min/user load model is an **assumption**. A load test against a seeded 10×100
  fixture is required before these numbers can be called sufficient.
- Cluster resource requests/limits and ingress timeouts — pending survey of `hope-v2-deployment`.
- `harness` per-call `httpx.AsyncClient` churn (no pooling) — real, deferred out of lane C as a
  larger refactor.
- `RateLimitTracker.mark_rate_limited()` (`apps/text/services/rate_limiter.py:96-98`) has **zero
  production call sites** — observed vendor 429s never feed back into the pacing tracker.

---

## 7. Implementation Summary

_Pending._

---

## 8. Change History

| Date | Change |
|---|---|
| 2026-09-19 | OD-1..OD-4 answered. Lanes A/B/C/D/E dispatched to worktrees; lane F (two-level bucketing) serialized behind A, which owns `modules/throttle/**`. §2.13 corrected — the Redis rule text is accurate; local and cluster differ by design. |
| 2026-09-19 | Cluster survey added (§2.10–2.13): HPAs exist but cannot fire on the real bottleneck; client IP is `CF-Connecting-IP`; measured 341-reconnects-vs-33-sessions storm; Redis-persistence docs drift. |
| 2026-09-19 | Ticket opened. Discovery complete across gateway, runtime, Python/provider surfaces. Six defects/findings recorded (D-1…D-5, F-1) with live reproduction of D-1 and D-3. |
