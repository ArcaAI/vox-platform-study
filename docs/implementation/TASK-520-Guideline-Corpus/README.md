# TASK-520 — Guideline corpus + tier enablement

**Status:** Documented (engineering sliver complete; corpus ingestion + enablement owner-run)
**Type:** program / infrastructure
**Parent program:** TASK-508 Phase 6 (Accuracy wave)

## Requirement Analysis

Populate a licensed guideline corpus (PMC-OA / CDC / ICD-11 per TASK-330 §2.6) into the
harness institutional-RAG store and enable `HARNESS_RETRIEVAL_ENABLED` on a pilot tenant,
building the retrieval golden set alongside TASK-521, then work the flag-flip matrix per
hardware tier — **one flip per change, each gated by a TASK-470 scorecard or harness-eval
re-run**.

## Current State Evaluation (what already shipped)

The retrieval **engineering path already exists** — nothing new to build here:
- Policy knob `retrievalEnabled` (TASK-511) + env fall-through `HARNESS_RETRIEVAL_ENABLED`
  (default OFF), resolved in `workflows.py` / `activities.py`.
- Hybrid dense+sparse retrieval (TASK-330), StrictCitations `[[kb:<id>]]`, degrade-safe.
- Write side: `POST /api/v1/internal/knowledge/ingest` (idempotent Qdrant upsert),
  driven by the `IngestKnowledgeDocument` processor once a `KnowledgeDocument` is APPROVED.

## Engineering sliver delivered

- **Ingestion runbook + flag-flip matrix** →
  [`docs/operations/retrieval-corpus-ingestion/README.md`](../../operations/retrieval-corpus-ingestion/README.md).

## Owner-run (documented, not executed)

- Corpus **licensing** clearance per source.
- Actual **ingestion** of the licensed corpus into the pilot tenant.
- Per-tenant **flag enablement**, one lever at a time, each with its scorecard/eval gate.
- Retrieval **golden set** (≥132 pairs) built alongside TASK-521.

## Change History

- 2026-07-19 — Engineering sliver: ingestion runbook + flag-flip matrix authored.
  Corpus ingestion and enablement deferred to the owner.
