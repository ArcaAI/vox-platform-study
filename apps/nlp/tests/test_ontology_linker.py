"""TASK-476 C1 — deterministic clinical ontology linker.

RED-first: written before ``nlp.services.ontology_linker`` exists. The linker
resolves a recognized clinical span to standardized ontology codes (UMLS CUI +
cross-walks to SNOMED CT / RxNorm / ICD-10 / LOINC) against a bundled,
self-hosted vocabulary subset. It is fully deterministic and offline — no
network, no cloud vendor, no model download.

These tests pin:
  * a known medication resolves to RxNorm + UMLS (AC-1: ``metformin``);
  * a known condition resolves to ICD-10 + SNOMED + UMLS (AC-1: ``pneumonia``);
  * lookup is normalization-robust (case / whitespace / leading article / ``▁``);
  * an unknown span returns an all-``None`` record (null-safe downstream);
  * repeated lookups are identical (deterministic).
"""

from __future__ import annotations

from nlp.services.ontology_linker import OntologyCodes, OntologyLinker


def test_links_known_medication_to_rxnorm_and_umls():
    linker = OntologyLinker()

    codes = linker.link("metformin")

    assert isinstance(codes, OntologyCodes)
    assert codes.rxnorm_code == "6809"
    assert codes.umls_cui == "C0025598"
    assert codes.has_any is True


def test_links_known_condition_to_icd_snomed_and_umls():
    linker = OntologyLinker()

    codes = linker.link("pneumonia")

    assert codes.icd_code == "J18.9"
    assert codes.snomed_code == "233604007"
    assert codes.umls_cui == "C0032285"


def test_lookup_is_normalization_robust():
    linker = OntologyLinker()

    # Case, surrounding whitespace, a leading article, and a SentencePiece "▁"
    # marker must all normalize to the same vocabulary key.
    assert linker.link("  Metformin ").rxnorm_code == "6809"
    assert linker.link("PNEUMONIA").icd_code == "J18.9"
    assert linker.link("the pneumonia").icd_code == "J18.9"
    assert linker.link("▁metformin").rxnorm_code == "6809"


def test_unknown_span_returns_all_none_record():
    linker = OntologyLinker()

    codes = linker.link("qwerty zzz not-a-clinical-term")

    assert codes == OntologyCodes()
    assert codes.umls_cui is None
    assert codes.snomed_code is None
    assert codes.rxnorm_code is None
    assert codes.icd_code is None
    assert codes.loinc_code is None
    assert codes.has_any is False


def test_lookup_is_deterministic():
    linker = OntologyLinker()

    first = linker.link("amoxicillin")
    second = linker.link("amoxicillin")

    assert first == second
    assert first.rxnorm_code == "723"


def test_links_a_lab_analyte_to_loinc():
    linker = OntologyLinker()

    codes = linker.link("hemoglobin a1c")

    assert codes.loinc_code == "4548-4"
    assert codes.umls_cui == "C0202054"


def test_empty_span_returns_all_none_record():
    linker = OntologyLinker()

    assert linker.link("").has_any is False
    assert linker.link("   ").has_any is False
