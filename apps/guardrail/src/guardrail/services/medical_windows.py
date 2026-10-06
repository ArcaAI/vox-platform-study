"""The per-window medical judge (TASK-1047 OD-5).

Before: every LLM call sent its whole joined prompt to one 8B-model judgement
(≈ 17 continuously busy judge streams at 100 consultations). After: each REGION is
cut into windows from its own start, each window is judged `on_scope` once and
cached (FC-7, task `medical_judge`), and the request is medical iff EVERY window is
on scope. A growing transcript is therefore judged only in its changed tail.

Cached per window: `is_medical`, `confidence`, `context_type` — never the model's
`reasoning`, which may quote the window it judged.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Final

from guardrail.services.windowing import WindowGeometry, WindowRunner, region_windows

MEDICAL_JUDGE_TASK: Final = "medical_judge"

_CACHED_FIELDS: Final = ("is_medical", "confidence", "context_type")
_STAT_SUMS: Final = ("prompt_tokens", "predicted_tokens", "total_tokens", "total_ms")


def _project(verdict: dict[str, Any]) -> dict[str, Any]:
    return {key: verdict.get(key) for key in _CACHED_FIELDS}


def _sum_stats(verdicts: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    """Usage of the windows actually judged in THIS request; `None` if none were.

    A cache hit cost nothing and reports nothing — a zeroed block would tell the
    billing plane a judgement happened for free.
    """
    computed = [v["stats"] for v in verdicts if isinstance(v.get("stats"), dict)]
    if not computed:
        return None
    total = dict(computed[0])
    for key in _STAT_SUMS:
        values = [s.get(key) for s in computed if isinstance(s.get(key), (int, float))]
        if values:
            total[key] = sum(values)
    return total


async def judge_regions(
    judge: Any,
    regions: Sequence[tuple[str, str]],
    *,
    runner: WindowRunner,
    geometry: WindowGeometry,
) -> dict[str, Any]:
    """One verdict over every window of every region. Any undetermined window raises.

    No content at all (no region, or only empty ones) has nothing off scope:
    `is_medical` is true and no judgement is requested.
    """
    windows = [w for key, text in regions for w in region_windows(key, text, geometry)]
    if not windows:
        return {
            "is_medical": True,
            "confidence": 1.0,
            "context_type": "empty",
            "reasoning": "no content to judge",
            "windows": 0,
            "off_scope_windows": 0,
            "stats": None,
        }

    verdicts = await runner.run(
        MEDICAL_JUDGE_TASK,
        str(getattr(judge, "model", "") or ""),
        [w.text for w in windows],
        judge.judge_window_on_scope,
        project=_project,
    )

    off_scope = [v for v in verdicts if not bool(v.get("is_medical"))]
    deciding = (
        off_scope[0]
        if off_scope
        else min(verdicts, key=lambda v: float(v.get("confidence") or 0.0))
    )
    return {
        "is_medical": not off_scope,
        "confidence": min(float(v.get("confidence") or 0.0) for v in verdicts),
        "context_type": str(deciding.get("context_type") or "unknown"),
        # Counts only: the model's prose may quote PHI and is never surfaced here.
        "reasoning": f"{len(windows)} window(s) judged; {len(off_scope)} off scope",
        "windows": len(windows),
        "off_scope_windows": len(off_scope),
        "stats": _sum_stats(verdicts),
    }
