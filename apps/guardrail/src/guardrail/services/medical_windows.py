"""The per-window medical judge (TASK-1047 OD-5; TASK-1059 C-1 + amendment A-1).

Before: every LLM call sent its whole joined prompt to one 8B-model judgement
(≈ 17 continuously busy judge streams at 100 consultations). After: the regions are
windowed, each window is judged `on_scope` once and cached (FC-7, task `medical_judge`).

TASK-1059: windowing is SIZE-based (`windowing.pack_regions`) in both scopes — small regions
share a window up to the geometry's size, a region longer than a window is cut from its own
start (so a growing transcript is still judged only in its changed tail). The answer carries one
verdict per request REGION (`region_verdicts`): a packed region takes its window's verdict, a
split region is medical if ANY window is (`scope="context"`) or if EVERY window is
(`scope="prompt"`). The request is medical iff at least one judged region is
(`"context"`: runtime context items, OD-5/OD-9) or every window is (`"prompt"`: build time, OD-2).
Regions named in ``skip`` (configuration blocks) are covered but never judged.

Cached per window: `is_medical`, `confidence`, `context_type` — never the model's
`reasoning`, which may quote the window it judged.

TASK-1050: when an inbound safety-judge lane is enabled, :func:`judge_regions_combined` runs the
medical lane through the judge runner instead (the lane's model row decides the protocol). A
packed window has no twin on the screen route, so only the medical lane is asked there.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Final

from guardrail.services.windowing import (
    PackedWindow,
    WindowGeometry,
    WindowRunner,
    is_shed_judge_error,
    pack_regions,
)

MEDICAL_JUDGE_TASK: Final = "medical_judge"

#: TASK-1059 C-1 — what the regions ARE. ``context``: runtime context items (the request is
#: medical iff one judged item is); ``prompt``: the pieces of a prompt being saved (strict).
SCOPE_CONTEXT: Final = "context"
SCOPE_PROMPT: Final = "prompt"

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
    "region_verdicts": [],
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


def _region_verdicts(
    regions: Sequence[tuple[str, str]],
    windows: Sequence[PackedWindow],
    verdicts: Sequence[dict[str, Any]],
    skip: frozenset[str],
    *,
    any_window: bool,
) -> list[dict[str, Any]]:
    """One ``{key, is_medical, context_type, confidence}`` per request region, in order.

    A region in several windows (split) is medical if ANY (``any_window``) / EVERY window is; the
    deciding window is then the most confident of the agreeing ones. A region in no window was
    never judged: a skipped configuration block (``context_type`` ``skipped``) or an empty one
    (``empty``); neither is off scope.
    """
    by_region: dict[int, list[dict[str, Any]]] = {}
    for window, verdict in zip(windows, verdicts, strict=True):
        for member in window.members:
            by_region.setdefault(member, []).append(verdict)
    out: list[dict[str, Any]] = []
    for index, (key, _text) in enumerate(regions):
        judged = by_region.get(index)
        if not judged:
            out.append(
                {
                    "key": key,
                    "is_medical": True,
                    "context_type": "skipped" if key in skip else "empty",
                    "confidence": 1.0,
                }
            )
            continue
        medical = [v for v in judged if bool(v.get("is_medical"))]
        off = [v for v in judged if not bool(v.get("is_medical"))]
        is_medical = bool(medical) if any_window else not off
        agreeing = medical if is_medical else off
        deciding = max(agreeing, key=lambda v: float(v.get("confidence") or 0.0))
        out.append(
            {
                "key": key,
                "is_medical": is_medical,
                "context_type": str(deciding.get("context_type") or "unknown"),
                "confidence": float(deciding.get("confidence") or 0.0),
            }
        )
    return out


def _verdict_of(
    regions: Sequence[tuple[str, str]],
    windows: Sequence[PackedWindow],
    verdicts: Sequence[dict[str, Any]],
    *,
    scope: str,
    skip: frozenset[str],
    stats: dict[str, Any] | None,
) -> dict[str, Any]:
    """The request verdict over per-window ``{is_medical, confidence, context_type}`` dicts."""
    context = scope == SCOPE_CONTEXT
    per_region = _region_verdicts(regions, windows, verdicts, skip, any_window=context)
    judged = {member for window in windows for member in window.members}
    judged_regions = [per_region[i] for i in sorted(judged)]
    off_windows = [v for v in verdicts if not bool(v.get("is_medical"))]
    # Region KEYS judged off scope, in request order — never text (TASK-1047 V7 diagnosis).
    off_scope_regions = [r["key"] for r in judged_regions if not r["is_medical"]]
    if not windows:
        return {**_EMPTY, "region_verdicts": per_region}
    if context:
        in_scope = [r for r in judged_regions if r["is_medical"]]
        is_medical = bool(in_scope)
        deciding = (
            max(in_scope, key=lambda r: r["confidence"])
            if in_scope
            else min(judged_regions, key=lambda r: r["confidence"])
        )
        confidence = deciding["confidence"]
        context_type = deciding["context_type"]
    else:
        is_medical = not off_windows
        window = (
            off_windows[0]
            if off_windows
            else min(verdicts, key=lambda v: float(v.get("confidence") or 0.0))
        )
        confidence = min(float(v.get("confidence") or 0.0) for v in verdicts)
        context_type = str(window.get("context_type") or "unknown")
    return {
        "is_medical": is_medical,
        "confidence": confidence,
        "context_type": context_type,
        # Counts only: the model's prose may quote PHI and is never surfaced here.
        "reasoning": f"{len(verdicts)} window(s) judged; {len(off_windows)} off scope",
        "windows": len(verdicts),
        "off_scope_windows": len(off_windows),
        "off_scope_regions": off_scope_regions,
        "stats": stats,
        "region_verdicts": per_region,
    }


def _plan(
    regions: Sequence[tuple[str, str]], geometry: WindowGeometry, skip: frozenset[str]
) -> list[PackedWindow]:
    """The packed windows of every region not in ``skip`` (indices stay the request's)."""
    judged = [(key, text if key not in skip else "") for key, text in regions]
    return pack_regions(judged, geometry)


async def judge_regions(
    judge: Any,
    regions: Sequence[tuple[str, str]],
    *,
    runner: WindowRunner,
    geometry: WindowGeometry,
    scope: str = SCOPE_PROMPT,
    skip: frozenset[str] = frozenset(),
) -> dict[str, Any]:
    """One verdict over the packed windows of ``regions``. Any undetermined window raises.

    A window the judge lane SHED (503) is retried on its own (OD-6) before it fails the request.
    No content at all (no region, or only empty / skipped ones) has nothing off scope:
    `is_medical` is true and no judgement is requested.
    """
    windows = _plan(regions, geometry, skip)
    verdicts: list[dict[str, Any]] = []
    if windows:
        verdicts = await runner.run(
            MEDICAL_JUDGE_TASK,
            str(getattr(judge, "model", "") or ""),
            [w.text for w in windows],
            judge.judge_window_on_scope,
            project=_project,
            retry=is_shed_judge_error,
        )
    return _verdict_of(
        regions, windows, verdicts, scope=scope, skip=skip, stats=_sum_stats(verdicts)
    )


async def judge_regions_combined(
    runner: Any,
    tenant_id: str,
    regions: Sequence[tuple[str, str]],
    *,
    skip: frozenset[str],
    geometry: WindowGeometry,
    scope: str = SCOPE_PROMPT,
) -> dict[str, Any]:
    """The same verdict through the TASK-1050 judge runner (the medical lane's model row).

    The windows are the packed plan of :func:`judge_regions`; only the medical lane is asked,
    because a packed window has no identical twin on the screen route to share a combined call
    with. Any undetermined medical window raises (503 at the route), exactly like
    :func:`judge_regions`.
    """
    from guardrail.core.errors import REASON_ENGINE_ERROR, GuardrailUndeterminedError
    from guardrail.services.judge_protocols import MEDICAL_LANE
    from guardrail.services.judge_runner import JudgeWindow, window_region_key

    windows = _plan(regions, geometry, skip)
    if not windows:
        return _verdict_of(regions, windows, [], scope=scope, skip=skip, stats=None)

    judge_windows = [
        JudgeWindow(window_region_key("medical", index), window.text, ())
        for index, window in enumerate(windows)
    ]
    answers = await runner.judge(
        tenant_id=tenant_id, direction="inbound", lanes=(MEDICAL_LANE,), windows=judge_windows
    )
    per_window: list[dict[str, Any]] = []
    for window in judge_windows:
        verdict = answers.get((MEDICAL_LANE, window.region_key))
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
    return _verdict_of(
        regions, windows, per_window, scope=scope, skip=skip, stats=runner.usage_stats()
    )
