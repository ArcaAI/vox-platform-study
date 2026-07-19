# Retrieval Corpus Ingestion & Tier-Enablement Runbook (TASK-520)

**Status:** Runbook (owner-run — do not execute in CI or automation)
**Owners:** Platform + Clinical Content owner
**Scope:** Ingest a licensed guideline corpus into the harness institutional-RAG store
and flip `HARNESS_RETRIEVAL_ENABLED` per tenant, one controlled change at a time.

> The **engineering** for retrieval already shipped (TASK-511 policy knob
> `retrievalEnabled` + `HARNESS_RETRIEVAL_ENABLED` env fall-through; TASK-330 §2.6
> hybrid retrieval). This runbook is the **operational** procedure to populate the
> corpus and enable the flag. Corpus ingestion + tenant enablement are **owner
> actions**, gated on licensing and a harness-eval / TASK-470 scorecard.

---

## 0. Preconditions

- [ ] **License cleared** for each corpus you intend to ingest (see §1). No corpus goes
      in without a documented license grant.
- [ ] Qdrant reachable; `knowledge_chunks` collection exists with the expected shape —
      `infrastructure/docker/scripts/init-qdrant-collections.py`.
- [ ] Embeddings backend (self-hosted LM Studio `/v1/embeddings`) up — queries can carry
      PHI, so embedding **never leaves the box**.
- [ ] Reranker (HF TEI cross-encoder) reachable for query-time rerank.
- [ ] Flag currently **OFF** everywhere (`HARNESS_RETRIEVAL_ENABLED=false`, the default).

## 1. Corpus candidates (license-gated)

| Corpus | Content | License note |
|---|---|---|
| **PMC-OA** (PubMed Central Open Access) | Peer-reviewed full text | OA subset only; respect per-article CC terms |
| **CDC** guidance | Public-health guidelines | US-gov public domain — verify per document |
| **ICD-11** | Diagnostic classification | WHO license terms apply |

Each ingested document becomes a `KnowledgeDocument` that must reach **`APPROVED`**
status before it is queryable — retrieval filters on `status=APPROVED` **and**
`tenant_id` on *both* prefetch branches (the load-bearing tenant-isolation + approval
gate).

## 2. Ingestion path (write side)

Ingestion is **not** a destructive/DB-migration operation — it chunks → embeds
(dense + sparse) → upserts Qdrant points with a stable
`uuid5(tenant, document, chunkIndex)` id, so **re-ingest is idempotent**.

Production flow (preferred): create a `KnowledgeDocument`, move it to `APPROVED`; the
apps/api `IngestKnowledgeDocument` BullMQ processor then calls the harness write
endpoint:

```
POST /api/v1/internal/knowledge/ingest        # apps/harness/api/endpoints/knowledge.py
  → chunk → dense+sparse embed → Qdrant upsert (knowledge_chunks)
```

Direct/back-fill (owner, per-tenant, staging first):

1. Stage the licensed corpus files for **one** pilot tenant.
2. Drive `POST /api/v1/internal/knowledge/ingest` per document (or enqueue via the
   approved-document processor). Idempotent — safe to retry.
3. Verify point counts in Qdrant and spot-check a `hybrid_query` returns
   `status=APPROVED`, tenant-scoped chunks only.

> **Never** run `migrate reset` / DROP / TRUNCATE against Qdrant or Postgres as part of
> ingestion. Re-ingest is idempotent by point id; to remove content, retire the
> `KnowledgeDocument` through its normal lifecycle.

## 3. Flag-flip matrix (one flip per change, each with a gate)

Enable retrieval **per tenant**, one accuracy lever at a time. Each row is a separate
change whose gate is a **TASK-470 streaming scorecard** or a **harness-eval re-run** on
the golden set — never batch multiple flips.

| # | Lever | Knob / env | Gate before flip ON |
|---|---|---|---|
| 1 | Institutional RAG (pilot tenant) | `retrievalEnabled` policy knob / `HARNESS_RETRIEVAL_ENABLED` | harness-eval faithfulness/citation delta ≥ 0 on golden set |
| 2 | Sortformer diarization (staging) + TASK-489 labels | ASR config | TASK-470 scorecard (WER/DER held) |
| 3 | MiniCheck GGUF entailment paths | sensor config | harness-eval AC-6 re-baseline |
| 4 | Atomic-fact verifier ON | `atomic-fact` extra + flag | harness-eval faithfulness delta |
| 5 | Warm-start / NER-priors ON | harness config | harness-eval + latency check |
| 6 | Optimistic delivery ON | gate config | harness-eval regen/flag rates held |
| 7 | Claim-check `store=s3` | claim-check config | storage/retention verified |

**Rollback:** each lever is additive + degrade-safe. Set the knob/env back to its
default (`false`) to disable; an embeddings/Qdrant/reranker outage already yields an
empty context (`degraded=True`) and flags reduced assurance — it never breaks the loop.

## 4. Verification after each flip

- Retrieval returns tenant-scoped, `APPROVED`-only chunks (no cross-tenant bleed).
- StrictCitations: hallucinated / never-retrieved `[[kb:<chunkId>]]` ids are dropped by
  `extract_cited_ids` (cannot reach `citationsMap` or the citation-verify sensor).
- harness-eval / TASK-470 scorecard recorded as the flip's evidence.

## Change History

- 2026-07-19 — Initial runbook (TASK-520 engineering sliver: this doc + flag-flip
  matrix). Corpus licensing, ingestion execution, and per-tenant enablement remain
  owner-run.
