# HOPE — Owner Product & Service Brief

| | |
|---|---|
| **Status** | AUTHORITATIVE. Owner-provided; this is the specification the platform is measured against. |
| **Recorded** | 2026-08-17 (restated by the owner; originally given at program start) |
| **Companion** | [owner-decisions-2026-08-17.md](./owner-decisions-2026-08-17.md) — decisions that refine this brief |

---

## 1. Enterprise features

Three product surfaces. **All three share one pattern**: a tenant admin uses an interactive
**reactflow workflow builder** to define the **context schema** and **prompt template**, configure
the pipeline, and then **expose it as APIs / Sockets / Webhooks, or consume it through the built-in
SDK**.

| Surface | Kind | Shape |
|---|---|---|
| **Speech-to-text** | simple / standalone | Configurable workflows, models, languages, settings |
| **Summarization** | simple / standalone | Each workflow is ONE agent — prompt template, context management, tool calling |
| **Consultation** | **main / core business** | Agent-orchestrator with agents and sub-agents, workflow management, tool calling. Per-DEPARTMENT workflows with **end-user personalization** |

Capability tasks underneath:

1. **ASR** — live/batch transcription, with or without VAD, noise filtering, diarization, language detection.
2. **Text generation** — summarization, translation, paraphrasing, topic extraction, question answering.
3. **Medical NLP** — NER + UMLS / SNOMED / RxNorm / ICD / LOINC.
4. **Guardrails** — PII, safety, medical validation; **fail-closed on generation**.
5. **Institutional RAG, TTS (en + ml), voice enrollment, DNA writing style.**
6. **Embeddable `@arcaai/vox` SDK** for a host EMR. **HOPE stores no patients — only an external `patientId`.**

## 2. Platform / IT

### Multi-tenancy and plans

- Every tenant is assigned features by subscription plan, or by a customized plan set by a super-admin.
- **Super-admin and the former global-admin are the same level. The name is consolidated to SUPER_ADMIN.**
- A super-admin manages, for all tenants: tenants · plans · features · configuration · customization ·
  audit trail · security · performance · compliance · reporting & analytics · monitoring & alerting ·
  disaster recovery & backup.

### Architecture

Modular, extensible, maintainable.

## 3. Services

Every service below carries the same microservice obligation, stated once here:
**gold-standard microservice architecture — well-defined and documented APIs, an SSE interface, a
Message Queue real-time interface, and documented internal architecture and design.**

### `text` (renamed from `smr`) — high-performance, high-availability, worker-pool managed
- Handles **text-generation and text-embedding** requests.
- Acts as a **proxy**: routes each request to the appropriate worker, running tasks **in parallel**,
  across engines — vLLM, llama.cpp, LM Studio, Ollama — and third parties — Azure Foundry, AWS Bedrock.
- Provides a standard API, SSE and real-time interface for other services.
- **Owns worker management and monitoring**: status, health, performance of every worker and engine.
  Worker lifecycle should follow k8s deployment + autoscaling best practice.

### `guardrail` — high-performance
- Handles PII, safety and medical validation.
- **MUST delegate to `text` and `nlp`** rather than owning engines.
- **MUST interact with the database** to store and retrieve **per-tenant** guardrail instructions.

### `nlp` — high-performance
- Handles NER, classification, clustering.
- **MUST handle AI/ML models for**: sentiment analysis, topic labeling, intent recognition, toxicity
  detection — and may leverage `text` for tasks needing generative models.
- **MUST interact with the database** for **per-tenant** NLP task instructions.

### `stt` — high-performance, high-availability, worker-pool managed
- Handles ASR and **audio embedding**, in **realtime or batch**.
- Acts as a **proxy**: routes to the appropriate worker in parallel across engines — Whisper, NeMo —
  and third parties — Azure Foundry, Azure Cognitive Services, AWS Transcribe.
- **MUST interact with the database** for **per-tenant** ASR task instructions.
- **Owns worker management and monitoring**; k8s deployment + autoscaling best practice.

### `tts` — high-performance, high-availability, worker-pool managed
- Handles TTS in **realtime or batch**.
- Acts as a **proxy** across engines and third parties.
- **MUST interact with the database** for **per-tenant** TTS task instructions.

### `harness` — the loop layer
- Session context management, tool-calling layer configuration, **memories, MCP, HITL, grounding,
  provenance, observability**.
- MUST interact with the database, object store and vector store.
- MUST interact with `text`, `nlp`, `stt`, `tts`.

### `api` — central gateway (TypeScript)
- Handles ALL requests from external clients, internal services and other services.
- Validates and authenticates external clients and connections.
- Handles internal service-to-service communication using HTTP / SSE / WebSocket / Message Queue /
  Event Bus as appropriate.
- Built on **DDD and CQRS**. Interacts with the database.

## 4. Admin console

**Super-admin:** tenant · user · store & bucket · plan · feature · configuration · audit trail ·
reporting & analytics management.

**Tenant admin (own tenant):** tenant · tenant user · store & bucket · **agentic loop / workflow** ·
**prompt & instruction** · **agent** · **tool & MCP** · **memory** management · monitoring & alerting.

**Test & debug surfaces:** agentic loop/workflow · agent · tool & MCP · memory · speech-to-text ·
text generation.

---

## 5. How to use this document

This brief is the conformance target. When a ticket's scope and this brief disagree, this brief wins
and the ticket is re-scoped. Gaps found against it are recorded in
[service-conformance-gaps.md](./service-conformance-gaps.md).
