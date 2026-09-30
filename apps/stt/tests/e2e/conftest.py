"""E2E test fixtures using testcontainers and real monorepo infrastructure."""

import asyncio
import os
from collections.abc import Generator

import pytest


def _service_auth_headers(app) -> dict[str, str]:
    """Present the shared internal token when the app is configured to want one.

    These suites drive the real ASGI app in-process, so they go through
    `ServiceAuthMiddleware` like any other caller. With no token configured
    (the normal local/CI case) this is empty and the dev bypass applies; a
    developer who exports `INTERNAL_ACCESS_TOKEN` gets a client that
    authenticates instead of a suite that 401s.
    """
    accepted = app.state.settings.accepted_service_tokens
    return {"X-Service-Token": accepted[0]} if accepted else {}


@pytest.fixture(scope="session")
def event_loop() -> Generator[asyncio.AbstractEventLoop, None, None]:
    """Create event loop for async tests."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session")
def docker_compose_services():
    """
    Start all required services using docker-compose.

    This fixture can be used to start all services needed for E2E tests.
    For now, we use individual containers.
    """
    # In a full setup, this would start docker-compose.dev.yml
    pass


@pytest.fixture(scope="session")
def redis_container():
    """Start Redis container for E2E tests."""
    try:
        from testcontainers.redis import RedisContainer

        with RedisContainer("redis:8-alpine") as redis:
            yield redis
    except ImportError:
        pytest.skip("testcontainers not installed")


@pytest.fixture(scope="session")
def minio_container():
    """Start MinIO container for E2E tests."""
    try:
        from testcontainers.minio import MinioContainer

        with MinioContainer(
            # TASK-1029: pgsty community fork (upstream minio/minio is archived)
            "pgsty/minio:RELEASE.2026-08-04T00-00-00Z@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372"
        ) as minio:
            yield {
                "endpoint": f"{minio.get_container_host_ip()}:{minio.get_exposed_port(9000)}",
                "access_key": "minioadmin",
                "secret_key": "minioadmin",
                "secure": False,
            }
    except ImportError:
        pytest.skip("testcontainers not installed")


@pytest.fixture(scope="function")
async def configured_app(redis_container, minio_container):
    """
    Configure and return a FastAPI test client with all services running.

    Uses testcontainers for infrastructure (Redis, MinIO — TASK-1006: the service
    has no database). Suitable for tests that do NOT require ML dependencies
    (health, internal admin, streaming session tests).
    """

    from httpx import ASGITransport, AsyncClient

    # ------------------------------------------------------------------
    # Save global state so we can restore it after this test.
    # ------------------------------------------------------------------
    import stt.core.storage.minio_client as minio_mod
    import stt.health.api.routes as health_routes
    import stt.main as main_mod

    _saved_env = {
        k: os.environ.get(k)
        for k in (
            "REDIS_URL",
            "MINIO_ENDPOINT",
            "MINIO_ACCESS_KEY",
            "MINIO_SECRET_KEY",
            "DEBUG",
        )
    }
    _saved_health_settings = health_routes.settings
    _saved_main_settings = main_mod.settings
    _saved_minio_settings = minio_mod.settings

    # ------------------------------------------------------------------
    # Configure environment for testcontainers
    # ------------------------------------------------------------------
    redis_host = redis_container.get_container_host_ip()
    redis_port = redis_container.get_exposed_port(6379)

    os.environ["REDIS_URL"] = f"redis://{redis_host}:{redis_port}/0"
    os.environ["MINIO_ENDPOINT"] = minio_container["endpoint"]
    os.environ["MINIO_ACCESS_KEY"] = minio_container["access_key"]
    os.environ["MINIO_SECRET_KEY"] = minio_container["secret_key"]
    os.environ["DEBUG"] = "true"

    # Clear cached settings so get_settings() picks up new env vars
    from stt.core.config.settings import get_settings

    get_settings.cache_clear()

    # Force-update module-level `settings` objects that were resolved at import
    # time. Without this, modules like health/routes.py keep a stale Settings
    # instance pointing at the wrong ports.
    new_settings = get_settings()

    health_routes.settings = new_settings
    main_mod.settings = new_settings
    minio_mod.settings = new_settings

    # Import and create app
    from stt.main import create_app

    app = create_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers=_service_auth_headers(app),
    ) as client:
        yield client

    # ------------------------------------------------------------------
    # Restore global state for the next test.
    # ------------------------------------------------------------------

    # Restore env vars BEFORE restoring settings so get_settings()
    # picks up the original values.
    for k, v in _saved_env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

    health_routes.settings = _saved_health_settings
    main_mod.settings = _saved_main_settings
    minio_mod.settings = _saved_minio_settings

    get_settings.cache_clear()


@pytest.fixture
def sample_wav_audio() -> bytes:
    """Generate a sample WAV audio file for testing (2s 440 Hz sine wave)."""
    import io
    import struct

    import numpy as np

    # Generate 2 seconds of a 440Hz sine wave at 16kHz
    sample_rate = 16000
    duration = 2.0
    frequency = 440

    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    samples = (np.sin(2 * np.pi * frequency * t) * 0.5 * 32767).astype(np.int16)

    # Create WAV file in memory
    wav_buffer = io.BytesIO()

    # RIFF header
    wav_buffer.write(b"RIFF")
    wav_buffer.write(struct.pack("<I", 36 + len(samples) * 2))
    wav_buffer.write(b"WAVE")

    # fmt chunk
    wav_buffer.write(b"fmt ")
    wav_buffer.write(struct.pack("<I", 16))  # Chunk size
    wav_buffer.write(struct.pack("<H", 1))  # Audio format (PCM)
    wav_buffer.write(struct.pack("<H", 1))  # Channels (mono)
    wav_buffer.write(struct.pack("<I", sample_rate))  # Sample rate
    wav_buffer.write(struct.pack("<I", sample_rate * 2))  # Byte rate
    wav_buffer.write(struct.pack("<H", 2))  # Block align
    wav_buffer.write(struct.pack("<H", 16))  # Bits per sample

    # data chunk
    wav_buffer.write(b"data")
    wav_buffer.write(struct.pack("<I", len(samples) * 2))
    wav_buffer.write(samples.tobytes())

    return wav_buffer.getvalue()
