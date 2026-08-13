"""Batch fallback dispatch tests.

Verifies ``_transcribe_file_async``:
- re-dispatches ONCE on the configured fallback pipeline on a retryable cloud
  ASR / model error, stamping ``usedFallbackPipelineId``;
- goes straight to the fallback on ``CloudASRAuthError``;
- is byte-identical to today when NO fallback is configured (regression lock:
  the error propagates, no second transcribe, job fails).

Only external boundaries are mocked (api client, blob, pipeline reader, batch
service, publisher, effective-config pull). The fallback branch under test is
real.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt.core.exceptions import CloudASRAuthError, CloudASRTranscriptionError
from stt.transcription.dto import TranscriptionResult
from stt.transcription.workers.transcribe_file import (
    _transcribe_file_async,
    transcribe_file,
)


def _make_result(text: str = "ok", pipeline_id: str = "p-primary") -> TranscriptionResult:
    return TranscriptionResult(
        text=text,
        language="en",
        language_probability=0.9,
        duration_seconds=3.0,
        processing_time_seconds=0.5,
        word_timestamps=[],
        sentence_timestamps=[],
        segments=[],
        metadata={"pipeline_id": pipeline_id},
    )


def _pipeline_config(name: str) -> MagicMock:
    pc = MagicMock(name=name)
    pc.spec.inference.language = None
    return pc


def _harness(*, reader: AsyncMock, batch: AsyncMock, overrides: dict | None = None):
    """Patch every external boundary of the worker; return the patch CMs."""
    api = AsyncMock()
    api.start_job = AsyncMock()
    api.update_job_progress = AsyncMock()
    api.complete_job = AsyncMock()
    api.fail_job = AsyncMock()
    api.get_job_status = AsyncMock(return_value="PROCESSING")
    api.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-1"})
    api.close = AsyncMock()

    blob = AsyncMock()
    blob.download_audio = AsyncMock(return_value=b"audio")
    blob.upload_transcript = AsyncMock(return_value="s3://t/transcript.json")
    blob.upload_batch_metadata = AsyncMock(return_value="s3://t/metadata.json")
    blob._resolver = MagicMock()

    settings = MagicMock()
    settings.pubsub_enabled = False

    eff_client = MagicMock()
    eff_client.get_provider_overrides = AsyncMock(return_value=overrides or {})

    publisher = AsyncMock()

    return (
        patch("stt.transcription.workers.transcribe_file.get_api_client", return_value=api),
        patch("stt.transcription.workers.transcribe_file.get_blob_service", return_value=blob),
        patch("stt.transcription.workers.transcribe_file.get_pipeline_reader", return_value=reader),
        patch("stt.transcription.workers.transcribe_file.get_batch_service", return_value=batch),
        patch("stt.transcription.workers.transcribe_file.get_settings", return_value=settings),
        patch(
            "stt.transcription.workers.transcribe_file.get_effective_config_client",
            return_value=eff_client,
        ),
        patch(
            "stt.transcription.workers.transcribe_file.TranscriptionEventPublisher",
            return_value=publisher,
        ),
        api,
        batch,
    )


@pytest.mark.asyncio
async def test_retryable_cloud_error_redispatches_on_fallback():
    primary_pc = _pipeline_config("primary")
    fallback_pc = _pipeline_config("fallback")
    reader = AsyncMock()
    reader.get_pipeline = AsyncMock(side_effect=[primary_pc, fallback_pc])

    fallback_result = _make_result(text="fallback text", pipeline_id="p-fallback")
    batch = AsyncMock()
    # First (primary) raises retryable; second (fallback) succeeds.
    batch.transcribe = AsyncMock(side_effect=[CloudASRTranscriptionError("5xx"), fallback_result])

    p1, p2, p3, p4, p5, p6, p7, api, _batch = _harness(reader=reader, batch=batch)
    with p1, p2, p3, p4, p5, p6, p7:
        await _transcribe_file_async(
            job_id="j-1",
            tenant_id="t-1",
            pipeline_id="p-primary",
            audio_uri="s3://a.wav",
            fallback_pipeline_id="p-fallback",
        )

    # transcribe called twice: primary then fallback.
    assert batch.transcribe.await_count == 2
    assert batch.transcribe.await_args_list[1].kwargs["pipeline_config"] is fallback_pc
    # Result stamped with the fallback lineage + job completed on it.
    assert fallback_result.metadata["usedFallbackPipelineId"] == "p-fallback"
    api.complete_job.assert_awaited_once()
    api.fail_job.assert_not_awaited()


@pytest.mark.asyncio
async def test_auth_error_goes_straight_to_fallback():
    primary_pc = _pipeline_config("primary")
    fallback_pc = _pipeline_config("fallback")
    reader = AsyncMock()
    reader.get_pipeline = AsyncMock(side_effect=[primary_pc, fallback_pc])

    fallback_result = _make_result(pipeline_id="p-fallback")
    batch = AsyncMock()
    batch.transcribe = AsyncMock(side_effect=[CloudASRAuthError("401"), fallback_result])

    p1, p2, p3, p4, p5, p6, p7, api, _batch = _harness(reader=reader, batch=batch)
    with p1, p2, p3, p4, p5, p6, p7:
        await _transcribe_file_async(
            job_id="j-2",
            tenant_id="t-1",
            pipeline_id="p-primary",
            audio_uri="s3://a.wav",
            fallback_pipeline_id="p-fallback",
        )

    assert batch.transcribe.await_count == 2
    assert fallback_result.metadata["usedFallbackPipelineId"] == "p-fallback"


@pytest.mark.asyncio
async def test_no_fallback_propagates_error_unchanged():
    primary_pc = _pipeline_config("primary")
    reader = AsyncMock()
    reader.get_pipeline = AsyncMock(return_value=primary_pc)

    batch = AsyncMock()
    batch.transcribe = AsyncMock(side_effect=CloudASRTranscriptionError("5xx"))

    p1, p2, p3, p4, p5, p6, p7, api, _batch = _harness(reader=reader, batch=batch)
    with p1, p2, p3, p4, p5, p6, p7:
        with pytest.raises(CloudASRTranscriptionError):
            await _transcribe_file_async(
                job_id="j-3",
                tenant_id="t-1",
                pipeline_id="p-primary",
                audio_uri="s3://a.wav",
                # no fallback_pipeline_id
            )

    # Regression lock: exactly one transcribe attempt, job failed, no completion.
    assert batch.transcribe.await_count == 1
    api.fail_job.assert_awaited()
    api.complete_job.assert_not_awaited()


@pytest.mark.asyncio
async def test_success_path_never_touches_fallback():
    primary_pc = _pipeline_config("primary")
    reader = AsyncMock()
    reader.get_pipeline = AsyncMock(return_value=primary_pc)

    batch = AsyncMock()
    batch.transcribe = AsyncMock(return_value=_make_result())

    p1, p2, p3, p4, p5, p6, p7, api, _batch = _harness(reader=reader, batch=batch)
    with p1, p2, p3, p4, p5, p6, p7:
        await _transcribe_file_async(
            job_id="j-4",
            tenant_id="t-1",
            pipeline_id="p-primary",
            audio_uri="s3://a.wav",
            fallback_pipeline_id="p-fallback",
        )

    # Fallback configured but never used on the happy path.
    assert batch.transcribe.await_count == 1
    api.complete_job.assert_awaited_once()


# ---------------------------------------------------------------------------
# The gateway↔worker wire contract for the fallback.
#
# The tests above call `_transcribe_file_async` directly, so they proved the
# fallback BRANCH worked while nothing in production ever reached it: the API
# gateway's Dramatiq dispatch never sent `fallback_pipeline_id` at all.
#
# It now rides as a KWARG next to `storage`, with the same 10 positional args
# as before. This locks that exact shape against the actor's signature — a
# renamed kwarg or a changed positional count silently disables batch fallback
# again, which is precisely how it stayed dead originally.
# ---------------------------------------------------------------------------

# The positional args the gateway emits, in order (transcriptionRealtime.service.ts):
# job_id, tenant_id, pipeline_id, audio_uri, consultation_id, media_id,
# language, code_switching, audio_bucket_name, user_id
_GATEWAY_POSITIONAL_ARGS = (
    "job-1",
    "tenant-1",
    "p-primary",
    "s3://hope-audio/x.wav",
    None,
    None,
    None,
    None,
    "hope-audio",
    "user-1",
)


def _invoke_actor(**kwargs):
    """Call the actor body the way Dramatiq does, capturing the forwarded call."""
    with (
        # MagicMock, not the AsyncMock `patch` would autospec for an async def:
        # `run_on_worker_loop` is mocked too, so a real coroutine here would be
        # created and never awaited (a RuntimeWarning, not a failure).
        patch(
            "stt.transcription.workers.transcribe_file._transcribe_file_async",
            new_callable=MagicMock,
        ) as inner,
        patch("stt.transcription.workers.transcribe_file.run_on_worker_loop"),
        patch("stt.transcription.workers.transcribe_file.refresh_job_concurrency_limit"),
    ):
        transcribe_file.fn(*_GATEWAY_POSITIONAL_ARGS, **kwargs)
    return inner.call_args.kwargs


def test_actor_binds_the_gateway_fallback_kwarg():
    forwarded = _invoke_actor(fallback_pipeline_id="p-fallback")

    assert forwarded["fallback_pipeline_id"] == "p-fallback"
    # The positional tail still lands where the signature expects it.
    assert forwarded["audio_bucket_name"] == "hope-audio"
    assert forwarded["user_id"] == "user-1"


def test_actor_binds_fallback_and_storage_together():
    # Both are kwargs; a DEDICATED tenant sends both in the same message.
    forwarded = _invoke_actor(
        fallback_pipeline_id="p-fallback",
        storage={"provider": "s3", "bucket": "tenant-bucket"},
    )

    assert forwarded["fallback_pipeline_id"] == "p-fallback"
    assert forwarded["storage"] == {"provider": "s3", "bucket": "tenant-bucket"}


def test_actor_defaults_the_fallback_to_none_when_absent():
    forwarded = _invoke_actor()

    assert forwarded["fallback_pipeline_id"] is None
