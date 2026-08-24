"""TASK-799 lane G — the clinical taxonomies are configuration, not literals.

RED-first. Four taxonomies and five env fields used to live in `apps/nlp`:

  1. `entailment_scorer` — MiniCheck label-token ids + calibration bounds;
  2. `ontology_linker._VOCABULARY_ENTRIES` — the UMLS/SNOMED/RxNorm crosswalk;
  3. `vitals_extractor._*_RANGE` — the physiologic plausibility bands;
  4. `assertion._TRIGGERS` — the ConText/NegEx trigger lexicon;
  5. `TOKEN_CLASSIFIER_{IGNORE_LABELS,AGGREGATION_STRATEGY,ASSERTION_ENABLED}`
     and `NLP_LINKER_{ENABLED,CONFIDENCE_FLOOR}`.

What these tests pin, in the order the brief asks for it:

  (a) a taxonomy resolved from the DB reaches the executor and CHANGES
      behaviour — asserted through the real HTTP route with a fake pipeline, so
      the value travels the whole way, not just into a schema field;
  (b) an unresolved/absent taxonomy fails closed — the pass it governs is
      DISABLED, never silently backed by a code literal;
  (c) a non-MiniCheck model cannot silently produce scores calibrated for
      MiniCheck: the adapter binding is explicit and refuses.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from nlp.schemas.clinical_taxonomy import ClinicalTaxonomy
from nlp.schemas.common import Entity, TextPosition


def _entity(text: str, start: int) -> Entity:
    """A recognized span, positioned so the pre-context is real."""
    return Entity(
        id="e1",
        text=text,
        normalized_text=text.lower(),
        entity_type="SIGN_SYMPTOM",
        confidence=0.9,
        position=TextPosition(start=start, end=start + len(text)),
        model_version="test",
    )


# --------------------------------------------------------------------------
# (0) The literals are GONE from the service modules.
# --------------------------------------------------------------------------


def test_no_taxonomy_literals_remain_in_the_service_modules():
    """The four literal tables must not exist as module attributes any more."""
    from nlp.services import assertion, ontology_linker, vitals_extractor

    assert not hasattr(ontology_linker, "_VOCABULARY_ENTRIES")
    assert not hasattr(assertion, "_TRIGGERS")
    for name in (
        "_SYSTOLIC_RANGE",
        "_DIASTOLIC_RANGE",
        "_HR_RANGE",
        "_SPO2_RANGE",
        "_TEMP_C_RANGE",
        "_WEIGHT_KG_RANGE",
    ):
        assert not hasattr(vitals_extractor, name), f"{name} is still a code literal"


def test_the_five_env_fields_are_gone_from_pydantic_settings():
    """A label set / threshold in an env var is exactly what rule 00 forbids."""
    from nlp.core import config as config_module
    from nlp.core.config import Settings, TokenClassificationConfig

    token_fields = set(TokenClassificationConfig.model_fields)
    assert "ignore_labels" not in token_fields
    assert "aggregation_strategy" not in token_fields
    assert "assertion_enabled" not in token_fields

    # The whole `NLP_LINKER_*` settings class is gone, not just its fields.
    assert not hasattr(config_module, "OntologyLinkerConfig")
    assert not hasattr(Settings(), "ontology_linker")


def test_env_vars_cannot_reintroduce_the_taxonomy(monkeypatch):
    """Setting the retired env vars must have no effect anywhere."""
    from nlp.core.config import TokenClassificationConfig

    monkeypatch.setenv("TOKEN_CLASSIFIER_IGNORE_LABELS", '["MEDICATION"]')
    monkeypatch.setenv("TOKEN_CLASSIFIER_ASSERTION_ENABLED", "false")
    monkeypatch.setenv("NLP_LINKER_ENABLED", "false")

    config = TokenClassificationConfig(model_name="x/y", tokenizer_name="x/y")
    assert not hasattr(config, "ignore_labels")
    assert not hasattr(config, "assertion_enabled")


# --------------------------------------------------------------------------
# (a) + (b) — the linker.
# --------------------------------------------------------------------------


def test_linker_with_no_vocabulary_emits_no_codes():
    """(b) Absent vocabulary ⇒ all-None. Never a bundled literal table."""
    from nlp.services.ontology_linker import OntologyCodes, OntologyLinker

    linker = OntologyLinker()

    assert linker.link("metformin") == OntologyCodes()
    assert linker.link("pneumonia") == OntologyCodes()


def test_linker_uses_the_injected_vocabulary():
    """(a) The codes come from the taxonomy, so changing it changes the answer."""
    from nlp.services.ontology_linker import OntologyLinker

    taxonomy = ClinicalTaxonomy.model_validate(
        {
            "linker": {
                "vocabulary": [
                    {"aliases": ["aspirin", "acetylsalicylic acid"], "rxnorm_code": "1191"},
                ]
            }
        }
    )
    linker = OntologyLinker.from_taxonomy(taxonomy.linker)
    assert linker.link("Aspirin").rxnorm_code == "1191"

    # A DIFFERENT stored value produces a DIFFERENT answer for the same span —
    # which is what makes it configuration rather than a constant.
    retuned = OntologyLinker.from_taxonomy(
        ClinicalTaxonomy.model_validate(
            {"linker": {"vocabulary": [{"aliases": ["aspirin"], "rxnorm_code": "999999"}]}}
        ).linker
    )
    assert retuned.link("aspirin").rxnorm_code == "999999"


# --------------------------------------------------------------------------
# (a) + (b) — vitals plausibility bands.
# --------------------------------------------------------------------------


def test_vitals_with_no_bands_emits_nothing():
    """(b) A value that cannot be range-checked is never shown."""
    from nlp.services.vitals_extractor import extract_vitals

    assert extract_vitals("blood pressure 138/88, heart rate 72") is None


def test_vitals_bands_travel_and_change_the_verdict():
    """(a) Narrowing a stored band discards a reading the wider band accepted."""
    from nlp.services.vitals_extractor import extract_vitals

    wide = ClinicalTaxonomy.model_validate(
        {"vitals": {"systolic": {"min": 60, "max": 260}, "diastolic": {"min": 30, "max": 160}}}
    ).vitals
    narrow = ClinicalTaxonomy.model_validate(
        {"vitals": {"systolic": {"min": 60, "max": 120}, "diastolic": {"min": 30, "max": 160}}}
    ).vitals

    text = "blood pressure 138/88"
    assert extract_vitals(text, wide) is not None
    assert extract_vitals(text, wide).systolic == 138
    # Same text, same code, different stored band ⇒ discarded (fail-safe).
    assert extract_vitals(text, narrow) is None


# --------------------------------------------------------------------------
# (a) + (b) — the ConText/NegEx trigger lexicon.
# --------------------------------------------------------------------------


def test_assertion_with_no_triggers_labels_nothing_absent():
    """(b) No lexicon ⇒ no span is asserted ABSENT on invented evidence."""
    from nlp.schemas.common import AssertionStatus
    from nlp.services.assertion import NegExAssertionClassifier

    classified = NegExAssertionClassifier().classify(
        "The patient has no chest pain today.", [_entity("chest pain", 18)]
    )

    assert classified[0].assertion == AssertionStatus.PRESENT


def test_assertion_triggers_travel():
    """(a) A stored trigger phrase produces the status it declares."""
    from nlp.schemas.common import AssertionStatus
    from nlp.services.assertion import NegExAssertionClassifier

    taxonomy = ClinicalTaxonomy.model_validate(
        {"assertion": {"triggers": {"ABSENT": ["denies", "no"]}}}
    )
    classifier = NegExAssertionClassifier.from_taxonomy(taxonomy.assertion)

    text = "The patient denies chest pain today."
    classified = classifier.classify(text, [_entity("chest pain", 19)])
    assert classified[0].assertion == AssertionStatus.ABSENT

    # A stored lexicon that does NOT declare the phrase leaves it PRESENT.
    other = NegExAssertionClassifier.from_taxonomy(
        ClinicalTaxonomy.model_validate(
            {"assertion": {"triggers": {"FAMILY": ["mother"]}}}
        ).assertion
    )
    assert other.classify(text, [_entity("chest pain", 19)])[0].assertion == AssertionStatus.PRESENT


# --------------------------------------------------------------------------
# (a) END TO END — over the real HTTP route, with the model faked.
# --------------------------------------------------------------------------


class _FakePipeline:
    """Stands in for the HF token-classification pipeline. Emits two spans."""

    def __call__(self, text, aggregation_strategy="simple"):  # noqa: D401,ANN001
        _FakePipeline.last_strategy = aggregation_strategy
        return [
            {"word": "aspirin", "entity_group": "MEDICATION", "start": 0, "end": 7, "score": 0.99},
            {"word": "junk", "entity_group": "O", "start": 8, "end": 12, "score": 0.5},
        ]


@pytest.fixture()
def taxonomy_client(monkeypatch):
    """A minimal app whose token classifier is a fake pipeline (no weights)."""
    import nlp.dependencies as deps
    from fastapi import FastAPI

    from nlp.api.v1 import rest_api_router_v1
    from nlp.core.config import TokenClassificationConfig
    from nlp.services.token_classifier import TransformerTokenClassifier

    async def _fake_factory(cache_key: str):
        model_name, _model_path = deps._split_cache_key(cache_key)
        classifier = TransformerTokenClassifier(
            configs=TokenClassificationConfig(model_name=model_name, tokenizer_name=model_name)
        )
        classifier.pipeline = _FakePipeline()
        classifier.is_initialized = True
        return classifier

    monkeypatch.setattr(deps, "_create_token_classifier", _fake_factory)
    saved = deps.__dict__.get("_token_classifier_cache_instance")
    deps.__dict__["_token_classifier_cache_instance"] = None
    app = FastAPI()
    app.include_router(rest_api_router_v1)
    yield TestClient(app)
    deps.__dict__["_token_classifier_cache_instance"] = saved


_TAXONOMY_BODY = {
    "tokenClassifier": {
        "aggregationStrategy": "max",
        "ignoreLabels": ["O"],
        "assertionEnabled": True,
    },
    "linker": {"enabled": True, "vocabulary": [{"aliases": ["aspirin"], "rxnorm_code": "1191"}]},
    "vitals": {"systolic": {"min": 60, "max": 260}, "diastolic": {"min": 30, "max": 160}},
    "assertion": {"triggers": {"ABSENT": ["no"]}},
}


def test_injected_taxonomy_reaches_the_executor_and_changes_behaviour(taxonomy_client):
    """(a) End to end: the DB-resolved blob changes what comes back."""
    response = taxonomy_client.post(
        "/api/v1/classify/tokens",
        json={
            "text": "aspirin junk, blood pressure 138/88",
            "model_name": "fake/ner",
            "clinical_taxonomy": _TAXONOMY_BODY,
        },
        headers={"X-Tenant-Id": "00000000-0000-0000-0000-000000000000"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()

    # `ignoreLabels` travelled: the "O" span was dropped.
    assert [e["entity_type"] for e in payload["entities"]] == ["MEDICATION"]
    # `linker.vocabulary` travelled: the code is the STORED one.
    assert payload["entities"][0]["rxnorm_code"] == "1191"
    # `vitals` bands travelled: the reading is inside the stored band.
    assert payload["vitals"]["systolic"] == 138
    # `aggregationStrategy` travelled all the way into the pipeline call.
    assert _FakePipeline.last_strategy == "max"


def test_absent_taxonomy_disables_every_pass_it_governs(taxonomy_client):
    """(b) No taxonomy ⇒ no codes, no vitals — and no substituted literal."""
    response = taxonomy_client.post(
        "/api/v1/classify/tokens",
        json={"text": "aspirin junk, blood pressure 138/88", "model_name": "fake/ner"},
        headers={"X-Tenant-Id": "00000000-0000-0000-0000-000000000000"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()

    assert payload["vitals"] is None
    for entity in payload["entities"]:
        assert entity.get("rxnorm_code") is None
        assert entity.get("umls_cui") is None


# --------------------------------------------------------------------------
# (c) — the entailment adapter binding.
# --------------------------------------------------------------------------


def test_entailment_calibration_carries_no_minicheck_defaults():
    """The label-token ids and bounds must be supplied, not assumed."""
    from nlp.services import entailment_scorer

    assert not hasattr(entailment_scorer, "CAL_SUPPORTED_MIN")
    assert not hasattr(entailment_scorer, "CAL_UNSUPPORTED_MAX")


def test_entailment_refuses_a_model_declared_as_another_adapter():
    """(c) A non-MiniCheck declaration cannot run MiniCheck's token ids."""
    from nlp.services.entailment_scorer import (
        EntailmentCalibration,
        MiniCheckLoadSpec,
        NliModelUnavailableError,
        load_minicheck_scorer,
    )

    spec = MiniCheckLoadSpec(
        model_id="microsoft/deberta-v3-large-mnli",
        model_path="/tmp/does-not-matter.gguf",
        calibration=EntailmentCalibration(
            adapter="deberta-mnli",
            label_token_no=0,
            label_token_yes=2,
            supported_min=0.6,
            unsupported_max=0.4,
            document="d",
            supported_claim="s",
            unsupported_claim="u",
        ),
    )
    with pytest.raises(NliModelUnavailableError) as excinfo:
        load_minicheck_scorer(spec)
    assert "deberta-mnli" in str(excinfo.value)


def test_entailment_without_a_calibration_spec_fails_closed():
    """(c) No declared calibration ⇒ refuse, rather than assume MiniCheck."""
    from nlp.services.entailment_scorer import (
        MiniCheckLoadSpec,
        NliModelUnavailableError,
        load_minicheck_scorer,
    )

    with pytest.raises(NliModelUnavailableError):
        load_minicheck_scorer(
            MiniCheckLoadSpec(model_id="some/gguf", model_path="/tmp/x.gguf", calibration=None)
        )


def test_entailment_calibration_bounds_travel():
    """(a) for item 1: the stored bounds decide pass/fail, not a constant."""
    from nlp.services.entailment_scorer import (
        EntailmentCalibration,
        LlamaCppMiniCheckScorer,
        NliModelUnavailableError,
    )

    # A scorer that returns P(yes) ≈ 0.73 for the supported pair, 0.27 for the other.
    def logit_fn(prompt: str) -> tuple[float, float]:
        return (0.0, 1.0) if "SUPPORTED" in prompt else (1.0, 0.0)

    loose = EntailmentCalibration(
        adapter="minicheck-flan-t5",
        label_token_no=3,
        label_token_yes=209,
        supported_min=0.60,
        unsupported_max=0.40,
        document="doc",
        supported_claim="SUPPORTED",
        unsupported_claim="other",
    )
    strict = loose.model_copy(update={"supported_min": 0.95})

    LlamaCppMiniCheckScorer(logit_fn, loose).verify_calibration()  # passes
    with pytest.raises(NliModelUnavailableError):
        LlamaCppMiniCheckScorer(logit_fn, strict).verify_calibration()
