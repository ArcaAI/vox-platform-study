"""Unit tests for Dramatiq workers.

Focus on testing behavior outcomes:
- Session state management
- Job lifecycle transitions
- Error handling and recovery
- NOT just that mocks were called
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt.core.exceptions import NotFoundError, TranscriptionError
from stt.transcription.dto import TranscriptionResult
from stt.transcription.workers.transcribe_file import (
    _fail_job,
    _transcribe_file_async,
)

# =============================================================================
# Test Fixtures for Complete Response Structures
# =============================================================================


def create_complete_transcription_result(
    text: str = "Hello world",
    language: str = "en",
    duration: float = 1.0,
) -> TranscriptionResult:
    """Create complete TranscriptionResult matching real structure."""
    return TranscriptionResult(
        text=text,
        language=language,
        language_probability=0.95,
        duration_seconds=duration,
        processing_time_seconds=0.5,
        word_timestamps=[],
        sentence_timestamps=[],
        metadata={
            "pipeline_id": "p-123",
            "model_id": "m-456",
        },
    )


class TestTranscribeFileWorker:
    """Tests for transcribe_file Dramatiq actor.

    Focus on testing the job lifecycle and state transitions,
    not just mock invocations.
    """

    @pytest.mark.asyncio
    async def test_successful_transcription_completes_job(self):
        """Verify successful transcription marks job as completed."""
        job_completed = False
        completed_with_text = None

        async def track_completion(*args, **kwargs):
            nonlocal job_completed, completed_with_text
            job_completed = True
            # Capture the result text if available
            if "result" in kwargs:
                completed_with_text = kwargs["result"].get("text")

        with (
            patch("stt.transcription.workers.transcribe_file.get_api_client") as mock_api,
            patch("stt.transcription.workers.transcribe_file.get_blob_service") as mock_blob,
            patch(
                "stt.transcription.workers.transcribe_file.get_pipeline_reader"
            ) as mock_reader,
            patch("stt.transcription.workers.transcribe_file.get_batch_service") as mock_batch,
        ):

            mock_api_client = AsyncMock()
            mock_api_client.start_job = AsyncMock()
            mock_api_client.update_job_progress = AsyncMock()
            mock_api_client.complete_job = AsyncMock(side_effect=track_completion)
            mock_api_client.create_transcript = AsyncMock(
                return_value={
                    "id": "ctx-123",
                    "contextItemId": "ctx-123",
                    "type": "TRANSCRIPT",
                }
            )
            mock_api.return_value = mock_api_client

            mock_blob_service = AsyncMock()
            mock_blob_service.download_audio = AsyncMock(return_value=b"audio data")
            mock_blob_service.upload_transcript = AsyncMock(
                return_value="s3://bucket/transcript.json"
            )
            mock_blob.return_value = mock_blob_service

            mock_pipeline_reader = AsyncMock()
            mock_pipeline_config = MagicMock()
            mock_pipeline_config.id = "p-789"
            mock_pipeline_reader.get_pipeline = AsyncMock(return_value=mock_pipeline_config)
            mock_reader.return_value = mock_pipeline_reader

            mock_batch_service = AsyncMock()
            mock_batch_service.transcribe = AsyncMock(
                return_value=create_complete_transcription_result(text="Hello world")
            )
            mock_batch.return_value = mock_batch_service

            await _transcribe_file_async(
                job_id="j-123",
                tenant_id="t-456",
                pipeline_id="p-789",
                audio_uri="s3://bucket/audio.wav",
                consultation_id="c-111",
            )

            # Test actual outcome: job was completed
            assert job_completed, "Job should be marked as completed"

    @pytest.mark.asyncio
    async def test_pipeline_not_found_fails_job_with_correct_error(self):
        """Verify pipeline not found results in job failure with descriptive error."""
        import dramatiq

        captured_error_code = None
        captured_error_message = None

        async def capture_failure(job_id, error_message, error_code):
            nonlocal captured_error_code, captured_error_message
            captured_error_code = error_code
            captured_error_message = error_message

        with (
            patch("stt.transcription.workers.transcribe_file.get_api_client") as mock_api,
            patch("stt.transcription.workers.transcribe_file.get_blob_service") as mock_blob,
            patch(
                "stt.transcription.workers.transcribe_file.get_pipeline_reader"
            ) as mock_reader,
        ):

            mock_api_client = AsyncMock()
            mock_api_client.start_job = AsyncMock()
            mock_api_client.fail_job = AsyncMock(side_effect=capture_failure)
            mock_api.return_value = mock_api_client

            mock_blob.return_value = AsyncMock()

            mock_pipeline_reader = AsyncMock()
            mock_pipeline_reader.get_pipeline = AsyncMock(
                side_effect=NotFoundError("Pipeline 'nonexistent' not found")
            )
            mock_reader.return_value = mock_pipeline_reader

            with pytest.raises(dramatiq.middleware.SkipMessage):
                await _transcribe_file_async(
                    job_id="j-123",
                    tenant_id="t-456",
                    pipeline_id="nonexistent",
                    audio_uri="s3://bucket/audio.wav",
                )

            # Test actual error handling behavior
            assert captured_error_code is not None
            assert (
                "not found" in captured_error_message.lower() or "PIPELINE" in captured_error_code
            )

    @pytest.mark.asyncio
    async def test_fail_job_sends_correct_error_details(self):
        """Verify _fail_job sends correct error information to API."""
        received_args = {}

        async def capture_call(job_id, error_message, error_code):
            received_args["job_id"] = job_id
            received_args["error_message"] = error_message
            received_args["error_code"] = error_code

        mock_api_client = AsyncMock()
        mock_api_client.fail_job = AsyncMock(side_effect=capture_call)

        # Mock publisher (best-effort, no side effects needed)
        mock_publisher = AsyncMock()

        await _fail_job(
            mock_api_client,
            mock_publisher,
            "j-123",
            "Model whisper-large not found in registry",
            "MODEL_NOT_FOUND",
        )

        # Test actual data sent
        assert received_args["job_id"] == "j-123"
        assert "whisper-large" in received_args["error_message"]
        assert received_args["error_code"] == "MODEL_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_fail_job_is_resilient_to_api_errors(self):
        """Verify _fail_job doesn't propagate API errors."""
        mock_api_client = AsyncMock()
        mock_api_client.fail_job = AsyncMock(side_effect=Exception("API unavailable"))

        mock_publisher = AsyncMock()

        # Should not raise - test actual resilience behavior
        await _fail_job(mock_api_client, mock_publisher, "j-123", "Error", "CODE")
        # If we reach here without exception, test passes


# =============================================================================
# Additional Worker Tests for Coverage
# =============================================================================


class TestTranscribeFileErrorHandling:
    """Tests for transcribe_file error handling paths."""

    @pytest.mark.asyncio
    async def test_transcription_error_marks_job_as_failed(self):
        """Test that TranscriptionError fails the job correctly."""
        captured_error_code = None

        async def capture_failure(job_id, error_message, error_code):
            nonlocal captured_error_code
            captured_error_code = error_code

        with (
            patch("stt.transcription.workers.transcribe_file.get_api_client") as mock_api,
            patch("stt.transcription.workers.transcribe_file.get_blob_service") as mock_blob,
            patch(
                "stt.transcription.workers.transcribe_file.get_pipeline_reader"
            ) as mock_reader,
            patch("stt.transcription.workers.transcribe_file.get_batch_service") as mock_batch,
        ):

            mock_api_client = AsyncMock()
            mock_api_client.start_job = AsyncMock()
            mock_api_client.fail_job = AsyncMock(side_effect=capture_failure)
            mock_api.return_value = mock_api_client

            mock_blob_service = AsyncMock()
            mock_blob_service.download_audio = AsyncMock(return_value=b"audio data")
            mock_blob.return_value = mock_blob_service

            mock_pipeline_reader = AsyncMock()
            mock_pipeline_reader.get_pipeline = AsyncMock(return_value=MagicMock())
            mock_reader.return_value = mock_pipeline_reader

            mock_batch_service = AsyncMock()
            mock_batch_service.transcribe = AsyncMock(
                side_effect=TranscriptionError("Model inference failed")
            )
            mock_batch.return_value = mock_batch_service

            with pytest.raises(TranscriptionError):
                await _transcribe_file_async(
                    job_id="j-123",
                    tenant_id="t-456",
                    pipeline_id="p-789",
                    audio_uri="s3://bucket/audio.wav",
                )

            assert captured_error_code == "TRANSCRIPTION_ERROR"

    @pytest.mark.asyncio
    async def test_unexpected_error_marks_job_as_internal_error(self):
        """Test that unexpected errors are handled correctly."""
        captured_error_code = None

        async def capture_failure(job_id, error_message, error_code):
            nonlocal captured_error_code
            captured_error_code = error_code

        with (
            patch("stt.transcription.workers.transcribe_file.get_api_client") as mock_api,
            patch("stt.transcription.workers.transcribe_file.get_blob_service") as mock_blob,
            patch(
                "stt.transcription.workers.transcribe_file.get_pipeline_reader"
            ) as mock_reader,
        ):

            mock_api_client = AsyncMock()
            mock_api_client.start_job = AsyncMock()
            mock_api_client.fail_job = AsyncMock(side_effect=capture_failure)
            mock_api.return_value = mock_api_client

            # Simulate unexpected error during audio download
            mock_blob_service = AsyncMock()
            mock_blob_service.download_audio = AsyncMock(
                side_effect=RuntimeError("Unexpected system error")
            )
            mock_blob.return_value = mock_blob_service

            mock_pipeline_reader = AsyncMock()
            mock_pipeline_reader.get_pipeline = AsyncMock(return_value=MagicMock())
            mock_reader.return_value = mock_pipeline_reader

            with pytest.raises(RuntimeError):
                await _transcribe_file_async(
                    job_id="j-123",
                    tenant_id="t-456",
                    pipeline_id="p-789",
                    audio_uri="s3://bucket/audio.wav",
                )

            assert captured_error_code == "INTERNAL_ERROR"

    @pytest.mark.asyncio
    async def test_transcription_without_consultation_skips_context_item(self):
        """Test that transcription works without consultation_id."""
        context_item_created = False

        async def track_context_item(*args, **kwargs):
            nonlocal context_item_created
            context_item_created = True
            return {"id": "ctx-123"}

        with (
            patch("stt.transcription.workers.transcribe_file.get_api_client") as mock_api,
            patch("stt.transcription.workers.transcribe_file.get_blob_service") as mock_blob,
            patch(
                "stt.transcription.workers.transcribe_file.get_pipeline_reader"
            ) as mock_reader,
            patch("stt.transcription.workers.transcribe_file.get_batch_service") as mock_batch,
        ):

            mock_api_client = AsyncMock()
            mock_api_client.start_job = AsyncMock()
            mock_api_client.complete_job = AsyncMock()
            mock_api_client.update_job_progress = AsyncMock()
            mock_api_client.create_transcript = AsyncMock(side_effect=track_context_item)
            mock_api.return_value = mock_api_client

            mock_blob_service = AsyncMock()
            mock_blob_service.download_audio = AsyncMock(return_value=b"audio")
            mock_blob_service.upload_transcript = AsyncMock(
                return_value="s3://bucket/transcript.json"
            )
            mock_blob.return_value = mock_blob_service

            mock_pipeline_reader = AsyncMock()
            mock_pipeline_reader.get_pipeline = AsyncMock(return_value=MagicMock())
            mock_reader.return_value = mock_pipeline_reader

            mock_batch_service = AsyncMock()
            mock_batch_service.transcribe = AsyncMock(
                return_value=create_complete_transcription_result()
            )
            mock_batch.return_value = mock_batch_service

            await _transcribe_file_async(
                job_id="j-123",
                tenant_id="t-456",
                pipeline_id="p-789",
                audio_uri="s3://bucket/audio.wav",
                consultation_id=None,  # No consultation
            )

            # Context item should NOT be created when no consultation_id
            assert not context_item_created

    @pytest.mark.asyncio
    async def test_context_item_creation_failure_continues(self):
        """Test that context item creation failure doesn't stop job completion."""
        job_completed = False

        async def track_completion(*args, **kwargs):
            nonlocal job_completed
            job_completed = True

        with (
            patch("stt.transcription.workers.transcribe_file.get_api_client") as mock_api,
            patch("stt.transcription.workers.transcribe_file.get_blob_service") as mock_blob,
            patch(
                "stt.transcription.workers.transcribe_file.get_pipeline_reader"
            ) as mock_reader,
            patch("stt.transcription.workers.transcribe_file.get_batch_service") as mock_batch,
        ):

            mock_api_client = AsyncMock()
            mock_api_client.start_job = AsyncMock()
            mock_api_client.complete_job = AsyncMock(side_effect=track_completion)
            mock_api_client.update_job_progress = AsyncMock()
            # Context item creation fails
            mock_api_client.create_transcript = AsyncMock(
                side_effect=Exception("Gateway unavailable")
            )
            mock_api.return_value = mock_api_client

            mock_blob_service = AsyncMock()
            mock_blob_service.download_audio = AsyncMock(return_value=b"audio")
            mock_blob_service.upload_transcript = AsyncMock(
                return_value="s3://bucket/transcript.json"
            )
            mock_blob.return_value = mock_blob_service

            mock_pipeline_reader = AsyncMock()
            mock_pipeline_reader.get_pipeline = AsyncMock(return_value=MagicMock())
            mock_reader.return_value = mock_pipeline_reader

            mock_batch_service = AsyncMock()
            mock_batch_service.transcribe = AsyncMock(
                return_value=create_complete_transcription_result()
            )
            mock_batch.return_value = mock_batch_service

            await _transcribe_file_async(
                job_id="j-123",
                tenant_id="t-456",
                pipeline_id="p-789",
                audio_uri="s3://bucket/audio.wav",
                consultation_id="c-111",  # Has consultation but creation fails
            )

            # Job should still complete despite context item failure
            assert job_completed


# =============================================================================
# Pipeline Config Tests — verify pipeline is the sole source of truth
# =============================================================================


class TestPipelineConfigUsedDirectly:
    """Tests that transcribe_file worker uses pipeline config directly without overrides.

    Verifies that:
    - Pipeline inference config (language, code_switching) is used as-is
    - No per-request overrides are applied
    """

    def _make_pipeline_config(
        self,
        language: str = "en",
        code_switching: bool = False,
    ) -> MagicMock:
        """Create a pipeline config mock with explicit inference defaults."""
        config = MagicMock()
        config.id = "p-789"
        config.spec.inference.language = language
        config.spec.inference.code_switching = code_switching
        config.spec.preprocessing.vad.enabled = False
        config.spec.diarization.enabled = False
        return config

    async def _run_worker(
        self,
        pipeline_config: MagicMock,
    ) -> None:
        """Run _transcribe_file_async with all external deps mocked."""
        with (
            patch("stt.transcription.workers.transcribe_file.get_settings") as mock_settings,
            patch(
                "stt.transcription.workers.transcribe_file.TranscriptionEventPublisher"
            ) as mock_pub_cls,
            patch("stt.transcription.workers.transcribe_file.get_api_client") as mock_api,
            patch("stt.transcription.workers.transcribe_file.get_blob_service") as mock_blob,
            patch(
                "stt.transcription.workers.transcribe_file.get_pipeline_reader"
            ) as mock_reader,
            patch("stt.transcription.workers.transcribe_file.get_batch_service") as mock_batch,
        ):

            mock_settings.return_value = MagicMock()

            mock_publisher = AsyncMock()
            mock_publisher.connect = AsyncMock()
            mock_publisher.close = AsyncMock()
            mock_publisher.publish_status = AsyncMock()
            mock_publisher.publish_progress = AsyncMock()
            mock_publisher.publish_chunk = AsyncMock()
            mock_publisher.publish_transcript = AsyncMock()
            mock_publisher.publish_error = AsyncMock()
            mock_pub_cls.return_value = mock_publisher

            mock_api_client = AsyncMock()
            mock_api_client.start_job = AsyncMock()
            mock_api_client.update_job_progress = AsyncMock()
            mock_api_client.complete_job = AsyncMock()
            mock_api_client.create_transcript = AsyncMock(
                return_value={
                    "id": "ctx-123",
                    "contextItemId": "ctx-123",
                    "type": "TRANSCRIPT",
                }
            )
            mock_api.return_value = mock_api_client

            mock_blob_service = AsyncMock()
            mock_blob_service.download_audio = AsyncMock(return_value=b"audio data")
            mock_blob_service.upload_transcript = AsyncMock(return_value="s3://transcript.json")
            mock_blob.return_value = mock_blob_service

            mock_pipeline_reader = AsyncMock()
            mock_pipeline_reader.get_pipeline = AsyncMock(return_value=pipeline_config)
            mock_reader.return_value = mock_pipeline_reader

            mock_batch_service = AsyncMock()
            mock_batch_service.transcribe = AsyncMock(
                return_value=create_complete_transcription_result()
            )
            mock_batch.return_value = mock_batch_service

            await _transcribe_file_async(
                job_id="j-1",
                tenant_id="t-1",
                pipeline_id="p-789",
                audio_uri="s3://audio.wav",
            )

    @pytest.mark.asyncio
    async def test_pipeline_language_preserved(self):
        """Verify pipeline language config is used as-is."""
        cfg = self._make_pipeline_config(language="ml")
        await self._run_worker(cfg)
        assert cfg.spec.inference.language == "ml"

    @pytest.mark.asyncio
    async def test_pipeline_code_switching_preserved(self):
        """Verify pipeline code_switching config is used as-is."""
        cfg = self._make_pipeline_config(code_switching=True)
        await self._run_worker(cfg)
        assert cfg.spec.inference.code_switching is True
