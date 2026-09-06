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
