"""A deterministic NLP 4xx must not be retried by the activity layer."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from temporalio.exceptions import ApplicationError

from harness.services.nlp_client import NlpClient, NlpServiceError
from harness.temporal import activities

SECRET_TEXT = "Patient John Doe has chest pain"


class _Api:
    async def resolve_task_model(self, task_key: str, *, tenant_id: str) -> dict[str, Any]:
        return {"sourceUri": "model-x"}


def _patch(monkeypatch: pytest.MonkeyPatch, handler: Any) -> None:
    client = NlpClient("http://nlp", transport=httpx.MockTransport(handler))
    monkeypatch.setattr(activities, "_api_client", lambda settings: _Api())
    monkeypatch.setattr(activities, "_nlp_client", lambda settings: client)


async def _run() -> Any:
    return await activities._extract_clinical_entities(object(), SECRET_TEXT, tenant_id="t1")  # type: ignore[arg-type]


@pytest.mark.parametrize("status", [400, 413, 422])
async def test_4xx_is_non_retryable(monkeypatch: pytest.MonkeyPatch, status: int) -> None:
    _patch(monkeypatch, lambda req: httpx.Response(status, json={"detail": SECRET_TEXT}))
    with pytest.raises(ApplicationError) as ei:
        await _run()
    err = ei.value
    assert err.non_retryable is True
    assert err.type == "NlpClientError"
    assert str(status) in str(err)
    assert "John" not in str(err) and "chest" not in str(err)


@pytest.mark.parametrize("status", [408, 429, 500, 503])
async def test_retryable_statuses_stay_retryable(
    monkeypatch: pytest.MonkeyPatch, status: int
) -> None:
    _patch(monkeypatch, lambda req: httpx.Response(status, json={}))
    with pytest.raises(NlpServiceError) as ei:
        await _run()
    assert ei.value.status_code == status


async def test_timeout_stays_retryable(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=req)

    _patch(monkeypatch, handler)
    with pytest.raises(NlpServiceError) as ei:
        await _run()
    assert ei.value.status_code is None
