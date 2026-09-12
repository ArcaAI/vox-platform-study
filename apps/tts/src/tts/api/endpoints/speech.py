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

from tts.core.usage import (
    UNKNOWN_PROVIDER,
    compute_audio_seconds,
    count_characters,
    record_usage_metrics,
)
from tts.providers.base import CONTENT_TYPES, AudioChunk, AudioFormat
from tts.routing.router import AllProvidersUnavailableError
from tts.spec import ResolvedTtsCandidate, ResolvedTtsSpec, candidate_chain

router = APIRouter(tags=["speech"])


def _connection_of(candidate: ResolvedTtsCandidate) -> str | None:
    return candidate.connection.connection_id if candidate.connection else None


_STREAM_HEADERS = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"}


class SpeechRequest(BaseModel):
    model: str = "tts"
    input: str = Field(min_length=1)
    # OPTIONAL since TASK-879. Absent ⇒ the resolved agent's own `parameters.voice`, which is what
    # a caller that has not chosen a voice should get: the tenant's configured one, not a service
    # default. When present it must be a voice the candidate's bound model actually declares —
    # an unknown one is a 404, never a substituted voice.
    voice: str | None = None
    response_format: AudioFormat = AudioFormat.PCM
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    stream_format: Literal["audio", "sse"] | None = None
    # The gateway-resolved TEXT_TO_SPEECH agent: engine chain, models, voices, connections and
    # the funding-gated fallback governance. REQUIRED — this service reads no selection of its
    # own, so a request without one cannot be served on anything but a guessed vendor.
    #
    # It REPLACES `routing_en` / `routing_ml` / `allowed_providers` / `voice_bindings`, which were
    # the `TenantTtsConfig` fold.
    resolved_spec: ResolvedTtsSpec
    # Decrypted per-tenant BYO provider credentials, gateway-injected. They ride BESIDE the spec
    # rather than on it: a credential must never travel on a document anything might persist.
    provider_overrides: dict[str, dict[str, str]] | None = None


@router.post("/audio/speech")
async def create_speech(body: SpeechRequest, request: Request) -> Response:
    settings = request.app.state.settings
    tts_router = request.app.state.router

    if len(body.input) > settings.max_input_chars:
        # 413 — nothing was accepted, so nothing is recorded: no headers, no
        # Prometheus counters.
        raise HTTPException(
            status_code=413,
            detail=f"input exceeds max_input_chars ({settings.max_input_chars})",
        )

    # Resolve the chain ONCE, here, so the two failure modes stay distinguishable: a voice this
    # agent's models do not declare is the CALLER's error (404), while an agent whose engines are
    # all disabled or failing is the SERVICE's (503). Deriving both from one empty list downstream
    # would collapse them into whichever status the router happened to raise.
    chain = candidate_chain(body.resolved_spec, voice_id=body.voice)
    if not chain and body.voice is not None:
        raise HTTPException(
            status_code=404,
            detail=f"unknown voice for the resolved agent: {body.voice}",
        )

    # ACCEPTED input length (contract: 1 Unicode code point = 1
    # character) — computed here, past every rejection path, never re-derived
    # downstream from a re-encoded/truncated copy of the text.
    character_count = count_characters(body.input)
    # Provisional: the chain's first candidate. Re-read from the candidate that actually WON once
    # the first byte has shipped (below) — a failover changes both, and a header that describes
    # the candidate that did not serve is worse than no header.
    head = chain[0] if chain else body.resolved_spec.primary
    head_binding = head.binding_for(body.voice)
    locale = (head_binding.locale if head_binding else None) or head.parameters.language or ""
    sample_rate = head.sample_rate()

    # Read-triggered retention refresh (TTL-cached, single-flight,
    # fail-safe): a service that never synthesizes never polls. Applied BEFORE
    # routing so a provider loading its pipeline for this request is already on
    # the current control-plane TTL.
    from tts.core.effective_config import refresh_model_cache_retention

    await refresh_model_cache_retention(request.app.state)

    fmt = body.response_format
    # TASK-959 — an out-parameter the router fills with the winning candidate's actual
    # synthesis wall-clock (`gen_s`) once the WHOLE utterance has been produced. Only the
    # batch branch below ever reads it: batch is the only mode that consumes the full
    # generator before its headers are built.
    timing: dict[str, float] = {}
    stream = tts_router.synthesize(
        spec=body.resolved_spec,
        voice_id=body.voice,
        text=body.input,
        fmt=fmt,
        speed=body.speed,
        provider_overrides=body.provider_overrides,
        timing=timing,
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
    # TASK-958 — WHICH connection of that provider served. Read off the chunk the router
    # stamped, never re-derived by matching the provider NAME against the chain: a tenant
    # with two accounts of one vendor has two candidates answering to that name, and the
    # first match would attribute the spend to whichever one happens to come first.
    connection_id = first.connection_id if first is not None else None
    # TASK-959 — the serving engine's configured device, and time-to-first-audio. Both are
    # read off `first` for the same reason `provider`/`connection_id` are: neither is known
    # until the router has picked a winner, and `first` is the moment that happens.
    device = first.device if first is not None else None
    ttfa_ms = first.ttfa_ms if first is not None else None
    # The candidate that actually served. Its sample rate and locale are what the audio IS, so
    # they are what the headers, the derived duration and the Prometheus labels must describe.
    winner = next(
        (c for c in chain if c.engine == provider and _connection_of(c) == connection_id),
        None,
    ) or next((c for c in chain if c.engine == provider), None)
    if winner is not None:
        binding = winner.binding_for(body.voice)
        locale = (binding.locale if binding else None) or winner.parameters.language or locale
        sample_rate = winner.sample_rate()
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
        "X-Tts-Sample-Rate": str(sample_rate),
        "X-Tts-Audio-Format": fmt.value,
        "X-Tts-Provider": provider or UNKNOWN_PROVIDER,
        # Absent rather than empty when the spec carried no connection id: the gateway
        # writes `AiUsageEvent.connectionId` from this, and an empty string is a value
        # while a missing header is "not stated".
        **({"X-Tts-Connection-Id": connection_id} if connection_id else {}),
        # TASK-959 — absent for a cloud engine that names no device of ours (Azure, Sarvam),
        # never a guessed value.
        **({"X-Tts-Device": device} if device else {}),
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
                audio_seconds = compute_audio_seconds(fmt, audio_bytes_total, sample_rate)
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
                            "connectionId": connection_id,
                        }
                    ),
                }

        return EventSourceResponse(
            events(),
            headers={
                **base_headers,
                "X-Accel-Buffering": "no",
                # TASK-959 — the total synthesis time is not knowable at header-commit time on
                # any streaming mode; time-to-first-audio is the one timing fact that already is.
                **({"X-Tts-Ttfa-Ms": str(round(ttfa_ms))} if ttfa_ms is not None else {}),
            },
        )

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
                audio_seconds = compute_audio_seconds(fmt, audio_bytes_total, sample_rate)
                record_usage_metrics(
                    provider=provider,
                    locale=locale,
                    characters=character_count,
                    audio_seconds=audio_seconds,
                    status="aborted" if interrupted else "ok",
                )

        # X-Tts-Audio-Seconds is deliberately ABSENT: headers commit before the
        # stream (and therefore the duration) exists. Same reasoning for
        # X-Tts-Synthesis-Ms/X-Tts-Response-Bytes/X-Tts-Byte-Source (TASK-959);
        # X-Tts-Ttfa-Ms is the one timing fact this mode already has up front.
        return StreamingResponse(
            raw(),
            media_type=content_type,
            headers={
                **base_headers,
                **_STREAM_HEADERS,
                **({"X-Tts-Ttfa-Ms": str(round(ttfa_ms))} if ttfa_ms is not None else {}),
            },
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
        audio_seconds = compute_audio_seconds(fmt, audio_bytes_total, sample_rate)
        record_usage_metrics(
            provider=provider,
            locale=locale,
            characters=character_count,
            audio_seconds=audio_seconds,
            status="aborted" if interrupted else "ok",
        )
    # TASK-959 — only knowable now, once the whole utterance has been produced.
    # `synthesis_ms` is the router's own `gen_s` for the winning candidate (excludes any
    # earlier failed-over candidate's time, since occupancy is what the WINNING engine held).
    # `byte_source` names how the byte count was obtained: "wire" for every adapter that hands
    # us the bytes it produced directly; "app" for the one adapter (Azure) whose SDK decodes
    # audio for us and we sum its chunks — see `providers/azure_speech.py`.
    synthesis_ms = timing.get("synthesis_ms")
    byte_source = ("app" if provider == "azure" else "wire") if provider else None
    return Response(
        content=bytes(buf),
        media_type=content_type,
        headers={
            **base_headers,
            "Cache-Control": "no-store",
            **({"X-Tts-Audio-Seconds": str(audio_seconds)} if audio_seconds is not None else {}),
            **({"X-Tts-Synthesis-Ms": str(round(synthesis_ms))} if synthesis_ms is not None else {}),
            "X-Tts-Response-Bytes": str(audio_bytes_total),
            **({"X-Tts-Byte-Source": byte_source} if byte_source else {}),
        },
    )
