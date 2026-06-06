from abc import ABC, abstractmethod
from typing import Any

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer, pipeline

from nlp.core.config import TextClassificationConfig
from nlp.core.logging import get_logger
from nlp.schemas.classification import TextClassificationRequest, TextClassificationResponse

logger = get_logger(__name__)


class TextClassifier(ABC):
    """Abstract base class for text classification models"""

    def __init__(self, model_name: str, version: str):
        self.model_name = model_name
        self.version = version
        self.is_initialized = False

    @abstractmethod
    async def initialize(self) -> None:
        """Load the text classification model"""
        pass

    @abstractmethod
    async def process(self, request: TextClassificationRequest) -> TextClassificationResponse:
        """Classify medical text into categories"""
        pass

    @abstractmethod
    async def shutdown(self) -> None:
        """Shutdown the text classification model"""
        pass


class TransformerTextClassifier(TextClassifier):
    """Transformer-based text classification for medical documents"""

    def __init__(self, config: TextClassificationConfig | None = None):
        if config is None:
            config = TextClassificationConfig()

        super().__init__(config.model_name, config.model_version)

        self.config = config
        self.tokenizer: Any = None
        self.model: Any = None
        self.pipeline: Any = None
        self._unconfigured_warning_emitted = False

    async def initialize(self) -> None:
        """Load transformer text classification model"""
        if not self.config.is_configured:
            # No clinical doc-type model has been chosen (TASK-330 §3.4). Refuse to load the
            # placeholder sentinel as a real model: leave the service uninitialized so the
            # endpoint returns 503 instead of emitting wrong (e.g. emotion) labels for
            # clinical text. Warn loudly, but only once to avoid log spam on repeated calls.
            if not self._unconfigured_warning_emitted:
                logger.warning(
                    "Document-type text classification is UNCONFIGURED: no clinical doc-type "
                    "classifier model is set via TEXT_CLASSIFIER_MODEL_NAME (the current default "
                    "is a non-functional placeholder). The /classify/text endpoint will be "
                    "unavailable (HTTP 503) until a model is configured. See the open decision "
                    "in nlp.core.config (TASK-330 §3.4)."
                )
                self._unconfigured_warning_emitted = True
            self.is_initialized = False
            return

        try:
            logger.info("Initializing TextClassifier service.")

            self.tokenizer = AutoTokenizer.from_pretrained(self.model_name)
            self.model = AutoModelForSequenceClassification.from_pretrained(self.model_name)

            self.pipeline = pipeline(
                "text-classification",
                model=self.model,
                tokenizer=self.tokenizer,
                device=0 if torch.cuda.is_available() else -1,
            )

            # self.label_mapping = self.model.config.id2label

            self.is_initialized = True

            logger.info("TextClassifier initialized successfully")

        except Exception as e:
            raise RuntimeError(f"Failed to load TextClassifier: {str(e)}") from e

    async def process(self, request: TextClassificationRequest) -> TextClassificationResponse:
        """Classify medical text into document categories"""
        if not self.is_initialized:
            await self.initialize()

        try:
            pipeline_results = self.pipeline(request.text)
            top_prediction = max(pipeline_results, key=lambda x: x["score"])
            probabilities = {score_item["label"]: float(score_item["score"]) for score_item in pipeline_results}

            return TextClassificationResponse(
                predicted_label=top_prediction["label"],
                confidence=float(top_prediction["score"]),
                probabilities=probabilities,
                model_version=self.version,
            )

        except Exception:
            return TextClassificationResponse(
                predicted_label="other",
                confidence=0.0,
                probabilities={"other": 1.0},
                model_version=self.version,
            )

    async def shutdown(self) -> None:
        """Shutdown the text classification model"""
        self.tokenizer = None
        self.model = None
        self.pipeline = None
        self.is_initialized = False
