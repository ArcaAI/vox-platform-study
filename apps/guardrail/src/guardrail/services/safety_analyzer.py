"""Content-safety POLICY over the delegated `apps/nlp` executor (TASK-735 Phase 3).

This is what is LEFT of `providers/gliner.py` after the weights moved out: the
half that decides things. It owns

* which moderation TASKS a `guardrail_type` runs,
* how nlp's per-task labels collapse into guardrail's `safe`/`issues`/`confidence`
  verdict shape,
* the fail-closed posture,

and it owns NO model id and NO label set. Both arrive from the registry
(`AiTaskDefault` ⋈ `AiModel`, tenant row first and SYSTEM as the platform
fallback) and reach this object through :class:`SafetyPolicy`.

Two DIFFERENT models back it, deliberately (owner directive 2026-08-19):

| Task key            | Model                                        | What it answers          |
|---------------------|----------------------------------------------|--------------------------|
| `guardrail.safety`  | `gliguard-LLMGuardrails-300M`-class          | six moderation tasks     |
| `guardrail.pii`     | `gliner2-privacy-filter-PII-multi`-class     | PII entity spans (en)    |

Neither slug appears here: they are seeded SYSTEM rows a platform admin owns.

Fail posture — FAIL-CLOSED and never fabricating. Every delegation failure
raises `GuardrailUndeterminedError`, which the routes map to 503 (single-item)
or a per-element `undetermined` (batch). `safe: true` on this service's wire
still always means a model actually computed it.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from guardrail.core.errors import REASON_ENGINE_ERROR, GuardrailUndeterminedError
from guardrail.core.logging import get_logger
from guardrail.services.external_nlp_client import NlpGuardClient

logger = get_logger(__name__)

#: Which moderation task names each `guardrail_type` consults. The task NAMES
#: are part of the model contract (they are the schema keys the safety model was
#: trained on); the LABELS behind each name are configuration and come from the
#: registry row. Prompt-side tasks are used because guardrail screens INPUT text;
#: `response_*` tasks are available in the same taxonomy for callers that submit
#: a prompt+response pair, and are run only when the registry declares them.
PROMPT_SAFETY_TASKS = ("prompt_safety", "prompt_toxicity")
ADVERSARIAL_TASKS = ("jailbreak_detection",)
RESPONSE_TASKS = ("response_safety", "response_toxicity", "response_refusal")

#: Labels that mean "nothing detected" in a multi-label result — they are not
#: issues. Sourced from the taxonomy itself, not assumed: the registry row's
#: `benignLabels` names them, and this is the bootstrap set when it does not.
_DEFAULT_BENIGN = frozenset({"benign", "none", "safe", "compliance"})


@dataclass(frozen=True)
class SafetyPolicy:
    """The resolved policy for one request — every field registry-sourced."""

    #: task name → gliner2 task spec (`labels`, `multi_label`, `cls_threshold`).
    tasks: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: PII label taxonomy for the PII model.
    pii_labels: list[str] = field(default_factory=list)
    #: Threshold the PII model flags at.
    pii_threshold: float = 0.5
    #: Threshold the moderation model flags at.
    classification_threshold: float = 0.4
    #: Labels that mean "clean" and must not be reported as issues.
    benign_labels: frozenset[str] = _DEFAULT_BENIGN

    def tasks_for(self, guardrail_type: str) -> dict[str, dict[str, Any]]:
        """The subset of the declared task schema a `guardrail_type` runs."""
        if guardrail_type == "prompt_injection":
            wanted = set(ADVERSARIAL_TASKS)
        elif guardrail_type == "content_safety":
            wanted = set(PROMPT_SAFETY_TASKS)
        elif guardrail_type == "pii_detection":
            wanted = set()
        else:  # comprehensive
            wanted = set(PROMPT_SAFETY_TASKS) | set(ADVERSARIAL_TASKS) | set(RESPONSE_TASKS)
        # Intersect with what the registry actually DECLARED: a taxonomy that
        # omits a task simply does not run it — guardrail never invents one.
        return {name: spec for name, spec in self.tasks.items() if name in wanted}


class SafetyAnalyzer:
    """Runs the policy against `apps/nlp`. Same async surface the provider had."""

    def __init__(
        self,
        policy: SafetyPolicy,
        *,
        safety_client: NlpGuardClient | None = None,
        pii_client: NlpGuardClient | None = None,
    ) -> None:
        self.policy = policy
        self._safety_client = safety_client
        self._pii_client = pii_client

    # ── the seam `services/screening.py` composes over ───────────────────

    async def classify_tasks(self, task_names: Sequence[str], text: str) -> dict[str, Any]:
        """Run exactly the named moderation tasks, from the resolved taxonomy.

        `analyze_content` collapses labels into guardrail's legacy
        `safe`/`issues` shape; the bidirectional screener needs the labels
        THEMSELVES, per task, to build an attributable per-check record. Both read
        the same registry-sourced task schema — a task the taxonomy does not
        declare is simply absent from the result, never invented.
        """
        wanted = {name: spec for name, spec in self.policy.tasks.items() if name in task_names}
        if not wanted:
            return {}
        if self._safety_client is None:
            raise GuardrailUndeterminedError(
                REASON_ENGINE_ERROR,
                "no safety model is selected (guardrail.safety) — refusing to report 'safe'",
            )
        results: dict[str, Any] = await self._safety_client.classify(wanted, text)
        return results

    def model_for(self, check: str) -> str:
        """Which model answers a given check — part of every attributable verdict."""
        client = self._pii_client if check == "pii_leak" else self._safety_client
        return str(getattr(client, "model_id", "") or "")

    # ── PII spans (the `/guardrail/redact` path) ─────────────────────────

    async def extract_pii_entities(self, text: str) -> list[Any]:
        """PII spans for redaction. Raises rather than reporting 'none found'."""
        if self._pii_client is None:
            raise GuardrailUndeterminedError(
                REASON_ENGINE_ERROR,
                "no PII model is selected (guardrail.pii) — cannot extract spans for redaction",
            )
        return list(await self._pii_client.extract_pii_entities(text))

    # ── moderation verdict (the `/guardrail/analyze` path) ───────────────

    async def analyze_content(
        self, text: str, guardrail_type: str = "comprehensive"
    ) -> dict[str, Any]:
        """Collapse the delegated per-task labels into guardrail's verdict shape."""
        issues: list[str] = []
        safe = True
        ran_something = False

        tasks = self.policy.tasks_for(guardrail_type)
        if tasks:
            if self._safety_client is None:
                raise GuardrailUndeterminedError(
                    REASON_ENGINE_ERROR,
                    "no safety model is selected (guardrail.safety) — refusing to report 'safe'",
                )
            results = await self._safety_client.classify(tasks, text)
            ran_something = True
            for name in tasks:
                value = results.get(name)
                if value is None:
                    continue
                labels = [value] if isinstance(value, str) else [str(v) for v in value]
                flagged = [
                    label for label in labels if label.lower() not in self.policy.benign_labels
                ]
                if flagged:
                    safe = False
                    issues.extend(f"{name}:{label}" for label in flagged)

        if guardrail_type in ("comprehensive", "pii_detection"):
            entities = await self.extract_pii_entities(text)
            ran_something = True
            if entities:
                safe = False
                issues.append("pii_detected")

        if not ran_something:
            # A verdict nothing computed is not a pass.
            raise GuardrailUndeterminedError(
                REASON_ENGINE_ERROR,
                f"no task in the resolved taxonomy matches guardrail_type={guardrail_type!r}",
            )

        return {
            "safe": safe,
            "issues": issues,
            # The delegated surface returns labels, not calibrated per-label
            # scores, so guardrail reports a categorical confidence rather than
            # inventing a number: 1.0 when the taxonomy ran clean, 0.0 when it
            # flagged. The verdict, not the number, is what callers gate on.
            "confidence": 1.0 if safe else 0.0,
        }

    async def batch_analyze(
        self,
        texts: list[str],
        guardrail_type: str = "comprehensive",
        gate: Any = None,
    ) -> list[Any]:
        """Analyze many texts concurrently; per-element failures stay per-element.

        BOUNDED when a gate is supplied (TASK-777 B-4): the list is caller-supplied,
        so a bare `gather` lets one request fan out arbitrarily wide against the
        peers — the classic way a single client takes a shared safety plane down.
        """
        if gate is not None:
            bounded: list[Any] = await gate.map(
                lambda text: self.analyze_content(text, guardrail_type),
                texts,
                return_exceptions=True,
            )
            return bounded
        return list(
            await asyncio.gather(
                *(self.analyze_content(text, guardrail_type) for text in texts),
                return_exceptions=True,
            )
        )
