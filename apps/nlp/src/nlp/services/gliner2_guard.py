"""GLiNER2 guardrail-class inference (TASK-735 Phase 3).

Hosts the owner-specified GLiNER2 safety-plane models — moved here from
`apps/guardrail`, which must hold zero resident weights. Three checkpoints are
in the roster and they differ by CAPABILITY, not by call shape:

* a dedicated **PII span** model (entity extraction only) — the high-volume
  redaction path behind guardrail's ``/guardrail/redact``;
* a **joint PII + safety** model, which can both localise spans and classify;
* a **classification-only** LLM-guardrails model covering six moderation tasks
  (``prompt_safety``, ``prompt_toxicity``, ``jailbreak_detection``,
  ``response_safety``, ``response_toxicity``, ``response_refusal``).

NO id appears here, and none may: each arrives per request, resolved by the
caller from ``AiTaskDefault`` ⋈ ``AiModel`` tenant-first, with the capability
envelope declared on ``AiModel._metadata``. This module knows only how to DRIVE
the ``gliner2`` runtime — it never branches on which checkpoint it holds.
``tests/test_no_hardcoded_model_ids_task778.py`` enforces that.

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
    # The runtime reports `confidence`; `score` is accepted only as a fallback
    # for stubs and older builds. Reading `score` FIRST is what TASK-735 did,
    # and against real weights every span then came back at 0.0 — under any
    # caller threshold, i.e. a detected identifier silently discarded.
    score = field("confidence")
    if score is None:
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

    def __init__(
        self,
        weights_source: str,
        model_id: str,
        device: str = "cpu",
        cpu_only_modules: tuple[str, ...] = (),
    ) -> None:
        self.model_id = model_id
        self._weights_source = weights_source
        # WHERE the tensors execute. Resolved by the caller from configuration
        # (`nlp.core.device`), never chosen here — and never guessed at load
        # time: an unsupported op on MPS aborts the PROCESS rather than raising,
        # so there is no failure to recover from afterwards.
        self._device = device
        self._cpu_only_modules = cpu_only_modules
        self.runtime: Any = None

    @property
    def device(self) -> str:
        return self._device

    def load(self) -> None:
        """Load the GLiNER2 runtime (blocking; call via ``to_thread``)."""
        from gliner2 import GLiNER2

        from nlp.core.device import apply_device_placement

        logger.info(f"nlp.gliner2_guard.loading model_id={self.model_id} device={self._device}")
        # `map_location` would place the weights but NOT relocate the submodules
        # that cannot execute on the accelerator, so the move goes through
        # `apply_device_placement`, which does both as one step.
        self.runtime = GLiNER2.from_pretrained(self._weights_source)
        apply_device_placement(self.runtime, self._device, self._cpu_only_modules)
        logger.info(f"nlp.gliner2_guard.ready model_id={self.model_id} device={self._device}")

    # ── sync cores (thread-pool bound) ───────────────────────────────────

    def _sync_extract(self, text: str, labels: list[str], threshold: float) -> list[dict[str, Any]]:
        result = self.runtime.extract_entities(
            text,
            labels,
            threshold=threshold,
            include_confidence=True,
            include_spans=True,
        )
        return self._normalize_entities(text, result)

    def _sync_batch_extract(
        self, texts: list[str], labels: list[str], threshold: float, batch_size: int
    ) -> list[list[dict[str, Any]]]:
        results = self.runtime.batch_extract_entities(
            texts,
            labels,
            batch_size=batch_size,
            threshold=threshold,
            include_confidence=True,
            include_spans=True,
        )
        if len(results) != len(texts):
            # Never zip a short result onto the inputs: caller A would receive
            # caller B's spans, and these offsets drive redaction.
            raise RuntimeError(f"gliner2 returned {len(results)} results for {len(texts)} texts")
        # Each result is normalised against ITS OWN text, so an offset can never
        # be interpreted against a sibling request's string.
        return [
            self._normalize_entities(text, result)
            for text, result in zip(texts, results, strict=True)
        ]

    def _sync_batch_classify(
        self, texts: list[str], tasks: dict[str, Any], threshold: float, batch_size: int
    ) -> list[dict[str, Any]]:
        results = self.runtime.batch_classify_text(
            texts, tasks, batch_size=batch_size, threshold=threshold
        )
        if len(results) != len(texts):
            raise RuntimeError(f"gliner2 returned {len(results)} results for {len(texts)} texts")
        return [dict(result or {}) for result in results]

    def _normalize_entities(self, text: str, result: Any) -> list[dict[str, Any]]:
        entities = result.get("entities", result) if isinstance(result, dict) else result
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

    def _sync_classify(self, text: str, tasks: dict[str, Any], threshold: float) -> dict[str, Any]:
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

    # ── batch API (TASK-778) ─────────────────────────────────────────────
    #
    # `gliner2` pushes N texts through ONE encoder pass. The fixed per-pass
    # cost — tokeniser dispatch, schema encoding, the Python↔torch boundary — is
    # paid once instead of N times, which is what makes >= 100 concurrent
    # consultation sessions reachable on CPU. The coalescing that decides WHICH
    # texts ride together lives in `nlp.core.batching`; this class only drives
    # the runtime.

    async def batch_extract_entities(
        self, texts: list[str], labels: list[str], threshold: float, batch_size: int = 8
    ) -> list[list[dict[str, Any]]]:
        """One pass over `texts`; result i holds the spans of `texts[i]`."""
        if not texts:
            return []
        return await asyncio.to_thread(
            self._sync_batch_extract, texts, labels, threshold, batch_size
        )

    async def batch_classify_text(
        self,
        texts: list[str],
        tasks: dict[str, Any],
        threshold: float,
        batch_size: int = 8,
    ) -> list[dict[str, Any]]:
        """One pass over `texts`; result i holds the verdicts for `texts[i]`."""
        if not texts:
            return []
        return await asyncio.to_thread(
            self._sync_batch_classify, texts, tasks, threshold, batch_size
        )
