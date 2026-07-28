# NLP Service Architecture

## Overview

The HOPE NLP Service is built using a clean, modular architecture that separates concerns across different layers. This document describes the system architecture, design patterns, and key components.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Client Applications                      │
│              (API Gateway, Web UI, Mobile Apps)              │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP/WebSocket
┌──────────────────────┴──────────────────────────────────────┐
│                    NLP Service (FastAPI)                     │
├──────────────────────────────────────────────────────────────┤
│  ┌────────────┐  ┌────────────┐  ┌────────────────────────┐ │
│  │ REST API   │  │ WebSocket  │  │  Health & Monitoring   │ │
│  │ Endpoints  │  │  Handlers  │  │    (Prometheus)        │ │
│  └─────┬──────┘  └─────┬──────┘  └────────────────────────┘ │
│        │               │                                     │
│  ┌─────┴───────────────┴─────────────────────────────────┐  │
│  │              Business Logic Layer                      │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  │  │
│  │  │Text         │  │Token          │  │Medical       │  │  │
│  │  │Classifier   │  │Classifier     │  │Suggester     │  │  │
│  │  └──────┬──────┘  └──────┬───────┘  └──────┬───────┘  │  │
│  │         │                │                   │          │  │
│  │  ┌──────┴────────────────┴───────────────────┴───────┐  │  │
│  │  │         Text Corrector Service                    │  │  │
│  │  └───────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │            ML Models Layer (Transformers)                │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │  │
│  │  │ Emotion Text │  │ Medical NER  │  │ Disease BERT │  │  │
│  │  │ Classifier   │  │   Model      │  │    Model     │  │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │            Infrastructure Layer                          │  │
│  │  • Logging  • Observability  • Security  • Config       │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

## Layered Architecture

### 1. API Layer (`api/`)

The API layer handles all external communication and routing.

**Components:**

- **REST Endpoints** (`api/v1/rest/`): Synchronous HTTP endpoints
  - `classify.py`: Text and token classification endpoints
  - `correct.py`: Text correction endpoints
  - `diagnosis.py`: Medical diagnosis suggestion endpoints
  - `monitoring.py`: Health checks and metrics

- **WebSocket Handlers** (`api/v1/ws/`): Real-time communication
  - `classify.py`: Streaming classification WebSocket

**Responsibilities:**

- Request/response handling
- Input validation using Pydantic
- Error handling and HTTP status codes
- API versioning
- CORS and security headers

### 2. Business Logic Layer (`services/`)

The services layer contains the core business logic and ML model interfaces.

**Services:**

#### Text Classifier Service

```python
class TransformerTextClassifier(TextClassifier):
    """
    Emotion text classification service

    Model: michellejieli/emotion_text_classifier
    Task: 11-class emotion classification
    Input: Text string
    Output: Label + confidence + probabilities
    """
```

**Features:**

- Emotion detection (anger, fear, joy, love, sadness, surprise, etc.)
- Confidence scoring
- Probability distribution across all classes
- GPU/CPU support

#### Token Classifier Service

```python
class TransformerTokenClassifier(TokenClassifier):
    """
    Medical NER service

    Model: blaze999/Medical-NER
    Task: Named Entity Recognition
    Input: Text string
    Output: List of entities with positions
    """
```

**Features:**

- Medical entity extraction (diseases, symptoms, treatments, medications)
- BIO tagging with position tracking
- Entity confidence scoring
- Aggregation strategies (simple, first, max, average)

#### Medical Suggester Service

```python
class MedicalSuggester:
    """
    Disease prediction service

    Model: shanover/symps_disease_bert_v3_c41
    Task: 41-class disease classification
    Input: Symptom text
    Output: Ranked disease suggestions
    """
```

**Features:**

- Symptom analysis
- Disease confidence ranking
- Top-K suggestions
- Minimum confidence filtering

#### Text Corrector Service

```python
class TextCorrector:
    """
    Spelling and terminology correction

    Engine: SymSpellPy
    Dictionaries: Medical terms (English + Malayalam)
    Task: Spelling correction
    """
```

**Features:**

- Fast spelling correction (SymSpell algorithm)
- Medical terminology dictionaries
- Multi-language support
- Alternative suggestions
- Configurable edit distance

### 3. Data Models Layer (`schemas/`)

Pydantic models for data validation and serialization.

**Model Categories:**

#### Classification Models (`classification.py`)

```python
class TextClassificationRequest(BaseModel):
    text: str
    language: Optional[SupportedLanguage]

class TextClassificationResponse(BaseModel):
    predicted_label: str
    confidence: float
    probabilities: Dict[str, float]
    model_version: str
```

#### Diagnosis Models (`diagnosis.py`)

```python
class DiagnosisSuggestionRequest(BaseModel):
    text: str
    min_confidence: Optional[float]
    language: Optional[SupportedLanguage]

class DiagnosisSuggestionResponse(BaseModel):
    suggestions: List[DiagnosisSuggestion]
    symptoms_analyzed: List[str]
    model_version: str
```

#### Common Models (`common.py`)

```python
class Entity(BaseModel):
    id: str
    text: str
    normalized_text: str
    entity_type: str
    confidence: float
    position: TextPosition
    model_version: str

class SupportedLanguage(str, Enum):
    ENGLISH = "en"
    MALAYALAM = "ml"
```

### 4. Core Layer (`core/`)

Core functionality and infrastructure concerns.

**Components:**

#### Configuration (`config.py`)

```python
class Settings:
    """Central configuration management"""
    service: NLPServiceConfig
    text_classification: TextClassificationConfig
    token_classification: TokenClassificationConfig
    medical_suggester: MedicalSuggesterConfig
    security: SecurityConfig
    text_corrector: TextCorrectorConfig
```

**Features:**

- Environment-based configuration
- Pydantic validation
- Type-safe settings
- Nested configuration classes

#### Logging (`logging.py`)

```python
def get_logger(name: str) -> logging.Logger:
    """Get structured logger with correlation IDs"""
```

**Features:**

- Structured JSON logging
- Correlation ID tracking
- Log levels (DEBUG, INFO, WARNING, ERROR)
- Performance metrics logging

#### Observability (`observability.py`)

```python
def setup_observability(app: FastAPI):
    """Configure OpenTelemetry tracing and Prometheus metrics"""
```

**Features:**

- OpenTelemetry tracing
- Prometheus metrics
- Custom business metrics
- Health check integration

#### WebSocket Manager (`websocket_manager.py`)

```python
class WebSocketManager:
    """Manage WebSocket connections and sessions"""
```

**Features:**

- Connection lifecycle management
- Session tracking
- Heartbeat/ping-pong
- Broadcast messaging

### 5. Infrastructure Layer (`infra/`)

Low-level infrastructure and utilities.

**Components:**

- Database connections (if needed)
- External service clients
- Caching mechanisms
- Message queues

## Design Patterns

### 1. Abstract Base Classes

All services implement abstract base classes for consistency:

```python
class TextClassifier(ABC):
    @abstractmethod
    async def initialize(self) -> None:
        """Load the model"""
        pass

    @abstractmethod
    async def process(self, request) -> Any:
        """Process the request"""
        pass

    @abstractmethod
    async def shutdown(self) -> None:
        """Clean up resources"""
        pass
```

**Benefits:**

- Enforces consistent interface
- Easy to swap implementations
- Clear contract for all services

### 2. Dependency Injection

Using FastAPI's dependency injection:

```python
def get_text_classifier() -> TextClassifier:
    """Dependency injection for text classifier"""
    return text_classifier_instance

@router.post("/classify/text")
async def classify_text(
    request: TextClassificationRequest,
    service: TextClassifier = Depends(get_text_classifier)
):
    return await service.process(request)
```

**Benefits:**

- Testability (easy mocking)
- Loose coupling
- Lifecycle management
- Singleton pattern

### 3. Factory Pattern

Application factory for FastAPI:

```python
def get_app() -> FastAPI:
    """Factory function to create FastAPI application"""
    app = FastAPI(
        title="Medical Entity Recognition & NLP Service",
        lifespan=lifespan,
    )

    # Configure middleware
    app.add_middleware(CORSMiddleware, ...)

    # Register routers
    app.include_router(api_router)

    return app
```

**Benefits:**

- Configuration flexibility
- Testing isolation
- Multiple instances support

### 4. Lifespan Events

Using FastAPI lifespan for model management:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle"""
    # Startup
    logger.info("Loading ML models...")
    await text_classifier.initialize()
    await token_classifier.initialize()
    await medical_suggester.initialize()

    yield  # Application runs

    # Shutdown
    logger.info("Shutting down ML models...")
    text_classifier.shutdown()
    token_classifier.shutdown()
```

**Benefits:**

- Clean startup/shutdown
- Resource management
- Graceful degradation

## Data Flow

### Text Classification Flow

```
Client Request
    ↓
FastAPI Endpoint (/api/v1/classify/text)
    ↓
Pydantic Validation (TextClassificationRequest)
    ↓
Dependency Injection (get_text_classifier)
    ↓
TextClassifier.process()
    ↓
Transformer Pipeline (michellejieli/emotion_text_classifier)
    ↓
Post-processing (probabilities, confidence)
    ↓
Pydantic Serialization (TextClassificationResponse)
    ↓
JSON Response to Client
```

### Token Classification Flow

```
Client Request
    ↓
FastAPI Endpoint (/api/v1/classify/tokens)
    ↓
Pydantic Validation (TokenClassificationRequest)
    ↓
Dependency Injection (get_token_classifier)
    ↓
TokenClassifier.process()
    ↓
Transformer Pipeline (blaze999/Medical-NER)
    ↓
Entity Aggregation (BIO tagging)
    ↓
Entity Objects Creation (with positions)
    ↓
Pydantic Serialization (TokenClassificationResponse)
    ↓
JSON Response to Client
```

### WebSocket Classification Flow

```
Client WebSocket Connection (ws://host/ws/classify/text/{session_id})
    ↓
WebSocket Connection Manager (accept connection)
    ↓
Session Registration (track active sessions)
    ↓
Message Loop (receive → process → send)
    ├─ Receive JSON message
    ├─ Parse WebSocketTextClassifyIncoming
    ├─ Process with TextClassifier
    ├─ Serialize to WebSocketTextClassifyOutgoing
    └─ Send JSON response
    ↓
Connection Close (unregister session)
```

## Concurrency Model

### Async/Await Pattern

All I/O operations use async/await:

```python
async def process(self, request: TextClassificationRequest):
    """Async processing for concurrent requests"""
    if not self.is_initialized:
        await self.initialize()

    # CPU-bound inference (runs in executor)
    result = await asyncio.to_thread(self.pipeline, request.text)

    return response
```

**Benefits:**

- High concurrency
- Non-blocking I/O
- Efficient resource usage
- Scalable to many concurrent requests

### Thread Safety

ML models are loaded once and shared:

```python
# Global instances (thread-safe)
text_classifier_instance = TransformerTextClassifier()
token_classifier_instance = TransformerTokenClassifier()

# Initialize on startup
@asynccontextmanager
async def lifespan(app: FastAPI):
    await text_classifier_instance.initialize()
    await token_classifier_instance.initialize()
    yield
```

**Considerations:**

- Models are loaded once
- Shared across all requests
- Thread-safe transformers library
- GPU serialization handled internally

## Error Handling

### Exception Hierarchy

```python
# Base exceptions
HTTPException  # FastAPI standard
    ├─ 400 Bad Request (validation errors)
    ├─ 404 Not Found (resource not found)
    ├─ 500 Internal Server Error (unexpected errors)
    └─ 503 Service Unavailable (model not loaded)

# Custom exceptions
class ModelNotLoadedException(Exception):
    """Raised when model is not initialized"""

class InferenceException(Exception):
    """Raised when model inference fails"""
```

### Error Handling Pattern

```python
@router.post("/classify/text")
async def classify_text(
    request: TextClassificationRequest,
    service: TextClassifier = Depends(get_text_classifier),
):
    try:
        # Check model availability
        if not service.is_initialized:
            raise HTTPException(
                status_code=503,
                detail="Text classification model not available"
            )

        # Process request
        result = await service.process(request)

        # Log success
        logger.info(f"Text classified with confidence {result.confidence:.3f}")

        return result

    except ValueError as e:
        # Validation errors
        logger.warning(f"Invalid input: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))

    except Exception as e:
        # Unexpected errors
        logger.error(f"Classification failed: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail="Classification failed")
```

## Performance Considerations

### Model Loading

- Models loaded once at startup
- Shared across all requests
- GPU memory allocated once
- Warm-up phase during initialization

### Batching

- Single request: Process immediately
- Batch requests: Process multiple texts together
- Dynamic batching based on queue depth
- Configurable batch size

### Caching

- Model weights cached by Transformers
- Hugging Face cache directory
- Docker volume for persistent cache
- Reduced startup time

### GPU Optimization

- CUDA memory management
- FP16 precision support
- Batch size tuning
- Multi-GPU support (future)

## Scalability

### Horizontal Scaling

```
Load Balancer
    ├─ NLP Instance 1 (CPU: 2 cores, RAM: 4GB)
    ├─ NLP Instance 2 (CPU: 2 cores, RAM: 4GB)
    └─ NLP Instance 3 (CPU: 2 cores, RAM: 4GB)
```

**Considerations:**

- Stateless service (no session state)
- Each instance loads models independently
- Round-robin or least-connections load balancing
- Health checks for instance availability

### Vertical Scaling

- Increase CPU cores for concurrent requests
- Increase RAM for larger models
- Add GPU for faster inference
- Tune batch size for throughput

## Security Architecture

### Input Validation

- Pydantic models for all inputs
- Type checking and coercion
- Length limits (max_length)
- Enum validation for languages

### API Security

- CORS configuration
- Rate limiting (at API Gateway)
- Input sanitization
- Output validation

### Container Security

- Non-root user (UID 1001)
- Distroless production image
- Read-only filesystem
- Minimal attack surface

## Monitoring & Observability

### Metrics

- Request count by endpoint
- Request duration (histograms)
- Error rates
- Model inference time
- Active connections (WebSocket)
- Resource usage (CPU, memory, GPU)

### Tracing

- OpenTelemetry integration
- Distributed tracing
- Request correlation IDs
- Span instrumentation

### Logging

- Structured JSON logs
- Correlation IDs
- Log levels (DEBUG, INFO, WARNING, ERROR)
- Performance metrics

### Health Checks

- Model availability
- Resource health
- Dependency checks
- Readiness vs. liveness

## Future Enhancements

### Planned Features

1. **Model Versioning**: Support multiple model versions
2. **A/B Testing**: Compare different models
3. **Batch API**: Dedicated batch processing endpoint
4. **Caching Layer**: Redis cache for common requests
5. **Model Quantization**: INT8 quantization for faster inference
6. **Multi-GPU Support**: Distribute models across GPUs
7. **Model Fine-tuning API**: Custom model training
8. **Explainability**: SHAP values and attention visualization

### Architecture Evolution

- Microservices decomposition (one service per model)
- Event-driven architecture (Kafka integration)
- CQRS pattern for read/write separation
- GraphQL API for flexible queries

## References

- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [Transformers Documentation](https://huggingface.co/docs/transformers)
- [Pydantic Documentation](https://docs.pydantic.dev/)
- [OpenTelemetry Documentation](https://opentelemetry.io/)
