"""Unit tests for the rewritten NeMoLoader."""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock, patch

import pytest

from stt.core.exceptions import ModelLoadError
from stt.models.base_loader import LoadedModel
from stt.models.nemo_loader import NeMoLoader
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)


def _make_config(
    *,
    source_uri: str = "nvidia/parakeet-tdt-0.6b-v2",
    local_path: str | None = None,
) -> AiModelConfig:
    return AiModelConfig(
        id="m-nemo-1",
        tenant_id=None,
        slug="parakeet-tdt-0-6b-v2",
        name="Parakeet TDT 0.6B v2",
        description=None,
        task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        source=AiModelSource.HUGGINGFACE,
        source_uri=source_uri,
        source_revision=None,
        format=AiModelFormat.NEMO,
        memory_size_mb=None,
        compute_type=None,
        download_status=AiModelDownloadStatus.NOT_DOWNLOADED,
        local_path=local_path,
        downloaded_at=None,
        file_size_mb=None,
        checksum=None,
        tags=[],
    )


def _install_fake_nemo() -> tuple[types.ModuleType, MagicMock]:
    """Install a minimal fake `nemo.collections.asr.models.ASRModel`.

    Returns the ASRModel class mock for assertions.
    """
    mock_asrmodel_cls = MagicMock(name="ASRModel")
    fake_model_instance = MagicMock(name="ASRModelInstance")
    fake_model_instance.cfg = MagicMock(target_lang="en")
    fake_model_instance.parameters.return_value = []
    # to(device) returns self; eval() returns self; .float()/.half() return self
    fake_model_instance.to.return_value = fake_model_instance
    fake_model_instance.eval.return_value = fake_model_instance
    fake_model_instance.float.return_value = fake_model_instance
    fake_model_instance.half.return_value = fake_model_instance
    type(fake_model_instance).__name__ = "EncDecRNNTBPEModel"
    mock_asrmodel_cls.from_pretrained.return_value = fake_model_instance
    mock_asrmodel_cls.restore_from.return_value = fake_model_instance

    # Build the module hierarchy: nemo.collections.asr.models
    nemo_mod = types.ModuleType("nemo")
    collections_mod = types.ModuleType("nemo.collections")
    asr_mod = types.ModuleType("nemo.collections.asr")
    models_mod = types.ModuleType("nemo.collections.asr.models")
    models_mod.ASRModel = mock_asrmodel_cls
    asr_mod.models = models_mod
    collections_mod.asr = asr_mod
    nemo_mod.collections = collections_mod

    sys.modules["nemo"] = nemo_mod
    sys.modules["nemo.collections"] = collections_mod
    sys.modules["nemo.collections.asr"] = asr_mod
    sys.modules["nemo.collections.asr.models"] = models_mod

    return mock_asrmodel_cls, fake_model_instance


@pytest.fixture
def fake_nemo(monkeypatch):
    saved = {
        k: sys.modules.get(k)
        for k in (
            "nemo",
            "nemo.collections",
            "nemo.collections.asr",
            "nemo.collections.asr.models",
        )
    }
    cls, instance = _install_fake_nemo()
    yield cls, instance
    for k, v in saved.items():
        if v is None:
            sys.modules.pop(k, None)
        else:
            sys.modules[k] = v


class TestNeMoLoaderRewrite:
    @pytest.mark.asyncio
    async def test_load_uses_asrmodel_from_pretrained_for_hf_id(self, fake_nemo):
        cls, instance = fake_nemo
        loader = NeMoLoader()
        with patch.object(loader, "_get_device", return_value="cpu"):
            loaded = await loader.load(_make_config(source_uri="nvidia/parakeet-tdt-0.6b-v2"))
        cls.from_pretrained.assert_called_once()
        called_args, called_kwargs = cls.from_pretrained.call_args
        # Either positional or keyword model_name should match
        passed = list(called_args) + list(called_kwargs.values())
        assert "nvidia/parakeet-tdt-0.6b-v2" in passed
        assert isinstance(loaded, LoadedModel)
        assert loaded.format == AiModelFormat.NEMO
        assert loaded.model is instance
        assert loaded.processor is None
        assert loaded.feature_extractor is None
        # Extras populated for downstream adapter
        assert loaded.extra.get("model_class") == "EncDecRNNTBPEModel"
        assert loaded.extra.get("target_lang") == "en"
        assert "supports_word_timestamps" in loaded.extra

    @pytest.mark.asyncio
    async def test_load_handles_tdt_variant(self, fake_nemo):
        # tdt variant must not crash with substring dispatch (no longer used)
        cls, _instance = fake_nemo
        loader = NeMoLoader()
        with patch.object(loader, "_get_device", return_value="cpu"):
            loaded = await loader.load(_make_config(source_uri="nvidia/parakeet-tdt-1.1b"))
        assert loaded.format == AiModelFormat.NEMO
        cls.from_pretrained.assert_called_once()

    @pytest.mark.asyncio
    async def test_load_falls_back_to_local_path_when_present(self, fake_nemo, tmp_path):
        cls, instance = fake_nemo
        ckpt = tmp_path / "model.nemo"
        ckpt.write_bytes(b"fake")
        loader = NeMoLoader()
        with patch.object(loader, "_get_device", return_value="cpu"):
            loaded = await loader.load(
                _make_config(
                    source_uri="nvidia/parakeet-tdt-0.6b-v2",
                    local_path=str(ckpt),
                )
            )
        cls.restore_from.assert_called_once()
        cls.from_pretrained.assert_not_called()
        assert loaded.model is instance

    @pytest.mark.asyncio
    async def test_load_raises_modelloaderror_when_nemo_missing(self, monkeypatch):
        # Remove any cached nemo module and force ImportError
        for k in list(sys.modules):
            if k == "nemo" or k.startswith("nemo."):
                monkeypatch.delitem(sys.modules, k, raising=False)

        # Block import of nemo
        real_import = (
            __builtins__["__import__"]
            if isinstance(__builtins__, dict)
            else __builtins__.__import__
        )

        def fake_import(name, *args, **kwargs):
            if name == "nemo" or name.startswith("nemo."):
                raise ImportError("No module named 'nemo'")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr("builtins.__import__", fake_import)

        loader = NeMoLoader()
        with patch.object(loader, "_get_device", return_value="cpu"):
            with pytest.raises(ModelLoadError):
                await loader.load(_make_config())
