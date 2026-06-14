# TASK-355 · Appendix 07 — Phase C Implementation Plan (R-6: warm start from the LiveDoc snapshot)

| | |
|---|---|
| **Ticket** | TASK-355 |
| **Phase** | C — Warm start `generate` with the LiveDoc `LIVE_SOAP_SNAPSHOT` |
| **Catalog item** | R-6 (README §5; phase summary §6) |
| **Status** | **Implemented (2026-06-14)** — Phase C warm-start **SHIPPED** behind a default-OFF kill-switch `HARNESS_WARM_START_ENABLED` (read by `HarnessInternalService` + `PromptAssemblyService` via `ConfigService`; flag-OFF restores exact pre-Phase-C behavior — no `{pre_summary_text}` append, empty `preSummaryIds`). **Caveat:** the §3 cold-vs-warm fidelity A/B (N ≥ 5 consults) is **still pending a live dev stack** — never run. |
| **Type** | TypeScript: NestJS application service + prompt assembly + (optional) prompt-template seed |
| **Layer chain touched** | Domain provenance (verify-only, no migration) → Application service (`HarnessInternalService`) → Prompt assembly (`PromptAssemblyService`) → (optional) prompt-template seed |
| **Temporal workflow change** | **None** (so no `workflow.patched()` gate, no replay fixture — the defining safety benefit of this phase) |

> Scope is **R-6 only**. Everything else in the catalog (R-1…R-5, R-7…R-13) is out of scope here.

---

## 0. Pre-flight findings from the live source (verified, 2026-06-13)

These drive every decision below; each is a direct read of the working tree.

1. **`SummaryMeta.preSummaryIds` already exists end-to-end → NO migration.**
   - Prisma: `preSummaryIds String[] @default([])` —

```233:233:packages/database/src/prisma/db_main/consultation.prisma
    preSummaryIds      String[] @default([]) // IDs of pre-summaries used
```
   - Entity getter/setter + `_preSummaryIds` default `[]` (`packages/domains/src/entities/generated/core/SummaryMetaEntity.ts:18,45,71,152-158`).
   - Factory accepts it and defaults to `[]` —

```60:62:packages/domains/src/factories/generated/core/SummaryMetaFactory.ts
      caseNoteIds: props.caseNoteIds ?? [],
      preSummaryIds: props.preSummaryIds ?? [],
      previousSummaryIds: props.previousSummaryIds ?? [],
```
   **Confirmation: the provenance column, entity field, and factory arg are all present. Phase C requires NO schema migration and NO `pnpm db:migrate`.** The only gap is that the harness path never *populates* it.

2. **The harness `assemble()` never loads a pre-summary today.** It loads transcript + NER + case/work notes + attachments + highlights, then calls `promptAssemblyService.assemble({...})` *without* `preSummaryText` —

```165:176:packages/applications/src/services/consultation/harness/harness-internal.service.ts
      const assembled = await this.promptAssemblyService.assemble({
        departmentId: consultation?.departmentId ?? undefined,
        promptType: consultation?.parentConsultationId ? 'revisit' : 'new-patient',
        transcript,
        conversationLanguage: dto.conversationLanguage?.trim() || 'en',
        dnaStyleId: dto.dnaStyleId,
        explicitTemplate: dto.template,
        nerEntities,
        clinicianNotes,
        attachments,
        highlights,
      });
```

3. **The legacy summary path is the mirror.** `SummaryService.generateSummary()` loads the latest pre-summary and passes `preSummaryText` —

```196:206:packages/applications/src/services/consultation/summary/summary.service.ts
    const latestPreSummary = await this.contextItemRepository.findLatestPreSummary(consultationId);
    const assembledPrompt = await this.promptAssemblyService.assemble({
      departmentId: consultation.departmentId ?? undefined,
      promptType: consultation.parentConsultationId ? 'revisit' : 'new-patient',
      transcript: content,
      conversationLanguage: this.resolveConversationLanguage(request.options),
      dnaStyleId: request.dnaStyleId,
      preSummaryText: latestPreSummary?.content ?? undefined,
      explicitTemplate: request.template,
      preferredPromptTemplateId: await this.resolvePreferredPromptTemplateId(consultation.doctorId),
    });
```

4. **⚠ Critical latent gap — mirroring the legacy path *alone* is a NO-OP.** `PromptAssemblyService.buildVariables()` only *defines* the `pre_summary_text` variable when truthy (`prompt-assembly.service.ts:252-254`), and `substituteVariables()` only injects it **if the resolved template literally contains `{pre_summary_text}`**. A repo-wide search shows the seed templates **declare** `pre_summary_text` in their `variables` map (24 hits) but **none inline-reference the `{pre_summary_text}` placeholder in their `content`**. Unlike `ner_entities` / `clinician_notes` / `attachments` / `doctor_highlights` — which each have an explicit "append the block if the template didn't consume it" fallback (`prompt-assembly.service.ts:182-209`) — **`pre_summary_text` has no such fallback**. Therefore the snapshot text will silently fail to reach the LLM unless we add that fallback. **This append-fallback is a required step, not optional** (it also repairs the same latent no-op on the legacy path).

5. **The snapshot is a single upserted `PRE_SUMMARY` row tagged in JSON.** `LiveDocumentationService.persistDurableSnapshot()` writes it via `ContextItemFactory.CreatePreSummary(...)` with `metaData = { subType: 'LIVE_SOAP_SNAPSHOT', ... }` —

```739:748:packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts
    const metaData = { subType: 'LIVE_SOAP_SNAPSHOT', lastSegmentId: session.lastSegmentId, updatedAt: payload.updatedAt };

    try {
      if (!session.snapshotEntity) {
        const entity = ContextItemFactory.CreatePreSummary(session.tenantId, session.consultationId, content, undefined, session.userId ?? 'system');
        entity.metaData = metaData;
        await this.contextItemRepository.create(entity);
```

6. **`findLatestPreSummary()` is NOT subType-aware.** It returns the newest `PRE_SUMMARY` of *any* subType (it can return a legacy case-notes pre-summary produced by `generatePreSummary()`):

```106:121:packages/domains/src/repositories/generated/core/ContextItemRepository.ts
  async findLatestPreSummary(consultationId: string): Promise<ContextItemEntity | null> {
    try {
      const model = await (this as any).db.findFirst({
        where: {
          consultationId,
          type: ContextItemType.PRE_SUMMARY,
          resourceStatus: ResourceStatusType.ENABLED,
        },
        orderBy: { createdAt: 'desc' },
      });
```
   So for the harness we must select **specifically the `LIVE_SOAP_SNAPSHOT` row**, not "the latest pre-summary". `findPreSummaries()` (returns all `PRE_SUMMARY`) sorts `createdAt: 'asc'` (`findByConsultation`, `ContextItemRepository.ts:36-39`) — so "latest wins" means taking the **last** matching row after a subType filter (or sorting desc defensively). `ContextItem.metaData` is `Json? @db.JsonB` (`consultation.prisma:75`) and `ContextItemEntity.metaData` is exposed via getter (`ContextItemEntity.ts:122-126`).

7. **Provenance must be re-resolved inside `persistDraft()` (cannot be threaded through the workflow).** The harness calls three *separate* apps/api endpoints — `assemble` (loads snapshot, injects text), `generate` (SMR), `persist_draft` (writes `SummaryMeta`). Because **no Temporal workflow change** is allowed, the consumed snapshot id cannot be carried from `assemble` → workflow → `persist_draft` (that would require editing the Python activity/workflow models). Instead `persistDraft()` independently re-resolves the same `LIVE_SOAP_SNAPSHOT` row (deterministic post-stop: the row is a single, frozen, upserted row by the time the workflow runs) and writes its id into `preSummaryIds`. Both `assemble()` and `persistDraft()` will use one shared private helper so they always agree.

8. **SMR has no dedicated prior-summary field → injection must be prompt text.** `GenerateRequest` only has `prompt` / `system_prompt` (`apps/smr/src/smr_v2/models/requests.py:21-32`). Confirms the legacy mechanism (`{pre_summary_text}` woven into the prompt) is the only channel — exactly what this plan does.

---

## 1. Files & functions to change — in edit order (layer chain)

> Order follows the rule chain Database → Domain → Service → API/template, with each step guarded by a RED test first (§2). Steps 0–3 are **required**; Step 4 is **optional/secondary**.

### Step 0 — Schema / domain provenance (VERIFY ONLY — no change)
- **`packages/database/src/prisma/db_main/consultation.prisma`** — confirm `SummaryMeta.preSummaryIds` exists (it does; finding #1). **No migration. No `db:migrate`/`db:generate`.**
- **`packages/domains/.../SummaryMetaEntity.ts` / `SummaryMetaFactory.ts`** — confirm field + factory arg exist (they do). **No change.**
- Deliverable of this step: a one-line confirmation in the ticket README change-history that Phase C is migration-free.

### Step 1 — Prompt assembly: guarantee the snapshot reaches the LLM + carry the refinement instruction
**File:** `packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts`

1a. `buildVariables()` already sets `variables.pre_summary_text` when `params.preSummaryText` is truthy (lines 252-254) — **leave as-is**.

1b. In `assemble()`, **add a `pre_summary_text` append-if-missing fallback** mirroring the existing NER/notes/attachments/highlights blocks (lines 182-209). Place it after the highlights block. The appended section header IS the "template refinement instruction" (finding #4 + scope item 2). Proposed shape:

```ts
// TASK-355 Phase C (R-6) — warm-start refinement. If the template consumed
// {pre_summary_text} the block is already present; otherwise append it under a
// refinement-instruction header. The transcript remains the source of truth:
// the model REFINES this prior draft, it does not treat it as ground truth.
const preSummaryBlock = variables.pre_summary_text ?? '';
if (preSummaryBlock && !userPrompt.includes(preSummaryBlock)) {
  userPrompt +=
    `\n\n--- PRIOR DRAFT (running SOAP note from the live session) ---\n` +
    `${preSummaryBlock}\n\n` +
    `INSTRUCTION: Refine and correct the PRIOR DRAFT above into the final note. ` +
    `Do not regenerate from scratch — preserve correct content and revise only where ` +
    `the transcript, recognized entities, or clinician notes indicate. ` +
    `The full transcript below remains the single source of truth; if the prior draft ` +
    `conflicts with the transcript, follow the transcript.`;
}
```

Notes:
- This change is **shared with the legacy summary path** (same method) — it repairs the latent no-op there too, which is acceptable and desirable (consistent behavior). Call this out in review; it is the one intentional non-harness-only side effect.
- Do **not** alter `same_day_prequel_summary` handling (out of scope).

### Step 2 — Application service: load the snapshot in `assemble()` + record provenance in `persistDraft()`
**File:** `packages/applications/src/services/consultation/harness/harness-internal.service.ts`

2a. **New private helper** `loadLiveSoapSnapshot(consultationId)` (placed beside `loadNerEntities`, lines 350-364):

```ts
/**
 * TASK-355 Phase C (R-6) — the latest live SOAP snapshot for warm-start.
 * The live session upserts ONE PRE_SUMMARY row tagged metaData.subType =
 * 'LIVE_SOAP_SNAPSHOT'. Distinct from legacy case-notes pre-summaries, so we
 * filter on subType (findLatestPreSummary is NOT subType-aware). Returns the
 * newest matching row (defensive sort: findPreSummaries is createdAt ASC).
 */
private async loadLiveSoapSnapshot(consultationId: string): Promise<ContextItemEntity | null> {
  const preSummaries = await this.contextItemRepository.findPreSummaries(consultationId);
  const snapshots = preSummaries.filter(
    (p) => (p.metaData as Record<string, unknown> | undefined)?.subType === 'LIVE_SOAP_SNAPSHOT',
  );
  if (snapshots.length === 0) return null;
  return snapshots.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
}
```
   - Uses the **existing** `findPreSummaries()` repo method → no domain-layer change required.
   - Add the `ContextItemEntity` type import from `@arcaai/domains` if not already imported (it currently is not — add it).

2b. In `assemble()`, before the `promptAssemblyService.assemble({...})` call (line 165), resolve the snapshot and pass its text:

```ts
const liveSnapshot = await this.loadLiveSoapSnapshot(consultationId);
// ...
const assembled = await this.promptAssemblyService.assemble({
  /* ...existing args... */
  preSummaryText: liveSnapshot?.content ?? undefined,   // <-- ADD (mirrors legacy)
});
```

2c. In `persistDraft()`, re-resolve the snapshot id and write provenance into `SummaryMeta` (currently the `SummaryMetaFactory.CreateSummaryMeta({...})` call at lines 222-233 omits `preSummaryIds`, so it defaults to `[]`):

```ts
const liveSnapshot = await this.loadLiveSoapSnapshot(consultationId);
const summaryMeta = SummaryMetaFactory.CreateSummaryMeta({
  /* ...existing args... */
  preSummaryIds: liveSnapshot ? [liveSnapshot.id] : [],   // <-- ADD (provenance)
});
```
   - Deterministic vs `assemble()` (finding #7): same helper, same frozen row post-stop.

**No constructor / DI / module change** — `contextItemRepository` is already injected (`harness-internal.service.ts:48`) and exposes `findPreSummaries`.

### Step 3 — Barrel / wiring
- No barrel exports change (no new files, no new exported symbols).
- No `apps/api` controller change (the `assemble` / `persist_draft` endpoints already forward to these methods; request/response DTOs are unchanged — `preSummaryText` is loaded server-side, `preSummaryIds` is written server-side).

### Step 4 — (OPTIONAL / SECONDARY) prompt-template seed refinement preamble
**File:** `packages/database/src/prisma/db_main/seed/07-prompt-template.ts`

- With Step 1 in place, injection already works for **every** template (seeded + custom) via the fallback. Editing the seed is therefore optional.
- If desired for *placement control*, add the literal `{pre_summary_text}` placeholder + a one-line refinement preamble into the SOAP `content` strings of the harness-resolved templates (the `new-patient` / `revisit` SUMMARY templates that already declare the variable). When a template embeds the placeholder, the Step-1 fallback detects the block is present and does **not** double-append (same `!userPrompt.includes(...)` guard the other blocks use).
- This is dev-seed data; applying it requires a re-seed in dev only (no migration). **Recommend deferring** unless a department wants the prior draft in a specific position.

---

## 2. TDD test list (RED first), vitest

All paths under `packages/applications/src/**/__tests__/`. Write each test, run it, watch it **fail for the right reason**, then implement the matching step.

### 2A. `PromptAssemblyService` — the append-fallback (Step 1)
**File:** `packages/applications/src/services/consultation/prompt/__tests__/prompt-assembly.service.test.ts` (extend the existing `edge cases` block; note the existing `should include preSummaryText when provided` test at lines 275-292 only covers the *placeholder-present* path).

| # | Test (RED) | Asserts |
|---|---|---|
| T1 | `appends the prior-draft block + refinement instruction when the template has NO {pre_summary_text} placeholder` (template content = `Summarize for {conversation_language}.`, pass `preSummaryText: 'S: chest pain ...'`) | `userPrompt` contains the snapshot text **and** `PRIOR DRAFT` **and** the `Refine` instruction wording **and** `source of truth`. Proves the no-op is fixed. |
| T2 | `substitutes {pre_summary_text} without duplicating the block` (template content = `Prior: {pre_summary_text}. Lang: {conversation_language}.`) | `userPrompt` contains snapshot text; does **not** contain literal `{pre_summary_text}`; does **not** contain the `--- PRIOR DRAFT` appended header (consumed by placeholder). |
| T3 | `adds no prior-draft section when preSummaryText is absent` (no `preSummaryText`) | `userPrompt` does **not** contain `PRIOR DRAFT`. Cold path unchanged. |

### 2B. `HarnessInternalService.assemble()` — snapshot injection (Step 2b)
**File:** `packages/applications/src/services/consultation/harness/__tests__/harness-internal.service.test.ts` (extend the `assemble` block). Add `findPreSummaries` to the mock context-item repo factory (`createMockContextItemRepository`, lines 60-66) — default `mockResolvedValue([])`.

| # | Test (RED) | Asserts |
|---|---|---|
| T4 | `injects the LIVE_SOAP_SNAPSHOT content as preSummaryText when a snapshot exists` — mock `findPreSummaries` → `[{ id:'ps-live-1', content:'S: chest pain O: BP 120/80', metaData:{ subType:'LIVE_SOAP_SNAPSHOT' }, createdAt: new Date() }]` | `promptAssemblyService.assemble` called with `objectContaining({ preSummaryText: 'S: chest pain O: BP 120/80' })`. |
| T5 | `omits preSummaryText when no snapshot exists (cold path still works)` — `findPreSummaries` → `[]` | `assemble` called with `preSummaryText: undefined`; result still returns `userPrompt`/`responseFormat`/`promptTemplateId` (existing assertions still pass). |
| T6 | `ignores a legacy (non-LIVE_SOAP_SNAPSHOT) pre-summary` — `findPreSummaries` → `[{ id:'ps-legacy', content:'historical notes', metaData:{ subType:'CASE_NOTES' } }]` (or `metaData: null`) | `assemble` called with `preSummaryText: undefined` (subType filter excludes it). |
| T7 | `selects the latest LIVE_SOAP_SNAPSHOT when multiple PRE_SUMMARY rows exist (latest wins)` — `findPreSummaries` → `[ {id:'ps-old', content:'old', subType LIVE_SOAP_SNAPSHOT, createdAt: t0}, {id:'ps-legacy', subType CASE_NOTES, createdAt: t2}, {id:'ps-new', content:'new', subType LIVE_SOAP_SNAPSHOT, createdAt: t1>t0} ]` | `assemble` called with `preSummaryText: 'new'` (newest snapshot by `createdAt`, legacy row ignored). |

### 2C. `HarnessInternalService.persistDraft()` — provenance (Step 2c)
**File:** same test file, `persistDraft` block.

| # | Test (RED) | Asserts |
|---|---|---|
| T8 | `records the consumed snapshot id in SummaryMeta.preSummaryIds` — `findPreSummaries` → one `LIVE_SOAP_SNAPSHOT` row id `ps-live-1` | `SummaryMetaFactory.CreateSummaryMeta` called with `objectContaining({ preSummaryIds: ['ps-live-1'] })`. (Existing `summaryMetaRepository.create` assertions unchanged.) |
| T9 | `records an empty preSummaryIds when no snapshot exists` — `findPreSummaries` → `[]` | `CreateSummaryMeta` called with `preSummaryIds: []`. Confirms cold path provenance is explicit, not undefined. |
| T10 | `latest-wins provenance matches assemble selection` — same multi-row fixture as T7 | `CreateSummaryMeta` called with `preSummaryIds: ['ps-new']` (same row id `assemble()` would inject — proves the shared-helper determinism in finding #7). |

> The existing `persistDraft` tests (lines 343-473) must keep passing unchanged: add `findPreSummaries` to the mock so the new helper call resolves; default `[]` makes pre-change tests green except for the new provenance assertions.

### 2D. Regression guard
- Re-run the **whole** `harness-internal.service.test.ts` and `prompt-assembly.service.test.ts` suites — every pre-existing test (NER injection, GAP #2 notes/attachments, GAP #5, highlights, WORM audit, PENDING_REVIEW) must stay green.

---

## 3. Quality-verification plan — draft quality must NOT degrade vs cold generation

**Goal:** prove warm-start (refinement) does not lower clinical fidelity vs cold generation, on **N = 5–10** representative consults that each produced a `LIVE_SOAP_SNAPSHOT`.

**Setup**
1. Pick N consults that ran the live pipeline to completion (so a `LIVE_SOAP_SNAPSHOT` `PRE_SUMMARY` row exists). Reuse the TASK-354 baseline run shape (`019eb9f4…`) plus a few longer, production-like transcripts (the baseline test consult is only 729 chars — include realistic length per README §2a).
2. For each consult, run the harness twice on the **same** transcript / template / model / seed:
   - **Cold** — warm-start disabled (toggle off; see rollback flag in §6, or temporarily stub `loadLiveSoapSnapshot` → `null`).
   - **Warm** — warm-start enabled.

**Which sensor scores to compare** (read from `SummaryMeta` via `getSummaryProvenance(contextItemId)` and/or the `SENSOR_RUN` WORM event written by `persistDraft`):
- **Entity-faithfulness** (`entityFaithfulnessScore`) — primary fidelity signal (are note entities actually in the transcript?). Warm must be **≥ cold** (tolerance ≤ 0.05 drop on any single consult).
- **Coverage / omission** (`coverageScore`) — are transcript entities represented? Warm must be **≥ cold**.
- **Groundedness ratio** from `guardrailDecisions` / `citationsMap` — grounded ÷ total claims, and absolute count of *ungrounded* claims. Ungrounded count must **not increase**.
- **Safety verdicts** (`guardrailDecisions.safety`) — must be **identical** (warm start changes only the generation prompt; it must not introduce new harm flags).
- **`ragTriadScore`** where retrieval is enabled — informational.

**Method / acceptance**
- Tabulate per-consult cold-vs-warm deltas for the five metrics above. **Acceptance: no consult shows a material drop** (entity-faithfulness/coverage not worse beyond tolerance; ungrounded claims not up; safety verdicts unchanged).
- Because the deterministic sensors FLAG-on-nearly-every-run on real input today (README §8: schema_validity, SentencePiece NER artifacts, zero-tolerance thresholds), **compare relative deltas, not absolute pass/fail** — the question is "did refinement make it worse than cold," not "did the gate pass."
- **Latency co-metric** (the point of R-6): capture `generate` duration from Temporal history. Expect 21 s → 4–8 s (README §5). Record it but do not let a latency win mask a fidelity loss — fidelity gates the ship decision.
- **Decision rule:** ship only if fidelity is non-degraded on **all** N; if any consult degrades, keep warm-start toggled off and investigate the refinement-instruction wording (e.g., strengthen "transcript is source of truth").

---

## 4. Build / test / lint commands

Run from repo root. Phase C is migration-free, so **no** `db:migrate` / `db:generate`.

```bash
# RED → GREEN loop, single files (fastest)
pnpm --filter @arcaai/applications exec vitest run \
  src/services/consultation/prompt/__tests__/prompt-assembly.service.test.ts
pnpm --filter @arcaai/applications exec vitest run \
  src/services/consultation/harness/__tests__/harness-internal.service.test.ts

# Full unit suite for the package (regression gate)
pnpm --filter @arcaai/applications test:unit

# Build + typecheck + lint (must be clean)
pnpm --filter @arcaai/applications build
pnpm --filter @arcaai/applications typecheck
pnpm --filter @arcaai/applications lint
```

- **ReadLints** on the two modified source files after editing.
- **No `@arcaai/domains` build/test** needed for the primary plan (no domain code changed). Only if the optional dedicated repo method is chosen (see §5) add: `pnpm --filter @arcaai/domains build && pnpm --filter @arcaai/domains test:unit`.
- **Optional seed change (Step 4)** is dev-only re-seed; not part of the CI gate.

---

## 5. Optional alternative — dedicated repository method (not required)

Instead of the in-service `findPreSummaries` + subType filter (§1 Step 2a), a subType-aware repo method could be added to `packages/domains/src/repositories/generated/core/ContextItemRepository.ts` (mirroring `findLatestPreSummary`):

```ts
async findLatestLiveSoapSnapshot(consultationId: string): Promise<ContextItemEntity | null> {
  const model = await (this as any).db.findFirst({
    where: {
      consultationId,
      type: ContextItemType.PRE_SUMMARY,
      resourceStatus: ResourceStatusType.ENABLED,
      metaData: { path: ['subType'], equals: 'LIVE_SOAP_SNAPSHOT' },  // JsonB path filter
    },
    orderBy: { createdAt: 'desc' },
  });
  return model ? (this as any)._mapper.toDomainEntity(model) : null;
}
```
**Trade-off:** indexed/efficient and self-documenting, but touches generated domain code and adds a domain test + build. Given a consult has only a handful of `PRE_SUMMARY` rows, the in-service filter is the **minimal, surgical** choice and is recommended for Phase C. Record the repo method as a fast-follow if profiling later shows it matters.

---

## 6. Safety invariants (README §7) mapped to Phase C

| # | Invariant | How Phase C preserves it |
|---|---|---|
| 1 | Gate never auto-PASSes; degraded/missing sensors ⇒ FLAG | Untouched — no sensor, aggregator, or gate code changes. Warm start only enriches the **generation prompt**. |
| 2 | Safety FLAG never regenerated away / signed past | Untouched — regen loop, aggregator `HIGHEST_HARM_SENSORS`, and sign-off path are not modified. |
| 3 | Conservative-failure directions (truncation/parse/timeout ⇒ stricter) | Preserved. A missing/failed snapshot lookup ⇒ `preSummaryText: undefined` ⇒ **cold generation** (no looser gating, no fabricated context). The lookup is read-only and additive. |
| 4 | Workflow-sequence changes ship with `workflow.patched()` + replay fixture | **N/A — and that's the point of Phase C.** Zero Temporal workflow change (finding #7), so no patch gate and no replay-safety risk (contrast TASK-348/354). |
| 5 | WORM audit truthfulness; `gate_decision` only when computed | Preserved. `preSummaryIds` is pure provenance on `SummaryMeta`; the `GENERATE`/`SENSOR_RUN`/`GATE_DECISION` WORM events and their timing are unchanged. |
| — | **Sensors verify against the FULL FINAL TRANSCRIPT (assurance semantics unchanged)** | **Explicit:** `assemble()` still appends the full transcript unconditionally (`prompt-assembly.service.ts:178-180`); the harness `run_sensors` / `run_inferential_sensors` evaluate the generated note against `transcript_text` (the full final transcript) and the note's own entities — neither reads `pre_summary_text`. The snapshot influences **only** how the draft is produced, never how it is verified. Attestation still hashes final content; the inferential gate is byte-for-byte the same. |

---

## 7. Risks + rollback

| ID | Risk | Likelihood / Impact | Mitigation |
|---|---|---|---|
| K1 | **Mirroring legacy alone is a no-op** (templates lack `{pre_summary_text}`, no fallback) → warm start silently does nothing | High if missed / Med | Step 1 append-fallback is **required**; T1 asserts the snapshot text reaches `userPrompt`. |
| K2 | **Wrong pre-summary selected** (legacy case-notes pre-summary picked instead of live snapshot) | Med / Med | subType filter on `LIVE_SOAP_SNAPSHOT`; T6/T7 lock it in. |
| K3 | **assemble/persistDraft disagree** on which row was consumed (two reads) | Low / Low | Single shared helper `loadLiveSoapSnapshot`; row is frozen post-stop; T10 asserts agreement. |
| K4 | **Draft quality regression** — model over-anchors on a stale/incomplete snapshot and propagates its errors | Med / High (clinical) | Refinement instruction makes the transcript the source of truth; §3 quality gate compares sensor scores cold-vs-warm and **blocks ship on any degradation**. This is the README "Low–Med risk" for R-6. |
| K5 | **Prompt bloat / context-window pressure** (snapshot + full transcript + NER + notes + highlights) | Low / Low | Snapshot is a bounded running SOAP (~≤1.5 k tokens, `LIVE_DOC` `max_tokens=1500`); monitor prompt size in the §3 runs; transcript already dominates. |
| K6 | **PHI exposure** | Low / — | Snapshot is same-consultation PHI already within the harness boundary; tenant-scoped repository reads enforce isolation; no new external surface. |

**Rollback (additive & reversible — no schema to revert):**
1. Cleanest: stop passing `preSummaryText` in `assemble()` and `preSummaryIds` in `persistDraft()` (revert the two service edits). The Step-1 fallback then has nothing to inject and is inert.
2. Recommended rollout guard (optional, low-risk): gate `loadLiveSoapSnapshot()` behind a flag (e.g. `HarnessPolicy` knob or `HARNESS_WARM_START_ENABLED` env) so warm-start can be toggled per-tenant without a redeploy — useful for the §3 cold/warm A/B and for an instant kill-switch if K4 surfaces in production. If adopted, default it **on** only after §3 passes.
3. `preSummaryIds` already-written rows need no cleanup — they are inert provenance and valid for any path.

---

## 8. Definition of done (Phase C)
- [x] T1–T10 written RED, then GREEN; full `@arcaai/applications` unit suite passes (evidence pasted).
- [x] `build` + `typecheck` + `lint` clean for `@arcaai/applications`; ReadLints clean on the 2 modified files.
- [ ] §3 quality run on N≥5 consults shows **no** entity-faithfulness/coverage/groundedness/safety degradation warm-vs-cold; `generate` latency improvement recorded. **(still blocked — dev stack; never run.)**
- [x] No Temporal workflow change; no migration (confirmed).
- [x] Ticket README updated: Implementation Summary (files changed, the latent-no-op fix, provenance), Change History entry, status → appropriate.
