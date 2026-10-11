# TASK-1061 — Cross-patient exemplar leak (N-1) and guardrail false positives (N-3)

| Field | Value |
|---|---|
| Status | Review — deployed 2026-10-11; acceptance passed for N-1; R-1..R-9 follow-ups |
| Type | bugfix (clinical safety) |
| Branch | dev-2.2 |
| Source | [TASK-1059 acceptance](../TASK-1059-Realtime-Path-And-Guardrail-Fixes-From-1058-E2E/README.md) §"Open after acceptance" N-1, N-3 |
| Opened | 2026-10-11 |

## Requirement Analysis

1. **N-1 (blocker, clinical safety).** A brand-new patient's pre-summary and live note contained
   another patient's facts ("metformin increased to 1000 mg", "amlodipine 5 mg started", "review in
   four weeks"). Nothing about one patient may ever appear in another patient's document.
2. **N-3 (major).** Guardrail false positives on legitimate clinical traffic:
   - outbound `jailbreak_detection` BLOCKED benign clinical workflow output in 2 of 3 runs (run FAILED,
     `GUARDRAIL_BLOCKED`, notice not resumable);
   - inbound `jailbreak_detection` flagged clinical live-lane prompts (8 record-only blocks in one window);
   - outbound `response_safety:unsafe` warning on 5 of 5 final notes, inbound `prompt_toxicity:privacy_violation`
     on clinical prompts — each shown to the clinician as a warning banner.

## Current State Evaluation

### N-1 — how another patient's note reaches the prompt
- `PromptAssemblyService` (`packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts:637-650`)
  builds `fewShot = buildFewShotExemplars(params)` for EVERY non-`noteInputs` prompt (pre-summary, live lane,
  legacy summary) and places it in the STYLE REFERENCE data block, first, for prefix caching.
- `styleReferenceContent` (`style-reference.ts:33`) labels it
  `--- APPROVED NOTES FROM DIFFERENT PATIENTS (set …) ---` — the doctor's approved notes for OTHER patients,
  full clinical content, with only partial redaction ("father [REDACTED] at 52").
- Evidence: composed prompt `01a1267d-d396` (agent `general-medicine-summarization`) and PRE_SUMMARY items
  `01a1267e-515b`, `01a1267e-72f7` on consultation `01a1267d-937c-72ea-a2bd-de1f41247943` (TASK-1059 AC1).
  The 2B model copied facts from the exemplar despite the label.
- The note-input composer path (`noteInputs`, finalization) does NOT include exemplars — the final note was clean.

### N-3 — why clinical text trips the classifiers
- `OUTBOUND_TASKS` includes `jailbreak_detection` (`apps/guardrail/src/guardrail/services/screening.py:153`,
  TASK-878/G1). Since the TASK-1050 seed it is routed to **Llama Prompt Guard 2 86M** — an injection classifier
  for untrusted INPUT. Run on a model's own clinical note it produces MALICIOUS/high false positives.
- TASK-1050 follow-up B retired `outboundRecordOnlyChecks` (`core/policy.py:417`): outbound checks now act on
  the platform `action` (block/warn/ignore), so an outbound jailbreak flag now BLOCKS.
- TASK-1049 measured PG2-86M against the bar (OD-13) and found no classifier meeting it; FC-5b stayed record-only
  for data regions — inbound instruction regions still act.
- `response_safety` / `prompt_toxicity` (GLiGuard) flag clinical content (doses, sensitive history) as
  unsafe / privacy_violation.

## Implementation Plan

### N-1 — proposed fix (decisions below)
- Exemplars are a WRITING-STYLE aid for the **final note** only. Remove them from pre-summary and live-lane
  prompts (and the legacy summary path) — `buildFewShotExemplars` called only where the finalizer asks for it.
- Defence in depth (OD-2): exemplars carry structure, never content — headings and phrasing only (redact every
  clinical value, or replace with a structure-only skeleton), so even the finalizer cannot copy facts.
- Regression guard: a test that composes a pre-summary and a live prompt for patient B with an approved note of
  patient A in the exemplar store, and asserts no exemplar text reaches the prompt; and a content test that
  A's distinctive facts never appear in B's composed prompt.
- Data clean-up: the affected E2E PRE_SUMMARY items are synthetic test data; no real patient is involved on dev.
  Check whether any non-E2E consultation on any environment carries an exemplar-derived pre-summary (OD-3).

### N-3 — proposed fix (decisions below)
- Outbound `jailbreak_detection`: stop running an INPUT injection classifier on model OUTPUT (OD-4).
- Inbound `jailbreak_detection` on gateway-composed clinical prompts: data regions stay record-only (FC-5b);
  decide whether instruction regions composed by the PLATFORM (governed prompts) are screened at runtime at all —
  they are already screened at save time (OD-5).
- `response_safety` / `prompt_toxicity` on clinical text: warn noise on every note (OD-5).
- Measure before/after on a fixed clinical corpus (the TASK-1049 bench set + the TASK-1058/1059 notes):
  false-positive rate per check, per direction.

### Lanes (on go)
| Lane | Tier | Owns | Work |
|---|---|---|---|
| X exemplars | opus | `consultation/prompt/prompt-assembly.service.ts`, `style-reference.ts`, few-shot exemplar service | N-1 per OD-1/OD-2 + regression tests |
| G guardrail | opus | guardrail `services/screening.py`, `core/policy.py`, `core/availability.py`, seed policy rows | N-3 per OD-4/OD-5 + tests |
| A audit | sonnet | read-only (cluster SQL SELECT + Loki) | OD-3: find PRE_SUMMARY / live snapshot items with exemplar-derived content; report only |

Then: orchestrator gate once, deploy with owner OK, cluster re-run of TASK-1059 AC1 (×3) and AC2 workflow runs.

## Owner decisions

| OD | Question | Proposed default |
|---|---|---|
| OD-1 | Where may approved-note exemplars appear? | **Final-note finalizer only** — never pre-summary, live lane, or legacy summary |
| OD-2 | What may an exemplar contain? | **Structure only**: headings, section order, sentence shapes; every clinical value, drug, dose, date, number and name replaced by a typed placeholder (`<DRUG>`, `<DOSE>`, `<VALUE>`) before it is stored or used |
| OD-3 | Clean-up | Audit PRE_SUMMARY / live snapshot items on dev and cluster for exemplar-derived content; dev data is synthetic — report, no mutation without approval |
| OD-4 | Outbound `jailbreak_detection` | **Remove from outbound** (an injection classifier on model output is a category error); keep `response_safety` / `response_toxicity` / `response_refusal` |
| OD-5 | Runtime noise from PG2 / GLiGuard on clinical text | Inbound: screen only untrusted regions at runtime (governed platform/authored prompts were screened at save); `response_safety` and `prompt_toxicity:privacy_violation` → `ignore` (recorded, no clinician banner) on gateway-composed clinical prompts and notes until a calibrated threshold exists |

## Implementation Summary

**Lanes merged:** X (`20b8ab5a9`: no exemplars in any assemble() prompt; structure-only transform at read; exemplar audit fields), G (`95d673354`: outbound jailbreak removed; `response_safety` default ignore; per-check `categoryActions`, `prompt_toxicity.privacy_violation` ignore), G2 (`acddda460`: TS catalogue + both normalizers carry `categoryActions`), fixture `f9553aacb`. Audit A: exposure confined to 6 live / 4 pre-summary items, 2 E2E consultations, one tenant/department. Gate: guardrail 1,098, types 242, applications+seeds+contracts 20,909, typecheck + lint clean (black drift in `guardrails.py` pre-existing). Pushed `6eb7d32b0`, deployed. Cluster ops (owner-approved): 5 `GateEditExemplar` rows deleted; SYSTEM `TenantGuardrailPolicy` `response_safety` warn → ignore (v2).

**Acceptance AC3 (2026-10-11 00:52–01:05Z):**
- Leak test PASS: patient A signed off (new APPROVED_CLEAN exemplar), patient B same department — 0 of A's facts in any B frame or composed prompt; no exemplar section; B's prompt records `exemplarCount: 0`.
- Outbound `jailbreak_detection` gone; `response_safety:unsafe` flagged 11× with 0 notices; `prompt_toxicity:privacy_violation` 13× with 0 notices; CONTEXT_WINDOW_EXCEEDED / CONCURRENCY_LIMIT / CONTENT_BLOCKED_NOT_MEDICAL / GUARDRAIL_BLOCKED all 0; 29 generations, 0 failed.

**Remaining:**
| Id | Sev | Item |
|---|---|---|
| R-1 | major | Stored exemplars still hold full clinical content (OD-2 at store time not done — corpus/fine-tune reuse `redactedAfter`; needs a `structureAfter` column, owner decision). Not used by any prompt today |
| R-2 | minor | Inbound PG2 `jailbreak_detection` BLOCK evaluations (10) on governed prompt pieces with null `consultationId` — the gateway registry's advisory re-screen, not enforced, no notice; noise in metrics |
| R-3 | major | Remaining clinician-facing FP notices: outbound `response_toxicity:privacy_violation` (3), inbound `prompt_safety:unsafe` (2), outbound `pii_leak:api_key` (1) |
| R-4 | major | ×3 concurrency: live snapshot / entities only after stop (76–95 s), slower than TASK-1059 |
| R-5 | minor | "Platform prompt-piece registration exceeded its wait" (3 s) on live requests |
| R-6..R-9 | minor | pre-summary record labelled `finalize`; broker notification time −7 h; `&amp;` creates a CORRECTED exemplar for an unedited note; "metformin 500 → 1000 mg" literal example in finalize/fact-ledger instructions |
| — | — | `categoryActions` API write path + platform-only field guard; console editor UI |


## Change History
- 2026-10-11 — opened from TASK-1059 acceptance (N-1, N-3); plan + OD-1..OD-5 proposed.
- 2026-10-11 — owner: accept OD-1..OD-5 defaults, go. Measurement lane dropped (a local classifier bench would load models); FP rates measured from cluster logs after deploy instead.
- 2026-10-11 — merged X/G/G2, gate green, pushed + deployed; exemplar rows deleted; SYSTEM response_safety → ignore; acceptance AC3 passed (leak test); R-1..R-9 recorded.
