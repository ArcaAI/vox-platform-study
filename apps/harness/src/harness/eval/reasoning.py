"""The judge's reasoning posture, resolved from the PLATFORM control plane.

TASK-968 (owner directive 2026-09-13). The two levers that decide how hard the assurance
judge thinks used to be ``HARNESS_JUDGE_REASONING_MODE`` / ``HARNESS_JUDGE_SUPPRESS_REASONING``
/ ``HARNESS_JUDGE_EXTRA_BODY`` — environment variables, immutable for the process lifetime,
both defaulting to "let the engine decide". They are now registry keys a platform admin writes
without a redeploy, served on ``GET /internal/effective-config?service=harness`` by the
descriptors in
``packages/applications/src/services/settings-registry/descriptors/harness-judge.descriptors.ts``.

Two levers, because they act in different places:

``mode``
    The PROMPT lever. ``resolve_prompt`` appends ``/no_think`` (``none``) or a think-first
    directive (``think``) to the judge SYSTEM MESSAGE, or says nothing (``auto``). It reaches
    the PDSQI-9 rubric judge only — CI, the promotion gate and the admin run-now endpoint.

``effort``
    The WIRE lever. It rides ``extra_body.reasoning_effort`` into the OpenAI-compatible /
    Azure ``create(...)`` call, so it reaches EVERY judge call — including the groundedness
    and citation-verify sensors ``run_inferential_sensors`` runs on every real consultation.
    Bedrock's ``converse`` API has no such passthrough and ignores it.

The FLOOR is the directive, not the engine's default. An unreachable control plane, an absent
key or an out-of-contract value all keep :data:`JUDGE_REASONING_FLOOR` — reasoning off — which
is the whole point: the state being removed is the one where nobody decided.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import structlog

logger = structlog.get_logger(__name__)

#: Registry keys, mirrored from `harness-judge.descriptors.ts`.
JUDGE_REASONING_MODE_KEY = "harness.judge.reasoningMode"
JUDGE_REASONING_EFFORT_KEY = "harness.judge.reasoningEffort"

#: How the prompt asks the judge to reason (`resolve_prompt` branches on these).
REASONING_MODES: tuple[str, ...] = ("auto", "think", "none")

#: How hard the engine is told to think — the same four efforts an agent may author.
REASONING_EFFORTS: tuple[str, ...] = ("minimal", "low", "medium", "high")


@dataclass(frozen=True)
class JudgeReasoning:
    """One resolved posture: a prompt mode and an engine effort."""

    mode: str
    effort: str


#: Reasoning OFF — the in-code floor, and the descriptors' default.
JUDGE_REASONING_FLOOR = JudgeReasoning(mode="none", effort="minimal")


def _resolved(snapshot: Any, key: str, allowed: tuple[str, ...], current: str) -> str:
    """One key off the snapshot, or ``current`` when there is nothing usable to apply.

    ``snapshot`` is never ``None`` here — the caller returns ``base`` before reaching this.
    """
    value = snapshot.setting(key)
    if value is None:
        # Absent or null — "no opinion", never "the default".
        return current
    if not isinstance(value, str) or value not in allowed:
        logger.warning(
            "harness.judge_reasoning.refused",
            key=key,
            reason=f"not one of {list(allowed)}",
        )
        return current
    return value


def resolve_judge_reasoning(
    snapshot: Any | None,
    base: JudgeReasoning = JUDGE_REASONING_FLOOR,
) -> JudgeReasoning:
    """``base`` with each lever the CONTROL PLANE resolved substituted in.

    Mirrors ``harness.sensors.config.resolve_sensor_thresholds`` deliberately — same channel,
    same degradation contract, so there is one shape to learn rather than two. Every rejection
    path keeps ``base``:

    * no snapshot, or a snapshot from a FAILED pull (``ok=False``) — a degraded control plane
      must leave the judge exactly where it was;
    * an absent key or a ``null`` value — "no opinion", never "the default";
    * a value outside the declared vocabulary, or of the wrong type.

    That last case is REFUSED and logged, not coerced: coercing would invent a posture nobody
    chose and hide the control-plane defect that produced it.
    """
    if snapshot is None or not getattr(snapshot, "ok", False):
        return base

    mode = _resolved(snapshot, JUDGE_REASONING_MODE_KEY, REASONING_MODES, base.mode)
    effort = _resolved(snapshot, JUDGE_REASONING_EFFORT_KEY, REASONING_EFFORTS, base.effort)
    if mode == base.mode and effort == base.effort:
        return base
    return JudgeReasoning(mode=mode, effort=effort)
