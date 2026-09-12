"""TASK-944 lane B2 — loader selection keys on the DECLARED serving library.

The defect this suite locks
---------------------------
``ModelCache`` keyed its loader registry on ``AiModelFormat`` alone, so every
``format = PYTORCH`` row in the catalogue was handed to ``HuggingFaceLoader``
— i.e. to ``transformers``. Essentially none of them is a transformers
checkpoint:

===============================  ==================  =========================
slug                             ``libraryName``     what actually runs it
===============================  ==================  =========================
``wespeaker-voxceleb-resnet34``  ``pyannote-audio``  ``PyannoteEmbeddingService``
``ecapa-tdnn-voxceleb``          ``speechbrain``     ``SpeechBrainEmbeddingService``
``rnnoise``                      ``pyrnnoise``       the RNNoise denoiser
``deepfilternet3``               ``deepfilternet``   the DeepFilterNet3 denoiser
===============================  ==================  =========================

``transformers.from_pretrained`` needs ``config.json``; the pyannote snapshot
publishes ``config.yaml`` + ``pytorch_model.bin``. Offline, transformers renders
that as *"couldn't connect ... couldn't find them in the cached files"*, which
reads exactly like a missing model — which is why TWO prior diagnoses on this
ticket blamed the DATA (a stale ``sourceUri``, then a wrong ``cache_dir``) and
both were wrong.

``AiModel.libraryName`` is the field the catalogue already declares for exactly
this: *"Artifact format — descriptive only since TASK-860. Loader selection is
``libraryName``"* (``packages/database/src/prisma/db_main/ai-model.prisma``).
The STT runtime never received it, so this half of TASK-860 never happened.
"""

from __future__ import annotations

import pytest

from stt.core.exceptions import ModelLoadError, ModelNotCacheServedError
from stt.models.cache import RUNTIME_OWNED_LIBRARIES, ModelCache
from stt.models.faster_whisper_loader import FasterWhisperLoader
from stt.models.huggingface_loader import HuggingFaceLoader
from stt.models.nemo_loader import NeMoLoader
from stt.models.onnx_loader import ONNXLoader
from stt.models.whisper_cpp_loader import WhisperCppLoader
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)


@pytest.fixture
def cache() -> ModelCache:
    """The production registry, read off ``_install_loaders`` — never rebuilt here."""
    instance = ModelCache.__new__(ModelCache)  # no __init__: skip cache/metrics setup
    ModelCache._install_loaders(instance)
    return instance


def _config(
    *,
    slug: str,
    library_name: str | None,
    fmt: AiModelFormat = AiModelFormat.PYTORCH,
    task: ModelTaskType = ModelTaskType.SPEAKER_EMBEDDING,
    source_uri: str = "pyannote/wespeaker-voxceleb-resnet34-LM",
) -> AiModelConfig:
    return AiModelConfig(
        id=f"agent-model:{slug}",
        tenant_id="00000000-0000-0000-0000-000000000000",
        slug=slug,
        name=slug,
        description=None,
        task_type=task,
        source=AiModelSource.HUGGINGFACE,
        source_uri=source_uri,
        source_revision=None,
        format=fmt,
        memory_size_mb=None,
        compute_type=None,
        download_status=AiModelDownloadStatus.DOWNLOADED,
        local_path=None,
        downloaded_at=None,
        file_size_mb=None,
        checksum=None,
        tags=[],
        library_name=library_name,
    )


# ---------------------------------------------------------------------------
# 1 — the measured defect
# ---------------------------------------------------------------------------


def test_the_pyannote_embedding_row_never_reaches_the_transformers_loader(cache):
    """The live failure: `wespeaker-voxceleb-resnet34` routed to `transformers`."""
    config = _config(slug="wespeaker-voxceleb-resnet34", library_name="pyannote-audio")

    with pytest.raises(ModelNotCacheServedError) as excinfo:
        cache.loader_for(config)

    message = str(excinfo.value)
    assert "pyannote-audio" in message
    assert "PyannoteEmbeddingService" in message


#: Every ``format = PYTORCH`` row served by ``apps/stt`` in the seeded catalogue
#: (``packages/database/src/prisma/db_main/seed/ai-models/audio.ts``). All four
#: were routed to ``transformers`` before this ticket; none of them is one.
_MISROUTED_PYTORCH_ROWS = [
    ("wespeaker-voxceleb-resnet34", "pyannote-audio", ModelTaskType.SPEAKER_EMBEDDING),
    ("ecapa-tdnn-voxceleb", "speechbrain", ModelTaskType.SPEAKER_EMBEDDING),
    ("rnnoise", "pyrnnoise", ModelTaskType.AUDIO_TO_AUDIO),
    ("deepfilternet3", "deepfilternet", ModelTaskType.AUDIO_TO_AUDIO),
]
_MISROUTED_IDS = [row[0] for row in _MISROUTED_PYTORCH_ROWS]


@pytest.mark.parametrize(("slug", "library", "task"), _MISROUTED_PYTORCH_ROWS, ids=_MISROUTED_IDS)
def test_no_pytorch_catalogue_row_is_handed_to_transformers(cache, slug, library, task):
    """The blast radius, row by row — `format` alone cannot tell these apart."""
    config = _config(slug=slug, library_name=library, task=task)
    with pytest.raises(ModelNotCacheServedError):
        cache.loader_for(config)


def test_the_runtime_that_owns_each_library_is_named_not_merely_refused():
    """A refusal that does not say WHO loads it instead sends the reader to the data."""
    for _slug, library, _task in _MISROUTED_PYTORCH_ROWS:
        assert RUNTIME_OWNED_LIBRARIES[library].strip(), library


# ---------------------------------------------------------------------------
# 2 — the libraries this cache DOES serve still resolve, unchanged
# ---------------------------------------------------------------------------


_SERVED = [
    ("transformers", AiModelFormat.SAFETENSOR, HuggingFaceLoader),
    ("faster-whisper", AiModelFormat.FASTER_WHISPER, FasterWhisperLoader),
    ("whisper.cpp", AiModelFormat.WHISPER_CPP, WhisperCppLoader),
    ("onnxruntime", AiModelFormat.ONNX, ONNXLoader),
    ("nemo", AiModelFormat.NEMO, NeMoLoader),
]


@pytest.mark.parametrize(
    ("library", "fmt", "expected"), _SERVED, ids=[served[0] for served in _SERVED]
)
def test_a_served_library_selects_the_loader_that_executes_it(cache, library, fmt, expected):
    config = _config(
        slug="x", library_name=library, fmt=fmt, task=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION
    )
    assert isinstance(cache.loader_for(config), expected)


def test_the_declared_library_wins_over_the_format(cache):
    """A row whose `format` says PYTORCH but whose library says onnxruntime loads as ONNX.

    `format` is descriptive since TASK-860; if the two disagree the DECLARED
    selection field is the answer, otherwise this fix is cosmetic.
    """
    config = _config(
        slug="x",
        library_name="onnxruntime",
        fmt=AiModelFormat.PYTORCH,
        task=ModelTaskType.VOICE_ACTIVITY_DETECTION,
    )
    assert isinstance(cache.loader_for(config), ONNXLoader)


# ---------------------------------------------------------------------------
# 3 — the paths that carry no library are unchanged (independent deployability)
# ---------------------------------------------------------------------------


def test_a_config_with_no_declared_library_falls_back_to_format(cache):
    """Inline model defs and the deprecated DB reader declare no library.

    The gateway and this service deploy independently, so a spec built by a
    gateway that predates the field must keep working exactly as before.
    """
    config = _config(
        slug="x",
        library_name=None,
        fmt=AiModelFormat.SAFETENSOR,
        task=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    )
    assert isinstance(cache.loader_for(config), HuggingFaceLoader)


def test_an_unknown_library_fails_closed(cache):
    """Selection fails closed — a guessed engine is never substituted."""
    with pytest.raises(ModelLoadError) as excinfo:
        cache.loader_for(_config(slug="x", library_name="not-a-library"))
    assert "not-a-library" in str(excinfo.value)


def test_a_format_with_no_loader_fails_closed(cache):
    """The pre-existing format fallback still raises rather than returning ``None``."""
    stripped = ModelCache.__new__(ModelCache)
    ModelCache._install_loaders(stripped)
    stripped._loaders.pop(AiModelFormat.SAFETENSOR)
    with pytest.raises(ModelLoadError):
        stripped.loader_for(_config(slug="x", library_name=None, fmt=AiModelFormat.SAFETENSOR))


# ---------------------------------------------------------------------------
# 4 — registry invariants
# ---------------------------------------------------------------------------


def test_every_library_loader_is_also_reachable_by_format(cache):
    """`_unload_model` resolves by `LoadedModel.format`, which carries no library.

    That is only sound while every loader the library map can select is the SAME
    INSTANCE the format map holds — otherwise an entry could be admitted through
    one loader and released through another.
    """
    by_format = {id(loader) for loader in cache._loaders.values()}
    for library, loader in cache._library_loaders.items():
        assert id(loader) in by_format, (
            f"library {library!r} selects a loader instance the format map does not hold; "
            "`_unload_model` would release it through a different loader"
        )


def test_the_two_library_tables_are_disjoint(cache):
    """A library is either served by this cache or owned by a runtime — never both."""
    assert not (set(cache._library_loaders) & set(RUNTIME_OWNED_LIBRARIES))


def test_the_library_registry_sweep_actually_found_loaders(cache):
    """Guard the guard: an empty map makes the parametrised cases vacuous."""
    assert len(cache._library_loaders) >= 10
