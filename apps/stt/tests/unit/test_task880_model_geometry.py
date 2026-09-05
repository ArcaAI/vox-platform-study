"""TASK-880 — model-coupled ASR geometry rides the ``AiModel`` row, not a platform key.

``stt.whisperCpp.maxAudioSeconds`` and ``stt.streaming.partialWindowS`` were platform
settings: ONE number per process, applied to every session whatever engine served it.
They describe a MODEL, so they now travel as ``ResolvedAsrSpec.models.asr.metadata``
(``AiModel._metadata.asr``) and reach the runtime through the dataclasses the adapters
already read — which is also what gives a fallback chain its OWN geometry.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from stt.pipeline.spec import ResolvedAsrSpec, pipeline_spec_from_resolved


def _fixture() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


FIXTURE = _fixture()
PLATFORM_DEFAULT = FIXTURE["platformDefault"]["expected"]
CLOUD = FIXTURE["cloudWithAgentFallback"]["expected"]


class TestSpecCarriesModelGeometry:
    def test_the_wire_carries_the_primary_rows_geometry(self) -> None:
        spec = ResolvedAsrSpec.model_validate(PLATFORM_DEFAULT)
        assert spec.models.asr.metadata is not None
        assert spec.models.asr.metadata.max_decode_window_sec == 7
        assert spec.models.asr.metadata.partial_window_sec == 6

    def test_a_row_that_declares_nothing_omits_metadata_on_the_wire(self) -> None:
        """`extra='forbid'` on both halves: an unset optional is OMITTED, never `null`."""
        spec = ResolvedAsrSpec.model_validate(CLOUD)
        assert spec.models.asr.metadata is None
        assert "metadata" not in spec.models.asr.model_dump(by_alias=True, mode="json")


class TestGeometryReachesTheRuntimeDataclasses:
    def test_max_decode_window_reaches_inference_config(self) -> None:
        spec = ResolvedAsrSpec.model_validate(PLATFORM_DEFAULT)
        pipeline_spec, _ = pipeline_spec_from_resolved(spec)
        assert pipeline_spec.inference.max_decode_window_sec == 7.0

    def test_partial_window_reaches_streaming_config(self) -> None:
        spec = ResolvedAsrSpec.model_validate(PLATFORM_DEFAULT)
        pipeline_spec, _ = pipeline_spec_from_resolved(spec)
        assert pipeline_spec.streaming.partial_window_s == 6.0

    def test_the_fallback_chain_decodes_on_its_own_window(self) -> None:
        """The whole point of moving these onto the row: the CT2 fallback is not
        bound by the GGUF primary's 7s accuracy window."""
        spec = ResolvedAsrSpec.model_validate(PLATFORM_DEFAULT)
        assert spec.fallback.spec is not None
        primary, _ = pipeline_spec_from_resolved(spec)
        fallback, _ = pipeline_spec_from_resolved(spec.fallback.spec)
        assert primary.inference.max_decode_window_sec == 7.0
        assert fallback.inference.max_decode_window_sec == 30.0

    @pytest.mark.parametrize("case", [PLATFORM_DEFAULT, CLOUD])
    def test_an_undeclared_window_leaves_the_dataclass_default(self, case: dict[str, Any]) -> None:
        """A row with no geometry must not have a number invented for it — the
        dataclass default is the one source of an engine default."""
        asr = {k: v for k, v in case["models"]["asr"].items() if k != "metadata"}
        spec = ResolvedAsrSpec.model_validate({**case, "models": {**case["models"], "asr": asr}})
        pipeline_spec, _ = pipeline_spec_from_resolved(spec)
        assert pipeline_spec.inference.max_decode_window_sec == 0.0
        assert pipeline_spec.streaming.partial_window_s is None


class TestBatchChunkingHasOneSource:
    """TASK-880 — `stt.transcription.{chunkLengthS,strideLengthS}` are deleted.

    TASK-877 put the agent's chunking on the spec and made ONE of the two batch
    readers prefer it; the other (`_transcribe_optimum_onnx`) still read the platform
    settings, so an agent's chunking applied on one path and not the other. Both now
    read `InferenceConfig`, whose defaults carry the numbers the deleted keys had.
    """

    def test_the_spec_value_is_used_when_the_agent_set_one(self) -> None:
        from stt.pipeline.dto import InferenceConfig
        from stt.transcription.batch_service import _resolve_chunking

        config = InferenceConfig(chunk_length_sec=20.0, stride_length_sec=(5, 3))
        assert _resolve_chunking(config) == (20.0, 5, 3)

    def test_no_agent_opinion_falls_back_to_the_engine_default_not_a_setting(self) -> None:
        from stt.pipeline.dto import InferenceConfig
        from stt.transcription.batch_service import _resolve_chunking

        assert _resolve_chunking(InferenceConfig()) == (15.0, 4, 2)

    @pytest.mark.parametrize(
        "config",
        [
            SimpleNamespace(),
            SimpleNamespace(chunk_length_sec="twenty", stride_length_sec="4,2"),
            SimpleNamespace(chunk_length_sec=True, stride_length_sec=(1,)),
        ],
    )
    def test_a_malformed_shape_degrades_to_the_engine_default(self, config: object) -> None:
        """Both call sites type `config` as `Any` and unit tests pass MagicMocks; a
        non-numeric value must never reach `float()`."""
        from stt.transcription.batch_service import _resolve_chunking

        assert _resolve_chunking(config) == (15.0, 4, 2)
