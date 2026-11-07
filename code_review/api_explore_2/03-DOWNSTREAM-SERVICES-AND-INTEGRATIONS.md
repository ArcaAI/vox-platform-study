# Downstream Services & External Integrations

This document details the downstream microservices, infrastructure components, and external providers that the HOPE API Gateway communicates with when servicing client requests.

---

## 1. Downstream Python AI Microservices

The gateway acts as an ingress, reverse-proxy, and security barrier for six backend Python AI services:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        HOPE API GATEWAY (Port 8868)                    │
└───────┬──────────────┬──────────────┬──────────────┬────────────┬──────┘
        │              │              │              │            │
        ▼              ▼              ▼              ▼            ▼
┌──────────────┐┌──────────────┐┌──────────────┐┌───────────┐┌───────────┐
│  STT Service ││ Text Service ││  TTS Service ││NLP Service││ Guardrail │
│  (Port 8861) ││ (Port 8862)  ││ (Port 8865)  ││(Port 8864)││  Service  │
│ Live Audio WS││LLM Summaries ││Speech Synthes││Medical NER││PII/Safety │
└──────────────┘└──────────────┘└──────────────┘└───────────┘└───────────┘
```

| Microservice | Default Port | Communication Protocol | Handled in Gateway By | Role & Responsibilities |
|---|---|---|---|---|
| **STT (Speech-to-Text)** | `8861` | WebSocket (binary audio) + HTTP REST | [`SttWsGateway`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/speech/stt-ws.gateway.ts), [`TranscriptionJobController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/streaming/transcription-job.controller.ts) | Real-time speech streaming, VAD (voice activity detection), speaker diarization, batch transcription. |
| **Text (LLM Generation)** | `8862` | HTTP POST (SSE streaming) | [`TextProxyController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/streaming/text-proxy.controller.ts) | LLM inference, clinical SOAP pre-summaries, running note accumulation, report formatting. |
| **TTS (Text-to-Speech)** | `8865` | WebSocket + HTTP REST | [`TtsWsGateway`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/speech/tts-ws.gateway.ts), [`SpeechProxyController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/speech/speech-proxy.controller.ts) | Clinical audio synthesis (English & Malayalam) using Azure Speech, Kokoro, and Indic Parler-TTS. |
| **NLP (Medical NLP)** | `8864` | HTTP REST | [`AiInferenceController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/ai-inference/ai-inference.controller.ts) | Medical Named-Entity Recognition (NER), diagnosis suggestion, ontology coding (SNOMED, ICD-10, UMLS, RxNorm). |
| **Guardrail** | Reached via Text proxy relay | HTTP REST | Evaluated inside [`TextProxyController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/streaming/text-proxy.controller.ts) | Content safety, hallucination detection, prompt injection mitigation, and HIPAA PII scrubbing. |
| **Harness (Temporal)** | Managed by Temporal | Temporal gRPC + HTTP callbacks | [`HarnessAdminController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/harness-admin/harness-admin.controller.ts), [`HarnessInternalController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/harness-internal.controller.ts) | Executes the durable `guides → generate → sensors → gate` workflow loop to generate grounded clinical notes. |

---

## 2. Infrastructure & Storage Components

The gateway relies on specialized infrastructure services managed through `@arcaai/applications` and `@arcaai/domains`:

### 1. PostgreSQL & Prisma ORM (`@arcaai/database`)
- **Role:** Primary relational data store for all business entities (Tenants, Users, Consultations, Documents, Settings).
- **Multi-Tenancy Isolation:** Applied through the Prisma tenant-scope extension. Every query automatically inherits `tenantId` from the active AsyncLocalStorage context (`ClsService`).
- **WORM Audit Trails:** Entity modifications (e.g. agent assignments, consultation approvals) create immutable audit records in Postgres.

### 2. Redis (In-Memory Key-Value & Queuing)
- **Rate Limiting:** Backing store for `TieredThrottlerGuard` to enforce sliding-window request limits across distributed gateway nodes.
- **Single-Use Stream Tickets:** `StreamTicketService` stores 30-second TTL cryptographically random tokens used to authorize WebSocket and SSE connections without sending JWTs in query parameters.
- **Pub/Sub Event Relays:** Powers real-time Server-Sent Events (SSE) broadcasting (e.g. streaming running notes, timeline updates, workflow progress).
- **BullMQ Task Queues:** Asynchronous job queues for checkpointing, media processing, and offline transcript cleanup.

### 3. MinIO / S3 Object Storage (`BlobStorageService`)
- **Role:** Secure cloud storage for unstructured media files.
- **Use Cases:**
  - Raw consultation audio recordings (`.wav` / `.webm`).
  - Clinician uploaded medical attachments and lab report PDFs.
  - Finalized exported clinical notes and invoices.
- **Security:** Files are never served publicly; the gateway generates short-lived presigned upload/download URLs.

### 4. HashiCorp Vault (`SecretsService`)
- **Role:** Centralized secrets and encryption key management.
- **Use Cases:**
  - Asymmetric JWT signing keys rotation.
  - Encryption-at-rest keys for sensitive database fields.
  - Third-party provider API keys (Azure OpenAI, AWS Bedrock, Anthropic).

### 5. Qdrant Vector Database
- **Role:** High-performance vector database for RAG (Retrieval-Augmented Generation).
- **Use Cases:**
  - Clinical institutional knowledge base embeddings (`/api/v1/admin/knowledge/documents`).
  - Doctor personalized DNA writing style embeddings.

### 6. Temporal Workflow Engine
- **Role:** Durable, failure-resilient workflow orchestrator.
- **Use Cases:**
  - Coordinates long-running clinical documentation loops across multiple microservices.
  - Provides stateful pausing, human-in-the-loop clinician attestation, and automatic retries upon downstream service transient failures.

---

## 3. External Third-Party Integrations

| External Service | Used For | Implementation Location |
|---|---|---|
| **Azure OpenAI / Anthropic / AWS Bedrock** | Upstream Foundation LLMs | Dispatched via Python Text service or direct Provider Connection services. |
| **Azure Speech** | Cloud-based speech-to-text fallback and high-fidelity TTS | Configured in tenant audio settings. |
| **Prometheus** | Real-time gateway performance metrics (`/metrics`) | Handled via Prometheus exporter (`@willsoto/nestjs-prometheus`). |
| **OpenTelemetry (OTel)** | Distributed tracing across gateway and Python services | Initialized in `src/instrumentation.ts` (with PHI scrubbing protection). |
