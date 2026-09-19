# `tests/load` — the TASK-993 capacity harness

TASK-993 asks the platform to serve **10 tenants × 100 concurrent users** plus machine
integrations. Every capacity number in that ticket's §2.9 is scaled from a **load model that
nobody had measured**: originally 10 requests/min per active console user, revised under OD-1 to
~30–50 because "a screen fires 10–15 TanStack queries". OD-1's answer was *"3× headroom, then
load-test to confirm"*.

This directory is the confirmation step. It does two things:

1. **`pnpm load:session`** — drives the real admin console in a real browser and *measures* what
   one session costs. That number is the input to everything else.
2. **`pnpm load:run`** — drives N tenants × M users (plus API keys and service accounts) against
   the gateway and reports **which ceiling bound first**, not just that something failed.

---

## The measured number

Recorded 2026-09-19 against the dev stack (gateway `:8868`, console `:5176`), logged in as
`super_admin`, walking 11 platform-admin screens and then sitting idle for 71 s:

| | measured |
|---|---|
| **active console user** | **26 gateway req/min** (mixed walk) — **44 req/min** when every navigation is a full document load |
| **idle, parked session** | **8.5 gateway req/min**, from `refetchInterval` polls alone |
| **per client-side navigation** | **1.6** gateway requests |
| **per document load** | **8.0** gateway requests |

Three things follow, and each changes a number in TASK-993:

- **The original 10 req/min model understates an active user by roughly 3×.** OD-1's revised
  30–50 band is the right order of magnitude; 26–44 sits just inside its lower half.
- **"10–15 TanStack queries per screen" is not 10–15 gateway requests.** After TanStack's
  de-duplication by query key and `staleTime: 30_000`, a client-side navigation costs **1.6**.
  The 10–15 figure counts React hook call sites. A user who reloads the page pays 8, because a
  document load destroys the `QueryClient` and every shell query re-runs.
- **1,000 idle sessions are not free.** At 8.5 req/min each, a fully-parked population of 1,000
  users offers **~142 req/s** with nobody touching anything. That is ~85% of the ~167 req/s the
  ticket budgets for the ACTIVE population, and it is not in the model at all.

Raw evidence: `results/session-profile.json` and `results/session-requests.json`.

---

## Run it

Needs the dev stack up (`pnpm stack:dev`) and the database seeded. Nothing here resets or
migrates anything.

```bash
# 1. measure one real console session  (~2.5 min: 11 screens + a 70 s idle window)
pnpm load:session
LOAD_HEADED=1 pnpm load:session          # watch the browser do it

# 2. drive load. Without a fixture this uses the ordinary dev seed's two tenants
#    and says so in the report; it is a smoke run, not a capacity run.
pnpm load:run

# 3. the actual target, once an operator has provisioned the fixture (see below)
LOAD_TENANTS=10 LOAD_USERS=100 LOAD_DURATION=300 pnpm load:run

# find the breaking point rather than the steady state
LOAD_ARRIVAL=open LOAD_DURATION=300 pnpm load:run
```

Both write to `results/` (gitignored — it holds plaintext fixture credentials).

### Knobs

| Variable | Default | Meaning |
|---|---|---|
| `LOAD_BASE_URL` | `http://localhost:8868/api/v1` | Gateway. **Never point this at the k3s cluster.** |
| `LOAD_TENANTS` / `LOAD_USERS` | `10` / `100` | The population. Capped by what the fixture actually contains. |
| `LOAD_API_KEYS` / `LOAD_SERVICE_ACCOUNTS` | `2` / `1` | Machine principals per tenant. They share the tenant's bucket. |
| `LOAD_DURATION` / `LOAD_RAMP` | `120` / `30` s | Timed window, and the ramp that spreads users into it. |
| `LOAD_THINK_MS` / `LOAD_THINK_SIGMA` | `4000` / `0.6` | Log-normal think time — **median**, not mean. |
| `LOAD_ARRIVAL` | `closed` | `closed` fixes concurrency; `open` fixes arrival rate and lets lag accumulate. |
| `LOAD_SESSIONS` | `reuse` | `reuse` = one JWT per tenant; `distinct` = one login per user (13 s apart — `auth/login` is 5/min). |
| `LOAD_WORKERS` | `min(8, cpus-1)` | Worker threads, so the client is not the bottleneck. |
| `LOAD_CALIBRATE` | `1` | Probe which routes each credential can reach, and drop the rest. |
| `LOAD_COOLDOWN_S` | `65` | Wait after the probes so the limiter windows they spent roll over. |
| `LOAD_SCRAPE_METRICS` | `1` | Bracket the run with `GET /metrics`. |
| `LOAD_PG_CONNECT_TIMEOUT_MS` | `5000` | The gateway's pg `connectionTimeoutMillis`; drives the pool-timeout heuristic. |
| `LOAD_PROBE_ROUTE_A/B` | `users/me/settings` / `agents` | Two routes on different handlers, for the lane probe. |

Session recorder: `LOAD_CONSOLE_URL`, `LOAD_USERNAME`, `LOAD_PASSWORD`, `LOAD_TENANT_KEY`,
`LOAD_SCREENS`, `LOAD_SETTLE_MS`, `LOAD_IDLE_MS`, `LOAD_HEADED`.

---

## Why this tool and not k6 / artillery / autocannon

**No new dependency was warranted, so none was added.**

- **Playwright** (already a repo dependency, browsers already installed) drives step 1. The thing
  being measured *is* the console's own behaviour — its query de-duplication, its `staleTime`, its
  `refetchInterval` polls. A hand-written route list would measure the list.
- **Plain Node 24 + global `fetch` + `worker_threads`** drives step 2, with zero new packages.
  Node's `fetch` is undici underneath, with keep-alive on and no per-origin connection cap, so a
  custom dispatcher would add a dependency to re-create the default.
- **k6** is a Go binary: a new external runtime dependency, which
  `09-infrastructure-devops.md` rules out, and awkward in CI.
- **artillery / autocannon** are npm packages, but neither models what this ticket needs:
  three credential classes sharing one tenant bucket, a per-tenant rate-limit lane established by
  probe, and failure attribution that reads `Retry-After-<tier>` suffixes and
  `DOMAIN.QUOTA_EXCEEDED` bodies. Most of the code here is that attribution — the request-issuing
  part any of them would have replaced is about 40 lines.

The pure logic (attribution, percentiles, think time, the mix) is unit-tested and runs under
`pnpm test:unit`; nothing in the decision path needs a running platform to be verified.

---

## How a failure is attributed

"It failed" is useless. §2.9 lists five ceilings that all present as a failed request, and the
only useful output is which one bound. Full detail in `src/attribution.ts`.

| Cause | How it is detected |
|---|---|
| `throttle_ip` | 429 with a **suffixed** `Retry-After-<tier>` ⇒ definitive: `TieredThrottlerGuard` never tenant-keys a non-default tier. Or a default-tier 429 whose tenant the probe found IP-keyed. |
| `throttle_tenant` | Default-tier 429 whose tenant the probe found tenant-keyed. |
| `throttle_unknown` | Default-tier 429 with no lane established. **Never** folded into either lane. |
| `entitlement_quota` | Body `code: DOMAIN.QUOTA_EXCEEDED`, sub-attributed by `metadata.capability`. Checked **before** the status, because `mapQuotaCapabilityToHttp` answers **429** for every rolling-meter and concurrency cap — a quota block and a rate limit are the same status. |
| `downstream_unreachable` | 503 + `GATEWAY.DOWNSTREAM_UNAVAILABLE`: the gateway never reached the Python peer. The message names the capability. |
| `downstream_5xx` | 502 + `GATEWAY.DOWNSTREAM_UNAVAILABLE`: the peer answered 5xx. **An `apps/stt` `CapacityGuard` 503 lands here**, because `downstreamStatusFor` maps an upstream 5xx to 502. |
| `peer_capacity_503` | A bare 503, only on the direct-peer lane that bypasses the gateway. |
| `gateway_timeout` | 504. |
| `db_pool_timeout_suspected` | A 500 whose latency falls in 0.9–1.6 × the pg `connectionTimeoutMillis`. **A heuristic, labelled as one** — see below. |
| `server_error` | Any other 5xx. |
| `auth` / `client_error` | 401/403 and other 4xx. Counted **apart** from platform capacity: these are harness or fixture faults, and folding them in would move the reported breaking point. |
| `transport` | `fetch` threw — including a timeout, which is recorded rather than discarded. |

Two supporting mechanisms:

- **The lane probe is per tenant** (`src/lane-probe.ts`), because lanes genuinely differ per
  tenant. Measured on the dev gateway: Global (`plan = null`) got **100/window, one bucket per
  route → IP-keyed**, while ArcaAI (`plan = ENTERPRISE`) got **300/window, one bucket → tenant-keyed**.
  A single run-wide verdict would have mislabelled one of them. Every verdict prints its evidence,
  and a test that cannot run returns `indeterminate` rather than a guess.
- **Calibration** (`src/calibrate.ts`) asks the platform which routes each credential can reach,
  before the timed run, and drops the rest. Without it, a fixture seeded with clinicians spends
  the run exercising the authorization guard: the first smoke run here returned **63 of 96
  responses as 403**.

---

## The fixture (written, **not** run)

`fixture/seed-load-fixture.ts` provisions the population. **Lane G did not run it** — the
orchestrator owns every shared surface, including the database. An operator runs:

```bash
LOAD_FIXTURE_CONFIRM=yes LOAD_TENANTS=10 LOAD_USERS=100 pnpm load:seed
```

It refuses without `LOAD_FIXTURE_CONFIRM=yes`, refuses under `NODE_ENV=production`, and refuses
with no `DATABASE_URL`. It is additive and idempotent — every write is an upsert on a
deterministic id in the reserved `9930…` block — and it deletes nothing. It creates, per tenant:
an ENTERPRISE `Tenant` (the only plan whose `maxUsers` reaches 100), one `Department`, M `User`s
sharing one bcrypt digest, a `UserRoleAssignment` (**TENANT_ADMIN**, because the measured load
model is an admin-console session), a `UserDepartment` (membership fails closed without it),
`ApiKey`s, `ServiceAccount`s, and the tenant reference set. It writes
`results/fixture.json`, which `load:run` consumes. The teardown SQL is printed on success and is
deliberately **not** a flag on the script.

---

## What this harness cannot tell you

Read this section before quoting a number from it.

**A laptop is not the cluster.**

- One machine runs the load generator *and* the gateway *and* Postgres *and* Redis *and* six
  Python services. At the 10×100 target they compete for the same cores, so latency here includes
  contention the cluster would not have — and the client's own scheduling jitter lands in the p99.
  Numbers from a laptop run bound the platform's *behaviour* (which ceiling binds, in what order,
  at what offered rate), never its *throughput*.
- **Every virtual user shares one source IP.** That is fine for the tenant lane and actively
  useful for reproducing D-1, but it cannot reproduce the cluster's shape, where
  `cloudflared → Traefik → pod` makes every real user share the Traefik pod's IP anyway. What it
  *cannot* show is what per-client-IP bucketing would do once D-1 is fixed.
- **Local Redis evicts (`allkeys-lru`, 64 MB); the cluster refuses writes (`noeviction`, 512 MB).**
  §2.13 calls this a deliberate divergence. A memory-pressure failure of the throttler counters,
  the socket registry or a BullMQ queue exists in production and **cannot be reproduced here at
  all**.
- **`replicas: 1` locally is not `1/3` with an HPA.** Nothing here exercises autoscaling, and
  §2.10's finding — that a CPU-at-75% trigger cannot fire on an I/O-bound bottleneck — is not
  testable from a client.
- Local Postgres allows `max_connections = 100`; the cluster allows 200.

**Blind spots in the measurement itself.**

- **DB pool-acquire timeouts are inferred from latency, not observed.** The gateway exports no
  Prisma/pg pool metric on `/metrics` — no pool depth, no acquire wait, no timeout counter — so a
  pool timeout arrives as a plain `500 Internal server error`, distinguishable only by clustering
  at the 5 s `connectionTimeoutMillis`. The harness reports it as **suspected** and carries the
  `correlationId`s so an operator can settle each one in the gateway log. *This is the same gap
  that blocks §2.10: the signal the HPA should scale on is not exported.*
- **The gateway's own HTTP metric is blind to refusals.** Nest runs guards before interceptors, so
  every 429/401/403 the throttler or the auth guard produces never reaches the metrics interceptor
  and is absent from `api_gateway_http_requests_total`. Measured on a smoke run: the client counted
  96 requests, the gateway counted 43. Trust the client-side numbers; the server-side scrape is a
  cross-check, not a source of truth.
- **`LOAD_SESSIONS=reuse` (the default) cannot exercise a per-principal bucket.** One JWT per
  tenant is correct for today's `t:<tenantId>` bucket, which has no principal component — but if
  OD-2's two-level bucketing ships, a `reuse` run would report far more headroom than exists. Use
  `distinct` then.
- **SSE and WebSocket load is not generated.** Only the requests that open and re-open those
  streams are counted. §2.12's reconnect storm (341 reconnects against 33 sessions) is therefore
  *not* reproduced, and it is the failure mode most likely to interact with the rate limiter.
- **No audio, no inference.** The STT stream ceiling (20 on the dev GPU), the harness LLM
  serialisation (`HARNESS_LLM_MAX_CONCURRENCY=1`) and the text per-provider semaphores are not
  driven. A run can report "no ceiling reached" while those are untouched.
- **The route mix is a platform admin's.** It was recorded as `super_admin`. A clinician
  population has a different mix, and calibration will simply drop most of these routes for one.
- **"No ceiling was reached" never means "there is headroom."** It means the offered load did not
  reach a ceiling. The report says so in those words.

---

## Layout

```
tests/load/
├── README.md              this file
├── tsconfig.json          `pnpm load:typecheck` (the repo-root tests/ tree is in no workspace)
├── eslint.config.mjs      `pnpm load:lint`, --max-warnings 0
├── src/
│   ├── types.ts           shared types + the FailureCause union
│   ├── attribution.ts     PURE. response → one named ceiling
│   ├── stats.ts           PURE. mergeable log-linear latency histogram
│   ├── thinktime.ts       PURE. seeded PRNG, log-normal think time, the arrival model
│   ├── scenario.ts        the screen mix + the static fallback profile
│   ├── aggregate.ts       PURE. what a worker ships home, and how shards combine
│   ├── report.ts          rendering + the binding-ceiling verdict
│   ├── http.ts            the one place a request is issued, timed and attributed
│   ├── credentials.ts     JWT / API key / service-account acquisition
│   ├── lane-probe.ts      per-tenant IP-vs-tenant bucket discrimination
│   ├── calibrate.ts       which routes each credential can actually reach
│   ├── metrics-probe.ts   GET /metrics before/after
│   ├── worker.ts          one shard of virtual users on its own thread
│   └── run-load.ts        ENTRY POINT 2
├── session/
│   └── measure-session.ts ENTRY POINT 1 (Playwright)
├── fixture/
│   └── seed-load-fixture.ts   written, NOT run
├── __tests__/             runs under `pnpm test:unit`
└── results/               gitignored
```

## Related

- `docs/implementation/TASK-993-Platform-Capacity-And-Rate-Limits/README.md` — the analysis this
  harness exists to validate
- `.claude/rules/01-development-workflow.md` §Script Naming — the `<domain>:<action>` taxonomy the
  `load:*` scripts follow
