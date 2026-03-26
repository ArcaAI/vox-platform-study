"""Root test configuration for STT-v2.

This conftest integrates with the monorepo's centralized test infrastructure.

Infrastructure modes (resolved in this priority order):
  1. Environment variables — TEST_DATABASE_URL, TEST_REDIS_URL, TEST_MINIO_ENDPOINT
     Set by CI pipelines (GitLab CI, GitHub Actions) for external infrastructure.
  2. Docker Compose test containers — tests/docker-compose.test.yml
     Start: pnpm docker:test:up   Stop: pnpm docker:test:down

External Test Infrastructure (CI):
  PostgreSQL HA:  10.10.1.250:5000  (HAProxy R/W VIP → vox_dev)
  Redis Dev:      10.10.1.120:6379  (DB 8 reserved for CI tests)

Local Test Ports (matching monorepo's docker-compose.test.yml):
  PostgreSQL: 5433 (test) vs 5432 (dev)
  Redis:      6380 (test) vs 6379 (dev)
  MinIO:      9002 (test) vs 9000 (dev)

Conda Environment: arcaenv
  All test commands use: conda run --no-banner -n arcaenv pytest ...

Platform Auto-Detection:
  The test framework automatically detects the best available hardware
  (CUDA → MPS → CPU) and runs the appropriate tests. No manual platform
  configuration is needed.

  Override only if necessary:
    TEST_PLATFORM=cpu make test-e2e   # Force CPU-only (skip ML tests)
    TEST_PLATFORM=all make test-e2e   # Force all tests regardless

This conftest provides fixtures that work with:
  1. Monorepo's centralized test infrastructure (docker-compose.test.yml)
  2. GitHub Actions service containers (CI/CD)
  3. GitLab CI with external HA-Postgres and Redis
  4. Environment variables (for custom setups)
  5. Automatic hardware-based test selection
"""

import asyncio
import os
from collections.abc import Generator

import pytest

# Test infrastructure ports (matching monorepo's tests/docker-compose.test.yml)
TEST_DB_PORT = 5433
TEST_REDIS_PORT = 6380
TEST_MINIO_PORT = 9002


def _get_db_url(sync: bool = False) -> str:
    """Get database URL for tests.

    Priority: TEST_DATABASE_URL env var > local docker-compose defaults.
    When the env var is set (CI pipelines), normalise the driver prefix
    so callers always get the correct sync/async URL.
    """
    test_url = os.environ.get("TEST_DATABASE_URL")
    if test_url:
        if sync:
            return (
                test_url
                .replace("postgresql+asyncpg://", "postgresql://")
                .replace("postgres+asyncpg://", "postgresql://")
            )
        if "asyncpg" not in test_url:
            return test_url.replace("postgresql://", "postgresql+asyncpg://")
        return test_url

    base_url = f"postgresql://test:test@localhost:{TEST_DB_PORT}/hope_test"
    if sync:
        return base_url
    return base_url.replace("postgresql://", "postgresql+asyncpg://")


def _get_redis_url() -> str:
    """Get Redis URL for tests."""
    return os.environ.get("TEST_REDIS_URL", f"redis://localhost:{TEST_REDIS_PORT}/0")


def _get_minio_config() -> dict:
    """Get MinIO config for tests."""
    return {
        "endpoint": os.environ.get("TEST_MINIO_ENDPOINT", f"localhost:{TEST_MINIO_PORT}"),
        "access_key": os.environ.get("TEST_MINIO_ACCESS_KEY", "test"),
        "secret_key": os.environ.get("TEST_MINIO_SECRET_KEY", "testpassword"),
        "secure": False,
    }


def pytest_configure(config):
    """Configure pytest markers."""
    config.addinivalue_line(
        "markers", "integration: marks tests as integration tests (require external services)"
    )
    config.addinivalue_line(
        "markers", "e2e: marks tests as end-to-end tests (require full stack)"
    )
    config.addinivalue_line(
        "markers", "slow: marks tests as slow (long running)"
    )
    # Platform-specific markers
    config.addinivalue_line(
        "markers", "cpu: marks tests that run on CPU only"
    )
    config.addinivalue_line(
        "markers", "gpu: marks tests that require any GPU (CUDA or MPS)"
    )
    config.addinivalue_line(
        "markers", "cuda: marks tests that require NVIDIA CUDA GPU"
    )
    config.addinivalue_line(
        "markers", "mps: marks tests that require Apple Silicon MPS"
    )
    config.addinivalue_line(
        "markers", "apple_silicon: marks tests specific to Apple Silicon platform"
    )
    config.addinivalue_line(
        "markers", "ml: marks tests that require ML dependencies (torch, etc.)"
    )


@pytest.fixture(scope="session")
def event_loop() -> Generator[asyncio.AbstractEventLoop, None, None]:
    """Create event loop for async tests."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


# =============================================================================
# Test Environment Detection
# =============================================================================


def is_ci_environment() -> bool:
    """Check if running in CI environment (GitHub Actions)."""
    return os.environ.get("CI") == "true"


def has_test_services_env() -> bool:
    """Check if test service env vars are set."""
    return all([
        os.environ.get("TEST_DATABASE_URL"),
        os.environ.get("TEST_REDIS_URL"),
        os.environ.get("TEST_MINIO_ENDPOINT"),
    ])


# =============================================================================
# Platform Detection and Auto-Skip Logic
# =============================================================================


def _get_platform_type() -> str:
    """Get current platform type (cpu, cuda, mps)."""
    try:
        from stt_v2.core.platform import detect_platform
        return detect_platform().value
    except ImportError:
        return "cpu"


# ---------------------------------------------------------------------------
# Pytest markers for platform-specific tests
# (Moved from stt_v2.core.platform to avoid importing pytest in production)
# ---------------------------------------------------------------------------


def skip_if_not_cuda():
    """Return pytest skip marker if CUDA is not available."""
    from stt_v2.core.platform import PlatformType, detect_platform

    platform_type = detect_platform()
    return pytest.mark.skipif(
        platform_type != PlatformType.CUDA,
        reason="CUDA not available",
    )


def skip_if_not_mps():
    """Return pytest skip marker if MPS is not available."""
    from stt_v2.core.platform import PlatformType, detect_platform

    platform_type = detect_platform()
    return pytest.mark.skipif(
        platform_type != PlatformType.MPS,
        reason="MPS not available",
    )


def skip_if_not_gpu():
    """Return pytest skip marker if no GPU is available."""
    from stt_v2.core.platform import PlatformType, detect_platform

    platform_type = detect_platform()
    return pytest.mark.skipif(
        platform_type == PlatformType.CPU,
        reason="No GPU available (CUDA or MPS)",
    )


# Pre-computed markers for common use
requires_cuda = skip_if_not_cuda()
requires_mps = skip_if_not_mps()
requires_gpu = skip_if_not_gpu()


def _get_test_platform() -> str:
    """Get the target test platform from environment variable.

    When TEST_PLATFORM is not set, auto-detects from hardware so that
    ML tests run on any capable machine without manual configuration.

    Set TEST_PLATFORM env var to override auto-detection:
    - cpu: Run CPU-only tests (skip ML tests)
    - gpu: Run GPU tests (CUDA or MPS)
    - cuda: Run CUDA-specific tests
    - mps: Run MPS-specific tests
    - all: Run all tests regardless of platform
    """
    explicit = os.environ.get("TEST_PLATFORM", "").lower()
    if explicit:
        return explicit
    # Auto-detect: use actual hardware capability
    return _get_platform_type()


def pytest_collection_modifyitems(config, items):
    """Auto-skip tests based on platform markers and TEST_PLATFORM env var.

    This hook runs after test collection and before test execution.
    It automatically skips tests that don't match the current platform.
    """
    test_platform = _get_test_platform()
    current_platform = _get_platform_type()

    # If TEST_PLATFORM=all, run everything
    if test_platform == "all":
        return

    skip_cuda = pytest.mark.skip(
        reason=f"CUDA tests skipped (detected platform: {current_platform})"
    )
    skip_mps = pytest.mark.skip(
        reason=f"MPS tests skipped (detected platform: {current_platform})"
    )
    skip_gpu = pytest.mark.skip(
        reason=f"GPU tests skipped (detected platform: {current_platform})"
    )
    skip_ml = pytest.mark.skip(
        reason=f"ML tests skipped (detected platform: {current_platform}, no accelerator)"
    )

    for item in items:
        markers = {marker.name for marker in item.iter_markers()}

        # Handle CUDA marker
        if "cuda" in markers:
            if test_platform not in ("cuda", "gpu", "all"):
                item.add_marker(skip_cuda)
            elif current_platform != "cuda":
                item.add_marker(pytest.mark.skip(reason="CUDA not available on this platform"))

        # Handle MPS marker
        if "mps" in markers:
            if test_platform not in ("mps", "gpu", "all"):
                item.add_marker(skip_mps)
            elif current_platform != "mps":
                item.add_marker(pytest.mark.skip(reason="MPS not available on this platform"))

        # Handle GPU marker (either CUDA or MPS)
        if "gpu" in markers:
            if test_platform not in ("gpu", "cuda", "mps", "all"):
                item.add_marker(skip_gpu)
            elif current_platform == "cpu":
                item.add_marker(pytest.mark.skip(reason="No GPU available on this platform"))

        # Handle ML marker (requires torch)
        if "ml" in markers:
            if test_platform == "cpu":
                item.add_marker(skip_ml)


# =============================================================================
# Platform Fixtures
# =============================================================================


@pytest.fixture(scope="session")
def platform_type() -> str:
    """Get the current platform type."""
    return _get_platform_type()


@pytest.fixture(scope="session")
def test_platform() -> str:
    """Get the target test platform from environment."""
    return _get_test_platform()


@pytest.fixture(scope="session")
def platform_info():
    """Get detailed platform information."""
    try:
        from stt_v2.core.platform import get_platform_info
        return get_platform_info()
    except ImportError:
        return None


@pytest.fixture
def device_string(platform_type: str) -> str:
    """Get the device string for PyTorch operations."""
    return platform_type


# =============================================================================
# Database Fixtures (using local helpers to avoid import issues in unit tests)
# =============================================================================


@pytest.fixture(scope="session")
def database_url():
    """Get database URL for tests."""
    return _get_db_url(sync=False)  # asyncpg URL


@pytest.fixture(scope="session")
def sync_database_url():
    """Get sync database URL for tests (psycopg2)."""
    return _get_db_url(sync=True)


@pytest.fixture(scope="session")
def redis_url():
    """Get Redis URL for tests."""
    return _get_redis_url()


@pytest.fixture(scope="session")
def minio_config():
    """Get MinIO config for tests."""
    return _get_minio_config()


# =============================================================================
# Common Test Fixtures
# =============================================================================


@pytest.fixture
def sample_audio_bytes():
    """Generate sample WAV audio bytes."""
    import io
    import struct

    import numpy as np

    sample_rate = 16000
    duration = 1.0
    frequency = 440

    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    samples = (np.sin(2 * np.pi * frequency * t) * 0.5 * 32767).astype(np.int16)

    wav_buffer = io.BytesIO()
    wav_buffer.write(b'RIFF')
    wav_buffer.write(struct.pack('<I', 36 + len(samples) * 2))
    wav_buffer.write(b'WAVE')
    wav_buffer.write(b'fmt ')
    wav_buffer.write(struct.pack('<I', 16))
    wav_buffer.write(struct.pack('<H', 1))
    wav_buffer.write(struct.pack('<H', 1))
    wav_buffer.write(struct.pack('<I', sample_rate))
    wav_buffer.write(struct.pack('<I', sample_rate * 2))
    wav_buffer.write(struct.pack('<H', 2))
    wav_buffer.write(struct.pack('<H', 16))
    wav_buffer.write(b'data')
    wav_buffer.write(struct.pack('<I', len(samples) * 2))
    wav_buffer.write(samples.tobytes())

    return wav_buffer.getvalue()


@pytest.fixture
def sample_pipeline_yaml():
    """Sample pipeline YAML for testing."""
    return """
version: "1.0"
models:
  asr: whisper-large-v3
  vad: silero-vad
preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.5
inference:
  batch_size: 16
  language: en
postprocessing:
  lowercase: false
  timestamps:
    word_timestamps: true
"""


@pytest.fixture
def sample_pipeline_config():
    """Sample parsed pipeline config."""
    from datetime import datetime

    from stt_v2.pipeline.dto import (
        InferenceConfig,
        ModelRef,
        ModelRefs,
        PipelineConfig,
        PipelineSpec,
        PostprocessingConfig,
        PreprocessingConfig,
    )

    return PipelineConfig(
        id="p-test-123",
        tenant_id="t-test-456",
        slug="test-pipeline",
        name="Test Pipeline",
        description="Test pipeline for unit tests",
        spec=PipelineSpec(
            version="1.0",
            models=ModelRefs(
                asr=ModelRef(slug="whisper-large-v3"),
                vad=ModelRef(slug="silero-vad"),
            ),
            preprocessing=PreprocessingConfig(
                target_sample_rate=16000,
                normalize=True,
            ),
            inference=InferenceConfig(
                batch_size=16,
                language="en",
            ),
            postprocessing=PostprocessingConfig(),
        ),
        tags=["test"],
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
