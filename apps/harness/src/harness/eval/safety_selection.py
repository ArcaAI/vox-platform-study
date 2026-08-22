"""DB-resident, fail-closed SAFETY-guardian selection for the offline eval tools.

TASK-791 W7 handoff — TASK-792 owns ``apps/harness/src/harness/eval/**``.

``SafetyGuardConfig`` (``harness/core/config.py``) carries ``provider="lm-studio"``
and ``model="granite-guardian-4.1-8b"`` as pydantic-settings defaults. Rule 00
§Configuration Principles is explicit that this is a hardcoded selection, not
config: *"a `pydantic-settings` field whose default is a real model/engine ... is
a hardcoded selection — move it to `AiTaskDefault` + `AiModel` and fail closed
when unresolved (selection is `failMode: closed`)."*

TASK-791 deliberately left those defaults in place rather than half-remove them,
because two of the three consumers live in THIS package —
:mod:`harness.eval.inferential_corpus_eval` and
:mod:`harness.eval.inferential_judge_parity` — and dropping the defaults without
fixing them first would leave the eval tooling failing at runtime, which is worse
than a visible violation. This module is the missing half: both tools now resolve
the guardian from the database and no longer depend on the literals at all.

It is the SAFETY twin of :mod:`harness.eval.judge.selection`, and shares that
module's DB read (:func:`~harness.eval.judge.selection.resolve_eval_selection`)
so the two cannot drift in resolution order or failure posture. Two deliberate
differences:

* **A different task key.** The guardian is ``guardrail.safety``, not
  ``harness.judge`` — a content-safety classifier is a different selection from
  the LLM-as-judge, and conflating them would screen notes with the grader.
* **The RAW provider string.** ``SafetyGuardConfig`` selects its engine by name
  (``lm-studio`` | ``ollama`` | ``azure`` | ``bedrock``), so the judge's
  provider -> transport mapping would be lossy here.

**Selection vs connection.** Only ``provider`` and ``model`` come from the DB.
``base_url``, ``timeout_s``, ``no_think`` and ``harm_criteria`` stay env-owned —
the same split ``judge/selection.py`` documents: env supplies CONNECTION config,
the database supplies SELECTION.

**Fail closed.** A missing, disabled or unresolvable selection raises
:class:`~harness.eval.judge.selection.JudgeSelectionUnavailable`. There is
deliberately no env fallback: a tool that screens with a different guardian than
the platform selects is worse than one that refuses to run.
"""

from __future__ import annotations

import structlog

from harness.core.config import SafetyGuardConfig
from harness.eval.judge.selection import (
    SYSTEM_TENANT_ID,
    JudgeSelectionUnavailable,
    RawSelection,
    resolve_eval_selection,
)

logger = structlog.get_logger(__name__)

__all__ = [
    "EVAL_SAFETY_TASK_KEY",
    "SYSTEM_TENANT_ID",
    "JudgeSelectionUnavailable",
    "resolve_eval_safety_selection",
    "resolve_eval_safety_config",
]

#: The `AiTaskDefault.taskKey` the content-safety guardian selection lives under.
#: Seeded alongside `guardrail.pii` / `guardrail.groundedness` / `guardrail.validate`.
EVAL_SAFETY_TASK_KEY = "guardrail.safety"


async def resolve_eval_safety_selection(
    *,
    tenant_id: str | None = None,
    dsn: str | None = None,
) -> RawSelection:
    """Resolve the safety guardian's ``(provider, model)``, tenant -> SYSTEM, fail closed.

    Parameters
    ----------
    tenant_id:
        Optional request tenant. ``None`` (the offline tools' normal case) resolves
        the SYSTEM tier ONLY — never a customer tenant.
    dsn:
        Override for ``DATABASE_URL`` (tests).

    Raises
    ------
    JudgeSelectionUnavailable
        When ``DATABASE_URL`` is unset, the database is unreachable, the task
        default is absent/disabled, or its model row is absent/disabled/empty.
    """
    return await resolve_eval_selection(task_key=EVAL_SAFETY_TASK_KEY, tenant_id=tenant_id, dsn=dsn)


async def resolve_eval_safety_config(
    base: SafetyGuardConfig,
    *,
    tenant_id: str | None = None,
    dsn: str | None = None,
) -> SafetyGuardConfig:
    """Return ``base`` with ``provider``/``model`` replaced by the DB selection.

    Returns a COPY (``model_copy``) rather than mutating: ``get_settings()`` is a
    process-wide singleton, and an offline tool must not rewrite the safety config
    every other caller in the process observes.
    """
    selection = await resolve_eval_safety_selection(tenant_id=tenant_id, dsn=dsn)
    logger.info(
        "harness.eval.safety_selection_applied",
        task_key=EVAL_SAFETY_TASK_KEY,
        tier=selection.tier,
        model_slug=selection.model_slug,
        provider=selection.provider,
        model=selection.model,
    )
    return base.model_copy(update={"provider": selection.provider, "model": selection.model})
