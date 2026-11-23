# Harness Service - API Documentation

## Service Overview

**Path**: `apps/harness/src/harness/`
**Entry Point**: `harness/main.py` → `create_app()` → `app = create_app()`
**Port**: 8866 (default)
**Framework**: FastAPI (Python 3.11+)

### Core Responsibilities
- **Clinical Documentation Loop** — Temporal durable workflow orchestration (guides → generate → sensors → gate)
- **Document Workflow Management** — Start, signal, cancel, terminate clinical document workflows
- **Consultation Loop** — Streaming context items to Temporal workflows
- **Admin Operations** — Workflow listing, cancellation, termination, signaling
- **Eval Gate** — Synchronous golden-set evaluation for promotion gates
- **Knowledge Ingestion** — Chunk → embed → upsert to Qdrant (Lane B contract)
- **Knowledge Deletion** — Qdrant vector deletion (tenant-scoped)

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Harness Service                          │
├─────────────────────────────────────────────────────────────────┤
│  HTTP Endpoints (FastAPI)                                       │
│  ├─ /api/v1/health          → Health probes                    │
│  ├─ /api/v1/internal/       → Gateway-driven endpoints         │
│  │  ├─ /consultations/{id}/document:start     → Start workflow │
│  │  ├─ /workflows/{id}/signal/approve         → Approval sig   │
│  │  ├─ /workflows/{id}/signal/edit            → Edit sig       │
│  │  ├─ /workflows/{id}/signal/context-added   → Context sig    │
│  │  ├─ /workflows/{id}/signal/consultation-ending → End sig   │
│  │  ├─ /workflows/{id}/signal/loop-cancel     → Cancel sig    │
│  │  ├─ /eval/run                                → Eval gate    │
│  │  ├─ /knowledge/ingest                        → Ingest       │
│  │  └─ /knowledge/{doc_id}                      → Delete       │
│  └─ /api/v1/internal/harness/workflows/       → Admin ops      │
│     ├─ GET /workflows                          → List          │
│     ├─ GET /workflows/{id}                     → Describe      │
│     ├─ POST /workflows/{id}/cancel             → Cancel        │
│     ├─ POST /workflows/{id}/terminate          → Terminate     │
│     └─ POST /workflows/{id}/signal             → Signal        │
├─────────────────────────────────────────────────────────────────┤
│  Temporal Client                                                  │
│  ├─ Workflows: HarnessDocWorkflow, ConsultationLoopWorkflow    │
│  ├─ Signals: approval, edit, contextAdded, consultationEnding  │
│  └─ Queries: phase                                                │
├─────────────────────────────────────────────────────────────────┤
│  Downstream Dependencies                                          │
│  ├─ Temporal (workflow orchestration)                            │
│  ├─ Qdrant (knowledge vectors)                                   │
│  ├─ API Gateway (config, credentials, peer services)            │
│  └─ Embeddings/LM Studio (dense + sparse embeddings)            │
└─────────────────────────────────────────────────────────────────┘
```

---

## API Endpoints Summary

### Health (No Auth Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/health` | `health_check()` | Detailed health (always 200) |
| GET | `/health/live` | `liveness()` | K8s liveness |
| GET | `/health/ready` | `readiness()` | K8s readiness (Temporal) |
| GET | `/health/startup` | `startup()` | K8s startup |

### Internal Gateway-Driven (Service Token Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/v1/internal/consultations/{id}/document:start` | `start_document()` | Start HarnessDocWorkflow |
| POST | `/api/v1/internal/workflows/{id}/signal/approve` | `signal_approve()` | Clinician sign-off |
| POST | `/api/v1/internal/workflows/{id}/signal/edit` | `signal_edit()` | Clinician edit |
| POST | `/api/v1/internal/workflows/{id}/signal/context-added` | `signal_context_added()` | Add context to loop |
| POST | `/api/v1/internal/workflows/{id}/signal/consultation-ending` | `signal_consultation_ending()` | End consultation |
| POST | `/api/v1/internal/workflows/{id}/signal/loop-cancel` | `signal_loop_cancel()` | Abandon loop |
| POST | `/api/v1/internal/eval/run` | `run_eval()` | Golden-set eval gate |
| POST | `/api/v1/internal/knowledge/ingest` | `ingest_knowledge()` | Ingest → embed → upsert |
| DELETE | `/api/v1/internal/knowledge/{doc_id}` | `delete_knowledge_document()` | Delete vectors |

### Admin Operations (Service Token Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/v1/internal/harness/workflows` | `list_workflows()` | List workflows (cursor-paged) |
| GET | `/api/v1/internal/harness/workflows/{id}` | `describe_workflow()` | Describe workflow (+ phase) |
| POST | `/api/v1/internal/harness/workflows/{id}/cancel` | `cancel_workflow()` | Cooperative cancel |
| POST | `/api/v1/internal/harness/workflows/{id}/terminate` | `terminate_workflow()` | Immediate terminate |
| POST | `/api/v1/internal/harness/workflows/{id}/signal` | `signal_workflow()` | Forward arbitrary signal |

---

## Detailed API Documentation

### 1. Document Workflow Start - POST /api/v1/internal/consultations/{id}/document:start

**File**: `harness/api/endpoints/internal.py:234`
**Handler**: `start_document(consultation_id, body, request) -> dict`

**Implementation Chain**:
```
start_document() [internal.py:238]
  → _temporal_client() [internal.py:70] → Temporal client (lazy connect)
  → HarnessDocWorkflowInput [temporal/models.py] — builds workflow input
  → RedactionRule.model_validate() [redaction/engine.py] — validate rules
  → HarnessGateConfig — gate config (SLA, escalation, optimistic delivery)
  → client.start_workflow() [temporalio.client] — start HarnessDocWorkflow
    → idempotent on workflow_id = "harness-doc-{consultation_id}"
    → Search Attributes: HarnessTenantId (tenant ownership)
    → Memo: {tenantId, consultationId} (fallback for unregistered SA)
```

**Data Integration**:
- **Temporal**: Workflow start with deterministic ID, search attributes, memo
- **PostgreSQL**: Tenant config resolved by API Gateway (passed in request body)
- **Redaction Engine**: Rules validated at boundary

**Key Features**:
- Idempotent (WorkflowAlreadyStartedError → "already_running")
- Search Attribute degradation (unregistered SA → memo-only)
- Temporal namespace/queue from config

---

### 2. Clinician Approval - POST /api/v1/internal/workflows/{id}/signal/approve

**File**: `harness/api/endpoints/internal.py:329`
**Handler**: `signal_approve(consultation_id, body, request) -> dict`

**Implementation Chain**:
```
signal_approve() [internal.py:333]
  → _temporal_client() → Temporal client
  → client.get_workflow_handle(workflow_id)
  → handle.signal(HarnessDocWorkflow.approval, ApprovalSignal(...))
```

**Data Integration**:
- **Temporal**: Signal to running workflow (tenant-scoped via search attribute)
- **Gateway**: Validates X-Service-Token, injects tenant_id

---

### 3. Clinician Edit - POST /api/v1/internal/workflows/{id}/signal/edit

**File**: `harness/api/endpoints/internal.py:366`
**Handler**: `signal_edit(consultation_id, body, request) -> dict`

**Implementation Chain**:
```
signal_edit() [internal.py:370]
  → handle.signal(HarnessDocWorkflow.edit, EditSignal(content, version_id, edited_by))
```

**Behavior**: Re-binds assurance to edited content + version, re-runs assurance (Q3), disables silent regen-if-untouched (Q1)

---

### 4. Context Added - POST /api/v1/internal/workflows/{id}/signal/context-added

**File**: `harness/api/endpoints/internal.py:415`
**Handler**: `signal_context_added(consultation_id, body, request) -> dict`

**Implementation Chain**:
```
signal_context_added() [internal.py:419]
  → Validate tenant_id required
  → ConsultationLoopWorkflowInput + ContextAddedSignal
  → client.start_workflow(ConsultationLoopWorkflow.run, ..., start_signal="contextAdded")
    → Signal-with-start: idempotent on loop workflow_id
    → Loop's lifetime = consultation's lifetime
```

**Key Design**: Signal-with-start ensures loop lifetime = consultation lifetime; idempotent on deterministic workflow ID

---

### 5. Consultation Ending - POST /api/v1/internal/workflows/{id}/signal/consultation-ending

**File**: `harness/api/endpoints/internal.py:503`
**Handler**: `signal_consultation_ending() -> dict`

**Implementation Chain**: Signal `consultation_ending` with `ConsultationEndingSignal` + `LoopFinalizeRequest` (transcript, context_item_id, job_id, etc.)

---

### 6. Loop Cancel - POST /api/v1/internal/workflows/{id}/signal/loop-cancel

**File**: `harness/api/endpoints/internal.py:553`
**Handler**: `signal_loop_cancel() -> dict`

**Behavior**: Orderly application-level stop (workflow COMPLETES, not fails); NOT Temporal cancellation

---

### 7. Eval Gate - POST /api/v1/internal/eval/run

**File**: `harness/api/endpoints/eval.py:136`
**Handler**: `run_eval(body, request) -> dict`

**Implementation Chain**:
```
run_eval() [eval.py:137]
  → Validate case count ≤ max_cases_per_run (413 if exceeded)
  → _resolve_evaluators() [eval.py:89]
    → Injected test doubles OR live PDSQI9Judge + faithfulness evaluator
    → build_judge_client() → judge client (model-agnostic)
    → PDSQI9Judge + optional faithfulness
  → run_and_gate() [eval/ci.py] → run_and_gate
    → InMemoryGoldenSetSource → judge → faithfulness → config
    → PDSQI-9 mean over 1–5 Likert dims + optional faithfulness
    → Release gate: pass/fail
  → _flatten_case_scores() → per-(case, metric) rows for EvalScore persistence
```

**Data Integration**:
- **Eval Judge**: Model-agnostic (PDSQI-9) + optional faithfulness
- **Config**: Control-plane resolved (reasoning mode/effort via effective-config)
- **Provenance**: promptTemplateId/Version/Number echoed back for EvalRun attribution

**Fail-Safe**: Synchronous, bounded (max_cases_per_run cap), synchronous promotion gate

---

### 7. Knowledge Ingestion - POST /api/v1/internal/knowledge/ingest

**File**: `harness/api/endpoints/knowledge.py:212`
**Handler**: `ingest_knowledge(body, request) -> dict`

**Implementation Chain**:
```
ingest_knowledge() [knowledge.py:212]
  → chunk_text() [guides/retrieval/chunker.py] — chunk by separators
  → _resolve_embeddings_credential() [knowledge.py:120] → BYO or platform
  → _embeddings_client() → EmbeddingsClient (dense)
  → embeddings.embed(texts) → dense vectors
  → _sparse_embedder().embed_documents() [guides/retrieval/sparse.py] — BM25
  → _point_id() → stable uuid5(tenant, document, chunk_index)
  → _resolve_qdrant_credential() → BYO or platform
  → KnowledgeQdrantStore.upsert_chunks() [guides/retrieval/qdrant_store.py]
    → Qdrant upsert with dense + sparse + payload
```

**Data Integration**:
- **Qdrant**: Dense (LM Studio) + sparse (BM25) vectors
- **API Gateway**: Credential resolution (embeddings + Qdrant)
- **Stable IDs**: uuid5(tenant, document, chunkIndex) — idempotent re-ingest

**Fail-Closed**: Any credential/embedding/Qdrant failure → 503 (Lane B retries)

---

### 8. Knowledge Deletion - DELETE /api/v1/internal/knowledge/{doc_id}

**File**: `harness/api/endpoints/knowledge.py:358`
**Handler**: `delete_knowledge_document(document_id, request, tenant_id) -> dict`

**Implementation Chain**:
```
delete_knowledge_document() [knowledge.py:362]
  → _resolve_qdrant_credential() → BYO/platform credential
  → _qdrant_store().delete_by_document(tenant_id, document_id)
```

**Fail-Closed**: Credential failure → 503 (Lane B aborts Postgres soft-delete)

---

### 8. Admin Workflow List - GET /api/v1/internal/harness/workflows

**File**: `harness/api/endpoints/admin.py:260`
**Handler**: `list_workflows(request, tenant_id, status, consultation_id, limit, page_token) -> dict`

**Implementation Chain**:
```
list_workflows() [admin.py:261]
  → _temporal_client() → Temporal client
  → _build_query(status, consultation_id, tenant_id) — visibility query
  → _list_page() → client.list_workflows(query, page_size, token)
    → RPCError (SA unregistered) → degrade: re-query without SA + client-side memo filter
  → For each execution:
    → _resolve_tenant() → SA HarnessTenantId → memo fallback
    → _summary() → HarnessWorkflowSummary
```

**Data Integration**:
- **Temporal**: Visibility API (list_workflows, describe, queries)
- **Search Attributes**: HarnessTenantId (Keyword) for tenant filtering
- **Memo Fallback**: tenantId memo when SA unregistered

---

### 9. Admin Workflow Describe - GET /api/v1/internal/harness/workflows/{id}

**File**: `harness/api/endpoints/admin.py:297`
**Handler**: `describe_workflow(workflow_id, request, phase) -> dict`

**Implementation Chain**: handle.describe() → _resolve_tenant → _summary → phase query + result

---

### 9. Admin Workflow Cancel - POST /api/v1/internal/harness/workflows/{id}/cancel

**File**: `harness/api/endpoints/admin.py:329`
**Handler**: `cancel_workflow() -> dict`

**Implementation**: handle.cancel() → cooperative cancel

---

### 10. Health Endpoints

**File**: `harness/api/endpoints/health.py`

| Endpoint | Handler | Logic |
|----------|---------|-------|
| `/health` | `health_check()` | Always 200; process + Temporal config (no dial) |
| `/health/live` | `liveness()` | Always 200 |
| `/health/startup` | `startup()` | Checks service_release_task |
| `/health/ready` | `readiness()` | Temporal client + health RPC |

**Readiness**: Actually probes Temporal frontend (`client.service_client.check_health()`)

---

## Key Implementation Files

| File | Purpose |
|------|---------|
| `harness/main.py` | FastAPI app, lifespan, Temporal client |
| `harness/api/endpoints/internal.py` | Gateway-driven workflow signals |
| `harness/api/endpoints/admin.py` | Admin workflow ops |
| `harness/api/endpoints/eval.py` | Eval gate (golden set + PDSQI-9) |
| `harness/api/endpoints/knowledge.py` | Knowledge ingest/delete |
| `harness/api/endpoints/health.py` | Health probes |
| `harness/temporal/client.py` | Temporal client (lazy connect) |
| `harness/temporal/workflows.py` | HarnessDocWorkflow, ConsultationLoopWorkflow |
| `harness/temporal/models.py` | Workflow inputs, signals, configs |
| `harness/temporal/client.py` | Temporal client factory |
| `harness/guides/retrieval/*.py` | Chunking, embeddings, Qdrant, sparse |
| `harness/services/embeddings_client.py` | Dense embeddings (LM Studio) |
| `harness/services/reranker_client.py` | Reranker client |
| `harness/eval/ci.py` | Eval gate runner |
| `harness/eval/judge/pdsqi.py` | PDSQI-9 judge |
| `harness/eval/judge/providers.py` | Judge client builder |
| `harness/core/config.py` | Settings, Temporal config |
| `harness/core/observability.py` | OTel, logging, Prometheus |
| `harness/core/effective_config.py` | Control plane config client |
| `harness/core/dependencies.py` | FastAPI dependencies |
| `harness/core/tenant_config.py` | Tenant config resolver (removed) |

---

## Configuration (Control Plane)

| Key | Description |
|-----|-------------|
| `harness.temporal.address` | Temporal frontend address |
| `harness.temporal.namespace` | Temporal namespace |
| `harness.temporal.task_queue` | Task queue name |
| `harness.temporal.connect_timeout_s` | Connection timeout |
| `harness.max_regen` | Max regeneration attempts |
| `harness.gate_sla_seconds` | Gate SLA |
| `harness.gate_escalation_seconds` | Gate escalation |
| `harness.optimistic_delivery_enabled` | Optimistic delivery kill-switch |
| `harness.eval.max_cases_per_run` | Eval case cap |

---

## Sequence Diagrams

See generated sequence diagrams in `review/codewalk/diagrams/` (open `.html` files in browser):
- `harness-doc-start.html` — Document workflow start
- `harness-signal-approve.html` — Approval signal
- `harness-signal-context-added.html` — Context added (signal-with-start)
- `harness-eval-gate.html` — Eval gate (golden set + PDSQI-9)
- `harness-knowledge-ingest.html` — Knowledge ingest (chunk → embed → Qdrant)
- `harness-admin-list.html` — Admin workflow list (visibility query + SA degrade)
- `harness-health.html` — Health/readiness (Temporal probe)