# TASK-355 · Appendix 03 — Live Pipeline Review: what the live session already computes (and the harness ignores)

> Produced by the live-pipeline review agent (code-level review of `apps/api`, `packages/applications`,
> `apps/smr`, `apps/stt-v2`, `packages/database`). Focus: which artifacts exist before the harness starts,
> where they live, and the exact recomputation overlap.

---

## 1. Live partial summarization

**Trigger chain:**

```
POST /consultations/:id/recording/start (ConsultationController)
  → LiveDocumentationService.start()    [packages/applications, NestJS]
    → attachSttStream() → StreamingAudioBridgeService.subscribeToResults(sessionId)
      → subscribes to Redis: stt:result:{sessionId}
        → ingestSegment() on every final STT segment
```

**Flush conditions** (`packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts`):
- Every **3 final segments** (`LIVE_DOC_SEGMENT_THRESHOLD=3`) → immediate flush (lines 346–349)
- **5-second idle timer** (`LIVE_DOC_DEBOUNCE_MS=5000`) → deferred flush (lines 634–640)
- **Min-interval throttle** `LIVE_DOC_MIN_INTERVAL_MS=4000` prevents back-to-back calls (lines 422–426)
- `ConsultationPipelineEvent.ContextAdded` (note/lab/file added mid-visit) → schedules flush (lines 358–378)

**SMR endpoint:** `POST {SMR_URL}/api/v1/generate` (called at line 799), **incremental refinement prompt**: prior SOAP + new transcript delta + clinician notes block, `max_tokens=1500`, JSON-schema response format. Output parsed by `soap-parser.ts` into `sections[] + runningSummary`.

**Persistence:**

| Store | Key | TTL | Content |
|---|---|---|---|
| Redis pub/sub | `consultation:live-summary:{consultationId}` | ephemeral | `LiveSummaryEventDto` JSON |
| Redis snapshot | `consultation:live-summary:{consultationId}:last` | 1 hour | last-known snapshot for late-join SSE |
| **Postgres `ContextItem`** | **type=`PRE_SUMMARY`, `metaData.subType='LIVE_SOAP_SNAPSHOT'`** | permanent | **running SOAP text — ONE row per session, upserted every 30 s** (`persistDurableSnapshot()`, line 731; `LIVE_DOC_DURABLE_SNAPSHOT_MS=30000`) + final upsert on stop |

## 2. Live NER — two separate paths

### Path A — in-flight NER inside each live flush (ephemeral)
- `LiveDocumentationService.callNlp()` (lines 807–820), once per flush, **on the freshly-generated `runningSummary`** (not the raw transcript)
- `POST {NLP_URL}/api/v1/classify/tokens` → entities embedded in `LiveSummaryEventDto.entities[]`
- **Redis/SSE only — never written to the `NamedEntity` table**

### Path B — BullMQ `NerProcessor` (durable, legacy path only)
- `jobs/processors/ner.processor.ts` line 165, fired by `ConsultationEventHandler.handleSummaryGenerated()` (line 279) when the **legacy** auto-summary completes — **NOT on the harness path**
- Persists to `NamedEntity` via `NamedEntityFactory.CreateNamedEntity()` (lines 86–104)

Guardrail is never called for NER on either path.

## 3. Consultation finalization flow (how the harness starts)

```
recording stop
  → apps/stt-v2: session_manager._finalize_session()
      → gateway.create_transcript(...)  → POST /internal/stt/transcripts (apps/api)
          → SttInternalService.createTranscript()
              → ContextItemFactory.CreateTranscript() → ContextItem (type=TRANSCRIPT)
              → emits ConsultationPipelineEvent.TranscriptionCreated

ConsultationEventHandler.handleTranscriptionCreated()  [consultation-event.handler.ts:70]
  → resolvePipelineConfig(consultationId)              [consultation.metadata.pipelineConfig]
    → if harnessEnabled=true:
        → mint harnessJobId = "harness-doc-<uuid>"
        → HarnessGatewayService.start(consultationId, { tenantId, userId, jobId,
                                                        contextItemId, transcriptText })
            → POST {HARNESS_URL}/api/v1/internal/consultations/{id}/document:start
                → Temporal: client.start_workflow(HarnessDocWorkflow, input)
```

**Workflow input carries: ids + cold `transcript_text` + gate config. No live artifacts (partial summaries, live NER) are passed — period.** Trigger dead time (stop → workflow start) is sub-3 s; nothing to win there.

## 4. Data model

Key tables (`packages/database/src/prisma/db_main/`):

| Model | File | Purpose |
|---|---|---|
| `Consultation` | `consultation.prisma:4` | `status`: OPEN→RECORDING→PENDING_REVIEW→SIGNED |
| `ContextItem` | `consultation.prisma:73` | polymorphic content container (discriminated by `type`) |
| `SummaryMeta` | `consultation.prisma:204` | 1:1 with ContextItem — sensor scores, citations, guardrail decisions, prompt provenance, **`preSummaryIds[]` (line 233)** |
| `NamedEntity` | `consultation.prisma:275` | NER results linked to a ContextItem |
| `ContextItemVersion` | `consultation.prisma:347` | snapshot history; attestation hash for SIGNED_NOTE |
| `HarnessAuditEvent` | `harness.prisma:185` | append-only WORM: GENERATE/SENSOR_RUN/GATE_DECISION/ATTEST |
| `HarnessPolicy` | `harness.prisma:253` | DB-backed per-tenant runtime knobs |

`ContextItemType` enum (`enums.prisma:205`): `AUDIO_RECORDING, WORKNOTE, RAW_SUMMARY, MODIFIED_SUMMARY, PRE_SUMMARY, NAMED_ENTITY, TRANSCRIPT, CASE_NOTE, ATTACHMENT, SIGNED_NOTE`.

**Live-artifact availability matrix:**

| Artifact | Storage | Populated by | Read by harness? |
|---|---|---|---|
| Live running SOAP draft | `ContextItem` `PRE_SUMMARY` + `metaData.subType='LIVE_SOAP_SNAPSHOT'` | `persistDurableSnapshot()` | **NO** |
| Live NER entities | Redis only | `callNlp()` | **NO** (not durably persisted — can't be, today) |
| Final transcript | `ContextItem` `TRANSCRIPT` | `SttInternalService.createTranscript()` | **YES** (primary input) |
| Harness transcript NER | `NamedEntity` | harness `persist_entities` | YES (read back in `assemble_prompt`) |
| Harness SOAP draft | `ContextItem` `RAW_SUMMARY` | harness `persist_draft` | n/a (creates it) |

## 5. Guardrail during live transcription

The Guardrail service (:8863) is called **by SMR, not by `LiveDocumentationService`**: `apps/smr/src/smr_v2/services/external_guardrail.py` — `ExternalGuardrailClient.validate()` → `POST {GUARDRAIL_BASE_URL}/api/medical/validate` **before every generate** when `SMR_V2_EXTERNAL_GUARDRAIL_ENABLED=true` (`generate.py:129–142`).

- **Dev/default: `false` → no guardrail calls during live flushes today.** If enabled, it fires on every live flush (every 3 segments / 5 s idle) AND again on the harness `generate`.
- Guardrail is never called per transcript chunk or per NER request.

## 6. The asymmetry vs the legacy path

The **legacy** summary path (`summary/summary.service.ts` ~line 196) loads `findLatestPreSummary()` and injects it as the `{pre_summary_text}` prompt variable via `PromptAssemblyService`. The **harness** assemble endpoint (`harness/harness-internal.service.ts:107–194`, `HarnessInternalService.assemble()`) loads:

- `contextItemRepository.findTranscripts()` ✓
- `namedEntityRepository.findByConsultation()` ✓ (harness-persisted NER)
- `findCaseNotes()`, `findWorknotes()`, `findAttachments()` ✓
- `highlightRepository.findByConsultation()` ✓
- **`PRE_SUMMARY` / `findLatestPreSummary()` — ✗ never fetched.**

`SummaryMeta.preSummaryIds[]` — the provenance column designed to record consumed pre-summaries — is **never populated on the harness path**.

The SMR `/api/v1/generate` request model (`apps/smr/src/smr_v2/models/requests.py`) has **no dedicated field** for a prior summary — injection must happen as prompt text (exactly how the legacy path does it).

## 7. Precise recomputation overlap map

| Work done live | Persisted where | Harness redoes it? | Exact overlap |
|---|---|---|---|
| SOAP summarization via SMR (incremental, near-complete at stop) | Redis + 1 `PRE_SUMMARY` row | **Yes — fully** (cold `generate`, 21.4 s measured) | never reads PRE_SUMMARY |
| NER (on running summary) | Redis only | **Yes — fully** | `extract_entities` re-runs on transcript + note |
| Guardrail validation (via SMR, if enabled) | not persisted | **Yes** | fires again on harness generate |
| Prompt context (case notes, worknotes, highlights) | in-memory session + DB | **Yes — from DB** | re-fetched (cheap, correct) |

**Work done ONLY by the harness (no live equivalent):** Qdrant RAG retrieval; 5 computational sensors; inferential sensors (groundedness / citation_verify / safety); gate aggregation + bounded regen; WORM audit; `PENDING_REVIEW` lifecycle; full `SummaryMeta`.

## 8. Key optimization target

The `PRE_SUMMARY` LiveDoc snapshot is the **only durable live artifact the harness ignores**. Wiring it in is isolated to `HarnessInternalService.assemble()` + the prompt template (mirror the legacy `{pre_summary_text}` mechanism), turning `generate` from cold generation into refinement, with `SummaryMeta.preSummaryIds[]` recording provenance. No Temporal workflow change → no replay-safety risk. Sensors still verify against the full final transcript, so assurance semantics are unchanged.

A second-order option (larger): make live NER durable (persist Path-A results) so the harness `extract_entities` transcript pass becomes a lookup — but at 0.18 s measured, this is **not worth it for latency** (only for consistency).
