"""Database connection management (read-only).

Note: For Dramatiq workers, each worker thread runs asyncio.run() which creates
a new event loop. SQLAlchemy async engines are bound to the event loop they're
created in. To handle this, we create engines lazily per event loop.
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import cast

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from stt.core.config.settings import get_settings
from stt.core.loop_local import get_loop_local, loop_local_size, reset_loop_locals

logger = structlog.get_logger(__name__)
settings = get_settings()

_ENGINE_NAMESPACE = "database.engine"
_initialized = False


def _dispose_stale(bound: tuple[AsyncEngine, async_sessionmaker[AsyncSession]]) -> None:
    """Reclaim an engine whose event loop is gone (BUG-015).

    Runs with no loop to await on, so it CANNOT use ``await engine.dispose()``.
    ``close=False`` drops the pooled connections instead of trying to close them
    on a dead loop; their sockets are released when the objects are collected.
    """
    engine, _ = bound
    engine.sync_engine.dispose(close=False)


def _get_or_create_engine() -> tuple[AsyncEngine, async_sessionmaker[AsyncSession]]:
    """Get or create an engine bound to the CURRENT event loop.

    BUG-015: this used to be a dict keyed on ``id(loop)``. CPython recycles those
    addresses, so a new loop was routinely handed a CLOSED loop's engine and its
    dead connection pool — a job then stalled 300s in its first query while the
    dead socket timed out. Entries were also never evicted, so one pool
    accumulated per job until Postgres refused connections. `loop_local` keys on
    loop IDENTITY and prunes closed loops, which fixes both.
    """

    def _build() -> tuple[AsyncEngine, async_sessionmaker[AsyncSession]]:
        engine = create_async_engine(
            settings.database_url,
            pool_size=settings.database_pool_size,
            max_overflow=settings.database_max_overflow,
            echo=settings.debug,
            pool_pre_ping=True,  # Verify connections before use
        )
        session_factory = async_sessionmaker(
            bind=engine,
            class_=AsyncSession,
            expire_on_commit=False,
            autocommit=False,
            autoflush=False,
        )
        logger.debug("Created database engine for the current event loop")
        return engine, session_factory

    return cast(
        "tuple[AsyncEngine, async_sessionmaker[AsyncSession]]",
        get_loop_local(_ENGINE_NAMESPACE, _build, dispose=_dispose_stale),
    )


def engine_cache_size() -> int:
    """Live engine bindings — pinned by tests so the pool leak cannot return."""
    return loop_local_size(_ENGINE_NAMESPACE)


async def initialize_database() -> None:
    """Initialize and test the database connection."""
    global _initialized

    logger.info("Initializing database connection", url=settings.database_url[:50] + "...")

    # Create engine for current loop and test connection
    engine, _ = _get_or_create_engine()

    async with engine.begin() as conn:
        await conn.execute(text("SELECT 1"))

    _initialized = True
    logger.info("Database connection initialized successfully")


async def close_database() -> None:
    """Close all database connection pools."""
    global _initialized

    logger.info("Closing database connection pools")

    # Close THIS loop's engine gracefully (the only one we can await on); any
    # binding left from another loop is reclaimed synchronously by `dispose`.
    try:
        engine, _ = _get_or_create_engine()
        await engine.dispose()
    except Exception as e:  # noqa: BLE001 — shutdown must not raise
        logger.warning(f"Error disposing engine for the current loop: {e}")

    reset_loop_locals(_ENGINE_NAMESPACE)
    _initialized = False

    logger.info("Database connection closed")


@asynccontextmanager
async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    """Get a database session for read-only operations.

    This automatically creates an engine for the current event loop if needed,
    which handles the case of Dramatiq workers using asyncio.run() per job.
    """
    _, session_factory = _get_or_create_engine()

    async with session_factory() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


# Alias for backwards compatibility
get_session = get_db_session
