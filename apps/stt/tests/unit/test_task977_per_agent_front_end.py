"""TASK-977 follow-up — audio front-end features are controlled per AGENT, and only there.

Two places still decided a noise-suppression outcome somewhere other than the agent:

* **The engine.** ``pipeline_spec_from_resolved`` built ``DenoiseConfig(enabled, strength)``
  and never set ``engine``, so an agent that bound the ``deepfilternet3`` registry row ran
  RNNoise anyway. The engine is now derived from the bound row's ``library_name`` — the
  loader-selection field since TASK-944 — and a library that names no denoise engine
  fails CLOSED while the spec is mapped, never degrading to RNNoise.
* **The hardware profile.** ``ExecutionProfile.denoise_enabled_default`` was a machine-level
  ENABLE, consulted when a session had no pipeline config. It is gone: a session with no
  pipeline config runs no denoiser, whatever the hardware.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt.models.cache import DENOISE_ENGINE_BY_LIBRARY, RUNTIME_OWNED_LIBRARIES
from stt.pipeline.dto import DenoiseConfig
from stt.pipeline.spec import (
    ResolvedAsrSpec,
    UnsupportedAsrSpecError,
    UnsupportedDenoiseEngineError,
    pipeline_spec_from_resolved,
)
from stt.streaming.execution_profile import ExecutionProfile
from stt.streaming.session_manager import SessionManager

RNNOISE_ROW = {"slug": "rnnoise", "libraryName": "pyrnnoise", "sourceUri": "pypi:pyrnnoise"}
DEEPFILTERNET3_ROW = {
    "slug": "deepfilternet3",
    "libraryName": "deepfilternet",
    "sourceUri": "github:Rikorose/DeepFilterNet#DeepFilterNet3",
}


def _fixture_case(name: str) -> dict[str, Any]:
    """The shared contract fixture's ``expected`` spec, parsed fresh so it is safe to mutate."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            cases: dict[str, Any] = json.loads(candidate.read_text(encoding="utf-8"))
            return cases[name]["expected"]
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


def _wire(*, denoise_enabled: bool = True, row: dict[str, Any] | None) -> dict[str, Any]:
    """``platformDefault`` with its denoise stage set by the test, and nothing else changed.

    Built from the platform default rather than from a fixture case that already binds a
    denoise model: that case's polarity has flipped once already (TASK-977 lane 1), and
    these tests must not follow it.
    """
    wire = _fixture_case("platformDefault")
    wire["audioFrontEnd"]["denoise"] = {
        "enabled": denoise_enabled,
        "level": "high" if denoise_enabled else "off",
    }
    # Diarization is not under test; off keeps the streaming assembly on the denoise path.
    wire["audioFrontEnd"]["diarization"]["enabled"] = False
    wire["models"].pop("denoise", None)
    if row is not None:
        # The seeded denoise rows' shape (`seed/ai-models/audio.ts`); `row` supplies the
        # slug, source and — unless the test is about its absence — the library.
        denoise = {
            **wire["models"]["vad"],
            "role": "denoise",
            "taskType": "AUDIO_TO_AUDIO",
            "format": "PYTORCH",
            "localPath": None,
        }
        denoise.pop("libraryName", None)
        wire["models"]["denoise"] = {**denoise, **row}
    return wire


def _denoise_config(wire: dict[str, Any]) -> DenoiseConfig:
    pipeline, _ = pipeline_spec_from_resolved(ResolvedAsrSpec.model_validate(wire))
    return pipeline.preprocessing.denoise


# ---------------------------------------------------------------------------
# Defect 1 — the agent's bound denoise row chooses the engine
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestTheBoundDenoiseRowChoosesTheEngine:
    def test_the_rnnoise_row_selects_rnnoise(self) -> None:
        assert _denoise_config(_wire(row=RNNOISE_ROW)).engine == "rnnoise"

    def test_the_deepfilternet3_row_selects_deepfilternet3(self) -> None:
        """The defect: this agent used to get RNNoise, because `engine` was never set."""
        config = _denoise_config(_wire(row=DEEPFILTERNET3_ROW))

        assert config.enabled is True
        assert config.engine == "deepfilternet3"

    def test_enabled_with_no_row_bound_keeps_the_rnnoise_default(self) -> None:
        """Runtime-owned engines need no registry row, so an unbound stage is legitimate."""
        config = _denoise_config(_wire(row=None))

        assert config.enabled is True
        assert config.engine == DenoiseConfig().engine == "rnnoise"

    def test_the_mapping_holds_whatever_the_stage_flag_says(self) -> None:
        """The gateway ships no row for a disabled stage; the mapper does not rely on it."""
        config = _denoise_config(_wire(denoise_enabled=False, row=DEEPFILTERNET3_ROW))

        assert config.enabled is False
        assert config.engine == "deepfilternet3"

    @pytest.mark.parametrize("library", ["transformers", "onnxruntime", "speechbrain"])
    def test_a_library_that_names_no_denoise_engine_fails_closed(self, library: str) -> None:
        """Never a silent RNNoise: a selection the admin made that quietly does something
        else is a wrong answer, not a degraded one."""
        with pytest.raises(UnsupportedDenoiseEngineError, match=library) as raised:
            _denoise_config(_wire(row={**DEEPFILTERNET3_ROW, "libraryName": library}))

        assert "deepfilternet3" in str(raised.value)  # the offending row is named
        # It is a spec-mapping refusal, so it rides the existing fail-closed handling.
        assert isinstance(raised.value, UnsupportedAsrSpecError)

    def test_a_row_that_declares_no_library_fails_closed(self) -> None:
        """`format` cannot tell the two engines apart (both rows are PYTORCH), so an
        undeclared library is not a known engine either."""
        row = {key: value for key, value in DEEPFILTERNET3_ROW.items() if key != "libraryName"}

        with pytest.raises(UnsupportedDenoiseEngineError, match="deepfilternet3"):
            _denoise_config(_wire(row=row))

    def test_every_denoise_library_is_runtime_owned(self) -> None:
        """The engine map lives beside the runtime-owned-library knowledge and must not
        drift from it: a denoise library the cache would try to load is a contradiction."""
        assert set(DENOISE_ENGINE_BY_LIBRARY) <= set(RUNTIME_OWNED_LIBRARIES)
        assert DENOISE_ENGINE_BY_LIBRARY == {
            "pyrnnoise": "rnnoise",
            "deepfilternet": "deepfilternet3",
        }


# ---------------------------------------------------------------------------
# Defect 1, end to end — the streaming assembly builds the engine the agent chose
# ---------------------------------------------------------------------------


def _assembly_manager(profile: Any = None) -> MagicMock:
    """The `MagicMock(spec=SessionManager)` shape `test_session_manager_denoiser.py` uses."""
    mgr = MagicMock(spec=SessionManager)
    mgr._profile = profile if profile is not None else MagicMock()
    mgr._redis = AsyncMock()
    mgr._load_vad_service = AsyncMock(return_value=MagicMock())
    mgr._load_asr_pipeline = AsyncMock(return_value=(MagicMock(), None))
    mgr._load_gloss_pipeline = AsyncMock(return_value=None)
    return mgr


async def _assemble(mgr: MagicMock, pipeline_config: Any) -> Any:
    return await SessionManager._assemble_session_runtime(
        mgr,
        session_id="s-977",
        tenant_id="t-977",
        consultation_id=None,
        user_id=None,
        sample_rate=16000,
        pipeline_config=pipeline_config,
        build_speaker_identifier=False,
    )


@pytest.mark.unit
class TestTheStreamingSessionRunsTheAgentsEngine:
    async def test_a_spec_binding_the_deepfilternet3_row_builds_the_deepfilternet3_denoiser(
        self,
    ) -> None:
        """Wire spec → the session's registered bundle → its pipeline config → assembly."""
        mgr = _assembly_manager()
        wire = _wire(row=DEEPFILTERNET3_ROW)
        bundle = SessionManager._register_resolved_spec(mgr, "s-977", wire)
        pipeline_config = await SessionManager._load_pipeline_config(
            mgr, bundle.runtime_key, session_id="s-977"
        )

        df3 = MagicMock()
        df3.initialize.return_value = True
        with (
            patch(
                "stt.streaming.session_manager.DeepFilterNet3StreamingDenoiser", return_value=df3
            ) as df3_cls,
            patch("stt.streaming.session_manager.StreamingDenoiser") as rnnoise_cls,
            patch("stt.streaming.session_manager.StreamingPreprocessor") as pp_cls,
            patch("stt.streaming.session_manager.ResultPublisher"),
        ):
            runtime = await _assemble(mgr, pipeline_config)

        df3_cls.assert_called_once_with(input_sr=16000, strength=0.8)
        rnnoise_cls.assert_not_called()
        df3.initialize.assert_called_once()
        assert pp_cls.call_args.kwargs.get("denoiser") is df3
        assert runtime.denoiser is df3


# ---------------------------------------------------------------------------
# Defect 2 — a hardware profile cannot switch denoise on
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestTheHardwareProfileCannotEnableDenoise:
    def test_the_execution_profile_carries_no_denoise_enable(self) -> None:
        names = {field.name for field in dataclasses.fields(ExecutionProfile)}

        assert "denoise_enabled_default" not in names

    async def test_no_pipeline_config_means_no_denoiser_whatever_the_profile_says(self) -> None:
        """A `MagicMock` profile answers truthy to every attribute — a machine that says
        "yes" to everything. The stage is the agent's to enable; with no pipeline config
        there is no agent opinion, so the stage is OFF."""
        mgr = _assembly_manager(profile=MagicMock())

        with (
            patch("stt.streaming.session_manager.DeepFilterNet3StreamingDenoiser") as df3_cls,
            patch("stt.streaming.session_manager.StreamingDenoiser") as rnnoise_cls,
            patch("stt.streaming.session_manager.StreamingPreprocessor") as pp_cls,
            patch("stt.streaming.session_manager.ResultPublisher"),
        ):
            runtime = await _assemble(mgr, None)

        df3_cls.assert_not_called()
        rnnoise_cls.assert_not_called()
        assert pp_cls.call_args.kwargs.get("denoiser") is None
        assert runtime.denoiser is None
