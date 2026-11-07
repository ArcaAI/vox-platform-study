# What are the APIs? — Architectural Inventory of HOPE Gateway

This document answers the user's first question: **What are the APIs?**

The HOPE API Gateway ([`apps/api`](file:///Users/apple/repos/VOX/project-hope/apps/api)) exposes **818 routes** across **77 feature modules** and **148 controllers**. All routes (except `/metrics` and the raw WebSocket gateway `/ws/stt/stream`) are served under the global prefix:
```
http://<host>:8868/api/v1/
```

---

## 1. The Five Capability Planes

To easily understand the 818 APIs, they are organized into **5 core capability planes**:

```
                          ┌────────────────────────┐
                          │   HOPE API GATEWAY     │
                          │      (apps/api)        │
                          └───────────┬────────────┘
         ┌──────────────┬─────────────┼──────────────┬──────────────┐
         ▼              ▼             ▼              ▼              ▼
   ┌───────────┐  ┌───────────┐ ┌───────────┐  ┌───────────┐  ┌───────────┐
   │ 1.Clinical│  │  2.Audio  │ │3.AI Models│  │4.Agentic  │  │5.Platform │
   │    and    │  │    and    │ │and Prompt │  │    and    │  │Admin and  │
   │Consultat. │  │  Speech   │ │Governance │  │ Workflows │  │  Tenancy  │
   └───────────┘  └───────────┘ └───────────┘  └───────────┘  └───────────┘
```

---

## Plane 1: Clinical & Consultation Plane
*Handles the end-to-end doctor-patient encounter: recording, live running notes, summaries, attachments, feedback, and telemetry.*

| Route Path | Verbs | Controller | Primary Role & Description | Auth Model |
|---|---|---|---|---|
| `/api/v1/consultations` | `GET`, `POST` | [`ConsultationController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation.controller.ts) | List and create clinical consultations. | JWT + API Key (`consultation:session:write`) |
| `/api/v1/consultations/:id` | `GET`, `PATCH` | [`ConsultationController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation.controller.ts) | Fetch session with relations; update session metadata (OCC protected). | JWT + API Key (`consultation:session:read/write`) |
| `/api/v1/consultations/:id/approve` | `POST` | [`ConsultationController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation.controller.ts) | Doctor signs and attests the clinical note (locks against further edits). | JWT only (doctor attribution) |
| `/api/v1/consultations/:id/summary` | `POST` | [`ConsultationController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation.controller.ts) | Asynchronous SOAP note generation trigger (seam to Harness workflow). | JWT + API Key (`consultation:report:write`) |
| `/api/v1/consultations/:id/stream/running-note` | `GET` (SSE) | [`ConsultationController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation.controller.ts) | Real-time Server-Sent Events stream of the in-progress clinical note. | Stream Ticket (`?ticket=`) |
| `/api/v1/consultations/:id/recording` | `GET`, `POST` | [`ConsultationController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation.controller.ts) | Presigned audio recording parts upload/download for consultation playback. | JWT + API Key (`consultation:recording:write`) |
| `/api/v1/consultations/:id/attachments` | `GET`, `POST`, `DELETE` | [`ConsultationAttachmentController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation-attachment.controller.ts) | Upload/manage EHR attachments, lab reports, and clinical images. | JWT + API Key (`consultation:attachment:write`) |
| `/api/v1/consultations/:id/feedback` | `POST`, `GET` | [`ConsultationFeedbackController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation-feedback.controller.ts) | Clinician feedback ratings, corrections, and comments on generated notes. | JWT + API Key (`consultation:feedback:write`) |
| `/api/v1/consultations/:id/timeline/stream` | `GET` (SSE) | [`ConsultationController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/consultation.controller.ts) | SSE stream of consultation timeline events (transcription, sensor, loop). | Stream Ticket |
| `/api/v1/consultations/history` | `GET` | [`ConsultationHistoryController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation-history/consultation-history.controller.ts) | Historical patient consultation search across dates and departments. | JWT + API Key (`consultation:history:read`) |
| `/api/v1/admin/consultations` | `GET`, `DELETE` | [`AdminConsultationController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/admin-consultation.controller.ts) | Administrative consultation listing, purging, and cross-tenant auditing. | JWT only (`manage:Consultation`, `@ForbidApiKey()`) |

---

## Plane 2: Speech & Audio Plane
*Real-time audio ingestion, speaker diarization, batch transcription jobs, voice profiles, and ASR engine dispatch.*

| Route Path | Verbs | Controller | Primary Role & Description | Auth Model |
|---|---|---|---|---|
| `/ws/stt/stream` | WebSocket | [`SttWsGateway`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/speech/stt-ws.gateway.ts) | High-speed binary WebSocket stream for live microphone audio chunks to Python STT engine. | Single-use Stream Ticket (`?ticket=`) |
| `/api/v1/audio/transcription-jobs` | `GET`, `POST` | [`TranscriptionJobController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/streaming/transcription-job.controller.ts) | Submit batch audio files for asynchronous transcription & list job history. | JWT + API Key (`stt:transcription:write`) |
| `/api/v1/audio/transcription-jobs/:id` | `GET`, `DELETE` | [`TranscriptionJobController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/streaming/transcription-job.controller.ts) | Inspect batch job status, progress percentage, and final transcription segments. | JWT + API Key (`stt:transcription:read`) |
| `/api/v1/audio/transcription-jobs/:id/stream` | `GET` (SSE) | [`TranscriptionJobController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/streaming/transcription-job.controller.ts) | Server-Sent Events stream for live progress updates on long-running audio batch jobs. | Stream Ticket (`?ticket=`) |
| `/api/v1/voice-profiles` | `GET`, `POST`, `DELETE` | [`VoiceProfileController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/voice-profile/voice-profile.controller.ts) | Manage clinician voice embeddings for speaker verification & diarization. | JWT only (`@ForbidApiKey()`) |
| `/api/v1/internal/stt` | `GET`, `POST` | [`SttInternalController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/internal/stt-internal.controller.ts) | Internal callbacks from Python STT workers (session sync, engine health, completion). | Service Token (`X-Internal-Service-Key`) |

---

## Plane 3: AI Text, Prompt Management & Guardrails Plane
*Direct LLM text generation proxy, safety/PII guardrail verification, clinician DNA writing styles, and prompt engineering.*

| Route Path | Verbs | Controller | Primary Role & Description | Auth Model |
|---|---|---|---|---|
| `/api/v1/text-generations` | `POST` | [`TextProxyController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/streaming/text-proxy.controller.ts) | Proxy text generation requests to Python LLM service with metering & guardrail check. | JWT + API Key (`consultation:report:write`) |
| `/api/v1/text-generations/tasks/:taskId/stream` | `GET` (SSE) | [`TextProxyController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/streaming/text-proxy.controller.ts) | Token-by-token streaming SSE response from downstream LLM back to client. | Stream Ticket (`StreamScope text_task`) |
| `/api/v1/text-analyses` | `POST` | [`AiInferenceController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/ai-inference/ai-inference.controller.ts) | Standalone NLP evaluation, entity extraction (NER), and guardrail safety checks. | JWT + API Key (`ai:inference:write`) |
| `/api/v1/prompt-templates` | `GET`, `POST`, `PATCH` | [`PromptTemplateController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/prompt-management/prompt-template.controller.ts) | Read and manage prompt templates available to clinicians in the department. | JWT + API Key (`prompt:template:read`) |
| `/api/v1/admin/prompt-templates` | `GET`, `POST`, `DELETE` | [`PromptManagementController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/prompt-management/prompt-management.controller.ts) | Full administrative control: prompt versioning, system prompts, approval gates. | JWT only (`manage:PromptTemplate`) |
| `/api/v1/dna-writing-styles` | `GET`, `POST`, `PATCH` | [`DnaWritingStyleController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts) | Clinician personalized writing style profiles (extracts vocabulary, tone, format). | JWT only (`@ForbidApiKey()`) |
| `/api/v1/admin/guardrail-policies` | `GET`, `POST`, `PUT` | [`GuardrailPolicyController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/guardrail-policy/guardrail-policy.controller.ts) | Define platform & tenant safety bounds (toxic content, hallucination, PII redaction). | JWT only (`manage:GuardrailPolicy`) |

---

## Plane 4: Agentic, Workflow & Harness Plane
*Clinical Documentation Harness, Temporal workflow orchestration, agent assignments, MCP tool servers, and RAG knowledge.*

| Route Path | Verbs | Controller | Primary Role & Description | Auth Model |
|---|---|---|---|---|
| `/api/v1/admin/harness` | `GET`, `POST`, `PATCH` | [`HarnessAdminController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/harness-admin/harness-admin.controller.ts) | Harness policy configuration, golden test sets, sensor weights, evaluation loops. | JWT only (`manage:HarnessPolicy`) |
| `/api/v1/admin/harness/workflows/:id/ops`| `POST` | [`HarnessAdminController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/harness-admin/harness-admin.controller.ts) | Signal, pause, resume, or cancel active Temporal clinical note generation workflows. | JWT only (`manage:HarnessWorkflow`) |
| `/api/v1/internal/harness` | `POST` | [`HarnessInternalController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/consultation/harness-internal.controller.ts) | Ingress for Temporal workers executing the harness `guides → generate → sensors → gate` loop. | Service Token (`X-Service-Token`) |
| `/api/v1/admin/agent-assignments` | `GET`, `POST`, `PATCH`, `DELETE` | [`AgentAssignmentAdminController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/agent-admin/agent-assignment-admin.controller.ts) | Governs which AI Agent (ASR, Summarizer, Note Writer) serves which tenant or department. | JWT only (`manage:Agent`) |
| `/api/v1/workflows` | `GET`, `POST` | [`WorkflowsController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/workflows/workflows.controller.ts) | Workflow execution plane: trigger custom clinical pipelines & view run status. | JWT + API Key (`workflow:run:write`) |
| `/api/v1/admin/mcp-servers` | `GET`, `POST`, `DELETE` | [`McpAdminController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/mcp-admin/mcp-admin.controller.ts) | Configure Model Context Protocol (MCP) server endpoints and tools available to agents. | JWT only (`manage:McpServer`) |
| `/api/v1/admin/knowledge/documents` | `GET`, `POST`, `DELETE` | [`KnowledgeController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/knowledge/knowledge.controller.ts) | Institutional clinical knowledge base ingestion for RAG (vectorized into Qdrant). | JWT only (`manage:KnowledgeDocument`) |

---

## Plane 5: Platform Administration, Security & Multi-Tenancy Plane
*Tenancy bounds, user lifecycle, RBAC, API keys, service accounts, billing, rate limiting, and audit logs.*

| Route Path | Verbs | Controller | Primary Role & Description | Auth Model |
|---|---|---|---|---|
| `/api/v1/auth/login`, `/token` | `POST` | [`AuthController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/auth/auth.controller.ts) | Authentication entry point: validate user credentials, issue JWTs & refresh tokens. | `@Public()` |
| `/api/v1/auth/stream-ticket` | `POST` | [`AuthController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/auth/auth.controller.ts) | Issues single-use 30-second TTL stream tickets for WebSocket and SSE connections. | Authenticated JWT |
| `/api/v1/admin/tenants` | `GET`, `POST`, `PATCH` | [`TenantController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/tenant/tenant.controller.ts) | Multi-tenant governance: provision hospitals/clinics, manage subscription plans & locks. | JWT only (`manage:Tenant`) |
| `/api/v1/admin/users` | `GET`, `POST`, `PATCH` | [`UserController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/user/user.controller.ts) | Clinician and staff user management, role assignments, password resets. | JWT only (`manage:User`) |
| `/api/v1/admin/api-keys` | `GET`, `POST`, `DELETE` | [`ApiKeyController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/api-key/api-key.controller.ts) | Create and revoke scoped API keys for external EHR/integrator systems. | JWT only (`manage:ApiKey`) |
| `/api/v1/admin/service-accounts` | `GET`, `POST`, `DELETE` | [`ServiceAccountController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/service-account/service-account.controller.ts) | Manage machine-to-machine service accounts and client credentials. | JWT only (`manage:ServiceAccount`) |
| `/api/v1/admin/rate-limit` | `GET`, `PUT`, `PATCH` | [`RateLimitAdminController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/admin-rate-limit/rate-limit-admin.controller.ts) | Global and per-route rate limiting rules and tier thresholds (backed by Redis). | JWT only (`manage:all`) |
| `/api/v1/admin/billing` | `GET`, `POST` | [`BillingController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/billing/billing.controller.ts) | Invoicing, token usage ledgers, and compute cost accounting. | JWT only (`manage:Billing`) |
| `/api/v1/admin/audit-logs` | `GET` | [`AuditLogController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/audit-log/audit-log.controller.ts) | Compliance and PHI access audit log queries. | JWT only (`read:AuditLog`) |
| `/api/v1/admin/tenant-buckets` | `GET`, `POST`, `DELETE` | [`TenantBucketController`](file:///Users/apple/repos/VOX/project-hope/apps/api/src/modules/tenant-bucket/tenant-bucket.controller.ts) | S3/MinIO cloud object storage bucket provisioning and file exploration. | JWT only (`manage:TenantBucket`) |

---

## 2. Machine-Readable Inventory Files

In addition to this guide, two machine-readable catalogs are provided in [`inventory/`](file:///Users/apple/repos/VOX/review/api_explore_2/inventory):
- **Full JSON Catalog:** [`inventory/api-route-call-tree-catalog.json`](file:///Users/apple/repos/VOX/review/api_explore_2/inventory/api-route-call-tree-catalog.json) (all 818 routes with controllers, parameters, auth scopes, and full downstream call trees).
- **Tabular CSV Export:** [`inventory/api-catalog.csv`](file:///Users/apple/repos/VOX/review/api_explore_2/inventory/api-catalog.csv) (ideal for sorting, filtering by module or HTTP verb in Excel/Numbers).
- **Module-by-Module Call Trees:** [`inventory/call-trees-by-module.md`](file:///Users/apple/repos/VOX/review/api_explore_2/inventory/call-trees-by-module.md) (complete 9,500+ line reference of every module's call trees).
