"""TASK-959 — the ggml loaders stamp the device they RESOLVED, never "auto".

`LoadedModel.device` is a billing input since TASK-959: the batch completion
callback carries it, and the gateway maps it to a unit — `cuda`/`mps` bills
`GPU_SECOND`, anything else bills `CPU_SECOND`. Two loaders stamped the literal
string `"auto"`, which normalises to `cpu` under the "cheaper unit, never
nothing" rule, so **a whisper.cpp batch job running on a GPU billed CPU
seconds**. Every other loader already stamped a concrete device
(`faster_whisper_loader` resolves through the same `_get_device`), so this was
a two-loader gap, not a design choice.

The resolution is the one the base loader already owns: `_get_device` sends
`"auto"` to `stt.core.platform.get_device_string`, which returns exactly
`cuda` | `mps` | `cpu` (and degrades to `cpu` when torch is absent — which
matters here, because neither ggml runtime depends on torch).

Two directions are both wrong and both pinned below: reporting CPU for a GPU
run under-bills the platform, and reporting GPU for a run the operator pinned
to CPU over-bills the tenant.
"""

from __future__ import annotations

import sys
import types
from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from stt.core.metering import normalize_device
from stt.models.parakeet_cpp_loader import ParakeetCppLoader
from stt.models.whisper_cpp_loader import WhisperCppLoader
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)


def _config(fmt: AiModelFormat, device: str | None) -> AiModelConfig:
    return AiModelConfig(
        id="m-1",
        tenant_id="t-1",
        slug="asr-ggml",
        name="ggml ASR",
        description=None,
        task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        source=AiModelSource.HUGGINGFACE,
        source_uri="org/repo-GGUF",
        source_revision="main",
        format=fmt,
        memory_size_mb=900,
        compute_type="q8_0",
        download_status=AiModelDownloadStatus.DOWNLOADED,
        local_path=None,
        downloaded_at=datetime.utcnow(),
        file_size_mb=0,
        checksum=None,
        tags=[],
        device=device,
    )


# ── whisper.cpp ──────────────────────────────────────────────────────────────


def _fake_pywhispercpp(model):
    package = types.ModuleType("pywhispercpp")
    model_module = types.ModuleType("pywhispercpp.model")
    model_module.Model = model
    package.model = model_module
    return {"pywhispercpp": package, "pywhispercpp.model": model_module}


@pytest.fixture
def _whisper_env(tmp_path):
    gguf = tmp_path / "whisper-large-v3-turbo-q8_0.gguf"
    gguf.write_bytes(b"GGUF")
    settings = MagicMock(whisper_cpp_num_threads=8)

    async def _resolve(_model_config, _settings):
        return gguf

    with (
        patch("stt.models.whisper_cpp_loader.get_settings", return_value=settings),
        patch("stt.models.whisper_cpp_loader.resolve_for_model_config", side_effect=_resolve),
        patch.dict(
            sys.modules, _fake_pywhispercpp(MagicMock(return_value=MagicMock(_ctx=object())))
        ),
    ):
        yield


class TestWhisperCppStampsAConcreteDevice:
    @pytest.mark.parametrize("detected", ["cuda", "mps"])
    async def test_an_auto_config_on_an_accelerator_host_bills_a_gpu_second(
        self, _whisper_env, detected
    ):
        """The defect: this stamped "auto", so a GPU whisper.cpp job metered as
        CPU_SECOND for as long as the gap existed."""
        with patch("stt.core.platform.get_device_string", return_value=detected):
            loaded = await WhisperCppLoader().load(_config(AiModelFormat.WHISPER_CPP, "auto"))

        assert loaded.device == detected
        assert normalize_device(loaded.device) == detected

    async def test_an_absent_device_resolves_the_same_way_as_auto(self, _whisper_env):
        with patch("stt.core.platform.get_device_string", return_value="cuda"):
            loaded = await WhisperCppLoader().load(_config(AiModelFormat.WHISPER_CPP, None))

        assert loaded.device == "cuda"

    async def test_a_cpu_only_host_still_reports_cpu(self, _whisper_env):
        with patch("stt.core.platform.get_device_string", return_value="cpu"):
            loaded = await WhisperCppLoader().load(_config(AiModelFormat.WHISPER_CPP, "auto"))

        assert loaded.device == "cpu"
        assert normalize_device(loaded.device) == "cpu"

    async def test_an_operator_pinned_cpu_is_never_upgraded_to_the_hosts_gpu(self, _whisper_env):
        """The other direction: `device: cpu` turns ggml's GPU off, so claiming
        the host's accelerator would over-bill the tenant for hardware the run
        never touched. `get_device_string` must not even be consulted."""
        with patch("stt.core.platform.get_device_string", return_value="cuda") as detect:
            loaded = await WhisperCppLoader().load(_config(AiModelFormat.WHISPER_CPP, "cpu"))

        assert loaded.device == "cpu"
        detect.assert_not_called()

    async def test_the_literal_auto_never_reaches_the_ledger(self, _whisper_env):
        """The regression guard, stated as the invariant rather than a value."""
        with patch("stt.core.platform.get_device_string", return_value="mps"):
            loaded = await WhisperCppLoader().load(_config(AiModelFormat.WHISPER_CPP, "auto"))

        assert loaded.device != "auto"
        assert loaded.device in {"cuda", "mps", "cpu"}


# ── parakeet.cpp ─────────────────────────────────────────────────────────────


@pytest.fixture
def _parakeet_env(tmp_path):
    settings = MagicMock(parakeet_cpp_num_threads=8, parakeet_cpp_library_path=None)

    async def _resolve(_model_config, _settings):
        return tmp_path

    with (
        patch("stt.models.parakeet_cpp_loader.get_settings", return_value=settings),
        patch("stt.models.parakeet_cpp_loader.resolve_for_model_config", side_effect=_resolve),
        patch.object(ParakeetCppLoader, "_resolve_binding", return_value=MagicMock()),
    ):
        yield


class TestParakeetCppStampsAConcreteDevice:
    @pytest.mark.parametrize("detected", ["cuda", "mps"])
    async def test_an_auto_config_on_an_accelerator_host_bills_a_gpu_second(
        self, _parakeet_env, detected
    ):
        with patch("stt.core.platform.get_device_string", return_value=detected):
            loaded = await ParakeetCppLoader().load(_config(AiModelFormat.PARAKEET_CPP, "auto"))

        assert loaded.device == detected
        assert normalize_device(loaded.device) == detected

    async def test_an_absent_device_resolves_the_same_way_as_auto(self, _parakeet_env):
        with patch("stt.core.platform.get_device_string", return_value="mps"):
            loaded = await ParakeetCppLoader().load(_config(AiModelFormat.PARAKEET_CPP, None))

        assert loaded.device == "mps"

    async def test_a_cpu_only_host_still_reports_cpu(self, _parakeet_env):
        with patch("stt.core.platform.get_device_string", return_value="cpu"):
            loaded = await ParakeetCppLoader().load(_config(AiModelFormat.PARAKEET_CPP, "auto"))

        assert loaded.device == "cpu"

    async def test_an_operator_pinned_cpu_is_honoured(self, _parakeet_env):
        with patch("stt.core.platform.get_device_string", return_value="cuda"):
            loaded = await ParakeetCppLoader().load(_config(AiModelFormat.PARAKEET_CPP, "cpu"))

        assert loaded.device == "cpu"

    async def test_the_literal_auto_never_reaches_the_ledger(self, _parakeet_env):
        with patch("stt.core.platform.get_device_string", return_value="cuda"):
            loaded = await ParakeetCppLoader().load(_config(AiModelFormat.PARAKEET_CPP, "auto"))

        assert loaded.device != "auto"
        assert loaded.device in {"cuda", "mps", "cpu"}
