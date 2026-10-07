"""The fallback walk of ONE NotePlan call — the chain ``generate`` and ``core.agent`` walk,
narrowed to the candidates that serve the PLAN's model.

The plan was budgeted against one model: its blocks, call split and output caps were counted
against that model's declared context window and tokenizer. A candidate on ANOTHER model could
overflow it, so it is not eligible — serving it would need a plan composed for it. A candidate
that serves the SAME model through another provider or connection (the platform default of a
tenant's own key, a second engine) fits the plan exactly, and is walked like any fallback.

Same rules as the other two walkers: switch only on a ``TextServiceError``, never START a
candidate the activity budget cannot fit, and report every leg that lost so its step is
recorded. The walk is per call: each section group switches on its own.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any

from harness.services.note_plan.executor import (
    GenerateFn,
    NoteCallAttemptsLost,
    NoteCallRequest,
    NoteCallResult,
)
from harness.services.note_plan.models import NotePlanV1
from harness.services.text_client import TextGuardrailBlocked, TextServiceError
from harness.temporal.interpreter.nodes._text_fallback import (
    TextFallbackCandidate,
    wire_provider,
)


@dataclass(frozen=True)
class PlanAttempt:
    """One candidate a plan call may run on (credential carried, never logged)."""

    provider: str
    model: str
    funding_tier: str | None = None
    deployment_kind: str | None = None
    provider_override: dict[str, Any] | None = None


@dataclass(frozen=True)
class FailedLeg:
    attempt: PlanAttempt
    #: 0-based position in the walk (0 = the plan's own model on its own provider).
    index: int
    started_at: datetime
    ended_at: datetime
    error: BaseException


AttemptFn = Callable[[NoteCallRequest, PlanAttempt, int], Awaitable[NoteCallResult]]


def plan_attempts(
    plan: NotePlanV1, primary: PlanAttempt, chain: Sequence[TextFallbackCandidate]
) -> list[PlanAttempt]:
    """``primary`` then every chain candidate serving ``plan.model.slug``, in chain order.

    A candidate with no wire provider or model id is dropped (it could only fail), as is one
    identical to an attempt already listed.
    """
    attempts = [primary]
    for candidate in chain:
        provider = wire_provider(candidate.provider)
        if candidate.model_slug != plan.model.slug or not provider or not candidate.model:
            continue
        attempt = PlanAttempt(
            provider=provider,
            model=candidate.model,
            funding_tier=candidate.funding_tier,
            deployment_kind=candidate.deployment_kind,
            provider_override=candidate.provider_override,
        )
        if any(
            (a.provider, a.model, a.provider_override)
            == (attempt.provider, attempt.model, attempt.provider_override)
            for a in attempts
        ):
            continue
        attempts.append(attempt)
    return attempts


def walk_attempts(
    attempts: Sequence[PlanAttempt],
    call: AttemptFn,
    *,
    allows_another: Callable[[], bool],
    on_attempt: Callable[[PlanAttempt, int], Awaitable[None]] | None = None,
) -> GenerateFn:
    """The executor's ``generate``: each call tries ``attempts`` in order.

    The first candidate always runs; a later one only while ``allows_another()`` (the activity
    budget). When every allowed candidate lost, :class:`NoteCallAttemptsLost` carries the last
    error — the one retry-safety is judged on — and the legs lost before it.
    """
    if not attempts:
        raise ValueError("a plan call needs at least one candidate")

    async def generate(request: NoteCallRequest) -> NoteCallResult:
        lost: list[FailedLeg] = []
        for index, attempt in enumerate(attempts):
            if index > 0 and not allows_another():
                break
            if on_attempt is not None:
                await on_attempt(attempt, index)
            started = datetime.now(UTC)
            try:
                result = await call(request, attempt, index)
            except TextGuardrailBlocked:
                # TASK-1050 — a guardrail refusal is a policy verdict (or a privacy outage), not a
                # provider outage: every candidate is screened against the same policy, so the call
                # stops here and the caller holds it.
                raise
            except TextServiceError as exc:
                lost.append(FailedLeg(attempt, index, started, datetime.now(UTC), exc))
                continue
            return replace(result, attempt=attempt, failed_legs=tuple(lost))
        last = lost[-1]
        raise NoteCallAttemptsLost(last.error, last.attempt, tuple(lost[:-1]))

    return generate
