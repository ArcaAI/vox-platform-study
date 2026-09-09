"""TASK-934 / TASK-938 — the model profile's ``hotwords`` ARE the decoder prompt vocabulary.

whisper.cpp has no hotword API, so TASK-934 appended the list to the ``initial_prompt`` —
the established biasing technique. TASK-935 removed it again after the first live run (only
possible once TASK-935 fixed the per-session spec lookup) collapsed the ml-en fine-tune's
decode into script garbage on the discharge fixture, with six terms exactly as badly as
twenty. TASK-938 restores it by owner directive as one arm of a live A/B alongside both
priming-prompt switches.

These tests pin the WIRING, not the verdict on it: the terms reach the decoder, appended
after the agent's own ``instruction.initialPrompt``, and blank entries never do. If the A/B
sends this back off, that is a one-line change here and in the adapter — TASK-937 R-4 turns
it into a per-model ``decoding.hotwordsInPrompt`` switch so it stops being global at all.
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
        model_id="task-935-hotwords",
        model_slug="task-935-hotwords",
        model=model,
        format=AiModelFormat.WHISPER_CPP,
    )
    config = SimpleNamespace(language=None, hotwords=hotwords, max_decode_window_sec=0.0)
    return WhisperCppAsrAdapter(loaded, inference_config=config), model


def test_hotwords_are_appended_after_the_agents_prompt() -> None:
    adapter, model = _adapter(["ceftriaxone", "amoxicillin"])
    adapter(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE, prompt="Clinical consultation.")
    assert model.calls, "the adapter did not decode"
    assert model.calls[-1]["initial_prompt"] == "Clinical consultation. ceftriaxone, amoxicillin"


def test_hotwords_without_a_prompt_stand_alone() -> None:
    adapter, model = _adapter(["troponin"])
    adapter(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE, prompt=None)
    assert model.calls[-1]["initial_prompt"] == "troponin"


def test_absent_or_blank_hotwords_leave_the_agents_prompt_alone() -> None:
    adapter, model = _adapter(None)
    adapter(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE, prompt="Clinical consultation.")
    assert model.calls[-1]["initial_prompt"] == "Clinical consultation."
    adapter2, model2 = _adapter([" ", ""])
    adapter2(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE, prompt=None)
    assert model2.calls[-1]["initial_prompt"] == ""
