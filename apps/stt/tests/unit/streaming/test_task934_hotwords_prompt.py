"""TASK-934 — the model profile's ``hotwords`` reach whisper.cpp as prompt vocabulary.

whisper.cpp has no hotword API; the established technique is to list the vocabulary in the
decoder prompt. Before this pin the adapter ignored ``InferenceConfig.hotwords`` entirely, so
an admin who set them on the profile (or the agent) changed nothing for the served engine.
"""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat
from stt.streaming.whisper_cpp_asr import WhisperCppAsrAdapter

SAMPLE_RATE = 16000


class _CapturingModel:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def transcribe(self, audio, **params):  # noqa: ANN001 — pywhispercpp signature
        self.calls.append(params)
        return []


def _adapter(hotwords: list[str] | None) -> tuple[WhisperCppAsrAdapter, _CapturingModel]:
    model = _CapturingModel()
    loaded = LoadedModel(
        model_id="task-934-hotwords",
        model_slug="task-934-hotwords",
        model=model,
        format=AiModelFormat.WHISPER_CPP,
    )
    config = SimpleNamespace(language=None, hotwords=hotwords, max_decode_window_sec=0.0)
    return WhisperCppAsrAdapter(loaded, inference_config=config), model


def test_hotwords_are_appended_to_the_decoder_prompt() -> None:
    adapter, model = _adapter(["ceftriaxone", "amoxicillin"])
    adapter(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE, prompt="Clinical consultation.")
    assert model.calls, "the adapter did not decode"
    assert model.calls[-1]["initial_prompt"] == "Clinical consultation. ceftriaxone, amoxicillin"


def test_hotwords_alone_form_the_prompt_when_no_prompt_is_set() -> None:
    adapter, model = _adapter(["troponin"])
    adapter(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE, prompt=None)
    assert model.calls[-1]["initial_prompt"] == "troponin"


def test_no_hotwords_leaves_the_prompt_untouched() -> None:
    adapter, model = _adapter(None)
    adapter(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE, prompt="Clinical consultation.")
    assert model.calls[-1]["initial_prompt"] == "Clinical consultation."
    adapter2, model2 = _adapter([" ", ""])
    adapter2(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE, prompt=None)
    assert model2.calls[-1]["initial_prompt"] == ""
