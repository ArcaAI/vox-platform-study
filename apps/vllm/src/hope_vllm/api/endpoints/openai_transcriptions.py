"""``POST /v1/audio/transcriptions`` — the OpenAI transcription schema over vLLM Whisper (C-3).

A THIN HOPE implementation of the schema, not vLLM's upstream handler (D-8): vLLM 0.30.0's
own transcription route prefixes prior text with ``<|prev|>`` — not a Whisper token — and
leaves ``SamplingParams.max_tokens`` at its default of 16, a silent truncation. This route
drives the spike's ``VllmWhisperEngine`` (``build_decoder_prompt`` / ``resolve_max_tokens``
fix both) and speaks the OpenAI wire format, so a stock OpenAI client works unchanged.

One deviation from OpenAI: ``language`` is REQUIRED — Whisper-on-vLLM needs the language
token, and detection is not offered.

Per request: ``model=<slug>`` → the gateway's ``ResolvedServingSpec`` for the CALLING tenant
(cached, ``core/serving_spec_client.py``) → a lease on that engine → one decode. Nothing
serialises requests here; every accepted window joins vLLM's running batch.

A client that goes away mid-decode is noticed (Starlette never cancels a handler for a
disconnect): the decode is cancelled, which aborts the request inside vLLM and releases
the lease (review focus 4).
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import time
import uuid
from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Literal, TypeVar

import numpy as np
import numpy.typing as npt
from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from hope_obs import get_logger

from hope_vllm.api.openai_errors import OpenAIError, openai_error
from hope_vllm.audio import AudioError, decode_wav, voiced_seconds
from hope_vllm.core import metrics
from hope_vllm.core.config import Settings
from hope_vllm.core.effective_config import schedule_control_plane_refresh
from hope_vllm.core.serving_spec_client import (
    ModelNotFound,
    ModelNotServable,
    ServingSpecUnavailable,
)
from hope_vllm.engine.base import (
    DecoderBudgetError,
    DecodeRequest,
    DecodeResult,
    EngineBuildRefused,
)
from hope_vllm.engine.pool import (
    ENGINE_LOAD_FAILED,
    EngineCapacityError,
    EngineLoadError,
    EnginePool,
    EngineSaturatedError,
    RuntimeKeySpecMismatchError,
)
from hope_vllm.spec import ResolvedServingSpec
from hope_vllm.truncation import assess_truncation

router = APIRouter(tags=["openai"])
logger = get_logger(__name__)

#: Seconds a client should wait before retrying a capacity / saturation refusal.
RETRY_AFTER_S = "1"
#: How often a running decode checks whether its client is still there.
_DISCONNECT_POLL_S = 0.25
_LANGUAGE = re.compile(r"^[a-z]{2,3}$")

T = TypeVar("T")


def _prepare_audio(
    data: bytes, threshold_dbfs: float
) -> tuple[npt.NDArray[np.float32], float, float]:
    samples, duration = decode_wav(data)
    return samples, duration, voiced_seconds(samples, threshold_dbfs=threshold_dbfs)


class ClientDisconnected(Exception):
    """The caller hung up before the decode finished."""


async def run_unless_disconnected(request: Request, work: Awaitable[T]) -> T:
    """Await ``work``; cancel it (and raise :class:`ClientDisconnected`) if the client leaves."""
    task: asyncio.Task[T] = asyncio.ensure_future(work)
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=_DISCONNECT_POLL_S)
            if done:
                return task.result()
            if await request.is_disconnected():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
                raise ClientDisconnected
    finally:
        if not task.done():  # this handler itself was cancelled
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


def _require_backend(request: Request) -> None:
    reason = request.app.state.engine_factory.availability()
    if reason is not None:
        raise openai_error(503, "ENGINE_BACKEND_UNAVAILABLE", reason, retry_after=RETRY_AFTER_S)


async def _resolve(request: Request, slug: str, tenant_id: str) -> ResolvedServingSpec:
    try:
        spec: ResolvedServingSpec = await request.app.state.serving_spec_client.resolve(
            slug, tenant_id
        )
    except ModelNotFound:
        raise openai_error(
            404, "model_not_found", f"The model '{slug}' does not exist", param="model"
        ) from None
    except ModelNotServable as exc:
        raise openai_error(
            409,
            "model_not_servable",
            f"The model '{slug}' cannot be served: {exc.reason}",
            param="model",
        ) from None
    except ServingSpecUnavailable as exc:
        raise openai_error(
            503, "serving_spec_unavailable", str(exc), retry_after=RETRY_AFTER_S
        ) from None
    return spec


async def _decode(
    pool: EnginePool, spec: ResolvedServingSpec, decode: DecodeRequest
) -> DecodeResult:
    try:
        async with pool.lease(spec) as engine:
            return await engine.transcribe(decode)
    except EngineSaturatedError:
        raise openai_error(
            429,
            "engine_saturated",
            f"model '{spec.slug}' is at its concurrent-request limit on this replica",
            retry_after=RETRY_AFTER_S,
        ) from None
    except EngineCapacityError:
        raise openai_error(
            503,
            "engine_capacity",
            "every resident engine is busy and this pool has no room for another",
            retry_after=RETRY_AFTER_S,
        ) from None
    except EngineBuildRefused as exc:  # refused at admission (VRAM_BUDGET_EXCEEDED)
        raise openai_error(503, exc.code, str(exc)) from None
    except EngineLoadError as exc:
        code = "engine_load_failed" if exc.code == ENGINE_LOAD_FAILED else exc.code
        raise openai_error(503, code, str(exc)) from None
    except ModelNotServable as exc:  # KIND_NOT_ACCEPTED
        raise openai_error(
            409,
            "model_not_servable",
            f"The model '{spec.slug}' cannot be served: {exc.reason}",
            param="model",
        ) from None
    except RuntimeKeySpecMismatchError:
        raise openai_error(
            409,
            "model_not_servable",
            f"The model '{spec.slug}' cannot be served: RUNTIME_KEY_SPEC_MISMATCH — its "
            "runtime key is resident with different weights",
            param="model",
        ) from None
    except DecoderBudgetError as exc:
        raise openai_error(400, "prompt_too_long", str(exc), param="prompt") from None


ROUTE = "/v1/audio/transcriptions"

#: Refusals the POOL already counts in `hope_vllm_rejections_total` (never twice).
_POOL_COUNTED = frozenset({"engine_capacity", "engine_saturated", "VRAM_BUDGET_EXCEEDED"})


@dataclass
class _Labels:
    """Metric labels, filled in as the request learns them. `model` stays `unresolved`
    until the GATEWAY resolved the slug — a client cannot mint label values."""

    kind: str = "unknown"
    model: str = "unresolved"


@router.post(ROUTE, response_model=None)
async def create_transcription(
    request: Request,
    file: UploadFile = File(...),
    model: str = Form(..., min_length=1),
    language: str | None = Form(None),
    prompt: str | None = Form(None),
    temperature: float = Form(0.0),
    response_format: Literal["json", "text", "verbose_json"] = Form("json"),
) -> Response:
    labels = _Labels()
    started = time.perf_counter()
    status = 500
    try:
        response = await _transcribe(
            request, labels, file, model, language, prompt, temperature, response_format
        )
        status = response.status_code
        return response
    except OpenAIError as exc:
        status = exc.status
        if exc.code not in _POOL_COUNTED:
            metrics.REJECTIONS_TOTAL.labels(reason=exc.code.lower()).inc()
        raise
    finally:
        metrics.REQUESTS_TOTAL.labels(
            route=ROUTE, kind=labels.kind, model=labels.model, status=str(status)
        ).inc()
        metrics.REQUEST_SECONDS.labels(route=ROUTE, kind=labels.kind).observe(
            time.perf_counter() - started
        )


async def _transcribe(
    request: Request,
    labels: _Labels,
    file: UploadFile,
    model: str,
    language: str | None,
    prompt: str | None,
    temperature: float,
    response_format: str,
) -> Response:
    tenant_id: str = request.state.tenant_id
    settings: Settings = request.app.state.settings
    if not language:
        raise openai_error(
            400, "language_required", "'language' is required (ISO-639-1)", param="language"
        )
    if not _LANGUAGE.match(language):
        raise openai_error(
            400, "invalid_value", "'language' must be an ISO-639-1 code", param="language"
        )
    if not 0.0 <= temperature <= 1.0:
        raise openai_error(
            400, "invalid_value", "'temperature' must be between 0 and 1", param="temperature"
        )
    _require_backend(request)
    # The truncation knobs are read per request; a stale control plane refreshes in the
    # BACKGROUND so this request never waits on the gateway.
    schedule_control_plane_refresh(request.app.state)

    data = await file.read()
    try:
        # Off the event loop: liveness must never wait behind request work.
        samples, duration, voiced = await asyncio.to_thread(
            _prepare_audio, data, settings.truncation_voiced_dbfs
        )
    except AudioError as exc:
        raise openai_error(400, exc.code, str(exc), param="file") from None

    spec = await _resolve(request, model, tenant_id)
    labels.kind, labels.model = spec.kind, spec.slug
    pool: EnginePool = request.app.state.engine_pool
    decode = DecodeRequest(
        audio=samples,
        language=language,
        prompt=prompt or None,
        temperature=temperature,
        max_tokens=None,  # the whole remaining decoder context — never vLLM's 16
        request_id=uuid.uuid4().hex,
    )
    try:
        result = await run_unless_disconnected(request, _decode(pool, spec, decode))
    except ClientDisconnected:
        logger.info("vllm.transcription.client_disconnected", runtime_key=spec.runtime_key)
        return Response(status_code=499)

    if duration > 0:
        metrics.ASR_RTF.labels(model=spec.slug).observe(result.decode_ms / 1000.0 / duration)
    if result.engine_queue_ms is not None:
        metrics.ENGINE_QUEUE_SECONDS.observe(result.engine_queue_ms / 1000.0)
    truncation = assess_truncation(
        result.text,
        finish_reason=result.finish_reason,
        voiced_seconds=voiced,
        min_chars_per_voiced_second=settings.truncation_min_chars_per_voiced_second,
    )
    if truncation.suspected and truncation.reason:
        metrics.TRUNCATION_SUSPECTED_TOTAL.labels(reason=truncation.reason).inc()
        logger.warning(
            "vllm.transcription.truncation_suspected",
            runtime_key=spec.runtime_key,
            reason=truncation.reason,
            voiced_seconds=truncation.voiced_seconds,
            chars=truncation.chars,
        )

    if response_format == "text":
        return PlainTextResponse(result.text)
    if response_format == "json":
        return JSONResponse({"text": result.text})
    return JSONResponse(
        {
            "task": "transcribe",
            "language": language,
            "duration": round(duration, 2),
            "text": result.text,
            "segments": [],
            "x_hope": {
                "finish_reason": result.finish_reason,
                "decode_ms": round(result.decode_ms, 1),
                "engine_queue_ms": (
                    None if result.engine_queue_ms is None else round(result.engine_queue_ms, 1)
                ),
                "truncation": {
                    "suspected": truncation.suspected,
                    "reason": truncation.reason,
                    "voiced_seconds": round(truncation.voiced_seconds, 2),
                    "chars": truncation.chars,
                },
            },
        }
    )
