"""A job whose claim cannot be resumed must END, not disappear.

TASK-991 W2-4, measured live: a worker restart redelivered an in-flight message,
the gateway refused the new claim with ``500 "Cannot start job in PROCESSING
status"``, and the client substring-matched that prose to decide the job was
TERMINAL. It was not — PROCESSING is a claim, not an outcome — so the worker acked
the delivery and returned, the row stayed PROCESSING forever, and the caller waited
out its entire timeout against a job that nothing owned.

Two things are fixed and pinned here:

* the refusal is classified by the job's STATUS, read back from the gateway, so the
  wording of an exception message is no longer load-bearing;
* a non-terminal refusal ends the job FAILED — an outcome the client can see —
  instead of being dropped in silence.
"""

from __future__ import annotations

from typing import Any

import dramatiq
import pytest

from stt.core.api_client.gateway import (
    ORPHANED_CLAIM_STATUS,
    TERMINAL_JOB_STATUSES,
    APIGatewayClient,
    JobNotResumableError,
)
from stt.core.exceptions import APIGatewayError, JobTerminalError

pytestmark = pytest.mark.unit

TENANT = "50000000-0000-0000-0000-000000000001"
JOB = "01a0b95a-0000-0000-0000-000000000000"

# Deliberately NOT the wording the gateway happens to use today: the classification
# must not depend on it. The real message was "Cannot start job in PROCESSING status".
OPAQUE_REFUSAL = "API Gateway request failed: 500"


def _client_refusing_start(status: str | None, status_readable: bool = True) -> APIGatewayClient:
    """A client whose /start is refused and whose /status answers *status*."""
    client = APIGatewayClient(base_url="http://gateway.invalid/api/v1", api_key="k")

    async def _request(
        method: str,
        path: str,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        if path.endswith("/start"):
            raise APIGatewayError(
                OPAQUE_REFUSAL,
                details={"status_code": 500, "path": path},
            )
        if path.endswith("/status"):
            if not status_readable:
                raise APIGatewayError("API Gateway connection error: timed out")
            return {} if status is None else {"status": status}
        raise AssertionError(f"unexpected call to {path}")

    client._request = _request  # type: ignore[method-assign]
    return client


class TestTerminalSetMatchesTheDomain:
    def test_processing_is_not_a_terminal_status(self) -> None:
        """The whole defect in one assertion: a claim is not an outcome."""
        assert ORPHANED_CLAIM_STATUS == "PROCESSING"
        assert ORPHANED_CLAIM_STATUS not in TERMINAL_JOB_STATUSES
        assert "QUEUED" not in TERMINAL_JOB_STATUSES

    def test_mirrors_transcription_job_entity_is_terminal(self) -> None:
        assert TERMINAL_JOB_STATUSES == {"COMPLETED", "FAILED", "CANCELLED", "DEAD"}


class TestStartJobClassifiesByStatus:
    @pytest.mark.asyncio
    async def test_a_processing_job_is_reported_unresumable_not_terminal(self) -> None:
        client = _client_refusing_start("PROCESSING")

        with pytest.raises(JobNotResumableError) as excinfo:
            await client.start_job(JOB, "worker-2", tenant_id=TENANT)

        assert excinfo.value.details["status"] == "PROCESSING"
        # A JobTerminalError here is what made the worker drop the delivery.
        assert not isinstance(excinfo.value, JobTerminalError)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", sorted(TERMINAL_JOB_STATUSES))
    async def test_a_finished_job_is_still_terminal(self, status: str) -> None:
        """Duplicate deliveries of a finished job must keep being dropped."""
        client = _client_refusing_start(status)

        with pytest.raises(JobTerminalError) as excinfo:
            await client.start_job(JOB, "worker-2", tenant_id=TENANT)

        assert excinfo.value.details["status"] == status

    @pytest.mark.asyncio
    async def test_the_verdict_does_not_read_the_error_message(self) -> None:
        """Rewording the gateway's exception must not change what a worker does."""
        client = _client_refusing_start("PROCESSING")

        with pytest.raises(JobNotResumableError):
            await client.start_job(JOB, "worker-2", tenant_id=TENANT)

        client = _client_refusing_start("COMPLETED")
        with pytest.raises(JobTerminalError):
            await client.start_job(JOB, "worker-2", tenant_id=TENANT)

    @pytest.mark.asyncio
    async def test_a_queued_job_is_left_retryable(self) -> None:
        """A QUEUED job refused a start for some OTHER reason — never end it.

        ``startProcessing`` only refuses a job that is not QUEUED, so a refusal on a
        QUEUED row is auth, validation or a transient 500. Retrying is the answer;
        failing the job would destroy work that had not started.
        """
        client = _client_refusing_start("QUEUED")

        with pytest.raises(APIGatewayError) as excinfo:
            await client.start_job(JOB, "worker-2", tenant_id=TENANT)

        assert not isinstance(excinfo.value, (JobTerminalError, JobNotResumableError))

    @pytest.mark.asyncio
    async def test_an_unreadable_status_stays_a_retryable_transport_error(self) -> None:
        """An unknown status must never be resolved as "not terminal"."""
        client = _client_refusing_start(None, status_readable=False)

        with pytest.raises(APIGatewayError) as excinfo:
            await client.start_job(JOB, "worker-2", tenant_id=TENANT)

        assert not isinstance(excinfo.value, (JobTerminalError, JobNotResumableError))

    @pytest.mark.asyncio
    async def test_a_status_less_response_is_not_a_state(self) -> None:
        """`get_job_status` substitutes "UNKNOWN"; that is an absence, not a verdict."""
        client = _client_refusing_start(None)

        with pytest.raises(APIGatewayError) as excinfo:
            await client.start_job(JOB, "worker-2", tenant_id=TENANT)

        assert not isinstance(excinfo.value, (JobTerminalError, JobNotResumableError))

    @pytest.mark.asyncio
    async def test_a_successful_start_is_untouched(self) -> None:
        client = APIGatewayClient(base_url="http://gateway.invalid/api/v1", api_key="k")

        async def _request(method: str, path: str, **_kwargs: Any) -> dict[str, Any]:
            assert path.endswith("/start")
            return {"status": "PROCESSING", "workerId": "worker-2"}

        client._request = _request  # type: ignore[method-assign]

        assert await client.start_job(JOB, "worker-2", tenant_id=TENANT) == {
            "status": "PROCESSING",
            "workerId": "worker-2",
        }


class TestWorkerEndsTheOrphanedJob:
    @pytest.mark.asyncio
    async def test_an_unresumable_job_is_failed_rather_than_silently_acked(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import importlib

        mod = importlib.import_module("stt.transcription.workers.transcribe_file")
        seen: dict[str, Any] = {}

        class FakeClient:
            async def start_job(self, job_id: str, worker_id: str, **_kw: Any) -> dict[str, Any]:
                raise JobNotResumableError(
                    f"Job {job_id} refused the worker claim in PROCESSING status",
                    details={"status": "PROCESSING"},
                )

            async def fail_job(self, **kwargs: Any) -> dict[str, Any]:
                seen["error_code"] = kwargs.get("error_code")
                seen["tenant_id"] = kwargs.get("tenant_id")
                return {}

            async def close(self) -> None:
                return None

        _install_stubs(monkeypatch, mod, FakeClient())

        # SkipMessage: the delivery is dropped ON PURPOSE, and only after the job
        # has been given an ending. A bare `return` (the old behaviour) drops it
        # while the row is still PROCESSING.
        with pytest.raises(dramatiq.middleware.SkipMessage):
            await mod._transcribe_file_async(
                job_id=JOB,
                tenant_id=TENANT,
                pipeline_id="p-1",
                audio_uri="s3://bucket/consult.wav",
            )

        assert seen["error_code"] == "JOB_NOT_RESUMABLE"
        assert seen["tenant_id"] == TENANT, "the /fail callback 404s without the owning tenant"

    @pytest.mark.asyncio
    async def test_a_genuinely_finished_job_is_still_dropped_without_being_failed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The duplicate-delivery path must not be collateral damage of the fix."""
        import importlib

        mod = importlib.import_module("stt.transcription.workers.transcribe_file")
        failed: list[Any] = []

        class FakeClient:
            async def start_job(self, job_id: str, worker_id: str, **_kw: Any) -> dict[str, Any]:
                raise JobTerminalError(
                    f"Job {job_id} is already in a terminal state",
                    details={"status": "COMPLETED"},
                )

            async def fail_job(self, **kwargs: Any) -> dict[str, Any]:
                failed.append(kwargs)
                return {}

            async def close(self) -> None:
                return None

        _install_stubs(monkeypatch, mod, FakeClient())

        await mod._transcribe_file_async(
            job_id=JOB,
            tenant_id=TENANT,
            pipeline_id="p-1",
            audio_uri="s3://bucket/consult.wav",
        )

        assert failed == [], "a COMPLETED job must not be overwritten as FAILED"


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
