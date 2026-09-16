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
    # TASK-977 (D-2/D-4) — this agent BINDS a denoise model and names `level: "high"`, but
    # never declares `denoise.enabled`. Naming a level is not consent to run the stage, so it
    # resolves OFF, and an off stage ships no model for `apps/stt` to warm.
    assert pipeline.preprocessing.denoise.enabled is False
    assert "rnnoise" not in models
    assert pipeline.postprocessing.punctuation.enabled is False
    assert pipeline.postprocessing.remove_disfluencies is True
    assert pipeline.postprocessing.segment_merge.enabled is True
    assert pipeline.streaming.commit_policy == "none"
    assert models["azure-speech-stt"].format is AiModelFormat.AZURE_SPEECH


def test_an_enabled_denoise_stage_maps_its_level_and_ships_its_model() -> None:
    """TASK-977 — the POSITIVE pole of D-2/D-4.

    `cloudWithAgentFallback` above proves a bound-but-undeclared denoise stage stays off.
    This proves the other direction still maps end to end, so neither assertion can pass
    vacuously: a DECLARED `enabled: true` carries its level into `DenoiseConfig.strength`
    and its model into the slug-keyed model map.
    """
    spec = ResolvedAsrSpec.model_validate(CASES["twoConnectionsOfOneVendor"]["expected"])
    pipeline, models = pipeline_spec_from_resolved(spec)

    assert pipeline.preprocessing.denoise.enabled is True
    assert pipeline.preprocessing.denoise.strength > 0.5  # "high"
    assert models["rnnoise"].local_path == "/opt/models/rnnoise"


def test_fallback_core_maps_independently_with_a_distinct_runtime_key() -> None:
    seen = 0
    for name in sorted(CASES):
        spec = ResolvedAsrSpec.model_validate(CASES[name]["expected"])
        if spec.fallback.spec is None:
            # `kind: 'none'` is a legitimate resolution — nothing to switch to.
            # `test_a_fallbackless_spec_declares_kind_none` locks that pairing.
            continue
        seen += 1
        fallback: AsrSpecCore = spec.fallback.spec
        assert fallback.runtime_key != spec.runtime_key
        fb_pipeline, fb_models = pipeline_spec_from_resolved(fallback)
        assert fb_pipeline.models.asr.slug == fallback.models.asr.slug
        assert fallback.models.asr.slug in fb_models
    assert seen >= 2, "the fixture must keep covering both the model and agent fallback kinds"


def test_a_fallbackless_spec_declares_kind_none() -> None:
    """`spec: null` and `kind: 'none'` are one state, never two half-states."""
    for name in sorted(CASES):
        fallback = ResolvedAsrSpec.model_validate(CASES[name]["expected"]).fallback
        assert (fallback.spec is None) == (fallback.kind == "none"), name


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


class TestClinicalVocabularyCorrection:
    """TASK-935 (OD-2 a / OD-5 a) — the lexicon stage crosses the wire; its terms don't.

    The stage's vocabulary is ``instruction.hotwords``, bound to the runtime config by
    ``pipeline_spec_from_resolved`` rather than sent a second time. That binding is the
    contract these tests hold: one list on the wire, one stage reading it, and an agent
    silence that resolves against the list rather than against a constant.
    """

    def test_the_configured_stage_reaches_the_runtime_with_the_hotwords_as_its_terms(
        self,
    ) -> None:
        spec = ResolvedAsrSpec.model_validate(CASES["clinicalVocabularyCorrection"]["expected"])
        pipeline, _ = pipeline_spec_from_resolved(spec)
        lexicon = pipeline.postprocessing.lexicon
        assert lexicon.enabled is True
        assert lexicon.max_distance == 0.3
        # The terms were NEVER on the wire under `postProcessing`; they are the hotwords
        # the same spec used to prime the decoder (here supplied by the MODEL row).
        assert lexicon.terms == ["ceftriaxone", "amoxicillin"]
        assert spec.post_processing.lexicon is not None
        assert not hasattr(spec.post_processing.lexicon, "terms")
        assert lexicon.active is True

    def test_an_agent_that_said_nothing_gets_the_stage_exactly_when_it_named_terms(
        self,
    ) -> None:
        """Absence resolves against the vocabulary, not against a constant.

        A term named for the decoder is a term the clinician expects to read back, so
        hotwords WITHOUT an explicit block turn the stage on; no hotwords leave it off.
        """
        raw = json.loads(json.dumps(CASES["clinicalVocabularyCorrection"]["expected"]))
        del raw["postProcessing"]["lexicon"]

        with_terms = ResolvedAsrSpec.model_validate(raw)
        assert with_terms.post_processing.lexicon is None
        pipeline, _ = pipeline_spec_from_resolved(with_terms)
        assert pipeline.postprocessing.lexicon.enabled is True
        assert pipeline.postprocessing.lexicon.terms == ["ceftriaxone", "amoxicillin"]
        # …and the engine default stands, because the spec never restates it.
        assert pipeline.postprocessing.lexicon.max_distance is None

        raw["instruction"]["hotwords"] = []
        without_terms, _ = pipeline_spec_from_resolved(ResolvedAsrSpec.model_validate(raw))
        assert without_terms.postprocessing.lexicon.enabled is False
        assert without_terms.postprocessing.lexicon.active is False

    def test_an_explicit_off_is_a_veto_that_survives_a_non_empty_hotword_list(self) -> None:
        raw = json.loads(json.dumps(CASES["clinicalVocabularyCorrection"]["expected"]))
        raw["postProcessing"]["lexicon"] = {"enabled": False}
        pipeline, _ = pipeline_spec_from_resolved(ResolvedAsrSpec.model_validate(raw))
        assert pipeline.postprocessing.lexicon.enabled is False
        assert pipeline.postprocessing.lexicon.terms == ["ceftriaxone", "amoxicillin"]
        assert pipeline.postprocessing.lexicon.active is False

    def test_every_other_case_omits_the_block_and_still_maps(self) -> None:
        """The omit-when-absent rule, from the consuming side."""
        for name in sorted(CASES):
            if name == "clinicalVocabularyCorrection":
                continue
            spec = ResolvedAsrSpec.model_validate(CASES[name]["expected"])
            assert spec.post_processing.lexicon is None, name
            pipeline, _ = pipeline_spec_from_resolved(spec)
            assert pipeline.postprocessing.lexicon.terms == list(spec.instruction.hotwords), name

    def test_a_term_list_smuggled_onto_the_wire_is_a_contract_drift(self) -> None:
        """OD-5 (a) is enforced by the mirror, not merely documented."""
        raw = json.loads(json.dumps(CASES["clinicalVocabularyCorrection"]["expected"]))
        raw["postProcessing"]["lexicon"]["terms"] = ["ceftriaxone"]
        with pytest.raises(ValidationError):
            ResolvedAsrSpec.model_validate(raw)
