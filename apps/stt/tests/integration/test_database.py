"""Integration tests for database operations.

These tests use the tables created by SQLAlchemy models (via Base.metadata.create_all
in the db_engine fixture) rather than manually creating tables. This ensures the test
schema matches the real model definitions including enum types and constraints.

IMPORTANT: Use flush() (not commit()) so the db_session fixture can rollback all
writes on teardown, keeping the shared test DB clean for other test suites.
Use unique IDs (uuid4) to avoid conflicts with Prisma-seeded data.
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


@pytest.mark.integration
class TestDatabaseConnection:
    """Test database connection and basic operations."""

    @pytest.mark.asyncio
    async def test_connection(self, db_session: AsyncSession):
        """Test database connection is working."""
        result = await db_session.execute(text("SELECT 1"))
        row = result.scalar()

        assert row == 1

    @pytest.mark.asyncio
    async def test_create_schema(self, db_session: AsyncSession):
        """Test that schema is created."""
        result = await db_session.execute(
            text("SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'core'")
        )
        assert result is not None


@pytest.mark.integration
class TestAsrPipelineRead:
    """Test ASR Pipeline read operations."""

    @pytest.mark.asyncio
    async def test_insert_and_read_pipeline(self, db_session: AsyncSession):
        """Test inserting and reading pipeline."""
        now = datetime.now(UTC).replace(tzinfo=None)
        pid = f"intg-{uuid.uuid4().hex[:8]}"

        await db_session.execute(
            text("""
            INSERT INTO core."AsrPipeline" (
                id, "tenantId", name, slug, "configYaml",
                "resourceStatus", tags, "_version", "createdAt", "updatedAt"
            )
            VALUES (
                :pid, 't-1', 'Test Pipeline', :slug,
                'version: "1.0"
models:
  asr: whisper',
                'ENABLED', '{}', 1, :now, :now
            )
        """),
            {"pid": pid, "slug": f"test-pipeline-{pid}", "now": now},
        )
        await db_session.flush()

        result = await db_session.execute(
            text('SELECT id, name, slug FROM core."AsrPipeline" WHERE id = :id'), {"id": pid}
        )
        row = result.fetchone()

        assert row is not None
        assert row[0] == pid
        assert row[1] == "Test Pipeline"
        assert row[2] == f"test-pipeline-{pid}"


@pytest.mark.integration
class TestAiModelRead:
    """Test AI Model read operations."""

    @pytest.mark.asyncio
    async def test_insert_and_read_model(self, db_session: AsyncSession):
        """Test inserting and reading AI model."""
        now = datetime.now(UTC).replace(tzinfo=None)
        mid = f"intg-{uuid.uuid4().hex[:8]}"

        await db_session.execute(
            text("""
            INSERT INTO core."AiModel" (
                id, "tenantId", name, slug, category, "taskType", "modelType",
                source, "sourceUri", format,
                "resourceStatus", "downloadStatus", tags, "_version",
                "createdAt", "updatedAt"
            ) VALUES (
                :mid, 't-1', 'Whisper Large', :slug,
                'AUDIO', 'AUTOMATIC_SPEECH_RECOGNITION', 'BASE_MODEL',
                'HUGGINGFACE', 'openai/whisper-large-v3', 'SAFETENSOR',
                'ENABLED', 'NOT_DOWNLOADED', '{}', 1,
                :now, :now
            )
        """),
            {"mid": mid, "slug": f"whisper-large-{mid}", "now": now},
        )
        await db_session.flush()

        result = await db_session.execute(
            text('SELECT id, name, slug, source FROM core."AiModel" WHERE slug = :slug'),
            {"slug": f"whisper-large-{mid}"},
        )
        row = result.fetchone()

        assert row is not None
        assert row[0] == mid
        assert row[1] == "Whisper Large"
        assert row[3] == "HUGGINGFACE"
