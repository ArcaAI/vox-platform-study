"""Unit tests for Dramatiq worker module.

Tests cover worker initialization and cleanup functions.
"""

from contextlib import contextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestWorkerServiceInitialization:
    """Tests for worker service initialization."""

    @pytest.mark.asyncio
    async def test_initialize_services(self):
        """Test initialize_services calls required init functions."""
        # We need to import after setting up patches
        with patch("stt.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            # Now set up the function patches
            with (
                patch(
                    "stt.core.database.connection.initialize_database", new_callable=AsyncMock
                ) as mock_db,
                patch(
                    "stt.core.storage.minio_client.initialize_minio", new_callable=AsyncMock
                ) as mock_minio,
            ):

                # Import the function after patches
                from stt.worker import initialize_services

                await initialize_services()

                mock_db.assert_called_once()
                mock_minio.assert_called_once()


class TestWorkerServiceCleanup:
    """Tests for worker service cleanup."""

    @pytest.mark.asyncio
    async def test_cleanup_services(self):
        """Test cleanup_services calls close functions."""
        with patch("stt.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            with (
                patch(
                    "stt.core.database.connection.close_database", new_callable=AsyncMock
                ) as mock_close_db,
                patch(
                    "stt.core.storage.minio_client.close_minio", new_callable=AsyncMock
                ) as mock_close_minio,
            ):

                from stt.worker import cleanup_services

                await cleanup_services()

                mock_close_db.assert_called_once()
                mock_close_minio.assert_called_once()

    @pytest.mark.asyncio
    async def test_cleanup_services_handles_db_error(self):
        """Test cleanup_services handles database close error."""
        with patch("stt.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            with (
                patch(
                    "stt.core.database.connection.close_database", new_callable=AsyncMock
                ) as mock_close_db,
                patch(
                    "stt.core.storage.minio_client.close_minio", new_callable=AsyncMock
                ) as mock_close_minio,
            ):

                mock_close_db.side_effect = Exception("DB close error")

                from stt.worker import cleanup_services

                # Should not raise - handles error gracefully
                await cleanup_services()

                mock_close_minio.assert_called_once()

    @pytest.mark.asyncio
    async def test_cleanup_services_handles_minio_error(self):
        """Test cleanup_services handles MinIO close error."""
        with patch("stt.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            with (
                patch(
                    "stt.core.database.connection.close_database", new_callable=AsyncMock
                ) as mock_close_db,
                patch(
                    "stt.core.storage.minio_client.close_minio", new_callable=AsyncMock
                ) as mock_close_minio,
            ):

                mock_close_minio.side_effect = Exception("MinIO close error")

                from stt.worker import cleanup_services

                # Should not raise - handles error gracefully
                await cleanup_services()

                mock_close_db.assert_called_once()


class TestWorkerNewServiceInitialization:
    """Tests for worker initialization of new services (VAD, Qdrant, Diarization)."""

    @pytest.mark.asyncio
    async def test_initialize_services_calls_vad_init(self):
        """Test that initialize_services initializes VAD service."""
        with patch("stt.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            mock_vad = MagicMock()
            mock_vad.initialize = AsyncMock()

            with (
                patch(
                    "stt.core.database.connection.initialize_database", new_callable=AsyncMock
                ),
                patch("stt.core.storage.minio_client.initialize_minio", new_callable=AsyncMock),
                patch("stt.vad.silero_service.get_vad_service", return_value=mock_vad),
            ):

                from stt.worker import initialize_services

                await initialize_services()

                mock_vad.initialize.assert_called_once()

    @pytest.mark.asyncio
    async def test_initialize_services_calls_diarization_init(self):
        """Test that initialize_services initializes diarization service."""
        with patch("stt.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            mock_embedding = MagicMock()
            mock_embedding.initialize = AsyncMock()

            with (
                patch(
                    "stt.core.database.connection.initialize_database", new_callable=AsyncMock
                ),
                patch("stt.core.storage.minio_client.initialize_minio", new_callable=AsyncMock),
                patch("stt.vad.silero_service.get_vad_service", side_effect=Exception("skip")),
                patch(
                    "stt.diarization.embedding_service.get_embedding_service",
                    return_value=mock_embedding,
                ),
            ):

                from stt.worker import initialize_services

                await initialize_services()

                mock_embedding.initialize.assert_called_once()

    @pytest.mark.asyncio
    async def test_initialize_services_vad_failure_nonfatal(self):
        """Test that VAD initialization failure doesn't block other services."""
        with patch("stt.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            mock_embedding = MagicMock()
            mock_embedding.initialize = AsyncMock()

            with (
                patch(
                    "stt.core.database.connection.initialize_database", new_callable=AsyncMock
                ),
                patch("stt.core.storage.minio_client.initialize_minio", new_callable=AsyncMock),
                patch(
                    "stt.vad.silero_service.get_vad_service",
                    side_effect=RuntimeError("VAD init failed"),
                ),
                patch(
                    "stt.diarization.embedding_service.get_embedding_service",
                    return_value=mock_embedding,
                ),
            ):

                from stt.worker import initialize_services

                # Should NOT raise
                await initialize_services()
                # Diarization should still have been called
                mock_embedding.initialize.assert_called_once()


class TestWorkerPunctuationLogging:
    """Worker boot-log contract for the punctuation service
    (mirrors the FastAPI lifespan contract in test_main.py)."""

    @contextmanager
    def _quiet_worker_init(self):
        """Patch all non-punctuation services to initialize without warnings."""
        mock_vad = MagicMock()
        mock_vad.initialize = AsyncMock()
        mock_embedding = MagicMock()
        mock_embedding.initialize = AsyncMock()

        with patch("stt.worker.configure_broker", return_value=MagicMock()):
            with (
                patch(
                    "stt.core.database.connection.initialize_database",
                    new_callable=AsyncMock,
                ),
                patch(
                    "stt.core.storage.minio_client.initialize_minio",
                    new_callable=AsyncMock,
                ),
                patch("stt.vad.silero_service.get_vad_service", return_value=mock_vad),
                patch(
                    "stt.diarization.embedding_service.get_embedding_service",
                    return_value=mock_embedding,
                ),
                patch("stt.worker.logger") as mock_logger,
            ):
                yield mock_logger

    @staticmethod
    def _info_messages(mock_logger):
        return [c.args[0] for c in mock_logger.info.call_args_list if c.args]

    @pytest.mark.asyncio
    async def test_failed_punctuation_init_logs_one_warning_and_debug_detail(self):
        with self._quiet_worker_init() as mock_logger:
            with patch(
                "stt.punctuation.service.initialize",
                side_effect=RuntimeError("cadence load failed"),
            ):
                from stt.worker import initialize_services

                await initialize_services()

        warning_calls = mock_logger.warning.call_args_list
        assert len(warning_calls) == 1
        assert "Punctuation service initialization failed" in warning_calls[0].args[0]

        debug_exc_info_calls = [
            c for c in mock_logger.debug.call_args_list if c.kwargs.get("exc_info") is True
        ]
        assert len(debug_exc_info_calls) == 1

        assert "Punctuation service initialized" not in self._info_messages(mock_logger)

    @pytest.mark.asyncio
    async def test_disabled_punctuation_does_not_log_initialized(self):
        with self._quiet_worker_init() as mock_logger:
            with patch("stt.punctuation.service.initialize", return_value=False):
                from stt.worker import initialize_services

                await initialize_services()

        assert "Punctuation service initialized" not in self._info_messages(mock_logger)
        assert mock_logger.warning.call_count == 0

    @pytest.mark.asyncio
    async def test_loaded_punctuation_logs_initialized(self):
        with self._quiet_worker_init() as mock_logger:
            with patch("stt.punctuation.service.initialize", return_value=True):
                from stt.worker import initialize_services

                await initialize_services()

        assert "Punctuation service initialized" in self._info_messages(mock_logger)
        assert mock_logger.warning.call_count == 0


class TestWorkerNewServiceCleanup:
    """Tests for worker cleanup of new services (VAD, Diarization)."""

    @pytest.mark.asyncio
    async def test_cleanup_services_shuts_down_vad(self):
        """Test that cleanup_services shuts down VAD service."""
        with patch("stt.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            mock_vad = MagicMock()
            mock_vad.shutdown = AsyncMock()

            with (
                patch("stt.core.database.connection.close_database", new_callable=AsyncMock),
                patch("stt.core.storage.minio_client.close_minio", new_callable=AsyncMock),
                patch("stt.vad.silero_service.get_vad_service", return_value=mock_vad),
                patch("stt.diarization.embedding_service.get_embedding_service") as mock_emb,
            ):

                mock_emb_instance = MagicMock()
                mock_emb_instance.shutdown = AsyncMock()
                mock_emb.return_value = mock_emb_instance

                from stt.worker import cleanup_services

                await cleanup_services()

                mock_vad.shutdown.assert_called_once()

    @pytest.mark.asyncio
    async def test_cleanup_services_handles_vad_shutdown_error(self):
        """Test that VAD shutdown error doesn't block other cleanup."""
        with patch("stt.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            with (
                patch("stt.core.database.connection.close_database", new_callable=AsyncMock),
                patch("stt.core.storage.minio_client.close_minio", new_callable=AsyncMock),
                patch(
                    "stt.vad.silero_service.get_vad_service",
                    side_effect=RuntimeError("VAD error"),
                ),
                patch("stt.diarization.embedding_service.get_embedding_service") as mock_emb,
            ):

                mock_emb_instance = MagicMock()
                mock_emb_instance.shutdown = AsyncMock()
                mock_emb.return_value = mock_emb_instance

                from stt.worker import cleanup_services

                # Should NOT raise
                await cleanup_services()
                # Other cleanups should still have been called
                mock_emb_instance.shutdown.assert_called_once()
