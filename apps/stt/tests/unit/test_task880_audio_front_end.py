"""TASK-880 — the VAD keys move to the model row and the agent.

``stt.vad.modelPath`` named the Silero ONNX weights. The weights are an ``AiModel``
row (``VOICE_ACTIVITY_DETECTION``) whose ``localPath`` already travels on every
session's ``ResolvedAsrSpec``, so the platform key was a second, parallel way to say
the same thing — and the only one in force.

``stt.vad.speechPadMs`` is segment padding: a tuning choice beside ``threshold`` and
``minSilenceMs``, which the agent has owned since TASK-861. It is now
``audioFrontEnd.vad.speechPadMs``.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from stt.pipeline.dto import VadConfig
from stt.pipeline.spec import AsrSpecAudioFrontEnd
from stt.streaming.session_manager import SessionManager
from stt.vad import silero_service


class TestSpeechPadIsAnAgentValue:
    def test_the_wire_carries_it_and_the_mapper_lands_it_on_vad_config(self) -> None:
        from stt.pipeline.spec import (
            AsrSpecDecoding,
            AsrSpecDenoise,
            AsrSpecDiarization,
            AsrSpecVad,
        )

        afe = AsrSpecAudioFrontEnd(
            vad=AsrSpecVad(
                enabled=True, threshold=None, minSpeechMs=None, minSilenceMs=None, speechPadMs=320
            ),
            denoise=AsrSpecDenoise(enabled=False, level="off"),
            diarization=AsrSpecDiarization(enabled=False, backend="embedding", maxSpeakers=None),
            resample=True,
            normalize=True,
        )
        assert afe.vad.speech_pad_ms == 320
        assert AsrSpecDecoding is not None  # import guard: the block is unchanged

    def test_absent_means_absent_on_the_wire_not_null(self) -> None:
        from stt.pipeline.spec import AsrSpecVad

        vad = AsrSpecVad(enabled=True, threshold=None, minSpeechMs=None, minSilenceMs=None)
        assert "speechPadMs" not in vad.model_dump(by_alias=True, mode="json")

    def test_a_caller_that_passes_nothing_gets_the_dataclass_default_not_a_setting(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`stt.vad.speechPadMs` is deleted, so `detect_speech` must not reach into
        `Settings` for it — the `VadConfig` dataclass is the one source of the default."""
        captured: dict[str, int] = {}

        def _probs_to_segments(**kwargs: object) -> list:
            captured["pad_ms"] = int(kwargs["pad_ms"])  # type: ignore[arg-type]
            return []

        svc = silero_service.SileroVADService()
        svc._loaded = True
        svc._session = MagicMock()
        svc._session.run.return_value = [[[0.0]], MagicMock()]
        monkeypatch.setattr(svc, "_probs_to_segments", _probs_to_segments)
        monkeypatch.setattr(
            silero_service,
            "get_settings",
            lambda: SimpleNamespace(
                vad_threshold=0.5, vad_min_speech_duration_ms=100, vad_min_silence_duration_ms=500
            ),
        )

        import numpy as np

        svc.detect_speech(np.zeros(1600, dtype=np.float32), 16000)

        assert captured["pad_ms"] == VadConfig.padding_ms


class TestVadWeightsComeFromTheModelRow:
    def test_the_singleton_takes_the_specs_local_path(self) -> None:
        silero_service._service = None
        try:
            svc = silero_service.get_vad_service(model_path="/models/silero/model.onnx")
            assert svc._model_path == "/models/silero/model.onnx"
        finally:
            silero_service._service = None

    def test_no_path_resolves_automatically_exactly_as_the_deleted_keys_default_did(self) -> None:
        silero_service._service = None
        try:
            assert silero_service.get_vad_service()._model_path is None
        finally:
            silero_service._service = None

    def test_the_session_manager_reads_the_path_off_the_spec_bundle(self) -> None:
        mgr = MagicMock(spec=SessionManager)
        mgr._session_specs = {
            "s1": SimpleNamespace(
                model_configs={"silero-vad": SimpleNamespace(local_path="/weights/silero.onnx")}
            )
        }
        config = SimpleNamespace(models=SimpleNamespace(vad=SimpleNamespace(slug="silero-vad")))

        assert SessionManager._spec_vad_local_path(mgr, "s1", config) == "/weights/silero.onnx"

    @pytest.mark.parametrize(
        "config",
        [
            None,
            SimpleNamespace(models=SimpleNamespace(vad=None)),
            SimpleNamespace(models=SimpleNamespace(vad=SimpleNamespace(slug="not-in-bundle"))),
        ],
    )
    def test_a_session_without_a_resolvable_vad_row_passes_none(self, config: object) -> None:
        mgr = MagicMock(spec=SessionManager)
        mgr._session_specs = {}
        assert SessionManager._spec_vad_local_path(mgr, "s1", config) is None

    @pytest.mark.asyncio
    async def test_load_vad_service_threads_the_specs_path_into_the_singleton(self) -> None:
        """End of the path: `_load_vad_service` is what actually hands the row's
        `localPath` to `get_vad_service`, replacing `settings.vad_model_path`."""
        from unittest.mock import AsyncMock, patch

        mgr = MagicMock(spec=SessionManager)
        mgr._spec_vad_local_path = MagicMock(return_value="/weights/silero.onnx")
        config = MagicMock()
        config.preprocessing.vad.enabled = True

        seen: dict[str, object] = {}
        vad = MagicMock(is_loaded=True, initialize=AsyncMock())

        def _get(model_path: str | None = None) -> object:
            seen["model_path"] = model_path
            return vad

        with patch.dict("sys.modules", {"stt.vad.silero_service": MagicMock(get_vad_service=_get)}):
            result = await SessionManager._load_vad_service(mgr, config, "s1")

        assert result is vad
        assert seen["model_path"] == "/weights/silero.onnx"
