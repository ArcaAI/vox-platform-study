"""
E2E tests for the internal streaming session management API.

Track D — Streaming Sessions (no ML deps required)

Endpoints under test:
  POST   /internal/streaming/sessions              — create session
  GET    /internal/streaming/sessions/{session_id}  — get session status
  DELETE /internal/streaming/sessions/{session_id}  — remove session
  GET    /internal/streaming/availability            — check capacity

These tests verify both the "not initialized" code-path (streaming module
has not been started) and the full session lifecycle (streaming module
patched with a lightweight mock SessionManager backed by a **real**
CapacityGuard).

Design notes (anti-pattern mitigations):
  - D1–D4 use ``configured_app`` with NO mocks — real route handlers,
    real _runtime.get_session_manager() returning None.
  - D5 patches only the boundary function ``get_session_manager`` in
    ``stt_v2.streaming.api.routes``.  The mock SessionManager delegates
    to a **real** ``CapacityGuard`` (not mocked) and uses ``spec=True``
    on fake sessions so attribute typos raise ``AttributeError`` rather
    than silently returning ``MagicMock``.
  - Mock setup is factored into a single ``_make_mock_session_manager``
    factory to prevent duplication drift between fixtures.

Requires: monorepo test infra running (``pnpm docker:test:up``)
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt_v2.streaming.api.schemas import (
    StreamingAvailabilityResponse,
    StreamingSessionResponse,
)
from stt_v2.streaming.capacity_guard import CapacityGuard
from stt_v2.streaming.schemas import SessionStatus

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _random_session_id() -> str:
    """Return a fresh UUID string for use as a session_id."""
    return str(uuid.uuid4())


def _build_create_payload(
    session_id: str | None = None,
    tenant_id: str = "t-test",
    pipeline_id: str | None = None,
    sample_rate: int = 16000,
    consultation_id: str | None = None,
    microphone_id: str | None = None,
    user_id: str | None = None,
) -> dict:
    """Build a JSON body for ``POST /internal/streaming/sessions``.

    Mirrors all fields of ``CreateStreamingSessionRequest`` so tests
    can exercise every optional parameter the real schema accepts.
    """
    payload: dict = {
        "session_id": session_id or _random_session_id(),
        "tenant_id": tenant_id,
        "pipeline_id": pipeline_id or str(uuid.uuid4()),
        "sample_rate": sample_rate,
    }
    if consultation_id is not None:
        payload["consultation_id"] = consultation_id
    if microphone_id is not None:
        payload["microphone_id"] = microphone_id
    if user_id is not None:
        payload["user_id"] = user_id
    return payload


class _FakeStreamSession:
    """Minimal stand-in for ``StreamSession`` used in mock manager.

    Uses explicit attributes instead of ``MagicMock`` so that accessing
    a non-existent attribute raises ``AttributeError`` — preventing
    anti-pattern #4 (incomplete mock hides typos in production code).
    """

    __slots__ = ("session_id", "status", "tenant_id", "pipeline_id")

    def __init__(
        self,
        session_id: str,
        status: SessionStatus = SessionStatus.ACTIVE,
        tenant_id: str = "",
        pipeline_id: str = "",
    ) -> None:
        self.session_id = session_id
        self.status = status
        self.tenant_id = tenant_id
        self.pipeline_id = pipeline_id


def _make_mock_session_manager(
    max_streams: int = 10,
) -> tuple[MagicMock, CapacityGuard, dict[str, _FakeStreamSession]]:
    """Build a lightweight mock ``SessionManager``.

    Returns (mock_mgr, guard, sessions_dict) so tests can introspect
    internal state when needed.

    **What is real**: ``CapacityGuard`` (slot accounting, locking).
    **What is mocked**: Redis I/O, inference workers, preprocessors.

    Single factory avoids anti-pattern #3 (duplicating mock setup
    in multiple fixtures that can drift out of sync).
    """
    guard = CapacityGuard(max_streams=max_streams)
    sessions: dict[str, _FakeStreamSession] = {}

    mock_mgr = MagicMock()
    mock_mgr.capacity_guard = guard
    mock_mgr._capacity_guard = guard

    async def _create_session(
        session_id: str,
        tenant_id: str,
        pipeline_id: str,
        consultation_id: str | None = None,
        sample_rate: int = 16000,
        audio_bucket_name: str | None = None,
        user_id: str | None = None,
    ) -> _FakeStreamSession | None:
        acquired = await guard.try_acquire(session_id)
        if not acquired:
            return None  # at capacity — routes.py raises 503
        session = _FakeStreamSession(
            session_id=session_id,
            status=SessionStatus.ACTIVE,
            tenant_id=tenant_id,
            pipeline_id=pipeline_id,
        )
        sessions[session_id] = session
        return session

    mock_mgr.create_session = AsyncMock(side_effect=_create_session)

    def _get_session(session_id: str) -> _FakeStreamSession | None:
        return sessions.get(session_id)

    mock_mgr.get_session = MagicMock(side_effect=_get_session)

    async def _end_session(session_id: str) -> None:
        sessions.pop(session_id, None)
        await guard.release(session_id)

    mock_mgr.end_session = AsyncMock(side_effect=_end_session)

    return mock_mgr, guard, sessions


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
async def streaming_initialized_app(configured_app):
    """
    Yield the same ``configured_app`` HTTP client, but with the streaming
    runtime patched so ``get_session_manager()`` returns a lightweight
    mock ``SessionManager`` backed by a **real** ``CapacityGuard``
    (max_streams=10).

    This lets us exercise the full create → get → delete lifecycle without
    requiring actual Redis Streams, inference workers, or ML models.
    """
    mock_mgr, _, _ = _make_mock_session_manager(max_streams=10)

    with patch(
        "stt_v2.streaming.api.routes.get_session_manager",
        return_value=mock_mgr,
    ):
        yield configured_app


# =========================================================================
# Task D1: Streaming Availability — not initialized
# =========================================================================


@pytest.mark.e2e
class TestStreamingAvailabilityE2E:
    """Tests for ``GET /internal/streaming/availability``.

    The availability endpoint is unique: it returns 200 even when streaming
    is not initialized (unlike the other three endpoints which return 503).
    """

    async def test_availability_returns_200_always(self, configured_app):
        """Availability endpoint never returns 503, even when not initialized."""
        response = await configured_app.get("/internal/streaming/availability")
        assert response.status_code == 200

    async def test_availability_schema_has_required_fields(self, configured_app):
        """Response body must contain all fields from StreamingAvailabilityResponse."""
        response = await configured_app.get("/internal/streaming/availability")
        assert response.status_code == 200
        data = response.json()

        # Validate with Pydantic — catches missing or mis-typed fields
        parsed = StreamingAvailabilityResponse.model_validate(data)

        assert isinstance(parsed.available, bool)
        assert parsed.status in ("ready", "not_initialized", "at_capacity")
        assert isinstance(parsed.max_concurrent, int)
        assert isinstance(parsed.current_active, int)
        assert isinstance(parsed.available_slots, int)

    async def test_availability_not_initialized_values(self, configured_app):
        """Without streaming startup, available must be False with zero slots.

        configured_app does NOT trigger the FastAPI lifespan, so
        get_session_manager() returns None. This is unconditionally true —
        no ``if`` guard needed.
        """
        response = await configured_app.get("/internal/streaming/availability")
        data = response.json()

        # Must be not_initialized — no conditional
        assert data["status"] == "not_initialized"
        assert data["available"] is False
        assert data["max_concurrent"] == 0
        assert data["current_active"] == 0
        assert data["available_slots"] == 0

    async def test_availability_returns_json_content_type(self, configured_app):
        """Response Content-Type must be JSON."""
        response = await configured_app.get("/internal/streaming/availability")
        assert "application/json" in response.headers.get("content-type", "")

    async def test_availability_idempotent(self, configured_app):
        """Multiple calls return consistent results (no side effects)."""
        resp1 = await configured_app.get("/internal/streaming/availability")
        resp2 = await configured_app.get("/internal/streaming/availability")
        assert resp1.json() == resp2.json()

    async def test_availability_wrong_method_returns_405(self, configured_app):
        """POST to the availability endpoint should return 405 Method Not Allowed."""
        response = await configured_app.post("/internal/streaming/availability")
        assert response.status_code == 405


# =========================================================================
# Task D2: Create Session — 503 when not initialized + 422 validation
# =========================================================================


@pytest.mark.e2e
class TestCreateStreamingSessionNotInitializedE2E:
    """Tests for ``POST /internal/streaming/sessions`` when streaming is not initialized."""

    async def test_create_session_503_when_not_initialized(self, configured_app):
        """Creating a session when streaming not initialized returns 503."""
        payload = _build_create_payload()
        response = await configured_app.post("/internal/streaming/sessions", json=payload)
        assert response.status_code == 503
        detail = response.json()["detail"]
        assert "not initialized" in detail.lower()

    async def test_create_session_503_body_is_json(self, configured_app):
        """The 503 error body should be valid JSON with a 'detail' key."""
        payload = _build_create_payload()
        response = await configured_app.post("/internal/streaming/sessions", json=payload)
        assert response.status_code == 503
        body = response.json()
        assert "detail" in body
        assert isinstance(body["detail"], str)

    async def test_create_session_missing_all_fields_returns_422(self, configured_app):
        """Empty JSON body should return 422 (Pydantic validation error).

        422 is returned by FastAPI's request validation *before* the route
        handler runs, so streaming initialization state is irrelevant.
        """
        response = await configured_app.post("/internal/streaming/sessions", json={})
        assert response.status_code == 422

    async def test_create_session_missing_session_id_returns_422(self, configured_app):
        """Missing ``session_id`` field returns 422."""
        payload = {
            "tenant_id": "t-test",
            "pipeline_id": str(uuid.uuid4()),
        }
        response = await configured_app.post("/internal/streaming/sessions", json=payload)
        assert response.status_code == 422
        errors = response.json()["detail"]
        field_names = [e["loc"][-1] for e in errors]
        assert "session_id" in field_names

    async def test_create_session_missing_tenant_id_returns_422(self, configured_app):
        """Missing ``tenant_id`` field returns 422."""
        payload = {
            "session_id": _random_session_id(),
            "pipeline_id": str(uuid.uuid4()),
        }
        response = await configured_app.post("/internal/streaming/sessions", json=payload)
        assert response.status_code == 422
        errors = response.json()["detail"]
        field_names = [e["loc"][-1] for e in errors]
        assert "tenant_id" in field_names

    async def test_create_session_missing_pipeline_id_returns_422(self, configured_app):
        """Missing ``pipeline_id`` field returns 422."""
        payload = {
            "session_id": _random_session_id(),
            "tenant_id": "t-test",
        }
        response = await configured_app.post("/internal/streaming/sessions", json=payload)
        assert response.status_code == 422
        errors = response.json()["detail"]
        field_names = [e["loc"][-1] for e in errors]
        assert "pipeline_id" in field_names

    async def test_create_session_invalid_json_returns_422(self, configured_app):
        """Non-JSON body should return 422."""
        response = await configured_app.post(
            "/internal/streaming/sessions",
            content=b"this is not json",
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422

    async def test_create_session_wrong_type_sample_rate_returns_422(self, configured_app):
        """String where int is expected (sample_rate) should return 422."""
        payload = {
            "session_id": _random_session_id(),
            "tenant_id": "t-test",
            "pipeline_id": str(uuid.uuid4()),
            "sample_rate": "not-a-number",
        }
        response = await configured_app.post("/internal/streaming/sessions", json=payload)
        assert response.status_code == 422

    async def test_create_session_extra_unknown_fields_accepted(self, configured_app):
        """Extra fields should be silently ignored (Pydantic default).

        This is important: the API Gateway may evolve and send new fields.
        The STT service should not reject them.
        """
        payload = _build_create_payload()
        payload["unknown_future_field"] = "some_value"
        response = await configured_app.post("/internal/streaming/sessions", json=payload)
        # Should still reach the handler (503, not 422)
        assert response.status_code == 503


# =========================================================================
# Task D3: Get Session — 503/404 scenarios
# =========================================================================


@pytest.mark.e2e
class TestGetStreamingSessionNotInitializedE2E:
    """Tests for ``GET /internal/streaming/sessions/{session_id}`` when not initialized."""

    async def test_get_session_503_when_not_initialized(self, configured_app):
        """Getting a session when streaming not initialized returns 503."""
        fake_id = _random_session_id()
        response = await configured_app.get(f"/internal/streaming/sessions/{fake_id}")
        assert response.status_code == 503
        assert "not initialized" in response.json()["detail"].lower()

    async def test_get_session_503_body_structure(self, configured_app):
        """503 response should have a ``detail`` key with a string value."""
        fake_id = _random_session_id()
        response = await configured_app.get(f"/internal/streaming/sessions/{fake_id}")
        assert response.status_code == 503
        body = response.json()
        assert "detail" in body
        assert isinstance(body["detail"], str)

    async def test_get_session_returns_json_content_type(self, configured_app):
        """Even 503 responses should have JSON content-type."""
        fake_id = _random_session_id()
        response = await configured_app.get(f"/internal/streaming/sessions/{fake_id}")
        assert "application/json" in response.headers.get("content-type", "")

    async def test_get_session_with_random_uuid(self, configured_app):
        """Even with a valid UUID format, returns 503 when not initialized."""
        for _ in range(3):
            fake_id = _random_session_id()
            response = await configured_app.get(f"/internal/streaming/sessions/{fake_id}")
            assert response.status_code == 503

    async def test_get_session_special_chars_in_id(self, configured_app):
        """Special characters in session_id should not cause 500.

        The session_id is a path parameter — ensure the route handles
        URL-encoded or unusual characters gracefully.
        """
        weird_ids = [
            "not-a-uuid",
            "session%2Fwith%2Fslashes",
            "",  # empty — may match a different route
        ]
        for sid in weird_ids:
            if not sid:
                continue  # skip empty — path doesn't match
            response = await configured_app.get(f"/internal/streaming/sessions/{sid}")
            # Should be 503 (not initialized) — never 500
            assert response.status_code in (
                503,
                404,
                422,
            ), f"Unexpected {response.status_code} for session_id={sid!r}"


# =========================================================================
# Task D4: Delete Session — 503/404 scenarios
# =========================================================================


@pytest.mark.e2e
class TestDeleteStreamingSessionNotInitializedE2E:
    """Tests for ``DELETE /internal/streaming/sessions/{session_id}`` when not initialized."""

    async def test_delete_session_503_when_not_initialized(self, configured_app):
        """Deleting a session when streaming not initialized returns 503."""
        fake_id = _random_session_id()
        response = await configured_app.delete(f"/internal/streaming/sessions/{fake_id}")
        assert response.status_code == 503
        assert "not initialized" in response.json()["detail"].lower()

    async def test_delete_session_503_body_structure(self, configured_app):
        """503 response should have a ``detail`` key."""
        fake_id = _random_session_id()
        response = await configured_app.delete(f"/internal/streaming/sessions/{fake_id}")
        assert response.status_code == 503
        body = response.json()
        assert "detail" in body

    async def test_delete_session_503_consistent(self, configured_app):
        """Multiple deletes should all return 503 consistently."""
        for _ in range(3):
            fake_id = _random_session_id()
            response = await configured_app.delete(f"/internal/streaming/sessions/{fake_id}")
            assert response.status_code == 503

    async def test_delete_wrong_method_put_returns_405(self, configured_app):
        """PUT to the sessions/{id} endpoint should return 405."""
        fake_id = _random_session_id()
        response = await configured_app.put(
            f"/internal/streaming/sessions/{fake_id}",
            json={},
        )
        assert response.status_code == 405


# =========================================================================
# Task D5: Session Lifecycle — streaming initialized (mocked manager)
# =========================================================================


@pytest.mark.e2e
class TestStreamingAvailabilityInitializedE2E:
    """Tests for availability when streaming IS initialized."""

    async def test_availability_shows_ready(self, streaming_initialized_app):
        """When streaming is initialized, status should be 'ready'."""
        response = await streaming_initialized_app.get("/internal/streaming/availability")
        assert response.status_code == 200
        data = response.json()
        assert data["available"] is True
        assert data["status"] == "ready"
        assert data["max_concurrent"] == 10
        assert data["current_active"] == 0
        assert data["available_slots"] == 10

    async def test_availability_schema_when_initialized(self, streaming_initialized_app):
        """Validate full schema with Pydantic when initialized."""
        response = await streaming_initialized_app.get("/internal/streaming/availability")
        data = response.json()
        parsed = StreamingAvailabilityResponse.model_validate(data)
        assert parsed.available is True
        assert parsed.max_concurrent > 0
        assert parsed.available_slots > 0


@pytest.mark.e2e
class TestCreateStreamingSessionInitializedE2E:
    """Tests for creating sessions when streaming IS initialized."""

    async def test_create_session_returns_201(self, streaming_initialized_app):
        """Successful session creation returns 201."""
        payload = _build_create_payload()
        response = await streaming_initialized_app.post(
            "/internal/streaming/sessions", json=payload
        )
        assert response.status_code == 201

    async def test_create_session_response_schema(self, streaming_initialized_app):
        """Validate full response schema with Pydantic.

        Checks that every field in ``StreamingSessionResponse`` is present
        and correctly typed — including the ``reason`` field which should
        be ``None`` for successful creates.
        """
        session_id = _random_session_id()
        payload = _build_create_payload(session_id=session_id)
        response = await streaming_initialized_app.post(
            "/internal/streaming/sessions", json=payload
        )
        assert response.status_code == 201
        data = response.json()

        parsed = StreamingSessionResponse.model_validate(data)
        assert parsed.session_id == session_id
        assert parsed.status == "active"
        assert parsed.reason is None  # no rejection
        assert parsed.max_concurrent == 10
        assert parsed.current_active >= 1

    async def test_create_session_with_all_optional_fields(self, streaming_initialized_app):
        """Session creation with every optional field populated."""
        payload = _build_create_payload(
            consultation_id="c-test-123",
            microphone_id="mic-usb-01",
        )
        response = await streaming_initialized_app.post(
            "/internal/streaming/sessions", json=payload
        )
        assert response.status_code == 201
        assert response.json()["status"] == "active"

    async def test_create_session_with_custom_sample_rate(self, streaming_initialized_app):
        """Session with non-default sample rate (8kHz telephony)."""
        payload = _build_create_payload(sample_rate=8000)
        response = await streaming_initialized_app.post(
            "/internal/streaming/sessions", json=payload
        )
        assert response.status_code == 201

    async def test_create_duplicate_session_id_is_idempotent(self, streaming_initialized_app):
        """Creating the same session_id twice should succeed (CapacityGuard is idempotent).

        This matches the real CapacityGuard.try_acquire behavior: an
        already-admitted session_id returns True without incrementing
        the active count.
        """
        session_id = _random_session_id()
        payload = _build_create_payload(session_id=session_id)

        resp1 = await streaming_initialized_app.post("/internal/streaming/sessions", json=payload)
        assert resp1.status_code == 201

        resp2 = await streaming_initialized_app.post("/internal/streaming/sessions", json=payload)
        assert resp2.status_code == 201
        assert resp2.json()["session_id"] == session_id

    async def test_create_session_returns_json_content_type(self, streaming_initialized_app):
        """201 response should have JSON content-type."""
        payload = _build_create_payload()
        response = await streaming_initialized_app.post(
            "/internal/streaming/sessions", json=payload
        )
        assert response.status_code == 201
        assert "application/json" in response.headers.get("content-type", "")


@pytest.mark.e2e
class TestGetStreamingSessionInitializedE2E:
    """Tests for getting sessions when streaming IS initialized."""

    async def test_get_existing_session_returns_200(self, streaming_initialized_app):
        """Getting an existing session returns 200 with correct data."""
        session_id = _random_session_id()
        payload = _build_create_payload(session_id=session_id)
        create_resp = await streaming_initialized_app.post(
            "/internal/streaming/sessions", json=payload
        )
        assert create_resp.status_code == 201

        response = await streaming_initialized_app.get(f"/internal/streaming/sessions/{session_id}")
        assert response.status_code == 200
        data = response.json()
        assert data["session_id"] == session_id
        assert data["status"] == "active"

    async def test_get_nonexistent_session_returns_404(self, streaming_initialized_app):
        """Getting a non-existent session returns 404 with descriptive detail."""
        fake_id = _random_session_id()
        response = await streaming_initialized_app.get(f"/internal/streaming/sessions/{fake_id}")
        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    async def test_get_session_response_schema(self, streaming_initialized_app):
        """Validate response schema with Pydantic for existing session."""
        session_id = _random_session_id()
        payload = _build_create_payload(session_id=session_id)
        await streaming_initialized_app.post("/internal/streaming/sessions", json=payload)

        response = await streaming_initialized_app.get(f"/internal/streaming/sessions/{session_id}")
        assert response.status_code == 200
        parsed = StreamingSessionResponse.model_validate(response.json())
        assert parsed.session_id == session_id
        assert parsed.status == "active"
        assert parsed.reason is None
        assert parsed.max_concurrent > 0
        assert isinstance(parsed.current_active, int)

    async def test_get_session_returns_json_content_type(self, streaming_initialized_app):
        """GET response should have JSON content-type."""
        session_id = _random_session_id()
        payload = _build_create_payload(session_id=session_id)
        await streaming_initialized_app.post("/internal/streaming/sessions", json=payload)

        response = await streaming_initialized_app.get(f"/internal/streaming/sessions/{session_id}")
        assert "application/json" in response.headers.get("content-type", "")

    async def test_get_deleted_session_returns_404(self, streaming_initialized_app):
        """After deleting a session, GET should return 404."""
        session_id = _random_session_id()
        payload = _build_create_payload(session_id=session_id)
        await streaming_initialized_app.post("/internal/streaming/sessions", json=payload)
        await streaming_initialized_app.delete(f"/internal/streaming/sessions/{session_id}")

        response = await streaming_initialized_app.get(f"/internal/streaming/sessions/{session_id}")
        assert response.status_code == 404


@pytest.mark.e2e
class TestDeleteStreamingSessionInitializedE2E:
    """Tests for deleting sessions when streaming IS initialized."""

    async def test_delete_existing_session_returns_204(self, streaming_initialized_app):
        """Deleting an existing session returns 204 with no body."""
        session_id = _random_session_id()
        payload = _build_create_payload(session_id=session_id)
        await streaming_initialized_app.post("/internal/streaming/sessions", json=payload)

        response = await streaming_initialized_app.delete(
            f"/internal/streaming/sessions/{session_id}"
        )
        assert response.status_code == 204
        assert response.content == b""

    async def test_delete_nonexistent_session_is_idempotent(self, streaming_initialized_app):
        """Deleting a non-existent session returns 204 (idempotent DELETE)."""
        fake_id = _random_session_id()
        response = await streaming_initialized_app.delete(f"/internal/streaming/sessions/{fake_id}")
        assert response.status_code == 204
        assert response.content == b""

    async def test_delete_already_deleted_session_is_idempotent(self, streaming_initialized_app):
        """Deleting the same session twice returns 204 both times (idempotent)."""
        session_id = _random_session_id()
        payload = _build_create_payload(session_id=session_id)
        await streaming_initialized_app.post("/internal/streaming/sessions", json=payload)

        resp1 = await streaming_initialized_app.delete(f"/internal/streaming/sessions/{session_id}")
        assert resp1.status_code == 204

        resp2 = await streaming_initialized_app.delete(f"/internal/streaming/sessions/{session_id}")
        assert resp2.status_code == 204
        assert resp2.content == b""


@pytest.mark.e2e
class TestStreamingSessionFullLifecycleE2E:
    """Full session lifecycle: create → get → delete → verify deleted."""

    async def test_full_lifecycle(self, streaming_initialized_app):
        """Create, query, and delete a streaming session end-to-end."""
        client = streaming_initialized_app
        session_id = _random_session_id()

        # 1. Create
        payload = _build_create_payload(session_id=session_id)
        create_resp = await client.post("/internal/streaming/sessions", json=payload)
        assert create_resp.status_code == 201
        create_data = create_resp.json()
        assert create_data["session_id"] == session_id
        assert create_data["status"] == "active"
        assert create_data["reason"] is None
        assert create_data["max_concurrent"] == 10
        assert create_data["current_active"] >= 1

        # 2. Get — session should be active
        get_resp = await client.get(f"/internal/streaming/sessions/{session_id}")
        assert get_resp.status_code == 200
        get_data = get_resp.json()
        assert get_data["session_id"] == session_id
        assert get_data["status"] == "active"

        # 3. Availability — should still have slots
        avail_resp = await client.get("/internal/streaming/availability")
        assert avail_resp.status_code == 200
        avail_data = avail_resp.json()
        assert avail_data["available"] is True
        assert avail_data["current_active"] >= 1
        assert avail_data["available_slots"] >= 1

        # 4. Delete
        del_resp = await client.delete(f"/internal/streaming/sessions/{session_id}")
        assert del_resp.status_code == 204
        assert del_resp.content == b""

        # 5. Verify deleted — should be 404
        get_after = await client.get(f"/internal/streaming/sessions/{session_id}")
        assert get_after.status_code == 404

    async def test_multiple_sessions_lifecycle(self, streaming_initialized_app):
        """Create multiple sessions, verify availability, delete all."""
        client = streaming_initialized_app

        session_ids = [_random_session_id() for _ in range(3)]

        # Create 3 sessions
        for sid in session_ids:
            payload = _build_create_payload(session_id=sid)
            resp = await client.post("/internal/streaming/sessions", json=payload)
            assert resp.status_code == 201

        # Verify availability reflects 3 active
        avail = await client.get("/internal/streaming/availability")
        avail_data = avail.json()
        assert avail_data["current_active"] >= 3
        assert avail_data["available_slots"] <= 7  # 10 max - 3 active

        # Get each session — all should be active
        for sid in session_ids:
            resp = await client.get(f"/internal/streaming/sessions/{sid}")
            assert resp.status_code == 200
            assert resp.json()["status"] == "active"

        # Delete all sessions
        for sid in session_ids:
            resp = await client.delete(f"/internal/streaming/sessions/{sid}")
            assert resp.status_code == 204

        # Verify all deleted
        for sid in session_ids:
            resp = await client.get(f"/internal/streaming/sessions/{sid}")
            assert resp.status_code == 404

        # Availability should be back to full capacity
        avail_after = await client.get("/internal/streaming/availability")
        avail_after_data = avail_after.json()
        assert avail_after_data["available_slots"] == 10
        assert avail_after_data["current_active"] == 0

    async def test_availability_reflects_capacity_changes(self, streaming_initialized_app):
        """Available slots decrease as sessions are created, increase as deleted."""
        client = streaming_initialized_app

        # Initial state
        avail_before = await client.get("/internal/streaming/availability")
        slots_before = avail_before.json()["available_slots"]

        # Create a session
        session_id = _random_session_id()
        payload = _build_create_payload(session_id=session_id)
        await client.post("/internal/streaming/sessions", json=payload)

        # Slots should decrease by exactly 1
        avail_during = await client.get("/internal/streaming/availability")
        slots_during = avail_during.json()["available_slots"]
        assert slots_during == slots_before - 1

        # Delete the session
        await client.delete(f"/internal/streaming/sessions/{session_id}")

        # Slots should return to original
        avail_after = await client.get("/internal/streaming/availability")
        slots_after = avail_after.json()["available_slots"]
        assert slots_after == slots_before


@pytest.mark.e2e
class TestStreamingSessionAtCapacityE2E:
    """Tests for capacity-exceeded scenarios.

    Uses a dedicated fixture with max_streams=2 so we can hit the
    capacity limit without creating 10 sessions.
    """

    @pytest.fixture
    async def small_capacity_app(self, configured_app):
        """App with streaming initialized at capacity of 2 sessions max."""
        mock_mgr, _, _ = _make_mock_session_manager(max_streams=2)

        with patch(
            "stt_v2.streaming.api.routes.get_session_manager",
            return_value=mock_mgr,
        ):
            yield configured_app

    async def test_at_capacity_returns_503(self, small_capacity_app):
        """When all slots are taken, new sessions get 503."""
        client = small_capacity_app

        # Fill capacity (2 slots)
        ids = []
        for _ in range(2):
            sid = _random_session_id()
            payload = _build_create_payload(session_id=sid)
            resp = await client.post("/internal/streaming/sessions", json=payload)
            assert resp.status_code == 201
            ids.append(sid)

        # Third session should be rejected
        payload = _build_create_payload()
        resp = await client.post("/internal/streaming/sessions", json=payload)
        assert resp.status_code == 503
        assert "capacity" in resp.json()["detail"].lower()

    async def test_at_capacity_availability_shows_at_capacity(self, small_capacity_app):
        """When at capacity, availability endpoint should report correctly."""
        client = small_capacity_app

        # Fill capacity
        for _ in range(2):
            payload = _build_create_payload()
            await client.post("/internal/streaming/sessions", json=payload)

        # Availability should show at_capacity
        avail = await client.get("/internal/streaming/availability")
        avail_data = avail.json()
        assert avail_data["available"] is False
        assert avail_data["status"] == "at_capacity"
        assert avail_data["available_slots"] == 0
        assert avail_data["max_concurrent"] == 2
        assert avail_data["current_active"] == 2

    async def test_capacity_freed_after_delete(self, small_capacity_app):
        """After deleting a session, capacity opens for a new one."""
        client = small_capacity_app

        # Fill capacity
        ids = []
        for _ in range(2):
            sid = _random_session_id()
            payload = _build_create_payload(session_id=sid)
            await client.post("/internal/streaming/sessions", json=payload)
            ids.append(sid)

        # At capacity — cannot create
        resp = await client.post(
            "/internal/streaming/sessions",
            json=_build_create_payload(),
        )
        assert resp.status_code == 503

        # Delete one session
        await client.delete(f"/internal/streaming/sessions/{ids[0]}")

        # Now can create again
        resp = await client.post(
            "/internal/streaming/sessions",
            json=_build_create_payload(),
        )
        assert resp.status_code == 201

        # Availability should show 1 slot available
        avail = await client.get("/internal/streaming/availability")
        assert avail.json()["available_slots"] == 0  # 2 filled again

    async def test_at_capacity_includes_retry_after_header(self, small_capacity_app):
        """503 at capacity should include Retry-After header.

        The route handler sets ``headers={"Retry-After": "5"}`` when
        ``create_session`` returns None. This is important for the API
        Gateway's retry logic.
        """
        client = small_capacity_app

        # Fill capacity
        for _ in range(2):
            payload = _build_create_payload()
            await client.post("/internal/streaming/sessions", json=payload)

        # Third should get 503 with Retry-After
        resp = await client.post(
            "/internal/streaming/sessions",
            json=_build_create_payload(),
        )
        assert resp.status_code == 503
        # httpx normalizes header names to lowercase
        retry_after = resp.headers.get("retry-after")
        assert retry_after is not None, "Missing Retry-After header on 503"
        assert retry_after == "5"

    async def test_at_capacity_error_body_structure(self, small_capacity_app):
        """At-capacity 503 should have proper error body, not not-initialized."""
        client = small_capacity_app

        # Fill capacity
        for _ in range(2):
            payload = _build_create_payload()
            await client.post("/internal/streaming/sessions", json=payload)

        # 503 should say "capacity", not "not initialized"
        resp = await client.post(
            "/internal/streaming/sessions",
            json=_build_create_payload(),
        )
        assert resp.status_code == 503
        detail = resp.json()["detail"].lower()
        assert "capacity" in detail
        assert "not initialized" not in detail
