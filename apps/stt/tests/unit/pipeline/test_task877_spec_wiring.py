"""TASK-877 — the fields ``ResolvedAsrSpec`` declares actually reach the runtime.

Before this ticket ``pipeline_spec_from_resolved`` built ``StreamingConfig`` from
``post_processing.stabilizer`` alone and never read ``core.streaming`` at all, and
``decoding.vad_filter`` had no consumer. An agent that asked for semantic
endpointing got fixed endpointing; ``max_utterance_sec`` was silently ignored;
``partial_interval_ms`` lost to the platform key ``stt.streaming.partialIntervalS``.

The owner's model is that the AGENT owns per-session ASR behaviour, so every one of
these is asserted here as "the spec value is what the runtime receives".

The two chunking fields and the ``streaming.semantic`` block are declared OPTIONAL on
the wire: the gateway may or may not send them (TASK-876 adds the agent-schema names),
so they must round-trip both when present and when absent.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from stt.pipeline.dto import EndpointConfig
from stt.pipeline.spec import ResolvedAsrSpec, pipeline_spec_from_resolved


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


def _mapped(raw: dict[str, Any]):
    spec, _configs = pipeline_spec_from_resolved(ResolvedAsrSpec.model_validate(raw))
    return spec


# ---------------------------------------------------------------------------
# streaming.*
# ---------------------------------------------------------------------------


def test_partial_interval_ms_reaches_the_streaming_config(platform_default) -> None:
    """500 ms on the wire is 0.5 s on the runtime dataclass — the session's cadence."""
    platform_default["streaming"]["partialIntervalMs"] = 500
    assert _mapped(platform_default).streaming.partial_interval_s == pytest.approx(0.5)


def test_absent_partial_interval_leaves_the_engine_default(platform_default) -> None:
    """`null` means "the agent said nothing" — never a substituted platform value."""
    platform_default["streaming"]["partialIntervalMs"] = None
    assert _mapped(platform_default).streaming.partial_interval_s is None


def test_max_utterance_sec_reaches_the_streaming_config(platform_default) -> None:
    platform_default["streaming"]["maxUtteranceSec"] = 30
    assert _mapped(platform_default).streaming.max_utterance_sec == 30


def test_semantic_endpointing_builds_an_enabled_endpoint_config(platform_default) -> None:
    """`endpointing: "semantic"` is what engages the semantic endpointer.

    `session_manager._resolve_endpoint_config` reads `preprocessing.endpoint`; the
    mapper never set it, which is why the agent's choice could not engage anything.
    """
    platform_default["streaming"]["endpointing"] = "semantic"
    endpoint = _mapped(platform_default).preprocessing.endpoint
    assert isinstance(endpoint, EndpointConfig)
    assert endpoint.enabled is True


def test_fixed_endpointing_leaves_the_endpoint_config_disabled(platform_default) -> None:
    platform_default["streaming"]["endpointing"] = "fixed"
    assert _mapped(platform_default).preprocessing.endpoint.enabled is False


def test_semantic_block_tunes_the_endpoint_config(platform_default) -> None:
    """The four knobs the deleted `stt.semanticEndpoint.*` family used to carry."""
    platform_default["streaming"]["endpointing"] = "semantic"
    platform_default["streaming"]["semantic"] = {
        "minSilenceMs": 240,
        "maxSilenceMs": 600,
        "confidenceThreshold": 0.9,
        "minWords": 5,
    }
    endpoint = _mapped(platform_default).preprocessing.endpoint
    assert endpoint.min_endpoint_silence_ms == 240
    assert endpoint.max_endpoint_silence_ms == 600
    assert endpoint.confidence_threshold == pytest.approx(0.9)
    assert endpoint.min_words == 5


def test_semantic_block_is_optional_and_keeps_the_dataclass_defaults(platform_default) -> None:
    platform_default["streaming"]["endpointing"] = "semantic"
    platform_default["streaming"].pop("semantic", None)
    endpoint = _mapped(platform_default).preprocessing.endpoint
    defaults = EndpointConfig()
    assert endpoint.min_endpoint_silence_ms == defaults.min_endpoint_silence_ms
    assert endpoint.confidence_threshold == defaults.confidence_threshold
    assert endpoint.min_words == defaults.min_words


def test_endpointing_model_role_supplies_the_eou_model(platform_default) -> None:
    """The agent's model chain — not a free-string platform key — names the EOU model."""
    platform_default["streaming"]["endpointing"] = "semantic"
    platform_default["models"]["endpointing"] = {
        "role": "endpointing",
        "slug": "smart-turn-v3",
        "taskType": "TEXT_CLASSIFICATION",
        "format": "ONNX",
        "sourceUri": "pipecat-ai/smart-turn-v3",
        "sourceRevision": None,
        "localPath": None,
        "checksum": None,
        "computeType": None,
        "provider": None,
        "tenantId": "00000000-0000-0000-0000-000000000000",
    }
    spec, configs = pipeline_spec_from_resolved(
        ResolvedAsrSpec.model_validate(platform_default)
    )
    assert spec.preprocessing.endpoint.model_id == "smart-turn-v3"
    # Referenced by slug only — the endpointer loads it lazily, the model cache does not.
    assert "smart-turn-v3" not in configs


def test_no_endpointing_model_means_the_heuristic_core(platform_default) -> None:
    platform_default["streaming"]["endpointing"] = "semantic"
    assert _mapped(platform_default).preprocessing.endpoint.model_id == ""


# ---------------------------------------------------------------------------
# decoding.*
# ---------------------------------------------------------------------------


def test_vad_filter_reaches_the_inference_config(platform_default) -> None:
    """`decoding.vadFilter` was dropped; the adapter hardcoded False."""
    platform_default["decoding"]["vadFilter"] = True
    assert _mapped(platform_default).inference.vad_filter is True


def test_vad_filter_defaults_off(platform_default) -> None:
    platform_default["decoding"]["vadFilter"] = False
    assert _mapped(platform_default).inference.vad_filter is False


def test_chunking_fields_are_optional_and_absent_by_default(platform_default) -> None:
    """Absent ⇒ the ENGINE defaults.

    TASK-877 wrote "the batch path keeps the platform `stt.transcription.*` values"
    here. TASK-880 deleted those keys: the spec is the only source, so an agent that
    says nothing gets `InferenceConfig`'s own defaults — the same 15 s and `[4, 2]`
    those keys carried, declared where every other engine default lives.
    """
    platform_default["decoding"].pop("chunkLengthSec", None)
    platform_default["decoding"].pop("strideLengthSec", None)
    inference = _mapped(platform_default).inference
    assert inference.chunk_length_sec == pytest.approx(15.0)
    assert inference.stride_length_sec == (4, 2)


def test_chunking_fields_reach_the_inference_config(platform_default) -> None:
    platform_default["decoding"]["chunkLengthSec"] = 20
    platform_default["decoding"]["strideLengthSec"] = [5, 3]
    inference = _mapped(platform_default).inference
    assert inference.chunk_length_sec == pytest.approx(20.0)
    assert inference.stride_length_sec == (5, 3)


# ---------------------------------------------------------------------------
# Wire optionality — safe in either merge order with the gateway
# ---------------------------------------------------------------------------


def test_new_optional_fields_are_omitted_when_unset(platform_default) -> None:
    """A spec that sets none of them serialises to EXACTLY the bytes it came from.

    `extra='forbid'` makes an unknown field a contract drift, so the gateway must be
    free to omit these until TASK-876's schema names them. Emitting `null` instead of
    omitting would break the byte-for-byte parity the contract fixture locks.
    """
    dumped = ResolvedAsrSpec.model_validate(platform_default).model_dump(
        by_alias=True, mode="json"
    )
    assert "chunkLengthSec" not in dumped["decoding"]
    assert "strideLengthSec" not in dumped["decoding"]
    assert "semantic" not in dumped["streaming"]
    assert "endpointing" not in dumped["models"]
    assert dumped == platform_default


def test_new_optional_fields_round_trip_when_present(platform_default) -> None:
    platform_default["decoding"]["chunkLengthSec"] = 20
    platform_default["decoding"]["strideLengthSec"] = [5, 3]
    platform_default["streaming"]["semantic"] = {
        "minSilenceMs": 240,
        "maxSilenceMs": 600,
        "confidenceThreshold": 0.9,
        "minWords": 5,
    }
    dumped = ResolvedAsrSpec.model_validate(platform_default).model_dump(
        by_alias=True, mode="json"
    )
    assert dumped == platform_default
