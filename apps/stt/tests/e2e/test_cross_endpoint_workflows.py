"""
Cross-endpoint workflow E2E tests (Track E).

These tests simulate realistic API Gateway usage patterns where multiple
endpoints are called in sequence — here, the streaming session lifecycle.

TASK-1006 — the transcription, cache-interaction and concurrent-transcription
workflows drove the removed ``POST /api/v1/transcribe`` route (a DB-seeded
pipeline selected by ``pipeline_id``) and were deleted with it. Batch
transcription is reached through the gateway's agent path and the Dramatiq
worker, which ``test_real_data_transcription.py`` exercises.

Anti-pattern prevention
~~~~~~~~~~~~~~~~~~~~~~~
* **No mocks** — all tests hit the real FastAPI app + real infrastructure.
* **No silent pass-throughs** — every test asserts on *all* paths; ``if``
  guards are replaced by explicit ``pytest.skip`` or unconditional asserts.

Prerequisites
~~~~~~~~~~~~~
* testcontainers (Redis, MinIO)
* ``conda activate arcaenv``

Run
~~~
.. code-block:: bash

   TEST_PLATFORM=all pytest tests/e2e/test_cross_endpoint_workflows.py -v -s
"""

from __future__ import annotations

import uuid
from datetime import datetime

import pytest

from stt.streaming.api.schemas import (
    StreamingAvailabilityResponse,
    StreamingSessionResponse,
)
from tests.helpers.resolved_spec import resolved_spec

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _validate_iso8601_timestamp(ts: str) -> None:
    """Assert that ``ts`` is a valid ISO 8601 datetime string."""
    try:
        datetime.fromisoformat(ts)
    except (ValueError, TypeError) as exc:
        raise AssertionError(f"Invalid ISO 8601 timestamp: {ts!r}") from exc


# ============================================================================
# Streaming session lifecycle
# ============================================================================


@pytest.mark.e2e
class TestGatewayStreamingWorkflowE2E:
    """Simulates the API Gateway's streaming session lifecycle.

    The gateway:
      1. ``GET /internal/streaming/availability`` — is streaming ready?
      2. ``POST /internal/streaming/sessions`` — create a session
      3. ``GET /internal/streaming/sessions/{id}`` — poll session status
      4. ``DELETE /internal/streaming/sessions/{id}`` — cleanup
    """

    async def test_full_session_lifecycle(self, configured_app):
        """Availability → create → get → delete → verify-404.

        Skips cleanly when streaming is not initialized.
        """

        # Step 1: Check availability (validate full Pydantic schema)
        avail = await configured_app.get("/internal/streaming/availability")
        assert avail.status_code == 200
        avail_model = StreamingAvailabilityResponse.model_validate(avail.json())
        assert avail_model.status in ("ready", "not_initialized", "at_capacity")

        # Numeric invariant: slots + active == max
        if avail_model.status != "not_initialized":
            assert (
                avail_model.current_active + avail_model.available_slots
                == avail_model.max_concurrent
            ), (
                f"Invariant violated: {avail_model.current_active} + "
                f"{avail_model.available_slots} != {avail_model.max_concurrent}"
            )

        if not avail_model.available:
            pytest.skip("Streaming not available — skipping full lifecycle test")

        # Step 2: Create session (validate full response schema)
        session_id = str(uuid.uuid4())
        create_payload = {
            "session_id": session_id,
            "tenant_id": "t-test",
            "resolved_spec": resolved_spec(),
            "sample_rate": 16000,
        }
        create = await configured_app.post("/internal/streaming/sessions", json=create_payload)
        assert create.status_code == 201
        create_model = StreamingSessionResponse.model_validate(create.json())
        assert create_model.session_id == session_id
        assert create_model.status == "active"
        assert create_model.max_concurrent > 0
        assert create_model.current_active >= 1  # we just created one

        # Step 3: Poll status
        status = await configured_app.get(f"/internal/streaming/sessions/{session_id}")
        assert status.status_code == 200
        status_model = StreamingSessionResponse.model_validate(status.json())
        assert status_model.session_id == session_id
        assert status_model.status == "active"

        # Step 4: Cleanup
        delete = await configured_app.delete(f"/internal/streaming/sessions/{session_id}")
        assert delete.status_code == 204

        # Step 5: Verify deleted — must be 404 now
        after = await configured_app.get(f"/internal/streaming/sessions/{session_id}")
        assert after.status_code == 404

    async def test_double_delete_returns_404(self, configured_app):
        """Deleting an already-deleted session must return 404, not 500.

        Edge case: API Gateway retries a DELETE due to network timeout.
        """
        avail = await configured_app.get("/internal/streaming/availability")
        avail_data = avail.json()

        if not avail_data.get("available", False):
            pytest.skip("Streaming not available")

        # Create then delete a session
        session_id = str(uuid.uuid4())
        await configured_app.post(
            "/internal/streaming/sessions",
            json={
                "session_id": session_id,
                "tenant_id": "t-test",
                "resolved_spec": resolved_spec(),
                "sample_rate": 16000,
            },
        )
        first_delete = await configured_app.delete(f"/internal/streaming/sessions/{session_id}")
        assert first_delete.status_code == 204

        # Second delete — must be 404, not 500 or 204
        second_delete = await configured_app.delete(f"/internal/streaming/sessions/{session_id}")
        assert second_delete.status_code == 404

    async def test_availability_when_not_initialized_is_deterministic(self, configured_app):
        """When streaming is not initialized, response is fully deterministic.

        No silent pass-through: we assert on the *actual* state, not skip.
        """
        avail = await configured_app.get("/internal/streaming/availability")
        assert avail.status_code == 200
        avail_model = StreamingAvailabilityResponse.model_validate(avail.json())

        if avail_model.status == "not_initialized":
            # Every field must have the "not initialized" sentinel values
            assert avail_model.available is False
            assert avail_model.max_concurrent == 0
            assert avail_model.current_active == 0
            assert avail_model.available_slots == 0
        else:
            # If initialized, the numeric invariant must hold
            assert avail_model.available or avail_model.status == "at_capacity"
            assert avail_model.max_concurrent > 0

    async def test_create_session_returns_503_when_not_initialized(self, configured_app):
        """Creating a session when streaming is off must return exactly 503.

        FIX for anti-pattern #5: the old test had `if status == 503:` which
        silently passed when streaming was accidentally initialized.
        """
        avail = await configured_app.get("/internal/streaming/availability")
        avail_data = avail.json()

        if avail_data["status"] != "not_initialized":
            pytest.skip("Streaming IS initialized — cannot test 503 path")

        # With streaming not initialized, create MUST return 503
        payload = {
            "session_id": str(uuid.uuid4()),
            "tenant_id": "t-test",
            "resolved_spec": resolved_spec(),
            "sample_rate": 16000,
        }
        response = await configured_app.post("/internal/streaming/sessions", json=payload)
        assert (
            response.status_code == 503
        ), f"Expected 503 when streaming not initialized, got {response.status_code}"
        detail = response.json().get("detail", "")
        assert (
            "not initialized" in detail.lower()
        ), f"Expected 'not initialized' in detail, got: {detail!r}"

    async def test_get_nonexistent_session_returns_503_or_404(self, configured_app):
        """GET on a random session ID must be 404 (initialized) or 503 (not)."""
        fake_id = str(uuid.uuid4())
        response = await configured_app.get(f"/internal/streaming/sessions/{fake_id}")

        avail = await configured_app.get("/internal/streaming/availability")
        streaming_status = avail.json()["status"]

        if streaming_status == "not_initialized":
            assert response.status_code == 503
        else:
            assert response.status_code == 404
            assert "not found" in response.json()["detail"].lower()

    async def test_streaming_status_consistent_with_availability(self, configured_app):
        """``/internal/streaming/status`` and ``/internal/streaming/availability``
        must agree on whether streaming is initialized."""

        status_resp = await configured_app.get("/internal/streaming/status")
        assert status_resp.status_code == 200
        status_data = status_resp.json()
        assert status_data["status"] in ("running", "not_initialized")
        _validate_iso8601_timestamp(status_data["timestamp"])

        avail_resp = await configured_app.get("/internal/streaming/availability")
        assert avail_resp.status_code == 200
        avail_data = avail_resp.json()

        # Consistency: both endpoints must agree on initialization state
        if status_data["status"] == "not_initialized":
            assert (
                avail_data["status"] == "not_initialized"
            ), f"Status says not_initialized but availability says {avail_data['status']}"
            assert "message" in status_data  # production sets message field
        else:
            assert avail_data["status"] in (
                "ready",
                "at_capacity",
            ), f"Status says running but availability says {avail_data['status']}"

    async def test_create_session_request_validation_422(self, configured_app):
        """Missing required fields must return 422, not 500.

        Ensures FastAPI's Pydantic validation layer is active on this route.
        """
        response = await configured_app.post("/internal/streaming/sessions", json={})
        assert response.status_code == 422
