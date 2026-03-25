"""Database connection management (read-only).

Note: For Dramatiq workers, each worker thread runs asyncio.run() which creates
a new event loop. SQLAlchemy async engines are bound to the event loop they're
created in. To handle this, we create engines lazily per event loop.
"""

import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from stt_v2.core.config.settings import get_settings

logger = structlog.get_logger(__name__)
settings = get_settings()

# Store engines per event loop to handle Dramatiq workers
# Each worker thread gets its own event loop via asyncio.run()
_engines: dict[int, AsyncEngine] = {}
_session_factories: dict[int, async_sessionmaker] = {}
_initialized = False


def _get_loop_id() -> int:
    """Get current event loop's id for tracking engines per loop."""
    try:
        loop = asyncio.get_running_loop()
        return id(loop)
    except RuntimeError:
        return 0


def _get_or_create_engine() -> tuple[AsyncEngine, async_sessionmaker]:
    """Get or create an engine for the current event loop."""
    loop_id = _get_loop_id()

    if loop_id not in _engines:
        logger.debug(f"Creating new database engine for loop {loop_id}")
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

        _engines[loop_id] = engine
        _session_factories[loop_id] = session_factory

    return _engines[loop_id], _session_factories[loop_id]


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

    # Dispose all engines
    for loop_id, engine in list(_engines.items()):
        try:
            await engine.dispose()
            logger.debug(f"Disposed engine for loop {loop_id}")
        except Exception as e:
            logger.warning(f"Error disposing engine for loop {loop_id}: {e}")

    _engines.clear()
    _session_factories.clear()
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
