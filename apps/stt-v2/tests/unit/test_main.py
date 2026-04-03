"""Unit tests for FastAPI application main module.

Tests cover app creation, middleware setup, and signal handling.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestCreateApp:
    """Tests for create_app function."""

    def test_create_app_returns_fastapi_instance(self):
        """Test create_app returns FastAPI instance."""
        from fastapi import FastAPI

        from stt_v2.main import create_app

        with patch("stt_v2.main.settings") as mock_settings:
            mock_settings.app_version = "2.0.0"
            mock_settings.debug = False
            mock_settings.cors_origins = ["*"]
            mock_settings.otel_enabled = False
            mock_settings.metrics_enabled = False

            app = create_app()

            assert isinstance(app, FastAPI)
            assert app.version == "2.0.0"

    def test_create_app_with_debug_mode(self):
        """Test create_app enables docs in debug mode."""
        from stt_v2.main import create_app

        with patch("stt_v2.main.settings") as mock_settings:
            mock_settings.app_version = "2.0.0"
            mock_settings.debug = True
            mock_settings.cors_origins = ["*"]
            mock_settings.otel_enabled = False
            mock_settings.metrics_enabled = False

            app = create_app()

            assert app.docs_url == "/api/v1/docs"
            assert app.redoc_url == "/api/v1/redoc"

    def test_create_app_without_debug_mode(self):
        """Test create_app disables docs in production."""
        from stt_v2.main import create_app

        with patch("stt_v2.main.settings") as mock_settings:
            mock_settings.app_version = "2.0.0"
            mock_settings.debug = False
            mock_settings.cors_origins = ["*"]
            mock_settings.otel_enabled = False
            mock_settings.metrics_enabled = False

            app = create_app()

            assert app.docs_url is None
            assert app.redoc_url is None

    def test_create_app_includes_health_router(self):
        """Test that health router is included."""
        from stt_v2.main import create_app

        with patch("stt_v2.main.settings") as mock_settings:
            mock_settings.app_version = "2.0.0"
            mock_settings.debug = False
            mock_settings.cors_origins = ["*"]
            mock_settings.otel_enabled = False
            mock_settings.metrics_enabled = False

            app = create_app()

            routes = [r.path for r in app.routes]
            assert "/api/v1/health" in routes
            assert "/api/v1/ready" in routes
            assert "/api/v1/live" in routes

    def test_create_app_includes_internal_router(self):
        """Test that internal router is included."""
        from stt_v2.main import create_app

        with patch("stt_v2.main.settings") as mock_settings:
            mock_settings.app_version = "2.0.0"
            mock_settings.debug = False
            mock_settings.cors_origins = ["*"]
            mock_settings.otel_enabled = False
            mock_settings.metrics_enabled = False

            app = create_app()

            # Check that internal routes exist
            routes = [r.path for r in app.routes]
            assert "/internal/cache/stats" in routes


class TestSigtermHandler:
    """Tests for SIGTERM signal handler."""

    def test_sigterm_handler_raises_system_exit(self):
        """Test that SIGTERM handler raises SystemExit."""
        from stt_v2.main import handle_sigterm

        with pytest.raises(SystemExit) as exc_info:
            handle_sigterm(15, None)

        assert exc_info.value.code == 0


class TestLifespan:
    """Tests for application lifespan management."""

    @pytest.mark.asyncio
    async def test_lifespan_startup_and_shutdown(self):
        """Test lifespan context manager calls init and close functions."""
        from fastapi import FastAPI

        from stt_v2.main import lifespan

        mock_app = FastAPI()

        with patch("stt_v2.main.initialize_database", new_callable=AsyncMock) as mock_db, \
             patch("stt_v2.main.initialize_redis", new_callable=AsyncMock) as mock_redis, \
             patch("stt_v2.main.initialize_minio", new_callable=AsyncMock) as mock_minio, \
             patch("stt_v2.main.initialize_streaming", new_callable=AsyncMock), \
             patch("stt_v2.main.shutdown_streaming", new_callable=AsyncMock), \
             patch("stt_v2.main._configure_torch_threading"), \
             patch("stt_v2.main._preload_pipeline_models", new_callable=AsyncMock), \
             patch("stt_v2.main.close_database", new_callable=AsyncMock) as mock_close_db, \
             patch("stt_v2.main.close_redis", new_callable=AsyncMock) as mock_close_redis, \
             patch("stt_v2.main.close_minio", new_callable=AsyncMock) as mock_close_minio, \
             patch("stt_v2.main.settings") as mock_settings, \
             patch.dict("sys.modules", {
                 "stt_v2.diarization.embedding_service": MagicMock(
                     get_embedding_service=MagicMock(return_value=AsyncMock())
                 ),
             }):

            mock_settings.app_version = "2.0.0"
            mock_settings.torch_num_threads = 0
            mock_settings.torch_num_interop_threads = 1
            mock_settings.onnx_num_threads = 0
            mock_settings.preload_pipelines = ""

            async with lifespan(mock_app):
                mock_db.assert_called_once()
                mock_redis.assert_called_once()
                mock_minio.assert_called_once()

            mock_close_db.assert_called_once()
            mock_close_redis.assert_called_once()
            mock_close_minio.assert_called_once()


class TestAppInstance:
    """Tests for the global app instance."""

    def test_app_is_fastapi_instance(self):
        """Test that app is a FastAPI instance."""
        from fastapi import FastAPI

        from stt_v2.main import app

        assert isinstance(app, FastAPI)

    def test_app_has_title(self):
        """Test app has correct title."""
        from stt_v2.main import app

        assert app.title == "STT Service V2"
