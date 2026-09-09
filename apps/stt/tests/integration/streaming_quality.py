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
* ``keyterm_recall(keyterms, hyp)`` — fraction of curated clinical keyterms
  present as a CONTIGUOUS span (verbatim phrase) in the hypothesis. The strict
  "did we drop the drug / dose / finding" catcher.
* ``keyphrase_recall(keyphrases, hyp)`` — fraction present as an ordered
  SUBSEQUENCE (gaps allowed) — a looser recall for longer descriptive phrases
  where an inserted filler word shouldn't zero the phrase.
* ``build_scorecard(...)`` — composes the quality fields + the reused
  transport metrics into one flat scorecard dict.
* ``regression_report(scorecard, thresholds)`` — pure verdict (never raises).
* ``assert_no_regression(scorecard, thresholds)`` — the pass/fail gate: raises
  ``AssertionError`` on any breach (an assertion the loss harness deferred).

All WER/recall values are surface-form only — NOT UMLS/MEDCON concept linking
(that is future work, gated on persisted NamedEntity codes).
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
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
) -> dict[str, Any]:
    """Compose quality metrics + the reused loss-harness transport metrics.

    ``transport_metrics`` is the dict returned by the loss harness's
    ``compute_metrics`` — this pulls out the guardrail fields the gate reads.
    """
    wer = medical_wer(reference, hypothesis, synonyms=synonyms)
    kt = keyterm_recall(keyterms, hypothesis, synonyms=synonyms)
    kp = keyphrase_recall(keyphrases, hypothesis, synonyms=synonyms)

    tm = transport_metrics or {}
    partial = tm.get("partial_revision") or {}
    committed = tm.get("committed_revision") or {}
    loss = tm.get("loss") or {}
    seq = loss.get("seq") or {}

    return {
        "quality": {
            "medical_wer": wer["wer"],
            "keyterm_recall": kt["recall"],
            "keyphrase_recall": kp["recall"],
            "detail": {"wer": wer, "keyterm": kt, "keyphrase": kp},
        },
        "transport": {
            "first_partial_ms": tm.get("first_partial_ms"),
            "ttfw_ms": tm.get("ttfw_ms"),
            "commit_latency_ms": tm.get("commit_latency_ms"),
            # committed_revision_rate is the GATED churn guardrail (settled-text
            # rewrite); partial_revision_rate is retained INFORMATIONAL (full-caption
            # churn incl. the by-design tentative tail — useful for cadence tuning).
            "committed_revision_rate": committed.get("rate"),
            "partial_revision_rate": partial.get("rate"),
            "seq_gap_count": seq.get("gap_count"),
            "audio_coverage_ratio": loss.get("audio_coverage_ratio"),
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
    if cr is not None and cr_cfg.get("baseline") is not None:
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
