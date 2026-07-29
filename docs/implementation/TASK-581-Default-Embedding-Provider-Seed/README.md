# TASK-581 — Default Text/RAG Embedding Provider Seed

- **Status**: Review — closed as non-gap, no code change
- **Type**: infrastructure (seed) — investigate-then-seed
- **Tier**: sonnet-5-xhigh (seed-file addition following the existing `AiModel` pattern)
- **Program**: [Provider-Plane Day-1 Defaults](../SOTA-Track/2026-07-28-provider-plane-day1-defaults-followups.md) — finding **F5**

## Requirement Analysis

The Day-1 built-in set is expected to include a general **text/RAG embedding** provider. The audit found only diarization `SPEAKER_EMBEDDING` models seeded; the `FEATURE_EXTRACTION` / `SENTENCE_SIMILARITY` model-task enum values (`enums.prisma:131,135`) have **no seed row**. If knowledge/RAG features need a Day-1 text embedder, it is missing; if embedding is served entirely by the RAG-profile TEI service without needing an `AiModel`/connection catalog row, this is a **non-gap** and the ticket closes as "documented, no change."

## Current State Evaluation (to confirm in Discovery)

- Infra note (`09-infrastructure-devops.md`): the `rag` compose profile runs a **TEI reranker** (`:8870`, default via `infra:up`); the `inference` profile adds a **TEI embed** service. So an embedding *endpoint* exists at the infra tier.
- Open question: does any application/harness/RAG code resolve an **embedding model/provider from the DB catalog** (`AiModel` where `taskType ∈ FEATURE_EXTRACTION|SENTENCE_SIMILARITY`, or an `AiProviderConnection`/`AiTaskDefault` row), or does it call the TEI endpoint directly via env/config? The answer decides whether a seed row is needed.

## Implementation Plan

### Phase A — Discovery (decides scope)

1. Grep the codebase (harness, applications, `06-stt`/`ai-models`, guardrail groundedness which uses MiniCheck) for consumers of `FEATURE_EXTRACTION`/`SENTENCE_SIMILARITY`, "embedding", "embed", TEI, Qdrant vectorization. Determine: **is there a DB-catalog lookup for a text embedder that currently returns empty?**
2. Record the finding in the Implementation Summary. If no DB lookup exists → **close as non-gap** (add a one-line note to the traceability doc that embedding is infra-tier TEI, not catalog-tier) and stop.

### Phase B — Seed (only if Discovery finds a real DB-catalog gap)

3. **RED** — extend `seed/__tests__/ai-model-consolidation-seed.test.ts` (or a sibling) to assert a SYSTEM `AiModel` row exists with `taskType = FEATURE_EXTRACTION` (or `SENTENCE_SIMILARITY`), `provider = 'built-in'`, pointing at the platform TEI embedder (e.g. a BGE/GTE/e5 model matching what the `inference`/`rag` profile actually runs — confirm the exact model id in Discovery). Run → fails.
4. **GREEN** — add the embedding `AiModel` entry to the appropriate `seed/ai-models/*.ts` list (new `embedding.ts` or extend an existing file), following the `AiModelSeed` shape (`shared.ts:98-122`): `name`, `slug`, `category`, `taskType`, `modelType`, `source`, `sourceUri`, `provider:'built-in'`, `tags`, `resourceStatus`. It is cloned to the default tenant by the existing `backfillCustomerTenantAiModels` path (`06-stt.ts:1418`).
5. If a task-default binding is needed (a `*.embedding` taskKey), add it to `seed/16-ai-task-default.ts` — only if a resolver consumes it (from Discovery).
6. Reseed a throwaway test DB; `psql` SELECT proving the embedding row(s); idempotent re-seed.

## TDD Test List (RED first — Phase B only)

- Seed test: SYSTEM `AiModel` FEATURE_EXTRACTION/SENTENCE_SIMILARITY row present, `provider='built-in'`.
- (If applicable) task-default binding present and resolves.
- Idempotent re-seed (row count stable).

## Verification Criteria (Definition of Done)

- [ ] Discovery conclusion recorded: **gap** (seed added) or **non-gap** (documented, closed).
- [ ] If seeded: `pnpm --filter @arcaai/database test` green; `psql` proof; matches the model the TEI profile actually runs.
- [ ] Traceability note added either way so the audit does not re-flag embedding.

## Implementation Summary

**Discovery conclusion: NON-GAP. No `AiModel` seed row added, no code change.**

Phase A discovery (2026-07-28, `thuynh/2607`) grepped the whole codebase (excluding
concurrent-agent worktrees under `.claude/worktrees/`) for consumers of a text/RAG
embedding model resolved from the DB catalog:

1. **`FEATURE_EXTRACTION` / `SENTENCE_SIMILARITY`** (`enums.prisma:131,135`) appear only in
   the enum declaration itself and its Python mirror (`apps/stt/src/stt/core/database/models.py`,
   `apps/stt/tests/unit/test_db_enum_mirrors.py`) — no service/repository queries `AiModel` by
   either task type.
2. **The extensible per-task-default registry has no embedding task key.**
   `AI_TASK_KEYS` / `AI_TASK_MODEL_TASK_TYPES` in
   `packages/applications/src/services/ai-task-default/constants.ts` list exactly nine keys
   (`guardrail.*`, `nlp.*`, `smr.*`, `harness.judge`) — none maps to `FEATURE_EXTRACTION` or
   `SENTENCE_SIMILARITY`. `seed/16-ai-task-default.ts` seeds rows only for those nine keys.
   There is no resolver anywhere that would consume an embedding task-default binding, so
   step 5 of the plan (task-default binding) does not apply either.
3. **The one real text-embedding consumer is `apps/harness`'s institutional-RAG retriever**
   (`RetrievalConfig` in `apps/harness/src/harness/core/config.py` →
   `EmbeddingsClient` in `apps/harness/src/harness/services/embeddings_client.py`). It resolves
   its endpoint (`embeddings_base_url`, default `http://localhost:1234/v1`) and model id
   (`embeddings_model`, default `text-embedding-bge-m3`) entirely from
   `HARNESS_RETRIEVAL_EMBEDDINGS_*` env vars (pydantic-settings, `env_prefix="HARNESS_RETRIEVAL_"`)
   — never from `AiModel`, `AiProviderConnection`, or `AiTaskDefault`. Same pattern for the
   HF TEI cross-encoder reranker (`reranker_base_url`, default `:8870`, matching the `rag`
   compose profile's TEI reranker port documented in `09-infrastructure-devops.md`).
4. Grepped `packages/applications`/`packages/domains`/`apps/api` for any other `embedding`
   reference: the only hits are `UserVoiceProfile` (speaker-embedding diarization, a
   different `ModelTaskType.SPEAKER_EMBEDDING` already seeded in `seed/ai-models/audio.ts`)
   and the institutional-RAG `KnowledgeChunk` entity (storage of the resulting vectors, not
   provider/model selection).

**Conclusion:** text/RAG embedding is served entirely at the infra tier (self-hosted
LM Studio `/v1/embeddings` + HF TEI reranker, both env-configured connection identity per
the Configuration-Tiers rule in `09-infrastructure-devops.md`), with no DB-catalog lookup
anywhere in the codebase that currently returns empty. Seeding an `AiModel` row for
`FEATURE_EXTRACTION`/`SENTENCE_SIMILARITY` would be inert — no resolver would ever read it —
so Phase B (seed) does not apply. This is a documented non-gap, not a missing Day-1 default.

Per the plan, closed at Phase A: no `seed/ai-models/*.ts` edit, no `seed/16-ai-task-default.ts`
edit, no migration, no test added. A one-line non-gap note was added to
`docs/traceability/ai-models-providers.md` (§ "Honest notes / gaps") so a later audit does
not re-flag this finding without first confirming a new resolver actually reads an embedding
row from the catalog.

**Files touched:**
- `docs/traceability/ai-models-providers.md` (new "Honest notes / gaps" bullet)
- `docs/implementation/TASK-581-Default-Embedding-Provider-Seed/README.md` (this file)

**Verification:** N/A for a doc-only, no-code-change closure — no `pnpm --filter @arcaai/database test`
run needed since nothing in `packages/database` changed; no seed reseed/psql proof required
(Phase B was not entered).

## Change History

- 2026-07-28 — Ticket created from the Provider-Plane Day-1 Defaults audit (finding F5). Status Pending, Discovery-gated.
- 2026-07-28 — Phase A Discovery run on `thuynh/2607`. Conclusion: **non-gap**. No DB-catalog
  consumer for a text embedder exists anywhere (`AI_TASK_KEYS` has no embedding key; harness's
  `EmbeddingsClient`/`RetrievalConfig` resolve endpoint+model from
  `HARNESS_RETRIEVAL_EMBEDDINGS_*` env vars only). Closed without a seed change; added a
  one-line note to `docs/traceability/ai-models-providers.md` so the audit does not re-flag
  it. Status set to Review — closed as non-gap, no code change.
