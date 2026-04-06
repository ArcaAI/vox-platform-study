"""Unit tests for the Transcription API (Track 1: POST /api/v1/transcribe).

Tests cover:
- Request validation (empty file, file too large, missing pipeline)
- Pipeline resolution (by UUID, by slug, not found)
- Successful transcription round-trip (mocked batch_service)
- Error mapping (TranscriptionError → 500, ValidationError → 400)
- Response schema construction (_build_response helper)
"""

import io
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import UploadFile
from fastapi.exceptions import HTTPException

from stt_v2.transcription.api.routes import (
    _MAX_UPLOAD_BYTES,
    _build_response,
    transcribe_audio,
)
from stt_v2.transcription.api.schemas import (
    ErrorResponse,
    SegmentResponse,
    SentenceTimestampResponse,
    TimingMetricsResponse,
    TranscriptionResponse,
    WordTimestampResponse,
)
from stt_v2.transcription.dto import (
    AudioSegment,
    SentenceTimestamp,
    TimingMetrics,
    TranscriptionResult,
    WordTimestamp,
)

# =============================================================================
# Helpers
# =============================================================================


def _make_upload_file(
    content: bytes = b"RIFF\x00\x00\x00\x00WAVE",
    filename: str = "test.wav",
) -> UploadFile:
    """Create a minimal UploadFile for testing."""
    return UploadFile(
        filename=filename,
        file=io.BytesIO(content),
    )


def _make_pipeline_mock(language: str | None = "en", slug: str = "test-pipeline") -> MagicMock:
    """Create a mock PipelineConfig with nested spec.inference.language.

    Cannot use ``MagicMock(spec=...)`` because Python 3.11 forbids passing
    another Mock as the ``spec`` constructor argument.  Instead we build
    the nested structure manually.
    """
    inference = MagicMock()
    inference.language = language
    inference.code_switching = False

    pipeline_spec = MagicMock()
    pipeline_spec.inference = inference

    pipeline = MagicMock()
    pipeline.spec = pipeline_spec
    pipeline.slug = slug
    return pipeline


def _make_transcription_result(**overrides) -> TranscriptionResult:
    """Build a TranscriptionResult with sensible defaults."""
    defaults = {
        "text": "Hello world",
        "language": "en",
        "language_probability": 0.95,
        "duration_seconds": 3.5,
        "processing_time_seconds": 1.2,
        "word_timestamps": [
            WordTimestamp(word="Hello", start_time=0.0, end_time=0.5, confidence=0.99),
            WordTimestamp(word="world", start_time=0.6, end_time=1.0, confidence=0.97),
        ],
        "sentence_timestamps": [
            SentenceTimestamp(text="Hello world", start_time=0.0, end_time=1.0),
        ],
        "segments": [],
        "metadata": {
            "job_id": "test-job-1",
            "pipeline": "test-pipeline",
            "timing": TimingMetrics(
                ttfw_seconds=0.5,
                model_loading_seconds=0.3,
                preprocessing_seconds=0.1,
                inference_seconds=0.6,
                total_seconds=1.2,
            ),
        },
    }
    defaults.update(overrides)
    return TranscriptionResult(**defaults)


# =============================================================================
# Schema Tests
# =============================================================================


class TestSchemaModels:
    """Basic tests for Pydantic response models."""

    def test_transcription_response_defaults(self):
        """Ensure defaults populate correctly."""
        resp = TranscriptionResponse(text="Hi")
        assert resp.text == "Hi"
        assert resp.word_timestamps == []
        assert resp.timing is None
        assert resp.metadata == {}

    def test_error_response(self):
        """ErrorResponse serialises cleanly."""
        err = ErrorResponse(error_code="TEST_ERR", message="Oops")
        assert err.error_code == "TEST_ERR"
        assert err.details == {}

    def test_timing_metrics_response(self):
        """TimingMetricsResponse round-trips."""
        t = TimingMetricsResponse(
            ttfw_seconds=0.5,
            inference_seconds=1.0,
            total_seconds=2.0,
        )
        assert t.ttfw_seconds == 0.5
        assert t.preprocessing_seconds == 0.0  # default

    def test_word_timestamp_response(self):
        """WordTimestampResponse fields."""
        w = WordTimestampResponse(word="hello", start_time=0.0, end_time=0.5)
        assert w.confidence == 1.0

    def test_sentence_timestamp_response(self):
        """SentenceTimestampResponse fields."""
        s = SentenceTimestampResponse(
            text="Hello world",
            start_time=0.0,
            end_time=1.0,
            english_text="Hello world",
        )
        assert s.text == "Hello world"
        assert s.english_text == "Hello world"

    def test_segment_response(self):
        """SegmentResponse fields."""
        seg = SegmentResponse(
            start_time=0.0,
            end_time=1.0,
            duration=1.0,
            is_speech=True,
            confidence=0.9,
        )
        assert seg.is_speech is True


# =============================================================================
# _build_response Tests
# =============================================================================


class TestBuildResponse:
    """Tests for the _build_response helper."""

    def test_basic_conversion(self):
        """TranscriptionResult → TranscriptionResponse round-trip."""
        result = _make_transcription_result(
            sentence_timestamps=[
                SentenceTimestamp(
                    text="ഹലോ വേൾഡ്",
                    start_time=0.0,
                    end_time=1.0,
                    english_text="Hello world",
                ),
            ]
        )
        resp = _build_response(result)

        assert isinstance(resp, TranscriptionResponse)
        assert resp.text == "Hello world"
        assert resp.language == "en"
        assert resp.duration_seconds == 3.5
        assert resp.processing_time_seconds == 1.2
        assert len(resp.word_timestamps) == 2
        assert resp.word_timestamps[0].word == "Hello"
        assert len(resp.sentence_timestamps) == 1
        assert resp.sentence_timestamps[0].english_text == "Hello world"

    def test_timing_extracted(self):
        """Timing metrics are extracted from metadata to top-level."""
        result = _make_transcription_result()
        resp = _build_response(result)

        assert resp.timing is not None
        assert resp.timing.ttfw_seconds == 0.5
        assert resp.timing.inference_seconds == 0.6
        # "timing" key should NOT appear in metadata
        assert "timing" not in resp.metadata

    def test_timing_from_dict(self):
        """Timing works when stored as a dict (e.g. from JSON)."""
        result = _make_transcription_result(
            metadata={
                "timing": {
                    "ttfw_seconds": 0.3,
                    "inference_seconds": 0.8,
                    "total_seconds": 1.5,
                },
            },
        )
        resp = _build_response(result)
        assert resp.timing is not None
        assert resp.timing.ttfw_seconds == 0.3

    def test_no_timing(self):
        """Response works when no timing present."""
        result = _make_transcription_result(metadata={"job_id": "x"})
        resp = _build_response(result)
        assert resp.timing is None

    def test_segments_included(self):
        """AudioSegment objects are serialised to SegmentResponse."""
        result = _make_transcription_result(
            segments=[
                AudioSegment(start_time=0.0, end_time=2.0, is_speech=True, confidence=0.95),
            ],
        )
        resp = _build_response(result)
        assert len(resp.segments) == 1
        assert resp.segments[0].is_speech is True
        assert resp.segments[0].duration == 2.0

    def test_storage_uris(self):
        """Storage URIs pass through when set."""
        result = _make_transcription_result()
        result.raw_audio_uri = "s3://bucket/raw.wav"
        result.transcript_uri = "s3://bucket/transcript.json"
        resp = _build_response(result)
        assert resp.raw_audio_uri == "s3://bucket/raw.wav"
        assert resp.transcript_uri == "s3://bucket/transcript.json"
        assert resp.processed_audio_uri is None


# =============================================================================
# Endpoint Tests (mocked dependencies)
# =============================================================================


class TestTranscribeAudioEndpoint:
    """Tests for POST /api/v1/transcribe."""

    @pytest.mark.asyncio
    async def test_empty_file_returns_400(self):
        """Empty file upload should return 400."""
        upload = _make_upload_file(content=b"")

        with pytest.raises(HTTPException) as exc_info:
            await transcribe_audio(
                file=upload,
                pipeline_id="p-123",
                tenant_id="t-456",
            )

        assert exc_info.value.status_code == 400
        assert "EMPTY_FILE" in str(exc_info.value.detail)

    @pytest.mark.asyncio
    async def test_oversized_file_returns_413(self):
        """File exceeding _MAX_UPLOAD_BYTES should return 413."""
        # Create content just over the limit
        big_content = b"X" * (_MAX_UPLOAD_BYTES + 1)
        upload = _make_upload_file(content=big_content)

        with pytest.raises(HTTPException) as exc_info:
            await transcribe_audio(
                file=upload,
                pipeline_id="p-123",
                tenant_id="t-456",
            )

        assert exc_info.value.status_code == 413
        assert "FILE_TOO_LARGE" in str(exc_info.value.detail)

    @pytest.mark.asyncio
    async def test_pipeline_not_found_returns_404(self):
        """Unknown pipeline_id should return 404."""
        upload = _make_upload_file()
        from stt_v2.core.exceptions import NotFoundError

        mock_reader = AsyncMock()
        mock_reader.get_pipeline = AsyncMock(side_effect=NotFoundError("Not found"))

        with patch(
            "stt_v2.transcription.api.routes.get_pipeline_reader",
            return_value=mock_reader,
        ):
            with pytest.raises(HTTPException) as exc_info:
                await transcribe_audio(
                    file=upload,
                    pipeline_id=str(uuid.uuid4()),
                    tenant_id="t-456",
                )

            assert exc_info.value.status_code == 404
            assert "PIPELINE_NOT_FOUND" in str(exc_info.value.detail)

    @pytest.mark.asyncio
    async def test_pipeline_resolved_by_slug(self):
        """When pipeline_id is not a UUID, resolve by slug."""
        upload = _make_upload_file()
        result = _make_transcription_result()

        mock_reader = AsyncMock()
        mock_reader.get_pipeline_by_slug = AsyncMock(
            return_value=_make_pipeline_mock(language="en", slug="test-pipeline"),
        )

        mock_service = AsyncMock()
        mock_service.transcribe = AsyncMock(return_value=result)

        with (
            patch(
                "stt_v2.transcription.api.routes.get_pipeline_reader",
                return_value=mock_reader,
            ),
            patch(
                "stt_v2.transcription.api.routes.get_batch_service",
                return_value=mock_service,
            ),
        ):
            resp = await transcribe_audio(
                file=upload,
                pipeline_id="my-slug",
                tenant_id="t-456",
            )

            mock_reader.get_pipeline_by_slug.assert_called_once_with(
                "my-slug",
                tenant_id="t-456",
            )
            assert isinstance(resp, TranscriptionResponse)

    @pytest.mark.asyncio
    async def test_pipeline_resolved_by_uuid(self):
        """When pipeline_id is a valid UUID, resolve by ID."""
        upload = _make_upload_file()
        result = _make_transcription_result()
        pid = str(uuid.uuid4())

        mock_reader = AsyncMock()
        mock_reader.get_pipeline = AsyncMock(
            return_value=_make_pipeline_mock(language="en", slug="uuid-pipeline"),
        )

        mock_service = AsyncMock()
        mock_service.transcribe = AsyncMock(return_value=result)

        with (
            patch(
                "stt_v2.transcription.api.routes.get_pipeline_reader",
                return_value=mock_reader,
            ),
            patch(
                "stt_v2.transcription.api.routes.get_batch_service",
                return_value=mock_service,
            ),
        ):
            resp = await transcribe_audio(
                file=upload,
                pipeline_id=pid,
                tenant_id="t-456",
            )

            mock_reader.get_pipeline.assert_called_once_with(pid)
            assert resp.text == "Hello world"

    @pytest.mark.asyncio
    async def test_pipeline_config_used_directly(self):
        """Pipeline inference config is used as-is without per-request overrides."""
        upload = _make_upload_file()
        result = _make_transcription_result()

        pipeline_mock = _make_pipeline_mock(language="en")

        mock_reader = AsyncMock()
        mock_reader.get_pipeline_by_slug = AsyncMock(return_value=pipeline_mock)

        mock_service = AsyncMock()
        mock_service.transcribe = AsyncMock(return_value=result)

        with (
            patch(
                "stt_v2.transcription.api.routes.get_pipeline_reader",
                return_value=mock_reader,
            ),
            patch(
                "stt_v2.transcription.api.routes.get_batch_service",
                return_value=mock_service,
            ),
        ):
            await transcribe_audio(
                file=upload,
                pipeline_id="slug",
                tenant_id="t-456",
            )

            # Pipeline config language remains unchanged
            assert pipeline_mock.spec.inference.language == "en"

    @pytest.mark.asyncio
    async def test_transcription_error_returns_500(self):
        """TranscriptionError from batch_service maps to 500."""
        upload = _make_upload_file()
        from stt_v2.core.exceptions import TranscriptionError

        mock_reader = AsyncMock()
        mock_reader.get_pipeline_by_slug = AsyncMock(
            return_value=_make_pipeline_mock(language=None),
        )

        mock_service = AsyncMock()
        mock_service.transcribe = AsyncMock(
            side_effect=TranscriptionError("ASR model exploded"),
        )

        with (
            patch(
                "stt_v2.transcription.api.routes.get_pipeline_reader",
                return_value=mock_reader,
            ),
            patch(
                "stt_v2.transcription.api.routes.get_batch_service",
                return_value=mock_service,
            ),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await transcribe_audio(
                    file=upload,
                    pipeline_id="slug",
                    tenant_id="t-456",
                )

            assert exc_info.value.status_code == 500
            assert "TRANSCRIPTION_ERROR" in str(exc_info.value.detail)

    @pytest.mark.asyncio
    async def test_validation_error_returns_400(self):
        """ValidationError from batch_service maps to 400."""
        upload = _make_upload_file()
        from stt_v2.core.exceptions import ValidationError

        mock_reader = AsyncMock()
        mock_reader.get_pipeline_by_slug = AsyncMock(
            return_value=_make_pipeline_mock(language=None),
        )

        mock_service = AsyncMock()
        mock_service.transcribe = AsyncMock(
            side_effect=ValidationError("Bad config"),
        )

        with (
            patch(
                "stt_v2.transcription.api.routes.get_pipeline_reader",
                return_value=mock_reader,
            ),
            patch(
                "stt_v2.transcription.api.routes.get_batch_service",
                return_value=mock_service,
            ),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await transcribe_audio(
                    file=upload,
                    pipeline_id="slug",
                    tenant_id="t-456",
                )

            assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    async def test_successful_transcription(self):
        """Full happy-path: upload → transcribe → response."""
        upload = _make_upload_file()
        result = _make_transcription_result()

        mock_reader = AsyncMock()
        mock_reader.get_pipeline_by_slug = AsyncMock(
            return_value=_make_pipeline_mock(language="en", slug="test-pipeline"),
        )

        mock_service = AsyncMock()
        mock_service.transcribe = AsyncMock(return_value=result)

        with (
            patch(
                "stt_v2.transcription.api.routes.get_pipeline_reader",
                return_value=mock_reader,
            ),
            patch(
                "stt_v2.transcription.api.routes.get_batch_service",
                return_value=mock_service,
            ),
        ):
            resp = await transcribe_audio(
                file=upload,
                pipeline_id="test-pipeline",
                tenant_id="t-456",
                consultation_id="c-789",
            )

            assert isinstance(resp, TranscriptionResponse)
            assert resp.text == "Hello world"
            assert resp.language == "en"
            assert resp.language_probability == 0.95
            assert resp.processing_time_seconds == 1.2
            assert len(resp.word_timestamps) == 2
            assert resp.timing is not None
            assert resp.timing.ttfw_seconds == 0.5

            # Verify batch_service was called with correct args
            mock_service.transcribe.assert_called_once()
            call_kwargs = mock_service.transcribe.call_args
            assert call_kwargs.kwargs["tenant_id"] == "t-456"
            assert call_kwargs.kwargs["consultation_id"] == "c-789"

    @pytest.mark.asyncio
    async def test_code_switching_override_applied_to_pipeline(self):
        """Explicit code_switching form field should override pipeline inference config."""
        upload = _make_upload_file()
        result = _make_transcription_result()

        pipeline_mock = _make_pipeline_mock(language="en")
        mock_reader = AsyncMock()
        mock_reader.get_pipeline_by_slug = AsyncMock(return_value=pipeline_mock)

        mock_service = AsyncMock()
        mock_service.transcribe = AsyncMock(return_value=result)

        with (
            patch(
                "stt_v2.transcription.api.routes.get_pipeline_reader",
                return_value=mock_reader,
            ),
            patch(
                "stt_v2.transcription.api.routes.get_batch_service",
                return_value=mock_service,
            ),
        ):
            await transcribe_audio(
                file=upload,
                pipeline_id="test-pipeline",
                tenant_id="t-456",
                code_switching=True,
            )

        assert pipeline_mock.spec.inference.code_switching is True
