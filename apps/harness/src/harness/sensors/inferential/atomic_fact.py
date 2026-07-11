"""Reference-free atomic-fact verifier — a deterministic, model-cheap groundedness gate.

TASK-481 (E2, SOTA S3-F2). A **second, deterministic** groundedness signal that runs
**alongside** the LLM-``JudgeClient`` :mod:`~harness.sensors.inferential.groundedness`
sensor (defense-in-depth) — it does **NOT** replace it. Where groundedness asks a
non-deterministic LLM judge to entail each provenance ``citationsMap`` claim, this
verifier is **reference-free** (it decomposes the *note itself* into atomic claims — no
gold reference, no provenance dependency) and **deterministic** (a self-hosted NLI whose
argmax verdict is byte-identical for identical input — no temperature, no sampling).

Two stages, both self-hosted / hermetic:

1. **Decomposition** (:func:`decompose_claims`) — split the generated note into atomic,
   sentence-level factual claims with pure, rule-based logic (**no model**). SOAP-JSON
   notes are decomposed per section; plain prose is split on sentence boundaries.
2. **Entailment** — each atomic claim is entailed against the consultation transcript by
   an injected :class:`NliEntailer` — a **self-hosted deterministic NLI** (MiniCheck /
   AlignScore / HHEM-class), NOT the LLM ``JudgeClient``. :class:`DeterministicOverlapEntailer`
   is the model-free default (a salient-token overlap check); a real self-hosted NLI model
   slots in behind the same interface once provisioned.

``score`` is the grounded fraction; ``passed`` is ``score >= threshold``; ``claims_flagged``
lists the ungrounded atomic claims. **Fail-safe by contract**: a note with claims but no
transcript to verify against, or an entailer backend error, returns a ``degraded`` result
(``passed=False``) — the gate **never** silently affirms a claim it could not verify.
"""

from __future__ import annotations

import re
from typing import Protocol, runtime_checkable

from harness.eval.jsonio import loads_json
from harness.sensors.base import SensorContext, SensorResult, dedupe, normalize_text
from harness.sensors.inferential.base import degraded_result

NAME = "atomic_fact"

# Deterministic sentence-boundary split for atomic-claim decomposition (NO model): break
# on sentence terminators, semicolons, and newlines. A clause-level proxy for "atomic".
_SENTENCE_SPLIT = re.compile(r"[.;\n!?]+")

# Common / structural tokens carry no grounding signal, so they are excluded from the
# overlap check — otherwise a fabricated entity ("warfarin") would be masked by the
# shared filler around it. Kept deliberately small + clinical-neutral (the real NLI model
# handles semantics; this is the hermetic model-free default).
_STOPWORDS = frozenset(
    {
        "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by",
        "is", "are", "was", "were", "be", "been", "being", "has", "have", "had", "as",
        "patient", "reports", "report", "reported", "notes", "noted", "states", "stated",
        "no", "not", "denies", "denied", "history", "also", "this", "that", "these",
        "those", "he", "she", "they", "his", "her", "their", "it", "its", "over",
    }
)


@runtime_checkable
class NliEntailer(Protocol):
    """A self-hosted **deterministic** NLI entailment backend (MiniCheck / AlignScore /
    HHEM-class) — **NOT** the LLM ``JudgeClient``.

    ``entail(premise, hypothesis)`` returns ``True`` iff the premise entails the
    hypothesis. Implementations MUST be deterministic (argmax at temperature 0 / an
    exact rule) so the same input yields a byte-identical verdict, and self-hosted (no
    cloud egress of clinical text). A backend outage should raise — the sensor catches
    it and degrades (never auto-PASS).
    """

    async def entail(self, premise: str, hypothesis: str) -> bool:
        """Return ``True`` iff ``premise`` entails ``hypothesis`` (deterministic)."""
        ...


def _salient_tokens(text: str) -> list[str]:
    """Normalized content tokens (>= 3 chars, non-stopword) that carry grounding signal."""
    return [t for t in normalize_text(text).split() if len(t) >= 3 and t not in _STOPWORDS]


class DeterministicOverlapEntailer:
    """Model-free, deterministic reference-free consistency entailer (the hermetic default).

    A hypothesis is entailed when at least ``min_overlap`` of its *salient* (normalized,
    non-stopword, >= 3-char) tokens appear in the premise. This is a cheap, self-hosted,
    **byte-deterministic** grounding proxy that calls **no model and no network** — a
    claim whose salient content (e.g. a fabricated drug name) is absent from the transcript
    is not entailed. It is the default entailer until a real self-hosted NLI model
    (MiniCheck / AlignScore / HHEM) is provisioned and injected behind :class:`NliEntailer`.

    ``min_overlap`` defaults to 1.0 (every salient token must be grounded) — the fail-safe
    setting: this over-flags a paraphrase rather than under-flagging a fabrication, and a
    flag drives a clinician-reviewable REGEN/FLAG, never a silent affirmation.
    """

    def __init__(self, min_overlap: float = 1.0) -> None:
        if not (0.0 <= min_overlap <= 1.0):
            raise ValueError("min_overlap must be within [0, 1]")
        self._min_overlap = min_overlap

    async def entail(self, premise: str, hypothesis: str) -> bool:
        hyp_tokens = _salient_tokens(hypothesis)
        if not hyp_tokens:
            # A claim with no salient content asserts nothing checkable -> vacuously grounded
            # (the claim-count / substantive filter in decompose_claims already drops empties).
            return True
        premise_tokens = set(_salient_tokens(premise))
        matched = sum(1 for t in hyp_tokens if t in premise_tokens)
        return (matched / len(hyp_tokens)) >= self._min_overlap


def _section_texts(text: str) -> list[str]:
    """The prose blocks to decompose: SOAP-JSON section values, or the raw text.

    The harness note is a SOAP JSON string (``{"subjective": ..., "plan": ...}``); parse
    it (tolerantly) and decompose each string section. A non-JSON note is decomposed as
    plain prose. Deterministic — no model.
    """
    stripped = text.strip()
    if not stripped:
        return []
    try:
        parsed = loads_json(stripped)
    except ValueError:
        parsed = None
    if isinstance(parsed, dict):
        return [str(v) for v in parsed.values() if isinstance(v, str) and v.strip()]
    if isinstance(parsed, list):
        return [str(v) for v in parsed if isinstance(v, str) and v.strip()]
    return [stripped]


def _is_substantive(claim: str) -> bool:
    """A claim is worth verifying only if it carries at least one content token (>= 2 chars)."""
    return any(len(t) >= 2 for t in normalize_text(claim).split())


def decompose_claims(text: str) -> list[str]:
    """Decompose a note into atomic, sentence-level factual claims (deterministic, NO model).

    Order-preserving. SOAP-JSON section values (and plain prose) are split on sentence
    boundaries; trivial/empty fragments are dropped. This is the reference-free
    decomposition step — it needs no reference summary and no model.
    """
    claims: list[str] = []
    for section in _section_texts(text):
        for part in _SENTENCE_SPLIT.split(section):
            claim = part.strip()
            if claim and _is_substantive(claim):
                claims.append(claim)
    return claims


class AtomicFactSensor:
    """Score = entailed atomic claims / total atomic claims, via the injected NLI.

    Reference-free + deterministic + **no ``JudgeClient``**. Decomposes the note into
    atomic claims and entails each against the transcript with the injected
    :class:`NliEntailer`. Fail-safe: no transcript to verify against, or a backend error,
    returns a ``degraded`` result (never an auto-PASS, never an exception into the loop).
    """

    name = NAME

    def __init__(self, nli: NliEntailer, threshold: float = 0.8) -> None:
        self._nli = nli
        self.threshold = threshold

    async def arun(self, ctx: SensorContext) -> SensorResult:
        claims = decompose_claims(ctx.note_blob())
        if not claims:
            # No verifiable claims -> vacuously grounded (mirrors groundedness' vacuous pass).
            return SensorResult(
                name=NAME,
                score=1.0,
                passed=True,
                details={"total": 0, "grounded": 0, "ungrounded": []},
            )

        premise = ctx.transcript_text
        if not premise.strip():
            # Claims asserted but nothing to verify against -> cannot verify -> degrade.
            return degraded_result(
                NAME,
                "no transcript to verify atomic claims against",
                claims_flagged=dedupe(claims),
            )

        grounded: list[str] = []
        ungrounded: list[str] = []
        try:
            # Sequential, in claim order -> byte-deterministic verdict (AC-2). The NLI is a
            # local/self-hosted call, so serial iteration is cheap and maximally reproducible.
            for claim in claims:
                if await self._nli.entail(premise, claim):
                    grounded.append(claim)
                else:
                    ungrounded.append(claim)
        except Exception as exc:  # noqa: BLE001 — backend failure degrades, never raises
            return degraded_result(NAME, f"atomic-fact NLI unavailable: {exc}")

        total = len(claims)
        score = len(grounded) / total
        flagged = dedupe(ungrounded)
        return SensorResult(
            name=NAME,
            score=score,
            passed=score >= self.threshold,
            claims_flagged=flagged,
            details={"total": total, "grounded": len(grounded), "ungrounded": flagged},
        )
