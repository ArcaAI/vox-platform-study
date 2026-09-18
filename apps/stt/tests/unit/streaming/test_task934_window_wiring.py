"""TASK-934 lane S — the two decode windows, from the wire to the preprocessor.

The live experiment of 2026-09-09 set the served ASR row to
``{maxDecodeWindowSec: 7, partialWindowSec: 15}``, restarted the stack, and still
observed 6 s partial windows (``t=0.06-6.05``, ``1.12-7.10``, …) and a
whole-buffer final. Those two numbers are the RUNTIME DEFAULTS —
``StreamingPreprocessor._DEFAULT_PARTIAL_WINDOW_S`` (6.0) and
``InferenceConfig.max_decode_window_sec`` (0.0 = no chunking guard) — and they
can only BOTH stand when ``models.asr.metadata`` is absent from the spec that
reached ``apps/stt``. These tests pin the STT half of that chain end to end, so a
repeat of the experiment localises the loss instead of re-opening the search:

- a spec that CARRIES the geometry reaches the preprocessor and the inference
  config with the declared values, and the two are independent;
- a spec that carries NO ``metadata`` produces exactly the observed signature.

The fixture is the committed cross-language parity fixture, so this exercises the
same wire shape the gateway emits.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from stt.pipeline.spec import bundle_from_resolved
from stt.streaming.preprocessor import _DEFAULT_PARTIAL_WINDOW_S, StreamingPreprocessor
from stt.streaming.session_manager import SessionManager


def _fixture() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


def _spec_with_asr_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    """The `platformDefault` resolved spec, with its ASR row's geometry replaced."""
    spec = copy.deepcopy(_fixture()["platformDefault"]["expected"])
    if metadata is None:
        spec["models"]["asr"].pop("metadata", None)
    else:
        spec["models"]["asr"]["metadata"] = metadata
    return spec


def _manager() -> MagicMock:
    mgr = MagicMock(spec=SessionManager)
    mgr._profile = MagicMock()
    mgr._profile.vad_silence_threshold_ms = 500
    mgr._make_endpointer = MagicMock(return_value=None)
    return mgr


def _preprocessor(pipeline_spec: Any) -> StreamingPreprocessor:
    kwargs = SessionManager._build_preprocessor_vad_kwargs(_manager(), pipeline_spec)
    return StreamingPreprocessor(session_id="s-934", sample_rate=16000, **kwargs)


@pytest.mark.unit
class TestModelGeometryReachesTheRuntime:
    def test_partial_window_reaches_the_preprocessor_independently_of_the_decode_window(
        self,
    ) -> None:
        """`{7, 15}` — the candidate profile — must arrive as 15 s AND 7 s.

        The two members travel on different rails (`StreamingConfig.partial_window_s`
        vs `InferenceConfig.max_decode_window_sec`) and are read by different
        components, so a test that checks only one of them cannot see the pairing
        the measurements actually depend on.
        """
        bundle = bundle_from_resolved(
            _spec_with_asr_metadata({"maxDecodeWindowSec": 7, "partialWindowSec": 15})
        )
        pipeline_spec = bundle.pipeline_specs[bundle.spec.runtime_key]

        assert pipeline_spec.streaming.partial_window_s == 15.0
        assert pipeline_spec.inference.max_decode_window_sec == 7.0
        assert _preprocessor(pipeline_spec)._partial_window_s == 15.0

    def test_absent_metadata_is_the_live_failure_signature(self) -> None:
        """No `metadata` ⇒ 6 s partials + an unguarded whole-buffer final.

        This is the pair of numbers the 2026-09-09 run showed. Because no other
        input produces BOTH (a declared window of 7 s would have split the final;
        a declared partial window of any value would have moved the partial),
        observing them again means the geometry was dropped BEFORE `apps/stt`.
        """
        bundle = bundle_from_resolved(_spec_with_asr_metadata(None))
        pipeline_spec = bundle.pipeline_specs[bundle.spec.runtime_key]

        assert pipeline_spec.streaming.partial_window_s is None
        assert pipeline_spec.inference.max_decode_window_sec == 0.0
        assert _preprocessor(pipeline_spec)._partial_window_s == _DEFAULT_PARTIAL_WINDOW_S == 6.0

    def test_each_chain_carries_its_own_geometry(self) -> None:
        """The fallback chain decodes on ITS row's window, never the primary's."""
        spec = _spec_with_asr_metadata({"maxDecodeWindowSec": 7, "partialWindowSec": 15})
        # TASK-985 (M-49) — the fallback is now an ORDERED CHAIN, and `fallback.spec`
        # is a one-release alias for `chain[0]`. `fallback_chain()` prefers the chain,
        # so writing only the alias left this asserting against the fixture's own
        # `chain[0]` and silently measuring the wrong entry. Set both: the chain is
        # the contract, the alias is what a gateway that predates it still sends.
        fallback_metadata = {"maxDecodeWindowSec": 30, "partialWindowSec": 30}
        spec["fallback"]["spec"]["models"]["asr"]["metadata"] = dict(fallback_metadata)
        for entry in spec["fallback"]["chain"]:
            entry["models"]["asr"]["metadata"] = dict(fallback_metadata)
        bundle = bundle_from_resolved(spec)

        primary = bundle.pipeline_specs[bundle.spec.runtime_key]
        fallback_key = bundle.spec.fallback.spec.runtime_key  # type: ignore[union-attr]
        fallback = bundle.pipeline_specs[fallback_key]

        assert (primary.inference.max_decode_window_sec, primary.streaming.partial_window_s) == (
            7.0,
            15.0,
        )
        assert (fallback.inference.max_decode_window_sec, fallback.streaming.partial_window_s) == (
            30.0,
            30.0,
        )
