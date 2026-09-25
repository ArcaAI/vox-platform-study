"""Integration test fixtures for STT.

Uses the monorepo's centralized test infrastructure (tests/docker-compose.test.yml)
instead of testcontainers for better reliability and consistency.

IMPORTANT: Start test services from monorepo root:
    pnpm docker:test:up

Test Ports (matching monorepo infrastructure):
- Redis: 6380 (test) vs 6379 (dev)
- MinIO: 9002 (test) vs 9000 (dev)

apps/stt has no database (TASK-1006), so the suite gates on the infrastructure its
fixtures actually use — Redis AND MinIO — rather than on Postgres. Checking one alone is
not enough: another stack bound to 6380 (e.g. the ALaaS harness Redis) answers PING, and
the MinIO-backed tests then fail instead of skipping.
"""

import pytest

# Import centralized test helpers
from tests.helpers.infra import (
    get_minio_config,
    get_redis_url,
    is_minio_healthy,
    wait_for_redis,
)

# =============================================================================
# Session-level setup
# =============================================================================


@pytest.fixture(scope="session", autouse=True)
def verify_test_environment():
    """Verify test infrastructure is available before running integration tests."""
    if not (wait_for_redis(max_retries=10, interval=1.0) and is_minio_healthy()):
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
