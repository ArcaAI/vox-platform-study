"""TASK-1035 — the inbound screen returns PII spans for `apps/text`'s egress pipeline.

`POST /guardrail/screen/inbound` gains `include_pii_spans`. When set, guardrail runs
the PII span extraction (`apps/nlp /guard/pii`, selection `guardrail.pii.spans`)
CONCURRENTLY with the safety classification and returns `pii_spans` in document
coordinates, so text can pseudonymize a cloud-bound prompt from ONE round trip.

Long text is chunked, and the chunks are extracted in PARALLEL with offsets re-based
onto the submitted document (§3.2 performance budget).
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from guardrail.api.endpoints.screen import InboundScreenRequest, screen_inbound
from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.services.pii_extraction import extract_spans, split_for_extraction
from guardrail.services.screening import Screener

TENANT = "11111111-1111-1111-1111-111111111111"
SYSTEM = "00000000-0000-0000-0000-000000000000"


@dataclass(frozen=True)
class _Span:
    label: str
    start: int
    end: int
    score: float = 0.9


class _SlowAnalyzer:
    """Safety classification that takes `delay` seconds."""

    def __init__(self, delay: float = 0.0) -> None:
        self._delay = delay
        self.policy = SimpleNamespace(pii_labels=[], benign_labels=None)

    async def classify_tasks(self, task_names, text):
        await asyncio.sleep(self._delay)
        return dict.fromkeys(task_names, "benign")

    async def extract_pii_entities(self, text):  # pragma: no cover - not the span lane
        return []

    def model_for(self, check):
        return "stub-safety-model"


class _NeedleSpanClient:
    """Finds every occurrence of `needle` in whatever text it is handed."""

    def __init__(self, needle: str, label: str = "person", delay: float = 0.0) -> None:
        self.needle = needle
        self.label = label
        self.delay = delay
        self.calls: list[str] = []
        self.raises = False

    async def extract_pii_entities(self, text: str) -> list[_Span]:
        self.calls.append(text)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.raises:
            raise GuardrailUndeterminedError("engine_error", "nlp down")
        spans: list[_Span] = []
        start = text.find(self.needle)
        while start != -1:
            spans.append(_Span(self.label, start, start + len(self.needle)))
            start = text.find(self.needle, start + 1)
        return spans


class _FakeRequest:
    def __init__(self, state: SimpleNamespace) -> None:
        self.app = SimpleNamespace(state=state)
        self.headers = {"X-Tenant-Id": TENANT}


@pytest.fixture
def wire(monkeypatch):
    """Bind the screener and the span client to stubs held on `app.state`."""
    import guardrail.api.endpoints.screen as screen_mod

    built: list[str] = []

    async def _build_screener(app_state, tenant_id):
        return Screener(
            analyzer=app_state.analyzer, tenant_id=tenant_id, policy_source_tenant_id=SYSTEM
        )

    async def _build_span_client(app_state, tenant_id):
        built.append(tenant_id)
        return app_state.span_client

    monkeypatch.setattr(screen_mod, "build_screener", _build_screener)
    monkeypatch.setattr(screen_mod, "build_pii_span_client", _build_span_client)
    return built


def _state(analyzer, span_client) -> SimpleNamespace:
    return SimpleNamespace(analyzer=analyzer, span_client=span_client, admission_gates={})


async def test_spans_are_returned_with_document_offsets_and_text(wire) -> None:
    text = "Seen today: John Doe, 54, chest pain. John Doe denies fever."
    request = _FakeRequest(_state(_SlowAnalyzer(), _NeedleSpanClient("John Doe")))

    result = await screen_inbound(
        InboundScreenRequest(text=text, include_pii_spans=True), request  # type: ignore[arg-type]
    )

    assert result.decision == "allow"
    assert result.pii_spans is not None and len(result.pii_spans) == 2
    for span in result.pii_spans:
        assert text[span.start : span.end] == "John Doe"
        assert span.text == "John Doe"
        assert span.label == "person"
    assert wire == [TENANT]


async def test_spans_are_not_extracted_unless_asked(wire) -> None:
    request = _FakeRequest(_state(_SlowAnalyzer(), _NeedleSpanClient("John")))

    result = await screen_inbound(
        InboundScreenRequest(text="John has a cough."), request  # type: ignore[arg-type]
    )

    assert result.pii_spans is None
    assert wire == []


async def test_span_extraction_runs_concurrently_with_classification(wire) -> None:
    request = _FakeRequest(
        _state(_SlowAnalyzer(delay=0.3), _NeedleSpanClient("John", delay=0.3))
    )

    started = time.monotonic()
    await screen_inbound(
        InboundScreenRequest(text="John has a cough.", include_pii_spans=True),
        request,  # type: ignore[arg-type]
    )
    elapsed = time.monotonic() - started

    # Sequential would be >= 0.6 s.
    assert elapsed < 0.5


async def test_a_failed_span_extraction_fails_closed_with_503(wire) -> None:
    client = _NeedleSpanClient("John")
    client.raises = True
    request = _FakeRequest(_state(_SlowAnalyzer(), client))

    with pytest.raises(HTTPException) as exc:
        await screen_inbound(
            InboundScreenRequest(text="John has a cough.", include_pii_spans=True),
            request,  # type: ignore[arg-type]
        )
    assert exc.value.status_code == 503


async def test_chunks_are_extracted_in_parallel_with_rebased_offsets() -> None:
    paragraph = "Patient John Doe reports a headache.\n\n"
    text = paragraph * 8
    client = _NeedleSpanClient("John Doe", delay=0.2)

    chunks = split_for_extraction(text, 100)
    assert len(chunks) >= 4

    started = time.monotonic()
    spans = await extract_spans(client.extract_pii_entities, text, 100)
    elapsed = time.monotonic() - started

    # Sequential would be len(chunks) x 0.2 s.
    assert elapsed < 0.2 * 2
    assert len(spans) == 8
    assert all(text[s.start : s.end] == "John Doe" for s in spans)
    assert [s.start for s in spans] == sorted(s.start for s in spans)
