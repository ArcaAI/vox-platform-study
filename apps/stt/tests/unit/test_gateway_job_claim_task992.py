"""TASK-992 — how the worker classifies a refused job claim.

The bug this file exists to prevent: ``_is_terminal_state_error`` matched on the
SUBSTRING ``"Cannot start job in"``, so a **PROCESSING** job — which is
recoverable, and was in fact the broker correctly redelivering a message whose
worker had died — was classified terminal. ``transcribe_file`` then logged
"already in terminal state, skipping duplicate delivery" and ACKed, orphaning
job ``01a0b94c-637e-78c0-a279-3a83cf8df46b`` in PROCESSING at 75% with
``retryCount`` 0 and nothing in the platform able to end it.

Two classifications now exist, and the difference decides whether a job
recovers or is lost:

* ``JobTerminalError``  → ACK. Nothing will ever make this claim succeed.
* ``JobConflictError``  → re-raise, let Dramatiq retry with backoff.

The gateway supplies the answer structurally (``DOMAIN.INVALID_STATE_TRANSITION``
+ ``metadata.terminal``). The substring branch survives only as a deprecated
fallback for the rolling-deploy window against an older gateway.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
import pytest

from stt.core.api_client.gateway import APIGatewayClient
from stt.core.exceptions import (
    NON_RETRYABLE_EXCEPTIONS,
    APIGatewayError,
    JobConflictError,
    JobTerminalError,
)

JOB_ID = "01a0b94c-637e-78c0-a279-3a83cf8df46b"


def _gateway_error(status_code: int, body: dict[str, Any]) -> APIGatewayError:
    """Build the exact error shape ``APIGatewayClient._request`` raises."""
    request = httpx.Request("PATCH", f"http://gw/internal/stt/jobs/{JOB_ID}/start")
    response = httpx.Response(status_code, request=request, content=json.dumps(body).encode())
    cause = httpx.HTTPStatusError("boom", request=request, response=response)
    error = APIGatewayError(
        f"API Gateway request failed: {status_code}",
        details={"status_code": status_code, "path": f"/internal/stt/jobs/{JOB_ID}/start"},
    )
    error.__cause__ = cause
    return error


def _legacy_body(status: str) -> dict[str, Any]:
    """What an OLD gateway answers: a generic 500 whose only signal is prose."""
    return {
        "statusCode": 500,
        "code": "DOMAIN.BUSINESS",
        "message": f"Cannot start job in {status} status",
        "correlationId": "corr-legacy",
    }


def _structured_body(status: str, terminal: bool) -> dict[str, Any]:
    """What the TASK-992 gateway answers."""
    return {
        "statusCode": 409,
        "code": "DOMAIN.INVALID_STATE_TRANSITION",
        "message": f"Cannot start job in {status} status",
        "metadata": {
            "entity": "TranscriptionJob",
            "entityId": JOB_ID,
            "currentStatus": status,
            "attempted": "startProcessing",
            "terminal": terminal,
        },
        "correlationId": "corr-992",
    }


async def _start_job(monkeypatch: pytest.MonkeyPatch, error: APIGatewayError | None) -> Any:
    """Drive ``start_job`` with ``_request`` stubbed to raise (or succeed)."""
    client = APIGatewayClient(base_url="http://gw", api_key="k")

    async def fake_request(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        if error is not None:
            raise error
        return {"id": JOB_ID, "status": "PROCESSING"}

    monkeypatch.setattr(client, "_request", fake_request)
    return await client.start_job(JOB_ID, "host-b-62315", tenant_id="tenant-1")


class TestLegacyGatewayBody:
    """A 500 ``DOMAIN.BUSINESS`` body, i.e. a gateway that predates TASK-992."""

    async def test_processing_is_not_terminal(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """THE regression. A redelivered job under a dead worker must not be ACKed."""
        with pytest.raises(JobConflictError):
            await _start_job(monkeypatch, _gateway_error(500, _legacy_body("PROCESSING")))

    async def test_processing_is_not_raised_as_terminal(self, monkeypatch: pytest.MonkeyPatch) -> None:
        with pytest.raises(Exception) as excinfo:  # noqa: B017 — the POINT is which subclass it is not
            await _start_job(monkeypatch, _gateway_error(500, _legacy_body("PROCESSING")))
        assert not isinstance(excinfo.value, JobTerminalError)

    @pytest.mark.parametrize("status", ["COMPLETED", "CANCELLED", "DEAD"])
    async def test_finished_statuses_stay_terminal(self, monkeypatch: pytest.MonkeyPatch, status: str) -> None:
        with pytest.raises(JobTerminalError):
            await _start_job(monkeypatch, _gateway_error(500, _legacy_body(status)))

    async def test_failed_stays_terminal_on_the_legacy_branch(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Deliberate, and the opposite of how the NEW gateway answers.

        Against an old gateway a FAILED job can never be restarted, so
        classifying it retryable would spin the worker through its whole
        backoff for a claim that cannot succeed. The new gateway re-attempts it
        and answers 200, so this branch is never reached once both sides ship.
        """
        with pytest.raises(JobTerminalError):
            await _start_job(monkeypatch, _gateway_error(500, _legacy_body("FAILED")))

    async def test_cannot_fail_message_stays_terminal(self, monkeypatch: pytest.MonkeyPatch) -> None:
        body = {"statusCode": 500, "code": "DOMAIN.BUSINESS", "message": "Cannot fail job in COMPLETED status"}
        with pytest.raises(JobTerminalError):
            await _start_job(monkeypatch, _gateway_error(500, body))


class TestStructuredGatewayBody:
    """A 409 ``DOMAIN.INVALID_STATE_TRANSITION`` body — no prose parsed."""

    async def test_non_terminal_refusal_is_a_conflict(self, monkeypatch: pytest.MonkeyPatch) -> None:
        with pytest.raises(JobConflictError):
            await _start_job(monkeypatch, _gateway_error(409, _structured_body("PROCESSING", terminal=False)))

    async def test_terminal_refusal_is_terminal(self, monkeypatch: pytest.MonkeyPatch) -> None:
        with pytest.raises(JobTerminalError):
            await _start_job(monkeypatch, _gateway_error(409, _structured_body("DEAD", terminal=True)))

    async def test_the_flag_wins_over_the_status_name(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The worker must not keep its own opinion of which statuses are final.

        A status the worker has never heard of, marked terminal by the gateway,
        is terminal — that is the whole reason ``terminal`` is a boolean the
        server decides rather than a string the client re-interprets.
        """
        with pytest.raises(JobTerminalError):
            await _start_job(monkeypatch, _gateway_error(409, _structured_body("SOME_FUTURE_STATUS", terminal=True)))

    async def test_a_500_carrying_the_structured_code_is_still_read(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The code is the signal, not the status line."""
        body = _structured_body("PROCESSING", terminal=False) | {"statusCode": 500}
        with pytest.raises(JobConflictError):
            await _start_job(monkeypatch, _gateway_error(500, body))


class TestUnrelatedErrors:
    async def test_an_ordinary_500_is_neither(self, monkeypatch: pytest.MonkeyPatch) -> None:
        body = {"statusCode": 500, "code": "GENERIC.INTERNAL_SERVER_ERROR", "message": "Internal server error"}
        with pytest.raises(APIGatewayError) as excinfo:
            await _start_job(monkeypatch, _gateway_error(500, body))
        assert not isinstance(excinfo.value, (JobTerminalError, JobConflictError))

    async def test_a_non_json_body_does_not_crash_the_classifier(self, monkeypatch: pytest.MonkeyPatch) -> None:
        request = httpx.Request("PATCH", "http://gw/x")
        response = httpx.Response(502, request=request, content=b"<html>bad gateway</html>")
        error = APIGatewayError("API Gateway request failed: 502", details={"status_code": 502})
        error.__cause__ = httpx.HTTPStatusError("boom", request=request, response=response)

        with pytest.raises(APIGatewayError) as excinfo:
            await _start_job(monkeypatch, error)
        assert not isinstance(excinfo.value, (JobTerminalError, JobConflictError))

    async def test_a_successful_claim_returns_the_row(self, monkeypatch: pytest.MonkeyPatch) -> None:
        assert (await _start_job(monkeypatch, None))["status"] == "PROCESSING"


class TestRetryClassification:
    def test_conflict_is_retryable_and_terminal_is_not(self) -> None:
        """The broker's own retry decision reads these tuples.

        ``JobConflictError`` must stay OUT of ``NON_RETRYABLE_EXCEPTIONS`` or
        the re-raise in ``transcribe_file`` is swallowed by ``should_retry``
        and the job is lost exactly as before.
        """
        assert JobTerminalError in NON_RETRYABLE_EXCEPTIONS
        assert JobConflictError not in NON_RETRYABLE_EXCEPTIONS
        assert not issubclass(JobConflictError, NON_RETRYABLE_EXCEPTIONS)


# ─────────────────────────────────────────────────────────────────────────────
# Worker-level behaviour. These carry over the two cases TASK-991 W2-4 pinned in
# `test_task991_orphaned_job_recovery.py::TestWorkerEndsTheOrphanedJob`, with the
# conflict verdict inverted: a job the platform can still finish is left ALONE
# for the broker to redeliver, never ended.
# ─────────────────────────────────────────────────────────────────────────────


def _install_stubs(monkeypatch: pytest.MonkeyPatch, mod: Any, api_client: Any) -> None:
    """Stub the collaborators resolved before the job's first gateway call."""

    class FakeResolver:
        def set_tenant_storage(self, *a: Any, **k: Any) -> None: ...
        def set_tenant_bucket(self, *a: Any, **k: Any) -> None: ...

    class FakeBlobService:
        _resolver = FakeResolver()

        async def download_audio(self, uri: str, tenant_id: str | None = None) -> bytes:
            raise AssertionError("the job never gets past /start in these tests")

    class FakePipelineReader:
        async def get_pipeline(self, pipeline_id: str) -> Any:
            raise AssertionError("the job never gets past /start in these tests")

    class FakeBatchService:
        async def transcribe(self, **kwargs: Any) -> Any:
            raise AssertionError("the job never gets past /start in these tests")

    class FakePublisher:
        async def connect(self) -> None: ...
        async def publish_status(self, *a: Any, **k: Any) -> None: ...
        async def publish_error(self, *a: Any, **k: Any) -> None: ...
        async def close(self) -> None: ...

    class FakeEffectiveConfigClient:
        async def get_provider_overrides(self, tenant_id: str) -> dict[str, Any]:
            return {}

    async def _noop_refresh() -> None:
        return None

    monkeypatch.setattr(mod, "refresh_job_concurrency_limit", _noop_refresh)
    monkeypatch.setattr(mod, "get_api_client", lambda: api_client)
    monkeypatch.setattr(mod, "get_blob_service", lambda: FakeBlobService())
    monkeypatch.setattr(mod, "get_pipeline_reader", lambda: FakePipelineReader())
    monkeypatch.setattr(mod, "get_batch_service", lambda: FakeBatchService())
    monkeypatch.setattr(mod, "TranscriptionEventPublisher", FakePublisher)
    monkeypatch.setattr(mod, "get_effective_config_client", lambda: FakeEffectiveConfigClient())


TENANT = "50000000-0000-0000-0000-000000000001"


class TestWorkerReactionToARefusal:
    async def test_a_conflict_is_re_raised_and_the_job_is_left_alone(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The job must NOT be ended — the platform can still transcribe it.

        TASK-991 W2-4 called ``_fail_job`` here and then ``SkipMessage``, which
        discarded a recoverable transcription. Re-raising hands the delivery
        back to Dramatiq, which redelivers it with backoff.
        """
        import importlib

        import dramatiq

        mod = importlib.import_module("stt.transcription.workers.transcribe_file")
        failed: list[Any] = []

        class FakeClient:
            async def start_job(self, job_id: str, worker_id: str, **_kw: Any) -> dict[str, Any]:
                raise JobConflictError(f"Job {job_id} cannot be claimed yet", details={"status_code": 409})

            async def fail_job(self, **kwargs: Any) -> dict[str, Any]:
                failed.append(kwargs)
                return {}

            async def close(self) -> None:
                return None

        _install_stubs(monkeypatch, mod, FakeClient())

        with pytest.raises(JobConflictError):
            await mod._transcribe_file_async(
                job_id=JOB_ID, tenant_id=TENANT, pipeline_id="p-1", audio_uri="s3://bucket/consult.wav"
            )

        assert failed == [], "a job that can still be completed must never be marked FAILED"
        # A SkipMessage would ACK the delivery and lose the job for good.
        assert not isinstance(getattr(mod, "_last_raised", None), dramatiq.middleware.SkipMessage)

    async def test_a_genuinely_finished_job_is_still_dropped_without_being_failed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The duplicate-delivery path must not be collateral damage of the fix."""
        import importlib

        mod = importlib.import_module("stt.transcription.workers.transcribe_file")
        failed: list[Any] = []

        class FakeClient:
            async def start_job(self, job_id: str, worker_id: str, **_kw: Any) -> dict[str, Any]:
                raise JobTerminalError(f"Job {job_id} is already in a terminal state", details={"status_code": 409})

            async def fail_job(self, **kwargs: Any) -> dict[str, Any]:
                failed.append(kwargs)
                return {}

            async def close(self) -> None:
                return None

        _install_stubs(monkeypatch, mod, FakeClient())

        await mod._transcribe_file_async(
            job_id=JOB_ID, tenant_id=TENANT, pipeline_id="p-1", audio_uri="s3://bucket/consult.wav"
        )

        assert failed == [], "a COMPLETED job must not be overwritten as FAILED"

    async def test_the_worker_identity_is_unique_across_hosts(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The reclaim rule is "a DIFFERENT worker holds this job".

        PIDs collide between pods, so a bare ``worker-<pid>`` could make a
        genuine reclaim look like the same worker re-sending its claim — which
        the gateway answers idempotently, leaving two workers on one job.
        """
        import importlib

        mod = importlib.import_module("stt.transcription.workers.transcribe_file")
        claimed: list[str] = []

        class FakeClient:
            async def start_job(self, job_id: str, worker_id: str, **_kw: Any) -> dict[str, Any]:
                claimed.append(worker_id)
                raise JobTerminalError("stop here", details={})

            async def close(self) -> None:
                return None

        _install_stubs(monkeypatch, mod, FakeClient())
        monkeypatch.setattr(mod.socket, "gethostname", lambda: "stt-worker-7d4c9")

        await mod._transcribe_file_async(
            job_id=JOB_ID, tenant_id=TENANT, pipeline_id="p-1", audio_uri="s3://bucket/consult.wav"
        )

        assert claimed[0].startswith("stt-worker-7d4c9-")
        assert claimed[0] != f"worker-{os.getpid()}"
