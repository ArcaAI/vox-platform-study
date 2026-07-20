"""HTTP client for write operations through API Gateway."""

from datetime import datetime
from functools import lru_cache
from typing import Any, cast

import httpx
import structlog

from stt_v2.core.config.settings import get_settings
from stt_v2.core.exceptions import APIGatewayError, JobTerminalError

logger = structlog.get_logger(__name__)
settings = get_settings()


class APIGatewayClient:
    """HTTP client for write operations through API Gateway.

    All database writes go through the API Gateway to ensure:
    - Proper validation
    - Audit logging
    - Consistent data handling
    """

    def __init__(self, base_url: str, api_key: str, timeout: int = 30) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create the HTTP client."""
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self.timeout,
                headers={
                    "X-Internal-Service-Key": self.api_key,
                    "Content-Type": "application/json",
                },
            )
        return self._client

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._client:
            await self._client.aclose()
            self._client = None

    async def _request(
        self,
        method: str,
        path: str,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """Make an HTTP request to the API Gateway."""
        client = await self._get_client()
        normalized_path = path if path.startswith("/") else f"/{path}"

        try:
            response = await client.request(
                method=method,
                url=normalized_path,
                json=json,
                params=params,
                headers=headers,
            )

            response.raise_for_status()
            return cast(dict[str, Any], response.json())
        except httpx.HTTPStatusError as e:
            logger.error(
                "API Gateway request failed",
                method=method,
                path=normalized_path,
                status_code=e.response.status_code,
                response_text=e.response.text[:500],
            )
            raise APIGatewayError(
                f"API Gateway request failed: {e.response.status_code}",
                details={"status_code": e.response.status_code, "path": normalized_path},
            ) from e
        except httpx.RequestError as e:
            logger.error(
                "API Gateway connection error",
                method=method,
                path=normalized_path,
                error=str(e),
            )
            raise APIGatewayError(f"API Gateway connection error: {e}") from e

    # =========================================================================
    # Transcription Job Lifecycle
    # =========================================================================

    async def start_job(
        self,
        job_id: str,
        worker_id: str,
    ) -> dict[str, Any]:
        """Mark a transcription job as PROCESSING.

        Calls NestJS ``PATCH /internal/stt/jobs/{id}/start`` which expects
        an ``InternalStartJobRequest`` body with ``workerId``.

        Raises ``JobTerminalError`` if the job is already in a
        terminal state (COMPLETED/FAILED/CANCELLED/DEAD) so callers can
        skip processing instead of retrying.
        """
        try:
            return await self._request(
                "PATCH",
                f"/internal/stt/jobs/{job_id}/start",
                json={"workerId": worker_id},
            )
        except APIGatewayError as e:
            status_code = (e.details or {}).get("status_code")
            if status_code == 500 and self._is_terminal_state_error(e):
                raise JobTerminalError(
                    f"Job {job_id} is already in a terminal state",
                    details=e.details,
                ) from e
            raise

    @staticmethod
    def _is_terminal_state_error(error: APIGatewayError) -> bool:
        """Check if an API error indicates the job is already terminal."""
        cause = error.__cause__
        if isinstance(cause, httpx.HTTPStatusError):
            try:
                body = cause.response.json()
                msg = body.get("message", "")
                return "Cannot start job in" in msg or "Cannot fail job in" in msg
            except Exception:
                pass
        return False

    async def update_job_progress(
        self,
        job_id: str,
        progress: int,
    ) -> dict[str, Any]:
        """Update job processing progress (0-100).

        Calls NestJS ``PATCH /internal/stt/jobs/{id}/progress`` which expects
        an ``InternalUpdateProgressRequest`` body with ``progress``.
        """
        return await self._request(
            "PATCH",
            f"/internal/stt/jobs/{job_id}/progress",
            json={"progress": progress},
        )

    async def complete_job(
        self,
        job_id: str,
        result_text: str,
        result_metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Mark a transcription job as COMPLETED with results.

        Calls NestJS ``PATCH /internal/stt/jobs/{id}/complete`` which expects
        an ``InternalCompleteJobRequest`` body with ``resultText`` and
        optional ``resultMetadata``.
        """
        payload: dict[str, Any] = {"resultText": result_text}
        if result_metadata is not None:
            payload["resultMetadata"] = result_metadata

        return await self._request(
            "PATCH",
            f"/internal/stt/jobs/{job_id}/complete",
            json=payload,
        )

    async def fail_job(
        self,
        job_id: str,
        error_message: str,
        error_code: str | None = None,
    ) -> dict[str, Any]:
        """Mark a transcription job as FAILED.

        Calls NestJS ``PATCH /internal/stt/jobs/{id}/fail`` which expects
        an ``InternalFailJobRequest`` body with ``errorMessage`` and
        optional ``errorCode``.
        """
        payload: dict[str, Any] = {"errorMessage": error_message}
        if error_code:
            payload["errorCode"] = error_code

        return await self._request(
            "PATCH",
            f"/internal/stt/jobs/{job_id}/fail",
            json=payload,
        )

    # =========================================================================
    # Job Status Query (for cancellation polling)
    # =========================================================================

    async def get_job_status(self, job_id: str) -> str:
        """Get job status from API Gateway.

        Returns the status string (e.g. QUEUED, PROCESSING, CANCELLED).
        Used by workers to check for cancellation during processing.
        """
        result = await self._request(
            "GET",
            f"/internal/stt/jobs/{job_id}/status",
        )
        return cast(str, result.get("status", "UNKNOWN"))

    # =========================================================================
    # Legacy Status Update (kept for backward compatibility)
    # =========================================================================

    async def update_job_status(
        self,
        job_id: str,
        status: str,
        progress: int | None = None,
        started_at: datetime | None = None,
        completed_at: datetime | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
        worker_id: str | None = None,
    ) -> dict[str, Any]:
        """Update transcription job status (legacy generic endpoint)."""
        payload: dict[str, Any] = {"status": status}

        if progress is not None:
            payload["progress"] = progress
        if started_at:
            payload["startedAt"] = started_at.isoformat()
        if completed_at:
            payload["completedAt"] = completed_at.isoformat()
        if error_code:
            payload["errorCode"] = error_code
        if error_message:
            payload["errorMessage"] = error_message
        if worker_id:
            payload["workerId"] = worker_id

        return await self._request(
            "PATCH",
            f"/internal/stt/jobs/{job_id}/status",
            json=payload,
        )

    # =========================================================================
    # Transcript Creation
    # =========================================================================

    async def create_transcript(
        self,
        transcript_text: str,
        job_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        consultation_id: str | None = None,
        tenant_id: str | None = None,
        transcription_source: str | None = None,
        idempotency_key: str | None = None,
        segments: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Create a transcript context item.

        Calls NestJS ``POST /internal/stt/transcripts`` which expects
        a ``CreateTranscriptRequest`` body.

        Two callers (TASK-342 GAP #1):
          * batch/file: pass ``job_id`` — tenant/creator are derived from the job.
          * streaming finalize: pass ``consultation_id`` + ``tenant_id`` and omit
            ``job_id`` (streaming sessions have no TranscriptionJob).

        Args:
            transcript_text: Full transcript text.
            job_id: Transcription job ID (batch path). Omit for streaming.
            metadata: Optional metadata (word timestamps, confidence, etc.).
            consultation_id: Consultation to associate the transcript with.
                Required when ``job_id`` is omitted.
            tenant_id: Owning tenant ID. Required when ``job_id`` is omitted.
            transcription_source: ``"streaming"`` or ``"batch"`` (event label).
            idempotency_key: Optional client-supplied dedup key sent as the
                ``Idempotency-Key`` header (TASK-456 C2-03 outbox/retry seam).
                NOTE: the gateway does not yet consume this header — today the
                streaming path is already deduped server-side by
                ``consultationId``; the header is forward-compatible and becomes
                authoritative once apps/api honors it (see ticket report).
            segments: Consumer-shaped transcript segments (TASK-533 D-22) —
                ``{idx, t0Ms, t1Ms, speaker, text, charStart, charEnd}``, camelCase,
                milliseconds. Maps onto the typed ``CreateTranscriptRequest.segments``
                field, which is what feeds ``TranscriptSegment`` rows and therefore
                the harness evidence-grounding chain. Omit (or pass empty) and the
                gateway persists no segments — the pre-D-22 behaviour.
        """
        payload: dict[str, Any] = {
            "transcriptText": transcript_text,
        }
        # Sent as a TOP-LEVEL typed field, deliberately NOT inside `metadata`:
        # metadata is an untyped JsonValue, so a wrong shape there bypasses
        # class-validator entirely and silently persists null columns (the D-22
        # batch failure mode). On the typed field a bad shape is a 400.
        if segments:
            payload["segments"] = segments
        if job_id:
            payload["jobId"] = job_id
        if metadata is not None:
            payload["metadata"] = metadata
        if consultation_id:
            payload["consultationId"] = consultation_id
        if tenant_id:
            payload["tenantId"] = tenant_id
        if transcription_source:
            payload["transcriptionSource"] = transcription_source

        # Only attach the header when a key is supplied so the request shape is
        # unchanged for existing callers (the gateway ignores it for now).
        if idempotency_key:
            return await self._request(
                "POST",
                "/internal/stt/transcripts",
                json=payload,
                headers={"Idempotency-Key": idempotency_key},
            )
        return await self._request(
            "POST",
            "/internal/stt/transcripts",
            json=payload,
        )

    # =========================================================================
    # Audio Recording Creation
    # =========================================================================

    async def create_audio_recording(
        self,
        context_item_id: str | None = None,
        media_id: str | None = None,
        tenant_id: str | None = None,
        format: str | None = None,
        sample_rate: int | None = None,
        channels: int | None = None,
        bitrate: int | None = None,
        language: str | None = None,
        sequence_number: int = 1,
        recorded_at: datetime | None = None,
        raw_media_id: str | None = None,
        processed_media_id: str | None = None,
        consultation_id: str | None = None,
        duration_ms: int | None = None,
    ) -> dict[str, Any]:
        """Create an AudioRecording linked to a ContextItem.

        ``raw_media_id`` / ``processed_media_id`` carry the dual-capture Media
        ids (pre-filter / post-filter audio) when the pipeline opts in. The
        streaming finalize path has no pre-resolved ``context_item_id``, so it
        may instead pass ``consultation_id`` for the gateway to attach the
        recording to.
        """
        payload: dict[str, Any] = {"sequenceNumber": sequence_number}

        if context_item_id:
            payload["contextItemId"] = context_item_id
        if media_id:
            payload["mediaId"] = media_id
        if tenant_id:
            payload["tenantId"] = tenant_id
        if consultation_id:
            payload["consultationId"] = consultation_id
        if duration_ms is not None:
            payload["durationMs"] = duration_ms
        if format:
            payload["format"] = format
        if sample_rate:
            payload["sampleRate"] = sample_rate
        if channels:
            payload["channels"] = channels
        if bitrate:
            payload["bitrate"] = bitrate
        if language:
            payload["language"] = language
        if recorded_at:
            payload["recordedAt"] = recorded_at.isoformat()
        if raw_media_id:
            payload["rawMediaId"] = raw_media_id
        if processed_media_id:
            payload["processedMediaId"] = processed_media_id

        return await self._request(
            "POST",
            "/internal/stt/audio-records",
            json=payload,
        )

    # =========================================================================
    # Media Creation
    # =========================================================================

    async def create_media(
        self,
        tenant_id: str,
        name: str,
        uri: str,
        extension: str,
        mime_type: str,
        size: int,
        hash: str,
        created_by: str | None = None,
    ) -> dict[str, Any]:
        """Create a Media record for an audio file."""
        payload = {
            "tenantId": tenant_id,
            "name": name,
            "uri": uri,
            "extension": extension,
            "mimeType": mime_type,
            "size": size,
            "hash": hash,
        }

        if created_by:
            payload["createdBy"] = created_by

        return await self._request(
            "POST",
            "/internal/stt/media",
            json=payload,
        )

    # =========================================================================
    # Health Check
    # =========================================================================

    async def health_check(self) -> bool:
        """Check if API Gateway is reachable."""
        try:
            await self._request("GET", "/health")
            return True
        except APIGatewayError:
            return False


@lru_cache
def get_api_client() -> APIGatewayClient:
    """Get the API Gateway client instance."""
    return APIGatewayClient(
        base_url=settings.api_gateway_url,
        api_key=settings.api_gateway_key,
        timeout=settings.api_gateway_timeout,
    )
