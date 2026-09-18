"""TASK-938 — a bare ``language`` declaration must survive the spec's backfill.

The admin console's Live Transcription screen declares a LANGUAGE (``language:
"en"``); the consultation playground declares a MODE (``languageMode: "en"``).
Only the second one ever worked, and the reason is one line in ``create_session``:
whenever the caller omitted ``language_mode`` it was backfilled from the AGENT's
own spec, so ``_session_language_modes`` was never empty and ``_load_asr_pipeline``
resolved that mode over the declared language on every agent-path session. The
seeded agent's mode is the ``ml-en`` PAIR, and a pair deliberately pins nothing —
so "English" decoded unpinned, whisper re-ran its own LID per decode window, and
the console showed Malayalam. Measured live 2026-09-09: two console sessions, both
logging ``ASR pipeline loaded for streaming session ... language=None``.

The documented precedence is unchanged and still right — a mode the CALLER
declared outranks a language. What was wrong is that a mode the SPEC supplied was
being treated as a declaration.

The TASK-891 tests that cover this chain seed ``_session_language_modes`` by hand
(they assert the resolution downstream of it), which is exactly why the defect
lived underneath them: these drive the real ``create_session`` instead.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt.streaming.session_manager import (
    SessionManager,
    _language_mode_for_declared_language,
)


def _fixture() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


SPEC = _fixture()["platformDefault"]["expected"]
PRIMARY_KEY = SPEC["runtimeKey"]


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
    ):
        mock_sess_cls.return_value.force_persist = AsyncMock()
        mock_ic.return_value.start = AsyncMock()
        mock_cl.return_value.start = AsyncMock()
        return await SessionManager.create_session(mgr, **kwargs), mock_sess_cls


# --- the promotion rule, on its own -------------------------------------------


def test_a_catalog_language_is_promoted_to_its_mode() -> None:
    assert _language_mode_for_declared_language("en") == "en"
    assert _language_mode_for_declared_language("ml") == "ml"
    assert _language_mode_for_declared_language("vi") == "vi"
    # `auto` is a catalog mode too: declaring it is a real choice (decode
    # unpinned) and must not silently fall through to the agent's pair.
    assert _language_mode_for_declared_language("auto") == "auto"


def test_a_non_catalog_or_absent_language_is_not_promoted() -> None:
    assert _language_mode_for_declared_language(None) is None
    assert _language_mode_for_declared_language("") is None
    # A real whisper language the closed catalog does not offer as a mode.
    assert _language_mode_for_declared_language("de") is None


def test_promotion_tolerates_the_casing_a_caller_sends() -> None:
    assert _language_mode_for_declared_language(" EN ") == "en"


# --- the same rule where it actually failed: create_session -------------------


@pytest.mark.asyncio
async def test_declared_language_is_not_overwritten_by_the_agents_pair() -> None:
    """THE REGRESSION. `language="en"` + the seeded `ml-en` agent."""
    mgr = _make_manager()
    await _create(mgr, language="en")
    assert mgr._session_language_modes["s1"] == "en"


@pytest.mark.asyncio
async def test_a_declared_mode_still_outranks_a_declared_language() -> None:
    """The documented precedence, unchanged: the MODE is the stronger statement."""
    mgr = _make_manager()
    await _create(mgr, language="en", language_mode="ml")
    assert mgr._session_language_modes["s1"] == "ml"


@pytest.mark.asyncio
async def test_declaring_nothing_still_leaves_the_agents_mode_in_charge() -> None:
    """TASK-891 OD-1 — no English default anywhere. Absence means the agent decides."""
    mgr = _make_manager()
    await _create(mgr)
    assert mgr._session_language_modes["s1"] == "ml-en"


@pytest.mark.asyncio
async def test_a_non_catalog_language_reaches_the_decoder_as_a_raw_pin() -> None:
    """No mode can express it, so no mode is set — which is what stops
    `_load_asr_pipeline` resolving the agent's pair over the raw override."""
    mgr = _make_manager()
    await _create(mgr, language="de")
    assert "s1" not in mgr._session_language_modes
    pipeline_config = mgr._assemble_session_runtime.await_args.kwargs["pipeline_config"]
    assert pipeline_config.inference.language == "de"
