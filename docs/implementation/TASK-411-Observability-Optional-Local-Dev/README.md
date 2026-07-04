# TASK-411 — Observability-Optional Local Development

| Field | Value |
|---|---|
| **Ticket** | TASK-411 |
| **Name** | Make observability tooling fully optional for local development (OTel opt-in gates + env template neutralization) |
| **Type** | `infrastructure` / `bugfix` (config + two small code gates) |
| **Status** | **Review** — implemented + verified 2026-07-03, awaiting user confirmation |
| **Created** | 2026-07-03 |
| **Updated** | 2026-07-03 |
| **Owner** | Infrastructure |
| **Builds on / references** | **TASK-386** (platform-metrics read path, graceful em-dash degradation), **TASK-397** (opt-in dev `prometheus` compose profile), **TASK-251** (production observability stack), **TASK-254/255** (SMR/STT OTel instrumentation) |

---

## 1. Requirement Analysis

### 1.1 Description

The repo recently gained a Prometheus + Grafana integration (TASK-386/397). A codebase review (2026-07-03) confirmed the **pull-based** metrics path is already safe without observability tools, but found the **push-based OTel (OTLP gRPC :4317) path** breaks the "clone → copy env → run" experience:

1. **NLP auto-enables OTLP push** whenever `OTEL_EXPORTER_OTLP_ENDPOINT` is set — and every committed dev template sets it. With no collector in dev compose, NLP retries trace export every 500 ms plus metric/log export, producing continuous gRPC `StatusCode.UNAVAILABLE` warnings.
2. **The API's prod entrypoint (`instrumentation.ts`) starts the OTel SDK unconditionally** with a `localhost:4317` fallback when the endpoint var is unset/empty — any prod-style or Docker run without a collector silently buffers/drops telemetry against a dead endpoint, with no kill-switch.
3. **Dev env templates advertise observability-on** (`OTEL_TRACES_ENABLED=true`, `OTEL_METRICS_ENABLED=true`, endpoint set) — the opposite of the intended dev default and the direct trigger for (1).

This ticket makes OTel export **explicit opt-in everywhere**, neutralizes the dev templates, and locks in the invariant: **any developer can start the full dev environment with zero observability tools running, by default.**

### 1.2 Business context

- Onboarding friction and noise: fresh local setups emit misleading error/warning spam that masks real problems.
- Wasted resources: background export retries burn CPU/memory in PHI-processing dev services.
- Consistency: 4 of 5 Python services already follow "off unless `*_OTEL_ENABLED=true`"; NLP and the API gateway are the outliers.

### 1.3 Acceptance criteria

1. **Cold-start clean:** fresh clone → `cp .env.example .env` (and/or per-app `.env.example` copies) → `docker compose up` (core infra only) → start each service (`pnpm dev:api`, `dev:stt-v2`, `dev:smr-v2`, `dev:nlp`, `dev:guardrail`, `dev:harness`) with **no** Prometheus/Grafana/OTel collector running → **zero** OTLP export errors/retry warnings in logs; all health endpoints green.
2. **Explicit opt-in only:** OTel export activates only when the service's master switch is on **and** an endpoint is configured. NLP gains `NLP_OTEL_ENABLED` (default `false`), covering traces, metrics, **and logs** (log export is currently ungated).
3. **API gateway:** `node --import dist/instrumentation.js` (i.e. `pnpm start`, `start:prod`, Docker CMD) with `OTEL_EXPORTER_OTLP_ENDPOINT` unset/empty does **not** start the SDK (single info log states telemetry is off); no `localhost:4317` fallback remains. `OTEL_SDK_DISABLED=true` is honored as a standard kill-switch. Behavior with an explicit endpoint is unchanged.
4. **Pull path untouched:** `/metrics` endpoints stay on by default (passive scrape surface); Prometheus + Grafana stay behind the opt-in `prometheus`/`observability` compose profiles; admin dashboard still degrades to em-dash without Prometheus.
5. **Scripts/docs:** shell + npm scripts verified to have no observability dependency (audit evidence recorded); `infrastructure/docker/README.md` documents "observability is optional (default off) + how to opt in"; convenience npm aliases exist for the opt-in profile.
6. All new/updated tests pass; affected packages build; no new lint errors — with captured evidence.

---

## 2. Current State Evaluation (review findings, 2026-07-03)

### 2.1 Already correct (do not change)

| Item | Evidence |
|---|---|
| Prometheus + Grafana are **opt-in** compose profiles; plain `up` never starts them; **no collector/Loki/Tempo in dev compose at all** | `infrastructure/docker/docker-compose.dev.yml:275-349` (`profiles: ["observability", "prometheus"]`) |
| Read path degrades gracefully — 2.5 s abort timeout, `null`/`[]` on any failure, debug-level logging, admin tiles render em-dash | `packages/applications/src/services/platform-metrics/prometheus-query.service.ts:44,99-125`; TASK-386 README decision #1 |
| STT / SMR / Guardrail / Harness gate OTel behind `otel_enabled: bool = False` and only then import/start exporters | `apps/stt-v2/src/stt_v2/core/config/settings.py:500-503` + `main.py:265-273`; `apps/smr/src/smr_v2/core/config.py:145` + `main.py:249-259`; `apps/guardrail/src/guardrail/core/config.py:237` (setup never called); `apps/harness/src/harness/core/config.py:256` |
| `/metrics` endpoints are passive pull surfaces, on by default (`metrics_enabled: bool = True`) | `apps/*/main.py` (`prometheus_fastapi_instrumentator` / `prometheus_client`); API via `@willsoto/nestjs-prometheus`, deliberately public: `apps/api/src/bootstrap/third-party-public-routes.ts:33` |
| `.env.test` already neutralized (`OTEL_EXPORTER_OTLP_ENDPOINT=` empty, flags false) | `.env.test:158-160` |
| Loki transport default off | `packages/applications/src/services/baseServices/logging/logging.service.ts:125` (`LOKI_ENABLED` default `false`) |
| `pnpm dev:api` never loads the OTel SDK (only `start`/`start:prod`/Docker do) | `apps/api/package.json:9-13`; `apps/api/Dockerfile:182`; no `instrumentation` import in `main.ts` |

### 2.2 Gap 1 — NLP activates OTLP push on endpoint presence (no master switch; log export ungated)

- Activation is presence-based: `apps/nlp/src/nlp/core/observability.py:41-44` (`if not settings.service.otlp_endpoint: return`), called unconditionally from `apps/nlp/src/nlp/lifespan.py:30`.
- Sub-toggles exist for traces (`OTEL_TRACES_ENABLED`, `config.py:63`) and metrics (`OTEL_METRICS_ENABLED`, `config.py:64`) but **log export has no gate** (`observability.py:85-92` always runs once the endpoint is set).
- Trace batch flush is aggressive: `schedule_delay_millis=500` (`observability.py:70`) → sub-second retry noise when the collector is absent.
- Every committed dev template sets the endpoint **and** the true flags: root `.env.example:109-113`, `.env.dev:84-88`, `apps/nlp/.env.example:23-29`, `apps/api/.env.example:71-77`.
- NLP loads env via `dotenv.load_dotenv()` (`apps/nlp/src/nlp/core/config.py:11`), which walks up and finds `apps/nlp/.env` or the repo-root `.env` — the documented setup step ("copy `.env.example` to `.env`", `infrastructure/docker/docker-compose.yml:13-14`) therefore switches NLP's OTel push ON in a fresh environment.

### 2.3 Gap 2 — API `instrumentation.ts` has no gate and a localhost fallback

```
apps/api/src/instrumentation.ts:15   const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317';
apps/api/src/instrumentation.ts:35   sdk.start();   // unconditional
```

- Loaded by `pnpm start`, `start:prod`, and the Docker image CMD (`apps/api/Dockerfile:182`).
- Root `.env.production:112` leaves the endpoint **empty** → falls through `||` to `localhost:4317`.
- Production is safe to change: the API's real prod env sets the endpoint explicitly (`apps/api/.env.production:86` → `http://10.10.1.100:4317`), so removing the implicit fallback only affects undocumented implicit-localhost setups (which must become explicit — flagged as a deliberate behavior change).

### 2.4 Gap 3 — dev templates advertise observability-on

| File | Lines | Today | Problem |
|---|---|---|---|
| `.env.example` | 109-113 | endpoint `http://localhost:4317`, traces/metrics `true` | Trips Gap 1 on fresh setup |
| `.env.dev` | 84-88 | same | Same (committed dev env) |
| `apps/nlp/.env.example` | 23-29 | same + resource attrs | Same, app-local |
| `apps/api/.env.example` | 71-77 | same + logs flags | Misleading for dev |
| `apps/guardrail/.env.example` | 19-21 | `GUARDRAIL_OTEL_*` | **Dead vars** — root settings prefix is `GUARDRAIL_V2_` (`apps/guardrail/src/guardrail/core/config.py:216`), so these are silently ignored |
| `apps/stt-v2/.env.example` | 250-254 | bare `OTEL_ENABLED=false` etc. | **Correct** — STT settings have no `env_prefix` (`settings.py:18-23`); no change |

### 2.5 Scripts / npm audit (evidence)

- `scripts/dev-service.sh`, `scripts/dev-infra.sh` (profiles: vault + temporal only), `scripts/dev-stack.sh`, `scripts/dev-doctor.sh`, `scripts/dev-setup.sh`, `scripts/start-infra.sh`: **zero** references to Prometheus/Grafana/OTel/Loki/Tempo — nothing to fix (verified via `rg -i "otel|4317|prometheus|grafana|loki|tempo"`).
- `package.json`: no observability coupling in `dev:*`/`infra:*`/`docker:dev:*` scripts; there is **no convenience alias** for the TASK-397 opt-in profile (developers must type the full two-flag compose command) — small addition proposed below.

---

## 3. Implementation Plan (requires user approval before any code)

No database, domain, or service-layer changes. Layers touched: Python service (NLP), API gateway bootstrap file, env templates, npm scripts, docs. TDD Red-Green-Refactor per unit.

### 3.1 Work item A — NLP master switch `NLP_OTEL_ENABLED` (default off)

**RED — tests first** (`apps/nlp/tests/test_observability.py`, extend existing suites; plus a config test):

| # | Test | Expected failure today |
|---|---|---|
| A1 | `otel_enabled` defaults to `False` on `NLPServiceConfig` (no env set) | Field doesn't exist |
| A2 | Endpoint set + `otel_enabled=False` → `setup_opentelemetry` returns early: **no** TracerProvider / MeterProvider / **LoggerProvider** created, no handler added to root logger, FastAPI app not instrumented | Providers are created today |
| A3 | Endpoint set + `otel_enabled=True` → providers created exactly as today (regression guard for existing behavior incl. PHI hook) | Passes only after gate wired correctly |
| A4 | `otel_enabled=True` + endpoint unset → disabled (existing early-return keeps working) | Should already pass; locks the contract |
| A5 | `shutdown_opentelemetry` is a no-op (no raise) when setup was skipped | Guard symmetry |

**GREEN — minimal implementation:**

1. `apps/nlp/src/nlp/core/config.py` — add to `NLPServiceConfig`: `otel_enabled: bool = Field(default=False)` reading `NLP_OTEL_ENABLED` (wire through the existing `__init__ kwargs.setdefault(...)` pattern for consistency with sibling fields).
2. `apps/nlp/src/nlp/core/observability.py` — top of `setup_opentelemetry`: return early with **one** info log (`"OpenTelemetry disabled (NLP_OTEL_ENABLED=false)"`) unless `settings.service.otel_enabled and settings.service.otlp_endpoint`. Mirror the same condition in `shutdown_opentelemetry`. The master switch thereby gates traces, metrics, **and the currently ungated log pipeline**; `OTEL_TRACES_ENABLED`/`OTEL_METRICS_ENABLED` remain sub-toggles beneath it.
3. `apps/nlp/tests/conftest.py` — keep the existing `setup_opentelemetry` patch (unchanged); confirm no test relies on implicit activation.

**Out of scope:** renaming NLP's standard `OTEL_*` sub-toggle vars (cross-service naming standardization was review item 6; not in this ticket).

### 3.2 Work item B — API `instrumentation.ts` explicit gate

**RED — update/extend** `apps/api/src/__tests__/instrumentation.test.ts`:

| # | Test | Expected failure today |
|---|---|---|
| B1 | Endpoint unset → `NodeSDK` not constructed / `sdk.start()` not called; a single "telemetry disabled" info line | SDK starts with localhost fallback today |
| B2 | Endpoint empty string → same as B1 | Same |
| B3 | Endpoint set (e.g. `http://collector:4317`) → SDK constructed with exporters pointing at that exact URL and started (existing assertions updated: current tests expect the localhost **default** — flip those expectations) | Existing default-URL tests will be updated |
| B4 | `OTEL_SDK_DISABLED=true` + endpoint set → not started | No kill-switch today |
| B5 | SIGTERM/SIGINT handlers only registered when the SDK started (no-op shutdown otherwise) | Handlers always registered today |

**GREEN — minimal implementation** (`apps/api/src/instrumentation.ts`):

- Remove the `|| 'http://localhost:4317'` fallback.
- Wrap resource/exporter/SDK construction + `sdk.start()` + shutdown-handler registration in: `if (endpoint && process.env.OTEL_SDK_DISABLED !== 'true') { … } else { console.log('[OTel] telemetry export disabled (…reason…)'); }`.
- No change to exporter wiring, instrumentation list, or shutdown flush logic when enabled.

**Deliberate behavior change (flagged for approval):** a deployment that relied on the *implicit* localhost fallback must now set `OTEL_EXPORTER_OTLP_ENDPOINT` explicitly. The documented prod path already does (`apps/api/.env.production:86`).

### 3.3 Work item C — env template neutralization

No tests (config files); guarded by grep-based verification in §3.5 and by `apps/api/src/__tests__/env-port-standardization.test.ts` (confirmed: it asserts no OTEL values).

| File | Change |
|---|---|
| `.env.example:109-113` | `OTEL_TRACES_ENABLED=false`, `OTEL_METRICS_ENABLED=false`, `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) + comment: "set only when running an OTLP collector (opt-in; see infrastructure/docker/README.md)" |
| `.env.dev:84-88` | Same treatment (touch **only** the OTEL block — file has unrelated local modifications) |
| `.env.production:110-114` | Keep flags `true`; add comment that the endpoint is **required** for export — empty now means "telemetry off" (post-item-B semantics), not "localhost" |
| `apps/api/.env.example:71-77` | Endpoint empty + comment; flags `false`; document `OTEL_SDK_DISABLED` |
| `apps/nlp/.env.example:23-29` | Add `NLP_OTEL_ENABLED=false` (master switch, first line of the block); endpoint empty + comment; traces/metrics `false` |
| `apps/guardrail/.env.example:19-21` | Rename dead vars → `GUARDRAIL_V2_OTEL_ENABLED` / `GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT` / `GUARDRAIL_V2_OTEL_SERVICE_NAME` (root settings prefix `GUARDRAIL_V2_`, config.py:216) |
| `.env.test`, `apps/stt-v2/.env.example`, `apps/smr/.env.example`, `apps/harness/.env.example` | **No change** (already correct) |

### 3.4 Work item D — scripts, npm aliases, docs

1. **Shell scripts:** audit complete (§2.5) — no observability coupling; **no changes**. Evidence goes into the Implementation Summary.
2. **npm scripts** (`package.json`): add two convenience aliases mirroring the TASK-397 canonical commands:
   - `"infra:observability:up": "docker compose -f infrastructure/docker/docker-compose.dev.yml --profile prometheus up -d prometheus grafana"`
   - `"infra:observability:down": "docker compose -f infrastructure/docker/docker-compose.dev.yml --profile prometheus stop prometheus grafana"`
3. **Docs** (`infrastructure/docker/README.md`): add a short **"Observability (optional, default off)"** section stating the invariant — *services may expose `/metrics`, but must never require a reachable observability backend to start, serve, or stay quiet in logs* — plus the opt-in commands (npm aliases + raw compose form) and a pointer to TASK-397 for the value-flow.
4. **Optional / out of scope unless requested:** a `dev-doctor.sh` informational line listing prometheus/grafana as optional components.

### 3.5 Verification criteria (Phase 5 gate)

| Check | Command | Pass condition |
|---|---|---|
| NLP unit tests | `conda run -n arcaenv python -m pytest apps/nlp/tests/test_observability.py -q` (+ full `pnpm py:nlp:test`) | All pass incl. A1–A5 |
| API unit tests | `pnpm --filter @arcaai/api test` (vitest) | All pass incl. B1–B5 |
| API build | `pnpm build:api` | Success |
| No fallback remains | `rg "localhost:4317" apps/api/src/instrumentation.ts` | No matches |
| Template posture | `rg "OTEL_TRACES_ENABLED=true|OTEL_METRICS_ENABLED=true" .env.example .env.dev apps/api/.env.example apps/nlp/.env.example` | No matches |
| Cold-start smoke (AC-1) | Stop prometheus/grafana containers; start NLP with endpoint set but master switch off, and API via `pnpm start` with endpoint unset | ≥60 s of logs with zero OTLP/export errors; single "disabled" info line for the API |
| Opt-in still works | `NLP_OTEL_ENABLED=true` + endpoint set → NLP logs "OpenTelemetry initialized"; export failures may then appear (expected — collector deliberately absent) | Confirms gate direction |
| Lint | ReadLints on all modified files | No new errors |

### 3.6 File change order

1. RED: NLP tests (A1–A5) → run, confirm failures
2. GREEN: `apps/nlp/src/nlp/core/config.py`, `apps/nlp/src/nlp/core/observability.py` → tests pass
3. RED: API instrumentation tests (B1–B5) → run, confirm failures
4. GREEN: `apps/api/src/instrumentation.ts` → tests pass
5. Templates (item C, six files)
6. `package.json` aliases + `infrastructure/docker/README.md` (item D)
7. Full verification suite (§3.5), lint, evidence capture, ticket update

---

## 4. Implementation Summary

Implemented 2026-07-03 by three parallel agents on disjoint file sets (A: `apps/nlp`; B: `apps/api/src`; C+D: env templates + `package.json` + infra README), TDD RED→GREEN for both code items.

### 4.1 Files changed (13)

| File | Change |
|---|---|
| `apps/nlp/src/nlp/core/config.py` | Added `otel_enabled` to `NLPServiceConfig` reading `NLP_OTEL_ENABLED` (default `false`), matching sibling field style (Field default + `__init__` setdefault) |
| `apps/nlp/src/nlp/core/observability.py` | `setup_opentelemetry`: early-return with one info line unless `otel_enabled`; master switch gates traces + metrics + the previously ungated log export. Endpoint check (warning) kept as misconfiguration signal. `shutdown_opentelemetry` mirrors the gate |
| `apps/nlp/tests/test_observability.py` | Tests A1–A5 added; existing activation tests updated to opt in explicitly (`otel_enabled=True`) |
| `apps/api/src/instrumentation.ts` | Removed `localhost:4317` fallback; SDK constructed/started and signal handlers registered ONLY when `OTEL_EXPORTER_OTLP_ENDPOINT` set and `OTEL_SDK_DISABLED !== 'true'`; single `[OTel] Telemetry export disabled (<reason>)` line otherwise. Enabled-path config unchanged |
| `apps/api/src/__tests__/instrumentation.test.ts` | Tests B1–B5; existing enabled-path tests now set the endpoint explicitly. 13 tests total |
| `.env.example` | OTEL block: endpoint empty + opt-in comment, traces/metrics `false` |
| `.env.dev` | Same treatment, OTEL block only (lines 84–91) |
| `.env.production` | Flags stay `true`; endpoint comment now states it is REQUIRED for export (no implicit localhost fallback) |
| `apps/api/.env.example` | Endpoint empty + comment (incl. `OTEL_SDK_DISABLED` kill-switch, dev-vs-start semantics); traces/metrics/logs/log-bridge `false` |
| `apps/nlp/.env.example` | `NLP_OTEL_ENABLED=false` master switch added; endpoint empty + comment; traces/metrics `false` |
| `apps/guardrail/.env.example` | Dead vars renamed `GUARDRAIL_OTEL_*` → `GUARDRAIL_V2_OTEL_*` (root settings env_prefix) |
| `package.json` | Added `infra:observability:up` / `infra:observability:down` aliases (TASK-397 `--profile prometheus` command) |
| `infrastructure/docker/README.md` | New "Observability (optional, default off)" section: invariant, pull-stack opt-in, per-service push opt-in switches |

No migrations, no API-surface changes, no domain/service-layer changes. Scripts audit (§2.5): no shell-script changes required — none reference observability tooling.

### 4.2 Verification evidence (2026-07-03)

- **NLP tests:** `conda run -n arcaenv python -m pytest tests/test_observability.py tests/test_metrics_task386.py -q` → **33 passed** (RED first: 4 new tests failed pre-implementation; agent evidence).
- **API tests:** `vitest run src/__tests__/instrumentation.test.ts` → **13 passed**; full api suite (agent run) → **1936 passed, 0 failed** (baseline had 0 failures); `pnpm build:api` → 8/8 tasks successful.
- **Grep gates:** `rg "localhost:4317" apps/api/src/instrumentation.ts` → none; `rg "OTEL_TRACES_ENABLED=true|OTEL_METRICS_ENABLED=true|OTEL_EXPORTER_OTLP_ENDPOINT=http" .env.example .env.dev apps/api/.env.example apps/nlp/.env.example` → none; `.env.production` keeps `true` flags; no `GUARDRAIL_OTEL_` left; `package.json` valid JSON.
- **Runtime smoke — API** (built `dist/instrumentation.js`): endpoint unset → `[OTel] Telemetry export disabled (OTEL_EXPORTER_OTLP_ENDPOINT not set)` + boots; endpoint set → SDK starts; `OTEL_SDK_DISABLED=true` → disabled line + boots.
- **Runtime smoke — NLP** (the exact former landmine: endpoint set, no collector, master switch untouched): `OpenTelemetry disabled (NLP_OTEL_ENABLED=false)`, no providers on `app.state`, shutdown no-op. With `NLP_OTEL_ENABLED=true`: initializes (export retries against the deliberately absent collector then appear — proving activation is now strictly opt-in).
- **Unchanged services:** STT/SMR/Guardrail/Harness already default `otel_enabled=False` (verified in §2.1); no code or template changes needed there.
- **Lint:** ReadLints on all modified source/config files → no errors.

### 4.3 Notes & follow-ups (out of scope)

- **Pre-existing build quirk (observation only):** `apps/api` `build` script runs `rimraf dist && nest build` but does not remove `tsconfig.build.tsbuildinfo`; with a stale tsbuildinfo, incremental tsc skips re-emitting unchanged files into the emptied `dist` (e.g. `instrumentation.js` missing until `pnpm run clean`). Docker/CI builds from fresh checkouts are unaffected. Candidate one-line fix in a hygiene ticket: `rimraf dist *.tsbuildinfo && nest build`.
- Cross-service OTel env-var naming standardization (review item 6) remains intentionally out of scope.
- `OTEL_LOGS_ENABLED` / `OTEL_LOG_BRIDGE` (api template) are consumed by the logging-service transports; flipped to `false` in the dev template for posture consistency — production template untouched.

---

## 5. Change History

| Date | Change | Files |
|---|---|---|
| 2026-07-03 | Ticket created from the observability-independence codebase review: requirement analysis, current-state evidence (gaps: NLP endpoint-presence activation incl. ungated log export; API unconditional SDK start with localhost fallback; dev templates advertising observability-on; dead guardrail template vars), scripts/npm audit, and TDD implementation plan. **Status: Pending — awaiting plan approval.** | This README |
| 2026-07-03 | Plan approved; implemented via three parallel agents (A/B/C+D, disjoint file sets). NLP `NLP_OTEL_ENABLED` master switch (default off, gates traces+metrics+logs); API `instrumentation.ts` explicit opt-in gate (no localhost fallback, `OTEL_SDK_DISABLED` honored); six env templates neutralized/corrected; `infra:observability:*` npm aliases; README invariant section. Verified: NLP 33 tests, API 13 instrumentation tests + full suite 1936/0 + build, grep gates, runtime smokes for both changed services. **Status: Review — awaiting user confirmation.** | See §4.1 file list |
