"""Unit tests for FastAPI application main module.

Tests cover app creation, middleware setup, and signal handling.
"""

import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestCreateApp:
    """Tests for create_app function."""

    def test_create_app_returns_fastapi_instance(self):
        """Test create_app returns FastAPI instance."""
        from fastapi import FastAPI

        from stt.main import create_app

        with patch("stt.main.settings") as mock_settings:
            mock_settings.app_version = "2.0.0"
            mock_settings.debug = False
            mock_settings.cors_origins = ["*"]
            mock_settings.otel_enabled = False
            mock_settings.otel_exporter_endpoint = "http://localhost:4317"
            mock_settings.otel_service_name = "stt"
            mock_settings.log_level = "INFO"
            mock_settings.metrics_enabled = False

            app = create_app()

            assert isinstance(app, FastAPI)
            assert app.version == "2.0.0"

    def test_create_app_with_debug_mode(self):
        """Test create_app enables docs in debug mode."""
        from stt.main import create_app

        with patch("stt.main.settings") as mock_settings:
            mock_settings.app_version = "2.0.0"
            mock_settings.debug = True
            mock_settings.cors_origins = ["*"]
            mock_settings.otel_enabled = False
            mock_settings.otel_exporter_endpoint = "http://localhost:4317"
            mock_settings.otel_service_name = "stt"
            mock_settings.log_level = "INFO"
            mock_settings.metrics_enabled = False

            app = create_app()

            assert app.docs_url == "/api/v1/docs"
            assert app.redoc_url == "/api/v1/redoc"

    def test_create_app_without_debug_mode(self):
        """Test create_app disables docs in production."""
        from stt.main import create_app

        with patch("stt.main.settings") as mock_settings:
            mock_settings.app_version = "2.0.0"
            mock_settings.debug = False
            mock_settings.cors_origins = ["*"]
            mock_settings.otel_enabled = False
            mock_settings.otel_exporter_endpoint = "http://localhost:4317"
            mock_settings.otel_service_name = "stt"
            mock_settings.log_level = "INFO"
            mock_settings.metrics_enabled = False

            app = create_app()

            assert app.docs_url is None
            assert app.redoc_url is None

    def test_create_app_includes_health_router(self):
        """Test that health router is included."""
        from stt.main import create_app

        with patch("stt.main.settings") as mock_settings:
            mock_settings.app_version = "2.0.0"
            mock_settings.debug = False
            mock_settings.cors_origins = ["*"]
            mock_settings.otel_enabled = False
            mock_settings.otel_exporter_endpoint = "http://localhost:4317"
            mock_settings.otel_service_name = "stt"
            mock_settings.log_level = "INFO"
            mock_settings.metrics_enabled = False

            app = create_app()

            routes = set(app.openapi()["paths"].keys())
            assert "/api/v1/health" in routes
            assert "/api/v1/ready" in routes
            assert "/api/v1/live" in routes

    def test_create_app_includes_internal_router(self):
        """Test that internal router is included."""
        from stt.main import create_app

        with patch("stt.main.settings") as mock_settings:
            mock_settings.app_version = "2.0.0"
            mock_settings.debug = False
            mock_settings.cors_origins = ["*"]
            mock_settings.otel_enabled = False
            mock_settings.otel_exporter_endpoint = "http://localhost:4317"
            mock_settings.otel_service_name = "stt"
            mock_settings.log_level = "INFO"
            mock_settings.metrics_enabled = False

            app = create_app()

            # Check that internal routes exist
            routes = set(app.openapi()["paths"].keys())
            assert "/internal/cache/stats" in routes


class TestNoCompetingSigtermHandler:
    """`stt.main` must NOT install its own SIGTERM handler.

    Verified defect: `uvicorn.Server.serve` installs its own SIGTERM/SIGINT
    handlers (via plain `signal.signal`, inside `capture_signals`) BEFORE
    `config.load` imports the string app target (`"stt.main:app"`). Because
    that import happens strictly *after* uvicorn's handler is installed, the
    module-level `signal.signal(signal.SIGTERM, handle_sigterm)` this file
    used to carry always ran second and clobbered uvicorn's handler — for
    every invocation shape (`uvicorn stt.main:app` CLI, `python -m uvicorn
    stt.main:app`, and the `stt = "stt.main:main"` console script), since all
    of them pass the app as a string and let uvicorn's `Config.load` do the
    import.

    `handle_sigterm` just did `raise SystemExit(0)` — raised inside whatever
    coroutine the event loop was running, unwinding straight out of
    `asyncio.run` without ever calling `self.should_exit = True` or
    `Server.shutdown`. That skips the ASGI `lifespan` shutdown event
    entirely, so `shutdown_streaming` (`stt.main.lifespan`, post-`yield`)
    never runs on a real k8s SIGTERM.

    Fix: remove the handler and its registration — let uvicorn own SIGTERM
    exclusively, which drives its normal graceful path
    (`should_exit` -> `main_loop` notices -> `Server.shutdown` -> ASGI
    `lifespan.shutdown` -> our `lifespan` post-`yield` cleanup).
    """

    def test_handle_sigterm_no_longer_exists(self):
        """The competing handler function itself is gone."""
        import stt.main

        assert not hasattr(stt.main, "handle_sigterm")

    def test_importing_stt_main_does_not_touch_the_sigterm_handler(self):
        """Regression guard for the actual bug: a completely fresh
        interpreter must show SIGTERM still at its OS default after
        `import stt.main` — proving the module makes no `signal.signal`
        call for SIGTERM at import time (the exact defect: it used to
        overwrite whatever uvicorn had already installed)."""
        src_dir = Path(__file__).resolve().parents[2] / "src"
        env = {
            **os.environ,
            "PYTHONPATH": f"{src_dir}{os.pathsep}{os.environ.get('PYTHONPATH', '')}",
        }

        result = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "import signal\n"
                    "before = signal.getsignal(signal.SIGTERM)\n"
                    "import stt.main  # noqa: F401\n"
                    "after = signal.getsignal(signal.SIGTERM)\n"
                    "assert before == after == signal.SIG_DFL, (before, after)\n"
                    "print('OK')\n"
                ),
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )

        assert result.returncode == 0, result.stdout + result.stderr
        assert "OK" in result.stdout


class TestLifespan:
    """Tests for application lifespan management."""

    @pytest.mark.asyncio
    async def test_lifespan_startup_and_shutdown(self):
        """Test lifespan context manager calls init and close functions."""
        from fastapi import FastAPI

        from stt.main import lifespan

        mock_app = FastAPI()

        with (
            patch("stt.main.initialize_database", new_callable=AsyncMock) as mock_db,
            patch("stt.main.initialize_redis", new_callable=AsyncMock) as mock_redis,
            patch("stt.main.initialize_minio", new_callable=AsyncMock) as mock_minio,
            patch("stt.main.initialize_streaming", new_callable=AsyncMock),
            patch("stt.main.shutdown_streaming", new_callable=AsyncMock),
            patch("stt.main._configure_torch_threading"),
            patch("stt.main.close_database", new_callable=AsyncMock) as mock_close_db,
            patch("stt.main.close_redis", new_callable=AsyncMock) as mock_close_redis,
            patch("stt.main.close_minio", new_callable=AsyncMock) as mock_close_minio,
            patch("stt.main.settings") as mock_settings,
            patch.dict(
                "sys.modules",
                {
                    "stt.diarization.embedding_service": MagicMock(
                        get_embedding_service=MagicMock(return_value=AsyncMock())
                    ),
                },
            ),
        ):

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


class TestLifespanLazyModels:
    """Auxiliary ML models must NOT load at boot.

    The lifespan startup must not initialize the Silero VAD, Pyannote
    embedding, or Cadence punctuation models — each loads lazily on first
    use. A freshly booted process therefore holds no ML weights.
    """

    @pytest.mark.asyncio
    async def test_lifespan_does_not_initialize_auxiliary_models(self):
        from fastapi import FastAPI

        from stt.main import lifespan

        mock_vad = MagicMock()
        mock_vad.initialize = AsyncMock()
        mock_embedding = MagicMock()
        mock_embedding.initialize = AsyncMock()
        mock_embedding.shutdown = AsyncMock()
        mock_get_vad = MagicMock(return_value=mock_vad)
        mock_get_embedding = MagicMock(return_value=mock_embedding)

        with (
            patch("stt.main.initialize_database", new_callable=AsyncMock),
            patch("stt.main.initialize_redis", new_callable=AsyncMock),
            patch("stt.main.initialize_minio", new_callable=AsyncMock),
            patch("stt.main.initialize_streaming", new_callable=AsyncMock),
            patch("stt.main.shutdown_streaming", new_callable=AsyncMock),
            patch("stt.main._configure_torch_threading"),
            patch("stt.main.close_database", new_callable=AsyncMock),
            patch("stt.main.close_redis", new_callable=AsyncMock),
            patch("stt.main.close_minio", new_callable=AsyncMock),
            patch("stt.main.settings") as mock_settings,
            patch("stt.punctuation.service.initialize") as mock_punct_init,
            patch.dict(
                "sys.modules",
                {
                    "stt.diarization.embedding_service": MagicMock(
                        get_embedding_service=mock_get_embedding
                    ),
                    "stt.vad.silero_service": MagicMock(get_vad_service=mock_get_vad),
                },
            ),
        ):
            mock_settings.app_version = "2.0.0"
            mock_settings.preload_pipelines = ""

            async with lifespan(FastAPI()):
                # During the running phase (post-startup) no aux model loaded.
                mock_punct_init.assert_not_called()
                mock_vad.initialize.assert_not_called()
                mock_get_vad.assert_not_called()
                mock_embedding.initialize.assert_not_called()

        # Even after shutdown, no aux model was ever *initialized* (shutdown may
        # release a never-initialized embedding service — that is tolerated).
        mock_punct_init.assert_not_called()
        mock_vad.initialize.assert_not_called()
        mock_embedding.initialize.assert_not_called()


class TestAppInstance:
    """Tests for the global app instance."""

    def test_app_is_fastapi_instance(self):
        """Test that app is a FastAPI instance."""
        from fastapi import FastAPI

        from stt.main import app

        assert isinstance(app, FastAPI)

    def test_app_has_title(self):
        """Test app has correct title."""
        from stt.main import app

        assert app.title == "STT Service"
