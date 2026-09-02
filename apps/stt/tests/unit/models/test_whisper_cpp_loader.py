"""Unit tests for the whisper.cpp (ggml) loader.

Covers the two defects behind the live-transcription segfault:

1. ``_select_gguf_file`` must NOT pick a top-level generic-GGUF file when the
   repo also ships whisper.cpp-format weights under a ``whisper.cpp/``
   subdirectory. The oxide-lab/whisper-large-v3-turbo-GGUF repo ships both; the
   top-level files fail whisper.cpp's magic check ("invalid model data (bad
   magic)") and segfault ``pywhispercpp`` at transcribe time, while the
   ``whisper.cpp/`` variants load cleanly.
2. ``load`` must detect a failed ``pywhispercpp`` init (null ``_ctx``) and raise
   ``ModelLoadError`` instead of returning a dead handle that the model cache
   then serves — a single bad session otherwise segfaults the whole service.
"""

from __future__ import annotations

import os
import sys
import types
from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from stt.core.exceptions import ModelLoadError
from stt.models.whisper_cpp_loader import WhisperCppLoader
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)


def _config(compute_type: str | None = "q8_0") -> AiModelConfig:
    return AiModelConfig(
        id="m-whispercpp-1",
        tenant_id="t-1",
        slug="whisper-large-v3-turbo-gguf",
        name="Whisper Large V3 Turbo (whisper.cpp GGUF)",
        description="whisper.cpp ggml runtime",
        task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        source=AiModelSource.HUGGINGFACE,
        source_uri="oxide-lab/whisper-large-v3-turbo-GGUF",
        source_revision="main",
        format=AiModelFormat.WHISPER_CPP,
        memory_size_mb=900,
        compute_type=compute_type,
        download_status=AiModelDownloadStatus.DOWNLOADED,
        local_path=None,
        downloaded_at=datetime.utcnow(),
        file_size_mb=0,
        checksum=None,
        tags=[],
    )


def _touch(path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(b"GGUF")


def _fake_pywhispercpp(model):
    package = types.ModuleType("pywhispercpp")
    model_module = types.ModuleType("pywhispercpp.model")
    model_module.Model = model
    package.model = model_module
    return {"pywhispercpp": package, "pywhispercpp.model": model_module}


# ── _select_gguf_file ────────────────────────────────────────────────────────


def test_prefers_whisper_cpp_subfolder_over_toplevel(tmp_path):
    """Given both a top-level and a whisper.cpp/ q8_0, pick the subfolder one."""
    repo = str(tmp_path)
    _touch(os.path.join(repo, "whisper-large-v3-turbo-q8_0.gguf"))
    _touch(os.path.join(repo, "whisper.cpp", "whisper-large-v3-turbo-q8_0.gguf"))

    selected = WhisperCppLoader._select_gguf_file(repo, _config("q8_0"))

    assert os.path.join("whisper.cpp", "whisper-large-v3-turbo-q8_0.gguf") in selected


def test_quant_match_within_whisper_cpp_subfolder(tmp_path):
    """The requested quant is honoured, but only among whisper.cpp/ candidates."""
    repo = str(tmp_path)
    _touch(os.path.join(repo, "whisper-large-v3-turbo-q8_0.gguf"))  # top-level decoy
    _touch(os.path.join(repo, "whisper.cpp", "whisper-large-v3-turbo-q4_k.gguf"))
    _touch(os.path.join(repo, "whisper.cpp", "whisper-large-v3-turbo-q8_0.gguf"))

    selected = WhisperCppLoader._select_gguf_file(repo, _config("q4_k"))

    assert selected.endswith(os.path.join("whisper.cpp", "whisper-large-v3-turbo-q4_k.gguf"))


def test_falls_back_to_toplevel_when_no_whisper_cpp_subfolder(tmp_path):
    """Repos without a whisper.cpp/ subdir keep the plain quant-match behaviour."""
    repo = str(tmp_path)
    _touch(os.path.join(repo, "model-q4_0.gguf"))
    _touch(os.path.join(repo, "model-q8_0.gguf"))

    selected = WhisperCppLoader._select_gguf_file(repo, _config("q8_0"))

    assert selected.endswith("model-q8_0.gguf")


def test_selects_ggml_bin_when_no_gguf(tmp_path):
    """Classic whisper.cpp `ggml-*.bin` weights are valid — pick them, honouring quant."""
    repo = str(tmp_path)
    _touch(os.path.join(repo, "ggml-whisper-turbo-ml-en-codeswitch-f16.bin"))
    _touch(os.path.join(repo, "ggml-whisper-turbo-ml-en-codeswitch-q5_0.bin"))
    _touch(os.path.join(repo, "ggml-whisper-turbo-ml-en-codeswitch-q8_0.bin"))

    selected = WhisperCppLoader._select_gguf_file(repo, _config("f16"))

    assert selected.endswith("ggml-whisper-turbo-ml-en-codeswitch-f16.bin")


def test_ignores_appledouble_sidecars(tmp_path):
    """macOS AppleDouble forks ("._name.bin") must never be selected as weights."""
    repo = str(tmp_path)
    _touch(os.path.join(repo, "._ggml-whisper-turbo-ml-en-codeswitch-q8_0.bin"))
    _touch(os.path.join(repo, "ggml-whisper-turbo-ml-en-codeswitch-q8_0.bin"))

    selected = WhisperCppLoader._select_gguf_file(repo, _config("q8_0"))

    assert os.path.basename(selected) == "ggml-whisper-turbo-ml-en-codeswitch-q8_0.bin"


def test_no_gguf_raises(tmp_path):
    with pytest.raises(ModelLoadError):
        WhisperCppLoader._select_gguf_file(str(tmp_path), _config("q8_0"))


def test_quant_mismatch_raises_instead_of_silently_substituting(tmp_path):
    """A requested quant with no matching candidate must fail closed (selection
    is `failMode: closed` — see .claude/rules/09-infrastructure-devops.md
    §Configuration Tiers), not silently return an unrelated quantization.
    """
    repo = str(tmp_path)
    _touch(os.path.join(repo, "ggml-whisper-turbo-ml-en-codeswitch-f16.bin"))
    _touch(os.path.join(repo, "ggml-whisper-turbo-ml-en-codeswitch-q5_0.bin"))

    with pytest.raises(ModelLoadError) as exc_info:
        WhisperCppLoader._select_gguf_file(repo, _config("q8_0"))

    message = str(exc_info.value)
    assert "whisper-large-v3-turbo-gguf" in message  # slug
    assert "q8_0" in message  # requested quant
    assert "ggml-whisper-turbo-ml-en-codeswitch-f16.bin" in message  # candidate seen
    assert "ggml-whisper-turbo-ml-en-codeswitch-q5_0.bin" in message  # candidate seen


def test_quant_mismatch_within_whisper_cpp_subfolder_raises(tmp_path):
    """The whisper.cpp/ subdirectory preference is applied before quant
    matching, so a mismatch is judged only against the subfolder's candidates
    — a top-level file that WOULD have matched must not rescue the request.
    """
    repo = str(tmp_path)
    _touch(os.path.join(repo, "whisper-large-v3-turbo-q8_0.gguf"))  # top-level decoy
    _touch(os.path.join(repo, "whisper.cpp", "whisper-large-v3-turbo-q4_k.gguf"))

    with pytest.raises(ModelLoadError) as exc_info:
        WhisperCppLoader._select_gguf_file(repo, _config("q8_0"))

    message = str(exc_info.value)
    assert "q8_0" in message  # requested quant
    assert "whisper-large-v3-turbo-q4_k.gguf" in message  # subfolder candidate seen
    assert "whisper-large-v3-turbo-q8_0.gguf" not in message  # top-level decoy excluded


# ── load: failed-init detection ──────────────────────────────────────────────


@pytest.fixture
def _patched_env(tmp_path):
    """Patch the resolver to a concrete .gguf file and settings to a thread count."""
    gguf = tmp_path / "whisper-large-v3-turbo-q8_0.gguf"
    gguf.write_bytes(b"GGUF")

    settings = MagicMock(whisper_cpp_num_threads=8)

    async def _resolve(_model_config, _settings):
        return gguf

    with (
        patch("stt.models.whisper_cpp_loader.get_settings", return_value=settings),
        patch("stt.models.whisper_cpp_loader.resolve_for_model_config", side_effect=_resolve),
    ):
        yield


async def test_load_raises_when_ctx_is_null(_patched_env):
    """pywhispercpp returns a handle with _ctx=None on a failed init — reject it."""
    dead_handle = MagicMock(_ctx=None)
    model = MagicMock(return_value=dead_handle)

    with patch.dict(sys.modules, _fake_pywhispercpp(model)):
        loader = WhisperCppLoader()
        with pytest.raises(ModelLoadError):
            await loader.load(_config("q8_0"))


async def test_load_succeeds_when_ctx_present(_patched_env):
    """A real whisper_context handle loads into a LoadedModel."""
    live_handle = MagicMock(_ctx=object())
    model = MagicMock(return_value=live_handle)

    with patch.dict(sys.modules, _fake_pywhispercpp(model)):
        loader = WhisperCppLoader()
        loaded = await loader.load(_config("q8_0"))

    assert loaded.model is live_handle
    assert loaded.format is AiModelFormat.WHISPER_CPP
