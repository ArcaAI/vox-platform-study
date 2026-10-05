# TASK-1045 — wave 4 (routes, composer, executor, console, legacy sweep) ownership

Base: `dev-2.2` at the wave-3 integration commit (`ebf0ed464`) + the NotePlan fixture (`88c29844c`). The applications package and `apps/api` type-check clean; `@arcaai/applications` dist in the primary is current (api lanes consume it through the symlinked `node_modules`). LANE-RULES.md applies unchanged — no gating tests, own files only, hand-overs for everything else.

## Pinned contracts

| File | Contents |
|---|---|
| `tests/contracts/note-plan.fixture.json` | NotePlan v1 + CoverageResult v1 wire shape, block order, labels, delivery route. TS composer and Python executor both parse every case. Changing it is an orchestrator decision. |
| P-AB §1.4 / §1.5 | business routes, DTOs, header projection, lifecycle events, WS control |
| P-CG §1.3 | attachment + feedback routes |
| P-D §1 | history read plane routes |
| P-E §1b–§1f + "Final revision" | composer, budget, coverage, settings (fixture wins where they differ) |

## Ownership (one writer per file)

| Lane | Agent / tier | Owns |
|---|---|---|
| AB-6 API | hope-lane-deep / opus | `apps/api/src/modules/consultation/{consultation.controller.ts, admin-consultation.controller.ts, dto/*}` (NOT `consultation.module.ts`), `apps/api/src/modules/internal/stt-internal.controller.ts` (+ dto), a NEW lifecycle-vocabulary interceptor file under `apps/api/src/modules/consultation/`, NEW `consultation-lifecycle-events.controller.ts` (SSE) if split out; test `apps/api/src/modules/consultation/__tests__/consultation.controller.lifecycle.task1045.test.ts`; authors (not run) `apps/api/tests/e2e/consultation-lifecycle-task1045.spec.ts` |
| CG-API | hope-lane / sonnet | NEW `apps/api/src/modules/consultation/{consultation-attachment.controller.ts, consultation-feedback.controller.ts, admin-feedback-rollup.controller.ts, consultation-access.helper.ts}`; tests `__tests__/consultation-attachment.controller.task1045.test.ts`, `__tests__/consultation-feedback.controller.task1045.test.ts`; authors (not run) `apps/api/tests/e2e/consultation-attachments-feedback-cross-tenant.spec.ts` |
| D2 history API | hope-lane / sonnet | NEW `apps/api/src/modules/consultation-history/*`; test `apps/api/src/modules/consultation-history/__tests__/consultation-history.controllers.task1045.test.ts`; authors (not run) `apps/api/tests/e2e/consultation-history-cross-tenant.spec.ts` |
| E3 composer | hope-lane-deep / opus high | NEW `packages/applications/src/services/consultation/note-composition/*`, NEW `settings-registry/descriptors/consultation-note-composition.descriptors.ts`; M `consultation/harness/harness-internal.service.ts`, `harness/dto/harness-internal.dto.ts`, `harness/prior-visit-summary.ts`, `harness/same-day-prequel.ts`, `prompt/prompt-assembly.service.ts`, `consultation/summary/chain-summary.service.ts` (H-89 only), `apps/api/src/modules/consultation/harness-internal.controller.ts`; NEW `tests/contracts/note-plan-parity.contract.test.ts` |
| E5 harness executor | hope-lane-deep / opus high | NEW `apps/harness/src/harness/services/note_plan/*`; M `apps/harness/src/harness/temporal/{activities.py, models.py, workflows.py, worker.py}`, `temporal/interpreter/nodes/core.py`, `services/api_client.py`; tests `apps/harness/src/harness/tests/unit/note_plan/test_{executor,coverage,fixture_parity}_task1045.py` |
| D4b console screen | hope-lane / sonnet | NEW `apps/admin-console/src/app/(console)/(tenant)/consultations/[id]/{page,loading,error}.tsx`, NEW `apps/admin-console/src/features/consultations/components/activity/*`; M `features/consultations/components/{consultations-screen.tsx, consultation-detail-panel.tsx}`; test `features/consultations/components/__tests__/consultation-activity-screen.task1045.test.tsx` |
| AB-8c legacy sweep (domains + database) | hope-lane / sonnet | existing tests only: `packages/domains/**/__tests__/{clinical-harness-phase1-domain,ConsultationEntity.transitions,consultationStatus.wired,ConsultationRepository.findTimeoutSweepEligible}.test.ts`, `packages/database/src/__tests__/{clinical-harness-phase1-schema,attestation-gate-persistence}.postgres.test.ts` (H-12); M `ContextItemVersionEntity.ts` typed `metaData` accessor (H-80) |
| AB-8a legacy sweep (applications) | hope-lane-deep / opus | launched after the diagnostic run lists the failing files; owns those existing test files + H-50/51/69/87 + H-78 (lifecycle `stop` SET NX claim + `recordingOffsetMs` stamp in `consultation-lifecycle.service.ts`) |
| F0b protocol pausedTotalMs (ALaaS) | hope-lane / sonnet | ALaaS `S/src/consultation/protocol.ts` + generated web protocol + fixtures, `consultation-broker.service.ts` (fill `pausedTotalMs` only) — H-30 |

Orchestrator-only in this wave: `apps/api/src/modules/consultation/consultation.module.ts`, `apps/api/src/app.module.ts`, every barrel, `registry.ts`, `docs/operations/deprecation-register.md` rows (lanes send rows; D8 writes them in wave 5), generated artifacts (R in wave 5).

## Sequencing after this wave

- Wave 5: E6 (after E3: `harness-internal.service.ts` + `live-documentation.service.ts`), E8 (after E3 + E5), AB-8b (apps/api legacy tests after AB-6), D8 docs/changeset (after AB-6 rows), R artifacts (after every API lane), ALaaS U8 (after U3), FD1 ALaaS docs.
- After the HOPE gate: F8 (vox-node 5.x adapter; the orchestrator bumps the dependency and lockfile).
