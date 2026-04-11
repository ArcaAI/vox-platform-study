"""Unit tests for Dramatiq worker module.

Tests cover worker initialization and cleanup functions.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestWorkerServiceInitialization:
    """Tests for worker service initialization."""

    @pytest.mark.asyncio
    async def test_initialize_services(self):
        """Test initialize_services calls required init functions."""
        # We need to import after setting up patches
        with patch("stt_v2.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            # Now set up the function patches
            with (
                patch(
                    "stt_v2.core.database.connection.initialize_database", new_callable=AsyncMock
                ) as mock_db,
                patch(
                    "stt_v2.core.storage.minio_client.initialize_minio", new_callable=AsyncMock
                ) as mock_minio,
            ):

                # Import the function after patches
                from stt_v2.worker import initialize_services

                await initialize_services()

                mock_db.assert_called_once()
                mock_minio.assert_called_once()


class TestWorkerServiceCleanup:
    """Tests for worker service cleanup."""

    @pytest.mark.asyncio
    async def test_cleanup_services(self):
        """Test cleanup_services calls close functions."""
        with patch("stt_v2.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            with (
                patch(
                    "stt_v2.core.database.connection.close_database", new_callable=AsyncMock
                ) as mock_close_db,
                patch(
                    "stt_v2.core.storage.minio_client.close_minio", new_callable=AsyncMock
                ) as mock_close_minio,
            ):

                from stt_v2.worker import cleanup_services

                await cleanup_services()

                mock_close_db.assert_called_once()
                mock_close_minio.assert_called_once()

    @pytest.mark.asyncio
    async def test_cleanup_services_handles_db_error(self):
        """Test cleanup_services handles database close error."""
        with patch("stt_v2.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            with (
                patch(
                    "stt_v2.core.database.connection.close_database", new_callable=AsyncMock
                ) as mock_close_db,
                patch(
                    "stt_v2.core.storage.minio_client.close_minio", new_callable=AsyncMock
                ) as mock_close_minio,
            ):

                mock_close_db.side_effect = Exception("DB close error")

                from stt_v2.worker import cleanup_services

                # Should not raise - handles error gracefully
                await cleanup_services()

                mock_close_minio.assert_called_once()

    @pytest.mark.asyncio
    async def test_cleanup_services_handles_minio_error(self):
        """Test cleanup_services handles MinIO close error."""
        with patch("stt_v2.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            with (
                patch(
                    "stt_v2.core.database.connection.close_database", new_callable=AsyncMock
                ) as mock_close_db,
                patch(
                    "stt_v2.core.storage.minio_client.close_minio", new_callable=AsyncMock
                ) as mock_close_minio,
            ):

                mock_close_minio.side_effect = Exception("MinIO close error")

                from stt_v2.worker import cleanup_services

                # Should not raise - handles error gracefully
                await cleanup_services()

                mock_close_db.assert_called_once()


class TestWorkerNewServiceInitialization:
    """Tests for worker initialization of new services (VAD, Qdrant, Diarization)."""

    @pytest.mark.asyncio
    async def test_initialize_services_calls_vad_init(self):
        """Test that initialize_services initializes VAD service."""
        with patch("stt_v2.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            mock_vad = MagicMock()
            mock_vad.initialize = AsyncMock()

            with (
                patch(
                    "stt_v2.core.database.connection.initialize_database", new_callable=AsyncMock
                ),
                patch("stt_v2.core.storage.minio_client.initialize_minio", new_callable=AsyncMock),
                patch("stt_v2.vad.silero_service.get_vad_service", return_value=mock_vad),
            ):

                from stt_v2.worker import initialize_services

                await initialize_services()

                mock_vad.initialize.assert_called_once()

    @pytest.mark.asyncio
    async def test_initialize_services_calls_diarization_init(self):
        """Test that initialize_services initializes diarization service."""
        with patch("stt_v2.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            mock_embedding = MagicMock()
            mock_embedding.initialize = AsyncMock()

            with (
                patch(
                    "stt_v2.core.database.connection.initialize_database", new_callable=AsyncMock
                ),
                patch("stt_v2.core.storage.minio_client.initialize_minio", new_callable=AsyncMock),
                patch("stt_v2.vad.silero_service.get_vad_service", side_effect=Exception("skip")),
                patch(
                    "stt_v2.diarization.embedding_service.get_embedding_service",
                    return_value=mock_embedding,
                ),
            ):

                from stt_v2.worker import initialize_services

                await initialize_services()

                mock_embedding.initialize.assert_called_once()

    @pytest.mark.asyncio
    async def test_initialize_services_vad_failure_nonfatal(self):
        """Test that VAD initialization failure doesn't block other services."""
        with patch("stt_v2.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            mock_embedding = MagicMock()
            mock_embedding.initialize = AsyncMock()

            with (
                patch(
                    "stt_v2.core.database.connection.initialize_database", new_callable=AsyncMock
                ),
                patch("stt_v2.core.storage.minio_client.initialize_minio", new_callable=AsyncMock),
                patch(
                    "stt_v2.vad.silero_service.get_vad_service",
                    side_effect=RuntimeError("VAD init failed"),
                ),
                patch(
                    "stt_v2.diarization.embedding_service.get_embedding_service",
                    return_value=mock_embedding,
                ),
            ):

                from stt_v2.worker import initialize_services

                # Should NOT raise
                await initialize_services()
                # Diarization should still have been called
                mock_embedding.initialize.assert_called_once()


class TestWorkerNewServiceCleanup:
    """Tests for worker cleanup of new services (VAD, Diarization)."""

    @pytest.mark.asyncio
    async def test_cleanup_services_shuts_down_vad(self):
        """Test that cleanup_services shuts down VAD service."""
        with patch("stt_v2.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            mock_vad = MagicMock()
            mock_vad.shutdown = AsyncMock()

            with (
                patch("stt_v2.core.database.connection.close_database", new_callable=AsyncMock),
                patch("stt_v2.core.storage.minio_client.close_minio", new_callable=AsyncMock),
                patch("stt_v2.vad.silero_service.get_vad_service", return_value=mock_vad),
                patch("stt_v2.diarization.embedding_service.get_embedding_service") as mock_emb,
            ):

                mock_emb_instance = MagicMock()
                mock_emb_instance.shutdown = AsyncMock()
                mock_emb.return_value = mock_emb_instance

                from stt_v2.worker import cleanup_services

                await cleanup_services()

                mock_vad.shutdown.assert_called_once()

    @pytest.mark.asyncio
    async def test_cleanup_services_handles_vad_shutdown_error(self):
        """Test that VAD shutdown error doesn't block other cleanup."""
        with patch("stt_v2.worker.configure_broker") as mock_configure:
            mock_configure.return_value = MagicMock()

            with (
                patch("stt_v2.core.database.connection.close_database", new_callable=AsyncMock),
                patch("stt_v2.core.storage.minio_client.close_minio", new_callable=AsyncMock),
                patch(
                    "stt_v2.vad.silero_service.get_vad_service",
                    side_effect=RuntimeError("VAD error"),
                ),
                patch("stt_v2.diarization.embedding_service.get_embedding_service") as mock_emb,
            ):

                mock_emb_instance = MagicMock()
                mock_emb_instance.shutdown = AsyncMock()
                mock_emb.return_value = mock_emb_instance

                from stt_v2.worker import cleanup_services

                # Should NOT raise
                await cleanup_services()
                # Other cleanups should still have been called
                mock_emb_instance.shutdown.assert_called_once()
