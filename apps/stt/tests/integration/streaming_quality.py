"""Pure streaming-QUALITY metric functions.

Deterministic, dependency-light (stdlib only — no numpy, no services), so the
scorecard math is unit-testable with nothing up. Imported by
``test_streaming_quality_scorecard.py`` alongside the loss-harness transport
metrics (``compute_metrics`` et al.) to build ONE clinical scorecard and gate it.

WHAT'S HERE
-----------
* ``medical_wer(ref, hyp)`` — word error rate via a self-contained word-level
  Levenshtein with backtrace, algorithm mirrored from the TS gate ``wer.ts``
  that historically shipped in the now-removed ``apps/ui-playground/e2e/helpers/``
  (same normalization + tie-break order) so the Python and TS gates agreed on
  the base algorithm. Medical-term-aware: an
  optional synonym map folds benign clinical spelling/abbreviation variation
  (with the map, the Python gate intentionally diverges from wer.ts — see
  ``medical_wer``).
* ``term_restricted_wer(ref, hyp, terms)`` — MedWER-shape WER (F9-K4): errors
  scored ONLY on a fixed clinical term list — a missed "atorvastatin" moves
  this metric, a missed "the" does not.
* ``character_error_rate(ref, hyp)`` — CER, primary metric for Malayalam /
  code-switch fixtures (F9-E2 — CER correlates better with human judgment
  than WER there).
* ``keyterm_recall(keyterms, hyp)`` — fraction of curated clinical keyterms
  present as a CONTIGUOUS span (verbatim phrase) in the hypothesis. The
  strict "did we drop the drug / dose / finding" catcher.
* ``keyphrase_recall(keyphrases, hyp)`` — fraction present as an ordered
  SUBSEQUENCE (gaps allowed) — a looser recall for longer descriptive phrases
  where an inserted filler word shouldn't zero the phrase.
* ``extract_fingerprint`` / ``find_fingerprint_in_log`` / ``check_fingerprint``
  — BP-1's structured session fingerprint: read FROM the session the harness
  opened, never re-derived from the seed (M-15's root cause). A live run whose
  fingerprint does not match the baseline's is reported NOT COMPARABLE so the
  caller can skip-with-reason instead of gating two different configurations
  against each other.
* ``median`` / ``mad`` / ``median_mad_bounds`` / ``bootstrap_ci`` — the M-11 /
  ST-4 robust statistics (median + 2xMAD point estimate; blockwise bootstrap
  CI wherever a baseline comparison is claimed) that replace a hand-widened
  epsilon calibrated on N=3 single-final clips.
* ``build_scorecard(...)`` — composes the quality fields + the reused
  transport metrics into one flat scorecard dict.
* ``regression_report(scorecard, thresholds)`` — pure verdict (never raises),
  single run.
* ``assert_no_regression(scorecard, thresholds)`` — the pass/fail gate: raises
  ``AssertionError`` on any breach (an assertion the loss harness deferred).
* ``regression_report_aggregate`` / ``assert_no_regression_aggregate`` — the
  N>=1 multi-run counterparts the live scorecard test gates on.

All WER/recall values are surface-form only — NOT UMLS/MEDCON concept linking
(that is future work, gated on persisted NamedEntity codes).
"""

from __future__ import annotations

import json
import random
import re
import statistics
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Medical-term-aware normalization
# ---------------------------------------------------------------------------

# A small, documented canonicalization map (v1 stub) that folds common clinical
# spellings/abbreviations to ONE surface form so WER isn't penalized for benign
# synonym variation ("5 milligrams" == "5 mg"). Keys AND values are already in
# normalized form (lowercase, punctuation-stripped). Extend as fixtures grow; a
# fuller UMLS/RxNorm mapping is deliberately out of scope for v1.
MEDICAL_SYNONYMS: dict[str, str] = {
    "milligram": "mg",
    "milligrams": "mg",
    "mgs": "mg",
    "microgram": "mcg",
    "micrograms": "mcg",
    "mcgs": "mcg",
    "gram": "g",
    "grams": "g",
    "kilogram": "kg",
    "kilograms": "kg",
    "milliliter": "ml",
    "millilitre": "ml",
    "milliliters": "ml",
    "millilitres": "ml",
    "mls": "ml",
}

_WHITESPACE_RE = re.compile(r"\s+")

# Hyphen, en dash (–), em dash (—) or slash sitting BETWEEN two alphanumeric
# characters — a candidate word JOIN rather than punctuation to discard. Uses
# zero-width lookaround (not consuming groups) so adjacent separators
# ("10/12/2020", "a-b-c") each get evaluated independently without the match
# for one separator eating the shared alphanumeric neighbor of the next.
_ALNUM_SEPARATOR_RE = re.compile(r"(?<=[a-z0-9])[\-–—/](?=[a-z0-9])")


def _split_alnum_separator(match: re.Match[str]) -> str:
    """``_ALNUM_SEPARATOR_RE`` callback: decide space-split vs stay-fused.

    A hyphen/en-dash/em-dash between alphanumerics is always a word join
    ("community-acquired" -> "community acquired") and becomes a space. A
    slash is the same UNLESS both neighbors are digits, where it is a numeric
    ratio/range ("120/80") and stays fused, matching the legacy behavior.
    """
    separator = match.group(0)
    if separator == "/":
        before = match.string[match.start() - 1]
        after = match.string[match.end()]
        if before.isdigit() and after.isdigit():
            return separator  # left for the generic punctuation strip below
    return " "


def normalize_text(text: str) -> str:
    """Lowercase, split word-join separators, strip punctuation, collapse whitespace, trim.

    A hyphen, en dash (``–``) or em dash (``—``) BETWEEN two alphanumeric
    characters becomes a SPACE — these are word joins, not punctuation to
    drop, so ``"community-acquired pneumonia"`` -> ``"community acquired
    pneumonia"`` and ``"follow-up"`` -> ``"follow up"``. A slash between two
    alphanumerics does the same UNLESS both neighbors are digits: ``"mg/dL"``
    -> ``"mg dl"`` (a unit ratio, a word join) but ``"120/80"`` -> ``"12080"``
    (a numeric reading, stays fused) exactly as before.

    Every other disallowed character (anything not a letter, number,
    whitespace, or apostrophe) is REMOVED, not spaced, so ``"B.P."`` ->
    ``"bp"`` still holds.

    THIS is the single source of truth for this normalization. The docstring
    used to claim it "mirrors ``normalizeText`` in ``wer.ts``" — that TS gate
    historically shipped at ``apps/ui-playground/e2e/helpers/wer.ts`` and was
    deleted with ``apps/ui-playground`` (TASK-669); grepping ``normalizeText``
    and ``wer.ts`` across the sibling ARCAAI repos on 2026-09-09 (ALaaSv3.0,
    ALaaSv3.0-hope-rt-web-ui, ALaaSv3.0-hope-rt-broker, hope-v2-deployment,
    INTRAPAC) found no equivalent mirror — the only substring hits were an
    unrelated ``normalizeTextForAI`` (a generic AI-prompt text cleaner in the
    ALaaS ``audio-stream-svc``, not a WER/metric normalizer). No TS mirror to
    keep in sync exists anywhere; this function is the sole implementation.
    """
    lowered = text.lower()
    split_joins = _ALNUM_SEPARATOR_RE.sub(_split_alnum_separator, lowered)
    filtered = "".join(c for c in split_joins if c.isalnum() or c.isspace() or c == "'")
    return _WHITESPACE_RE.sub(" ", filtered).strip()


def _normalize_words(text: str, synonyms: Mapping[str, str] | None = None) -> list[str]:
    words = [w for w in normalize_text(text).split(" ") if w]
    if synonyms:
        words = [synonyms.get(w, w) for w in words]
    return words


# ---------------------------------------------------------------------------
# Medical WER (word-level Levenshtein + backtrace — mirrors wer.ts)
# ---------------------------------------------------------------------------


def _word_edits(ref: list[str], hyp: list[str]) -> tuple[int, int, int]:
    """Return ``(substitutions, deletions, insertions)`` via edit-distance backtrace.

    Backtrace tie-break order matches ``wer.ts``: match → substitution → deletion
    → insertion, so S/D/I counts agree token-for-token with the TS gate.
    """
    n, m = len(ref), len(hyp)
    if n == 0 and m == 0:
        return (0, 0, 0)
    if n == 0:
        return (0, 0, m)  # every hypothesis word is an insertion
    if m == 0:
        return (0, n, 0)  # every reference word is a deletion

    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]
            else:
                dp[i][j] = 1 + min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])

    subs = dels = ins = 0
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and ref[i - 1] == hyp[j - 1]:
            i -= 1
            j -= 1
        elif i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + 1:
            subs += 1
            i -= 1
            j -= 1
        elif i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            dels += 1
            i -= 1
        else:
            ins += 1
            j -= 1
    return (subs, dels, ins)


def medical_wer(
    reference: str,
    hypothesis: str,
    *,
    synonyms: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Word Error Rate = (S + D + I) / N with medical-term-aware normalization.

    Pass ``synonyms=MEDICAL_SYNONYMS`` to fold benign clinical spelling variation.
    Returns wer plus the S/D/I breakdown (for scorecard drill-down).

    NOTE: agreement with the TS gate (``wer.ts``) holds ONLY for ``synonyms=None``;
    with ``MEDICAL_SYNONYMS`` (as the live scorecard uses) the two intentionally
    diverge on synonym variation (the Python gate is deliberately more lenient).
    """
    ref = _normalize_words(reference, synonyms)
    hyp = _normalize_words(hypothesis, synonyms)
    subs, dels, ins = _word_edits(ref, hyp)
    n = len(ref)
    if n == 0:
        wer = 0.0 if len(hyp) == 0 else 1.0
    else:
        wer = (subs + dels + ins) / n
    return {
        "wer": round(wer, 6),
        "substitutions": subs,
        "deletions": dels,
        "insertions": ins,
        "reference_words": n,
        "hypothesis_words": len(hyp),
    }


# ---------------------------------------------------------------------------
# ST-4 (F9-K4 MedWER shape) — term-restricted WER, scored only on a fixed
# clinical term list. F9-E2 — character error rate, primary for Malayalam /
# code-switch.
# ---------------------------------------------------------------------------


def term_restricted_wer(
    reference: str,
    hypothesis: str,
    terms: Sequence[str],
    *,
    synonyms: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """MedWER-shape WER (F9-K4): errors scored ONLY on a fixed drug / diagnosis /
    symptom term list, not the whole utterance — a missed "atorvastatin" moves
    this metric, a missed "the" does not.

    Reference and hypothesis are each filtered down to the tokens that are
    members of the (normalized, synonym-folded) term vocabulary, in original
    order, then scored with the same S/D/I Levenshtein backtrace as
    ``medical_wer``. A term written as "5 milligrams" still matches a
    hypothesis token folded to "mg" — the vocabulary is built with the SAME
    normalization + synonym map the words are matched against.
    """
    vocab: set[str] = set()
    for term in terms:
        vocab.update(_normalize_words(term, synonyms))
    ref_words = [w for w in _normalize_words(reference, synonyms) if w in vocab]
    hyp_words = [w for w in _normalize_words(hypothesis, synonyms) if w in vocab]
    subs, dels, ins = _word_edits(ref_words, hyp_words)
    n = len(ref_words)
    if n == 0:
        wer = 0.0 if len(hyp_words) == 0 else 1.0
    else:
        wer = (subs + dels + ins) / n
    return {
        "wer": round(wer, 6),
        "substitutions": subs,
        "deletions": dels,
        "insertions": ins,
        "reference_words": n,
        "hypothesis_words": len(hyp_words),
        "term_vocabulary_size": len(vocab),
    }


def character_error_rate(
    reference: str,
    hypothesis: str,
    *,
    normalized: bool = True,
) -> dict[str, Any]:
    """CER = character-level (S + D + I) / len(reference chars).

    Primary metric for Malayalam and code-switched fixtures (F9-E2 — CER
    correlates better with human judgment than WER there; ``medical_wer``
    stays primary for English fixtures). ``normalized=True`` (default) runs
    the SAME ``normalize_text`` ``medical_wer`` uses (lowercase, punctuation
    strip, whitespace collapse) and scores on the space-stripped character
    stream, so the two metrics agree on what counts as "the same text" modulo
    casing/punctuation; ``normalized=False`` scores the raw strings verbatim
    (script-sensitive, no folding — use for a script-flip regression check).
    """
    ref_text = normalize_text(reference) if normalized else reference
    hyp_text = normalize_text(hypothesis) if normalized else hypothesis
    ref_chars = list(ref_text.replace(" ", "")) if normalized else list(ref_text)
    hyp_chars = list(hyp_text.replace(" ", "")) if normalized else list(hyp_text)
    subs, dels, ins = _word_edits(ref_chars, hyp_chars)
    n = len(ref_chars)
    if n == 0:
        cer = 0.0 if len(hyp_chars) == 0 else 1.0
    else:
        cer = (subs + dels + ins) / n
    return {
        "cer": round(cer, 6),
        "substitutions": subs,
        "deletions": dels,
        "insertions": ins,
        "reference_chars": n,
        "hypothesis_chars": len(hyp_chars),
    }


# ---------------------------------------------------------------------------
# Clinical keyterm / keyphrase recall
# ---------------------------------------------------------------------------


def _contains_span(hay: list[str], needle: list[str]) -> bool:
    """True iff ``needle`` occurs as a CONTIGUOUS span in ``hay``."""
    if not needle:
        return True
    span = len(needle)
    for start in range(len(hay) - span + 1):
        if hay[start : start + span] == needle:
            return True
    return False


def _is_subsequence(hay: list[str], needle: list[str]) -> bool:
    """True iff ``needle`` occurs as an ORDERED subsequence of ``hay`` (gaps ok)."""
    if not needle:
        return True
    idx = 0
    for token in hay:
        if token == needle[idx]:
            idx += 1
            if idx == len(needle):
                return True
    return False


def _recall(
    terms: Sequence[str],
    hypothesis: str,
    match: Any,
    synonyms: Mapping[str, str] | None,
) -> dict[str, Any]:
    hyp_words = _normalize_words(hypothesis, synonyms)
    total = 0
    matched = 0
    missing: list[str] = []
    for term in terms:
        term_words = _normalize_words(term, synonyms)
        if not term_words:
            continue  # ignore blank/whitespace-only entries
        total += 1
        if match(hyp_words, term_words):
            matched += 1
        else:
            missing.append(term)
    recall = 1.0 if total == 0 else matched / total
    return {"recall": round(recall, 6), "total": total, "matched": matched, "missing": missing}


def keyterm_recall(
    keyterms: Sequence[str],
    hypothesis: str,
    *,
    synonyms: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Fraction of ``keyterms`` present as a contiguous (verbatim) span.

    Empty ``keyterms`` → recall 1.0 (vacuous — nothing to drop; neutral guardrail).
    """
    return _recall(keyterms, hypothesis, _contains_span, synonyms)


def keyphrase_recall(
    keyphrases: Sequence[str],
    hypothesis: str,
    *,
    synonyms: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Fraction of ``keyphrases`` present as an ordered subsequence (gaps allowed)."""
    return _recall(keyphrases, hypothesis, _is_subsequence, synonyms)


# ---------------------------------------------------------------------------
# Scorecard assembly + regression gate
# ---------------------------------------------------------------------------


def build_scorecard(
    *,
    reference: str,
    hypothesis: str,
    keyterms: Sequence[str],
    keyphrases: Sequence[str],
    transport_metrics: Mapping[str, Any],
    synonyms: Mapping[str, str] | None = None,
    term_restricted_terms: Sequence[str] | None = None,
    cer_primary: bool = False,
) -> dict[str, Any]:
    """Compose quality metrics + the reused loss-harness transport metrics.

    ``transport_metrics`` is the dict returned by the loss harness's
    ``compute_metrics`` — this pulls out the guardrail fields the gate reads.

    ``term_restricted_terms`` (ST-4/F9-K4), when given, adds
    ``quality.term_restricted_wer`` scored only on that term list — in
    addition to, never instead of, ``medical_wer``. ``cer_primary=True``
    (F9-E2, Malayalam/code-switch fixtures) additionally computes
    ``quality.cer`` and marks it as the primary quality metric in the card
    (``quality.primary_metric``); ``medical_wer``/``keyterm_recall`` are
    still always present so an English-fixture gate is unaffected.
    """
    wer = medical_wer(reference, hypothesis, synonyms=synonyms)
    kt = keyterm_recall(keyterms, hypothesis, synonyms=synonyms)
    kp = keyphrase_recall(keyphrases, hypothesis, synonyms=synonyms)

    quality: dict[str, Any] = {
        "medical_wer": wer["wer"],
        "keyterm_recall": kt["recall"],
        "keyphrase_recall": kp["recall"],
        "primary_metric": "cer" if cer_primary else "medical_wer",
        "detail": {"wer": wer, "keyterm": kt, "keyphrase": kp},
    }
    if term_restricted_terms:
        trw = term_restricted_wer(reference, hypothesis, term_restricted_terms, synonyms=synonyms)
        quality["term_restricted_wer"] = trw["wer"]
        quality["detail"]["term_restricted_wer"] = trw
    if cer_primary:
        cer = character_error_rate(reference, hypothesis)
        quality["cer"] = cer["cer"]
        quality["detail"]["cer"] = cer

    tm = transport_metrics or {}
    partial = tm.get("partial_revision") or {}
    committed = tm.get("committed_revision") or {}
    loss = tm.get("loss") or {}
    seq = loss.get("seq") or {}

    return {
        "quality": quality,
        "transport": {
            "first_partial_ms": tm.get("first_partial_ms"),
            "ttfw_ms": tm.get("ttfw_ms"),
            "commit_latency_ms": tm.get("commit_latency_ms"),
            # committed_revision_rate is the GATED churn guardrail (settled-text
            # rewrite); partial_revision_rate is retained INFORMATIONAL (full-caption
            # churn incl. the by-design tentative tail — useful for cadence tuning).
            "committed_revision_rate": committed.get("rate"),
            # M-11 honesty: True only when >=1 partial in the run actually carried a
            # measurable committed prefix (stableChars > 0). A 0.0 rate with
            # measurable=False is a vacuous pass (an untested code path), not a clean run.
            "committed_revision_rate_measurable": committed.get("measurable"),
            "partial_revision_rate": partial.get("rate"),
            "seq_gap_count": seq.get("gap_count"),
            "audio_coverage_ratio": loss.get("audio_coverage_ratio"),
            "session_create_ms": tm.get("session_create_ms"),
            "inference_ms": tm.get("inference_ms"),
            "partial_cadence_ms": tm.get("partial_cadence_ms"),
        },
    }


def _check(
    metric: str,
    observed: Any,
    limit: Any,
    passed: bool,
    direction: str,
) -> dict[str, Any]:
    return {
        "metric": metric,
        "observed": observed,
        "limit": limit,
        "direction": direction,
        "passed": bool(passed),
    }


def regression_report(
    scorecard: Mapping[str, Any],
    thresholds: Mapping[str, Any],
) -> dict[str, Any]:
    """Evaluate a scorecard against committed thresholds. Pure — never raises.

    For quality metrics an ABSOLUTE bootstrap ceiling/floor is always enforced; a
    ``baseline`` (null until the orchestrator's live capture) adds a tighter
    baseline±ε check when present. Transport guardrails use the loss-harness baseline.
    Missing observed data (e.g. no finals ⇒ no commit latency) skips that check
    rather than failing — the live test already skips when nothing transcribes.
    """
    quality = scorecard.get("quality", {})
    transport = scorecard.get("transport", {})
    checks: list[dict[str, Any]] = []

    # --- medical WER: <= ceiling (always) and <= baseline+ε (when captured) ---
    wer_cfg = thresholds.get("medical_wer", {})
    wer = quality.get("medical_wer")
    if wer is not None:
        ceiling = wer_cfg.get("ceiling")
        if ceiling is not None:
            checks.append(_check("medical_wer", wer, ceiling, wer <= ceiling, "<= ceiling"))
        base = wer_cfg.get("baseline")
        if base is not None:
            lim = base + wer_cfg.get("epsilon", 0.0)
            checks.append(
                _check("medical_wer_vs_baseline", wer, lim, wer <= lim, "<= baseline+eps")
            )

    # --- keyterm / keyphrase recall: >= floor and >= baseline-ε ---------------
    for name in ("keyterm_recall", "keyphrase_recall"):
        cfg = thresholds.get(name, {})
        val = quality.get(name)
        if val is None:
            continue
        floor = cfg.get("floor")
        if floor is not None:
            checks.append(_check(name, val, floor, val >= floor, ">= floor"))
        base = cfg.get("baseline")
        if base is not None:
            lim = base - cfg.get("epsilon", 0.0)
            checks.append(_check(f"{name}_vs_baseline", val, lim, val >= lim, ">= baseline-eps"))

    # --- committed-region revision rate: <= baseline+ε (churn guardrail) --------
    # Gates the LA-2 committed-prefix churn (settled-text the user sees rewrite),
    # NOT the full-caption rate — re-transcribing the by-design tentative tail is
    # excluded. The full-caption partial_revision_rate is surfaced but ungated.
    cr_cfg = thresholds.get("committed_revision_rate", {})
    cr = transport.get("committed_revision_rate")
    cr_measurable = transport.get("committed_revision_rate_measurable")
    if cr is not None and cr_cfg.get("baseline") is not None:
        # M-11 honesty: a 0.0 rate where NO partial ever carried a measurable
        # committed prefix (stableChars > 0) is an UNTESTED code path, not a
        # clean run — it must not report a vacuous pass. Only trips when the
        # caller explicitly reports measurable=False; a caller that doesn't
        # thread the flag (e.g. older synthetic scorecards) is unaffected.
        if cr_measurable is False and cr == 0.0:
            checks.append(
                _check(
                    "committed_revision_rate",
                    cr,
                    None,
                    False,
                    "measurable (not vacuously 0.0 — no partial had stableChars > 0)",
                )
            )
        else:
            lim = cr_cfg["baseline"] + cr_cfg.get("epsilon", 0.0)
            checks.append(_check("committed_revision_rate", cr, lim, cr <= lim, "<= baseline+eps"))

    # --- commit latency P50/P99: <= baseline × (1 + ε_ratio) ------------------
    cl_cfg = thresholds.get("commit_latency_ms", {})
    commit = transport.get("commit_latency_ms")
    if isinstance(commit, Mapping):
        ratio = cl_cfg.get("epsilon_ratio", 0.0)
        for pct, base_key in (("p50", "p50_baseline"), ("p99", "p99_baseline")):
            observed = commit.get(pct)
            base = cl_cfg.get(base_key)
            if observed is not None and base is not None:
                lim = base * (1 + ratio)
                checks.append(
                    _check(
                        f"commit_latency_{pct}",
                        observed,
                        lim,
                        observed <= lim,
                        "<= baseline*(1+eps)",
                    )
                )

    # --- dropped captions: seq gap count == 0 (zero tolerance) ----------------
    gap_cfg = thresholds.get("seq_gap_count", {})
    gaps = transport.get("seq_gap_count")
    if gaps is not None and gap_cfg.get("max") is not None:
        checks.append(
            _check("seq_gap_count", gaps, gap_cfg["max"], gaps <= gap_cfg["max"], "<= max")
        )

    # --- audio coverage: >= baseline-ε ----------------------------------------
    cov_cfg = thresholds.get("audio_coverage_ratio", {})
    cov = transport.get("audio_coverage_ratio")
    if cov is not None and cov_cfg.get("baseline") is not None:
        lim = cov_cfg["baseline"] - cov_cfg.get("epsilon", 0.0)
        checks.append(_check("audio_coverage_ratio", cov, lim, cov >= lim, ">= baseline-eps"))

    # A metric-less scorecard must NEVER pass vacuously (``all([])`` is True): a
    # direct caller with an empty/all-None card would otherwise get a false green.
    if not checks:
        return {
            "passed": False,
            "checks": [],
            "error": "scorecard exposed no observable metrics to gate (empty/all-None card)",
        }
    return {"passed": all(c["passed"] for c in checks), "checks": checks}


def assert_no_regression(
    scorecard: Mapping[str, Any],
    thresholds: Mapping[str, Any],
) -> dict[str, Any]:
    """Raise ``AssertionError`` on any threshold breach; else return the verdict.

    This is the concrete pass/fail scorecard gate that a baseline-only harness
    deferred. Returns the full ``regression_report`` verdict on success so
    callers can embed it in the emitted scorecard artifact.
    """
    report = regression_report(scorecard, thresholds)
    if not report["passed"]:
        detail = report.get("error") or json.dumps(
            [c for c in report["checks"] if not c["passed"]], ensure_ascii=False
        )
        raise AssertionError("streaming quality regression vs committed thresholds: " + detail)
    return report


# ===========================================================================
# BP-1 -- structured session fingerprint (M-15 fix)
# ===========================================================================
#
# Read FROM the session the harness opened, NEVER re-derived from the seed --
# that re-derivation ("what we THINK is served") is M-15's root cause: the
# committed baseline and the served config silently drifted apart six times
# over and every `_note` still described the config from 2026-09-09. The
# fingerprint is machine-written by STT at session-open time (a
# ``stt.streaming.fingerprint`` structured-log event, extending the existing
# ``stt.streaming.windows`` line) and machine-compared here -- no human
# transcription step exists in the loop that could drift.

# The exact D7 (docs/implementation/TASK-985.../scratchpad design dossier
# section 4) schema. Prompt STATE is a FIRST-CLASS field pair
# (`promptHash` + the two priming-prompt enable flags), not prose in a
# `_note` -- that is precisely the signal today's `_note` fields cannot
# express, and precisely what the `e3d61eefb` regression needed a gate to see.
FINGERPRINT_EVENT_NAME = "stt.streaming.fingerprint"

FINGERPRINT_FIELDS: tuple[str, ...] = (
    "agentVersion",
    "modelSlug",
    "modelDigest",
    "maxDecodeWindowSec",
    "partialWindowSec",
    "partialIntervalMs",
    "endpointing",
    "vadEnabled",
    "promptHash",
    "pairPromptEnabled",
    "singlePromptEnabled",
    "engineBuild",
    "device",
    "sdkOperatingPoint",
)

# Geometry knobs compared with a small numeric tolerance; everything else
# (strings, bools, hashes, digests) is exact-match.
_FINGERPRINT_NUMERIC_TOLERANCE: dict[str, float] = {
    "maxDecodeWindowSec": 1e-6,
    "partialWindowSec": 1e-6,
    "partialIntervalMs": 1e-6,
}


def extract_fingerprint(log_event: Mapping[str, Any]) -> dict[str, Any] | None:
    """Pull the BP-1 fingerprint out of one decoded structured-log event.

    ``log_event`` is one JSON object as STT's structlog JSON renderer writes
    it (one per output line). Returns ``None`` unless ``event`` is exactly
    the ``stt.streaming.fingerprint`` marker -- this module never guesses at a
    fingerprint from any other event shape.
    """
    if not isinstance(log_event, Mapping):
        return None
    if log_event.get("event") != FINGERPRINT_EVENT_NAME:
        return None
    return {field: log_event.get(field) for field in FINGERPRINT_FIELDS}


def find_fingerprint_in_log(log_path: Path, session_id: str) -> dict[str, Any] | None:
    """Scan a JSON-lines structured log file for ``session_id``'s fingerprint.

    Tolerant of a log file that mixes plain-text and JSON lines (e.g. an
    ASGI-server access-log preamble, or a line structlog could not render as
    JSON) -- a line that is not a parseable JSON object is skipped, never
    raised. Returns the LAST matching event (a session may open more than
    once across retries; the last is authoritative for what actually ran).
    """
    if not log_path.is_file():
        return None
    found: dict[str, Any] | None = None
    with log_path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                continue
            fp = extract_fingerprint(raw)
            if fp is None:
                continue
            if raw.get("session_id") == session_id or raw.get("sessionId") == session_id:
                found = fp
    return found


def fingerprint_mismatch(candidate: Mapping[str, Any], baseline: Mapping[str, Any]) -> list[str]:
    """Field-by-field diff. Returns human-readable mismatch strings (empty = match).

    Only fields present and non-``None`` on BOTH sides are compared -- a field
    neither side has captured yet is not a false mismatch (``check_fingerprint``
    separately flags "nothing to compare" via its own ``comparable`` verdict).
    """
    mismatches: list[str] = []
    for field in FINGERPRINT_FIELDS:
        cand_val = candidate.get(field)
        base_val = baseline.get(field)
        if cand_val is None or base_val is None:
            continue
        tol = _FINGERPRINT_NUMERIC_TOLERANCE.get(field)
        if tol is not None:
            try:
                mismatched = abs(float(cand_val) - float(base_val)) > tol
            except (TypeError, ValueError):
                mismatched = cand_val != base_val
        else:
            mismatched = cand_val != base_val
        if mismatched:
            mismatches.append(f"{field} {cand_val!r} != baseline {base_val!r}")
    return mismatches


def check_fingerprint(
    candidate: Mapping[str, Any] | None,
    baseline: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Decide whether a live run's fingerprint is COMPARABLE to the committed baseline.

    Returns ``{"comparable": bool, "reason": str | None, "mismatched": [...]}``.
    ``comparable=False`` is the caller's cue to ``pytest.skip(reason)`` instead
    of gating the run -- the concrete fix for M-15/M-16: a pass must never be
    reported by silently comparing two different configurations.
    """
    if candidate is None:
        return {
            "comparable": False,
            "reason": (
                "fingerprint not captured for this run (no stt.streaming.fingerprint "
                "log event found for this session -- see STREAM_STT_LOG_PATH)"
            ),
            "mismatched": [],
        }
    # An EMPTY block and an all-null SCAFFOLDING block (the shape
    # streaming_thresholds.json ships in before BP-1's live re-capture) are
    # the same "nothing to compare" case -- `fingerprint_mismatch` would
    # otherwise skip every field (both sides None) and report a false match.
    if not baseline or all(v is None for v in baseline.values()):
        return {
            "comparable": False,
            "reason": (
                "baseline carries no fingerprint yet (BP-1 has not re-captured "
                "streaming_thresholds.json under the served spec)"
            ),
            "mismatched": [],
        }
    mismatched = fingerprint_mismatch(candidate, baseline)
    if mismatched:
        return {
            "comparable": False,
            "reason": "fingerprint mismatch: " + "; ".join(mismatched),
            "mismatched": mismatched,
        }
    return {"comparable": True, "reason": None, "mismatched": []}


# ===========================================================================
# M-11 / ST-4 -- robust statistics for an N>=5 multi-run gate (stdlib only)
# ===========================================================================
#
# Replaces "one pooled statistic, epsilon hand-widened after seeing the
# spread on N=3" with: a robust point estimate (median + 2xMAD) for the
# absolute ceiling/floor, and a blockwise bootstrap CI wherever a BASELINE
# comparison is claimed. No epsilon is ever widened here to fit an observed
# spread -- a wide spread is a signal to re-capture on a quiet stack, not to
# loosen the bound (README Sec.5 "N and statistics").


def median(values: Sequence[float]) -> float:
    return statistics.median(values)


def mad(values: Sequence[float]) -> float:
    """Median Absolute Deviation (unscaled) -- a robust, outlier-resistant spread."""
    if not values:
        return 0.0
    m = statistics.median(values)
    return statistics.median([abs(v - m) for v in values])


def median_mad_bounds(values: Sequence[float], k: float = 2.0) -> tuple[float, float]:
    """``(median - k*MAD, median + k*MAD)`` -- the robust acceptance band this
    redesign uses in place of a hand-widened epsilon."""
    m = statistics.median(values)
    spread = k * mad(values)
    return (m - spread, m + spread)


def bootstrap_ci(
    values: Sequence[float],
    *,
    statistic: Callable[[Sequence[float]], float] = statistics.median,
    n_resamples: int = 1000,
    confidence: float = 0.95,
    seed: int | None = None,
) -> tuple[float, float] | None:
    """Percentile bootstrap CI of ``statistic(values)``.

    BLOCKWISE for a streaming gate (F9-E3, Bisani and Ney): each element of
    ``values`` is already ONE WHOLE RUN's scalar summary (e.g. one run's
    ``medical_wer``), so resampling whole elements with replacement resamples
    whole RUNS, not individual frames/utterances within a run -- it respects
    the within-run autocorrelation a streaming session has by construction,
    rather than treating every observation as independent.

    Returns ``None`` for fewer than 2 samples (nothing to resample) -- the
    caller falls back to ``median_mad_bounds`` in that case.
    """
    n = len(values)
    if n < 2:
        return None
    rng = random.Random(seed)
    resampled = sorted(
        statistic([values[rng.randrange(n)] for _ in range(n)]) for _ in range(n_resamples)
    )
    alpha = (1.0 - confidence) / 2.0
    lo_idx = max(0, min(n_resamples - 1, int(alpha * n_resamples)))
    hi_idx = max(0, min(n_resamples - 1, int((1.0 - alpha) * n_resamples) - 1))
    return (resampled[lo_idx], resampled[hi_idx])


# ===========================================================================
# N>=1 aggregate gate -- the multi-run counterpart of regression_report/
# assert_no_regression, used by the live scorecard test once it loops N runs
# per clip (M-11 / ST-4).
# ===========================================================================


def aggregate_metric(
    values: Sequence[float],
    *,
    direction: str,
    ceiling: float | None = None,
    floor: float | None = None,
    baseline: float | None = None,
    epsilon: float = 0.0,
    use_bootstrap: bool = True,
    n_resamples: int = 1000,
    seed: int | None = None,
) -> dict[str, Any]:
    """One metric's N-run verdict.

    ``direction`` is ``"lower"`` (smaller is better, e.g. WER) or ``"higher"``
    (bigger is better, e.g. recall). The absolute ceiling/floor check always
    uses the robust point estimate (median). The baseline check uses the
    WORSE bound of a bootstrap CI when >=2 samples are available (a proper
    statistical comparison, not a single hand-widened epsilon); with fewer
    samples, or when ``use_bootstrap=False``, it falls back to the
    median +/- 2*MAD worst-case bound.
    """
    if not values:
        return {"observed_n": 0, "passed": False, "reason": "no observations"}
    med = median(values)
    lo, hi = median_mad_bounds(values)
    result: dict[str, Any] = {
        "observed_n": len(values),
        "median": round(med, 6),
        "mad_bounds": [round(lo, 6), round(hi, 6)],
        "values": [round(v, 6) for v in values],
    }
    checks: list[dict[str, Any]] = []
    worse_bound = hi if direction == "lower" else lo

    if ceiling is not None:
        checks.append(_check("ceiling", med, ceiling, med <= ceiling, "<= ceiling (median)"))
    if floor is not None:
        checks.append(_check("floor", med, floor, med >= floor, ">= floor (median)"))

    if baseline is not None:
        ci = bootstrap_ci(values, n_resamples=n_resamples, seed=seed) if use_bootstrap else None
        result["bootstrap_ci"] = list(ci) if ci else None
        if ci is not None:
            bound = ci[1] if direction == "lower" else ci[0]
            source = "bootstrap_ci"
        else:
            bound = worse_bound
            source = "median+/-2xMAD"
        limit = baseline + epsilon if direction == "lower" else baseline - epsilon
        ok = bound <= limit if direction == "lower" else bound >= limit
        checks.append(
            _check(
                f"vs_baseline ({source})",
                bound,
                limit,
                ok,
                "<= limit" if direction == "lower" else ">= limit",
            )
        )

    result["checks"] = checks
    result["passed"] = all(c["passed"] for c in checks) if checks else True
    return result


def regression_report_aggregate(
    scorecards: Sequence[Mapping[str, Any]],
    thresholds: Mapping[str, Any],
    *,
    n_resamples: int = 1000,
    seed: int | None = None,
) -> dict[str, Any]:
    """The N>=1 multi-run counterpart of ``regression_report``.

    Each element of ``scorecards`` is one run's ``build_scorecard(...)``
    output for the SAME clip/fixture. Aggregates every gated metric across
    the N runs (median + 2xMAD point estimate; bootstrap CI for a baseline
    comparison) and refuses to pass a vacuous ``committed_revision_rate``
    (0.0 across every run with none of them ``measurable`` -- M-11 honesty).
    """
    if not scorecards:
        return {"passed": False, "checks": {}, "error": "no runs to aggregate (N=0)"}

    checks: dict[str, Any] = {}

    def _values(section: str, key: str) -> list[float]:
        out: list[float] = []
        for card in scorecards:
            v = card.get(section, {}).get(key)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                out.append(float(v))
        return out

    wer_cfg = thresholds.get("medical_wer", {})
    wer_vals = _values("quality", "medical_wer")
    if wer_vals:
        checks["medical_wer"] = aggregate_metric(
            wer_vals,
            direction="lower",
            ceiling=wer_cfg.get("ceiling"),
            baseline=wer_cfg.get("baseline"),
            epsilon=wer_cfg.get("epsilon", 0.0),
            n_resamples=n_resamples,
            seed=seed,
        )

    for name in ("keyterm_recall", "keyphrase_recall"):
        cfg = thresholds.get(name, {})
        vals = _values("quality", name)
        if vals:
            checks[name] = aggregate_metric(
                vals,
                direction="higher",
                floor=cfg.get("floor"),
                baseline=cfg.get("baseline"),
                epsilon=cfg.get("epsilon", 0.0),
                n_resamples=n_resamples,
                seed=seed,
            )

    # committed_revision_rate -- M-11 honesty: a run set where NO run ever had a
    # measurable committed prefix must not silently pass as "0.0 churn".
    cr_cfg = thresholds.get("committed_revision_rate", {})
    cr_pairs: list[tuple[float, Any]] = []
    for card in scorecards:
        t = card.get("transport", {})
        v = t.get("committed_revision_rate")
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            cr_pairs.append((float(v), t.get("committed_revision_rate_measurable")))
    if cr_pairs:
        if cr_cfg.get("baseline") is not None and not any(m for _, m in cr_pairs):
            checks["committed_revision_rate"] = {
                "observed_n": len(cr_pairs),
                "passed": False,
                "reason": (
                    "committed_revision_rate is vacuously 0.0 across all N runs -- no partial "
                    "in any run carried a measurable committed prefix (stableChars > 0); an "
                    "untested code path must not report a green result"
                ),
            }
        else:
            checks["committed_revision_rate"] = aggregate_metric(
                [v for v, _ in cr_pairs],
                direction="lower",
                baseline=cr_cfg.get("baseline"),
                epsilon=cr_cfg.get("epsilon", 0.0),
                n_resamples=n_resamples,
                seed=seed,
            )

    cl_cfg = thresholds.get("commit_latency_ms", {})
    cl_p50_vals: list[float] = []
    for card in scorecards:
        cl = card.get("transport", {}).get("commit_latency_ms")
        if isinstance(cl, Mapping) and isinstance(cl.get("p50"), (int, float)):
            cl_p50_vals.append(float(cl["p50"]))
    if cl_p50_vals:
        base = cl_cfg.get("p50_baseline")
        ratio = cl_cfg.get("epsilon_ratio", 0.0)
        checks["commit_latency_ms_p50"] = aggregate_metric(
            cl_p50_vals,
            direction="lower",
            baseline=base,
            epsilon=(base * ratio) if base is not None else 0.0,
            n_resamples=n_resamples,
            seed=seed,
        )

    gap_cfg = thresholds.get("seq_gap_count", {})
    gap_vals = _values("transport", "seq_gap_count")
    if gap_vals and gap_cfg.get("max") is not None:
        # Zero tolerance: the WORST (max) run counts, never the median -- a
        # single dropped caption anywhere in N runs is a real drop.
        worst = max(gap_vals)
        checks["seq_gap_count"] = {
            "observed_n": len(gap_vals),
            "max_observed": worst,
            "passed": worst <= gap_cfg["max"],
            "reason": (
                None
                if worst <= gap_cfg["max"]
                else f"seq gap seen in at least one of {len(gap_vals)} runs"
            ),
        }

    cov_cfg = thresholds.get("audio_coverage_ratio", {})
    cov_vals = _values("transport", "audio_coverage_ratio")
    if cov_vals:
        checks["audio_coverage_ratio"] = aggregate_metric(
            cov_vals,
            direction="higher",
            baseline=cov_cfg.get("baseline"),
            epsilon=cov_cfg.get("epsilon", 0.0),
            n_resamples=n_resamples,
            seed=seed,
        )

    if not checks:
        return {
            "passed": False,
            "checks": {},
            "error": "no observable aggregate metrics across the N runs",
        }
    return {"passed": all(c.get("passed") for c in checks.values()), "checks": checks}


def assert_no_regression_aggregate(
    scorecards: Sequence[Mapping[str, Any]],
    thresholds: Mapping[str, Any],
    *,
    n_resamples: int = 1000,
    seed: int | None = None,
) -> dict[str, Any]:
    """Raise ``AssertionError`` on any aggregate breach; else return the verdict."""
    report = regression_report_aggregate(
        scorecards, thresholds, n_resamples=n_resamples, seed=seed
    )
    if not report["passed"]:
        failing = {k: v for k, v in report.get("checks", {}).items() if not v.get("passed")}
        detail = report.get("error") or json.dumps(failing, ensure_ascii=False, default=str)
        raise AssertionError(
            f"streaming quality regression (N={len(scorecards)} aggregate) "
            f"vs committed thresholds: {detail}"
        )
    return report
