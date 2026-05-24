"""Unit tests for `voice_profile_model` query helpers (TASK-296 M-6).

These tests verify the *signature contract* of the read-only helpers without
hitting a real database. We monkey-patch ``get_session`` to a no-op context
manager and assert the helpers accept the new optional ``tenant_id`` kwarg
and do NOT crash. (Full tenant-scoped SQL coverage is deferred until the
master roadmap P2-5 migration adds a ``tenantId`` column on
``UserVoiceProfile``.)
"""

from __future__ import annotations

import inspect
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt_v2.core.database import voice_profile_model


@asynccontextmanager
async def _fake_session_factory():
    session = MagicMock()
    session.execute = AsyncMock(return_value=MagicMock(fetchone=MagicMock(return_value=None)))
    yield session


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
