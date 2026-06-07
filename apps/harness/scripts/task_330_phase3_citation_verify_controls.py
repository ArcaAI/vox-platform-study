"""TASK-330 Phase 3 — citation_verify positive/negative controls (REAL sensor + judge).

The full live driver (task_330_phase3_cite_verify_check.py) proves the cite->parse
machinery end to end, but its score is confounded by the Phase-1 deterministic
provenance builder making ONE claim per NER entity (the live NLP returns per-token
spans) plus SECTION-level citation attribution — so a single stray marker pulls in
unsupported patient-specific token-fragments and the judge (correctly) flags them.

This script isolates the CitationVerifySensor's verdict path with WELL-FORMED cited
claims (the kind a sentence-level claim builder would produce), proving both:
  * POSITIVE: claims genuinely entailed by the cited chunk  -> supported -> PASS
  * MIXED:    supported + unsupported claims cited to the same chunk -> flagged

Premise (the cited chunk text) is pulled LIVE from the seeded tenant-A hypertension
chunk; the judge is the REAL calibrated runtime judge (LM Studio google/gemma-4-e4b).

Run:
  PYTHONPATH=apps/harness/src conda run -n arcaenv \
    python apps/harness/scripts/task_330_phase3_citation_verify_controls.py
"""

from __future__ import annotations

import asyncio
import json

from harness.core.config import get_settings
from harness.sensors.base import SensorContext
from harness.sensors.config import SensorThresholds
from harness.sensors.inferential import CitationVerifySensor
from harness.temporal.activities import _build_runtime_judge, _hybrid_retriever

TENANT_A = "50000000-0000-0000-0000-000000000000"
CHUNK_A = "ad1bd3fc-bb10-52d5-b3c5-adb8c5360ae5"

# Well-formed claims that ARE entailed by the institutional hypertension protocol.
SUPPORTED = [
    "The recommended blood pressure target for most adults is below 130/80 mmHg.",
    "A first-line antihypertensive option is an ACE inhibitor such as lisinopril.",
    "Serum electrolytes and kidney function should be checked within 2 to 4 weeks "
    "of starting an ACE inhibitor.",
    "Lifestyle measures include the DASH dietary pattern and sodium restriction.",
]

# Claims that the hypertension protocol does NOT support (must be flagged).
UNSUPPORTED = [
    "The patient's home blood pressure averaged 148/92 over the last two weeks.",
    "Start metformin 500 mg twice daily for glycemic control.",
]


def _map(claims: list[tuple[str, str]]) -> dict:
    return {
        "claims": [
            {
                "id": f"claim-{i + 1}",
                "text": text,
                "section": "P",
                "status": "verified",
                "evidence": [],
                "entityRefs": [],
                "knowledgeChunkIds": [CHUNK_A],
            }
            for i, (text, _kind) in enumerate(claims)
        ]
    }


async def _run(label: str, claims: list[tuple[str, str]], premise: str, judge) -> None:
    ctx = SensorContext(citations_map=_map(claims), knowledge_chunks={CHUNK_A: premise})
    sensor = CitationVerifySensor(threshold=SensorThresholds().citation_verify_threshold)
    r = await sensor.arun(ctx, judge=judge)
    print(f"\n=== {label} ===")
    for c in _map(claims)["claims"]:
        kind = next(k for t, k in claims if t == c["text"])
        print(f"  [{kind:11}] {c['text'][:78]}")
    print(f"  -> score={round(r.score, 4)} passed={r.passed} degraded={r.degraded} "
          f"threshold={SensorThresholds().citation_verify_threshold}")
    print(f"  -> details={json.dumps(r.details, ensure_ascii=False)}")


async def main() -> None:
    settings = get_settings()
    # Pull the real cited-chunk text (the premise) live from Qdrant via the retriever.
    res = await _hybrid_retriever(settings).retrieve(
        query="hypertension blood pressure target first-line agents monitoring", tenant_id=TENANT_A
    )
    premise = next((c.text for c in res.chunks if c.chunk_id == CHUNK_A), "")
    print(f"premise(cited chunk) chars={len(premise)} from chunk {CHUNK_A}")
    if not premise:
        print("could not load chunk text; aborting")
        return

    judge = _build_runtime_judge()

    # POSITIVE control: every cited claim is supported -> PASS (score 1.0).
    await _run(
        "POSITIVE control (all cited claims supported)",
        [(t, "SUPPORTED") for t in SUPPORTED],
        premise,
        judge,
    )

    # MIXED control: 2 supported + 2 unsupported -> flags the unsupported (score 0.5).
    mixed = [(SUPPORTED[0], "SUPPORTED"), (SUPPORTED[1], "SUPPORTED")] + [
        (t, "UNSUPPORTED") for t in UNSUPPORTED
    ]
    await _run("MIXED control (2 supported + 2 unsupported)", mixed, premise, judge)


if __name__ == "__main__":
    asyncio.run(main())
