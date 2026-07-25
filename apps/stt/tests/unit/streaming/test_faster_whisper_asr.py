"""Unit tests for the faster-whisper/CTranslate2 streaming engine.

Covers:
- CT2 device / compute-type resolution helpers
- ``FasterWhisperAsrAdapter`` kwargs contract (language pinning vs auto-LID,
  prompt passthrough, batch size, decode params)
- Output mapping (text, word timestamps, language, per-segment error isolation)
- ``FasterWhisperLoader`` (lazy import, compute-type resolution, cache registration)
- ``SessionManager._make_asr_callable`` routing for FASTER_WHISPER

All tests run WITHOUT the ``faster_whisper`` package installed — the loader
imports it lazily and tests mock ``WhisperModel`` / ``BatchedInferencePipeline``.
"""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import (
    AiModelFormat,
    InferenceConfig,
    InlineModelDef,
    ModelTaskType,
)
from stt.streaming.faster_whisper_asr import (
    FasterWhisperAsrAdapter,
    resolve_ct2_compute_type,
    resolve_ct2_device,
)

# ---------------------------------------------------------------------------
# Fakes mirroring the faster-whisper result objects
# ---------------------------------------------------------------------------


def _bind_asr_dispatch(mgr):
    """_make_asr_callable dispatches through registry adapters
    that call back into per-engine builder methods on the manager; bind the
    real ones onto MagicMock(spec=SessionManager) harnesses."""
    from stt.streaming.session_manager import SessionManager

    for _name in (
        "_make_nemo_callable",
        "_make_faster_whisper_callable",
        "_make_azure_callable",
        "_make_transformers_callable",
        "_make_multimodal_lm_callable",
    ):
        setattr(mgr, _name, getattr(SessionManager, _name).__get__(mgr))
    return mgr


class _FakeWord:
    def __init__(self, word: str, start: float, end: float, probability: float = 0.9):
        self.word = word
        self.start = start
        self.end = end
        self.probability = probability


class _FakeSegment:
    def __init__(self, text: str, words=None, start: float = 0.0, end: float = 1.0):
        self.text = text
        self.words = words or []
        self.start = start
        self.end = end


class _ExplodingSegment:
    """Segment whose attribute access raises — used for error isolation."""

    @property
    def text(self):
        raise RuntimeError("boom")

    @property
    def words(self):
        raise RuntimeError("boom")


class _FakeInfo:
    def __init__(self, language: str = "en", language_probability: float = 0.99):
        self.language = language
        self.language_probability = language_probability


def _make_loaded(
    fake_model=None,
    batched=None,
    fmt: AiModelFormat = AiModelFormat.FASTER_WHISPER,
) -> LoadedModel:
    extra = {}
    if batched is not None:
        extra["batched_pipeline"] = batched
    return LoadedModel(
        model_id="m1",
        model_slug="fw-large-v3",
        model=fake_model if fake_model is not None else MagicMock(),
        format=fmt,
        device="cpu",
        extra=extra,
    )


def _transcribe_result(segments=None, info=None):
    return iter(segments or []), info or _FakeInfo()


# ---------------------------------------------------------------------------
# Device / compute-type resolution
# ---------------------------------------------------------------------------


class TestResolveCt2Device:
    def test_cuda_with_index(self):
        assert resolve_ct2_device("cuda:1") == ("cuda", 1)

    def test_plain_cuda(self):
        assert resolve_ct2_device("cuda") == ("cuda", 0)

    def test_mps_falls_back_to_cpu(self):
        # CTranslate2 has no MPS backend
        assert resolve_ct2_device("mps") == ("cpu", 0)

    def test_cpu(self):
        assert resolve_ct2_device("cpu") == ("cpu", 0)


class TestResolveCt2ComputeType:
    def test_none_becomes_auto(self):
        assert resolve_ct2_compute_type(None, "cuda") == "auto"

    def test_empty_becomes_auto(self):
        assert resolve_ct2_compute_type("", "cpu") == "auto"

    def test_float16_on_cpu_coerced_to_float32(self):
        assert resolve_ct2_compute_type("float16", "cpu") == "float32"

    def test_bfloat16_on_cpu_coerced_to_float32(self):
        assert resolve_ct2_compute_type("bfloat16", "cpu") == "float32"

    def test_int8_float16_on_cpu_coerced_to_int8(self):
        assert resolve_ct2_compute_type("int8_float16", "cpu") == "int8"

    def test_float16_on_cuda_passes(self):
        assert resolve_ct2_compute_type("float16", "cuda") == "float16"

    def test_int8_on_cpu_passes(self):
        assert resolve_ct2_compute_type("int8", "cpu") == "int8"

    def test_unknown_value_raises(self):
        with pytest.raises(ValueError):
            resolve_ct2_compute_type("fp99", "cuda")


# ---------------------------------------------------------------------------
# Adapter kwargs contract
# ---------------------------------------------------------------------------


class TestAdapterKwargsContract:
    def _call(self, inference_config, batched=None, prompt=None, batch_size=None):
        model = MagicMock()
        model.transcribe.return_value = _transcribe_result()
        if batched is not None:
            batched.transcribe.return_value = _transcribe_result()
        loaded = _make_loaded(fake_model=model, batched=batched)
        adapter = FasterWhisperAsrAdapter(
            loaded, inference_config, batch_size=batch_size
        )
        adapter(np.zeros(16000, dtype=np.float32), 16000, prompt=prompt)
        target = batched if batched is not None else model
        return target.transcribe.call_args

    def test_language_pinned_when_cs_off(self):
        cfg = InferenceConfig(language="ml", code_switching=False)
        _args, kwargs = self._call(cfg)
        assert kwargs["language"] == "ml"

    def test_default_task_is_transcribe(self):
        cfg = InferenceConfig(language="ml")
        _args, kwargs = self._call(cfg)
        assert kwargs["task"] == "transcribe"

    def test_translate_task_passed_when_configured(self):
        # The gloss pass builds the adapter with task=translate.
        model = MagicMock()
        model.transcribe.return_value = _transcribe_result()
        loaded = _make_loaded(fake_model=model)
        adapter = FasterWhisperAsrAdapter(
            loaded, InferenceConfig(language="ml"), task="translate"
        )
        adapter(np.zeros(16000, dtype=np.float32), 16000)
        _args, kwargs = model.transcribe.call_args
        assert kwargs["task"] == "translate"

    def test_language_pinned_even_when_cs_on(self):
        # CS + language set now means PINNED matrix language.
        cfg = InferenceConfig(language="ml", code_switching=True)
        _args, kwargs = self._call(cfg)
        assert kwargs["language"] == "ml"

    def test_auto_lid_when_no_language(self):
        cfg = InferenceConfig(language=None, code_switching=False)
        _args, kwargs = self._call(cfg)
        assert kwargs["language"] is None

    def test_bcp47_language_normalized(self):
        cfg = InferenceConfig(language="ml-IN", code_switching=False)
        _args, kwargs = self._call(cfg)
        assert kwargs["language"] == "ml"

    def test_prompt_passed_as_initial_prompt(self):
        cfg = InferenceConfig()
        _args, kwargs = self._call(cfg, prompt="clinic context")
        assert kwargs["initial_prompt"] == "clinic context"

    def test_no_prompt_omits_initial_prompt(self):
        cfg = InferenceConfig()
        _args, kwargs = self._call(cfg)
        assert "initial_prompt" not in kwargs

    def test_batch_size_forwarded_to_batched_pipeline(self):
        batched = MagicMock()
        cfg = InferenceConfig()
        _args, kwargs = self._call(cfg, batched=batched, batch_size=4)
        assert kwargs["batch_size"] == 4

    def test_falls_back_to_plain_model_without_batched_pipeline(self):
        model = MagicMock()
        model.transcribe.return_value = _transcribe_result()
        loaded = _make_loaded(fake_model=model, batched=None)
        adapter = FasterWhisperAsrAdapter(loaded, InferenceConfig(), batch_size=4)
        adapter(np.zeros(16000, dtype=np.float32), 16000)
        model.transcribe.assert_called_once()
        _args, kwargs = model.transcribe.call_args
        # plain WhisperModel.transcribe takes no batch_size
        assert "batch_size" not in kwargs

    def test_task_word_timestamps_and_vad_filter(self):
        _args, kwargs = self._call(InferenceConfig())
        assert kwargs["task"] == "transcribe"
        assert kwargs["word_timestamps"] is True
        assert kwargs["vad_filter"] is False

    def test_decode_params_forwarded(self):
        cfg = InferenceConfig(
            beam_size=3,
            temperature=[0.0, 0.4],
            compression_ratio_threshold=2.2,
            logprob_threshold=-0.8,
            no_speech_threshold=0.5,
            condition_on_prev_tokens=True,
        )
        _args, kwargs = self._call(cfg)
        assert kwargs["beam_size"] == 3
        assert kwargs["temperature"] == [0.0, 0.4]
        assert kwargs["compression_ratio_threshold"] == 2.2
        assert kwargs["log_prob_threshold"] == -0.8
        assert kwargs["no_speech_threshold"] == 0.5
        assert kwargs["condition_on_previous_text"] is True

    def test_rejects_wrong_model_format(self):
        loaded = _make_loaded(fmt=AiModelFormat.NEMO)
        with pytest.raises(ValueError):
            FasterWhisperAsrAdapter(loaded, InferenceConfig())


# ---------------------------------------------------------------------------
# Adapter output mapping
# ---------------------------------------------------------------------------


class TestAdapterOutputMapping:
    def _adapter_with_segments(self, segments, info=None):
        model = MagicMock()
        model.transcribe.return_value = _transcribe_result(segments, info)
        loaded = _make_loaded(fake_model=model)
        return FasterWhisperAsrAdapter(loaded, InferenceConfig())

    def test_text_joined_from_segments(self):
        adapter = self._adapter_with_segments(
            [_FakeSegment(" hello"), _FakeSegment(" world ")]
        )
        out = adapter(np.zeros(16000, dtype=np.float32), 16000)
        assert out["text"] == "hello world"

    def test_word_timestamps_mapped(self):
        words = [_FakeWord(" hello", 0.0, 0.5, 0.8), _FakeWord(" world", 0.5, 1.0, 0.7)]
        adapter = self._adapter_with_segments([_FakeSegment("hello world", words)])
        out = adapter(np.zeros(16000, dtype=np.float32), 16000)
        assert out["word_timestamps"] == [
            {"word": "hello", "start": 0.0, "end": 0.5, "confidence": 0.8},
            {"word": "world", "start": 0.5, "end": 1.0, "confidence": 0.7},
        ]

    def test_language_from_info(self):
        adapter = self._adapter_with_segments(
            [_FakeSegment("namaskaram")], info=_FakeInfo(language="ml")
        )
        out = adapter(np.zeros(16000, dtype=np.float32), 16000)
        assert out["language"] == "ml"

    def test_per_segment_error_isolation(self):
        segments = [
            _FakeSegment("good one", [_FakeWord("good", 0.0, 0.4)]),
            _ExplodingSegment(),
            _FakeSegment("good two", [_FakeWord("two", 1.0, 1.4)]),
        ]
        adapter = self._adapter_with_segments(segments)
        out = adapter(np.zeros(16000, dtype=np.float32), 16000)
        assert out["text"] == "good one good two"
        assert len(out["word_timestamps"]) == 2

    def test_empty_segments_return_empty_text(self):
        adapter = self._adapter_with_segments([])
        out = adapter(np.zeros(16000, dtype=np.float32), 16000)
        assert out["text"] == ""
        assert out["word_timestamps"] == []

    def test_resamples_non_16k_audio(self):
        model = MagicMock()
        model.transcribe.return_value = _transcribe_result()
        loaded = _make_loaded(fake_model=model)
        adapter = FasterWhisperAsrAdapter(loaded, InferenceConfig())
        adapter(np.zeros(8000, dtype=np.float32), 8000)  # 1 second @ 8 kHz
        (audio,), _kwargs = model.transcribe.call_args
        assert len(audio) == 16000


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------


def _fake_fw_module():
    mod = types.ModuleType("faster_whisper")
    mod.WhisperModel = MagicMock(name="WhisperModel")
    mod.BatchedInferencePipeline = MagicMock(name="BatchedInferencePipeline")
    return mod


def _asr_model_config(**overrides):
    inline = InlineModelDef(
        hf_model_id=overrides.pop("hf_model_id", "arcaai/whisper-large-v3-ct2"),
        engine=AiModelFormat.FASTER_WHISPER,
        **overrides,
    )
    return inline.to_ai_model_config(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)


class TestFasterWhisperLoader:
    def test_loader_registered_in_cache(self):
        from stt.models.cache import ModelCache
        from stt.models.faster_whisper_loader import FasterWhisperLoader

        cache = ModelCache(max_memory_mb=100, max_models=1, ttl_seconds=60)
        loader = cache._get_loader(AiModelFormat.FASTER_WHISPER)
        assert isinstance(loader, FasterWhisperLoader)

    @pytest.mark.asyncio
    async def test_load_constructs_whisper_model_with_resolved_kwargs(self):
        from stt.models.faster_whisper_loader import FasterWhisperLoader

        fake_mod = _fake_fw_module()
        config = _asr_model_config(device="cpu", compute_type="float16")

        with patch.dict(sys.modules, {"faster_whisper": fake_mod}):
            loaded = await FasterWhisperLoader().load(config)

        _args, kwargs = fake_mod.WhisperModel.call_args
        assert _args[0] == "arcaai/whisper-large-v3-ct2"
        assert kwargs["device"] == "cpu"
        # float16 unsupported on CPU — coerced to float32
        assert kwargs["compute_type"] == "float32"

        fake_mod.BatchedInferencePipeline.assert_called_once()
        assert loaded.format == AiModelFormat.FASTER_WHISPER
        assert loaded.extra["batched_pipeline"] is (
            fake_mod.BatchedInferencePipeline.return_value
        )
        assert loaded.model is fake_mod.WhisperModel.return_value

    @pytest.mark.asyncio
    async def test_load_uses_profile_compute_type_when_unset(self):
        from stt.models.faster_whisper_loader import FasterWhisperLoader

        fake_mod = _fake_fw_module()
        config = _asr_model_config(device="cpu", compute_type=None)
        profile = MagicMock(asr_compute_type="int8")

        with (
            patch.dict(sys.modules, {"faster_whisper": fake_mod}),
            patch(
                "stt.streaming._runtime.get_execution_profile",
                return_value=profile,
            ),
        ):
            await FasterWhisperLoader().load(config)

        _args, kwargs = fake_mod.WhisperModel.call_args
        assert kwargs["compute_type"] == "int8"

    @pytest.mark.asyncio
    async def test_load_missing_package_raises_model_load_error(self):
        from stt.core.exceptions import ModelLoadError
        from stt.models.faster_whisper_loader import FasterWhisperLoader

        config = _asr_model_config(device="cpu")

        with patch.dict(sys.modules, {"faster_whisper": None}):
            with pytest.raises(ModelLoadError, match="faster-whisper"):
                await FasterWhisperLoader().load(config)


# ---------------------------------------------------------------------------
# SessionManager routing
# ---------------------------------------------------------------------------


class TestSessionManagerFasterWhisperRouting:
    @pytest.mark.asyncio
    async def test_routes_faster_whisper_format_to_adapter(self):
        from stt.streaming.session_manager import SessionManager

        mgr = MagicMock(spec=SessionManager)

        _bind_asr_dispatch(mgr)
        mgr._profile = MagicMock(asr_max_batch_size=4)
        loaded = _make_loaded()

        with patch(
            "stt.streaming.faster_whisper_asr.FasterWhisperAsrAdapter"
        ) as adapter_cls:
            adapter_cls.return_value = MagicMock(
                return_value={"text": "routed", "word_timestamps": []}
            )
            callable_ = SessionManager._make_asr_callable(
                mgr,
                asr_model=loaded,
                inference_config=InferenceConfig(language="en"),
            )
            out = await callable_(np.zeros(16000, dtype=np.float32), 16000)

        assert out["text"] == "routed"
        _args, kwargs = adapter_cls.call_args
        assert kwargs["batch_size"] == 4

    @pytest.mark.asyncio
    async def test_prompt_forwarded_through_routing(self):
        from stt.streaming.session_manager import SessionManager

        mgr = MagicMock(spec=SessionManager)

        _bind_asr_dispatch(mgr)
        mgr._profile = MagicMock(asr_max_batch_size=8)
        loaded = _make_loaded()

        with patch(
            "stt.streaming.faster_whisper_asr.FasterWhisperAsrAdapter"
        ) as adapter_cls:
            instance = MagicMock(return_value={"text": "", "word_timestamps": []})
            adapter_cls.return_value = instance
            callable_ = SessionManager._make_asr_callable(
                mgr,
                asr_model=loaded,
                inference_config=InferenceConfig(),
            )
            await callable_(
                np.zeros(16000, dtype=np.float32), 16000, prompt="ctx"
            )

        _args, kwargs = instance.call_args
        assert kwargs["prompt"] == "ctx"
