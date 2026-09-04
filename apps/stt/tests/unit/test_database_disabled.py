"""TASK-861 — the read-only Postgres connection is OPTIONAL and OFF by default.

Selection arrives from the gateway as ``ResolvedAsrSpec``; the deprecated
readers that still exist for the window fail CLOSED (a typed error, never a
guessed engine) when the database is disabled, and they warn on every use.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from stt.core.database import connection
from stt.core.database.connection import DatabaseDisabledError
from stt.pipeline.config_reader import ModelRegistryReader, PipelineConfigReader


@pytest.fixture
def db_disabled():
    with patch.object(connection.settings, "database_enabled", False):
        yield


@pytest.fixture
def db_enabled():
    with patch.object(connection.settings, "database_enabled", True):
        yield


def test_database_is_off_by_default() -> None:
    from stt.core.config.settings import Settings

    assert Settings.model_fields["database_enabled"].default is False


async def test_initialize_database_is_a_no_op_when_disabled(db_disabled) -> None:
    with patch.object(
        connection, "_get_or_create_engine", side_effect=AssertionError("engine created")
    ):
        await connection.initialize_database()
    assert connection.engine_cache_size() == 0


async def test_get_db_session_fails_closed_when_disabled(db_disabled) -> None:
    with pytest.raises(DatabaseDisabledError, match="STT_DATABASE_ENABLED"):
        async with connection.get_db_session():
            pass


async def test_deprecated_pipeline_reader_warns_and_fails_closed(db_disabled) -> None:
    with pytest.warns(DeprecationWarning, match="TASK-861"):
        with pytest.raises(DatabaseDisabledError):
            await PipelineConfigReader().get_pipeline("any-id")


async def test_deprecated_model_reader_warns_and_fails_closed(db_disabled) -> None:
    with pytest.warns(DeprecationWarning, match="TASK-861"):
        with pytest.raises(DatabaseDisabledError):
            await ModelRegistryReader().get_model_by_slug("any-slug")
