"""E2E test fixtures using testcontainers and real monorepo infrastructure."""

import asyncio
from pathlib import Path

import pytest
import pytest_asyncio
from typing import AsyncGenerator, Generator

# Directory containing real .wav audio fixtures
_FIXTURES_DIR = Path(__file__).parent / "fixtures"


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
def postgres_container():
    """Start PostgreSQL container for E2E tests."""
    try:
        from testcontainers.postgres import PostgresContainer

        with PostgresContainer("postgres:15-alpine") as postgres:
            yield postgres
    except ImportError:
        pytest.skip("testcontainers not installed")


@pytest.fixture(scope="session")
def redis_container():
    """Start Redis container for E2E tests."""
    try:
        from testcontainers.redis import RedisContainer

        with RedisContainer("redis:7-alpine") as redis:
            yield redis
    except ImportError:
        pytest.skip("testcontainers not installed")


@pytest.fixture(scope="session")
def minio_container():
    """Start MinIO container for E2E tests."""
    try:
        from testcontainers.minio import MinioContainer

        with MinioContainer("minio/minio:latest") as minio:
            yield {
                "endpoint": f"{minio.get_container_host_ip()}:{minio.get_exposed_port(9000)}",
                "access_key": "minioadmin",
                "secret_key": "minioadmin",
                "secure": False,
            }
    except ImportError:
        pytest.skip("testcontainers not installed")


@pytest.fixture(scope="function")
async def configured_app(postgres_container, redis_container, minio_container):
    """
    Configure and return a FastAPI test client with all services running.

    Uses testcontainers for infrastructure. Suitable for tests that do NOT
    require ML dependencies (health, internal admin, streaming session tests).
    """
    import os
    from httpx import AsyncClient, ASGITransport

    # ------------------------------------------------------------------
    # Save global state so we can restore it after this test.
    # This prevents configured_app (function-scoped) from corrupting
    # the session-scoped real_audio_client's DB engines / settings.
    # ------------------------------------------------------------------
    import stt_v2.core.database.connection as db_conn
    import stt_v2.health.api.routes as health_routes
    import stt_v2.main as main_mod
    import stt_v2.core.storage.minio_client as minio_mod

    _saved_env = {
        k: os.environ.get(k)
        for k in ("DATABASE_URL", "REDIS_URL", "MINIO_ENDPOINT",
                   "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "DEBUG")
    }
    _saved_db_settings = db_conn.settings
    _saved_health_settings = health_routes.settings
    _saved_main_settings = main_mod.settings
    _saved_minio_settings = minio_mod.settings
    _saved_engines = dict(db_conn._engines)
    _saved_factories = dict(db_conn._session_factories)

    # ------------------------------------------------------------------
    # Configure environment for testcontainers
    # ------------------------------------------------------------------
    sync_url = postgres_container.get_connection_url()
    # testcontainers returns postgresql+psycopg2://... — swap to asyncpg driver
    async_url = sync_url.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )

    redis_host = redis_container.get_container_host_ip()
    redis_port = redis_container.get_exposed_port(6379)

    os.environ["DATABASE_URL"] = async_url
    os.environ["REDIS_URL"] = f"redis://{redis_host}:{redis_port}/0"
    os.environ["MINIO_ENDPOINT"] = minio_container["endpoint"]
    os.environ["MINIO_ACCESS_KEY"] = minio_container["access_key"]
    os.environ["MINIO_SECRET_KEY"] = minio_container["secret_key"]
    os.environ["DEBUG"] = "true"

    # Clear cached settings so get_settings() picks up new env vars
    from stt_v2.core.config.settings import get_settings
    get_settings.cache_clear()

    # Force-update module-level `settings` objects that were resolved at import
    # time. Without this, modules like connection.py, health/routes.py etc.
    # keep a stale Settings instance pointing at the wrong ports.
    new_settings = get_settings()

    db_conn.settings = new_settings
    # Dispose stale engines so new ones are created with the correct URL
    for engine in list(db_conn._engines.values()):
        try:
            await engine.dispose()
        except Exception:
            pass
    db_conn._engines.clear()
    db_conn._session_factories.clear()

    health_routes.settings = new_settings
    main_mod.settings = new_settings
    minio_mod.settings = new_settings

    # Create the "core" schema, required enum types, and all tables in the
    # testcontainer DB.  Without this, queries to core."AsrPipeline" etc.
    # return UndefinedTableError because the bare PostgreSQL has no schema.
    from sqlalchemy.ext.asyncio import create_async_engine as _create_engine
    from sqlalchemy import text as _text
    from stt_v2.core.database.models import Base

    _tmp_engine = _create_engine(async_url)
    async with _tmp_engine.begin() as conn:
        await conn.execute(_text('CREATE SCHEMA IF NOT EXISTS core'))
        # Create all PostgreSQL ENUM types that the models reference.
        # Production DB creates these via Prisma migrations; for
        # testcontainers we must create them ourselves.
        _enums = {
            "ResourceStatusType": (
                "'ENABLED','DISABLED','DELETED','PENDING','ARCHIVED'"
            ),
            "AiModelSource": (
                "'HUGGINGFACE','GITHUB','MLFLOW','LOCAL'"
            ),
            "AiModelFormat": (
                "'SAFETENSOR','ONNX','NEMO','PYTORCH'"
            ),
            "AiModelDownloadStatus": (
                "'NOT_DOWNLOADED','DOWNLOADING','DOWNLOADED','DOWNLOAD_FAILED'"
            ),
            "ModelCategory": (
                "'AUDIO','TEXT','VISION','MULTIMODAL'"
            ),
            "ModelTaskType": (
                "'AUTOMATIC_SPEECH_RECOGNITION','VOICE_ACTIVITY_DETECTION',"
                "'AUDIO_DENOISING','SPEAKER_DIARIZATION','TEXT_TO_SPEECH',"
                "'LANGUAGE_MODEL','TRANSLATION','SUMMARIZATION',"
                "'TEXT_CLASSIFICATION','NAMED_ENTITY_RECOGNITION',"
                "'IMAGE_CLASSIFICATION','OBJECT_DETECTION'"
            ),
            "ModelType": (
                "'BASE_MODEL','FINETUNED_MODEL','QUANTIZED_MODEL','UNKNOWN'"
            ),
        }
        for enum_name, enum_values in _enums.items():
            await conn.execute(_text(
                f"DO $$ BEGIN "
                f"  CREATE TYPE core.\"{enum_name}\" AS ENUM ({enum_values}); "
                f"EXCEPTION WHEN duplicate_object THEN NULL; "
                f"END $$"
            ))
        await conn.run_sync(Base.metadata.create_all)
    await _tmp_engine.dispose()

    # Import and create app
    from stt_v2.main import create_app
    app = create_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        yield client

    # ------------------------------------------------------------------
    # Restore global state so session-scoped fixtures (real_audio_client)
    # continue to work correctly after this function-scoped test.
    # ------------------------------------------------------------------
    for engine in list(db_conn._engines.values()):
        try:
            await engine.dispose()
        except Exception:
            pass
    db_conn._engines.clear()
    db_conn._session_factories.clear()

    # Restore saved engines / factories
    db_conn._engines.update(_saved_engines)
    db_conn._session_factories.update(_saved_factories)

    db_conn.settings = _saved_db_settings
    health_routes.settings = _saved_health_settings
    main_mod.settings = _saved_main_settings
    minio_mod.settings = _saved_minio_settings

    # Restore env vars
    for k, v in _saved_env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Shared real-data fixtures (Task 0 — used by Tracks B, E)
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def real_audio_client():
    """
    AsyncClient backed by real monorepo test infrastructure.

    Requires:
        pnpm docker:test:up  (PostgreSQL:5433, Redis:6380, MinIO:9002)

    Environment variables (set by docker-compose or CI):
        TEST_DATABASE_URL, TEST_REDIS_URL, TEST_MINIO_ENDPOINT
    """
    import os
    from httpx import AsyncClient, ASGITransport
    from stt_v2.core.config.settings import get_settings

    # Point at monorepo test containers (fallback to defaults matching
    # tests/docker-compose.test.yml and .env.test).
    # We use os.environ[key] = ... (not setdefault) because the
    # function-scoped ``configured_app`` fixture may have already
    # set DATABASE_URL to the testcontainer URL.  The real_audio_client
    # must always point at the monorepo test infrastructure.
    os.environ["DATABASE_URL"] = os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql+asyncpg://test:test@localhost:5433/hope_test",
    )
    os.environ["REDIS_URL"] = os.environ.get(
        "TEST_REDIS_URL", "redis://localhost:6380/0"
    )
    os.environ["MINIO_ENDPOINT"] = os.environ.get(
        "TEST_MINIO_ENDPOINT", "localhost:9002"
    )
    os.environ["MINIO_ACCESS_KEY"] = os.environ.get("MINIO_ACCESS_KEY", "test")
    os.environ["MINIO_SECRET_KEY"] = os.environ.get("MINIO_SECRET_KEY", "testpassword")
    os.environ["DEBUG"] = "true"
    # Limit DB pool to avoid TooManyConnectionsError on test PostgreSQL
    # (max_connections=20).  Each event-loop creates its own engine, so
    # keep the per-engine pool small.
    os.environ.setdefault("DATABASE_POOL_SIZE", "2")
    os.environ.setdefault("DATABASE_MAX_OVERFLOW", "3")

    # Clear cached settings so env vars take effect
    get_settings.cache_clear()
    new_settings = get_settings()

    # Force-update module-level settings and dispose stale DB engines
    # (same as configured_app — prevents cross-contamination)
    import stt_v2.core.database.connection as db_conn
    db_conn.settings = new_settings
    for engine in list(db_conn._engines.values()):
        try:
            await engine.dispose()
        except Exception:
            pass
    db_conn._engines.clear()
    db_conn._session_factories.clear()

    import stt_v2.health.api.routes as health_routes
    health_routes.settings = new_settings

    import stt_v2.main as main_mod
    main_mod.settings = new_settings

    import stt_v2.core.storage.minio_client as minio_mod
    minio_mod.settings = new_settings

    # Verify the monorepo test infra is reachable before proceeding.
    # If not, skip all tests that depend on this fixture.
    db_url = os.environ["DATABASE_URL"]
    from sqlalchemy.ext.asyncio import create_async_engine as _create_engine
    from sqlalchemy import text as _text

    _probe_engine = _create_engine(db_url, pool_pre_ping=True)
    try:
        async with _probe_engine.connect() as conn:
            await conn.execute(_text("SELECT 1"))
    except Exception as exc:
        await _probe_engine.dispose()
        pytest.skip(
            f"Monorepo test infrastructure not available "
            f"(pnpm docker:test:up required): {exc}"
        )
    await _probe_engine.dispose()

    from stt_v2.main import create_app

    app = create_app()

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        timeout=180.0,  # whisper-large-v3-turbo: ~14s MPS, ~60s CPU + model load
    ) as client:
        yield client


@pytest.fixture(scope="session")
def real_ml_audio_bytes() -> bytes:
    """Load multilingual WAV fixture (~3.3 MB)."""
    path = _FIXTURES_DIR / "20260205_52886591770282917_ml.wav"
    if not path.exists():
        pytest.skip(f"ML audio fixture not found: {path}")
    return path.read_bytes()


@pytest.fixture(scope="session")
def real_en_audio_bytes() -> bytes:
    """Load English WAV fixture (~20 MB)."""
    path = _FIXTURES_DIR / "20260206_52886591770369502_en.wav"
    if not path.exists():
        pytest.skip(f"EN audio fixture not found: {path}")
    return path.read_bytes()


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def valid_pipeline_id(real_audio_client) -> str:
    """Return the ``turbo-whisper-large-v3`` pipeline slug for ML e2e tests.

    This pipeline is seeded by ``pnpm test:db:seed`` (see
    ``packages/database/src/prisma/db_main/seed/06-stt.ts``).  It uses
    ``openai/whisper-large-v3-turbo`` with the **safetensor** engine so
    the auto-detected hardware accelerator (MPS / CUDA / CPU) is used.

    Performance (107 s audio, cached model):
      - Apple Silicon MPS:  ~14 s
      - CUDA GPU:           ~5 s
      - CPU (fallback):     ~60 s

    Override via the ``TEST_PIPELINE_ID`` env var if needed.
    """
    import os

    override = os.environ.get("TEST_PIPELINE_ID")
    if override:
        return override

    slug = "turbo-whisper-large-v3"

    # Verify the pipeline exists in the test DB (seeded by pnpm test:db:seed)
    from sqlalchemy import text
    from stt_v2.core.database.connection import get_session

    async with get_session() as session:
        result = await session.execute(
            text('SELECT slug FROM core."AsrPipeline" WHERE slug = :slug'),
            {"slug": slug},
        )
        existing = result.scalar_one_or_none()

        if existing is None:
            import pytest

            pytest.fail(
                f"Pipeline '{slug}' not found in test DB. "
                f"Run 'pnpm test:db:seed' to seed the test database."
            )

    return slug


@pytest.fixture(scope="session")
def valid_tenant_id() -> str:
    """Return the default test tenant ID."""
    import os

    return os.environ.get("TEST_TENANT_ID", "50000000-0000-0000-0000-000000000000")


@pytest.fixture
def sample_wav_audio() -> bytes:
    """Generate a sample WAV audio file for testing (2s 440 Hz sine wave)."""
    import struct
    import io
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
    wav_buffer.write(b'RIFF')
    wav_buffer.write(struct.pack('<I', 36 + len(samples) * 2))
    wav_buffer.write(b'WAVE')

    # fmt chunk
    wav_buffer.write(b'fmt ')
    wav_buffer.write(struct.pack('<I', 16))  # Chunk size
    wav_buffer.write(struct.pack('<H', 1))   # Audio format (PCM)
    wav_buffer.write(struct.pack('<H', 1))   # Channels (mono)
    wav_buffer.write(struct.pack('<I', sample_rate))  # Sample rate
    wav_buffer.write(struct.pack('<I', sample_rate * 2))  # Byte rate
    wav_buffer.write(struct.pack('<H', 2))   # Block align
    wav_buffer.write(struct.pack('<H', 16))  # Bits per sample

    # data chunk
    wav_buffer.write(b'data')
    wav_buffer.write(struct.pack('<I', len(samples) * 2))
    wav_buffer.write(samples.tobytes())

    return wav_buffer.getvalue()
