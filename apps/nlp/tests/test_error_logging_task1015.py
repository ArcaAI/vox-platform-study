"""E6 / E8 (nlp) — a failed token classification is loud and never an empty success;
the classify handlers log stable dotted events with ``error_type`` and no ``str(exc)``."""

from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
from fastapi import HTTPException, Request
from structlog.testing import capture_logs

from nlp.api.v1.rest import classify as classify_module
from nlp.core.config import TokenClassificationConfig
from nlp.schemas.classification import TokenClassificationRequest
from nlp.services.token_classifier import TransformerTokenClassifier

SECRET = "patient-MRN-99887 has chest pain"


class _NoopBound:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *exc: object) -> None:
        return None


def _http_request() -> Request:
    """The handler reads ``X-Tenant-Id`` off the request (TASK-1049 F10 NER cache)."""
    tenant = b"11111111-1111-1111-1111-111111111111"
    return Request({"type": "http", "headers": [(b"x-tenant-id", tenant)]})


def _boom(text: str, **kwargs: object) -> list[dict]:
    raise RuntimeError(f"tensor blew up on {SECRET}")


async def test_token_classifier_failure_raises_and_logs_instead_of_empty_success() -> None:
    classifier = TransformerTokenClassifier(
        configs=TokenClassificationConfig(model_name="test-org/ner", tokenizer_name="test-org/ner")
    )
    classifier.pipeline = _boom
    classifier.is_initialized = True

    with capture_logs() as logs:
        with pytest.raises(RuntimeError):
            await classifier.process(TokenClassificationRequest(text=SECRET))

    (line,) = [entry for entry in logs if entry["event"] == "nlp.token_classification_failed"]
    assert line["log_level"] == "error"
    assert line["error_type"] == "RuntimeError"
    assert "exc_info" in line


async def test_classify_tokens_handler_logs_stable_event_and_returns_generic_500(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Service:
        is_initialized = True

        async def process(self, request: object) -> None:
            raise RuntimeError(f"tensor blew up on {SECRET}")

    @asynccontextmanager
    async def _pinned(model_name: str, model_path: str | None):
        yield _Service()

    monkeypatch.setattr(classify_module, "pinned_token_classifier", _pinned)

    with capture_logs() as logs:
        with pytest.raises(HTTPException) as info:
            await classify_module.classify_tokens(
                TokenClassificationRequest(text=SECRET, model_name="m"),
                http_request=_http_request(),
                inference_bound=_NoopBound(),  # type: ignore[arg-type]
            )

    assert info.value.status_code == 500
    assert SECRET not in str(info.value.detail)
    (line,) = [entry for entry in logs if entry["event"] == "nlp.classify.tokens_failed"]
    assert line["log_level"] == "error"
    assert line["error_type"] == "RuntimeError"
    assert "exc_info" in line
    assert SECRET not in str({k: v for k, v in line.items() if k != "exc_info"})


async def test_classify_tokens_model_unavailable_is_logged_at_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from nlp.services.model_cache import ModelUnavailableError

    @asynccontextmanager
    async def _pinned(model_name: str, model_path: str | None):
        raise ModelUnavailableError("nope")
        yield  # pragma: no cover

    monkeypatch.setattr(classify_module, "pinned_token_classifier", _pinned)

    with capture_logs() as logs:
        with pytest.raises(HTTPException) as info:
            await classify_module.classify_tokens(
                TokenClassificationRequest(text="x", model_name="m"),
                http_request=_http_request(),
                inference_bound=_NoopBound(),  # type: ignore[arg-type]
            )

    assert info.value.status_code == 503
    (line,) = [entry for entry in logs if entry["event"] == "nlp.classify.tokens_model_unavailable"]
    assert line["log_level"] == "error"
    assert line["error_type"] == "ModelUnavailableError"
