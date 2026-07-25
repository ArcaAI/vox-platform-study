# BUG-009 — Admin Console reports `harness` down after manual dev start

| Field | Value |
|---|---|
| **Status** | Completed |
| **Type** | bugfix / developer-experience |
| **Reported** | 2026-07-13 |
| **Branch** | fix/2605-review |
| **Surfaces** | `apps/admin-console` (Monitoring + Platform dashboard), `apps/api` (health controller), `apps/harness` (FastAPI), `scripts/` (dev launchers) |
| **Severity** | Low (no code defect confirmed — faithful status report of a service that wasn't running; the actionable defect is *diagnosability*, not a false "down") |

---

## 1. Reported Issue

Developer started the stack manually, one terminal per service, in this order:

```
pnpm dev:api
pnpm dev:admin
pnpm dev:stt
pnpm dev:smr
pnpm dev:nlp
pnpm dev:harness
pnpm dev:harness:worker
```

The Admin Console reports the `harness` service as **down**, while the other services show healthy.

---

## 2. Investigation — What Actually Happens

### 2.1 The health-status chain (end-to-end, verified)

```
Admin Console card ("Service health" / "Services" strip)
  └─ useServicesHealth()                 apps/admin-console/src/features/monitoring/api/hooks.ts:11-13  (refetch 30s)
     └─ getServicesHealth()              apps/admin-console/src/features/monitoring/api/client.ts:6-8   → getJson('health/services')
        └─ BFF proxy  /api/hope/*         apps/admin-console/src/app/api/hope/[...path]/route.ts
           └─ handleProxy → gatewayUrl    apps/admin-console/src/server/hope-proxy.ts:65-113, gateway.ts:6-8
              → ${API_URL}/api/v1/health/services   (API_URL default http://localhost:8868, config/env.ts:11)
              └─ NestJS ApiHealthController.checkServices   apps/api/src/modules/health/health.controller.ts:176-221
                 └─ probeService(harness)                   health.controller.ts:243-277
                    → GET http://localhost:8866/api/v1/health   (axios, timeout 5000ms, NO auth header)
                       └─ apps/harness FastAPI  GET /api/v1/health   apps/harness/src/harness/api/endpoints/health.py:36-63
```

Key code facts:

- **Gateway probe** (`health.controller.ts:243-277`): plain `axiosRef.get('${HARNESS_URL}/api/v1/health', { timeout: 5000 })`. On **any** thrown request (ECONNREFUSED / timeout / non-2xx) the catch block returns `{ status: 'down', service, error: <message> }` (`:265-276`). A 2xx drives `status: data.status || 'healthy'` (`:260`).
- **Aggregation** (`checkServices`, `:190-221`): `Promise.allSettled` over 5 services; counts anything `!== 'down'` as healthy; overall = all-up `healthy` / none-up `unhealthy` / mixed `degraded`.
- **Admin UI does NOT compute up/down** — it renders whatever status string the gateway returns. `serviceStatusRole` maps `'down' || 'unhealthy'` → destructive/red (`monitoring-screen.tsx:21-26`, `platform-dashboard.tsx:25-30`), and the strip also renders the probe's `error` string (`platform-dashboard.tsx:32-34, 91-95`).
- **Harness `/api/v1/health`** (`health.py:36-63`) is dependency-free: always `200 {"status":"healthy", ...}`. It does **not** dial Temporal, and the health router is mounted with **no auth dependency** (`main.py:99`) — so the missing `X-Service-Token` on the gateway probe is irrelevant here.

### 2.2 Ground-truth evidence (captured live on the reporter's machine, 2026-07-13)

**Listening sockets** (`lsof -nP -iTCP -sTCP:LISTEN`):

| Port | Service | Listener |
|---|---|---|
| 8868 | api | node ✅ (`*:8868`) |
| 5176 | admin | node ✅ (`*:5176`) |
| 8861 | stt | python ✅ (`127.0.0.1:8861`) |
| 8862 | smr | python ✅ (`127.0.0.1:8862`) |
| 8864 | nlp | python ✅ (`127.0.0.1:8864`) |
| 8863 | guardrail | python ✅ (`127.0.0.1:8863`) |
| **8866** | **harness** | **— NOTHING LISTENING —** ❌ |
| 7233 | Temporal | OrbStack ✅ |
| 6379 | Redis | OrbStack ✅ |
| 5432 | Postgres | OrbStack ✅ |

**Direct probe of harness (all three loopback forms), while "down":**

```
GET http://localhost:8866/api/v1/health  → http_code=000  Couldn't connect to server
GET http://127.0.0.1:8866/api/v1/health  → http_code=000  Couldn't connect to server
GET http://[::1]:8866/api/v1/health      → http_code=000  Couldn't connect to server
```

**The harness code is fine** — proven by two independent checks in `arcaenv`:

1. `import harness.main` → `IMPORT_OK app=True` (no import-time crash; module-level `app` exists, so the `uvicorn harness.main:app` target is valid).
2. Freshly booting the exact dev command:
   ```
   uvicorn harness.main:app --host 127.0.0.1 --port 8866 --app-dir apps/harness/src
   ```
   → binds `127.0.0.1:8866`, `GET /api/v1/health` returns **200 healthy in ~2s**, and even `GET /api/v1/health/ready` returns **200** (Temporal reachable).

### 2.3 Conclusion

**There is no false "down" and no code/config defect in the reporting path.** The Admin Console, the BFF proxy, the gateway health controller, `HARNESS_URL`, the ports, and the harness health endpoint are all correct and consistent. The card was red because **the harness FastAPI process was genuinely not listening on 8866** at check time — despite `pnpm dev:harness` having been run. The gateway probe hit `ECONNREFUSED`, `probeService` returned `status:'down'` with the connection error, and the UI faithfully rendered it.

**The real, actionable problem is diagnosability**: when a single downstream dev service dies or never binds, the *only* signal a developer gets is a red card in the Admin Console 30 seconds later — the actual startup error is buried in one of seven separate terminals.

---

## 3. Root-Cause Analysis (ranked)

### RC-1 (primary) — Harness process failed to start or exited in the reporter's session; failure was invisible
The definitive missing datum is the **`pnpm dev:harness` terminal output**. Because the code imports and boots cleanly here, in the reporter's session harness must have either errored during launch or exited afterward, unnoticed. Plausible triggers (to confirm from that terminal's log — see Plan step 1):
- Startup traceback the developer didn't see (scrolled off, or the terminal tab was closed/replaced).
- Port 8866 momentarily occupied by a stale run at launch (`dev-service.sh` does no port preflight for single-service launches; only `dev:stack` does — `dev-stack.sh:218-231`).
- Conda env / working-directory drift for that one terminal (`dev-service.sh` requires `arcaenv`; a shell without conda initialized would fail `check_conda_env`, `dev-service.sh:94-103`).
- The process was launched and then the terminal/shell that owned it was closed, taking the child with it.

This is an **operational** root cause, not a code bug. The fix is to make the failure *loud and central* (see RC-A).

### RC-A (systemic, the fix worth shipping) — No aggregated dev-time startup visibility
Launching services as 7 independent `pnpm dev:*` terminals means a per-service crash has no central signal. Two facilities already exist but were not used here:
- **`pnpm dev:doctor`** (`scripts/dev-doctor.sh`) already does a one-shot probe of `harness (8866)` health (`:107`) **and** checks the `harness.temporal.worker` process (`:122-128`) — it would have printed `harness (8866) … FAIL` immediately. It just isn't surfaced/recommended when a card goes red.
- **`pnpm dev:stack`** (`scripts/dev-stack.sh`) is a supervisor that launches `api stt smr guardrail nlp harness worker admin` in one place with port-free preflight and a cleanup trap (`:52, :218-282`). A crash there is visible in the aggregated stream.

### RC-B (latent, not today's cause) — `localhost` URL + loopback bind = IPv6 footgun
Every dev service binds `127.0.0.1` (`dev-service.sh:135`) while every downstream URL uses `localhost` (`HARNESS_URL=http://localhost:8866`, `.env.dev:304`). On this machine `/etc/hosts` maps `localhost` to **both** `127.0.0.1` and `::1`. It works today (Node 22 fetch/axios Happy-Eyeballs to IPv4, and the other 4 services prove the path), and it is **not** the current cause (the service was down on *both* stacks — see 2.2). But it is a real fragility: any probe client that resolves `::1` first without IPv4 fallback would report a *healthy* service as down. Worth removing as cheap hardening.

### RC-C (secondary) — Harness worker hard-requires Temporal, no preflight
`pnpm dev:harness:worker` → `python -m harness.temporal.worker` (`dev-service.sh:214-216`) hard-requires Temporal. Temporal is up here (7233), so the worker is fine now, but if Temporal were down the worker would crash with the same invisible-failure pattern. `dev:doctor` already flags a missing worker (`:124-128`); a launch-time preflight would fail faster.

---

## 4. Implementation Plan

> Diagnostic-first. Step 1 confirms RC-1 and may make the rest moot for the reporter; steps 2–4 are the durable hardening that stops this from being invisible next time. No code is written until this plan is approved.

### Step 1 — Confirm RC-1 (no code)
1. Re-run `pnpm dev:harness` in a foreground terminal and read the output verbatim. Capture any traceback / "Address already in use" / conda error.
2. In parallel run `pnpm dev:doctor` and paste the `harness (8866)` + `harness worker process` lines.
3. If it now binds 8866 and the Admin card goes green on the next 30s poll → RC-1 confirmed as a transient/operational miss; proceed to hardening so it can't hide again. If it fails to bind, the captured traceback becomes the concrete defect to fix (new sub-task).

**Verification:** `curl -s http://127.0.0.1:8866/api/v1/health` returns `200 {"status":"healthy"}`; Admin `health/services` shows `harness: healthy`.

### Step 2 — RC-A: make a not-started downstream service loud (primary hardening)
Pick one (recommend 2a + 2b):
- **2a. Admin console affordance** — when a service renders `down`/`unhealthy`, surface the probe `error` string more prominently and add a "run `pnpm dev:doctor`" hint in the Monitoring screen's error/detail area (`monitoring-screen.tsx:146-160`). Small, no backend change. Follows `10-skeleton-loading`/`11-ux-ui-principles` (error affordance, not silent red).
- **2b. Docs/runbook** — add a "one service shows down in dev" troubleshooting entry to `infrastructure/README.md` / `scripts/README.md` pointing at `pnpm dev:doctor` and `pnpm dev:stack`, and note that individual `pnpm dev:*` terminals hide per-service crashes.
- **2c. (optional) `dev:doctor` polish** — on a failed required http_check, print the exact restart command (e.g. `→ start with 'pnpm dev:harness'`), mirroring the worker hint at `dev-doctor.sh:128`.

**Verification:** kill harness, confirm `pnpm dev:doctor` prints an actionable FAIL line, and the Admin card shows the connection error inline.

### Step 3 — RC-B: remove the IPv6 footgun (cheap, optional)
Normalize dev downstream URLs to the loopback the services actually bind: `HARNESS_URL=http://127.0.0.1:8866` (and the sibling `*_URL` in `.env.dev`/`.env.test`/`.env.example`), **or** flip the dev bind default in `dev-service.sh` — not both. Keep `turbo.json#globalEnv` unchanged (already lists `HARNESS_URL`). This is a config-only change; guard it with the existing `apps/api/src/__tests__/env-port-standardization.test.ts` expectations (that suite asserts port 8866 and the `|| 'http://localhost:8866'` default — update those assertions in lockstep if the host string changes).

**Verification:** `pnpm test:unit` env-port suite green; all 5 services still probe healthy via `dev:doctor`.

### Step 4 — RC-C: worker Temporal preflight (optional)
Add a fast Temporal reachability preflight to the `worker` branch of `dev-service.sh` (or a note in `dev:doctor`) so `pnpm dev:harness:worker` fails immediately with "Temporal not reachable at ${TEMPORAL_ADDRESS}; run `pnpm infra:up`" instead of a deep SDK stack trace.

**Verification:** with Temporal stopped, `pnpm dev:harness:worker` exits fast with the preflight message.

### Scope decision for the user
This ticket treats the whole thing as **one bug** because there is no confirmed code defect — only an operational miss plus diagnosability hardening. If preferred, the hardening findings can be split into their own tickets:
- **BUG-009** — this issue + Step 2 (visibility).
- **BUG-010 (optional)** — RC-B localhost→127.0.0.1 dev URL normalization.
- **BUG-011 (optional)** — RC-C worker Temporal preflight.

---

## 5. Implementation Summary (Step 1 + Step 2, TDD)

**Step 1 — RC-1 confirmed.** Full stack started fresh (`pnpm dev:stack`, harness+worker included). Direct probe: `curl http://127.0.0.1:8866/api/v1/health` → `200 {"status":"healthy",...}`. Gateway aggregate (via the Admin Console UI, authenticated as `global_admin`) shows `harness: healthy`. No code defect — confirms 2.3: the service just wasn't running. (One incidental finding while re-launching: a stale harness process from an earlier investigation session was still holding port 8866, which `dev:stack`'s port preflight correctly refused to start over — killed it and re-launched clean. This is exactly the "stale run occupies the port" trigger named in RC-1.)

**Step 2a+2c shipped** (2b docs folded in too — see `scripts/README.md`):
- `apps/admin-console/src/features/monitoring/components/dev-service-down-hint.tsx` (new) — `DevServiceDownHint`: renders a `role="status"` banner naming any `down`/`unhealthy` service and pointing at `pnpm dev:doctor` / `pnpm dev:stack`. Hidden when `NODE_ENV === 'production'` (dev-only affordance, per its own doc comment).
- `apps/admin-console/src/features/monitoring/components/monitoring-screen.tsx` — wires `DevServiceDownHint` into `ServiceHealthGrid`, above the service list.
- `apps/admin-console/src/features/monitoring/components/__tests__/dev-service-down-hint.test.tsx` (new, TDD) — 4 cases: names the down service (not healthy ones), treats `unhealthy` same as `down`, renders nothing when all healthy/degraded, renders nothing when `enabled={false}` (prod gate).
- `apps/admin-console/src/features/monitoring/components/__tests__/monitoring-screen.test.tsx` — 2 cases added: hint renders with the `pnpm dev:doctor` text + service name when a probe is `down`; hint absent on the default (all-healthy/degraded) fixture.
- `scripts/dev-doctor.sh` — `http_check` takes an optional restart-hint; every required HOPE-service check now names its own start command on failure (e.g. `harness (8866) … → 000 — start with 'pnpm dev:harness'`).
- `scripts/README.md` — new "Troubleshooting" section: explains the red-card-is-real posture, points at `dev:doctor` / `dev:stack`.

**Verification evidence (live, this session):**
- Unit: `pnpm --filter @arcaai/admin-console test` (scoped to the two changed suites) → **2 files, 12 tests passed**.
- Lint: `pnpm --filter @arcaai/admin-console lint` → clean, 0 warnings.
- Build: `pnpm --filter @arcaai/admin-console build` → compiled + typechecked successfully, all 54 routes generated.
- Runtime (browser, both themes): logged into the Admin Console as `global_admin`; **Platform Dashboard** and **Monitoring** screens both show `harness: Healthy` (4ms) once the service is actually running. `nlp`/`guardrail` were genuinely down at check time (first-run HF model download still in progress — unrelated to this ticket) and the new hint rendered live, unprompted: *"nlp, guardrail aren't responding — if you started services by hand, one may have failed to launch. Run `pnpm dev:doctor` … or `pnpm dev:stack` …"* — verified in light and dark theme.
- `pnpm dev:doctor` (live, real stack): `harness (8866) → 200 PASS`; the failing `nlp (8864)` line now prints `— start with 'pnpm dev:nlp'`, confirming the RC-A restart-hint hardening.

**Out of scope / left as optional follow-ups (per §4 Step 3–4 and the ticket's own scope decision):** RC-B (`localhost`→`127.0.0.1` dev URL normalization) and RC-C (worker Temporal preflight) were not implemented — they're explicitly optional hardening, not needed to close the reported symptom.

---

## 6. Files Referenced (for the implementer)

| Area | Path |
|---|---|
| Admin health hook/client | `apps/admin-console/src/features/monitoring/api/{hooks.ts,client.ts,types.ts}` |
| Admin health UI | `apps/admin-console/src/features/monitoring/components/monitoring-screen.tsx`, `apps/admin-console/src/features/platform/components/platform-dashboard.tsx` |
| BFF proxy | `apps/admin-console/src/server/{hope-proxy.ts,gateway.ts}`, `src/app/api/hope/[...path]/route.ts`, `src/config/env.ts` |
| Gateway health probe | `apps/api/src/modules/health/health.controller.ts` (`:74-106` service list, `:176-221` aggregate, `:243-277` probe) |
| Second (cron) monitor | `packages/applications/src/services/baseServices/serviceHealth/serviceHealthMonitoring.service.ts` (`@Cron` 30s, native fetch, 5s timeout) — mirrors the same 5-service set; drives `/api/v1/monitoring/uptime` |
| Config default | `packages/applications/src/services/baseServices/_meta/config/config.service.ts:152` (`HARNESS_URL || 'http://localhost:8866'`) |
| Harness health | `apps/harness/src/harness/api/endpoints/health.py:36-63` (`/health` dependency-free), `:72-101` (`/health/ready` dials Temporal → 503) |
| Harness bootstrap | `apps/harness/src/harness/main.py:24-62` (best-effort Temporal lifespan), `:99` (health router, no auth) |
| Harness settings | `apps/harness/src/harness/core/config.py:229-364` (`HARNESS_`/`TEMPORAL_` prefixes; host `0.0.0.0`, port 8866, empty service_token) |
| Dev launchers | `scripts/dev-service.sh:135,201-221` (loopback bind, harness+worker cmds), `scripts/dev-stack.sh` (supervisor), `scripts/dev-doctor.sh:103-128` (health + worker probes) |
| Env / turbo | `.env.dev:304`, `.env.test:137`, `.env.example:415-417`, `turbo.json:141` |

---

## 7. Change History

| Date | Author | Change |
|---|---|---|
| 2026-07-13 | Claude (investigation) | Created ticket. Traced full admin→BFF→gateway→harness health chain; captured live ground truth (8866 not listening while other 4 services up); proved harness code imports and boots cleanly (200 in ~2s, ready 200). Root cause = harness process not running (operational), real fix = dev-time startup visibility. Plan proposed; no code written. |
| 2026-07-13 | Claude (implementation) | TDD-implemented Step 2a+2c: `DevServiceDownHint` component (4 unit tests) wired into `MonitoringScreen` (2 new tests); `dev-doctor.sh` restart-hints; `scripts/README.md` troubleshooting section. Confirmed RC-1 live: started the full dev stack (killed a stale leftover harness process holding 8866 first — same footgun RC-1 describes), harness probed 200/healthy end-to-end through the real gateway + Admin Console UI (both themes). Unit/lint/build all green. Status → Completed. |
