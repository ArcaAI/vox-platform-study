# TASK-627 — Service Health, Probe & Lifecycle Standards Across All Services

**Status**: Pending
**Classification**: Infrastructure
**Created**: 2026-08-07
**Parent**: [TASK-616 — Deployment/CI-CD/Observability Modernization](../TASK-616-Deployment-CICD-Observability-Modernization/README.md), specifically [`component-design-zero-downtime-ha.md`](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-zero-downtime-ha.md) (Appendix G) and [`live-state-2026-08.md`](../TASK-616-Deployment-CICD-Observability-Modernization/live-state-2026-08.md) (Appendix B)
**Deployment manifests live in a sibling repo**: `hope-v2-deployment/deployment/k8s/base/*.yaml` (k3s/ArgoCD; NOT the deleted in-monorepo `deployment/k8s/` tree `09-infrastructure-devops.md` still describes)

## Relationship to TASK-616 — read this first

TASK-616's Appendix G already diagnosed the triggering defect and produced a per-service remediation table (§G1) plus a set of prioritized execution tasks (`execution-plan.md` 0.0, 0.15, 0.6, 0.7, 0.8, 0.12, 3.6) that apply specific fixes: repoint `hope-api`'s probes (0.0), author probe/tGPS/preStop values for the other 9 services (0.15), author probes for `stt-v2-worker` (0.6), author Ingress (0.7), author deployment-repo CI (0.8), author `harness-worker.yaml` (0.12), and complete metrics scrape coverage (3.6). **TASK-627 does not re-plan any of that** — §2.7 below maps every TASK-627 finding against those task IDs so nothing is duplicated.

What TASK-616 did not produce is a **written, reusable standard**: Appendix G is a set of per-service findings and one-off fixes for the *current* 10 workloads, not a contract new services must satisfy, not a design for how the two Python-worker processes (which have no HTTP server) report health, not a decision for the two Next.js/Vite frontend apps (which have no health contract at all today), and not a CI guard that stops this class of defect from recurring. That gap is TASK-627's scope.

## 1. Requirement Analysis

Build a platform-wide health/probe/lifecycle standard for all 11 canonical HOPE services (`api`, `stt` + `stt-worker`, `smr`, `guardrail`, `harness` + `harness-worker`, `nlp`, `tts`, `admin-console`, `compat-playground`), covering:

1. An audit of what every service's code actually implements vs. what its k8s manifest actually probes (§2.2–§2.3).
2. A canonical health-contract spec (endpoint semantics, response shape, status codes) for NestJS and FastAPI, generalizing the convention six of seven backend services already converged on informally (§3, Phase 1).
3. A health approach for the two worker processes that have no HTTP server at all (§3, Phase 3).
4. Pod lifecycle rules: `terminationGracePeriodSeconds` sizing, `preStop`, per-runtime SIGTERM ownership, generalized from three real, cited bugs already found in this codebase (§3, Phase 5).
5. Monitoring integration specifically for probe/lifecycle failure signals — SLIs, scrape config, Grafana-per-service contract, restart/probe alerting (§3, Phase 6), scoped to not duplicate TASK-616 execution-plan 3.6's general metrics-coverage work.
6. A CI check that makes "manifest probe path points at a route that cannot return non-200" structurally impossible to ship again (§3, Phase 7).

**Assumption stated explicitly**: this ticket produces a *standard* (a doc + a small number of code fixes that the standard itself requires, listed in §3 Phase 2) and hands the *bulk execution* of already-planned per-service manifest changes to TASK-616's existing execution-plan tasks. If the user wants TASK-627 to also perform 0.15/0.6/0.7/0.12's work, say so explicitly — as scoped, this ticket assumes those stay owned by TASK-616.

## 2. Current State Evaluation

### 2.1 The triggering defect, verified directly

All three `hope-api` probes point at `/api/v1/health`:

```yaml
# hope-v2-deployment/deployment/k8s/base/api.yaml:95-114
startupProbe:
  httpGet:
    path: /api/v1/health
    port: 8868
  failureThreshold: 30
  periodSeconds: 5
readinessProbe:
  httpGet:
    path: /api/v1/health
    port: 8868
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 3
livenessProbe:
  httpGet:
    path: /api/v1/health
    port: 8868
  initialDelaySeconds: 30
  periodSeconds: 30
  failureThreshold: 3
```

`GET /api/v1/health` (`apps/api/src/modules/health/health.controller.ts:154-180`) never throws — `status` is a string in the response body (`'healthy' | 'degraded' | 'unhealthy'`), and the handler always returns HTTP 200:

```ts
// apps/api/src/modules/health/health.controller.ts:158-180
check() {
  const isShuttingDown = this.shutdownService.isShuttingDown;
  const isReady = this.shutdownService.isReady;
  let status: string;
  if (isShuttingDown) status = 'unhealthy';
  else if (isReady) status = 'healthy';
  else status = 'degraded';
  return { status, service: SERVICE_NAME, version: SERVICE_VERSION, uptime_seconds: ..., timestamp: ..., checks: {...} };
}
```

The correct, already-implemented endpoints sit one route above, unused by the manifest:

```ts
// apps/api/src/modules/health/health.controller.ts:115-152
@Get('live')  liveness()  { return { status: 'healthy' }; }                    // always 200 — pure process check
@Get('ready') readiness() { if (!this.shutdownService.isReady) throw new ServiceUnavailableException(...); return {...}; }  // 503 when not ready
@Get('startup') startup() { if (!this.shutdownService.isReady && !this.shutdownService.isShuttingDown) throw new ServiceUnavailableException(...); return {...}; }  // 503 while initializing
```

`readiness()`/`startup()` read `GracefulShutdownService.isReady`/`isShuttingDown` (`apps/api/src/services/graceful-shutdown.service.ts:184-194`), which are correctly wired: `main.ts:169` calls `app.enableShutdownHooks()`, which drives `onModuleInit` (sets `_isReady = true`) → SIGTERM → `onModuleDestroy` (sets `_isShuttingDown = true`, `_isReady = false`, sleeps `drainDelayMs`) → `beforeApplicationShutdown` → `onApplicationShutdown`. **The service-level drain logic runs regardless of probe wiring** (SIGTERM still triggers `onModuleDestroy`'s sleep); what the manifest bug actually breaks is the *external* half of the drain — Kubernetes never observes `isReady` flip to `false`, so the pod is never pulled from Service endpoints before it starts refusing/dropping in-flight work. `GracefulShutdownService.registerCleanupCallback` (`graceful-shutdown.service.ts:203-224`) has zero callers anywhere in the codebase — it is dead code today, a fact this ticket's Phase 5 standard should prevent recurring elsewhere.

A second, independent SIGTERM handler compounds the problem: `apps/api/src/instrumentation.ts:64-65` registers `process.on('SIGTERM', ...)` for OpenTelemetry shutdown, with a `setTimeout(() => process.exit(1), 25_000)` force-exit at `instrumentation.ts:50-52` — racing Nest's own ~35s budget (5s drain + 30s `SHUTDOWN_TIMEOUT_MS`) and undercutting the manifest's `terminationGracePeriodSeconds: 60` (`api.yaml:24`). Two SIGTERM handlers on one process, neither aware of the other. This exact anti-pattern recurs in Python (§2.3) — it is the empirical basis for the "one handler owns the lifecycle" rule in §3 Phase 5.

### 2.2 Full per-service health/probe matrix

Verified directly against source (`apps/*/src/**`) and the live manifests (`hope-v2-deployment/deployment/k8s/base/*.yaml`) on 2026-08-07.

| Service | Port | Code implements `/live` + `/ready` correctly? | Manifest readinessProbe path | Manifest livenessProbe path | Manifest startupProbe | Verdict |
|---|---|---|---|---|---|---|
| **api** | 8868 | Yes — `health.controller.ts:115-152`, `/ready` throws 503, `/live` pure | `/api/v1/health` (always 200) | `/api/v1/health` (always 200) | `/api/v1/health` | **Manifest-only bug.** Endpoints exist and are correct; manifest ignores them (§2.1). Owned by execution-plan **0.0**. |
| **stt** | 8861 | Partial — `/health/ready` at `stt/health/api/routes.py:109-119` correctly returns 503 on DB/MinIO/Redis failure; `/health` (:45-100) and `/health/live` (:103-106) always 200 | `/api/v1/health` (always 200) | `/api/v1/health` (always 200, **includes DB/MinIO/Redis checks** — violates liveness-must-be-dependency-free) | `/api/v1/health/live` (correct) | **Manifest bug, worse than api's**: readiness ignores the working `/health/ready`, AND liveness is wired to the *dependency-checking* endpoint, so a DB blip can trigger a liveness-triggered container restart instead of a clean readiness-only pull from the Service. Owned by execution-plan **0.15** (flag this specific detail for its implementer — Appendix G's table doesn't call it out explicitly, see §2.7). |
| **smr** | 8862 | Yes — `smr/api/endpoints/health.py:111-135`, `/health/ready` returns 503 via `JSONResponse` on Redis-down or zero-healthy-providers | `/api/v1/health/live` (always 200) | `/api/v1/health/live` (always 200) | `/api/v1/health/live` | **Manifest-only bug**, same class as api: a correct `/health/ready` exists and is unused. Owned by execution-plan **0.15**. |
| **guardrail** | 8863 | **No — endpoint-level bug**, not just manifest. `/health/ready` (`guardrail/api/endpoints/health.py:83-105`) returns a plain `dict`, never `JSONResponse(status_code=503, ...)`; on Redis failure it returns `{"ready": False, ...}` with HTTP **200**. | `/api/health/ready` (correct path, but the endpoint itself cannot signal failure) | `/api/health/live` (correct) | `/api/health/live` (correct) | **New finding, not in Appendix G.** Manifest wiring is right; the handler is wrong. See §2.3 and §3 Phase 2a. |
| **nlp** | 8864 | Weak — `/health/ready` (`nlp/api/v1/rest/monitoring.py:86-102`) only checks whether `effective_config_client` finished constructing during lifespan startup; it never probes a real dependency. `/health`/`/health/live` always 200. | `/api/v1/health` (always 200) | `/api/v1/health` (always 200) | `/api/v1/health` | **Manifest bug** (same class as api) **plus a weak readiness check** worth strengthening when 0.15 repoints it. Owned by execution-plan **0.15**. |
| **harness** | 8866 | Yes — `harness/api/endpoints/health.py:72-101`, `/health/ready` does a real Temporal RPC (`client.service_client.check_health()`) and returns 503 via `JSONResponse` on failure; `/health` (:36-63) is deliberately dependency-free (echoes config, does not dial Temporal) | `/api/v1/health/ready` (correct) | `/api/v1/health/live` (correct) | `/api/v1/health/live` (correct) | **No gap.** Confirms the ticket brief's expectation. Exemplar for §3 Phase 1's spec. |
| **tts** | 8865 | Yes — `tts/api/endpoints/health.py:46-64`, `/health/ready` returns 503 via `JSONResponse` when zero providers are registered/healthy | `/api/v1/health/live` (always 200) | `/api/v1/health/live` (always 200) | `/api/v1/health/live` | **Manifest-only bug**, same class as smr. Owned by execution-plan **0.15**. |
| **admin-console** | 3000 | **No health contract at all.** No `/api/health*` route anywhere under `apps/admin-console/src/app` (confirmed by search). Docker `HEALTHCHECK` and the k8s probes both hit `/login`, a real page. | `/login` | `/login` | *(none)* | Conflates "login page regressed" with "process/dependency health." §3 Phase 4a. |
| **compat-playground** | 3000 | **No health contract at all** — it is a Vite SPA with no backend; `serve -s dist -l 3000` (`apps/compat-playground/Dockerfile:66`) serves static files only. | `/` | `/` | *(none)* | Weaker signal than admin-console's — `/` only proves `index.html` is served, not that the bundle works. §3 Phase 4b. |
| **stt-worker** | none | N/A — no HTTP server (Dramatiq worker, `apps/stt/src/stt/worker.py`) | — | — | — | No probes exist in the manifest at all (`stt-v2-worker.yaml` has no `ports:`/probe keys). Owned by execution-plan **0.6**; approach designed in §3 Phase 3. |
| **harness-worker** | none | N/A — no HTTP server (Temporal worker, `apps/harness/src/harness/temporal/worker.py`) | — | — | — | **Manifest does not exist yet** (confirmed: `grep -rni "harness.*worker" hope-v2-deployment` → 0 matches). Owned by execution-plan **0.12**; approach designed in §3 Phase 3. |

Every backend service that emits a `/metrics` route uses `prometheus_fastapi_instrumentator.Instrumentator().instrument(app).expose(app, endpoint="/metrics")`, gated by `settings.metrics_enabled` — confirmed present in `stt/main.py:255-258`, `smr/main.py:395-398`, `guardrail/main.py:250-254`, `nlp/app.py:49` (via `core/observability.py:155-169`), `harness/main.py:106-109`, `tts/main.py:170-173`. `apps/api` exposes `/metrics` too (excluded from the global `api/v1` prefix per `apps/api/src/main.ts` bootstrap facts in `05-nestjs-api.md`). **Only 3 of these 7 `/metrics` endpoints are actually scraped** — see §2.6.

### 2.3 Findings beyond the original brief

Direct code reading surfaced three defects Appendix G did not catalogue, because Appendix G's scope was `hope-api` plus a cross-service manifest table, not a line-by-line audit of every Python health handler:

1. **Guardrail's `/health/ready` cannot fail an HTTP status code** (`apps/guardrail/src/guardrail/api/endpoints/health.py:83-105`). Every other service's readiness handler returns `JSONResponse(status_code=503, ...)` on the equivalent failure path; guardrail returns a plain `dict` with `{"ready": False, ...}` serialized as HTTP 200. Even after 0.15 (or anyone) confirms guardrail's manifest paths are correct, the readiness gate is inert — Kubernetes polls a 200 no matter what the body says. This is a code fix, not a manifest fix; scoped in §3 Phase 2a.

2. **STT registers a second, competing SIGTERM handler inside the FastAPI process**, the same anti-pattern as `apps/api/src/instrumentation.ts` (§2.1):

   ```python
   # apps/stt/src/stt/main.py:267-273
   def handle_sigterm(signum: int, frame: object) -> None:
       """Handle SIGTERM for graceful shutdown."""
       logger.info("Received SIGTERM, initiating graceful shutdown...")
       raise SystemExit(0)

   signal.signal(signal.SIGTERM, handle_sigterm)
   ```

   This module-level `signal.signal()` call competes with uvicorn's own signal handling, which is what normally drives the FastAPI `lifespan()` shutdown block — and that block does real work worth not skipping: `shutdown_streaming()`, punctuation/embedding service shutdown, `close_minio()/close_redis()/close_database()`, OTel flush (`stt/main.py:177-205`). Whether `raise SystemExit(0)` from a raw signal handler races or short-circuits uvicorn's lifespan-driven shutdown depends on install order and needs verification as part of §3 Phase 5's implementation, not assumed here — but a second SIGTERM handler competing with the framework's own is exactly the class of bug the "one handler owns the lifecycle" rule exists to prevent, and this is now the **second confirmed instance** in the codebase (after `instrumentation.ts`), which upgrades it from a hypothetical rule to a pattern with two live repro cases.

3. **SMR's shutdown handling is the best exemplar in the codebase** and should anchor the FastAPI section of the Phase 1 contract: `ShutdownManager.wait_for_shutdown` (`apps/smr/src/smr/services/shutdown_manager.py:41-51`) waits up to 30s on an `asyncio.Event` set when in-flight generation tasks drain, logging `smr.draining_tasks`/`smr.drain_timeout`, before closing the httpx client, Redis, and OTel (`smr/main.py:286-307`). No explicit `signal.signal()` call exists in `smr/main.py` — it relies entirely on uvicorn's default SIGTERM → ASGI lifespan-shutdown path, which is the correct pattern (one handler, framework-owned).

### 2.4 Worker processes — confirmed no HTTP server

- **`apps/stt/src/stt/worker.py`** — Dramatiq entrypoint. No `fastapi`/`uvicorn` import anywhere in the file. `main()` builds a `dramatiq.Worker`, installs its own `signal.signal(SIGINT/SIGTERM, handle_signal)` (:212-213), blocks on `shutdown_event.wait()`, then `worker.stop()`/`worker.join()`. Run via `pnpm stt:worker:dev` → `./scripts/dev-service.sh stt-worker`.
- **`apps/harness/src/harness/temporal/worker.py`** — Temporal worker entrypoint (`conda run -n arcaenv python -m harness.temporal.worker`, or `pnpm worker:dev`). No FastAPI/uvicorn import; imports only `temporalio.worker.Worker`. Installs `loop.add_signal_handler(sig, ...)` for `(SIGINT, SIGTERM)` (:179-187) and builds a `Worker(..., graceful_shutdown_timeout=timedelta(seconds=settings.temporal.graceful_shutdown_timeout_s), ...)` — Temporal's own SDK drains in-flight activities for that window before cancelling. Unlike the FastAPI app's best-effort Temporal connect (`harness/main.py:24-63`, wrapped in `try/except Exception` with a comment stating *"the worker ... is what actually requires Temporal"*), the worker's `client = await get_temporal_client(settings)` has no try/except — an unreachable Temporal server crashes worker startup outright, by design.

Neither process exposes a port, a `/metrics` endpoint, or any way for Kubernetes to probe it over HTTP. `stt-v2-worker.yaml` currently has a `preStop: sleep 10` hook and no probes at all; there is no `harness-worker.yaml` yet. §3 Phase 3 designs the health approach both `stt-worker`'s existing manifest and `harness-worker`'s not-yet-authored manifest should use.

### 2.5 Pod lifecycle current state

| Manifest | `terminationGracePeriodSeconds` | `preStop` |
|---|---|---|
| `api.yaml` | **60** (`:24`) | `exec: sh -c "sleep 10"` (`:34-36`) |
| `stt-v2.yaml` | **60** (`:22`) | `exec: sh -c "sleep 10"` (`:46-48`) |
| `stt-v2-worker.yaml` | **60** (`:22`) | `exec: sh -c "sleep 10"` (`:44-46`) — present even though the container has no HTTP port at all |
| `guardrail.yaml`, `harness.yaml`, `nlp.yaml`, `smr.yaml`, `tts-v2.yaml` | not set → k8s default **30** | missing |
| `admin-console.yaml`, `compat-playground.yaml`, `ui.yaml` (undeployed) | not set → default **30** | missing |

Only the three workloads with GPU/streaming/gateway traffic got any tuning at all; the other 8 active workloads run on the bare k8s default with no drain hook. All three existing `preStop` hooks use `exec: sh -c "sleep 10"` — on the target k8s version this should migrate to the native `sleep` lifecycle action (§3 Phase 5).

### 2.6 Monitoring current state

- Prometheus is a **raw `Deployment`** running `prom/prometheus:v3.10.0` (`hope-v2-deployment/deployment/k8s/base/prometheus.yaml:14-77`), not the Prometheus Operator / `kube-prometheus-stack`. **Zero `ServiceMonitor`/`PodMonitor`/`PrometheusRule` CRDs exist anywhere in the repo.**
- Scrape targets are a hand-maintained static list (`observability-config.yaml:80-121`) covering exactly **7 jobs**: `api-gateway` (hope-api:8868), `stt-v2` (hope-stt-v2:8861), `smr` (hope-smr:8862), plus `loki`, `tempo`, `grafana`, `prometheus` (self). **guardrail, harness, nlp, tts, admin-console, compat-playground, and stt-v2-worker are absent** — even though guardrail/harness/nlp/tts all expose a working `/metrics` (§2.2). No `prometheus.io/*` pod annotations exist anywhere in the repo either, so there is no annotation-based fallback discovery.
- **`kube-state-metrics` is not deployed** (0 matches repo-wide). This matters directly for §3 Phase 6: any alert on `kube_pod_container_status_restarts_total` or `kube_pod_status_ready` requires this exporter first — it is a prerequisite this ticket must call out, not assume.
- **`nvidia-dcgm-exporter` is already running and healthy** as part of the GPU Operator stack (confirmed in `live-state-2026-08.md` §B5) — GPU metrics work is "add a scrape target," not "deploy an exporter," and is already scoped as part of execution-plan **3.6**.
- This split — Appendix G covers probe/lifecycle, README/execution-plan/`sota-research-2026.md` cover scrape-coverage/ServiceMonitor migration — is intentional in TASK-616's existing document structure; §3 Phase 6 keeps that split rather than re-deriving scrape-coverage work.

### 2.7 Explicit non-overlap with TASK-616 execution-plan.md

| TASK-627 finding | Owning execution-plan task | TASK-627's role |
|---|---|---|
| `hope-api` probes point at `/health` | **0.0** | Cite only — already fully scoped and prioritized as #1. |
| Probe/tGPS/preStop for guardrail, harness, nlp, smr, tts, stt-v2, admin-console, compat-playground, ui | **0.15** | Provide the *standard* (§3 Phase 1/5) 0.15's implementer should follow, plus flag the STT liveness-checks-dependencies detail (§2.2) and the guardrail endpoint bug (§2.3-1, must land as a separate code PR before or alongside 0.15's manifest PR, since 0.15 cannot fix guardrail's readiness gate by repointing paths alone — the paths are already correct). |
| `stt-v2-worker` probes (currently none) | **0.6** | Provide the worker health-approach design (§3 Phase 3) 0.6 should implement. |
| `harness-worker.yaml` doesn't exist | **0.12** | Same design (§3 Phase 3) applies; 0.12 authors the manifest. |
| Deployment-repo CI (`kustomize build` + `kubeconform` + image-completeness + secret-key parity) | **0.8** | Add the probe-path-resolves-to-a-real-route check (§3 Phase 7) to 0.8's CI authoring scope, or land it as a follow-up job if 0.8 ships first — do not duplicate 0.8's schema-validation work. |
| Metrics scrape coverage (7→11 services), DCGM scrape target, ServiceMonitor migration | **3.6** | Cite only for scrape *coverage*; TASK-627's §3 Phase 6 is scoped narrowly to probe/lifecycle-failure *alerting* (restart counts, readiness flapping), which is a different signal from general request/latency metrics. |
| WS/SSE graceful-drain coordination (`SttWsGateway` vs. `GracefulShutdownService`) | Appendix G §G2 (not yet an execution-plan line item) | Out of scope for TASK-627 — this is API-specific session-lifecycle work, not a cross-service standard. |

## 3. Implementation Plan

Model-tier legend per project convention: `haiku-4-5` (trivial), `sonnet-5` (moderate), `sonnet-5`/`opus-4-8` (complex), `opus-5`/`fable-5` (very high).

### Phase 1 — Canonical Health Contract spec

| # | Task | Classification | Model | Effort |
|---|---|---|---|---|
| 1.1 | Write `docs/architecture/health-contract.md` (or a TASK-627 companion doc, `component-design-health-contract.md`, matching TASK-616's naming convention) formalizing the convention six of seven backend Python services already carry as a repeated code comment ("Follows the HOPE standardized health contract") into one canonical spec: exact response shape, the three-status vocabulary (`healthy`/`degraded`/`unhealthy`), which endpoint MUST vs. MUST NOT check dependencies, and the status-code table (200 body-only-degraded is banned for `/ready`; `/ready` MUST use `JSONResponse(status_code=503, ...)` in FastAPI or throw in NestJS). Use `harness/api/endpoints/health.py` and `smr/api/endpoints/health.py` as the FastAPI exemplars (§2.2/§2.3) and `apps/api/src/modules/health/health.controller.ts:115-152` as the NestJS exemplar — do not re-derive the doctrine Appendix G §G7 already settled ("liveness = pure process check, readiness = in-memory/dependency flags, dependency probing confined to an authenticated diagnostic route"); cite and extend it. | Moderate — synthesis of existing, mostly-correct code into one doc | `sonnet-5` | high |
| 1.2 | Add a `/health/startup` (or equivalent) convention decision: only `api` currently has one. Decide whether Python services need a distinct startup probe or whether `/health/live` + a generous `failureThreshold` (as `stt-v2.yaml`'s 180×5s already does) is sufficient — document the rule, don't mandate a third endpoint everywhere if it adds no signal beyond what `/live` + `failureThreshold` gives. | Moderate — a real design decision, not just documentation | `sonnet-5` | medium |

### Phase 2 — Endpoint-level fixes the contract itself requires (code, not manifests)

These are bugs the manifest-repointing work (0.0/0.15) cannot fix by itself, because the endpoints themselves are wrong.

| # | Task | Classification | Model | Effort |
|---|---|---|---|---|
| 2.1 | Fix guardrail's `/health/ready` (`apps/guardrail/src/guardrail/api/endpoints/health.py:83-105`) to return `JSONResponse(status_code=503, content={"ready": False, "reason": ...})` on Redis failure, matching every other service's pattern (stt/smr/nlp/harness/tts already do this correctly — copy their shape). Add a unit test asserting 503 on a mocked Redis failure (none exists today for this path — `apps/guardrail/src/guardrail/tests/`). | Trivial — isolated, well-understood fix with 5 sibling exemplars in the same repo | `haiku-4-5` | default |
| 2.2 | Investigate and fix the competing SIGTERM handler in `apps/stt/src/stt/main.py:267-273`. Determine (with a live SIGTERM test, not just code reading) whether `signal.signal(signal.SIGTERM, handle_sigterm)` actually pre-empts uvicorn's lifespan-driven shutdown or is a harmless no-op given uvicorn's own signal installation order; if it pre-empts, remove it and rely on uvicorn's default SIGTERM → ASGI lifespan-shutdown path (the pattern `smr/main.py` already uses correctly, §2.3-3) so the `lifespan()` shutdown block (`stt/main.py:177-205`: `shutdown_streaming()`, MinIO/Redis/DB close, telemetry flush) is guaranteed to run to completion. Do not touch `apps/stt/src/stt/worker.py`'s own signal handlers (:212-213) — those are correct and separate from this bug (Dramatiq worker, not the FastAPI process). | Moderate — behavior-sensitive; must be verified with an actual SIGTERM against a running process, not just static reading | `sonnet-5` | medium |
| 2.3 | Strengthen `nlp`'s `/health/ready` (`apps/nlp/src/nlp/api/v1/rest/monitoring.py:86-102`) from "did lifespan finish constructing `effective_config_client`" to an actual dependency check consistent with the Phase 1 contract — but only if NLP has a dependency worth gating on (it may not; NLP's models load lazily by design, per its own `/health` docstring). If no real dependency exists, document explicitly in the Phase 1 spec that "ready = process finished startup" is a valid readiness definition for a stateless, lazy-loading service — don't force a check that doesn't exist just for uniformity. | Moderate — requires a judgment call, not a mechanical fix | `sonnet-5` | medium |

### Phase 3 — Worker health approach (`stt-worker`, `harness-worker`)

| # | Task | Classification | Model | Effort |
|---|---|---|---|---|
| 3.1 | Design the worker health-check approach as a companion doc (`component-design-worker-health.md`) consumed by execution-plan 0.6 and 0.12. Confirmed constraints from §2.4: neither `stt-worker` (Dramatiq) nor `harness-worker` (Temporal SDK worker) runs an HTTP server. **Proposed MVP**: each worker's main loop touches a heartbeat file (e.g. `/tmp/worker-healthy`, mtime updated every N seconds from the event loop) on every successful poll/dispatch cycle; the pod's `livenessProbe`/`readinessProbe` uses `exec: ["sh", "-c", "test $(($(date +%s) - $(stat -c %Y /tmp/worker-healthy))) -lt <2×N>"]`. Assess and document, don't hand-wave, at least these alternatives before committing: (a) a tiny stdlib `http.server` thread bound to loopback exposing `/health` inside the same process (adds an HTTP surface to a process that intentionally has none — extra attack surface + dependency for a container-internal-only signal); (b) Temporal SDK-native worker heartbeats (Temporal already tracks worker liveness server-side via task-queue polling — evaluate whether this alone is a sufficient *external* signal Prometheus/Grafana could consume instead of a k8s exec probe, vs. still needing a k8s-native liveness signal for pod restart); (c) Dramatiq's own process-supervision hooks (does Dramatiq expose a liveness hook the `stt-worker` entrypoint isn't yet using). State a recommendation, not just options. | Complex — cross-language design synthesis with real alternatives to weigh, feeding two other tickets' implementation | `sonnet-5` | high |
| 3.2 | Specify the exact `stt-v2-worker.yaml` probe stanza (exec command, `periodSeconds`, `failureThreshold` — note the existing `preStop: sleep 10` at `stt-v2-worker.yaml:44-46` already assumes *some* graceful-drain signal exists; align the heartbeat cadence with the Dramatiq actor `time_limit` and the `terminationGracePeriodSeconds` Appendix G §G1 already recommends (620s) so a probe timeout can't fire mid-job) for 0.6's implementer to apply directly — a ready-to-paste YAML snippet, not just prose. | Moderate | `sonnet-5` | medium |
| 3.3 | Same as 3.2 for `harness-worker.yaml`, sized against Temporal's `graceful_shutdown_timeout_s` (`harness/temporal/worker.py:189-200`) and Appendix G §G1's recommended 150s `terminationGracePeriodSeconds`, for 0.12's implementer. | Moderate | `sonnet-5` | medium |

### Phase 4 — Frontend (Next.js / Vite) health + SIGTERM

| # | Task | Classification | Model | Effort |
|---|---|---|---|---|
| 4.1 | Add a dedicated `src/app/api/health/route.ts` (or `/api/health/live`, `/api/health/ready` split, matching the backend convention) to `apps/admin-console`, distinct from `/login`. Confirmed gap: zero health routes exist today (`grep -rn health apps/admin-console/src/app` only matches an unrelated test fixture and a `<meta description>`); the Docker `HEALTHCHECK` and both k8s probes currently hit `/login` (`admin-console.yaml:52-65`, `apps/admin-console/Dockerfile:85-86`), so a login-page regression and an infra outage are indistinguishable. A route handler is process-liveness-only by default in the standalone runtime; decide in the Phase 1 doc whether readiness should check the BFF's ability to reach `apps/api` (would make it a dependency check, arguably wrong for a *liveness* route per the Phase 1 doctrine — keep that check on a `/ready` variant only, per `13-nextjs-apps.mdc`'s BFF/proxy pattern). | Moderate — new route + a Next.js-specific liveness/readiness split decision | `sonnet-5` | medium |
| 4.2 | Add SIGTERM handling to the Next.js standalone runtime. Confirmed gap: the generated `apps/admin-console/.next/standalone/.../server.js` is stock Next.js boilerplate with no app-level `process.on('SIGTERM', ...)` — `apps/admin-console/Dockerfile:88` runs it directly as PID 1 with no init/signal-forwarding wrapper. Evaluate the standard options rather than picking blind: (a) a `next.config.ts` `output: 'standalone'` post-build script that patches in a signal handler (fragile — touches generated output); (b) wrapping `CMD` with `tini`/`dumb-init` (handles signal forwarding to the Node process cleanly, does not by itself add app-level connection draining); (c) a custom minimal server entry (`server.ts` compiled alongside standalone output) that imports the generated handler and adds its own `process.on('SIGTERM', ...)` → `server.close()` sequence. Recommend one, matching the "only one handler owns the lifecycle" rule from §3 Phase 5 — don't stack a wrapper's signal handling on top of an app-level one without one clearly owning the sequence. | Complex — Next.js 16 standalone-output internals, no existing precedent in this codebase to copy | `sonnet-5`/`opus-4-8` | high |
| 4.3 | Same SIGTERM-ownership question for `apps/compat-playground`'s `serve -s dist -l 3000` (`apps/compat-playground/Dockerfile:66`) — `serve` is a third-party static-file server with no confirmed graceful-shutdown behavior of its own. Decide whether to wrap it with `tini`, replace it with a minimal purpose-built static server the team controls signal handling for, or accept "no in-flight requests" as low-risk given it serves static assets only (unlike admin-console, there are no long-lived connections to drain). Also add a distinct `/healthz.json` static asset (trivial, since there's no backend to add a real route to) so the probe stops conflating "index.html served" with "app healthy." | Moderate | `sonnet-5` | medium |

### Phase 5 — Pod lifecycle standards doc

| # | Task | Classification | Model | Effort |
|---|---|---|---|---|
| 5.1 | Write the lifecycle rules doc (fold into 1.1's companion doc or its own section): **(a)** `terminationGracePeriodSeconds` sizing rule — must exceed `preStop` sleep + the longest realistic in-flight operation for that service (cite `stt-v2-worker`'s Dramatiq `time_limit` vs. tGPS mismatch already flagged in Appendix G §G1 as the canonical counter-example: a 600s actor time limit against a 60s tGPS means SIGKILL lands mid-job). **(b)** `preStop` should migrate from `exec: ["sh","-c","sleep 10"]` (used identically in `api.yaml:34-36`, `stt-v2.yaml:46-48`, `stt-v2-worker.yaml:44-46`) to the native k8s 1.34 `sleep` lifecycle action (`preStop: { sleep: { seconds: 10 } }`) — no shell fork, same effect, cite Appendix G §G7's formula `preStop ≥ readiness periodSeconds × failureThreshold + propagation margin` (settled at 15s there; this ticket does not re-derive that number, only generalizes the rule and the native-action migration). **(c)** the "one SIGTERM handler owns the lifecycle" rule, backed by the two confirmed repro cases in this codebase: `apps/api/src/instrumentation.ts:64-65` (OTel handler racing `GracefulShutdownService` via a 25s force-exit against a 60s tGPS, §2.1) and `apps/stt/src/stt/main.py:267-273` (raw `signal.signal()` competing with uvicorn's lifespan shutdown, §2.3-2) — state the rule as: the runtime's own graceful-shutdown mechanism (NestJS `enableShutdownHooks`, uvicorn's ASGI lifespan, Temporal SDK's `graceful_shutdown_timeout`) is the ONE handler; anything else (OTel flush, cache eviction, connection draining) registers as a callback/cleanup hook INTO that mechanism, never a second top-level signal listener. | Complex — codifies a rule from two real, non-hypothetical production bugs; must be precise enough to be checkable in review | `sonnet-5`/`opus-4-8` | high |

### Phase 6 — Monitoring integration for probe/lifecycle signals

Scoped narrowly to *probe and restart* signals — general metrics-coverage scrape work stays owned by execution-plan **3.6** (§2.7).

| # | Task | Classification | Model | Effort |
|---|---|---|---|---|
| 6.1 | Document the per-service SLI table (already-exposed `/metrics` endpoint: yes for api/stt/smr/guardrail/nlp/harness/tts, no backend for admin-console/compat-playground) and which of those 7 are actually scraped today (3: api-gateway, stt-v2, smr — §2.6). Recommend the specific `scrape_configs` static-target additions needed to close that gap (guardrail:8863, nlp:8864, harness:8866, tts:8865, all `/metrics`) as a concrete, pasteable addition to `observability-config.yaml`, cross-referencing that 3.6 owns landing it — this task produces the spec, not the merged config. | Moderate | `sonnet-5` | medium |
| 6.2 | Flag `kube-state-metrics` as a hard prerequisite for any restart-count or readiness-flap alerting (§2.6 — not deployed today) and scope its addition (a small, well-known Deployment + RBAC + Service, no Operator required) as a dependency this ticket's Phase 6 needs, not an implicit assumption. | Moderate — infra addition with RBAC implications | `sonnet-5` | medium |
| 6.3 | Define the probe-failure alert set once 6.2 lands: `kube_pod_container_status_restarts_total` rate > 0 over a rolling window (per the "harness-worker crash-restarts" and "stt-v2 crash-looping" failure modes already live in the cluster per `live-state-2026-08.md` §B4 — treat those as the motivating real incidents, not hypothetical), `kube_pod_status_ready == 0` sustained beyond `readinessProbe.periodSeconds × failureThreshold`, and a per-service Grafana panel showing probe outcome history (reuse the existing `infrastructure/grafana/dashboards/` convention — one dashboard-per-service, not one mega-dashboard). Note DCGM is already running (§2.6) so a GPU-health panel for stt-v2/stt-v2-worker needs no new exporter, only a panel. | Complex — alert-threshold design against real incident data | `sonnet-5` | high |

### Phase 7 — CI enforcement

| # | Task | Classification | Model | Effort |
|---|---|---|---|---|
| 7.1 | Write a small validator script (Python or Node, run in `hope-v2-deployment`'s CI) that, for every workload manifest under `deployment/k8s/base/*.yaml`, extracts each probe's `httpGet.path`/`port` (or notes an `exec` probe and skips path validation) and cross-checks it against a per-service route manifest — either a maintained allow-list (`{service: {port, live_path, ready_path}}`, hand-updated alongside the Phase 1 contract) or, more robustly, a live check against each service's `/openapi.json` (FastAPI) / Nest's Swagger JSON (`apps/api` exposes `/api/v1/docs` in non-production) fetched during a CI job that spins the service up. Fail the pipeline if `readinessProbe.path == livenessProbe.path == startupProbe.path` for any service that has a genuine `/ready` implementation (the exact bug class in §2.1/§2.2) — this is a structural, mechanical check, not a judgment call. Land this as an addition to execution-plan **0.8**'s CI-authoring scope if 0.8 hasn't shipped yet, or as a standalone follow-up job otherwise (§2.7) — do not duplicate 0.8's `kubeconform`/`kustomize build` schema validation. | Complex — new CI capability, needs to run against live services or a maintained route registry, and must not produce false positives for services (like guardrail pre-2.1-fix, or nlp by design) with legitimately weak/absent readiness checks | `sonnet-5`/`opus-4-8` | high |

## 4. Verification Criteria

- [ ] Phase 1 doc exists, is cross-linked from `CLAUDE.md`'s rule index or `docs/development-patterns-and-standards.md`, and every one of the 11 services' actual health behavior (§2.2 matrix) is classified against it as compliant/non-compliant with a stated reason.
- [ ] Guardrail's `/health/ready` returns a real 503 on Redis failure, proven by a passing unit test (Phase 2.1) — paste the test output.
- [ ] STT's SIGTERM investigation (Phase 2.2) has a documented conclusion (pre-empts uvicorn or doesn't) backed by an actual signal-delivery test against a running process, not just static analysis.
- [ ] Worker health-approach doc (Phase 3.1) is referenced by name from execution-plan tasks 0.6 and 0.12 once they pick it up (cross-link both directions).
- [ ] admin-console and compat-playground each have a dedicated health route/asset distinct from a real page (Phase 4.1/4.3), and a stated, justified SIGTERM-ownership decision (Phase 4.2/4.3) — not silence.
- [ ] Lifecycle doc (Phase 5.1) states the tGPS-sizing rule, the native `preStop.sleep` migration, and the one-handler rule, each backed by a cited example already in this codebase (not hypothetical).
- [ ] Phase 6's SLI/scrape-gap table and probe-failure alert set exist as a spec; `kube-state-metrics` prerequisite is explicitly flagged, not silently assumed.
- [ ] Phase 7's CI validator runs against at least one intentionally-broken manifest (readiness path == liveness path for a service with a real `/ready`) and fails; runs against a correct manifest (e.g. `harness.yaml`, already correct per §2.2) and passes.
- [ ] Ticket README updated through the lifecycle per `01-development-workflow.md` (status transitions, Implementation Summary, Change History) — no separate per-fix files.

## 5. Open Questions

1. **Does TASK-627 also execute 0.0/0.15/0.6/0.7/0.8/0.12, or only produce the standard those tasks consume?** Scoped in this doc as "produce the standard + fix the code-level bugs the standard itself requires (Phase 2)," leaving manifest-only repointing to TASK-616's already-prioritized tasks. Confirm this split before Phase 3 starts, since 0.6/0.12 are currently unblocked and could proceed in parallel with Phase 3's design work rather than waiting on it.
2. **Worker health MVP (heartbeat file + exec probe) vs. a lightweight loopback HTTP server** — Phase 3.1 recommends the heartbeat approach but this is a real architectural choice with security-surface tradeoffs (a loopback-only HTTP server is not automatically a bigger risk than a file-mtime exec probe; both are container-internal). Needs an explicit decision, not a default.
3. **Where does the `kube-state-metrics` deployment live?** `infrastructure/docker/` (local dev) has no k3s equivalent to add it to directly — it's a `hope-v2-deployment`-repo addition (Phase 6.2), which sits outside this monorepo's CI/lint gates entirely. Confirm ownership/reviewer for changes to that sibling repo before scoping Phase 6 further.
4. **CI validator's route-registry approach (Phase 7.1)**: static allow-list (simple, can drift) vs. live OpenAPI-spec fetch during CI (accurate, but requires spinning up every service in CI, which `hope-v2-deployment` does not currently do for any validation — 0.8 is `kustomize build` + `kubeconform`, both static). A static allow-list co-maintained with the Phase 1 contract doc is likely the pragmatic MVP; revisit if service health contracts start drifting from it in practice.
5. **Does guardrail's mount-at-two-prefixes pattern** (`/api/health*` AND `/api/v1/health*`, both resolving to the same handlers — `guardrail/main.py:239-243`) belong in the Phase 1 contract as a sanctioned exception, or should guardrail be migrated to `/api/v1` only (breaking the legacy `/api/health` callers)? Out of scope to decide here; flag for the Phase 1 doc author.

## 6. Change History

- 2026-08-07 — Ticket created. Scope, current-state audit (§2), and implementation plan (§3) written against direct code/manifest verification; explicit non-overlap mapping against TASK-616 execution-plan.md established (§2.7).
