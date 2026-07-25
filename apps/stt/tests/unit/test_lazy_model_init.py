"""auxiliary ML models (VAD, embedding) load lazily on first use.

A freshly booted stt process must hold no ML weights until a request needs
them. These tests prove that:

- the service is NOT loaded until an inference/extract entry point is called;
- the first use triggers exactly one load;
- concurrent first-use callers load the model exactly once (single-flight).
"""

import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import numpy as np
import pytest

from stt.diarization.embedding_service import EmbeddingService
from stt.vad.silero_service import SileroVADService

# ---------------------------------------------------------------------------
# Silero VAD
# ---------------------------------------------------------------------------


def _patch_onnx(mocker) -> MagicMock:
    """Patch onnxruntime + model-path resolution for a fake ONNX load."""
    mock_ort = MagicMock()
    mock_ort.InferenceSession.side_effect = lambda *a, **k: MagicMock()
    mock_ort.SessionOptions.return_value = MagicMock()
    mock_ort.GraphOptimizationLevel.ORT_ENABLE_ALL = 99
    mocker.patch.dict("sys.modules", {"onnxruntime": mock_ort})
    return mock_ort


class TestVadLazyInit:
    @pytest.mark.asyncio
    async def test_not_loaded_until_first_use(self, mocker):
        service = SileroVADService(model_path="/tmp/model.onnx")
        assert service.is_loaded is False

    @pytest.mark.asyncio
    async def test_first_use_triggers_exactly_one_load(self, mocker):
        service = SileroVADService(model_path="/tmp/model.onnx")
        mocker.patch.object(service, "_resolve_model_path", return_value=Path("/tmp/model.onnx"))
        mock_ort = _patch_onnx(mocker)

        await service.initialize()
        await service.initialize()  # idempotent

        assert service.is_loaded is True
        mock_ort.InferenceSession.assert_called_once()

    @pytest.mark.asyncio
    async def test_concurrent_first_use_loads_once(self, mocker):
        service = SileroVADService(model_path="/tmp/model.onnx")
        mocker.patch.object(service, "_resolve_model_path", return_value=Path("/tmp/model.onnx"))
        mock_ort = _patch_onnx(mocker)

        await asyncio.gather(*[service.initialize() for _ in range(10)])

        assert service.is_loaded is True
        assert mock_ort.InferenceSession.call_count == 1


# ---------------------------------------------------------------------------
# Pyannote / SpeechBrain embedding
# ---------------------------------------------------------------------------


class _FakeEmbeddingService(EmbeddingService):
    """Concrete EmbeddingService that counts model loads without real weights."""

    def __init__(self) -> None:
        super().__init__(hf_model_id="fake/model")
        self.load_calls = 0

    def _load_model_sync(self, model_id: str, settings: Any) -> None:
        self.load_calls += 1

    def _run_inference_sync(self, waveform: Any, sample_rate: int) -> Any:
        return np.zeros(8, dtype=np.float32)


class TestEmbeddingLazyInit:
    @pytest.mark.asyncio
    async def test_not_loaded_until_first_use(self):
        svc = _FakeEmbeddingService()
        assert svc.is_loaded is False
        assert svc.load_calls == 0

    @pytest.mark.asyncio
    async def test_extract_lazily_initializes_once(self, mocker):
        svc = _FakeEmbeddingService()
        mocker.patch(
            "stt.diarization.embedding_service.get_settings",
            return_value=MagicMock(diarization_hf_model_id="fake/model"),
        )
        # Avoid a real torch inference path — we only assert the lazy load.
        mocker.patch.object(svc, "_extract_sync", return_value=[0.0] * 8)
        init_spy = mocker.spy(svc, "initialize")

        samples = np.zeros(16000, dtype=np.float32)
        await svc.extract_from_samples(samples, 16000)
        await svc.extract_from_samples(samples, 16000)

        init_spy.assert_awaited()
        assert svc.is_loaded is True
        assert svc.load_calls == 1

    @pytest.mark.asyncio
    async def test_concurrent_initialize_loads_once(self, mocker):
        svc = _FakeEmbeddingService()
        mocker.patch(
            "stt.diarization.embedding_service.get_settings",
            return_value=MagicMock(diarization_hf_model_id="fake/model"),
        )

        await asyncio.gather(*[svc.initialize() for _ in range(10)])

        assert svc.is_loaded is True
        assert svc.load_calls == 1
