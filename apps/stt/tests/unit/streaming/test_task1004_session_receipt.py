"""TASK-1004 G-5 — a live session says which engine served it and what it applied.

The ``LanguageResolution`` receipt is built where the effective mode is resolved
(``_load_asr_pipeline``, the one choke point for create, every engine switch and
recovery) and:

* answered on the session-create HTTP response (``language_resolution``);
* JSON-encoded on the ``provider_switched`` status result entry, re-built for the
  engine that just took over;
* persisted in the session hash, so a worker restart keeps WHO declared the mode.

``source`` comes from the gateway (``language_mode_source``) or defaults to
``request`` for a declared mode, ``agent`` for the spec's own, ``default`` for none.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from stt.models.base_loader import LoadedModel
from stt.pipeline import language_modes
from stt.pipeline.language_modes import LanguageModeUnsupportedError
from stt.streaming._runtime import clear_runtime, set_session_manager
from stt.streaming.api.routes import router
from stt.streaming.redis_streams import ResultPublisher
from stt.streaming.schemas import SessionMetadata, SessionStatus
from stt.streaming.session_manager import SessionManager


def _fixture() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


BASE_SPEC = _fixture()["platformDefault"]["expected"]
PRIMARY_KEY = BASE_SPEC["runtimeKey"]


@pytest.fixture(autouse=True)
def _prompts_as_shipped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(language_modes, "WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED", False)
    monkeypatch.setattr(language_modes, "WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED", False)


def _spec(
    *,
    primary: tuple[str, str | None] = ("WHISPER_CPP", None),
    fallback: tuple[str, str | None] = ("FASTER_WHISPER", None),
    mode: str | None = "ml-en",
) -> dict[str, Any]:
    spec = copy.deepcopy(BASE_SPEC)
    spec["models"]["asr"]["format"], spec["models"]["asr"]["provider"] = primary
    spec["decoding"]["languageMode"] = mode
    for chain in (spec["fallback"]["spec"], *spec["fallback"]["chain"]):
        chain["models"]["asr"]["format"], chain["models"]["asr"]["provider"] = fallback
    return spec


def _cache() -> MagicMock:
    """A model cache that 'loads' whatever format the spec's row declares."""

    async def _load(*, model_ref: Any, task_type: Any, db_model_config: Any) -> LoadedModel:
        return LoadedModel(
            model_id="m",
            model_slug=db_model_config.slug,
            model=MagicMock(),
            format=db_model_config.format,
            device="cpu",
        )

    cache = MagicMock()
    cache.get_or_load_from_ref = AsyncMock(side_effect=_load)
    cache.pin = AsyncMock()
    return cache


def _manager() -> MagicMock:
    mgr = MagicMock(spec=SessionManager)
    for name in (
        "_sessions",
        "_consumers",
        "_control_listeners",
        "_publishers",
        "_preprocessors",
        "_inference_workers",
        "_dual_capture",
        "_commit_policies",
        "_switch_controllers",
        "_provider_overrides",
        "_fallback_pipeline_ids",
        "_session_language_modes",
        "_session_channel_counts",
        "_session_specs",
        "_session_asr_formats",
        "_session_connections",
        "_session_pinned_models",
        "_pending_front_end_geometry",
        "_empty_decode_streaks",
    ):
        setattr(mgr, name, {})
    mgr._creating = set()
    mgr._pending_want_word_timestamps = False
    mgr._redis = AsyncMock()
    mgr._worker_id = "test-worker"
    mgr._capacity_guard = MagicMock()
    mgr._capacity_guard.try_acquire = AsyncMock(return_value=True)
    mgr._register_inference_runtime = MagicMock()
    mgr._make_frame_handler = MagicMock(return_value=lambda x: None)
    mgr._make_batch_handler = MagicMock(return_value=lambda x: None)
    mgr._make_control_handler = MagicMock(return_value=lambda x: None)
    mgr._make_commit_policy = MagicMock(return_value=None)
    mgr._resolve_dual_capture = MagicMock(return_value=False)
    mgr._warm_and_pin_pipeline_models = AsyncMock(return_value=[])
    mgr._make_asr_callable = MagicMock(side_effect=lambda *a, **k: AsyncMock())
    mgr._load_gloss_pipeline = AsyncMock(return_value=None)
    mgr.remove_session = AsyncMock()
    type(mgr).active_session_count = 1
    # REAL: spec plumbing, the ASR loader (where the receipt is built), both engine
    # builders, the switch controller and the receipt accessor.
    for name in (
        "_make_switch_controller",
        "_load_pipeline_config",
        "_register_resolved_spec",
        "_load_asr_pipeline",
        "_build_fallback_asr_callable",
        "_build_primary_asr_callable",
        "_binding_from_pipeline_config",
        "get_language_resolution",
    ):
        setattr(mgr, name, getattr(SessionManager, name).__get__(mgr))

    mgr.publisher = AsyncMock()

    async def _assemble(**kw: Any) -> MagicMock:
        await mgr._load_asr_pipeline(
            kw["pipeline_config"],
            kw["session_id"],
            tenant_id=kw["tenant_id"],
            provider_overrides=kw.get("provider_overrides"),
        )
        runtime = MagicMock()
        runtime.publisher = mgr.publisher
        runtime.vad_service = None
        return runtime

    mgr._assemble_session_runtime = AsyncMock(side_effect=_assemble)
    return mgr


async def _create(mgr: MagicMock, spec: dict[str, Any], **overrides: Any) -> SessionMetadata:
    kwargs: dict[str, Any] = {
        "session_id": "s1",
        "tenant_id": "t1",
        "resolved_spec": spec,
    }
    kwargs.update(overrides)
    with (
        patch("stt.streaming.session_manager.StreamSession") as session_cls,
        patch("stt.streaming.session_manager.IngestionConsumer") as consumer_cls,
        patch("stt.streaming.session_manager.ControlListener") as listener_cls,
        patch("stt.models.get_model_cache", return_value=_cache()),
    ):
        session_cls.return_value.force_persist = AsyncMock()
        consumer_cls.return_value.start = AsyncMock()
        listener_cls.return_value.start = AsyncMock()
        await SessionManager.create_session(mgr, **kwargs)
    return session_cls.call_args.kwargs["metadata"]


# --- create -------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_stamps_the_receipt_of_the_engine_that_loaded() -> None:
    mgr = _manager()
    metadata = await _create(
        mgr, _spec(), language_mode="ml-en", language_mode_source="consultation"
    )

    expected = {
        "requested_mode": "ml-en",
        "source": "consultation",
        "applied_mode": "ml-en",
        "engine": "WHISPER_CPP",
        "provider": None,
        "params": {
            "language": None,
            "code_switching": False,
            "streaming_english_gloss": False,
            "primed": False,
        },
        "degraded": True,
        "reason": "whisper_cpp_pair_unprimed",
    }
    assert mgr.get_language_resolution("s1") == expected
    # Persisted on the session hash, so recovery keeps it.
    assert json.loads(metadata.language_resolution) == expected


@pytest.mark.asyncio
async def test_sarvam_code_mix_is_native_and_names_its_provider() -> None:
    mgr = _manager()
    await _create(mgr, _spec(primary=("SARVAM", "sarvam")), language_mode="ml-en")
    receipt = mgr.get_language_resolution("s1")
    assert receipt["engine"] == "SARVAM"
    assert receipt["provider"] == "sarvam"
    assert receipt["params"] == {
        "language": "ml",
        "code_switching": True,
        "streaming_english_gloss": False,
        "primed": False,
    }
    assert (receipt["degraded"], receipt["reason"]) == (False, None)


@pytest.mark.parametrize(
    ("overrides", "spec_mode", "expected"),
    [
        ({"language_mode": "en"}, "ml-en", ("en", "request")),
        ({"language": "en-US"}, "ml-en", ("en", "request")),
        ({"language_mode": "en", "language_mode_source": "agent"}, "ml-en", ("en", "agent")),
        ({}, "ml-en", ("ml-en", "agent")),
        ({}, None, ("auto", "default")),
    ],
)
@pytest.mark.asyncio
async def test_source_follows_who_declared_the_mode(
    overrides: dict[str, Any], spec_mode: str | None, expected: tuple[str, str]
) -> None:
    mgr = _manager()
    await _create(mgr, _spec(mode=spec_mode), **overrides)
    receipt = mgr.get_language_resolution("s1")
    assert (receipt["requested_mode"], receipt["source"]) == expected


@pytest.mark.asyncio
async def test_nobody_declared_a_mode_reads_as_default_auto() -> None:
    mgr = _manager()
    await _create(mgr, _spec(mode=None))
    receipt = mgr.get_language_resolution("s1")
    assert receipt["applied_mode"] == "auto"
    assert receipt["params"]["language"] is None
    assert (receipt["degraded"], receipt["reason"]) == (False, None)


@pytest.mark.asyncio
async def test_a_primary_that_cannot_serve_the_mode_hands_it_to_the_fallback_visibly() -> None:
    """D-4: served, never refused, while any engine in the chain can serve it — and
    the switch that caused it is on the receipt AND on the switch frame."""
    mgr = _manager()
    await _create(
        mgr,
        _spec(primary=("NEMO", None), fallback=("SARVAM", "sarvam")),
        language_mode="ml",
    )

    receipt = mgr.get_language_resolution("s1")
    assert receipt["engine"] == "SARVAM"
    assert (receipt["degraded"], receipt["reason"]) == (True, "fallback_engine_switch")
    mgr.publisher.publish_provider_switched.assert_awaited_once()
    frame = mgr.publisher.publish_provider_switched.await_args.kwargs
    assert json.loads(frame["language_resolution"]) == receipt


@pytest.mark.asyncio
async def test_no_engine_in_the_chain_serving_the_mode_is_still_the_422_error() -> None:
    mgr = _manager()
    with pytest.raises(LanguageModeUnsupportedError):
        await _create(
            mgr, _spec(primary=("NEMO", None), fallback=("NEMO", None)), language_mode="ml"
        )


# --- engine switch ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_runtime_switch_rebuilds_publishes_and_persists_the_receipt() -> None:
    mgr = _manager()
    await _create(mgr, _spec(), language_mode="ml-en", language_mode_source="consultation")
    session = MagicMock()
    session.metadata = SessionMetadata(session_id="s1", tenant_id="t1", pipeline_id=PRIMARY_KEY)
    mgr._sessions["s1"] = session

    with patch("stt.models.get_model_cache", return_value=_cache()):
        switched = await mgr._switch_controllers["s1"].switch_manual("fallback")

    assert switched is True
    receipt = mgr.get_language_resolution("s1")
    assert receipt["engine"] == "FASTER_WHISPER"
    assert receipt["source"] == "consultation"
    assert (receipt["degraded"], receipt["reason"]) == (True, "gloss_translation_only")
    assert receipt["params"]["streaming_english_gloss"] is True

    frame = mgr.publisher.publish_provider_switched.await_args.kwargs
    assert frame["active"] == "fallback"
    assert json.loads(frame["language_resolution"]) == receipt
    assert json.loads(session.metadata.language_resolution) == receipt
    mgr._redis.hset.assert_any_await(
        "stt:session:s1", "language_resolution", frame["language_resolution"]
    )


# --- recovery ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recovery_keeps_who_declared_the_mode_and_rebuilds_the_receipt() -> None:
    mgr = _manager()
    persisted = {
        "requested_mode": "ml-en",
        "source": "consultation",
        "applied_mode": "ml-en",
        "engine": "WHISPER_CPP",
        "provider": None,
        "params": {
            "language": None,
            "code_switching": False,
            "streaming_english_gloss": False,
            "primed": False,
        },
        "degraded": True,
        "reason": "whisper_cpp_pair_unprimed",
    }
    meta = SessionMetadata(
        session_id="s1",
        tenant_id="t1",
        pipeline_id=PRIMARY_KEY,
        status=SessionStatus.ACTIVE,
        resolved_spec_json=json.dumps(_spec()),
        language_mode="ml-en",
        language_resolution=json.dumps(persisted),
    )
    mgr._redis = MagicMock()
    mgr._redis.scan = AsyncMock(return_value=(0, ["stt:session:s1"]))
    mgr._redis.hgetall = AsyncMock(return_value=dict(meta.to_redis_dict()))
    mgr._redis.exists = AsyncMock(return_value=0)

    with (
        patch("stt.streaming.session_manager.StreamSession") as session_cls,
        patch("stt.streaming.session_manager.IngestionConsumer") as consumer_cls,
        patch("stt.streaming.session_manager.ControlListener") as listener_cls,
        patch("stt.models.get_model_cache", return_value=_cache()),
    ):
        session_cls.return_value.force_persist = AsyncMock()
        consumer_cls.return_value.start = AsyncMock()
        listener_cls.return_value.start = AsyncMock()
        await SessionManager._recover_sessions(mgr)

    assert mgr.get_language_resolution("s1") == persisted
    recovered_meta = session_cls.call_args.kwargs["metadata"]
    assert json.loads(recovered_meta.language_resolution) == persisted


# --- wire pieces --------------------------------------------------------------------------


def test_session_metadata_round_trips_the_receipt() -> None:
    meta = SessionMetadata(
        session_id="s1", tenant_id="t1", pipeline_id="p", language_resolution='{"a":1}'
    )
    restored = SessionMetadata.from_redis_dict(dict(meta.to_redis_dict()))
    assert restored.language_resolution == '{"a":1}'
    bare = SessionMetadata(session_id="s1", tenant_id="t1", pipeline_id="p")
    assert "language_resolution" not in bare.to_redis_dict()
    assert SessionMetadata.from_redis_dict(bare.to_redis_dict()).language_resolution == ""


@pytest.mark.asyncio
async def test_provider_switched_entry_carries_the_receipt_only_when_given() -> None:
    redis = AsyncMock()
    redis.xadd = AsyncMock(return_value=b"1-0")
    publisher = ResultPublisher(redis=redis, session_id="s1", maxlen=100)

    await publisher.publish_provider_switched(
        from_pipeline="a", to_pipeline="b", reason="user", language_resolution='{"x":1}'
    )
    assert redis.xadd.await_args.args[1]["language_resolution"] == '{"x":1}'

    await publisher.publish_provider_switched(from_pipeline="a", to_pipeline="b", reason="user")
    assert "language_resolution" not in redis.xadd.await_args.args[1]


# --- the internal HTTP API ----------------------------------------------------------------


@pytest.fixture
def api() -> tuple[TestClient, AsyncMock]:
    clear_runtime()
    mgr = AsyncMock()
    mgr.get_voice_profile_seeded = MagicMock(return_value=False)
    mgr.get_switch_controller = MagicMock(return_value=None)
    receipt = {
        "requested_mode": "ml-en",
        "source": "consultation",
        "applied_mode": "ml-en",
        "engine": "SARVAM",
        "provider": "sarvam",
        "params": {
            "language": "ml",
            "code_switching": True,
            "streaming_english_gloss": False,
            "primed": False,
        },
        "degraded": False,
        "reason": None,
    }
    mgr.get_language_resolution = MagicMock(return_value=receipt)
    guard = MagicMock()
    guard.max_streams = 10
    guard.active_count = 1
    mgr.capacity_guard = guard
    session = MagicMock()
    session.session_id = "s1"
    session.pipeline_id = "p1"
    session.status = SessionStatus.ACTIVE
    mgr.create_session.return_value = session
    mgr.get_session = MagicMock(return_value=session)
    set_session_manager(mgr)
    app = FastAPI()
    app.include_router(router)
    yield TestClient(app), mgr
    clear_runtime()


def _body(**overrides: Any) -> dict[str, Any]:
    body = {"session_id": "s1", "tenant_id": "t1", "resolved_spec": _spec()}
    body.update(overrides)
    return body


def test_create_forwards_the_source_and_answers_the_receipt(
    api: tuple[TestClient, AsyncMock],
) -> None:
    client, mgr = api
    resp = client.post(
        "/internal/streaming/sessions",
        json=_body(language_mode="ml-en", language_mode_source="consultation"),
    )
    assert resp.status_code == 201
    assert mgr.create_session.await_args.kwargs["language_mode_source"] == "consultation"
    assert resp.json()["language_resolution"] == mgr.get_language_resolution.return_value


def test_status_answers_the_receipt_too(api: tuple[TestClient, AsyncMock]) -> None:
    client, mgr = api
    resp = client.get("/internal/streaming/sessions/s1")
    assert resp.status_code == 200
    assert resp.json()["language_resolution"]["engine"] == "SARVAM"


def test_an_unknown_source_is_rejected_at_the_boundary(
    api: tuple[TestClient, AsyncMock],
) -> None:
    client, _ = api
    resp = client.post(
        "/internal/streaming/sessions", json=_body(language_mode="en", language_mode_source="ui")
    )
    assert resp.status_code == 422
