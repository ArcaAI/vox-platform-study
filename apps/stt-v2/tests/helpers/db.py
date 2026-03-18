"""Database test helpers for STT-v2.

This module mirrors the monorepo's TypeScript test helpers (tests/helpers/db.helper.ts)
for Python services. It integrates with the centralized test infrastructure.

Usage:
    # In conftest.py
    from tests.helpers.db import setup_test_database, teardown_test_database

    @pytest.fixture(scope="session", autouse=True)
    def setup_database():
        setup_test_database()
        yield
        teardown_test_database()

Environment:
    Uses the monorepo's test infrastructure ports:
    - PostgreSQL: 5433 (test) vs 5432 (dev)
    - Redis: 6380 (test) vs 6379 (dev)
    - MinIO: 9002 (test) vs 9000 (dev)
"""

import asyncio
import os
import time
import subprocess
from typing import Optional
from urllib.parse import urlparse

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
        # Use psycopg2 for sync
        return url.replace("postgresql+asyncpg://", "postgresql://")
    else:
        # Use asyncpg for async
        if "asyncpg" not in url:
            return url.replace("postgresql://", "postgresql+asyncpg://")
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
            host="localhost", port=TEST_REDIS_PORT,
            password=password, socket_timeout=1,
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


def setup_test_database() -> None:
    """Setup the test database.

    This mirrors the TypeScript helper's setupTestDatabase function.
    It should be called before running integration/E2E tests.

    Flow:
    1. Wait for database to be ready
    2. Push schema (create tables)
    3. Seed database with test data (optional)
    """
    print("\n📦 Setting up test database for STT-v2...\n")

    # Step 1: Wait for database
    if not wait_for_database():
        raise RuntimeError(
            f"Database at localhost:{TEST_DB_PORT} is not accessible.\n"
            "Please start test infrastructure: pnpm docker:test:up (from monorepo root)"
        )
    print("✅ Database is ready\n")

    # Step 2: Create schema if needed
    # Note: The monorepo's TypeScript tests handle schema with Prisma
    # For Python services, we can use SQLAlchemy's create_all
    try:
        _create_schema()
        print("✅ Schema created\n")
    except Exception as e:
        print(f"⚠️ Schema creation warning: {e}\n")

    print("✅ Test database setup complete!\n")


def _create_schema() -> None:
    """Create database schema using SQLAlchemy models."""
    try:
        from sqlalchemy import create_engine, text
        from stt_v2.core.database.models import Base

        engine = create_engine(get_db_url(sync=True), echo=False)

        with engine.connect() as conn:
            # Create core schema if it doesn't exist
            conn.execute(text("CREATE SCHEMA IF NOT EXISTS core"))
            conn.commit()

        # Create all tables
        Base.metadata.create_all(engine)
        engine.dispose()
    except ImportError:
        print("  Note: SQLAlchemy models not available, skipping schema creation")


def reset_database() -> None:
    """Reset the database by truncating all tables.

    WARNING: This will delete all data in the database.

    This mirrors the TypeScript helper's resetDatabase function.
    """
    try:
        from sqlalchemy import create_engine, text

        engine = create_engine(get_db_url(sync=True), echo=False)

        with engine.connect() as conn:
            # Get all tables from public and core schemas
            result = conn.execute(text("""
                SELECT schemaname, tablename
                FROM pg_tables
                WHERE schemaname IN ('public', 'core')
                AND tablename != '_prisma_migrations'
            """))
            tables = result.fetchall()

            if not tables:
                return

            # Disable foreign key checks
            conn.execute(text("SET session_replication_role = 'replica'"))

            # Truncate all tables
            for schema, table in tables:
                try:
                    conn.execute(text(f'TRUNCATE TABLE "{schema}"."{table}" CASCADE'))
                except Exception as e:
                    print(f"  Warning: Could not truncate {schema}.{table}: {e}")

            # Re-enable foreign key checks
            conn.execute(text("SET session_replication_role = 'origin'"))
            conn.commit()

        engine.dispose()
    except Exception as e:
        print(f"  Warning: Database reset failed: {e}")


def teardown_test_database() -> None:
    """Cleanup after tests.

    Currently just logs completion - tables are left for inspection.
    Use reset_database() if you need a clean slate between test runs.
    """
    print("\n✅ Test database teardown complete\n")


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


async def async_reset_database() -> None:
    """Async version of reset_database."""
    # Run sync reset in executor to not block event loop
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, reset_database)
