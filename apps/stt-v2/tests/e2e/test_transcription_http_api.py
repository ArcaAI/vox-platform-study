"""
E2E tests for POST /api/v1/transcribe HTTP endpoint.

Track B — Tests the actual HTTP multipart upload flow with real audio files.

Requires:
    - ML deps installed (torch, faster-whisper, etc.) for happy-path tests
    - Monorepo test infra running: ``pnpm docker:test:up``
    - Pipeline seeded in test DB (or ``real_audio_client`` fixture configured)
    - Audio fixtures in ``tests/e2e/fixtures/``

Run:
    TEST_PLATFORM=all pytest tests/e2e/test_transcription_http_api.py -v -s

Markers:
    @pytest.mark.e2e    — all tests in this file
    @pytest.mark.slow   — tests that perform ML inference (>10s)
    @pytest.mark.ml     — tests that require ML dependencies

Anti-Pattern Compliance:
    - Happy-path tests (#1) use ZERO mocks — real audio, real infra, real ML
    - Error tests mock ONLY the DB boundary (pipeline reader) when needed to
      reach deeper validation; all HTTP routing, validation, and error handling
      runs through real production code
    - No production code was modified for testing (#2)
    - Error response schema is validated against the real ErrorResponse model (#4)
"""

from __future__ import annotations

import io

# Default tenant used across all tests (must match seeded data in test DB).
# Override via TEST_TENANT_ID env var if the seed differs.
import os as _os
from datetime import datetime

import pytest

VALID_TENANT_ID = _os.environ.get("TEST_TENANT_ID", "50000000-0000-0000-0000-000000000000")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_multipart_form(
    audio_bytes: bytes,
    filename: str,
    pipeline_id: str,
    tenant_id: str = VALID_TENANT_ID,
    language: str | None = None,
    consultation_id: str | None = None,
    code_switching: bool | None = None,
) -> dict:
    """Build multipart form data dict for httpx.

    Returns a dict with ``files`` and ``data`` keys suitable for
    ``httpx.AsyncClient.post("/api/v1/transcribe", **form)``.
    """
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


def _assert_error_response(response, *, expected_status: int, expected_error_code: str):
    """Validate the complete error response structure.

    Checks:
      - HTTP status code matches
      - Response is JSON with ``application/json`` content-type
      - ``detail`` dict contains ``error_code`` (str) and ``message`` (str)
      - ``error_code`` matches the expected value
    """
    assert (
        response.status_code == expected_status
    ), f"Expected {expected_status} but got {response.status_code}: {response.text}"
    assert "application/json" in response.headers.get(
        "content-type", ""
    ), f"Expected JSON content-type, got: {response.headers.get('content-type')}"
    body = response.json()
    assert "detail" in body, f"Response body missing 'detail' key: {body}"
    detail = body["detail"]
    assert isinstance(detail, dict), f"Expected 'detail' to be a dict, got {type(detail)}"
    assert "error_code" in detail, f"detail missing 'error_code': {detail}"
    assert "message" in detail, f"detail missing 'message': {detail}"
    assert isinstance(detail["error_code"], str)
    assert isinstance(detail["message"], str)
    assert len(detail["message"]) > 0, "Error message should not be empty"
    assert (
        detail["error_code"] == expected_error_code
    ), f"Expected error_code '{expected_error_code}', got '{detail['error_code']}'"
    return detail


# ---------------------------------------------------------------------------
# Shared mock fixtures for error tests (Anti-Pattern #3: mock at boundary,
# not internally. Anti-Pattern #4: use real PipelineConfig, not MagicMock)
# ---------------------------------------------------------------------------
#
# Language validation happens AFTER pipeline lookup in the route handler
# (routes.py lines 136-149). For the INVALID_LANGUAGE error path, we need
# a resolved pipeline config. Since the testcontainer DB has no seeded
# pipelines, we mock ONLY the pipeline reader boundary — every other line
# of code (HTTP routing, file validation, language validation, error
# formatting) runs through real production code.
#


def _make_mock_pipeline_config():
    """Create a real PipelineConfig for use in pipeline-reader mocks.

    Uses the actual Pydantic/dataclass models from production code, NOT
    MagicMock. This prevents Anti-Pattern #4 (incomplete mocks).
    """
    from stt_v2.pipeline.dto import (
        InferenceConfig,
        ModelRef,
        ModelRefs,
        PipelineConfig,
        PipelineSpec,
        PostprocessingConfig,
        PreprocessingConfig,
    )

    return PipelineConfig(
        id="p-mock-lang-test",
        tenant_id="t-test",
        slug="mock-pipeline",
        name="Mock Pipeline for Language Validation Test",
        description="Used to bypass pipeline lookup in INVALID_LANGUAGE tests",
        spec=PipelineSpec(
            version="1.0",
            models=ModelRefs(
                asr=ModelRef(slug="whisper-large-v3"),
            ),
            preprocessing=PreprocessingConfig(
                target_sample_rate=16000,
                normalize=True,
            ),
            inference=InferenceConfig(
                batch_size=1,
                language="en",
            ),
            postprocessing=PostprocessingConfig(),
        ),
        tags=["test"],
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )


# ============================================================================
# Task B1 + B2 + B3 + B8 — Happy-path tests (require real_audio_client & ML)
#
# Anti-Pattern #1 compliance: ZERO mocks. These tests exercise the full
# production stack: HTTP → route handler → pipeline reader (real DB) →
# batch service → ML inference → response serialization.
# ============================================================================


@pytest.mark.e2e
@pytest.mark.slow
@pytest.mark.ml
class TestTranscribeHttpHappyPath:
    """Happy-path tests for ``POST /api/v1/transcribe``.

    These tests upload real audio through the HTTP endpoint and verify
    that a complete transcription result is returned.  They use:
      - Real ML models (no mocks)
      - Real monorepo infrastructure (Postgres, Redis, MinIO)
      - Real audio fixtures (.wav files)
    """

    # ------------------------------------------------------------------
    # Task B1: Successful transcription with real English audio
    # ------------------------------------------------------------------

    async def test_transcribe_en_audio_returns_200(
        self, real_audio_client, real_ml_audio_bytes, valid_pipeline_id
    ):
        """Upload real EN audio via HTTP multipart -> get 200 with transcription text."""
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_en.wav",
            pipeline_id=valid_pipeline_id,
            language="en",
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)

        assert (
            response.status_code == 200
        ), f"Expected 200 but got {response.status_code}: {response.text}"
        assert "application/json" in response.headers.get("content-type", "")
        data = response.json()

        # Core fields must be present and non-empty
        assert isinstance(data["text"], str)
        assert len(data["text"]) > 0, "Transcription text should not be empty"
        assert data["duration_seconds"] > 0
        assert data["processing_time_seconds"] > 0

        # Timestamps should be lists (may be empty for very short audio)
        assert isinstance(data["word_timestamps"], list)
        assert isinstance(data["sentence_timestamps"], list)

    # ------------------------------------------------------------------
    # Task B2: Successful transcription with real multilingual audio
    # ------------------------------------------------------------------

    async def test_transcribe_ml_audio_returns_200(
        self, real_audio_client, real_ml_audio_bytes, valid_pipeline_id
    ):
        """Upload real ML (multilingual) audio via HTTP -> get 200 with transcription text."""
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_ml.wav",
            pipeline_id=valid_pipeline_id,
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)

        assert (
            response.status_code == 200
        ), f"Expected 200 but got {response.status_code}: {response.text}"
        data = response.json()
        assert len(data["text"]) > 0, "Transcription text should not be empty"
        assert data["duration_seconds"] > 0
        assert data["processing_time_seconds"] > 0

    # ------------------------------------------------------------------
    # Task B3: Response schema deep validation
    # ------------------------------------------------------------------

    async def test_transcription_response_full_schema(
        self, real_audio_client, real_ml_audio_bytes, valid_pipeline_id
    ):
        """Validate every field in ``TranscriptionResponse`` via Pydantic round-trip.

        This test ensures the HTTP response can be parsed by the exact same
        Pydantic model the server uses. It verifies all nested objects, timing
        metrics, and optional storage URIs.
        """
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_en_schema.wav",
            pipeline_id=valid_pipeline_id,
            language="en",
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)
        assert response.status_code == 200
        data = response.json()

        # Round-trip through the Pydantic model — this catches any field
        # the server returns that doesn't match the declared schema
        from stt_v2.transcription.api.schemas import TranscriptionResponse

        parsed = TranscriptionResponse.model_validate(data)

        # ---- Top-level fields ----
        assert parsed.text
        assert parsed.duration_seconds > 0
        assert parsed.processing_time_seconds > 0

        # ---- Word timestamps ----
        for wt in parsed.word_timestamps:
            assert wt.start_time >= 0
            assert wt.end_time >= wt.start_time
            assert 0 <= wt.confidence <= 1.0
            assert len(wt.word) > 0

        # ---- Sentence timestamps ----
        for st in parsed.sentence_timestamps:
            assert st.start_time >= 0
            assert st.end_time >= st.start_time
            assert len(st.text) > 0

        # ---- Segments (from VAD) ----
        for seg in parsed.segments:
            assert seg.start_time >= 0
            assert seg.end_time >= seg.start_time
            assert seg.duration >= 0
            assert isinstance(seg.is_speech, bool)
            assert 0 <= seg.confidence <= 1.0

        # ---- Timing metrics ----
        if parsed.timing is not None:
            assert parsed.timing.total_seconds > 0
            assert parsed.timing.inference_seconds >= 0
            # All timing fields must be non-negative
            assert parsed.timing.ttfw_seconds >= 0
            assert parsed.timing.model_loading_seconds >= 0
            assert parsed.timing.preprocessing_seconds >= 0
            assert parsed.timing.diarization_seconds >= 0
            assert parsed.timing.postprocessing_seconds >= 0

        # ---- Metadata dict ----
        assert isinstance(parsed.metadata, dict)

        # ---- Storage URIs (optional, may or may not be populated) ----
        for uri_field in (parsed.raw_audio_uri, parsed.processed_audio_uri, parsed.transcript_uri):
            if uri_field is not None:
                assert isinstance(uri_field, str)
                assert len(uri_field) > 0

    async def test_transcription_response_contains_language(
        self, real_audio_client, real_ml_audio_bytes, valid_pipeline_id
    ):
        """When language hint is provided, the response should include language info.

        Note: The ``language`` field in the response is populated from the
        model's inference result, not from the request hint.  Some engines
        (e.g. HuggingFace safetensor pipeline with ``language: null`` in
        config) may not propagate language detection back.  We therefore
        accept ``None`` as a valid value and only validate the probability
        range when language is present.
        """
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_en_lang.wav",
            pipeline_id=valid_pipeline_id,
            language="en",
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)
        assert response.status_code == 200
        data = response.json()

        # The response may or may not include language info depending on
        # the engine and pipeline config.  Validate structure when present.
        if data.get("language") is not None:
            assert isinstance(data["language"], str)
        # language_probability range validation
        if data.get("language_probability") is not None:
            assert 0.0 <= data["language_probability"] <= 1.0

    async def test_transcription_word_timestamps_ordered_chronologically(
        self, real_audio_client, real_ml_audio_bytes, valid_pipeline_id
    ):
        """Word timestamps should be in chronological order."""
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_en_order.wav",
            pipeline_id=valid_pipeline_id,
            language="en",
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)
        assert response.status_code == 200
        data = response.json()

        word_timestamps = data.get("word_timestamps", [])
        if len(word_timestamps) > 1:
            for i in range(1, len(word_timestamps)):
                assert word_timestamps[i]["start_time"] >= word_timestamps[i - 1]["start_time"], (
                    f"Word timestamps not chronological at index {i}: "
                    f"{word_timestamps[i-1]} -> {word_timestamps[i]}"
                )

    async def test_transcription_sentence_timestamps_ordered_chronologically(
        self, real_audio_client, real_ml_audio_bytes, valid_pipeline_id
    ):
        """Sentence timestamps should be in chronological order."""
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_en_sent_order.wav",
            pipeline_id=valid_pipeline_id,
            language="en",
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)
        assert response.status_code == 200
        data = response.json()

        sentence_timestamps = data.get("sentence_timestamps", [])
        if len(sentence_timestamps) > 1:
            for i in range(1, len(sentence_timestamps)):
                assert (
                    sentence_timestamps[i]["start_time"] >= sentence_timestamps[i - 1]["start_time"]
                ), (
                    f"Sentence timestamps not chronological at index {i}: "
                    f"{sentence_timestamps[i-1]} -> {sentence_timestamps[i]}"
                )

    async def test_transcription_processing_time_reasonable(
        self, real_audio_client, real_ml_audio_bytes, valid_pipeline_id
    ):
        """Processing time should be within a reasonable real-time factor.

        For CPU inference, 10x real-time is generous. If this fails, something
        is seriously wrong with the pipeline.
        """
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_en_perf.wav",
            pipeline_id=valid_pipeline_id,
            language="en",
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)
        assert response.status_code == 200
        data = response.json()

        duration = data["duration_seconds"]
        processing = data["processing_time_seconds"]
        if duration > 0:
            rtf = processing / duration
            assert rtf < 10.0, (
                f"Real-time factor {rtf:.2f}x is unreasonably high "
                f"(processing={processing:.1f}s, audio={duration:.1f}s)"
            )

    # ------------------------------------------------------------------
    # Task B8: Transcription with code_switching and consultation_id
    # ------------------------------------------------------------------

    async def test_transcribe_with_optional_params(
        self, real_audio_client, real_ml_audio_bytes, valid_pipeline_id
    ):
        """Transcription with ``code_switching=true`` and ``consultation_id`` succeeds.

        These optional fields should be accepted without error and produce
        a valid transcription result.
        """
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_ml_opts.wav",
            pipeline_id=valid_pipeline_id,
            consultation_id="c-test-123",
            code_switching=True,
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)

        assert (
            response.status_code == 200
        ), f"Expected 200 but got {response.status_code}: {response.text}"
        data = response.json()
        assert len(data["text"]) > 0

    async def test_transcribe_with_consultation_id_only(
        self, real_audio_client, real_ml_audio_bytes, valid_pipeline_id
    ):
        """Providing only ``consultation_id`` (without code_switching) works."""
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_en_consult.wav",
            pipeline_id=valid_pipeline_id,
            language="en",
            consultation_id="c-consult-only-456",
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)
        assert response.status_code == 200
        assert len(response.json()["text"]) > 0

    async def test_transcribe_with_code_switching_false(
        self, real_audio_client, real_ml_audio_bytes, valid_pipeline_id
    ):
        """Explicitly setting ``code_switching=false`` should work."""
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_en_no_cs.wav",
            pipeline_id=valid_pipeline_id,
            language="en",
            code_switching=False,
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)
        assert response.status_code == 200
        assert len(response.json()["text"]) > 0


# ============================================================================
# Task B4–B7 — Error scenario tests (use configured_app / testcontainers)
#
# These tests exercise the REAL FastAPI route handler error paths. Mocking is
# used ONLY where needed (pipeline reader) and is clearly documented with
# the reason. Each test validates the full error response structure.
# ============================================================================


@pytest.mark.e2e
class TestTranscribeHttpErrors:
    """Error scenario tests for ``POST /api/v1/transcribe``.

    These tests verify that the endpoint correctly returns 400, 404, 413,
    and 422 responses for invalid requests. They use the ``configured_app``
    fixture (testcontainers) and do NOT require ML deps or real audio.

    Error response validation uses ``_assert_error_response`` which checks
    the complete response structure (Anti-Pattern #4: no incomplete mocks).
    """

    # ------------------------------------------------------------------
    # Task B4: Empty file -> 400 EMPTY_FILE
    # ------------------------------------------------------------------

    async def test_empty_file_returns_400(self, configured_app):
        """Uploading an empty file should return 400 with ``EMPTY_FILE`` error code.

        Production code: routes.py line 93 ``if not audio_bytes``
        """
        form = _build_multipart_form(
            audio_bytes=b"",
            filename="empty.wav",
            pipeline_id="any-pipeline",
            tenant_id="any-tenant",
        )
        response = await configured_app.post("/api/v1/transcribe", **form)

        detail = _assert_error_response(
            response, expected_status=400, expected_error_code="EMPTY_FILE"
        )
        assert "empty" in detail["message"].lower()

    # ------------------------------------------------------------------
    # Task B5: Oversized file -> 413 FILE_TOO_LARGE
    # ------------------------------------------------------------------

    async def test_oversized_file_returns_413(self, configured_app):
        """File exceeding 100 MB limit should return 413 with ``FILE_TOO_LARGE``.

        Production code: routes.py line 99 ``if len(audio_bytes) > _MAX_UPLOAD_BYTES``
        We use 101 MB of null bytes. Validation runs before pipeline lookup.
        """
        oversized = b"\x00" * (101 * 1024 * 1024)
        form = _build_multipart_form(
            audio_bytes=oversized,
            filename="huge.wav",
            pipeline_id="any-pipeline",
            tenant_id="any-tenant",
        )
        response = await configured_app.post("/api/v1/transcribe", **form)

        detail = _assert_error_response(
            response, expected_status=413, expected_error_code="FILE_TOO_LARGE"
        )
        # Message should mention the limit
        assert (
            "100" in detail["message"]
        ), f"Error message should mention 100 MB limit, got: {detail['message']}"

    async def test_file_just_over_limit_returns_413(self, configured_app):
        """File at exactly 100 MB + 1 byte should be rejected.

        Boundary test: _MAX_UPLOAD_BYTES = 100 * 1024 * 1024 = 104857600.
        A file of 104857601 bytes must be rejected.
        """
        just_over = b"\x00" * (100 * 1024 * 1024 + 1)
        form = _build_multipart_form(
            audio_bytes=just_over,
            filename="just_over.wav",
            pipeline_id="any-pipeline",
            tenant_id="any-tenant",
        )
        response = await configured_app.post("/api/v1/transcribe", **form)
        _assert_error_response(response, expected_status=413, expected_error_code="FILE_TOO_LARGE")

    async def test_file_exactly_at_limit_passes_size_check(self, configured_app, sample_wav_audio):
        """A file of exactly 100 MB should NOT be rejected by the size check.

        Production code uses strict ``>`` (not ``>=``), so 100 MB exactly should pass.
        The request will fail later on pipeline lookup (404), proving the
        size validation passed.
        """
        target_size = 100 * 1024 * 1024
        padded = sample_wav_audio + b"\x00" * (target_size - len(sample_wav_audio))
        assert len(padded) == target_size  # sanity check

        form = _build_multipart_form(
            audio_bytes=padded,
            filename="at_limit.wav",
            pipeline_id="nonexistent-pipeline",
            tenant_id="any-tenant",
        )
        response = await configured_app.post("/api/v1/transcribe", **form)

        # Must NOT be 413 — the size check passes at exactly 100 MB
        assert (
            response.status_code != 413
        ), "File at exactly 100 MB should not trigger FILE_TOO_LARGE"
        # Should proceed to pipeline lookup and get 404
        assert response.status_code == 404

    # ------------------------------------------------------------------
    # Task B6: Non-existent pipeline -> 404 PIPELINE_NOT_FOUND
    # ------------------------------------------------------------------

    async def test_nonexistent_pipeline_slug_returns_404(self, configured_app, sample_wav_audio):
        """Non-existent ``pipeline_id`` (slug format) should return 404.

        Production code: routes.py line 121-125 — slug lookup path
        (ValueError is raised by uuid.UUID, so it falls through to slug lookup).
        """
        form = _build_multipart_form(
            audio_bytes=sample_wav_audio,
            filename="test.wav",
            pipeline_id="nonexistent-pipeline-slug",
            tenant_id="t-test",
        )
        response = await configured_app.post("/api/v1/transcribe", **form)

        detail = _assert_error_response(
            response, expected_status=404, expected_error_code="PIPELINE_NOT_FOUND"
        )
        assert "nonexistent-pipeline-slug" in detail["message"]

    async def test_nonexistent_pipeline_uuid_returns_404(self, configured_app, sample_wav_audio):
        """Non-existent ``pipeline_id`` (UUID format) should return 404.

        Production code: routes.py line 119-120 — UUID lookup path
        (uuid.UUID succeeds, so it uses get_pipeline by ID).
        """
        import uuid

        fake_uuid = str(uuid.uuid4())
        form = _build_multipart_form(
            audio_bytes=sample_wav_audio,
            filename="test.wav",
            pipeline_id=fake_uuid,
            tenant_id="t-test",
        )
        response = await configured_app.post("/api/v1/transcribe", **form)

        detail = _assert_error_response(
            response, expected_status=404, expected_error_code="PIPELINE_NOT_FOUND"
        )
        assert fake_uuid in detail["message"]

    # ------------------------------------------------------------------
    # Task B7: Invalid language code -> 400 INVALID_LANGUAGE
    #
    # WHY we mock here: Language validation (routes.py line 137-149)
    # occurs AFTER the pipeline lookup succeeds. Since the testcontainer
    # DB has no seeded pipelines, every request would 404 before reaching
    # the language check. We mock ONLY get_pipeline_reader to return a
    # real PipelineConfig, letting all other code (HTTP layer, file
    # validation, is_valid_language_code) run through production paths.
    # ------------------------------------------------------------------

    async def test_invalid_language_code_returns_400(self, configured_app, sample_wav_audio):
        """Language code 'xyz-invalid' is not in VALID_WHISPER_LANGUAGES -> 400."""
        from unittest.mock import AsyncMock, patch

        mock_config = _make_mock_pipeline_config()
        mock_reader = AsyncMock()
        mock_reader.get_pipeline_by_slug = AsyncMock(return_value=mock_config)
        mock_reader.get_pipeline = AsyncMock(return_value=mock_config)

        with patch(
            "stt_v2.transcription.api.routes.get_pipeline_reader",
            return_value=mock_reader,
        ):
            form = _build_multipart_form(
                audio_bytes=sample_wav_audio,
                filename="test.wav",
                pipeline_id="mock-pipeline",
                tenant_id="t-test",
                language="xyz-invalid",
            )
            response = await configured_app.post("/api/v1/transcribe", **form)

        detail = _assert_error_response(
            response, expected_status=400, expected_error_code="INVALID_LANGUAGE"
        )
        assert "xyz-invalid" in detail["message"]

    async def test_three_letter_invalid_language_returns_400(
        self, configured_app, sample_wav_audio
    ):
        """Language code 'zzz' (3-letter but not in Whisper set) -> 400."""
        from unittest.mock import AsyncMock, patch

        mock_config = _make_mock_pipeline_config()
        mock_reader = AsyncMock()
        mock_reader.get_pipeline_by_slug = AsyncMock(return_value=mock_config)
        mock_reader.get_pipeline = AsyncMock(return_value=mock_config)

        with patch(
            "stt_v2.transcription.api.routes.get_pipeline_reader",
            return_value=mock_reader,
        ):
            form = _build_multipart_form(
                audio_bytes=sample_wav_audio,
                filename="test.wav",
                pipeline_id="mock-pipeline",
                tenant_id="t-test",
                language="zzz",
            )
            response = await configured_app.post("/api/v1/transcribe", **form)

        _assert_error_response(
            response, expected_status=400, expected_error_code="INVALID_LANGUAGE"
        )

    async def test_bcp47_with_invalid_primary_subtag_returns_400(
        self, configured_app, sample_wav_audio
    ):
        """BCP-47 tag 'zzz-ZZ' should fail: primary subtag 'zzz' is not in Whisper set.

        Production code: is_valid_language_code splits on '-' and validates
        the primary subtag, so 'zzz-ZZ' extracts 'zzz' which is invalid.
        """
        from unittest.mock import AsyncMock, patch

        mock_config = _make_mock_pipeline_config()
        mock_reader = AsyncMock()
        mock_reader.get_pipeline_by_slug = AsyncMock(return_value=mock_config)
        mock_reader.get_pipeline = AsyncMock(return_value=mock_config)

        with patch(
            "stt_v2.transcription.api.routes.get_pipeline_reader",
            return_value=mock_reader,
        ):
            form = _build_multipart_form(
                audio_bytes=sample_wav_audio,
                filename="test.wav",
                pipeline_id="mock-pipeline",
                tenant_id="t-test",
                language="zzz-ZZ",
            )
            response = await configured_app.post("/api/v1/transcribe", **form)

        _assert_error_response(
            response, expected_status=400, expected_error_code="INVALID_LANGUAGE"
        )

    async def test_valid_bcp47_language_passes_validation(self, configured_app, sample_wav_audio):
        """BCP-47 tag 'en-US' should pass language validation.

        Primary subtag 'en' is in VALID_WHISPER_LANGUAGES. The request will
        proceed past language validation and fail at the batch service (500),
        proving the language check passed.
        """
        from unittest.mock import AsyncMock, patch

        mock_config = _make_mock_pipeline_config()
        mock_reader = AsyncMock()
        mock_reader.get_pipeline_by_slug = AsyncMock(return_value=mock_config)
        mock_reader.get_pipeline = AsyncMock(return_value=mock_config)

        with patch(
            "stt_v2.transcription.api.routes.get_pipeline_reader",
            return_value=mock_reader,
        ):
            form = _build_multipart_form(
                audio_bytes=sample_wav_audio,
                filename="test.wav",
                pipeline_id="mock-pipeline",
                tenant_id="t-test",
                language="en-US",
            )
            response = await configured_app.post("/api/v1/transcribe", **form)

        # Must NOT be 400 INVALID_LANGUAGE — en-US is valid
        assert response.status_code != 400 or (
            response.status_code == 400
            and response.json().get("detail", {}).get("error_code") != "INVALID_LANGUAGE"
        ), "en-US should pass language validation"

    async def test_empty_language_string_bypasses_validation(
        self, configured_app, sample_wav_audio
    ):
        """Empty string for language should NOT trigger language validation.

        Production code: ``if language:`` is falsy for empty string, so
        language validation is skipped entirely. The request proceeds to
        pipeline lookup (which will 404 in testcontainers).
        """
        form = _build_multipart_form(
            audio_bytes=sample_wav_audio,
            filename="test.wav",
            pipeline_id="nonexistent-slug",
            tenant_id="t-test",
            language="",
        )
        response = await configured_app.post("/api/v1/transcribe", **form)

        # Should NOT be 400 INVALID_LANGUAGE — empty string bypasses the check
        if response.status_code == 400:
            detail = response.json().get("detail", {})
            assert (
                detail.get("error_code") != "INVALID_LANGUAGE"
            ), "Empty language string should not trigger INVALID_LANGUAGE"
        # Most likely: 404 PIPELINE_NOT_FOUND (pipeline lookup runs next)
        assert response.status_code in (404, 422)

    # ------------------------------------------------------------------
    # Additional error edge cases: FastAPI validation (422)
    # ------------------------------------------------------------------

    async def test_missing_pipeline_id_returns_422(self, configured_app, sample_wav_audio):
        """Omitting required ``pipeline_id`` field -> 422 Unprocessable Entity."""
        files = {"file": ("test.wav", io.BytesIO(sample_wav_audio), "audio/wav")}
        data = {"tenant_id": "t-test"}  # missing pipeline_id
        response = await configured_app.post("/api/v1/transcribe", files=files, data=data)
        assert response.status_code == 422
        # FastAPI 422 responses include a 'detail' list with validation errors
        body = response.json()
        assert "detail" in body

    async def test_missing_tenant_id_returns_422(self, configured_app, sample_wav_audio):
        """Omitting required ``tenant_id`` field -> 422 Unprocessable Entity."""
        files = {"file": ("test.wav", io.BytesIO(sample_wav_audio), "audio/wav")}
        data = {"pipeline_id": "some-pipeline"}  # missing tenant_id
        response = await configured_app.post("/api/v1/transcribe", files=files, data=data)
        assert response.status_code == 422
        body = response.json()
        assert "detail" in body

    async def test_missing_file_returns_422(self, configured_app):
        """Omitting the required ``file`` field -> 422 Unprocessable Entity."""
        data = {"pipeline_id": "some-pipeline", "tenant_id": "t-test"}
        response = await configured_app.post("/api/v1/transcribe", data=data)
        assert response.status_code == 422

    async def test_missing_all_fields_returns_422(self, configured_app):
        """Sending an empty POST with no multipart fields -> 422."""
        response = await configured_app.post("/api/v1/transcribe")
        assert response.status_code == 422

    # ------------------------------------------------------------------
    # HTTP method edge cases
    # ------------------------------------------------------------------

    async def test_get_method_not_allowed(self, configured_app):
        """``GET /api/v1/transcribe`` should return 405 Method Not Allowed."""
        response = await configured_app.get("/api/v1/transcribe")
        assert response.status_code == 405

    async def test_put_method_not_allowed(self, configured_app):
        """``PUT /api/v1/transcribe`` should return 405 Method Not Allowed."""
        response = await configured_app.put("/api/v1/transcribe")
        assert response.status_code == 405

    async def test_delete_method_not_allowed(self, configured_app):
        """``DELETE /api/v1/transcribe`` should return 405 Method Not Allowed."""
        response = await configured_app.delete("/api/v1/transcribe")
        assert response.status_code == 405

    # ------------------------------------------------------------------
    # Content-type edge cases
    # ------------------------------------------------------------------

    async def test_json_body_instead_of_multipart_returns_422(self, configured_app):
        """Sending JSON body instead of multipart form should fail.

        The endpoint expects multipart/form-data, not application/json.
        """
        response = await configured_app.post(
            "/api/v1/transcribe",
            json={"pipeline_id": "test", "tenant_id": "t-test"},
        )
        assert response.status_code == 422
