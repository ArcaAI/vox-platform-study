"""The runtime model enums stay aligned with the Prisma enums and the seed.

`AiModelFormat` lives in three places that must agree:

1. the Postgres ``core."AiModelFormat"`` enum — authored in ``enums.prisma``;
2. the runtime ``dto.AiModelFormat`` ``StrEnum`` — the formats the STT process
   actually executes (a deliberate SUBSET; catalog-only formats like MLX/GGUF/
   CLOUD_API are DB-valid but never reach this service);
3. the seed data — the concrete ``format`` rows that exist on day one.

The containment contract these tests lock:

    seed formats  ⊆  dto.AiModelFormat  ⊆  Prisma enum

TASK-1006 — the SQLAlchemy read-mirror that used to sit between (1) and (2) is gone
with the database layer; the gateway resolves every model into the
``ResolvedAsrSpec``, so the values this service meets are the ones the spec carries.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from stt.pipeline.dto import AiModelFormat, AiModelSource

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

#: The runtime ``AiModelSource`` is a deliberate SUPERSET of Prisma: ``KSERVE`` is
#: reserved for MLFlow Serve + KServe inference and has no Prisma counterpart.
AI_MODEL_SOURCE_KNOWN_EXTRAS = {"KSERVE"}

#: The runtime ``AiModelFormat`` is likewise a deliberate SUPERSET: ``vllm``
#: (TASK-1021, contract C-5) is an stt-side pseudo-format the `vllm` loader stamps on
#: ``LoadedModel.format``. A vLLM row keeps its artifact format (``SAFETENSOR``) and
#: selects the engine through ``libraryName``, so no AiModel row ever carries it.
AI_MODEL_FORMAT_KNOWN_EXTRAS = {"vllm"}


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


DTO_FORMATS = {member.value for member in AiModelFormat}


@requires_monorepo
def test_runtime_formats_are_db_valid() -> None:
    leaked = DTO_FORMATS - _prisma_enum_values("AiModelFormat") - AI_MODEL_FORMAT_KNOWN_EXTRAS
    assert not leaked, (
        "dto.AiModelFormat carries runtime formats the Prisma enum does not have "
        f"(no AiModel row can ever carry them): {sorted(leaked)}"
    )


@requires_monorepo
def test_sarvam_and_openai_are_present_everywhere() -> None:
    prisma = _prisma_enum_values("AiModelFormat")
    for value in ("SARVAM", "OPENAI"):
        assert value in prisma, f"{value} missing from the Prisma enum"
        assert value in DTO_FORMATS, f"{value} missing from dto.AiModelFormat"


def test_seed_formats_are_runtime_executable() -> None:
    seed = _seed_row_formats()
    assert seed, "no `format: AiModelFormat.X` seed rows found — parser or paths drifted"
    unrunnable = seed - DTO_FORMATS
    assert not unrunnable, (
        "seed declares day-1 models whose format the STT runtime does not execute "
        f"(dto.AiModelFormat) -> seeded-but-unusable provider: {sorted(unrunnable)}"
    )


@requires_monorepo
def test_runtime_model_source_is_the_prisma_enum_plus_known_extras() -> None:
    prisma = _prisma_enum_values("AiModelSource")
    runtime = {member.value for member in AiModelSource}
    assert prisma <= runtime
    assert runtime - prisma == AI_MODEL_SOURCE_KNOWN_EXTRAS
