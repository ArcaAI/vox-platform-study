"""TASK-980 — a session persisted before the Sortformer retirement is SKIPPED on recovery.

A worker that crashed while running a spec whose ``audioFrontEnd.diarization.backend`` named
the now-retired backend leaves that spec in the session's Redis hash. After the retirement the
narrowed wire ``Literal`` rejects it, and crash recovery must read that as "not recovered, with
a logged reason" — never a crash of the sweep, never a session silently rebuilt on embedding
diarization. Concretely, for the invalid session: no capacity slot, no runtime assembly, no
bundle left registered under its id, and a warning naming the session; the sweep goes on to
recover the healthy session beside it.

The deploy order in the ticket (gateway first, drain, then STT) makes this path rare; this test
is what makes it safe.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt.streaming.schemas import SessionMetadata, SessionStatus
from stt.streaming.session_manager import SessionManager


def _platform_default_spec() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            fixture = json.loads(candidate.read_text(encoding="utf-8"))
            return copy.deepcopy(fixture["platformDefault"]["expected"])
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


def _meta(session_id: str, spec: dict[str, Any]) -> dict[str, str]:
    return dict(
        SessionMetadata(
            session_id=session_id,
            tenant_id="t1",
            pipeline_id=spec["runtimeKey"],
            status=SessionStatus.ACTIVE,
            resolved_spec_json=json.dumps(spec),
        ).to_redis_dict()
    )


@pytest.mark.asyncio
async def test_recovery_skips_a_persisted_spec_that_names_the_retired_backend() -> None:
    healthy = _platform_default_spec()
    retired = _platform_default_spec()
    retired["audioFrontEnd"]["diarization"]["backend"] = "sortformer"

    hashes = {
        "stt:session:s-retired": _meta("s-retired", retired),
        "stt:session:s-healthy": _meta("s-healthy", healthy),
    }

    mgr = MagicMock(spec=SessionManager)
    mgr._register_resolved_spec = SessionManager._register_resolved_spec.__get__(mgr)
    mgr._session_specs = {}
    mgr._session_language_modes = {}
    mgr._redis = MagicMock()
    mgr._redis.scan = AsyncMock(return_value=(0, list(hashes)))
    mgr._redis.hgetall = AsyncMock(side_effect=lambda key: hashes[key])
    mgr._redis.exists = AsyncMock(return_value=0)
    mgr._worker_id = "w1"
    mgr._capacity_guard = MagicMock()
    mgr._capacity_guard.try_acquire = AsyncMock(return_value=True)
    mgr._load_pipeline_config = AsyncMock(return_value=MagicMock())
    mgr._assemble_session_runtime = AsyncMock(return_value=MagicMock())
    mgr._register_inference_runtime = MagicMock()
    mgr._make_frame_handler = MagicMock(return_value=lambda x: None)
    mgr._make_batch_handler = MagicMock(return_value=lambda x: None)
    mgr._make_control_handler = MagicMock(return_value=lambda x: None)
    mgr._make_commit_policy = MagicMock(return_value=None)
    mgr._resolve_dual_capture = MagicMock(return_value=False)
    mgr._sessions, mgr._consumers, mgr._control_listeners = {}, {}, {}
    mgr._publishers, mgr._preprocessors, mgr._inference_workers = {}, {}, {}
    mgr._dual_capture, mgr._commit_policies = {}, {}
    mgr.remove_session = AsyncMock()

    with (
        patch("stt.streaming.session_manager.logger") as logger,
        patch("stt.streaming.session_manager.StreamSession") as session_cls,
        patch("stt.streaming.session_manager.IngestionConsumer") as consumer_cls,
        patch("stt.streaming.session_manager.ControlListener") as listener_cls,
    ):
        session_cls.return_value.force_persist = AsyncMock()
        consumer_cls.return_value.start = AsyncMock()
        listener_cls.return_value.start = AsyncMock()
        # Must not raise: one bad persisted spec never takes the sweep down.
        await SessionManager._recover_sessions(mgr)

    # The healthy session beside it is still recovered — the sweep continued.
    assert set(mgr._sessions) == {"s-healthy"}
    assembled = [c.kwargs["session_id"] for c in mgr._assemble_session_runtime.await_args_list]
    assert assembled == ["s-healthy"]
    acquired = [c.args[0] for c in mgr._capacity_guard.try_acquire.await_args_list]
    assert acquired == ["s-healthy"]

    # The retired one is "not recovered": nothing registered, nothing torn down.
    assert "s-retired" not in mgr._session_specs
    assert "s-retired" not in mgr._session_language_modes
    mgr.remove_session.assert_not_awaited()

    # …and the reason is logged against the session, naming the offending key.
    skipped = [
        c
        for c in logger.warning.call_args_list
        if c.args and c.args[0] == "Cannot recover session — persisted resolved spec is invalid"
    ]
    assert len(skipped) == 1
    assert skipped[0].kwargs["session_id"] == "s-retired"
    assert "backend" in skipped[0].kwargs["error"]
