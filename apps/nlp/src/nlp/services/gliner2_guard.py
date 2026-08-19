"""GLiNER2 guardrail-class inference (TASK-735 Phase 3).

Hosts the two owner-specified models — moved here from `apps/guardrail`, which
must hold zero resident weights:

* ``fastino/gliner2-privacy-filter-PII-multi`` — PII entity spans, used by
  guardrail's ``/guardrail/redact`` and its PII detection path;
* ``fastino/gliguard-LLMGuardrails-300M`` — LLM safety moderation over six
  tasks (``prompt_safety``, ``prompt_toxicity``, ``jailbreak_detection``,
  ``response_safety``, ``response_toxicity``, ``response_refusal``).

Neither id appears here: both arrive per request, resolved by guardrail from
``AiTaskDefault`` ⋈ ``AiModel``. This module knows only how to DRIVE the
``gliner2`` runtime.

Fail posture — FAIL-CLOSED, and never fabricating: a load or inference failure
RAISES. An empty entity list means "the model ran and found nothing", never
"something went wrong".
"""

from __future__ import annotations

import asyncio
from typing import Any

from nlp.core.logging import get_logger

logger = get_logger(__name__)


def _span_fields(entity: Any) -> tuple[str, int, int, float, str] | None:
    """Normalize one gliner2 entity to ``(label, start, end, score, text)``.

    ``gliner2`` returns mappings when called with ``include_spans=True`` /
    ``include_confidence=True``; older/ONNX runtimes return objects with the
    same attribute names. Both are accepted, and an entity WITHOUT usable
    character offsets is dropped rather than guessed at — redaction slices the
    original string with these numbers, so a wrong offset is worse than a miss
    the caller can see in the count.
    """

    def field(name: str) -> Any:
        if isinstance(entity, dict):
            return entity.get(name)
        return getattr(entity, name, None)

    start, end = field("start"), field("end")
    if not isinstance(start, int) or not isinstance(end, int) or end < start:
        return None
    label = field("label") or field("type") or ""
    score = field("score")
    text = field("text") or ""
    return (
        str(label),
        start,
        end,
        float(score if score is not None else 0.0),
        str(text),
    )


class Gliner2GuardService:
    """A loaded ``gliner2`` runtime with the two calls guardrail delegates.

    Construction is weightless; :meth:`load` pulls the runtime (blocking, so it
    is driven through ``asyncio.to_thread`` by the model-cache factory).
    """

    def __init__(self, weights_source: str, model_id: str) -> None:
        self.model_id = model_id
        self._weights_source = weights_source
        self.runtime: Any = None

    def load(self) -> None:
        """Load the GLiNER2 runtime (blocking; call via ``to_thread``)."""
        from gliner2 import GLiNER2

        logger.info(f"nlp.gliner2_guard.loading model_id={self.model_id}")
        self.runtime = GLiNER2.from_pretrained(self._weights_source)
        logger.info(f"nlp.gliner2_guard.ready model_id={self.model_id}")

    # ── sync cores (thread-pool bound) ───────────────────────────────────

    def _sync_extract(
        self, text: str, labels: list[str], threshold: float
    ) -> list[dict[str, Any]]:
        result = self.runtime.extract_entities(
            text,
            labels,
            threshold=threshold,
            include_confidence=True,
            include_spans=True,
        )
        entities = (
            result.get("entities", result) if isinstance(result, dict) else result
        )
        if isinstance(entities, dict):
            # Some runtimes group by label: {label: [span, ...]}.
            flattened: list[Any] = []
            for label, spans in entities.items():
                for span in spans or []:
                    if isinstance(span, dict):
                        span.setdefault("label", label)
                    flattened.append(span)
            entities = flattened

        normalized: list[dict[str, Any]] = []
        for entity in entities or []:
            fields = _span_fields(entity)
            if fields is None:
                continue
            label, start, end, score, span_text = fields
            normalized.append(
                {
                    "label": label,
                    "start": start,
                    "end": end,
                    "score": score,
                    # Prefer the ACTUAL substring: it is what the caller will
                    # slice, so a runtime that reports a normalized surface form
                    # cannot desynchronize the offsets from the text.
                    "text": text[start:end] or span_text,
                }
            )
        return normalized

    def _sync_classify(
        self, text: str, tasks: dict[str, Any], threshold: float
    ) -> dict[str, Any]:
        return dict(self.runtime.classify_text(text, tasks, threshold=threshold) or {})

    # ── async API ────────────────────────────────────────────────────────

    async def extract_entities(
        self, text: str, labels: list[str], threshold: float
    ) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._sync_extract, text, labels, threshold)

    async def classify_text(
        self, text: str, tasks: dict[str, Any], threshold: float
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync_classify, text, tasks, threshold)
