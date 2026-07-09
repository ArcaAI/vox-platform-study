# TASK-463 — NamedEntity Persistence Contract Fix (C5-01 siblings, DISCOVERED)

- **Status**: Review — implemented (Wave 1.5), adversarially reviewed (Approve, no Critical/Important), merged to `fix/task-449-wave1`; final landing pending
- **Type**: bugfix (data integrity — durable clinical entities)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · discovered follow-up (not in the original TASK-448 register)
- **Origin**: found by the TASK-452 adversarial reviewer (finding I-1) while verifying C5-01. **TASK-448 did not catch these two sibling call sites.**
- **Severity**: **High** — arguably higher than C5-01's live-doc panel: these paths WRITE `NamedEntity` rows to the database, so the corruption is durable, not transient UI.
- **Branch (when scheduled)**: `fix/task-463-namedentity-contract` (from current HEAD)
- **Size**: S–M

## Requirement Analysis

The same NLP field-contract bug fixed in TASK-452 (`e.value`/`e.type`/`e.start`/`e.end` vs the real `text`/`entity_type`/`position.{start,end}`) exists, unfixed, in **two paths that persist `NamedEntity` rows** — so the DB records are written blank/null instead of merely rendering blank in a panel.

### Verified evidence (current HEAD, confirmed 2026-07-09)

**Path 1 — async BullMQ NER job, FULLY broken** ([ner.processor.ts:100-108](packages/applications/src/services/consultation/jobs/processors/ner.processor.ts)):

```ts
const namedEntity = NamedEntityFactory.CreateNamedEntity({
  tenantId, contextItemId,
  text: entity.value,        // NLP emits `text`            → undefined
  className: entity.type,     // NLP emits `entity_type`     → undefined
  confidence: entity.confidence,
  startOffset: entity.start,  // NLP emits `position.start`  → undefined
  endOffset: entity.end,      // NLP emits `position.end`    → undefined
});
// …encryptFieldsIntoEntity → namedEntityRepository.create(namedEntity)  ← DURABLE WRITE
```

The method's own return type declares the phantom shape (`{ type, value, start, end }`) at [ner.processor.ts:172-179](packages/applications/src/services/consultation/jobs/processors/ner.processor.ts). Result: persisted `NamedEntity` has encrypted-empty `text`, `className = null`, offsets `null`.

**Path 2 — synchronous `extractEntities`, PARTIALLY broken** ([summary.service.ts:734-742](packages/applications/src/services/consultation/summary/summary.service.ts)):

```ts
text: (entity.value as string) ?? (entity.text as string),        // survives via fallback
className: (entity.type as string) ?? (entity.className as string), // both absent → undefined
startOffset: (entity.start as number) ?? (entity.startOffset as number), // both absent → undefined
endOffset: (entity.end as number) ?? (entity.endOffset as number),       // both absent → undefined
```

`text` survives (falls back to `entity.text`), but `className` and offsets persist `null`.

**Correct reference (do not regress)**: [nlp_client.py:58-66](apps/harness/src/harness/services/nlp_client.py) maps the contract properly; [ai-inference.client.ts:48](apps/api/src/modules/ai-inference/ai-inference.client.ts) proxies verbatim and is fine.

### Correct mapping (NLP serializer → NamedEntity field)

| NLP field | Wrong read | Correct read | NamedEntity field |
|---|---|---|---|
| `text` | `entity.value` | `entity.text` | `text` |
| `entity_type` | `entity.type` | `entity.entity_type` | `className` |
| `confidence` | `entity.confidence` ✅ | `entity.confidence` | `confidence` |
| `position.start` | `entity.start` | `entity.position?.start` | `startOffset` |
| `position.end` | `entity.end` | `entity.position?.end` | `endOffset` |

### Acceptance criteria

- [ ] **AC-1 (red first, both paths)**: tests persist a `NamedEntity` from a realistic NLP response (`{ text, entity_type, position:{start,end} }`) and assert the CURRENT code writes blank/null `text`/`className`/offsets — fail against current code, then pass.
- [ ] **AC-2**: both call sites map the real contract; the `callNlpService` return type in `ner.processor.ts` (:172-179) is corrected to the real shape (`text`/`entity_type`/`position`).
- [ ] **AC-3**: the `extractEntities` fallback chain is cleaned so it reads the real fields (the `?? entity.text` etc. fallbacks become the primary read).
- [ ] **AC-4 (severity check)**: confirm whether either path is currently live in production pipelines (the reviewer did not fully verify runtime liveness) — if a path is dead, note it; if live, it is corrupting durable clinical entities and should be prioritized accordingly.
- [ ] **AC-5**: consider a shared NLP-entity mapper (one function) so the contract lives in ONE place across live-doc, ner.processor, summary.service, and the harness client — preventing a fourth divergence (the `defense-in-depth` lesson).
- [ ] **AC-6**: verification gate green; `pnpm --filter @arcaai/applications build test lint`.

### Coordination note

`summary.service.ts` is also in **TASK-453**'s manifest (the blocked C1-01 sign-off guard). The two edits are in different methods (`extractEntities` here vs `approveSummary` there), but whichever schedules first should flag the other to avoid a merge race.

## Implementation Summary

**Branch**: `fix/task-463-namedentity-contract` (commit `cbf43740`, parent `f84ff216`) — merged into `fix/task-449-wave1` (Wave 1.5).

**Fix (AC-5 durable form)**: one shared mapper `packages/applications/src/services/consultation/shared/namedEntityFromNlp.ts` — `namedEntityPropsFromNlp(entity, { tenantId, contextItemId })` reads the real snake_case contract as primary (`text`, `entity_type`, `confidence`, `position.{start,end}`), keeps legacy names as defensive fallbacks, preserves `0` via `??` (not `||`), and defaults required `text`/`className` to `''`. Both call sites route through it:
- `ner.processor.ts` — mapping replaced + `callNlpService` return type corrected from the phantom `{type,value,start,end}` to `NlpNamedEntity[]`.
- `summary.service.ts` — ONLY the `extractEntities` mapping (~:734-742) + a top-of-file import; `approveSummary` and all else byte-identical.

**Both paths verified LIVE (AC-4)**: `NerProcessor` is a registered provider with a real `ExtractNamedEntities` queue producer; `summary.extractEntities` is a real API route (`consultation.controller.ts:994`). So this was actively persisting blank/null `NamedEntity` rows.

**Gates**: `@arcaai/applications` build clean; **5892 tests passed / 0 failed** (272 files); lint net-zero new warnings. RED captured for both persistence paths (blank/null before fix) + 7 shared-mapper unit tests.

**Adversarial review**: **Approve — no Critical, no Important.** Mapper contract-exact and `??`-correct; both paths route through it identically; encryption path intact; tests genuine RED. The reviewer additionally chased down a **third** `NamedEntity` writer (`harness-internal.service.ts::persistEntities`) and proved it correctly out of scope (it consumes the re-keyed `HarnessEntityItem` DTO the harness Python worker already maps; `forbidNonWhitelisted` enforces the contract end-to-end). `live-documentation.service.ts` correctly untouched (persists `ContextItem`, not `NamedEntity`).

**Known Minor (non-blocking, deferred)**: the mapper's `''`-default doc comment says "both are required non-null columns" — inaccurate for `text` (its plaintext column was dropped in TASK-369; now nullable `encryptedText`); only `className` is non-null. The `''` default is still correct (it feeds the required entity prop + encryption). Comment-only nit.

## Implementation Plan (historical)

_Executed as above. AC-5's shared mapper was adopted (the durable fix), not just the two call-site edits._

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from the TASK-452 review's I-1 finding; both persistence call sites confirmed against code by the orchestrator (ner.processor.ts fully broken, summary.service.ts partially). Not in the original TASK-448 register. Awaiting prioritization. |
