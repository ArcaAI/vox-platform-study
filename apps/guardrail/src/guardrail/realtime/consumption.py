"""C-2 and C-3 — the gate a downstream task must pass before it may read.

The streaming tier produces one verdict per finalized segment, cheaply and
fast, and that is genuinely useful: it drives the clinician-facing signals and it
caches the task-agnostic half of the answer. What it does **not** do is authorise
anybody to read anything.

**C-2, stated as the invariant this module enforces:** *the validated unit at a
consumption point is the CUMULATIVE transcript, never the isolated delta.*

The temptation is obvious — the deltas are already validated, they are already
clean, and together they are exactly the text the model is about to see, so why
pay to check it again? Because "every part is clean" is not evidence about the
whole. Malicious tokens separated by natural prose pass every inspected segment
while remaining actionable once the model reassembles them: measured bypass rates
of **82-100%** against exactly this shape, with detector confidence collapsing
0.99 -> 0.03 as malicious density per window falls. A gate built from per-delta
verdicts is not a cheaper gate; it is the vulnerability, wearing the gate's name.

So this module has **no function that combines segment verdicts into a cumulative
one** — not a private one, not a helper. :meth:`ConsumptionGate.evaluate` accepts
the segment verdicts precisely so it can refuse in their presence, and the
absence of a compose/merge/fold helper is itself asserted by a test.

**C-3:** a verdict is valid only for the (assembly x capability set) it was
computed against. Today's four consumer tasks are read-only text->text. The
moment one calls a tool, retrieves, or writes to a chart, the question changes
and the answer is recomputed, never inherited — an inherited verdict across a
capability change is silent privilege escalation.

**C-5:** every branch below, including the unavailable one, returns
``RETAIN_VERBATIM``. Fail-closed governs downstream USE. It never governs capture
or clinician display, because a guardrail that blanks a live transcript is itself
a patient-safety event.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from guardrail.core.errors import REASON_UNSUPPORTED, GuardrailUndeterminedError
from guardrail.realtime.verdict import RETAIN_VERBATIM, TranscriptSegmentVerdict

ACTION_ALLOW: Final = "ALLOW"
ACTION_REVALIDATE_CUMULATIVE: Final = "REVALIDATE_CUMULATIVE"
ACTION_RECOMPUTE_INJECTION: Final = "RECOMPUTE_INJECTION"
ACTION_BLOCK: Final = "BLOCK"

# Machine codes the console keys its copy off. Deliberately NOT prose: rules
#: that alert copy must never say "attack" or "malicious" — dictation artefacts
#: and quoted emails land in these categories — and the surest way to honour that
#: is for the safety plane never to author the sentence in the first place.
NOTICE_AI_DERIVATIONS_PAUSED: Final = "ai_derivations_paused"
NOTICE_SEGMENT_EXCLUDED: Final = "segment_excluded_from_ai_processing"
NOTICE_REVALIDATION_REQUIRED: Final = "revalidation_required"
NOTICE_CODES: Final[tuple[str, ...]] = (
    NOTICE_AI_DERIVATIONS_PAUSED,
    NOTICE_SEGMENT_EXCLUDED,
    NOTICE_REVALIDATION_REQUIRED,
)


@dataclass(frozen=True)
class CapabilityPolicy:
    """Which capabilities each declared capability set actually confers.

    Configuration, resolved tenant -> SYSTEM. An UNKNOWN set id is refused rather
    than assumed read-only: assuming the safest-sounding option for an
    undeclared name is how an unmodelled capability slips through wearing a
    familiar label.
    """

    sets: Mapping[str, frozenset[str]]

    def fingerprint(self) -> str:
        """Which capabilities each set confers — C-3's model, as one string."""
        return ";".join(
            name + "=" + ",".join(sorted(caps)) for name, caps in sorted(self.sets.items())
        )

    @classmethod
    def from_declaration(cls, declaration: Mapping[str, Any] | None) -> CapabilityPolicy:
        if not declaration:
            raise GuardrailUndeterminedError(
                REASON_UNSUPPORTED,
                "the realtime capability sets are unresolved (failMode=closed): declare "
                "`labelTaxonomy.realtime.capabilitySets` on the guardrail.safety model "
                "row. C-3 cannot be checked against an undeclared capability model",
            )
        return cls(
            sets={
                str(name): frozenset(str(c) for c in caps)
                for name, caps in declaration.items()
            }
        )

    def knows(self, capability_set_id: str) -> bool:
        return capability_set_id in self.sets

    def for_set(self, capability_set_id: str) -> frozenset[str]:
        return self.sets.get(capability_set_id, frozenset())


@dataclass(frozen=True)
class ConsumptionRequest:
    """What the consumer is about to do — declared, not inferred.

    ``consumer_window_chars`` is the size of the text that will actually be fed
    to the model, and ``cumulative_content_hash`` is that exact text's hash. The
    pair is what makes C-2 mechanically checkable rather than a review habit.
    """

    tenant_id: str
    cumulative_content_hash: str
    consumer_window_chars: int
    assembly_template_id: str
    capability_set_id: str
    declared_capabilities: tuple[str, ...] = ()
    #: How many independently-validated artifacts are being joined into ONE
    #: context. More than one is a composite, and a composite is a new thing.
    source_artifact_count: int = 1


@dataclass(frozen=True)
class ConsumptionDecision:
    """May this task read? And, always, what happens to the transcript: nothing."""

    allowed: bool
    action: str
    reasons: tuple[str, ...] = ()
    notice: str | None = None
    clinical_signal_count: int = 0
    detail: dict[str, Any] = field(default_factory=dict)

    @property
    def transcript_disposition(self) -> str:
        """Invariant, not a decision. See the module docstring (C-5)."""
        return RETAIN_VERBATIM

    def to_dict(self) -> dict[str, Any]:
        return {
            "allowed": self.allowed,
            "action": self.action,
            "reasons": list(self.reasons),
            "notice": self.notice,
            "clinicalSignalCount": self.clinical_signal_count,
            "transcriptDisposition": self.transcript_disposition,
            "detail": dict(self.detail),
        }


class ConsumptionGate:
    """Stateless policy. One method, and deliberately no composition helpers."""

    def __init__(self, *, capabilities: CapabilityPolicy) -> None:
        self._capabilities = capabilities

    # -- the fail-closed constructor ---------------------------------------

    @staticmethod
    def unavailable(reason: str) -> ConsumptionDecision:
        """Guardrail could not answer.

        Derivations stop; the consultation, the recording and the clinician's
        view of the transcript do not. A timeout is a backend error, not an
        absent value, so it is never disguised as a pass — but neither is it
        allowed to reach the clinical record.
        """
        return ConsumptionDecision(
            allowed=False,
            action=ACTION_BLOCK,
            reasons=(f"guardrail_unavailable:{reason}",),
            notice=NOTICE_AI_DERIVATIONS_PAUSED,
        )

    # -- the gate ----------------------------------------------------------

    def evaluate(
        self,
        request: ConsumptionRequest,
        *,
        held_verdict: TranscriptSegmentVerdict | None,
        segment_verdicts: Sequence[TranscriptSegmentVerdict] = (),
    ) -> ConsumptionDecision:
        """Decide whether ``request``'s task may read the window it declared.

        ``segment_verdicts`` is accepted and deliberately NOT consulted for the
        pass/fail decision. It is recorded in ``detail`` so an auditor can see
        what the caller offered, which is the interesting thing when the answer
        is "revalidate": it means per-delta evidence existed and was correctly
        refused.
        """
        offered = len(segment_verdicts)

        # --- C-2: is there a verdict over the CUMULATIVE artifact at all? ---
        if held_verdict is None:
            return self._revalidate(("no_cumulative_verdict",), offered)

        # --- tenancy, before anything is read off the verdict ---------------
        if held_verdict.scope.tenant_id != request.tenant_id:
            return ConsumptionDecision(
                allowed=False,
                action=ACTION_BLOCK,
                reasons=("tenant_mismatch",),
                notice=NOTICE_REVALIDATION_REQUIRED,
                detail={"segmentVerdictsOffered": offered},
            )

        # --- C-2: is it a verdict over THIS text, as one whole artifact? ----
        cumulative_reasons: list[str] = []
        if held_verdict.scope.content_hash != request.cumulative_content_hash:
            cumulative_reasons.append("content_hash_mismatch")
        if not held_verdict.window.complete:
            cumulative_reasons.append("window_incomplete")
        if held_verdict.window.inspected_chars < request.consumer_window_chars:
            # The guard inspected less than the model will infer over — the
            # Prompt Overflow shape in one comparison.
            cumulative_reasons.append("inspection_narrower_than_model_window")
        if request.source_artifact_count > 1:
            # Concatenating two validated artifacts creates a third, unvalidated
            # one. Validity is not additive.
            cumulative_reasons.append("unvalidated_composite")
        if cumulative_reasons:
            return self._revalidate(tuple(cumulative_reasons), offered)

        # --- C-3: is the verdict scoped to what this consumer will do? ------
        scope_reasons: list[str] = []
        if not self._capabilities.knows(request.capability_set_id):
            scope_reasons.append("undeclared_capability_set")
        else:
            modelled = self._capabilities.for_set(request.capability_set_id)
            for capability in request.declared_capabilities:
                if capability not in modelled:
                    scope_reasons.append(f"unmodelled_capability:{capability}")
        if held_verdict.injection_risk.assembly_template_id != request.assembly_template_id:
            scope_reasons.append("assembly_changed")
        if held_verdict.injection_risk.capability_set_id != request.capability_set_id:
            scope_reasons.append("capability_set_changed")
        if scope_reasons:
            return ConsumptionDecision(
                allowed=False,
                action=ACTION_RECOMPUTE_INJECTION,
                reasons=tuple(scope_reasons),
                notice=NOTICE_REVALIDATION_REQUIRED,
                clinical_signal_count=len(held_verdict.clinical),
                detail={"segmentVerdictsOffered": offered},
            )

        # --- the verdict itself. Axis 3 is not consulted; see `verdict.py`. --
        if held_verdict.gates_derivations:
            return ConsumptionDecision(
                allowed=False,
                action=ACTION_BLOCK,
                reasons=held_verdict.gating_reasons,
                notice=NOTICE_SEGMENT_EXCLUDED,
                clinical_signal_count=len(held_verdict.clinical),
                detail={"segmentVerdictsOffered": offered},
            )

        return ConsumptionDecision(
            allowed=True,
            action=ACTION_ALLOW,
            clinical_signal_count=len(held_verdict.clinical),
            detail={"segmentVerdictsOffered": offered},
        )

    # -- helpers ------------------------------------------------------------

    @staticmethod
    def _revalidate(reasons: tuple[str, ...], offered: int) -> ConsumptionDecision:
        return ConsumptionDecision(
            allowed=False,
            action=ACTION_REVALIDATE_CUMULATIVE,
            reasons=reasons,
            notice=NOTICE_REVALIDATION_REQUIRED,
            detail={"segmentVerdictsOffered": offered},
        )
