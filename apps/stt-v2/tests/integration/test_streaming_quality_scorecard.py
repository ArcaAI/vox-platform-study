"""TASK-470 (Theme F · S1-EVAL) — Streaming QUALITY scorecard + regression gate.

EXTENDS TASK-455's ``test_streaming_loss_harness.py`` (imports its through-the-
gateway session bootstrap + transport metrics — does NOT fork it) with the
CLINICAL QUALITY metrics the SOTA ASR/NER track is scored against:

* **medical WER** — word error rate of the concatenated time-ordered finals vs a
  fixture ground-truth (``*.gt.txt``), medical-term-aware normalization.
* **clinical keyterm / keyphrase recall** — fraction of a clip's curated clinical
  keyterms/keyphrases (``*.keyterms.json``) present in the hypothesis. The
  "did we drop the drug / dose / finding" catcher.

and a **committed pass/fail regression gate** (``streaming_thresholds.json`` +
``assert_no_regression``) — the assertion TASK-455 deliberately deferred (its
AC-6 was baseline-only).

TWO KINDS OF TEST live here (mirroring the loss harness's split):

1. ``test_quality_metric_functions_are_correct`` — PURE-CPU self-check. Runs with
   **no services up** (it overrides the integration conftest's docker gate, like
   the loss harness). Pins the WER / keyterm / keyphrase / regression-gate math
   against hand-computed transcript↔reference pairs. THIS is the unit gate this
   ticket owns.
2. ``test_clinical_fixtures_are_wellformed`` — PURE-CPU: the de-identified
   clinical fixture set parses to the expected schema and carries no obvious PHI.
3. ``test_streaming_quality_scorecard`` — the LIVE run through the WS gateway that
   produces a REAL scorecard JSON artifact + asserts the thresholds. Self-skips
   cleanly when STT-v2 / login / a clinical WAV is unavailable. Producing the
   captured baseline scorecard on a live stack is the ORCHESTRATOR's step (exactly
   like TASK-455's live baseline), so this test skips — never fails — off-stack.

Run::

    pnpm py:stt-v2:test                 # whole suite; the pure self-checks run off-stack
    pnpm py:stt-v2:test:integration     # this + the loss harness
    # or just this module's pure gate:
    conda run -n arcaenv --no-capture-output pytest \
        apps/stt-v2/tests/integration/test_streaming_quality_scorecard.py \
        -k functions_are_correct -v
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

# The functions under test (this ticket's pure metric module).
from tests.integration.streaming_quality import (
    MEDICAL_SYNONYMS,
    assert_no_regression,
    build_scorecard,
    keyphrase_recall,
    keyterm_recall,
    medical_wer,
    normalize_text,
    regression_report,
)

# Reuse TASK-455's harness (import — do NOT fork). All module-level & importable.
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
    _stt_v2_unreachable_reason as stt_v2_unreachable_reason,
)
from tests.integration.test_streaming_loss_harness import (
    _ws_origin as ws_origin,
)

pytestmark = [pytest.mark.integration]

_THRESHOLDS_PATH = Path(__file__).resolve().parent / "streaming_thresholds.json"
_CLINICAL_DIR = Path(__file__).resolve().parents[1] / "e2e" / "fixtures" / "clinical"


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


# ===========================================================================
# 1. PURE metric self-check (no services) — the unit gate this ticket owns
# ===========================================================================


def test_committed_revision_rate_excludes_tentative_tail() -> None:
    """TASK-487 A1: the churn guardrail must measure the LA-2 COMMITTED region
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
    # stableChars=0 on TASK-471 tentative-tail refreshes (the UI carries the settled
    # prefix forward, never un-settling it). A non-empty committed prefix followed by
    # such an sc=0 frame is NOT a committed rewrite — the metric must skip the frame,
    # else it false-positives on every tail refresh (regression observed live: the
    # TASK-470 scorecard on the …402 pipeline reported ~0.10-0.15 committed churn that
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


def test_quality_metric_functions_are_correct() -> None:
    """Pin the WER / recall / regression-gate math (runs with no services up)."""
    # --- normalization: case/punct fold, whitespace collapse ---------------
    assert normalize_text("The  Patient's B.P. was 120/80!") == "the patient's bp was 12080"

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
    transport = {
        "first_partial_ms": 4920.4,
        "ttfw_ms": 4920.4,
        "commit_latency_ms": {"count": 11, "p50": 6023.2, "p99": 7624.2},
        "partial_revision": {"partials": 1, "revisions": 0, "rate": 0.0},
        "committed_revision": {"partials": 1, "revisions": 0, "rate": 0.0},
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
    assert card["transport"]["commit_latency_ms"]["p50"] == 6023.2
    assert card["transport"]["committed_revision_rate"] == 0.0  # the GATED A1 guardrail
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

    # (f) committed-region revision above baseline+ε — the TASK-487 A1 guardrail
    # bites on genuine settled-text churn (a high full-caption tail rate would NOT,
    # since partial_revision_rate is now informational/ungated).
    churned = json.loads(json.dumps(card))
    churned["transport"]["committed_revision_rate"] = 0.5
    churned_report = regression_report(churned, thresholds)
    assert churned_report["passed"] is False
    assert any(
        c["metric"] == "committed_revision_rate" and not c["passed"] for c in churned_report["checks"]
    )

    # (e) a metric-less scorecard must NOT pass vacuously (`all([])` is True)
    empty = regression_report({}, thresholds)
    assert empty["passed"] is False and empty["checks"] == []
    assert regression_report({"quality": {}, "transport": {}}, thresholds)["passed"] is False
    with pytest.raises(AssertionError):
        assert_no_regression({}, thresholds)


# ===========================================================================
# 2. PURE fixture-integrity check (no services) — AC-3, PHI-free guarantee
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
        assert isinstance(data.get("keyterms"), list) and data["keyterms"], (
            f"{kt_path.name} must have a non-empty 'keyterms' list"
        )
        assert isinstance(data.get("keyphrases", []), list)
        curated = [*data["keyterms"], *data.get("keyphrases", [])]

        # No PHI SHAPES anywhere in the reference OR the curated terms.
        for label, blob in ((gt.name, reference), (kt_path.name, " ".join(curated))):
            phi = _scan_phi(blob)
            assert not phi, f"{label} contains PHI red flags: {phi}"

        # Every curated keyterm/keyphrase must actually appear in its reference —
        # a mislabeled fixture would silently deflate recall.
        for term in curated:
            assert keyphrase_recall([term], reference)["recall"] == 1.0, (
                f"keyterm {term!r} is not present in {gt.name} — fixture mismatch"
            )


# ===========================================================================
# 3. LIVE scorecard through the WS gateway (self-skips off-stack) — AC-2/6
# ===========================================================================


def _concat_finals(events: list[Any]) -> str:
    finals = [e for e in events if e.kind == "transcript_final"]
    finals.sort(key=lambda e: (e.start_time, e.recv_ms))
    return " ".join(e.text for e in finals if e.text.strip()).strip()


async def test_streaming_quality_scorecard(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run each clinical clip through the WS gateway → emit + gate the scorecard."""
    import httpx

    if not _CLINICAL_DIR.is_dir():
        pytest.skip(f"no clinical fixture dir: {_CLINICAL_DIR}")
    gts = sorted(_CLINICAL_DIR.glob("*.gt.txt"))
    if not gts:
        pytest.skip("no clinical *.gt.txt fixtures to score")

    api_url = env("STREAM_API_URL", "http://localhost:8868")
    stt_v2_url = env("STREAM_STT_V2_URL", "http://localhost:8861")
    origin = ws_origin(api_url)
    frame_ms = env_float("STREAM_FRAME_MS", 80.0)
    timeout_s = env_float("STREAM_TIMEOUT_S", 45.0)
    thresholds = _load_thresholds()
    report_path = Path(env("STREAM_QUALITY_REPORT_PATH", "./stt-quality-scorecard.json"))

    async with httpx.AsyncClient() as http:
        for reason in (
            await api_unreachable_reason(http, api_url),
            await stt_v2_unreachable_reason(http, stt_v2_url),
        ):
            if reason:
                pytest.skip(reason)

        token = await login(http, api_url)
        if not token:
            pytest.skip("login failed — is the test DB seeded (pnpm test:db:seed)?")

        scorecards: list[dict[str, Any]] = []
        scored_any = False
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

            frames, events, closed, session_id = await run_one_session(
                http, api_url, origin, token, audio, frame_ms, timeout_s
            )
            transport = compute_metrics(frames, events, audio, frame_ms)
            hypothesis = _concat_finals(events)
            card = build_scorecard(
                reference=reference,
                hypothesis=hypothesis,
                keyterms=list(kt.get("keyterms", [])),
                keyphrases=list(kt.get("keyphrases", [])),
                transport_metrics=transport,
                synonyms=MEDICAL_SYNONYMS,
            )
            card["clip"] = stem
            card["session_id"] = session_id
            card["closed_status_received"] = closed
            card["hypothesis_preview"] = hypothesis[:200]
            card["regression"] = regression_report(card, thresholds)
            scorecards.append(card)
            if hypothesis:
                scored_any = True

    report = {
        "harness": "TASK-470 Theme-F streaming quality scorecard — through the WS gateway",
        "thresholds_source": str(_THRESHOLDS_PATH.name),
        "clips": scorecards,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n===== STT QUALITY SCORECARD ({report_path.resolve()}) =====")
    print(json.dumps(report, indent=2, ensure_ascii=False))

    if not scorecards:
        pytest.skip(
            "no clinical clip had a matching *.wav — provide a self-hosted scripted "
            f"read under {_CLINICAL_DIR} to capture the live scorecard (orchestrator step)."
        )
    if not scored_any:
        pytest.skip(
            "clinical clips produced no transcripts — the offline volume may lack the "
            "ASR model cached; scorecard written but quality not captured."
        )

    # The pass/fail gate TASK-455 deferred: every scored clip must hold the line.
    for card in scorecards:
        assert_no_regression(card, thresholds)
