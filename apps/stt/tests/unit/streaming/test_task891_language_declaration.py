"""TASK-891 A1/A2 — the end-user language DECLARATION must reach the decoder,
and its ABSENCE must leave the agent's code-switch mode untouched.

Owner decision OD-1: *"default language is empty (so the code-switch is always
enabled), to use a specific language, the SDK or end-user must declare the
language code!"* — so there is NO English default anywhere in this chain, and
Malayalam output on an undeclared session is correct behaviour.

What was never proven end to end, and is proven here, is the two halves of that
rule on the ONE engine the platform agent runs (`WHISPER_CPP`):

* a DECLARED mode (``language_mode="en"``) survives
  ``create_session`` → ``_session_language_modes`` → ``resolve_mode_for_engine``
  → ``InferenceConfig.language`` → ``pywhispercpp.Model.transcribe(language=…)``;
* an ABSENT declaration leaves the agent's ``ml-en`` pair unpinned
  (``language=None``) with no code-switch flag and no translate gloss — and
  survives a worker restart, which it did not before (the declaration lived only
  in a process-local dict, so crash recovery silently re-pinned the pair's
  PRIMARY subtag ``ml``).

The spec under test is the committed contract fixture, which mirrors the seeded
platform agent exactly: WHISPER_CPP, ``ml-en``, ``maxDecodeWindowSec 7``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat
from stt.streaming.schemas import SessionMetadata, SessionStatus
from stt.streaming.session_manager import SessionManager


def _fixture() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


SPEC = _fixture()["platformDefault"]["expected"]
PRIMARY_KEY = SPEC["runtimeKey"]


class _CapturingWhisper:
    """Fake ``pywhispercpp.model.Model`` recording each transcribe's kwargs."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def transcribe(self, audio: np.ndarray, **kwargs: object) -> list:
        self.calls.append(kwargs)
        return []


def _manager() -> MagicMock:
    mgr = MagicMock(spec=SessionManager)
    for name in (
        "_session_specs",
        "_session_language_modes",
        "_session_asr_formats",
        "_session_connections",
    ):
        setattr(mgr, name, {})
    mgr._pending_want_word_timestamps = False
    mgr._warm_and_pin_pipeline_models = AsyncMock(return_value=[])
    mgr._session_pinned_models = {}
    # REAL spec plumbing + the real whisper.cpp callable factory: this test is
    # about what actually reaches the binding, so nothing between the resolved
    # spec and `Model.transcribe` may be faked.
    for name in ("_register_resolved_spec", "_load_pipeline_config", "_make_whisper_cpp_callable"):
        setattr(mgr, name, getattr(SessionManager, name).__get__(mgr))
    mgr._make_asr_callable = lambda *a, **kw: SessionManager._make_asr_callable(mgr, *a, **kw)
    return mgr


async def _decode_kwargs(language_mode: str | None) -> dict[str, object]:
    """Run the declaration chain for *language_mode* and return the kwargs the
    pywhispercpp binding was actually called with."""
    mgr = _manager()
    bundle = SessionManager._register_resolved_spec(mgr, "s1", SPEC)
    pipeline_config = await SessionManager._load_pipeline_config(mgr, bundle.runtime_key)
    if language_mode:
        mgr._session_language_modes["s1"] = language_mode
    else:
        # No declaration ⇒ create_session falls back to the agent's own mode.
        mgr._session_language_modes["s1"] = bundle.spec.decoding.language_mode

    whisper = _CapturingWhisper()
    loaded = LoadedModel(
        model_id="m1",
        model_slug=SPEC["models"]["asr"]["slug"],
        model=whisper,
        format=AiModelFormat.WHISPER_CPP,
        device="cpu",
        extra={"model_path": "/weights/model.gguf", "num_threads": 4},
    )
    cache = MagicMock()
    cache.get_or_load_from_ref = AsyncMock(return_value=loaded)
    cache.pin = AsyncMock()

    with patch("stt.models.get_model_cache", return_value=cache):
        run, prompt = await SessionManager._load_asr_pipeline(mgr, pipeline_config, "s1")

    await run(np.zeros(16000, dtype=np.float32), 16000, prompt=prompt)
    assert whisper.calls, "the adapter never reached the pywhispercpp binding"
    return whisper.calls[0]


@pytest.mark.parametrize("declared", ["en", "ml", "vi"])
@pytest.mark.asyncio
async def test_a1_declared_language_reaches_the_pywhispercpp_decoder(declared: str) -> None:
    """A DECLARED single language is pinned on the decode call — the whole point
    of OD-1's "the SDK or end-user must declare the language code"."""
    kwargs = await _decode_kwargs(declared)
    assert kwargs["language"] == declared


@pytest.mark.asyncio
async def test_a1_absent_declaration_leaves_the_agents_code_switch_untouched() -> None:
    """OD-1's regression guard: with nothing declared, the agent's ``ml-en`` pair
    reaches the decoder UNPINNED (``language=None``). Pinning the pair's primary
    subtag would bias the English spans toward the Malayalam script."""
    kwargs = await _decode_kwargs(None)
    assert kwargs["language"] is None


@pytest.mark.asyncio
async def test_a1_declaration_does_not_rewrite_the_agents_prompt_channel() -> None:
    """The agent's ``instruction.initialPrompt`` is the ONE prompt channel and a
    language declaration must not displace it."""
    kwargs = await _decode_kwargs("en")
    assert SPEC["instruction"]["initialPrompt"] in str(kwargs["initial_prompt"])


# --- A2: the declaration must survive a worker restart -----------------------


def test_a2_session_metadata_round_trips_the_declared_language_mode() -> None:
    """The declaration is session state, so it belongs on the persisted session
    metadata — not only in a process-local dict."""
    meta = SessionMetadata(
        session_id="s1",
        tenant_id="t1",
        pipeline_id=PRIMARY_KEY,
        language_mode="en",
    )
    restored = SessionMetadata.from_redis_dict(dict(meta.to_redis_dict()))
    assert restored.language_mode == "en"


@pytest.mark.asyncio
async def test_a2_recovery_restores_the_declared_language_mode() -> None:
    """After a worker restart the declared mode must still govern the decode.

    Before this ticket ``_session_language_modes`` was in-memory only, so a
    recovered ``ml-en`` session resolved NO mode and fell back to the spec's
    mapped primary subtag (``ml``) — silently turning a declared-English session
    into a Malayalam-pinned one."""
    mgr = _manager()
    bundle = SessionManager._register_resolved_spec(mgr, "probe", SPEC)
    pipeline_config = await SessionManager._load_pipeline_config(mgr, bundle.runtime_key)
    mgr._session_specs.clear()

    meta = SessionMetadata(
        session_id="s1",
        tenant_id="t1",
        pipeline_id=PRIMARY_KEY,
        status=SessionStatus.ACTIVE,
        resolved_spec_json=json.dumps(SPEC),
        language_mode="en",
    )

    mgr._redis = MagicMock()
    mgr._redis.scan = AsyncMock(return_value=(0, ["stt:session:s1"]))
    mgr._redis.hgetall = AsyncMock(return_value=dict(meta.to_redis_dict()))
    mgr._redis.exists = AsyncMock(return_value=0)
    mgr._worker_id = "w1"
    mgr._capacity_guard = MagicMock()
    mgr._capacity_guard.try_acquire = AsyncMock(return_value=True)
    mgr._load_pipeline_config = AsyncMock(return_value=pipeline_config)
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
        patch("stt.streaming.session_manager.StreamSession") as session_cls,
        patch("stt.streaming.session_manager.IngestionConsumer") as consumer_cls,
        patch("stt.streaming.session_manager.ControlListener") as listener_cls,
    ):
        session_cls.return_value.force_persist = AsyncMock()
        consumer_cls.return_value.start = AsyncMock()
        listener_cls.return_value.start = AsyncMock()
        await SessionManager._recover_sessions(mgr)

    assert mgr._session_language_modes["s1"] == "en"


@pytest.mark.asyncio
async def test_a2_recovery_falls_back_to_the_agents_mode_when_nothing_declared() -> None:
    """Nothing declared ⇒ recovery restores the AGENT's mode from the persisted
    spec, so an ``ml-en`` session stays unpinned rather than re-pinning ``ml``."""
    mgr = _manager()
    meta = SessionMetadata(
        session_id="s1",
        tenant_id="t1",
        pipeline_id=PRIMARY_KEY,
        status=SessionStatus.ACTIVE,
        resolved_spec_json=json.dumps(SPEC),
    )

    mgr._redis = MagicMock()
    mgr._redis.scan = AsyncMock(return_value=(0, ["stt:session:s1"]))
    mgr._redis.hgetall = AsyncMock(return_value=dict(meta.to_redis_dict()))
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
        patch("stt.streaming.session_manager.StreamSession") as session_cls,
        patch("stt.streaming.session_manager.IngestionConsumer") as consumer_cls,
        patch("stt.streaming.session_manager.ControlListener") as listener_cls,
    ):
        session_cls.return_value.force_persist = AsyncMock()
        consumer_cls.return_value.start = AsyncMock()
        listener_cls.return_value.start = AsyncMock()
        await SessionManager._recover_sessions(mgr)

    assert mgr._session_language_modes["s1"] == "ml-en"
