# NLP (Natural Language Processing) Service - API Documentation

## Service Overview

**Path**: `apps/nlp/src/nlp/`
**Entry Point**: `nlp/main.py` → `uvicorn --factory nlp.app:get_app`
**Port**: 8863 (default)
**Framework**: FastAPI (Python 3.11+)

### Core Responsibilities
- Medical entity extraction (NER) via token classification
- Document classification (text & multi-label)
- Topic & intent classification (delegated to `text` service via LLM)
- Medical diagnosis suggestions (NER + disease classifier)
- Document text extraction (PDF OCR via PyMuPDF + RapidOCR)
- Text correction (spelling via SymSpell)
- Guardrail inference (PII detection, safety classification, entailment scoring) — **for `apps/guardrail`**
- WebSocket streaming classification (token & text)

### Model Architecture
| Model Family | Use Cases | Runtime |
|--------------|-----------|---------|
| **GLiNER2** | Token classification (NER), PII, safety classification | ONNX / transformers |
| **Transformer (BERT-based)** | Text classification, disease classification | transformers |
| **MiniCheck (NLI)** | Entailment scoring (guardrail) | GGUF / llama.cpp |
| **SymSpell** | Text correction (spelling) | Native Python |
| **External LLM (via `text` service)** | Topic/intent classification | Delegated |

### Infrastructure Dependencies
| Dependency | Purpose | Client |
|------------|---------|--------|
| Redis | Config cache, invalidation pub/sub, WebSocket session mgmt | redis.asyncio |
| HuggingFace Hub | Model weights (transformers/GLiNER) | transformers, onnxruntime |
| MinIO (S3) | Staged model weights (s3://, file://) | source_resolver |
| API Gateway | Spec resolution, service registration, auth, tenant injection | httpx |
| `text` service | LLM generation for topic/intent | ExternalTextClient |

---

## API Endpoints Summary

### Health & Monitoring (No Auth Required for /health, /health/live)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/health` | `health_check()` | Detailed component health (always 200) |
| GET | `/health/live` | `liveness()` | K8s liveness probe |
| GET | `/health/ready` | `readiness()` | K8s readiness probe |
| GET | `/health/startup` | `startup()` | K8s startup probe |

### Internal Model Resolvability (Service Token Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/v1/internal/models/resolvable` | `resolvable_one()` | Single model resolvability check |
| POST | `/api/v1/internal/models/resolvable` | `resolvable_batch()` | Batch model resolvability check |

### REST Classification (Service Token + Tenant Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/v1/classify/text` | `classify_text()` | Single-label document classification |
| POST | `/api/v1/classify/text/multi-label` | `classify_text_multi_label()` | Multi-label classification (toxicity, etc.) |
| POST | `/api/v1/classify/tokens` | `classify_tokens()` | Token classification + NER (medical entities) |
| POST | `/api/v1/classify/topic` | `classify_topic()` | Topic classification (delegated to `text` LLM) |
| POST | `/api/v1/classify/intent` | `classify_intent()` | Intent classification (delegated to `text` LLM) |

### REST Guardrail Inference (Service Token + Tenant Required) — for `apps/guardrail`
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/v1/guard/pii` | `guard_pii()` | PII entity extraction (GLiNER2) |
| POST | `/api/v1/guard/classify` | `guard_classify()` | Safety classification (GLiNER2 multi-task) |
| POST | `/api/v1/guard/entailment` | `guard_entailment()` | Entailment scoring (MiniCheck NLI) |

### REST Other (Service Token + Tenant Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/v1/extract` | `extract_document()` | PDF/image text extraction (PyMuPDF + RapidOCR) |
| POST | `/api/v1/correct/text` | `correct_text()` | Spelling correction (SymSpell) |
| POST | `/api/v1/diagnosis/suggestions` | `get_diagnosis_suggestions()` | Diagnosis suggestions (NER + disease classifier) |

### WebSocket Streaming (Service Token via WS handshake)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| WS | `/ws/classify/token/{session_id}` | `websocket_classify_token()` | Streaming token classification |
| WS | `/ws/classify/text/{session_id}` | `websocket_classify_text()` | Streaming text classification |

---

## Detailed API Documentation

### 1. Document Extraction - POST /api/v1/extract

**File**: `nlp/api/v1/rest/extract.py:13`
**Handler**: `extract_document(file, service: DocumentExtractor) -> ExtractionResponse`

**Implementation Chain**:
```
extract_document() [extract.py:13]
  → await file.read()
  → service.extract(content, filename, content_type) [services/document_extractor.py]
    → PyMuPDF: extract text layer from PDF
    → RapidOCR: OCR scanned pages / images
    → Returns: text, page_count, ocr_used
```

**Data Integration**:
- **In-Memory**: DocumentExtractor singleton (no ML weights)
- **Fail-Soft**: Always returns 200; empty extraction on error/corrupt input

---

### 2. Text Classification - POST /api/v1/classify/text

**File**: `nlp/api/v1/rest/classify.py:62`
**Handler**: `classify_text(request, inference_bound) -> TextClassificationResponse`

**Implementation Chain**:
```
classify_text() [classify.py:62]
  → Validate request.model_name (required, gateway-injected)
  → async with pinned_text_classifier(model_name, model_path) [dependencies.py:447]
    → _text_classifier_cache().pin(key) [dependencies.py:383]
    → _create_text_classifier() [dependencies.py:220]
      → _weights_source() → resolve model_path or hub id
      → TransformerTextClassifier.initialize() [services/text_classifier.py]
    → async with inference_bound [concurrency.py]
    → service.process(request) [services/text_classifier.py]
      → Transformers pipeline inference
```

**Data Integration**:
- **ModelCache** (`_text_classifier_cache`): Idle-TTL cache keyed by `(model_name, model_path)`
- **Pin-While-Active**: Model pinned for request duration, unpinned after
- **Concurrency**: `inference_bound` semaphore (control-plane refreshed)
- **Model Source**: HF Hub (default) or staged `s3://`/`file://` via `source_resolver`

---

### 3. Multi-Label Classification - POST /api/v1/classify/text/multi-label

**File**: `nlp/api/v1/rest/classify.py:104`
**Handler**: `classify_text_multi_label(request, inference_bound) -> MultiLabelClassificationResponse`

**Implementation Chain**: Same as `/classify/text` but calls `service.process_multi_label(request)`

**Use Case**: Toxicity detection (toxic + threat + insult all apply independently)

---

### 4. Token Classification (NER) - POST /api/v1/classify/tokens

**File**: `nlp/api/v1/rest/classify.py:152`
**Handler**: `classify_tokens(request, inference_bound) -> TokenClassificationResponse`

**Implementation Chain**:
```
classify_tokens() [classify.py:152]
  → Validate request.model_name
  → async with pinned_token_classifier(model_name, model_path) [dependencies.py:428]
    → _token_classifier_cache().pin(key)
    → _create_token_classifier() [dependencies.py:172]
      → _weights_source() + read_checkpoint_config()
      → is_gliner_checkpoint()? → Gliner2TokenClassifier : TransformerTokenClassifier
    → async with inference_bound
    → service.process(request) [services/token_classifier.py / gliner_token_classifier.py]
      → Returns entities with BIO tags, confidence, byte offsets
```

**Data Integration**:
- **Auto-Detection**: Checkpoint family (GLiNER vs Transformer) read from model's `config.json`
- **Fail-Closed**: Missing taxonomy (`ExtractorLabelsUnavailable`) → 503
- **Byte-Exact Offsets**: For guardrail redaction round-trip

---

### 5. Topic Classification - POST /api/v1/classify/topic

**File**: `nlp/api/v1/rest/classify.py:223`
**Handler**: `classify_topic(request, http_request, external_text_client, peer_call_bound) -> TopicClassificationResponse`

**Implementation Chain**:
```
classify_topic() [classify.py:223]
  → Validate request.instructions (tenant's topic list, required)
  → Validate external_text_client exists
  → _require_tenant() [api/tenant.py] — 428 if missing
  → _build_topic_prompt(text, topics)
  → async with peer_call_bound [dedicated semaphore]
  → external_text_client.generate_label_with_usage(prompt, tenant_id) [services/external_text_client.py]
    → POST to `text` service /api/v1/generate
    → Returns label + llm_usage + llm_guardrail_usage
```

**Data Integration**:
- **Delegation**: Calls `text` service (peer service) for LLM generation
- **Dedicated Semaphore**: `peer_call_bound` separate from `inference_bound`
- **Tenant Required**: Gateway must inject `tenant_id` (428 if absent)
- **Fail-Closed**: Missing instructions → 503

---

### 6. Intent Classification - POST /api/v1/classify/intent

**File**: `nlp/api/v1/rest/classify.py:282`
**Handler**: `classify_intent(...)` — Same pattern as topic, different prompt

---

### 7. Guardrail PII Extraction - POST /api/v1/guard/pii

**File**: `nlp/api/v1/rest/guard.py:270`
**Handler**: `guard_pii(request, http_request, inference_bound) -> GuardPiiResponse`

**Implementation Chain**:
```
guard_pii() [guard.py:270]
  → _require(model_name, tenant_id, "PII") — 428/503 if missing
  → Validate request.labels (taxonomy required, fail-closed)
  → lane = normalize_lane(latency_class) [guard_dispatch.py]
  → batch_size = batch_size_for(lane)
  → async with _acquire_guard(model_name, model_path) [dependencies.py:565]
    → _gliner2_guard_cache().pin(key) [dependencies.py:549]
    → _create_gliner2_guard() [dependencies.py:498]
      → resolve_guard_weights_source() — FAIL CLOSED on missing path
      → Gliner2GuardService.load() [services/gliner2_guard.py]
    → async with inference_bound
    → _submit_pii() [guard.py:139]
      → get_batcher(slot_key, "pii", run_batch, lane) [guard_dispatch.py]
        → Batcher: groups by (labels, threshold), submits to run_batch
      → run_batch() → service.batch_extract_entities(texts, labels, threshold, batch_size)
      → Returns spans + per-item inference_ms (TASK-959 metering)
```

**Data Integration**:
- **ModelCache** (`_gliner2_guard_cache`): Idle-TTL, pin-while-active
- **Batching**: Micro-batcher groups requests by (labels, threshold, lane)
- **Weight Resolution**: FAIL CLOSED on missing staged path (no HF fallback)
- **Metering**: Per-request share of batched forward pass time
- **Backpressure**: `InferenceQueueFull`/`Timeout` → 503 with `Retry-After: 1`

---

### 8. Guardrail Classification - POST /api/v1/guard/classify

**File**: `nlp/api/v1/rest/guard.py:342`
**Handler**: `guard_classify(...) -> GuardClassifyResponse`

**Implementation Chain**: Same batching pattern as PII, calls `service.batch_classify_text(texts, tasks, threshold, batch_size)`

**Returns**: Per-task verdicts (`results`) + confidences (`scores`), model_version, inference_ms, device

---

### 9. Guardrail Entailment - POST /api/v1/guard/entailment

**File**: `nlp/api/v1/rest/guard.py:421`
**Handler**: `guard_entailment(...) -> GuardEntailmentResponse`

**Implementation Chain**:
```
guard_entailment() [guard.py:421]
  → _require(model_name, tenant_id, "entailment")
  → async with _acquire_scorer(model_name, model_path, calibration) [dependencies.py:595]
    → _entailment_scorer_cache().pin(key)
    → _create_entailment_scorer() [dependencies.py:533]
      → MiniCheckLoadSpec(model_id, model_path, calibration) — FAIL CLOSED if missing
      → load_minicheck_scorer() [services/entailment_scorer.py] — GGUF via llama.cpp
    → async with inference_bound
    → scorer.score_pairs(pairs) → probabilities
```

**Data Integration**:
- **Calibration in Cache Key**: Changed calibration = cache miss (validated against old bounds)
- **GGUF Only**: Staged path required, no HF fallback
- **Metering**: inference_ms on cheaper unit (TASK-959)

---

### 9. Diagnosis Suggestions - POST /api/v1/diagnosis/suggestions

**File**: `nlp/api/v1/rest/diagnosis.py:15`
**Handler**: `get_diagnosis_suggestions(...) -> DiagnosisSuggestionResponse`

**Implementation Chain**:
```
get_diagnosis_suggestions() [diagnosis.py:15]
  → Validate BOTH model_name (disease) AND ner_model_name (symptom extractor)
  → async with pinned_medical_suggester(model_name, model_path, ner_model_name, ner_model_path)
    → _medical_suggester_cache().pin(key) [dependencies.py:391]
    → _create_medical_suggester() [dependencies.py:249]
      → Creates BOTH: disease classifier + dedicated NER (TransformerTokenClassifier)
    → async with inference_bound
    → service.suggest(request) [services/medical_suggester.py]
      → NER extracts symptoms → disease classifier suggests diagnoses
```

**Key Design**: Dedicated NER instance (not shared with token classifier cache) — suggester's eviction would unload weights the other cache believes it's serving.

---

### 10. Text Correction - POST /api/v1/correct/text

**File**: `nlp/api/v1/rest/correct.py:13`
**Handler**: `correct_text(request, service: TextCorrector) -> TextCorrectionResponse`

**Implementation Chain**:
```
correct_text() [correct.py:13]
  → get_text_corrector() [dependencies.py:67] → SymSpellCorrector singleton
  → service.correct(request) [services/text_corrector.py]
    → SymSpell dictionary lookup + correction
```

**Data Integration**: Process singleton (SymSpell dictionaries), lazy init on first `/correct`

---

### 11. WebSocket Token Classification - WS /ws/classify/token/{session_id}

**File**: `nlp/api/v1/ws/classify.py:83`
**Handler**: `websocket_classify_token(websocket, session_id, ws_manager)`

**Protocol**:
```
Client → {"tenant_id", "model_name", "model_path", "text", ...}
Server → TokenClassificationResponse (entities, confidence, offsets)
```

**Implementation Chain**:
```
websocket_classify_token() [classify.py:83]
  → enforce_service_token_ws() [middleware/auth.py]
  → ws_manager.handle_connection() [core/websocket_manager.py]
    → _bounded(pinned_token_classifier, parse, "token classification", header_tenant)
      → Per-message: validate tenant/model → pin → inference_bound → service.process()
```

**Key Design**: Per-message model resolution (socket picks up model changes on next message)

---

### 12. WebSocket Text Classification - WS /ws/classify/text/{session_id}

**File**: `nlp/api/v1/ws/classify.py:109`
**Handler**: `websocket_classify_text(...)` — Same pattern, uses `pinned_text_classifier`

---

### 13. Model Resolvability - GET/POST /api/v1/internal/models/resolvable

**File**: `nlp/api/v1/rest/models.py:79,98`
**Handler**: `resolvable_one()` / `resolvable_batch()`

**Implementation Chain**: Same as STT/TTS — `check_resolvable_many()` off event loop, 60s budget

**warm** field: `"pending"` | `"true"` | `"false"` (boot warmup verdict)

---

### 14. Health Endpoints

#### GET /health
**File**: `nlp/api/v1/rest/monitoring.py:64`
**Handler**: `health_check(request) -> dict`

Returns: `{"status": "healthy", "service", "version", "uptime", "timestamp", "checks: {component: {status: "lazy", loaded: bool, loaded_models: []}} }`

**Component Checks**: Reads from `model_cache_snapshot()` — cache-backed components report `"lazy"` (never `unhealthy`)

#### GET /health/live
**File**: `nlp/api/v1/rest/monitoring.py:115`
**Handler**: `liveness()` — Always 200 healthy

#### GET /health/startup
**File**: `nlp/api/v1/rest/monitoring.py:121`
**Handler**: `startup(request)` — Checks `app.state.service_release_task` attribute

#### GET /health/ready
**File**: `nlp/api/v1/rest/monitoring.py:163`
**Handler**: `readiness(request)` — Checks `effective_config_client` exists (startup complete)

**Readiness Does NOT Gate on Models**: Models load lazily; requiring warmed models would leave workers permanently unready (BUG-010 fix)

---

## Model Cache Architecture

**File**: `nlp/dependencies.py` + `nlp/services/model_cache.py`

### Three Main Caches (+ Guardrail Caches)
| Cache | Global | Model Types | Key |
|-------|--------|-------------|-----|
| Token Classifier | `_token_classifier_cache_instance` | GLiNER2 / Transformer NER | `(model_name, model_path)` |
| Text Classifier | `_text_classifier_cache_instance` | Document type, toxicity | `(model_name, model_path)` |
| Medical Suggester | `_medical_suggester_cache_instance` | Disease + NER pair | `(model, path, ner_model, ner_path)` |
| GLiNER2 Guard | `_gliner2_guard_cache_instance` | PII, safety classification | `(model_name, model_path)` |
| Entailment Scorer | `_entailment_scorer_cache_instance` | MiniCheck NLI | `(model, path, calibration)` |

### Cache Properties
- **Idle-TTL**: Control-plane configurable (`model_cache_ttl_seconds`, default 3600)
- **Max Size**: Control-plane configurable (`model_cache_max_models`)
- **Pin-While-Active**: `pin()` on request enter, `unpin()` on exit (never evicted mid-flight)
- **Sweep Task**: Periodic `sweep_model_caches()` releases idle-expired models
- **Weight Resolution**: `_weights_source()` — staged path > HF Hub id; `s3://`/`file://` via `source_resolver`

---

## Concurrency Control

**File**: `nlp/core/concurrency.py`

| Semaphore | Purpose | Refreshed From |
|-----------|---------|----------------|
| `inference_bound` | Local GPU/CPU inference slots | Control plane (`inference_limit`) |
| `peer_call_bound` | Outbound calls to `text` service | Control plane (`peer_call_limit`) |

**Separation**: Topic/intent delegation uses `peer_call_bound`; local inference uses `inference_bound`. Prevents burst of LLM calls from starving local NER.

---

## Key Implementation Files

| File | Purpose |
|------|---------|
| `nlp/main.py` | Uvicorn entrypoint (factory mode) |
| `nlp/app.py` | FastAPI factory, middleware, observability |
| `nlp/lifespan.py` | Startup/shutdown: caches, warmup, Redis, registration |
| `nlp/dependencies.py` | Model caches, pin-while-active, weight resolution |
| `nlp/services/model_cache.py` | Generic ModelCache (TTL, LRU, pin, sweep) |
| `nlp/services/token_classifier.py` | TransformerTokenClassifier |
| `nlp/services/gliner_token_classifier.py` | Gliner2TokenClassifier (GLiNER family) |
| `nlp/services/text_classifier.py` | TransformerTextClassifier |
| `nlp/services/gliner2_guard.py` | GLiNER2 guard runtime (PII/safety) |
| `nlp/services/entailment_scorer.py` | MiniCheck NLI scorer (GGUF) |
| `nlp/services/medical_suggester.py` | Disease suggestion (NER + classifier) |
| `nlp/services/document_extractor.py` | PDF OCR (PyMuPDF + RapidOCR) |
| `nlp/services/text_corrector.py` | SymSpellCorrector |
| `nlp/services/external_text_client.py` | Peer client to `text` service |
| `nlp/services/guard_dispatch.py` | Micro-batching for guardrail routes |
| `nlp/core/batching.py` | Batcher implementation (queue, timeout, depth) |
| `nlp/core/concurrency.py` | ResizableSemaphore (control-plane refreshed) |
| `nlp/core/checkpoint_family.py` | GLiNER vs Transformer detection from config.json |
| `nlp/core/device.py` | Device resolution (cuda/mps/cpu) |
| `nlp/core/effective_config.py` | Control plane config client |
| `nlp/core/observability.py` | OpenTelemetry, Prometheus, logging |
| `nlp/api/v1/rest/*.py` | REST endpoints |
| `nlp/api/v1/ws/classify.py` | WebSocket endpoints |
| `nlp/schemas/*.py` | Pydantic request/response models |

---

## Configuration Keys (Control Plane)

| Key | Description | Default |
|-----|-------------|---------|
| `nlp.service.warmModels` | Comma-separated `modelName[=path]` to pre-load at boot | `""` |
| `nlp.service.modelCacheTtlSeconds` | Model cache idle TTL | `3600` |
| `nlp.service.modelCacheMaxModels` | Max models in cache | `10` |
| `nlp.service.inferenceLimit` | Local inference concurrency | `4` |
| `nlp.service.peerCallLimit` | Outbound `text` calls concurrency | `4` |
| `nlp.service.inferenceDevice` | `cuda`/`mps`/`cpu` | `cpu` |
| `nlp.service.inferenceDeviceCpuOnlyModules` | Modules forced to CPU | `[]` |

---

## Sequence Diagrams

See generated sequence diagrams in `review/codewalk/diagrams/` (open `.html` files in browser):
- `nlp-token-classification.html` — Token classification (NER) flow
- `nlp-text-classification.html` — Text classification flow
- `nlp-topic-intent-delegation.html` — Topic/intent → `text` service delegation
- `nlp-guard-pii.html` — Guardrail PII extraction with micro-batching
- `nlp-guard-entailment.html` — Guardrail entailment scoring (MiniCheck)
- `nlp-diagnosis-suggestions.html` — Diagnosis suggestions (NER + classifier)
- `nlp-model-cache.html` — Model cache pin-while-active + TTL sweep
- `nlp-health-readiness.html` — Health/readiness (lazy model aware)