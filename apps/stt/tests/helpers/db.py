"""Test-infrastructure helpers for STT.

URLs and readiness probes for the monorepo's centralized test infrastructure
(tests/docker-compose.test.yml). TASK-1006 — apps/stt has no database of its own,
so the schema setup / reset helpers that served its SQLAlchemy read models were
removed with them; only the readiness probe the integration suite gates on remains.

Environment:
    Uses the monorepo's test infrastructure ports:
    - PostgreSQL: 5433 (test) vs 5432 (dev)
    - Redis: 6380 (test) vs 6379 (dev)
    - MinIO: 9002 (test) vs 9000 (dev)
"""

import asyncio
import os
import subprocess
import time

# Test infrastructure ports (matching monorepo's tests/docker-compose.test.yml)
TEST_DB_PORT = 5433
TEST_REDIS_PORT = 6380
TEST_MINIO_PORT = 9002


def get_db_url(sync: bool = False) -> str:
    """Get the database URL for tests.

    Priority:
    1. TEST_DATABASE_URL environment variable
    2. DATABASE_URL if it contains 'test' or port 5433
    3. Default test URL with port 5433

    Args:
        sync: If True, return psycopg2 sync URL. If False, return asyncpg URL.
    """
    # Check for explicit test URL
    test_url = os.environ.get("TEST_DATABASE_URL")
    if test_url:
        return _convert_url(test_url, sync)

    # Check if DATABASE_URL is a test database
    db_url = os.environ.get("DATABASE_URL", "")
    if "test" in db_url.lower() or f":{TEST_DB_PORT}" in db_url:
        return _convert_url(db_url, sync)

    # Default to test infrastructure
    default_url = f"postgresql://test:test@localhost:{TEST_DB_PORT}/hope_test"
    return _convert_url(default_url, sync)


def _convert_url(url: str, sync: bool) -> str:
    """Convert database URL to sync or async driver format."""
    if sync:
        url = url.replace("postgresql+asyncpg://", "postgresql://")
    elif "asyncpg" not in url:
        url = url.replace("postgresql://", "postgresql+asyncpg://")

    from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

    parsed = urlparse(url)
    if parsed.query:
        params = parse_qs(parsed.query)
        params.pop("schema", None)
        url = urlunparse(parsed._replace(query=urlencode(params, doseq=True)))
    return url


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


def is_database_healthy(max_wait: int = 1) -> bool:
    """Check if the database is accessible.

    Args:
        max_wait: Maximum seconds to wait (default 1 for quick check)
    """
    try:
        result = subprocess.run(
            ["pg_isready", "-h", "localhost", "-p", str(TEST_DB_PORT), "-U", "test"],
            capture_output=True,
            timeout=max_wait,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False


def wait_for_database(max_retries: int = 30, interval: float = 1.0) -> bool:
    """Wait for the database to be ready.

    This mirrors the TypeScript helper's waitForDatabase function.

    Args:
        max_retries: Maximum number of attempts
        interval: Seconds between attempts

    Returns:
        True if database became ready, False if timeout
    """
    for i in range(max_retries):
        if is_database_healthy():
            return True

        if i > 0 and i % 5 == 0:
            print(f"  Still waiting for database... ({i}/{max_retries})")

        time.sleep(interval)

    return False


def is_redis_healthy() -> bool:
    """Check if Redis is accessible."""
    try:
        import redis

        password = os.environ.get("TEST_REDIS_PASSWORD", "test_redis_pass")
        client = redis.Redis(
            host="localhost",
            port=TEST_REDIS_PORT,
            password=password,
            socket_timeout=1,
        )
        return client.ping()
    except Exception:
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


# Async versions for use in async test fixtures
async def async_wait_for_database(max_retries: int = 30, interval: float = 1.0) -> bool:
    """Async version of wait_for_database."""
    for i in range(max_retries):
        if is_database_healthy():
            return True

        if i > 0 and i % 5 == 0:
            print(f"  Still waiting for database... ({i}/{max_retries})")

        await asyncio.sleep(interval)

    return False
