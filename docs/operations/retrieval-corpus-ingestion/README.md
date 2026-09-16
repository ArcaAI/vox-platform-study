# Retrieval Corpus Ingestion — owner-run tier-enablement runbook

An owner-run runbook (do not execute in CI or automation) for ingesting a licensed guideline
corpus into the harness institutional-RAG store and flipping `HARNESS_RETRIEVAL_ENABLED` per
tenant, one controlled change at a time. The engineering for retrieval already shipped (the
`retrievalEnabled` `HarnessPolicy` knob and its `HARNESS_RETRIEVAL_ENABLED` env fall-through, plus
hybrid retrieval) — this is the operational procedure to populate the corpus and enable the flag.
Corpus ingestion and tenant enablement are owner actions, gated on licensing and a harness-eval
scorecard.

## Layout

This directory holds only this file.

## How it works

### Preconditions

- License cleared for each corpus (see the candidates table below) — no corpus goes in without a
  documented license grant.
- Qdrant reachable; the `knowledge_chunks` collection exists with the expected shape
  (`infrastructure/docker/scripts/init-qdrant-collections.py`).
- Embeddings backend (self-hosted, `/v1/embeddings`) up — queries can carry PHI, so embedding
  never leaves the box.
- Reranker (HF TEI cross-encoder) reachable for query-time rerank.
- The flag is OFF everywhere (`HARNESS_RETRIEVAL_ENABLED=false`, the default) before you start.

### Corpus candidates (license-gated)

| Corpus | Content | License note |
|---|---|---|
| PMC-OA (PubMed Central Open Access) | Peer-reviewed full text | OA subset only; respect per-article CC terms |
| CDC guidance | Public-health guidelines | US-gov public domain — verify per document |
| ICD-11 | Diagnostic classification | WHO license terms apply |

Each ingested document becomes a `KnowledgeDocument` (`packages/database/src/prisma/db_main/knowledge.prisma`)
that must reach `APPROVED` status before it is queryable — retrieval filters on `status=APPROVED`
and `tenant_id` on both prefetch branches, the load-bearing tenant-isolation and approval gate.

### Ingestion path (write side)

Ingestion is not a destructive/DB-migration operation — it chunks, embeds (dense + sparse), and
upserts Qdrant points with a stable `uuid5(tenant, document, chunkIndex)` id, so re-ingest is
idempotent.

Production flow (preferred): create a `KnowledgeDocument`, move it to `APPROVED`; the `apps/api`
`IngestKnowledgeDocument` BullMQ processor
(`packages/applications/src/services/knowledge/ingest-knowledge-document.processor.ts`) then calls
the harness write endpoint:

```
POST /api/v1/internal/knowledge/ingest   # apps/harness/src/harness/api/endpoints/knowledge.py
  -> chunk -> dense+sparse embed -> Qdrant upsert (knowledge_chunks)
```

Direct/back-fill (owner, per-tenant, staging first):

1. Stage the licensed corpus files for one pilot tenant.
2. Drive `POST /api/v1/internal/knowledge/ingest` per document (or enqueue via the
   approved-document processor). Idempotent — safe to retry.
3. Verify point counts in Qdrant and spot-check that a `hybrid_query` returns only
   `status=APPROVED`, tenant-scoped chunks.

### Flag-flip matrix (one flip per change, each with a gate)

Enable retrieval per tenant, one accuracy lever at a time. Each row is a separate change whose
gate is a streaming scorecard or a harness-eval re-run on the golden set — never batch multiple
flips.

| # | Lever | Knob / env | Gate before flip ON |
|---|---|---|---|
| 1 | Institutional RAG (pilot tenant) | `retrievalEnabled` policy knob / `HARNESS_RETRIEVAL_ENABLED` | harness-eval faithfulness/citation delta >= 0 on golden set |
| 2 | ~~Sortformer diarization (staging)~~ — **backend retired by TASK-980 (2026-09-16)**; embedding diarization labels only | ASR agent `audioFrontEnd.diarization` | Streaming scorecard (WER/DER held) |
| 3 | MiniCheck GGUF entailment paths | sensor config | harness-eval AC-6 re-baseline |
| 4 | Atomic-fact verifier ON | `atomic-fact` extra + flag | harness-eval faithfulness delta |
| 5 | Warm-start / NER-priors ON | harness config | harness-eval + latency check |
| 6 | Optimistic delivery ON | gate config | harness-eval regen/flag rates held |
| 7 | Claim-check `store=s3` | claim-check config | storage/retention verified |

### Verification after each flip

- Retrieval returns tenant-scoped, `APPROVED`-only chunks (no cross-tenant bleed).
- Hallucinated or never-retrieved `[[kb:<chunkId>]]` ids are dropped by `extract_cited_ids`
  (cannot reach `citationsMap` or the citation-verify sensor).
- harness-eval / streaming scorecard is recorded as the flip's evidence.

## Gotchas

- **Never run `migrate reset` / DROP / TRUNCATE against Qdrant or Postgres as part of ingestion.**
  Re-ingest is idempotent by point id; to remove content, retire the `KnowledgeDocument` through
  its normal lifecycle instead.
- Each lever is additive and degrade-safe. Set the knob/env back to its default (`false`) to
  disable; an embeddings/Qdrant/reranker outage already yields an empty context (`degraded=True`)
  and flags reduced assurance — it never breaks the loop.

## Related

- [`../../../.claude/rules/06-python-services.md`](../../../.claude/rules/06-python-services.md) — the harness/Temporal and per-tenant config rules governing this surface
- [`../../architecture/consultation-session-workflow/assessment/README.md`](../../architecture/consultation-session-workflow/assessment/README.md) — the consultation-vertical codebase assessment, including the harness/retrieval path

### Change History
- 2026-07-19 — Initial runbook (this doc plus the flag-flip matrix). Corpus licensing, ingestion execution, and per-tenant enablement remain owner-run.
