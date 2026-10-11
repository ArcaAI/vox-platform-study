# TASK-1062 — Live-lane admission, structure-only exemplars, guardrail follow-ups

| Field | Value |
|---|---|
| Status | Review — deployed 2026-10-11; acceptance partial (see Implementation Summary) |
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

## Frozen contract (orchestrator, before lanes)
- **Live-lane marker:** every gateway → text `/generate` call made by the live lane (`live-documentation` flushes) carries header `X-Hope-Lane: live`. Absent header = the existing user lane.
- **Live-lane budget:** platform setting `lmStudio.serving.liveLaneSlots` (`global-kv`, number, default **2**, min 1, max = `lmStudio.serving.parallel`), served to text through `GET internal/effective-config?service=text` as `lmStudioServing.liveLaneSlots`. Text admits live-marked lm-studio requests into a separate semaphore of that size; the user lane keeps `parallel − liveLaneSlots`.
- **Migration:** lane S writes the schema change and the migration SQL WITHOUT a database (`prisma migrate diff --from-schema <old> --to-schema <new> --script`); the orchestrator applies it. No lane touches a database.

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

**Merged:** P `9861f05ac`, R `f54481f8b`, C `b67c1e29f`, S `ca7ab63f3`, L `e18e6b1fd`, ALaaS `acc6ab7`+`f4144ab` (EMR HTML escapes raw tags), regenerated OpenAPI. Gate green (guardrail, text 2,292, domains 2,112, types 245, applications+db+contracts 22,074, console 145, typecheck, lint, ALaaS broker 1,354, web_ui 816). Pushed `e05a1a00e` (also carried BUG-026..028 from another session) and ALaaS `6605485`; deployed; migration applied; backfill skipped (0 rows).

**Cluster data (AC4):** SYSTEM availability v3 `response_toxicity.categoryActions = {privacy_violation: ignore}`; `piiLeakQuasiIdentifierLabels` v2 (+`api_key`, `encounter_id`); `fact-ledger-extraction` republished (Global v2, SYSTEM v2 via promote, ArcaAI v2); ArcaAI `casenote-finalization` v2 published. **Global `casenote-finalization` v2 publish REFUSED** by build-time medical_scope (fragment `clinical_note` + `output_language_policy` judged off scope) — left DRAFT, SYSTEM not promoted.

**Acceptance AC4 (03:52–03:58Z):**
| Check | Result |
|---|---|
| No `response_toxicity:privacy_violation` banner | PASS |
| EMR copy has no `&amp;` | PASS |
| Live snapshot during recording (×3) | **FAIL** — no live flush fired before stop (35 s recordings, also single visit); at stop, 2 of 3 live flushes 503 `CONCURRENCY_LIMIT` after ~31 s on the 2-slot live lane |
| No `pii_leak:api_key` banner | **FAIL** — now `warn` with acknowledgement required (quasi downgrade is block→warn, not ignore) |
| Exemplar `structureAfter` | **not testable** — 0 rows: pre-existing fail-closed check drops any note the redactor leaves unchanged when `/\b[A-Z][a-z]+ [A-Z][a-z]+\b/` matches (every heading) — `gate-edit-mining.service.ts:825,869` (TASK-532) |
| stop→note.final ×3 | 128–138 s (TASK-1061: 123–148 s) |

**Open (owner decisions needed):** live-lane sizing/queueing at stop; flush cadence before stop; `pii_leak` quasi labels → ignore vs warn; build-time medical_scope false positive on Global finalizer + output-language template; exemplar capture fail-closed heuristic; `pii_leak` engine 20 s timeout under ×3; `prompt_safety:unsafe` warns (2/3); R-2 registry jailbreak evaluations still recorded.


## Change History
- 2026-10-11 — opened from TASK-1061 R-1..R-9; owner decisions D-1A, D-2C, D-3A, D-4A, D-5 yes, E-1/E-2 yes.
- 2026-10-11 — owner go; contract frozen (X-Hope-Lane header, lmStudio.serving.liveLaneSlots); six lanes started.
- 2026-10-11 — merged, gate green, pushed + deployed; AC4 data writes and acceptance; open items recorded.
