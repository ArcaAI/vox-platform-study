"""A job whose worker died must RECOVER, not merely end.

TASK-991 W2-4, measured live: a worker restart redelivered an in-flight message,
the gateway refused the new claim with ``500 "Cannot start job in PROCESSING
status"``, and the client substring-matched that prose to decide the job was
TERMINAL. It was not — PROCESSING is a claim, not an outcome — so the worker acked
the delivery and returned, the row stayed PROCESSING forever, and the caller waited
out its entire timeout against a job that nothing owned.

.. note:: SUPERSEDED BY TASK-992, and this file was rewritten with it.

   W2-4 fixed the classification by reading the job's status back over a second
   HTTP call, and ended a PROCESSING job **FAILED** on the reasoning that
   "nothing can resume it: the previous attempt's audio, models and partial
   results went with its process."

   That reasoning was wrong. The audio lives in object storage and
   ``transcribe_file`` re-downloads it from ``audio_uri`` on **every** delivery,
   after the claim — so the redelivered worker has everything it needs and the
   transcription was being thrown away. Seeing only a status, that design also
   could not tell ANOTHER worker's claim from this worker's own, so a retried
   ``/start`` could end a job that was running perfectly well.

   Under TASK-992 the gateway RECLAIMS such a row for the new worker and answers
   200, and classifies a genuine refusal structurally
   (``DOMAIN.INVALID_STATE_TRANSITION`` + ``metadata.terminal``) in the refusal
   body itself — no second request, and no terminal-status list maintained on
   this side. ``JobNotResumableError`` is gone with it.

Every scenario W2-4 pinned is still pinned here; the PROCESSING verdict is
inverted, which is the point. The wire-level classification matrix lives in
``test_gateway_job_claim_task992.py``.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from stt.core.api_client.gateway import (
    STATE_TRANSITION_CODE,
    TERMINAL_JOB_STATUSES,
    APIGatewayClient,
)
from stt.core.exceptions import APIGatewayError, JobConflictError, JobTerminalError

pytestmark = pytest.mark.unit

TENANT = "50000000-0000-0000-0000-000000000001"
JOB = "01a0b95a-0000-0000-0000-000000000000"


def _client_refusing_start(status: str, *, terminal: bool, structured: bool = True) -> APIGatewayClient:
    """A client whose /start is refused with the body a gateway would send."""
    client = APIGatewayClient(base_url="http://gateway.invalid/api/v1", api_key="k")

    if structured:
        body: dict[str, Any] = {
            "statusCode": 409,
            "code": STATE_TRANSITION_CODE,
            "message": f"Cannot start job in {status} status",
            "metadata": {
                "entity": "TranscriptionJob",
                "entityId": JOB,
                "currentStatus": status,
                "attempted": "startProcessing",
                "terminal": terminal,
            },
        }
        code = 409
    else:
        # The pre-TASK-992 body: prose and nothing else.
        body = {"statusCode": 500, "code": "DOMAIN.BUSINESS", "message": f"Cannot start job in {status} status"}
        code = 500

    _encoded = json.dumps(body).encode()

    async def _request(
        method: str,
        path: str,
        json: dict[str, Any] | None = None,  # noqa: A002 — mirrors the real `_request` signature
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        if not path.endswith("/start"):
            raise AssertionError(
                f"unexpected call to {path} — TASK-992 classifies from the refusal body, "
                "so a refused claim must cost exactly ONE request"
            )
        request = httpx.Request("PATCH", f"http://gateway.invalid{path}")
        response = httpx.Response(code, request=request, content=_encoded)
        error = APIGatewayError(f"API Gateway request failed: {code}", details={"status_code": code, "path": path})
        error.__cause__ = httpx.HTTPStatusError("boom", request=request, response=response)
        raise error

    client._request = _request  # type: ignore[method-assign]
    return client


class TestTerminalSetMatchesTheDomain:
    def test_processing_is_not_a_terminal_status(self) -> None:
        assert "PROCESSING" not in TERMINAL_JOB_STATUSES

    def test_mirrors_transcription_job_entity_is_terminal(self) -> None:
        assert TERMINAL_JOB_STATUSES == frozenset({"COMPLETED", "FAILED", "CANCELLED", "DEAD"})


class TestStartJobClassifiesFromTheRefusalBody:
    @pytest.mark.asyncio
    async def test_a_processing_job_is_a_conflict_not_terminal(self) -> None:
        """The inverted verdict. Was `JobNotResumableError` → fail the job."""
        client = _client_refusing_start("PROCESSING", terminal=False)
        with pytest.raises(JobConflictError):
            await client.start_job(JOB, "host-b-2", tenant_id=TENANT)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", sorted(TERMINAL_JOB_STATUSES - {"FAILED"}))
    async def test_a_finished_job_is_still_terminal(self, status: str) -> None:
        client = _client_refusing_start(status, terminal=True)
        with pytest.raises(JobTerminalError):
            await client.start_job(JOB, "host-b-2", tenant_id=TENANT)

    @pytest.mark.asyncio
    async def test_the_verdict_does_not_read_the_error_message(self) -> None:
        """A body whose prose disagrees with its metadata follows the METADATA."""
        client = APIGatewayClient(base_url="http://gateway.invalid/api/v1", api_key="k")

        async def _request(*_a: Any, **_kw: Any) -> dict[str, Any]:
            body = {
                "statusCode": 409,
                "code": STATE_TRANSITION_CODE,
                # Prose says COMPLETED; metadata says it is not terminal.
                "message": "Cannot start job in COMPLETED status",
                "metadata": {"currentStatus": "PROCESSING", "terminal": False},
            }
            request = httpx.Request("PATCH", "http://gateway.invalid/x")
            response = httpx.Response(409, request=request, content=json.dumps(body).encode())
            error = APIGatewayError("refused", details={"status_code": 409})
            error.__cause__ = httpx.HTTPStatusError("boom", request=request, response=response)
            raise error

        client._request = _request  # type: ignore[method-assign]
        with pytest.raises(JobConflictError):
            await client.start_job(JOB, "host-b-2", tenant_id=TENANT)

    @pytest.mark.asyncio
    async def test_a_refusal_this_cannot_classify_stays_a_retryable_transport_error(self) -> None:
        client = APIGatewayClient(base_url="http://gateway.invalid/api/v1", api_key="k")

        async def _request(*_a: Any, **_kw: Any) -> dict[str, Any]:
            body = {"statusCode": 401, "code": "UNAUTHORIZED", "message": "Invalid internal service key"}
            request = httpx.Request("PATCH", "http://gateway.invalid/x")
            response = httpx.Response(401, request=request, content=json.dumps(body).encode())
            error = APIGatewayError("refused", details={"status_code": 401})
            error.__cause__ = httpx.HTTPStatusError("boom", request=request, response=response)
            raise error

        client._request = _request  # type: ignore[method-assign]
        with pytest.raises(APIGatewayError) as excinfo:
            await client.start_job(JOB, "host-b-2", tenant_id=TENANT)
        assert not isinstance(excinfo.value, (JobTerminalError, JobConflictError))

    @pytest.mark.asyncio
    async def test_an_unreadable_body_is_not_read_as_an_outcome(self) -> None:
        """"Could not tell" must never resolve the job's fate — it retries."""
        client = APIGatewayClient(base_url="http://gateway.invalid/api/v1", api_key="k")

        async def _request(*_a: Any, **_kw: Any) -> dict[str, Any]:
            request = httpx.Request("PATCH", "http://gateway.invalid/x")
            response = httpx.Response(502, request=request, content=b"<html>bad gateway</html>")
            error = APIGatewayError("refused", details={"status_code": 502})
            error.__cause__ = httpx.HTTPStatusError("boom", request=request, response=response)
            raise error

        client._request = _request  # type: ignore[method-assign]
        with pytest.raises(APIGatewayError) as excinfo:
            await client.start_job(JOB, "host-b-2", tenant_id=TENANT)
        assert not isinstance(excinfo.value, (JobTerminalError, JobConflictError))

    @pytest.mark.asyncio
    async def test_a_refused_claim_costs_exactly_one_request(self) -> None:
        """W2-4 spent a second round trip reading the status back; this does not."""
        calls: list[str] = []
        client = APIGatewayClient(base_url="http://gateway.invalid/api/v1", api_key="k")

        async def _request(method: str, path: str, *_a: Any, **_kw: Any) -> dict[str, Any]:
            calls.append(path)
            body = {"statusCode": 409, "code": STATE_TRANSITION_CODE, "metadata": {"currentStatus": "DEAD", "terminal": True}}
            request = httpx.Request("PATCH", f"http://gateway.invalid{path}")
            response = httpx.Response(409, request=request, content=json.dumps(body).encode())
            error = APIGatewayError("refused", details={"status_code": 409})
            error.__cause__ = httpx.HTTPStatusError("boom", request=request, response=response)
            raise error

        client._request = _request  # type: ignore[method-assign]
        with pytest.raises(JobTerminalError):
            await client.start_job(JOB, "host-b-2", tenant_id=TENANT)
        assert len(calls) == 1

    @pytest.mark.asyncio
    async def test_a_successful_start_is_untouched(self) -> None:
        client = APIGatewayClient(base_url="http://gateway.invalid/api/v1", api_key="k")

        async def _request(*_a: Any, **_kw: Any) -> dict[str, Any]:
            return {"status": "PROCESSING", "workerId": "host-b-2"}

        client._request = _request  # type: ignore[method-assign]
        assert await client.start_job(JOB, "host-b-2", tenant_id=TENANT) == {
            "status": "PROCESSING",
            "workerId": "host-b-2",
        }

    @pytest.mark.asyncio
    async def test_the_reclaim_is_the_ordinary_outcome(self) -> None:
        """What the live incident now produces: the redelivery just works.

        The gateway reclaims the PROCESSING row for the new worker and answers
        200, so the actor carries straight on to download the audio and
        transcribe it. No refusal is raised at all.
        """
        client = APIGatewayClient(base_url="http://gateway.invalid/api/v1", api_key="k")

        async def _request(method: str, path: str, json: dict[str, Any] | None = None, *_a: Any, **_kw: Any) -> dict[str, Any]:
            assert json == {"workerId": "host-b-62315"}
            return {"id": JOB, "status": "PROCESSING", "workerId": "host-b-62315", "reclaimCount": 1}

        client._request = _request  # type: ignore[method-assign]
        result = await client.start_job(JOB, "host-b-62315", tenant_id=TENANT)
        assert result["workerId"] == "host-b-62315"
        assert result["reclaimCount"] == 1


class TestLegacyGatewayStillClassified:
    """A gateway that predates TASK-992 — the rolling-deploy window."""

    @pytest.mark.asyncio
    async def test_processing_is_still_not_terminal(self) -> None:
        client = _client_refusing_start("PROCESSING", terminal=False, structured=False)
        with pytest.raises(JobConflictError):
            await client.start_job(JOB, "host-b-2", tenant_id=TENANT)

    @pytest.mark.asyncio
    async def test_a_finished_job_is_still_terminal(self) -> None:
        client = _client_refusing_start("COMPLETED", terminal=True, structured=False)
        with pytest.raises(JobTerminalError):
            await client.start_job(JOB, "host-b-2", tenant_id=TENANT)
