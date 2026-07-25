"""Unit tests for streaming inference embedding separation (S3).

Tests:
- _extract_embedding: guards for disabled/short/no-tenant
- _identify_speaker: known speaker, no embedding
- process_utterance full pipeline order: embed -> asr -> diarize -> punctuate
"""

from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt.streaming.inference import StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance


def _make_utterance(duration_s: float = 2.0, sr: int = 16000) -> AudioUtterance:
    n_samples = int(duration_s * sr)
    return AudioUtterance(
        samples=np.random.randn(n_samples).astype(np.float32) * 0.1,
        sample_rate=sr,
        start_time=0.0,
        end_time=duration_s,
        utterance_index=0,
        is_final=True,
    )


class TestExtractEmbedding:

    @pytest.mark.asyncio
    async def test_diarization_disabled_returns_none(self):
        """When diarization is disabled, _extract_embedding should return None."""
        worker = StreamingInferenceWorker(
            result_publisher=None,
            asr_pipeline=None,
            tenant_id="t1",
            diarization_config=MagicMock(enabled=False),
        )
        utt = _make_utterance()
        result = await worker._extract_embedding(utt)
        assert result is None

    @pytest.mark.asyncio
    async def test_no_tenant_returns_none(self):
        """Without tenant_id, _extract_embedding returns None."""
        worker = StreamingInferenceWorker(
            result_publisher=None,
            asr_pipeline=None,
            tenant_id=None,
            diarization_config=MagicMock(enabled=True),
        )
        utt = _make_utterance()
        result = await worker._extract_embedding(utt)
        assert result is None

    @pytest.mark.asyncio
    async def test_short_utterance_returns_none(self):
        """Utterances shorter than min_segment_duration_s should return None."""
        worker = StreamingInferenceWorker(
            result_publisher=None,
            asr_pipeline=None,
            tenant_id="t1",
            diarization_config=MagicMock(enabled=True, min_segment_duration_s=1.0),
        )
        utt = _make_utterance(duration_s=0.3)
        result = await worker._extract_embedding(utt)
        assert result is None

    @pytest.mark.asyncio
    async def test_extract_embedding_success(self):
        """Should call embedding service and return the embedding."""
        mock_embedding = MagicMock()
        mock_embedding.embedding = [0.1] * 512

        mock_emb_service = MagicMock()
        mock_emb_service.extract_from_samples = AsyncMock(return_value=mock_embedding)

        worker = StreamingInferenceWorker(
            result_publisher=None,
            asr_pipeline=None,
            tenant_id="t1",
            diarization_config=MagicMock(enabled=True, min_segment_duration_s=0.5),
        )
        utt = _make_utterance(duration_s=2.0)

        with patch(
            "stt.diarization.embedding_service.get_embedding_service",
            return_value=mock_emb_service,
        ):
            result = await worker._extract_embedding(utt)

        assert result is mock_embedding


class TestIdentifyWithEmbedding:

    @pytest.mark.asyncio
    async def test_known_speaker(self):
        """Should return speaker ID when embedding matches."""
        mock_match = MagicMock()
        mock_match.speaker_id = "spk-123"
        mock_match.confidence = 0.95

        mock_identifier = MagicMock()
        mock_identifier.identify = AsyncMock(return_value=mock_match)

        worker = StreamingInferenceWorker(
            result_publisher=None,
            asr_pipeline=None,
            tenant_id="t1",
            diarization_config=MagicMock(enabled=True),
            speaker_identifier=mock_identifier,
        )
        embedding = MagicMock()
        embedding.embedding = [0.1] * 512
        samples = np.random.randn(32000).astype(np.float32)

        sid, conf = await worker._identify_speaker(
            embedding, "hello world", samples=samples, sample_rate=16000,
        )

        assert sid == "spk-123"
        assert conf == 0.95

    @pytest.mark.asyncio
    async def test_no_embedding_returns_none(self):
        """When embedding is None, should return (None, None)."""
        worker = StreamingInferenceWorker(
            result_publisher=None,
            asr_pipeline=None,
            tenant_id="t1",
            diarization_config=MagicMock(enabled=True),
        )
        sid, conf = await worker._identify_speaker(None, "hello")
        assert sid is None
        assert conf is None


class TestProcessUtterancePipelineOrder:

    @pytest.mark.asyncio
    async def test_full_pipeline_order(self):
        """process_utterance should follow: embed -> asr -> diarize -> publish."""
        call_order = []

        async def mock_extract_embedding(utt):
            call_order.append("embed")
            return MagicMock(embedding=[0.1] * 512)

        async def mock_run_inference(utt):
            call_order.append("asr")
            from stt.streaming.inference import _InferenceResult

            return _InferenceResult(text="hello world")

        async def mock_identify_speaker(emb, text, samples=None, sample_rate=16000):
            call_order.append("diarize")
            return "spk-1", 0.9

        mock_publisher = AsyncMock()

        worker = StreamingInferenceWorker(
            result_publisher=mock_publisher,
            asr_pipeline=MagicMock(),
            tenant_id="t1",
            diarization_config=MagicMock(enabled=True),
        )
        worker._extract_embedding = mock_extract_embedding
        worker._run_inference = mock_run_inference
        worker._identify_speaker = mock_identify_speaker

        utt = _make_utterance()
        result = await worker.process_utterance("session-1", utt)

        assert call_order == ["embed", "asr", "diarize"]
        assert result.text == "hello world"
        assert result.speaker_id == "spk-1"

    @pytest.mark.asyncio
    async def test_partial_utterance_skips_embedding_and_diarization(self):
        """Partial utterances should run ASR only -- no embedding or diarization."""
        call_order = []

        async def mock_extract_embedding(utt):
            call_order.append("embed")
            return MagicMock(embedding=[0.1] * 512)

        async def mock_run_inference(utt):
            call_order.append("asr")
            from stt.streaming.inference import _InferenceResult

            return _InferenceResult(text="partial text")

        async def mock_identify_speaker(emb, text, samples=None, sample_rate=16000):
            call_order.append("diarize")
            return "spk-1", 0.9

        mock_publisher = AsyncMock()

        worker = StreamingInferenceWorker(
            result_publisher=mock_publisher,
            asr_pipeline=MagicMock(),
            tenant_id="t1",
            diarization_config=MagicMock(enabled=True),
        )
        worker._extract_embedding = mock_extract_embedding
        worker._run_inference = mock_run_inference
        worker._identify_speaker = mock_identify_speaker

        utt = AudioUtterance(
            samples=np.random.randn(32000).astype(np.float32) * 0.1,
            sample_rate=16000,
            start_time=0.0,
            end_time=2.0,
            utterance_index=0,
            is_final=False,
        )
        result = await worker.process_utterance("session-1", utt)

        assert call_order == ["asr"]
        assert "embed" not in call_order
        assert "diarize" not in call_order
        assert result.text == "partial text"
        assert result.is_final is False
        assert result.speaker_id is None
