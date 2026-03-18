# NLP Codemap

**Last Updated:** 2026-03-14  
**Language:** Python 3.11+ / FastAPI  
**Port:** 8864 (development)  
**Entry Point:** [src/nlp/main.py](../../../apps/nlp/src/nlp/main.py)

---

## 📋 Purpose

Medical NLP service for text analysis, classification, named entity recognition (NER), diagnosis support, and semantic understanding of medical documents. Integrates specialized medical NLP models with FastAPI.

---

## 🗂️ Directory Structure

```
apps/nlp/src/nlp/
├── app.py                     # FastAPI app factory
├── main.py                    # FastAPI entry point
├── dependencies.py            # FastAPI dependency injection
├── lifespan.py                # App lifecycle (startup/shutdown)
├── utils.py                   # Shared utilities
│
├── api/                       # FastAPI route modules
│   ├── health.py              # GET /health, /health/ready
│   ├── classification.py      # POST /classify (intent, severity)
│   ├── ner.py                 # POST /ner (entity extraction)
│   ├── diagnosis.py           # POST /diagnose (diagnostic support)
│   ├── similarity.py          # POST /similarity (semantic matching)
│   └── models.py              # GET /models (available models)
│
├── core/                      # Configuration & setup
│   ├── config.py              # Settings (pydantic-settings)
│   ├── constants.py           # App constants, enums
│   └── logging.py             # Logging configuration
│
├── services/                  # Business logic
│   ├── classifier.py          # Text classification service
│   ├── ner_service.py         # Named entity recognition
│   ├── diagnosis_service.py   # Diagnostic inference
│   ├── embedding_service.py   # Semantic embeddings
│   └── knowledge_base.py      # Medical knowledge lookups
│
├── models/                    # NLP model management
│   ├── model_registry.py      # Model loading • caching
│   ├── transformers_loader.py # HuggingFace Transformers
│   ├── medical_models.py      # Medical-specific models
│   └── entity_models.py       # NER models
│
├── infra/                     # Infrastructure integrations
│   ├── qdrant_client.py       # Vector DB (embedding search)
│   ├── postgres_client.py     # Medical knowledge DB
│   └── cache.py               # In-memory caching
│
├── schemas/                   # Pydantic request/response models
│   ├── classification.py      # Classification requests/responses
│   ├── ner.py                 # NER schemas
│   ├── diagnosis.py           # Diagnosis schemas
│   ├── embedding.py           # Embedding schemas
│   └── error.py               # Error response schemas
│
└── tests/                     # Unit and integration tests
    ├── unit/
    └── integration/
```

---

## 🔌 Key Services

### Classification Service
**Purpose**: Intent and severity classification

```python
class ClassificationService:
    async def classify(
        text: str,
        task: str = "intent"  # intent | severity | urgency
    ) -> ClassificationResult:
        # 1. Tokenize and preprocess
        # 2. Load model (cached)
        # 3. Inference
        # 4. Return predictions with scores
        
    async def batch_classify(
        texts: List[str],
        task: str = "intent"
    ) -> List[ClassificationResult]:
        # Efficient batch processing
```

### NER Service
**Purpose**: Medical entity extraction

```python
class NERService:
    async def extract_entities(
        text: str,
        entity_types: List[str] = None  # SYMPTOMS | DIAGNOSIS | MEDICATION
    ) -> NERResult:
        # 1. Tokenize
        # 2. Load NER model (medical-focused)
        # 3. Extract entities
        # 4. Link to medical knowledge base
        # 5. Return structured entities
```

### Diagnosis Service
**Purpose**: Diagnostic inference support

```python
class DiagnosisService:
    async def suggest_diagnoses(
        symptoms: List[str],
        patient_age: int = None,
        gender: str = None
    ) -> DiagnosisResult:
        # 1. Extract intent from symptoms
        # 2. Query medical knowledge base
        # 3. Rank possible diagnoses
        # 4. Return with confidence scores
```

### Embedding Service
**Purpose**: Semantic text understanding

```python
class EmbeddingService:
    async def embed_text(
        text: str
    ) -> List[float]:
        # 1. Load embedding model (medical)
        # 2. Tokenize
        # 3. Generate embedding
        # 4. Return vector
        
    async def find_similar(
        query_embedding: List[float],
        top_k: int = 5
    ) -> List[SimilarDocument]:
        # Search Qdrant for similar medical documents
```

---

## 🔄 Request Flow: Text Classification

```
POST /classify
  │
  ├─► Parse request (text, task, language)
  │
  ├─► Validate input
  │   • Language detection
  │   • Length checks
  │   • Format validation
  │
  ├─► Preprocess text
  │   • Tokenization
  │   • Lowercasing
  │   • Medical normalization
  │
  ├─► Load model (from cache if available)
  │   • HuggingFace Transformers
  │   • Medical fine-tuned version
  │
  ├─► Inference
  │   • Forward pass
  │   • Softmax probabilities
  │
  ├─► Post-process
  │   • Confidence filtering
  │   • Label mapping
  │
  └─► Return response
      {
        "intent": "appointment_request",
        "severity": "low",
        "confidence": 0.94,
        "alternatives": [...]
      }
```

---

## 🔬 Supported NLP Tasks

| Task | Purpose | Model |
|------|---------|-------|
| **Intent Classification** | User intent detection | Medical-BERT fine-tuned |
| **Severity Assessment** | Urgency level (low/high) | Clinical severity classifier |
| **NER** | Medical entity extraction | BioBERT + medical vocab |
| **Diagnosis Support** | Suggest diagnoses from symptoms | Medical knowledge graph |
| **Similarity** | Find similar medical cases | Sentence transformers |
| **Summarization** | Condense medical text | Fine-tuned T5 (optional) |

---

## 🗂️ Knowledge Integration

### Medical Knowledge Base
- Integrated with PostgreSQL curated medical data
- Diagnoses, symptoms, medications
- Hierarchical relationships (ICD-10, SNOMED-CT)

### Vector Search (Qdrant)
- Embed medical documents
- Semantic search for similar cases
- Recommendation queries

### Model Zoo (HuggingFace)
- `medical-bert-base` — Medical-specific BERT
- `bio-electra` — BioBERT variant
- `clinical-xlnet` — Clinical-specialized XLNet
- `sentence-transformers/medical-*` — Medical embeddings

---

## 🔗 External Dependencies

### Python Libraries
- `fastapi>=0.133.0` — Web framework
- `uvicorn[standard]>=0.41.0` — ASGI server
- `transformers>=4.45.0` — HuggingFace NLP models
- `torch>=2.2.0` — Deep learning framework
- `pydantic>=2.12.5` — Data validation
- `pydantic-settings>=2.13.1` — Config management
- `httpx>=0.28.1` — Async HTTP
- `asyncpg>=0.31.0` — Async PostgreSQL
- `qdrant-client>=1.12.0` — Vector DB client
- `numpy>=1.26.0` — Numerical computing
- `scikit-learn>=1.5.0` — ML utilities
- `nltk>=3.8.1` — NLP preprocessing
- `spacy>=3.8.0` — Tokenization/NLP (optional)

### ML Models
- Medical-BERT (HuggingFace)
- BioBERT
- Clinical XLNet
- Sentence Transformers (medical variant)

### Microservices
- **API Gateway** — Service consumer
- **PostgreSQL** — Medical knowledge base
- **Qdrant** — Vector database for embeddings

---

## ⚙️ Configuration

**Environment Variables**:

```bash
# FastAPI
HOST=0.0.0.0
PORT=8864

# Database (Medical Knowledge Base)
DATABASE_URL=postgresql+asyncpg://...

# Qdrant (Embeddings)
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=medical-documents

# Model Loading
MODEL_CACHE_DIR=/tmp/nlp-models
HF_MODEL_REPO=medical-bert-base
DEVICE=cuda              # cuda | cpu | mps

# Performance
BATCH_SIZE=32
INFERENCE_TIMEOUT=30     # seconds
MAX_SEQUENCE_LENGTH=512

# Caching
ENABLE_MODEL_CACHE=true
CACHE_TTL=3600           # seconds
```

---

## 📋 API Endpoints

### Health
- `GET /health` — Liveness probe
- `GET /health/ready` — Readiness probe (checks model loading)

### Classification
- `POST /classify` — Classify text (intent, severity, etc.)

### NER
- `POST /ner` — Extract medical entities

### Diagnosis
- `POST /diagnose` — Suggest diagnoses from symptoms

### Embeddings
- `POST /embed` — Generate text embedding
- `POST /search` — Find similar medical documents

### Model Info
- `GET /models` — List loaded models
- `GET /models/{name}/info` — Model metadata

---

## 🧪 Testing

**Unit Tests**:
```bash
pytest tests/unit/ -v
```

**Integration Tests**:
```bash
pytest tests/integration/ -v
```

**Load Testing**:
```bash
k6 run tests/load/classification.js
```

---

## 🔐 Security Considerations

- **No auth** on NLP endpoints (auth via API Gateway)
- **Input sanitization** for malicious text
- **Model integrity** — verify model checksums
- **HIPAA-compliant** — no PHI in logs
- **Rate limiting** via API Gateway

---

## 📊 Observability

### Logging
- Structured JSON logs
- Context: request_id, task, model, duration
- Sensitive info masking

### Metrics (Prometheus)
- `nlp_inference_duration_seconds`
- `nlp_model_load_duration_seconds`
- `nlp_cache_hit_ratio`
- `nlp_errors_total`

### Health Checks
- Model availability
- Database connectivity
- Qdrant connectivity
- GPU/device availability

---

## 🚀 Performance Tuning

### Model Caching
- LRU cache with configurable TTL
- Lazy loading on first use
- GPU memory management

### Batch Processing
- Support for batch inference
- Vectorized operations with NumPy/PyTorch

### Optimization
- ONNX model export (optional)
- Quantization for faster inference
- Async processing for long-running tasks

---

## 🔗 Related Codemaps

- [API Gateway](./api-gateway.md) — Service consumer
- [Database Package](../packages/database.md) — Medical knowledge schema
- [Med NER Package](../packages/med-ner.md) — Specialized NER implementation
- [Pipeline Package](../packages/pipeline.md) — Processing orchestration

---

**Status**: ✅ Current | NLP service active in development
