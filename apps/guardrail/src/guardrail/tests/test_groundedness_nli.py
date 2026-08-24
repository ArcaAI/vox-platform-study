"""TDD tests for the self-hosted NLI groundedness verifier.

The verifier is the core of the live OUTPUT gate: sentence/claim-vs-source
entailment over ``(summary_segment, transcript)`` with per-segment verdicts.
Hermetic by design — tests inject a deterministic tiny stand-in scorer (no
network, no model download, no cloud). The production MiniCheck-class scorer
is NOT staged on this host; a verifier with no scorer must therefore degrade
``NliModelUnavailableError`` and the verifier must degrade FAIL-CLOSED to
``unverified`` (never ``grounded``) on that path.

RED: written before ``guardrail.services.groundedness_nli`` exists.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from guardrail.core.config import GroundednessConfig
from guardrail.services.groundedness_nli import (
    GROUNDED,
    UNGROUNDED,
    UNVERIFIED,
    GroundednessNliVerifier,
    split_segments,
)

TRANSCRIPT = (
    "Patient reports a persistent dry cough for two weeks. "
    "Blood pressure measured at 150 over 95. "
    "Doctor started amlodipine five milligrams daily."
)

SUPPORTED_CLAIM = "Patient reports a persistent dry cough."
HALLUCINATED_CLAIM = "MRI confirmed metastatic pancreatic carcinoma."


class KeywordOverlapScorer:
    """Deterministic tiny stand-in NLI for use in tests.

    Entailment score = fraction of the claim's content words present in the
    source. Enough signal to separate a transcript-supported claim from an
    invented one, with zero I/O and full determinism.
    """

    def __init__(self) -> None:
        self.calls: list[list[tuple[str, str]]] = []

    def score_pairs(self, pairs: Sequence[tuple[str, str]]) -> Sequence[float]:
        self.calls.append(list(pairs))
        scores: list[float] = []
        for source, claim in pairs:
            source_words = set(re.findall(r"[a-z0-9]+", source.lower()))
            claim_words = [w for w in re.findall(r"[a-z0-9]+", claim.lower()) if len(w) > 2]
            if not claim_words:
                scores.append(0.0)
                continue
            hits = sum(1 for w in claim_words if w in source_words)
            scores.append(hits / len(claim_words))
        return scores


class ExplodingScorer:
    """A scorer that always errors — drives the fail-closed branch."""

    def score_pairs(self, pairs: Sequence[tuple[str, str]]) -> Sequence[float]:
        raise RuntimeError("scorer exploded")


class MismatchedScorer:
    """A scorer that returns the wrong number of scores (malformed output)."""

    def score_pairs(self, pairs: Sequence[tuple[str, str]]) -> Sequence[float]:
        return [1.0] * (len(pairs) + 1)


def _verifier(scorer: object | None = None, **config_overrides: object) -> GroundednessNliVerifier:
    config = GroundednessConfig(enabled=True, **config_overrides)  # type: ignore[arg-type]
    return GroundednessNliVerifier(config, scorer=scorer)  # type: ignore[arg-type]


# ── Grounded vs hallucinated, deterministic, offline ──


async def test_supported_claim_grounded_hallucinated_claim_ungrounded() -> None:
    """A transcript-supported claim is grounded; an invented claim is ungrounded."""
    summary = f"{SUPPORTED_CLAIM} {HALLUCINATED_CLAIM}"
    result = await _verifier(KeywordOverlapScorer()).verify(summary, TRANSCRIPT)

    assert result.checked is True
    assert result.reason == "checked"
    assert [s.verdict for s in result.segments] == [GROUNDED, UNGROUNDED]


async def test_verify_is_deterministic() -> None:
    """Same inputs → byte-identical verdicts, scores, and offsets."""
    summary = f"{SUPPORTED_CLAIM} {HALLUCINATED_CLAIM}"
    first = await _verifier(KeywordOverlapScorer()).verify(summary, TRANSCRIPT)
    second = await _verifier(KeywordOverlapScorer()).verify(summary, TRANSCRIPT)

    assert [(s.text, s.verdict, s.score, s.start, s.end) for s in first.segments] == [
        (s.text, s.verdict, s.score, s.start, s.end) for s in second.segments
    ]


async def test_verdict_offsets_index_the_summary() -> None:
    """Each segment's (start, end) slices the ORIGINAL summary to its text."""
    summary = f"{SUPPORTED_CLAIM}\n\n{HALLUCINATED_CLAIM} Follow up in one week."
    result = await _verifier(KeywordOverlapScorer()).verify(summary, TRANSCRIPT)

    assert len(result.segments) >= 2
    for segment in result.segments:
        assert summary[segment.start : segment.end] == segment.text


async def test_flagged_spans_cover_exactly_the_ungrounded_segments() -> None:
    """Flagged spans are the ungrounded segments' offsets — nothing more or less."""
    summary = f"{SUPPORTED_CLAIM} {HALLUCINATED_CLAIM}"
    result = await _verifier(KeywordOverlapScorer()).verify(summary, TRANSCRIPT)

    ungrounded = [s for s in result.segments if s.verdict == UNGROUNDED]
    assert result.flagged_spans == [(s.start, s.end) for s in ungrounded]
    assert len(result.flagged_spans) == 1


# ── Throughput as a batching property (never a flaky wall-clock test) ──


async def test_batched_scoring_respects_configured_batch_size() -> None:
    """N segments with batch_size B → ceil(N/B) scorer calls, each ≤ B pairs."""
    scorer = KeywordOverlapScorer()
    sentences = " ".join(f"Patient reports cough episode number {i}." for i in range(10))
    result = await _verifier(scorer, batch_size=4).verify(sentences, TRANSCRIPT)

    assert len(result.segments) == 10
    assert len(scorer.calls) == 3  # ceil(10 / 4)
    assert [len(call) for call in scorer.calls] == [4, 4, 2]


async def test_throughput_reported_for_batched_run() -> None:
    """A successful batched run reports a positive docs/min throughput figure."""
    summary = f"{SUPPORTED_CLAIM} {HALLUCINATED_CLAIM}"
    result = await _verifier(KeywordOverlapScorer()).verify(summary, TRANSCRIPT)

    assert result.throughput_docs_per_min is not None
    assert result.throughput_docs_per_min > 0


async def test_max_segments_cap_marks_excess_unverified() -> None:
    """Segments beyond the per-request cap are honestly ``unverified`` — never scored-by-omission."""
    sentences = " ".join(f"Patient reports cough episode number {i}." for i in range(6))
    result = await _verifier(KeywordOverlapScorer(), max_segments=4).verify(sentences, TRANSCRIPT)

    assert len(result.segments) == 6
    assert [s.verdict for s in result.segments[:4]] != [UNVERIFIED] * 4
    assert [s.verdict for s in result.segments[4:]] == [UNVERIFIED, UNVERIFIED]


# ── Fail-closed degrade paths: NO error path may ever yield ``grounded`` ──


async def test_disabled_gate_degrades_to_unverified_never_grounded() -> None:
    """enabled=False (dev/CI bypass) → every segment ``unverified``, checked=False."""
    config = GroundednessConfig(enabled=False)
    verifier = GroundednessNliVerifier(config, scorer=KeywordOverlapScorer())
    result = await verifier.verify(f"{SUPPORTED_CLAIM} {HALLUCINATED_CLAIM}", TRANSCRIPT)

    assert result.checked is False
    assert result.reason == "groundedness_disabled"
    assert all(s.verdict == UNVERIFIED for s in result.segments)
    assert not any(s.verdict == GROUNDED for s in result.segments)


async def test_model_unavailable_degrades_to_unverified_never_grounded() -> None:
    """An un-loadable model (the un-staged MiniCheck) → ``unverified``, never grounded."""
    verifier = _verifier(scorer=None)  # no scorer ⇒ fail-closed degrade
    result = await verifier.verify(f"{SUPPORTED_CLAIM} {HALLUCINATED_CLAIM}", TRANSCRIPT)

    assert result.checked is False
    assert result.reason == "nli_model_unavailable"
    assert all(s.verdict == UNVERIFIED for s in result.segments)


async def test_scorer_error_fails_closed_to_unverified() -> None:
    """A scorer error mid-verify → the WHOLE result degrades to ``unverified``."""
    result = await _verifier(ExplodingScorer()).verify(
        f"{SUPPORTED_CLAIM} {HALLUCINATED_CLAIM}", TRANSCRIPT
    )

    assert result.checked is False
    assert result.reason == "nli_error"
    assert all(s.verdict == UNVERIFIED for s in result.segments)
    assert not any(s.verdict == GROUNDED for s in result.segments)


async def test_mismatched_scorer_output_fails_closed() -> None:
    """A malformed (wrong-count) scorer response is an error, not a silent zip-truncate."""
    result = await _verifier(MismatchedScorer()).verify(
        f"{SUPPORTED_CLAIM} {HALLUCINATED_CLAIM}", TRANSCRIPT
    )

    assert result.checked is False
    assert result.reason == "nli_error"
    assert all(s.verdict == UNVERIFIED for s in result.segments)


def test_no_default_scorer_factory_exists() -> None:
    """TASK-735 Phase 6 — guardrail loads nothing; `apps/nlp` hosts the weights."""
    import guardrail.services.groundedness_nli as module

    assert not hasattr(module, "load_default_scorer")


# ── Segmentation ──


def test_split_segments_offsets_and_content() -> None:
    """Sentence/newline segmentation preserves exact offsets into the input."""
    text = "First sentence. Second one!\nThird line\n\nFourth."
    segments = split_segments(text)

    assert [s[0] for s in segments] == [
        "First sentence.",
        "Second one!",
        "Third line",
        "Fourth.",
    ]
    for segment_text, start, end in segments:
        assert text[start:end] == segment_text


def test_split_segments_empty_input() -> None:
    assert split_segments("") == []
    assert split_segments("   \n  ") == []


# ── Metric machinery (precision/recall on a labelled sample) ──


async def test_metric_harness_precision_recall_on_labelled_sample() -> None:
    """Precision/recall over a small de-identified labelled sample is computable.

    The labelled pairs are SYNTHETIC (no PHI). With the real MiniCheck-class
    model un-staged, the recorded metric for this ticket is produced against the
    stub scorer to lock the machinery; the real-model numbers are the follow-up.
    """
    labelled: list[tuple[str, bool]] = [
        ("Patient reports a persistent dry cough.", True),
        ("Blood pressure measured at 150 over 95.", True),
        ("Doctor started amlodipine five milligrams daily.", True),
        ("MRI confirmed metastatic pancreatic carcinoma.", False),
        ("Patient underwent emergency appendectomy yesterday.", False),
        ("Family history of hereditary angioedema was discussed.", False),
    ]
    verifier = _verifier(KeywordOverlapScorer())

    true_positive = false_positive = false_negative = 0
    for claim, is_grounded in labelled:
        result = await verifier.verify(claim, TRANSCRIPT)
        predicted_grounded = all(s.verdict == GROUNDED for s in result.segments)
        if predicted_grounded and is_grounded:
            true_positive += 1
        elif predicted_grounded and not is_grounded:
            false_positive += 1
        elif not predicted_grounded and is_grounded:
            false_negative += 1

    precision = true_positive / (true_positive + false_positive)
    recall = true_positive / (true_positive + false_negative)
    assert precision == 1.0
    assert recall == 1.0
