"""TASK-724 Task 5 — the STT palette's harness batch-trigger activity.

Hermetic: `_api_client` is monkeypatched to an in-process fake (no network I/O,
no live apps/api). Polling loops use tiny intervals so the test stays fast while
still exercising the real `asyncio.sleep`-based poll body.
"""

from __future__ import annotations

from typing import Any

import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from harness.services.api_client import ApiServiceError, SttBatchJobResponse
from harness.temporal import activities
from harness.temporal.models import DispatchBatchTranscriptionInput


class _FakeSttApi:
    """Stub for the two `ApiClient` STT batch-job methods this activity calls."""

    def __init__(self, *, create_error: Exception | None = None) -> None:
        self.create_calls: list[dict[str, Any]] = []
        self.poll_calls: list[dict[str, Any]] = []
        self._create_error = create_error
        # Sequence of GET responses returned on successive polls; the LAST
        # entry repeats once exhausted.
        self._poll_sequence: list[SttBatchJobResponse] = []
        self._created = SttBatchJobResponse(jobId="job-1", status="QUEUED")

    def set_created(self, resp: SttBatchJobResponse) -> None:
        self._created = resp

    def set_poll_sequence(self, seq: list[SttBatchJobResponse]) -> None:
        self._poll_sequence = list(seq)

    async def create_stt_batch_job(self, **kw: Any) -> SttBatchJobResponse:
        self.create_calls.append(kw)
        if self._create_error is not None:
            raise self._create_error
        return self._created

    async def get_stt_batch_job_status(self, job_id: str, *, tenant_id: str) -> SttBatchJobResponse:
        self.poll_calls.append({"job_id": job_id, "tenant_id": tenant_id})
        if self._poll_sequence:
            return (
                self._poll_sequence.pop(0)
                if len(self._poll_sequence) > 1
                else self._poll_sequence[0]
            )
        return SttBatchJobResponse(jobId=job_id, status="PROCESSING")


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


class TestDispatchBatchTranscription:
    @pytest.mark.asyncio
    async def test_dispatches_and_returns_immediately_on_a_terminal_create_response(
        self, env, monkeypatch
    ):
        """A job that lands COMPLETED synchronously (small/fast transcription) never polls."""
        fake = _FakeSttApi()
        fake.set_created(SttBatchJobResponse(jobId="job-1", status="COMPLETED", progress=100))
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)

        result = await env.run(
            activities.dispatch_batch_transcription,
            DispatchBatchTranscriptionInput(
                tenant_id="t-1",
                pipeline_id="pipeline-1",
                audio_uri="s3://bucket/key.wav",
                consultation_id="c-1",
            ),
        )

        assert result.job_id == "job-1"
        assert result.status == "COMPLETED"
        assert result.progress == 100
        assert result.timed_out is False
        assert fake.create_calls == [
            {
                "tenant_id": "t-1",
                "pipeline_id": "pipeline-1",
                "audio_uri": "s3://bucket/key.wav",
                "consultation_id": "c-1",
                "media_id": None,
                "language": None,
            }
        ]
        assert fake.poll_calls == []

    @pytest.mark.asyncio
    async def test_polls_until_terminal_state(self, env, monkeypatch):
        fake = _FakeSttApi()
        fake.set_created(SttBatchJobResponse(jobId="job-1", status="QUEUED"))
        fake.set_poll_sequence(
            [
                SttBatchJobResponse(jobId="job-1", status="PROCESSING", progress=50),
                SttBatchJobResponse(jobId="job-1", status="COMPLETED", progress=100),
            ]
        )
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)

        result = await env.run(
            activities.dispatch_batch_transcription,
            DispatchBatchTranscriptionInput(
                tenant_id="t-1",
                pipeline_id="pipeline-1",
                audio_uri="s3://bucket/key.wav",
                poll_interval_seconds=0.01,
                poll_timeout_seconds=5,
            ),
        )

        assert result.status == "COMPLETED"
        assert result.progress == 100
        assert result.timed_out is False
        assert len(fake.poll_calls) == 2
        assert all(
            call["job_id"] == "job-1" and call["tenant_id"] == "t-1" for call in fake.poll_calls
        )

    @pytest.mark.asyncio
    async def test_returns_timed_out_when_the_poll_ceiling_is_hit(self, env, monkeypatch):
        """Never a failure — the job is still QUEUED/PROCESSING on apps/api, so this
        surfaces as ``timed_out=True`` on the last-observed non-terminal status."""
        fake = _FakeSttApi()
        fake.set_created(SttBatchJobResponse(jobId="job-1", status="QUEUED"))
        fake.set_poll_sequence(
            [SttBatchJobResponse(jobId="job-1", status="PROCESSING", progress=10)]
        )
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)

        result = await env.run(
            activities.dispatch_batch_transcription,
            DispatchBatchTranscriptionInput(
                tenant_id="t-1",
                pipeline_id="pipeline-1",
                audio_uri="s3://bucket/key.wav",
                poll_interval_seconds=0.01,
                poll_timeout_seconds=0.03,
            ),
        )

        assert result.status == "PROCESSING"
        assert result.timed_out is True

    @pytest.mark.asyncio
    async def test_create_failure_raises_non_retryable_application_error_type(
        self, env, monkeypatch
    ):
        fake = _FakeSttApi(create_error=ApiServiceError("apps/api down"))
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)

        with pytest.raises(ApplicationError) as exc_info:
            await env.run(
                activities.dispatch_batch_transcription,
                DispatchBatchTranscriptionInput(
                    tenant_id="t-1", pipeline_id="pipeline-1", audio_uri="s3://bucket/key.wav"
                ),
            )
        assert exc_info.value.type == "SttBatchDispatchFailed"

    @pytest.mark.asyncio
    async def test_idempotent_retry_is_safe_because_apps_api_dedups_on_consultation_and_pipeline(
        self, env, monkeypatch
    ):
        """This activity does not itself track idempotency — apps/api's
        `POST /internal/harness/stt/batch-jobs` reuses the existing non-terminal
        job for the same (consultation_id, pipeline_id). Two full activity
        invocations (simulating a Temporal retry) both call create; the SAME
        fake stands in for apps/api's own dedup by returning the SAME job id
        both times, proving the activity's output is stable across a retry."""
        fake = _FakeSttApi()
        fake.set_created(SttBatchJobResponse(jobId="job-1", status="COMPLETED", progress=100))
        monkeypatch.setattr(activities, "_api_client", lambda s: fake)

        payload = DispatchBatchTranscriptionInput(
            tenant_id="t-1",
            pipeline_id="pipeline-1",
            audio_uri="s3://bucket/key.wav",
            consultation_id="c-1",
        )
        first = await env.run(activities.dispatch_batch_transcription, payload)
        second = await env.run(activities.dispatch_batch_transcription, payload)

        assert first.job_id == second.job_id == "job-1"
        assert len(fake.create_calls) == 2
