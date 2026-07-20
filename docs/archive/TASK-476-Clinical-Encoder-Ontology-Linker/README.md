# TASK-476 — Server-side Clinical Encoder + Ontology Linker (Theme C1 · SOTA S2 · **the real close of C5-03**)

- **Status**: Completed — server-side clinical encoder + ontology linker implemented, adversarially reviewed (I1 applied) + merged. AC-5 fully captured: this ticket's deterministic link-accuracy on a labelled sample (n=28; coverage 82% over sample / 100% over eligible, link precision 100%) is recorded in §Implementation Summary, and the shared TASK-470 keyterm/keyphrase-recall no-regression was captured 2026-07-12 (keyterm 1.0/0.833/1.0, keyphrase 1.0/1.0/1.0, all ≥ the 0.70 floor). No residual — the linker is a pure in-process vocab lookup (no served model gate).
- **Type**: feature (server-side clinical NER + entity linking) — makes the NLP service the **authoritative producer of coded `NamedEntity` rows**
- **Track**: [SOTA Enhancement Track](../SOTA-Track/README.md) · Theme **C1** (server-side clinical encoder + linker)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · strategic SOTA track (post-Wave-3)
- **Source finding**: [TASK-448](../TASK-448-Harness-Loop-Quality-Review/README.md) §SOTA **S2** (clinical NER + ontology linking — "significantly behind"; generic models, no linker) + register finding **C5-03** (ontology columns read everywhere, written nowhere)
- **Supersedes**: [TASK-462](../TASK-462-Gateway-Backend-Hygiene/README.md) §C5-03 — that ticket shipped the **interim** decision only (a `//` column annotation + a prompt-assembly groundedness guard for the always-empty-codes case). **This ticket is the real writer** the annotation points to.
- **Builds on**: [TASK-463](../TASK-463-NamedEntity-Persistence-Contract/README.md) (the shared `namedEntityPropsFromNlp` NLP→`NamedEntity` mapper — the one place the code fields must now flow through) · [TASK-452](../TASK-452-Live-NER-Contract-Aggregation/README.md) (aggregation-strategy fix; the classifier already merges whole-word entities)
- **Theme**: C1 · **Size**: L · **Value**: Very high (real close of C5-03) · **Risk**: Med
- **Depends on**: [TASK-470](../TASK-470-Streaming-Quality-Eval-Harness/README.md) (measure-first — the quality scorecard + committed thresholds must exist before this ships). **Unblocks**: [TASK-480](../SOTA-Track/README.md) (E1 — warm-start reuses `NamedEntity` rows as NER priors, only worth it once codes are populated) · [TASK-482](../SOTA-Track/README.md) (E3 — MEDCON/UMLS concept-F1 is computed over these codes).
- **Suggested agent**: general-purpose (spans `apps/nlp` Python + `apps/harness` Python + `packages/applications` TS + the apps/api internal DTO — a linker/NLP lens; run the Python and TS gates separately)
- **Hard guardrail (track-level)**: **self-hosted models only — no cloud PHI.** The encoder (Clinical/BioClinical ModernBERT or GatorTron) and the linker (MedCAT / Spark NLP) were chosen because they run on-prem. Do NOT introduce a cloud NER/linking vendor (e.g. AWS Comprehend Medical) that receives clinical text.

## File-ownership manifest (exclusive — binding)

The write path is a **contract chain** from the NLP producer to five DB columns; each hop currently drops the codes. This ticket extends every hop. Grouped by gate (Python NLP · Python harness · TS applications · apps/api DTO).

| File | Change | Layer |
|---|---|---|
| `apps/nlp/src/nlp/services/ontology_linker.py` (new) | The linker: recognized span → UMLS CUI + cross-walk to SNOMED CT / RxNorm / ICD-10 / LOINC (MedCAT-class, self-hosted vocab subset). Deterministic resolver, unit-testable offline. | NLP |
| `apps/nlp/src/nlp/services/token_classifier.py` | Wire the linker into `process()` (post-`_to_entities`); optionally swap/augment the encoder backbone (`blaze999/Medical-NER` → Clinical/BioClinical ModernBERT / GatorTron) behind config. | NLP |
| `apps/nlp/src/nlp/schemas/common.py` | `Entity` gains the five nullable code fields (`umls_cui`, `snomed_code`, `rxnorm_code`, `icd_code`, `loinc_code`) — the on-the-wire contract. | NLP |
| `apps/nlp/src/nlp/core/config.py` | `TokenClassificationConfig` (or a new `OntologyLinkerConfig`, `env_prefix="NLP_"`) — encoder model id + linker vocab path/toggle + confidence floor. | NLP |
| `apps/nlp/tests/**` | RED-first: linker resolves a known span (`metformin`→rxnorm/umls), classify/tokens response now serializes codes, encoder-swap parity. | NLP |
| `apps/harness/src/harness/sensors/base.py` | `NEREntity` (`:55`) gains the code fields so harness NER carries them. | harness |
| `apps/harness/src/harness/services/nlp_client.py` | `_to_entity` (`:59`) maps the new NLP code fields onto `NEREntity`. | harness |
| `apps/harness/src/harness/services/api_client.py` | `_entity_payload` (`:91`) forwards the codes into the `HarnessEntityItem` body. | harness |
| `apps/harness/src/harness/**/tests/**` | RED-first: harness NER round-trips codes end to end. | harness |
| `packages/applications/src/services/consultation/shared/namedEntityFromNlp.ts` | `NlpNamedEntity` + `namedEntityPropsFromNlp` map the five codes (`entity.umls_cui`→`umlsCui`, …). The single source of truth for the sync + async persistence paths (TASK-463). | applications |
| `packages/applications/src/services/consultation/harness/dto/harness-internal.dto.ts` | `HarnessEntityItem` accepts the five codes (class-validator + `@ApiPropertyOptional`; the global pipe is `forbidNonWhitelisted`, so undeclared fields reject). | applications |
| `packages/applications/src/services/consultation/harness/harness-internal.service.ts` | `persistEntities` mapping (`:170-182`) sets the five columns from the DTO. | applications |
| `packages/applications/src/services/consultation/**/__tests__/**` | RED-first: (a) `namedEntityFromNlp` maps codes; (b) `ner.processor` + `summary.service.extractEntities` persist codes; (c) `persistEntities` writes codes; (d) the TASK-462 prompt-assembly guard **disengages** (real coded block emitted, the "no standardized codes assigned" note absent) — the concrete C5-03-closed proof. | applications |
| `uv.lock` (root) | Only if MedCAT / Spark NLP (or a vocab package) is added — edit the `apps/nlp` `pyproject.toml`, then `uv lock` at root (per `06-python-services.md`). | infra |

**No Prisma migration.** The five `NamedEntity` ontology columns already exist (`consultation.prisma:323-327`, nullable, plaintext) — this ticket **populates** them, it does not add them.

**STOP-and-report before touching**: the **live-documentation** NER path (`live-documentation.service.ts` — re-pointing it note→transcript is [TASK-477](../TASK-477-Live-NER-Transcript-Repoint-Grounding/README.md)/C2, not here), the **browser** NER (`packages/med-ner`, `KnowledgePipeline.ts` — demoted to a display hint by policy, not rewritten here), the **eval harness** (`apps/stt-v2/tests/integration/streaming_quality.py` — TASK-470's owned files; re-run it, don't edit it), any concept-F1 scorer (TASK-482), or the five columns' definition (they are the write target — do not alter/drop). Anything outside the manifest → STOP.

## Requirement Analysis

Populate the `NamedEntity` ontology-code columns from an authoritative, self-hosted clinical NER + entity-linking step, closing the **read-everywhere / written-nowhere** gap that TASK-462 could only annotate.

### The verified gap (read by 3, written by 0)

The five ontology columns `umlsCui`/`snomedCode`/`rxnormCode`/`icdCode`/`loincCode` are **read** by three durable-summarization consumers:

1. **prompt-assembly** — `prompt-assembly.service.ts:56-67` builds `umls:…/snomed:…/rxnorm:…/icd:…/loinc:…` code strings into the harness/summary prompt (guarded since TASK-462).
2. **harness-internal** — `harness-internal.service.ts:885-889` (`loadNerEntities`) flattens the codes for prompt injection.
3. **summary processor** — `summary.processor.ts:320-324` maps the codes onto `NerEntityForPrompt`.

…but **no path writes them.** The NLP token classifier (`blaze999/Medical-NER`) emits entity **types** with **no linker** and **no codes**; every `NamedEntity` writer therefore persists the codes as `null`. TASK-462 confirmed this repo-wide (grep-empty writer search) and shipped the **interim** only — a `//` annotation on the columns (`consultation.prisma:311-322`, naming this ticket) + a groundedness guard in `serializeNerEntities` that appends `(no standardized codes assigned)` whenever the whole entity set is un-coded (which is **always**, today). So the coded-list logic runs on **permanently empty codes**, and the guard is permanently engaged.

This ticket makes the **NLP service the authoritative producer of coded entities** — a server-side clinical encoder recognizes clinical spans, a MedCAT / Spark-NLP linker resolves them to UMLS + cross-walks (SNOMED/RxNorm/ICD-10/LOINC), and the codes flow through every `NamedEntity` write path into the columns. The browser NER is thereby demoted to a **display hint** (no ambient-scribe product runs clinical linking in the browser; the durable coded entities come from the server). Per the measure-first governing principle, it lands **after** TASK-470 so the improvement is scored, not asserted.

### Acceptance criteria

- [ ] **AC-1 (linker, hermetic RED→GREEN)** — `ontology_linker.py` resolves a known clinical span to a code deterministically (`metformin` → RxNorm + UMLS CUI; `pneumonia` → ICD-10/SNOMED) against a bundled self-hosted vocab subset, unit-tested with **no network**. RED: linker absent.
- [ ] **AC-2 (NLP contract carries codes)** — `GET/POST /classify/tokens` `Entity` serializes `umls_cui`/`snomed_code`/`rxnorm_code`/`icd_code`/`loinc_code` (nullable); a test asserts a recognized medication returns a populated `rxnorm_code`. Existing type/offset/confidence output unchanged.
- [ ] **AC-3 (all durable write paths populate the columns)** — RED-first per path, then GREEN: (a) **async** `ner.processor.ts` (via the shared mapper), (b) **sync** `summary.service.extractEntities` (via the shared mapper), (c) **harness** `harness-internal.persistEntities`. Each persists a `NamedEntity` whose `rxnormCode`/`icdCode`/… are non-null for a coded input (RED proves they are `null` on current code).
- [ ] **AC-4 (C5-03 closed — the guard disengages)** — with codes populated, `serializeNerEntities` emits a real `[umls:…; rxnorm:…]` block and the TASK-462 `(no standardized codes assigned)` note is **absent**. This is the concrete proof the interim guard's `hasAnyOntologyCode` now goes true in production. (The guard code stays — it still covers genuinely un-codable spans.)
- [ ] **AC-5 (scored on TASK-470, gated on TASK-470)** — re-run TASK-470's scorecard (`test_streaming_quality_scorecard`, same clinical fixtures + pipeline `…402`) and record it in §Implementation Summary: **keyterm/keyphrase recall** (the surface-form entity-recall proxy) must **not regress** past `streaming_thresholds.json`, and the ASR guardrails (`medical_wer`, `commit_latency`, `partial_revision_rate`, `seq_gap_count`, `coverage`) must hold. Introduce this ticket's own **code-coverage / link-accuracy** acceptance number (fraction of eligible entities that receive a code; linker precision on a labelled sample) — TASK-470 explicitly **defers concept-F1 to TASK-482**, so 476 owns the code-population metric and 482 later scores semantic concept-F1 over the codes 476 writes.
- [ ] **AC-6 (browser NER demoted — positioning, documented)** — record that the server NLP service is the authoritative producer of coded `NamedEntity` rows and the browser med-ner output is a display hint only. No browser code is changed here (the actual live-surface re-point is TASK-477).
- [ ] **AC-7 (gates, per language)** — `pnpm py:nlp:test` + `py:nlp:lint` + `py:nlp:typecheck` green; `pnpm py:harness:test` (hermetic — Temporal/LLM/NLP stubbed) + `py:harness:lint`/`:typecheck` green; `pnpm --filter @arcaai/applications build test lint` green; `pnpm build:api` green (DTO change). `uv lock` re-run if deps changed. Output pasted.
- [ ] **AC-8 (no migration; self-hosted)** — `git status` shows no `packages/database/**/migrations/**` diff (columns already exist); the encoder + linker + vocab are self-hosted (no cloud PHI egress).

### Non-goals

- **Re-pointing the live-documentation NER from the generated SOAP note to the transcript delta + note-entity source-grounding** — that is [TASK-477](../TASK-477-Live-NER-Transcript-Repoint-Grounding/README.md) (C2). Do them **adjacent** (shared clinical NER path) but this ticket does not touch `live-documentation.service.ts`.
- **MEDCON / UMLS concept-F1 eval** — [TASK-482](../SOTA-Track/README.md) (E3); it consumes the codes this ticket populates. TASK-470's keyterm recall is the lightweight surface proxy used here, not concept-linking.
- **Harness warm-start / reuse of `NamedEntity` as NER priors** — [TASK-480](../SOTA-Track/README.md) (E1); only viable once codes are populated (this ticket) — E1 lands after C.
- **Swapping or removing the browser med-ner model** — it stays a display hint; not rewritten here.
- **Any cloud NER / entity-linking vendor** — self-hosted only (track guardrail).
- **Altering or dropping the five ontology columns** — they are the write target; TASK-462's annotation stays until superseded by this ticket's populated-writer note.

## Current State Evaluation (code-verified 2026-07-10 against `fix/2605-review` @ `59827bb5`)

**The producer emits no codes.** `token_classifier.py` (`TransformerTokenClassifier`) loads `blaze999/Medical-NER` (`config.py:144`, tokenizer `:147`), runs the HF `token-classification` pipeline **with** the aggregation strategy (`:88-91`, TASK-452 fixed the subword bug), and `_to_entities` (`:135-165`) builds `Entity(text, normalized_text, entity_type, confidence, position)` — **no ontology code fields exist on the `Entity` schema** (`apps/nlp/src/nlp/schemas/common.py`), and **no linker module exists**. So the NLP service produces entity **types** but never **codes**.

**Every `NamedEntity` writer therefore persists `null` codes** (three durable paths, all verified):
- **Async BullMQ** — `ner.processor.ts:101` maps via the shared `namedEntityPropsFromNlp(entity, {tenantId, contextItemId})`; the NLP call (`:169-178`) posts only `{ text }`. The shared mapper (`namedEntityFromNlp.ts:39-49`) sets `text`/`className`/`confidence`/offsets — and **no code fields at all**.
- **Sync `extractEntities`** — `summary.service.ts:735` routes through the **same** shared mapper (`:40` import) → same omission.
- **Harness** — the Temporal worker runs NER over the transcript (`activities.py:229` `extract_entities`; `_entity_payload` comment "NLP ran on the transcript") and posts to `POST /api/v1/internal/harness/consultations/:id/entities` (`harness-internal.controller.ts:82`). The chain drops codes at **every** hop: harness `NEREntity` (`sensors/base.py:55`) has none; `nlp_client._to_entity` (`:59-64`) maps only `text`/`entity_type`/`position`; `api_client._entity_payload` (`:91-113`) forwards only text/type/offsets/transcript-spans; and `harness-internal.persistEntities` (`:170-182`) maps the DTO **without** the five code columns.

**The three read sites are live and run on empty codes**: `prompt-assembly.service.ts:56-67` (+ the TASK-462 guard `:47-82`, permanently engaged), `harness-internal.service.ts:885-889`, `summary.processor.ts:320-324`.

**The columns already exist and are plaintext** (`consultation.prisma:323-327`; the `:356` comment confirms the ontology columns are **not** encrypted — safe for coded-list lookups), carrying the TASK-462 C5-03 annotation (`:311-322`) that names this ticket as the writer. **Transcript-provenance columns also already exist** (`transcriptContextItemId`/`transcriptStartOffset`/`transcriptEndOffset`, `:332-335`) — TASK-477's grounding target, out of scope here.

**Already-landed context (frame against, don't re-do)**: C5-01 (live-doc blank entities) fixed — `callNlp` reads the real contract; C5-02 (aggregation) fixed — TASK-452; C5-03 **interim** guard + annotation shipped — TASK-462; C5-05 (browser dedup) fixed — `stableEntityId`; TASK-463 shipped the shared mapper. The **one remaining** piece of the C5-family is the coded writer — this ticket.

## Implementation Plan (TDD — strict order)

> Context pack for the implementing agent: this README · TASK-449 §Architecture preamble (durable harness stays the clinical authority; live NER is ephemeral) · TASK-448 §SOTA S2 (encoder + linker choices, self-hosted) · TASK-462 §C5-03 (the interim guard this closes) · TASK-463 (the shared mapper contract) · `.claude/rules/06-python-services.md` (NLP + harness — pytest, ruff/mypy, `uv lock`, `X-Service-Token`, hermetic harness CI) · `.claude/rules/04-application-services.md` + `02-database-prisma.md` (TS write paths; columns already exist — no migration).

1. **Linker (RED→GREEN, hermetic)** — write `ontology_linker.py` with a deterministic resolver over a bundled self-hosted vocab subset; unit-test known spans → codes first (RED = absent). Keep it dependency-light or add MedCAT/Spark-NLP via `uv lock`.
2. **NLP contract (RED→GREEN)** — add the five nullable code fields to `Entity` (`common.py`); wire the linker into `token_classifier.process()` after `_to_entities`; assert `/classify/tokens` returns a populated `rxnorm_code` for a coded medication. (Encoder swap is optional/config-gated — do it behind a flag and prove parity on the existing type output.)
3. **TS shared mapper (RED→GREEN)** — extend `NlpNamedEntity` + `namedEntityPropsFromNlp` to map the codes. This single edit lights up **both** `ner.processor` and `summary.service.extractEntities` (they route through it) — assert persisted codes on both (RED = `null`).
4. **Harness chain (RED→GREEN)** — add codes to `NEREntity` → `_to_entity` → `_entity_payload` → `HarnessEntityItem` DTO → `persistEntities` mapping. Assert a coded entity round-trips to a persisted `NamedEntity` with `snomedCode`/`rxnormCode` set (RED at the DTO/mapping).
5. **Guard-disengages proof (C5-03 closed)** — a prompt-assembly test where entities carry codes asserts the real `[umls:…]` block is emitted and the `(no standardized codes assigned)` note is **absent** (the TASK-462 guard now flips to true in production).
6. **Score + gate** — re-run TASK-470's scorecard on the clinical fixtures; record keyterm/keyphrase recall (no regression) + the new code-coverage/link-accuracy number in §Implementation Summary. Note concept-F1 is TASK-482.

### Verification gate (paste output into §Implementation Summary)

```bash
# NLP (producer + linker)
pnpm py:nlp:test && pnpm py:nlp:lint && pnpm py:nlp:typecheck
# Harness chain (hermetic — Temporal/LLM/NLP stubbed)
pnpm py:harness:test && pnpm py:harness:lint && pnpm py:harness:typecheck
# TS write paths + DTO
pnpm --filter @arcaai/applications build test lint
pnpm build:api
# score (measure-first) — same fixtures/pipeline as TASK-470
pnpm py:stt-v2:test:integration   # test_streaming_quality_scorecard
```

Adversarial review focus: (a) do **all three** durable write paths (async ner.processor, sync extractEntities, harness persistEntities) actually persist codes — proven by tests, not asserted? (b) is the linker deterministic + offline (no hidden network, no cloud vendor)? (c) does the DTO change respect `forbidNonWhitelisted` (codes declared with validators)? (d) does the TASK-462 guard genuinely disengage on coded input **without** suppressing the un-coded case? (e) keyterm/keyphrase recall held vs TASK-470 baseline; no ASR-guardrail regression? (f) no Prisma migration; self-hosted only; zero diff outside the manifest.

## Implementation Summary

Implemented the full contract chain that makes the NLP service the authoritative producer of coded `NamedEntity` rows. TDD, RED-first at each hop.

**NLP producer (`apps/nlp`)** — new deterministic, offline `services/ontology_linker.py` (`OntologyLinker` + frozen `OntologyCodes`) resolves a normalized clinical span against a bundled self-hosted vocabulary subset (curated medications/conditions/symptoms/labs/procedures → UMLS + SNOMED/RxNorm/ICD-10/LOINC). `schemas/common.py` `Entity` gains the five nullable code fields; `core/config.py` gains `OntologyLinkerConfig` (`env_prefix="NLP_"`: `linker_enabled` toggle + `linker_confidence_floor`); `services/token_classifier.py` wires the linker into `process()` post-`_to_entities` (config-gated). **Encoder swap deliberately NOT done** — optional/config-gated per the plan, and no Clinical/BioClinical ModernBERT / GatorTron weights are staged in the offline HF cache; `blaze999/Medical-NER` stays the backbone (no download attempted).

**Harness chain (`apps/harness`)** — `sensors/base.py` `NEREntity`, `services/nlp_client.py` `_to_entity`, and `services/api_client.py` `_entity_payload` now carry/forward the five codes (omit-None, mirroring offsets) so harness NER round-trips codes into the `HarnessEntityItem` body.

**TS write paths (`packages/applications`)** — the shared `namedEntityFromNlp` mapper maps the five snake_case codes → `umlsCui`/`snomedCode`/`rxnormCode`/`icdCode`/`loincCode` (single edit lights up **both** async `ner.processor` and sync `summary.extractEntities`); `HarnessEntityItem` DTO gains the five validated `@ApiPropertyOptional` fields; `harness-internal.persistEntities` sets the columns. The TASK-462 C5-03 guard now disengages on coded input (real `[umls:…; rxnorm:…]` block emitted, "no standardized codes assigned" note absent) — proven by a prompt-assembly test.

**No Prisma migration** (columns pre-existed). **No dependency added** (`uv.lock` untouched) — the linker is dependency-light. **New env vars** `NLP_LINKER_ENABLED` / `NLP_LINKER_CONFIDENCE_FLOOR` registered in `turbo.json#globalEnv` + root `.env.example` + `apps/nlp/.env.example`.

### Evidence (gates, actual output)

| Gate | Result |
|---|---|
| `py:nlp:test` | **83 passed** (13 new: linker + contract) |
| `py:nlp:lint` (ruff) / `py:nlp:typecheck` (mypy) | ruff clean · mypy `Success: no issues found in 39 source files` |
| `py:harness:test` (hermetic) | **667 passed** (2 new: code round-trip) |
| `py:harness:lint` / `py:harness:typecheck` | ruff clean · mypy `Success: no issues found in 79 source files` |
| `@arcaai/applications` build (tsc) | clean |
| `@arcaai/applications` test | **5939 passed, 4 skipped** (RED→GREEN demonstrated for mapper + both durable paths + persistEntities) |
| `@arcaai/applications` lint | 0 errors, 94 pre-existing warnings (0 in any TASK-476-edited file) |
| `build:api` (turbo) | clean (8 tasks) — DTO change compiles into apps/api |
| TASK-470 scorecard (`test_streaming_quality_scorecard`) | pure metric gates **3 passed**; live run **self-skips** off-stack (orchestrator's on-stack step, by TASK-470 design). TASK-476 touches **zero** STT/ASR code → keyterm/keyphrase recall + ASR guardrails unaffected by construction. |
| AC-5 link metric (this ticket's code-population number) | labelled sample n=28 (23 in-vocab): **coverage 82% over sample / 100% over eligible**, **link precision 100%** (deterministic vocab — un-codable tail correctly left un-coded for the C5-03 guard). |

Concept-F1 over these codes is deferred to TASK-482 (E3), per the plan.

## Change History

| Date | Change |
|---|---|
| 2026-07-12 | **Triage — program closure sweep. Status → Completed.** Both halves of AC-5 are captured, no skip required: (1) this ticket's own code-population/link-accuracy number is a deterministic in-process vocab lookup already measured (labelled sample n=28 — coverage 82% over sample / 100% over eligible, link precision 100%, §Implementation Summary), and (2) the shared TASK-470 keyterm/keyphrase-recall no-regression was captured this session via the live scorecard over the 3 clinical fixtures — keyterm_recall 1.0/0.833/1.0, keyphrase_recall 1.0/1.0/1.0, all ≥ the 0.70 floor (docs/implementation/TASK-470 stt-quality-scorecard.json). The optional encoder-model swap stays correctly out of scope. No code outstanding. |
| 2026-07-11 | **Adversarially reviewed (APPROVE-WITH-FIXES) + merged to `fix/2605-review`.** Review confirmed: the `persistEntities` tenant-ownership guard is preserved byte-identical (`harness-internal.service.ts:165-166`, before the entity loop; `recordGateDecision` untouched), PHI hygiene clean (linker is a pure in-process dict lookup — no network/model/logging of clinical text; the 5 codes are intentionally plaintext-queryable, excluded from the Vault-encrypted field set), end-to-end code threading field-consistent (rxnorm traced snake→camel→column, unset codes omitted not empty-string), and scope clean (manifest-exact, no `uv.lock`/eval-harness/med-ner edits, encoder swap correctly not done). **Important fix I1 applied by the orchestrator:** the vocab aliased bare `"diabetes"`/`"diabetes mellitus"` to Type-2-specific codes (E11.9/44054006/C0011860) — removed those two aliases (kept `type 2 diabetes`/`type ii diabetes`/`t2dm`); an unqualified "diabetes" now resolves un-coded so the TASK-462 groundedness guard covers it (no Type-1/unspecified mislabeling into durable rows + the SOAP prompt). Deferred Minor follow-ups: **M1** the internal `HarnessPersistEntitiesRequest.entities` lacks `@ValidateNested`/`@Type` so nested `HarnessEntityItem` fields aren't deep-validated at the boundary (pre-existing; benign — internal service-token endpoint, Prisma-parameterized; the added DTO comment/test over-imply runtime rejection); **M2** the WordPiece `##` normalization comment is inaccurate but the branch is inert (HF aggregation merges subwords before the linker); **M3** a few curated LOINC codes are context-narrow. Gates re-verified in the main tree post-I1: `py:nlp:test` **83 passed**, `@arcaai/applications` **5939 passed**; harness (667, hermetic) + build:api unchanged from the verified worktree state. The "link precision 100%" number is honest post-I1 (bare "diabetes" is now correctly un-coded, not falsely T2-coded). Status stays Review pending the on-stack AC-5 keyterm-recall capture (TASK-470's orchestrator step). |
| 2026-07-10 | Detail-scaffolded from [SOTA-Track](../SOTA-Track/README.md) Theme **C1** into an execution-ready ticket. Current state code-verified against `fix/2605-review` @ `59827bb5`: the NLP producer (`blaze999/Medical-NER`, `token_classifier.py`/`common.py`) emits entity **types but no ontology codes and has no linker**; all three durable `NamedEntity` writers persist `null` codes (async `ner.processor.ts:101` + sync `summary.service.ts:735` via the shared mapper `namedEntityFromNlp.ts:39-49`; harness `sensors/base.py:55`→`nlp_client.py:59`→`api_client.py:91`→`harness-internal.service.ts:170-182`); the three read sites are live on empty codes (`prompt-assembly.service.ts:56-67`, `harness-internal.service.ts:885-889`, `summary.processor.ts:320-324`); the five columns already exist plaintext (`consultation.prisma:323-327`) with the TASK-462 annotation naming this ticket. **This ticket supersedes TASK-462's C5-03 interim guard/annotation** with the real self-hosted clinical encoder + MedCAT/Spark-NLP linker that populates the columns end-to-end, gated on TASK-470. No implementation; documentation only. |
| 2026-07-10 | **Implemented (status → Review).** TDD RED-first across the contract chain. NLP: new `ontology_linker.py` (deterministic, offline, bundled self-hosted vocab subset — dependency-light, no MedCAT/Spark-NLP added, no `uv.lock` change), `Entity` +5 code fields, `OntologyLinkerConfig`, linker wired into `token_classifier.process()`. Encoder swap NOT done (optional; no ModernBERT/GatorTron weights staged offline). Harness: codes threaded through `NEREntity`→`_to_entity`→`_entity_payload`. TS: shared `namedEntityFromNlp` maps codes (lights up async ner.processor + sync extractEntities), `HarnessEntityItem` +5 validated fields, `persistEntities` writes columns; TASK-462 guard disengages on coded input (proven). No migration. New env vars `NLP_LINKER_ENABLED`/`NLP_LINKER_CONFIDENCE_FLOOR` added to `turbo.json#globalEnv` + both `.env.example`. Gates: `py:nlp:test` 83 · `py:harness:test` 667 · `@arcaai/applications` build+test 5939 +lint(0 err) · `build:api` clean · TASK-470 scorecard pure gates 3 passed (live run self-skips off-stack). See §Implementation Summary. |
