"""TASK-935 — a session builds its pipeline from ITS OWN resolved spec.

Runtime keys are agent VERSION ids, so every session on one agent shares a key; the
specs behind that key differ whenever the model row changed between two resolves (an
admin adds ``decoding.hotwords``; a stale session recovered from Redis at startup).
``_load_pipeline_config`` used to return the FIRST registered bundle carrying the key,
so a stale sibling silently decided a new session's lexicon terms — the live cause of
the TASK-935 "ceftriaxone" miss surviving every STT restart.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from stt.streaming.session_manager import SessionManager


def _fixture() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


SPEC = _fixture()["platformDefault"]["expected"]
KEY = SPEC["runtimeKey"]


def _spec_with_hotwords(hotwords: list[str]) -> dict[str, Any]:
    spec = copy.deepcopy(SPEC)
    spec["instruction"]["hotwords"] = hotwords
    return spec


def _manager() -> MagicMock:
    mgr = MagicMock(spec=SessionManager)
    mgr._session_specs = {}
    return mgr


async def _load(mgr: MagicMock, **kw: Any) -> Any:
    return await SessionManager._load_pipeline_config(mgr, KEY, tenant_id="t1", **kw)


@pytest.mark.asyncio
async def test_a_session_gets_its_own_spec_not_a_stale_siblings_on_the_same_runtime_key() -> None:
    mgr = _manager()
    # A stale session registered FIRST (a recovered pre-hotword bundle) …
    SessionManager._register_resolved_spec(mgr, "stale-session", _spec_with_hotwords([]))
    # … and the requesting session, whose row now names a term.
    SessionManager._register_resolved_spec(mgr, "new-session", _spec_with_hotwords(["ceftriaxone"]))

    spec = await _load(mgr, session_id="new-session")

    assert spec.postprocessing.lexicon.terms == ["ceftriaxone"]
    assert spec.postprocessing.lexicon.active is True


@pytest.mark.asyncio
async def test_a_session_with_no_bundle_of_its_own_still_resolves_by_key() -> None:
    """Recovery paths look a key up before the session owns a bundle: the scan stays."""
    mgr = _manager()
    SessionManager._register_resolved_spec(mgr, "other-session", _spec_with_hotwords(["troponin"]))

    spec = await _load(mgr, session_id="session-without-a-bundle")

    assert spec.postprocessing.lexicon.terms == ["troponin"]
