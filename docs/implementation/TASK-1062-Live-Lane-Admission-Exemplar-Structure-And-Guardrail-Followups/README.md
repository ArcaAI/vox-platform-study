# TASK-1062 — Live-lane admission, structure-only exemplars, guardrail follow-ups

| Field | Value |
|---|---|
| Status | Pending — owner decisions recorded 2026-10-11; awaiting **go** |
| Type | bugfix / hardening |
| Branch | dev-2.2 (lanes in worktrees); ALaaS `refactor-hope-integaration` for D-5.2/D-5.3 |
| Source | [TASK-1061](../TASK-1061-Cross-Patient-Exemplar-Leak-And-Guardrail-False-Positives/README.md) §Implementation Summary "Remaining" R-1..R-9 + follow-ups |
| Opened | 2026-10-11 |

## Owner decisions (2026-10-11)

| # | Decision |
|---|---|
| D-1 **A** | Remaining false-positive banners → **policy defaults only**: `response_toxicity.categoryActions.privacy_violation = ignore`; PII-leak label taxonomy moves `api_key` and `encounter_id` to the quasi (warn-only) labels; inbound `prompt_safety` — inspect the 2 caller-text hits first, then decide default |
| D-2 **C** | Live lane late at ×3 → **A now**: a dedicated live-lane admission budget in text (default 2 of 8 LM Studio slots, configurable `global-kv`), so live flushes never queue behind finalize/pre-summary; **B as a follow-up ticket**: incremental live prompt (delta transcript + running note) |
| D-3 **A** | Exemplars → new column `GateEditExemplar.structureAfter` written at save time with the TASK-1061 structure-only transform; prompts read **only** `structureAfter`; `redactedAfter` stays for the SME corpus / fine-tune / golden-case exports. Migration + backfill of existing rows |
| D-4 **A** | Governed-prompt registry skips the injection classifier for `sourceType: PLATFORM` pieces (authored pieces keep save-time screening) |
| D-5 **yes** | (1) pre-summary composed record phase `pre-summary` (not `finalize`); (2) ALaaS broker notification timestamps in UTC; (3) ALaaS stops HTML-escaping `&` in save/EMR copy; (4) finalize + fact-ledger instruction examples use placeholders (`<DRUG> <DOSE> → <DOSE>`) instead of literal "metformin 500 → 1000 mg" |
| E-1 **yes** | `categoryActions` writable through the platform guardrail API, **platform-admin-only** (added to the field guard like `action`), plus a console editor in the guardrail availability screen |
| E-2 **yes** | Platform guardrail availability screen/API ignores the session working tenant for SYSTEM reads/writes (today a working tenant makes the SYSTEM row read as empty and a save tries to create a duplicate) |

## Implementation Plan — lanes (file-disjoint, parallel)

| Lane | Tier | Owns | Work |
|---|---|---|---|
| P policy defaults (D-1) | sonnet | guardrail `core/availability.py` + catalogue contract JSON, `packages/applications/.../guardrail-availability/policy-catalogue.ts`, seed `18-guardrail-availability.ts`, PII-leak label taxonomy seed (`seed/ai-models/nlp.ts` labelTaxonomy) + tests | `response_toxicity.privacy_violation` ignore; `api_key`/`encounter_id` quasi; report the 2 `prompt_safety` hits (Loki, read-only) with a recommended default |
| L live admission (D-2A) | opus | text `core/runtime_defaults.py`, `services/runtime_limits.py`, `api/endpoints/generate.py` (lane selection only), settings descriptor for the live budget + gateway live-lane request marker in `live-documentation.service.ts` (header/field only) + tests | live lane budget, live flushes tagged and admitted separately, back-pressure without starving finalize |
| S structure column (D-3) | opus | prisma `GateEditExemplar` (+ migration via shadow DB recipe), domains entity/mapper/repo, `gate-edit-mining.service.ts`, `exemplar-structure.ts`, backfill script + tests | `structureAfter` written at save; reads only it; backfill existing rows |
| R registry (D-4, D-5.1, D-5.4) | sonnet | `governed-prompt-registry.service.ts`, `composed-prompt.recorder.ts` (phase label), the pre-summary call site's phase, seed instruction texts for finalize + fact-ledger + tests | PLATFORM pieces skip injection classifier; phase label; placeholder examples |
| C console + API (E-1, E-2) | sonnet | gateway guardrail availability service/controller/DTO, `packages/types` field guard, admin-console guardrail availability feature + tests | `categoryActions` platform-only write + editor; SYSTEM reads/writes ignore working tenant |
| AL ALaaS (D-5.2, D-5.3) | sonnet | ALaaS broker notification timestamp + save/EMR copy escaping + tests | UTC timestamps; no `&amp;` |

Orchestrator: contract freeze (live-lane marker name + setting key), DB migration on shared surfaces, gate once after merge, deploy with owner OK (migration ⇒ `hope-db-migrate` job), cluster acceptance re-run (×3 live timing, banner counts, exemplar store content).

## Follow-up ticket to open after this one
- D-2B incremental live prompt (delta transcript + running note).

## Implementation Summary
_(pending go)_

## Change History
- 2026-10-11 — opened from TASK-1061 R-1..R-9; owner decisions D-1A, D-2C, D-3A, D-4A, D-5 yes, E-1/E-2 yes.
