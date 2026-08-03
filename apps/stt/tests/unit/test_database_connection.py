"""Unit tests for database connection module.

Tests cover event loop handling, engine creation, and session management.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestDatabaseConnectionHelpers:
    """Tests for database connection helper functions."""

    def test_engine_binding_follows_the_running_loop(self):
        """BUG-015: a binding belongs to ONE loop, never to a recycled address."""
        from stt.core.database.connection import _get_or_create_engine

        async def run_test():
            first, _ = _get_or_create_engine()
            second, _ = _get_or_create_engine()
            return first, second

        same_loop_a, same_loop_b = asyncio.run(run_test())
        other_loop, _ = asyncio.run(run_test())[0], None

        assert same_loop_a is same_loop_b, "one engine per loop, reused within it"
        assert other_loop is not same_loop_a, "a new loop must get a new engine"

    def test_engine_cache_size_is_observable(self):
        """`engine_cache_size` is the guard against the pool leak returning."""
        from stt.core.database.connection import engine_cache_size

        assert engine_cache_size() >= 0


class TestDatabaseEngineCreation:
    """Tests for database engine creation."""

    def test_get_or_create_engine_creates_new_engine(self):
        """Test that engine is created for a loop that has none."""
        from stt.core.database import connection as conn_module
        from stt.core.loop_local import reset_loop_locals

        reset_loop_locals(conn_module._ENGINE_NAMESPACE)
        mock_engine = MagicMock()
        mock_session_factory = MagicMock()

        try:
            with (
                patch(
                    "stt.core.database.connection.create_async_engine", return_value=mock_engine
                ),
                patch(
                    "stt.core.database.connection.async_sessionmaker",
                    return_value=mock_session_factory,
                ),
            ):

                async def run_test():
                    return conn_module._get_or_create_engine()

                engine, factory = asyncio.run(run_test())

                assert engine is mock_engine
                assert factory is mock_session_factory
        finally:
            reset_loop_locals(conn_module._ENGINE_NAMESPACE)

    def test_get_or_create_engine_reuses_existing(self):
        """Test that an existing engine is reused WITHIN the same loop."""
        from stt.core.database import connection as conn_module
        from stt.core.loop_local import reset_loop_locals

        reset_loop_locals(conn_module._ENGINE_NAMESPACE)
        mock_engine = MagicMock()
        mock_factory = MagicMock()

        try:
            with (
                patch(
                    "stt.core.database.connection.create_async_engine", return_value=mock_engine
                ),
                patch(
                    "stt.core.database.connection.async_sessionmaker", return_value=mock_factory
                ) as sessionmaker,
            ):

                async def run_test():
                    conn_module._get_or_create_engine()
                    return conn_module._get_or_create_engine()

                engine, factory = asyncio.run(run_test())

                assert engine is mock_engine
                assert factory is mock_factory
                assert sessionmaker.call_count == 1, "the second call must reuse, not rebuild"
        finally:
            reset_loop_locals(conn_module._ENGINE_NAMESPACE)


class TestDatabaseInitialization:
    """Tests for database initialization."""

    @pytest.mark.asyncio
    async def test_initialize_database(self):
        """Test initialize_database creates connection and tests it."""
        from stt.core.database import connection as conn_module

        mock_engine = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock()

        # Create async context manager mock
        mock_begin = AsyncMock()
        mock_begin.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_begin.__aexit__ = AsyncMock(return_value=None)
        mock_engine.begin = MagicMock(return_value=mock_begin)

        with patch.object(
            conn_module, "_get_or_create_engine", return_value=(mock_engine, MagicMock())
        ):
            await conn_module.initialize_database()

            mock_conn.execute.assert_called_once()
            assert conn_module._initialized is True

    @pytest.mark.asyncio
    async def test_close_database(self):
        """close_database disposes this loop's engine and clears every binding."""
        from stt.core.database import connection as conn_module
        from stt.core.loop_local import loop_local_size, reset_loop_locals

        reset_loop_locals(conn_module._ENGINE_NAMESPACE)
        mock_engine = AsyncMock()
        mock_engine.dispose = AsyncMock()
        # `sync_engine.dispose` is the SYNC reclaim path — not a coroutine.
        mock_engine.sync_engine = MagicMock()
        original_initialized = conn_module._initialized

        try:
            with (
                patch(
                    "stt.core.database.connection.create_async_engine", return_value=mock_engine
                ),
                patch("stt.core.database.connection.async_sessionmaker", return_value=MagicMock()),
            ):
                conn_module._get_or_create_engine()
                conn_module._initialized = True

                await conn_module.close_database()

            mock_engine.dispose.assert_awaited_once()
            assert loop_local_size(conn_module._ENGINE_NAMESPACE) == 0
            assert conn_module._initialized is False
        finally:
            reset_loop_locals(conn_module._ENGINE_NAMESPACE)
            conn_module._initialized = original_initialized


class TestDatabaseSession:
    """Tests for database session management."""

    @pytest.mark.asyncio
    async def test_get_db_session_yields_session(self):
        """Test get_db_session yields a session."""
        from stt.core.database import connection as conn_module

        mock_session = AsyncMock()
        mock_session.rollback = AsyncMock()

        mock_factory = MagicMock()
        mock_session_context = AsyncMock()
        mock_session_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_context.__aexit__ = AsyncMock(return_value=None)
        mock_factory.return_value = mock_session_context

        with patch.object(
            conn_module, "_get_or_create_engine", return_value=(MagicMock(), mock_factory)
        ):
            async with conn_module.get_db_session() as session:
                assert session is mock_session

    @pytest.mark.asyncio
    async def test_get_db_session_rollback_on_exception(self):
        """Test get_db_session rolls back on exception."""
        from stt.core.database import connection as conn_module

        mock_session = AsyncMock()
        mock_session.rollback = AsyncMock()

        mock_factory = MagicMock()
        mock_session_context = AsyncMock()
        mock_session_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_context.__aexit__ = AsyncMock(return_value=None)
        mock_factory.return_value = mock_session_context

        with patch.object(
            conn_module, "_get_or_create_engine", return_value=(MagicMock(), mock_factory)
        ):
            try:
                async with conn_module.get_db_session() as _session:
                    raise ValueError("Test error")
            except ValueError:
                pass

            mock_session.rollback.assert_called_once()
