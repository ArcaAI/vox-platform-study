"""Unit tests for StreamingInferenceWorker."""

from __future__ import annotations

import itertools
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt.pipeline.dto import (
    PostprocessingConfig,
    PunctuationConfig,
    TimestampConfig,
)
from stt.streaming.inference import StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance
from stt.streaming.schemas import SegmentResult

# =========================================================================
# Helpers
# =========================================================================


def _make_utterance(
    index: int = 0,
    duration_s: float = 1.0,
    is_final: bool = False,
    rms_level: float | None = None,
) -> AudioUtterance:
    """Create a dummy AudioUtterance for testing.

    Parameters
    ----------
    rms_level:
        If provided, scale samples to have approximately this RMS level.
        Use a very small value (e.g. 0.001) for near-silence.
    """
    samples = np.random.randn(int(16000 * duration_s)).astype(np.float32)
    if rms_level is not None:
        current_rms = float(np.sqrt(np.mean(samples**2)))
        if current_rms > 0:
            samples = samples * (rms_level / current_rms)
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

    def test_initial_prompt_stored(self):
        worker = StreamingInferenceWorker(initial_prompt="medical terms")
        assert worker._initial_prompt == "medical terms"

    def test_initial_prompt_default_none(self):
        worker = StreamingInferenceWorker()
        assert worker._initial_prompt is None


# =========================================================================
# Tests: process_utterance
# =========================================================================


class TestCumulativeProcessingSeconds:
    """Per-session running total of ASR-only processing
    time, read by SessionManager at teardown to compute the streaming RTF
    metric (stt_streaming_rtf). Distinct from stt_streaming_inference_latency_seconds
    (still observed unchanged): that is per-utterance, this is the session-wide sum."""

    def test_starts_at_zero(self):
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "hi")
        assert worker.cumulative_processing_seconds == 0.0

    @pytest.mark.asyncio
    async def test_accumulates_across_utterances(self):
        """`time.monotonic()` advances by a fixed 0.1s on EVERY call (from
        anywhere — `process_utterance` times itself too). Since
        `_run_inference`'s own pair of calls is never interleaved with any
        other `time.monotonic()` call, each utterance contributes exactly
        0.1s to the accumulator regardless of how many other timing calls
        happen elsewhere — precise, without coupling this test to an
        unrelated internal call count."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "hi")
        counter = itertools.count(start=0.0, step=0.1)

        with patch("stt.streaming.inference.time.monotonic", side_effect=lambda: next(counter)):
            await worker.process_utterance("sess-1", _make_utterance(index=0))
            after_one = worker.cumulative_processing_seconds
            await worker.process_utterance("sess-1", _make_utterance(index=1))

        assert after_one == pytest.approx(0.1)
        assert worker.cumulative_processing_seconds == pytest.approx(0.2)

    @pytest.mark.asyncio
    async def test_does_not_accumulate_when_pipeline_raises(self):
        """A pipeline exception propagates out of `_run_inference` BEFORE its
        timing/observe_streaming_inference call — `process_utterance`'s outer
        guard is what turns it into an empty result — so a failed utterance
        must not silently inflate the RTF numerator."""

        def _failing_pipeline(samples, sr):
            raise RuntimeError("boom")

        worker = StreamingInferenceWorker(asr_pipeline=_failing_pipeline)

        await worker.process_utterance("sess-1", _make_utterance())

        assert worker.cumulative_processing_seconds == 0.0


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
        worker = StreamingInferenceWorker(asr_pipeline=lambda samples, sr: "hello world")
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == "hello world"

    @pytest.mark.asyncio
    async def test_sync_pipeline_returns_dict(self):
        """Sync pipeline returning a dict with text key."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda samples, sr: {"text": "from dict"})
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == "from dict"

    @pytest.mark.asyncio
    async def test_sync_pipeline_preserves_english_text(self):
        """Dict pipeline english_text should be preserved on live segment results."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda samples, sr: {
                "text": "வில் நாட் கால விலிக்கில்லா தீரித்து விலிக்கியும்",
                "english_text": "Will not call ...",
            }
        )
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == "வில் நாட் கால விலிக்கில்லா தீரித்து விலிக்கியும்"
        assert result.english_text == "Will not call ..."

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
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "test")
        utt = _make_utterance(index=3, duration_s=2.5)

        result = await worker.process_utterance("sess-1", utt)

        assert result.start_time == 3 * 2.5
        assert result.end_time == 4 * 2.5
        assert result.is_final is False

    @pytest.mark.asyncio
    async def test_final_flag_preserved(self):
        """is_final should pass through to SegmentResult."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "final")
        utt = _make_utterance(is_final=True)

        result = await worker.process_utterance("sess-1", utt)

        assert result.is_final is True

    @pytest.mark.asyncio
    async def test_sanitizes_chevron_spam(self):
        """Pathological leading chevron spam should be removed."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: ">> >> >> >> hello world")
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == "hello world"

    @pytest.mark.asyncio
    async def test_applies_speaker_identification_when_enabled(self):
        """When diarization is enabled, final results should include speaker metadata."""
        diarization_cfg = MagicMock()
        diarization_cfg.enabled = True
        diarization_cfg.min_segment_duration_s = 0.1

        mock_embedding = MagicMock()
        mock_identifier = MagicMock()
        mock_identifier.identify = AsyncMock(
            return_value=MagicMock(speaker_id="speaker-abc", confidence=0.93)
        )

        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "hello diarization",
            tenant_id="tenant-1",
            consultation_id="consult-1",
            diarization_config=diarization_cfg,
            speaker_identifier=mock_identifier,
        )
        utt = _make_utterance(duration_s=1.2, is_final=True)

        with patch(
            "stt.diarization.embedding_service.get_embedding_service",
        ) as mock_emb_svc:
            mock_emb_svc.return_value.extract_from_samples = AsyncMock(return_value=mock_embedding)
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

        _result = await worker.process_utterance("sess-1", utt)

        publisher.publish.assert_awaited_once()
        published_result = publisher.publish.call_args[0][0]
        assert isinstance(published_result, SegmentResult)
        assert published_result.text == "published text"

    @pytest.mark.asyncio
    async def test_publishes_english_text_when_present(self):
        """Published live segment should carry english_text for code-switching."""
        publisher = AsyncMock()

        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: {
                "text": "வில் நாட் கால விலிக்கில்லா தீரித்து விலிக்கியும்",
                "english_text": "Will not call ...",
            },
        )
        utt = _make_utterance()

        await worker.process_utterance("sess-1", utt)

        publisher.publish.assert_awaited_once()
        published_result = publisher.publish.call_args[0][0]
        assert isinstance(published_result, SegmentResult)
        assert published_result.english_text == "Will not call ..."

    @pytest.mark.asyncio
    async def test_no_publisher_no_error(self):
        """No publisher configured should not crash."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "no pub")
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
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: 42)
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == "42"

    @pytest.mark.asyncio
    async def test_pipeline_returns_dict_without_text(self):
        """Pipeline returning a dict without 'text' key returns empty."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: {"confidence": 0.95})
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_pipeline_returns_empty_string(self):
        """Pipeline returning empty string is valid."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "")
        utt = _make_utterance()

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_pipeline_returns_none_via_dict(self):
        """Pipeline returning dict with None text should yield empty string."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: {"text": None})
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


# =========================================================================
# Tests: Hallucination filter
# =========================================================================


class TestHallucinationFilter:
    """Tests for post-ASR hallucination filtering."""

    @pytest.mark.asyncio
    async def test_rejects_filler_only_text(self):
        """Filler-only output like 'uh...' should be filtered to empty."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "uh...")
        utt = _make_utterance(rms_level=0.005)

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_rejects_um_filler(self):
        """Single filler 'um' should be filtered."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "um")
        utt = _make_utterance(rms_level=0.005)

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_rejects_oh_man_hallucination(self):
        """'Oh, man.' on low-energy segment should be filtered."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "Oh, man.")
        utt = _make_utterance(rms_level=0.003)

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_rejects_dots_only(self):
        """Ellipsis-only output should be filtered."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "...")
        utt = _make_utterance(rms_level=0.005)

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_rejects_mixed_fillers(self):
        """Mixed fillers 'uh um ah' should be filtered."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "uh um ah")
        utt = _make_utterance(rms_level=0.005)

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_keeps_real_speech(self):
        """Real speech with normal energy should be preserved."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "hello world this is a test")
        utt = _make_utterance(rms_level=0.1)

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == "hello world this is a test"

    @pytest.mark.asyncio
    async def test_keeps_short_real_word_with_energy(self):
        """Short real word 'yes' with sufficient energy should be preserved."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "yes")
        utt = _make_utterance(rms_level=0.1)

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == "yes"

    @pytest.mark.asyncio
    async def test_keeps_filler_with_real_content(self):
        """Text containing fillers mixed with real words should be preserved."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "uh I think this is important")
        utt = _make_utterance(rms_level=0.08)

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == "uh I think this is important"

    @pytest.mark.asyncio
    async def test_low_energy_short_text_filtered(self):
        """Short text on very low energy segment should be filtered."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "Oh.")
        utt = _make_utterance(rms_level=0.002)

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_rejects_thank_you_on_silence(self):
        """'Thank you.' on near-silence is a common Whisper hallucination."""
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "Thank you.")
        utt = _make_utterance(rms_level=0.002)

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_hallucination_filtered_still_publishes(self):
        """Filtered hallucination should still publish (with empty text)."""
        publisher = AsyncMock()
        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: "uh...",
        )
        utt = _make_utterance(rms_level=0.005)

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == ""
        publisher.publish.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_high_wps_kept_by_default(self):
        """12 wps (e.g. 3x-sped audio) should NOT be filtered by default.

        The words-per-second gate is opt-in; with no config, legitimate
        dense transcripts must pass through unchanged.
        """
        dense_text = " ".join(["word"] * 12)  # 12 words in 1s => 12 wps
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: dense_text)
        utt = _make_utterance(duration_s=1.0, rms_level=0.1)

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == dense_text

    @pytest.mark.asyncio
    async def test_high_wps_filtered_when_configured(self):
        """With max_words_per_second set, too-dense text is rejected."""
        dense_text = " ".join(["word"] * 12)
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: dense_text,
            max_words_per_second=8.0,
        )
        utt = _make_utterance(duration_s=1.0, rms_level=0.1)

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_wps_gate_respects_boundary(self):
        """Density at or below the configured ceiling should be kept."""
        text_at_limit = " ".join(["word"] * 6)  # 6 wps
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: text_at_limit,
            max_words_per_second=8.0,
        )
        utt = _make_utterance(duration_s=1.0, rms_level=0.1)

        result = await worker.process_utterance("sess-1", utt)

        assert result.text == text_at_limit


# =========================================================================
# Tests: process_partial
# =========================================================================


class TestProcessPartial:
    """Tests for the lightweight partial inference path."""

    @pytest.mark.asyncio
    async def test_process_partial_returns_is_final_false(self):
        """Partial result should have is_final=False and speaker_id=None."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "hello world",
        )
        utt = _make_utterance(is_final=False)

        result = await worker.process_partial("sess-1", utt)

        assert result.is_final is False
        assert result.speaker_id is None
        assert result.speaker_confidence == 0.0

    @pytest.mark.asyncio
    async def test_process_partial_skips_embedding(self):
        """Embedding extraction should not be called for partials."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "hello",
            tenant_id="t1",
        )
        utt = _make_utterance(is_final=False)

        with patch.object(worker, "_extract_embedding") as mock_embed:
            result = await worker.process_partial("sess-1", utt)
            mock_embed.assert_not_called()

        assert result.text == "hello"

    @pytest.mark.asyncio
    async def test_process_partial_skips_diarization(self):
        """Diarization should not be called for partials."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "hello",
            tenant_id="t1",
        )
        utt = _make_utterance(is_final=False)

        with patch.object(worker, "_identify_speaker") as mock_diar:
            await worker.process_partial("sess-1", utt)
            mock_diar.assert_not_called()

    @pytest.mark.asyncio
    async def test_process_partial_does_not_update_previous_text(self):
        """_previous_text should remain unchanged after process_partial."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "partial text here",
        )
        worker._previous_text = "original context"
        utt = _make_utterance(is_final=False)

        await worker.process_partial("sess-1", utt)

        assert worker._previous_text == "original context"

    @pytest.mark.asyncio
    async def test_process_partial_hallucination_filtered(self):
        """Near-silence input should produce empty text."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "uh",
        )
        utt = _make_utterance(is_final=False, rms_level=0.001)

        result = await worker.process_partial("sess-1", utt)

        assert result.text == ""

    @pytest.mark.asyncio
    async def test_process_utterance_unchanged_regression(self):
        """is_final=True still runs full pipeline (embed + diarize + context carry)."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "hello world",
        )
        utt = _make_utterance(is_final=True)

        with patch.object(
            worker, "_extract_embedding", new_callable=AsyncMock, return_value=None
        ) as mock_embed:
            result = await worker.process_utterance("sess-1", utt)
            mock_embed.assert_awaited_once()

        assert result.is_final is True
        assert "hello world" in worker._previous_text

    @pytest.mark.asyncio
    async def test_prev_text_context_words_zero_disables_carry(self):
        """Setting prev_text_context_words=0 must produce empty _previous_text.

        Regression test for a `words[-0:]` bug that previously sliced the full
        list and propagated the entire utterance as prompt context.
        """
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "one two three four five",
            prev_text_context_words=0,
        )
        utt = _make_utterance(is_final=True)

        with patch.object(worker, "_extract_embedding", new_callable=AsyncMock, return_value=None):
            await worker.process_utterance("sess-1", utt)

        assert worker._previous_text == ""

    @pytest.mark.asyncio
    async def test_prev_text_context_words_caps_carry(self):
        """Only the tail N words should carry forward when configured."""
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "one two three four five",
            prev_text_context_words=2,
        )
        utt = _make_utterance(is_final=True)

        with patch.object(worker, "_extract_embedding", new_callable=AsyncMock, return_value=None):
            await worker.process_utterance("sess-1", utt)

        assert worker._previous_text == "four five"


# =========================================================================
# Tests: PostprocessingConfig wiring (Step 2)
# =========================================================================


class TestPostprocessingConfigWiring:

    def test_worker_derives_punctuation_from_postprocessing_config(self):
        pp_config = PostprocessingConfig(
            punctuation=PunctuationConfig(enabled=True, model="test-model"),
        )
        worker = StreamingInferenceWorker(postprocessing_config=pp_config)
        assert worker._punctuation_config is not None
        assert worker._punctuation_config.enabled is True
        assert worker._punctuation_config.model == "test-model"

    def test_worker_none_config_has_none_punctuation(self):
        worker = StreamingInferenceWorker(postprocessing_config=None)
        assert worker._punctuation_config is None

    def test_worker_stores_full_postprocessing_config(self):
        pp_config = PostprocessingConfig(lowercase=True, remove_disfluencies=True)
        worker = StreamingInferenceWorker(postprocessing_config=pp_config)
        assert worker._postprocessing_config is pp_config
        assert worker._postprocessing_config.lowercase is True
        assert worker._postprocessing_config.remove_disfluencies is True


# =========================================================================
# Tests: Lowercase in streaming (Step 3)
# =========================================================================


class TestStreamingLowercase:

    @pytest.mark.asyncio
    async def test_lowercase_applied_when_enabled(self):
        pp_config = PostprocessingConfig(lowercase=True)
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "Hello World",
            postprocessing_config=pp_config,
        )
        utt = _make_utterance()
        result = await worker.process_utterance("sess-1", utt)
        assert result.text == "hello world"

    @pytest.mark.asyncio
    async def test_lowercase_not_applied_when_disabled(self):
        pp_config = PostprocessingConfig(lowercase=False)
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "Hello World",
            postprocessing_config=pp_config,
        )
        utt = _make_utterance()
        result = await worker.process_utterance("sess-1", utt)
        assert result.text == "Hello World"

    @pytest.mark.asyncio
    async def test_lowercase_not_applied_when_no_config(self):
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: "Hello World",
        )
        utt = _make_utterance()
        result = await worker.process_utterance("sess-1", utt)
        assert result.text == "Hello World"


# =========================================================================
# Tests: Word timestamps gating (Step 5)
# =========================================================================


class TestWordTimestampsGating:

    @pytest.mark.asyncio
    async def test_word_timestamps_cleared_when_disabled(self):
        pp_config = PostprocessingConfig(
            timestamps=TimestampConfig(word_timestamps=False),
        )
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: {
                "text": "hello world",
                "word_timestamps": [
                    {"word": "hello", "start": 0.0, "end": 0.5},
                    {"word": "world", "start": 0.5, "end": 1.0},
                ],
            },
            postprocessing_config=pp_config,
        )
        utt = _make_utterance()
        result = await worker.process_utterance("sess-1", utt)
        assert result.word_timestamps == []

    @pytest.mark.asyncio
    async def test_word_timestamps_preserved_when_enabled(self):
        pp_config = PostprocessingConfig(
            timestamps=TimestampConfig(word_timestamps=True),
        )
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: {
                "text": "hello",
                "word_timestamps": [
                    {"word": "hello", "start": 0.0, "end": 0.5},
                ],
            },
            postprocessing_config=pp_config,
        )
        utt = _make_utterance()
        result = await worker.process_utterance("sess-1", utt)
        assert len(result.word_timestamps) >= 1

    @pytest.mark.asyncio
    async def test_word_timestamps_preserved_when_no_config(self):
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda s, sr: {
                "text": "hello",
                "word_timestamps": [
                    {"word": "hello", "start": 0.0, "end": 0.5},
                ],
            },
        )
        utt = _make_utterance()
        result = await worker.process_utterance("sess-1", utt)
        assert len(result.word_timestamps) >= 1
