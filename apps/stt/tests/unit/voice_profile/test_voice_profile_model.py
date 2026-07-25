"""Unit tests for `voice_profile_model` query helpers.

Signature-contract tests verify the read-only helpers accept the optional
``tenant_id`` kwarg, plus enforcement tests: the ``UserVoiceProfile`` lookups MUST filter by
``tenantId`` (cross-tenant read returns nothing) and MUST fail closed when no
tenant scope is supplied. The fake session emulates the database's WHERE
semantics so the cross-tenant no-leak behaviour is asserted, not just the SQL
text.
"""

from __future__ import annotations

import inspect
import logging
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt.core.database import voice_profile_model


@asynccontextmanager
async def _fake_session_factory():
    session = MagicMock()
    session.execute = AsyncMock(return_value=MagicMock(fetchone=MagicMock(return_value=None)))
    yield session


def _capturing_session_factory(captured: dict):
    """Fake session factory that records the SQL text + bind params."""

    @asynccontextmanager
    async def factory():
        session = MagicMock()

        async def _execute(sql, params):
            captured["sql"] = str(sql)
            captured["params"] = dict(params)
            result = MagicMock()
            result.fetchone = MagicMock(return_value=None)
            return result

        session.execute = AsyncMock(side_effect=_execute)
        yield session

    return factory


def _tenant_scoped_session_factory(rows_by_tenant: dict, entered: list):
    """Fake session emulating the DB's tenant-filter WHERE semantics.

    A row is only returned when the SQL carries the ``"tenantId" = :tenant_id``
    filter AND the bound tenant matches a row's tenant — i.e. what Postgres
    would do. This lets the tests assert the cross-tenant no-leak behaviour.
    """

    @asynccontextmanager
    async def factory():
        entered.append(True)
        session = MagicMock()

        async def _execute(sql, params):
            row = None
            if '"tenantId" = :tenant_id' in str(sql):
                row = rows_by_tenant.get(params.get("tenant_id"))
            result = MagicMock()
            result.fetchone = MagicMock(return_value=row)
            return result

        session.execute = AsyncMock(side_effect=_execute)
        yield session

    return factory


def test_get_voice_embedding_accepts_optional_tenant_id_kwarg():
    sig = inspect.signature(voice_profile_model.get_voice_embedding)
    assert "tenant_id" in sig.parameters
    param = sig.parameters["tenant_id"]
    assert param.default is None


def test_get_voice_profile_metadata_exists_with_tenant_id_param():
    fn = getattr(voice_profile_model, "get_voice_profile_metadata", None)
    assert fn is not None, "get_voice_profile_metadata must be exported"
    sig = inspect.signature(fn)
    assert "user_id" in sig.parameters
    assert "tenant_id" in sig.parameters
    assert sig.parameters["tenant_id"].default is None


@pytest.mark.asyncio
async def test_get_voice_embedding_with_tenant_id_does_not_raise():
    with patch.object(voice_profile_model, "get_session", _fake_session_factory):
        result = await voice_profile_model.get_voice_embedding(
            "user-1", tenant_id="tenant-1"
        )
    assert result is None


@pytest.mark.asyncio
async def test_get_voice_profile_metadata_with_tenant_id_does_not_raise():
    with patch.object(voice_profile_model, "get_session", _fake_session_factory):
        result = await voice_profile_model.get_voice_profile_metadata(
            "user-1", tenant_id="tenant-1"
        )
    assert result is None


# ---------------------------------------------------------------------------
# Tenant scoping is ENFORCED
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_voice_embedding_sql_filters_by_tenant():
    """The embedding lookup binds tenant_id and filters on "tenantId"."""
    captured: dict = {}
    with patch.object(
        voice_profile_model, "get_session", _capturing_session_factory(captured)
    ):
        await voice_profile_model.get_voice_embedding("user-1", tenant_id="tenant-a")

    assert '"tenantId" = :tenant_id' in captured["sql"]
    assert captured["params"]["tenant_id"] == "tenant-a"
    assert captured["params"]["user_id"] == "user-1"


@pytest.mark.asyncio
async def test_get_voice_profile_metadata_sql_filters_by_tenant():
    """The metadata lookup binds tenant_id and filters on "tenantId"."""
    captured: dict = {}
    with patch.object(
        voice_profile_model, "get_session", _capturing_session_factory(captured)
    ):
        await voice_profile_model.get_voice_profile_metadata(
            "user-1", tenant_id="tenant-a"
        )

    assert '"tenantId" = :tenant_id' in captured["sql"]
    assert captured["params"]["tenant_id"] == "tenant-a"


@pytest.mark.asyncio
async def test_get_voice_embedding_cross_tenant_returns_none():
    """Cross-tenant no-leak: tenant-b never sees tenant-a's profile."""
    rows = {"tenant-a": ("[0.5,0.25]",)}
    entered: list = []
    with patch.object(
        voice_profile_model,
        "get_session",
        _tenant_scoped_session_factory(rows, entered),
    ):
        same_tenant = await voice_profile_model.get_voice_embedding(
            "user-1", tenant_id="tenant-a"
        )
        cross_tenant = await voice_profile_model.get_voice_embedding(
            "user-1", tenant_id="tenant-b"
        )

    assert same_tenant == [0.5, 0.25]
    assert cross_tenant is None


@pytest.mark.asyncio
async def test_get_voice_profile_metadata_cross_tenant_returns_none():
    """Cross-tenant no-leak for the metadata (profile_id/model_id) lookup."""
    rows = {"tenant-a": ("profile-1", "model-1")}
    entered: list = []
    with patch.object(
        voice_profile_model,
        "get_session",
        _tenant_scoped_session_factory(rows, entered),
    ):
        same_tenant = await voice_profile_model.get_voice_profile_metadata(
            "user-1", tenant_id="tenant-a"
        )
        cross_tenant = await voice_profile_model.get_voice_profile_metadata(
            "user-1", tenant_id="tenant-b"
        )

    assert same_tenant == {"profile_id": "profile-1", "model_id": "model-1"}
    assert cross_tenant is None


@pytest.mark.asyncio
async def test_get_voice_embedding_without_tenant_fails_closed():
    """Missing tenant scope -> no DB query at all, returns None."""
    entered: list = []
    with patch.object(
        voice_profile_model,
        "get_session",
        _tenant_scoped_session_factory({}, entered),
    ):
        result = await voice_profile_model.get_voice_embedding("user-1")

    assert result is None
    assert entered == []  # fail-closed BEFORE touching the database


@pytest.mark.asyncio
async def test_get_voice_profile_metadata_without_tenant_fails_closed():
    """Missing tenant scope -> no DB query at all, returns None."""
    entered: list = []
    with patch.object(
        voice_profile_model,
        "get_session",
        _tenant_scoped_session_factory({}, entered),
    ):
        result = await voice_profile_model.get_voice_profile_metadata("user-1")

    assert result is None
    assert entered == []


@pytest.mark.asyncio
async def test_lookup_failure_logs_contain_no_raw_identifiers(caplog):
    """DB-failure warnings must not leak the raw user id (PHI log hygiene)."""
    raw_user_id = "3f9d2c58-1111-2222-3333-friendly-uuid"

    @asynccontextmanager
    async def _exploding_session_factory():
        session = MagicMock()
        session.execute = AsyncMock(side_effect=RuntimeError("DB down"))
        yield session

    with (
        patch.object(voice_profile_model, "get_session", _exploding_session_factory),
        caplog.at_level(logging.DEBUG, logger="stt.core.database.voice_profile_model"),
    ):
        result = await voice_profile_model.get_voice_embedding(
            raw_user_id, tenant_id="tenant-a"
        )

    assert result is None
    assert len(caplog.records) > 0  # the failure IS logged...
    assert raw_user_id not in caplog.text  # ...without the raw identifier
