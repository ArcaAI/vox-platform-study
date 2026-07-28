# Development Guide

Complete guide for developing and contributing to the HOPE NLP Service.

## Development Environment Setup

### Prerequisites

- **Python:** 3.11 or higher
- **UV Package Manager:** Latest version
- **Git:** For version control
- **Docker:** Optional, for containerized development
- **GPU:** Optional, NVIDIA GPU with CUDA 11.0+ for acceleration

### Initial Setup

```bash
# 1. Clone the repository
git clone <repository-url>
cd apps/nlp

# 2. Install UV package manager
curl -LsSf https://astral.sh/uv/install.sh | sh

# 3. Install dependencies
uv sync

# 4. Configure environment
cp env.example .env
# Edit .env with your settings

# 5. Run the service
uv run python src/nlp/main.py
```

### IDE Setup

#### VS Code

Recommended extensions:

- Python
- Pylance
- Python Test Explorer
- Docker
- YAML

**`.vscode/settings.json`:**

```json
{
  "python.linting.enabled": true,
  "python.linting.ruffEnabled": true,
  "python.formatting.provider": "black",
  "python.formatting.blackArgs": ["--line-length=120"],
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.organizeImports": true
  }
}
```

#### PyCharm

1. Open project in PyCharm
2. Configure Python interpreter (Python 3.11+)
3. Enable Black formatter
4. Enable Ruff linter
5. Set line length to 120

## Project Structure

```
apps/nlp/
├── src/nlp/                    # Source code
│   ├── api/                    # API endpoints
│   │   └── v1/
│   │       ├── rest/          # REST endpoints
│   │       └── ws/            # WebSocket endpoints
│   ├── core/                  # Core functionality
│   ├── services/              # Business logic
│   ├── schemas/               # Pydantic models
│   ├── infra/                 # Infrastructure
│   ├── app.py                 # FastAPI app
│   └── main.py                # Entry point
├── tests/                     # Test files
│   ├── unit/                  # Unit tests
│   ├── integration/           # Integration tests
│   └── fixtures/              # Test fixtures
├── docs/                      # Documentation
├── data/                      # Data files
│   └── dictionaries/          # Medical dictionaries
├── pyproject.toml             # Project configuration
├── uv.lock                    # Dependency lock file
├── Dockerfile                 # Docker build
├── env.example                # Environment template
└── README.md                  # Main documentation
```

## Development Workflow

### 1. Create Feature Branch

```bash
git checkout -b feature/your-feature-name
```

### 2. Write Code

Follow the coding standards (see below).

### 3. Write Tests

```bash
# Create test file
touch tests/unit/test_your_feature.py

# Write tests
import pytest
from nlp.services.your_service import YourService

def test_your_feature():
    service = YourService()
    result = service.process("test input")
    assert result is not None
```

### 4. Run Tests

```bash
# Run all tests
uv run pytest

# Run specific test
uv run pytest tests/unit/test_your_feature.py

# Run with coverage
uv run pytest --cov=src --cov-report=html
```

### 5. Code Quality Checks

```bash
# Format code
uv run black src/

# Lint code
uv run ruff src/

# Type check
uv run mypy src/
```

### 6. Commit Changes

```bash
git add .
git commit -m "feat: add your feature description"
```

### 7. Push and Create PR

```bash
git push origin feature/your-feature-name
```

## Coding Standards

### Python Style Guide

Follow PEP 8 with these additions:

- **Line Length:** 120 characters
- **String Quotes:** Double quotes for strings
- **Imports:** Organized (stdlib, third-party, local)
- **Type Hints:** Required for all public functions
- **Docstrings:** Google style for all public APIs

### Example Code Style

```python
"""Module docstring describing the module purpose."""

from typing import Optional, List
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from nlp.core.logging import get_logger
from nlp.schemas.common import Entity

logger = get_logger(__name__)


class ServiceConfig(BaseModel):
    """Configuration for the service.

    Attributes:
        model_name: Name of the ML model
        batch_size: Batch size for inference
    """
    model_name: str
    batch_size: int = 16


class YourService:
    """Your service description.

    This service provides functionality for...
    """

    def __init__(self, config: ServiceConfig):
        """Initialize the service.

        Args:
            config: Service configuration
        """
        self.config = config
        self.model = None

    async def initialize(self) -> None:
        """Load the model asynchronously."""
        logger.info(f"Loading model: {self.config.model_name}")
        # Load model logic
        self.model = await self._load_model()

    async def process(self, text: str) -> List[Entity]:
        """Process text and extract entities.

        Args:
            text: Input text to process

        Returns:
            List of extracted entities

        Raises:
            ValueError: If text is empty
            RuntimeError: If model is not loaded
        """
        if not text:
            raise ValueError("Text cannot be empty")

        if not self.model:
            raise RuntimeError("Model not loaded")

        # Processing logic
        entities = await self._extract_entities(text)

        logger.info(f"Extracted {len(entities)} entities")
        return entities

    async def _extract_entities(self, text: str) -> List[Entity]:
        """Private method to extract entities."""
        # Implementation
        return []

    async def _load_model(self):
        """Private method to load model."""
        # Implementation
        pass
```

### Naming Conventions

| Type            | Convention       | Example            |
| --------------- | ---------------- | ------------------ |
| Classes         | PascalCase       | `TextClassifier`   |
| Functions       | snake_case       | `extract_entities` |
| Variables       | snake_case       | `model_name`       |
| Constants       | UPPER_SNAKE_CASE | `MAX_BATCH_SIZE`   |
| Private Methods | _snake_case      | `_load_model`      |
| Type Variables  | PascalCase       | `ModelType`        |

### Import Organization

```python
# 1. Standard library
import os
import sys
from typing import List, Optional

# 2. Third-party
from fastapi import APIRouter
from pydantic import BaseModel
import torch

# 3. Local imports
from nlp.core.config import settings
from nlp.services.base import BaseService
from nlp.schemas.common import Entity
```

## Testing Guidelines

### Test Structure

```python
import pytest
from unittest.mock import Mock, patch

from nlp.services.text_classifier import TransformerTextClassifier
from nlp.schemas.classification import TextClassificationRequest


@pytest.fixture
def text_classifier():
    """Fixture for text classifier service."""
    return TransformerTextClassifier()


class TestTextClassifier:
    """Test suite for text classifier."""

    @pytest.mark.asyncio
    async def test_initialize(self, text_classifier):
        """Test model initialization."""
        await text_classifier.initialize()
        assert text_classifier.is_initialized is True

    @pytest.mark.asyncio
    async def test_process_happy_path(self, text_classifier):
        """Test successful text classification."""
        request = TextClassificationRequest(
            text="Patient is very happy",
            language="en"
        )

        result = await text_classifier.process(request)

        assert result.predicted_label is not None
        assert 0 <= result.confidence <= 1
        assert result.probabilities is not None

    @pytest.mark.asyncio
    async def test_process_empty_text(self, text_classifier):
        """Test classification with empty text."""
        with pytest.raises(ValueError):
            request = TextClassificationRequest(text="", language="en")
```

### Running Tests

```bash
# Run all tests
uv run pytest

# Run with coverage
uv run pytest --cov=src --cov-report=html --cov-report=term

# Run specific test file
uv run pytest tests/unit/test_text_classifier.py

# Run specific test
uv run pytest tests/unit/test_text_classifier.py::TestTextClassifier::test_initialize

# Run with verbose output
uv run pytest -v

# Run with output capture disabled (see print statements)
uv run pytest -s

# Run tests matching pattern
uv run pytest -k "test_text"
```

### Test Coverage

Aim for >80% code coverage:

```bash
# Generate coverage report
uv run pytest --cov=src --cov-report=html

# View report
open htmlcov/index.html
```

## Debugging

### Local Debugging

```python
# Add breakpoint
import pdb; pdb.set_trace()

# Or use breakpoint() in Python 3.7+
breakpoint()
```

### VS Code Debugging

**`.vscode/launch.json`:**

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Python: FastAPI",
      "type": "python",
      "request": "launch",
      "module": "uvicorn",
      "args": ["nlp.main:app", "--reload", "--host", "0.0.0.0", "--port", "8864"],
      "jinja": true,
      "justMyCode": false
    }
  ]
}
```

### Logging

```python
from nlp.core.logging import get_logger

logger = get_logger(__name__)

# Debug logging
logger.debug("Debug message", extra={"key": "value"})

# Info logging
logger.info("Processing request", extra={
    "text_length": len(text),
    "model": "text_classifier"
})

# Error logging
logger.error("Processing failed", exc_info=True)
```

## Docker Development

### Build Docker Image

```bash
# Debug build
docker build --target debug -t hope-nlp:debug .

# Production build
docker build --target production -t hope-nlp:prod .
```

### Run Docker Container

```bash
# Development mode
docker run -d \
  --name hope-nlp-dev \
  -p 8864:8864 \
  -v $(pwd)/src:/app/src \
  -e NLP_ENVIRONMENT=development \
  hope-nlp:debug

# Production mode
docker run -d \
  --name hope-nlp-prod \
  -p 8864:8864 \
  -e NLP_ENVIRONMENT=production \
  --env-file .env \
  hope-nlp:prod
```

### Docker Compose

```yaml
version: '3.8'

services:
  nlp:
    build:
      context: .
      target: debug
    ports:
      - '8864:8864'
    volumes:
      - ./src:/app/src
    environment:
      - NLP_ENVIRONMENT=development
      - NLP_LOG_LEVEL=DEBUG
```

## Performance Profiling

### Using cProfile

```python
import cProfile
import pstats

profiler = cProfile.Profile()
profiler.enable()

# Your code here
result = await service.process(request)

profiler.disable()
stats = pstats.Stats(profiler)
stats.sort_stats('cumulative')
stats.print_stats(10)
```

### Memory Profiling

```python
from memory_profiler import profile

@profile
async def process_large_batch(texts: List[str]):
    results = []
    for text in texts:
        result = await classifier.process(text)
        results.append(result)
    return results
```

## API Testing

### Using curl

```bash
# Text classification
curl -X POST http://localhost:8864/api/v1/classify/text \
  -H "Content-Type: application/json" \
  -d '{"text": "Patient is happy", "language": "en"}'
```

### Using Python requests

```python
import requests

response = requests.post(
    "http://localhost:8864/api/v1/classify/text",
    json={"text": "Patient is happy", "language": "en"}
)

print(response.json())
```

### Using pytest with FastAPI TestClient

```python
from fastapi.testclient import TestClient
from nlp.app import get_app

client = TestClient(get_app())

def test_classify_text():
    response = client.post(
        "/api/v1/classify/text",
        json={"text": "Patient is happy", "language": "en"}
    )
    assert response.status_code == 200
    data = response.json()
    assert "predicted_label" in data
```

## Common Development Tasks

### Adding a New Endpoint

1. Create route handler in `api/v1/rest/your_endpoint.py`
2. Define request/response models in `schemas/your_model.py`
3. Implement business logic in `services/your_service.py`
4. Register router in `api/v1/__init__.py`
5. Write tests in `tests/unit/test_your_endpoint.py`
6. Update API documentation

### Adding a New Service

1. Create service class in `services/your_service.py`
2. Implement abstract base class methods
3. Add service configuration in `core/config.py`
4. Register service in `dependencies.py`
5. Initialize service in `lifespan.py`
6. Write unit tests
7. Update documentation

### Adding a New Model

1. Download model from Hugging Face
2. Add model configuration in `core/config.py`
3. Create service wrapper in `services/`
4. Test model loading and inference
5. Update environment variables
6. Document model in `docs/03-models.md`

## Troubleshooting

### Model Loading Errors

```bash
# Check GPU availability
python -c "import torch; print(torch.cuda.is_available())"

# Clear model cache
rm -rf ~/.cache/huggingface/

# Check disk space
df -h ~/.cache/huggingface/
```

### Import Errors

```bash
# Verify installation
uv pip list

# Reinstall dependencies
uv sync --reinstall

# Check PYTHONPATH
echo $PYTHONPATH
```

### Port Already in Use

```bash
# Find process using port
lsof -ti:8864

# Kill process
kill -9 $(lsof -ti:8864)
```

## Best Practices

1. **Write Tests First** (TDD approach)
2. **Use Type Hints** everywhere
3. **Log Extensively** with structured logging
4. **Handle Errors Gracefully**
5. **Document Public APIs** with docstrings
6. **Keep Functions Small** (<50 lines)
7. **Use Async/Await** for I/O operations
8. **Cache When Appropriate**
9. **Monitor Performance**
10. **Review Code** before committing

## Resources

- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [Pydantic Documentation](https://docs.pydantic.dev/)
- [Pytest Documentation](https://docs.pytest.org/)
- [Python Type Hints](https://docs.python.org/3/library/typing.html)
- [Google Python Style Guide](https://google.github.io/styleguide/pyguide.html)
