import uuid
from abc import ABC, abstractmethod
from typing import Any

import torch
from transformers import AutoModelForTokenClassification, AutoTokenizer, pipeline

from nlp.core.config import TokenClassificationConfig
from nlp.core.logging import get_logger
from nlp.core.metrics import MODEL_MEDICAL_NER, track_model_inference
from nlp.schemas.classification import TokenClassificationRequest, TokenClassificationResponse
from nlp.schemas.common import Entity, TextPosition

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

    def __init__(self, configs: TokenClassificationConfig | None = None):
        if configs is None:
            configs = TokenClassificationConfig()

        super().__init__(configs.model_name, configs.model_version)

        self.configs = configs
        self.tokenizer: Any = None
        self.model: Any = None
        self.pipeline: Any = None

    async def initialize(self) -> None:
        """Load transformer token classification model"""
        try:
            logger.info("Initializing TokenClassifier service.")

            self.tokenizer = AutoTokenizer.from_pretrained(self.model_name)
            self.model = AutoModelForTokenClassification.from_pretrained(self.model_name)

            self.pipeline = pipeline(
                "token-classification",
                model=self.model,
                tokenizer=self.tokenizer,
                device=0 if torch.cuda.is_available() else -1,
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
            # TASK-452 — honor the request's aggregation strategy (config fallback).
            # Without a non-"none" strategy the HF pipeline emits `##` subword
            # fragments with raw BIO labels instead of merged whole-word entities.
            strategy = request.aggregation_strategy or self.configs.aggregation_strategy
            # TASK-386 — per-model running gauge + inference latency (Medical-NER).
            with track_model_inference(MODEL_MEDICAL_NER):
                pipeline_results = self.pipeline(request.text, aggregation_strategy=strategy)

            # tokenized = self.tokenizer(text, return_tensors="pt", add_special_tokens=True)
            # tokens = self.tokenizer.convert_ids_to_tokens(tokenized["input_ids"][0])

            # with torch.no_grad():
            #     outputs = self.model(**tokenized)
            #     predictions = torch.nn.functional.softmax(outputs.logits, dim=-1)
            #     predicted_labels = torch.argmax(predictions, dim=-1)

            # labels = []
            # confidences = []

            # for i, (pred_id, pred_probs) in enumerate(zip(predicted_labels[0], predictions[0])):
            #     label = self.label_mapping.get(pred_id.item(), "O")
            #     confidence = pred_probs[pred_id].item()
            #     labels.append(label)
            #     confidences.append(confidence)

            entities = self._to_entities(pipeline_results)

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

    async def shutdown(self) -> None:
        """Shutdown the token classification model"""
        pass
