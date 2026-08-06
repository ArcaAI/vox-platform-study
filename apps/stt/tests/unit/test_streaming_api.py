"""Unit tests for the internal streaming session API and initialization."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from stt.streaming._runtime import (
    clear_runtime,
    get_execution_profile,
    get_redis_client,
    get_session_manager,
    initialize_streaming,
    set_session_manager,
    shutdown_streaming,
)
from stt.streaming.api.routes import router
from stt.streaming.schemas import SessionMetadata, SessionStatus

# =========================================================================
# Fixtures
# =========================================================================


@pytest.fixture(autouse=True)
def _clean_runtime():
    """Ensure runtime singletons are reset before and after each test."""
    clear_runtime()
    yield
    clear_runtime()


@pytest.fixture
def mock_session_manager():
    """Create a mock SessionManager with a CapacityGuard."""
    mgr = AsyncMock()
    mgr._guard = MagicMock()
    mgr._guard.max_streams = 10
    mgr._guard.active_count = 2
    mgr._guard.available_slots = 8
    mgr.capacity_guard = mgr._guard
    # get_switch_controller (TASK-613) is a SYNCHRONOUS method on the real
    # SessionManager; explicitly set it as a plain (non-async) MagicMock so
    # routes.py's synchronous call site gets a real value/None back instead of
    # an unawaited coroutine from the AsyncMock default.
    mgr.get_switch_controller = MagicMock(return_value=None)
    return mgr


@pytest.fixture
def mock_session():
    """Create a mock StreamSession."""
    session = MagicMock()
    session.session_id = "sess-001"
    session.status = SessionStatus.ACTIVE
    session.pipeline_id = "pipe-001"
    return session


@pytest.fixture
def app_with_streaming(mock_session_manager):
    """FastAPI test app with streaming router and mock manager."""
    set_session_manager(mock_session_manager)
    app = FastAPI()
    app.include_router(router)
    return app


@pytest.fixture
def client(app_with_streaming):
    return TestClient(app_with_streaming)


@pytest.fixture
def app_no_streaming():
    """FastAPI test app with streaming router but NO session manager."""
    clear_runtime()
    app = FastAPI()
    app.include_router(router)
    return app


@pytest.fixture
def client_no_streaming(app_no_streaming):
    return TestClient(app_no_streaming)


# =========================================================================
# Tests: initialize_streaming / shutdown_streaming
# =========================================================================


class TestInitializeStreaming:
    """Tests for initialize_streaming() and shutdown_streaming()."""

    @pytest.mark.asyncio
    async def test_initialize_creates_session_manager(self, monkeypatch):
        """initialize_streaming() should create and start a SessionManager."""
        monkeypatch.setenv("LOG_LEVEL", "INFO")

        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock()
        mock_redis.aclose = AsyncMock()

        mock_profile = MagicMock()
        mock_profile.platform = "cpu"
        mock_profile.asr_device = "cpu"
        mock_profile.max_concurrent_streams = 5

        mock_mgr_instance = AsyncMock()
        mock_mgr_cls = MagicMock(return_value=mock_mgr_instance)

        with (
            patch("stt.streaming._runtime.SessionManager", mock_mgr_cls),
            patch("redis.asyncio.from_url", return_value=mock_redis),
            patch(
                "stt.streaming.execution_profile.detect_execution_profile",
                return_value=mock_profile,
            ),
        ):
            await initialize_streaming()

        assert get_session_manager() is mock_mgr_instance
        assert get_execution_profile() is mock_profile
        assert get_redis_client() is mock_redis
        mock_mgr_instance.start.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_initialize_idempotent(self):
        """Calling initialize_streaming() when already initialized is a no-op."""
        mock_mgr = AsyncMock()
        set_session_manager(mock_mgr)

        # Should not crash, just warn
        await initialize_streaming()

        # Manager should be unchanged
        assert get_session_manager() is mock_mgr

    @pytest.mark.asyncio
    async def test_shutdown_stops_manager(self):
        """shutdown_streaming() should stop the manager and clear runtime."""
        mock_mgr = AsyncMock()
        set_session_manager(mock_mgr)

        mock_redis = AsyncMock()
        import stt.streaming._runtime as rt

        rt._redis_client = mock_redis

        await shutdown_streaming()

        mock_mgr.stop.assert_awaited_once()
        mock_redis.aclose.assert_awaited_once()
        assert get_session_manager() is None
        assert get_redis_client() is None

    @pytest.mark.asyncio
    async def test_shutdown_when_not_initialized(self):
        """shutdown_streaming() when not initialized should be a safe no-op."""
        await shutdown_streaming()
        assert get_session_manager() is None


# =========================================================================
# Tests: POST /internal/streaming/sessions
# =========================================================================


class TestCreateSession:
    """Tests for the session creation endpoint."""

    def test_create_session_success(self, client, mock_session_manager, mock_session):
        mock_session_manager.create_session = AsyncMock(return_value=mock_session)

        resp = client.post(
            "/internal/streaming/sessions",
            json={
                "session_id": "sess-001",
                "tenant_id": "t-001",
                "pipeline_id": "pipe-001",
                "sample_rate": 16000,
            },
        )

        assert resp.status_code == 201
        data = resp.json()
        assert data["session_id"] == "sess-001"
        assert data["status"] == "active"
        assert data["max_concurrent"] == 10
        assert data["current_active"] == 2

    def test_create_session_at_capacity(self, client, mock_session_manager):
        mock_session_manager.create_session = AsyncMock(return_value=None)

        resp = client.post(
            "/internal/streaming/sessions",
            json={
                "session_id": "sess-002",
                "tenant_id": "t-001",
                "pipeline_id": "pipe-001",
            },
        )

        assert resp.status_code == 503
        assert "Retry-After" in resp.headers
        assert resp.json()["detail"] == "At capacity"

    def test_create_session_not_initialized(self, client_no_streaming):
        resp = client_no_streaming.post(
            "/internal/streaming/sessions",
            json={
                "session_id": "sess-003",
                "tenant_id": "t-001",
                "pipeline_id": "pipe-001",
            },
        )

        assert resp.status_code == 503
        assert "not initialized" in resp.json()["detail"]

    def test_create_session_with_optional_fields(self, client, mock_session_manager, mock_session):
        mock_session_manager.create_session = AsyncMock(return_value=mock_session)

        resp = client.post(
            "/internal/streaming/sessions",
            json={
                "session_id": "sess-004",
                "tenant_id": "t-001",
                "pipeline_id": "pipe-001",
                "consultation_id": "c-001",
                "microphone_id": "mic-doctor",
                "sample_rate": 48000,
            },
        )

        assert resp.status_code == 201

    def test_create_session_missing_required(self, client):
        resp = client.post(
            "/internal/streaming/sessions",
            json={"session_id": "sess-005"},
        )

        assert resp.status_code == 422  # Validation error

    def test_create_session_forwards_audio_bucket_name(
        self, client, mock_session_manager, mock_session
    ):
        """Posting audio_bucket_name should be forwarded verbatim to SessionManager.create_session."""
        mock_session_manager.create_session = AsyncMock(return_value=mock_session)

        resp = client.post(
            "/internal/streaming/sessions",
            json={
                "session_id": "sess-bk-1",
                "tenant_id": "t-001",
                "pipeline_id": "pipe-001",
                "audio_bucket_name": "hope-audio-arcaai",
            },
        )

        assert resp.status_code == 201
        kwargs = mock_session_manager.create_session.call_args.kwargs
        assert kwargs["audio_bucket_name"] == "hope-audio-arcaai"

    def test_create_session_defaults_audio_bucket_name(
        self, client, mock_session_manager, mock_session
    ):
        """Omitting audio_bucket_name should default to the legacy 'hope-audio' fallback."""
        mock_session_manager.create_session = AsyncMock(return_value=mock_session)

        resp = client.post(
            "/internal/streaming/sessions",
            json={
                "session_id": "sess-bk-2",
                "tenant_id": "t-001",
                "pipeline_id": "pipe-001",
            },
        )

        assert resp.status_code == 201
        kwargs = mock_session_manager.create_session.call_args.kwargs
        assert kwargs["audio_bucket_name"] == "hope-audio"

    def test_create_session_forwards_storage_descriptor(
        self, client, mock_session_manager, mock_session
    ):
        """A `storage` descriptor should be forwarded verbatim to create_session."""
        mock_session_manager.create_session = AsyncMock(return_value=mock_session)

        descriptor = {
            "provider": "azure_blob",
            "bucket": "tenant-container",
            "connection_string": "conn",
        }
        resp = client.post(
            "/internal/streaming/sessions",
            json={
                "session_id": "sess-stg-1",
                "tenant_id": "t-001",
                "pipeline_id": "pipe-001",
                "storage": descriptor,
            },
        )

        assert resp.status_code == 201
        kwargs = mock_session_manager.create_session.call_args.kwargs
        assert kwargs["storage"] == descriptor

    def test_create_session_storage_defaults_none(self, client, mock_session_manager, mock_session):
        """Omitting `storage` should forward None (legacy single-provider path)."""
        mock_session_manager.create_session = AsyncMock(return_value=mock_session)

        resp = client.post(
            "/internal/streaming/sessions",
            json={
                "session_id": "sess-stg-2",
                "tenant_id": "t-001",
                "pipeline_id": "pipe-001",
            },
        )

        assert resp.status_code == 201
        kwargs = mock_session_manager.create_session.call_args.kwargs
        assert kwargs["storage"] is None

    def test_create_session_response_includes_pipeline_id(
        self, client, mock_session_manager, mock_session
    ):
        """AC-2 (TASK-613): the create response echoes the resolved pipeline_id
        and active_engine baseline, not just the coarse request echo."""
        mock_session_manager.create_session = AsyncMock(return_value=mock_session)

        resp = client.post(
            "/internal/streaming/sessions",
            json={
                "session_id": "sess-001",
                "tenant_id": "t-001",
                "pipeline_id": "pipe-001",
            },
        )

        assert resp.status_code == 201
        data = resp.json()
        assert data["pipeline_id"] == "pipe-001"
        assert data["active_engine"] == "primary"

    def test_create_session_response_reports_fallback_engine(
        self, client, mock_session_manager, mock_session
    ):
        """When the session's EngineSwitchController reports 'fallback' (D3/D4
        — start_on=fallback or create-time load-failure fallback), the response
        must echo 'fallback', never a hardcoded 'primary'."""
        mock_session_manager.create_session = AsyncMock(return_value=mock_session)
        fake_controller = MagicMock()
        fake_controller.active_engine = "fallback"
        fake_controller.active_pipeline_id = "fb-pipe"
        mock_session_manager.get_switch_controller = MagicMock(return_value=fake_controller)

        resp = client.post(
            "/internal/streaming/sessions",
            json={
                "session_id": "sess-001",
                "tenant_id": "t-001",
                "pipeline_id": "pipe-001",
            },
        )

        assert resp.status_code == 201
        assert resp.json()["active_engine"] == "fallback"

    def test_create_response_pipeline_id_agrees_with_active_engine_on_fallback(
        self, client, mock_session_manager, mock_session
    ):
        """TASK-613 A3: a D3/D4 session used to report ``active_engine:
        'fallback'`` beside a ``pipeline_id`` naming the PRIMARY — a
        self-contradictory baseline. The id must name the EFFECTIVE pipeline."""
        mock_session_manager.create_session = AsyncMock(return_value=mock_session)
        fake_controller = MagicMock()
        fake_controller.active_engine = "fallback"
        fake_controller.active_pipeline_id = "fb-pipe"
        mock_session_manager.get_switch_controller = MagicMock(return_value=fake_controller)

        resp = client.post(
            "/internal/streaming/sessions",
            json={
                "session_id": "sess-001",
                "tenant_id": "t-001",
                "pipeline_id": "pipe-001",
            },
        )

        assert resp.status_code == 201
        data = resp.json()
        assert data["active_engine"] == "fallback"
        assert data["pipeline_id"] == "fb-pipe"

    def test_create_response_pipeline_id_agrees_with_active_engine_on_primary(
        self, client, mock_session_manager, mock_session
    ):
        mock_session_manager.create_session = AsyncMock(return_value=mock_session)
        fake_controller = MagicMock()
        fake_controller.active_engine = "primary"
        fake_controller.active_pipeline_id = "pipe-001"
        mock_session_manager.get_switch_controller = MagicMock(return_value=fake_controller)

        resp = client.post(
            "/internal/streaming/sessions",
            json={
                "session_id": "sess-001",
                "tenant_id": "t-001",
                "pipeline_id": "pipe-001",
            },
        )

        assert resp.status_code == 201
        data = resp.json()
        assert data["active_engine"] == "primary"
        assert data["pipeline_id"] == "pipe-001"

    def test_create_response_falls_back_to_the_session_id_without_a_controller(
        self, client, mock_session_manager, mock_session
    ):
        """No controller registered (or an unknown pipeline on it) ⇒ the
        session's own pipeline_id, exactly as before."""
        mock_session_manager.create_session = AsyncMock(return_value=mock_session)
        mock_session_manager.get_switch_controller = MagicMock(return_value=None)

        resp = client.post(
            "/internal/streaming/sessions",
            json={
                "session_id": "sess-001",
                "tenant_id": "t-001",
                "pipeline_id": "pipe-001",
            },
        )

        assert resp.status_code == 201
        data = resp.json()
        assert data["pipeline_id"] == "pipe-001"
        assert data["active_engine"] == "primary"


# =========================================================================
# Tests: GET /internal/streaming/sessions/{session_id}
# =========================================================================


class TestGetSession:
    """Tests for the session status endpoint."""

    def test_get_session_found(self, client, mock_session_manager, mock_session):
        mock_session_manager.get_session = MagicMock(return_value=mock_session)

        resp = client.get("/internal/streaming/sessions/sess-001")

        assert resp.status_code == 200
        data = resp.json()
        assert data["session_id"] == "sess-001"
        assert data["status"] == "active"

    def test_get_session_includes_pipeline_id_and_engine(
        self, client, mock_session_manager, mock_session
    ):
        """StreamingSessionResponse is shared by create + status; both must
        populate pipeline_id/active_engine now that the field is required."""
        mock_session_manager.get_session = MagicMock(return_value=mock_session)

        resp = client.get("/internal/streaming/sessions/sess-001")

        assert resp.status_code == 200
        data = resp.json()
        assert data["pipeline_id"] == "pipe-001"
        assert data["active_engine"] == "primary"

    def test_get_session_not_found(self, client, mock_session_manager):
        mock_session_manager.get_session = MagicMock(return_value=None)

        resp = client.get("/internal/streaming/sessions/sess-999")

        assert resp.status_code == 404

    def test_get_session_not_initialized(self, client_no_streaming):
        resp = client_no_streaming.get("/internal/streaming/sessions/sess-001")
        assert resp.status_code == 503


# =========================================================================
# Tests: DELETE /internal/streaming/sessions/{session_id}
# =========================================================================


class TestDeleteSession:
    """Tests for the session removal endpoint.

    TASK-615 WS-C — a real teardown now returns 200 with the usage-attribution
    summary the API Gateway needs to emit the transcribe.stream ledger row
    (previously a bare 204). The idempotent "already gone" branch keeps its
    original 204-no-body contract unchanged — there is nothing new to
    summarize on a no-op.
    """

    def _teardown_summary(self, **overrides):
        summary = {
            "session_id": "sess-001",
            "tenant_id": "t-1",
            "consultation_id": "c-1",
            "user_id": "u-1",
            "pipeline_id": "pipe-001",
            "closed_at": "2026-08-06T10:01:30",
            "audio_seconds": 42.5,
            "session_seconds": 90.0,
            "engine": "whisper_cpp",
            "deployment": "SELF_HOSTED",
            "language_mode": "ml-en",
        }
        summary.update(overrides)
        return summary

    def test_delete_session_success_returns_teardown_summary(
        self, client, mock_session_manager, mock_session
    ):
        mock_session_manager.get_session = MagicMock(return_value=mock_session)
        mock_session_manager.end_session = AsyncMock(return_value=self._teardown_summary())

        resp = client.delete("/internal/streaming/sessions/sess-001")

        assert resp.status_code == 200
        body = resp.json()
        assert body["session_id"] == "sess-001"
        assert body["tenant_id"] == "t-1"
        assert body["audio_seconds"] == 42.5
        assert body["session_seconds"] == 90.0
        assert body["engine"] == "whisper_cpp"
        assert body["deployment"] == "SELF_HOSTED"
        mock_session_manager.end_session.assert_awaited_once_with("sess-001")

    def test_delete_session_success_with_no_resolved_engine(
        self, client, mock_session_manager, mock_session
    ):
        """engine/deployment/language_mode are nullable — never fabricated."""
        mock_session_manager.get_session = MagicMock(return_value=mock_session)
        mock_session_manager.end_session = AsyncMock(
            return_value=self._teardown_summary(engine=None, deployment=None, language_mode=None)
        )

        resp = client.delete("/internal/streaming/sessions/sess-001")

        assert resp.status_code == 200
        body = resp.json()
        assert body["engine"] is None
        assert body["deployment"] is None

    def test_delete_session_idempotent_when_not_found(self, client, mock_session_manager):
        """DELETE should return 204 even when session doesn't exist (idempotent)."""
        mock_session_manager.get_session = MagicMock(return_value=None)
        mock_session_manager.end_session = AsyncMock()

        resp = client.delete("/internal/streaming/sessions/sess-999")

        assert resp.status_code == 204
        assert resp.content == b""
        mock_session_manager.end_session.assert_not_awaited()

    def test_delete_session_success_but_no_summary_returns_204(
        self, client, mock_session_manager, mock_session
    ):
        """A real teardown whose summary-build failed (best-effort, logged
        server-side) degrades to 204 rather than a body with nulls that would
        look like a resolved-but-empty summary."""
        mock_session_manager.get_session = MagicMock(return_value=mock_session)
        mock_session_manager.end_session = AsyncMock(return_value=None)

        resp = client.delete("/internal/streaming/sessions/sess-001")

        assert resp.status_code == 204
        assert resp.content == b""

    def test_delete_session_not_initialized(self, client_no_streaming):
        resp = client_no_streaming.delete("/internal/streaming/sessions/sess-001")
        assert resp.status_code == 503


# =========================================================================
# Tests: GET /internal/streaming/sessions/active
# =========================================================================


class TestListActiveSessions:
    """Tests for listing active sessions."""

    def test_list_active_sessions_success(self, client, mock_session_manager):
        mock_session_manager.list_sessions = MagicMock(
            return_value=[
                {"session_id": "sess-001", "status": "active"},
                {"session_id": "sess-002", "status": "active"},
            ]
        )

        resp = client.get("/internal/streaming/sessions/active")

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["active_count"] == 2
        assert len(data["sessions"]) == 2

    def test_list_active_sessions_empty(self, client, mock_session_manager):
        mock_session_manager.list_sessions = MagicMock(return_value=[])

        resp = client.get("/internal/streaming/sessions/active")

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["active_count"] == 0
        assert data["sessions"] == []

    def test_list_active_sessions_not_initialized(self, client_no_streaming):
        resp = client_no_streaming.get("/internal/streaming/sessions/active")
        assert resp.status_code == 503


# =========================================================================
# Tests: POST /internal/streaming/sessions/{session_id}/end
# =========================================================================


class TestEndActiveSession:
    """Tests for ending an active session by ID."""

    def test_end_active_session_success(self, client, mock_session_manager, mock_session):
        mock_session_manager.get_session = MagicMock(return_value=mock_session)
        mock_session_manager.end_session = AsyncMock()

        resp = client.post("/internal/streaming/sessions/sess-001/end")

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["session_id"] == "sess-001"
        mock_session_manager.end_session.assert_awaited_once_with("sess-001")

    def test_end_active_session_not_found(self, client, mock_session_manager):
        mock_session_manager.get_session = MagicMock(return_value=None)

        resp = client.post("/internal/streaming/sessions/sess-999/end")

        assert resp.status_code == 404
        assert resp.json()["detail"] == "Session not found"

    def test_end_active_session_not_initialized(self, client_no_streaming):
        resp = client_no_streaming.post("/internal/streaming/sessions/sess-001/end")
        assert resp.status_code == 503


# =========================================================================
# Tests: GET /internal/streaming/availability
# =========================================================================


class TestAvailability:
    """Tests for the availability endpoint."""

    def test_availability_ready(self, client, mock_session_manager):
        resp = client.get("/internal/streaming/availability")

        assert resp.status_code == 200
        data = resp.json()
        assert data["available"] is True
        assert data["status"] == "ready"
        assert data["max_concurrent"] == 10
        assert data["current_active"] == 2
        assert data["available_slots"] == 8

    def test_availability_at_capacity(self, client, mock_session_manager):
        mock_session_manager._guard.available_slots = 0
        mock_session_manager._guard.active_count = 10

        resp = client.get("/internal/streaming/availability")

        data = resp.json()
        assert data["available"] is False
        assert data["status"] == "at_capacity"
        assert data["available_slots"] == 0

    def test_availability_not_initialized(self, client_no_streaming):
        resp = client_no_streaming.get("/internal/streaming/availability")

        assert resp.status_code == 200
        data = resp.json()
        assert data["available"] is False
        assert data["status"] == "not_initialized"


# =========================================================================
# Tests: SessionMetadata microphone_id
# =========================================================================


class TestSessionMetadataMicrophoneId:
    """Tests for the microphone_id field in SessionMetadata."""

    def test_to_redis_dict_includes_microphone_id(self):
        meta = SessionMetadata(
            session_id="s1",
            tenant_id="t1",
            pipeline_id="p1",
            microphone_id="mic-doctor",
        )
        d = meta.to_redis_dict()
        assert d["microphone_id"] == "mic-doctor"

    def test_to_redis_dict_empty_when_none(self):
        meta = SessionMetadata(
            session_id="s1",
            tenant_id="t1",
            pipeline_id="p1",
        )
        d = meta.to_redis_dict()
        assert d["microphone_id"] == ""

    def test_from_redis_dict_roundtrip(self):
        meta = SessionMetadata(
            session_id="s1",
            tenant_id="t1",
            pipeline_id="p1",
            microphone_id="mic-patient",
        )
        d = meta.to_redis_dict()
        restored = SessionMetadata.from_redis_dict(d)
        assert restored.microphone_id == "mic-patient"

    def test_from_redis_dict_missing_microphone_id(self):
        """Backward compatibility: old metadata without microphone_id."""
        d = {
            "session_id": "s1",
            "tenant_id": "t1",
            "pipeline_id": "p1",
            "status": "active",
            "created_at": "2026-01-01T00:00:00",
            "last_activity": "2026-01-01T00:00:00",
            "total_samples_received": "0",
            "total_duration_seconds": "0",
            "utterance_count": "0",
            "last_seq": "-1",
            "sample_rate": "16000",
            "pipeline_config_json": "",
        }
        restored = SessionMetadata.from_redis_dict(d)
        assert restored.microphone_id is None

    def test_from_redis_dict_bytes_keys(self):
        meta = SessionMetadata(
            session_id="s1",
            tenant_id="t1",
            pipeline_id="p1",
            microphone_id="mic-001",
        )
        # Simulate redis.asyncio returning bytes keys
        d = {
            k.encode(): v.encode() if isinstance(v, str) else v
            for k, v in meta.to_redis_dict().items()
        }
        restored = SessionMetadata.from_redis_dict(d)
        assert restored.microphone_id == "mic-001"


# =========================================================================
# Tests: initialize_streaming — Redis failure path
# =========================================================================


class TestInitializeStreamingEdgeCases:
    """Edge cases and error paths for initialize_streaming()."""

    @pytest.mark.asyncio
    async def test_redis_ping_failure_disables_streaming(self, monkeypatch):
        """If redis.ping() fails, streaming should be disabled (not crash)."""
        monkeypatch.setenv("LOG_LEVEL", "INFO")

        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock(side_effect=ConnectionError("Connection refused"))

        with patch("redis.asyncio.from_url", return_value=mock_redis):
            await initialize_streaming()

        # Manager should NOT be created
        assert get_session_manager() is None
        assert get_execution_profile() is None
        # Redis client should be cleaned up
        assert get_redis_client() is None

    @pytest.mark.asyncio
    async def test_redis_import_failure_disables_streaming(self, monkeypatch):
        """If redis.asyncio import raises, streaming stays disabled."""
        monkeypatch.setenv("LOG_LEVEL", "INFO")

        with (
            patch.dict("sys.modules", {"redis.asyncio": None}),
            patch(
                "stt.streaming._runtime.aioredis",
                side_effect=ImportError("No module named 'redis.asyncio'"),
                create=True,
            ),
        ):
            mock_redis = AsyncMock()
            mock_redis.ping = AsyncMock(side_effect=Exception("redis unavailable"))
            with patch("redis.asyncio.from_url", side_effect=ImportError("no redis"), create=True):
                await initialize_streaming()

        assert get_session_manager() is None


# =========================================================================
# Tests: shutdown_streaming — error handling
# =========================================================================


class TestShutdownStreamingEdgeCases:
    """Error handling during shutdown."""

    @pytest.mark.asyncio
    async def test_shutdown_manager_stop_raises(self):
        """If manager.stop() raises, shutdown should still clear runtime."""
        mock_mgr = AsyncMock()
        mock_mgr.stop = AsyncMock(side_effect=RuntimeError("Stop failed"))
        set_session_manager(mock_mgr)

        import stt.streaming._runtime as rt

        rt._redis_client = AsyncMock()

        # Should not raise
        await shutdown_streaming()

        assert get_session_manager() is None
        assert get_redis_client() is None

    @pytest.mark.asyncio
    async def test_shutdown_redis_close_raises(self):
        """If redis.aclose() raises, shutdown should still complete."""
        mock_redis = AsyncMock()
        mock_redis.aclose = AsyncMock(side_effect=RuntimeError("Close error"))

        import stt.streaming._runtime as rt

        rt._redis_client = mock_redis

        await shutdown_streaming()

        assert get_redis_client() is None

    @pytest.mark.asyncio
    async def test_shutdown_clears_execution_profile(self):
        """shutdown should clear the execution profile."""
        from stt.streaming._runtime import set_execution_profile

        mock_profile = MagicMock()
        set_execution_profile(mock_profile)

        await shutdown_streaming()

        assert get_execution_profile() is None


# =========================================================================
# Tests: GET session — non-active statuses
# =========================================================================


class TestGetSessionStatuses:
    """Test that GET session returns correct status for various states."""

    def test_get_session_finalizing(self, client, mock_session_manager):
        session = MagicMock()
        session.session_id = "sess-fin"
        session.status = SessionStatus.FINALIZING
        session.pipeline_id = "pipe-fin"
        mock_session_manager.get_session = MagicMock(return_value=session)

        resp = client.get("/internal/streaming/sessions/sess-fin")

        assert resp.status_code == 200
        assert resp.json()["status"] == "finalizing"

    def test_get_session_closed(self, client, mock_session_manager):
        session = MagicMock()
        session.session_id = "sess-closed"
        session.status = SessionStatus.CLOSED
        session.pipeline_id = "pipe-closed"
        mock_session_manager.get_session = MagicMock(return_value=session)

        resp = client.get("/internal/streaming/sessions/sess-closed")

        assert resp.status_code == 200
        assert resp.json()["status"] == "closed"


# =========================================================================
# Tests: create_session — exception propagation
# =========================================================================


class TestCreateSessionErrors:
    """Test that create_session properly handles internal errors."""

    def test_create_session_internal_error(self, app_with_streaming, mock_session_manager):
        """If SessionManager.create_session raises, server returns 500."""
        mock_session_manager.create_session = AsyncMock(
            side_effect=RuntimeError("DB connection lost")
        )

        # Use raise_server_exceptions=False to capture 500 instead of propagating
        with TestClient(app_with_streaming, raise_server_exceptions=False) as c:
            resp = c.post(
                "/internal/streaming/sessions",
                json={
                    "session_id": "sess-err",
                    "tenant_id": "t-001",
                    "pipeline_id": "pipe-001",
                },
            )

        assert resp.status_code == 500

    def test_create_session_empty_session_id(self, client, mock_session_manager, mock_session):
        """Empty string for required fields should still pass Pydantic validation."""
        # Pydantic str fields accept empty strings — verify the endpoint runs
        mock_session.session_id = ""
        mock_session_manager.create_session = AsyncMock(return_value=mock_session)

        resp = client.post(
            "/internal/streaming/sessions",
            json={
                "session_id": "",
                "tenant_id": "",
                "pipeline_id": "",
            },
        )
        # Should reach the handler and create successfully
        assert resp.status_code == 201


# =========================================================================
# Tests: Pydantic schema validation
# =========================================================================


class TestApiSchemas:
    """Tests for Pydantic request/response schemas."""

    def test_create_request_defaults(self):
        from stt.streaming.api.schemas import CreateStreamingSessionRequest

        req = CreateStreamingSessionRequest(session_id="s1", tenant_id="t1", pipeline_id="p1")
        assert req.sample_rate == 16000
        assert req.consultation_id is None
        assert req.microphone_id is None
        assert req.user_id is None
        assert req.storage is None

    def test_create_request_accepts_storage_descriptor(self):
        from stt.streaming.api.schemas import CreateStreamingSessionRequest

        descriptor = {"provider": "aws_s3", "bucket": "b", "region": "us-east-1"}
        req = CreateStreamingSessionRequest(
            session_id="s1",
            tenant_id="t1",
            pipeline_id="p1",
            storage=descriptor,
        )
        assert req.storage == descriptor

    def test_create_request_all_fields(self):
        from stt.streaming.api.schemas import CreateStreamingSessionRequest

        req = CreateStreamingSessionRequest(
            session_id="s1",
            tenant_id="t1",
            pipeline_id="p1",
            consultation_id="c1",
            sample_rate=48000,
            microphone_id="mic-1",
            user_id="u1",
        )
        assert req.sample_rate == 48000
        assert req.microphone_id == "mic-1"
        assert req.user_id == "u1"

    def test_availability_response_defaults(self):
        from stt.streaming.api.schemas import StreamingAvailabilityResponse

        resp = StreamingAvailabilityResponse(available=True, status="ready")
        assert resp.max_concurrent == 0
        assert resp.current_active == 0
        assert resp.available_slots == 0

    def test_session_response_reason_none(self):
        from stt.streaming.api.schemas import StreamingSessionResponse

        resp = StreamingSessionResponse(
            session_id="s1",
            status="active",
            max_concurrent=10,
            current_active=2,
            pipeline_id="p1",
            active_engine="primary",
        )
        assert resp.reason is None

    def test_session_response_requires_pipeline_id_and_active_engine(self):
        """pipeline_id/active_engine (TASK-613) are required on the wire — the
        internal create/status response is the AC-2 baseline echo."""
        from pydantic import ValidationError

        from stt.streaming.api.schemas import StreamingSessionResponse

        with pytest.raises(ValidationError):
            StreamingSessionResponse(
                session_id="s1", status="active", max_concurrent=10, current_active=2
            )

    def test_session_response_carries_pipeline_id_and_active_engine(self):
        from stt.streaming.api.schemas import StreamingSessionResponse

        resp = StreamingSessionResponse(
            session_id="s1",
            status="active",
            max_concurrent=10,
            current_active=2,
            pipeline_id="pipe-001",
            active_engine="fallback",
        )
        assert resp.pipeline_id == "pipe-001"
        assert resp.active_engine == "fallback"


# =========================================================================
# Tests: Availability negative available_slots clamped to 0
# =========================================================================


class TestAvailabilityEdgeCases:
    """Edge cases for the availability endpoint."""

    def test_availability_negative_slots_clamped(self, client, mock_session_manager):
        """If available_slots is negative (race condition), should clamp to 0."""
        mock_session_manager._guard.available_slots = -1
        mock_session_manager._guard.active_count = 11

        resp = client.get("/internal/streaming/availability")

        data = resp.json()
        assert data["available"] is False
        assert data["available_slots"] == 0
