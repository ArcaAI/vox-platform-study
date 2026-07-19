# TASK-510 — Ordered Session Trajectory

| Field | Value |
|---|---|
| **Status** | Completed (eng) — S2 + prune scheduler landed; ResourceType / NITs / eval still open |
| **Type** | feature |
| **Parent** | [TASK-508 Agentic SOTA Program](../TASK-508-Agentic-SOTA-Program/README.md) — Phase 2 (owner ask 2) |
| **Depends on** | TASK-509 (AD-1 `GenerationStats` on `LLM_CALL`) |
| **Unblocks** | TASK-512 AI Operations Runs / Metrics screens |

---

## 1. Requirement Analysis

Every AI working session (live-doc, harness run, summary job, eval run) produces an
**ordered, queryable, streamable** step record:

`LLM_CALL | TOOL_CALL | SENSOR | RETRIEVAL | GUARDRAIL | THINKING | SIGNAL | GATE | PHASE`

Stats-first / payload-by-reference (PHI): `stats` holds AD-1 on `LLM_CALL`;
`payloadRef` holds claim-check/encrypted pointers only — never plaintext clinical content
on the read plane. Admin list/read + SSE for live view; Prometheus + Grafana for fleet.

Authoritative spec: program README §AD-2 + Phase 2 (2A–2D).

---

## 2. Current State Evaluation (at ticket open)

Harness had a 5-stage progress feed, WORM audit (wrong tool for high-volume telemetry),
and structlog — but **no ordered per-step record**, no admin history API, no step timings
correlated to stats, no live SSE for the full spine.

---

## 3. Implementation Plan (executed, TDD)

1. **2A** — Prisma model + migration + tenant/soft-delete allow-lists + hand-authored domain trio.
2. **2B** — Applications service: `recordSteps` (idempotent), `listSessions`, `listSteps` (keyset), Redis republish, `pruneOlderThan`.
3. **2C** — Emitters: harness activities + workflow seq; live-doc flush spine; summary jobs.
4. **2D** — Admin GETs + consultation SSE; harness Prometheus + Grafana dashboard.
5. Cross-agent seam review (W2) → fix B1/S1 blockers before calling integration-sound.

---

## 4. Implementation Summary

### Schema (`agent-trajectory.prisma`)

**Enums**

| Enum | Values |
|---|---|
| `AgentSessionKind` | `LIVE_DOC`, `HARNESS_DOC`, `SUMMARY_JOB`, `EVAL_RUN` |
| `AgentStepType` | `LLM_CALL`, `TOOL_CALL`, `SENSOR`, `RETRIEVAL`, `GUARDRAIL`, `THINKING`, `SIGNAL`, `GATE`, `PHASE` |
| `AgentStepStatus` | `STARTED`, `OK`, `ERROR`, `SKIPPED`, `TIMEOUT` |

**Model highlights**

- Unique `(tenantId, sessionId, runId, seq)` — `runId` is non-null `""` sentinel (not `String?`) so Postgres unique idempotency works for non-Temporal sessions.
- No `resourceStatus` — listed in `MODELS_WITHOUT_SOFT_DELETE`; hard retention via prune.
- Tenant-scoped; no sys-events on write (telemetry exemption).

Migration: `20260719010000_task_510_agent_trajectory_step`.

### Applications

- `packages/applications/src/services/agent-trajectory/` — service, DTOs, mapper (**strips `payloadRef` on read**), module.
- Redis channel: `consultation:trajectory:{consultationId}`.

### API

| Route | Auth / notes |
|---|---|
| `GET admin/agent-trajectory/sessions` | `@CanManage('HarnessPolicy')` (dedicated `AgentTrajectory` ResourceType deferred) |
| `GET admin/agent-trajectory/sessions/:sessionId/steps` | Keyset cursor; 404-over-403 |
| `POST /api/v1/internal/harness/trajectory` | Service-token; 202; floors fractional `durationMs` |
| `GET consultations/:id/trajectory/stream` | Ticket-scoped SSE |

### Emitters

| Emitter | Behavior |
|---|---|
| Harness | Deterministic `self._seq`; activities emit via `ApiClient.report_trajectory`; THINKING when SMR returns reasoning; fire-and-forget |
| Live-doc | Per flush: `LLM_CALL:flush` → `TOOL_CALL:nlp.classify-tokens` → optional `GUARDRAIL:groundedness` → `PHASE:publish`; stable `trajectorySessionId` |
| Summary | One `SUMMARY_JOB` / `LLM_CALL` per generate / pre-summary |
| Eval `--trajectory` | **Deferred** (plan OK) |

### Observability

- `apps/harness/src/harness/core/metrics.py` — `harness_step_duration_seconds`, `harness_regen_total`, `harness_gate_decision_total`
- Grafana: `infrastructure/grafana/dashboards/agentic-trajectory.json`

---

## 5. Seam-review fixes (W2)

| ID | Problem | Fix |
|---|---|---|
| **B1** (blocker) | Harness emitted fractional `durationMs`; API `@IsInt` + column `Int?` → every real batch 400'd → **0% harness trajectory persisted** | Harness `round` to int; API `@IsNumber()` + `Math.floor` |
| **S1** | Live-doc seq reset on restart → composite-unique collision / silent drop | Stable `trajectorySessionId = ${consultationId}:${startedAt}` |

Regression tests: harness `test_trajectory.py`, api `harness-internal.controller.test.ts`, applications `live-documentation.trajectory.test.ts`.

---

## 6. Verification Evidence

| Suite | File / focus |
|---|---|
| Domains | `AgentTrajectoryStepRepository.test.ts` — ordered by seq, tenant scope |
| Applications | `agent-trajectory.service.test.ts` — idempotency, Redis, prune, keyset; live-doc + summary trajectory suites |
| API | `agent-trajectory.controller.test.ts`, `consultation.controller.trajectory.test.ts`, ingest duration floor |
| Harness | `test_trajectory.py` — ordered spine, metrics, outage never fails workflow, `duration_ms` int |
| E2E probe | `apps/api/tests/e2e/task-510-trajectory-admin.spec.ts` (Phase 7 — not executed this run) |

Gate counts at land / seam-fix time: see program [TRACKER](../TASK-508-Agentic-SOTA-Program/TRACKER.md) (applications ~6333, api ~2270, harness targeted green).

---

## 7. Deviations & deferred items

| Item | Status |
|---|---|
| `@CanManage('AgentTrajectory')` | Uses `HarnessPolicy` family — dedicated ResourceType deferred |
| Nightly prune + `agentic.trajectory.retentionDays` | **Done** — `AgentTrajectoryRetentionService` (cron via SchedulerRegistry + AppSettings; mirrors audit-retention). Opt-in; see keys below. |
| Eval `--trajectory` | Deferred OK |
| **S2** | **Done** — `AgentTrajectoryStepRepository.listSessionSummaries` Prisma `groupBy`; `listSessions` no longer full-scans steps |
| **NITs** | Partial-redelivery SSE double-render; metric re-increment on Temporal retries; groundedness verdict only in write-only `payloadRef`; `engine_native` on read/SSE |
| Dedicated README | Was missing — this doc |

### Retention scheduler AppSettings keys

| Key | Default | Notes |
|---|---|---|
| `agentic.trajectory.enabled` | `false` | Hard-delete safety — must opt in |
| `agentic.trajectory.cron` | `0 4 * * *` | Daily 04:00 (cron) |
| `agentic.trajectory.retentionDays` | `30` | Non-positive window refuses purge |

Wired in API via `AgentTrajectoryRetentionServiceModule` (next to `AuditRetentionServiceModule`). Tick calls `AgentTrajectoryService.pruneOlderThan`.

---

## 8. Change History

| Date | Change |
|---|---|
| 2026-07-19 | Phase 2A–2D implemented (W2). Tracker marked Completed. |
| 2026-07-19 | W2 seam review: B1 + S1 fixed; S2/NITs deferred to owner. |
| 2026-07-19 | **Retrospective README** authored (was missing). Documents prune-job gap, S2, permission ResourceType deferral. |
| 2026-07-19 | **S2 + prune scheduler:** DB `listSessionSummaries` groupBy; `AgentTrajectoryRetentionService` (enabled default false, retentionDays 30, cron `0 4 * * *`). |
