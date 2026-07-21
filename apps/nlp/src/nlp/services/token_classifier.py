import uuid
from abc import ABC, abstractmethod
from typing import Any

import torch
from transformers import AutoModelForTokenClassification, AutoTokenizer, pipeline

from nlp.core.config import OntologyLinkerConfig, TokenClassificationConfig
from nlp.core.logging import get_logger
from nlp.core.metrics import MODEL_MEDICAL_NER, track_model_inference
from nlp.schemas.classification import TokenClassificationRequest, TokenClassificationResponse
from nlp.schemas.common import Entity, TextPosition
from nlp.services.assertion import AssertionModel, NegExAssertionClassifier
from nlp.services.ontology_linker import OntologyLinker

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


class TransformerTokenClassifier(TokenClassifier):
    """Transformer-based token classification for medical entity extraction"""

    def __init__(
        self,
        configs: TokenClassificationConfig | None = None,
        linker: OntologyLinker | None = None,
        linker_config: OntologyLinkerConfig | None = None,
        assertion_classifier: AssertionModel | None = None,
    ):
        if configs is None:
            configs = TokenClassificationConfig()

        super().__init__(configs.model_name, configs.model_version)

        self.configs = configs
        self.tokenizer: Any = None
        self.model: Any = None
        self.pipeline: Any = None
        # Deterministic, offline clinical ontology linker. Runs
        # post-`_to_entities` in `process()` to populate the entity code fields.
        self.linker = linker if linker is not None else OntologyLinker()
        self.linker_config = linker_config if linker_config is not None else OntologyLinkerConfig()
        # deterministic ConText/NegEx assertion classifier. Runs after
        # linking to label each span's polarity (PRESENT/ABSENT/…). The injected
        # AssertionModel is the model-swap seam for a future learned model.
        self.assertion_classifier = assertion_classifier if assertion_classifier is not None else NegExAssertionClassifier()

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
            # Honor the request's aggregation strategy (config fallback).
            # Without a non-"none" strategy the HF pipeline emits `##` subword
            # fragments with raw BIO labels instead of merged whole-word entities.
            strategy = request.aggregation_strategy or self.configs.aggregation_strategy
            # Per-model running gauge + inference latency (Medical-NER).
            with track_model_inference(MODEL_MEDICAL_NER):
                pipeline_results = self.pipeline(request.text, aggregation_strategy=strategy)

            entities = self._to_entities(pipeline_results)
            # Resolve ontology codes for each recognized span so the
            # NLP service is the authoritative producer of CODED entities.
            entities = self._link_entities(entities)
            # label each span's assertion polarity (negation/family/
            # historical/hypothetical) over the request text. Config-gated.
            if self.configs.assertion_enabled and entities:
                entities = self.assertion_classifier.classify(request.text, entities)

            return TokenClassificationResponse(
                # tokens=tokens,
                # labels=labels,
                # confidences=confidences,
                entities=entities,
                model_version=self.version,
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

    def _to_entities(self, pipeline_results: list[dict[str, Any]]) -> list[Entity]:
        """Convert pipeline results to MedicalEntity objects"""
        entities = []
        ignore_labels = set(self.configs.ignore_labels)

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

    def _link_entities(self, entities: list[Entity]) -> list[Entity]:
        """Resolve ontology codes for each recognized span.

        Config-gated: skipped entirely when the linker is disabled, and only
        entities at/above the confidence floor are linked (low-confidence NER
        noise stays un-coded). Un-resolvable spans keep None codes — the mapping
        stays null-safe end to end. Deterministic + offline (no network).
        """
        if not self.linker_config.linker_enabled:
            return entities

        floor = self.linker_config.linker_confidence_floor
        for entity in entities:
            if entity.confidence < floor:
                continue
            codes = self.linker.link(entity.normalized_text or entity.text)
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
