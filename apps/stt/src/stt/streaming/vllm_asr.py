"""Whisper on the in-cluster `vllm` service — per-window REST recognition (TASK-1021).

Transcribes one audio window (≤ 30 s) through the OpenAI transcription schema the
`vllm` service implements (contract C-3): ``POST {base_url}/audio/transcriptions``,
multipart WAV, ``response_format=verbose_json``. Mirrors
:mod:`stt.streaming.openai_asr`, with three differences that follow from the
server being OUR hardware rather than a vendor's:

* **Auth is the house peer pattern** (D-10): ``X-Service-Token`` carries this
  service's ``INTERNAL_ACCESS_TOKEN``, ``X-Tenant-Id`` is mandatory, and the
  request id and W3C ``traceparent`` ride along so one clinical utterance is one
  trace across `stt` and `vllm`.
* **Backpressure is local.** A per-process, per-event-loop semaphore keyed by
  ``base_url`` caps in-flight requests at the connection's ``max_concurrent``, and a
  429/503 from a saturated engine is retried briefly (``Retry-After``, capped) before
  it is raised as a typed Cloud ASR error, which is what ``engine_switch`` fails
  over on.
* **Truncation is reported, never guessed.** The server returns
  ``x_hope.truncation`` (D-9); a suspected truncation is logged by its shape only —
  never the transcript.
"""

from __future__ import annotations

import asyncio
import contextlib
import weakref
from typing import Any

import httpx
import numpy as np
import structlog
from hope_obs import outbound_context_headers
from hope_otel.trace_propagation import inject_trace_carrier

from stt.core.exceptions import CloudASRTranscriptionError
from stt.models.cloud_asr import (
    raise_for_cloud_status,
    raise_for_cloud_transport,
    wav_bytes_from_samples,
)
from stt.models.vllm_loader import VllmAsrConfig

logger = structlog.get_logger(__name__)

PROVIDER = "vllm"
#: Retries after the first attempt on a 429 (engine saturated) or 503 (capacity).
_MAX_RETRIES = 2
#: ``Retry-After`` absent or unparseable → this; a larger value is capped at the ceiling.
_DEFAULT_RETRY_AFTER_S = 0.5
_RETRY_AFTER_CEILING_S = 2.0
_RETRYABLE_STATUSES = frozenset({429, 503})

#: ``asyncio.Semaphore`` binds to the loop it first blocks on, and this process runs
#: more than one loop (the API loop and each worker thread's), so the cap is kept per
#: loop. Entries die with their loop.
_SEMAPHORES: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, dict[str, tuple[int, asyncio.Semaphore]]
] = weakref.WeakKeyDictionary()


def _http_client(timeout_s: float) -> httpx.AsyncClient:
    """The HTTP client for one request (a seam for the wire-level tests)."""
    return httpx.AsyncClient(timeout=timeout_s)


def _slot(config: VllmAsrConfig) -> contextlib.AbstractAsyncContextManager[Any]:
    """The in-flight slot for ``config.base_url`` — unbounded when no cap is declared."""
    if config.max_concurrent is None:
        return contextlib.nullcontext()
    per_loop = _SEMAPHORES.setdefault(asyncio.get_running_loop(), {})
    current = per_loop.get(config.base_url)
    if current is None or current[0] != config.max_concurrent:
        # A changed cap (a connection edit) takes a fresh semaphore; requests holding
        # the old one release it as they finish.
        current = (config.max_concurrent, asyncio.Semaphore(config.max_concurrent))
        per_loop[config.base_url] = current
    return current[1]


def _retry_after_s(response: httpx.Response) -> float:
    try:
        value = float(response.headers.get("Retry-After", _DEFAULT_RETRY_AFTER_S))
    except ValueError:
        value = _DEFAULT_RETRY_AFTER_S
    return max(0.0, min(value, _RETRY_AFTER_CEILING_S))


def _error_detail(response: httpx.Response) -> str:
    """``<code>: <message>`` from the OpenAI error shape, else the raw body (bounded)."""
    try:
        error = response.json().get("error") or {}
    except (ValueError, AttributeError):
        return response.text[:500]
    if not isinstance(error, dict):
        return response.text[:500]
    code = error.get("code") or error.get("type") or "error"
    message = str(error.get("message") or "")[:300]
    return f"{code}: {message}" if message else str(code)


def _headers(tenant_id: str, request_id: str | None, service_token: str) -> dict[str, str]:
    headers = {"X-Service-Token": service_token, "X-Tenant-Id": tenant_id}
    headers.update(outbound_context_headers())
    if request_id:
        headers["X-Request-Id"] = request_id
    headers.update(inject_trace_carrier())
    return headers


async def vllm_recognize_utterance(
    config: VllmAsrConfig,
    samples: np.ndarray,
    sample_rate: int,
    *,
    language: str,
    prompt: str | None,
    tenant_id: str,
    request_id: str | None,
    service_token: str,
) -> dict[str, Any]:
    """Transcribe one window via ``POST {base_url}/audio/transcriptions``.

    Returns ``{"text", "word_timestamps": [], "language", "truncation",
    "request_bytes", "response_bytes", "byte_source"}`` — the keys of
    :func:`~stt.streaming.openai_asr.openai_recognize_utterance` plus
    ``truncation`` (the server's ``x_hope.truncation``, or ``None``).
    ``byte_source`` is ``None``: the `vllm` service is platform hardware, so these
    bytes are not third-party egress (TASK-959 §4.2 — the absence is the signal
    that keeps a self-hosted engine out of the egress sums).

    ``prompt`` is the agent's configured initial prompt, passed through unchanged;
    this client never adds prior-transcript context (TASK-994).

    Raises:
        CloudASRAuthError: 401/403 — the service token was refused.
        CloudASRQuotaError: 429 after the retries.
        CloudASRTranscriptionError: 503 after the retries, any other 4xx/5xx, a
            transport failure, or no language to send.
    """
    primary = (language or "").split("-")[0].strip().lower()
    if not primary:
        # Whisper-on-vLLM needs the language token (C-3 deviates from OpenAI here);
        # the server would answer 400 `language_required`.
        raise CloudASRTranscriptionError(
            "vllm transcription requires a language: the session resolved none"
        )
    if not tenant_id:
        raise CloudASRTranscriptionError("vllm transcription requires X-Tenant-Id")

    wav = wav_bytes_from_samples(samples, sample_rate)
    data: dict[str, str] = {
        "model": config.model_slug,
        "language": primary,
        "response_format": "verbose_json",
        "temperature": "0",
    }
    if prompt:
        data["prompt"] = prompt
    headers = _headers(tenant_id, request_id, service_token)
    url = config.base_url.rstrip("/") + "/audio/transcriptions"

    attempt = 0
    while True:
        async with _slot(config):
            try:
                async with _http_client(config.timeout_s) as client:
                    response = await client.post(
                        url,
                        data=data,
                        files={"file": ("audio.wav", wav, "audio/wav")},
                        headers=headers,
                    )
            except httpx.RequestError as exc:
                raise_for_cloud_transport(PROVIDER, type(exc).__name__)
        if response.status_code in _RETRYABLE_STATUSES and attempt < _MAX_RETRIES:
            attempt += 1
            delay = _retry_after_s(response)
            logger.info(
                "stt.vllm.retry",
                model_slug=config.model_slug,
                status=response.status_code,
                attempt=attempt,
                delay_s=delay,
            )
            # Sleep OUTSIDE the slot: a saturated engine is exactly when the slot
            # must go to a request that can use it.
            await asyncio.sleep(delay)
            continue
        break

    if response.status_code >= 400:
        raise_for_cloud_status(PROVIDER, response.status_code, _error_detail(response))

    try:
        payload = response.json()
    except ValueError:
        raise CloudASRTranscriptionError("vllm returned a non-JSON transcription body") from None

    x_hope = payload.get("x_hope") if isinstance(payload, dict) else None
    truncation = x_hope.get("truncation") if isinstance(x_hope, dict) else None
    if isinstance(truncation, dict) and truncation.get("suspected"):
        logger.warning(
            "stt.vllm.truncation_suspected",
            model_slug=config.model_slug,
            reason=truncation.get("reason"),
            voiced_seconds=truncation.get("voiced_seconds"),
            chars=truncation.get("chars"),
        )

    return {
        "text": (payload.get("text") or "").strip(),
        "word_timestamps": [],
        "language": payload.get("language") or primary,
        "truncation": truncation if isinstance(truncation, dict) else None,
        "request_bytes": len(wav),
        "response_bytes": len(response.content),
        "byte_source": None,
    }


#: The route's hard ceiling (C-3: ``file`` ≤ 30 s). A window never exceeds it.
MAX_WINDOW_S = 30.0


def split_windows(
    samples: np.ndarray, sample_rate: int, window_s: float | None
) -> list[tuple[int, int]]:
    """``[start, end)`` sample spans of at most ``min(window_s, 30 s)``.

    The segmenter is the whisper.cpp one, reused as-is rather than rewritten: it
    cuts at the quietest 30 ms frame in the back half of each window, which keeps a
    cut out of the middle of a word. ``_split_spans`` reads no adapter state beyond
    the static ``_quietest_in_range``, so a bare instance serves it.
    """
    from stt.streaming.whisper_cpp_asr import WhisperCppAsrAdapter

    limit = MAX_WINDOW_S if not window_s or window_s <= 0 else min(float(window_s), MAX_WINDOW_S)
    splitter = WhisperCppAsrAdapter.__new__(WhisperCppAsrAdapter)
    return splitter._split_spans(np.asarray(samples, dtype=np.float32), sample_rate, limit)


async def vllm_recognize_windows(
    config: VllmAsrConfig,
    samples: np.ndarray,
    sample_rate: int,
    *,
    window_s: float | None,
    language: str,
    prompt: str | None,
    tenant_id: str,
    request_id: str | None,
    service_token: str,
) -> dict[str, Any]:
    """Transcribe audio of any length as ≤ 30 s windows, decoded concurrently.

    Windows are cut by :func:`split_windows`, sent together with ``asyncio.gather``
    (the per-``base_url`` semaphore in :func:`vllm_recognize_utterance` bounds how
    many are in flight), and reassembled in AUDIO order: one segment per window,
    its times offset by the window's start. Every window carries the same agent
    prompt — never the previous window's text (TASK-994).
    """
    audio = np.asarray(samples, dtype=np.float32)
    spans = split_windows(audio, sample_rate, window_s)
    results = await asyncio.gather(
        *(
            vllm_recognize_utterance(
                config,
                audio[start:end],
                sample_rate,
                language=language,
                prompt=prompt,
                tenant_id=tenant_id,
                request_id=request_id,
                service_token=service_token,
            )
            for start, end in spans
        )
    )

    segments: list[dict[str, Any]] = []
    for (start, end), result in zip(spans, results, strict=True):
        if result["text"]:
            segments.append(
                {
                    "text": result["text"],
                    "start": round(start / float(sample_rate), 4),
                    "end": round(end / float(sample_rate), 4),
                }
            )
    suspected = [
        r["truncation"]
        for r in results
        if isinstance(r.get("truncation"), dict) and r["truncation"].get("suspected")
    ]
    return {
        "text": " ".join(seg["text"] for seg in segments),
        "word_timestamps": [],
        "segments": segments,
        "language": results[0]["language"] if results else None,
        "truncation": (
            suspected[0] if suspected else (results[-1]["truncation"] if results else None)
        ),
        "request_bytes": sum(int(r["request_bytes"]) for r in results),
        "response_bytes": sum(int(r["response_bytes"]) for r in results),
        "byte_source": None,
    }
