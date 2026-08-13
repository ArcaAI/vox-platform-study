"""Entity-level grounding by entailment, escalated from the lexical floor.

The two computational entity sensors (:mod:`harness.sensors.computational.entity_faithfulness`
and :mod:`~harness.sensors.computational.coverage_omission`) are pure lexical matchers.
That costs a **0.944 absolute / 94.4% relative** penalty on
clinically correct but abstracted notes — writing ``paracetamol`` where the transcript said
``Tylenol`` reads as a fabrication, and the disappearance of ``Tylenol`` reads as a separate
omission. This sensor is the fix, and its shape is dictated by the constraint
attached to it: **the lexical thresholds must not be lowered and the matchers must not be
fuzzed**, because loosening them enough to admit a generic-drug substitution loosens them by
exactly the amount that also admits a hallucinated drug name.

**Escalation, not replacement.** The lexical match runs first and unchanged — it remains the
floor. Only the entities it could not ground (the *residue*) are escalated to entailment, and
entailment can only ever *withdraw* a flag, never create one. Consequences:

* An over-permissive entailer cannot manufacture a false FLAG.
* A hallucinated entity must survive both checks to reach PASS.
* The common case (a note that reuses transcript wording) has an empty residue and costs
  nothing — no backend call is made at all.

**Symmetry closes the recall gap.** Every existing inferential sensor asks note → transcript
(*is what the note says supported?*). Omission is the opposite question. Both are the same
computation with the premise swapped, so one class serves both directions:

=================== ========================== =========================
direction            hypothesis                  premise
=================== ========================== =========================
``FAITHFULNESS``     a **note** entity           the transcript
``COVERAGE``         a **transcript** entity     the note
=================== ========================== =========================

**Deliberate deviation from its sibling inferential sensors: this one does NOT degrade.**
`groundedness` / `atomic_fact` return :func:`degraded_result` on backend failure, which the
aggregator turns into a blanket FLAG. Doing that here would be strictly worse than today —
the incumbent lexical sensor is in ``HIGHEST_HARM_SENSORS``, so making an entailment backend
load-bearing on it converts every outage into a FLAG-everything event, and it would also
escalate the coverage direction from REGEN to FLAG. Instead, a backend failure **falls back
to the lexical verdict** and records ``escalation_unavailable`` in ``details``. That can only
ever produce *more* flags than a successful escalation, never fewer, so it is fail-safe in
the direction that matters: an outage costs recovered abstraction, never added safety.
"""

from __future__ import annotations

from enum import StrEnum

from harness.sensors.base import SensorContext, SensorResult, dedupe, normalize_text
from harness.sensors.inferential.atomic_fact import NliEntailer

NAME_FAITHFULNESS = "entity_faithfulness_inferential"
NAME_COVERAGE = "coverage_omission_inferential"


class Direction(StrEnum):
    """Which way the grounding question runs."""

    FAITHFULNESS = "faithfulness"
    COVERAGE = "coverage"


def frame_entity(entity_text: str) -> str:
    """Frame a bare entity as an entailment hypothesis.

    An NER span is a noun phrase (``bilateral peripheral oedema``), and a noun phrase is not
    a proposition — an entailment backend needs something that can be true or false. This is
    the whole adapter between the entity-level sensors and the claim-level inferential lane,
    and the framing measurably affects verdicts, so it is a single named pure function rather
    than an inline f-string: the framing ablation (Q2) varies exactly this.

    Kept deliberately minimal and clinically neutral — it asserts only that the concept is
    part of this consultation's record, which is precisely the question both directions ask.
    """
    return f"The consultation record includes {entity_text.strip()}."


class EntityGroundingSensor:
    """Lexical floor + entailment on the residue, in one direction.

    ``score`` is the grounded fraction over the same denominator the incumbent lexical sensor
    uses, so the two are directly comparable and the incumbent's threshold applies unchanged.
    """

    def __init__(
        self,
        entailer: NliEntailer,
        *,
        direction: Direction,
        threshold: float,
    ) -> None:
        self._entailer = entailer
        self._direction = direction
        self.threshold = threshold
        self.name = (
            NAME_FAITHFULNESS if direction is Direction.FAITHFULNESS else NAME_COVERAGE
        )

    def _hypotheses_and_premise(self, ctx: SensorContext) -> tuple[list[str], str, set[str]]:
        """The entities to check, the premise to check them against, and the lexical haystack.

        Mirrors each incumbent sensor's own selection exactly — including the faithfulness
        sensor's exclusion of ABSENT (negated) spans, since "no chest pain" is not a positive
        claim requiring grounding.
        """
        if self._direction is Direction.FAITHFULNESS:
            checked = [e for e in ctx.note_entities if e.normalized and not e.is_absent]
            premise = ctx.transcript_text
            support_texts = {e.normalized for e in ctx.transcript_entities if e.normalized}
            haystack = normalize_text(ctx.transcript_text)
        else:
            checked = [e for e in ctx.transcript_entities if e.normalized]
            premise = ctx.note_blob()
            support_texts = {e.normalized for e in ctx.note_entities if e.normalized}
            haystack = normalize_text(ctx.note_blob())

        lexically_grounded = {
            e.text
            for e in checked
            if e.normalized in support_texts or e.normalized in haystack
        }
        return [e.text for e in checked], premise, lexically_grounded

    async def arun(self, ctx: SensorContext) -> SensorResult:
        checked, premise, lexically_grounded = self._hypotheses_and_premise(ctx)
        if not checked:
            return SensorResult(
                name=self.name,
                score=1.0,
                passed=True,
                details={"total": 0, "grounded": 0, "ungrounded": [], "escalated": 0},
            )

        residue = [text for text in checked if text not in lexically_grounded]

        # Nothing to escalate: the lexical floor already grounded everything. Byte-identical
        # to the incumbent's pass, and no backend is touched.
        if not residue:
            return self._result(checked, set(checked), escalated=0, unavailable=False)

        # A premise we cannot read verifies nothing. Fall back to lexical rather than
        # affirming — same posture as the incumbent's own no-transcript degradation.
        if not premise.strip():
            return self._result(checked, lexically_grounded, escalated=0, unavailable=True)

        recovered: set[str] = set()
        try:
            # Sequential, in entity order, so the verdict is reproducible for a
            # deterministic backend (the NliEntailer contract).
            for text in residue:
                if await self._entailer.entail(premise, frame_entity(text)):
                    recovered.add(text)
        except Exception:  # noqa: BLE001 — backend failure falls back to lexical, never raises
            return self._result(checked, lexically_grounded, escalated=0, unavailable=True)

        return self._result(
            checked,
            lexically_grounded | recovered,
            escalated=len(residue),
            unavailable=False,
            recovered=recovered,
        )

    def _result(
        self,
        checked: list[str],
        grounded: set[str],
        *,
        escalated: int,
        unavailable: bool,
        recovered: set[str] | None = None,
    ) -> SensorResult:
        ungrounded = dedupe(t for t in checked if t not in grounded)
        score = (len(checked) - len(set(ungrounded))) / len(checked)
        details: dict[str, object] = {
            "total": len(checked),
            "grounded": len(checked) - len(set(ungrounded)),
            "ungrounded": ungrounded,
            "escalated": escalated,
            "recovered_by_entailment": sorted(recovered or ()),
            "direction": str(self._direction),
        }
        if unavailable:
            # The lexical verdict stands. Recorded so a run can be told apart from one where
            # entailment ran and simply agreed — otherwise a silent outage looks like a clean
            # lexical pass in the trajectory.
            details["escalation_unavailable"] = True
        return SensorResult(
            name=self.name,
            score=score,
            passed=score >= self.threshold,
            claims_flagged=ungrounded,
            details=details,
        )
