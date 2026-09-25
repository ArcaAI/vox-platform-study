"""Integration test fixtures for STT.

Uses the monorepo's centralized test infrastructure (tests/docker-compose.test.yml)
instead of testcontainers for better reliability and consistency.

IMPORTANT: Start test services from monorepo root:
    pnpm docker:test:up

Test Ports (matching monorepo infrastructure):
- PostgreSQL: 5433 (test) vs 5432 (dev)
- Redis: 6380 (test) vs 6379 (dev)
- MinIO: 9002 (test) vs 9000 (dev)
"""

import pytest

# Import centralized test helpers
from tests.helpers.db import (
    get_minio_config,
    get_redis_url,
    wait_for_database,
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
# Redis Fixtures (using centralized helpers)
# =============================================================================


@pytest.fixture(scope="session")
def redis_url():
    """Get Redis URL from centralized helper."""
    return get_redis_url()


@pytest.fixture(scope="function")
def redis_client(redis_url):
    """Create Redis client for tests."""
    from urllib.parse import urlparse

    import redis

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
