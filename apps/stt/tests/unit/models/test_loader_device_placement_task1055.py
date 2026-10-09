"""TASK-1055 lane S — stt's loaders honour ``cuda:<i>`` and free memory on that card.

The residency planner stamps ``AiModelConfig.device = "cuda:<i>"`` (the i-th GPU
the process sees) on a load the platform admin placed on a chosen GPU. Each
self-hosted loader must load ON that index, stamp it on the `LoadedModel`, and on
unload hand the freed memory back to the driver on THAT card. A loader whose
runtime cannot choose a GPU says so (`places_on_device_index = False`) and the
planner refuses the placement rather than loading on the wrong card.

CI has no GPU and loads no model: every runtime here is a mock.
"""

from __future__ import annotations

import sys
import types
from datetime import datetime
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from stt.models.base_loader import LoadedModel, cleanup_accelerator_memory, cuda_index
from stt.models.cache import ModelCache
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)


def _config(fmt: AiModelFormat, device: str | None, **overrides: Any) -> AiModelConfig:
    values: dict[str, Any] = {
        "id": "m-1",
        "tenant_id": "t-1",
        "slug": "asr-model",
        "name": "ASR",
        "description": None,
        "task_type": ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        "source": AiModelSource.HUGGINGFACE,
        "source_uri": "org/repo",
        "source_revision": "main",
        "format": fmt,
        "memory_size_mb": 900,
        "compute_type": None,
        "download_status": AiModelDownloadStatus.DOWNLOADED,
        "local_path": None,
        "downloaded_at": datetime.utcnow(),
        "file_size_mb": 0,
        "checksum": None,
        "tags": [],
        "device": device,
    }
    values.update(overrides)
    return AiModelConfig(**values)


def _loaded(fmt: AiModelFormat, device: str) -> LoadedModel:
    return LoadedModel(
        model_id="m-1", model_slug="asr-model", model=MagicMock(), format=fmt, device=device
    )


# ── the device string ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("device", "index"),
    [("cuda:0", 0), ("cuda:1", 1), ("cuda", None), ("cpu", None), (None, None), ("cuda:x", None)],
)
def test_cuda_index_reads_only_an_explicit_ordinal(device: str | None, index: int | None) -> None:
    assert cuda_index(device) == index


# ── unload frees memory on the right card ───────────────────────────────────


def test_cleanup_on_a_named_gpu_releases_that_gpu() -> None:
    with patch("stt.models.base_loader.release_accelerator_memory") as release:
        cleanup_accelerator_memory("cuda:1")

    release.assert_called_once_with("cuda:1")


def test_cleanup_without_a_named_gpu_keeps_todays_behaviour() -> None:
    fake_torch = MagicMock()
    fake_torch.cuda.is_available.return_value = True
    with (
        patch("stt.models.base_loader.release_accelerator_memory") as release,
        patch.dict(sys.modules, {"torch": fake_torch}),
    ):
        cleanup_accelerator_memory("cuda")
        cleanup_accelerator_memory()

    release.assert_not_called()
    assert fake_torch.cuda.empty_cache.call_count == 2


def _loaders() -> dict[AiModelFormat, Any]:
    return ModelCache()._loaders


@pytest.mark.parametrize(
    "fmt",
    [
        AiModelFormat.PYTORCH,
        AiModelFormat.FASTER_WHISPER,
        AiModelFormat.WHISPER_CPP,
        AiModelFormat.ONNX,
        AiModelFormat.NEMO,
    ],
)
async def test_every_gpu_loader_unloads_on_the_card_its_model_sits_on(fmt: AiModelFormat) -> None:
    loader = _loaders()[fmt]
    with (
        patch("stt.models.base_loader.cleanup_accelerator_memory") as cleanup,
        patch("stt.streaming.faster_whisper_asr.close_model_batcher"),
    ):
        await loader.unload(_loaded(fmt, "cuda:1"))

    cleanup.assert_called_once_with("cuda:1")


# ── which loaders can choose a GPU ──────────────────────────────────────────


@pytest.mark.parametrize(
    ("fmt", "places"),
    [
        (AiModelFormat.PYTORCH, True),
        (AiModelFormat.SAFETENSOR, True),
        (AiModelFormat.FASTER_WHISPER, True),
        (AiModelFormat.WHISPER_CPP, True),
        (AiModelFormat.ONNX, True),
        (AiModelFormat.ONNX_OPTIMUM, True),
        (AiModelFormat.NEMO, True),
        (AiModelFormat.PARAKEET_CPP, False),
        (AiModelFormat.VLLM, False),
        (AiModelFormat.AZURE_SPEECH, False),
        (AiModelFormat.AZURE_FOUNDRY, False),
        (AiModelFormat.OPENAI, False),
        (AiModelFormat.SARVAM, False),
    ],
)
def test_each_loader_declares_whether_it_can_choose_a_gpu(fmt: AiModelFormat, places: bool) -> None:
    assert _loaders()[fmt].places_on_device_index is places


# ── transformers: device_map pins the whole model to the chosen card ────────


def _fake_transformers() -> MagicMock:
    tf = MagicMock()
    model = MagicMock()
    model.to.return_value = model
    tf.AutoConfig.from_pretrained.return_value = types.SimpleNamespace(
        architectures=["WhisperForConditionalGeneration"], model_type="whisper"
    )
    tf.WhisperForConditionalGeneration.from_pretrained.return_value = model
    tf.AutoModelForMultimodalLM.from_pretrained.return_value = MagicMock()
    return tf


def _load_by_task(device: str, tf: MagicMock) -> None:
    from stt.models.huggingface_loader import HuggingFaceLoader

    loader = HuggingFaceLoader()
    with (
        patch.dict(sys.modules, {"transformers": tf}),
        patch.object(HuggingFaceLoader, "_has_accelerate", staticmethod(lambda: True)),
    ):
        loader._load_by_task(
            model_source="openai/whisper-small",
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            device=device,
            torch_dtype="auto",
            cache_dir="/tmp/hf-cache",
            revision=None,
            token=None,
        )


def test_transformers_on_a_named_gpu_maps_every_layer_to_it() -> None:
    tf = _fake_transformers()

    _load_by_task("cuda:1", tf)

    kwargs = tf.WhisperForConditionalGeneration.from_pretrained.call_args.kwargs
    assert kwargs["device_map"] == {"": 1}


def test_transformers_without_a_named_gpu_keeps_device_map_auto() -> None:
    tf = _fake_transformers()

    _load_by_task("cuda", tf)

    kwargs = tf.WhisperForConditionalGeneration.from_pretrained.call_args.kwargs
    assert kwargs["device_map"] == "auto"


def test_a_multimodal_lm_on_a_named_gpu_maps_every_layer_to_it() -> None:
    tf = _fake_transformers()
    tf.AutoConfig.from_pretrained.return_value = types.SimpleNamespace(
        architectures=["Gemma3ForMultimodalLM"], model_type="gemma3"
    )

    _load_by_task("cuda:1", tf)

    kwargs = tf.AutoModelForMultimodalLM.from_pretrained.call_args.kwargs
    assert kwargs["device_map"] == {"": 1}


# ── faster-whisper: CTranslate2 device_index ────────────────────────────────


async def test_faster_whisper_loads_on_the_named_gpu_index() -> None:
    from stt.models.faster_whisper_loader import FasterWhisperLoader

    whisper_model = MagicMock(name="WhisperModel")
    fake_fw = types.ModuleType("faster_whisper")
    fake_fw.WhisperModel = whisper_model  # type: ignore[attr-defined]
    fake_fw.BatchedInferencePipeline = MagicMock()  # type: ignore[attr-defined]

    async def _resolve(_config: Any, _settings: Any) -> str:
        return "/models/whisper-ct2"

    with (
        patch.dict(sys.modules, {"faster_whisper": fake_fw}),
        patch("stt.models.faster_whisper_loader.resolve_weights_or_hf_id", side_effect=_resolve),
        patch.object(FasterWhisperLoader, "_get_device", lambda self, requested: requested),
    ):
        loaded = await FasterWhisperLoader().load(
            _config(AiModelFormat.FASTER_WHISPER, "cuda:1", compute_type="float16")
        )

    assert whisper_model.call_args.kwargs["device"] == "cuda"
    assert whisper_model.call_args.kwargs["device_index"] == 1
    assert loaded.device == "cuda:1"


# ── whisper.cpp: pywhispercpp `gpu_device` context param ────────────────────


@pytest.fixture
def whisper_cpp(tmp_path: Any) -> Any:
    gguf = tmp_path / "whisper-large-v3-turbo-q8_0.gguf"
    gguf.write_bytes(b"GGUF")
    model_cls = MagicMock(return_value=MagicMock(_ctx=object()))
    package = types.ModuleType("pywhispercpp")
    model_module = types.ModuleType("pywhispercpp.model")
    model_module.Model = model_cls  # type: ignore[attr-defined]
    package.model = model_module  # type: ignore[attr-defined]

    async def _resolve(_config: Any, _settings: Any) -> Any:
        return gguf

    with (
        patch(
            "stt.models.whisper_cpp_loader.get_settings",
            return_value=MagicMock(whisper_cpp_num_threads=8),
        ),
        patch("stt.models.whisper_cpp_loader.resolve_for_model_config", side_effect=_resolve),
        patch.dict(sys.modules, {"pywhispercpp": package, "pywhispercpp.model": model_module}),
        patch("stt.core.platform.get_device_string", return_value="cuda"),
    ):
        yield model_cls


async def test_whisper_cpp_on_a_named_gpu_passes_gpu_device(whisper_cpp: MagicMock) -> None:
    from stt.models.whisper_cpp_loader import WhisperCppLoader

    loaded = await WhisperCppLoader().load(_config(AiModelFormat.WHISPER_CPP, "cuda:1"))

    context = whisper_cpp.call_args.kwargs["context_params"]
    assert context["use_gpu"] is True
    assert context["gpu_device"] == 1
    # The Metal/ggml recovery path replays these — it must land on the same card.
    assert loaded.extra["context_params"]["gpu_device"] == 1
    assert loaded.device == "cuda:1"


async def test_whisper_cpp_without_a_named_gpu_leaves_ggml_its_default(
    whisper_cpp: MagicMock,
) -> None:
    from stt.models.whisper_cpp_loader import WhisperCppLoader

    loaded = await WhisperCppLoader().load(_config(AiModelFormat.WHISPER_CPP, None))

    assert "gpu_device" not in whisper_cpp.call_args.kwargs["context_params"]
    assert "gpu_device" not in loaded.extra["context_params"]


# ── ONNX Runtime: CUDA provider device_id ───────────────────────────────────


def test_onnx_providers_on_a_named_gpu_carry_its_device_id() -> None:
    from stt.models.onnx_loader import ONNXLoader

    fake_ort = MagicMock()
    fake_ort.get_available_providers.return_value = [
        "CUDAExecutionProvider",
        "CPUExecutionProvider",
    ]
    with patch.dict(sys.modules, {"onnxruntime": fake_ort}):
        named = ONNXLoader()._get_providers(1)
        default = ONNXLoader()._get_providers()

    assert named == [("CUDAExecutionProvider", {"device_id": 1}), "CPUExecutionProvider"]
    assert default == ["CUDAExecutionProvider", "CPUExecutionProvider"]


async def test_onnx_runtime_session_on_a_named_gpu(tmp_path: Any) -> None:
    from stt.models.onnx_loader import ONNXLoader

    model_file = tmp_path / "model.onnx"
    model_file.write_bytes(b"onnx")
    fake_ort = MagicMock()
    fake_ort.get_available_providers.return_value = [
        "CUDAExecutionProvider",
        "CPUExecutionProvider",
    ]
    session = fake_ort.InferenceSession.return_value
    session.get_providers.return_value = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    session.get_inputs.return_value = []
    session.get_outputs.return_value = []

    async def _resolve(_config: Any, _settings: Any) -> str:
        return str(model_file)

    with (
        patch.dict(sys.modules, {"onnxruntime": fake_ort}),
        patch("stt.models.onnx_loader.resolve_weights_or_hf_id", side_effect=_resolve),
        patch.object(ONNXLoader, "_should_use_optimum", lambda self, _config: False),
    ):
        loaded = await ONNXLoader().load(_config(AiModelFormat.ONNX, "cuda:1"))

    providers = fake_ort.InferenceSession.call_args.kwargs["providers"]
    assert providers[0] == ("CUDAExecutionProvider", {"device_id": 1})
    assert loaded.device == "cuda:1"


async def test_optimum_onnx_on_a_named_gpu_passes_provider_options() -> None:
    from stt.models.onnx_loader import ONNXLoader

    ort_model = MagicMock(name="ORTModelForSpeechSeq2Seq")
    optimum = types.ModuleType("optimum")
    optimum_ort = types.ModuleType("optimum.onnxruntime")
    optimum_ort.ORTModelForSpeechSeq2Seq = ort_model  # type: ignore[attr-defined]
    optimum.onnxruntime = optimum_ort  # type: ignore[attr-defined]
    fake_tf = MagicMock()

    with (
        patch.dict(
            sys.modules,
            {
                "optimum": optimum,
                "optimum.onnxruntime": optimum_ort,
                "onnxruntime": MagicMock(),
                "transformers": fake_tf,
            },
        ),
        patch(
            "stt.models.onnx_loader.get_settings",
            return_value=MagicMock(huggingface_cache_dir="/tmp/hf-cache"),
        ),
        patch.object(ONNXLoader, "_resolve_subfolder", lambda self, _config: ""),
    ):
        loaded = await ONNXLoader()._load_with_optimum(
            _config(AiModelFormat.ONNX_OPTIMUM, "cuda:1")
        )

    kwargs = ort_model.from_pretrained.call_args.kwargs
    assert kwargs["provider"] == "CUDAExecutionProvider"
    assert kwargs["provider_options"] == {"device_id": 1}
    assert loaded.device == "cuda:1"


# ── NeMo: `.to(device)` on the named card ───────────────────────────────────


async def test_nemo_on_a_named_gpu_moves_the_model_there() -> None:
    from stt.models.nemo_loader import NeMoLoader

    instance = MagicMock(name="ASRModelInstance")
    instance.parameters.return_value = []
    instance.to.return_value = instance
    asr_model = MagicMock(name="ASRModel")
    asr_model.from_pretrained.return_value = instance
    modules: dict[str, types.ModuleType] = {}
    for name in ("nemo", "nemo.collections", "nemo.collections.asr", "nemo.collections.asr.models"):
        modules[name] = types.ModuleType(name)
    modules["nemo.collections.asr.models"].ASRModel = asr_model  # type: ignore[attr-defined]

    async def _resolve(_config: Any, _settings: Any) -> str:
        return "nvidia/parakeet-tdt-0.6b-v2"

    with (
        patch.dict(sys.modules, modules),
        patch("stt.models.nemo_loader.resolve_weights_or_hf_id", side_effect=_resolve),
    ):
        loaded = await NeMoLoader().load(_config(AiModelFormat.NEMO, "cuda:1"))

    instance.to.assert_called_once_with("cuda:1")
    assert loaded.device == "cuda:1"
