"""DB-resident, fail-closed SAFETY-guardian selection for the offline eval tools.

TASK-791 W7 handoff (TASK-792 owns ``apps/harness/src/harness/eval/**``).

``SafetyGuardConfig`` carries ``provider="lm-studio"`` and
``model="granite-guardian-4.1-8b"`` as pydantic-settings defaults — a hardcoded
engine + model id, which rule 00 §Configuration Principles forbids outright
("a `pydantic-settings` field with a real default is a hardcoded value wearing a
config costume"). TASK-791 deliberately left those defaults in place rather than
half-do the removal, because two of the three consumers are eval tools in this
package: ``inferential_corpus_eval`` and ``inferential_judge_parity``.

These tests lock the posture for those two consumers: the guardian
provider/model come from the ``guardrail.safety`` ``AiTaskDefault`` row,
tenant -> SYSTEM, and the tools refuse to run rather than silently screening
with an env- or literal-supplied model — exactly the stance
``judge/selection.py`` already takes for ``harness.judge``.

Offline: a fake ``asyncpg`` module is injected, so nothing here touches Postgres.
"""

from __future__ import annotations

import sys
import types

import pytest

from harness.eval import safety_selection as sfs
from harness.eval.judge.selection import JudgeSelectionUnavailable


class _FakeConn:
    def __init__(self, rows: dict[tuple[str, str], dict | None], *, fail: Exception | None = None):
        self._rows = rows
        self._fail = fail
        self.closed = False
        self.queries: list[tuple[str, str]] = []

    async def fetchrow(self, _sql: str, task_key: str, tenant_id: str):
        if self._fail:
            raise self._fail
        self.queries.append((task_key, tenant_id))
        return self._rows.get((task_key, tenant_id))

    async def close(self) -> None:
        self.closed = True


def _install_fake_asyncpg(monkeypatch, conn: _FakeConn | None, *, connect_error: Exception | None = None):
    module = types.ModuleType("asyncpg")

    async def connect(_dsn: str):
        if connect_error:
            raise connect_error
        return conn

    module.connect = connect  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "asyncpg", module)
    return module


def _row(provider: str = "lm-studio", model_id: str = "granite-guardian-4.1-8b", slug: str = "gg-41-8b"):
    return {"provider": provider, "model_id": model_id, "model_slug": slug}


SYSTEM = sfs.SYSTEM_TENANT_ID


async def test_resolves_the_safety_guardian_from_the_system_tier(monkeypatch) -> None:
    conn = _FakeConn({(sfs.EVAL_SAFETY_TASK_KEY, SYSTEM): _row()})
    _install_fake_asyncpg(monkeypatch, conn)

    got = await sfs.resolve_eval_safety_selection(dsn="postgresql://u@h/db")

    # The RAW provider string, not a judge-transport enum: SafetyGuardConfig
    # selects its engine by name.
    assert got.provider == "lm-studio"
    assert got.model == "granite-guardian-4.1-8b"
    assert got.tier == "system"
    assert conn.closed is True


async def test_reads_the_guardrail_safety_task_key(monkeypatch) -> None:
    """The guardian is a DIFFERENT selection from the LLM-as-judge."""
    conn = _FakeConn({(sfs.EVAL_SAFETY_TASK_KEY, SYSTEM): _row()})
    _install_fake_asyncpg(monkeypatch, conn)

    await sfs.resolve_eval_safety_selection(dsn="postgresql://u@h/db")

    assert sfs.EVAL_SAFETY_TASK_KEY == "guardrail.safety"
    assert conn.queries == [("guardrail.safety", SYSTEM)]


async def test_tenant_wins_and_system_is_the_only_fallback(monkeypatch) -> None:
    """Resolution order is tenant -> SYSTEM. Two tiers, never a customer fallback."""
    tenant = "11111111-1111-1111-1111-111111111111"
    conn = _FakeConn(
        {
            (sfs.EVAL_SAFETY_TASK_KEY, tenant): _row(provider="ollama", model_id="tenant-guardian"),
            (sfs.EVAL_SAFETY_TASK_KEY, SYSTEM): _row(model_id="system-guardian"),
        }
    )
    _install_fake_asyncpg(monkeypatch, conn)

    got = await sfs.resolve_eval_safety_selection(tenant_id=tenant, dsn="postgresql://u@h/db")

    assert got.model == "tenant-guardian"
    assert got.provider == "ollama"
    assert got.tier == "tenant"
    # The tenant answered, so SYSTEM must not even be queried.
    assert conn.queries == [(sfs.EVAL_SAFETY_TASK_KEY, tenant)]


async def test_fails_closed_when_no_selection_exists(monkeypatch) -> None:
    conn = _FakeConn({})
    _install_fake_asyncpg(monkeypatch, conn)

    with pytest.raises(JudgeSelectionUnavailable):
        await sfs.resolve_eval_safety_selection(dsn="postgresql://u@h/db")


async def test_fails_closed_when_database_url_is_unset(monkeypatch) -> None:
    """No env fallback. A tool that screens with a different guardian than the
    platform selects is worse than a tool that refuses to run."""
    monkeypatch.delenv("DATABASE_URL", raising=False)

    with pytest.raises(JudgeSelectionUnavailable):
        await sfs.resolve_eval_safety_selection()


async def test_fails_closed_when_the_model_id_is_empty(monkeypatch) -> None:
    conn = _FakeConn({(sfs.EVAL_SAFETY_TASK_KEY, SYSTEM): _row(model_id="")})
    _install_fake_asyncpg(monkeypatch, conn)

    with pytest.raises(JudgeSelectionUnavailable):
        await sfs.resolve_eval_safety_selection(dsn="postgresql://u@h/db")


async def test_resolved_config_overrides_the_hardcoded_defaults(monkeypatch) -> None:
    """The point of the exercise: the tools stop depending on the literals."""
    from harness.core.config import SafetyGuardConfig

    conn = _FakeConn({(sfs.EVAL_SAFETY_TASK_KEY, SYSTEM): _row(provider="vllm", model_id="resolved-guardian")})
    _install_fake_asyncpg(monkeypatch, conn)

    base = SafetyGuardConfig()
    resolved = await sfs.resolve_eval_safety_config(base, dsn="postgresql://u@h/db")

    assert resolved.provider == "vllm"
    assert resolved.model == "resolved-guardian"
    # Connection/tuning config is env's job and must survive untouched — the same
    # selection-vs-connection split judge/selection.py documents.
    assert resolved.base_url == base.base_url
    assert resolved.timeout_s == base.timeout_s
    assert resolved.harm_criteria == base.harm_criteria
    # The base object is not mutated in place.
    assert base.model == SafetyGuardConfig().model
