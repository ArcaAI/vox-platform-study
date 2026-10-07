"""Read a seeded PII row's `labelTaxonomy` straight from the seed file.

The incumbents' label sets are configuration, not constants of this harness: reading the
seed keeps the evaluation on exactly the labels and default threshold production asks for.
"""

from __future__ import annotations

import re
from pathlib import Path

SEED_FILE = (
    Path(__file__).resolve().parents[4]
    / "packages/database/src/prisma/db_main/seed/ai-models/nlp.ts"
)


def seeded_row(slug: str, seed_file: Path = SEED_FILE) -> dict:
    """`{"labels": [...], "threshold": float, "sourceUri": str, "memorySizeMb": int}`."""
    source = seed_file.read_text()
    start = source.index(f"slug: '{slug}'")
    nxt = source.find("\n  {\n    id:", start)
    block = source[start : nxt if nxt != -1 else len(source)]
    tax = block[block.index("labelTaxonomy") :]
    body = tax[tax.index("labels: [") + len("labels: [") :]
    body = body[: body.index("]")]
    body = re.sub(r"//[^\n]*", "", body)
    labels = re.findall(r"'([a-z_]+)'", body)
    threshold = re.search(r"threshold:\s*([0-9.]+)", tax)
    uri = re.search(r"sourceUri:\s*'([^']+)'", block)
    mem = re.search(r"memorySizeMb:\s*(\d+)", block)
    if not labels or threshold is None or uri is None:
        raise ValueError(f"could not read the seeded taxonomy of {slug}")
    return {
        "labels": labels,
        "threshold": float(threshold.group(1)),
        "sourceUri": uri.group(1),
        "memorySizeMb": int(mem.group(1)) if mem else None,
    }
