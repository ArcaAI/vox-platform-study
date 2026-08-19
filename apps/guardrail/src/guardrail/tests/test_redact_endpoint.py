"""TDD tests for ``POST /guardrail/redact`` — the tenant-facing PHI redactor.

Hermetic: the app is built with ``create_app()`` and driven over an ASGI transport
WITHOUT entering the lifespan (no Redis / real ONNX weights). A fake GLiNER
analyzer stub is injected through `get_safety_analyzer` (same pattern as
``test_aux_model_selection.py``) so the endpoint's PII-extraction seam is
exercised without loading real weights.

Fail posture — FAIL-CLOSED, the deliberate inverse of ``/guardrail/analyze``: a
missing DB model selection is 503; an extraction-time error is a non-200
(never a 200 echoing the raw input back as `sanitized_text`).

RED: written before the endpoint exists (POST /api/guardrail/redact → 404/405).
"""

from __future__ import annotations

from collections import namedtuple
from typing import Any

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from guardrail.core.dependencies import get_safety_analyzer
from guardrail.core.effective_config import EffectiveConfigSnapshot
from guardrail.main import create_app

REDACT_PATH = "/api/guardrail/redact"

FakeEntity = namedtuple("FakeEntity", ["text", "label", "start", "end", "score"])

TEXT = (
    "Patient John Doe was seen for hypertension and started lisinopril 10mg. "
    "Contact John Doe at john.doe@example.com with questions."
)


def _entity(
    source: str, label: str, needle: str, score: float = 0.95, occurrence: int = 0
) -> FakeEntity:
    idx = -1
    for _ in range(occurrence + 1):
        idx = source.index(needle, idx + 1)
    return FakeEntity(
        text=needle, label=label, start=idx, end=idx + len(needle), score=score
    )


PERSON_1 = _entity(TEXT, "person", "John Doe", occurrence=0)
PERSON_2 = _entity(TEXT, "person", "John Doe", occurrence=1)
EMAIL = _entity(TEXT, "email", "john.doe@example.com")
DEFAULT_ENTITIES = [PERSON_1, PERSON_2, EMAIL]


class FakeGlinerRedactor:
    """Stand-in GLiNER provider — no ONNX weights, deterministic entities."""

    def __init__(self, entities: list[FakeEntity] | Exception) -> None:
        self._entities = entities

    async def extract_pii_entities(self, text: str) -> list[FakeEntity]:
        if isinstance(self._entities, Exception):
            raise self._entities
        return self._entities


class ScanningGlinerRedactor:
    """Fake that scans whatever text it is handed for `needle`, reporting LOCAL offsets.

    Unlike :class:`FakeGlinerRedactor` (fixed entities, offsets pre-computed
    against the whole document) this one behaves the way the real GLiNER does
    under chunking: it only ever sees one chunk and its offsets index THAT
    chunk. It is therefore the fixture that proves the endpoint re-bases
    per-chunk offsets back onto the submitted document. Records every chunk it
    was handed so tests can assert the split itself.
    """

    def __init__(self, needle: str, label: str = "person") -> None:
        self._needle = needle
        self._label = label
        self.seen_chunks: list[str] = []

    async def extract_pii_entities(self, text: str) -> list[FakeEntity]:
        self.seen_chunks.append(text)
        found: list[FakeEntity] = []
        idx = text.find(self._needle)
        while idx != -1:
            found.append(
                FakeEntity(
                    text=self._needle,
                    label=self._label,
                    start=idx,
                    end=idx + len(self._needle),
                    score=0.95,
                )
            )
            idx = text.find(self._needle, idx + len(self._needle))
        return found


class FakeEffectiveConfigClient:
    """Control-plane stub serving ONLY the `redaction` group.

    The chunk size is a DB-tier (`global-kv`) knob a platform admin manages —
    it reaches guardrail through `GET /internal/effective-config`, never an env
    var — so the test seam is the pull client, matching how retention is
    already served.
    """

    def __init__(self, chunk_chars: int | None) -> None:
        self._chunk_chars = chunk_chars

    async def get(self) -> EffectiveConfigSnapshot:
        raw = (
            {"redaction": {"chunkChars": self._chunk_chars}}
            if self._chunk_chars
            else {}
        )
        return EffectiveConfigSnapshot(raw=raw, ok=True)


def _app(
    *,
    entities: list[FakeEntity] | Exception = DEFAULT_ENTITIES,
    token: str = "",
    db_config_enabled: bool = False,
    provider: Any = None,
    chunk_chars: int | None = None,
) -> FastAPI:
    app = create_app()
    from pydantic import SecretStr

    app.state.settings.service_token = SecretStr(token)
    # Pin the SHARED token too: the middleware accepts EITHER it or the legacy
    # per-service token (`Settings.accepted_service_tokens`), and both are populated from
    # the environment — so setting only `service_token` left whatever `INTERNAL_ACCESS_TOKEN`
    # the loaded `.env.test` carried silently in play, and `token=""` (auth off) still 401'd.
    app.state.settings.internal_access_token = SecretStr(token)
    app.state.settings.db.db_config_enabled = db_config_enabled
    if chunk_chars is not None:
        app.state.effective_config_client = FakeEffectiveConfigClient(chunk_chars)

    if not db_config_enabled:
        # TASK-735 Phase 3 — the models run in `apps/nlp`; the analyzer is the
        # seam the endpoint now depends on, so tests inject it there instead of
        # seeding a local model cache (guardrail has none).
        stub = provider if provider is not None else FakeGlinerRedactor(entities)
        app.dependency_overrides[get_safety_analyzer] = lambda: stub
    return app


# `X-Tenant-Id` is mandatory on every tenant-scoped route (428 otherwise), so the
# helper supplies one by default; tests about the header pass their own.
TEST_TENANT = "11111111-1111-1111-1111-111111111111"


async def _post(
    app: FastAPI, body: dict[str, Any], headers: dict[str, str] | None = None
) -> Any:
    transport = ASGITransport(app=app)
    merged = {"X-Tenant-Id": TEST_TENANT, **(headers or {})}
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post(REDACT_PATH, json=body, headers=merged)


# ── Contract: entities + sanitized_text ──


async def test_full_mode_masks_every_flagged_span_generically() -> None:
    resp = await _post(_app(), {"text": TEXT, "mode": "full"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "full"
    assert "John Doe" not in body["sanitized_text"]
    assert "john.doe@example.com" not in body["sanitized_text"]
    # Clinical terms GLiNER never flagged survive verbatim.
    assert "hypertension" in body["sanitized_text"]
    assert "lisinopril" in body["sanitized_text"]
    # Generic marker only — no label leaks in `full` mode.
    assert body["sanitized_text"].count("[REDACTED]") == 3
    assert len(body["entities"]) == 3
    for entity, expected in zip(body["entities"], DEFAULT_ENTITIES, strict=True):
        assert entity["label"] == expected.label
        assert entity["start"] == expected.start
        assert entity["end"] == expected.end
        assert TEXT[entity["start"] : entity["end"]] == expected.text


async def test_pseudonymize_mode_preserves_clinical_terms_and_masks_identifiers() -> (
    None
):
    resp = await _post(_app(), {"text": TEXT, "mode": "pseudonymize"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "pseudonymize"
    sanitized = body["sanitized_text"]
    assert "John Doe" not in sanitized
    assert "john.doe@example.com" not in sanitized
    # Clinical terms are preserved verbatim under pseudonymize too.
    assert "hypertension" in sanitized
    assert "lisinopril 10mg" in sanitized
    # Both occurrences of the identical identifier collapse onto the SAME
    # stable token (co-reference survives for downstream NER).
    assert sanitized.count("[PERSON_1]") == 2
    assert "[EMAIL_1]" in sanitized


async def test_empty_text_returns_no_entities_and_identity_sanitized_text() -> None:
    resp = await _post(_app(entities=[]), {"text": "", "mode": "full"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["entities"] == []
    assert body["sanitized_text"] == ""


async def test_text_with_no_pii_is_returned_unchanged() -> None:
    resp = await _post(
        _app(entities=[]),
        {"text": "Patient reports hypertension.", "mode": "pseudonymize"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["entities"] == []
    assert body["sanitized_text"] == "Patient reports hypertension."


# ── X-Service-Token posture (the global middleware covers this route) ──


async def test_redact_is_behind_service_token() -> None:
    token = "test-service-token-redact-abc123"  # noqa: S105 — test constant
    app = _app(token=token)
    body = {"text": TEXT, "mode": "full"}

    rejected = await _post(app, body)
    assert rejected.status_code == 401

    accepted = await _post(app, body, headers={"X-Service-Token": token})
    assert accepted.status_code == 200


# ── Fail-closed posture: never a 200 with unredacted text on error ──


async def test_redact_fails_closed_502_when_extraction_errors() -> None:
    app = _app(entities=RuntimeError("onnx runtime crashed"))

    resp = await _post(app, {"text": TEXT, "mode": "full"})

    assert resp.status_code != 200
    # The raw input must never leak back out on an error path.
    body_text = resp.text
    assert "John Doe" not in body_text


async def test_redact_fails_closed_503_when_model_selection_missing() -> None:
    app = _app(db_config_enabled=True)  # DB-on, but no tenant_config_resolver wired

    resp = await _post(app, {"text": TEXT, "mode": "full"})

    assert resp.status_code == 503


async def test_redact_rejects_unknown_mode() -> None:
    resp = await _post(_app(), {"text": TEXT, "mode": "anonymize"})

    assert resp.status_code == 422


# ── Bounded-input chunking (GLiNER cost is super-linear in input length) ──
#
# Measured in TASK-710 §7 Task 6: 20,000 chars → 3.6s / 5.2GB peak RSS but
# 50,000 chars → 17.5s / 17.8GB. A single `extract_entities` call over a
# 100,000-char DNA corpus would exceed both the caller's HTTP timeout and a
# worker container's memory limit. The endpoint therefore splits the input into
# bounded chunks and re-bases each chunk's offsets onto the submitted document.

PARAGRAPH = "Patient John Doe reports a headache and was prescribed lisinopril.\n\n"
LONG_TEXT = PARAGRAPH * 20  # ~1,340 chars — well over the 200-char test chunk


async def test_long_input_is_split_into_bounded_chunks() -> None:
    provider = ScanningGlinerRedactor("John Doe")

    resp = await _post(
        _app(provider=provider, chunk_chars=200), {"text": LONG_TEXT, "mode": "full"}
    )

    assert resp.status_code == 200
    # More than one extraction call, and no single call exceeded the budget —
    # this is the whole point: peak memory is bounded by the chunk, not by the
    # document.
    assert len(provider.seen_chunks) > 1
    assert all(len(chunk) <= 200 for chunk in provider.seen_chunks)
    # Chunking is a pure partition: nothing dropped, nothing duplicated.
    assert "".join(provider.seen_chunks) == LONG_TEXT


async def test_chunked_entity_offsets_index_the_submitted_document() -> None:
    provider = ScanningGlinerRedactor("John Doe")

    resp = await _post(
        _app(provider=provider, chunk_chars=200), {"text": LONG_TEXT, "mode": "full"}
    )

    body = resp.json()
    assert len(provider.seen_chunks) > 1, "fixture must actually be chunked"
    expected_occurrences = LONG_TEXT.count("John Doe")
    assert len(body["entities"]) == expected_occurrences
    # Every returned offset must address the ORIGINAL text, not its chunk.
    for entity in body["entities"]:
        assert LONG_TEXT[entity["start"] : entity["end"]] == "John Doe"
    # Offsets are returned in document order.
    starts = [e["start"] for e in body["entities"]]
    assert starts == sorted(starts)
    assert "John Doe" not in body["sanitized_text"]
    assert body["sanitized_text"].count("[REDACTED]") == expected_occurrences
    assert "lisinopril" in body["sanitized_text"]


async def test_chunk_boundaries_never_split_a_word() -> None:
    """A cut mid-identifier would hide PII from BOTH chunks — the one way
    chunking could silently weaken redaction. Splits land on whitespace."""
    provider = ScanningGlinerRedactor("John Doe")

    await _post(
        _app(provider=provider, chunk_chars=200), {"text": LONG_TEXT, "mode": "full"}
    )

    # Every seam (end of chunk N / start of chunk N+1) falls on whitespace.
    assert len(provider.seen_chunks) > 1, "fixture must actually be chunked"
    for chunk in provider.seen_chunks[:-1]:
        assert chunk[-1].isspace(), f"chunk ended mid-token: {chunk[-30:]!r}"


async def test_pseudonymize_tokens_stay_stable_across_chunk_boundaries() -> None:
    """Token assignment happens AFTER the per-chunk spans are merged, so the
    same identifier in two different chunks still collapses onto one token."""
    provider = ScanningGlinerRedactor("John Doe")

    resp = await _post(
        _app(provider=provider, chunk_chars=200),
        {"text": LONG_TEXT, "mode": "pseudonymize"},
    )

    sanitized = resp.json()["sanitized_text"]
    assert len(provider.seen_chunks) > 1
    assert sanitized.count("[PERSON_1]") == LONG_TEXT.count("John Doe")
    assert "[PERSON_2]" not in sanitized


async def test_short_input_is_a_single_unchunked_call() -> None:
    """Below the budget the behaviour is byte-identical to the pre-chunking
    endpoint — one call, whole document, offsets already global."""
    provider = ScanningGlinerRedactor("John Doe")

    resp = await _post(
        _app(provider=provider, chunk_chars=200), {"text": TEXT, "mode": "full"}
    )

    assert resp.status_code == 200
    assert provider.seen_chunks == [TEXT]


async def test_chunk_size_falls_back_to_the_code_default_when_control_plane_is_silent() -> (
    None
):
    """No client / no opinion ⇒ the built-in budget applies. A control-plane
    miss must never mean "unbounded"."""
    provider = ScanningGlinerRedactor("John Doe")

    resp = await _post(_app(provider=provider), {"text": LONG_TEXT, "mode": "full"})

    assert resp.status_code == 200
    # LONG_TEXT is far below the default budget, so it stays a single call.
    assert provider.seen_chunks == [LONG_TEXT]
