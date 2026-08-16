"""TDD tests for ``POST /guardrail/redact`` — the tenant-facing PHI redactor.

Hermetic: the app is built with ``create_app()`` and driven over an ASGI transport
WITHOUT entering the lifespan (no Redis / real ONNX weights). A fake GLiNER
provider is pre-seeded onto ``app.state.gliner_cache`` (same pattern as
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

from guardrail.main import create_app
from guardrail.services.model_cache import ModelCache

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
    return FakeEntity(text=needle, label=label, start=idx, end=idx + len(needle), score=score)


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


def _app(
    *,
    entities: list[FakeEntity] | Exception = DEFAULT_ENTITIES,
    token: str = "",
    db_config_enabled: bool = False,
) -> FastAPI:
    app = create_app()
    from pydantic import SecretStr

    app.state.settings.service_token = SecretStr(token)
    app.state.settings.db.db_config_enabled = db_config_enabled

    async def factory(model_id: str) -> FakeGlinerRedactor:
        return FakeGlinerRedactor(entities)

    app.state.gliner_cache = ModelCache(factory=factory, ttl_seconds=60, max_size=2)
    return app


async def _post(app: FastAPI, body: dict[str, Any], headers: dict[str, str] | None = None) -> Any:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post(REDACT_PATH, json=body, headers=headers)


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


async def test_pseudonymize_mode_preserves_clinical_terms_and_masks_identifiers() -> None:
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
        _app(entities=[]), {"text": "Patient reports hypertension.", "mode": "pseudonymize"}
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
