"""TASK-860 — SpeechBrain loads a PUBLISHED (local) prefix in place.

`EncoderClassifier.from_hparams(source=<dir>)` without `savedir` copies every
file into `pretrained_models/<hash>/` — a write on a read-only bucket mount and
the surface of the speechbrain 1.0.x offline-fetch defect (#2817). A local
source must therefore be its own `savedir`; a Hub id keeps the default.
Hermetic — `speechbrain` is a stub module injected into `sys.modules`.
"""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock, patch


def _fake_speechbrain() -> tuple[dict[str, types.ModuleType], MagicMock]:
    encoder_cls = MagicMock()
    speaker = types.ModuleType("speechbrain.inference.speaker")
    speaker.EncoderClassifier = encoder_cls  # type: ignore[attr-defined]
    fetching = types.ModuleType("speechbrain.utils.fetching")
    fetching.FetchConfig = MagicMock(return_value="fetch-config")  # type: ignore[attr-defined]
    inference = types.ModuleType("speechbrain.inference")
    utils = types.ModuleType("speechbrain.utils")
    root = types.ModuleType("speechbrain")
    return (
        {
            "speechbrain": root,
            "speechbrain.inference": inference,
            "speechbrain.inference.speaker": speaker,
            "speechbrain.utils": utils,
            "speechbrain.utils.fetching": fetching,
        },
        encoder_cls,
    )


def _load(model_id: str) -> MagicMock:
    from stt.diarization.speechbrain_embedding import SpeechBrainEmbeddingService

    modules, encoder_cls = _fake_speechbrain()
    settings = MagicMock(diarization_device="cpu")
    with (
        patch.dict(sys.modules, modules),
        patch("stt.diarization.speechbrain_embedding._resolve_hf_token", return_value=None),
    ):
        SpeechBrainEmbeddingService(hf_model_id=model_id)._load_model_sync(model_id, settings)
    return encoder_cls


def test_local_published_prefix_is_its_own_savedir(tmp_path):
    encoder_cls = _load(str(tmp_path))

    kwargs = encoder_cls.from_hparams.call_args.kwargs
    assert kwargs["source"] == str(tmp_path)
    assert kwargs["savedir"] == str(tmp_path)


def test_hub_id_keeps_the_default_savedir():
    encoder_cls = _load("speechbrain/spkrec-ecapa-voxceleb")

    kwargs = encoder_cls.from_hparams.call_args.kwargs
    assert kwargs["source"] == "speechbrain/spkrec-ecapa-voxceleb"
    assert "savedir" not in kwargs
