"""TASK-860 — Kokoro loads explicit published paths, never HF_HOME.

`KModel(config=…, model=…)` + voice `.pt` paths bypass the Hub entirely
(verified in kokoro/model.py). A SET `model_path` that lacks the files fails at
construction; an empty one keeps the dev Hub fallback. Hermetic — `kokoro` is a
stub module injected into `sys.modules`.
"""

from __future__ import annotations

import asyncio
import sys
import types
from unittest.mock import MagicMock, patch

import pytest

from tts.core.config import KokoroConfig
from tts.providers.kokoro import KokoroProvider, resolve_kokoro_paths, resolve_kokoro_voice


def _published(tmp_path, *, voices: tuple[str, ...] = ("af_heart",)):
    (tmp_path / "config.json").write_text("{}")
    (tmp_path / "kokoro-v1_0.pth").write_bytes(b"pth")
    vdir = tmp_path / "voices"
    vdir.mkdir()
    for v in voices:
        (vdir / f"{v}.pt").write_bytes(b"pt")
    return KokoroConfig().model_copy(update={"model_path": str(tmp_path)})


def test_empty_model_path_means_hub_fallback():
    assert resolve_kokoro_paths(KokoroConfig()) is None


def test_model_path_resolves_config_checkpoint_and_voices(tmp_path):
    paths = resolve_kokoro_paths(_published(tmp_path))
    assert paths is not None
    assert paths.config_json == str(tmp_path / "config.json")
    assert paths.model_pth == str(tmp_path / "kokoro-v1_0.pth")
    assert paths.voices_dir == str(tmp_path / "voices")


def test_model_path_without_the_files_fails_closed(tmp_path):
    cfg = KokoroConfig().model_copy(update={"model_path": str(tmp_path)})
    with pytest.raises(FileNotFoundError, match="TTS_KOKORO_MODEL_PATH"):
        resolve_kokoro_paths(cfg)
    with pytest.raises(FileNotFoundError):
        KokoroProvider(cfg)


def test_published_voice_resolves_to_its_pt_path_and_unpublished_stays_a_name(tmp_path):
    paths = resolve_kokoro_paths(_published(tmp_path, voices=("af_heart",)))
    assert resolve_kokoro_voice(paths, "af_heart") == str(tmp_path / "voices" / "af_heart.pt")
    assert resolve_kokoro_voice(paths, "am_adam") == "am_adam"
    assert resolve_kokoro_voice(None, "af_heart") == "af_heart"


def test_pipeline_is_built_from_kmodel_with_explicit_paths(tmp_path):
    cfg = _published(tmp_path)
    fake = types.ModuleType("kokoro")
    fake.KModel = MagicMock(name="KModel")  # type: ignore[attr-defined]
    fake.KPipeline = MagicMock(name="KPipeline")  # type: ignore[attr-defined]

    provider = KokoroProvider(cfg)
    with patch.dict(sys.modules, {"kokoro": fake}):
        pipeline = asyncio.run(provider._load_pipeline("kokoro"))

    fake.KModel.assert_called_once_with(config=str(tmp_path / "config.json"), model=str(tmp_path / "kokoro-v1_0.pth"))
    fake.KPipeline.assert_called_once_with(lang_code="a", model=fake.KModel.return_value)
    assert pipeline is fake.KPipeline.return_value


def test_hub_fallback_still_builds_kpipeline_without_a_model():
    fake = types.ModuleType("kokoro")
    fake.KModel = MagicMock(name="KModel")  # type: ignore[attr-defined]
    fake.KPipeline = MagicMock(name="KPipeline")  # type: ignore[attr-defined]

    provider = KokoroProvider(KokoroConfig())
    with patch.dict(sys.modules, {"kokoro": fake}):
        asyncio.run(provider._load_pipeline("kokoro"))

    fake.KModel.assert_not_called()
    fake.KPipeline.assert_called_once_with(lang_code="a")
