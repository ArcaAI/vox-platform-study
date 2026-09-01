# TASK-843 — AI Task Taxonomy Unification (Phase 1)

| Field | Value |
|---|---|
| **Status** | `Review` — Phase 1 complete in worktree `worktree-agent-ac993242a195bd683`, NOT merged |
| **Type** | `refactor` (schema-bearing), strictly ADDITIVE |
| **Parent program** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) §4 |
| **Target branch** | `dev-2.2` (orchestrator merges) |
| **Blocks** | TASK-844, TASK-845, all of Track D (OD-4) |
| **Date** | 2026-09-01 |

---

## 1. Requirement Analysis

The product requires **one configuration per task** across four tasks: text generation,
translation, speech-to-text, text-to-speech. Finding F-9 established that a task taxonomy existed
for **text generation only**; the other three routed through unrelated mechanisms:

| Task | Mechanism before this ticket |
|---|---|
| text generation | `AiTaskDefault.taskKey` → `modelSlug` |
| translation | **none at all** |
| speech-to-text | `AsrPipeline` + `TenantSttConfig` |
| text-to-speech | `TenantTtsConfig` |

Phase 1 creates the taxonomy and stamps it onto the rows that carry provider bindings. It
**retires nothing and changes no resolver**, so a mistake stays recoverable (program §4, TASK-843
step 3). Phase 2 (TASK-844) migrates readers and retires the three legacy mechanisms.

Owner decision **OD-8** bounds the translation half: Azure OpenAI has no text-translation
endpoint (`/audio/translations` is Whisper audio→English), so translation is served only by a
provider with a native endpoint — Sarvam, with explicit `ml-IN`. No Azure AI Translator provider
is added. `TRANSLATION` is declared as a task; it simply has no rows yet.

---

## 2. Current State Evaluation

### 2.1 The task-key vocabulary is 19 strings, not "text generation only"

`AI_TASK_KEYS` (`packages/applications/src/services/ai-task-default/constants.ts`) declares
**17** keys, and two more (`nlp.topic`, `nlp.intent`) live in
`tenant-nlp-task-instructions/constants.ts` whose own comment confirms their model selection
*"still resolves through `AiTaskDefault`"*. The seed creates **12** SYSTEM rows.

Of those 12, only **4** are text generation (`text.live`, `text.finalize`, `text.test`,
`harness.judge`). The other 8 are guardrail and NLP selections.

> **Deviation from the brief, recorded.** The ticket brief instructed "every existing
> `AiTaskDefault` row → `TEXT_GENERATION`". Applied literally that would have **mislabelled 8 of
> the 12 seeded rows** — writing `TEXT_GENERATION` onto `nlp.ner`, `guardrail.pii`,
> `guardrail.groundedness` and five siblings. The brief's own guard-rail ("embeddings, guardrail
> classification and NER already exist elsewhere and must not be silently swallowed; survey what
> exists before you fix the value set") is what this deviation honours. The backfill is therefore
> **derived per row from `taskKey`**, not a constant.

### 2.2 Two taxonomies already touch the word "task", and neither can serve as this axis

| Enum | What it answers | Why it cannot be reused |
|---|---|---|
| `ModelTaskType` (`enums.prisma:95`, 47 members) | What SHAPE of artifact a model is — the HuggingFace pipeline-tag vocabulary, a property of `AiModel` | It is **many-to-one** with task keys: `TOKEN_CLASSIFICATION` serves both `nlp.ner` and `guardrail.pii`; `TEXT_CLASSIFICATION` serves four more. Keying selection on it would merge bindings that are different models under different governance. It is also parity-gated member-for-member against a Python mirror (`apps/stt/tests/unit/test_db_enum_mirrors.py`), so growing it drags an unrelated service |
| `AiCapability` (`enums.prisma:490`, 5 members) | What a usage-ledger row is BILLED under | Deliberately coarse — its own comment records that guardrail and harness LLM calls meter under `LLM`. "The translation model" is not expressible |

The existence of `AI_TASK_MODEL_TASK_TYPES` — a hand-maintained many-to-one map from task key to
`ModelTaskType` — is itself the proof the two are different axes. You do not write a map between
a thing and itself.

A third enum was therefore justified, and the justification is recorded in the enum's own doc
comment so the next reader does not re-litigate it.

### 2.3 Other capability vocabularies surveyed (and deliberately not folded in)

- `AiProviderConnection.service` — a plain TEXT column with a TS-owned vocabulary
  `ProviderService = 'llm' | 'stt' | 'tts' | 'embeddings' | 'rerank' | 'vector' | 'model-registry'`.
  Overlaps partially; `vector` and `model-registry` are infrastructure connections, not AI tasks.
- `ModelCategory`, `ModelType`, `AiModelFormat`, `AiModelSource` — artifact properties.
- `apps/stt/src/stt/pipeline/dto.py:9-18` — a Python-local 6-member subset of `ModelTaskType`
  containing `AUDIO_DENOISING`, which **has no Prisma counterpart**. Pre-existing, undocumented
  drift; out of scope, reported.

---

## 3. Implementation

### 3.1 The taxonomy

`enum AiTaskKind` in `packages/database/src/prisma/db_main/enums.prisma`, mirrored to
`packages/domains/src/enums/generated/AiTaskKind.ts` by `pnpm gen:model`.

| Member | Bound task keys |
|---|---|
| `TEXT_GENERATION` | `text.live`, `text.finalize`, `text.live.fallback`, `text.finalize.fallback`, `text.test`, `harness.judge` |
| `TRANSLATION` | *(none yet — Sarvam native endpoint, OD-8)* |
| `SPEECH_TO_TEXT` | `AsrPipeline`, `TenantSttConfig` rows |
| `TEXT_TO_SPEECH` | `TenantTtsConfig` rows |
| `VISION_EXTRACTION` | `vlm.extract` |
| `EMBEDDING` | *(none yet — `ProviderService = 'embeddings'`, `AiCapability.EMBEDDING`)* |
| `NAMED_ENTITY_RECOGNITION` | `nlp.ner` |
| `TEXT_CLASSIFICATION` | `nlp.classification`, `nlp.diagnosis`, `nlp.sentiment`, `nlp.toxicity`, `nlp.topic`, `nlp.intent` |
| `CONTENT_SAFETY` | `guardrail.validate`, `guardrail.safety` |
| `GROUNDEDNESS` | `guardrail.groundedness` |
| `PII_DETECTION` | `guardrail.pii`, `guardrail.pii.spans` |

Every one of the 19 live task keys maps; nothing is swallowed.

**Deliberately absent**, because nothing *selects* them and a member would promise a binding
surface that does not exist: `RERANK` (the TEI reranker on :8870, `ProviderService = 'rerank'`)
and the `vector` / `model-registry` provider services. Postgres enums extend with
`ALTER TYPE … ADD VALUE` when a selection surface appears.

**Granularity is deliberately coarser than `taskKey`.** `text.live` and `text.finalize` are one
KIND and two SELECTIONS.

### 3.2 Columns

| Model | Column | Shape | Why |
|---|---|---|---|
| `AiTaskDefault` | `taskKind AiTaskKind?` | nullable + backfilled + `@@index([tenantId, taskKind])` | Derived per row from `taskKey`. Nullable because Phase 1 changes no writer: a row created by an un-migrated writer must land "unclassified", not a plausible-but-wrong `TEXT_GENERATION` |
| `AiRoutingPolicy` | `taskKind AiTaskKind?` | same | It is TASK-844's absorption target (OD-3); carrying the discriminator on both sides makes the fold a column-to-column move |
| `AsrPipeline` | `taskKind AiTaskKind @default(SPEECH_TO_TEXT)` | NOT NULL + default | Constant for the table. A new row cannot be wrong, and `db push` fills existing rows correctly with no data step |
| `TenantSttConfig` | `taskKind AiTaskKind @default(SPEECH_TO_TEXT)` | same | same |
| `TenantTtsConfig` | `taskKind AiTaskKind @default(TEXT_TO_SPEECH)` | same | same |

The three constant columns are redundant today, deliberately: they are the **migration seam** that
turns TASK-844's five-source fold into one `UNION` instead of three bespoke mappings.

### 3.3 The mapping, declared once and pinned twice

`AI_TASK_KIND_BY_TASK_KEY: Record<AiTaskKey, AiTaskKind>` +
`resolveAiTaskKind(taskKey): AiTaskKind | null` in
`packages/applications/src/services/ai-task-default/constants.ts`. The exhaustive `Record` makes
adding a task key without deciding its kind a **compile error** — the same enforcement
`AI_TASK_MODEL_TASK_TYPES` already relies on.

`resolveAiTaskKind` returns `null` for an unknown key rather than guessing, and the SQL backfill
takes the same position (`ELSE NULL`). Selection is `failMode: 'closed'` platform-wide, so
"nobody classified this" must stay distinguishable from "classified as X".

The migration SQL hand-writes the same mapping. `ai-task-kind.test.ts` **reads the migration file
and fails on drift** — verified by deliberately drifting one arm and watching it go RED (§5).

### 3.4 Nothing else changed

No resolver, no service, no seed, no controller, no allow-list. `TENANT_SCOPED_MODELS`,
`SYSTEM_SHARED_READ_MODELS`, `MODELS_WITHOUT_SOFT_DELETE` and `ResourceType` are untouched — no
model was added, so none applies. `pnpm gen:mapper` was **not** run (destructive); the mappers are
fully automatic (`AutoClassMapper`) and needed no edit.

---

## 4. Findings for TASK-844

### F-843-A — the proposed `(tenantId, taskKind) WHERE isDefault` index would lose data

Program §4 TASK-844 step 2 calls for a partial unique index on `(tenantId, taskKind)`. Because
`taskKind` is **coarser** than `taskKey`, that index would permit only one default per KIND and so
collapse:

- `text.live` with `text.finalize` — two live, separately-configurable generation selections today;
- `nlp.ner` with `guardrail.pii` — both `TOKEN_CLASSIFICATION`, different models, different
  governance (`guardrail.pii` is in `SUPER_ADMIN_ONLY_TASK_KEYS`).

**The "one default per task" constraint must key on the SELECTION (`taskKey`), or on
`(taskKey, taskKind)` — never on `taskKind` alone.** This is recorded in the enum's doc comment
and pinned by a test so it cannot be discovered the hard way.

### F-843-B — `nlp.topic` / `nlp.intent` are undeclared task keys

They select models through `AiTaskDefault` but are absent from `AI_TASK_KEYS`, so
`assertKnownTaskKey` rejects them on every admin route and no `models.*` descriptor exists. This
ticket classifies them (in a separate, documented map) without widening `AI_TASK_KEYS` — widening
it is an owner-facing decision about who may configure them. Same shape as the closed TASK-799 R6
gap.

### F-843-C — `AUDIO_DENOISING` exists in Python, not in Prisma

`apps/stt/src/stt/pipeline/dto.py:9-18` declares a `ModelTaskType` member with no Prisma
counterpart. Pre-existing drift, unrelated to this ticket, not fixed here.

---

## 5. Verification (actual output)

### Migration drift proof

```
$ npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script
Loaded Prisma config from prisma.config.ts.
-- This is an empty migration.
```

### Backfill row counts, against a ledger-replayed + seeded shadow DB

BEFORE:

```
      table      | total | with_taskkind | null_taskkind
-----------------+-------+---------------+---------------
 AiRoutingPolicy |     0 |             0 |             0
 AiTaskDefault   |    12 |             0 |            12
 AsrPipeline     |    46 |            46 |             0
 TenantSttConfig |     1 |             1 |             0
 TenantTtsConfig |     0 |             0 |             0
```

Backfill:

```
UPDATE 12
UPDATE 0
NOTICE:  TASK-843 backfill complete. 0 row(s) carry an unrecognised taskKey and were left NULL (fail-closed).
```

AFTER:

```
      table      | total | with_taskkind | null_taskkind
-----------------+-------+---------------+---------------
 AiRoutingPolicy |     0 |             0 |             0
 AiTaskDefault   |    12 |            12 |             0
 AsrPipeline     |    46 |            46 |             0
 TenantSttConfig |     1 |             1 |             0
 TenantTtsConfig |     0 |             0 |             0

        taskKey         |         taskKind
------------------------+--------------------------
 guardrail.safety       | CONTENT_SAFETY
 guardrail.validate     | CONTENT_SAFETY
 guardrail.groundedness | GROUNDEDNESS
 nlp.ner                | NAMED_ENTITY_RECOGNITION
 guardrail.pii          | PII_DETECTION
 guardrail.pii.spans    | PII_DETECTION
 nlp.classification     | TEXT_CLASSIFICATION
 nlp.diagnosis          | TEXT_CLASSIFICATION
 harness.judge          | TEXT_GENERATION
 text.finalize          | TEXT_GENERATION
 text.live              | TEXT_GENERATION
 text.test              | TEXT_GENERATION
```

Total row counts are **identical before and after** on all five tables — the backfill classifies,
it never creates or drops.

### Generator gates

```
gen:model:check    check: no drift — 180 generated file(s) match the committed files.
gen:entity:check   check: no drift — 103 generated file(s) match the committed files.
                   Schema coverage OK: 101 entity artifact(s) cover every persisted column of 105 Prisma model(s)
gen:factory:check  check: no drift — 103 generated file(s) match the committed files.
                   Schema coverage OK: 101 factory artifact(s) cover every persisted column of 105 Prisma model(s)
```

### Suites

```
@arcaai/database    Test Files  73 passed (73)          Tests  1750 passed (1750)
@arcaai/domains     build: tsc clean
@arcaai/domains     Test Files  158 passed | 2 skipped (160)   Tests  1874 passed | 2 skipped | 9 todo (1885)
@arcaai/applications Test Files 624 passed | 1 skipped (625)   Tests  10643 passed | 4 skipped (10647)
```

### The drift guard was seen RED

```
### RED: drift guardrail.groundedness GROUNDEDNESS -> TEXT_CLASSIFICATION in the SQL only
 × ... > agrees with the SQL backfill in the TASK-843 migration
      Tests  1 failed | 8 passed (9)

### Restore and re-run
 ✓ ... > agrees with the SQL backfill in the TASK-843 migration
      Tests  9 passed (9)
```

### Lint

`@arcaai/domains` and `@arcaai/applications`: **0 errors**. All warnings are the pre-existing
`eslint-comments/require-description` on generated-file `eslint-disable` headers. The two files
this ticket authored in `packages/applications` lint clean. `@arcaai/database` has no `lint`
script.

---

## 6. Files Changed

**Schema (`packages/database/src/prisma/db_main/`)** — `enums.prisma` (new `AiTaskKind`),
`ai-task-default.prisma`, `ai-routing-policy.prisma`, `stt.prisma` (`AsrPipeline`),
`tenant-stt-config.prisma`, `tenant-tts-config.prisma`;
`migrations/20260901051803_task_843_ai_task_taxonomy/migration.sql` (new).

**Domain (`packages/domains/src/`)** — `enums/generated/AiTaskKind.ts` (new) + barrel;
`models/generated/core/{AiTaskDefault,AiRoutingPolicy,AsrPipeline,TenantSttConfig,TenantTtsConfig}Model.ts`
(regenerated); the five matching `entities/generated/core/*Entity.ts` and
`factories/generated/core/*Factory.ts` (hand-authored);
`mappers/generated/core/__tests__/AiTaskDefaultEntityMapper.test.ts` (fixture gains the column).

**Applications (`packages/applications/src/services/ai-task-default/`)** — `constants.ts`
(`AI_TASK_KIND_BY_TASK_KEY`, `resolveAiTaskKind`); `__tests__/ai-task-kind.test.ts` (new).

**Docs** — this README; `backfill-dev-db.sql`.

---

## 7. Orchestrator Handoff

Deliberately **not done** by this worktree (shared surfaces belong to the orchestrator):

1. `pnpm db:push` against the dev DB.
2. **Then run `backfill-dev-db.sql`** (this directory). The dev DB is `db push`-managed, so it
   applies schema but no migration body: `AsrPipeline` / `TenantSttConfig` / `TenantTtsConfig`
   come out correct from their column defaults, but `AiTaskDefault` and `AiRoutingPolicy` land
   NULL without this step. The script is idempotent and prints a count report.
3. Drop the shadow database `hope_shadow` (still present, migrated and seeded).
4. Merge `worktree-agent-ac993242a195bd683` into `dev-2.2` and re-run the gates after the merge.

The seed was deliberately **not** changed to set `taskKind`. Phase 1 changes no writer, and adding
the mapping to the seed would make a third copy of it. TASK-844 sets it at the writer
(`AiTaskDefaultService.upsertRow`), which is where the seed's own value should then come from.

---

## 8. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Phase 1 implemented in worktree `worktree-agent-ac993242a195bd683`. Taxonomy defined (11 members), `taskKind` added to 5 models, migration `20260901051803_task_843_ai_task_taxonomy` authored and verified against a shadow DB with zero drift. Backfill derived per row from `taskKey` — a documented deviation from the brief's blanket `TEXT_GENERATION`, which would have mislabelled 8 of 12 seeded rows. F-843-A raised against TASK-844's proposed unique index. Not merged. |
