"""The clinical taxonomy the NER plane executes against (TASK-799 lane G).

`apps/nlp` is the EXECUTOR for the clinical NER plane, never its policy owner —
the same contract `schemas/guard.py` already declares for the guardrail plane.
Four things used to be Python literals in this service and are configuration by
rule 00 §Configuration Principles ("a threshold, prompt, taxonomy or label set
is NOT a literal in code and is NOT an env var"):

* the **ontology vocabulary** — the UMLS/SNOMED/RxNorm/ICD-10/LOINC crosswalk the
  linker resolves a span against (was `ontology_linker._VOCABULARY_ENTRIES`);
* the **vitals plausibility bands** — the physiologic ranges outside which a
  parsed vital is discarded (was `vitals_extractor._SYSTOLIC_RANGE` &c.);
* the **assertion trigger lexicon** — the ConText/NegEx phrases that mark a span
  ABSENT / FAMILY / HYPOTHETICAL / HISTORICAL (was `assertion._TRIGGERS`);
* the **token-classifier contract** — aggregation strategy, the labels that mean
  "nothing", and whether the assertion pass runs (was five `TOKEN_CLASSIFIER_*` /
  `NLP_LINKER_*` env fields).

Where it lives now: `AiModel._metadata.clinicalTaxonomy` on the row the
`nlp.ner` `AiTaskDefault` selects — beside `_metadata.labelTaxonomy`, which the
guardrail plane already treats as load-bearing configuration for exactly the
same reason. The gateway resolves it (`resolveNerModelInjection`, SYSTEM-pinned
per decision D-4: nlp models are PLATFORM-SHARED) and injects it into the
`/classify/tokens` body. It travels with the CHECKPOINT because most of it is a
property of the checkpoint: which labels that model emits as "nothing", how its
subword pieces aggregate, which surface forms its NER can be expected to produce.

Fail posture, declared here rather than decided at each call site
================================================================
This module carries **no defaults for any taxonomy content**. An absent section
DISABLES the pass it governs — it never substitutes a literal:

* no `linker.vocabulary`  ⇒ every span resolves all-None (the linker's existing
  null-safe contract for an unknown span; the downstream groundedness guard
  already covers un-coded spans);
* no `vitals` bands       ⇒ no vital is emitted (the extractor's documented
  fail-SAFE direction: a value that cannot be range-checked is never shown);
* no `assertion.triggers` ⇒ the assertion pass is skipped, so no span is labelled
  ABSENT/FAMILY/... on evidence this service invented.

That is deliberately NOT a 503 on the whole route: model SELECTION is fail-closed
(a missing `model_name` is already 503, and stays so), but an unconfigured
ENRICHMENT must not take entity extraction down with it. What matters for rule 00
is that nothing is fabricated and no code literal is substituted — and nothing is.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class OntologyVocabularyEntry(BaseModel):
    """One vocabulary row: surface aliases → the codes they resolve to."""

    model_config = ConfigDict(frozen=True)

    aliases: list[str] = Field(
        ..., min_length=1, description="Surface forms, matched after normalization"
    )
    umls_cui: str | None = Field(default=None)
    snomed_code: str | None = Field(default=None)
    rxnorm_code: str | None = Field(default=None)
    icd_code: str | None = Field(default=None)
    loinc_code: str | None = Field(default=None)


class LinkerTaxonomy(BaseModel):
    """The ontology linker's configuration and its vocabulary."""

    model_config = ConfigDict(frozen=True, populate_by_name=True)

    enabled: bool = Field(default=True)
    confidence_floor: float = Field(default=0.0, ge=0.0, le=1.0, alias="confidenceFloor")
    #: Absent/empty ⇒ the linker emits all-None codes. Never a bundled fallback.
    vocabulary: list[OntologyVocabularyEntry] = Field(default_factory=list)


class VitalsRange(BaseModel):
    """One inclusive physiologic plausibility band."""

    model_config = ConfigDict(frozen=True)

    min: float
    max: float

    def contains(self, value: float) -> bool:
        return self.min <= value <= self.max


class VitalsTaxonomy(BaseModel):
    """Per-vital plausibility bands. An absent band disables that vital."""

    model_config = ConfigDict(frozen=True, populate_by_name=True)

    systolic: VitalsRange | None = Field(default=None)
    diastolic: VitalsRange | None = Field(default=None)
    heart_rate: VitalsRange | None = Field(default=None, alias="heartRate")
    spo2: VitalsRange | None = Field(default=None)
    temperature_c: VitalsRange | None = Field(default=None, alias="temperatureC")
    weight_kg: VitalsRange | None = Field(default=None, alias="weightKg")


class AssertionTaxonomy(BaseModel):
    """ConText/NegEx pre-trigger lexicon, keyed by the status a match implies.

    Keys are `AssertionStatus` values (`ABSENT` / `FAMILY` / `HYPOTHETICAL` /
    `HISTORICAL`). An unknown key is ignored rather than rejected, so widening
    the status enum later does not invalidate a stored taxonomy.
    """

    model_config = ConfigDict(frozen=True)

    triggers: dict[str, list[str]] = Field(default_factory=dict)


class TokenClassifierTaxonomy(BaseModel):
    """The NER contract of the selected checkpoint.

    These are checkpoint properties, not operator preferences: which labels that
    model emits meaning "nothing", and how its subword pieces aggregate into
    spans. They used to be `TOKEN_CLASSIFIER_IGNORE_LABELS` /
    `TOKEN_CLASSIFIER_AGGREGATION_STRATEGY` / `TOKEN_CLASSIFIER_ASSERTION_ENABLED`
    — an env var could not vary with the model it describes.
    """

    model_config = ConfigDict(frozen=True, populate_by_name=True)

    aggregation_strategy: str | None = Field(default=None, alias="aggregationStrategy")
    #: Absent ⇒ nothing is filtered here. Not a literal `["O"]`.
    ignore_labels: list[str] = Field(default_factory=list, alias="ignoreLabels")
    #: Absent ⇒ the assertion pass is skipped (see the module docstring).
    assertion_enabled: bool = Field(default=False, alias="assertionEnabled")


class ClinicalTaxonomy(BaseModel):
    """Everything the NER plane executes against, resolved by the gateway."""

    model_config = ConfigDict(frozen=True, populate_by_name=True)

    token_classifier: TokenClassifierTaxonomy = Field(
        default_factory=TokenClassifierTaxonomy, alias="tokenClassifier"
    )
    linker: LinkerTaxonomy = Field(default_factory=LinkerTaxonomy)
    vitals: VitalsTaxonomy = Field(default_factory=VitalsTaxonomy)
    assertion: AssertionTaxonomy = Field(default_factory=AssertionTaxonomy)
