"""TASK-1031 — nlp on GPU 0 (the `nlp-gpu` image variant).

Three behaviours the CUDA image depends on, none of which needs a GPU to test:

1. Residency accounting reports the device the tensors are RESOLVED onto
   (`NLP_INFERENCE_DEVICE`), not a hardcoded host-RAM device — so the residency
   report of a GPU pod names `cuda:0`, and a CPU pod stays `cpu`.
2. MiniCheck's llama.cpp offload (`n_gpu_layers`) is a host setting on the
   service config (`NLP_ENTAILMENT_N_GPU_LAYERS`, default 0), and the factory
   passes it through.
3. The metered `device` of a MiniCheck scorer is where llama.cpp ACTUALLY runs:
   asking for offload on a CPU-only llama.cpp build reports `cpu`, not `cuda`.
"""

from __future__ import annotations

import sys
import types
from typing import Any

import pytest

import nlp.residency as residency
from nlp.core.config import NLPServiceConfig, settings


@pytest.fixture(autouse=True)
def _fresh_device_cache() -> Any:
    residency.nlp_device.cache_clear()
    yield
    residency.nlp_device.cache_clear()


def _set_device(monkeypatch: pytest.MonkeyPatch, name: str, *, cuda: bool) -> None:
    monkeypatch.setattr(settings.service, "inference_device", name)
    monkeypatch.setattr("nlp.core.device.torch.cuda.is_available", lambda: cuda)


class _FakeGpu:
    id = "cuda:0"
    kind = "gpu"


class TestResidencyDevice:
    def test_cpu_inference_device_reports_host_ram(self, monkeypatch) -> None:
        _set_device(monkeypatch, "cpu", cuda=True)
        assert residency.nlp_device().id == "cpu"

    def test_cuda_inference_device_reports_the_gpu(self, monkeypatch) -> None:
        _set_device(monkeypatch, "cuda", cuda=True)
        monkeypatch.setattr(residency, "gpu_device", lambda index=0: _FakeGpu())
        device = residency.nlp_device()
        assert (device.id, device.kind) == ("cuda:0", "gpu")

    def test_auto_with_cuda_present_reports_the_gpu(self, monkeypatch) -> None:
        _set_device(monkeypatch, "auto", cuda=True)
        monkeypatch.setattr(residency, "gpu_device", lambda index=0: _FakeGpu())
        assert residency.nlp_device().id == "cuda:0"

    def test_unreadable_nvml_falls_back_to_host_ram(self, monkeypatch) -> None:
        _set_device(monkeypatch, "cuda", cuda=True)
        monkeypatch.setattr(residency, "gpu_device", lambda index=0: None)
        assert residency.nlp_device().id == "cpu"

    def test_explicit_cuda_that_is_absent_does_not_crash_accounting(self, monkeypatch) -> None:
        # The LOAD fails closed (`resolve_inference_device` raises there); the
        # residency report must still render, so accounting degrades to host RAM.
        _set_device(monkeypatch, "cuda", cuda=False)
        assert residency.nlp_device().id == "cpu"


class TestEntailmentGpuLayersSetting:
    def test_default_is_zero(self, monkeypatch) -> None:
        monkeypatch.delenv("NLP_ENTAILMENT_N_GPU_LAYERS", raising=False)
        assert NLPServiceConfig().entailment_n_gpu_layers == 0

    def test_env_sets_full_offload(self, monkeypatch) -> None:
        monkeypatch.setenv("NLP_ENTAILMENT_N_GPU_LAYERS", "-1")
        assert NLPServiceConfig().entailment_n_gpu_layers == -1

    @pytest.mark.asyncio
    async def test_factory_passes_it_to_the_load_spec(self, monkeypatch) -> None:
        import nlp.dependencies as deps
        import nlp.services.entailment_scorer as es

        seen: list[Any] = []
        monkeypatch.setattr(settings.service, "entailment_n_gpu_layers", -1)
        monkeypatch.setattr(es, "load_minicheck_scorer", lambda spec: seen.append(spec) or spec)
        key = deps._entailment_cache_key("minicheck", "/models/m.gguf", None)
        await deps._create_entailment_scorer(key)
        assert seen[0].n_gpu_layers == -1


def _calibration() -> Any:
    from nlp.services.entailment_scorer import (
        MINICHECK_ADAPTER,
        MINICHECK_LABEL_TOKEN_NO,
        MINICHECK_LABEL_TOKEN_YES,
        EntailmentCalibration,
    )

    return EntailmentCalibration(
        adapter=MINICHECK_ADAPTER,
        labelTokenNo=MINICHECK_LABEL_TOKEN_NO,
        labelTokenYes=MINICHECK_LABEL_TOKEN_YES,
        supportedMin=0.5,
        unsupportedMax=0.5,
        document="d",
        supportedClaim="s",
        unsupportedClaim="u",
    )


def _fake_llama_cpp(monkeypatch: pytest.MonkeyPatch, *, gpu_offload: bool) -> None:
    module = types.ModuleType("llama_cpp")
    module.Llama = lambda **kwargs: object()  # type: ignore[attr-defined]
    module.llama_supports_gpu_offload = lambda: gpu_offload  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "llama_cpp", module)

    import nlp.services.entailment_scorer as es

    monkeypatch.setattr(es, "_make_llama_logit_fn", lambda llama: lambda prompt: (0.0, 0.0))
    monkeypatch.setattr(es.LlamaCppMiniCheckScorer, "verify_calibration", lambda self: None)


class TestMiniCheckReportedDevice:
    def _load(self, n_gpu_layers: int) -> Any:
        from nlp.services.entailment_scorer import MiniCheckLoadSpec, load_minicheck_scorer

        return load_minicheck_scorer(
            MiniCheckLoadSpec(
                model_id="minicheck",
                model_path="/models/m.gguf",
                calibration=_calibration(),
                n_gpu_layers=n_gpu_layers,
            )
        )

    def test_offload_on_a_cpu_only_build_reports_cpu(self, monkeypatch) -> None:
        _fake_llama_cpp(monkeypatch, gpu_offload=False)
        assert self._load(-1).device == "cpu"

    def test_offload_on_a_gpu_build_reports_cuda(self, monkeypatch) -> None:
        _fake_llama_cpp(monkeypatch, gpu_offload=True)
        assert self._load(-1).device == "cuda"

    def test_no_offload_reports_cpu(self, monkeypatch) -> None:
        _fake_llama_cpp(monkeypatch, gpu_offload=True)
        assert self._load(0).device == "cpu"
