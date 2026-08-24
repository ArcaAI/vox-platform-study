"""TASK-713 Task 1: proves ``harness.eval.ci`` produces a genuine PASS/FAIL
verdict over the *actual* golden set the CI job points at
(``eval/golden/fixtures/curated_v1.json``) — not just the synthetic fixture
used elsewhere in ``test_ci_gate.py``.

This is deliberately hermetic (a stub judge, no network) per
``.claude/rules/06-python-services.md`` §Pitfalls: the live-backend call is
provisioned separately (TASK-713 Task 2/3, HUMAN-GATED on the judge-backend
decision) and must never leak into the hermetic suite. What this test proves
is the *wiring*: point ``main()`` at the real curated_v1 fixture and confirm
it exits 0 when every case clears the release-gate thresholds, and exits 1
when a single case is deliberately degraded (a hallucinated/low-quality note)
— so once Task 0/2 provision a real judge backend, swapping the stub for a
live client is a config change, not a rewrite of this wiring.
"""

from __future__ import annotations

import json
from pathlib import Path

from harness.eval.ci import main
from harness.eval.golden.sources import FIXTURES_DIR, JSONFileGoldenSetSource
from harness.eval.judge import OutputMode, PDSQI9Judge

from ._stubs import MappingJudgeClient, pdsqi_score_json

CURATED_V1_PATH = FIXTURES_DIR / "curated_v1.json"


def _curated_v1_case_ids() -> list[str]:
    data = json.loads(CURATED_V1_PATH.read_text(encoding="utf-8"))
    return [c["case_id"] for c in data["cases"]]


def _note_key(generated_note: str) -> str:
    # MappingJudgeClient matches by substring against the full rendered judge
    # prompt (which embeds ``generated_note``, not ``case_id``). Unlike
    # test_judge_calibration.py's 28-char prefix (safe against its own
    # fixture), curated_v1's ``source_documents`` transcripts can themselves
    # contain a short prefix of another case's note (e.g. an "Assessment:"
    # line appearing verbatim inside a different case's dictated transcript),
    # so the FULL note text is used here as the uniqueness guarantee.
    return generated_note


def _calibration_lane_agreement_mapping() -> dict[str, str]:
    """Maps each calibration-lane case's note prefix to a judge response that
    matches its own ``clinician_pdsqi`` label exactly (perfect agreement).

    ``curated_v1.json`` carries clinician reference labels for the 6
    calibration-lane cases specifically so the judge<->clinician ICC gate has
    something to compare against. A judge that scores every case identically
    (as a naive stub would) disagrees with those varied labels and fails the
    ICC>=0.8 gate regardless of quality-lane scoring — so these tests pin
    calibration-lane responses to the reference label, leaving only the
    quality-lane PDSQI thresholds as the thing under test.
    """
    data = json.loads(CURATED_V1_PATH.read_text(encoding="utf-8"))
    mapping = {}
    for case in data["cases"]:
        if case.get("role") == "calibration" and case.get("clinician_pdsqi"):
            mapping[_note_key(case["generated_note"])] = pdsqi_score_json(**case["clinician_pdsqi"])
    return mapping


def _degraded_note_key() -> str:
    data = json.loads(CURATED_V1_PATH.read_text(encoding="utf-8"))
    case = next(c for c in data["cases"] if c["case_id"] == "curated-q01-fammed-pharyngitis")
    return _note_key(case["generated_note"])


class TestCuratedV1GateWiring:
    """``main()`` against the real CI-pinned golden set, stub judge injected."""

    def test_curated_v1_fixture_exists_and_is_the_ci_pinned_set(self):
        # Guards against silent drift between this test and the CI job's
        # ``--golden-set`` argument (.gitlab/ci/test.yml, harness-eval-gate).
        assert CURATED_V1_PATH.exists()
        case_ids = _curated_v1_case_ids()
        assert len(case_ids) == 18
        assert "curated-q01-fammed-pharyngitis" in case_ids

    def test_main_exits_zero_when_every_curated_v1_case_scores_high(self, tmp_path: Path):
        # Every case gets the same high, threshold-clearing score — proves the
        # real 18-case fixture round-trips through the runner/gate end to end.
        judge = PDSQI9Judge(
            MappingJudgeClient(_calibration_lane_agreement_mapping(), default=pdsqi_score_json()),
            output_mode=OutputMode.SCORE,
        )
        report = tmp_path / "report.json"

        code = main(
            [
                "--golden-set",
                str(CURATED_V1_PATH),
                "--output",
                str(report),
                "--no-faithfulness",
            ],
            judge=judge,
        )

        assert code == 0
        data = json.loads(report.read_text(encoding="utf-8"))
        assert data["passed"] is True
        assert data["failures"] == []

    def test_main_exits_nonzero_when_one_curated_v1_case_is_degraded(self, tmp_path: Path):
        # One real case (the first quality-lane case) is scored as if the
        # generator hallucinated content not grounded in the transcript —
        # a low "accurate" dimension, below EvalConfig.pdsqi_accurate_threshold
        # (4.0). This is the "deliberately degraded note fixture" the ticket's
        # Task 1 calls for, applied directly to the CI-pinned golden set rather
        # than a synthetic stand-in.
        # The other 11 quality-lane cases sit exactly AT the accurate threshold
        # (4) rather than comfortably above it (5) — otherwise a single
        # degraded case can't drag a 12-case mean below the 4.0 cutoff at all
        # (11*5 + 1)/12 = 4.67, still "passing". This mirrors a real regression
        # more honestly too: most notes are fine, one is bad, and that must be
        # enough to fail release.
        mapping = {_degraded_note_key(): pdsqi_score_json(accurate=1)}
        mapping.update(_calibration_lane_agreement_mapping())
        judge = PDSQI9Judge(
            MappingJudgeClient(mapping, default=pdsqi_score_json(accurate=4)),
            output_mode=OutputMode.SCORE,
        )
        report = tmp_path / "report.json"

        code = main(
            [
                "--golden-set",
                str(CURATED_V1_PATH),
                "--output",
                str(report),
                "--no-faithfulness",
            ],
            judge=judge,
        )

        assert code == 1
        data = json.loads(report.read_text(encoding="utf-8"))
        assert data["passed"] is False
        assert any("pdsqi_accurate" in f for f in data["failures"])

    def test_json_file_source_loads_curated_v1_with_expected_role_split(self):
        # Cross-check against the fixture's own documented lane split
        # (12 quality-lane + 6 calibration-lane; eval/README.md:19).
        golden_set = JSONFileGoldenSetSource(CURATED_V1_PATH).load()
        quality = [c for c in golden_set.cases if c.role == "quality"]
        calibration = [c for c in golden_set.cases if c.role == "calibration"]
        assert len(quality) == 12
        assert len(calibration) == 6
