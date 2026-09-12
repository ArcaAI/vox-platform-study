"""TASK-860 D-3 — Nemotron / Parakeet transducer checkpoints on transformers.

The RNNT branch is version-gated on `AutoModelForRNNT` (transformers >= 5.13):
an older transformers must FAIL with a named error instead of falling into the
Whisper → Seq2Seq → CTC chain and failing as "not a Whisper model". Hermetic —
`transformers` is a stub module injected into `sys.modules`.
"""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock, patch

import pytest

from stt.core.exceptions import ModelLoadError
from stt.models.huggingface_loader import RNNT_MIN_TRANSFORMERS, HuggingFaceLoader
from stt.pipeline.dto import ModelTaskType


def _fake_transformers(
    *, architectures: list[str], model_type: str, with_rnnt: bool
) -> types.ModuleType:
    mod = types.ModuleType("transformers")
    config = MagicMock(model_type=model_type, architectures=architectures, audio_config=None)
    mod.AutoConfig = MagicMock()  # type: ignore[attr-defined]
    mod.AutoConfig.from_pretrained.return_value = config
    for name in (
        "AutoFeatureExtractor",
        "AutoModelForAudioClassification",
        "AutoModelForCTC",
        "AutoModelForSpeechSeq2Seq",
        "AutoProcessor",
        "AutoTokenizer",
        "GenerationConfig",
        "WhisperForConditionalGeneration",
        "WhisperProcessor",
    ):
        setattr(mod, name, MagicMock())
    mod.__version__ = "5.13.0" if with_rnnt else "5.5.4"  # type: ignore[attr-defined]
    if with_rnnt:
        mod.AutoModelForRNNT = MagicMock()  # type: ignore[attr-defined]
    return mod


def _load(mod: types.ModuleType):
    with patch.dict(sys.modules, {"transformers": mod}):
        return HuggingFaceLoader()._load_by_task(
            model_source="/mnt/models-bucket/hf/hub/models--nvidia--nemotron-3.5-asr-streaming-0.6b/snapshots/abc/",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            device="cpu",
            torch_dtype="float32",
            cache_dir="/tmp/hf-cache",
            revision=None,
            token=None,
        )


def test_rnnt_checkpoint_loads_through_auto_model_for_rnnt_from_a_local_snapshot():
    mod = _fake_transformers(
        architectures=["ParakeetForRNNT"], model_type="parakeet_rnnt", with_rnnt=True
    )

    model, _tokenizer, processor, _fe, is_multimodal, is_rnnt = _load(mod)

    assert is_rnnt is True and is_multimodal is False
    mod.AutoModelForRNNT.from_pretrained.assert_called_once()
    assert mod.AutoModelForRNNT.from_pretrained.call_args.args[0].endswith("/snapshots/abc/")
    loaded = mod.AutoModelForRNNT.from_pretrained.return_value
    # `.to(device)` is only applied when `accelerate` is absent (device_map otherwise).
    assert model is loaded or model is loaded.to.return_value
    mod.AutoProcessor.from_pretrained.assert_called_once()
    assert processor is mod.AutoProcessor.from_pretrained.return_value
    # The Whisper chain never ran.
    mod.WhisperForConditionalGeneration.from_pretrained.assert_not_called()


def test_rnnt_checkpoint_on_an_old_transformers_fails_closed_with_the_version_floor():
    mod = _fake_transformers(
        architectures=["ParakeetForRNNT"], model_type="parakeet_rnnt", with_rnnt=False
    )

    with pytest.raises(ModelLoadError) as exc_info:
        _load(mod)

    message = str(exc_info.value)
    assert "AutoModelForRNNT" in message
    assert RNNT_MIN_TRANSFORMERS in message
    assert "5.5.4" in message  # names what is installed
    assert "parakeet.cpp" in message  # names the alternative engine
    mod.WhisperForConditionalGeneration.from_pretrained.assert_not_called()


def test_whisper_checkpoint_is_not_mistaken_for_rnnt():
    mod = _fake_transformers(
        architectures=["WhisperForConditionalGeneration"], model_type="whisper", with_rnnt=True
    )

    _model, _tok, _proc, _fe, _is_mm, is_rnnt = _load(mod)

    assert is_rnnt is False
    mod.AutoModelForRNNT.from_pretrained.assert_not_called()
    mod.WhisperForConditionalGeneration.from_pretrained.assert_called_once()


def test_detection_reads_model_type_when_architectures_are_absent():
    mod = _fake_transformers(architectures=[], model_type="nemotron_asr", with_rnnt=True)
    assert HuggingFaceLoader._is_rnnt_model(mod, "x", {}) is True
    mod2 = _fake_transformers(architectures=[], model_type="wav2vec2", with_rnnt=True)
    assert HuggingFaceLoader._is_rnnt_model(mod2, "x", {}) is False
