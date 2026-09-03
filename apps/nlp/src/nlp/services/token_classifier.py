import uuid
from abc import ABC, abstractmethod
from collections import OrderedDict
from collections.abc import Callable
from typing import Any, TypeVar

import torch
from transformers import AutoModelForTokenClassification, AutoTokenizer, pipeline

from nlp.core.config import TokenClassificationConfig
from nlp.core.logging import get_logger
from nlp.core.metrics import (
    MODEL_MEDICAL_NER,
    NLP_DOCUMENTS_PROCESSED_TOTAL,
    nlp_metrics,
    track_model_inference,
)
from nlp.schemas.classification import TokenClassificationRequest, TokenClassificationResponse
from nlp.schemas.clinical_taxonomy import AssertionTaxonomy, ClinicalTaxonomy, LinkerTaxonomy
from nlp.schemas.common import Entity, TextPosition
from nlp.services.assertion import AssertionModel, NegExAssertionClassifier
from nlp.services.ontology_linker import OntologyLinker
from nlp.services.vitals_extractor import extract_vitals

logger = get_logger(__name__)


class TokenClassifier(ABC):
    """Abstract base class for token classification models"""

    def __init__(self, model_name: str, version: str):
        self.model_name = model_name
        self.version = version
        self.is_initialized = False

    @abstractmethod
    async def initialize(self) -> None:
        """Load the token classification model"""
        pass

    @abstractmethod
    async def process(self, request: TokenClassificationRequest) -> TokenClassificationResponse:
        """Classify tokens and extract medical entities"""
        pass

    @abstractmethod
    async def shutdown(self) -> None:
        """Shutdown the token classification model"""
        pass


# --------------------------------------------------------------------------
# Per-taxonomy builders, memoized.
#
# The taxonomy arrives per REQUEST, but building from it is not free: the linker
# expands ~40 vocabulary rows into a lookup table and the assertion engine
# compiles one regex per trigger phrase. In practice a deployment serves ONE
# taxonomy (the platform-shared `nlp.ner` row — decision D-4), so a tiny
# insertion-ordered cache keyed on the taxonomy's canonical JSON makes the steady
# state a dict hit while an admin edit is still picked up immediately.
# --------------------------------------------------------------------------

_BUILDER_CACHE_MAX = 8
_T = TypeVar("_T")
_linker_cache: OrderedDict[str, OntologyLinker] = OrderedDict()
_assertion_cache: OrderedDict[str, NegExAssertionClassifier] = OrderedDict()


def _cached(cache: OrderedDict[str, _T], key: str, build: Callable[[], _T]) -> _T:
    hit = cache.get(key)
    if hit is not None:
        cache.move_to_end(key)
        return hit
    built = build()
    cache[key] = built
    while len(cache) > _BUILDER_CACHE_MAX:
        cache.popitem(last=False)
    return built


def _linker_for(section: LinkerTaxonomy) -> OntologyLinker:
    return _cached(
        _linker_cache, section.model_dump_json(), lambda: OntologyLinker.from_taxonomy(section)
    )


def _assertion_classifier_for(section: AssertionTaxonomy) -> NegExAssertionClassifier:
    return _cached(
        _assertion_cache,
        section.model_dump_json(),
        lambda: NegExAssertionClassifier.from_taxonomy(section),
    )


class TransformerTokenClassifier(TokenClassifier):
    """Transformer-based token classification for medical entity extraction"""

    def __init__(
        self,
        configs: TokenClassificationConfig,
        assertion_classifier: AssertionModel | None = None,
    ):
        # `configs` is REQUIRED: it carries the resolved model selection, and
        # there is no default to fall back to — building one here would put a
        # checkpoint id back into shipped Python.
        super().__init__(configs.model_name, configs.model_version)

        self.configs = configs
        self.tokenizer: Any = None
        self.model: Any = None
        self.pipeline: Any = None
        # The linker and the assertion classifier are built PER REQUEST from the
        # gateway-injected taxonomy, NOT held on the instance: this object lives
        # in a model cache keyed on weight identity alone, so instance-level
        # taxonomy state would serve one caller's configuration to the next.
        # `assertion_classifier` stays as the model-swap seam (a future learned
        # model), and when supplied it overrides the taxonomy-built rule engine.
        self._assertion_override = assertion_classifier

    async def initialize(self) -> None:
        """Load transformer token classification model"""
        # Idempotent: per-request MedicalSuggester instances share the
        # default token classifier and call initialize() again; never reload it.
        if self.is_initialized:
            return

        try:
            logger.info("Initializing TokenClassifier service.")

            self.tokenizer = AutoTokenizer.from_pretrained(self.model_name)
            self.model = AutoModelForTokenClassification.from_pretrained(self.model_name)

            self.pipeline = pipeline(
                "token-classification",
                model=self.model,
                tokenizer=self.tokenizer,
                # `configs.use_gpu` (default True) gates GPU use;
                # default preserves auto-detect-when-available behavior.
                device=0 if (self.configs.use_gpu and torch.cuda.is_available()) else -1,
            )

            self.label_mapping = self.model.config.id2label

            self.is_initialized = True

            logger.info("TokenClassifier initialized successfully")

        except Exception as e:
            raise RuntimeError(f"Failed to load token classification model: {str(e)}") from e

    async def process(self, request: TokenClassificationRequest) -> TokenClassificationResponse:
        """Classify tokens and extract medical entities"""
        if not self.is_initialized:
            await self.initialize()

        try:
            # The clinical taxonomy the gateway resolved from
            # `AiModel._metadata.clinicalTaxonomy` for THIS request. Absent ⇒ an
            # empty taxonomy, which disables every pass it governs rather than
            # substituting a literal (see `nlp.schemas.clinical_taxonomy`).
            taxonomy = request.clinical_taxonomy or ClinicalTaxonomy()

            # Aggregation strategy: the request's own field wins (it is part of
            # the public API), then the checkpoint's declared strategy. Without a
            # non-"none" strategy the HF pipeline emits `##` subword fragments
            # with raw BIO labels instead of merged whole-word entities.
            strategy = (
                request.aggregation_strategy
                or taxonomy.token_classifier.aggregation_strategy
                or "simple"
            )
            # Per-model running gauge + inference latency (Medical-NER).
            with track_model_inference(MODEL_MEDICAL_NER):
                pipeline_results = self.pipeline(request.text, aggregation_strategy=strategy)

            entities = self._to_entities(pipeline_results, taxonomy)
            # Resolve ontology codes for each recognized span so the
            # NLP service is the authoritative producer of CODED entities.
            entities = self._link_entities(entities, taxonomy)
            # Label each span's assertion polarity (negation/family/historical/
            # hypothetical) over the request text. Taxonomy-gated.
            if entities and taxonomy.token_classifier.assertion_enabled:
                classifier = self._assertion_override or _assertion_classifier_for(
                    taxonomy.assertion
                )
                entities = classifier.classify(request.text, entities)

            # Wire the previously dead record_entities at the
            # real call-site (current-state-review — zero call-sites
            # outside its own definition). One call per DISTINCT entity_type so
            # the label stays bounded (the model's own fixed BIO-tag label set,
            # not free text), plus one "document processed" per call — this
            # single site is shared by BOTH the REST route (classify_tokens)
            # and the WebSocket route (same service.process()).
            self._record_usage_metrics(entities)

            return TokenClassificationResponse(
                # tokens=tokens,
                # labels=labels,
                # confidences=confidences,
                entities=entities,
                model_version=self.version,
                # Deterministic vitals over the request text (null-safe; None when absent).
                vitals=extract_vitals(request.text, taxonomy.vitals),
            )

        except Exception as e:
            print(f"Error in token classification: {str(e)}")
            # tokens = text.split()
            # labels = ["O"] * len(tokens)
            # confidences = [0.0] * len(tokens)
            entities = []

            return TokenClassificationResponse(
                # tokens=tokens,
                # labels=labels,
                # confidences=confidences,
                entities=entities,
                model_version=self.version,
            )

    def _record_usage_metrics(self, entities: list[Entity]) -> None:
        """Entities-by-type (dual OTel+Prometheus write via
        ``nlp_metrics.record_entities``) + one documents-processed increment.
        Grouped by type so the label is bounded by the model's own fixed
        BIO-tag label set, never a per-entity free-text value.
        """
        counts: dict[str, int] = {}
        for entity in entities:
            counts[entity.entity_type] = counts.get(entity.entity_type, 0) + 1
        for entity_type, count in counts.items():
            nlp_metrics.record_entities(
                entity_count=count, entity_type=entity_type, model=MODEL_MEDICAL_NER
            )
        NLP_DOCUMENTS_PROCESSED_TOTAL.labels(model=MODEL_MEDICAL_NER).inc()

    def _to_entities(
        self, pipeline_results: list[dict[str, Any]], taxonomy: ClinicalTaxonomy
    ) -> list[Entity]:
        """Convert pipeline results to MedicalEntity objects"""
        entities = []
        # The labels this CHECKPOINT emits meaning "nothing" — declared on its
        # own registry row, because they differ per checkpoint and an env var
        # could not vary with the model it describes.
        ignore_labels = set(taxonomy.token_classifier.ignore_labels)

        for result in pipeline_results:
            # With aggregation != "none" the HF pipeline merges subwords and keys
            # the label under `entity_group` (BIO prefix stripped); fall back to the
            # raw `entity` key for the "none" strategy.
            entity_type = result.get("entity_group") or result.get("entity", "O")
            if entity_type in ignore_labels:
                continue

            entity_text = result.get("word", "")
            confidence = result.get("score", 0.0)
            start_pos = result.get("start", 0)
            end_pos = result.get("end", len(entity_text))

            entity = Entity(
                id=str(uuid.uuid4()),
                text=entity_text,
                normalized_text=entity_text.strip().lower(),
                entity_type=entity_type,
                confidence=confidence,
                position=TextPosition(start=start_pos, end=end_pos),
                model_version=self.version,
            )

            entities.append(entity)

        return entities

    def _link_entities(self, entities: list[Entity], taxonomy: ClinicalTaxonomy) -> list[Entity]:
        """Resolve ontology codes for each recognized span.

        Taxonomy-gated: skipped entirely when the linker is disabled OR carries
        no vocabulary, and only entities at/above the configured confidence floor
        are linked (low-confidence NER noise stays un-coded). Un-resolvable spans
        keep None codes — the mapping stays null-safe end to end. Deterministic +
        offline (no network).
        """
        if not taxonomy.linker.enabled or not taxonomy.linker.vocabulary:
            return entities

        linker = _linker_for(taxonomy.linker)
        floor = taxonomy.linker.confidence_floor
        for entity in entities:
            if entity.confidence < floor:
                continue
            codes = linker.link(entity.normalized_text or entity.text)
            if codes.has_any:
                entity.umls_cui = codes.umls_cui
                entity.snomed_code = codes.snomed_code
                entity.rxnorm_code = codes.rxnorm_code
                entity.icd_code = codes.icd_code
                entity.loinc_code = codes.loinc_code

        return entities

    async def shutdown(self) -> None:
        """Shutdown the token classification model"""
        pass
