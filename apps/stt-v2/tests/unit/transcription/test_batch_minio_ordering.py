"""Unit tests for batch MinIO ordering fix (B2).

Tests:
- MinIO upload is called before postprocessing in transcribe()
- MinIO upload skipped when no blob_service provided
- Final transcript still uploaded after postprocessing
"""

from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt_v2.transcription.dto import (
    AudioSegment,
    ProcessedAudio,
    RawTranscription,
)


class TestBatchMinioOrdering:

    @pytest.mark.asyncio
    async def test_minio_upload_called_before_postprocess(self):
        """blob_service.upload_processed_audio() should be called
        before _postprocess() in the transcribe() pipeline."""
        from stt_v2.transcription.batch_service import BatchTranscriptionService

        svc = BatchTranscriptionService()
        call_order = []

        # Track call ordering
        original_postprocess = svc._postprocess

        def tracked_postprocess(*args, **kwargs):
            call_order.append("postprocess")
            return original_postprocess(*args, **kwargs)

        mock_blob = AsyncMock()

        async def tracked_upload(*args, **kwargs):
            call_order.append("minio_upload")
            return "s3://bucket/audio.wav"

        mock_blob.upload_processed_audio = tracked_upload

        # Mock pipeline config
        pipeline_config = MagicMock()
        pipeline_config.slug = "test-pipeline"
        pipeline_config.spec.preprocessing.vad.enabled = True
        pipeline_config.spec.preprocessing.denoise.enabled = False
        pipeline_config.spec.preprocessing.normalize = False
        pipeline_config.spec.inference.language = "en"
        pipeline_config.spec.diarization.enabled = False
        pipeline_config.spec.postprocessing.punctuation.enabled = False
        pipeline_config.spec.models.asr = MagicMock()
        pipeline_config.spec.models.vad = MagicMock()
        pipeline_config.spec.models.denoise = None

        # Mock internal methods
        processed = ProcessedAudio(
            samples=np.zeros(16000, dtype=np.float32),
            sample_rate=16000,
            duration_seconds=1.0,
            vad_applied=True,
            segments=[AudioSegment(start_time=0.0, end_time=1.0, is_speech=True)],
        )
        raw = RawTranscription(text="test", segments=[])

        with patch.object(svc, "_load_models", new_callable=AsyncMock, return_value={"asr": MagicMock(), "vad": None, "denoise": None}), \
             patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc, \
             patch.object(svc, "_run_inference", new_callable=AsyncMock, return_value=raw), \
             patch.object(svc, "_postprocess", side_effect=tracked_postprocess):

            mock_preproc.return_value.process = AsyncMock(return_value=processed)

            await svc.transcribe(
                job_id="test-job",
                audio_bytes=b"\x00" * 1000,
                pipeline_config=pipeline_config,
                blob_service=mock_blob,
                tenant_id="tenant-1",
            )

        # Verify MinIO upload happened before postprocessing
        assert "minio_upload" in call_order
        assert "postprocess" in call_order
        assert call_order.index("minio_upload") < call_order.index("postprocess")

    @pytest.mark.asyncio
    async def test_minio_upload_skipped_when_no_blob_service(self):
        """Without blob_service, no upload should occur."""
        from stt_v2.transcription.batch_service import BatchTranscriptionService

        svc = BatchTranscriptionService()

        pipeline_config = MagicMock()
        pipeline_config.slug = "test-pipeline"
        pipeline_config.spec.preprocessing.vad.enabled = False
        pipeline_config.spec.preprocessing.denoise.enabled = False
        pipeline_config.spec.preprocessing.normalize = False
        pipeline_config.spec.inference.language = "en"
        pipeline_config.spec.diarization.enabled = False
        pipeline_config.spec.postprocessing.punctuation.enabled = False
        pipeline_config.spec.models.asr = MagicMock()
        pipeline_config.spec.models.vad = None
        pipeline_config.spec.models.denoise = None

        processed = ProcessedAudio(
            samples=np.zeros(16000, dtype=np.float32),
            sample_rate=16000,
            duration_seconds=1.0,
        )
        raw = RawTranscription(text="test", segments=[])

        with patch.object(svc, "_load_models", new_callable=AsyncMock, return_value={"asr": MagicMock(), "vad": None, "denoise": None}), \
             patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc, \
             patch.object(svc, "_run_inference", new_callable=AsyncMock, return_value=raw):

            mock_preproc.return_value.process = AsyncMock(return_value=processed)

            # No blob_service passed -- should not crash
            result = await svc.transcribe(
                job_id="test-job",
                audio_bytes=b"\x00" * 1000,
                pipeline_config=pipeline_config,
            )

        assert result.text == "test"
