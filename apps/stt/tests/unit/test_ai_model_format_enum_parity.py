"""`AiModelFormat` lives in FOUR places that must stay aligned, or streaming
session creation 500s with a SQLAlchemy ``LookupError`` while hydrating an
``AiModelRead`` row (the TASK-586 SARVAM/OPENAI regression):

1. the Postgres ``core."AiModelFormat"`` enum — authored in ``enums.prisma``;
2. the SQLAlchemy read-mirror ``AiModelFormatType`` in ``core/database/models.py``
   bound to ``AiModelRead.format`` — validates EVERY value read from the column;
3. the runtime ``dto.AiModelFormat`` ``StrEnum`` — the formats the STT process
   actually executes (a deliberate SUBSET; catalog-only formats like MLX/GGUF/
   CLOUD_API are DB-valid but raise a clear ValueError in ``config_reader``);
4. the seed data — the concrete ``format`` rows that exist on day one.

The containment contract these tests lock:

    seed formats  ⊆  dto.AiModelFormat  ⊆  AiModelFormatType (== Prisma enum)

- SQLAlchemy mirror **==** Prisma enum: any Prisma value the mirror lacks crashes
  hydration on that row (exactly the SARVAM bug); any extra is dead drift.
- dto **⊆** mirror: every runtime-executable format must be a legal DB value.
- seed **⊆** dto **⊆** mirror: every day-1 provider row is both hydratable AND
  executable — no seeded model can 500 or be unrunnable out of the box.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from stt.core.database.models import AiModelFormatType
from stt.pipeline.dto import AiModelFormat

REPO_ROOT = Path(__file__).resolve().parents[4]
ENUMS_PRISMA = REPO_ROOT / "packages/database/src/prisma/db_main/enums.prisma"
SEED_FILES = (
    REPO_ROOT / "packages/database/src/prisma/db_main/seed/ai-models/audio.ts",
    REPO_ROOT / "packages/database/src/prisma/db_main/seed/06-stt.ts",
)

# The cross-package Prisma schema / seed are present in a full monorepo checkout
# (the `test-stt` CI job) but not in a src-only packaging of the service.
requires_monorepo = pytest.mark.skipif(
    not ENUMS_PRISMA.exists(),
    reason="enums.prisma not reachable (src-only checkout); cross-package parity check skipped",
)


def _prisma_enum_values(name: str) -> set[str]:
    """Extract member names from an ``enum <name> { ... }`` block in enums.prisma."""
    text = ENUMS_PRISMA.read_text(encoding="utf-8")
    match = re.search(r"enum\s+" + re.escape(name) + r"\s*\{(.*?)\}", text, re.DOTALL)
    assert match, f"enum {name} not found in {ENUMS_PRISMA}"
    values: set[str] = set()
    for raw in match.group(1).splitlines():
        line = raw.strip()
        if not line or line.startswith("//") or line.startswith("@@"):
            continue
        values.add(line.split()[0])  # `MEMBER // trailing comment` -> `MEMBER`
    return values


def _seed_row_formats() -> set[str]:
    """Every ``format: AiModelFormat.X`` a seed row is created with."""
    formats: set[str] = set()
    for path in SEED_FILES:
        if not path.exists():
            continue
        formats |= set(
            re.findall(r"format:\s*AiModelFormat\.([A-Z_]+)", path.read_text(encoding="utf-8"))
        )
    return formats


SQLALCHEMY_VALUES = set(AiModelFormatType.enums)
DTO_VALUES = {member.value for member in AiModelFormat}


class TestSqlAlchemyMirrorMatchesPrisma:
    """The read-mirror must accept exactly what the DB column can hold."""

    @requires_monorepo
    def test_mirror_equals_prisma_enum(self) -> None:
        prisma = _prisma_enum_values("AiModelFormat")
        missing = prisma - SQLALCHEMY_VALUES
        extra = SQLALCHEMY_VALUES - prisma
        assert not missing, (
            "AiModelFormatType (core/database/models.py) is missing values the DB enum "
            f"has -> hydrating a row with one of these 500s: {sorted(missing)}"
        )
        assert not extra, (
            "AiModelFormatType has values absent from the Prisma enum (dead drift): "
            f"{sorted(extra)}"
        )


class TestRuntimeFormatsAreDbValid:
    def test_dto_is_subset_of_mirror(self) -> None:
        leaked = DTO_VALUES - SQLALCHEMY_VALUES
        assert not leaked, (
            "dto.AiModelFormat carries runtime formats that are not valid DB values "
            f"(cannot be read back from AiModelRead.format): {sorted(leaked)}"
        )

    def test_sarvam_and_openai_are_present_everywhere(self) -> None:
        # Direct regression anchor for the TASK-586 crash.
        for value in ("SARVAM", "OPENAI"):
            assert value in SQLALCHEMY_VALUES, f"{value} missing from SQLAlchemy mirror"
            assert value in DTO_VALUES, f"{value} missing from dto.AiModelFormat"


class TestDay1SeedProvidersAreUsable:
    """Every provider seeded for day one must both hydrate and execute."""

    def test_seed_formats_are_hydratable(self) -> None:
        seed = _seed_row_formats()
        assert seed, "no `format: AiModelFormat.X` seed rows found — parser or paths drifted"
        unhydratable = seed - SQLALCHEMY_VALUES
        assert not unhydratable, (
            "seed declares day-1 models whose format the SQLAlchemy mirror rejects "
            f"-> streaming session 500 on read: {sorted(unhydratable)}"
        )

    def test_seed_formats_are_runtime_executable(self) -> None:
        seed = _seed_row_formats()
        unrunnable = seed - DTO_VALUES
        assert not unrunnable, (
            "seed declares day-1 models whose format the STT runtime does not execute "
            f"(dto.AiModelFormat) -> seeded-but-unusable provider: {sorted(unrunnable)}"
        )
