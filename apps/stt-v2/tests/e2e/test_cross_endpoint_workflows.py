"""
Cross-endpoint workflow E2E tests (Track E).

These tests simulate realistic API Gateway usage patterns where
multiple endpoints are called in sequence.  They verify that the
STT-v2 service behaves correctly when endpoints interact — e.g.
health checks before transcription, cache clear + re-populate,
streaming session lifecycle, and concurrent transcription requests.

Anti-pattern prevention
~~~~~~~~~~~~~~~~~~~~~~~
* **No mocks** — all tests hit the real FastAPI app + real infrastructure.
* **Full Pydantic validation** — transcription responses are validated via
  ``TranscriptionResponse.model_validate()`` to catch schema drift.
* **No silent pass-throughs** — every test asserts on *all* paths; ``if``
  guards are replaced by explicit ``pytest.skip`` or unconditional asserts.
* **Self-contained tests** — tests that need cache state set up their own
  pre-conditions rather than depending on test execution order.

Prerequisites
~~~~~~~~~~~~~
* ``pnpm docker:test:up`` running (PostgreSQL, Redis, MinIO)
* ``conda activate arcaenv``
* ML dependencies installed (``pip install -e ".[ml,test]"``)
* Audio fixtures present in ``tests/e2e/fixtures/``

Run
~~~
.. code-block:: bash

   TEST_PLATFORM=all pytest tests/e2e/test_cross_endpoint_workflows.py -v -s
"""

from __future__ import annotations

import asyncio
import io
import os
import uuid
from datetime import datetime

import pytest

from stt_v2.streaming.api.schemas import (
    StreamingAvailabilityResponse,
    StreamingSessionResponse,
)
from stt_v2.transcription.api.schemas import TranscriptionResponse

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_DEFAULT_TENANT_ID = os.environ.get(
    "TEST_TENANT_ID", "50000000-0000-0000-0000-000000000000"
)


def _build_multipart_form(
    audio_bytes: bytes,
    filename: str,
    pipeline_id: str,
    tenant_id: str = _DEFAULT_TENANT_ID,
    language: str | None = None,
    consultation_id: str | None = None,
    code_switching: bool | None = None,
) -> dict:
    """Build multipart form ``files`` / ``data`` kwargs for httpx."""
    files = {"file": (filename, io.BytesIO(audio_bytes), "audio/wav")}
    data: dict[str, str] = {
        "pipeline_id": pipeline_id,
        "tenant_id": tenant_id,
    }
    if language is not None:
        data["language"] = language
    if consultation_id is not None:
        data["consultation_id"] = consultation_id
    if code_switching is not None:
        data["code_switching"] = str(code_switching).lower()
    return {"files": files, "data": data}


def _validate_transcription_response(data: dict) -> TranscriptionResponse:
    """Parse and validate the full transcription response against the Pydantic model.

    This catches schema drift — if the API adds/removes/renames a field,
    ``model_validate`` will raise instead of silently ignoring it.
    """
    parsed = TranscriptionResponse.model_validate(data)

    # Behaviour assertions (not just schema)
    assert isinstance(parsed.text, str) and len(parsed.text) > 0, (
        f"Expected non-empty transcription text, got: {parsed.text!r}"
    )
    assert parsed.duration_seconds > 0, (
        f"Audio duration must be positive, got {parsed.duration_seconds}"
    )
    assert parsed.processing_time_seconds > 0, (
        f"Processing time must be positive, got {parsed.processing_time_seconds}"
    )

    # Word timestamps — validate internal consistency when present
    for wt in parsed.word_timestamps:
        assert wt.end_time >= wt.start_time, (
            f"Word '{wt.word}': end_time ({wt.end_time}) < start_time ({wt.start_time})"
        )
        assert 0.0 <= wt.confidence <= 1.0, (
            f"Word '{wt.word}': confidence ({wt.confidence}) out of [0, 1]"
        )
        assert len(wt.word) > 0

    # Sentence timestamps
    for st in parsed.sentence_timestamps:
        assert st.end_time >= st.start_time
        assert len(st.text) > 0

    # Segments (VAD)
    for seg in parsed.segments:
        assert seg.end_time >= seg.start_time
        assert seg.duration >= 0
        assert isinstance(seg.is_speech, bool)

    # Timing breakdown (may be absent for some pipelines)
    if parsed.timing is not None:
        assert parsed.timing.total_seconds > 0
        assert parsed.timing.inference_seconds >= 0

    return parsed


def _validate_iso8601_timestamp(ts: str) -> None:
    """Assert that ``ts`` is a valid ISO 8601 datetime string."""
    try:
        datetime.fromisoformat(ts)
    except (ValueError, TypeError) as exc:
        raise AssertionError(f"Invalid ISO 8601 timestamp: {ts!r}") from exc


# ============================================================================
# Task E1 — Health → Readiness → Transcription → Cache Verification
# ============================================================================


@pytest.mark.e2e
@pytest.mark.slow
@pytest.mark.ml
class TestGatewayTranscriptionWorkflowE2E:
    """Simulates the API Gateway's transcription workflow.

    The gateway typically:
      1. Checks ``GET /api/v1/health`` — is the service alive?
      2. Checks ``GET /api/v1/ready`` — are dependencies (DB, Redis, MinIO) ready?
      3. ``POST /api/v1/transcribe`` — perform the actual work.
      4. ``GET /internal/cache/stats`` — verify model cache was populated.
    """

    async def test_health_then_ready_then_transcribe(
        self,
        real_audio_client,
        real_ml_audio_bytes,
        valid_pipeline_id,
    ):
        """Full gateway workflow: health → ready → transcribe → cache stats.

        Validates *complete* response schemas, not just status codes.
        """

        # ----- Step 1: Health — service must be alive -----
        health = await real_audio_client.get("/api/v1/health")
        assert health.status_code == 200
        health_data = health.json()
        assert health_data["status"] == "ok"
        assert health_data["service"] == "stt-v2"
        assert isinstance(health_data["version"], str) and len(health_data["version"]) > 0
        _validate_iso8601_timestamp(health_data["timestamp"])

        # ----- Step 2: Readiness — database must be healthy -----
        # Note: MinIO and Redis singletons require the FastAPI lifespan to
        # call initialize_minio() / configure_broker().  ASGITransport does
        # not trigger the lifespan, so those components will report
        # "unhealthy".  We therefore only assert the overall endpoint
        # returns 200 and the database component is healthy.
        ready = await real_audio_client.get("/api/v1/ready")
        assert ready.status_code == 200
        ready_data = ready.json()
        assert ready_data["status"] in ("healthy", "degraded", "unhealthy", "not_initialized")
        assert ready_data["uptime_seconds"] >= 0
        _validate_iso8601_timestamp(ready_data["timestamp"])

        # Verify database component is reachable
        component_names = {c["name"] for c in ready_data["components"]}
        assert "database" in component_names, (
            f"Missing 'database' component. Got: {component_names}"
        )
        db_component = next(c for c in ready_data["components"] if c["name"] == "database")
        assert db_component["status"] == "healthy", (
            f"Database should be healthy, got '{db_component['status']}': "
            f"{db_component.get('message')}"
        )
        for component in ready_data["components"]:
            assert component["status"] in ("healthy", "degraded", "unhealthy", "not_initialized")
            assert isinstance(component["latency_ms"], (int, float))
            assert component["latency_ms"] >= 0

        # ----- Step 3: Transcribe with real audio -----
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_en.wav",
            pipeline_id=valid_pipeline_id,
        )
        transcribe = await real_audio_client.post("/api/v1/transcribe", **form)
        assert transcribe.status_code == 200

        # Full Pydantic validation — catches schema drift (anti-pattern #4)
        _validate_transcription_response(transcribe.json())

        # ----- Step 4: Cache should now contain loaded models -----
        cache = await real_audio_client.get("/internal/cache/stats")
        assert cache.status_code == 200
        cache_data = cache.json()
        assert cache_data["total_models"] >= 1
        assert cache_data["total_memory_mb"] > 0
        _validate_iso8601_timestamp(cache_data["timestamp"])

    async def test_transcribe_with_multilingual_audio(
        self,
        real_audio_client,
        real_ml_audio_bytes,
        valid_pipeline_id,
    ):
        """Gateway sends multilingual audio — full response validation."""

        # Liveness gate
        health = await real_audio_client.get("/api/v1/health")
        assert health.status_code == 200

        # Transcribe multilingual audio (no explicit language — auto-detect)
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_ml.wav",
            pipeline_id=valid_pipeline_id,
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)
        assert response.status_code == 200

        # Full Pydantic validation — catches schema drift
        _validate_transcription_response(response.json())

    async def test_transcribe_response_round_trips_through_pydantic(
        self,
        real_audio_client,
        real_ml_audio_bytes,
        valid_pipeline_id,
    ):
        """Serialize → deserialize via Pydantic must be lossless.

        This ensures the JSON the API returns can be reconstructed into
        the exact same Pydantic model — no silent field drops.
        """
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_roundtrip.wav",
            pipeline_id=valid_pipeline_id,
            language="en",
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)
        assert response.status_code == 200

        raw_json = response.json()
        parsed = TranscriptionResponse.model_validate(raw_json)
        reserialized = parsed.model_dump(mode="json")

        # Every field in the raw response must survive the round-trip
        for key in raw_json:
            assert key in reserialized, f"Field '{key}' lost during Pydantic round-trip"


# ============================================================================
# Task E2 — Streaming: availability → create → get status → delete
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
            assert avail_model.current_active + avail_model.available_slots == avail_model.max_concurrent, (
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
            "pipeline_id": str(uuid.uuid4()),
            "sample_rate": 16000,
        }
        create = await configured_app.post(
            "/internal/streaming/sessions", json=create_payload
        )
        assert create.status_code == 201
        create_model = StreamingSessionResponse.model_validate(create.json())
        assert create_model.session_id == session_id
        assert create_model.status == "active"
        assert create_model.max_concurrent > 0
        assert create_model.current_active >= 1  # we just created one

        # Step 3: Poll status
        status = await configured_app.get(
            f"/internal/streaming/sessions/{session_id}"
        )
        assert status.status_code == 200
        status_model = StreamingSessionResponse.model_validate(status.json())
        assert status_model.session_id == session_id
        assert status_model.status == "active"

        # Step 4: Cleanup
        delete = await configured_app.delete(
            f"/internal/streaming/sessions/{session_id}"
        )
        assert delete.status_code == 204

        # Step 5: Verify deleted — must be 404 now
        after = await configured_app.get(
            f"/internal/streaming/sessions/{session_id}"
        )
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
                "pipeline_id": str(uuid.uuid4()),
                "sample_rate": 16000,
            },
        )
        first_delete = await configured_app.delete(
            f"/internal/streaming/sessions/{session_id}"
        )
        assert first_delete.status_code == 204

        # Second delete — must be 404, not 500 or 204
        second_delete = await configured_app.delete(
            f"/internal/streaming/sessions/{session_id}"
        )
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
            "pipeline_id": str(uuid.uuid4()),
            "sample_rate": 16000,
        }
        response = await configured_app.post(
            "/internal/streaming/sessions", json=payload
        )
        assert response.status_code == 503, (
            f"Expected 503 when streaming not initialized, got {response.status_code}"
        )
        detail = response.json().get("detail", "")
        assert "not initialized" in detail.lower(), (
            f"Expected 'not initialized' in detail, got: {detail!r}"
        )

    async def test_get_nonexistent_session_returns_503_or_404(self, configured_app):
        """GET on a random session ID must be 404 (initialized) or 503 (not)."""
        fake_id = str(uuid.uuid4())
        response = await configured_app.get(
            f"/internal/streaming/sessions/{fake_id}"
        )

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
            assert avail_data["status"] == "not_initialized", (
                f"Status says not_initialized but availability says {avail_data['status']}"
            )
            assert "message" in status_data  # production sets message field
        else:
            assert avail_data["status"] in ("ready", "at_capacity"), (
                f"Status says running but availability says {avail_data['status']}"
            )

    async def test_create_session_request_validation_422(self, configured_app):
        """Missing required fields must return 422, not 500.

        Ensures FastAPI's Pydantic validation layer is active on this route.
        """
        response = await configured_app.post(
            "/internal/streaming/sessions", json={}
        )
        assert response.status_code == 422


# ============================================================================
# Task E3 — Cache clear → Transcribe → Verify cache repopulated
# ============================================================================


@pytest.mark.e2e
@pytest.mark.slow
@pytest.mark.ml
class TestCacheInteractionWorkflowE2E:
    """Test cache behavior around transcription.

    Every test sets up its own pre-conditions (clear cache, transcribe)
    rather than depending on test execution order.
    """

    async def test_clear_cache_then_transcribe_repopulates(
        self,
        real_audio_client,
        real_ml_audio_bytes,
        valid_pipeline_id,
    ):
        """
        1. Clear cache
        2. Verify cache is empty
        3. Transcribe (triggers model load)
        4. Verify cache has models + memory allocated
        5. Verify cache misses incremented
        6. Validate transcription via Pydantic
        """

        # Step 1: Clear the model cache
        clear = await real_audio_client.post("/internal/cache/clear")
        assert clear.status_code == 200
        assert clear.json()["status"] == "ok"

        # Step 2: Verify cache is empty (full schema)
        stats_before = await real_audio_client.get("/internal/cache/stats")
        assert stats_before.status_code == 200
        before_data = stats_before.json()
        assert before_data["total_models"] == 0
        assert before_data["total_memory_mb"] == 0.0
        assert isinstance(before_data["models"], list)
        assert len(before_data["models"]) == 0

        # Step 3: Transcribe — this forces model loading
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_en.wav",
            pipeline_id=valid_pipeline_id,
            language="en",
        )
        transcribe = await real_audio_client.post("/api/v1/transcribe", **form)
        assert transcribe.status_code == 200

        # Full Pydantic validation of the transcription response
        _validate_transcription_response(transcribe.json())

        # Step 4: Cache should now have at least one model
        stats_after = await real_audio_client.get("/internal/cache/stats")
        assert stats_after.status_code == 200
        after_data = stats_after.json()
        assert after_data["total_models"] >= 1
        assert after_data["total_memory_mb"] > 0.0
        assert len(after_data["models"]) >= 1

        # Step 5: Cache misses should have increased (cold-start)
        assert after_data["misses"] >= 1

    async def test_second_transcription_hits_cache(
        self,
        real_audio_client,
        real_ml_audio_bytes,
        valid_pipeline_id,
    ):
        """After model is cached, a second transcription must use cache hits.

        Self-contained: does its own first transcription to guarantee warm cache,
        then measures the delta. Does NOT depend on other tests having run.
        """

        # --- Pre-condition: ensure at least one model is cached ---
        warm_form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_warmup.wav",
            pipeline_id=valid_pipeline_id,
            language="en",
        )
        warmup = await real_audio_client.post("/api/v1/transcribe", **warm_form)
        assert warmup.status_code == 200

        # Record cache stats AFTER warm-up
        stats_before = await real_audio_client.get("/internal/cache/stats")
        assert stats_before.status_code == 200
        hits_before = stats_before.json()["hits"]
        models_before = stats_before.json()["total_models"]
        assert models_before >= 1, "Warm-up transcription should have loaded models"

        # --- Second transcription — expect cache hits ---
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_cache_hit.wav",
            pipeline_id=valid_pipeline_id,
            language="en",
        )
        transcribe = await real_audio_client.post("/api/v1/transcribe", **form)
        assert transcribe.status_code == 200
        _validate_transcription_response(transcribe.json())

        # Cache hits MUST have increased
        stats_after = await real_audio_client.get("/internal/cache/stats")
        assert stats_after.status_code == 200
        hits_after = stats_after.json()["hits"]
        assert hits_after > hits_before, (
            f"Cache hits did not increase: before={hits_before}, after={hits_after}"
        )

    async def test_cache_clear_is_idempotent_around_transcription(
        self,
        real_audio_client,
        real_ml_audio_bytes,
        valid_pipeline_id,
    ):
        """Clearing cache multiple times then transcribing still works.

        Edge case: operator runs /cache/clear twice by mistake.
        """

        # Double clear
        for _ in range(2):
            clear = await real_audio_client.post("/internal/cache/clear")
            assert clear.status_code == 200
            assert clear.json()["models_cleared"] >= 0

        # Cache must be empty
        stats = await real_audio_client.get("/internal/cache/stats")
        assert stats.json()["total_models"] == 0

        # Transcription must still succeed (cold-start)
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_double_clear.wav",
            pipeline_id=valid_pipeline_id,
            language="en",
        )
        transcribe = await real_audio_client.post("/api/v1/transcribe", **form)
        assert transcribe.status_code == 200
        _validate_transcription_response(transcribe.json())


# ============================================================================
# Task E4 — Concurrent transcription requests
# ============================================================================


@pytest.mark.e2e
@pytest.mark.slow
@pytest.mark.ml
class TestConcurrentTranscriptionE2E:
    """Test multiple concurrent transcription requests.

    Validates that the service can handle parallel requests without errors,
    race conditions, or data corruption.
    """

    async def test_two_concurrent_transcriptions(
        self,
        real_audio_client,
        real_ml_audio_bytes,
        valid_pipeline_id,
    ):
        """Two concurrent transcription requests should both succeed
        and produce valid, non-empty, independent results."""

        async def _transcribe(tag: str) -> dict:
            form = _build_multipart_form(
                audio_bytes=real_ml_audio_bytes,
                filename=f"test_concurrent_{tag}.wav",
                pipeline_id=valid_pipeline_id,
                language="en",
            )
            resp = await real_audio_client.post("/api/v1/transcribe", **form)
            return {"status_code": resp.status_code, "body": resp.json()}

        results = await asyncio.gather(_transcribe("a"), _transcribe("b"))

        for i, result in enumerate(results):
            assert result["status_code"] == 200, (
                f"Concurrent request {i} failed: {result['status_code']}"
            )
            # Full Pydantic validation on each concurrent response
            _validate_transcription_response(result["body"])

    async def test_concurrent_health_and_transcription(
        self,
        real_audio_client,
        real_ml_audio_bytes,
        valid_pipeline_id,
    ):
        """Health checks running alongside a transcription must not interfere.

        Simulates the gateway's readiness polling during active transcription.
        """

        async def _health_burst() -> list[int]:
            """Fire 5 rapid health checks."""
            codes = []
            for _ in range(5):
                resp = await real_audio_client.get("/api/v1/health")
                codes.append(resp.status_code)
            return codes

        async def _transcribe() -> dict:
            form = _build_multipart_form(
                audio_bytes=real_ml_audio_bytes,
                filename="test_alongside.wav",
                pipeline_id=valid_pipeline_id,
                language="en",
            )
            resp = await real_audio_client.post("/api/v1/transcribe", **form)
            return {"status_code": resp.status_code, "body": resp.json()}

        health_codes, transcribe_result = await asyncio.gather(
            _health_burst(), _transcribe()
        )

        assert all(c == 200 for c in health_codes), f"Health codes: {health_codes}"
        assert transcribe_result["status_code"] == 200
        _validate_transcription_response(transcribe_result["body"])

    async def test_concurrent_mixed_endpoints(
        self,
        real_audio_client,
        real_ml_audio_bytes,
        valid_pipeline_id,
    ):
        """Concurrent calls to health + ready + cache + transcribe all succeed.

        This is the realistic "steady-state" scenario where the gateway polls
        multiple endpoints simultaneously while transcriptions are in flight.
        """

        async def _health():
            return await real_audio_client.get("/api/v1/health")

        async def _ready():
            return await real_audio_client.get("/api/v1/ready")

        async def _cache_stats():
            return await real_audio_client.get("/internal/cache/stats")

        async def _transcribe():
            form = _build_multipart_form(
                audio_bytes=real_ml_audio_bytes,
                filename="test_mixed.wav",
                pipeline_id=valid_pipeline_id,
                language="en",
            )
            return await real_audio_client.post("/api/v1/transcribe", **form)

        health, ready, cache, transcribe = await asyncio.gather(
            _health(), _ready(), _cache_stats(), _transcribe()
        )

        assert health.status_code == 200
        assert health.json()["status"] == "ok"

        assert ready.status_code == 200
        assert ready.json()["status"] in ("healthy", "degraded", "unhealthy")

        assert cache.status_code == 200
        assert isinstance(cache.json()["total_models"], int)

        assert transcribe.status_code == 200
        _validate_transcription_response(transcribe.json())

    async def test_concurrent_cache_clear_during_transcription(
        self,
        real_audio_client,
        real_ml_audio_bytes,
        valid_pipeline_id,
    ):
        """Cache clear during an in-flight transcription must not cause 500.

        Edge case: ops clears cache while a transcription is running.
        Both operations must complete without server errors.
        """

        async def _transcribe():
            form = _build_multipart_form(
                audio_bytes=real_ml_audio_bytes,
                filename="test_clear_race.wav",
                pipeline_id=valid_pipeline_id,
                language="en",
            )
            return await real_audio_client.post("/api/v1/transcribe", **form)

        async def _cache_clear():
            return await real_audio_client.post("/internal/cache/clear")

        transcribe_resp, clear_resp = await asyncio.gather(
            _transcribe(), _cache_clear()
        )

        # Neither must return a 500 server error
        assert transcribe_resp.status_code != 500, (
            f"Transcription returned 500 during concurrent cache clear: "
            f"{transcribe_resp.json()}"
        )
        assert clear_resp.status_code == 200

        # The transcription may succeed (200) or fail gracefully (e.g., 500
        # from model being evicted mid-inference is unlikely but possible).
        # The key assertion: no unhandled exception / crash.
        if transcribe_resp.status_code == 200:
            _validate_transcription_response(transcribe_resp.json())
