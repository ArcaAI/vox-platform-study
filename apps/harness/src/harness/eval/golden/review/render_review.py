"""Render the clinician review artifact for a golden set.

Turns `fixtures/<set>.json` into ONE markdown document a clinician can work through
without reading JSON: per case, the source documents, the note under review, the seeded
error (if any), the proposed rating, and the rationale that produced it — followed by an
accept/amend block.

Usage::

    python -m harness.eval.golden.review.render_review \\
        --golden-set src/harness/eval/golden/fixtures/curated_v2.json \\
        --output      src/harness/eval/golden/review/curated_v2_review.md

The artifact is GENERATED, never hand-edited: amendments go into
`curated_v2_amendments.json` (see `apply_amendments.py`), so a reviewer's decisions are
machine-readable and a re-render never loses them.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from harness.eval.models import PDSQI_LIKERT_DIMENSIONS

_BINARY = ("abstraction", "voice_summ", "voice_note")

_HEADER = """# Clinician review — `{version}`

> **What you are reviewing.** Every rating below was produced by an AI applying the Epic
> PDSQI-9 grade descriptors under the labelling rules in
> [`../curated_v2_spec.md`](../curated_v2_spec.md) §3. **None of these are clinician
> ratings.** Your sign-off is what makes them authoritative.
>
> **How to review efficiently.** The ratings were produced by RULE, not case by case, so
> checking the seven rules in §3 of the spec covers all {n_cases} cases. Read the rules
> first; then spot-check cases, and record only where you DISAGREE.
>
> **The one decision that matters most** is spec §5 rule **R3**: a content error does not
> lower `citation`. It affects 8 cases by 3 points. Please answer that one explicitly.
>
> **Recording your decision.** For each case you want to change, add an entry to
> `curated_v2_amendments.json`:
>
> ```json
> {{
>   "reviewer": "<your name or initials>",
>   "reviewed_at": "<YYYY-MM-DD>",
>   "amendments": [
>     {{"case_id": "cv2-s01-L2-fabrication",
>      "ratings": {{"accurate": 1}},
>      "note": "why you changed it"}}
>   ]
> }}
> ```
>
> Only the dimensions you name are changed; everything else keeps the proposed value.
> Then run `apply_amendments.py`, which ships a NEW version (`curated-v2.1.0`) rather
> than mutating this one, so historical gate runs stay interpretable.

**Set**: `{version}` · **cases**: {n_cases} ({n_quality} quality / {n_calibration} calibration)
· **paired ratings**: {n_ratings} · **status**: {status}

---

## Contents

{toc}

---
"""


def _rating_table(rating: dict[str, Any]) -> str:
    head = "| " + " | ".join(PDSQI_LIKERT_DIMENSIONS) + " |"
    rule = "|" + "---|" * len(PDSQI_LIKERT_DIMENSIONS)
    vals = "| " + " | ".join(str(rating.get(d, "NA")) for d in PDSQI_LIKERT_DIMENSIONS) + " |"
    binaries = ", ".join(f"`{b}` = {rating.get(b)}" for b in _BINARY)
    return f"{head}\n{rule}\n{vals}\n\nBinary items: {binaries}"


def render(golden: dict[str, Any]) -> str:
    cases = golden["cases"]
    n_quality = sum(1 for c in cases if c.get("role") == "quality")
    n_ratings = sum(
        sum(1 for d in PDSQI_LIKERT_DIMENSIONS if (c.get("clinician_pdsqi") or {}).get(d) is not None)
        for c in cases
    )
    statuses = {(c.get("metadata") or {}).get("clinician_review_status", "pending") for c in cases}
    status = "PENDING CLINICIAN REVIEW" if statuses != {"reviewed"} else "reviewed"

    toc_lines = []
    body: list[str] = []
    for case in cases:
        meta = case.get("metadata") or {}
        cid = case["case_id"]
        anchor = cid.lower().replace(".", "")
        toc_lines.append(
            f"- [`{cid}`](#{anchor}) — {meta.get('level', '?')} · {meta.get('lane', '?')} · "
            f"{case.get('target_specialty', '?')} · split `{meta.get('split', '?')}`"
        )

        seeded = meta.get("seeded_errors") or []
        if seeded:
            seeded_md = "\n".join(
                f"- **`{e['class']}`** — span: `{e['span']}`\n  - why it is wrong: {e['why_wrong']}"
                for e in seeded
            )
        else:
            seeded_md = "_None — this is a gold-standard (L5) note; the review question is "
            seeded_md += "whether it genuinely merits 5 on every dimension._"

        sources = "\n\n".join(
            f"**Source document {i + 1}**\n\n> {doc}" for i, doc in enumerate(case["source_documents"])
        )

        body.append(
            f"""### `{cid}`

| | |
|---|---|
| Level | **{meta.get('level', '?')}** ({meta.get('lane', '?')} lane) |
| Specialty | {case.get('target_specialty', '?')} |
| Consultation | {meta.get('consultation_length', '?')} length · {meta.get('complexity', '?')} complexity |
| Split | `{meta.get('split', '?')}` |
| Label provenance | `{meta.get('label_provenance', '?')}` · review status `{meta.get('clinician_review_status', 'pending')}` |

{sources}

**Note under review**

> {case['generated_note']}

**Seeded defect(s)**

{seeded_md}

**Proposed reference rating**

{_rating_table(case.get('clinician_pdsqi') or {})}

**Rationale (the rule that produced it)**

{meta.get('label_rationale', '_none recorded_')}

**Reviewer decision** — ☐ accept as proposed ☐ amend (record in `curated_v2_amendments.json`)

---
"""
        )

    header = _HEADER.format(
        version=golden["version"],
        n_cases=len(cases),
        n_quality=n_quality,
        n_calibration=len(cases) - n_quality,
        n_ratings=n_ratings,
        status=status,
        toc="\n".join(toc_lines),
    )
    return header + "\n" + "\n".join(body)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m harness.eval.golden.review.render_review")
    parser.add_argument("--golden-set", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    golden = json.loads(Path(args.golden_set).read_text(encoding="utf-8"))
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(golden), encoding="utf-8")
    print(f"wrote {out} ({len(golden['cases'])} cases)")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
