"""OpenAI-compatible speech synthesis endpoint.

``POST /api/v1/audio/speech`` — request shape mirrors OpenAI's Create speech
(``input``/``voice``/``response_format``/``speed``) plus ``stream_format``:
  - unset  → full audio response (batch)
  - "audio" → chunked raw audio bytes (fetch ReadableStream)
  - "sse"   → ``speech.audio.delta`` (base64) events + ``speech.audio.done``
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from tts.catalog.voices import VoiceNotFoundError
from tts.core.usage import (
    UNKNOWN_PROVIDER,
    compute_audio_seconds,
    count_characters,
    record_usage_metrics,
)
from tts.providers.base import CONTENT_TYPES, AudioChunk, AudioFormat
from tts.routing.router import AllProvidersUnavailableError

router = APIRouter(tags=["speech"])

_STREAM_HEADERS = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"}


class SpeechRequest(BaseModel):
    model: str = "tts"
    input: str = Field(min_length=1)
    voice: str
    response_format: AudioFormat = AudioFormat.PCM
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    stream_format: Literal["audio", "sse"] | None = None
    # Per-request routing overrides injected by the gateway from a tenant's
    # resolved config. None → fall back to the static settings chains.
    routing_en: list[str] | None = None
    routing_ml: list[str] | None = None
    allowed_providers: list[str] | None = None
    # Decrypted per-tenant BYO provider credentials, gateway-injected.
    provider_overrides: dict[str, dict[str, str]] | None = None
    # Per-request voice-binding overrides, gateway-resolved from the
    # AiModel registry / tenant TTS config: {internalVoiceId: {provider: voiceName}}.
    # A present entry MERGES over that voice's DEFAULT_VOICES binding map
    # (unmentioned providers keep their catalog binding — "empty = inherit").
    voice_bindings: dict[str, dict[str, str]] | None = None


@router.post("/audio/speech")
async def create_speech(body: SpeechRequest, request: Request) -> Response:
    settings = request.app.state.settings
    tts_router = request.app.state.router
    catalog = request.app.state.voice_catalog

    if len(body.input) > settings.max_input_chars:
        # 413 — nothing was accepted, so nothing is recorded: no headers, no
        # Prometheus counters.
        raise HTTPException(
            status_code=413,
            detail=f"input exceeds max_input_chars ({settings.max_input_chars})",
        )
    try:
        voice = catalog.get(body.voice)
    except VoiceNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"unknown voice: {body.voice}") from exc

    # ACCEPTED input length (contract: 1 Unicode code point = 1
    # character) — computed here, past every rejection path, never re-derived
    # downstream from a re-encoded/truncated copy of the text.
    character_count = count_characters(body.input)
    locale = voice.locale

    # Read-triggered retention refresh (TTL-cached, single-flight,
    # fail-safe): a service that never synthesizes never polls. Applied BEFORE
    # routing so a provider loading its pipeline for this request is already on
    # the current control-plane TTL.
    from tts.core.effective_config import refresh_model_cache_retention

    await refresh_model_cache_retention(request.app.state)

    fmt = body.response_format
    stream = tts_router.synthesize(
        voice_id=body.voice,
        text=body.input,
        fmt=fmt,
        speed=body.speed,
        routing_en=body.routing_en,
        routing_ml=body.routing_ml,
        allowed_providers=body.allowed_providers,
        provider_overrides=body.provider_overrides,
        voice_bindings=body.voice_bindings,
    )

    # Prime the generator so provider-availability errors become an HTTP status
    # BEFORE any streaming headers are committed. This ALSO resolves which
    # provider won failover (AudioChunk.provider) before any
    # response is built, so it can go in a header on every response mode.
    try:
        first: AudioChunk | None = await stream.__anext__()
        exhausted = False
    except StopAsyncIteration:
        first = None
        exhausted = True
    except AllProvidersUnavailableError as exc:
        raise HTTPException(
            status_code=503, detail="no TTS provider available for this voice"
        ) from exc

    provider = first.provider if first is not None else None
    # Accumulated across every chunk this request yields, regardless of which
    # response mode drains it — the SAME counters back batch, SSE, and raw
    # streaming, and are read at teardown (success OR abort) by each mode below.
    audio_bytes_total = 0

    async def chunks() -> AsyncIterator[AudioChunk]:
        nonlocal audio_bytes_total
        try:
            if first is not None:
                audio_bytes_total += len(first.data)
                yield first
            if not exhausted:
                async for chunk in stream:
                    audio_bytes_total += len(chunk.data)
                    yield chunk
        finally:
            await stream.aclose()

    content_type = CONTENT_TYPES[fmt]
    base_headers = {
        "X-Tts-Characters": str(character_count),
        "X-Tts-Sample-Rate": str(settings.sample_rate),
        "X-Tts-Audio-Format": fmt.value,
        "X-Tts-Provider": provider or UNKNOWN_PROVIDER,
    }

    if body.stream_format == "sse":

        async def events() -> AsyncIterator[dict[str, str]]:
            interrupted = True
            try:
                async for chunk in chunks():
                    payload = {"audio": base64.b64encode(chunk.data).decode("ascii")}
                    yield {"event": "speech.audio.delta", "data": json.dumps(payload)}
                interrupted = False
                yield {"event": "speech.audio.done", "data": json.dumps({})}
            finally:
                # SSE is TTS's own framing (unlike the raw byte stream below),
                # so the EXACT final duration can ride the wire as one more
                # event — accumulate + surface at teardown, abort included.
                audio_seconds = compute_audio_seconds(fmt, audio_bytes_total, settings.sample_rate)
                record_usage_metrics(
                    provider=provider,
                    locale=locale,
                    characters=character_count,
                    audio_seconds=audio_seconds,
                    status="aborted" if interrupted else "ok",
                )
                yield {
                    "event": "speech.usage",
                    "data": json.dumps(
                        {
                            "characters": character_count,
                            "audioSeconds": audio_seconds,
                            "interrupted": interrupted,
                        }
                    ),
                }

        return EventSourceResponse(events(), headers={**base_headers, "X-Accel-Buffering": "no"})

    if body.stream_format == "audio":

        async def raw() -> AsyncIterator[bytes]:
            interrupted = True
            try:
                async for chunk in chunks():
                    yield chunk.data
                interrupted = False
            finally:
                # Duration is NOT knowable up front here (raw bytes only, no
                # room for a trailing control frame) — the gateway derives it
                # from X-Tts-Sample-Rate/X-Tts-Audio-Format + the byte count it
                # observes while proxying (same RTF byte math). This is TTS's
                # own accumulate-and-record-at-teardown for the Prometheus view.
                audio_seconds = compute_audio_seconds(fmt, audio_bytes_total, settings.sample_rate)
                record_usage_metrics(
                    provider=provider,
                    locale=locale,
                    characters=character_count,
                    audio_seconds=audio_seconds,
                    status="aborted" if interrupted else "ok",
                )

        # X-Tts-Audio-Seconds is deliberately ABSENT: headers commit before the
        # stream (and therefore the duration) exists.
        return StreamingResponse(
            raw(), media_type=content_type, headers={**base_headers, **_STREAM_HEADERS}
        )

    # Batch: collect the full utterance, then respond — duration IS knowable
    # here, so it rides as a header like everything else.
    interrupted = True
    try:
        buf = bytearray()
        async for chunk in chunks():
            buf += chunk.data
        interrupted = False
    finally:
        audio_seconds = compute_audio_seconds(fmt, audio_bytes_total, settings.sample_rate)
        record_usage_metrics(
            provider=provider,
            locale=locale,
            characters=character_count,
            audio_seconds=audio_seconds,
            status="aborted" if interrupted else "ok",
        )
    return Response(
        content=bytes(buf),
        media_type=content_type,
        headers={
            **base_headers,
            "Cache-Control": "no-store",
            **({"X-Tts-Audio-Seconds": str(audio_seconds)} if audio_seconds is not None else {}),
        },
    )
