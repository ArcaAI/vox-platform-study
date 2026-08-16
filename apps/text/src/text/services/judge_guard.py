"""Cycle guard for the internal judge lane (TASK-735 Phase 2).

`apps/text` gates every PUBLIC `/generate` on `apps/guardrail`, fail-closed.
Guardrail, in turn, is being rebuilt to delegate its LLM judgement calls back to
`apps/text`. Those two facts together describe a cycle —
``text -> guardrail -> text -> guardrail -> ...`` — which is unbounded and, under
saturation, deadlocks the safety plane behind the very pool it protects.

The cycle is broken structurally: judgement calls land on a SEPARATE route
(``POST /generate/internal/judge``) that sits outside the moderation gate and
owns its own concurrency budget. This module is the tripwire that keeps it
broken. The judge handler runs its whole body inside :func:`judge_scope`, and the
shared moderation gate asserts it is NOT inside one
(:func:`assert_not_in_judge_scope`). A future edit that routes the gate onto the
judge path therefore raises loudly on the first request instead of quietly
closing the cycle again.

The scope is a ``ContextVar``, so it follows the handler's task into everything
it awaits and never leaks into a concurrently-served request.

This is layer TWO of the guard. Layer one is static: the judge module names
neither the guardrail client nor its dependency provider, which is pinned by
``tests/unit/test_judge_route.py``. Layer one stops the cycle being written;
layer two stops it being reached.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

from text.core.exceptions import SmrError

_IN_JUDGE_SCOPE: ContextVar[bool] = ContextVar("text_in_judge_scope", default=False)


class GuardrailRecursionError(SmrError):
    """The moderation gate was reached from inside a judge call.

    Always a wiring defect, never a runtime condition: it means the safety
    plane's own judgement call would have been gated on the safety plane. Mapped
    to 500 by the shared handler (``SmrError``) — there is nothing a caller can
    retry or reconfigure to make it succeed.
    """

    def __init__(self, where: str) -> None:
        super().__init__(
            f"Guardrail moderation gate reached from inside an internal judge call at {where!r}: "
            "this closes the text -> guardrail -> text cycle. The judge lane must never invoke "
            "the guardrail gate.",
            error_code="GUARDRAIL_RECURSION",
        )
        self.where = where


@contextmanager
def judge_scope() -> Iterator[None]:
    """Mark the calling task (and everything it awaits) as an internal judge call."""
    token = _IN_JUDGE_SCOPE.set(True)
    try:
        yield
    finally:
        _IN_JUDGE_SCOPE.reset(token)


def in_judge_scope() -> bool:
    """True while the current task is serving an internal judge call."""
    return _IN_JUDGE_SCOPE.get()


def assert_not_in_judge_scope(where: str) -> None:
    """Raise if the moderation gate is being reached from a judge call."""
    if _IN_JUDGE_SCOPE.get():
        raise GuardrailRecursionError(where)
