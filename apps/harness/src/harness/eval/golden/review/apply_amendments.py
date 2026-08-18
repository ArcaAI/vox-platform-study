"""Turn clinician amendments into the AUTHORITATIVE reference ratings.

This is the documented path by which a doctor's judgement replaces the AI's. It is
deliberately mechanical and deliberately non-destructive:

* it reads `fixtures/<set>.json` plus an amendments file,
* it applies ONLY the dimensions a reviewer named,
* it flips every case the reviewer signed off to
  ``metadata.clinician_review_status = "reviewed"`` and records the reviewer + date and
  the amended dimensions on the case,
* it upgrades ``label_provenance`` to ``clinician-reviewed`` for amended/accepted cases,
* and it writes a **NEW version** to a **NEW file**. The reviewed input is never mutated
  in place, so a historical gate run stays interpretable against the exact set it scored.

Usage::

    python -m harness.eval.golden.review.apply_amendments \\
        --golden-set src/harness/eval/golden/fixtures/curated_v2.json \\
        --amendments src/harness/eval/golden/review/curated_v2_amendments.json \\
        --version    curated-v2.1.0 \\
        --output     src/harness/eval/golden/fixtures/curated_v2_1.json

Amendments file shape::

    {
      "reviewer": "Dr A. Example",
      "reviewed_at": "2026-09-01",
      "accept_all_unlisted": true,
      "amendments": [
        {"case_id": "cv2-s01-L2-fabrication",
         "ratings": {"accurate": 1},
         "note": "a single fabrication of a confirmed finding reads as 1 to me"}
      ]
    }

``accept_all_unlisted`` (default ``false``) records that the reviewer read the whole set
and accepted every case they did not list. When it is ``false``, only listed cases are
marked reviewed — the rest stay ``pending``, which is the honest state for a partial pass.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, cast

from harness.eval.models import PDSQI_BINARY_DIMENSIONS, PDSQI_LIKERT_DIMENSIONS, GoldenSet

_ALL_DIMS = frozenset(PDSQI_LIKERT_DIMENSIONS) | frozenset(PDSQI_BINARY_DIMENSIONS)


class AmendmentError(ValueError):
    """The amendments file does not apply cleanly to this golden set."""


def apply_amendments(golden: dict[str, Any], amendments: dict[str, Any], *, version: str) -> dict[str, Any]:
    """Return a NEW golden-set document with the reviewer's decisions applied."""
    reviewer = str(amendments.get("reviewer") or "").strip()
    reviewed_at = str(amendments.get("reviewed_at") or "").strip()
    if not reviewer or not reviewed_at:
        raise AmendmentError(
            "amendments must carry a non-empty 'reviewer' and 'reviewed_at' — an "
            "unattributed rating cannot be called clinician-reviewed."
        )
    accept_all = bool(amendments.get("accept_all_unlisted", False))

    by_id = {c["case_id"]: c for c in golden["cases"]}
    entries = amendments.get("amendments") or []
    unknown = [e["case_id"] for e in entries if e.get("case_id") not in by_id]
    if unknown:
        raise AmendmentError(f"amendments name case_ids absent from the golden set: {unknown}")

    out = json.loads(json.dumps(golden))  # deep copy
    out["version"] = version
    out_by_id = {c["case_id"]: c for c in out["cases"]}

    amended_ids: set[str] = set()
    for entry in entries:
        case = out_by_id[entry["case_id"]]
        ratings = entry.get("ratings") or {}
        bad = sorted(set(ratings) - _ALL_DIMS)
        if bad:
            raise AmendmentError(f"{entry['case_id']}: unknown PDSQI dimension(s) {bad}")
        case["clinician_pdsqi"].update(ratings)
        meta = case.setdefault("metadata", {})
        meta["clinician_review_status"] = "reviewed"
        meta["label_provenance"] = "clinician-reviewed"
        meta["clinician_reviewer"] = reviewer
        meta["clinician_reviewed_at"] = reviewed_at
        if ratings:
            meta["clinician_amended_dimensions"] = sorted(ratings)
        if entry.get("note"):
            meta["clinician_note"] = entry["note"]
        amended_ids.add(entry["case_id"])

    if accept_all:
        for case in out["cases"]:
            if case["case_id"] in amended_ids:
                continue
            meta = case.setdefault("metadata", {})
            meta["clinician_review_status"] = "reviewed"
            meta["label_provenance"] = "clinician-reviewed"
            meta["clinician_reviewer"] = reviewer
            meta["clinician_reviewed_at"] = reviewed_at

    reviewed = sum(
        1 for c in out["cases"] if (c.get("metadata") or {}).get("clinician_review_status") == "reviewed"
    )
    out["description"] = (
        f"{out['description']} "
        f"[{version}] Clinician review applied {reviewed_at} by {reviewer}: "
        f"{len(amended_ids)} case(s) amended, {reviewed}/{len(out['cases'])} case(s) now "
        "clinician-reviewed. Ratings on reviewed cases are AUTHORITATIVE (clinician-reviewed); "
        "any case still marked 'pending' remains AI-authored and must not be presented as a "
        "clinician rating."
    )

    # Fail loudly if the amended document is no longer a valid golden set.
    GoldenSet.model_validate(out)
    return cast("dict[str, Any]", out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m harness.eval.golden.review.apply_amendments")
    parser.add_argument("--golden-set", required=True)
    parser.add_argument("--amendments", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    golden = json.loads(Path(args.golden_set).read_text(encoding="utf-8"))
    amendments = json.loads(Path(args.amendments).read_text(encoding="utf-8"))
    if Path(args.output).resolve() == Path(args.golden_set).resolve():
        raise AmendmentError("refusing to overwrite the reviewed set in place — ship a new version")

    out = apply_amendments(golden, amendments, version=args.version)
    Path(args.output).write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {args.output} as {args.version}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
