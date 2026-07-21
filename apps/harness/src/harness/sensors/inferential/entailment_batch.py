"""Batched-entailment helper for the groundedness sensor.

The per-claim groundedness loop re-sent the entire transcript premise on every
single claim — ~N serial long-prefill judge calls. This helper collapses that to
``ceil(N / batch_size)`` calls: the shared PREMISE is stated **once** and a JSON
array of claims is labelled in one response, cutting BOTH the repeated prefill and
the repeated reasoning decode.

The parser is deliberately **conservative** (clinical safety invariant §7.3):
anything ambiguous — unparseable/truncated array, a missing id, a non-bool
``supported``, or a duplicate-id conflict — maps the affected claim(s) to
*ungrounded* (``False``). Extra ids that match no real claim are ignored and can
never ground a real claim. This mirrors the per-claim path's ``unparseable ->
ungrounded`` contract, applied per item.
"""

from __future__ import annotations

import json
from typing import Any

from harness.eval.jsonio import loads_json

# Shared system instruction for the array form. Mirrors the single-claim
# groundedness prompt's semantics (full support only) but asks for one verdict per
# id as a strict JSON array.
BATCH_SYSTEM_PROMPT = (
    "You are a meticulous clinical fact-checking judge. You are given a PREMISE "
    "(the source consultation transcript and any cited evidence) and a JSON array of "
    'CLAIMS, each with an "id", a "hypothesis" (a statement taken from a generated '
    'clinical note), and optional "evidence" quotes. For EVERY claim decide whether the '
    "hypothesis is fully supported by the PREMISE together with that claim's own "
    "evidence: it is supported only if every clinical assertion in it is stated in, or "
    "directly entailed by, the premise; unstated or contradicted assertions are NOT "
    "supported. Respond ONLY with a JSON array containing one object per claim, in the "
    'same order, labelling each id: [{"id": "<id>", "supported": true|false}, ...]. '
    "Label every id. Output ONLY the JSON array, no prose."
)


def chunk(items: list[Any], size: int) -> list[list[Any]]:
    """Split ``items`` into in-order runs of at most ``size`` (size < 1 => 1)."""
    if size < 1:
        size = 1
    return [items[i : i + size] for i in range(0, len(items), size)]


def batch_entailment_messages(premise: str, items: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Build the system+user messages for one batch.

    ``items`` are pre-built ``{"id", "hypothesis", "evidence": [...]}`` payloads
    (the caller carries each claim's own evidence quotes inline, preserving the
    per-claim semantics the serial ``_premise`` used). The shared transcript
    ``premise`` is stated once.
    """
    payload = json.dumps(items, ensure_ascii=False)
    user = f"PREMISE:\n{premise}\n\nCLAIMS:\n{payload}"
    return [
        {"role": "system", "content": BATCH_SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


def _extract_rows(raw: str) -> list[Any] | None:
    """Pull the verdict array out of a (possibly reasoning-wrapped) response."""
    try:
        obj = loads_json(raw)  # tolerant: strips reasoning, returns object/array
    except ValueError:
        return None
    if isinstance(obj, list):
        return obj
    # Tolerate a dict wrapper like {"results": [...]} / {"verdicts": [...]}.
    if isinstance(obj, dict):
        for value in obj.values():
            if isinstance(value, list):
                return value
    return None


def parse_batch_verdicts(raw: str, expected_ids: list[str]) -> dict[str, bool]:
    """Map each expected id to a verdict, conservatively (default = ungrounded).

    Grounded iff the id appears at least once AND every occurrence's ``supported``
    is exactly the bool ``True``. Missing id, non-bool / false value, duplicate
    conflict ⇒ ungrounded. Extra (unexpected) ids are ignored.
    """
    out = dict.fromkeys(expected_ids, False)
    rows = _extract_rows(raw)
    if rows is None:
        return out  # unparseable / truncated / wrong shape -> all ungrounded

    expected = set(expected_ids)
    present: set[str] = set()
    grounded = set(expected_ids)  # innocent-until: discarded on any non-True / conflict
    for item in rows:
        if not isinstance(item, dict):
            continue
        cid = item.get("id")
        if cid is None:
            continue
        cid = str(cid)
        if cid not in expected:
            continue
        present.add(cid)
        if item.get("supported") is not True:
            grounded.discard(cid)

    for cid in expected_ids:
        out[cid] = cid in present and cid in grounded
    return out
