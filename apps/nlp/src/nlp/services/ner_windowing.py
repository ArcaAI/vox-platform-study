"""Server-side NER windowing for ``/classify/tokens`` (TASK-1047 OD-10, FC-8a).

Five callers send whole transcripts and notes to NER. GLiNER2 memory is
quadratic in input length, so a text above ``nlp.inference.maxInputChars`` is
never one pass: it is cut into windows of at most ``windowChars +
windowOverlapChars`` characters, each run through the SAME inference path as a
normal request (one window at a time, each inside the inference semaphore), and
the spans are re-based onto the original text and merged.

Merge rules: identical ``(label, start, end)`` keeps the highest score; spans of
the same label from DIFFERENT windows that overlap keep the longer one (ties by
score); different labels, and overlaps the model itself reported inside one
window, are never merged. Output is sorted by start.
"""

from __future__ import annotations

from typing import Protocol

from nlp.core.bounds import resolve_ner_window
from nlp.core.concurrency import ResizableSemaphore
from nlp.core.logging import get_logger
from nlp.core.metrics import NLP_NER_WINDOWS_TOTAL
from nlp.schemas.classification import (
    TokenClassificationRequest,
    TokenClassificationResponse,
    Vitals,
)
from nlp.schemas.common import Entity, TextPosition

logger = get_logger(__name__)

Window = tuple[int, int]


class _TokenService(Protocol):
    async def process(self, request: TokenClassificationRequest) -> TokenClassificationResponse: ...


def plan_ner_windows(text: str, window_chars: int, overlap_chars: int) -> list[Window]:
    """``[start, end)`` per window; each is at most ``window_chars + overlap_chars`` long.

    A window's nominal end is ``window_chars`` past where the previous one was
    cut; the cut prefers whitespace, searched backward over the last 10% of the
    window (hard cut if none). Every window after the first starts
    ``overlap_chars`` before the previous cut, moved forward past the first
    whitespace in the overlap so it never opens mid-word (a fragment labelled
    differently from the full span would survive the merge).
    """
    n = len(text)
    windows: list[Window] = []
    core = 0
    while True:
        start = max(0, core - overlap_chars)
        if start > 0:
            for i in range(start, core):
                if text[i].isspace():
                    start = i + 1
                    break
        if n - core <= window_chars:
            windows.append((start, n))
            return windows
        nominal = core + window_chars
        cut = nominal
        for i in range(nominal - 1, nominal - window_chars // 10 - 1, -1):
            if text[i].isspace():
                cut = i + 1
                break
        windows.append((start, cut))
        core = cut


def _overlaps(a: Entity, b: Entity) -> bool:
    return a.position.start < b.position.end and b.position.start < a.position.end


def merge_window_entities(
    text: str, windows: list[Window], per_window: list[list[Entity]]
) -> list[Entity]:
    """Re-base each window's spans onto ``text`` and merge the overlap (rules above)."""
    best: dict[tuple[str, int, int], tuple[int, Entity]] = {}
    for k, ((offset, _end), entities) in enumerate(zip(windows, per_window, strict=True)):
        for entity in entities:
            start, end = entity.position.start + offset, entity.position.end + offset
            rebased = entity.model_copy(
                update={"position": TextPosition(start=start, end=end), "text": text[start:end]}
            )
            key = (rebased.entity_type, start, end)
            held = best.get(key)
            if held is None or rebased.confidence > held[1].confidence:
                best[key] = (k, rebased)

    # Two spans from different windows can only overlap inside the region those
    # windows share, so only spans touching a shared region need the pairwise check.
    shared = [(windows[k + 1][0], windows[k][1]) for k in range(len(windows) - 1)]

    def touches_shared(entity: Entity) -> bool:
        return any(entity.position.start < hi and entity.position.end > lo for lo, hi in shared)

    kept = [entity for _k, entity in best.values() if not touches_shared(entity)]
    boundary = sorted(
        (item for item in best.values() if touches_shared(item[1])),
        key=lambda item: (
            -(item[1].position.end - item[1].position.start),
            -item[1].confidence,
            item[1].position.start,
        ),
    )
    accepted: list[tuple[int, Entity]] = []
    for k, entity in boundary:
        if any(
            j != k and other.entity_type == entity.entity_type and _overlaps(other, entity)
            for j, other in accepted
        ):
            continue
        accepted.append((k, entity))
    kept.extend(entity for _k, entity in accepted)
    return sorted(kept, key=lambda e: (e.position.start, e.position.end))


def merge_vitals(per_window: list[Vitals | None]) -> Vitals | None:
    """Field by field, the first window that extracted a value wins."""
    fields: dict[str, object] = {}
    for vitals in per_window:
        if vitals is None:
            continue
        for name, value in vitals.model_dump().items():
            if value is not None and fields.get(name) is None:
                fields[name] = value
    merged = Vitals.model_validate(fields)
    return merged if merged.has_any() else None


async def classify_tokens_windowed(
    service: _TokenService,
    request: TokenClassificationRequest,
    inference_bound: ResizableSemaphore,
) -> TokenClassificationResponse:
    """Run ``request`` window by window through ``service`` and merge the answers.

    Windows run sequentially, each inside ``inference_bound`` — never one giant
    tensor and never every window at once. The response shape is the
    single-pass one.
    """
    text = request.text
    window_chars, overlap_chars = resolve_ner_window()
    windows = plan_ner_windows(text, window_chars, overlap_chars)
    responses: list[TokenClassificationResponse] = []
    for start, end in windows:
        window_request = request.model_copy(update={"text": text[start:end]})
        async with inference_bound:
            responses.append(await service.process(window_request))
        NLP_NER_WINDOWS_TOTAL.inc()
    logger.info("nlp.classify.tokens_windowed", windows=len(windows), chars=len(text))
    first = responses[0]
    return TokenClassificationResponse(
        entities=merge_window_entities(text, windows, [r.entities for r in responses]),
        model_version=first.model_version,
        vitals=merge_vitals([r.vitals for r in responses]),
        inference_ms=sum(r.inference_ms for r in responses),
        device=first.device,
    )
