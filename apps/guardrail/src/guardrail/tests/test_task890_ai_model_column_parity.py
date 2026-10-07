"""The resolver's ``AiModel`` reader may only name columns the schema still has.

TASK-890 dropped four ``AiModel`` columns (``localPath``, ``downloadStatus``,
``downloadedAt``, ``fileSizeMb``) and the ``AiModelDownloadStatus`` enum
(migration ``20260906101622_task_890_context_schema_byo_model_provenance``).
Guardrail's SQL resolver is the ONLY Python reader of this table on the
validate path, and a stale ``mapped_column`` there is not a lint error — it is
an ``UndefinedColumnError`` on every ``guardrail.validate`` resolve, which fails
the safety gate closed and 502s every guardrailed generation.

So this test reads the CURRENT column list out of the Prisma schema and asserts
the reader names nothing else.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from guardrail.core.tenant_config import AiModelRead

# apps/guardrail/src/guardrail/tests/<this file> → repo root
_REPO_ROOT = Path(__file__).resolve().parents[5]
_SCHEMA = _REPO_ROOT / "packages" / "database" / "src" / "prisma" / "db_main" / "ai-model.prisma"

_FIELD = re.compile(r"^\s{2}(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s+\S")
_MAP = re.compile(r'@map\("(?P<column>[^"]+)"\)')

#: Dropped by the TASK-890 migration; naming any of them again re-opens the bug.
DROPPED_COLUMNS = ("localPath", "downloadStatus", "downloadedAt", "fileSizeMb")


def _schema_columns() -> set[str]:
    """Column names of ``core."AiModel"`` as the committed Prisma schema declares them."""
    if not _SCHEMA.is_file():
        pytest.skip(f"Prisma schema not available at {_SCHEMA}")

    columns: set[str] = set()
    in_model = False
    for raw in _SCHEMA.read_text(encoding="utf-8").splitlines():
        if raw.startswith("model AiModel {"):
            in_model = True
            continue
        if in_model and raw.startswith("}"):
            break
        if not in_model:
            continue
        line = raw.split("//", 1)[0].rstrip()
        if not line.strip() or line.strip().startswith("@@"):
            continue
        match = _FIELD.match(line)
        if not match:
            continue
        mapped = _MAP.search(line)
        columns.add(mapped.group("column") if mapped else match.group("name"))
    return columns


class TestAiModelReaderColumnParity:
    def test_schema_parse_finds_the_table(self) -> None:
        columns = _schema_columns()

        assert {"id", "tenantId", "slug", "sourceUri", "_metadata"} <= columns

    def test_reader_names_only_columns_that_exist(self) -> None:
        columns = _schema_columns()

        named = {column.name for column in AiModelRead.__table__.columns}

        assert named <= columns, (
            "guardrail's AiModel reader selects columns the schema does not have: "
            f"{sorted(named - columns)}"
        )

    @pytest.mark.parametrize("column", DROPPED_COLUMNS)
    def test_dropped_columns_are_not_mapped(self, column: str) -> None:
        named = {c.name for c in AiModelRead.__table__.columns}

        assert column not in named


class TestTask1050JudgeColumns:
    """TASK-1050 W2a2: the judge runner needs `_metadata.judge` and `libraryName` per row.

    Without them on `GuardrailTenantConfig`, every safety lane resolves as
    `JUDGE_LANE_UNSUPPORTED` (no capability declaration) and a seq-cls/native row is served
    by the wrong loader.
    """

    def test_library_name_is_mapped_and_exists(self) -> None:
        columns = _schema_columns()
        named = {c.name for c in AiModelRead.__table__.columns}
        assert "libraryName" in named
        assert "libraryName" in columns

    @pytest.mark.asyncio
    async def test_resolve_carries_judge_metadata_and_library_name(self) -> None:
        from types import SimpleNamespace
        from typing import Any

        from guardrail.core.tenant_config import SYSTEM_TENANT_ID, TenantConfigResolver

        row = SimpleNamespace(
            default_tenant_id=SYSTEM_TENANT_ID,
            default_resource_status="ENABLED",
            default_enabled=True,
            config_json=None,
            model_tenant_id=SYSTEM_TENANT_ID,
            provider="nlp",
            source_uri="Qwen/Qwen3Guard-Gen-0.6B",
            meta_data={"judge": {"protocol": "qwen3guard_native", "lanes": ["injection_judge"]}},
            checksum=None,
            source=None,
            source_revision=None,
            library_name="transformers",
        )

        class _Session:
            async def __aenter__(self) -> Any:
                return self

            async def __aexit__(self, *_: Any) -> None:
                return None

            async def execute(self, _statement: Any) -> Any:
                return SimpleNamespace(all=lambda: [row])

        resolver = TenantConfigResolver(session_factory=_Session, cache_ttl_s=60)
        cfg = await resolver.resolve("tenant-a", "guardrail.judge.injection")
        assert cfg.judge == {"protocol": "qwen3guard_native", "lanes": ["injection_judge"]}
        assert cfg.library_name == "transformers"
