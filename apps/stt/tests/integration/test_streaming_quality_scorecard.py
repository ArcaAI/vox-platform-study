"""Streaming QUALITY scorecard + regression gate.

EXTENDS ``test_streaming_loss_harness.py`` (imports its through-the-
gateway session bootstrap + transport metrics — does NOT fork it) with the
CLINICAL QUALITY metrics the SOTA ASR/NER track is scored against:

* **medical WER** — word error rate of the concatenated time-ordered finals vs a
  fixture ground-truth (``*.gt.txt``), medical-term-aware normalization.
* **clinical keyterm / keyphrase recall** — fraction of a clip's curated clinical
  keyterms/keyphrases (``*.keyterms.json``) present in the hypothesis. The
  "did we drop the drug / dose / finding" catcher.
* **term-restricted WER** (informational, ST-4/F9-K4) — WER scored only on the
  clip's own curated term list.

and an **N-run AGGREGATE pass/fail regression gate**
(``streaming_thresholds.json`` + ``regression_report_aggregate`` /
``assert_no_regression_aggregate``) — the M-11/ST-4 redesign of the assertion
the baseline-only loss harness deliberately deferred: median + 2xMAD point
estimate, bootstrap CI wherever a baseline comparison is claimed, and a
**BP-1 structured fingerprint** read from the SESSION the harness opened
(never re-derived from the seed — M-15's root cause) that makes the gate
SKIP WITH A REASON instead of silently comparing two different
configurations (M-16's "the gate did not catch a 27x accuracy regression").

FOUR KINDS OF TEST live here (mirroring the loss harness's split):

1. ``test_quality_metric_functions_are_correct`` and its neighbors — PURE-CPU
   self-checks. Run with **no services up** (this module overrides the
   integration conftest's docker gate, like the loss harness). Pin the WER /
   keyterm / keyphrase / fingerprint / aggregate-gate math against
   hand-computed inputs. THIS is the unit gate this ticket owns.
2. ``test_clinical_fixtures_are_wellformed`` + the ST-4 fixture-manifest
   self-checks — PURE-CPU: the de-identified clinical fixture set parses to
   the expected schema and carries no obvious PHI; the ST-4 manifest resolves
   each fixture class to either "available" or a clean skip-with-reason.
3. ``test_streaming_quality_scorecard`` — the LIVE run through the WS gateway
   that produces a REAL scorecard JSON artifact + gates the AGGREGATE of
   N>=1 runs per clip. Self-skips cleanly when STT / login / a clinical WAV
   is unavailable. Producing the captured baseline scorecard on a live stack
   is the ORCHESTRATOR's step (exactly like the loss harness's live
   baseline), so this test skips — never fails — off-stack.
4. ``test_streaming_quality_scorecard_steady_state`` and the other ST-4
   scaffolding tests (noise-augmented, negative controls, diarization,
   ml-en-through-the-gateway) — LIVE, but self-skip with a named reason
   because their fixtures are never committed to git (real/de-identified
   clinical audio). Wiring, not measurement: once a fixture lands, the same
   N-run aggregate gate machinery applies.

ENV VARS added on top of the loss harness's own (``STREAM_*``):

============================== ============================================
``STREAM_QUALITY_N``           runs per clip for the aggregate gate
                                (default 5 — README §5 "N and statistics")
``STREAM_QUALITY_BOOTSTRAP_N``  bootstrap resamples for a baseline comparison
                                (default 1000 — F9-E3)
``STREAM_STT_LOG_PATH``        path to STT's own structured (JSON-lines) log
                                output, read for the ``stt.streaming.fingerprint``
                                event per session (BP-1). Unset ⇒ every run's
                                fingerprint is ``None`` and the gate SKIPS WITH
                                A REASON rather than comparing blind.
============================== ============================================

Run::

    pnpm py:stt:test                 # whole suite; the pure self-checks run off-stack
    pnpm py:stt:test:integration     # this + the loss harness
    # or just this module's pure gate:
    conda run -n arcaenv --no-capture-output pytest \
        apps/stt/tests/integration/test_streaming_quality_scorecard.py \
        -k "functions_are_correct or fingerprint or aggregate or manifest" -v
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import pytest

# The functions under test (this ticket's pure metric module).
from tests.integration.streaming_quality import (
    MEDICAL_SYNONYMS,
    assert_no_regression,
    assert_no_regression_aggregate,
    bootstrap_ci,
    build_scorecard,
    character_error_rate,
    check_fingerprint,
    extract_fingerprint,
    find_fingerprint_in_log,
    fingerprint_mismatch,
    keyphrase_recall,
    keyterm_recall,
    mad,
    median,
    median_mad_bounds,
    medical_wer,
    normalize_text,
    regression_report,
    regression_report_aggregate,
    term_restricted_wer,
)

# Reuse the loss harness (import — do NOT fork). All module-level & importable.
from tests.integration.test_streaming_loss_harness import (
    ReplayAudio,
    committed_revision_rate,
    compute_metrics,
    load_replay_audio,
    partial_revision_rate,
)
from tests.integration.test_streaming_loss_harness import (
    _api_unreachable_reason as api_unreachable_reason,
)
from tests.integration.test_streaming_loss_harness import (
    _env as env,
)
from tests.integration.test_streaming_loss_harness import (
    _env_float as env_float,
)
from tests.integration.test_streaming_loss_harness import (
    _login as login,
)
from tests.integration.test_streaming_loss_harness import (
    _run_one_session as run_one_session,
)
from tests.integration.test_streaming_loss_harness import (
    _stt_unreachable_reason as stt_unreachable_reason,
)
from tests.integration.test_streaming_loss_harness import (
    _warmup_session as warmup_session,
)
from tests.integration.test_streaming_loss_harness import (
    _ws_origin as ws_origin,
)

pytestmark = [pytest.mark.integration]

_THRESHOLDS_PATH = Path(__file__).resolve().parent / "streaming_thresholds.json"
_FIXTURES_ROOT = Path(__file__).resolve().parents[1] / "e2e" / "fixtures"
_CLINICAL_DIR = _FIXTURES_ROOT / "clinical"
_FIXTURE_MANIFEST_PATH = _FIXTURES_ROOT / "streaming-fixture-manifest.json"


@pytest.fixture(scope="session")
def verify_test_environment():  # noqa: D401 — fixture override
    """Override the integration conftest's docker-compose gate.

    The pure self-checks in this module need NO infrastructure; the live
    scorecard test performs its own reachability probes with clean skips. So —
    exactly like the loss harness — neutralize the directory-level test-Postgres
    gate for this module.
    """
    yield


def _load_thresholds() -> dict[str, Any]:
    return json.loads(_THRESHOLDS_PATH.read_text(encoding="utf-8"))


def _load_fixture_manifest() -> dict[str, Any]:
    return json.loads(_FIXTURE_MANIFEST_PATH.read_text(encoding="utf-8"))


def _resolve_fixture_class(name: str, manifest: dict[str, Any]) -> dict[str, Any]:
    """Resolve one ST-4 manifest fixture class against the filesystem/env.

    NEVER raises — an unresolvable class is reported unavailable with a
    reason, exactly like the existing ``*.wav``-missing skip in
    ``test_streaming_quality_scorecard`` (§3). Returns
    ``{"available": bool, "reason": str | None, "files": [...]}``.
    """
    spec = manifest.get("classes", {}).get(name)
    if spec is None:
        return {"available": False, "reason": f"unknown fixture class {name!r}", "files": []}

    env_dir = spec.get("env_dir")
    if env_dir:
        raw = os.environ.get(env_dir, "").strip()
        if not raw:
            return {
                "available": False,
                "reason": spec.get("skip_reason_needs_env", f"{env_dir} is not set"),
                "files": [],
            }
        p = Path(raw)
        if not p.is_dir():
            return {
                "available": False,
                "reason": f"{env_dir}={raw!r} is not a directory",
                "files": [],
            }
        return {"available": True, "reason": None, "files": [str(p)]}

    clip_dir = _FIXTURES_ROOT / spec["dir"]

    if spec.get("file"):
        target = clip_dir / spec["file"]
        if not target.is_file():
            return {
                "available": False,
                "reason": spec.get("skip_reason", f"{target} not found"),
                "files": [],
            }
        return {"available": True, "reason": None, "files": [str(target)]}

    if spec.get("file_glob"):
        matches = sorted(clip_dir.glob(spec["file_glob"])) if clip_dir.is_dir() else []
        if not matches:
            return {
                "available": False,
                "reason": spec.get("skip_reason", f"no {spec['file_glob']} under {clip_dir}"),
                "files": [],
            }
        return {"available": True, "reason": None, "files": [str(m) for m in matches]}

    pattern = spec.get("pattern", "*.gt.txt")
    matches = sorted(clip_dir.glob(pattern)) if clip_dir.is_dir() else []
    if not matches:
        return {
            "available": False,
            "reason": spec.get("skip_reason", f"no {pattern} under {clip_dir}"),
            "files": [],
        }
    return {"available": True, "reason": None, "files": [str(m) for m in matches]}


def _quality_n() -> int:
    """Runs per clip for the aggregate gate (M-11/ST-4: N>=5 by default).

    Configurable so a quick local smoke pass can dial it down; the
    orchestrator's real capture runs at the default (README §5 "N and
    statistics": "N >= 5 runs per fixture on a quiet stack").
    """
    raw = os.environ.get("STREAM_QUALITY_N", "").strip()
    try:
        n = int(raw) if raw else 5
    except ValueError:
        n = 5
    return max(1, n)


def _bootstrap_resamples() -> int:
    raw = os.environ.get("STREAM_QUALITY_BOOTSTRAP_N", "").strip()
    try:
        b = int(raw) if raw else 1000
    except ValueError:
        b = 1000
    return max(100, b)


# ===========================================================================
# 1. PURE metric self-check (no services) — the unit gate this ticket owns
# ===========================================================================


def test_committed_revision_rate_excludes_tentative_tail() -> None:
    """The churn guardrail must measure the LA-2 COMMITTED region
    (``text[:stable_chars]``), not the full caption — revising the deliberately
    provisional tentative tail is by design and must NOT count as caption churn.
    """
    # Tentative-tail revision only: committed prefix "the patient" is stable across
    # both partials (stable_chars=11); only the ghosted tail is re-transcribed.
    tail_only = [("the patient has", 11), ("the patient presents now", 11)]
    assert committed_revision_rate(tail_only)["rate"] == 0.0
    # The full-caption metric DOES flag the same pair (the tail rewrite) — proving
    # the two metrics measure different surfaces and the committed one excludes the tail.
    assert partial_revision_rate([t for t, _ in tail_only])["rate"] > 0.0

    # Genuine committed churn: the settled prefix itself shrinks/rewrites (an LA-2
    # rollback of already-committed text) → still counted (the real guardrail bites).
    rollback = [("the patient has", 15), ("the patient", 11)]
    assert committed_revision_rate(rollback)["rate"] > 0.0

    # No stable_chars (LA-2 off / nothing committed yet) → empty committed prefix →
    # never a rewrite (null-safe; the metric reads all-None as "no committed churn").
    assert committed_revision_rate([("abc", None), ("xyz", None)])["rate"] == 0.0
    # A stable, forward-extending committed prefix is not a revision.
    assert committed_revision_rate([("the", 3), ("the patient", 11)])["rate"] == 0.0

    # A tail-only frame carries NO committed-prefix info: the STT pipeline emits
    # stableChars=0 on tentative-tail refreshes (the UI carries the settled
    # prefix forward, never un-settling it). A non-empty committed prefix followed by
    # such an sc=0 frame is NOT a committed rewrite — the metric must skip the frame,
    # else it false-positives on every tail refresh (regression observed live: a
    # scorecard on one pipeline reported ~0.10-0.15 committed churn that
    # was ENTIRELY sc→0 tail frames, not settled-text flicker).
    assert (
        committed_revision_rate([("the patient has", 11), ("the patient has more", 0)])["rate"]
        == 0.0
    )
    # Interleaved commit / tail / commit (the live wire pattern sc 11→0→19): the sc=0
    # tail frame must not break the prefix comparison; the forward-extending commit is clean.
    assert (
        committed_revision_rate(
            [("the patient", 11), ("the patient ghosted tail", 0), ("the patient is here", 19)]
        )["rate"]
        == 0.0
    )
    # A genuine committed rollback SEPARATED by a tail frame is STILL caught — skipping
    # sc=0 frames carries the last committed prefix forward, so it is not blind to churn.
    assert (
        committed_revision_rate([("the patient has", 15), ("x", 0), ("the patient", 11)])["rate"]
        > 0.0
    )


def test_committed_revision_rate_reports_measurable_honestly() -> None:
    """M-11 fix: ``measurable`` distinguishes "genuinely 0.0 churn" from
    "no partial ever carried a committed prefix at all" — today's failure
    mode, where the gate PASSED while measuring nothing.
    """
    # No entry ever reports stable_chars > 0 -> the metric is NOT measurable,
    # even though the rate itself is (vacuously) 0.0.
    never_measurable = committed_revision_rate([("abc", None), ("xyz", 0)])
    assert never_measurable["rate"] == 0.0
    assert never_measurable["measurable"] is False

    # At least one entry carries a real committed prefix -> measurable, even
    # though this run also happens to hold at 0.0 churn (a genuine clean run).
    genuinely_clean = committed_revision_rate([("the patient", 11), ("the patient is here", 11)])
    assert genuinely_clean["rate"] == 0.0
    assert genuinely_clean["measurable"] is True

    # A real committed rewrite is naturally measurable too.
    churned = committed_revision_rate([("the patient has", 15), ("the patient", 11)])
    assert churned["rate"] > 0.0
    assert churned["measurable"] is True


def test_quality_metric_functions_are_correct() -> None:
    """Pin the WER / recall / regression-gate math (runs with no services up)."""
    # --- normalization: case/punct fold, whitespace collapse ---------------
    assert normalize_text("The  Patient's B.P. was 120/80!") == "the patient's bp was 12080"

    # --- normalization: hyphen/en-dash/em-dash between alphanumerics splits
    # to a space (a word JOIN, not punctuation to drop) — TASK-935 R-3, the
    # discharge-fixture miss where "community-acquired" fused into one token
    # and cost the key-term gate a false miss.
    assert normalize_text("community-acquired pneumonia") == "community acquired pneumonia"
    assert normalize_text("follow-up") == "follow up"
    assert normalize_text("pre–op") == "pre op"  # en dash (–)
    assert normalize_text("well—done") == "well done"  # em dash (—)
    # --- normalization: a slash is a word join ONLY when it is not flanked by
    # digits on both sides — "mg/dL" (unit ratio, a word) splits, "120/80"
    # (a numeric reading) stays fused exactly as before.
    assert normalize_text("mg/dL") == "mg dl"
    assert normalize_text("120/80") == "12080"

    # --- medical WER: identical → 0 ----------------------------------------
    ident = medical_wer("the patient has hypertension", "the patient has hypertension")
    assert ident["wer"] == 0.0
    assert (ident["substitutions"], ident["deletions"], ident["insertions"]) == (0, 0, 0)
    assert ident["reference_words"] == 4

    # --- one deletion + one substitution → WER 2/5 = 0.4 -------------------
    #   ref: the patient has severe hypertension  (N=5)
    #   hyp:     patient has  mild  hypertension  (del "the", sub severe→mild)
    sub = medical_wer("the patient has severe hypertension", "patient has mild hypertension")
    assert sub["substitutions"] == 1
    assert sub["deletions"] == 1
    assert sub["insertions"] == 0
    assert sub["wer"] == pytest.approx(0.4)

    # --- two insertions → WER 2/3 ------------------------------------------
    ins = medical_wer("patient has hypertension", "the patient has severe hypertension")
    assert ins["insertions"] == 2
    assert ins["substitutions"] == 0
    assert ins["deletions"] == 0
    assert ins["wer"] == pytest.approx(2 / 3)

    # --- empty-reference edge cases ----------------------------------------
    assert medical_wer("", "")["wer"] == 0.0
    assert medical_wer("", "unexpected words")["wer"] == 1.0

    # --- medical-term awareness: synonym map folds "milligrams" → "mg" -----
    raw = medical_wer("administered 5 mg", "administered 5 milligrams")
    assert raw["wer"] == pytest.approx(1 / 3)  # "milligrams" ≠ "mg" without the map
    aware = medical_wer("administered 5 mg", "administered 5 milligrams", synonyms=MEDICAL_SYNONYMS)
    assert aware["wer"] == 0.0  # folded → exact match
    assert "milligrams" in MEDICAL_SYNONYMS and MEDICAL_SYNONYMS["milligrams"] == "mg"

    # --- keyterm recall: contiguous span match -----------------------------
    hyp_meds = "the patient was prescribed metformin 500 mg twice daily for type 2 diabetes"
    kt = keyterm_recall(["metformin", "type 2 diabetes", "insulin", "500 mg"], hyp_meds)
    assert kt["matched"] == 3
    assert kt["total"] == 4
    assert kt["recall"] == pytest.approx(0.75)
    assert kt["missing"] == ["insulin"]

    # empty keyterm list → vacuously full recall (neutral guardrail)
    assert keyterm_recall([], hyp_meds)["recall"] == 1.0
    assert keyterm_recall([], hyp_meds)["total"] == 0

    # --- keyphrase recall: subsequence (gaps allowed) vs keyterm (strict) --
    hyp_sob = "the patient reports shortness of breath on mild exertion"
    #   "shortness of breath on exertion" is NOT a contiguous span (word "mild"
    #   splits "on … exertion") → keyterm strict FAILS, keyphrase subseq PASSES.
    assert keyterm_recall(["shortness of breath on exertion"], hyp_sob)["recall"] == 0.0
    kp = keyphrase_recall(
        ["shortness of breath", "shortness of breath on exertion", "chest pain"], hyp_sob
    )
    assert kp["matched"] == 2
    assert kp["total"] == 3
    assert kp["recall"] == pytest.approx(2 / 3)
    assert kp["missing"] == ["chest pain"]

    # --- build_scorecard composes quality + reused transport metrics -------
    # commit_latency_ms below matches the committed streaming_thresholds.json
    # baseline (TASK-934/M, 2026-09-09 re-capture: p50/p99_baseline 4056.7 ms) — a
    # "clean" scorecard must sit at-or-under whatever is actually committed, or
    # this self-check breaks every time the thresholds are re-captured.
    transport = {
        "first_partial_ms": 4920.4,
        "ttfw_ms": 4920.4,
        "commit_latency_ms": {"count": 11, "p50": 4056.7, "p99": 4200.0},
        "partial_revision": {"partials": 1, "revisions": 0, "rate": 0.0},
        "committed_revision": {"partials": 1, "revisions": 0, "rate": 0.0, "measurable": True},
        "loss": {"seq": {"gap_count": 0}, "audio_coverage_ratio": 0.996},
    }
    card = build_scorecard(
        reference="the patient has type 2 diabetes",
        hypothesis="the patient has type 2 diabetes",
        keyterms=["type 2 diabetes"],
        keyphrases=["type 2 diabetes"],
        transport_metrics=transport,
    )
    assert card["quality"]["medical_wer"] == 0.0
    assert card["quality"]["keyterm_recall"] == 1.0
    assert card["quality"]["keyphrase_recall"] == 1.0
    assert card["quality"]["primary_metric"] == "medical_wer"
    assert card["transport"]["commit_latency_ms"]["p50"] == 4056.7
    assert card["transport"]["committed_revision_rate"] == 0.0  # the GATED A1 guardrail
    assert card["transport"]["committed_revision_rate_measurable"] is True
    assert card["transport"]["partial_revision_rate"] == 0.0  # informational (ungated)
    assert card["transport"]["seq_gap_count"] == 0
    assert card["transport"]["audio_coverage_ratio"] == 0.996

    # --- regression gate: a clean card PASSES against committed thresholds --
    thresholds = _load_thresholds()
    good_report = regression_report(card, thresholds)
    assert good_report["passed"] is True, good_report
    # assert_no_regression must NOT raise on a passing card and returns the verdict
    assert assert_no_regression(card, thresholds)["passed"] is True

    # --- regression gate: each guardrail breach FAILS ----------------------
    # (a) WER above the ceiling
    bad_wer = build_scorecard(
        reference="the patient has type 2 diabetes",
        hypothesis="completely different words entirely here",
        keyterms=["type 2 diabetes"],
        keyphrases=["type 2 diabetes"],
        transport_metrics=transport,
    )
    assert regression_report(bad_wer, thresholds)["passed"] is False
    with pytest.raises(AssertionError):
        assert_no_regression(bad_wer, thresholds)

    # (b) dropped caption (seq gap) — a hard zero-tolerance guardrail
    dropped = json.loads(json.dumps(card))
    dropped["transport"]["seq_gap_count"] = 2
    assert regression_report(dropped, thresholds)["passed"] is False
    with pytest.raises(AssertionError):
        assert_no_regression(dropped, thresholds)

    # (c) commit-latency P99 blown past baseline × (1 + ε)
    slow = json.loads(json.dumps(card))
    slow["transport"]["commit_latency_ms"]["p99"] = 99_999.0
    assert regression_report(slow, thresholds)["passed"] is False

    # (d) keyterm recall below the floor
    dropped_term = json.loads(json.dumps(card))
    dropped_term["quality"]["keyterm_recall"] = 0.0
    assert regression_report(dropped_term, thresholds)["passed"] is False

    # (f) committed-region revision above baseline+ε — the churn guardrail
    # bites on genuine settled-text churn (a high full-caption tail rate would NOT,
    # since partial_revision_rate is now informational/ungated).
    churned = json.loads(json.dumps(card))
    churned["transport"]["committed_revision_rate"] = 0.5
    churned_report = regression_report(churned, thresholds)
    assert churned_report["passed"] is False
    assert any(
        c["metric"] == "committed_revision_rate" and not c["passed"]
        for c in churned_report["checks"]
    )

    # (g) M-11 honesty: a 0.0 committed_revision_rate with measurable=False
    # must FAIL, not vacuously pass — the untested-code-path case.
    vacuous = json.loads(json.dumps(card))
    vacuous["transport"]["committed_revision_rate"] = 0.0
    vacuous["transport"]["committed_revision_rate_measurable"] = False
    vacuous_report = regression_report(vacuous, thresholds)
    assert vacuous_report["passed"] is False
    assert any(
        c["metric"] == "committed_revision_rate" and not c["passed"]
        for c in vacuous_report["checks"]
    )

    # (e) a metric-less scorecard must NOT pass vacuously (`all([])` is True)
    empty = regression_report({}, thresholds)
    assert empty["passed"] is False and empty["checks"] == []
    assert regression_report({"quality": {}, "transport": {}}, thresholds)["passed"] is False
    with pytest.raises(AssertionError):
        assert_no_regression({}, thresholds)


def test_keyterm_recall_treats_hyphenated_word_joins_as_spaces() -> None:
    """A curated key term written with spaces must still match a hyphenated
    hypothesis surface form: "community-acquired pneumonia" is the same
    clinical term as "community acquired pneumonia", not a miss.

    This is the exact discharge-fixture regression (TASK-935 R-3): before the
    hyphen fix, ``normalize_text`` fused the hyphen away with no space
    ("community-acquired" -> "communityacquired"), so a key term written with
    spaces could never match — one of the two misses behind the fixture's
    0.667 recall against the 0.70 floor.
    """
    kt = keyterm_recall(["community acquired pneumonia"], "community-acquired pneumonia")
    assert kt["recall"] == 1.0
    assert kt["missing"] == []

    # The keyphrase (subsequence) matcher gets the same benefit.
    kp = keyphrase_recall(["community acquired pneumonia"], "community-acquired pneumonia")
    assert kp["recall"] == 1.0


def test_term_restricted_wer_and_cer() -> None:
    """ST-4/F9-K4 MedWER-shape WER: scored only on the curated term list, not
    the whole utterance. F9-E2 CER: primary for Malayalam/code-switch.
    """
    trw = term_restricted_wer(
        "patient on metformin 500 mg for diabetes",
        "patient on metformin 500 mg for diabetes",
        ["metformin", "500 mg", "diabetes"],
    )
    assert trw["wer"] == 0.0

    # A genuine substitution WITHIN the restricted vocabulary.
    trw_sub = term_restricted_wer(
        "patient on metformin 500 mg",
        "patient on insulin 500 mg",
        ["metformin", "insulin", "500 mg"],
    )
    assert trw_sub["substitutions"] == 1

    # A word outside the vocabulary never enters the score at all — only the
    # curated terms move this metric, unlike medical_wer which scores the
    # whole utterance ("a missed 'atorvastatin' moves it, a missed 'the'
    # does not").
    trw_neutral = term_restricted_wer(
        "the quick brown fox jumps over metformin 500 mg",
        "a slow red dog metformin 500 mg",
        ["metformin", "500 mg"],
    )
    assert trw_neutral["wer"] == 0.0

    cer = character_error_rate("the patient has hypertension", "the patient has hypertension")
    assert cer["cer"] == 0.0
    cer_err = character_error_rate("hello", "helo")
    assert cer_err["cer"] > 0.0
    assert character_error_rate("", "")["cer"] == 0.0
    assert character_error_rate("", "x")["cer"] == 1.0

    # build_scorecard wires both in as ADDITIVE quality fields — medical_wer
    # and keyterm_recall stay present and unaffected either way.
    transport = {
        "committed_revision": {"rate": 0.0, "measurable": True},
        "loss": {"seq": {"gap_count": 0}, "audio_coverage_ratio": 1.0},
    }
    plain = build_scorecard(
        reference="patient on metformin",
        hypothesis="patient on metformin",
        keyterms=["metformin"],
        keyphrases=[],
        transport_metrics=transport,
    )
    assert "term_restricted_wer" not in plain["quality"]
    assert "cer" not in plain["quality"]
    assert plain["quality"]["primary_metric"] == "medical_wer"

    enriched = build_scorecard(
        reference="patient on metformin",
        hypothesis="patient on metformin",
        keyterms=["metformin"],
        keyphrases=[],
        transport_metrics=transport,
        term_restricted_terms=["metformin"],
        cer_primary=True,
    )
    assert enriched["quality"]["term_restricted_wer"] == 0.0
    assert enriched["quality"]["cer"] == 0.0
    assert enriched["quality"]["primary_metric"] == "cer"
    # medical_wer/keyterm_recall are STILL present — cer_primary labels the
    # primary metric, it never removes the others.
    assert enriched["quality"]["medical_wer"] == 0.0
    assert enriched["quality"]["keyterm_recall"] == 1.0


def test_robust_statistics() -> None:
    """M-11/ST-4: median + 2xMAD point estimate; blockwise bootstrap CI."""
    values = [0.03, 0.04, 0.05, 0.03, 0.06]
    assert median(values) == 0.04
    assert mad(values) == pytest.approx(0.01)
    lo, hi = median_mad_bounds(values)
    assert lo == pytest.approx(0.02) and hi == pytest.approx(0.06)

    # Bootstrap CI is deterministic under a fixed seed and brackets the median.
    ci = bootstrap_ci(values, seed=7)
    assert ci is not None
    lo_ci, hi_ci = ci
    assert lo_ci <= median(values) <= hi_ci

    # Fewer than 2 samples -> no CI (nothing to resample); the caller falls
    # back to median_mad_bounds in that case.
    assert bootstrap_ci([0.5]) is None
    assert bootstrap_ci([]) is None

    # A near-constant series has a near-zero MAD and a tight CI (sanity: the
    # statistics do not manufacture spread that isn't in the data).
    tight = bootstrap_ci([0.1, 0.1, 0.1, 0.1, 0.1], seed=1)
    assert tight is not None
    assert tight[0] == pytest.approx(0.1) and tight[1] == pytest.approx(0.1)


def test_fingerprint_extract_and_compare() -> None:
    """BP-1: the fingerprint is read from a structured log EVENT, never
    re-derived from the seed — the concrete fix for M-15's root cause.
    """
    non_fingerprint_event = {"event": "stt.streaming.windows", "session_id": "s1"}
    assert extract_fingerprint(non_fingerprint_event) is None
    assert extract_fingerprint("not a mapping") is None  # type: ignore[arg-type]

    event = {
        "event": "stt.streaming.fingerprint",
        "session_id": "s1",
        "agentVersion": 3,
        "modelSlug": "arcaai-whisper-large-ml-en-gguf",
        "modelDigest": "sha256:abc",
        "maxDecodeWindowSec": 7.0,
        "partialWindowSec": 3.0,
        "partialIntervalMs": 300,
        "endpointing": "semantic",
        "vadEnabled": False,
        "promptHash": "sha256:def",
        "pairPromptEnabled": True,
        "singlePromptEnabled": False,
        "engineBuild": "whisper.cpp@abc123",
        "device": "mps",
        "sdkOperatingPoint": "scribe",
    }
    fp = extract_fingerprint(event)
    assert fp is not None
    assert fp["modelSlug"] == "arcaai-whisper-large-ml-en-gguf"
    assert fp["pairPromptEnabled"] is True

    # Identical fingerprints -> comparable, no mismatches.
    assert fingerprint_mismatch(fp, fp) == []
    identical = check_fingerprint(fp, fp)
    assert identical == {"comparable": True, "reason": None, "mismatched": []}

    # A geometry field differs by more than the numeric tolerance -> a real mismatch.
    geometry_drift = dict(fp, partialWindowSec=15.0)
    mism = fingerprint_mismatch(fp, geometry_drift)
    assert any("partialWindowSec" in m for m in mism)

    # This IS the root-cause regression today's ticket exists to close: the
    # served prompt state differs from the baseline's (e3d61eefb flipped
    # WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED) — the gate must name it and
    # refuse to compare, not silently pass or fail on unrelated numbers.
    prompt_drift = dict(fp, pairPromptEnabled=False)
    check = check_fingerprint(fp, prompt_drift)
    assert check["comparable"] is False
    assert "pairPromptEnabled" in check["reason"]
    assert any("pairPromptEnabled" in m for m in check["mismatched"])

    # A field neither side captured is not a false mismatch.
    partial_a = {"modelSlug": "m", "device": None}
    partial_b = {"modelSlug": "m", "device": None}
    assert fingerprint_mismatch(partial_a, partial_b) == []

    # No captured fingerprint at all (STREAM_STT_LOG_PATH unset, or the event
    # never matched this session) -> not comparable, named reason.
    no_candidate = check_fingerprint(None, fp)
    assert no_candidate["comparable"] is False
    assert "not captured" in no_candidate["reason"]

    # No baseline fingerprint yet (BP-1 has not re-captured) -> not
    # comparable, named reason — the scaffolding state streaming_thresholds.json
    # ships in today, before the orchestrator's live capture.
    no_baseline = check_fingerprint(fp, None)
    assert no_baseline["comparable"] is False
    assert "baseline carries no fingerprint" in no_baseline["reason"]
    no_baseline_empty = check_fingerprint(fp, {})
    assert no_baseline_empty["comparable"] is False


def test_fingerprint_scaffolding_is_present_and_not_yet_comparable() -> None:
    """The committed ``streaming_thresholds.json`` ships the BP-1 schema with
    every field null (scaffolding only — no numbers invented ahead of the
    orchestrator's live re-capture). Prove the schema is complete and that
    ``check_fingerprint`` correctly treats it as not-yet-comparable.
    """
    thresholds = _load_thresholds()
    fp = thresholds.get("_fingerprint")
    assert fp is not None, "streaming_thresholds.json is missing the BP-1 _fingerprint block"
    expected_fields = {
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
    }
    assert set(fp.keys()) == expected_fields
    assert all(v is None for v in fp.values()), (
        "the committed baseline's _fingerprint must stay null scaffolding until "
        "the orchestrator's live BP-1 re-capture fills it in — this lane must "
        "never invent fingerprint numbers"
    )

    live_candidate = {
        "agentVersion": 3,
        "modelSlug": "arcaai-whisper-large-ml-en-gguf",
        "modelDigest": "sha256:abc",
        "maxDecodeWindowSec": 7.0,
        "partialWindowSec": 3.0,
        "partialIntervalMs": 300,
        "endpointing": "semantic",
        "vadEnabled": False,
        "promptHash": "sha256:def",
        "pairPromptEnabled": True,
        "singlePromptEnabled": False,
        "engineBuild": "whisper.cpp@abc123",
        "device": "mps",
        "sdkOperatingPoint": "scribe",
    }
    check = check_fingerprint(live_candidate, fp)
    assert check["comparable"] is False
    assert "no fingerprint yet" in check["reason"]


def test_aggregate_gate_median_and_bootstrap() -> None:
    """M-11/ST-4: the N-run gate uses median+2xMAD for the absolute
    ceiling/floor and a bootstrap CI for a baseline comparison — never a
    single hand-widened epsilon on a small N.
    """
    thresholds = {
        "medical_wer": {"baseline": 0.05, "ceiling": 0.4, "epsilon": 0.05},
        "keyterm_recall": {"baseline": 1.0, "floor": 0.7, "epsilon": 0.05},
        "committed_revision_rate": {"baseline": 0.15, "epsilon": 0.07},
        "audio_coverage_ratio": {"baseline": 0.99, "epsilon": 0.01},
        "seq_gap_count": {"max": 0},
    }

    def _card(wer: float, *, measurable: bool = False, gap: int = 0) -> dict[str, Any]:
        return {
            "quality": {"medical_wer": wer, "keyterm_recall": 1.0, "keyphrase_recall": 1.0},
            "transport": {
                "committed_revision_rate": 0.0,
                "committed_revision_rate_measurable": measurable,
                "seq_gap_count": gap,
                "audio_coverage_ratio": 0.997,
                "commit_latency_ms": {"p50": 2700.0},
            },
        }

    cards = [_card(v) for v in (0.03, 0.04, 0.05, 0.03, 0.06)]

    # (a) a clean N=5 run passes the median-based ceiling AND the vacuous
    # committed_revision_rate is caught (none of the runs is `measurable`).
    report = regression_report_aggregate(cards, thresholds)
    assert report["passed"] is False
    assert report["checks"]["committed_revision_rate"]["passed"] is False
    assert "vacuously" in report["checks"]["committed_revision_rate"]["reason"]
    assert report["checks"]["medical_wer"]["passed"] is True
    assert report["checks"]["medical_wer"]["median"] == pytest.approx(0.04)

    # (b) mark ONE run as measurable=True -> the honesty gate stops firing and
    # the metric is scored normally (0.0 churn, well under baseline+epsilon).
    cards[0]["transport"]["committed_revision_rate_measurable"] = True
    report2 = regression_report_aggregate(cards, thresholds)
    assert report2["checks"]["committed_revision_rate"]["passed"] is True
    assert assert_no_regression_aggregate(cards, thresholds)["passed"] is True

    # (c) a genuine WER regression (median above ceiling) fails, and raises.
    regressed = [_card(v, measurable=True) for v in (0.5, 0.6, 0.55, 0.52, 0.58)]
    bad_report = regression_report_aggregate(regressed, thresholds)
    assert bad_report["passed"] is False
    assert bad_report["checks"]["medical_wer"]["passed"] is False
    with pytest.raises(AssertionError):
        assert_no_regression_aggregate(regressed, thresholds)

    # (d) seq_gap_count is zero-tolerance on the WORST run, not the median —
    # a single gap in N=5 clean runs still fails the gate.
    with_one_gap = [_card(v, measurable=True, gap=(1 if i == 2 else 0)) for i, v in enumerate(
        (0.03, 0.04, 0.05, 0.03, 0.06)
    )]
    gap_report = regression_report_aggregate(with_one_gap, thresholds)
    assert gap_report["checks"]["seq_gap_count"]["passed"] is False
    assert gap_report["checks"]["seq_gap_count"]["max_observed"] == 1

    # (e) N=0 fails cleanly, never vacuously.
    empty_report = regression_report_aggregate([], thresholds)
    assert empty_report["passed"] is False
    assert "N=0" in empty_report["error"]


# ===========================================================================
# 2. PURE fixture-integrity + ST-4 manifest self-check (no services)
# ===========================================================================

# PHI tripwire for EVERY current AND future SOTA clinical fixture. It matches the
# structured SHAPES that leak PHI (regex), not merely label substrings — it will
# NOT catch an arbitrary unlabeled free-text name (that is out of regex reach and
# is guarded procedurally: fixtures are synthetic scripted reads), but it DOES
# catch SSNs, phone numbers, dates/DOBs, emails, long digit runs (unlabeled
# MRNs/account numbers), and the common identifier LABELS. Any hit fails the gate.
_PHI_LABEL_FLAGS: tuple[str, ...] = (
    "ssn",
    "social security",
    "mrn",
    "medical record number",
    "date of birth",
    "dob",
    "patient name",
    "name:",
    "address:",
)
_PHI_SHAPE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("ssn", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("phone", re.compile(r"\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\(\d{3}\)\s?\d{3}[-.\s]?\d{4}")),
    ("date", re.compile(r"\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b")),
    ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("long_digit_run", re.compile(r"\b\d{7,}\b")),
)


def _scan_phi(text: str) -> list[str]:
    """Return PHI red-flag hits for ``text`` (empty list = clean).

    Catches identifier SHAPES (SSN/phone/date/email/long-digit-run) and common
    labels — the structured PHI that must never reach a committed fixture.
    """
    low = text.lower()
    hits = [f"label:{flag}" for flag in _PHI_LABEL_FLAGS if flag in low]
    hits += [f"shape:{name}" for name, pattern in _PHI_SHAPE_PATTERNS if pattern.search(text)]
    return hits


def test_phi_scanner_catches_synthetic_identifiers() -> None:
    """Prove the PHI guard itself fires (the gate is tested, not just asserted)."""
    # Structured identifiers MUST be caught:
    assert _scan_phi("SSN 123-45-6789"), "labeled SSN not caught"
    assert _scan_phi("123-45-6789"), "bare SSN shape not caught"
    assert _scan_phi("Patient name: John Q. Public, DOB 03/04/1985"), "name/DOB not caught"
    assert _scan_phi("born 1985-03-04"), "ISO date not caught"
    assert _scan_phi("call 555-123-4567"), "phone not caught"
    assert _scan_phi("reach me at jane.doe@example.com"), "email not caught"
    assert _scan_phi("record number 1234567"), "long digit run (unlabeled MRN) not caught"
    # Clean clinical prose (the shape of the real fixtures) must NOT false-positive:
    assert _scan_phi("The patient is a 62 year old with type 2 diabetes on metformin 500 mg.") == []
    assert _scan_phi("Blood pressure today is 128 over 82; oxygen saturation 96 percent.") == []


def test_clinical_fixtures_are_wellformed() -> None:
    """Each clinical clip has a parseable, de-identified gt.txt + keyterms.json."""
    if not _CLINICAL_DIR.is_dir():
        pytest.skip(f"no clinical fixture dir yet: {_CLINICAL_DIR}")
    gts = sorted(_CLINICAL_DIR.glob("*.gt.txt"))
    if not gts:
        pytest.skip(f"no *.gt.txt clinical fixtures under {_CLINICAL_DIR}")

    for gt in gts:
        stem = gt.name[: -len(".gt.txt")]
        reference = gt.read_text(encoding="utf-8").strip()
        assert reference, f"{gt.name} is empty"

        # A matching, schema-valid keyterms file.
        kt_path = _CLINICAL_DIR / f"{stem}.keyterms.json"
        assert kt_path.is_file(), f"missing keyterms file for {stem}"
        data = json.loads(kt_path.read_text(encoding="utf-8"))
        assert (
            isinstance(data.get("keyterms"), list) and data["keyterms"]
        ), f"{kt_path.name} must have a non-empty 'keyterms' list"
        assert isinstance(data.get("keyphrases", []), list)
        curated = [*data["keyterms"], *data.get("keyphrases", [])]

        # No PHI SHAPES anywhere in the reference OR the curated terms.
        for label, blob in ((gt.name, reference), (kt_path.name, " ".join(curated))):
            phi = _scan_phi(blob)
            assert not phi, f"{label} contains PHI red flags: {phi}"

        # Every curated keyterm/keyphrase must actually appear in its reference —
        # a mislabeled fixture would silently deflate recall.
        for term in curated:
            assert (
                keyphrase_recall([term], reference)["recall"] == 1.0
            ), f"keyterm {term!r} is not present in {gt.name} — fixture mismatch"


def test_fixture_manifest_is_valid_and_stop_flush_is_available() -> None:
    """The ST-4 manifest parses, names the expected classes, and the
    ALREADY-committed ``stop_flush`` class (the existing 3 clinical clips)
    resolves as available.
    """
    manifest = _load_fixture_manifest()
    classes = manifest.get("classes", {})
    expected = {
        "stop_flush",
        "steady_state",
        "noise_augmented",
        "silence",
        "room_tone",
        "two_speaker",
        "ml_en",
    }
    assert set(classes.keys()) == expected

    resolution = _resolve_fixture_class("stop_flush", manifest)
    if _CLINICAL_DIR.is_dir() and list(_CLINICAL_DIR.glob("*.gt.txt")):
        assert resolution["available"] is True
        assert resolution["files"]
    else:
        # A fresh checkout without the committed fixtures (should not happen
        # on this repo, but the resolver must degrade cleanly either way).
        assert resolution["available"] is False


@pytest.mark.parametrize(
    "class_name",
    ["steady_state", "noise_augmented", "silence", "room_tone", "two_speaker", "ml_en"],
)
def test_fixture_manifest_uncommitted_classes_skip_with_reason(class_name: str) -> None:
    """Every ST-4 class whose audio is deliberately NOT committed resolves to
    ``available=False`` with a non-empty, informative reason — the
    "MANIFEST/loader support and skip-with-reason paths" this lane owns.
    Never raises; never silently reports available when the files are absent.
    """
    manifest = _load_fixture_manifest()
    resolution = _resolve_fixture_class(class_name, manifest)
    if resolution["available"]:
        # Only possible if the orchestrator (or a future ticket) has since
        # dropped real audio in — not a failure, just nothing left to prove.
        assert resolution["files"]
        return
    assert resolution["reason"], f"{class_name} skip has no reason"
    assert resolution["files"] == []


def test_fixture_manifest_unknown_class_is_unavailable_not_a_crash() -> None:
    manifest = _load_fixture_manifest()
    resolution = _resolve_fixture_class("not-a-real-class", manifest)
    assert resolution["available"] is False
    assert "unknown fixture class" in resolution["reason"]


# ===========================================================================
# 3. LIVE scorecard through the WS gateway (self-skips off-stack)
# ===========================================================================


def _concat_finals(events: list[Any]) -> str:
    finals = [e for e in events if e.kind == "transcript_final"]
    finals.sort(key=lambda e: (e.start_time, e.recv_ms))
    return " ".join(e.text for e in finals if e.text.strip()).strip()


def _stt_log_path() -> Path | None:
    raw = env("STREAM_STT_LOG_PATH", "")
    return Path(raw) if raw else None


async def _score_clip_n_times(
    http: Any,
    api_url: str,
    origin: str,
    token: str,
    *,
    audio: ReplayAudio,
    reference: str,
    keyterms: list[str],
    keyphrases: list[str],
    frame_ms: float,
    timeout_s: float,
    n: int,
    stt_log_path: Path | None,
    baseline_fingerprint: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """Run one clip N times through the WS gateway.

    Returns ``(scorecards, fingerprint_check)``. The BP-1 fingerprint is
    captured and checked once, on the FIRST run only — the served geometry
    does not change within one test invocation, so re-checking N times would
    be pure overhead, not additional signal.
    """
    scorecards: list[dict[str, Any]] = []
    fingerprint_check: dict[str, Any] | None = None

    for i in range(n):
        frames, events, closed, session_id, create_ms = await run_one_session(
            http, api_url, origin, token, audio, frame_ms, timeout_s
        )
        transport = compute_metrics(frames, events, audio, frame_ms, session_create_ms=create_ms)
        hypothesis = _concat_finals(events)
        card = build_scorecard(
            reference=reference,
            hypothesis=hypothesis,
            keyterms=keyterms,
            keyphrases=keyphrases,
            transport_metrics=transport,
            synonyms=MEDICAL_SYNONYMS,
            term_restricted_terms=[*keyterms, *keyphrases],
        )
        card["run_index"] = i
        card["session_id"] = session_id
        card["closed_status_received"] = closed
        card["hypothesis_preview"] = hypothesis[:200]
        scorecards.append(card)

        if fingerprint_check is None:
            candidate_fp = (
                find_fingerprint_in_log(stt_log_path, session_id) if stt_log_path else None
            )
            fingerprint_check = check_fingerprint(candidate_fp, baseline_fingerprint)

    return scorecards, fingerprint_check


async def test_streaming_quality_scorecard(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run each clinical (stop-flush) clip N>=1 times through the WS gateway
    -> emit + gate an AGGREGATE scorecard.

    M-11/ST-4: median + 2xMAD point estimate, bootstrap CI vs baseline.
    BP-1/M-15/M-16: a captured fingerprint that does not match the baseline's
    SKIPS that clip's gate with a named reason, instead of silently comparing
    two different configurations and reporting a pass.
    """
    import httpx

    if not _CLINICAL_DIR.is_dir():
        pytest.skip(f"no clinical fixture dir: {_CLINICAL_DIR}")
    gts = sorted(_CLINICAL_DIR.glob("*.gt.txt"))
    if not gts:
        pytest.skip("no clinical *.gt.txt fixtures to score")

    api_url = env("STREAM_API_URL", "http://localhost:8868")
    stt_url = env("STREAM_STT_URL", "http://localhost:8861")
    origin = ws_origin(api_url)
    frame_ms = env_float("STREAM_FRAME_MS", 80.0)
    timeout_s = env_float("STREAM_TIMEOUT_S", 45.0)
    thresholds = _load_thresholds()
    baseline_fingerprint = thresholds.get("_fingerprint")
    n = _quality_n()
    bootstrap_n = _bootstrap_resamples()
    report_path = Path(env("STREAM_QUALITY_REPORT_PATH", "./stt-quality-scorecard.json"))
    stt_log_path = _stt_log_path()

    async with httpx.AsyncClient() as http:
        for reason in (
            await api_unreachable_reason(http, api_url),
            await stt_unreachable_reason(http, stt_url),
        ):
            if reason:
                pytest.skip(reason)

        token = await login(http, api_url)
        if not token:
            pytest.skip("login failed — is the test DB seeded (pnpm test:db:seed)?")

        clip_reports: list[dict[str, Any]] = []

        # --- BP-1/M-17 warm-up ONCE before the first scored clip -----------
        # Shields the first clip's first run from a cold model-load hidden
        # inside session-create (measured live: a TTL-evicted model absorbed
        # ~4.6s of cold reload into a 5.8s session-create POST).
        first_wav = next(
            (
                _CLINICAL_DIR / f"{gt.name[: -len('.gt.txt')]}.wav"
                for gt in gts
                if (_CLINICAL_DIR / f"{gt.name[: -len('.gt.txt')]}.wav").is_file()
            ),
            None,
        )
        if first_wav is not None:
            monkeypatch.setenv("STREAM_WAV_PATH", str(first_wav))
            monkeypatch.setenv("STREAM_MAX_SECONDS", "0")
            warm_audio = load_replay_audio()
            await warmup_session(
                http, api_url, origin, token, warm_audio, frame_ms, timeout_s=min(timeout_s, 20.0)
            )

        for gt in gts:
            stem = gt.name[: -len(".gt.txt")]
            wav = _CLINICAL_DIR / f"{stem}.wav"
            if not wav.is_file():
                # Self-hosted scripted read not provided in-repo (PHI-free posture);
                # the orchestrator's live step drops the matching WAV in. Skip clip.
                continue
            reference = gt.read_text(encoding="utf-8").strip()
            kt_path = _CLINICAL_DIR / f"{stem}.keyterms.json"
            kt = json.loads(kt_path.read_text(encoding="utf-8")) if kt_path.is_file() else {}

            # Reuse the harness's exact WAV loader (16-bit check + resample/downmix)
            # by pointing it at this clip. monkeypatch auto-restores at teardown, so
            # the last clip's WAV path can't bleed into the loss harness's loader.
            monkeypatch.setenv("STREAM_WAV_PATH", str(wav))
            monkeypatch.setenv("STREAM_MAX_SECONDS", "0")
            audio: ReplayAudio = load_replay_audio()

            scorecards, fingerprint_check = await _score_clip_n_times(
                http,
                api_url,
                origin,
                token,
                audio=audio,
                reference=reference,
                keyterms=list(kt.get("keyterms", [])),
                keyphrases=list(kt.get("keyphrases", [])),
                frame_ms=frame_ms,
                timeout_s=timeout_s,
                n=n,
                stt_log_path=stt_log_path,
                baseline_fingerprint=baseline_fingerprint,
            )

            clip_report: dict[str, Any] = {
                "clip": stem,
                "gate_class": "stop_flush",
                "n_runs": len(scorecards),
                "runs": scorecards,
                "fingerprint_check": fingerprint_check,
            }

            any_hypothesis = any(c.get("hypothesis_preview") for c in scorecards)
            if not any_hypothesis:
                clip_report["gated"] = False
                clip_report["skip_reason"] = "no run produced a transcript"
            elif fingerprint_check is not None and not fingerprint_check["comparable"]:
                # BP-1 fix for M-15/M-16: never gate a run against a baseline
                # captured under a DIFFERENT configuration — the exact mechanism
                # that let the pair-priming-prompt regression (e3d61eefb) pass
                # 27x-worse WER against a baseline captured with the prompt OFF.
                clip_report["gated"] = False
                clip_report["skip_reason"] = fingerprint_check["reason"]
            else:
                clip_report["aggregate"] = regression_report_aggregate(
                    scorecards, thresholds, n_resamples=bootstrap_n
                )
                clip_report["gated"] = True
            clip_reports.append(clip_report)

    report = {
        "harness": "Theme-F streaming quality scorecard — through the WS gateway "
        "(N-run aggregate, BP-1 fingerprint-gated)",
        "thresholds_source": str(_THRESHOLDS_PATH.name),
        "n_runs_per_clip": n,
        "clips": clip_reports,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n===== STT QUALITY SCORECARD ({report_path.resolve()}) =====")
    print(json.dumps(report, indent=2, ensure_ascii=False))

    if not clip_reports:
        pytest.skip(
            "no clinical clip had a matching *.wav — provide a self-hosted scripted "
            f"read under {_CLINICAL_DIR} to capture the live scorecard (orchestrator step)."
        )
    gated_clips = [c for c in clip_reports if c.get("gated")]
    if not gated_clips:
        reasons = "; ".join(f"{c['clip']}: {c.get('skip_reason')}" for c in clip_reports)
        pytest.skip(f"no clip could be gated — {reasons}")

    # The pass/fail gate the loss harness deferred: every GATED clip must
    # hold the line. A clip excluded above (no transcript, or an
    # incomparable fingerprint) already carries its own reason in the report
    # and is never silently folded into a pass.
    failures = [
        f"{c['clip']}: {c['aggregate'].get('error') or 'aggregate regression'}"
        for c in gated_clips
        if not c["aggregate"]["passed"]
    ]
    assert not failures, (
        f"streaming quality regression (N={n} aggregate): " + "; ".join(failures)
    )


# ===========================================================================
# 4. ST-4 scaffolding — LIVE tests that self-skip until their (never
#    committed) real/de-identified audio exists. Wiring, not measurement:
#    the manifest resolver + a clear reason is the deliverable here; once a
#    fixture lands, the SAME N-run aggregate gate machinery above applies.
# ===========================================================================


async def test_streaming_quality_scorecard_steady_state() -> None:
    """The >=60s multi-final STEADY-STATE gate class (M-11): tighter bounds
    than the stop-flush clips because it averages over many commits instead
    of the cold-open/tail-flush transient. Scaffolding only — no >=60s
    clinical clip is committed to git.
    """
    manifest = _load_fixture_manifest()
    resolution = _resolve_fixture_class("steady_state", manifest)
    if not resolution["available"]:
        pytest.skip(resolution["reason"])
    pytest.skip(
        "steady_state fixture files are present but this gate's runner is not yet "
        "wired past the manifest resolver — extend _score_clip_n_times over "
        f"{resolution['files']} once a committed threshold block exists for the "
        "steady_state gate class"
    )


async def test_streaming_quality_scorecard_noise_augmented() -> None:
    """Deterministic noise-augmented English variants of the stop-flush clips
    (ST-4). Scaffolding only — no noise-augmented variant is committed.
    """
    manifest = _load_fixture_manifest()
    resolution = _resolve_fixture_class("noise_augmented", manifest)
    if not resolution["available"]:
        pytest.skip(resolution["reason"])
    pytest.skip(
        "noise_augmented fixture files are present but this gate's runner is not "
        f"yet wired past the manifest resolver — files: {resolution['files']}"
    )


@pytest.mark.parametrize("class_name", ["silence", "room_tone"])
async def test_streaming_quality_negative_controls(class_name: str) -> None:
    """Silence-only and room-tone-only clips must never emit a spurious
    final (BP-7/QW-13 companion). Scaffolding only — neither is committed.
    """
    manifest = _load_fixture_manifest()
    resolution = _resolve_fixture_class(class_name, manifest)
    if not resolution["available"]:
        pytest.skip(resolution["reason"])
    pytest.skip(
        f"{class_name} fixture files are present but this negative-control runner is "
        f"not yet wired past the manifest resolver — files: {resolution['files']}"
    )


async def test_streaming_quality_diarization_two_speaker() -> None:
    """One real de-identified two-speaker WAV with forced-alignment turns —
    the diarization baseline M-12 names as null today. The turns JSON IS
    committed (``two_speaker_consult_01.turns.json``); the WAV is not.
    """
    manifest = _load_fixture_manifest()
    resolution = _resolve_fixture_class("two_speaker", manifest)
    if not resolution["available"]:
        pytest.skip(resolution["reason"])
    pytest.skip(
        "two_speaker fixture WAV is present but this diarization runner is not yet "
        f"wired past the manifest resolver — files: {resolution['files']}"
    )


async def test_streaming_quality_ml_en_through_gateway() -> None:
    """The 24 de-identified ml-en clips (``STT_MLEN_EVAL_DIR``) scored
    THROUGH THE WS GATEWAY with CER + Latin ratio — distinct from
    ``test_mlen_quality_gate.py``'s OFFLINE single-utterance model gate
    (M-12: "the ml-en gate is offline, single-utterance, prompts off").
    Scaffolding only: ``STT_MLEN_EVAL_DIR`` is unset on this machine.
    """
    manifest = _load_fixture_manifest()
    resolution = _resolve_fixture_class("ml_en", manifest)
    if not resolution["available"]:
        pytest.skip(resolution["reason"])
    pytest.skip(
        "STT_MLEN_EVAL_DIR is set but this through-the-gateway runner is not yet "
        f"wired past the manifest resolver — dir: {resolution['files']}"
    )
