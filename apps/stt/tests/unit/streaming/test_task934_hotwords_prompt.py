"""TASK-935 — the model profile's ``hotwords`` do NOT enter the whisper.cpp prompt.

TASK-934 appended the list to the decoder prompt (whisper.cpp has no hotword API). That code
never ran on a live session until TASK-935 fixed the per-session spec lookup, and the first
real run showed why it must not: on the discharge fixture the ml-en fine-tune's decode
collapsed into script garbage with the terms in the prompt — with six terms exactly as with
twenty. The list stays on the wire for the lexicon stage and for engines with a native
hotword parameter; the ONE prompt channel here is the agent's ``instruction.initialPrompt``.
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


def test_hotwords_never_enter_the_decoder_prompt() -> None:
    adapter, model = _adapter(["ceftriaxone", "amoxicillin"])
    adapter(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE, prompt="Clinical consultation.")
    assert model.calls, "the adapter did not decode"
    assert model.calls[-1]["initial_prompt"] == "Clinical consultation."


def test_hotwords_without_a_prompt_leave_the_prompt_empty() -> None:
    adapter, model = _adapter(["troponin"])
    adapter(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE, prompt=None)
    assert model.calls[-1]["initial_prompt"] == ""


def test_the_prompt_is_the_agents_initial_prompt_alone() -> None:
    adapter, model = _adapter(None)
    adapter(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE, prompt="Clinical consultation.")
    assert model.calls[-1]["initial_prompt"] == "Clinical consultation."
    adapter2, model2 = _adapter([" ", ""])
    adapter2(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE, prompt=None)
    assert model2.calls[-1]["initial_prompt"] == ""
