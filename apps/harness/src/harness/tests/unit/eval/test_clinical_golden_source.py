"""ClinicalGoldenSetSource loader tests (Phase-0 real golden set).

The clinical golden set is authored in a RICH multi-rater schema
(``clinical_v1.schema.json``): >=3 blinded clinician PDSQI ratings per case, an
adjudicated consensus, claim-level groundedness truth, safety truth, PHI
de-identification, and provenance/consent. The loader PROJECTS that rich format
down onto the existing :class:`GoldenCase` (consensus -> ``clinician_pdsqi``;
everything else preserved under ``metadata``) so a real set flows into the
EXISTING judge<->clinician ICC gate with no change to ``models.py``.

INTEGRITY: a TEMPLATE/PLACEHOLDER document must be structurally REFUSED so
placeholder data can never silently gate a clinical claim. No live LLM.
"""

from __future__ import annotations

import json

import pytest
from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

from harness.eval.ci import judge_clinician_icc
from harness.eval.golden import (
    GoldenSetSource,
    JSONFileGoldenSetSource,
)
from harness.eval.golden.sources import (
    CLINICAL_FIXTURE,
    CLINICAL_TEMPLATE_FIXTURE,
    ClinicalGoldenSetSource,
    project_clinical_case,
)
from harness.eval.models import (
    EvalCaseResult,
    EvalRunResult,
    GoldenSet,
    PDSQIResult,
)

FIXTURES_DIR = CLINICAL_TEMPLATE_FIXTURE.parent
SCHEMA_PATH = FIXTURES_DIR / "clinical_v1.schema.json"


def _pdsqi(**over: int) -> dict:
    """A valid PDSQI-9 score dict (the consensus / rater shape)."""
    base = {
        "citation": 4,
        "accurate": 5,
        "thorough": 4,
        "useful": 5,
        "organized": 4,
        "comprehensible": 5,
        "succinct": 4,
        "synthesized": 4,
        "abstraction": 0,
        "voice_summ": 0,
        "voice_note": 0,
    }
    base.update(over)
    return base


def _rich_case(case_id: str, consensus: dict, *, role: str = "calibration") -> dict:
    """A real-shaped (NON-template) clinical case dict for projection tests."""
    rater = {
        "rater_id": "rater-A",
        "rater_role": "Attending, Test Specialty",
        "rated_at": "2025-01-01T00:00:00Z",
        "blinded": True,
        "ratings": consensus,
    }
    return {
        "case_id": case_id,
        "role": role,
        "target_specialty": "Internal Medicine",
        "source_documents": ["de-identified transcript turn"],
        "generated_note": "Assessment: example. <Note ID:1>",
        "reference_note": "exemplar description",
        "clinician_pdsqi": consensus,
        "pdsqi_raters": [
            {**rater, "rater_id": "rater-A"},
            {**rater, "rater_id": "rater-B"},
            {**rater, "rater_id": "rater-C"},
        ],
        "adjudication": {"method": "mean_round_half_up"},
        "deidentification": {"phi_free": True, "method": "synthetic_no_phi"},
        "provenance": {
            "source_type": "simulated_by_clinician",
            "consent": {"status": "not_applicable_synthetic"},
        },
        "metadata": {"label_provenance": "clinician-adjudicated", "lane": role},
    }


class TestSchemaAndTemplate:
    def test_template_validates_against_schema(self):
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        doc = json.loads(CLINICAL_TEMPLATE_FIXTURE.read_text(encoding="utf-8"))
        # Raises if the shipped template violates its own published contract.
        Draft202012Validator(schema).validate(doc)

    def test_template_is_flagged_and_placeholder(self):
        doc = json.loads(CLINICAL_TEMPLATE_FIXTURE.read_text(encoding="utf-8"))
        assert doc["template"] is True
        assert all(
            c["metadata"]["label_provenance"] == "TEMPLATE-PLACEHOLDER" for c in doc["cases"]
        )


class TestIntegrityGuard:
    def test_template_load_is_refused_by_default(self):
        source = ClinicalGoldenSetSource(CLINICAL_TEMPLATE_FIXTURE)
        with pytest.raises(ValueError, match="(?i)template|placeholder"):
            source.load()

    def test_template_load_allowed_only_with_explicit_flag(self):
        gs = ClinicalGoldenSetSource(CLINICAL_TEMPLATE_FIXTURE, allow_template=True).load()
        assert isinstance(gs, GoldenSet)
        assert gs.version == "clinical-v1.0.0-template"
        assert len(gs.cases) == 2
        # consensus label is projected onto the runtime field
        assert all(c.clinician_pdsqi is not None for c in gs.cases)

    def test_real_set_loads_without_the_flag(self, tmp_path):
        doc = {
            "version": "clinical-v1.0.0",
            "name": "tiny-real",
            "cases": [_rich_case("clinical-c01", _pdsqi())],
        }
        path = tmp_path / "clinical_v1.json"
        path.write_text(json.dumps(doc), encoding="utf-8")
        gs = ClinicalGoldenSetSource(path).load()
        assert gs.version == "clinical-v1.0.0"
        assert gs.cases[0].clinician_pdsqi.accurate == 5


class TestProjection:
    def test_consensus_maps_to_clinician_pdsqi(self):
        case = project_clinical_case(_rich_case("c1", _pdsqi(accurate=3, thorough=2)))
        assert case.clinician_pdsqi is not None
        assert case.clinician_pdsqi.accurate == 3
        assert case.clinician_pdsqi.thorough == 2
        assert case.role == "calibration"
        assert case.target_specialty == "Internal Medicine"

    def test_rater_and_provenance_payload_preserved_in_metadata(self):
        case = project_clinical_case(_rich_case("c1", _pdsqi()))
        meta = case.metadata
        # multi-rater + governance detail is NOT lost: it lives under metadata so
        # the human-IRR analysis + audit can read it without a models.py change.
        assert len(meta["pdsqi_raters"]) == 3
        assert meta["adjudication"]["method"] == "mean_round_half_up"
        assert meta["deidentification"]["phi_free"] is True
        assert meta["provenance"]["source_type"] == "simulated_by_clinician"
        assert meta["label_provenance"] == "clinician-adjudicated"

    def test_projection_does_not_duplicate_native_keys_into_metadata(self):
        case = project_clinical_case(_rich_case("c1", _pdsqi()))
        # native GoldenCase fields must not be re-stashed under metadata
        for native in ("case_id", "source_documents", "generated_note", "clinician_pdsqi"):
            assert native not in case.metadata


class TestCalibrationWiring:
    def test_projected_cases_pair_into_judge_clinician_icc(self):
        # Three cases with DISTINCT consensus vectors (ICC needs between-case
        # variance). Judge == consensus -> perfect agreement -> ICC >= 0.8.
        consensus = [
            _pdsqi(accurate=5, thorough=3, citation=5),
            _pdsqi(accurate=4, thorough=5, citation=4),
            _pdsqi(accurate=2, thorough=4, citation=2),
        ]
        cases = [project_clinical_case(_rich_case(f"c{i}", c)) for i, c in enumerate(consensus)]
        gs = GoldenSet(version="clinical-v1.0.0", cases=cases)
        run = EvalRunResult(
            golden_set_version="clinical-v1.0.0",
            judge_model="stub",
            case_results=[
                EvalCaseResult(
                    case_id=c.case_id,
                    pdsqi=PDSQIResult(
                        case_id=c.case_id, score=c.clinician_pdsqi.model_copy(), model="stub"
                    ),
                )
                for c in cases
            ],
        )
        report = judge_clinician_icc(gs, run, icc_threshold=0.8)
        assert report is not None
        assert report.passed is True
        assert report.icc >= 0.8


class TestSourceContract:
    def test_clinical_source_satisfies_golden_set_source_protocol(self):
        assert isinstance(ClinicalGoldenSetSource(CLINICAL_FIXTURE), GoldenSetSource)
        # drop-in for the runner alongside the JSON file source
        assert isinstance(JSONFileGoldenSetSource(CLINICAL_FIXTURE), GoldenSetSource)

    def test_missing_real_fixture_raises_file_not_found(self):
        # clinical_v1.json does not exist until SMEs author it; the loader must
        # fail loudly rather than silently falling back to a synthetic set.
        assert not CLINICAL_FIXTURE.exists()
        with pytest.raises(FileNotFoundError):
            ClinicalGoldenSetSource(CLINICAL_FIXTURE).load()
