"""TASK-1047 OD-10 / FC-8a — `/classify/tokens` windows long text server-side.

Five callers send whole transcripts and notes (up to 200k chars) to NER. GLiNER2
memory is quadratic in input length, so the cure is not a bigger single pass:
above `nlp.inference.maxInputChars` the route splits the text into
`nlp.ner.windowChars` + `nlp.ner.windowOverlapChars` windows, runs each through the
SAME inference path (inference semaphore, one window at a time), re-bases every
span onto the original text and merges the overlap. Above `nlp.ner.maxRequestChars`
it is still a 413. Every other capped route keeps its 413 above `maxInputChars`.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest

from nlp.services.ner_windowing import plan_ner_windows

TENANT = "11111111-1111-1111-1111-111111111111"
MODEL = "some/gliner2-model"

#: What the fake extractor "recognises": every occurrence of each term, per window.
TERMS = {"FEVR": "symptom", "HEAD ACHE": "symptom", "ASPN": "drug"}


@pytest.fixture(autouse=True)
def _reset_bounds():
    from nlp.core import bounds

    bounds.reset_bounds()
    yield
    bounds.reset_bounds()


class WindowRuntime:
    """Stands in for the loaded gliner2 runtime; window k scores 0.5 + 0.1·k."""

    def __init__(self) -> None:
        self.texts: list[str] = []

    async def extract_entities(
        self, text: str, labels: list[str], threshold: float
    ) -> list[dict[str, Any]]:
        call = len(self.texts)
        self.texts.append(text)
        spans = []
        for term, label in TERMS.items():
            pos = text.find(term)
            while pos != -1:
                spans.append(
                    {
                        "label": label,
                        "start": pos,
                        "end": pos + len(term),
                        "score": min(1.0, 0.5 + 0.1 * call),
                        "text": term,
                    }
                )
                pos = text.find(term, pos + 1)
        return spans


def _install(monkeypatch, runtime: WindowRuntime) -> None:
    import nlp.api.v1.rest.classify as classify
    from nlp.services.gliner_token_classifier import Gliner2TokenClassifier

    service = Gliner2TokenClassifier(model_name=MODEL, runtime=runtime)
    service.is_initialized = True

    @asynccontextmanager
    async def pinned(*_a: Any, **_k: Any):
        yield service

    monkeypatch.setattr(classify, "pinned_token_classifier", pinned)


def _boom_acquire(*_a: Any, **_k: Any):
    raise AssertionError("a model was acquired for an oversized input")


def _body(text: str) -> dict[str, Any]:
    return {"text": text, "model_name": MODEL, "labels": ["symptom", "drug"]}


def _place(chars: list[str], at: int, term: str) -> None:
    chars[at : at + len(term)] = list(term)


def _long_text() -> str:
    """20,000 chars of `abcd ` (a space at every index ≡ 4 mod 5), with terms placed.

    The default plan (4,000 + 256) cuts at exactly 4,000 / 8,000 / 12,000 /
    16,000, so the windows are [0,4000) [3744,8000) [7744,12000) [11744,16000)
    [15744,20000).
    """
    chars = list("abcd " * 4000)
    _place(chars, 1000, "FEVR")  # window 0 only
    _place(chars, 3800, "FEVR")  # in the [3744,4000) overlap: windows 0 AND 1
    _place(chars, 3995, "HEAD ACHE")  # straddles the 4,000 cut: window 1 only
    _place(chars, 10000, "ASPN")  # window 2 only
    _place(chars, 19995, "ASPN")  # last window only
    return "".join(chars)


EXPECTED_WINDOWS = [(0, 4000), (3744, 8000), (7744, 12000), (11744, 16000), (15744, 20000)]


# ── bounds ───────────────────────────────────────────────────────────────


def test_default_ner_bounds_are_the_frozen_fc8a_values():
    from nlp.core import bounds

    b = bounds.get_bounds()
    assert (b.ner_max_request_chars, b.ner_window_chars, b.ner_window_overlap_chars) == (
        200000,
        2000,
        256,
    )
    assert bounds.resolve_ner_window() == (2000, 256)


def test_ner_bounds_follow_the_control_plane_snapshot():
    from nlp.core import bounds
    from nlp.core.effective_config import EffectiveConfigSnapshot

    snap = EffectiveConfigSnapshot(
        raw={
            "settings": {
                "nlp.ner.maxRequestChars": {"value": 50000},
                "nlp.ner.windowChars": {"value": 3000},
                "nlp.ner.windowOverlapChars": {"value": 0},
            }
        },
        ok=True,
    )
    bounds.apply_snapshot(snap)
    b = bounds.get_bounds()
    assert (b.ner_max_request_chars, b.ner_window_chars, b.ner_window_overlap_chars) == (
        50000,
        3000,
        0,
    )


def test_a_window_pair_over_max_input_chars_falls_back_to_the_defaults():
    from nlp.core import bounds

    bounds.set_bounds(ner_window_chars=8000, ner_window_overlap_chars=500)
    assert bounds.resolve_ner_window() == (2000, 256)


def test_defaults_that_exceed_a_lowered_cap_shrink_to_fit_it():
    from nlp.core import bounds

    bounds.set_bounds(max_input_chars=1000)
    window, overlap = bounds.resolve_ner_window()
    assert window > 0 and overlap >= 0
    assert window + overlap <= 1000


# ── window plan ──────────────────────────────────────────────────────────


def test_hard_cuts_when_there_is_no_whitespace():
    from nlp.services.ner_windowing import plan_ner_windows

    assert plan_ner_windows("x" * 20000, 4000, 256) == EXPECTED_WINDOWS


def test_cut_prefers_whitespace_in_the_last_tenth_of_the_window():
    from nlp.services.ner_windowing import plan_ner_windows

    chars = ["x"] * 9000
    chars[3700] = " "  # inside [3600, 4000)
    chars[3500] = " "  # outside the last 10% — ignored
    windows = plan_ner_windows("".join(chars), 4000, 256)
    assert windows[0] == (0, 3701)
    # The overlap [3445, 3701) holds a space at 3500: the next window starts after it,
    # never mid-word (a fragment of a different label would otherwise survive the merge).
    assert windows[1][0] == 3501
    for start, end in windows:
        assert end - start <= 4256
    assert windows[-1][1] == 9000


def test_a_window_never_starts_mid_word_when_the_overlap_has_whitespace():
    from nlp.services.ner_windowing import plan_ner_windows

    text = " ".join(f"word{i:05d}" for i in range(3000))  # 10-char tokens, ~30k chars
    for start, end in plan_ner_windows(text, 4000, 256)[1:]:
        assert text[start - 1].isspace(), (start, text[start - 5 : start + 5])
        assert end - start <= 4256


# ── merge ────────────────────────────────────────────────────────────────


def _entity(label: str, start: int, end: int, score: float, text: str):
    from nlp.schemas.common import Entity, TextPosition

    return Entity(
        id=f"{label}-{start}-{end}-{score}",
        text=text[start:end],
        normalized_text=text[start:end].lower(),
        entity_type=label,
        confidence=score,
        position=TextPosition(start=start, end=end),
    )


def test_overlapping_same_label_spans_from_different_windows_keep_the_longer():
    from nlp.services.ner_windowing import merge_window_entities

    text = "".join(chr(97 + i % 26) for i in range(300))
    windows = [(0, 200), (100, 300)]
    w0 = [_entity("drug", 100, 110, 0.9, text[0:200])]
    w1 = [_entity("drug", 5, 20, 0.5, text[100:300])]  # absolute [105, 120)
    merged = merge_window_entities(text, windows, [w0, w1])
    assert [(e.position.start, e.position.end, e.confidence) for e in merged] == [(105, 120, 0.5)]
    assert merged[0].text == text[105:120]


def test_equal_length_overlap_tie_keeps_the_higher_score():
    from nlp.services.ner_windowing import merge_window_entities

    text = "y" * 300
    windows = [(0, 200), (100, 300)]
    w0 = [_entity("drug", 100, 110, 0.7, text[0:200])]
    w1 = [_entity("drug", 5, 15, 0.8, text[100:300])]  # absolute [105, 115)
    merged = merge_window_entities(text, windows, [w0, w1])
    assert [(e.position.start, e.position.end, e.confidence) for e in merged] == [(105, 115, 0.8)]


def test_identical_spans_keep_the_highest_score():
    from nlp.services.ner_windowing import merge_window_entities

    text = "z" * 300
    windows = [(0, 200), (100, 300)]
    w0 = [_entity("drug", 150, 160, 0.4, text[0:200])]
    w1 = [_entity("drug", 50, 60, 0.95, text[100:300])]  # absolute [150, 160)
    merged = merge_window_entities(text, windows, [w0, w1])
    assert [(e.position.start, e.position.end, e.confidence) for e in merged] == [(150, 160, 0.95)]


def test_same_window_overlaps_and_different_labels_are_never_merged():
    from nlp.services.ner_windowing import merge_window_entities

    text = "q" * 300
    windows = [(0, 200), (100, 300)]
    w0 = [
        _entity("drug", 10, 20, 0.6, text[0:200]),
        _entity("drug", 15, 30, 0.6, text[0:200]),  # same window — both kept
        _entity("symptom", 120, 130, 0.6, text[0:200]),
    ]
    w1 = [_entity("drug", 22, 28, 0.6, text[100:300])]  # absolute [122, 128), other label
    merged = merge_window_entities(text, windows, [w0, w1])
    assert [(e.entity_type, e.position.start, e.position.end) for e in merged] == [
        ("drug", 10, 20),
        ("drug", 15, 30),
        ("symptom", 120, 130),
        ("drug", 122, 128),
    ]


# ── route ────────────────────────────────────────────────────────────────


def test_short_text_is_one_unchanged_pass(client, monkeypatch):
    runtime = WindowRuntime()
    _install(monkeypatch, runtime)
    text = "Patient reports FEVR since Monday."
    response = client.post("/api/v1/classify/tokens", json=_body(text))
    assert response.status_code == 200
    assert runtime.texts == [text]
    (entity,) = response.json()["entities"]
    assert entity["position"] == {"start": 16, "end": 20}
    assert entity["text"] == "FEVR"


def test_text_at_max_input_chars_is_still_one_pass(client, monkeypatch):
    runtime = WindowRuntime()
    _install(monkeypatch, runtime)
    text = "a" * 8192
    assert client.post("/api/v1/classify/tokens", json=_body(text)).status_code == 200
    assert runtime.texts == [text]


def test_a_20k_text_is_windowed_rebased_and_merged(client, monkeypatch):
    from nlp.core import bounds
    from nlp.core.metrics import NLP_NER_WINDOWS_TOTAL

    # The fixture's overlap/straddle positions are laid out for 4,000-char windows.
    bounds.set_bounds(ner_window_chars=4000)
    runtime = WindowRuntime()
    _install(monkeypatch, runtime)
    text = _long_text()
    before = NLP_NER_WINDOWS_TOTAL._value.get()

    response = client.post("/api/v1/classify/tokens", json=_body(text))

    assert response.status_code == 200
    assert runtime.texts == [text[s:e] for s, e in plan_ner_windows(text, 4000, 256)]
    assert all(len(window) <= 4256 for window in runtime.texts)
    assert NLP_NER_WINDOWS_TOTAL._value.get() == before + len(plan_ner_windows(text, 4000, 256))

    body = response.json()
    got = [
        (e["entity_type"], e["position"]["start"], e["position"]["end"], e["confidence"])
        for e in body["entities"]
    ]
    assert got == [
        ("symptom", 1000, 1004, 0.5),
        # in the overlap: seen by windows 0 (0.5) and 1 (0.6) — returned once, best score
        ("symptom", 3800, 3804, pytest.approx(0.6)),
        # straddles the 4,000 cut: only window 1 sees it whole — returned once
        ("symptom", 3995, 4004, pytest.approx(0.6)),
        ("drug", 10000, 10004, pytest.approx(0.7)),
        ("drug", 19995, 19999, pytest.approx(0.9)),
    ]
    for e in body["entities"]:
        assert e["text"] == text[e["position"]["start"] : e["position"]["end"]]
    # the response SHAPE is today's
    assert set(body) == {"entities", "model_version", "vitals", "inference_ms", "device"}


def test_a_misconfigured_window_pair_runs_on_the_defaults(client, monkeypatch):
    from nlp.core import bounds

    bounds.set_bounds(ner_window_chars=8000, ner_window_overlap_chars=500)
    runtime = WindowRuntime()
    _install(monkeypatch, runtime)
    text = _long_text()
    assert client.post("/api/v1/classify/tokens", json=_body(text)).status_code == 200
    assert runtime.texts == [text[s:e] for s, e in plan_ner_windows(text, 2000, 256)]


def test_over_max_request_chars_is_413_without_loading_a_model(client, monkeypatch):
    import nlp.api.v1.rest.classify as classify
    from nlp.core import bounds

    bounds.set_bounds(max_input_chars=500, ner_max_request_chars=1000)
    monkeypatch.setattr(classify, "pinned_token_classifier", _boom_acquire)
    response = client.post("/api/v1/classify/tokens", json=_body("x" * 1001))
    assert response.status_code == 413
    assert response.json() == {"code": "INPUT_EXCEEDS_WINDOW", "maxChars": 1000}


def test_default_max_request_chars_is_200k(client, monkeypatch):
    import nlp.api.v1.rest.classify as classify

    monkeypatch.setattr(classify, "pinned_token_classifier", _boom_acquire)
    response = client.post("/api/v1/classify/tokens", json=_body("x" * 200001))
    assert response.status_code == 413
    assert response.json() == {"code": "INPUT_EXCEEDS_WINDOW", "maxChars": 200000}


def test_classify_text_keeps_its_413_above_max_input_chars(client, monkeypatch):
    import nlp.api.v1.rest.classify as classify

    monkeypatch.setattr(classify, "pinned_text_classifier", _boom_acquire)
    response = client.post("/api/v1/classify/text", json={"text": "x" * 8193, "model_name": MODEL})
    assert response.status_code == 413
    assert response.json() == {"code": "INPUT_EXCEEDS_WINDOW", "maxChars": 8192}


def test_guard_pii_keeps_its_413_above_max_input_chars(client, monkeypatch):
    import nlp.api.v1.rest.guard as guard

    monkeypatch.setattr(guard, "_acquire_guard", _boom_acquire)
    body = {"text": "x" * 8193, "model_name": MODEL, "labels": ["email"], "tenant_id": TENANT}
    response = client.post("/api/v1/guard/pii", json=body)
    assert response.status_code == 413
    assert response.json() == {"code": "INPUT_EXCEEDS_WINDOW", "maxChars": 8192}
