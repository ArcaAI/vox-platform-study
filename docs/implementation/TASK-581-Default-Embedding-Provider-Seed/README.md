# TASK-581 — Default Text/RAG Embedding Provider Seed

- **Status**: Pending (Discovery-gated — may resolve to "no gap")
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

_(fill on completion — Discovery conclusion first)_

## Change History

- 2026-07-28 — Ticket created from the Provider-Plane Day-1 Defaults audit (finding F5). Status Pending, Discovery-gated.
