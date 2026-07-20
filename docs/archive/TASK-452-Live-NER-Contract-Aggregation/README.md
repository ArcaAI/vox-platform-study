# TASK-452 — Live NER Contract Fix + Token Aggregation (C5-01 · C5-02)

- **Status**: Completed — all 7 ACs met + adversarially reviewed + gates green; only the owner's own push/PR to main remains (per owner directive, they land it)
- **Type**: bugfix
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 1 (P0)
- **Findings**: C5-01 (High, CONFIRMED ✓C ✓H) · C5-02 (High, CONFIRMED ✓C ✓H) — see [TASK-448 register](../TASK-448-Harness-Loop-Quality-Review/README.md)
- **Severity rationale**: patient-safety-adjacent — the live entity highlight overlay is clinically inert (blank/UNKNOWN entities) and, once fixed server-side, would still emit subword `##` fragments as "medications" without the aggregation fix.
- **Branch**: `fix/task-452-live-ner-contract` (cut from `main`)
- **Size**: S (both fixes are small; the work is in the tests)

## File-ownership manifest (exclusive — binding)

| File | Change |
|---|---|
| `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts` | `callNlp` mapping block ONLY (lines ~819–833) |
| `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.service.test.ts` | Fix mock fixtures (lines ~35, ~216); add contract test |
| `packages/applications/src/services/consultation/live-documentation/dto/live-summary.dto.ts` | Stale doc comments only (lines ~8, ~12) — no shape change |
| `apps/nlp/src/nlp/services/token_classifier.py` | Pipeline call (~line 87) + `_to_entities` key read (~line 137) |
| `apps/nlp/tests/` | NEW test file for aggregation + serialization |

Touching any other file (including `session.lastPayload` handling, `flush`, `persistDurableSnapshot`, barrels) → STOP and report to the orchestrator. Do not "improve" adjacent code.

## Requirement Analysis

Two defects break the live NER surface end-to-end:

1. **C5-01 — field-contract mismatch (TS side).** `callNlp` in `live-documentation.service.ts:819-833` reads `e.value` / `e.type` / `e.start` / `e.end`, but the NLP service serializes `text` / `entity_type` / `position.{start,end}` (canonical contract: `apps/nlp/src/nlp/schemas/common.py:13-28`). At runtime every live entity maps to `{ text: '', type: 'UNKNOWN' }` with undefined offsets (only `confidence` survives — that field name happens to match). The colocated test mocks the **buggy** shape (`__tests__/live-documentation.service.test.ts:35` and `:216`), so it stays green against the defect.
2. **C5-02 — aggregation dropped (Python side).** `token_classifier.py:87` calls `self.pipeline(request.text)`, never passing `request.aggregation_strategy` (declared with default `"simple"` in `schemas/classification.py:28` and configured in `core/config.py:150`) → the HF pipeline runs at `none` → subword `##` fragments with raw BIO labels. **Secondary trap (must be fixed together)**: `_to_entities` reads `result.get("entity", "O")` and `result.get("word")` (`token_classifier.py:136-137`) — those are the `none`-mode output keys. With aggregation enabled, HF returns `entity_group` instead, so passing the strategy alone would silently degrade every `entity_type` to `"O"`. The configured `ignore_labels=["O"]` (`config.py:151`) is likewise never applied.

**Blast radius (verified)**: the mapped entities flow only into `LiveSummaryEventDto.entities` → Redis snapshot + SSE channel `consultation:live-summary:{id}` (transient UI highlight overlay). `persistDurableSnapshot` saves only the summary text — entities are **not persisted**. The durable harness NER path (`apps/harness/.../nlp_client.py:58-66`) already maps the contract correctly and is the reference implementation; it must not be touched.

### Acceptance criteria

- [ ] **AC-1 (red first)**: mock fixtures at `live-documentation.service.test.ts:35` and `:216` re-keyed to the REAL NLP shape (`{ entity_type, text, confidence, position: { start, end } }`). With fixtures fixed and mapper untouched, the existing assertion (`:169`) FAILS — capture this red run as evidence.
- [ ] **AC-2**: `callNlp` maps `text → text`, `entity_type → type`, `position.start → start`, `position.end → end`, `confidence → confidence`; the inline `raw` element type on line ~825 updated to the real contract. All prior tests green.
- [ ] **AC-3 (red first)**: new pytest asserts the pipeline is invoked WITH the request's `aggregation_strategy` (fails against current code), and that `_to_entities` reads `entity_group` (with fallback to `entity` for `none`-mode) — a multi-subword medication fixture (e.g. pipeline output for "amlodipine" split into `##` fragments in `none` mode vs one merged `entity_group: MEDICATION` span in `simple` mode) yields ONE entity with un-prefixed type and correct char offsets.
- [ ] **AC-4**: labels in configured `ignore_labels` (default `["O"]`) are excluded from the response.
- [ ] **AC-5**: `entity_type` values are BIO-prefix-free when aggregation ≠ `none` (`MEDICATION`, not `B-MEDICATION`).
- [ ] **AC-6**: no change to the NLP response schema (`Entity` / `TokenClassificationResponse`) — the wire contract is already correct; only the two consumers/producers of it change.
- [ ] **AC-7**: verification commands (below) green; output pasted into §Implementation Summary.

### Explicit non-goals

- Re-pointing live NER at the transcript instead of the generated note (SOTA S2-04 — separate strategic ticket).
- Clinical model replacement, entity linking, ontology columns (C5-03 → TASK-462; S2 track).
- Forwarding `aggregation_strategy`/`language` from the TS caller (server default `"simple"` is correct once honored); do NOT add fields to the request body.
- Any change to `flush` debouncing, truncation (C5-04 → TASK-459), or the owner lock (C5-06 → TASK-459).

## Current State Evaluation (code-verified 2026-07-09 by read-only scout)

**Buggy mapper** — [live-documentation.service.ts:825-832](packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts):

```ts
const raw = (response.data?.entities ?? []) as Array<{ type?: string; value?: string; confidence?: number; start?: number; end?: number }>;
return raw.map((e) => ({
  text: e.value ?? '',
  type: e.type ?? 'UNKNOWN',
  confidence: e.confidence,
  start: e.start,
  end: e.end,
}));
```

**Canonical NLP contract** — [common.py:18-28](apps/nlp/src/nlp/schemas/common.py): `Entity { id, text, normalized_text, entity_type, confidence, position: TextPosition { start, end }, model_version }`.

**Test masking the bug** — [live-documentation.service.test.ts:35](packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.service.test.ts): mock returns `{ type: 'MEDICATION', value: 'amlodipine', confidence: 0.92, start: 3, end: 13 }`; second occurrence at line 216.

**Dropped aggregation** — [token_classifier.py:84-87](apps/nlp/src/nlp/services/token_classifier.py): `pipeline_results = self.pipeline(request.text)`; `_to_entities` at lines 131-154 reads `result.get("word")` / `result.get("entity", "O")` (none-mode keys). Request field declared at [classification.py:28](apps/nlp/src/nlp/schemas/classification.py); config default + `ignore_labels` at [config.py:150-151](apps/nlp/src/nlp/core/config.py). Model: `blaze999/Medical-NER` (BIO-labeled), [config.py:139](apps/nlp/src/nlp/core/config.py).

**Existing NLP test gap** — [test_metrics_task386.py:42-55](apps/nlp/tests/test_metrics_task386.py) stubs the pipeline entirely (`classifier.pipeline = lambda text: []`) and asserts only metrics; `conftest.py:21-47` fakes the classifier for API tests. Nothing covers aggregation or `_to_entities`.

**Correct reference (do not modify)** — [nlp_client.py:58-66](apps/harness/src/harness/services/nlp_client.py) maps `text` / `entity_type` / `position.{start,end}` properly.

### Field-mapping table (the contract, for the implementing agent)

| NLP serializer field | Current (buggy) TS read | Correct TS read | DTO field |
|---|---|---|---|
| `text` | `e.value` → `''` | `e.text` | `text` |
| `entity_type` | `e.type` → `'UNKNOWN'` | `e.entity_type` | `type` |
| `confidence` | `e.confidence` ✅ | `e.confidence` | `confidence` |
| `position.start` | `e.start` → `undefined` | `e.position?.start` | `start` |
| `position.end` | `e.end` → `undefined` | `e.position?.end` | `end` |

## Implementation Plan (TDD — strict order)

> Context pack for the implementing agent: this README · TASK-449 §Architecture preamble (the entities here are the **realtime loop's** transient UI overlay, NOT the durable `NamedEntity` rows — do not conflate) · `.claude/rules/04-application-services.md` · `.claude/rules/06-python-services.md`.

1. **RED (C5-01)** — In `live-documentation.service.test.ts`, re-key BOTH mock fixtures (lines ~35, ~216) to the real contract shape. Run `pnpm --filter @arcaai/applications test -- live-documentation`; the entity assertions must FAIL. Commit the red test.
2. **GREEN (C5-01)** — Fix `callNlp`'s `raw` type + mapping per the table. Keep nullish-fallbacks (`?? ''`, `?? 'UNKNOWN'`) for genuinely missing fields. Run the suite green. Commit.
3. Update the two stale doc comments in `live-summary.dto.ts` (they document `value` → `text`). No shape change.
4. **RED (C5-02)** — New `apps/nlp/tests/test_token_classifier_aggregation.py`: (a) spy that `self.pipeline` is called with `aggregation_strategy=request.aggregation_strategy`; (b) `_to_entities` on a fixture of aggregated output (`entity_group`/merged `word`) returns one merged entity with un-prefixed type + correct offsets; (c) `ignore_labels` filtering. All must fail against current code. Commit red.
5. **GREEN (C5-02)** — Pass `aggregation_strategy` into the pipeline call (request value, falling back to `self.configs.aggregation_strategy`); in `_to_entities` read `result.get("entity_group") or result.get("entity", "O")`; apply `ignore_labels`. Run green. Commit.
6. **Refactor pass** — none anticipated; do not restructure the service.

### Verification gate (paste output into §Implementation Summary)

```bash
pnpm --filter @arcaai/applications build
pnpm --filter @arcaai/applications test
pnpm py:nlp:test
pnpm py:nlp:lint && pnpm py:nlp:typecheck
pnpm lint   # only-warn in packages/* — treat new warnings as errors
```

Adversarial review focus (reviewer agent): (a) does the fixed mock now match `apps/nlp/src/nlp/schemas/common.py` exactly? (b) with aggregation `simple`, is `entity_type` guaranteed BIO-free and `word`-merging correct for `##` fragments? (c) does anything else consume `callNlp`'s output shape? (d) confirm zero diff outside the manifest.

## Implementation Summary

**Branch**: `fix/task-452-live-ner-contract` (2 commits: `280c8a95` fix, `04a73f41` review cleanups) — merged into `fix/task-449-wave1`.

**C5-01 (TS)**: `callNlp` re-keyed to the real NLP contract (`text`/`entity_type`/`position.{start,end}`); the two colocated mocks re-keyed to that shape (making the existing assertions RED against the old mapper), plus a new contract test. Output DTO shape unchanged.

**C5-02 (Python)**: `token_classifier.py` now forwards `aggregation_strategy` (request value, falling back to config) into the HF pipeline and reads `entity_group` (fallback `entity`), applying `ignore_labels`. New `test_token_classifier_aggregation.py` pins forwarding, subword-merge, and filtering.

**Gates**: `@arcaai/applications` **5884 tests** (272 files), `apps/nlp` **52 tests**, `ruff` clean, `mypy` clean. RED captured for both findings.

**Adversarial review**: no Critical (contract-exact, genuine RED, no wire-schema change, scope-clean). Review cleanups applied: **I-2** (a metrics test was passing via the error branch — stub fixed to the happy path), **M-1** (precedence test strengthened to `"max"` ≠ config default), **M-4** (restored a dropped doc note).

**Discovered → [TASK-463](../TASK-463-NamedEntity-Persistence-Contract/README.md)**: the review found the SAME contract bug in two paths that PERSIST `NamedEntity` rows (`ner.processor.ts`, `summary.service.ts`) — durable corruption, not in the TASK-448 register. Deliberately NOT folded into this ticket (different files, different severity); tracked separately.

## Change History

| Date | Change |
|---|---|
| 2026-07-11 | **Closed (Status → Completed).** Closure-review pass (owner directive): all 7 ACs met, adversarial review applied (I-2/M-1/M-4 cleanups), gates green (applications 5884 + nlp 52 passed / ruff + mypy clean / integration build). The discovered sibling was spun off to TASK-463 (separate ticket, not remaining work here). No external work remains — only the owner's git push/PR to main. |
| 2026-07-09 | Ticket scaffolded from TASK-448 findings C5-01/C5-02; all line references and contract fields re-verified against code by read-only scout. No implementation started. |
| 2026-07-09 | Implemented (TDD) + adversarially reviewed (no Critical). Cleanups I-2/M-1/M-4 applied. Review discovered the same bug in two NamedEntity persistence paths → TASK-463 (not folded in). Merged to `fix/task-449-wave1` (integration build green). |
