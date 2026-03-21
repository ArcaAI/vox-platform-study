"""Unit tests for database connection module.

Tests cover event loop handling, engine creation, and session management.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import asyncio


class TestDatabaseConnectionHelpers:
    """Tests for database connection helper functions."""

    def test_get_loop_id_with_running_loop(self):
        """Test _get_loop_id returns loop id when loop is running."""
        from stt_v2.core.database.connection import _get_loop_id

        async def run_test():
            loop_id = _get_loop_id()
            assert loop_id > 0  # Should return actual loop id

        asyncio.run(run_test())

    def test_get_loop_id_without_running_loop(self):
        """Test _get_loop_id returns 0 when no loop is running."""
        from stt_v2.core.database import connection

        # Directly test without running event loop
        with patch("asyncio.get_running_loop", side_effect=RuntimeError("No loop")):
            result = connection._get_loop_id()
            assert result == 0


class TestDatabaseEngineCreation:
    """Tests for database engine creation."""

    def test_get_or_create_engine_creates_new_engine(self):
        """Test that engine is created for new loop."""
        from stt_v2.core.database import connection as conn_module

        # Reset module state
        original_engines = conn_module._engines.copy()
        original_factories = conn_module._session_factories.copy()
        conn_module._engines.clear()
        conn_module._session_factories.clear()

        mock_engine = MagicMock()
        mock_session_factory = MagicMock()

        try:
            with patch.object(conn_module, "_get_loop_id", return_value=12345), \
                 patch("stt_v2.core.database.connection.create_async_engine", return_value=mock_engine), \
                 patch("stt_v2.core.database.connection.async_sessionmaker", return_value=mock_session_factory):

                engine, factory = conn_module._get_or_create_engine()

                assert engine is mock_engine
                assert factory is mock_session_factory
                assert 12345 in conn_module._engines
        finally:
            # Restore original state
            conn_module._engines.clear()
            conn_module._engines.update(original_engines)
            conn_module._session_factories.clear()
            conn_module._session_factories.update(original_factories)

    def test_get_or_create_engine_reuses_existing(self):
        """Test that existing engine is reused."""
        from stt_v2.core.database import connection as conn_module

        # Reset module state
        original_engines = conn_module._engines.copy()
        original_factories = conn_module._session_factories.copy()

        mock_engine = MagicMock()
        mock_factory = MagicMock()
        conn_module._engines[99999] = mock_engine
        conn_module._session_factories[99999] = mock_factory

        try:
            with patch.object(conn_module, "_get_loop_id", return_value=99999):
                engine, factory = conn_module._get_or_create_engine()

                assert engine is mock_engine
                assert factory is mock_factory
        finally:
            # Restore original state
            conn_module._engines.clear()
            conn_module._engines.update(original_engines)
            conn_module._session_factories.clear()
            conn_module._session_factories.update(original_factories)


class TestDatabaseInitialization:
    """Tests for database initialization."""

    @pytest.mark.asyncio
    async def test_initialize_database(self):
        """Test initialize_database creates connection and tests it."""
        from stt_v2.core.database import connection as conn_module

        mock_engine = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock()

        # Create async context manager mock
        mock_begin = AsyncMock()
        mock_begin.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_begin.__aexit__ = AsyncMock(return_value=None)
        mock_engine.begin = MagicMock(return_value=mock_begin)

        with patch.object(conn_module, "_get_or_create_engine", return_value=(mock_engine, MagicMock())):
            await conn_module.initialize_database()

            mock_conn.execute.assert_called_once()
            assert conn_module._initialized is True

    @pytest.mark.asyncio
    async def test_close_database(self):
        """Test close_database disposes all engines."""
        from stt_v2.core.database import connection as conn_module

        # Set up mock engines
        mock_engine1 = AsyncMock()
        mock_engine1.dispose = AsyncMock()
        mock_engine2 = AsyncMock()
        mock_engine2.dispose = AsyncMock()

        original_engines = conn_module._engines.copy()
        original_factories = conn_module._session_factories.copy()
        original_initialized = conn_module._initialized

        conn_module._engines = {1: mock_engine1, 2: mock_engine2}
        conn_module._session_factories = {1: MagicMock(), 2: MagicMock()}
        conn_module._initialized = True

        try:
            await conn_module.close_database()

            mock_engine1.dispose.assert_called_once()
            mock_engine2.dispose.assert_called_once()
            assert len(conn_module._engines) == 0
            assert len(conn_module._session_factories) == 0
            assert conn_module._initialized is False
        finally:
            # Restore original state
            conn_module._engines.clear()
            conn_module._engines.update(original_engines)
            conn_module._session_factories.clear()
            conn_module._session_factories.update(original_factories)
            conn_module._initialized = original_initialized


class TestDatabaseSession:
    """Tests for database session management."""

    @pytest.mark.asyncio
    async def test_get_db_session_yields_session(self):
        """Test get_db_session yields a session."""
        from stt_v2.core.database import connection as conn_module

        mock_session = AsyncMock()
        mock_session.rollback = AsyncMock()

        mock_factory = MagicMock()
        mock_session_context = AsyncMock()
        mock_session_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_context.__aexit__ = AsyncMock(return_value=None)
        mock_factory.return_value = mock_session_context

        with patch.object(conn_module, "_get_or_create_engine", return_value=(MagicMock(), mock_factory)):
            async with conn_module.get_db_session() as session:
                assert session is mock_session

    @pytest.mark.asyncio
    async def test_get_db_session_rollback_on_exception(self):
        """Test get_db_session rolls back on exception."""
        from stt_v2.core.database import connection as conn_module

        mock_session = AsyncMock()
        mock_session.rollback = AsyncMock()

        mock_factory = MagicMock()
        mock_session_context = AsyncMock()
        mock_session_context.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_context.__aexit__ = AsyncMock(return_value=None)
        mock_factory.return_value = mock_session_context

        with patch.object(conn_module, "_get_or_create_engine", return_value=(MagicMock(), mock_factory)):
            try:
                async with conn_module.get_db_session() as session:
                    raise ValueError("Test error")
            except ValueError:
                pass

            mock_session.rollback.assert_called_once()
