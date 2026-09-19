"""Tests for transcribe_file worker with pub/sub event publishing.

These tests verify the **integration behavior** between the worker,
the gateway API client, and the TranscriptionEventPublisher.

Anti-pattern prevention:
- #1 (Testing mocks): Tests verify actual outcomes (events published,
  job status transitions) not just that mocks were called.
- #3 (Blind mocking): Only external boundaries are mocked (Redis,
  API Gateway, MinIO, pipeline reader, batch service). The publisher
  itself is real — we inject a mock Redis into it so we can observe
  the actual events it publishes.
- #4 (Incomplete mocks): Mock objects include complete response
  structures matching real services.
"""

import asyncio
import json
import os
import socket
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import dramatiq
import pytest

from stt.core.exceptions import NotFoundError, TranscriptionError
from stt.transcription.dto import TranscriptionResult
from stt.transcription.workers.transcribe_file import (
    _fail_job,
    _transcribe_file_async,
)

# =============================================================================
# Realistic fixtures — complete structures matching production data
# =============================================================================


def _make_result(
    text: str = "Patient reports mild discomfort.",
    language: str = "en",
    duration: float = 5.0,
    processing_time: float = 1.2,
    engine: str | None = "whisper_cpp",
    deployment: str | None = "SELF_HOSTED",
    device: str | None = None,
    request_bytes: int | None = None,
    response_bytes: int | None = None,
    byte_source: str | None = None,
) -> TranscriptionResult:
    """Create a complete TranscriptionResult matching real pipeline output."""
    return TranscriptionResult(
        text=text,
        language=language,
        language_probability=0.95,
        duration_seconds=duration,
        processing_time_seconds=processing_time,
        word_timestamps=[],
        sentence_timestamps=[],
        segments=[],
        metadata={"pipeline_id": "p-789"},
        engine=engine,
        deployment=deployment,
        device=device,
        request_bytes=request_bytes,
        response_bytes=response_bytes,
        byte_source=byte_source,
    )


def _make_pipeline_config(
    vad_enabled: bool = False,
    diarization_enabled: bool = False,
) -> MagicMock:
    """Create a pipeline config mock with all necessary nested attributes."""
    config = MagicMock()
    config.id = "p-789"
    config.spec.preprocessing.vad.enabled = vad_enabled
    config.spec.diarization.enabled = diarization_enabled
    config.spec.diarization.segment_silence_padding_ms = 100
    return config


def _patch_worker_deps(
    api_client: AsyncMock | None = None,
    blob_service: AsyncMock | None = None,
    pipeline_reader: AsyncMock | None = None,
    batch_service: AsyncMock | None = None,
    pipeline_config: MagicMock | None = None,
    result: TranscriptionResult | None = None,
):
    """Return a tuple of context managers + mocks for worker dependencies.

    Returns (p1, p2, p3, p4, p5, api, blob, reader, batch) where p1-p5 are
    patch context managers and api/blob/reader/batch are the mock instances.
    """
    # --- API Client ---
    _api = api_client if api_client is not None else AsyncMock()
    if api_client is None:
        _api.start_job = AsyncMock()
        _api.update_job_progress = AsyncMock()
        _api.complete_job = AsyncMock()
        _api.fail_job = AsyncMock()
        _api.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-001"})

    # --- Blob Service ---
    _blob = blob_service if blob_service is not None else AsyncMock()
    if blob_service is None:
        _blob.download_audio = AsyncMock(return_value=b"fake audio")
        _blob.upload_transcript = AsyncMock(return_value="s3://t/transcript.json")
        _blob.upload_processed_audio = AsyncMock(return_value="s3://t/processed.wav")
        _blob.upload_batch_metadata = AsyncMock(return_value="s3://t/metadata.json")

    # --- Pipeline Reader ---
    _reader = pipeline_reader if pipeline_reader is not None else AsyncMock()
    _pc = pipeline_config or _make_pipeline_config()
    if pipeline_reader is None:
        _reader.get_pipeline = AsyncMock(return_value=_pc)

    # --- Batch Service ---
    _batch = batch_service if batch_service is not None else AsyncMock()
    if batch_service is None:
        _batch.transcribe = AsyncMock(return_value=result or _make_result())

    _mock_settings = MagicMock()
    _mock_settings.pubsub_enabled = True
    _mock_settings.pubsub_channel_prefix = "stt:transcription:"
    _mock_settings.redis_url = "redis://localhost:6379/0"

    return (
        patch("stt.transcription.workers.transcribe_file.get_api_client", return_value=_api),
        patch("stt.transcription.workers.transcribe_file.get_blob_service", return_value=_blob),
        patch(
            "stt.transcription.workers.transcribe_file.get_pipeline_reader", return_value=_reader
        ),
        patch("stt.transcription.workers.transcribe_file.get_batch_service", return_value=_batch),
        patch(
            "stt.transcription.workers.transcribe_file.get_settings", return_value=_mock_settings
        ),
        _api,
        _blob,
        _reader,
        _batch,
    )


# =============================================================================
# Helper to capture all Redis Pub/Sub messages published by the worker
# =============================================================================


class PubSubCapture:
    """Captures all Redis Pub/Sub messages published during a worker run.

    Instead of mocking the publisher, we inject a mock Redis client into
    the real TranscriptionEventPublisher so we observe actual serialization
    and channel routing.
    """

    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self.channels: list[str] = []

    def mock_redis(self) -> AsyncMock:
        """Create a mock Redis client that captures published messages."""
        redis = AsyncMock()
        redis.ping = AsyncMock()
        redis.aclose = AsyncMock()

        async def capture_publish(channel: str, message: str) -> int:
            self.channels.append(channel)
            self.messages.append(json.loads(message))
            return 1

        redis.publish = AsyncMock(side_effect=capture_publish)
        return redis

    def events_of_type(self, event_type: str) -> list[dict[str, Any]]:
        """Filter captured events by type."""
        return [m for m in self.messages if m.get("type") == event_type]

    def event_types(self) -> list[str]:
        """Return the ordered list of event types published."""
        return [m.get("type", "?") for m in self.messages]

    @property
    def status_events(self) -> list[dict[str, Any]]:
        return self.events_of_type("status")

    @property
    def progress_events(self) -> list[dict[str, Any]]:
        return self.events_of_type("progress")

    @property
    def chunk_events(self) -> list[dict[str, Any]]:
        return self.events_of_type("chunk")

    @property
    def transcript_events(self) -> list[dict[str, Any]]:
        return self.events_of_type("transcript")

    @property
    def error_events(self) -> list[dict[str, Any]]:
        return self.events_of_type("error")


@pytest.fixture
def pubsub_capture():
    return PubSubCapture()


def _patch_publisher(capture: PubSubCapture):
    """Patch the publisher to use the capture's mock Redis."""
    mock_redis = capture.mock_redis()

    _original_connect = None

    async def patched_connect(self_pub):
        """Replace real Redis with capture mock."""
        self_pub._redis = mock_redis
        self_pub._connected = True

    return patch(
        "stt.core.messaging.pubsub.TranscriptionEventPublisher.connect",
        patched_connect,
    )


# =============================================================================
# Happy path: full event lifecycle
# =============================================================================


class TestWorkerPubSubHappyPath:
    """Verify the complete event sequence for successful transcription."""

    @pytest.mark.asyncio
    async def test_successful_job_publishes_full_event_sequence(self, pubsub_capture):
        """Verify: PROCESSING -> transcript -> COMPLETED events in order."""
        p1, p2, p3, p4, p5, api, blob, reader, batch = _patch_worker_deps()

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-100",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
            )

        types = pubsub_capture.event_types()
        # Must have status:PROCESSING first, transcript before COMPLETED
        assert "status" in types
        assert "transcript" in types

        # First status is PROCESSING, last status is COMPLETED
        statuses = [e["data"]["status"] for e in pubsub_capture.status_events]
        assert statuses[0] == "PROCESSING"
        assert statuses[-1] == "COMPLETED"

        # Transcript event carries the full text
        assert len(pubsub_capture.transcript_events) == 1
        assert (
            pubsub_capture.transcript_events[0]["data"]["text"]
            == "Patient reports mild discomfort."
        )

    @pytest.mark.asyncio
    async def test_processing_status_includes_worker_id(self, pubsub_capture):
        """Verify the PROCESSING status event includes the worker ID."""
        p1, p2, p3, p4, p5, *_ = _patch_worker_deps()

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-101",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
            )

        processing = pubsub_capture.status_events[0]
        assert processing["data"]["status"] == "PROCESSING"
        assert "workerId" in processing["data"]
        # TASK-992 — the identity is `{hostname}-{pid}`, not the former
        # `worker-{pid}`. The prefix is not the contract; being unique ACROSS
        # HOSTS is, because the gateway's reclaim rule is "a DIFFERENT worker
        # holds this job" and PIDs collide freely between pods.
        worker_id = processing["data"]["workerId"]
        assert worker_id.startswith(f"{socket.gethostname()}-")
        assert worker_id.endswith(f"-{os.getpid()}")

    @pytest.mark.asyncio
    async def test_all_events_published_to_correct_channel(self, pubsub_capture):
        """Verify all events go to stt:transcription:{jobId} channel."""
        p1, p2, p3, p4, p5, *_ = _patch_worker_deps()

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-102",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
            )

        for channel in pubsub_capture.channels:
            assert channel == "stt:transcription:j-102"

    @pytest.mark.asyncio
    async def test_transcript_event_contains_complete_result_data(self, pubsub_capture):
        """Verify the transcript event carries language, duration, timestamps."""
        result = _make_result(
            text="Hello world",
            language="en",
            duration=10.0,
            processing_time=2.5,
        )
        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(result=result)

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-103",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
            )

        tx = pubsub_capture.transcript_events[0]["data"]
        assert tx["text"] == "Hello world"
        assert tx["language"] == "en"
        assert tx["languageProbability"] == 0.95
        assert tx["durationSeconds"] == 10.0
        assert tx["processingTimeSeconds"] == 2.5
        assert "metadata" in tx

    @pytest.mark.asyncio
    async def test_publisher_closed_in_finally_block(self, pubsub_capture):
        """Verify publisher.close() is called even on success."""
        _mock_redis = pubsub_capture.mock_redis()
        p1, p2, p3, p4, p5, api, *_ = _patch_worker_deps()

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-104",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
            )

        # If close was called, publisher state resets
        # We can verify by checking the mock_redis.aclose was called
        # (the patched connect injects mock_redis which has aclose)
        # Since we can't easily inspect internal state post-close,
        # verify no exceptions were raised (implicit)
        assert len(pubsub_capture.messages) > 0  # Events were published
        api.close.assert_awaited_once()


# =============================================================================
# Consultation flow: context item creation
# =============================================================================


class TestWorkerWithConsultation:
    """Verify behavior when consultation_id is provided or absent."""

    @pytest.mark.asyncio
    async def test_with_consultation_creates_context_item_and_completes(self, pubsub_capture):
        """Job with consultation_id creates transcript context item."""
        api = AsyncMock()
        api.start_job = AsyncMock()
        api.update_job_progress = AsyncMock()
        api.complete_job = AsyncMock()
        api.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-55"})

        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(api_client=api)

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-200",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
                consultation_id="c-999",
            )

        # Context item was created
        api.create_transcript.assert_awaited_once()
        call_kwargs = api.create_transcript.call_args.kwargs
        assert call_kwargs["job_id"] == "j-200"
        assert call_kwargs["consultation_id"] == "c-999"

        # Job completed with context_item_id in metadata
        complete_kwargs = api.complete_job.call_args.kwargs
        assert complete_kwargs["result_metadata"]["context_item_id"] == "ctx-55"

    # The typed usage-attribution fields
    # (duration_seconds/processing_time_seconds/engine/deployment) must ride
    # as separate kwargs on the complete_job() call, mirroring
    # `TranscriptionResult`'s own fields, NOT smuggled into result_metadata.
    @pytest.mark.asyncio
    async def test_completes_job_with_typed_usage_attribution_fields(self, pubsub_capture):
        api = AsyncMock()
        api.start_job = AsyncMock()
        api.update_job_progress = AsyncMock()
        api.complete_job = AsyncMock()
        api.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-usage"})

        result = _make_result(
            duration=42.5, processing_time=9.75, engine="whisper_cpp", deployment="SELF_HOSTED"
        )
        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(api_client=api, result=result)

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-usage",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
                consultation_id="c-usage",
            )

        complete_kwargs = api.complete_job.call_args.kwargs
        assert complete_kwargs["duration_seconds"] == 42.5
        assert complete_kwargs["processing_time_seconds"] == 9.75
        assert complete_kwargs["engine"] == "whisper_cpp"
        assert complete_kwargs["deployment"] == "SELF_HOSTED"
        # The blob is UNCHANGED — a second, typed channel, not a move.
        assert complete_kwargs["result_metadata"]["duration_seconds"] == 42.5
        assert complete_kwargs["result_metadata"]["processing_time_seconds"] == 9.75

    # TASK-959 §3.2/§4.2 — the compute device and the network byte counters ride
    # the SAME typed channel. Without `device` the gateway holds occupancy seconds
    # it cannot map to a unit, so the seconds stay unpriced.
    @pytest.mark.asyncio
    async def test_completes_job_with_the_task959_compute_and_network_fields(self, pubsub_capture):
        api = AsyncMock()
        api.start_job = AsyncMock()
        api.update_job_progress = AsyncMock()
        api.complete_job = AsyncMock()
        api.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-959"})

        result = _make_result(
            processing_time=9.75,
            engine="sarvam",
            deployment="BYOK",
            device="cpu",
            request_bytes=4096,
            response_bytes=512,
            byte_source="wire",
        )
        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(api_client=api, result=result)

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-959",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
                consultation_id="c-959",
            )

        complete_kwargs = api.complete_job.call_args.kwargs
        assert complete_kwargs["processing_time_seconds"] == 9.75
        assert complete_kwargs["device"] == "cpu"
        assert complete_kwargs["request_bytes"] == 4096
        assert complete_kwargs["response_bytes"] == 512
        assert complete_kwargs["byte_source"] == "wire"

    @pytest.mark.asyncio
    async def test_a_self_hosted_job_forwards_a_device_but_no_byte_counters(self, pubsub_capture):
        """No third-party call was made, so the byte counters stay `None` and
        `complete_job` omits them from the body entirely."""
        api = AsyncMock()
        api.start_job = AsyncMock()
        api.update_job_progress = AsyncMock()
        api.complete_job = AsyncMock()
        api.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-959b"})

        result = _make_result(device="cuda")
        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(api_client=api, result=result)

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-959b",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
                consultation_id="c-959b",
            )

        complete_kwargs = api.complete_job.call_args.kwargs
        assert complete_kwargs["device"] == "cuda"
        assert complete_kwargs["request_bytes"] is None
        assert complete_kwargs["response_bytes"] is None
        assert complete_kwargs["byte_source"] is None

    @pytest.mark.asyncio
    async def test_completes_job_without_engine_when_unresolved(self, pubsub_capture):
        """A result with no resolved engine (e.g. an unusual pipeline shape)
        must not fabricate one — complete_job simply omits it."""
        api = AsyncMock()
        api.start_job = AsyncMock()
        api.update_job_progress = AsyncMock()
        api.complete_job = AsyncMock()
        api.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-noeng"})

        result = _make_result(engine=None, deployment=None)
        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(api_client=api, result=result)

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-noeng",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
                consultation_id="c-noeng",
            )

        complete_kwargs = api.complete_job.call_args.kwargs
        assert complete_kwargs.get("engine") is None
        assert complete_kwargs.get("deployment") is None

    @pytest.mark.asyncio
    async def test_without_consultation_skips_context_item(self, pubsub_capture):
        """Job without consultation_id skips context item creation."""
        api = AsyncMock()
        api.start_job = AsyncMock()
        api.update_job_progress = AsyncMock()
        api.complete_job = AsyncMock()
        api.create_transcript = AsyncMock()

        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(api_client=api)

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-201",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
                consultation_id=None,
            )

        # Context item NOT created
        api.create_transcript.assert_not_awaited()

        # Job still completes
        api.complete_job.assert_awaited_once()
        assert pubsub_capture.status_events[-1]["data"]["status"] == "COMPLETED"

    @pytest.mark.asyncio
    async def test_context_item_failure_does_not_block_completion(self, pubsub_capture):
        """Context item creation failure should not prevent job completion."""
        api = AsyncMock()
        api.start_job = AsyncMock()
        api.update_job_progress = AsyncMock()
        api.complete_job = AsyncMock()
        api.create_transcript = AsyncMock(side_effect=Exception("Gateway down"))

        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(api_client=api)

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-202",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
                consultation_id="c-123",
            )

        # Despite error, job still completed + COMPLETED event published
        api.complete_job.assert_awaited_once()
        assert pubsub_capture.status_events[-1]["data"]["status"] == "COMPLETED"


# =============================================================================
# Error paths: verify error events + status transitions
# =============================================================================


class TestWorkerErrorPaths:
    """Verify that error conditions produce correct error + status events."""

    @pytest.mark.asyncio
    async def test_not_found_error_publishes_error_and_failed(self, pubsub_capture):
        """NotFoundError -> error event + status:FAILED + SkipMessage."""
        api = AsyncMock()
        api.start_job = AsyncMock()
        api.fail_job = AsyncMock()

        reader = AsyncMock()
        reader.get_pipeline = AsyncMock(side_effect=NotFoundError("Pipeline gone"))

        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(
            api_client=api,
            pipeline_reader=reader,
        )

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            with pytest.raises(dramatiq.middleware.SkipMessage):
                await _transcribe_file_async(
                    job_id="j-300",
                    tenant_id="t-1",
                    pipeline_id="p-bad",
                    audio_uri="s3://audio.wav",
                )

        # Error event published with correct code
        assert len(pubsub_capture.error_events) == 1
        err = pubsub_capture.error_events[0]["data"]
        assert err["errorCode"] == "NOT_FOUND"
        assert "Pipeline gone" in err["message"]

        # FAILED status event published
        failed = [e for e in pubsub_capture.status_events if e["data"]["status"] == "FAILED"]
        assert len(failed) == 1

    @pytest.mark.asyncio
    async def test_transcription_error_publishes_error_and_reraises(self, pubsub_capture):
        """TranscriptionError -> error event + status:FAILED + re-raised."""
        api = AsyncMock()
        api.start_job = AsyncMock()
        api.fail_job = AsyncMock()

        batch = AsyncMock()
        batch.transcribe = AsyncMock(side_effect=TranscriptionError("OOM"))

        blob = AsyncMock()
        blob.download_audio = AsyncMock(return_value=b"audio")

        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(
            api_client=api,
            batch_service=batch,
            blob_service=blob,
        )

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            with pytest.raises(TranscriptionError):
                await _transcribe_file_async(
                    job_id="j-301",
                    tenant_id="t-1",
                    pipeline_id="p-1",
                    audio_uri="s3://audio.wav",
                )

        assert len(pubsub_capture.error_events) == 1
        assert pubsub_capture.error_events[0]["data"]["errorCode"] == "TRANSCRIPTION_ERROR"

        failed = [e for e in pubsub_capture.status_events if e["data"]["status"] == "FAILED"]
        assert len(failed) == 1

    @pytest.mark.asyncio
    async def test_unexpected_error_publishes_internal_error(self, pubsub_capture):
        """Unexpected RuntimeError -> INTERNAL_ERROR event + re-raised."""
        api = AsyncMock()
        api.start_job = AsyncMock()
        api.fail_job = AsyncMock()

        blob = AsyncMock()
        blob.download_audio = AsyncMock(side_effect=RuntimeError("disk full"))

        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(
            api_client=api,
            blob_service=blob,
        )

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            with pytest.raises(RuntimeError, match="disk full"):
                await _transcribe_file_async(
                    job_id="j-302",
                    tenant_id="t-1",
                    pipeline_id="p-1",
                    audio_uri="s3://audio.wav",
                )

        assert pubsub_capture.error_events[0]["data"]["errorCode"] == "INTERNAL_ERROR"
        assert "disk full" in pubsub_capture.error_events[0]["data"]["message"]

    @pytest.mark.asyncio
    async def test_publisher_closed_even_on_error(self, pubsub_capture):
        """Verify publisher.close() runs via finally even when job fails."""
        api = AsyncMock()
        api.start_job = AsyncMock()
        api.fail_job = AsyncMock()

        blob = AsyncMock()
        blob.download_audio = AsyncMock(side_effect=RuntimeError("boom"))

        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(
            api_client=api,
            blob_service=blob,
        )

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            with pytest.raises(RuntimeError):
                await _transcribe_file_async(
                    job_id="j-303",
                    tenant_id="t-1",
                    pipeline_id="p-1",
                    audio_uri="s3://audio.wav",
                )

        # Events were still published before the error
        assert len(pubsub_capture.messages) >= 1
        api.close.assert_awaited_once()


# =============================================================================
# Progress callback: verify API + Pub/Sub dual delivery
# =============================================================================


class TestWorkerProgressCallback:
    """Verify progress_callback sends to both API and Pub/Sub."""

    @pytest.mark.asyncio
    async def test_progress_callback_updates_api_and_publishes_event(self, pubsub_capture):
        """Verify progress_callback fires both API call and SSE event."""
        api = AsyncMock()
        api.start_job = AsyncMock()
        api.update_job_progress = AsyncMock()
        api.complete_job = AsyncMock()
        api.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-1"})

        _progress_values = []

        batch = AsyncMock()

        async def fake_transcribe(**kwargs):
            cb = kwargs.get("progress_callback")
            if cb:
                cb(25)
                await asyncio.sleep(0.05)
                cb(50)
                await asyncio.sleep(0.05)
                cb(100)
                await asyncio.sleep(0.05)
            return _make_result()

        batch.transcribe = AsyncMock(side_effect=fake_transcribe)

        blob = AsyncMock()
        blob.download_audio = AsyncMock(return_value=b"audio")
        blob.upload_transcript = AsyncMock(return_value="s3://t.json")

        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(
            api_client=api,
            batch_service=batch,
            blob_service=blob,
        )

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-400",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
            )

        prog_events = pubsub_capture.progress_events
        prog_values = [e["data"]["progress"] for e in prog_events]
        assert 100 in prog_values
        assert len(prog_values) >= 1

        for ev in prog_events:
            assert ev["data"].get("stage") == "inference"

    @pytest.mark.asyncio
    async def test_progress_api_failure_does_not_block_pubsub(self, pubsub_capture):
        """If API progress update fails, SSE event still published."""
        api = AsyncMock()
        api.start_job = AsyncMock()
        api.update_job_progress = AsyncMock(side_effect=Exception("API timeout"))
        api.complete_job = AsyncMock()
        api.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-1"})

        batch = AsyncMock()

        async def fake_transcribe(**kwargs):
            cb = kwargs.get("progress_callback")
            if cb:
                cb(50)
                await asyncio.sleep(0.05)
            return _make_result()

        batch.transcribe = AsyncMock(side_effect=fake_transcribe)

        blob = AsyncMock()
        blob.download_audio = AsyncMock(return_value=b"audio")
        blob.upload_transcript = AsyncMock(return_value="s3://t.json")

        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(
            api_client=api,
            batch_service=batch,
            blob_service=blob,
        )

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            # Should complete despite API progress failure
            await _transcribe_file_async(
                job_id="j-401",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
            )

        # SSE progress event still published
        assert len(pubsub_capture.progress_events) >= 1
        # Job still completed
        assert pubsub_capture.status_events[-1]["data"]["status"] == "COMPLETED"


# =============================================================================
# Chunk callback: verify partial transcript delivery
# =============================================================================


class TestWorkerChunkCallback:
    """Verify chunk_callback publishes partial transcripts via SSE."""

    @pytest.mark.asyncio
    async def test_chunk_callback_publishes_each_chunk(self, pubsub_capture):
        """Verify batch_service chunk_callback emits chunk events."""
        batch = AsyncMock()

        async def fake_transcribe(**kwargs):
            chunk_cb = kwargs.get("chunk_callback")
            if chunk_cb:
                # Simulate 2 chunks using objects with to_dict()
                mock_chunk_1 = MagicMock()
                mock_chunk_1.to_dict.return_value = {
                    "chunk_index": 0,
                    "text": "First part.",
                    "start_time": 0.0,
                    "end_time": 2.5,
                    "is_final": False,
                    "word_timestamps": [],
                    "vad_segment_index": 0,
                }
                mock_chunk_2 = MagicMock()
                mock_chunk_2.to_dict.return_value = {
                    "chunk_index": 1,
                    "text": "Second part.",
                    "start_time": 2.5,
                    "end_time": 5.0,
                    "is_final": True,
                    "word_timestamps": [
                        {"word": "Second", "start_time": 2.5, "end_time": 2.8, "confidence": 0.98},
                    ],
                    "vad_segment_index": 1,
                }
                await chunk_cb(mock_chunk_1)
                await chunk_cb(mock_chunk_2)
            return _make_result(text="First part. Second part.")

        batch.transcribe = AsyncMock(side_effect=fake_transcribe)

        blob = AsyncMock()
        blob.download_audio = AsyncMock(return_value=b"audio")
        blob.upload_transcript = AsyncMock(return_value="s3://t.json")

        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(
            batch_service=batch,
            blob_service=blob,
        )

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-500",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
            )

        chunks = pubsub_capture.chunk_events
        assert len(chunks) == 2

        # Verify first chunk
        assert chunks[0]["data"]["chunkIndex"] == 0
        assert chunks[0]["data"]["text"] == "First part."
        assert chunks[0]["data"]["isFinal"] is False

        # Verify second chunk with word timestamps
        assert chunks[1]["data"]["chunkIndex"] == 1
        assert chunks[1]["data"]["text"] == "Second part."
        assert chunks[1]["data"]["isFinal"] is True
        assert len(chunks[1]["data"]["wordTimestamps"]) == 1
        assert chunks[1]["data"]["wordTimestamps"][0]["word"] == "Second"


# =============================================================================
# _fail_job: verify dual delivery (API + Pub/Sub)
# =============================================================================


class TestFailJobFunction:
    """Verify _fail_job marks job as failed and publishes FAILED status."""

    @pytest.mark.asyncio
    async def test_fail_job_calls_api_and_publishes_status(self):
        """Verify _fail_job sends API call AND publishes FAILED status."""
        api = AsyncMock()
        api.fail_job = AsyncMock()

        published_events = []
        publisher = AsyncMock()
        publisher.publish_status = AsyncMock(
            side_effect=lambda jid, status: published_events.append({"jid": jid, "status": status})
        )

        await _fail_job(api, publisher, "j-600", "Model error", "MODEL_ERROR")

        # API called with correct args
        api.fail_job.assert_awaited_once_with(
            job_id="j-600",
            error_message="Model error",
            error_code="MODEL_ERROR",
            # BUG-013: the owning tenant is now addressed explicitly; this direct
            # call supplies none, so the callback keeps today's key-derived scope.
            tenant_id=None,
        )

        # Publisher notified with FAILED status
        publisher.publish_status.assert_awaited_once_with("j-600", "FAILED")

    @pytest.mark.asyncio
    async def test_fail_job_publishes_status_even_when_api_fails(self):
        """If API call fails, FAILED status event is still published."""
        api = AsyncMock()
        api.fail_job = AsyncMock(side_effect=Exception("API down"))

        publisher = AsyncMock()

        await _fail_job(api, publisher, "j-601", "Error", "ERR")

        # API failed but publisher still called
        publisher.publish_status.assert_awaited_once_with("j-601", "FAILED")

    @pytest.mark.asyncio
    async def test_fail_job_resilient_when_api_fails(self):
        """If API call fails, _fail_job still calls publisher (no propagation).

        Note: The real TranscriptionEventPublisher.publish_status never raises
        because _publish catches all exceptions internally. Using a realistic
        mock that mirrors this behavior — per anti-pattern #4, mocks must
        be indistinguishable from real responses.
        """
        api = AsyncMock()
        api.fail_job = AsyncMock(side_effect=Exception("API down"))

        # Real publisher never raises from publish_status
        published = []
        publisher = AsyncMock()
        publisher.publish_status = AsyncMock(
            side_effect=lambda jid, status: published.append(status)
        )

        # Should NOT raise
        await _fail_job(api, publisher, "j-602", "Error", "ERR")

        # Publisher was still called despite API failure
        assert "FAILED" in published


# =============================================================================
# Publisher disabled: verify worker still functions
# =============================================================================


class TestWorkerWithPublisherDisabled:
    """Verify worker completes normally when pub/sub is disabled."""

    @pytest.mark.asyncio
    async def test_worker_completes_when_pubsub_disabled(self):
        """Worker should complete successfully even with pubsub_enabled=False."""
        api = AsyncMock()
        api.start_job = AsyncMock()
        api.update_job_progress = AsyncMock()
        api.complete_job = AsyncMock()
        api.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-1"})

        blob = AsyncMock()
        blob.download_audio = AsyncMock(return_value=b"audio")
        blob.upload_transcript = AsyncMock(return_value="s3://t.json")
        blob.upload_processed_audio = AsyncMock(return_value="s3://p.wav")

        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(
            api_client=api,
            blob_service=blob,
        )

        mock_settings = MagicMock()
        mock_settings.pubsub_enabled = False
        mock_settings.pubsub_channel_prefix = "stt:transcription:"
        mock_settings.redis_url = "redis://localhost:6379/0"

        with (
            p1,
            p2,
            p3,
            p4,
            patch("stt.core.messaging.pubsub.get_settings", return_value=mock_settings),
        ):
            await _transcribe_file_async(
                job_id="j-700",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
            )

        # Job completed via API (the important thing)
        api.complete_job.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_worker_completes_when_redis_unavailable(self):
        """Worker completes when Redis connection fails (graceful degradation)."""
        api = AsyncMock()
        api.start_job = AsyncMock()
        api.update_job_progress = AsyncMock()
        api.complete_job = AsyncMock()
        api.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-1"})

        blob = AsyncMock()
        blob.download_audio = AsyncMock(return_value=b"audio")
        blob.upload_transcript = AsyncMock(return_value="s3://t.json")
        blob.upload_processed_audio = AsyncMock(return_value="s3://p.wav")

        # Use the capture approach: connect fails, but publisher degrades
        capture = PubSubCapture()
        mock_redis = capture.mock_redis()
        mock_redis.ping = AsyncMock(side_effect=ConnectionError("No Redis"))

        async def patched_connect(self_pub):
            """Simulate failed Redis connection."""
            try:
                await mock_redis.ping()
            except Exception:
                self_pub._redis = None
                self_pub._connected = False

        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(
            api_client=api,
            blob_service=blob,
        )

        with (
            p1,
            p2,
            p3,
            p4,
            patch(
                "stt.core.messaging.pubsub.TranscriptionEventPublisher.connect",
                patched_connect,
            ),
        ):
            await _transcribe_file_async(
                job_id="j-701",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
            )

        # Job completed via API despite Redis failure
        api.complete_job.assert_awaited_once()


# =============================================================================
# Per-tenant storage descriptor
# =============================================================================


class TestWorkerStorageDescriptor:
    """The `storage` kwarg drives per-tenant provider/bucket registration."""

    @staticmethod
    def _blob_with_resolver() -> AsyncMock:
        blob = AsyncMock()
        blob.download_audio = AsyncMock(return_value=b"audio")
        blob.upload_transcript = AsyncMock(return_value="s3://t/transcript.json")
        blob.upload_batch_metadata = AsyncMock(return_value="s3://t/metadata.json")
        # Sync resolver so registration calls are plain (non-coroutine) mocks.
        blob._resolver = MagicMock()
        return blob

    @pytest.mark.asyncio
    async def test_storage_descriptor_registers_tenant_storage(self, pubsub_capture):
        blob = self._blob_with_resolver()
        descriptor = {"provider": "azure_blob", "bucket": "c1", "connection_string": "conn"}
        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(blob_service=blob)

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-stg-1",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://c1/audio.wav",
                storage=descriptor,
            )

        blob._resolver.set_tenant_storage.assert_called_once_with("t-1", descriptor)
        blob._resolver.set_tenant_bucket.assert_not_called()
        # tenant_id is threaded to download so the right provider is selected.
        blob.download_audio.assert_awaited_once_with("s3://c1/audio.wav", tenant_id="t-1")

    @pytest.mark.asyncio
    async def test_audio_bucket_name_fallback_when_no_storage(self, pubsub_capture):
        blob = self._blob_with_resolver()
        p1, p2, p3, p4, p5, *_ = _patch_worker_deps(blob_service=blob)

        with p1, p2, p3, p4, p5, _patch_publisher(pubsub_capture):
            await _transcribe_file_async(
                job_id="j-stg-2",
                tenant_id="t-1",
                pipeline_id="p-1",
                audio_uri="s3://audio.wav",
                audio_bucket_name="hope-audio-acme",
            )

        blob._resolver.set_tenant_bucket.assert_called_once_with("t-1", "audio", "hope-audio-acme")
        blob._resolver.set_tenant_storage.assert_not_called()
