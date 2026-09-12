"""GLiNER2 as a token classifier — the OPEN-taxonomy half of ``/classify/tokens``.

The registry has ONE task type for span extraction (``TOKEN_CLASSIFICATION``) and
two runtimes behind it (see :mod:`nlp.core.checkpoint_family`). This adapter puts
the ``gliner2`` runtime — already hosted here for the guard plane — behind the
same :class:`~nlp.services.token_classifier.TokenClassifier` contract the
transformers pipeline implements, so ``/classify/tokens`` answers ONE response
shape whichever family the caller's checkpoint belongs to.

The difference the caller MUST supply is the taxonomy: a GLiNER extractor has no
label set of its own, so the labels arrive per request (the gateway resolves them
from the node's declared labels, else ``AiModel._metadata.labelTaxonomy``). An
absent taxonomy is a REFUSAL, exactly as on ``/guard/pii`` — never a label list
invented here.

Fail posture — FAIL-CLOSED and never fabricating, like every other guard-plane
path: a load or inference failure raises. An empty entity list means "the model
ran and found nothing".
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from nlp.core.logging import get_logger
from nlp.schemas.classification import TokenClassificationRequest, TokenClassificationResponse
from nlp.schemas.common import Entity, TextPosition
from nlp.services.token_classifier import TokenClassifier

logger = get_logger(__name__)

#: Version reported on every entity when the caller pinned none — the same
#: program default `TokenClassificationConfig.model_version` carries.
DEFAULT_MODEL_VERSION = "1.0.0"


class ExtractorLabelsUnavailable(RuntimeError):
    """An OPEN-taxonomy checkpoint was asked to extract with no labels.

    Distinct from ``ModelUnavailableError``: the MODEL loaded fine, the taxonomy
    that tells it what to look for is missing. The route maps both to 503 —
    unserviceable either way — but the cause has to stay legible in the log.
    """


class Gliner2TokenClassifier(TokenClassifier):
    """The ``gliner2`` extractor behind the token-classification contract."""

    def __init__(
        self,
        model_name: str,
        runtime: Any,
        version: str = DEFAULT_MODEL_VERSION,
    ) -> None:
        super().__init__(model_name, version)
        # Already-loaded (the cache factory drives `Gliner2GuardService.load` off
        # the event loop, as the guard plane does), so `initialize` is a no-op.
        self._runtime = runtime

    async def initialize(self) -> None:
        self.is_initialized = True

    async def process(self, request: TokenClassificationRequest) -> TokenClassificationResponse:
        labels = [
            label.strip()
            for label in (request.labels or [])
            if isinstance(label, str) and label.strip()
        ]
        if not labels:
            raise ExtractorLabelsUnavailable(
                f"model {self.model_name} is an open-taxonomy extractor and the request "
                "declared no labels; the caller resolves them (node labels, else the "
                "registry row's labelTaxonomy) and this service never invents a set"
            )

        # Absent ⇒ 0.0: the model's own answer rides through and the CALLER
        # filters at its own threshold. A floor chosen here would be policy.
        threshold = float(request.threshold) if request.threshold is not None else 0.0
        started = time.perf_counter()
        spans = await self._runtime.extract_entities(request.text, labels, threshold)
        inference_ms = round((time.perf_counter() - started) * 1000)
        entities = [entity for entity in map(self._to_entity, spans or []) if entity is not None]
        logger.info(
            f"nlp.gliner_token_classifier.extracted model={self.model_name} "
            f"labels={len(labels)} entities={len(entities)}"
        )
        return TokenClassificationResponse(
            entities=entities,
            model_version=self.version,
            # No vitals pass: those are the clinical NER contract, driven by the
            # taxonomy of a checkpoint that declares one. Never fabricated here.
            vitals=None,
            inference_ms=inference_ms,
            # The runtime is the shared `Gliner2GuardService` (its `.device`
            # already resolved from `nlp.core.device`); a bare stub without one
            # (unit tests) falls back to the cheaper unit rather than nothing.
            device=getattr(self._runtime, "device", "cpu"),
        )

    def _to_entity(self, span: Any) -> Entity | None:
        if not isinstance(span, dict):
            return None
        start, end = span.get("start"), span.get("end")
        if not isinstance(start, int) or not isinstance(end, int):
            return None
        text = str(span.get("text") or "")
        raw_score = span.get("score")
        score = float(raw_score) if isinstance(raw_score, (int, float)) else 0.0
        return Entity(
            id=str(uuid.uuid4()),
            text=text,
            normalized_text=text.strip().lower(),
            entity_type=str(span.get("label") or ""),
            # The schema bounds confidence to [0, 1]; a runtime reporting outside
            # it must not 500 the whole request.
            confidence=min(1.0, max(0.0, score)),
            position=TextPosition(start=start, end=end),
            model_version=self.version,
        )

    async def shutdown(self) -> None:
        self._runtime = None
