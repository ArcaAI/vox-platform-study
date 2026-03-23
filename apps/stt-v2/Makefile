# STT-v2 Service Makefile
# Common commands for development, testing, and deployment
#
# IMPORTANT: All commands use `conda run -n arcaenv` to ensure the correct
# conda environment is used. Run `make setup` first to create the environment.
#
# Conda Environment: arcaenv (Python 3.11)

.PHONY: help setup install install-dev install-ml test test-unit test-integration test-cov \
        test-unit-cpu test-unit-gpu test-unit-apple test-unit-all \
        test-integration-cpu test-integration-gpu test-integration-apple \
        lint format type-check build build-ml build-worker run run-worker \
        docker-build docker-run docker-stop validate-build clean \
        docker-test-cpu docker-test-gpu docker-test-apple

# Conda environment name
CONDA_ENV := arcaenv

# Conda run prefix
CONDA_RUN := conda run -n $(CONDA_ENV)

# Default target
help:
	@echo "STT-v2 Service - Available Commands"
	@echo ""
	@echo "  Uses conda environment: $(CONDA_ENV)"
	@echo ""
	@echo "Platform Setup (choose one based on your hardware):"
	@echo "  setup-cpu         CPU environment (no ML deps, lightweight)"
	@echo "  setup-cpu-ml      CPU environment with PyTorch (full ML on CPU)"
	@echo "  setup-gpu         NVIDIA CUDA environment (full ML with GPU)"
	@echo "  setup-apple       Apple Silicon MPS environment (full ML with MPS)"
	@echo "  setup             Alias for setup-cpu (default)"
	@echo "  check-env         Verify current environment configuration"
	@echo ""
	@echo "Add-on Installation (to existing environment):"
	@echo "  install-ml        Add ML dependencies (CPU)"
	@echo "  install-ml-gpu    Add ML dependencies (NVIDIA CUDA)"
	@echo "  install-ml-apple  Add ML dependencies (Apple Silicon MPS)"
	@echo ""
	@echo "Development:"
	@echo "  run             Run FastAPI server locally"
	@echo "  run-worker      Run Dramatiq worker locally"
	@echo ""
	@echo "Testing (Platform-Aware):"
	@echo "  test            Run all tests"
	@echo "  test-unit       Run unit tests (skips ML tests if no torch)"
	@echo "  test-unit-cpu   Run CPU tests only (no ML tests)"
	@echo "  test-unit-cpu-ml Run CPU tests with ML (requires setup-cpu-ml)"
	@echo "  test-unit-gpu   Run GPU tests (requires setup-gpu)"
	@echo "  test-unit-apple Run Apple Silicon tests (requires setup-apple)"
	@echo "  test-unit-all   Run all tests (requires any ML setup)"
	@echo "  test-integration Run integration tests (requires: pnpm docker:test:up)"
	@echo "  test-cov        Run tests with coverage report"
	@echo ""
	@echo "Docker Testing:"
	@echo "  docker-test-cpu   Run tests in CPU Docker container"
	@echo "  docker-test-gpu   Run tests in GPU Docker container (NVIDIA)"
	@echo "  docker-test-apple Run tests in ARM64 Docker container"
	@echo ""
	@echo "Code Quality:"
	@echo "  lint            Run linters (ruff)"
	@echo "  format          Format code (black, isort)"
	@echo "  type-check      Run type checking (mypy)"
	@echo ""
	@echo "Docker:"
	@echo "  docker-build        Build runtime Docker image (no ML)"
	@echo "  docker-build-ml     Build ML runtime Docker image (GPU/CUDA)"
	@echo "  docker-build-ml-cpu Build ML runtime Docker image (CPU only)"
	@echo "  docker-build-worker Build Dramatiq worker image (GPU)"
	@echo "  docker-build-worker-cpu Build Dramatiq worker image (CPU)"
	@echo "  docker-run          Run service in Docker"
	@echo "  docker-stop         Stop Docker container"
	@echo "  validate-build      Validate Docker build"
	@echo ""
	@echo "Cleanup:"
	@echo "  clean           Clean build artifacts"

# =============================================================================
# Setup & Installation (using conda)
# =============================================================================
#
# Platform-specific setup commands:
#   setup-cpu:      CPU-only environment (no ML dependencies) - lightweight
#   setup-cpu-ml:   CPU with ML dependencies (PyTorch CPU) - full ML on CPU
#   setup-gpu:      NVIDIA CUDA environment (full ML stack with GPU)
#   setup-apple:    Apple Silicon environment (MPS support + FFmpeg for torchcodec)
#
# Each setup command creates the conda environment and installs:
#   - Development (code editing, linting, formatting)
#   - Testing (pytest, coverage, mocking)
#   - Deployment (production dependencies)
#
# IMPORTANT: pyannote.audio 4.x hard-pins torch==2.8.0, torchaudio==2.8.0.
# Do NOT upgrade torch past 2.8.x until pyannote releases a compatible version.
# =============================================================================

# Default setup: CPU-only (lightweight, no ML deps)
setup: setup-cpu

# CPU Platform Setup - Lightweight (no ML)
# - No ML dependencies (torch, transformers, etc.)
# - Suitable for: API development, basic unit tests, CI/CD
setup-cpu:
	@echo "Setting up STT-v2 CPU environment (lightweight)..."
	@echo "   Conda environment: $(CONDA_ENV)"
	@echo "   Platform: CPU (no ML dependencies)"
	conda create -n $(CONDA_ENV) python=3.11 -y
	$(CONDA_RUN) pip install -e ".[dev,test]"
	@echo ""
	@echo "CPU environment ready!"
	@echo "   Run tests: make test-unit"
	@echo "   Run server: make run"
	@echo ""
	@echo "To add ML support, use one of:"
	@echo "   make setup-cpu-ml  # Full setup with CPU PyTorch"
	@echo "   make install-ml    # Add PyTorch to existing env"

# CPU Platform Setup - Full ML (PyTorch CPU)
# - Full ML stack running on CPU (no GPU required)
# - Suitable for: ML inference on CPU, full testing, development without GPU
setup-cpu-ml:
	@echo "Setting up STT-v2 CPU environment (with ML)..."
	@echo "   Conda environment: $(CONDA_ENV)"
	@echo "   Platform: CPU with PyTorch (CPU-only inference)"
	conda create -n $(CONDA_ENV) python=3.11 -y
	$(CONDA_RUN) pip install -e ".[ml,dev,test]"
	@echo ""
	@echo "Verifying PyTorch (CPU) installation..."
	@$(CONDA_RUN) python -c "import torch; print(f'PyTorch version: {torch.__version__}'); print(f'CUDA available: {torch.cuda.is_available()}'); print(f'Device: cpu')"
	@echo ""
	@echo "CPU ML environment ready!"
	@echo "   Run tests: make test-unit-all"
	@echo "   Run server: make run"

# NVIDIA GPU Platform Setup (CUDA)
# - Full ML stack with CUDA support
# - Suitable for: GPU inference, model training, full testing
setup-gpu:
	@echo "Setting up STT-v2 GPU (CUDA) environment..."
	@echo "   Conda environment: $(CONDA_ENV)"
	@echo "   Platform: NVIDIA CUDA"
	conda create -n $(CONDA_ENV) python=3.11 -y
	$(CONDA_RUN) pip install -e ".[ml-gpu,dev,test]"
	@echo ""
	@echo "Verifying CUDA availability..."
	@$(CONDA_RUN) python -c "import torch; print(f'PyTorch version: {torch.__version__}'); print(f'CUDA available: {torch.cuda.is_available()}'); print(f'CUDA version: {torch.version.cuda if torch.cuda.is_available() else \"N/A\"}'); print(f'GPU count: {torch.cuda.device_count() if torch.cuda.is_available() else 0}')" || echo "CUDA verification failed - GPU may not be available"
	@echo ""
	@echo "GPU environment ready!"
	@echo "   Run tests: make test-unit-gpu"
	@echo "   Run server: make run"

# Apple Silicon Platform Setup (MPS)
# - Full ML stack with MPS (Metal Performance Shaders) support
# - Installs FFmpeg 6.x (required by torchcodec, a pyannote.audio dependency)
# - Creates conda activation/deactivation scripts for DYLD_LIBRARY_PATH
# - Suitable for: Apple Silicon inference, full testing on macOS
setup-apple:
	@echo "Setting up STT-v2 Apple Silicon (MPS) environment..."
	@echo "   Conda environment: $(CONDA_ENV)"
	@echo "   Platform: Apple Silicon (MPS)"
	conda create -n $(CONDA_ENV) python=3.11 -y
	@echo ""
	@echo "Installing FFmpeg 6.x (required by torchcodec/pyannote.audio)..."
	conda install -n $(CONDA_ENV) -c conda-forge 'ffmpeg>=6,<7' -y
	@echo ""
	@echo "Creating DYLD_LIBRARY_PATH activation scripts..."
	@mkdir -p "$$(conda info --envs | grep $(CONDA_ENV) | awk '{print $$NF}')/etc/conda/activate.d"
	@mkdir -p "$$(conda info --envs | grep $(CONDA_ENV) | awk '{print $$NF}')/etc/conda/deactivate.d"
	@echo '#!/bin/sh' > "$$(conda info --envs | grep $(CONDA_ENV) | awk '{print $$NF}')/etc/conda/activate.d/env_vars.sh"
	@echo 'export OLD_DYLD_LIBRARY_PATH="$${DYLD_LIBRARY_PATH:-}"' >> "$$(conda info --envs | grep $(CONDA_ENV) | awk '{print $$NF}')/etc/conda/activate.d/env_vars.sh"
	@echo 'export DYLD_LIBRARY_PATH="$$CONDA_PREFIX/lib$${DYLD_LIBRARY_PATH:+:$$DYLD_LIBRARY_PATH}"' >> "$$(conda info --envs | grep $(CONDA_ENV) | awk '{print $$NF}')/etc/conda/activate.d/env_vars.sh"
	@echo '#!/bin/sh' > "$$(conda info --envs | grep $(CONDA_ENV) | awk '{print $$NF}')/etc/conda/deactivate.d/env_vars.sh"
	@echo 'export DYLD_LIBRARY_PATH="$$OLD_DYLD_LIBRARY_PATH"' >> "$$(conda info --envs | grep $(CONDA_ENV) | awk '{print $$NF}')/etc/conda/deactivate.d/env_vars.sh"
	@echo 'unset OLD_DYLD_LIBRARY_PATH' >> "$$(conda info --envs | grep $(CONDA_ENV) | awk '{print $$NF}')/etc/conda/deactivate.d/env_vars.sh"
	@echo ""
	@echo "Installing Python dependencies..."
	$(CONDA_RUN) pip install -e ".[ml,dev,test]"
	@echo ""
	@echo "Verifying MPS availability..."
	@$(CONDA_RUN) python -c "import platform; import torch; print(f'System: {platform.system()} {platform.machine()}'); print(f'PyTorch version: {torch.__version__}'); print(f'MPS available: {torch.backends.mps.is_available()}'); print(f'MPS built: {torch.backends.mps.is_built()}')" || echo "MPS verification failed"
	@echo ""
	@echo "Apple Silicon environment ready!"
	@echo "   Run tests: make test-unit-apple"
	@echo "   Run server: make run"

# Verify current environment
check-env:
	@echo "Current environment ($(CONDA_ENV)):"
	@$(CONDA_RUN) python -c "import platform; import sys; print(f'Python: {sys.version}'); print(f'System: {platform.system()} {platform.machine()}')"
	@$(CONDA_RUN) python -c "try:\n    import torch\n    print(f'PyTorch: {torch.__version__}')\n    print(f'CUDA: {torch.cuda.is_available()}')\n    mps = torch.backends.mps.is_available() if hasattr(torch.backends, 'mps') else False\n    print(f'MPS: {mps}')\nexcept ImportError:\n    print('PyTorch: Not installed (CPU-only environment)')" 2>/dev/null || echo "PyTorch: Not installed (CPU-only environment)"

# =============================================================================
# Individual Package Installation (for adding to existing env)
# =============================================================================

install:
	$(CONDA_RUN) pip install -e "."

install-dev:
	$(CONDA_RUN) pip install -e ".[dev,test]"

install-ml:
	@echo "Installing ML dependencies (CPU)..."
	$(CONDA_RUN) pip install -e ".[ml]"
	@$(CONDA_RUN) python -c "import torch; print(f'PyTorch {torch.__version__} installed')"

install-ml-gpu:
	@echo "Installing ML dependencies (NVIDIA CUDA)..."
	$(CONDA_RUN) pip install -e ".[ml-gpu]"
	@$(CONDA_RUN) python -c "import torch; print(f'PyTorch {torch.__version__}'); print(f'CUDA available: {torch.cuda.is_available()}')"

install-ml-apple:
	@echo "Installing ML dependencies (Apple Silicon MPS)..."
	@echo "   NOTE: Run 'make setup-apple' instead for full setup with FFmpeg."
	$(CONDA_RUN) pip install -e ".[ml]"
	@$(CONDA_RUN) python -c "import torch; print(f'PyTorch {torch.__version__}'); print(f'MPS available: {torch.backends.mps.is_available()}')"

# =============================================================================
# Development (using conda run)
# =============================================================================

run:
	$(CONDA_RUN) uvicorn stt_v2.main:app --host 0.0.0.0 --port 8861 --reload

run-worker:
	$(CONDA_RUN) dramatiq stt_v2.worker --processes 1 --threads 4

# =============================================================================
# Testing (using conda run)
# All test commands use conda run to ensure correct environment
#
# Auto-Detected Platform Testing:
#   The test framework automatically detects the best available hardware
#   (CUDA → MPS → CPU) and runs the appropriate tests.
#
#   Override with TEST_PLATFORM env var only if needed:
#     TEST_PLATFORM=cpu make test-e2e   # Force CPU-only (skip ML tests)
#     TEST_PLATFORM=all make test-e2e   # Force all tests regardless
# =============================================================================

test:
	$(CONDA_RUN) pytest tests/ -v -s --log-cli-level=INFO --tb=short

test-unit:
	$(CONDA_RUN) pytest tests/unit/ -v -s --log-cli-level=INFO --tb=short -m "not slow"

test-integration:
	@echo "Integration tests require test infrastructure."
	@echo "   Start with: pnpm docker:test:up (from monorepo root)"
	@echo ""
	$(CONDA_RUN) pytest tests/integration/ -v -s --log-cli-level=INFO --tb=short

test-e2e:
	$(CONDA_RUN) pytest tests/e2e/ -v -s --log-cli-level=INFO --tb=short

test-cov:
	$(CONDA_RUN) pytest tests/unit/ \
		--cov=src/stt_v2 \
		--cov-report=term-missing \
		--cov-report=html:coverage/html \
		--cov-report=xml:coverage.xml \
		--cov-fail-under=80

test-all:
	./scripts/run-tests.sh all

# =============================================================================
# Docker-based Testing
# Run tests inside Docker containers for consistent environments
# =============================================================================

docker-test-cpu:
	@echo "Running CPU tests in Docker..."
	docker compose -f docker/docker-compose.test.yml --profile cpu up --build --abort-on-container-exit
	docker compose -f docker/docker-compose.test.yml --profile cpu down

docker-test-gpu:
	@echo "Running GPU tests in Docker (NVIDIA)..."
	@echo "   Requires: NVIDIA Container Toolkit"
	docker compose -f docker/docker-compose.test.yml --profile gpu up --build --abort-on-container-exit
	docker compose -f docker/docker-compose.test.yml --profile gpu down

docker-test-apple:
	@echo "Running ARM64 tests in Docker..."
	@echo "   Note: MPS not available in Docker, runs CPU tests on ARM64"
	docker compose -f docker/docker-compose.test.yml --profile apple up --build --abort-on-container-exit
	docker compose -f docker/docker-compose.test.yml --profile apple down

# =============================================================================
# Code Quality (using conda run)
# =============================================================================

lint:
	$(CONDA_RUN) ruff check src/ tests/

lint-fix:
	$(CONDA_RUN) ruff check --fix src/ tests/

format:
	$(CONDA_RUN) black src/ tests/
	$(CONDA_RUN) isort src/ tests/

format-check:
	$(CONDA_RUN) black --check src/ tests/
	$(CONDA_RUN) isort --check-only src/ tests/

type-check:
	$(CONDA_RUN) mypy src/

quality: lint format-check type-check

# =============================================================================
# Docker
# =============================================================================

DOCKER_IMAGE ?= stt-v2
DOCKER_TAG ?= latest

docker-build:
	docker build \
		--target runtime \
		-t $(DOCKER_IMAGE):$(DOCKER_TAG) \
		-f docker/Dockerfile \
		.

docker-build-ml:
	docker build \
		--target ml-runtime \
		-t $(DOCKER_IMAGE):$(DOCKER_TAG)-ml \
		-f docker/Dockerfile \
		.

docker-build-ml-cpu:
	docker build \
		--target ml-runtime-cpu \
		-t $(DOCKER_IMAGE):$(DOCKER_TAG)-ml-cpu \
		-f docker/Dockerfile \
		.

docker-build-worker:
	docker build \
		--target worker \
		-t $(DOCKER_IMAGE):$(DOCKER_TAG)-worker \
		-f docker/Dockerfile \
		.

docker-build-worker-cpu:
	docker build \
		--target worker-cpu \
		-t $(DOCKER_IMAGE):$(DOCKER_TAG)-worker-cpu \
		-f docker/Dockerfile \
		.

docker-run:
	docker run -d \
		--name stt-v2 \
		-p 8001:8001 \
		-e DEBUG=true \
		$(DOCKER_IMAGE):$(DOCKER_TAG)

docker-stop:
	docker stop stt-v2 || true
	docker rm stt-v2 || true

docker-logs:
	docker logs -f stt-v2

validate-build:
	chmod +x scripts/validate-build.sh
	./scripts/validate-build.sh

# =============================================================================
# Docker Compose (Development)
# =============================================================================

dev-up:
	docker-compose -f docker/docker-compose.dev.yml up -d

dev-down:
	docker-compose -f docker/docker-compose.dev.yml down

dev-logs:
	docker-compose -f docker/docker-compose.dev.yml logs -f

dev-rebuild:
	docker-compose -f docker/docker-compose.dev.yml up -d --build

# =============================================================================
# Cleanup
# =============================================================================

clean:
	rm -rf build/
	rm -rf dist/
	rm -rf *.egg-info/
	rm -rf .pytest_cache/
	rm -rf .mypy_cache/
	rm -rf .ruff_cache/
	rm -rf coverage/
	rm -rf htmlcov/
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete
	find . -type f -name "*.pyo" -delete

# =============================================================================
# CI/CD (for GitHub Actions)
# =============================================================================

ci-setup:
	conda create -n $(CONDA_ENV) python=3.11 -y
	$(CONDA_RUN) pip install -e ".[test]"

ci-setup-ml:
	conda create -n $(CONDA_ENV) python=3.11 -y
	$(CONDA_RUN) pip install -e ".[ml,test]"

ci-test-unit:
	$(CONDA_RUN) pytest tests/unit/ \
		--cov=src/stt_v2 \
		--cov-report=xml:coverage.xml \
		--cov-report=term-missing \
		--junitxml=test-results.xml \
		-v

ci-test-integration:
	$(CONDA_RUN) pytest tests/integration/ \
		--cov=src/stt_v2 \
		--cov-report=xml:coverage.xml \
		--cov-report=term-missing \
		--junitxml=test-results.xml \
		-v

ci-build:
	docker build \
		--target runtime \
		-t $(DOCKER_IMAGE):$(DOCKER_TAG) \
		-f docker/Dockerfile \
		.
	docker build \
		--target ml-runtime-cpu \
		-t $(DOCKER_IMAGE):$(DOCKER_TAG)-ml-cpu \
		-f docker/Dockerfile \
		.
	docker build \
		--target ml-runtime \
		-t $(DOCKER_IMAGE):$(DOCKER_TAG)-ml \
		-f docker/Dockerfile \
		.
