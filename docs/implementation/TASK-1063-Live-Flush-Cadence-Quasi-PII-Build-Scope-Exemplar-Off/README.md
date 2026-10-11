# TASK-1063 — Live flush cadence, quasi-PII record-only, build-time scope, exemplar capture off

| Field | Value |
|---|---|
| Status | In Progress — owner "go with recommendations" 2026-10-11 |
| Type | bugfix |
| Branch | dev-2.2 (lanes in worktrees) |
| Source | [TASK-1062](../TASK-1062-Live-Lane-Admission-Exemplar-Structure-And-Guardrail-Followups/README.md) AC4 acceptance |
| Opened | 2026-10-11 |

## Owner decisions (2026-10-11, recommendations accepted)

| # | Problem (AC4) | Decision |
|---|---|---|
| 1a | At stop, every consultation's live flush hits the 2-slot live lane at once; 2 of 3 wait ~31 s then 503 | **Skip the live flush on stop** — finalization runs right after stop and supersedes it; live flushes compete only while recording |
| 1b | No live flush fires during a 35 s recording | Find the first-flush threshold (transcript length / interval); if it exceeds ~20 s of speech, lower the **default** so the first flush fires by ~20 s of transcript |
| 1c | (held in reserve) | 3 live slots only if 1a+1b are not enough |
| 2 | `pii_leak:api_key` still a clinician banner (quasi downgrade is block → warn) | For a **local** provider, a pii_leak flag whose labels are ALL quasi-identifiers is **record-only (`ignore`)**; cloud keeps warn |
| 3 | Global `casenote-finalization` publish refused by build-time medical_scope (instruction + output-language template judged together) | Build-time medical_scope judges **only the authored instruction text** of the unit — not platform/template pieces (output-language policy, document headings). Then republish Global v2 + promote to SYSTEM |
| 4 | Exemplar capture fail-closed heuristic drops every note | **Capture off**: platform setting `gateEdit.exemplarCapture.enabled` (global-kv, default `false`); no rows written while off |
| 5 | `pii_leak` engine timeout 20 s under ×3 → "could not run" banner; prompt_safety warns unattributable | Raise / retry the pii_leak extraction under load (bounded); record **per-region verdicts** (`flaggedRegions`) on every guardrail evaluation check |

## Lanes (file-disjoint, parallel)

| Lane | Tier | Owns | Work |
|---|---|---|---|
| LV live | opus | `consultation/live-documentation/**`, `settings-registry/descriptors/consultation-realtime.descriptors.ts` | 1a, 1b |
| GD guardrail | opus | guardrail `services/screening.py`, `services/pii_extraction.py` (or the pii_leak engine client), `services/evaluation_outbox.py`/evaluation record builder, `core/policy.py` (timeouts only) + tests; `packages/types` evaluation record type if the field must be declared | 2, 5 |
| BS build scope | sonnet | `services/governed-prompt/**` | 3 (code) |
| EX exemplar off | sonnet | `services/gate-edit-mining/**`, a new descriptor file under `settings-registry/descriptors/` | 4 |

Orchestrator: gate once after merge; push/deploy with owner OK; republish Global `casenote-finalization` (draft v2 `01a12915-3c2c…`) and promote; acceptance (×3 + single, banner counts, live snapshot during recording).

## Implementation Summary
_(in progress)_

## Change History
- 2026-10-11 — opened from TASK-1062 AC4; owner accepted the recommendations; go.
