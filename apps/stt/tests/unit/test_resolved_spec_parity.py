"""TASK-861 — ``ResolvedAsrSpec`` cross-language parity (Python half).

The gateway PRODUCES the spec (``buildResolvedAsrSpec`` in ``@arcaai/applications``)
and this service CONSUMES it (``stt.pipeline.spec``). Both halves read the SAME
committed fixture — ``tests/contracts/resolved-asr-spec.fixture.json`` — so a shape
change one side makes fails the other. The TypeScript half is
``tests/contracts/resolved-asr-spec-parity.contract.test.ts``.

What this half locks:

* every ``expected`` spec in the fixture validates against the pydantic mirror AND
  round-trips byte-for-byte (``extra='forbid'`` — an unknown field is a contract
  drift, never silently dropped);
* ``pipeline_spec_from_resolved`` maps the spec into the ``PipelineSpec`` + per-model
  ``AiModelConfig`` the runtime already consumes, with NO database read;
* selection fails CLOSED: an unknown schema version or a format this runtime does
  not execute raises, never a guessed engine.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from stt.pipeline.dto import AiModelFormat, ModelTaskType, PipelineSpec
from stt.pipeline.spec import (
    RESOLVED_ASR_SPEC_SCHEMA_VERSION,
    AsrSpecCore,
    ResolvedAsrSpec,
    UnsupportedAsrSpecError,
    pipeline_spec_from_resolved,
)


def _load_fixture() -> dict[str, Any]:
    """Locate the shared contract fixture by walking up to the repo root."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


FIXTURE = _load_fixture()
CASES = {name: case for name, case in FIXTURE.items() if isinstance(case, dict)}


@pytest.mark.parametrize("name", sorted(CASES))
def test_expected_spec_validates_and_round_trips(name: str) -> None:
    expected = CASES[name]["expected"]
    spec = ResolvedAsrSpec.model_validate(expected)
    assert spec.schema_version == RESOLVED_ASR_SPEC_SCHEMA_VERSION
    # by_alias → camelCase wire keys; exclude nothing so `null`s survive.
    assert spec.model_dump(by_alias=True, mode="json") == expected


def test_unknown_field_is_a_contract_drift_not_a_silent_drop() -> None:
    expected = dict(CASES["platformDefault"]["expected"])
    expected["pipelineId"] = "legacy"
    with pytest.raises(ValidationError):
        ResolvedAsrSpec.model_validate(expected)


def test_unknown_schema_version_fails_closed() -> None:
    expected = dict(CASES["platformDefault"]["expected"])
    expected["schemaVersion"] = RESOLVED_ASR_SPEC_SCHEMA_VERSION + 1
    with pytest.raises(ValidationError):
        ResolvedAsrSpec.model_validate(expected)


def test_platform_default_maps_to_the_runtime_pipeline_spec() -> None:
    spec = ResolvedAsrSpec.model_validate(CASES["platformDefault"]["expected"])
    pipeline, models = pipeline_spec_from_resolved(spec)

    assert isinstance(pipeline, PipelineSpec)
    assert pipeline.models.asr.slug == "arcaai-whisper-large-ml-en-gguf"
    assert pipeline.models.vad is not None and pipeline.models.vad.slug == "silero-vad"
    assert pipeline.models.embedding is not None
    assert pipeline.models.embedding.slug == "ecapa-tdnn-voxceleb"
    assert pipeline.models.denoise is None

    # Every executable model is pre-resolved — this is what makes the DB read unnecessary.
    assert set(models) == {"arcaai-whisper-large-ml-en-gguf", "silero-vad", "ecapa-tdnn-voxceleb"}
    asr = models["arcaai-whisper-large-ml-en-gguf"]
    assert asr.format is AiModelFormat.WHISPER_CPP
    assert asr.task_type is ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION
    assert asr.local_path == "/models/whisper-turbo-ml-en/ggml-model.gguf"
    assert asr.checksum == "sha256:aaaa"
    assert asr.compute_type == "int8"
    assert asr.tenant_id == "00000000-0000-0000-0000-000000000000"
    assert models["silero-vad"].task_type is ModelTaskType.VOICE_ACTIVITY_DETECTION
    assert models["ecapa-tdnn-voxceleb"].task_type is ModelTaskType.SPEAKER_EMBEDDING

    # §3.2 blocks land on the dataclasses the runtime already reads.
    assert pipeline.preprocessing.vad.threshold == 0.5
    assert pipeline.preprocessing.vad.min_speech_duration_ms == 120
    assert pipeline.preprocessing.vad.min_silence_duration_ms == 200
    assert pipeline.preprocessing.denoise.enabled is False
    assert pipeline.diarization.enabled is True
    assert pipeline.diarization.max_speakers == 2
    assert pipeline.diarization.backend == "embedding"
    assert pipeline.inference.beam_size == 5
    assert pipeline.inference.code_switching is True
    assert pipeline.inference.language == "ml"  # primary language of the ml-en mode
    assert pipeline.postprocessing.timestamps.word_timestamps is True
    assert pipeline.postprocessing.punctuation.enabled is True
    assert pipeline.streaming.commit_policy == "local_agreement_2"


def test_null_tuning_fields_keep_the_runtime_defaults() -> None:
    """A `null` means "engine default" — the spec never restates PipelineSpec defaults."""
    spec = ResolvedAsrSpec.model_validate(CASES["cloudWithAgentFallback"]["expected"])
    pipeline, models = pipeline_spec_from_resolved(spec)

    defaults = PipelineSpec.__dataclass_fields__  # noqa: F841 — documents intent
    assert pipeline.inference.beam_size == 5  # dataclass default, not 0/None
    assert pipeline.inference.temperature == [0.2]
    assert pipeline.inference.language == "en"
    assert pipeline.inference.code_switching is False
    assert pipeline.preprocessing.vad.threshold == 0.6  # VadConfig default
    assert pipeline.preprocessing.resample_enabled is False
    assert pipeline.preprocessing.denoise.enabled is True
    assert pipeline.preprocessing.denoise.strength > 0.5  # "high"
    assert pipeline.postprocessing.punctuation.enabled is False
    assert pipeline.postprocessing.remove_disfluencies is True
    assert pipeline.postprocessing.segment_merge.enabled is True
    assert pipeline.streaming.commit_policy == "none"
    assert models["azure-speech-stt"].format is AiModelFormat.AZURE_SPEECH
    assert models["rnnoise"].local_path == "/opt/models/rnnoise"


def test_fallback_core_maps_independently_with_a_distinct_runtime_key() -> None:
    for name in sorted(CASES):
        spec = ResolvedAsrSpec.model_validate(CASES[name]["expected"])
        assert spec.fallback.spec is not None, name
        fallback: AsrSpecCore = spec.fallback.spec
        assert fallback.runtime_key != spec.runtime_key
        fb_pipeline, fb_models = pipeline_spec_from_resolved(fallback)
        assert fb_pipeline.models.asr.slug == fallback.models.asr.slug
        assert fallback.models.asr.slug in fb_models


def test_format_this_runtime_does_not_execute_fails_closed() -> None:
    expected = json.loads(json.dumps(CASES["platformDefault"]["expected"]))
    expected["models"]["asr"]["format"] = "GGUF"  # a catalogue-only (LM-Studio) format
    spec = ResolvedAsrSpec.model_validate(expected)
    with pytest.raises(UnsupportedAsrSpecError, match="arcaai-whisper-large-ml-en-gguf"):
        pipeline_spec_from_resolved(spec)


def test_punctuation_model_is_referenced_not_loaded() -> None:
    """Punctuation (Cadence) is served by the punctuation service, never the model cache."""
    expected = json.loads(json.dumps(CASES["platformDefault"]["expected"]))
    expected["models"]["punctuation"] = {
        **expected["models"]["vad"],
        "role": "punctuation",
        "slug": "cadence-punct",
        "taskType": "TOKEN_CLASSIFICATION",
    }
    spec = ResolvedAsrSpec.model_validate(expected)
    pipeline, models = pipeline_spec_from_resolved(spec)
    assert pipeline.postprocessing.punctuation.model == "cadence-punct"
    assert "cadence-punct" not in models
