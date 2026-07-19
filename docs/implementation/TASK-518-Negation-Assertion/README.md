# TASK-518 — Negation / assertion

**Status:** Completed
**Type:** feature
**Parent program:** TASK-508 Phase 6 (Accuracy wave)

## Requirement Analysis

Label each recognized clinical entity mention with its **assertion status** so
faithfulness checks stop treating negated / non-patient mentions as positive claims.

`Entity.assertion ∈ {PRESENT, ABSENT, HISTORICAL, FAMILY, HYPOTHETICAL}`:

| Text | Expected |
|---|---|
| "no chest pain" | ABSENT |
| "family history of MI" | FAMILY |
| "if symptoms worsen" | HYPOTHETICAL |
| "history of asthma" | HISTORICAL |
| (plain mention) | PRESENT (default) |

Consumers: `entity_faithfulness` + concept-F1 sensors **exclude ABSENT** entities
from positive-claim checks (a note that correctly says "no metformin" must not be
scored as *having* the metformin concept).

## Current State Evaluation

NLP token classifier emitted spans with no polarity; every recognized entity was
implicitly a positive assertion, so correctly-negated content could be flagged as
unfaithful and negated concepts inflated/deflated concept-F1.

## Implementation Plan (TDD)

1. **RED** — `apps/nlp/tests/test_assertion.py`: negation, family, hypothetical,
   historical, default present, precedence, sentence-boundary scoping.
2. **GREEN** — rule engine + `Entity.assertion` field + additive
   `NamedEntity.assertion` column + persist through all writers + sensor consumption.

## Implementation Summary

### NLP service
- `apps/nlp/src/nlp/services/assertion.py` — `NegExAssertionClassifier`
  (ConText/NegEx-style, deterministic, **offline**) over a trigger lexicon, behind an
  abstract `AssertionModel` interface — the documented **model-swap seam** so a learned
  classifier can replace it without touching callers. Precedence: FAMILY/HYPOTHETICAL
  before ABSENT/HISTORICAL; triggers scoped to sentence boundaries (no bleed across
  `.`/`;`).
- `apps/nlp/src/nlp/schemas/common.py` — `AssertionStatus` StrEnum; `Entity.assertion`
  (default `PRESENT`).
- `apps/nlp/src/nlp/core/config.py` — `TokenClassificationConfig.assertion_enabled`
  (default **ON**; deterministic + offline; disable to skip the pass).
- `apps/nlp/src/nlp/services/token_classifier.py` — inject `AssertionModel`
  (default `NegExAssertionClassifier`); classify spans after linking, config-gated.

### Database (additive)
- `consultation.prisma` — `NamedEntity.assertion String?` (nullable; **null reads as
  PRESENT**, the safe default, so existing rows and non-setting writers stay positive).
- Migration `20260719040000_task_518_named_entity_assertion/migration.sql`:
  ```sql
  ALTER TABLE "core"."NamedEntity" ADD COLUMN IF NOT EXISTS "assertion" TEXT;
  ```

### Domain (hand-authored)
- `NamedEntityModel.ts` / `NamedEntityEntity.ts` / `NamedEntityFactory.ts` — new
  `assertion: string | null` field, entity accessor, and factory prop.

### Persistence — all three NamedEntity writers carry polarity
- `packages/applications/.../consultation/shared/namedEntityFromNlp.ts` — map
  `entity.assertion` → factory prop.
- `packages/applications/.../consultation/harness/dto/harness-internal.dto.ts` —
  `HarnessEntityItem.assertion?`.
- `packages/applications/.../consultation/harness/harness-internal.service.ts` —
  `persistEntities` forwards `assertion`.

### Harness sensors consume polarity
- `sensors/base.py` — `NEREntity.assertion`; `is_absent` / `is_positive_assertion`
  helpers (ABSENT/FAMILY/HYPOTHETICAL are not positive claims).
- `services/nlp_client.py`, `services/api_client.py` — forward `assertion` in
  entity payload/parse.
- `sensors/computational/entity_faithfulness.py` — ABSENT entities excluded from the
  positive-claim faithfulness check.
- `eval/models.py` (`ConceptCode.assertion`) + `eval/draft_eval.py`
  (`candidate_concepts_for_case` filters ABSENT from the concept-F1 positive set).

## Verification (actual)

- `conda run -n arcaenv … pytest apps/nlp/tests/ -q` → **114 passed**
- `conda run -n arcaenv … pytest apps/harness/src/harness/tests/ -q` → **820 passed**
  (incl. `test_entity_faithfulness` ABSENT-exclusion + `test_draft_eval` polarity cases)
- `pnpm --filter @arcaai/{database,domains,applications} build`+`test` → green
- `ruff check` on changed NLP surfaces → All checks passed

## Deviations

None. Rule engine chosen over a learned model per the ticket (offline, deterministic);
the `AssertionModel` seam keeps the upgrade path open.

## Change History

- 2026-07-19 — Initial implementation (RED→GREEN): NegEx assertion classifier, additive
  `NamedEntity.assertion` column + trio, polarity threaded through all writers and the
  faithfulness/concept-F1 sensors. Gates green.
