"""Citation-verify inferential sensor — per-claim entailment vs the CITED chunk.

Forked from :mod:`harness.sensors.inferential.groundedness` (plan §E). Where
groundedness entails each claim against the consultation transcript, citation-verify
entails each *cited* claim against the **institutional knowledge chunk(s) it cited**
— i.e. it checks that a StrictCitations citation actually supports the statement.

Scope: only claims carrying ``knowledgeChunkIds`` are verified (uncited claims are
groundedness' job). ``score`` is the supported fraction over those cited claims;
``passed`` is ``score >= threshold`` (constructor-injected). A claim whose cited id
cannot be resolved to chunk text is **unverifiable** and fails (never auto-PASS a
citation we cannot check). A judge-backend failure returns :func:`degraded_result`
(``degraded=True`` + ``passed=False``) so the loop can surface the "unverified"
badge; it never raises into the durable workflow.
"""

from __future__ import annotations

from typing import Any

from harness.eval.judge.base import JudgeClient
from harness.sensors.base import SensorContext, SensorResult, dedupe
from harness.sensors.inferential.base import degraded_result
from harness.sensors.inferential.groundedness import (
    _claim_ref,
    _is_supported,
    _section_code,
)
from harness.sensors.inferential.verdict_cache import (
    VerdictCache,
    cached_verdict,
    claim_verdict_key,
    sensor_identity,
)

NAME = "citation_verify"

_SYSTEM_PROMPT = (
    "You are a meticulous clinical citation auditor. Decide whether the HYPOTHESIS "
    "(a statement taken from a generated clinical note) is fully supported by the "
    "PREMISE (the institutional reference text the note cited for that statement). "
    "The hypothesis is supported only if every clinical assertion in it is stated in, "
    "or directly entailed by, the cited premise; unstated or contradicted assertions "
    'are NOT supported. Respond ONLY with a JSON object: {"supported": true} or '
    '{"supported": false}.'
)


def _cited_ids(claim: dict[str, Any]) -> list[str]:
    raw = claim.get("knowledgeChunkIds")
    if not isinstance(raw, list):
        return []
    return [str(cid) for cid in raw if cid]


def _premise(ctx: SensorContext, ids: list[str]) -> str:
    """The cited chunks' text (ONLY) — the institutional grounding for this claim."""
    parts = [ctx.knowledge_chunks.get(cid, "") for cid in ids]
    return "\n\n".join(p for p in parts if p)


def _entailment_messages(premise: str, hypothesis: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": f"PREMISE:\n{premise}\n\nHYPOTHESIS:\n{hypothesis}"},
    ]


def _vacuous_pass() -> SensorResult:
    """No cited claims -> nothing to citation-verify (vacuously passes)."""
    return SensorResult(
        name=NAME,
        score=1.0,
        passed=True,
        details={"total": 0, "supported": 0, "unverified": [], "sections": []},
    )


class CitationVerifySensor:
    """Score = supported cited-claims / total cited-claims, via the injected judge."""

    name = NAME

    def __init__(self, threshold: float = 0.8) -> None:
        self.threshold = threshold

    async def arun(
        self,
        ctx: SensorContext,
        *,
        judge: JudgeClient,
        verdict_cache: VerdictCache | None = None,
    ) -> SensorResult:
        cited = [c for c in ctx.claims() if _cited_ids(c)]
        if not cited:
            return _vacuous_pass()

        # TASK-359 WS-2: reuse the WS-1 content key — keyed on this sensor's OWN premise (the
        # cited chunk(s), NOT the transcript) + its own identity, so a dually-checked cited claim
        # gets a citation_verify entry DISTINCT from its groundedness entry (different premise +
        # sensor/prompt) and the two verdicts stay separable. NO prompt merge (parity-unsafe).
        identity = sensor_identity(NAME, _SYSTEM_PROMPT, judge.model)

        supported: list[str] = []
        unverified: list[str] = []
        unverified_sections: list[str] = []
        try:
            for claim in cited:
                ref = _claim_ref(claim)
                hypothesis = str(claim.get("text") or "").strip()
                premise = _premise(ctx, _cited_ids(claim))
                ok = False
                if hypothesis and premise:
                    key = claim_verdict_key(
                        claim_text=hypothesis, premise=premise, judge_identity=identity
                    )

                    async def _judge_once(_premise: str = premise, _hyp: str = hypothesis) -> bool:
                        raw = await judge.complete(
                            _entailment_messages(_premise, _hyp),
                            json_mode=True,
                            temperature=0.0,
                        )
                        try:
                            return _is_supported(raw)
                        except ValueError:
                            return False  # unparseable -> not confirmed (conservative)

                    # HIT reuses the cached verdict; MISS re-judges (conservative) + populates.
                    # The cached bool is byte-identical to a fresh judgement (AC-2) and flows
                    # unchanged into the scoring below — citation_verify stays separable.
                    ok = await cached_verdict(verdict_cache, key=key, compute=_judge_once)
                # No premise (unresolvable cited id) or empty hypothesis -> unverifiable.
                if ok:
                    supported.append(ref)
                else:
                    unverified.append(ref)
                    code = _section_code(claim.get("section"))
                    if code:
                        unverified_sections.append(code)
        except Exception as exc:  # noqa: BLE001 — backend failure degrades, never raises
            return degraded_result(NAME, f"citation-verify judge unavailable: {exc}")

        total = len(cited)
        score = len(supported) / total
        return SensorResult(
            name=NAME,
            score=score,
            passed=score >= self.threshold,
            claims_flagged=dedupe(unverified),
            details={
                "total": total,
                "supported": len(supported),
                "unverified": dedupe(unverified),
                "sections": sorted(set(unverified_sections)),
            },
        )
