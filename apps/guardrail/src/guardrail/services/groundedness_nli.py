"""Self-hosted NLI groundedness verifier — the live output gate core.

Sentence/claim-vs-source entailment over ``(summary_segment, transcript)``: the generated
running note is split into deterministic segments, each segment is scored against the source
transcript by a self-hosted NLI scorer (MiniCheck / Flan-T5-Large class — chosen over the
durable harness JudgeClient sensor for the >500 docs/min live-loop target), and per-segment
verdicts + flagged spans are returned so ungrounded text can be MARKED before a clinician
reads it.

Fail posture (pairs with the input-side gate): FAIL-CLOSED throughout —

* gate disabled (dev/CI bypass)          → every segment ``unverified``
* NLI model un-staged / un-loadable      → every segment ``unverified``
* scorer error / malformed scorer output → every segment ``unverified``

No code path may ever return ``grounded`` for a segment the model did not actually entail.

PHI hygiene: this module NEVER logs summary or transcript text — counts/sizes/reasons only.

The scorer is injectable (``NliScorer`` protocol) so tests run hermetically with a tiny
deterministic stub. The production MiniCheck-class scorer requires the model staged on the
host (see ``load_default_scorer``); until it is staged the default factory raises
``NliModelUnavailableError`` and the gate degrades honestly.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol

from guardrail.core.config import GroundednessConfig
from guardrail.core.logging import get_logger

logger = get_logger(__name__)

Verdict = Literal["grounded", "ungrounded", "unverified"]

GROUNDED: Verdict = "grounded"
UNGROUNDED: Verdict = "ungrounded"
UNVERIFIED: Verdict = "unverified"

REASON_CHECKED = "checked"
REASON_DISABLED = "groundedness_disabled"
REASON_MODEL_UNAVAILABLE = "nli_model_unavailable"
REASON_ERROR = "nli_error"


class NliModelUnavailableError(RuntimeError):
    """The self-hosted NLI model cannot be loaded on this host."""


class NliScorer(Protocol):
    """Entailment scorer contract: ``p(claim entailed by source)`` per (source, claim) pair.

    Implementations MUST be deterministic and self-hosted (no network egress of clinical
    text — track guardrail). Scores are in ``[0, 1]`` and returned in input order.
    """

    def score_pairs(self, pairs: Sequence[tuple[str, str]]) -> Sequence[float]:
        """Return one entailment score per ``(source, claim)`` pair, in order."""
        ...


@dataclass
class SegmentVerdict:
    """Verdict for one summary segment; ``start``/``end`` index the ORIGINAL summary."""

    text: str
    verdict: Verdict
    start: int
    end: int
    score: float | None = None


@dataclass
class GroundednessResult:
    """Per-segment verdicts for one ``(summary, transcript)`` verification."""

    segments: list[SegmentVerdict] = field(default_factory=list)
    checked: bool = False
    reason: str = REASON_ERROR
    model_id: str = ""
    elapsed_ms: float = 0.0
    throughput_docs_per_min: float | None = None

    @property
    def flagged_spans(self) -> list[tuple[int, int]]:
        """Offsets (into the original summary) of the UNGROUNDED segments."""
        return [(s.start, s.end) for s in self.segments if s.verdict == UNGROUNDED]


_SEGMENT_BOUNDARY = re.compile(r"(?<=[.!?])\s+|\n+")


def split_segments(summary: str) -> list[tuple[str, int, int]]:
    """Deterministic sentence/line segmentation with exact char offsets.

    Splits on sentence terminators (``.!?`` + whitespace) and newlines; returns
    ``(text, start, end)`` triples where ``summary[start:end] == text`` (text is
    stripped, offsets adjusted accordingly). Pure and dependency-free so the
    degrade paths can always enumerate segments even when no model is loadable.
    """
    segments: list[tuple[str, int, int]] = []
    position = 0
    boundaries = [(m.start(), m.end()) for m in _SEGMENT_BOUNDARY.finditer(summary)]
    boundaries.append((len(summary), len(summary)))
    for boundary_start, boundary_end in boundaries:
        raw = summary[position:boundary_start]
        stripped = raw.strip()
        if stripped:
            start = position + (len(raw) - len(raw.lstrip()))
            segments.append((stripped, start, start + len(stripped)))
        position = boundary_end
    return segments


def load_default_scorer(config: GroundednessConfig) -> NliScorer:
    """Production scorer factory — the self-hosted MiniCheck-Flan-T5 GGUF (llama.cpp).

    Delegates to ``load_minicheck_scorer`` (owner directive 2026-07-11: GGUF backend).
    That loader is FAIL-CLOSED: a missing local ``model_path``, missing llama-cpp-python,
    an unloadable model, or a failed calibration self-check all raise
    ``NliModelUnavailableError``, and the verifier degrades to ``unverified`` verdicts.
    Track guardrail: self-hosted, explicit local staging only — clinical text must not
    leave the host and the gate never auto-downloads weights. Imported lazily so this
    module has no llama.cpp import edge.
    """
    from guardrail.services.groundedness_scorer_minicheck import load_minicheck_scorer

    return load_minicheck_scorer(config)


def _chunked(
    items: Sequence[tuple[str, int, int]], size: int
) -> Iterator[Sequence[tuple[str, int, int]]]:
    step = max(1, size)
    for index in range(0, len(items), step):
        yield items[index : index + step]


class GroundednessNliVerifier:
    """Batched, deterministic groundedness verification of a summary against its source."""

    def __init__(
        self,
        config: GroundednessConfig,
        scorer: NliScorer | None = None,
        scorer_factory: Callable[[GroundednessConfig], NliScorer] | None = None,
    ) -> None:
        self._config = config
        self._scorer = scorer
        self._scorer_factory = scorer_factory or load_default_scorer

    @property
    def model_id(self) -> str:
        return self._config.model_id

    def verify(self, summary: str, transcript: str) -> GroundednessResult:
        """Verify each summary segment against the transcript. Never raises; never
        returns ``grounded`` from a degrade/error path (fail-closed)."""
        started = time.monotonic()
        spans = split_segments(summary)

        def degrade(reason: str) -> GroundednessResult:
            return GroundednessResult(
                segments=[SegmentVerdict(text, UNVERIFIED, start, end) for text, start, end in spans],
                checked=False,
                reason=reason,
                model_id=self._config.model_id,
                elapsed_ms=(time.monotonic() - started) * 1000,
                throughput_docs_per_min=None,
            )

        if not self._config.enabled:
            return degrade(REASON_DISABLED)

        scorer = self._scorer
        if scorer is None:
            try:
                scorer = self._scorer_factory(self._config)
            except Exception as exc:
                # MINOR-1 (applied when the real loader landed): ANY factory failure —
                # not just NliModelUnavailableError — degrades FAIL-CLOSED to `unverified`
                # at the verifier level (defence in depth beyond the endpoint backstop).
                # PHI-safe: counts + error type only, never the clinical text.
                logger.warning(
                    "guardrail.groundedness.model_unavailable",
                    model_id=self._config.model_id,
                    segment_count=len(spans),
                    error=type(exc).__name__,
                )
                return degrade(REASON_MODEL_UNAVAILABLE)
            self._scorer = scorer

        capped = spans[: max(0, self._config.max_segments)]
        scores: list[float] = []
        try:
            for batch in _chunked(capped, self._config.batch_size):
                batch_scores = list(scorer.score_pairs([(transcript, text) for text, _, _ in batch]))
                if len(batch_scores) != len(batch):
                    raise ValueError("NLI scorer returned a mismatched score count")
                scores.extend(batch_scores)
        except Exception as exc:
            # FAIL-CLOSED: a scoring error degrades the WHOLE result to `unverified`
            # (no partially-grounded output from an error path). PHI-safe log.
            logger.warning(
                "guardrail.groundedness.scoring_failed",
                model_id=self._config.model_id,
                segment_count=len(spans),
                error=type(exc).__name__,
            )
            return degrade(REASON_ERROR)

        threshold = self._config.entailment_threshold
        segments = [
            SegmentVerdict(
                text=text,
                verdict=GROUNDED if score >= threshold else UNGROUNDED,
                start=start,
                end=end,
                score=float(score),
            )
            for (text, start, end), score in zip(capped, scores, strict=True)
        ]
        # Segments beyond the per-request cap were never scored — honestly `unverified`.
        segments.extend(
            SegmentVerdict(text, UNVERIFIED, start, end) for text, start, end in spans[len(capped):]
        )

        elapsed_s = time.monotonic() - started
        throughput = (len(capped) / elapsed_s) * 60.0 if capped and elapsed_s > 0 else None
        return GroundednessResult(
            segments=segments,
            checked=True,
            reason=REASON_CHECKED,
            model_id=self._config.model_id,
            elapsed_ms=elapsed_s * 1000,
            throughput_docs_per_min=throughput,
        )
