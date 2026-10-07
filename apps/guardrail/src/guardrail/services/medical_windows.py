"""The per-window medical judge (TASK-1047 OD-5).

Before: every LLM call sent its whole joined prompt to one 8B-model judgement
(≈ 17 continuously busy judge streams at 100 consultations). After: each REGION is
cut into windows from its own start, each window is judged `on_scope` once and
cached (FC-7, task `medical_judge`), and the request is medical iff EVERY window is
on scope. A growing transcript is therefore judged only in its changed tail.

Cached per window: `is_medical`, `confidence`, `context_type` — never the model's
`reasoning`, which may quote the window it judged.

TASK-1050: when an inbound safety-judge lane is enabled, :func:`judge_regions_combined` runs the
same verdict through the judge runner instead, so a data window's medical judgement is ONE combined
call with the inbound safety lanes — shared with the screen route (`services/judge_runner.py`).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Final

from guardrail.services.windowing import WindowGeometry, WindowRunner, region_windows

MEDICAL_JUDGE_TASK: Final = "medical_judge"

_CACHED_FIELDS: Final = ("is_medical", "confidence", "context_type")
_STAT_SUMS: Final = ("prompt_tokens", "predicted_tokens", "total_tokens", "total_ms")

_EMPTY: Final[dict[str, Any]] = {
    "is_medical": True,
    "confidence": 1.0,
    "context_type": "empty",
    "reasoning": "no content to judge",
    "windows": 0,
    "off_scope_windows": 0,
    "off_scope_regions": [],
    "stats": None,
}


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


def _verdict_of(
    verdicts: Sequence[dict[str, Any]], regions: Sequence[str], stats: dict[str, Any] | None
) -> dict[str, Any]:
    """The request verdict over per-window ``{is_medical, confidence, context_type}`` dicts."""
    off_scope = [v for v in verdicts if not bool(v.get("is_medical"))]
    # Region KEYS of the off-scope windows, in first-seen order — never text (TASK-1047 V7 diagnosis).
    off_scope_regions = list(
        dict.fromkeys(
            region
            for region, v in zip(regions, verdicts, strict=True)
            if not bool(v.get("is_medical"))
        )
    )
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
        "reasoning": f"{len(verdicts)} window(s) judged; {len(off_scope)} off scope",
        "windows": len(verdicts),
        "off_scope_windows": len(off_scope),
        "off_scope_regions": off_scope_regions,
        "stats": stats,
    }


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
        return dict(_EMPTY)

    verdicts = await runner.run(
        MEDICAL_JUDGE_TASK,
        str(getattr(judge, "model", "") or ""),
        [w.text for w in windows],
        judge.judge_window_on_scope,
        project=_project,
    )
    return _verdict_of(verdicts, [str(w.region) for w in windows], _sum_stats(verdicts))


async def judge_regions_combined(
    runner: Any,
    tenant_id: str,
    regions: Sequence[tuple[str, str, str]],
    *,
    enabled_safety_lanes: Sequence[str],
    skip: frozenset[str],
    geometry: WindowGeometry,
) -> dict[str, Any]:
    """The OD-5 verdict through the TASK-1050 judge runner, sharing calls with the screen route.

    ``regions`` are ``(key, text, trust)`` exactly as sent. The plan is
    `judge_runner.plan_inbound_judge_calls` — the SAME call the screen route makes — so a data
    window's lane set (medical + the enabled inbound safety lanes) is identical on both routes and
    the two make ONE combined judgement between them. Only the groups that contain the medical
    lane run here: a settings-region group would buy this route nothing. Any undetermined medical
    window raises (503 at the route), exactly like :func:`judge_regions`.
    """
    from guardrail.core.errors import REASON_ENGINE_ERROR, GuardrailUndeterminedError
    from guardrail.services.judge_protocols import MEDICAL_LANE
    from guardrail.services.judge_runner import plan_inbound_judge_calls, region_of

    plan = [
        (lanes, windows)
        for lanes, windows in plan_inbound_judge_calls(
            regions,
            enabled_safety_lanes=enabled_safety_lanes,
            medical_skip=skip,
            geometry=geometry,
        )
        if MEDICAL_LANE in lanes
    ]
    if not plan:
        return dict(_EMPTY)

    verdicts: dict[tuple[str, str], Any] = {}
    for lanes, windows in plan:
        verdicts.update(
            await runner.judge(
                tenant_id=tenant_id, direction="inbound", lanes=lanes, windows=windows
            )
        )

    # Request order: by region as sent, then by window offset within it.
    region_order = {key: index for index, (key, _text, _trust) in enumerate(regions)}
    ordered = sorted(
        (w for _lanes, windows in plan for w in windows),
        key=lambda w: (
            region_order.get(region_of(w.region_key), 0),
            int(w.region_key.rsplit("@", 1)[1]),
        ),
    )
    per_window: list[dict[str, Any]] = []
    for window in ordered:
        verdict = verdicts.get((MEDICAL_LANE, window.region_key))
        if verdict is None or verdict.verdict == "undetermined":
            reason = getattr(verdict, "category", None) or "missing"
            raise GuardrailUndeterminedError(
                REASON_ENGINE_ERROR, f"the medical judge rendered no verdict ({reason})"
            )
        per_window.append(
            {
                "is_medical": verdict.verdict == "pass",
                "confidence": verdict.confidence,
                "context_type": verdict.category,
            }
        )
    return _verdict_of(per_window, [region_of(w.region_key) for w in ordered], runner.usage_stats())
