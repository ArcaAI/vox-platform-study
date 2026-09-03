"""RAGAS-style faithfulness for clinical summaries.

Faithfulness = (# claims supported by the context) / (# total claims), computed
by **claim decomposition** (split the note into atomic factual statements) +
**per-claim support checking** (does the transcript/evidence entail the claim?).
This mirrors RAGAS's faithfulness metric and the entity/claim-level entailment
approach that dominates clinical groundedness work (research doc 06).

Both steps are model-agnostic — they run through a
:class:`~harness.eval.judge.base.JudgeClient`, so the same local ≤20B model
(or Azure/Bedrock, or a tiny NLI verifier like MiniCheck/HHEM swapped in later)
can drive them. Everything is injectable for offline, deterministic tests.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

import structlog

from harness.eval.jsonio import loads_json
from harness.eval.judge.base import JudgeClient
from harness.eval.models import FaithfulnessResult, GoldenCase

logger = structlog.get_logger(__name__)

_CLAIM_SYSTEM = (
    "You decompose a clinical summary into atomic, self-contained factual claims. "
    "Each claim asserts exactly one fact (a diagnosis, medication, dose, finding, or plan)."
)
_CLAIM_USER = (
    "Decompose the SUMMARY below into a JSON object of the form "
    '{{"claims": ["claim 1", "claim 2", ...]}}. Resolve pronouns; one fact per claim. '
    "Return ONLY JSON.\n\nCONTEXT (for reference only):\n{context}\n\nSUMMARY:\n{answer}"
)

_VERIFY_SYSTEM = (
    "You are a clinical fact-checker. Decide whether the CONTEXT supports (entails) the CLAIM. "
    "A claim is supported only if it can be directly inferred from the context."
)
_VERIFY_USER = (
    'Respond with ONLY JSON of the form {{"supported": true|false, "reason": "..."}}.\n\n'
    "CONTEXT:\n{context}\n\nCLAIM:\n{claim}"
)


@runtime_checkable
class ClaimExtractor(Protocol):
    async def extract(self, answer: str, context: str) -> list[str]: ...


@runtime_checkable
class ClaimVerifier(Protocol):
    async def verify(self, claim: str, context: str) -> bool: ...


class LLMClaimExtractor:
    """Decomposes a summary into atomic claims via a judge client."""

    def __init__(self, client: JudgeClient) -> None:
        self._client = client

    async def extract(self, answer: str, context: str) -> list[str]:
        messages = [
            {"role": "system", "content": _CLAIM_SYSTEM},
            {"role": "user", "content": _CLAIM_USER.format(context=context, answer=answer)},
        ]
        raw = await self._client.complete(messages, json_mode=True)
        try:
            parsed = loads_json(raw)
        except ValueError:
            # A genuinely unparseable decomposition (e.g. a small local judge
            # emitting truncated/malformed JSON — reproduced live)
            # degrades to "no claims" rather than crashing the whole eval run:
            # the same vacuous-truth convention `evaluate()` already applies
            # when the model legitimately extracts zero claims.
            logger.warning("claim_extraction_unparseable", raw_response=raw[:200])
            return []
        if isinstance(parsed, dict):
            claims = parsed.get("claims", [])
        elif isinstance(parsed, list):
            claims = parsed
        else:
            claims = []
        return [str(c).strip() for c in claims if str(c).strip()]


class LLMClaimVerifier:
    """Checks whether the context entails a claim via a judge client."""

    def __init__(self, client: JudgeClient) -> None:
        self._client = client

    async def verify(self, claim: str, context: str) -> bool:
        messages = [
            {"role": "system", "content": _VERIFY_SYSTEM},
            {"role": "user", "content": _VERIFY_USER.format(context=context, claim=claim)},
        ]
        raw = await self._client.complete(messages, json_mode=True)
        try:
            parsed = loads_json(raw)
        except ValueError:
            # A claim we can't parse a verdict for has no evidence of support —
            # fail CLOSED to unsupported (never raise, never count as
            # supported). Reproduced live against a real small local judge
            # an occasional malformed verify response previously
            # propagated a raw JSONDecodeError and crashed the entire eval-gate
            # run instead of degrading this one claim.
            logger.warning("claim_verification_unparseable", raw_response=raw[:200])
            return False
        if isinstance(parsed, dict):
            return bool(parsed.get("supported", False))
        return False


class FaithfulnessEvaluator:
    """Computes RAGAS-style faithfulness for a golden case."""

    def __init__(self, extractor: ClaimExtractor, verifier: ClaimVerifier) -> None:
        self._extractor = extractor
        self._verifier = verifier

    async def evaluate(self, case: GoldenCase) -> FaithfulnessResult:
        context = "\n\n".join(case.faithfulness_contexts())
        claims = await self._extractor.extract(case.generated_note, context)

        if not claims:
            # No verifiable claims → nothing can be unfaithful (RAGAS edge case).
            return FaithfulnessResult(
                case_id=case.case_id, score=1.0, supported_claims=0, total_claims=0
            )

        supported: list[str] = []
        unsupported: list[str] = []
        for claim in claims:
            if await self._verifier.verify(claim, context):
                supported.append(claim)
            else:
                unsupported.append(claim)

        return FaithfulnessResult(
            case_id=case.case_id,
            score=len(supported) / len(claims),
            supported_claims=len(supported),
            total_claims=len(claims),
            claims=claims,
            unsupported=unsupported,
        )


def build_faithfulness_evaluator(client: JudgeClient) -> FaithfulnessEvaluator:
    """Wire an LLM extractor + verifier over a single judge client."""
    return FaithfulnessEvaluator(LLMClaimExtractor(client), LLMClaimVerifier(client))
