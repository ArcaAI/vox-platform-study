"""TASK-934 (G-2 / OD-3 / OD-4 / OD-11) — the decode knobs reach ``InferenceConfig``.

Before this ticket ``compression_ratio_threshold``, ``logprob_threshold``,
``no_speech_threshold``, ``no_repeat_ngram_size``, ``condition_on_prev_tokens`` and
``prev_text_context_words`` were Python literals in :class:`InferenceConfig`: one
number for every agent, every tenant and every fine-tune on the box, with no wire
field, no agent-schema key and no settings descriptor. The gateway now resolves them
(agent → the ASR row's ``_metadata.asr`` profile → absent) and sends what it decided.

What is locked here:

* each of the six lands on the dataclass field the engine actually reads;
* a spec that carries NONE of them keeps today's dataclass defaults verbatim — the
  dataclass stays the one source of engine defaults, and a gateway that has not
  learned the keys yet changes nothing;
* the provenance the gateway attaches (``decoding.sources``, the row's raw
  recommendation on ``models.asr.metadata``) round-trips through ``extra='forbid'``
  and is inert: it never becomes an inference argument;
* ``extra='forbid'`` still refuses a key neither half declares.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from stt.pipeline.dto import InferenceConfig
from stt.pipeline.spec import ResolvedAsrSpec, pipeline_spec_from_resolved

#: The wire key → the ``InferenceConfig`` field it feeds, with a value that is NOT the
#: dataclass default (so a test cannot pass by accident).
KNOBS: dict[str, tuple[str, Any]] = {
    "noSpeechThreshold": ("no_speech_threshold", 0.4),
    "compressionRatioThreshold": ("compression_ratio_threshold", 2.2),
    "logprobThreshold": ("logprob_threshold", -0.8),
    "conditionOnPrevTokens": ("condition_on_prev_tokens", True),
    "noRepeatNgramSize": ("no_repeat_ngram_size", 4),
    "prevTextContextWords": ("prev_text_context_words", 20),
}


def _load_expected(case: str) -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return copy.deepcopy(
                json.loads(candidate.read_text(encoding="utf-8"))[case]["expected"]
            )
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


@pytest.fixture
def platform_default() -> dict[str, Any]:
    return _load_expected("platformDefault")


@pytest.fixture
def tuned() -> dict[str, Any]:
    """The TASK-934 fixture case: a row with a full profile, an agent overriding part of it."""
    return _load_expected("modelProfileDecodeKnobs")


def _inference(raw: dict[str, Any]) -> InferenceConfig:
    spec, _configs = pipeline_spec_from_resolved(ResolvedAsrSpec.model_validate(raw))
    return spec.inference


@pytest.mark.parametrize("wire_key", sorted(KNOBS))
def test_each_knob_reaches_the_inference_config(platform_default, wire_key: str) -> None:
    field, value = KNOBS[wire_key]
    platform_default["decoding"][wire_key] = value
    assert getattr(_inference(platform_default), field) == value


def test_a_spec_without_the_knobs_keeps_todays_dataclass_defaults(platform_default) -> None:
    """Absent ⇒ the engine default. The dataclass stays the ONE source of those numbers."""
    for wire_key in KNOBS:
        assert wire_key not in platform_default["decoding"]
    inference = _inference(platform_default)
    defaults = InferenceConfig()
    for field, _value in KNOBS.values():
        assert getattr(inference, field) == getattr(defaults, field), field
    # Pinned literally, so a change to the dataclass defaults is a visible decision.
    assert inference.no_speech_threshold == 0.6
    assert inference.compression_ratio_threshold == 2.4
    assert inference.logprob_threshold == -1.0
    assert inference.condition_on_prev_tokens is False
    assert inference.no_repeat_ngram_size == 3
    assert inference.prev_text_context_words == 50


def test_the_tuned_fixture_case_maps_the_whole_resolved_profile(tuned) -> None:
    """The OD-3 fold, end to end: the agent's overrides and the row's fill-ins both land."""
    inference = _inference(tuned)
    assert inference.beam_size == 5  # agent over the row's 1
    assert inference.temperature == [0.0]  # the row's
    assert inference.no_speech_threshold == 0.3  # agent over the row's 0.6
    assert inference.compression_ratio_threshold == 2.4  # the row's
    assert inference.logprob_threshold == -1.0  # the row's
    assert inference.condition_on_prev_tokens is True  # the row's
    assert inference.no_repeat_ngram_size == 3  # the row's
    assert inference.prev_text_context_words == 50  # the row's
    # OD-11 — the prompt and the hotwords fold into `instruction`, which is the ONE
    # wire path for these two engine fields.
    assert inference.initial_prompt_text is not None
    assert "Malayalam" in inference.initial_prompt_text
    assert inference.hotwords == ["ceftriaxone", "amoxicillin"]
    # OD-4 — the agent's partial-window override arrives as the EFFECTIVE geometry, so
    # the runtime reads it where it always read the row's.
    assert _spec(tuned).streaming.partial_window_s == pytest.approx(15.0)
    assert inference.max_decode_window_sec == pytest.approx(7.0)


def _spec(raw: dict[str, Any]):
    spec, _configs = pipeline_spec_from_resolved(ResolvedAsrSpec.model_validate(raw))
    return spec


def test_provenance_round_trips_and_is_inert(tuned) -> None:
    """`decoding.sources` and the row's raw recommendation are OBSERVABILITY, never arguments."""
    spec = ResolvedAsrSpec.model_validate(tuned)
    assert spec.decoding.sources is not None
    assert spec.decoding.sources["beamSize"] == "agent"
    assert spec.decoding.sources["conditionOnPrevTokens"] == "model"
    metadata = spec.models.asr.metadata
    assert metadata is not None and metadata.decoding is not None
    assert metadata.decoding.beam_size == 1  # what the ROW recommended, not what won
    assert metadata.initial_prompt is not None
    # Round-trips byte-for-byte — the parity suite asserts this for every case, repeated
    # here so a change to THESE fields fails in the file that owns them.
    assert spec.model_dump(by_alias=True, mode="json") == tuned


def test_an_undeclared_decoding_key_is_still_a_contract_drift(platform_default) -> None:
    platform_default["decoding"]["bestOf"] = 5
    with pytest.raises(ValidationError):
        ResolvedAsrSpec.model_validate(platform_default)
