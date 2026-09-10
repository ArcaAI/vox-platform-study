"""TASK-944 lane B2 — the declared library REACHES the loader, and a wrong-loader
failure no longer reads like a missing model.

Companion to ``test_task944_loader_selection.py``, which locks the selection
itself. This half locks the two things that made the defect cost three
diagnoses instead of one:

* the loader-selection field has to travel — ``AiModel.libraryName`` →
  ``ResolvedAsrSpec.models.*.libraryName`` → ``AiModelConfig.library_name``.
  It could not, before, which is why ``apps/stt`` kept selecting on ``format``
  a whole release after TASK-860 made ``format`` descriptive;
* "this cache does not load that kind of artifact" and "the weights are not
  there" have to READ differently. Offline, ``transformers`` renders both as
  *"couldn't connect to huggingface.co ... couldn't find them in the cached
  files"*.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import structlog

from stt.core.exceptions import ModelLoadError, ModelNotCacheServedError
from stt.models.huggingface_loader import HuggingFaceLoader
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelRef,
    ModelRefs,
    ModelTaskType,
)
from stt.pipeline.spec import AsrSpecModel, ResolvedAsrSpec, pipeline_spec_from_resolved
from stt.streaming.session_manager import SessionManager


def _load_fixture() -> dict[str, Any]:
    """The shared cross-language contract fixture (walk up to the repo root)."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


FIXTURE = _load_fixture()


# ---------------------------------------------------------------------------
# 1 — the field travels
# ---------------------------------------------------------------------------


def test_the_contract_fixture_declares_a_library_on_every_model():
    """The gateway is the only place that KNOWS the library; the fixture pins that it sends it."""
    for name, case in FIXTURE.items():
        if not isinstance(case, dict) or "expected" not in case:
            continue
        for role, model in case["expected"]["models"].items():
            assert model.get("libraryName"), (
                f"{name}.models.{role} carries no `libraryName`; `apps/stt` would fall "
                "back to the `format` key, which is exactly the TASK-944 defect"
            )


def test_the_library_reaches_the_ai_model_config_the_loaders_take():
    """`ResolvedAsrSpec` → `AiModelConfig`, the hop `ModelCache.loader_for` reads."""
    spec = ResolvedAsrSpec.model_validate(FIXTURE["platformDefault"]["expected"])
    _pipeline, configs = pipeline_spec_from_resolved(spec)

    embedding = configs["ecapa-tdnn-voxceleb"]
    assert embedding.library_name == "speechbrain"
    assert configs["arcaai-whisper-large-ml-en-gguf"].library_name == "whisper.cpp"
    assert configs["silero-vad"].library_name == "onnxruntime"


def test_an_omitted_library_round_trips_as_omitted_not_null():
    """`extra='forbid'` on both halves — the field must be OMIT-when-absent.

    That is what lets the gateway and this service deploy in either order: a
    spec built before the field exists still validates, and one built here
    without it does not grow a `libraryName: null` key the other half rejects.
    """
    model = AsrSpecModel(
        role="asr",
        slug="x",
        task_type="AUTOMATIC_SPEECH_RECOGNITION",
        format="WHISPER_CPP",
        source_uri="org/repo",
        source_revision=None,
        local_path=None,
        checksum=None,
        compute_type=None,
        provider=None,
        tenant_id="00000000-0000-0000-0000-000000000000",
    )
    assert "libraryName" not in model.model_dump(by_alias=True, mode="json")
    assert model.library_name is None


# ---------------------------------------------------------------------------
# 2 — a wrong-loader failure is distinguishable from a cache miss
# ---------------------------------------------------------------------------


def _hf_config(**overrides: Any) -> AiModelConfig:
    base: dict[str, Any] = {
        "id": "agent-model:wespeaker-voxceleb-resnet34",
        "tenant_id": "00000000-0000-0000-0000-000000000000",
        "slug": "wespeaker-voxceleb-resnet34",
        "name": "wespeaker",
        "description": None,
        "task_type": ModelTaskType.SPEAKER_EMBEDDING,
        "source": AiModelSource.HUGGINGFACE,
        "source_uri": "pyannote/wespeaker-voxceleb-resnet34-LM",
        "source_revision": None,
        "format": AiModelFormat.PYTORCH,
        "memory_size_mb": None,
        "compute_type": None,
        "download_status": AiModelDownloadStatus.DOWNLOADED,
        "local_path": None,
        "downloaded_at": None,
        "file_size_mb": None,
        "checksum": None,
        "tags": [],
        "library_name": "pyannote-audio",
    }
    base.update(overrides)
    return AiModelConfig(**base)


def test_a_present_snapshot_without_config_json_says_so(tmp_path):
    """The pyannote snapshot as published: `config.yaml` + `pytorch_model.bin`."""
    snapshot = tmp_path / "models--pyannote--wespeaker-voxceleb-resnet34-LM"
    snapshot.mkdir()
    (snapshot / "config.yaml").write_text(
        "_target_: pyannote.audio.models.embedding.WeSpeakerResNet34\n", encoding="utf-8"
    )
    (snapshot / "pytorch_model.bin").write_bytes(b"\x00")

    hint = HuggingFaceLoader._not_a_transformers_checkpoint_hint(
        _hf_config(local_path=str(snapshot))
    )

    assert "no `config.json`" in hint
    assert "config.yaml" in hint
    assert "pyannote-audio" in hint
    assert "not a missing or unreachable model" in hint


def test_a_genuinely_absent_snapshot_adds_no_hint(tmp_path):
    """A real cache miss must NOT be relabelled a loader mismatch — the inverse defect."""
    assert HuggingFaceLoader._not_a_transformers_checkpoint_hint(_hf_config()) == ""
    assert (
        HuggingFaceLoader._not_a_transformers_checkpoint_hint(
            _hf_config(local_path=str(tmp_path / "nope"))
        )
        == ""
    )
    empty = tmp_path / "empty"
    empty.mkdir()
    assert (
        HuggingFaceLoader._not_a_transformers_checkpoint_hint(_hf_config(local_path=str(empty)))
        == ""
    )


def test_a_real_transformers_checkpoint_adds_no_hint(tmp_path):
    snapshot = tmp_path / "whisper"
    snapshot.mkdir()
    (snapshot / "config.json").write_text("{}", encoding="utf-8")
    assert (
        HuggingFaceLoader._not_a_transformers_checkpoint_hint(
            _hf_config(local_path=str(snapshot), library_name="transformers")
        )
        == ""
    )


def test_the_refusal_type_alone_separates_the_two_causes():
    """`ModelNotCacheServedError` is a `ModelLoadError` — catchable as before, nameable now."""
    assert issubclass(ModelNotCacheServedError, ModelLoadError)


async def test_the_refusal_survives_the_real_single_flight_load_path():
    """`loader_for` raises inside the SHARED cache's factory, not at the call site.

    The warm path calls `get_or_load_from_ref` -> `get_or_load`, so the exception
    crosses `hope_runtime_models.ModelCache`'s single-flight machinery before the
    session manager can catch it. If that wrapped the type, the INFO-level skip would
    never fire and the warm would go back to reading as a failure — which every other
    test here would still pass.
    """
    from stt.models.cache import ModelCache

    cache = ModelCache(max_memory_mb=1000, max_models=2, ttl_seconds=600)
    with pytest.raises(ModelNotCacheServedError):
        await cache.get_or_load(_hf_config())


# ---------------------------------------------------------------------------
# 3 — the warm path stops paying for a load that cannot succeed
# ---------------------------------------------------------------------------


class _FakeCache:
    """Only what `_warm_and_pin_pipeline_models` touches."""

    def __init__(self, refuse: set[str]) -> None:
        self._refuse = refuse
        self.attempted: list[str] = []
        self.pinned: list[str] = []

    async def get_or_load_from_ref(self, *, model_ref, task_type, db_model_config):
        del task_type, db_model_config
        slug = model_ref.slug
        self.attempted.append(slug)
        if slug in self._refuse:
            raise ModelNotCacheServedError(
                f"Model '{slug}' declares serving library 'pyannote-audio', which this model "
                "cache does not load. It is executed by PyannoteEmbeddingService."
            )
        return SimpleNamespace(model_slug=slug)

    async def pin_many(self, slugs):
        self.pinned.extend(slugs)

    async def pin(self, slug):
        self.pinned.append(slug)


@pytest.fixture
def warm_manager() -> Any:
    """A bare object carrying only what the warm helper reads off `self`.

    `_session_specs` must hold the session id: a spec-driven session carries its
    own model configs, and its absence is what sends `_load_optional` to the
    deprecated (and disabled) registry reader instead of to the cache.
    """
    return SimpleNamespace(
        _session_specs={
            "sess-1": SimpleNamespace(model_configs={}),
            "sess-2": SimpleNamespace(model_configs={}),
        }
    )


async def test_a_runtime_owned_model_is_skipped_at_info_not_warned_as_a_failure(warm_manager):
    """The 9.3 s cold-start burn and the misleading WARNING, both gone.

    The session manager builds `PyannoteEmbeddingService` itself from the very
    same spec row (`_get_pipeline_embedding_service`), so this warm was never
    what made diarization work — it was a second, doomed load of the same model
    through `transformers`.
    """
    cache = _FakeCache(refuse={"wespeaker-voxceleb-resnet34"})
    models = ModelRefs(
        asr=ModelRef(slug="arcaai-whisper-large-ml-en-gguf"),
        vad=ModelRef(slug="silero-vad"),
        embedding=ModelRef(slug="wespeaker-voxceleb-resnet34"),
    )

    with structlog.testing.capture_logs() as logs:
        pinned = await SessionManager._warm_and_pin_pipeline_models(
            warm_manager,
            cache,
            SimpleNamespace(models=models),
            tenant_id=None,
            session_id="sess-1",
        )

    warnings = [entry for entry in logs if entry["log_level"] == "warning"]
    assert warnings == [], f"a deliberate skip must not read as a failure: {warnings}"

    skips = [entry for entry in logs if "Skipped warming" in entry.get("event", "")]
    assert len(skips) == 1
    assert "PyannoteEmbeddingService" in skips[0]["reason"]

    # The models the cache DOES serve are unaffected.
    assert "silero-vad" in pinned
    assert "arcaai-whisper-large-ml-en-gguf" in pinned
    assert "wespeaker-voxceleb-resnet34" not in pinned


async def test_a_genuine_warm_failure_is_still_a_warning(warm_manager):
    """The skip must not swallow the failures the WARNING exists for."""

    class _Broken(_FakeCache):
        async def get_or_load_from_ref(self, *, model_ref, task_type, db_model_config):
            del task_type, db_model_config
            self.attempted.append(model_ref.slug)
            raise ModelLoadError("weights not in cache")

    with structlog.testing.capture_logs() as logs:
        await SessionManager._warm_and_pin_pipeline_models(
            warm_manager,
            _Broken(refuse=set()),
            SimpleNamespace(models=ModelRefs(asr=ModelRef(slug="a"), vad=ModelRef(slug="v"))),
            tenant_id=None,
            session_id="sess-2",
        )

    warnings = [entry for entry in logs if entry["log_level"] == "warning"]
    assert len(warnings) == 1
    assert "weights not in cache" in warnings[0]["error"]
