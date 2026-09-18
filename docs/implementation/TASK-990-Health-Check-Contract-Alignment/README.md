# TASK-990 — Health-Check Contract Alignment (apps, services, probes, Argo)

| Field | Value |
|---|---|
| Status | In Progress |
| Type | bugfix + infrastructure |
| Branch | `dev-2.2` (hope-v2) · `main` (hope-v2-deployment) |
| Opened | 2026-09-18 |
| Repos | `arca/hope-v2`, `arca/hope-v2-deployment` |

## Requirement Analysis

Review every app and service for a correct health-check API and confirm the k8s probes and
Argo CD health assessment agree with it. Fix what diverges.

## Current State Evaluation (audited 2026-09-18 against dev-2.2 + the live `hope-v2-dev` namespace)

**Every probe path in every manifest resolves to a route that exists.** No 404ing probes. The
fleet is not broken; it is inconsistent, and three of those inconsistencies are live defects.

### Live defects

| id | Finding | Evidence |
|---|---|---|
| F1 | **STT readiness+liveness point at `/api/v1/health`, which can never fail.** `health_check()` computes `overall_status` into the JSON body and returns a plain dict — FastAPI serialises that 200 unconditionally. A dead Postgres/MinIO/Redis answers `{"status":"unhealthy"}` with HTTP 200. Both probes degrade to "something is listening on 8861". | `apps/stt/src/stt/health/api/routes.py:45-100`; `base/stt.yaml:320-335` |
| F2 | **STT's graceful drain is dead code.** `/health/ready` implements `mgr.is_draining` and its docstring calls it "the ACTUAL mechanism by which a draining pod stops receiving new streaming sessions". The readinessProbe does not point there, so the kubelet never consults it. A draining STT pod keeps taking new streaming sessions until `preStop: sleep 10` expires. | `routes.py:109-135`; `base/stt.yaml:320-327` |
| F3 | **`hope-vault` has readiness but no liveness and no startup probe.** A wedged Vault is never restarted, and it is sync-wave 0 — the fleet's secrets path. `hope-temporal` and `hope-temporal-ui` likewise have no liveness. | `base/vault.yaml:252-257`; `base/temporal.yaml:100-109,170-175` |
| F4 | **GPU startup budgets exceed the default progress deadline.** `progressDeadlineSeconds` is set nowhere, so every Deployment uses the 600s default. STT's startupProbe allows 180x5s = **900s**; LM Studio's allows 90x10s = **900s**. A legitimate cold start trips `ProgressDeadlineExceeded`, the exact condition Argo reads to mark a Deployment Degraded. | `base/stt.yaml:313-319`, `base/lmstudio.yaml:222-229`; no `progressDeadlineSeconds` in the repo |
| F5 | **TTS readiness lies about model load.** `KokoroProvider.health()` returns `True` unconditionally with no check that the pipeline loaded, and `TTS_WARMUP_ENABLED` defaults to `False`. Pods go Ready before weights are resident. | `apps/tts/src/tts/providers/kokoro.py:311-312`; `core/config.py:309` |

### Contract gaps

| id | Finding |
|---|---|
| F6 | **No Python service reports its build identity.** All six call `BuildInfoReader` at boot to self-register with the gateway, then report a hardcoded literal in `/health`: text `"2.0.0"`, stt `"2.0.0"`, guardrail `"1.0.0"`, nlp/harness/tts `"0.1.0"` — while the image's `/app/build-info.json` carries the real `0.0.0-dev-2-2.<sha>`. This is the TASK-648 defect, fixed in the gateway (`apps/api/.../health.controller.ts:143`) and never mirrored. During a rollout you cannot tell which build answered. |
| F7 | **`/health/startup` exists only on the gateway.** The six Python services have a three-route contract (`/health`, `/health/live`, `/health/ready`). The auth middleware renders the missing route as 401 rather than 404. |
| F8 | **admin-console has no health endpoint.** Both k8s probes and the Dockerfile `HEALTHCHECK` hit `/login` — proves Next.js renders a public page, nothing about the BFF reaching the gateway. No startup probe either. |
| F9 | **Guardrail's `/health` returns 200 even when Redis is unhealthy** — only a `"degraded"` string in the body. Its probes correctly use `/health/ready`, so this is a trap, not a live fault. |
| F10 | **stt-worker readiness probes `/` on port 9191**, the Dramatiq Prometheus exporter — proves the exporter is up, not that the worker consumes its queue. `harness-worker` does this properly with a 15s heartbeat file + `find -mmin -1`. stt-worker's startup budget is 5 min vs the stt service's 15 min for the same GPU model load. |
| F11 | **stt-worker's Dockerfile `HEALTHCHECK` can never pass** — the `worker` stage inherits `ml-runtime`'s check against `localhost:8861`, a port Dramatiq never binds. `apps/harness/Dockerfile:183` does this correctly with `HEALTHCHECK NONE`. |
| F12 | **All 14 PDBs are `minAvailable: 0`** — they permit full disruption. Evaluate, don't blindly change: with `replicas: 1`, `minAvailable: 1` blocks node drains entirely. |
| F13 | **Dead duplicate health controller** — `packages/applications/src/services/baseServices/health/health.controller.ts` declares `@Controller('health')` with `/liveness` + `/readiness` and no `@Public()`. Exported from the barrel, registered by no module. |
| F14 | **No CI gate validates probes** in either repo — not presence, not paths. Every path currently resolves; a renderer-based assertion would lock that in. |
| F15 | **`promote-dev` has no feedback loop** — resolves the digest, commits, pipeline goes green. No wait-for-sync, no rollout verification. The in-cluster `hope-smoke-test` PostSync hook is the only gate and CI never learns its result. `environment: name: dev` carries no `url:`. |
| F16 | **The only `smoke` job in hope-v2 CI targets the retired external PgBouncer** (rule 09: "There is no pooler on this deployment"). Dormant behind `SMOKE_PGBOUNCER`. |
| F17 | **Doc/manifest mismatch** — the deployment README says dev runs `prune: false`; `application-dev.yaml:43` and the live Application both say `prune: true`. |

### Not defects (verified, recorded so they are not "fixed" later)

- `apps/api` is the reference implementation: four `@Public()` routes, `@SkipThrottle()` on the three
  kubelet probes (after a documented incident where the shared throttle bucket let anonymous traffic
  evict the pod from its Service), readiness wired to `GracefulShutdownService` so it flips on drain,
  `version` from `/app/build-info.json`.
- `hope-smoke-test` is a real gate: a `PostSync` hook curling nine readiness endpoints, failing the
  sync on any non-2xx. Observed passing 9/9.
- `db-migrate` / `mlflow-migrate` are deliberately de-hooked in `overlays/dev` so a failing migration
  cannot wedge the Application.
- guardrail's `/api/health/*` (no `/v1/`) is intentional — it dual-mounts both prefixes.
- nlp's startupProbe targeting the bare `/api/v1/health` is a deliberate "heaviest handler" gate.
- The `s3fs` native sidecars deliberately carry no probes; the gate is the `await-models-bucket` init container.
- `apps/smr/` is a ghost directory (stale `__pycache__`, no source, absent from `uv.lock`) — not a service.

### Out of scope (owner decisions, recorded not actioned)

- **All 13 HPAs are inert** — `FailedGetResourceMetric` on every one, `top pod` reports `0m` CPU
  fleet-wide: `metrics.k8s.io` is registered but serving nothing. Fixing it means installing/repairing
  metrics-server, a cluster-addon decision. Argo reports the Application Healthy regardless.
- Whether a real PDB (F12) is wanted on single-replica dev workloads.

## Implementation Plan — lanes

One writer per worktree; the orchestrator owns merges, pushes and cluster verification.

| Lane | Repo / branch | Owns (files) | Findings | Tier |
|---|---|---|---|---|
| **DEPLOY** | hope-v2-deployment `task-990/probe-alignment` | `deployment/k8s/base/{stt,vault,temporal}.yaml`, all Deployments for `progressDeadlineSeconds`, `README.md`, new CI probe gate | F1, F3, F4, F14(dep), F17, F12(evaluate) | opus / high |
| **PY-HEALTH** | hope-v2 `task-990/py-health` | the six services' `health` route modules + their auth-middleware `EXEMPT_PATHS`, `apps/tts/.../providers/kokoro.py`, new `tests/contracts/` parity test | F5, F6, F7, F9 | opus / high |
| **WORKER** | hope-v2 `task-990/worker-health` | `apps/stt/src/stt/worker.py`, `apps/stt/docker/Dockerfile` ONLY | F10(app half), F11 | opus / medium |
| **ADMIN** | hope-v2 `task-990/admin-health` | `apps/admin-console/src/app/api/health/**`, `src/proxy.ts`, its tests, its `Dockerfile` | F8 | sonnet / medium |
| **orchestrator, inline** | hope-v2 `dev-2.2` | delete F13 dead controller; remove F16 dead CI job | F13, F16 | — |

Sequencing: DEPLOY is independent and lands first (F1/F3/F4 are live defects needing no code).
PY-HEALTH / WORKER / ADMIN land in hope-v2, then a second DEPLOY pass repoints the admin-console
and stt-worker probes at the new endpoints once their images exist. F15 lands last and needs an
Argo API token (owner item).

## Verification Criteria

- `kustomize build deployment/k8s/overlays/dev` renders; the new probe CI gate passes.
- Per-service Python gates green (`pnpm <svc>:test`, `<svc>:lint`, `<svc>:typecheck`).
- `pnpm --filter @arcaai/admin-console build lint test` green (with `CI=true`).
- Pushed; GitLab pipeline green; `promote-dev` commits digests; Argo syncs to `Synced/Healthy`.
- Live re-probe: STT `/health/ready` returns 503 when draining; every Python `/health` reports the
  build-info version matching its image's `/app/build-info.json`.

## Implementation Summary

_(filled in as lanes land)_

## Change History

| Date | Change |
|---|---|
| 2026-09-18 | Ticket opened. Audit of all apps/services + k8s probes + Argo recorded; 17 findings, 5 live defects. |
