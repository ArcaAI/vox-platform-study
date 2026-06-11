"""Streaming English gloss — opt-in translate pass (TASK-351 P2-3).

Covers:
- ``inference.streaming_english_gloss`` flag (DTO default + YAML parsing)
- ``SegmentResult`` additive ``type: gloss`` / ``utterance_index`` wire fields
- ``StreamingInferenceWorker`` gloss behavior: emitted only when enabled,
  published AFTER the final (never delays it), failures/timeouts swallowed,
  same ``utterance_index`` as the final
- ``SessionManager`` gloss-callable construction (task=translate on the
  same cached model; unsupported engines return None)
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest

from stt_v2.pipeline.dto import AiModelFormat, InferenceConfig
from stt_v2.pipeline.yaml_parser import PipelineYamlParser
from stt_v2.streaming.inference import StreamingInferenceWorker
from stt_v2.streaming.preprocessor import AudioUtterance
from stt_v2.streaming.schemas import SegmentResult


def _make_utterance(
    index: int = 0,
    duration_s: float = 1.0,
    is_final: bool = True,
) -> AudioUtterance:
    samples = np.random.randn(int(16000 * duration_s)).astype(np.float32) * 0.1
    return AudioUtterance(
        samples=samples,
        sample_rate=16000,
        start_time=index * duration_s,
        end_time=(index + 1) * duration_s,
        utterance_index=index,
        is_final=is_final,
    )


async def _drain_gloss_tasks(worker: StreamingInferenceWorker) -> None:
    tasks = list(worker._gloss_tasks)
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


# =========================================================================
# Config plumbing
# =========================================================================


class TestGlossConfig:

    def test_inference_config_default_off(self):
        assert InferenceConfig().streaming_english_gloss is False

    def test_yaml_parses_flag_true(self):
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  language: ml
  streaming_english_gloss: true
"""
        spec = PipelineYamlParser().parse(yaml_content)
        assert spec.inference.streaming_english_gloss is True

    def test_yaml_default_false_when_absent(self):
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  language: ml
"""
        spec = PipelineYamlParser().parse(yaml_content)
        assert spec.inference.streaming_english_gloss is False


# =========================================================================
# Wire schema — additive type / utterance_index
# =========================================================================


class TestGlossWireSchema:

    def test_default_result_type_is_segment(self):
        d = SegmentResult(text="hello").to_redis_dict()
        assert d["type"] == "segment"
        assert "utterance_index" not in d

    def test_gloss_result_serializes_type_and_index(self):
        result = SegmentResult(
            text="namaskaram",
            english_text="hello",
            is_final=True,
            utterance_index=4,
            result_type="gloss",
        )
        d = result.to_redis_dict()
        assert d["type"] == "gloss"
        assert d["utterance_index"] == "4"
        assert d["english_text"] == "hello"

    def test_round_trip_preserves_type_and_index(self):
        original = SegmentResult(
            text="t",
            english_text="e",
            utterance_index=7,
            result_type="gloss",
            is_final=True,
        )
        restored = SegmentResult.from_redis_dict(original.to_redis_dict())
        assert restored.result_type == "gloss"
        assert restored.utterance_index == 7
        assert restored.english_text == "e"

    def test_round_trip_defaults_for_legacy_entries(self):
        restored = SegmentResult.from_redis_dict({"text": "legacy"})
        assert restored.result_type == "segment"
        assert restored.utterance_index is None

    def test_final_result_carries_utterance_index(self):
        d = SegmentResult(text="x", utterance_index=3).to_redis_dict()
        assert d["utterance_index"] == "3"


# =========================================================================
# Worker gloss behavior
# =========================================================================


class TestWorkerGloss:

    @pytest.mark.asyncio
    async def test_gloss_published_after_final_when_enabled(self):
        publisher = AsyncMock()

        async def _gloss(samples, sample_rate):
            return {"text": "I have a fever"}

        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: "enikku pani undu",
            gloss_callable=_gloss,
        )
        utt = _make_utterance(index=5, is_final=True)

        await worker.process_utterance("sess-1", utt)
        await _drain_gloss_tasks(worker)

        assert publisher.publish.await_count == 2
        final = publisher.publish.call_args_list[0][0][0]
        gloss = publisher.publish.call_args_list[1][0][0]
        assert final.result_type == "segment"
        assert gloss.result_type == "gloss"
        assert gloss.english_text == "I have a fever"
        assert gloss.utterance_index == utt.utterance_index
        assert gloss.utterance_index == final.utterance_index
        assert gloss.is_final is True

    @pytest.mark.asyncio
    async def test_no_gloss_when_disabled(self):
        publisher = AsyncMock()
        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: "text",
        )
        utt = _make_utterance(is_final=True)

        await worker.process_utterance("sess-1", utt)
        await _drain_gloss_tasks(worker)

        assert publisher.publish.await_count == 1

    @pytest.mark.asyncio
    async def test_no_gloss_for_non_final_utterances(self):
        publisher = AsyncMock()
        gloss_callable = AsyncMock(return_value={"text": "en"})
        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: "text",
            gloss_callable=gloss_callable,
        )
        utt = _make_utterance(is_final=False)

        await worker.process_utterance("sess-1", utt)
        await _drain_gloss_tasks(worker)

        assert publisher.publish.await_count == 1
        gloss_callable.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_gloss_for_empty_final_text(self):
        publisher = AsyncMock()
        gloss_callable = AsyncMock(return_value={"text": "en"})
        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: "",
            gloss_callable=gloss_callable,
        )
        utt = _make_utterance(is_final=True)

        await worker.process_utterance("sess-1", utt)
        await _drain_gloss_tasks(worker)

        gloss_callable.assert_not_called()

    @pytest.mark.asyncio
    async def test_final_not_delayed_by_slow_gloss(self):
        """The final must already be published while the gloss is pending."""
        publisher = AsyncMock()
        release = asyncio.Event()

        async def _slow_gloss(samples, sample_rate):
            await release.wait()
            return {"text": "translated"}

        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: "original",
            gloss_callable=_slow_gloss,
        )
        utt = _make_utterance(is_final=True)

        await worker.process_utterance("sess-1", utt)

        # Final already published; gloss still pending on the event.
        assert publisher.publish.await_count == 1
        assert publisher.publish.call_args_list[0][0][0].result_type == "segment"

        release.set()
        await _drain_gloss_tasks(worker)
        assert publisher.publish.await_count == 2

    @pytest.mark.asyncio
    async def test_gloss_failure_swallowed(self):
        publisher = AsyncMock()

        async def _broken_gloss(samples, sample_rate):
            raise RuntimeError("translate blew up")

        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: "text",
            gloss_callable=_broken_gloss,
        )
        utt = _make_utterance(is_final=True)

        result = await worker.process_utterance("sess-1", utt)
        await _drain_gloss_tasks(worker)

        assert result.text == "text"
        assert publisher.publish.await_count == 1  # final only, no gloss

    @pytest.mark.asyncio
    async def test_gloss_timeout_swallowed(self):
        publisher = AsyncMock()

        async def _hanging_gloss(samples, sample_rate):
            await asyncio.sleep(5)
            return {"text": "late"}

        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: "text",
            gloss_callable=_hanging_gloss,
            gloss_timeout_s=0.01,
        )
        utt = _make_utterance(is_final=True)

        await worker.process_utterance("sess-1", utt)
        await _drain_gloss_tasks(worker)

        assert publisher.publish.await_count == 1

    @pytest.mark.asyncio
    async def test_empty_gloss_text_not_published(self):
        publisher = AsyncMock()

        async def _empty_gloss(samples, sample_rate):
            return {"text": "   "}

        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: "text",
            gloss_callable=_empty_gloss,
        )
        utt = _make_utterance(is_final=True)

        await worker.process_utterance("sess-1", utt)
        await _drain_gloss_tasks(worker)

        assert publisher.publish.await_count == 1

    @pytest.mark.asyncio
    async def test_final_result_has_utterance_index(self):
        publisher = AsyncMock()
        worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=lambda s, sr: "text",
        )
        utt = _make_utterance(index=9, is_final=True)

        result = await worker.process_utterance("sess-1", utt)

        assert result.utterance_index == 9

    @pytest.mark.asyncio
    async def test_partial_result_has_utterance_index(self):
        worker = StreamingInferenceWorker(asr_pipeline=lambda s, sr: "text")
        utt = _make_utterance(index=2, is_final=False)

        result = await worker.process_partial("sess-1", utt)

        assert result.utterance_index == 2


# =========================================================================
# SessionManager gloss-callable construction
# =========================================================================


class TestSessionManagerGlossWiring:

    def _manager(self):
        from stt_v2.streaming.session_manager import SessionManager

        return MagicMock(spec=SessionManager), SessionManager

    def test_returns_none_when_flag_off(self):
        mgr, SessionManager = self._manager()
        asr_model = MagicMock()
        cfg = InferenceConfig(streaming_english_gloss=False)

        out = SessionManager._make_gloss_callable(mgr, asr_model, cfg)

        assert out is None
        mgr._make_asr_callable.assert_not_called()

    def test_returns_none_for_nemo_engine(self):
        mgr, SessionManager = self._manager()
        asr_model = MagicMock()
        asr_model.format = AiModelFormat.NEMO
        cfg = InferenceConfig(streaming_english_gloss=True)

        out = SessionManager._make_gloss_callable(mgr, asr_model, cfg)

        assert out is None
        mgr._make_asr_callable.assert_not_called()

    def test_returns_none_for_azure_engine(self):
        mgr, SessionManager = self._manager()
        asr_model = MagicMock()
        asr_model.format = AiModelFormat.AZURE_SPEECH
        cfg = InferenceConfig(streaming_english_gloss=True)

        out = SessionManager._make_gloss_callable(mgr, asr_model, cfg)

        assert out is None

    def test_builds_translate_callable_for_whisper_family(self):
        mgr, SessionManager = self._manager()
        asr_model = MagicMock()
        asr_model.format = AiModelFormat.SAFETENSOR
        asr_model.extra = None
        cfg = InferenceConfig(streaming_english_gloss=True)

        out = SessionManager._make_gloss_callable(mgr, asr_model, cfg)

        assert out is mgr._make_asr_callable.return_value
        _args, kwargs = mgr._make_asr_callable.call_args
        assert kwargs.get("task") == "translate"

    @pytest.mark.asyncio
    async def test_load_gloss_pipeline_skips_when_flag_off(self):
        from types import SimpleNamespace

        mgr, SessionManager = self._manager()
        pipeline_config = SimpleNamespace(
            inference=SimpleNamespace(streaming_english_gloss=False),
        )

        out = await SessionManager._load_gloss_pipeline(mgr, pipeline_config, "s-1")

        assert out is None


# =========================================================================
# Transformers path: task=translate kwargs
# =========================================================================


class TestTranslateTaskKwargs:

    @pytest.mark.asyncio
    async def test_translate_task_reaches_generate(self):
        torch = pytest.importorskip("torch")
        from stt_v2.streaming.session_manager import SessionManager

        mgr = MagicMock(spec=SessionManager)

        mock_model = MagicMock()
        mock_model.dtype = torch.float32
        mock_model.generate.return_value = torch.tensor([[1, 2]])

        mock_processor = MagicMock()
        mock_processor.batch_decode.return_value = ["I have a fever"]
        mock_processor.decode.return_value = {"offsets": []}

        asr_model = MagicMock()
        asr_model.model = mock_model
        asr_model.processor = mock_processor
        asr_model.feature_extractor = None
        asr_model.device = torch.device("cpu")

        run_gloss = SessionManager._make_asr_callable(
            mgr,
            asr_model=asr_model,
            inference_config=MagicMock(
                beam_size=1, code_switching=False, language="ml"
            ),
            task="translate",
        )
        await run_gloss(np.zeros(16000, dtype=np.float32), 16000)

        gen_kwargs = mock_model.generate.call_args.kwargs
        assert gen_kwargs["task"] == "translate"
        # Mirrors the batch translate pass: forces English output token.
        assert gen_kwargs["language"] == "en"
