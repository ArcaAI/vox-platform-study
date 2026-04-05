"""Unit tests for batch embedding separation (B1).

Tests:
- _split_vad_segments_for_embedding: short, long, non-speech
- Embedding extraction happens before ASR in transcribe()
- Diarization skipped => embedding step skipped
"""

from unittest.mock import AsyncMock, MagicMock, patch
import numpy as np
import pytest

from stt_v2.transcription.batch_service import BatchTranscriptionService
from stt_v2.transcription.dto import AudioSegment, ProcessedAudio


class TestSplitVadSegmentsForEmbedding:
    """Test the static helper that splits long VAD segments at 5s."""

    def test_short_segments_unchanged(self):
        """Segments <= max_window_s are returned unchanged."""
        segments = [
            AudioSegment(start_time=0.0, end_time=2.0, is_speech=True),
            AudioSegment(start_time=3.0, end_time=5.0, is_speech=True),
        ]
        result = BatchTranscriptionService._split_vad_segments_for_embedding(
            segments,
            max_window_s=5.0,
        )
        assert len(result) == 2
        assert result[0] == (0.0, 2.0)
        assert result[1] == (3.0, 5.0)

    def test_long_segment_split_at_5s(self):
        """A 12s segment should produce three chunks: 5s + 5s + 2s."""
        segments = [
            AudioSegment(start_time=0.0, end_time=12.0, is_speech=True),
        ]
        result = BatchTranscriptionService._split_vad_segments_for_embedding(
            segments,
            max_window_s=5.0,
        )
        assert len(result) == 3
        assert result[0] == (0.0, 5.0)
        assert result[1] == (5.0, 10.0)
        assert result[2] == (10.0, 12.0)

    def test_non_speech_skipped(self):
        """Non-speech segments should be excluded from output."""
        segments = [
            AudioSegment(start_time=0.0, end_time=2.0, is_speech=True),
            AudioSegment(start_time=2.0, end_time=4.0, is_speech=False),
            AudioSegment(start_time=4.0, end_time=6.0, is_speech=True),
        ]
        result = BatchTranscriptionService._split_vad_segments_for_embedding(
            segments,
            max_window_s=5.0,
        )
        assert len(result) == 2
        assert result[0] == (0.0, 2.0)
        assert result[1] == (4.0, 6.0)


class TestBatchEmbeddingSeparation:

    @pytest.mark.asyncio
    async def test_transcribe_extracts_embeddings_before_asr(self):
        """Embedding extraction (Step 2b) should happen BEFORE ASR (Step 3)."""
        svc = BatchTranscriptionService()
        call_order = []

        # Track call ordering
        original_inference = svc._run_inference

        async def tracked_inference(*args, **kwargs):
            call_order.append("asr")
            return MagicMock(text="test", segments=[], model_output=None)

        # Pipeline config with diarization enabled
        pipeline_config = MagicMock()
        pipeline_config.slug = "test-pipeline"
        pipeline_config.spec.preprocessing.vad.enabled = True
        pipeline_config.spec.preprocessing.denoise.enabled = False
        pipeline_config.spec.preprocessing.normalize = False
        pipeline_config.spec.inference.language = "en"
        pipeline_config.spec.diarization.enabled = True
        pipeline_config.spec.diarization.similarity_threshold = 0.6
        pipeline_config.spec.diarization.max_speakers = 10
        pipeline_config.spec.diarization.auto_register_speakers = True
        pipeline_config.spec.diarization.min_segment_duration_s = 0.5
        pipeline_config.spec.diarization.segment_silence_padding_ms = 0
        pipeline_config.spec.postprocessing.punctuation.enabled = False
        pipeline_config.spec.models.asr = MagicMock()
        pipeline_config.spec.models.vad = MagicMock()
        pipeline_config.spec.models.denoise = None
        pipeline_config.spec.models.diarization = MagicMock()
        pipeline_config.spec.models.diarization.is_inline = True
        pipeline_config.spec.models.diarization.inline.hf_model_id = "test-model"

        # Processed audio with VAD segments
        processed = ProcessedAudio(
            samples=np.zeros(32000, dtype=np.float32),
            sample_rate=16000,
            duration_seconds=2.0,
            vad_applied=True,
            segments=[AudioSegment(start_time=0.0, end_time=2.0, is_speech=True)],
        )

        # Mock embedding service
        mock_emb_service = AsyncMock()
        mock_embedding = MagicMock()
        mock_embedding.embedding = [0.1] * 512
        mock_emb_service.extract_batch = AsyncMock(return_value=[mock_embedding])

        async def tracked_extract_batch(*args, **kwargs):
            call_order.append("embedding")
            return [mock_embedding]

        mock_emb_service.extract_batch = tracked_extract_batch

        # Mock diarize_with_embeddings
        mock_identifier = MagicMock()
        mock_diarize_result = MagicMock()
        mock_diarize_result.applied = False
        mock_identifier.diarize_with_embeddings = AsyncMock(return_value=mock_diarize_result)

        with (
            patch.object(
                svc,
                "_load_models",
                new_callable=AsyncMock,
                return_value={"asr": MagicMock(), "vad": None, "denoise": None},
            ),
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(svc, "_run_inference", side_effect=tracked_inference),
            patch(
                "stt_v2.transcription.batch_service.EmbeddingService", return_value=mock_emb_service
            ),
            patch(
                "stt_v2.transcription.batch_service.get_speaker_identifier",
                return_value=mock_identifier,
            ),
        ):

            mock_preproc.return_value.process = AsyncMock(return_value=processed)

            result = await svc.transcribe(
                job_id="test-job",
                audio_bytes=b"\x00" * 1000,
                pipeline_config=pipeline_config,
                tenant_id="tenant-1",
            )

        # Embedding extraction should happen before ASR
        assert "embedding" in call_order, f"Expected 'embedding' in {call_order}"
        assert "asr" in call_order, f"Expected 'asr' in {call_order}"
        assert call_order.index("embedding") < call_order.index(
            "asr"
        ), f"Expected embedding before asr, got {call_order}"

    @pytest.mark.asyncio
    async def test_transcribe_no_diarization_skips_embedding(self):
        """When diarization is disabled, no embedding extraction occurs."""
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
        raw = MagicMock(text="test", segments=[], model_output=None)

        with (
            patch.object(
                svc,
                "_load_models",
                new_callable=AsyncMock,
                return_value={"asr": MagicMock(), "vad": None, "denoise": None},
            ),
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(svc, "_run_inference", new_callable=AsyncMock, return_value=raw),
            patch("stt_v2.transcription.batch_service.EmbeddingService") as mock_emb_cls,
        ):

            mock_preproc.return_value.process = AsyncMock(return_value=processed)

            result = await svc.transcribe(
                job_id="test-job",
                audio_bytes=b"\x00" * 1000,
                pipeline_config=pipeline_config,
                tenant_id="tenant-1",
            )

        # EmbeddingService should never be instantiated
        mock_emb_cls.assert_not_called()
