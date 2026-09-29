"""Dramatiq actor for batch file transcription."""

import asyncio
import json
import os
import socket
from collections.abc import Coroutine
from dataclasses import dataclass
from typing import Any

import dramatiq
from hope_obs import get_logger, redact_id

from ...core.api_client.gateway import get_api_client
from ...core.config.settings import get_settings
from ...core.effective_config import get_effective_config_client
from ...core.exceptions import (
    AudioProcessingError,
    CloudASRError,
    JobCancelledError,
    JobConflictError,
    JobTerminalError,
    ModelError,
    NotFoundError,
    ResolvedSpecRequiredError,
    TranscriptionError,
)
from ...core.initial_prompt import compose_prompt
from ...core.job_concurrency import get_job_gate, refresh_job_concurrency_limit
from ...core.messaging.pubsub import TranscriptionEventPublisher
from ...core.worker_loop import run_on_worker_loop
from ...pipeline.dto import PipelineConfig
from ...pipeline.language_modes import (
    LANGUAGE_MODE_SOURCES,
    LanguageModeSource,
    LanguageModeUnsupportedError,
    LanguageResolution,
    default_language_resolution,
    mark_fallback_engine_switch,
    normalize_language_mode,
    resolve_language,
)
from ...pipeline.spec import (
    ResolvedSpecBundle,
    bundle_from_resolved,
    fallback_chain,
    pipeline_config_from_bundle,
)
from ...storage.blob_service import get_blob_service
from ..batch_service import get_batch_service
from .job_context import current_trace_carrier, job_context

logger = get_logger(__name__)


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
    _ignored_pipeline_id: str | None,
    audio_uri: str,
    consultation_id: str | None = None,
    media_id: str | None = None,
    language: str | None = None,
    _ignored_code_switching: bool | None = None,
    audio_bucket_name: str | None = None,
    user_id: str | None = None,
    storage: dict[str, Any] | None = None,
    _ignored_fallback_pipeline_id: str | None = None,
    resolved_spec: dict[str, Any] | None = None,
    voice_profiles: list[dict[str, Any]] | None = None,
    *,
    language_mode: str | None = None,
    language_mode_source: str | None = None,
    fallback_pipeline_id: str | None = None,
) -> None:
    """
    Dramatiq actor for batch file transcription.

    Flow:
    1. Update job status → PROCESSING
    2. Assemble the engine chain from ``resolved_spec``
    3. Download audio from MinIO
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
        _ignored_pipeline_id: TASK-1006 — the DEAD positional slot where the
            pre-agent ``pipeline_id`` used to sit. It stays so an already-queued
            positional message still binds, and is ignored; the gateway sends ``null``.
        audio_uri: MinIO URI for audio file
        consultation_id: Optional consultation ID
        media_id: Optional media ID
        language: Optional language hint for ASR. A value naming a catalog mode
            (``en``, ``en-US``) is promoted to that mode, exactly as a live session
            promotes it; any other value is a raw ``inference.language`` override.
        _ignored_code_switching: TASK-1004 — the DEAD positional slot where
            ``code_switching`` used to sit. The gateway always sent ``null`` and the
            worker never applied it; it stays so an already-queued positional message
            still binds, and is ignored. Never send it.
        language_mode: TASK-1004 — the job's effective language-mode id
            (``en`` | ``ml`` | ``ml-en`` | … | ``auto``), KEYWORD-ONLY. Resolved per
            chain against that chain's engine by the same call a live session makes.
            Absent ⇒ a declared catalog ``language``, else the agent's own mode.
        language_mode_source: TASK-1004 — which precedence tier supplied
            ``language_mode`` (``request`` | ``consultation`` | ``agent`` |
            ``default``), stamped on the job's LanguageResolution receipt.
        audio_bucket_name: Optional tenant-scoped bucket name
        user_id: Optional authenticated user ID
        _ignored_fallback_pipeline_id: TASK-1006 — the DEAD positional slot of the
            pre-agent tenant fallback pipeline; kept for arity and ignored. The
            fallback engine is the spec's own ``fallback`` chain.
        fallback_pipeline_id: TASK-1006 — IGNORED. The pre-agent gateway sent the
            fallback pointer by KEYWORD (never positionally), so this name is what an
            already-queued legacy message binds to; without it that message would
            raise ``TypeError`` before the job could be failed by name. Never send it.
        resolved_spec: The gateway-resolved ``ResolvedAsrSpec`` (wire JSON) — the ONLY
            selector. A job without one fails with ``RESOLVED_SPEC_REQUIRED`` and is
            not retried.
        voice_profiles: TASK-887 — the end-user's ENROLLED voice profiles for the agent's
            speaker-embedding model, resolved and pushed by the gateway. Biometric PHI: it
            lives in this message for the life of the job and is never persisted or logged
            here.
        storage: Optional per-tenant storage provider descriptor. When present,
            selects the provider (MinIO/S3/Azure) and bucket for this tenant;
            when absent, the global MinIO client and ``audio_bucket_name`` are
            used (unchanged behaviour).
    """
    # Bound concurrent batch jobs HERE, inside the actor, so the
    # ceiling holds under any launch mode. The dramatiq CLI (the shipped
    # Dockerfile CMD) imports this module rather than running `worker.py:main()`,
    # so a Worker(worker_threads=...) value set there would never apply. The
    # gate's `--threads` outer bound still caps how many jobs a process attempts;
    # this is the operator-adjustable inner bound. See core/job_concurrency.py.
    with get_job_gate():
        # BUG-016: dispatch onto the process-wide worker loop instead of
        # `asyncio.run()`. A loop per message put every job on its own loop while
        # the objects jobs SHARE (DB pools, HTTP clients, the model cache's
        # single-flight futures) are bound to the loop that built them — the
        # cause of the 300s stall, the pool leak, and
        # `got Future … attached to a different loop`. Concurrency is unchanged:
        # the thread gate above still bounds it, and the loop never does CPU work
        # (loading and inference already run under `asyncio.to_thread`).
        run_on_worker_loop(
            _transcribe_file_async(
                job_id=job_id,
                tenant_id=tenant_id,
                audio_uri=audio_uri,
                consultation_id=consultation_id,
                media_id=media_id,
                language=language,
                audio_bucket_name=audio_bucket_name,
                user_id=user_id,
                storage=storage,
                resolved_spec=resolved_spec,
                voice_profiles=voice_profiles,
                language_mode=language_mode,
                language_mode_source=language_mode_source,
                trace_carrier=current_trace_carrier(),
            )
        )


async def _transcribe_file_async(
    *args: Any, trace_carrier: dict[str, Any] | None = None, **kwargs: Any
) -> None:
    """Run one batch job inside the enqueuer's trace and request context.

    The job's spans continue the trace the gateway started and every log line
    carries the gateway's ``requestId`` and the job's ``tenantId`` (``tenant_id``
    is the impl's own argument, named in ``args``/``kwargs``).
    """
    tenant_id = kwargs.get("tenant_id") or (args[1] if len(args) > 1 else None)
    with job_context(trace_carrier, tenant_id=tenant_id):
        await _transcribe_file_impl(*args, **kwargs)


async def _transcribe_file_impl(
    job_id: str,
    tenant_id: str,
    audio_uri: str,
    consultation_id: str | None = None,
    media_id: str | None = None,
    language: str | None = None,
    audio_bucket_name: str | None = None,
    user_id: str | None = None,
    storage: dict[str, Any] | None = None,
    resolved_spec: dict[str, Any] | None = None,
    voice_profiles: list[dict[str, Any]] | None = None,
    language_mode: str | None = None,
    language_mode_source: str | None = None,
) -> None:
    """Async implementation of file transcription.

    In addition to the gateway API lifecycle calls, this function
    publishes real-time events to Redis Pub/Sub so the NestJS API
    Gateway can relay them to clients via SSE.
    """
    # Track the control-plane job ceiling. This job already holds
    # its slot, so a resize applies to SUBSEQUENT admissions: the bound converges
    # monotonically instead of disturbing work in flight. Never raises.
    await refresh_job_concurrency_limit()

    _settings = get_settings()
    api_client = get_api_client()
    blob_service = get_blob_service()
    batch_service = get_batch_service()
    # TASK-861 — the job carries its whole engine chain (primary + fallback + every
    # model config) in `resolved_spec`; nothing is read from Postgres. TASK-1006 —
    # it is the ONLY selector: a job without one is failed below, once claimed.
    bundle = bundle_from_resolved(resolved_spec) if resolved_spec is not None else None

    # Register per-tenant storage routing. A `storage` descriptor (multi-provider
    # S3/MinIO/Azure) wins and also pins the tenant audio bucket; otherwise fall
    # back to the legacy `audio_bucket_name` bucket override.
    if storage and tenant_id:
        blob_service._resolver.set_tenant_storage(tenant_id, storage)
    elif audio_bucket_name and tenant_id:
        blob_service._resolver.set_tenant_bucket(tenant_id, "audio", audio_bucket_name)

    # TASK-992 — the worker identity must be unique ACROSS HOSTS, because the
    # gateway's reclaim rule is "a different worker holds this job". PIDs
    # collide freely between pods, so a bare `worker-<pid>` could make a
    # genuine reclaim look like the same worker re-sending its claim — which
    # the gateway answers idempotently, leaving two workers on one job.
    worker_id = f"{socket.gethostname()}-{os.getpid()}"
    logger.info("stt.batch.started", job=redact_id(job_id), worker=worker_id)

    # Cancellation check helper — polls API for job status
    async def _check_cancelled() -> None:
        try:
            status = await api_client.get_job_status(job_id, tenant_id=tenant_id)
            if status == "CANCELLED":
                raise JobCancelledError(f"Job {job_id} was cancelled")
        except JobCancelledError:
            raise
        except Exception as e:
            # Best-effort: log and continue if status check fails
            logger.warning(
                "stt.batch.cancellation_check_failed",
                job=redact_id(job_id),
                error_type=type(e).__name__,
            )

    # Create the event publisher for real-time SSE relay
    publisher = TranscriptionEventPublisher()

    try:
        # Connect publisher (best-effort — degrades gracefully)
        await publisher.connect()

        # Step 1: Mark job as processing
        await api_client.start_job(job_id, worker_id, tenant_id=tenant_id)
        logger.info("stt.batch.processing", job=redact_id(job_id))

        # Publish status: PROCESSING
        await publisher.publish_status(job_id, "PROCESSING", worker_id=worker_id)

        # Step 2: Assemble the engine chain from the resolved spec
        if bundle is None:
            raise ResolvedSpecRequiredError(
                f"Job {job_id} carries no resolved_spec; the pre-agent pipeline_id path "
                "was removed (TASK-1006)"
            )
        # TASK-1004 — the job's effective language mode is resolved per chain,
        # against that chain's engine, by the same call a live session makes; it may
        # start the job on a fallback when the primary cannot serve the mode, and
        # raises when no chain can.
        logger.info(
            "stt.batch.assembling_chain", job=redact_id(job_id), runtime_key=bundle.runtime_key
        )
        job_language = _plan_job_language(
            bundle,
            language_mode=language_mode,
            language_mode_source=language_mode_source,
            language=language,
        )
        pipeline_config = job_language.pipeline_config
        language_resolution: LanguageResolution | None = job_language.receipt
        if job_language.runtime_key != bundle.runtime_key:
            logger.warning(
                "stt.batch.primary_cannot_serve_language",
                job=redact_id(job_id),
                language_mode=job_language.mode,
                fallback_runtime_key=job_language.runtime_key,
            )

        # Check for cancellation before downloading audio
        await _check_cancelled()

        # Step 3: Download audio from storage
        logger.info("stt.batch.downloading_audio", job=redact_id(job_id))
        audio_bytes = await blob_service.download_audio(audio_uri, tenant_id=tenant_id)
        logger.info("stt.batch.downloaded_audio", job=redact_id(job_id), size_bytes=len(audio_bytes))

        # Check for cancellation before starting transcription
        await _check_cancelled()

        # Step 4: Run transcription with progress + chunk callbacks
        _pending_progress_tasks: list[asyncio.Task[Any]] = []
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
                        await api_client.update_job_progress(job_id, progress, tenant_id=tenant_id)
                    except Exception as e:
                        logger.warning(
                            "stt.batch.progress_update_failed",
                            job=redact_id(job_id),
                            error_type=type(e).__name__,
                        )
                    try:
                        await publisher.publish_progress(
                            job_id,
                            progress,
                            stage="inference",
                        )
                    except Exception as e:
                        logger.warning(
                            "stt.batch.progress_publish_failed",
                            job=redact_id(job_id),
                            error_type=type(e).__name__,
                        )

        async def on_chunk(chunk: object) -> None:
            """Publish each partial transcript chunk for real-time SSE."""
            await publisher.publish_chunk(job_id, chunk)

        def _schedule_progress_task(coro: Coroutine[Any, Any, Any]) -> None:
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

        # PULL the tenant's decrypted BYO provider overrides at
        # execution time (injecting a key into the Dramatiq queue message is
        # prohibited). Fail-open: {} on any error ⇒ env creds.
        provider_overrides = await get_effective_config_client().get_provider_overrides(tenant_id)

        async def _do_transcribe(pc: Any) -> Any:
            return await batch_service.transcribe(
                job_id=job_id,
                audio_bytes=audio_bytes,
                pipeline_config=pc,
                progress_callback=schedule_progress,
                chunk_callback=on_chunk,
                tenant_id=tenant_id,
                consultation_id=consultation_id,
                blob_service=blob_service,
                audio_filename=audio_filename,
                user_id=user_id,
                provider_overrides=provider_overrides,
                model_configs=bundle.model_configs,
                voice_profiles=voice_profiles,
            )

        # The fallback engine: the spec's own `fallback` chain.
        fallback_key = job_language.fallback_key

        try:
            result = await _do_transcribe(pipeline_config)
        except (CloudASRError, ModelError) as asr_exc:
            # Batch fallback dispatch. On a cloud-ASR/model failure
            # with a configured fallback, re-run ONCE on the fallback chain
            # within this same Dramatiq attempt (CloudASRAuthError → straight to
            # fallback; retrying a bad key is pointless). No fallback configured
            # ⇒ re-raise, byte-identical to today (Dramatiq retry/skip taxonomy).
            if not fallback_key:
                raise
            logger.warning(
                "stt.batch.primary_asr_failed",
                job=redact_id(job_id),
                error_type=type(asr_exc).__name__,
                fallback_key=fallback_key,
            )
            try:
                fb_pipeline_config, language_resolution = _resolve_chain_language(
                    bundle,
                    fallback_key,
                    job_language.mode,
                    job_language.source,
                    language,
                )
            except LanguageModeUnsupportedError:
                # The fallback cannot serve the job's mode: the engine error stands.
                logger.warning(
                    "stt.batch.fallback_cannot_serve_language",
                    job=redact_id(job_id),
                    fallback_key=fallback_key,
                    language_mode=job_language.mode,
                )
                raise asr_exc from None
            result = await _do_transcribe(fb_pipeline_config)
            # Auditability: record which fallback actually produced the result.
            result.metadata["usedFallbackPipelineId"] = fallback_key

        # Await pending progress tasks before publishing final events
        if _pending_progress_tasks:
            await asyncio.gather(*_pending_progress_tasks, return_exceptions=True)
            _pending_progress_tasks.clear()

        # Check for cancellation before uploading results
        await _check_cancelled()

        # Step 5: Upload transcript to storage
        logger.info("stt.batch.uploading_transcript", job=redact_id(job_id))
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
            await blob_service.upload_batch_metadata(
                metadata_data=json.dumps(result.to_dict(), indent=2),
                tenant_id=tenant_id,
                job_id=job_id,
                consultation_id=consultation_id,
            )
            logger.info("stt.batch.uploaded_metadata", job=redact_id(job_id))
        except Exception as e:
            logger.warning(
                "stt.batch.metadata_upload_failed",
                job=redact_id(job_id),
                error_type=type(e).__name__,
            )

        # Step 6: Create transcript context item (if consultation provided)
        context_item_id = None
        if consultation_id:
            logger.info("stt.batch.creating_context_item", job=redact_id(job_id))
            try:
                response = await api_client.create_transcript(
                    job_id=job_id,
                    transcript_text=result.text,
                    metadata=result.to_dict(),
                    consultation_id=consultation_id,
                    tenant_id=tenant_id,
                    # Sent on the TYPED field, not smuggled inside `metadata`.
                    # The metadata path was how the wrong (text-less, seconds,
                    # snake_case) shape used to slip past validation and write
                    # all-null segment rows.
                    segments=result.build_transcript_segments(),
                )
                context_item_id = response.get("contextItemId")
                logger.info(
                    "stt.batch.created_context_item",
                    job=redact_id(job_id),
                    context_item=redact_id(context_item_id),
                )
            except Exception as e:
                logger.warning(
                    "stt.batch.context_item_failed",
                    job=redact_id(job_id),
                    error_type=type(e).__name__,
                )

        # Publish full transcript event before completing
        await publisher.publish_transcript(job_id, result)

        # Step 7: Complete job
        logger.info("stt.batch.completing", job=redact_id(job_id))
        await api_client.complete_job(
            job_id=job_id,
            tenant_id=tenant_id,
            result_text=result.text,
            result_metadata={
                **result.to_dict(),
                "transcript_uri": transcript_uri,
                "context_item_id": context_item_id,
            },
            # Typed usage-attribution fields lifted OUT of the
            # (soon-to-be-encrypted) resultMetadata blob above; the gateway
            # reads these to emit the transcribe.batch AUDIO_SECOND ledger
            # row. None (unresolved engine, e.g. an unusual pipeline shape)
            # is never guessed — complete_job() omits the field entirely.
            duration_seconds=result.duration_seconds,
            processing_time_seconds=result.processing_time_seconds,
            engine=result.engine,
            deployment=result.deployment,
            connection_id=result.connection_id,
            # TASK-959 — the device turns processing_time_seconds into a
            # GPU_SECOND or CPU_SECOND row; the byte counters are the only
            # per-tenant network figures that can exist (§3.2, §4.2).
            device=result.device,
            request_bytes=result.request_bytes,
            response_bytes=result.response_bytes,
            byte_source=result.byte_source,
            # TASK-1004 — what the engine that PRODUCED the result applied for the
            # job's language mode; a typed sibling for the same reason as the
            # fields above (the metadata blob is encrypted on persist).
            language_resolution=(
                language_resolution.to_wire() if language_resolution is not None else None
            ),
        )

        # Publish status: COMPLETED
        await publisher.publish_status(job_id, "COMPLETED")

        logger.info(
            "stt.batch.completed",
            job=redact_id(job_id),
            processing_s=round(result.processing_time_seconds, 2),
            text_chars=len(result.text),
        )

    except NotFoundError as e:
        # Non-retryable error
        logger.error("stt.batch.not_found", job=redact_id(job_id), error_type=type(e).__name__)
        await publisher.publish_error(job_id, "NOT_FOUND", str(e))
        await _fail_job(api_client, publisher, job_id, str(e), "NOT_FOUND", tenant_id=tenant_id)
        raise dramatiq.middleware.SkipMessage() from e

    except ResolvedSpecRequiredError as e:
        # TASK-1006 — a message queued for the removed pipeline path. There is no
        # engine to resolve and a retry cannot grow one, so the broker skips it.
        logger.error(
            "stt.batch.resolved_spec_required",
            job=redact_id(job_id),
            error_code=e.error_code,
        )
        await publisher.publish_error(job_id, e.error_code, e.message)
        await _fail_job(api_client, publisher, job_id, e.message, e.error_code, tenant_id=tenant_id)
        raise dramatiq.middleware.SkipMessage() from e

    except LanguageModeUnsupportedError as e:
        # TASK-1004 — no engine in the job's chain can serve the requested mode:
        # the batch counterpart of a live session's 422. Re-running the same chain
        # can only fail the same way, so the broker skips the retries.
        logger.error(
            "stt.batch.language_mode_unsupported",
            job=redact_id(job_id),
            error_type=type(e).__name__,
        )
        await publisher.publish_error(job_id, "LANGUAGE_MODE_UNSUPPORTED", str(e))
        await _fail_job(
            api_client,
            publisher,
            job_id,
            str(e),
            "LANGUAGE_MODE_UNSUPPORTED",
            tenant_id=tenant_id,
        )
        raise dramatiq.middleware.SkipMessage() from e

    except JobCancelledError as e:
        # Job was cancelled by user — stop processing, skip retries
        logger.info("stt.batch.cancelled", job=redact_id(job_id))
        await publisher.publish_status(job_id, "CANCELLED")
        raise dramatiq.middleware.SkipMessage() from e

    except JobTerminalError:
        # Job was already completed/failed by a previous attempt -- skip silently.
        # Safe to drop: the job HAS an outcome and the client can see it.
        logger.warning("stt.batch.duplicate_delivery_skipped", job=redact_id(job_id))
        return

    except JobConflictError as e:
        # TASK-992 — the gateway refused the claim on a job that has NOT
        # finished, and can say so structurally (`terminal: false`).
        #
        # Re-raise. Under the current gateway this is rare: a PROCESSING row
        # left by a dead worker is RECLAIMED and this delivery goes on to
        # transcribe the job, because the audio lives in object storage and is
        # re-downloaded below. The branch exists for the refusals that remain
        # genuinely not-yet — chiefly a NEW worker talking to a gateway that
        # predates TASK-992 — and the broker's backoff is the right answer to
        # those.
        #
        # Deliberately NOT `_fail_job` + SkipMessage, which is what TASK-991
        # W2-4 did here: ending the job discards a transcription the platform
        # is perfectly able to complete, and on a refusal this worker's OWN
        # earlier claim caused, it would fail a job that is running fine.
        logger.warning(
            "stt.batch.claim_conflict_will_retry",
            job=redact_id(job_id),
            error_type=type(e).__name__,
        )
        raise

    except AudioProcessingError as e:
        # The file itself is unusable (undecodable, wrong format,
        # too short). Report the specific code and let the broker skip retries;
        # re-reading the same bytes can only fail the same way.
        logger.error(
            "stt.batch.audio_error",
            job=redact_id(job_id),
            error_code=e.error_code,
            error_type=type(e).__name__,
        )
        await publisher.publish_error(job_id, e.error_code, e.message)
        await _fail_job(api_client, publisher, job_id, e.message, e.error_code, tenant_id=tenant_id)
        raise

    except TranscriptionError as e:
        # Transcription-specific error (may be retryable)
        logger.error(
            "stt.batch.transcription_error",
            job=redact_id(job_id),
            error_type=type(e).__name__,
        )
        await publisher.publish_error(job_id, "TRANSCRIPTION_ERROR", str(e))
        await _fail_job(
            api_client, publisher, job_id, str(e), "TRANSCRIPTION_ERROR", tenant_id=tenant_id
        )
        raise  # Let Dramatiq handle retry

    except Exception as e:
        # Unexpected error
        logger.exception(
            "stt.batch.unexpected_error", job=redact_id(job_id), error_type=type(e).__name__
        )
        await publisher.publish_error(job_id, "INTERNAL_ERROR", str(e))
        await _fail_job(
            api_client, publisher, job_id, str(e), "INTERNAL_ERROR", tenant_id=tenant_id
        )
        raise

    finally:
        await publisher.close()
        await api_client.close()


async def _fail_job(
    api_client: Any,
    publisher: TranscriptionEventPublisher,
    job_id: str,
    error_message: str,
    error_code: str,
    tenant_id: str | None = None,
) -> None:
    """Mark job as failed via the API and publish failure status event.

    ``tenant_id`` addresses the job's owning tenant (BUG-013). Without it the
    /fail callback 404s by the same mechanism as /start, so a job that can never
    run can never be marked FAILED either — it strands at QUEUED with no error.
    """
    try:
        await api_client.fail_job(
            job_id=job_id,
            error_message=error_message,
            error_code=error_code,
            tenant_id=tenant_id,
        )
    except Exception as e:
        logger.error(
            "stt.batch.job_status_update_failed",
            job=redact_id(job_id),
            error_type=type(e).__name__,
        )

    # Publish status: FAILED
    await publisher.publish_status(job_id, "FAILED")


# ---------------------------------------------------------------------------
# TASK-1004 — the job's spoken-language selection, resolved per chain
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _JobLanguage:
    """The job's effective mode and the chain that will serve it first.

    ``fallback_key`` is the engine an ASR failure re-dispatches to — today's single
    spec fallback when the job starts on the primary, none when the MODE already
    moved it onto a fallback.
    """

    mode: str | None
    source: LanguageModeSource
    runtime_key: str
    pipeline_config: PipelineConfig
    receipt: LanguageResolution | None
    fallback_key: str | None


def _effective_job_mode(
    bundle: ResolvedSpecBundle,
    *,
    language_mode: str | None,
    language_mode_source: str | None,
    language: str | None,
) -> tuple[str | None, LanguageModeSource]:
    """``(mode, source)`` by the rules a live session applies in ``create_session``.

    A caller mode wins; else a ``language`` naming a catalog mode is promoted
    (TASK-938); else — only when nothing was declared — the agent's own mode. The
    gateway's ``language_mode_source`` holds only for a mode the CALLER sent.
    """
    if language_mode:
        mode: str | None = language_mode
    else:
        mode = normalize_language_mode(language) if language else None
        if not mode and not language:
            spec_mode = bundle.spec.decoding.language_mode
            return (spec_mode, "agent") if spec_mode else (None, "default")
    if not mode:
        return None, "default"
    if language_mode_source in LANGUAGE_MODE_SOURCES:
        return mode, language_mode_source  # type: ignore[return-value]
    return mode, "request"


def _resolve_chain_language(
    bundle: ResolvedSpecBundle,
    runtime_key: str,
    mode: str | None,
    source: LanguageModeSource,
    language: str | None = None,
) -> tuple[PipelineConfig, LanguageResolution | None]:
    """One chain's ``PipelineConfig`` with the job's mode applied, plus its receipt.

    The batch half of the streaming loader's resolution (``_load_asr_pipeline``):
    the same ``resolve_language`` call against the chain's engine, the same three
    fields, and the priming prompt composed AHEAD of the agent's prompt exactly as a
    live session composes it. Raises ``LanguageModeUnsupportedError`` when this
    chain's engine cannot serve the mode. With no mode, a raw ``language`` override
    applies and the receipt is ``default``/``auto`` only if the engine runs unpinned.
    """
    config = pipeline_config_from_bundle(bundle, runtime_key)
    inference = config.spec.inference
    core = next(
        c for c in (bundle.spec, *fallback_chain(bundle.spec)) if c.runtime_key == runtime_key
    )
    asr = core.models.asr
    engine = bundle.model_configs[asr.slug].format
    if mode:
        resolved, receipt = resolve_language(mode, engine, source=source, provider=asr.provider)
        inference.language = resolved.language
        inference.code_switching = resolved.code_switching
        inference.streaming_english_gloss = resolved.streaming_english_gloss
        if resolved.initial_prompt:
            inference.initial_prompt_text = compose_prompt(
                resolved.initial_prompt, inference.initial_prompt_text
            )
        return config, receipt
    if language is not None:
        inference.language = language
    if inference.language is not None:
        return config, None
    return config, default_language_resolution(
        engine,
        provider=asr.provider,
        code_switching=inference.code_switching,
        streaming_english_gloss=inference.streaming_english_gloss,
    )


def _plan_job_language(
    bundle: ResolvedSpecBundle,
    *,
    language_mode: str | None,
    language_mode_source: str | None,
    language: str | None,
) -> _JobLanguage:
    """Pick the chain that serves the job's mode first: the primary, else — only
    when the primary cannot serve it — the first fallback that can, marked
    ``fallback_engine_switch`` (D-4). Language never re-routes a primary that CAN
    serve the mode, however degraded (OD-6). Raises when no chain can."""
    mode, source = _effective_job_mode(
        bundle,
        language_mode=language_mode,
        language_mode_source=language_mode_source,
        language=language,
    )
    last_error: LanguageModeUnsupportedError | None = None
    for key in (bundle.runtime_key, *bundle.fallback_runtime_keys):
        try:
            config, receipt = _resolve_chain_language(bundle, key, mode, source, language)
        except LanguageModeUnsupportedError as exc:
            last_error = exc
            continue
        on_primary = key == bundle.runtime_key
        if not on_primary and receipt is not None:
            receipt = mark_fallback_engine_switch(receipt)
        return _JobLanguage(
            mode=mode,
            source=source,
            runtime_key=key,
            pipeline_config=config,
            receipt=receipt,
            fallback_key=bundle.fallback_runtime_key if on_primary else None,
        )
    assert last_error is not None  # the primary is always tried
    raise last_error
