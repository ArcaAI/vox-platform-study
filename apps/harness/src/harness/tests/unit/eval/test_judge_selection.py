"""DB-resident, fail-closed judge selection for the eval gate.

Offline: a fake ``asyncpg`` module is injected, so these never touch Postgres. What they
lock is the POSTURE, which is the part that matters — the eval gate must take its judge
provider/model from the database (owner decision D-B) and must refuse to run rather than
silently grade with an env-supplied model id.
"""

from __future__ import annotations

import sys
import types

import pytest

from harness.eval.config import JudgeProvider
from harness.eval.judge import selection as sel


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


def _install_fake_asyncpg(
    monkeypatch, conn: _FakeConn | None, *, connect_error: Exception | None = None
):
    module = types.ModuleType("asyncpg")

    async def connect(_dsn: str):
        if connect_error:
            raise connect_error
        return conn

    module.connect = connect  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "asyncpg", module)
    return module


def _row(provider: str = "lm-studio", model_id: str = "gemma-4-e4b-it-qat", slug: str = "lms-x"):
    return {"provider": provider, "model_id": model_id, "model_slug": slug}


async def test_resolves_the_system_tier(monkeypatch) -> None:
    conn = _FakeConn({("harness.judge", sel.SYSTEM_TENANT_ID): _row()})
    _install_fake_asyncpg(monkeypatch, conn)

    got = await sel.resolve_eval_judge_selection(dsn="postgresql://u@h/db")

    assert got.provider is JudgeProvider.OPENAI_COMPAT
    assert got.model == "gemma-4-e4b-it-qat"
    assert got.tier == "system"
    assert conn.closed is True


async def test_tenant_wins_over_system_and_system_is_the_only_fallback(monkeypatch) -> None:
    """Resolution order is tenant -> SYSTEM. Two tiers, never a customer tenant fallback."""
    tenant = "11111111-1111-1111-1111-111111111111"
    conn = _FakeConn(
        {
            ("harness.judge", tenant): _row(model_id="tenant-model"),
            ("harness.judge", sel.SYSTEM_TENANT_ID): _row(model_id="system-model"),
        }
    )
    _install_fake_asyncpg(monkeypatch, conn)

    got = await sel.resolve_eval_judge_selection(tenant_id=tenant, dsn="postgresql://u@h/db")
    assert (got.model, got.tier) == ("tenant-model", "tenant")

    # With NO tenant context the SYSTEM tier is the only one consulted.
    conn2 = _FakeConn({("harness.judge", sel.SYSTEM_TENANT_ID): _row(model_id="system-model")})
    _install_fake_asyncpg(monkeypatch, conn2)
    got2 = await sel.resolve_eval_judge_selection(dsn="postgresql://u@h/db")
    assert got2.tier == "system"
    assert [t for _, t in conn2.queries] == [sel.SYSTEM_TENANT_ID]


async def test_widens_to_system_only_on_absence(monkeypatch) -> None:
    tenant = "11111111-1111-1111-1111-111111111111"
    conn = _FakeConn({("harness.judge", sel.SYSTEM_TENANT_ID): _row(model_id="system-model")})
    _install_fake_asyncpg(monkeypatch, conn)

    got = await sel.resolve_eval_judge_selection(tenant_id=tenant, dsn="postgresql://u@h/db")
    assert (got.model, got.tier) == ("system-model", "system")
    assert [t for _, t in conn.queries] == [tenant, sel.SYSTEM_TENANT_ID]


async def test_fails_closed_when_no_selection_exists(monkeypatch) -> None:
    conn = _FakeConn({})
    _install_fake_asyncpg(monkeypatch, conn)
    with pytest.raises(sel.JudgeSelectionUnavailable, match="no enabled, ACTIVE harness.judge"):
        await sel.resolve_eval_judge_selection(dsn="postgresql://u@h/db")


async def test_fails_closed_on_unknown_provider(monkeypatch) -> None:
    conn = _FakeConn({("harness.judge", sel.SYSTEM_TENANT_ID): _row(provider="carrier-pigeon")})
    _install_fake_asyncpg(monkeypatch, conn)
    with pytest.raises(sel.JudgeSelectionUnavailable, match="carrier-pigeon"):
        await sel.resolve_eval_judge_selection(dsn="postgresql://u@h/db")


async def test_fails_closed_on_empty_model_id(monkeypatch) -> None:
    conn = _FakeConn({("harness.judge", sel.SYSTEM_TENANT_ID): _row(model_id="  ")})
    _install_fake_asyncpg(monkeypatch, conn)
    with pytest.raises(sel.JudgeSelectionUnavailable, match="empty"):
        await sel.resolve_eval_judge_selection(dsn="postgresql://u@h/db")


async def test_fails_closed_when_the_database_is_unreachable(monkeypatch) -> None:
    _install_fake_asyncpg(monkeypatch, None, connect_error=OSError("connection refused"))
    with pytest.raises(sel.JudgeSelectionUnavailable, match="could not reach the database"):
        await sel.resolve_eval_judge_selection(dsn="postgresql://u@h/db")


async def test_fails_closed_without_database_url(monkeypatch) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(sel.JudgeSelectionUnavailable, match="DATABASE_URL is not set"):
        await sel.resolve_eval_judge_selection()


def test_prisma_style_query_string_is_stripped_for_asyncpg() -> None:
    """asyncpg rejects `?schema=`/`?pgbouncer=`, which a Prisma DATABASE_URL carries."""
    assert (
        sel._asyncpg_dsn("postgresql://u:p@h:5432/hope?schema=core&pgbouncer=true")
        == "postgresql://u:p@h:5432/hope"
    )


def test_every_judge_transport_is_reachable_from_a_provider_key() -> None:
    """A provider the DB can name but no transport serves would be a silent dead end."""
    assert set(sel._PROVIDER_MAP.values()) == set(JudgeProvider)
