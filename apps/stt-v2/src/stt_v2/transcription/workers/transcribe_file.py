"""Dramatiq actor for batch file transcription."""

import asyncio
import json
import logging
import os

import dramatiq

from ...core.api_client.gateway import get_api_client
from ...core.config.settings import get_settings
from ...core.exceptions import (
    JobCancelledError,
    JobTerminalError,
    NotFoundError,
    TranscriptionError,
)
from ...core.messaging.pubsub import TranscriptionEventPublisher
from ...pipeline.config_reader import get_pipeline_reader
from ...storage.blob_service import get_blob_service
from ..batch_service import get_batch_service

logger = logging.getLogger(__name__)


@dramatiq.actor(
    queue_name="stt_batch",
    max_retries=3,
    min_backoff=10000,  # 10 seconds
    max_backoff=300000,  # 5 minutes
    time_limit=get_settings().transcription_timeout_seconds * 1000,
)
def transcribe_file(
    job_id: str,
    tenant_id: str,
    pipeline_id: str,
    audio_uri: str,
    consultation_id: str | None = None,
    media_id: str | None = None,
    language: str | None = None,
    code_switching: bool | None = None,
    audio_bucket_name: str | None = None,
    user_id: str | None = None,
    storage: dict | None = None,
) -> None:
    """
    Dramatiq actor for batch file transcription.

    Flow:
    1. Update job status → PROCESSING
    2. Download audio from MinIO
    3. Load pipeline configuration
    4. Run batch transcription
    5. Upload result to storage
    6. Call API Gateway to create context item
    7. Update job status → COMPLETED

    On error:
    - Update job status → FAILED
    - Record error details
    - Retry if retryable error

    Args:
        job_id: Transcription job ID
        tenant_id: Tenant ID
        pipeline_id: Pipeline ID
        audio_uri: MinIO URI for audio file
        consultation_id: Optional consultation ID
        media_id: Optional media ID
        language: Optional language hint for ASR
        code_switching: Optional flag to enable code-switching mode
        audio_bucket_name: Optional tenant-scoped bucket name
        user_id: Optional authenticated user ID
        storage: Optional per-tenant storage provider descriptor. When present,
            selects the provider (MinIO/S3/Azure) and bucket for this tenant;
            when absent, the global MinIO client and ``audio_bucket_name`` are
            used (unchanged behaviour).
    """
    # Run async code in event loop
    asyncio.run(
        _transcribe_file_async(
            job_id=job_id,
            tenant_id=tenant_id,
            pipeline_id=pipeline_id,
            audio_uri=audio_uri,
            consultation_id=consultation_id,
            media_id=media_id,
            language=language,
            code_switching=code_switching,
            audio_bucket_name=audio_bucket_name,
            user_id=user_id,
            storage=storage,
        )
    )


async def _transcribe_file_async(
    job_id: str,
    tenant_id: str,
    pipeline_id: str,
    audio_uri: str,
    consultation_id: str | None = None,
    media_id: str | None = None,
    language: str | None = None,
    code_switching: bool | None = None,
    audio_bucket_name: str | None = None,
    user_id: str | None = None,
    storage: dict | None = None,
) -> None:
    """Async implementation of file transcription.

    In addition to the gateway API lifecycle calls, this function
    publishes real-time events to Redis Pub/Sub so the NestJS API
    Gateway can relay them to clients via SSE.
    """
    _settings = get_settings()
    api_client = get_api_client()
    blob_service = get_blob_service()
    pipeline_reader = get_pipeline_reader()
    batch_service = get_batch_service()

    # Register per-tenant storage routing. A `storage` descriptor (multi-provider
    # S3/MinIO/Azure) wins and also pins the tenant audio bucket; otherwise fall
    # back to the legacy `audio_bucket_name` bucket override.
    if storage and tenant_id:
        blob_service._resolver.set_tenant_storage(tenant_id, storage)
    elif audio_bucket_name and tenant_id:
        blob_service._resolver.set_tenant_bucket(tenant_id, "audio", audio_bucket_name)

    worker_id = f"worker-{os.getpid()}"
    logger.info(f"[{job_id}] Starting batch transcription (worker={worker_id})")

    # Cancellation check helper — polls API for job status
    async def _check_cancelled() -> None:
        try:
            status = await api_client.get_job_status(job_id)
            if status == "CANCELLED":
                raise JobCancelledError(f"Job {job_id} was cancelled")
        except JobCancelledError:
            raise
        except Exception as e:
            # Best-effort: log and continue if status check fails
            logger.warning(f"[{job_id}] Cancellation check failed: {e}")

    # Create the event publisher for real-time SSE relay
    publisher = TranscriptionEventPublisher()

    try:
        # Connect publisher (best-effort — degrades gracefully)
        await publisher.connect()

        # Step 1: Mark job as processing
        await api_client.start_job(job_id, worker_id)
        logger.info(f"[{job_id}] Job marked as PROCESSING")

        # Publish status: PROCESSING
        await publisher.publish_status(job_id, "PROCESSING", worker_id=worker_id)

        # Step 2: Load pipeline configuration
        logger.info(f"[{job_id}] Loading pipeline {pipeline_id}")
        pipeline_config = await pipeline_reader.get_pipeline(pipeline_id)

        if language is not None:
            pipeline_config.spec.inference.language = language

        # Check for cancellation before downloading audio
        await _check_cancelled()

        # Step 3: Download audio from storage
        logger.info(f"[{job_id}] Downloading audio from {audio_uri}")
        audio_bytes = await blob_service.download_audio(audio_uri, tenant_id=tenant_id)
        logger.info(f"[{job_id}] Downloaded {len(audio_bytes)} bytes")

        # Check for cancellation before starting transcription
        await _check_cancelled()

        # Step 4: Run transcription with progress + chunk callbacks
        _pending_progress_tasks: list[asyncio.Task] = []
        _progress_publish_lock = asyncio.Lock()
        _last_progress_scheduled = -1
        _last_cancel_check_progress = -1
        _progress_state: dict[str, int | bool | None] = {
            "latest": None,
            "in_flight": False,
        }

        async def _flush_progress_updates() -> None:
            """
            Flush only the latest queued progress update.

            Progress callbacks can fire very frequently for long audio.  Sending each
            update as an independent async task causes a large backlog waiting on the
            Redis connection lock.  Coalescing to the latest value keeps realtime
            semantics while preventing task pile-ups.
            """
            nonlocal _last_cancel_check_progress
            while True:
                queued = _progress_state["latest"]
                _progress_state["latest"] = None

                if queued is None:
                    _progress_state["in_flight"] = False
                    return

                progress = int(queued)

                # Check for cancellation every ~10% progress
                if progress - _last_cancel_check_progress >= 10:
                    _last_cancel_check_progress = progress
                    await _check_cancelled()

                async with _progress_publish_lock:
                    try:
                        await api_client.update_job_progress(job_id, progress)
                    except Exception as e:
                        logger.warning(f"[{job_id}] Failed to update progress: {e}")
                    try:
                        await publisher.publish_progress(
                            job_id,
                            progress,
                            stage="inference",
                        )
                    except Exception as e:
                        logger.warning(f"[{job_id}] Failed to publish progress event: {e}")

        async def on_chunk(chunk: object) -> None:
            """Publish each partial transcript chunk for real-time SSE."""
            await publisher.publish_chunk(job_id, chunk)

        def _schedule_progress_task(coro: object) -> None:
            """Schedule an async progress task and track it for later awaiting."""
            task = asyncio.create_task(coro)
            _pending_progress_tasks.append(task)

        def schedule_progress(progress: int) -> None:
            """
            Coalesce frequent progress callbacks into a single in-flight task.

            - keep monotonic progress only
            - throttle tiny increments (except terminal 100%)
            - always flush the latest value
            """
            nonlocal _last_progress_scheduled

            value = int(progress)
            if value <= _last_progress_scheduled:
                return
            if (
                value < 100
                and (_last_progress_scheduled >= 0)
                and (value - _last_progress_scheduled < 2)
            ):
                return

            _last_progress_scheduled = value

            queued = _progress_state["latest"]
            if queued is None or value > int(queued):
                _progress_state["latest"] = value

            if not bool(_progress_state["in_flight"]):
                _progress_state["in_flight"] = True
                _schedule_progress_task(_flush_progress_updates())

        audio_filename = audio_uri.rsplit("/", 1)[-1] if audio_uri else None

        result = await batch_service.transcribe(
            job_id=job_id,
            audio_bytes=audio_bytes,
            pipeline_config=pipeline_config,
            progress_callback=schedule_progress,
            chunk_callback=on_chunk,
            tenant_id=tenant_id,
            consultation_id=consultation_id,
            blob_service=blob_service,
            audio_filename=audio_filename,
            user_id=user_id,
        )

        # Await pending progress tasks before publishing final events
        if _pending_progress_tasks:
            await asyncio.gather(*_pending_progress_tasks, return_exceptions=True)
            _pending_progress_tasks.clear()

        # Check for cancellation before uploading results
        await _check_cancelled()

        # Step 5: Upload transcript to storage
        logger.info(f"[{job_id}] Uploading transcript")
        transcript_uri = await blob_service.upload_transcript(
            transcript_data=json.dumps(result.to_dict(), indent=2),
            tenant_id=tenant_id,
            job_id=job_id,
            consultation_id=consultation_id,
            format="json",
        )
        result.transcript_uri = transcript_uri

        # Step 5b: Upload job metadata
        try:
            metadata_uri = await blob_service.upload_batch_metadata(
                metadata_data=json.dumps(result.to_dict(), indent=2),
                tenant_id=tenant_id,
                job_id=job_id,
                consultation_id=consultation_id,
            )
            logger.info(f"[{job_id}] Uploaded metadata to {metadata_uri}")
        except Exception as e:
            logger.warning(f"[{job_id}] Metadata upload failed (non-fatal): {e}")

        # Step 6: Create transcript context item (if consultation provided)
        context_item_id = None
        if consultation_id:
            logger.info(f"[{job_id}] Creating transcript context item")
            try:
                response = await api_client.create_transcript(
                    job_id=job_id,
                    transcript_text=result.text,
                    metadata=result.to_dict(),
                    consultation_id=consultation_id,
                )
                context_item_id = response.get("contextItemId")
                logger.info(f"[{job_id}] Created context item: {context_item_id}")
            except Exception as e:
                logger.warning(f"[{job_id}] Failed to create context item: {e}")

        # Publish full transcript event before completing
        await publisher.publish_transcript(job_id, result)

        # Step 7: Complete job
        logger.info(f"[{job_id}] Completing job")
        await api_client.complete_job(
            job_id=job_id,
            result_text=result.text,
            result_metadata={
                **result.to_dict(),
                "transcript_uri": transcript_uri,
                "context_item_id": context_item_id,
            },
        )

        # Publish status: COMPLETED
        await publisher.publish_status(job_id, "COMPLETED")

        logger.info(
            f"[{job_id}] Transcription completed successfully "
            f"({result.processing_time_seconds:.2f}s, {len(result.text)} chars)"
        )

    except NotFoundError as e:
        # Non-retryable error
        logger.error(f"[{job_id}] Resource not found: {e}")
        await publisher.publish_error(job_id, "NOT_FOUND", str(e))
        await _fail_job(api_client, publisher, job_id, str(e), "NOT_FOUND")
        raise dramatiq.middleware.SkipMessage() from e

    except JobCancelledError as e:
        # Job was cancelled by user — stop processing, skip retries
        logger.info(f"[{job_id}] Job cancelled, stopping worker")
        await publisher.publish_status(job_id, "CANCELLED")
        raise dramatiq.middleware.SkipMessage() from e

    except JobTerminalError:
        # Job was already completed/failed by a previous attempt -- skip silently
        logger.warning(f"[{job_id}] Job already in terminal state, skipping duplicate delivery")
        return

    except TranscriptionError as e:
        # Transcription-specific error (may be retryable)
        logger.error(f"[{job_id}] Transcription error: {e}")
        await publisher.publish_error(job_id, "TRANSCRIPTION_ERROR", str(e))
        await _fail_job(api_client, publisher, job_id, str(e), "TRANSCRIPTION_ERROR")
        raise  # Let Dramatiq handle retry

    except Exception as e:
        # Unexpected error
        logger.exception(f"[{job_id}] Unexpected error: {e}")
        await publisher.publish_error(job_id, "INTERNAL_ERROR", str(e))
        await _fail_job(api_client, publisher, job_id, str(e), "INTERNAL_ERROR")
        raise

    finally:
        await publisher.close()
        await api_client.close()


async def _fail_job(
    api_client: object,
    publisher: TranscriptionEventPublisher,
    job_id: str,
    error_message: str,
    error_code: str,
) -> None:
    """Mark job as failed via the API and publish failure status event."""
    try:
        await api_client.fail_job(
            job_id=job_id,
            error_message=error_message,
            error_code=error_code,
        )
    except Exception as e:
        logger.error(f"[{job_id}] Failed to update job status: {e}")

    # Publish status: FAILED
    await publisher.publish_status(job_id, "FAILED")
