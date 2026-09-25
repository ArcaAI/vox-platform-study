"""Test-infrastructure helpers for STT.

URLs and readiness probes for the monorepo's centralized test infrastructure
(tests/docker-compose.test.yml). apps/stt has no database of its own (TASK-1006),
so these cover only what its integration fixtures actually use: Redis and MinIO.

Environment:
    Uses the monorepo's test infrastructure ports:
    - Redis: 6380 (test) vs 6379 (dev)
    - MinIO: 9002 (test) vs 9000 (dev)
"""

import os
import time

# Test infrastructure ports (matching monorepo's tests/docker-compose.test.yml)
TEST_REDIS_PORT = 6380
TEST_MINIO_PORT = 9002


def get_redis_url() -> str:
    """Get the Redis URL for tests."""
    test_url = os.environ.get("TEST_REDIS_URL")
    if test_url:
        return test_url
    password = os.environ.get("TEST_REDIS_PASSWORD", "test_redis_pass")
    return f"redis://:{password}@localhost:{TEST_REDIS_PORT}/0"


def get_minio_config() -> dict:
    """Get MinIO config for tests."""
    return {
        "endpoint": os.environ.get("TEST_MINIO_ENDPOINT", f"localhost:{TEST_MINIO_PORT}"),
        "access_key": os.environ.get("TEST_MINIO_ACCESS_KEY", "test"),
        "secret_key": os.environ.get("TEST_MINIO_SECRET_KEY", "testpassword"),
        "secure": False,
    }


def is_redis_healthy() -> bool:
    """Check if Redis is accessible."""
    try:
        import redis

        client = redis.Redis.from_url(get_redis_url(), socket_timeout=1)
        return bool(client.ping())
    except Exception:
        return False


def wait_for_redis(max_retries: int = 30, interval: float = 1.0) -> bool:
    """Wait for the test Redis to be ready.

    Args:
        max_retries: Maximum number of attempts
        interval: Seconds between attempts

    Returns:
        True if Redis became ready, False if timeout
    """
    for i in range(max_retries):
        if is_redis_healthy():
            return True

        if i > 0 and i % 5 == 0:
            print(f"  Still waiting for Redis... ({i}/{max_retries})")

        time.sleep(interval)

    return False


def is_minio_healthy() -> bool:
    """Check if MinIO is accessible."""
    try:
        from minio import Minio

        config = get_minio_config()
        client = Minio(
            config["endpoint"],
            access_key=config["access_key"],
            secret_key=config["secret_key"],
            secure=config["secure"],
        )
        # Try to list buckets as health check
        list(client.list_buckets())
        return True
    except Exception:
        return False
