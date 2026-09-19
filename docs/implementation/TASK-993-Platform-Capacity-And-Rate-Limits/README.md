# TASK-993 — Platform Capacity & Rate Limits for 10 Tenants × 100 Concurrent Users

| Field | Value |
|---|---|
| **Status** | Review |
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
| axios → Python | no custom agent ⇒ falls back to Node's `globalAgent`. **CORRECTED — see §2.14: keep-alive is ON; the real gap is `maxSockets: Infinity` and a shared process-wide singleton.** | all 4 `HttpModule.register` sites |
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

### 2.14 CORRECTION to §2.8 — gateway keep-alive was NOT off

The original claim ("no custom agent ⇒ `keepAlive: false`, a new TCP handshake per call") is
**wrong for the Node version this service ships**. `apps/api/Dockerfile:1` pins
`ARG NODE_VERSION=24`, and Node has defaulted `http(s).globalAgent` to `keepAlive: true` since
**Node 19** (nodejs/node#43522). Verified directly on Node v24.12.0:

```
keepAlive: true | maxSockets: Infinity | timeout: 5000
bare new Agent keepAlive: false      <- true only for a hand-constructed Agent, which axios never makes
```

The lane caught it the honest way: its first control test asserted "no agent ⇒ N connections" and
**measured 1**, so it rewrote the control to use an explicit `keepAlive: false` agent.

The fix remains correct, for different reasons:
- `globalAgent.maxSockets` is **`Infinity`** — no ceiling at all against any downstream peer.
- `globalAgent` is a **process-wide singleton** shared with every other caller in the gateway that
  does not pass its own agent, carrying a blunt `timeout: 5000`.

Consequence for §2.9: gateway→Python calls were already reusing sockets, so connection churn is NOT
one of the ceilings standing between the platform and the target. Do not credit this lane with a
throughput win it did not deliver; credit it with a bound and an isolation boundary.

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

## 5b. Verification evidence (2026-09-19, quiet machine)

| Gate | Result |
|---|---|
| Serial build: domains → database → applications → api | **exit 0, 0 TS errors** (load avg 6.9) |
| `apps/api` + `packages/applications` + `packages/database` | **1332 files / 21,132 tests passed, 0 failed** |
| `apps/text` (lane B) | 1821 passed, 4 skipped, exit 0 |
| deployment `kustomize build` ×6 overlays + capacity | **304/350, every capacity rule holds** |
| D-1 inverted, live | two forwarded clients get INDEPENDENT counters; spoof from an untrusted peer refused |
| Pool saturation, live vs real dev Postgres | `pool_waiting 3`, `acquire_timeouts_total{reason="pool_exhausted"} 3` at 8 concurrent vs pool 5 |

⚠ **The earlier post-merge green was not trustworthy** and is recorded here as a lesson: it passed
only because another session's uncommitted domain-layer work was in the shared tree. At load 157 the
same suites produced 5–21 `Test timed out in 30000ms` failures with zero AssertionErrors; at load 6.9,
zero. **Never accept or reject a gate taken under load.**

Dev DB updated (the seed's plan-matrix upsert is `update: {}`, create-only, so new defaults never
reach an existing database):

```
 ENTERPRISE | 150 | 150 | 6650
 PRO/TRIAL  |  25 |  25 | 1150
 STARTER    |   5 |   5 |  250
```

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

### Lane B — `apps/text` vendor 429 (branch `task-993-b-text-429`, `f2c54202a`) — COMPLETE, verified

`_TRANSIENT_PROVIDER_STATUSES = {408, 429}` carved out of the invalid-request sweep
(`retry_handler.py:142`); a new narrower `is_provider_rate_limited` (429 only, `:203`) keeps 408
retryable *without* inheriting the 429 response mapping — a caller told "429, back off" when nobody
throttled it pauses for no reason, so 408 surfaces 502. `should_retry` admits `RATE_LIMITED`
structurally but still honours the attempt ceiling. The catch-all now raises `RateLimitError` into
the existing 429 + `Retry-After` path, so `exception_handlers.py` needed no change.

**Circuit breaker:** a vendor 429 no longer counts. The lane did NOT hardcode this — it revived
`CircuitBreaker.record_failure(is_rate_limit=)` / `LaneBudget.count_rate_limits`, which already
existed, were already wired to `AiRuntimeProfile.countRateLimits`, and had **no call site setting
the flag**. Only the safe default moved (`runtime_defaults.py:112` → `False`); policy stays in the
control plane. The streaming path (`routing/streaming.py:538`) got the same treatment, because it
shares the `circuit_breakers` dict — a carve-out on one path only is not a carve-out.

18 new tests, all watched fail first (RED: `15 failed, 19 passed`). Gates: `text:test`
**1821 passed, 4 skipped, EXIT=0**; `text:lint` and `text:typecheck` clean; worktree guard exit 0.
Independently re-run by the orchestrator: **15 passed**.

The `mark_rate_limited` bonus was declined, correctly: `RateLimitTracker` is keyed per provider
**process-wide**, not per tenant, so feeding an observed 429 into it would throttle every tenant on
that provider — including tenants on a different BYO key. Follow-up, with a tenant-scoped key.

### Lane F — two-level bucketing + the gateway relay (`task-993-f-bucketing`) — MERGED

**OD-2 delivered.** A per-principal bucket now sits UNDER the tenant aggregate; both apply and
either can refuse. The principal is decided by the same act of proof that already decides the
tenant (`resolveTrustedTenantId` → `resolveTrustedCaller`): JWT → `u:<payload.id>` (**`id`, not
`sub`** — `createJwt` signs a `UserSession`; pinned by a test), API key → `k:<sha256 fingerprint>`,
service account → `s:<…>`. Unprovable ⇒ no second bucket, today's IP lane. Fingerprints, not
credentials, because the key reaches Redis and the 429 diagnostics.

**150 req/min**, from `max(26.0 active, 44.1 worst-case walk) × 3 = 132.3`, rounded to 50. It
deliberately diverges from lane D's formula: D's floor is an aggregate pathological case, while
44.1 is a rate ONE measured user produced, so capping there would refuse a doctor doing a
legitimate document-load walk. On ENTERPRISE one caller can take 2.3 % of the tenant budget; on
STARTER at most 60 % — never 100 %, which is the property the lane exists to create.

Tier: `global-kv` (`rate-limit.principal.{enabled,limit,ttl}`), **not** the plan — a doctor's
browser is not hungrier because the tenant upgraded, and rule 00 says entitlements bound, they
never supply. **Beside the cascade, not in it**: `resolveRateLimit` is first-match-wins, so a sixth
rank would either replace the tenant ceiling (recreating F-1) or never fire. Per-principal is
checked FIRST — checking the aggregate first lets a runaway burn shared budget on requests it is
about to be refused for. Headers advertise **the binding lane** (fewest remaining), because
advertising the more generous one is D-3 at a new address.

Task 2: the gateway now relays the vendor's `Retry-After` (429 only, re-rendered as an integer,
floored at 1, capped at 3600 s so a vendor answering `86400` cannot park a console for a day) and
adds `RATE_LIMITED`, `PROVIDER_INVALID_REQUEST`, `CONTEXT_WINDOW_EXCEEDED` to
`RELAYABLE_ERROR_PHRASES`. **The PHI posture is intact** — the allow-list carries a CODE and the
gateway substitutes its own phrase; no upstream body or string is ever echoed, proven by a test
that plants a name and a DOB in `detail` and asserts their absence.

Both suites RED-probed: disabling the principal lane fails 7 of 11; removing the relay fails 7 of 11.

### Lane H — the saturation signal (`task-993-h-metrics`) — MERGED

**OD-3's missing half.** Exports `hope_api_prisma_pool_{waiting,in_use,idle,max}`,
`..._wait_seconds` (histogram) and `..._acquire_timeouts_total{reason}`, where `reason` splits
`pool_exhausted` (*add capacity*) from `connect_timeout` (*Postgres is unreachable*) — same expiry,
opposite levers. Plus `hope_api_http_responses_total`, hooked as the FIRST `app.use` in `main.ts`
on `res.on('close')`: ahead of the router, so it sees what the guards refuse. `finish` would have
been wrong — it never fires for an abandoned connection, the case that dominates under load.

**There are THREE pools, not two.** Beyond `extended` and `platform-admin`, `VaultPrismaClient.swap()`
builds a whole new adapter on every credential rotation (`vault-client.ts:169`). The lane wrapped the
`PrismaPg` FACTORY rather than the pool, so a rotated or reconnected pool cannot go unobserved.

Seam: `packages/database/src/pool-observability.ts` carries no metrics library (seeds and CLI import
that package). Depth is a level ⇒ PULLED at scrape; an acquire is an event ⇒ PUSHED via observer.

**Live-verified against real dev Postgres**, 8 concurrent acquires against `PRISMA_PG_MAX=5`:
`pool_waiting 3`, `acquire_timeouts_total{reason="pool_exhausted"} 3`. Before this, those three were
opaque 500s with CPU at idle — which is precisely why the CPU-based HPA could never fire.

**The HPA should use `rate(hope_api_prisma_pool_wait_seconds_sum[2m])`, target `500m`** — by Little's
law that is the mean number of requests concurrently blocked on the pool: dimensionless, additive
across pods, and it moves BEFORE saturation. The `_waiting` gauge is only non-zero once the pool is
already full: a good alert, a late trigger. The `500m` is reasoned, not measured — calibrate it with
lane G's harness.

Nine mutations each proven to turn the suite red, including reproducing the interceptor's blindness.

### Lane G — load harness (branch `task-993-g-loadtest`, `760822893`) — COMPLETE

**The load model is now MEASURED, and it corrects §1 twice.** `pnpm load:session` drives real
Chromium against the running console, walks 11 admin screens, then parks idle for 71 s, counting
only requests that actually cost the gateway (`/api/hope/*`, `/api/auth/*`; the BFF answers
`session`/`working-tenant` from the cookie).

| | measured |
|---|---|
| active console user | **26.0 gateway req/min** (44.1 all-document-load) |
| idle parked session | **8.5 gateway req/min** |
| per client-side navigation | **1.6** |
| per document load | **8.0** |

1. The original 10 req/min understates an active user ~3×.
2. **"10–15 TanStack queries per screen" is NOT 10–15 gateway requests** — that counts React hook
   call sites. After de-dup by query key and `staleTime: 30_000` a navigation costs 1.6. The
   OD-1 revision to 30–50 landed in the right band for the wrong reason.
3. **Idle sessions were absent from the model and dominate.** 1,000 parked sessions offer
   **~142 req/s** untouched. A 30 % active / 70 % idle mix over 1,000 users ⇒ **~230 req/s**
   platform-wide (~1,375 req/min per 100-user tenant) BEFORE the approved 3× headroom.

**F-1 is now empirically confirmed.** The harness probes each tenant's lane before timing:
ArcaAI (ENTERPRISE) → 300/window, ONE bucket, **tenant-keyed**; Global (`plan = null`) →
100/window, per-route, **IP-keyed**. That second result refines §2.4: `effectivePlan` resolves
RESERVED tenants (SYSTEM, Global) to `null` = ungated; only a plan-less CUSTOMER tenant becomes
STARTER.

No new dependency (Playwright + Node `fetch`/`worker_threads`). Log-normal think time, open/closed
arrival with coordinated-omission reporting, machine plane included. Failure attribution is pure and
unit-tested against the real filter bodies — critically, it checks `DOMAIN.QUOTA_EXCEEDED` BEFORE
the status, because `mapQuotaCapabilityToHttp` also answers 429. Calibration cut a smoke run from
63/96 403s to 0 failures. Fixture written, **not run** (`LOAD_FIXTURE_CONFIRM=yes` required).
Gates: `load:lint` EXIT=0 (canary-proven), `load:typecheck` EXIT=0, 56 tests passed.

**Two findings that undercut the §2.10 saturation trigger:**
1. **`api_gateway_http_requests_total` is blind to every refusal.** Nest runs guards BEFORE
   interceptors, so 429/401/403 never reach the metrics interceptor — measured client 96 requests
   vs gateway 43. The metric the HPA would scale on cannot see overload.
2. **No Prisma/pg pool metric exists anywhere on `/metrics`** — no depth, no acquire wait, no
   timeout counter. The signal OD-3 requires is not exported. ⇒ **new lane H.**

Honest limits it states itself: no SSE/WS load, so §2.12's reconnect storm is NOT reproduced; pool
timeouts are inferred from latency, never observed; one source IP; local Redis evicts where the
cluster refuses writes; "no ceiling reached" never means "there is headroom".

### Lane E — cluster (repo `hope-v2-deployment`, branch `task-993-capacity`) — COMPLETE, verified

**The connection budget was already 1.99× over, and nobody could see it.** The pool rule lived
inside the EKS profile, so `--limits-only` skipped it on every k3s overlay. Orchestrator-verified by
rendering `main` and running the lane's script against it:

```
PostgreSQL max_connections=200; pooled at HPA ceilings = 278 (budget 140):
    hope-temporal   1 pods × 160 = 160      <- alone exceeds the whole budget
```

`hope-temporal`'s `SQL_MAX_CONNS` was unset (image default 20 × 4 services × 2 datastores).
After: `max_connections` 200→500, Temporal 20→12, `PRISMA_PG_MAX` set explicitly to 10 in
`overlays/dev/capacity.yaml:54`. Verified with CI's exact invocation: **264 / budget 350, RC=0**.
Note the script models `2 × PRISMA_PG_MAX` per gateway pod (Prisma pool + the vault-client pool,
`vault-client.ts:89-97`), which is why 10 renders as 20/pod.

**The saturation HPA was staged, not shipped.** A custom metric is not servable today — no
prometheus-adapter, no `custom.metrics.k8s.io` anywhere. Shipping an HPA against a metric nothing
serves fails closed while looking configured. So: the adapter is written as `out-of-band/`, the
saturation HPA is committed but deliberately unreferenced (orchestrator-verified: renders zero
resources), and what IS servable shipped — floor 1→**2** (first real redundancy), ceiling 3→4,
CPU 75→60 %.

**Independent find: the gateway is scraped through its ClusterIP.** That balances per connection and
Prometheus opens a new one per scrape, so at ≥2 replicas one series interleaves N monotonic counters
and `rate()` reads every switch as a reset — `GatewayErrorRateHigh`, `GatewayLatencyHigh` and every
Platform panel computing over a series that never existed, with the target still `up`. The base HPA
already permits 3, so this was live-reachable. Now pod-discovery based.

**~128s cadence: not root-caused, and deliberately not guessed.** This repo sets no timeout on any
hop. `cloudflared` was never scraped at all despite exposing `--metrics 0.0.0.0:2000`, which is
exactly why the cadence could not be attributed; that scrape now exists, so the next burst
distinguishes a cut below the connector from one at the tunnel or edge.

Gates: all six overlays render; kubeconform 0 invalid; config-refs, envfrom-coverage, patch-hygiene,
image-hygiene, gitleaks, promtool all RC=0. The lifted rules were proven to fail before they passed,
and caught an orphaned PDB in the lane's own change.

---

## 8. Change History

| Date | Change |
|---|---|
| 2026-09-19 | **All eight lanes merged.** Dev DB plan matrix updated by hand. Status → Review. Remaining items are owner decisions and one unaddressed defect (D-2), listed in §6. NOTHING PUSHED in either repo. |
| 2026-09-19 | Lanes F and H complete and MERGED; all eight lanes now on `dev-2.2`. Full serial build green at load 6.9 (the earlier green was unreliable — it passed only on another session's uncommitted files). `.env.dev` and local compose `max_connections` reconciled to the new pool size. |
| 2026-09-19 | Lane C complete. §2.8's keep-alive claim CORRECTED (§2.14): Node ≥19 defaults `globalAgent.keepAlive` to true and the gateway ships Node 24, so sockets were already reused; the real gap was `maxSockets: Infinity` + a shared singleton. |
| 2026-09-19 | Lane G complete: load model MEASURED (26 active / 8.5 idle req/min; ~230 req/s at 30/70 mix) and fed to lane D mid-flight. F-1 confirmed empirically. Repo-wide `pnpm lint` found red on `dev-2.2` since `f7307362f` and fixed centrally (`d96b7c37d`). Lane H queued: export the pool + refusal metrics OD-3 depends on. |
| 2026-09-19 | Lanes B and E complete and orchestrator-verified. New chain gap found: the gateway DROPS `Retry-After` and swaps the body (`text-proxy.controller.ts:479-521`, `RELAYABLE_ERROR_PHRASES:191`) — folded into lane F. |
| 2026-09-19 | OD-1..OD-4 answered. Lanes A/B/C/D/E dispatched to worktrees; lane F (two-level bucketing) serialized behind A, which owns `modules/throttle/**`. §2.13 corrected — the Redis rule text is accurate; local and cluster differ by design. |
| 2026-09-19 | Cluster survey added (§2.10–2.13): HPAs exist but cannot fire on the real bottleneck; client IP is `CF-Connecting-IP`; measured 341-reconnects-vs-33-sessions storm; Redis-persistence docs drift. |
| 2026-09-19 | Ticket opened. Discovery complete across gateway, runtime, Python/provider surfaces. Six defects/findings recorded (D-1…D-5, F-1) with live reproduction of D-1 and D-3. |
