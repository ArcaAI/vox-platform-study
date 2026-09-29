"""``POST /api/v1/transcriptions`` — decode ONE audio window; ``POST /api/v1/engines/warm``.

Body encoding — JSON with base64 audio, chosen over a binary body:

* the request carries a NESTED resolved spec that must validate strictly
  (``extra='forbid'``); a binary body would push it into headers or multipart;
* one self-describing body is one atomic unit to validate, log (without the audio) and
  replay in the bench;
* the cost is small: a 7 s PCM16 window is 224 KB raw, ~299 KB base64 (+33 %), decoded in
  well under a millisecond — noise next to a decode measured in hundreds of ms, on an
  in-cluster hop.

Envelope keys are snake_case (a Python-to-Python internal API); ``spec`` keeps the
gateway's camelCase wire names so STT forwards it without renaming (see ``hope_vllm.spec``).

Concurrency is NOT managed here. Every accepted window goes straight to the engine and
joins vLLM's running batch; this layer adds no lock, queue or semaphore that could
serialise streams in front of it.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Annotated, Literal

import numpy as np
import numpy.typing as npt
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from hope_obs import get_logger
from pydantic import BaseModel, ConfigDict, Field

from hope_vllm.audio import SAMPLE_RATE, AudioError, decode_pcm16_b64, voiced_seconds
from hope_vllm.core import metrics
from hope_vllm.core.config import Settings
from hope_vllm.core.effective_config import schedule_control_plane_refresh
from hope_vllm.engine.base import DecoderBudgetError, DecodeRequest
from hope_vllm.engine.pool import (
    EngineCapacityError,
    EngineLoadError,
    EnginePool,
    RuntimeKeySpecMismatchError,
)
from hope_vllm.spec import ResolvedServingSpec
from hope_vllm.truncation import assess_truncation

router = APIRouter(tags=["transcriptions"])
logger = get_logger(__name__)

#: Seconds a client should wait before retrying a capacity refusal (a decode window).
_CAPACITY_RETRY_AFTER_S = "1"


# ── wire models ─────────────────────────────────────────────────────────────


class TranscriptionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    spec: ResolvedServingSpec
    #: PCM16 little-endian, mono, 16 kHz, base64 — at most 30 s.
    audio_b64: str
    sample_rate: Literal[16000] = 16000
    #: Whisper language token, e.g. ``ml`` / ``en``.
    language: str = Field(pattern=r"^[a-z]{2,3}$")
    #: Previous text (``<|startofprev|>``). TASK-994: omit it for the ml-en fine-tune.
    prompt: str | None = None
    temperature: float = Field(default=0.0, ge=0.0, le=1.0)
    #: Generation cap; absent = the whole remaining decoder context, never vLLM's 16.
    max_tokens: int | None = Field(default=None, ge=1)


class Timings(BaseModel):
    #: Wait for a ready engine at this replica (load / single-flight) before submit.
    queue_ms: float
    #: Engine submit → final output (includes vLLM's scheduling and the batch).
    decode_ms: float
    #: vLLM's own scheduler wait, when the engine reports it.
    engine_queue_ms: float | None = None


class Truncation(BaseModel):
    suspected: bool
    reason: str | None
    voiced_seconds: float
    chars: int


class TranscriptionResponse(BaseModel):
    text: str
    language: str
    runtime_key: str
    audio_seconds: float
    finish_reason: str | None
    timings: Timings
    truncation: Truncation


class WarmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    spec: ResolvedServingSpec


class WarmResponse(BaseModel):
    runtime_key: str
    already_resident: bool
    load_seconds: float


# ── helpers ─────────────────────────────────────────────────────────────────


def _error(
    status: int, code: str, message: str, headers: dict[str, str] | None = None
) -> HTTPException:
    return HTTPException(
        status_code=status, detail={"code": code, "message": message}, headers=headers
    )


def require_tenant(x_tenant_id: Annotated[str | None, Header()] = None) -> str:
    """``X-Tenant-Id`` is mandatory on tenant-scoped internal work (owner directive)."""
    tenant = (x_tenant_id or "").strip()
    if not tenant:
        raise _error(400, "TENANT_ID_REQUIRED", "X-Tenant-Id header is required")
    return tenant


def _require_backend(request: Request) -> None:
    reason = request.app.state.engine_factory.availability()
    if reason is not None:
        raise _error(503, "ENGINE_BACKEND_UNAVAILABLE", reason)


def _prepare_audio(data: str, threshold_dbfs: float) -> tuple[npt.NDArray[np.float32], float]:
    samples = decode_pcm16_b64(data)
    return samples, voiced_seconds(samples, threshold_dbfs=threshold_dbfs)


# ── routes ──────────────────────────────────────────────────────────────────


@router.post("/transcriptions", response_model=TranscriptionResponse)
async def transcribe(
    body: TranscriptionRequest,
    request: Request,
    tenant_id: Annotated[str, Depends(require_tenant)],
) -> TranscriptionResponse:
    settings: Settings = request.app.state.settings
    pool: EnginePool = request.app.state.engine_pool
    _require_backend(request)
    # The truncation knobs are read per request from `settings`; a stale control plane is
    # refreshed in the BACKGROUND so this window never waits on the gateway.
    schedule_control_plane_refresh(request.app.state)

    try:
        # Off the event loop: liveness must never wait behind request work.
        audio, voiced = await asyncio.to_thread(
            _prepare_audio, body.audio_b64, settings.truncation_voiced_dbfs
        )
    except AudioError as exc:
        metrics.WINDOWS_TOTAL.labels(outcome="rejected").inc()
        raise _error(422, exc.code, str(exc)) from None

    metrics.INFLIGHT_WINDOWS.inc()
    started = time.perf_counter()
    try:
        async with pool.lease(body.spec) as engine:
            queue_ms = (time.perf_counter() - started) * 1000.0
            result = await engine.transcribe(
                DecodeRequest(
                    audio=audio,
                    language=body.language,
                    prompt=body.prompt,
                    temperature=body.temperature,
                    max_tokens=body.max_tokens,
                    request_id=uuid.uuid4().hex,
                )
            )
    except EngineCapacityError:
        metrics.WINDOWS_TOTAL.labels(outcome="capacity").inc()
        raise _error(
            503,
            "ENGINE_CAPACITY",
            "every resident engine is busy and the residency bound is reached",
            headers={"Retry-After": _CAPACITY_RETRY_AFTER_S},
        ) from None
    except RuntimeKeySpecMismatchError:
        metrics.WINDOWS_TOTAL.labels(outcome="spec_mismatch").inc()
        raise _error(
            409,
            "RUNTIME_KEY_SPEC_MISMATCH",
            f"runtime key {body.spec.runtime_key} is already bound to a different model spec",
        ) from None
    except EngineLoadError as exc:
        metrics.WINDOWS_TOTAL.labels(outcome="load_failed").inc()
        raise _error(503, exc.code, str(exc)) from None
    except DecoderBudgetError as exc:
        metrics.WINDOWS_TOTAL.labels(outcome="rejected").inc()
        raise _error(422, "PROMPT_EXCEEDS_DECODER_CONTEXT", str(exc)) from None
    finally:
        metrics.INFLIGHT_WINDOWS.dec()

    truncation = assess_truncation(
        result.text,
        finish_reason=result.finish_reason,
        voiced_seconds=voiced,
        min_chars_per_voiced_second=settings.truncation_min_chars_per_voiced_second,
    )
    metrics.WINDOWS_TOTAL.labels(outcome="ok").inc()
    metrics.SERVICE_QUEUE_SECONDS.observe(queue_ms / 1000.0)
    metrics.DECODE_SECONDS.observe(result.decode_ms / 1000.0)
    if result.engine_queue_ms is not None:
        metrics.ENGINE_QUEUE_SECONDS.observe(result.engine_queue_ms / 1000.0)
    if truncation.suspected and truncation.reason:
        metrics.TRUNCATION_SUSPECTED_TOTAL.labels(reason=truncation.reason).inc()
        logger.warning(
            "vllm.transcription.truncation_suspected",
            runtime_key=body.spec.runtime_key,
            reason=truncation.reason,
            voiced_seconds=truncation.voiced_seconds,
            chars=truncation.chars,
        )

    return TranscriptionResponse(
        text=result.text,
        language=body.language,
        runtime_key=body.spec.runtime_key,
        audio_seconds=round(audio.shape[0] / SAMPLE_RATE, 3),
        finish_reason=result.finish_reason,
        timings=Timings(
            queue_ms=round(queue_ms, 3),
            decode_ms=round(result.decode_ms, 3),
            engine_queue_ms=(
                None if result.engine_queue_ms is None else round(result.engine_queue_ms, 3)
            ),
        ),
        truncation=Truncation(
            suspected=truncation.suspected,
            reason=truncation.reason,
            voiced_seconds=truncation.voiced_seconds,
            chars=truncation.chars,
        ),
    )


@router.post("/engines/warm", response_model=WarmResponse)
async def warm(
    body: WarmRequest,
    request: Request,
    tenant_id: Annotated[str, Depends(require_tenant)],
) -> WarmResponse:
    """Load the engine for ``spec`` now, so a new replica's first window pays no cold start."""
    _require_backend(request)
    pool: EnginePool = request.app.state.engine_pool
    try:
        load_seconds, already = await pool.warm(body.spec)
    except EngineCapacityError:
        raise _error(
            503,
            "ENGINE_CAPACITY",
            "every resident engine is busy and the residency bound is reached",
            headers={"Retry-After": _CAPACITY_RETRY_AFTER_S},
        ) from None
    except RuntimeKeySpecMismatchError:
        raise _error(
            409,
            "RUNTIME_KEY_SPEC_MISMATCH",
            f"runtime key {body.spec.runtime_key} is already bound to a different model spec",
        ) from None
    except EngineLoadError as exc:
        raise _error(503, exc.code, str(exc)) from None
    return WarmResponse(
        runtime_key=body.spec.runtime_key,
        already_resident=already,
        load_seconds=round(load_seconds, 3),
    )
