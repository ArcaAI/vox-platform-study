"""Unit tests for StreamingInferenceWorker."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt_v2.streaming.inference import StreamingInferenceWorker
from stt_v2.streaming.preprocessor import AudioUtterance
from stt_v2.streaming.schemas import SegmentResult


# =========================================================================
# Helpers
# =========================================================================


def _make_utterance(
    index: int = 0,
    duration_s: float = 1.0,
    is_final: bool = False,
) -> AudioUtterance:
    """Create a dummy AudioUtterance for testing."""
    samples = np.random.randn(int(16000 * duration_s)).astype(np.float32)
    return AudioUtterance(
        samples=samples,
        sample_rate=16000,
        start_time=index * duration_s,
        end_time=(index + 1) * duration_s,
        utterance_index=index,
        is_final=is_final,
    )


# =========================================================================
# Tests: Initialization
# =========================================================================


class TestInferenceWorkerInit:

    def test_no_pipeline(self):
        worker = StreamingInferenceWorker()
        assert worker.has_pipeline is False

    def test_with_pipeline(self):
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "hello")
        assert worker.has_pipeline is True


# =========================================================================
# Tests: process_utterance
# =========================================================================


class TestProcessUtterance:

    @pytest.mark.asyncio
    async def test_no_pipeline_returns_empty(self):
        """Without ASR pipeline, text should be empty."""
        worker = StreamingInferenceWorker()
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert isinstance(result, SegmentResult)
        assert result.text == ""
        assert result.start_time == utt.start_time
        assert result.end_time == utt.end_time
        assert result.is_final is False

    @pytest.mark.asyncio
    async def test_sync_pipeline_returns_string(self):
        """Sync pipeline returning a string."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda samples, sr: "hello world"
        )
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == "hello world"

    @pytest.mark.asyncio
    async def test_sync_pipeline_returns_dict(self):
        """Sync pipeline returning a dict with text key."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda samples, sr: {"text": "from dict"}
        )
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == "from dict"

    @pytest.mark.asyncio
    async def test_async_pipeline(self):
        """Async pipeline should be awaited."""
        async def _asr(samples, sr):
            return "async result"

        worker = StreamingInferenceWorker(asr_pipeline=_asr)
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == "async result"

    @pytest.mark.asyncio
    async def test_pipeline_error_returns_empty(self):
        """Pipeline error should not crash — returns empty text."""
        def _failing_pipeline(samples, sr):
            raise RuntimeError("Model crashed")

        worker = StreamingInferenceWorker(asr_pipeline=_failing_pipeline)
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == ""
        assert result.start_time == utt.start_time

    @pytest.mark.asyncio
    async def test_timing_preserved(self):
        """Result should preserve utterance timing."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "test"
        )
        utt = _make_utterance(index=3, duration_s=2.5)

        result = await worker.process_utterance("sess-1", utt)

        assert result.start_time == 3 * 2.5
        assert result.end_time == 4 * 2.5
        assert result.is_final is False

    @pytest.mark.asyncio
    async def test_final_flag_preserved(self):
        """is_final should pass through to SegmentResult."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "final"
        )
        utt = _make_utterance(is_final=True)

        result = await worker.process_utterance("sess-1", utt)

        assert result.is_final is True

    @pytest.mark.asyncio
    async def test_sanitizes_chevron_spam(self):
        """Pathological leading chevron spam should be removed."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: ">> >> >> >> hello world"
        )
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == "hello world"

    @pytest.mark.asyncio
    async def test_applies_speaker_identification_when_enabled(self):
        """When diarization is enabled, result should include speaker metadata."""
        diarization_cfg = MagicMock()
        diarization_cfg.enabled = True
        diarization_cfg.min_segment_duration_s = 0.1

        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "hello diarization",
            tenant_id="tenant-1",
            consultation_id="consult-1",
            diarization_config=diarization_cfg,
        )
        utt = _make_utterance(duration_s=1.2)

        mock_identifier = MagicMock()
        mock_identifier.identify_speaker = AsyncMock(
            return_value=MagicMock(speaker_id="speaker-abc", confidence=0.93)
        )

        with patch(
            "stt_v2.diarization.speaker_identifier.get_speaker_identifier",
            return_value=mock_identifier,
        ):
            result = await worker.process_utterance("sess-1", utt)

        assert result.speaker_id == "speaker-abc"
        assert result.speaker_confidence == pytest.approx(0.93)


# =========================================================================
# Tests: Result publishing
# =========================================================================


class TestResultPublishing:

    @pytest.mark.asyncio
    async def test_publishes_result(self):
        """Result should be published via ResultPublisher."""
        publisher = AsyncMock()

        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: "published text",
        )
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        publisher.publish.assert_awaited_once()
        published_result = publisher.publish.call_args[0][0]
        assert isinstance(published_result, SegmentResult)
        assert published_result.text == "published text"

    @pytest.mark.asyncio
    async def test_no_publisher_no_error(self):
        """No publisher configured should not crash."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "no pub"
        )
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == "no pub"

    @pytest.mark.asyncio
    async def test_publish_error_does_not_crash(self):
        """Publisher error should not crash the worker."""
        publisher = AsyncMock()
        publisher.publish = AsyncMock(side_effect=RuntimeError("Redis down"))

        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: "works",
        )
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        # Should still return the result even if publishing failed
        assert result.text == "works"


# =========================================================================
# Tests: Pipeline return type edge cases
# =========================================================================


class TestPipelineReturnTypes:
    """Test that various pipeline return types are handled correctly."""

    @pytest.mark.asyncio
    async def test_pipeline_returns_integer(self):
        """Pipeline returning an integer should be str()-ified."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: 42
        )
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == "42"

    @pytest.mark.asyncio
    async def test_pipeline_returns_dict_without_text(self):
        """Pipeline returning a dict without 'text' key returns empty."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: {"confidence": 0.95}
        )
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_pipeline_returns_empty_string(self):
        """Pipeline returning empty string is valid."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: ""
        )
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_pipeline_returns_none_via_dict(self):
        """Pipeline returning dict with None text should yield empty string."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: {"text": None}
        )
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        # dict.get("text") returns None → `or ""` coerces to empty string
        assert result.text == ""

    @pytest.mark.asyncio
    async def test_async_pipeline_error(self):
        """Async pipeline that throws should be handled gracefully."""
        async def _failing_async(samples, sr):
            raise ValueError("Async model error")

        worker = StreamingInferenceWorker(asr_pipeline=_failing_async)
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_pipeline_receives_correct_args(self):
        """Pipeline should receive the utterance samples and sample_rate."""
        received_args = {}

        def _capture_pipeline(samples, sr):
            received_args["samples_shape"] = samples.shape
            received_args["sample_rate"] = sr
            return "captured"

        worker = StreamingInferenceWorker(asr_pipeline=_capture_pipeline)
        utt = _make_utterance(duration_s=0.5)

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == "captured"
        assert received_args["sample_rate"] == 16000
        assert received_args["samples_shape"] == (8000,)  # 0.5s * 16000

    @pytest.mark.asyncio
    async def test_multiple_utterances_sequential(self):
        """Processing multiple utterances sequentially should work."""
        call_count = 0

        def _counting_pipeline(samples, sr):
            nonlocal call_count
            call_count += 1
            return f"utterance {call_count}"

        publisher = AsyncMock()
        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=_counting_pipeline,
        )

        results = []
        for i in range(5):
            utt = _make_utterance(index=i)
            result = await worker.process_utterance("sess-1", utt)
            results.append(result)

        assert len(results) == 5
        assert results[0].text == "utterance 1"
        assert results[4].text == "utterance 5"
        assert publisher.publish.await_count == 5
