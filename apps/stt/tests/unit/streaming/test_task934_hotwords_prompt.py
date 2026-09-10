"""TASK-946 (OD-1) — the hotword append to the whisper.cpp decoder prompt is PER MODEL.

whisper.cpp has no hotword API, so TASK-934 appended ``decoding.hotwords`` to the
``initial_prompt`` — the established biasing technique. TASK-935 removed it again after
the first live run collapsed the ml-en fine-tune's decode into script garbage; TASK-938
restored it globally by owner directive as one arm of a live A/B; that A/B has now been
run offline on the owner's recording (7 s spans, ``language=en``, temperature 0) and the
verdict is unambiguous — no prompt decodes 100 % Latin, the terms alone 80 % (with one
term looping 30×), and the production combination 2 %.

TASK-937 R-4 is therefore implemented rather than deferred: the append is a property of
the ROW (``AiModel._metadata.asr.decoding.hotwordsInPrompt`` → ``decoding.hotwordsInPrompt``
→ ``InferenceConfig.hotwords_in_prompt``), and the ENGINE DEFAULT is OFF.

These tests pin the WIRING and the DEFAULT: silence leaves the caller's prompt untouched,
an opted-in row gets the append after the agent's own prompt, and blank entries never
reach it either way. The terms themselves are unaffected in both states — the lexicon
correction stage binds the same list (TASK-935 OD-5 a).
"""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat, InferenceConfig
from stt.streaming.whisper_cpp_asr import WhisperCppAsrAdapter

SAMPLE_RATE = 16000


class _CapturingModel:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def transcribe(self, audio, **params):  # noqa: ANN001 — pywhispercpp signature
        self.calls.append(params)
        return []


def _adapter(
    hotwords: list[str] | None,
    *,
    hotwords_in_prompt: bool | None = None,
) -> tuple[WhisperCppAsrAdapter, _CapturingModel]:
    """An adapter over a capturing model.

    ``hotwords_in_prompt=None`` OMITS the attribute entirely — the shape a gateway that
    has not learned the key produces, and the one that must not turn the append on.
    """
    model = _CapturingModel()
    loaded = LoadedModel(
        model_id="task-946-hotwords",
        model_slug="task-946-hotwords",
        model=model,
        format=AiModelFormat.WHISPER_CPP,
    )
    kwargs: dict[str, object] = {
        "language": None,
        "hotwords": hotwords,
        "max_decode_window_sec": 0.0,
    }
    if hotwords_in_prompt is not None:
        kwargs["hotwords_in_prompt"] = hotwords_in_prompt
    return WhisperCppAsrAdapter(loaded, inference_config=SimpleNamespace(**kwargs)), model


def _decode(adapter: WhisperCppAsrAdapter, prompt: str | None) -> None:
    adapter(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE, prompt=prompt)


def test_the_engine_default_is_off_so_hotwords_never_reach_the_prompt() -> None:
    """The regression this ticket exists for: terms configured, prompt untouched."""
    adapter, model = _adapter(["ceftriaxone", "amoxicillin"])
    _decode(adapter, "Clinical consultation.")
    assert model.calls, "the adapter did not decode"
    assert model.calls[-1]["initial_prompt"] == "Clinical consultation."


def test_an_explicit_false_is_the_same_as_silence() -> None:
    adapter, model = _adapter(["ceftriaxone"], hotwords_in_prompt=False)
    _decode(adapter, "Clinical consultation.")
    assert model.calls[-1]["initial_prompt"] == "Clinical consultation."


def test_the_dataclass_default_is_off_too() -> None:
    """`InferenceConfig` is the one source of engine defaults — pinned literally."""
    assert InferenceConfig().hotwords_in_prompt is False


def test_an_opted_in_row_appends_after_the_agents_prompt() -> None:
    adapter, model = _adapter(["ceftriaxone", "amoxicillin"], hotwords_in_prompt=True)
    _decode(adapter, "Clinical consultation.")
    assert model.calls[-1]["initial_prompt"] == "Clinical consultation. ceftriaxone, amoxicillin"


def test_an_opted_in_row_without_a_prompt_stands_alone() -> None:
    adapter, model = _adapter(["troponin"], hotwords_in_prompt=True)
    _decode(adapter, None)
    assert model.calls[-1]["initial_prompt"] == "troponin"


def test_blank_and_absent_hotwords_leave_the_prompt_alone_in_both_states() -> None:
    for switch in (None, True):
        adapter, model = _adapter(None, hotwords_in_prompt=switch)
        _decode(adapter, "Clinical consultation.")
        assert model.calls[-1]["initial_prompt"] == "Clinical consultation."

        adapter2, model2 = _adapter([" ", ""], hotwords_in_prompt=switch)
        _decode(adapter2, None)
        assert model2.calls[-1]["initial_prompt"] == ""


def test_the_terms_are_kept_whatever_the_switch_says() -> None:
    """OD-1 gates the PROMPT, never the vocabulary: the lexicon stage reads this list."""
    for switch in (None, False, True):
        adapter, _model = _adapter(["ceftriaxone", "amoxicillin"], hotwords_in_prompt=switch)
        assert adapter._hotwords == ["ceftriaxone", "amoxicillin"]
