"""TASK-861 — a streaming session assembled from a gateway-resolved ``ResolvedAsrSpec``.

``create_session(resolved_spec=...)`` builds the engine chain from the spec and
reads NOTHING from Postgres: the pipeline reader and the model reader are patched
to raise, so any DB read fails the test loudly.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt.pipeline.dto import AiModelFormat
from stt.streaming.session_manager import SessionManager, _spec_model_config_of


def _fixture() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


SPEC = _fixture()["platformDefault"]["expected"]
PRIMARY_KEY = SPEC["runtimeKey"]
FALLBACK_KEY = SPEC["fallback"]["spec"]["runtimeKey"]


def _boom(*_a: Any, **_k: Any) -> Any:
    raise AssertionError("apps/stt read the database on the agent path")


def _make_manager() -> MagicMock:
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
    ):
        setattr(mgr, name, {})
    # TASK-985 L-SESSION — instance attrs created in `__init__`, so a
    # `MagicMock(spec=SessionManager)` (which specs off the CLASS) does not
    # carry them. `_creating` holds the ids of sessions mid-creation so the
    # capacity reconciler cannot release a slot during a cold model load;
    # `_empty_decode_streaks` is M-24's empty-with-speech failover counter,
    # cleared by the engine-switch `_apply`.
    mgr._creating = set()
    mgr._empty_decode_streaks = {}
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
    mgr.remove_session = AsyncMock()
    type(mgr).active_session_count = 1
    # REAL spec plumbing + switch-controller factory; heavy assembly mocked.
    mgr._make_switch_controller = lambda **kw: SessionManager._make_switch_controller(mgr, **kw)
    mgr._load_pipeline_config = lambda *a, **k: SessionManager._load_pipeline_config(mgr, *a, **k)
    mgr._register_resolved_spec = lambda *a, **k: SessionManager._register_resolved_spec(
        mgr, *a, **k
    )
    mgr._assemble_session_runtime = AsyncMock(return_value=MagicMock())
    return mgr


async def _create(mgr: MagicMock, **overrides: Any) -> Any:
    kwargs: dict[str, Any] = {
        "session_id": "s1",
        "tenant_id": "t1",
        "pipeline_id": PRIMARY_KEY,
        "resolved_spec": SPEC,
    }
    kwargs.update(overrides)
    with (
        patch("stt.streaming.session_manager.StreamSession") as mock_sess_cls,
        patch("stt.streaming.session_manager.IngestionConsumer") as mock_ic,
        patch("stt.streaming.session_manager.ControlListener") as mock_cl,
        patch("stt.pipeline.config_reader.get_pipeline_reader", _boom),
        patch("stt.pipeline.config_reader.get_model_reader", _boom),
    ):
        mock_sess_cls.return_value.force_persist = AsyncMock()
        mock_ic.return_value.start = AsyncMock()
        mock_cl.return_value.start = AsyncMock()
        result = await SessionManager.create_session(mgr, **kwargs)
        return result, mock_sess_cls


@pytest.mark.asyncio
async def test_session_assembles_from_the_spec_without_a_database_read() -> None:
    mgr = _make_manager()
    await _create(mgr)

    mgr._assemble_session_runtime.assert_awaited_once()
    pipeline_config = mgr._assemble_session_runtime.await_args.kwargs["pipeline_config"]
    assert pipeline_config.models.asr.slug == "arcaai-whisper-large-ml-en-gguf"
    assert pipeline_config.models.vad.slug == "silero-vad"
    assert mgr._assemble_session_runtime.await_args.kwargs["active_pipeline_id"] == PRIMARY_KEY


@pytest.mark.asyncio
async def test_spec_fallback_and_governance_reach_the_switch_controller() -> None:
    mgr = _make_manager()
    await _create(mgr)

    ctrl = mgr._switch_controllers["s1"]
    assert ctrl.active_engine == "primary"
    assert mgr._fallback_pipeline_ids["s1"] == FALLBACK_KEY
    # The spec's language mode becomes the session's unless the request names one.
    assert mgr._session_language_modes["s1"] == "ml-en"


@pytest.mark.asyncio
async def test_request_language_mode_wins_over_the_spec_default() -> None:
    mgr = _make_manager()
    await _create(mgr, language_mode="en")
    assert mgr._session_language_modes["s1"] == "en"


@pytest.mark.asyncio
async def test_fallback_pipeline_config_comes_from_the_spec_too() -> None:
    """The lazily-built fallback chain resolves from the same bundle — no DB."""
    mgr = _make_manager()
    await _create(mgr)
    with (
        patch("stt.pipeline.config_reader.get_pipeline_reader", _boom),
        patch("stt.pipeline.config_reader.get_model_reader", _boom),
    ):
        fb = await SessionManager._load_pipeline_config(mgr, FALLBACK_KEY, tenant_id="t1")
    assert fb.models.asr.slug == "faster-whisper-large-v3-turbo-int8"
    assert fb.models.vad.slug == "silero-vad"


@pytest.mark.asyncio
async def test_pre_resolved_model_configs_replace_the_model_reader() -> None:
    mgr = _make_manager()
    await _create(mgr)
    cfg = _spec_model_config_of(mgr, "s1", "arcaai-whisper-large-ml-en-gguf")
    assert cfg is not None
    assert cfg.format is AiModelFormat.WHISPER_CPP
    assert cfg.local_path == "/models/whisper-turbo-ml-en/ggml-model.gguf"
    assert _spec_model_config_of(mgr, "s1", "not-in-spec") is None
    assert _spec_model_config_of(mgr, "other-session", "silero-vad") is None


@pytest.mark.asyncio
async def test_each_session_gets_its_own_pipeline_spec_copy() -> None:
    """create_session mutates inference.language; a shared object would leak across sessions."""
    mgr = _make_manager()
    await _create(mgr, language="vi")
    first = mgr._assemble_session_runtime.await_args.kwargs["pipeline_config"]
    assert first.inference.language == "vi"
    again = await SessionManager._load_pipeline_config(mgr, PRIMARY_KEY, tenant_id="t1")
    assert again is not first
    assert again.inference.language == "ml"  # the spec's own value, untouched


@pytest.mark.asyncio
async def test_the_spec_is_persisted_on_the_session_metadata_for_crash_recovery() -> None:
    mgr = _make_manager()
    _, sess_cls = await _create(mgr)
    metadata = sess_cls.call_args.kwargs["metadata"]
    assert json.loads(metadata.resolved_spec_json)["runtimeKey"] == PRIMARY_KEY
    assert metadata.pipeline_id == PRIMARY_KEY


@pytest.mark.asyncio
async def test_a_request_key_that_disagrees_with_the_spec_is_overridden_by_the_spec() -> None:
    mgr = _make_manager()
    await _create(mgr, pipeline_id="stale-pipeline-id")
    assert mgr._assemble_session_runtime.await_args.kwargs["active_pipeline_id"] == PRIMARY_KEY


@pytest.mark.asyncio
async def test_legacy_pipeline_id_without_a_spec_still_goes_through_the_deprecated_reader() -> None:
    mgr = _make_manager()
    reader = MagicMock()
    reader.get_pipeline = AsyncMock(return_value=MagicMock())
    with patch("stt.pipeline.config_reader.get_pipeline_reader", return_value=reader):
        with (
            patch("stt.streaming.session_manager.StreamSession") as mock_sess_cls,
            patch("stt.streaming.session_manager.IngestionConsumer") as mock_ic,
            patch("stt.streaming.session_manager.ControlListener") as mock_cl,
        ):
            mock_sess_cls.return_value.force_persist = AsyncMock()
            mock_ic.return_value.start = AsyncMock()
            mock_cl.return_value.start = AsyncMock()
            await SessionManager.create_session(
                mgr, session_id="s2", tenant_id="t1", pipeline_id="legacy-pipe"
            )
    reader.get_pipeline.assert_awaited_once_with("legacy-pipe", tenant_id="t1")
