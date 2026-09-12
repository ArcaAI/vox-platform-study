import time
from abc import ABC, abstractmethod
from typing import Any

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer, pipeline

from nlp.core.config import TextClassificationConfig
from nlp.core.logging import get_logger
from nlp.schemas.classification import (
    MultiLabelClassificationRequest,
    MultiLabelClassificationResponse,
    TextClassificationRequest,
    TextClassificationResponse,
)
from nlp.schemas.common import DeviceLabel

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
    async def process_multi_label(
        self, request: MultiLabelClassificationRequest
    ) -> MultiLabelClassificationResponse:
        """Classify text against every label the model exposes, independently."""
        pass

    @abstractmethod
    async def shutdown(self) -> None:
        """Shutdown the text classification model"""
        pass


class TransformerTextClassifier(TextClassifier):
    """Transformer-based text classification for medical documents"""

    def __init__(self, config: TextClassificationConfig):
        # REQUIRED — see `TransformerTokenClassifier`. The doc-type plane keeps
        # its unconfigured SENTINEL default on the config field (it is not a
        # model id and never loads), but the classifier is still only ever built
        # from a caller-supplied selection.
        super().__init__(config.model_name, config.model_version)

        self.config = config
        self.tokenizer: Any = None
        self.model: Any = None
        self.pipeline: Any = None
        self._unconfigured_warning_emitted = False
        # Resolved placement (TASK-959 metering). Set for real in `initialize()`;
        # the "cpu" floor here means a caller that never initializes (e.g. a
        # test stubbing `.pipeline` directly) still gets a well-defined value.
        self._device: DeviceLabel = "cpu"

    async def initialize(self) -> None:
        """Load transformer text classification model"""
        if not self.config.is_configured:
            # No clinical doc-type model has been chosen. Refuse to load the
            # placeholder sentinel as a real model: leave the service uninitialized so the
            # endpoint returns 503 instead of emitting wrong (e.g. emotion) labels for
            # clinical text. Warn loudly, but only once to avoid log spam on repeated calls.
            if not self._unconfigured_warning_emitted:
                logger.warning(
                    "Document-type text classification is UNCONFIGURED: no clinical doc-type "
                    "classifier model_name was provided (the current default is a non-functional "
                    "placeholder). /classify/text requires a DB-configured, "
                    "gateway-injected model_name and stays unavailable (HTTP 503) until one is "
                    "set. See the open decision in nlp.core.config (§3.4)."
                )
                self._unconfigured_warning_emitted = True
            self.is_initialized = False
            return

        try:
            logger.info("Initializing TextClassifier service.")

            self.tokenizer = AutoTokenizer.from_pretrained(self.model_name)
            self.model = AutoModelForSequenceClassification.from_pretrained(self.model_name)

            # D6: config.use_gpu (default True) now gates GPU use; default
            # preserves today's auto-detect-when-available behavior. This
            # pipeline never checks MPS (unchanged), so the resolved placement
            # (TASK-959) is honestly cuda-or-cpu, never mps.
            use_accelerator = self.config.use_gpu and torch.cuda.is_available()
            self._device = "cuda" if use_accelerator else "cpu"
            self.pipeline = pipeline(
                "text-classification",
                model=self.model,
                tokenizer=self.tokenizer,
                device=0 if use_accelerator else -1,
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
            scores, inference_ms = self._raw_scores(request.text)
            top_label = max(scores, key=lambda label: scores[label])

            return TextClassificationResponse(
                predicted_label=top_label,
                confidence=scores[top_label],
                probabilities=scores,
                model_version=self.version,
                inference_ms=inference_ms,
                device=self._device,
            )

        except Exception:
            return TextClassificationResponse(
                predicted_label="other",
                confidence=0.0,
                probabilities={"other": 1.0},
                model_version=self.version,
                inference_ms=0,
                device=self._device,
            )

    async def process_multi_label(
        self, request: MultiLabelClassificationRequest
    ) -> MultiLabelClassificationResponse:
        """Score every label the model exposes independently, threshold-gated.

        Reuses the SAME pipeline call `process()` does — the model's own head
        (softmax/single-label or sigmoid/multi-label) decides how its scores
        relate to one another; this method invents no taxonomy of its own, it
        only applies the caller's `cls_threshold` to whatever labels come
        back, so zero, one, or several may clear it on the same input.
        """
        if not self.is_initialized:
            await self.initialize()

        scores, inference_ms = self._raw_scores(request.text)
        predicted_labels = [
            label for label, score in scores.items() if score >= request.cls_threshold
        ]

        return MultiLabelClassificationResponse(
            predicted_labels=predicted_labels,
            scores=scores,
            threshold=request.cls_threshold,
            model_version=self.version,
            inference_ms=inference_ms,
            device=self._device,
        )

    def _raw_scores(self, text: str) -> tuple[dict[str, float], int]:
        """Every label the pipeline returns, mapped to its own independent score,
        alongside the wall-clock time the pipeline call took (TASK-959)."""
        started = time.perf_counter()
        pipeline_results = self.pipeline(text)
        inference_ms = round((time.perf_counter() - started) * 1000)
        return {item["label"]: float(item["score"]) for item in pipeline_results}, inference_ms

    async def shutdown(self) -> None:
        """Shutdown the text classification model"""
        self.tokenizer = None
        self.model = None
        self.pipeline = None
        self.is_initialized = False
