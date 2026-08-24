"""NLP token-classification contract carries ontology codes.

RED-first: the ``Entity`` schema gains five nullable code fields and the token
classifier wires the deterministic :class:`OntologyLinker` into ``process()``
(post-``_to_entities``) so a recognized clinical span comes back CODED.

Pins:
  * ``Entity`` serializes ``umls_cui``/``snomed_code``/``rxnorm_code``/
    ``icd_code``/``loinc_code`` (nullable, default None);
  * a recognized medication returns a populated ``rxnorm_code``;
  * a recognized condition returns ICD/SNOMED codes;
  * an unrecognized span keeps codes None (null-safe);
  * the existing type/offset/confidence output is UNCHANGED (encoder parity);
  * the linker is config-gated (toggle + confidence floor).

TASK-799 lane G: the vocabulary, the toggle and the floor now arrive per request
on `clinical_taxonomy` (gateway-resolved `AiModel._metadata.clinicalTaxonomy`)
rather than from a bundled table + `NLP_LINKER_*` env fields, so every case here
supplies the taxonomy it is asserting against. The CONTRACT is unchanged: a
recognized span comes back coded, an unrecognized one keeps None codes.
"""

from __future__ import annotations

import pytest

from nlp.core.config import TokenClassificationConfig
from nlp.schemas.classification import TokenClassificationRequest
from nlp.schemas.clinical_taxonomy import ClinicalTaxonomy
from nlp.schemas.common import Entity
from nlp.services.token_classifier import TransformerTokenClassifier

#: The vocabulary rows these cases assert against — the shape a platform admin
#: stores on the `nlp.ner` model row, supplied here per request.
_VOCAB = [
    {"aliases": ["metformin"], "rxnorm_code": "6809", "umls_cui": "C0025598"},
    {
        "aliases": ["pneumonia"],
        "icd_code": "J18.9",
        "snomed_code": "233604007",
        "umls_cui": "C0032285",
    },
]


def _taxonomy(*, enabled: bool = True, floor: float = 0.0) -> ClinicalTaxonomy:
    return ClinicalTaxonomy.model_validate(
        {"linker": {"enabled": enabled, "confidenceFloor": floor, "vocabulary": _VOCAB}}
    )


def test_entity_schema_has_nullable_ontology_code_fields():
    entity = Entity(
        id="e1",
        text="metformin",
        normalized_text="metformin",
        entity_type="MEDICATION",
        confidence=0.9,
        position={"start": 0, "end": 9},
    )
    # Default None when unset...
    assert entity.umls_cui is None
    assert entity.snomed_code is None
    assert entity.rxnorm_code is None
    assert entity.icd_code is None
    assert entity.loinc_code is None
    # ...and serialized on the wire.
    dumped = entity.model_dump()
    for field in ("umls_cui", "snomed_code", "rxnorm_code", "icd_code", "loinc_code"):
        assert field in dumped


def _classifier_with_pipeline(results):
    classifier = TransformerTokenClassifier(
        configs=TokenClassificationConfig(model_name="test-org/ner", tokenizer_name="test-org/ner")
    )

    def fake_pipeline(text, **kwargs):
        return results

    classifier.pipeline = fake_pipeline
    classifier.is_initialized = True
    return classifier


@pytest.mark.asyncio
async def test_process_populates_rxnorm_for_recognized_medication():
    classifier = _classifier_with_pipeline(
        [{"entity_group": "MEDICATION", "score": 0.97, "word": "metformin", "start": 14, "end": 23}]
    )

    resp = await classifier.process(
        TokenClassificationRequest(text="patient takes metformin", clinical_taxonomy=_taxonomy())
    )

    assert len(resp.entities) == 1
    ent = resp.entities[0]
    # The recognized medication comes back CODED.
    assert ent.rxnorm_code == "6809"
    assert ent.umls_cui == "C0025598"
    # Existing output unchanged (encoder parity).
    assert ent.entity_type == "MEDICATION"
    assert ent.text == "metformin"
    assert ent.confidence == pytest.approx(0.97)
    assert ent.position.start == 14
    assert ent.position.end == 23


@pytest.mark.asyncio
async def test_process_populates_icd_and_snomed_for_recognized_condition():
    classifier = _classifier_with_pipeline(
        [{"entity_group": "DISEASE", "score": 0.95, "word": "pneumonia", "start": 12, "end": 21}]
    )

    resp = await classifier.process(
        TokenClassificationRequest(text="patient has pneumonia", clinical_taxonomy=_taxonomy())
    )

    ent = resp.entities[0]
    assert ent.icd_code == "J18.9"
    assert ent.snomed_code == "233604007"
    assert ent.umls_cui == "C0032285"


@pytest.mark.asyncio
async def test_process_leaves_codes_none_for_unrecognized_span():
    classifier = _classifier_with_pipeline(
        [{"entity_group": "PERSON", "score": 0.9, "word": "john smith", "start": 0, "end": 10}]
    )

    resp = await classifier.process(
        TokenClassificationRequest(text="john smith arrived", clinical_taxonomy=_taxonomy())
    )

    ent = resp.entities[0]
    assert ent.rxnorm_code is None
    assert ent.umls_cui is None
    assert ent.icd_code is None


@pytest.mark.asyncio
async def test_linking_disabled_toggle_leaves_codes_none():
    classifier = _classifier_with_pipeline(
        [{"entity_group": "MEDICATION", "score": 0.97, "word": "metformin", "start": 0, "end": 9}]
    )
    resp = await classifier.process(
        TokenClassificationRequest(text="metformin", clinical_taxonomy=_taxonomy(enabled=False))
    )

    assert resp.entities[0].rxnorm_code is None


@pytest.mark.asyncio
async def test_linking_respects_confidence_floor():
    classifier = _classifier_with_pipeline(
        [{"entity_group": "MEDICATION", "score": 0.10, "word": "metformin", "start": 0, "end": 9}]
    )
    resp = await classifier.process(
        TokenClassificationRequest(text="metformin", clinical_taxonomy=_taxonomy(floor=0.5))
    )

    # Below the floor → not linked (still returned as an entity, just un-coded).
    assert resp.entities[0].rxnorm_code is None
