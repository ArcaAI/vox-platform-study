"""Groundedness inferential sensor — per-claim entailment via the shared judge.

Semantic counterpart to the deterministic provenance sensors: every
``citationsMap`` claim is entailment-checked against (the consultation transcript
∪ that claim's own cited evidence) using the calibrated, constructor-agnostic
:class:`~harness.eval.judge.base.JudgeClient` (passed per-call to :meth:`arun`, so
the Temporal activity builds it once and fans it out). ``score`` is the grounded
fraction; ``passed`` is ``score >= threshold`` (the threshold is injected at
construction, mirroring the computational sensors); ``claims_flagged`` lists the
ungrounded claim ids.

It additionally derives a **RAG triad** — *context-relevance* (was grounding
context actually attached), *groundedness* (the judge-entailment fraction), and
*answer-relevance* (does the note assert content) — and stashes ``rag_triad_score``
+ the breakdown + the offending SOAP ``sections`` in ``details`` so the later
persistence phase can write ``ragTriadScore`` and a regen can target the right
sections. A judge-backend failure returns :func:`degraded_result` (never an
auto-PASS, never an exception into the durable loop); a single unparseable verdict
is treated conservatively as ungrounded.
"""

from __future__ import annotations

from typing import Any

from harness.eval.jsonio import loads_json
from harness.eval.judge.base import JudgeClient
from harness.sensors.base import SensorContext, SensorResult, dedupe
from harness.sensors.inferential.base import degraded_result

NAME = "groundedness"

# SOAP full-name -> single-letter section code (matches provenance + the aggregator's
# DEFAULT_SOAP_SECTIONS so an emitted ``sections`` entry can drive a targeted regen).
_SOAP_CODES = {"subjective": "S", "objective": "O", "assessment": "A", "plan": "P"}

_SYSTEM_PROMPT = (
    "You are a meticulous clinical fact-checking judge. Decide whether the HYPOTHESIS "
    "(a statement taken from a generated clinical note) is fully supported by the PREMISE "
    "(the source consultation transcript and any cited evidence). The hypothesis is "
    "supported only if every clinical assertion in it is stated in, or directly entailed "
    "by, the premise; unstated or contradicted assertions are NOT supported. Respond ONLY "
    'with a JSON object: {"supported": true} or {"supported": false}.'
)


def _claim_ref(claim: dict[str, Any]) -> str:
    """Stable claim reference (id, else text) used for flagged-claim lists."""
    return str(claim.get("id") or claim.get("text") or "<unknown-claim>")


def _section_code(raw: Any) -> str:
    """Normalize a claim ``section`` to an S/O/A/P code (``""`` if unknown)."""
    section = str(raw or "").strip()
    if not section:
        return ""
    code = _SOAP_CODES.get(section.lower(), section.upper())
    return code if code in {"S", "O", "A", "P"} else ""


def _has_evidence(claim: dict[str, Any]) -> bool:
    evidence = claim.get("evidence")
    if not isinstance(evidence, list):
        return False
    return any(bool(ev) for ev in evidence)


def _evidence_quotes(claim: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for ev in claim.get("evidence") or []:
        if isinstance(ev, dict):
            quote = ev.get("quote")
            if quote:
                out.append(str(quote))
    return out


def _premise(ctx: SensorContext, claim: dict[str, Any]) -> str:
    """Build the entailment premise: the transcript ∪ this claim's evidence quotes."""
    parts: list[str] = []
    if ctx.transcript_text.strip():
        parts.append(ctx.transcript_text)
    parts.extend(_evidence_quotes(claim))
    return "\n\n".join(parts)


def _entailment_messages(premise: str, hypothesis: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": f"PREMISE:\n{premise}\n\nHYPOTHESIS:\n{hypothesis}"},
    ]


def _is_supported(raw: str) -> bool:
    """Parse a judge verdict into a boolean (tolerant of reasoning-wrapped JSON)."""
    obj = loads_json(raw)  # raises ValueError when no JSON object is present
    if not isinstance(obj, dict):
        return False
    value = obj.get("supported", obj.get("grounded", obj.get("entailed")))
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "yes", "supported", "grounded", "entailed"}
    return False


def _vacuous_pass() -> SensorResult:
    """No claims to verify -> vacuously grounded (citation_presence owns the
    'note but no claims' degradation, so groundedness need not duplicate it)."""
    return SensorResult(
        name=NAME,
        score=1.0,
        passed=True,
        details={
            "total": 0,
            "grounded": 0,
            "ungrounded": [],
            "rag_triad_score": 1.0,
            "rag_triad": {"context_relevance": 1.0, "groundedness": 1.0, "answer_relevance": 1.0},
            "sections": [],
        },
    )


class GroundednessSensor:
    """Score = entailed claims / total claims, via the injected judge."""

    name = NAME

    def __init__(self, threshold: float = 0.8) -> None:
        self.threshold = threshold

    async def arun(self, ctx: SensorContext, *, judge: JudgeClient) -> SensorResult:
        claims = ctx.claims()
        if not claims:
            return _vacuous_pass()

        grounded: list[str] = []
        ungrounded: list[str] = []
        ungrounded_sections: list[str] = []
        try:
            for claim in claims:
                ref = _claim_ref(claim)
                hypothesis = str(claim.get("text") or "").strip()
                if not hypothesis:
                    # An empty claim asserts nothing -> nothing to fabricate.
                    grounded.append(ref)
                    continue
                messages = _entailment_messages(_premise(ctx, claim), hypothesis)
                raw = await judge.complete(messages, json_mode=True, temperature=0.0)
                try:
                    supported = _is_supported(raw)
                except ValueError:
                    supported = False  # unparseable -> not confirmed grounded (conservative)
                if supported:
                    grounded.append(ref)
                else:
                    ungrounded.append(ref)
                    code = _section_code(claim.get("section"))
                    if code:
                        ungrounded_sections.append(code)
        except Exception as exc:  # noqa: BLE001 — backend failure degrades, never raises
            return degraded_result(NAME, f"groundedness judge unavailable: {exc}")

        total = len(claims)
        groundedness = len(grounded) / total
        context_relevance = sum(1 for c in claims if _has_evidence(c)) / total
        answer_relevance = sum(1 for c in claims if str(c.get("text") or "").strip()) / total
        rag_triad_score = (context_relevance + groundedness + answer_relevance) / 3
        sections = sorted(set(ungrounded_sections))

        return SensorResult(
            name=NAME,
            score=groundedness,
            passed=groundedness >= self.threshold,
            claims_flagged=dedupe(ungrounded),
            details={
                "total": total,
                "grounded": len(grounded),
                "ungrounded": dedupe(ungrounded),
                "rag_triad_score": round(rag_triad_score, 6),
                "rag_triad": {
                    "context_relevance": round(context_relevance, 6),
                    "groundedness": round(groundedness, 6),
                    "answer_relevance": round(answer_relevance, 6),
                },
                "sections": sections,
            },
        )
