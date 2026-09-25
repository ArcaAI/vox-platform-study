"""Batch fallback dispatch tests.

Verifies ``_transcribe_file_async``:
- re-dispatches ONCE on the resolved spec's fallback chain on a retryable cloud
  ASR / model error, stamping ``usedFallbackPipelineId`` with that chain's
  runtime key;
- goes straight to the fallback on ``CloudASRAuthError``;
- is byte-identical to today when the spec declares NO fallback (regression lock:
  the error propagates, no second transcribe, job fails).

TASK-1006 — the fallback is the spec's own ``fallback`` chain and nothing else; the
pre-agent tenant pointer (``fallback_pipeline_id``) and the pipeline reader behind
it are gone. Only external boundaries are mocked (api client, blob, batch service,
publisher, effective-config pull). The fallback branch under test is real.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt.core.exceptions import CloudASRAuthError, CloudASRTranscriptionError
from stt.transcription.dto import TranscriptionResult
from stt.transcription.workers.transcribe_file import _transcribe_file_async
from tests.helpers.resolved_spec import FALLBACK_KEY, resolved_spec

_PRIMARY_ASR = "arcaai-whisper-large-ml-en-gguf"
_FALLBACK_ASR = "faster-whisper-large-v3-turbo-int8"


def _make_result(text: str = "ok") -> TranscriptionResult:
    return TranscriptionResult(
        text=text,
        language="en",
        language_probability=0.9,
        duration_seconds=3.0,
        processing_time_seconds=0.5,
        word_timestamps=[],
        sentence_timestamps=[],
        segments=[],
        metadata={},
    )


def _harness(*, batch: AsyncMock, overrides: dict | None = None):
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
    )


def _asr_slug(call) -> str:
    return call.kwargs["pipeline_config"].spec.models.asr.slug


@pytest.mark.asyncio
async def test_retryable_cloud_error_redispatches_on_fallback():
    fallback_result = _make_result(text="fallback text")
    batch = AsyncMock()
    # First (primary) raises retryable; second (fallback) succeeds.
    batch.transcribe = AsyncMock(side_effect=[CloudASRTranscriptionError("5xx"), fallback_result])

    p1, p2, p3, p4, p5, p6, api = _harness(batch=batch)
    with p1, p2, p3, p4, p5, p6:
        await _transcribe_file_async(
            job_id="j-1", tenant_id="t-1", audio_uri="s3://a.wav", resolved_spec=resolved_spec()
        )

    # transcribe called twice: primary then the spec's fallback chain.
    assert batch.transcribe.await_count == 2
    first, second = batch.transcribe.await_args_list
    assert _asr_slug(first) == _PRIMARY_ASR
    assert _asr_slug(second) == _FALLBACK_ASR
    # Result stamped with the fallback lineage + job completed on it.
    assert fallback_result.metadata["usedFallbackPipelineId"] == FALLBACK_KEY
    api.complete_job.assert_awaited_once()
    api.fail_job.assert_not_awaited()


@pytest.mark.asyncio
async def test_auth_error_goes_straight_to_fallback():
    fallback_result = _make_result()
    batch = AsyncMock()
    batch.transcribe = AsyncMock(side_effect=[CloudASRAuthError("401"), fallback_result])

    p1, p2, p3, p4, p5, p6, api = _harness(batch=batch)
    with p1, p2, p3, p4, p5, p6:
        await _transcribe_file_async(
            job_id="j-2", tenant_id="t-1", audio_uri="s3://a.wav", resolved_spec=resolved_spec()
        )

    assert batch.transcribe.await_count == 2
    assert fallback_result.metadata["usedFallbackPipelineId"] == FALLBACK_KEY


@pytest.mark.asyncio
async def test_no_fallback_propagates_error_unchanged():
    batch = AsyncMock()
    batch.transcribe = AsyncMock(side_effect=CloudASRTranscriptionError("5xx"))

    p1, p2, p3, p4, p5, p6, api = _harness(batch=batch)
    with p1, p2, p3, p4, p5, p6:
        with pytest.raises(CloudASRTranscriptionError):
            await _transcribe_file_async(
                job_id="j-3",
                tenant_id="t-1",
                audio_uri="s3://a.wav",
                resolved_spec=resolved_spec(fallback=None),
            )

    # Regression lock: exactly one transcribe attempt, job failed, no completion.
    assert batch.transcribe.await_count == 1
    api.fail_job.assert_awaited()
    api.complete_job.assert_not_awaited()


@pytest.mark.asyncio
async def test_success_path_never_touches_fallback():
    batch = AsyncMock()
    batch.transcribe = AsyncMock(return_value=_make_result())

    p1, p2, p3, p4, p5, p6, api = _harness(batch=batch)
    with p1, p2, p3, p4, p5, p6:
        await _transcribe_file_async(
            job_id="j-4", tenant_id="t-1", audio_uri="s3://a.wav", resolved_spec=resolved_spec()
        )

    # Fallback declared but never used on the happy path.
    assert batch.transcribe.await_count == 1
    assert _asr_slug(batch.transcribe.await_args) == _PRIMARY_ASR
    api.complete_job.assert_awaited_once()


# ---------------------------------------------------------------------------
# The gateway↔worker wire contract.
#
# The gateway emits the same 10 positional args it always has — TASK-1006 turns the
# third (the pre-agent `pipeline_id`) into a dead slot it fills with `null` — and
# rides the spec and the storage descriptor as KWARGS. This locks that exact shape
# against the actor's signature: the fallback now travels INSIDE `resolved_spec`.
# ---------------------------------------------------------------------------

# job_id, tenant_id, <dead pipeline_id slot>, audio_uri, consultation_id, media_id,
# language, <dead code_switching slot>, audio_bucket_name, user_id
_GATEWAY_POSITIONAL_ARGS = (
    "job-1",
    "tenant-1",
    None,
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
    from stt.transcription.workers.transcribe_file import transcribe_file

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


def test_actor_binds_the_spec_and_storage_kwargs_together():
    spec = resolved_spec()
    forwarded = _invoke_actor(
        resolved_spec=spec, storage={"provider": "s3", "bucket": "tenant-bucket"}
    )

    assert forwarded["resolved_spec"] == spec
    assert forwarded["storage"] == {"provider": "s3", "bucket": "tenant-bucket"}
    # The positional tail still lands where the signature expects it.
    assert forwarded["audio_bucket_name"] == "hope-audio"
    assert forwarded["user_id"] == "user-1"
    assert "fallback_pipeline_id" not in forwarded
