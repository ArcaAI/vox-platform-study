"""Integration test fixtures for STT-v2.

Uses the monorepo's centralized test infrastructure (tests/docker-compose.test.yml)
instead of testcontainers for better reliability and consistency.

IMPORTANT: Start test services from monorepo root:
    pnpm docker:test:up

Test Ports (matching monorepo infrastructure):
- PostgreSQL: 5433 (test) vs 5432 (dev)
- Redis: 6380 (test) vs 6379 (dev)
- MinIO: 9002 (test) vs 9000 (dev)
"""

import asyncio
import os
import pytest
from typing import AsyncGenerator, Generator

# Import centralized test helpers
from tests.helpers.db import (
    get_db_url,
    get_redis_url,
    get_minio_config,
    wait_for_database,
    async_reset_database,
)


# =============================================================================
# Session-level setup
# =============================================================================


@pytest.fixture(scope="session", autouse=True)
def verify_test_environment():
    """Verify test infrastructure is available before running integration tests."""
    if not wait_for_database(max_retries=10, interval=1.0):
        pytest.skip(
            "Integration tests require the monorepo test infrastructure.\n"
            "Start with: pnpm docker:test:up (from monorepo root)"
        )
    print("\n✅ Test infrastructure is ready")


# =============================================================================
# Database Fixtures (using centralized helpers)
# =============================================================================


@pytest.fixture(scope="session")
def database_url():
    """Get database URL from centralized helper."""
    return get_db_url(sync=False)  # asyncpg URL


@pytest.fixture(scope="function")
async def db_engine(database_url):
    """Create database engine for tests."""
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy import text
    from stt_v2.core.database.models import Base

    engine = create_async_engine(database_url, echo=False, pool_pre_ping=True)

    try:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE SCHEMA IF NOT EXISTS core"))
            enum_defs = [
                ('ResourceStatusType', ['ENABLED', 'DISABLED', 'DELETED', 'PENDING', 'ARCHIVED']),
                ('AiModelSource', ['HUGGINGFACE', 'GITHUB', 'MLFLOW', 'LOCAL']),
                ('AiModelFormat', ['SAFETENSOR', 'ONNX', 'NEMO', 'PYTORCH']),
                ('AiModelDownloadStatus', ['NOT_DOWNLOADED', 'DOWNLOADING', 'DOWNLOADED', 'DOWNLOAD_FAILED']),
                ('ModelCategory', ['AUDIO', 'TEXT', 'VISION', 'MULTIMODAL']),
                ('ModelTaskType', [
                    'AUTOMATIC_SPEECH_RECOGNITION', 'VOICE_ACTIVITY_DETECTION',
                    'AUDIO_DENOISING', 'SPEAKER_DIARIZATION', 'TEXT_TO_SPEECH',
                    'LANGUAGE_MODEL', 'TRANSLATION', 'SUMMARIZATION',
                    'TEXT_CLASSIFICATION', 'NAMED_ENTITY_RECOGNITION',
                    'IMAGE_CLASSIFICATION', 'OBJECT_DETECTION',
                ]),
                ('ModelType', ['BASE_MODEL', 'FINETUNED_MODEL', 'QUANTIZED_MODEL', 'UNKNOWN']),
            ]
            for enum_name, values in enum_defs:
                values_str = ", ".join(f"'{v}'" for v in values)
                await conn.execute(text(f"""
                    DO $$ BEGIN
                        CREATE TYPE core."{enum_name}" AS ENUM ({values_str});
                    EXCEPTION
                        WHEN duplicate_object THEN null;
                    END $$;
                """))
            await conn.run_sync(Base.metadata.create_all)

        yield engine

        async with engine.begin() as conn:
            await conn.execute(text("DROP SCHEMA IF EXISTS core CASCADE"))
    finally:
        await engine.dispose()


@pytest.fixture(scope="function")
async def db_session(db_engine):
    """Create database session for tests."""
    from sqlalchemy.ext.asyncio import AsyncSession
    from sqlalchemy.orm import sessionmaker

    async_session = sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)

    async with async_session() as session:
        yield session
        await session.rollback()


# =============================================================================
# Redis Fixtures (using centralized helpers)
# =============================================================================


@pytest.fixture(scope="session")
def redis_url():
    """Get Redis URL from centralized helper."""
    return get_redis_url()


@pytest.fixture(scope="function")
def redis_client(redis_url):
    """Create Redis client for tests."""
    import redis
    from urllib.parse import urlparse

    parsed = urlparse(redis_url)
    client = redis.Redis(
        host=parsed.hostname or "localhost",
        port=parsed.port or 6380,
        db=int(parsed.path.lstrip("/") or 0),
        password=parsed.password,
    )

    try:
        client.ping()
        yield client
    finally:
        try:
            client.flushdb()
        except Exception:
            pass
        client.close()


# =============================================================================
# MinIO Fixtures (using centralized helpers)
# =============================================================================


@pytest.fixture(scope="session")
def minio_config():
    """Get MinIO config from centralized helper."""
    return get_minio_config()


@pytest.fixture(scope="function")
def minio_client(minio_config):
    """Create MinIO client for tests."""
    from minio import Minio

    client = Minio(
        minio_config["endpoint"],
        access_key=minio_config["access_key"],
        secret_key=minio_config["secret_key"],
        secure=minio_config["secure"],
    )

    # Create test buckets
    buckets = ["hope-audio", "hope-audio-chunks", "hope-models"]
    for bucket in buckets:
        try:
            if not client.bucket_exists(bucket):
                client.make_bucket(bucket)
        except Exception:
            pass

    yield client

    # Cleanup - remove all objects and buckets
    for bucket in buckets:
        try:
            objects = list(client.list_objects(bucket, recursive=True))
            for obj in objects:
                client.remove_object(bucket, obj.object_name)
        except Exception:
            pass
