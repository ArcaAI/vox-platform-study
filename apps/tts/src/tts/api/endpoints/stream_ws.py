"""WS-duplex streaming synthesis endpoint.

Incremental text in → binary PCM frames out over a single WebSocket, so audio
starts after the first sentence instead of the whole summary. Fronted by the
NestJS gateway (the browser never connects here directly); the gateway injects
``X-Service-Token`` in the handshake and mints the single-use stream ticket.

Protocol (JSON text frames in, binary PCM frames out — no base64):
  client → ``{"type":"init","voice","format":"pcm","sample_rate","speed"}`` (first)
           ``{"type":"text","text":"words ending with a space "}`` · ``{"type":"flush"}`` · ``{"type":"end"}``
  server → ``{"type":"ready",...}`` · binary PCM s16le/mono · ``{"type":"done"}`` · ``{"type":"error","code","message"}``

``init`` is validated (voice + provider availability) BEFORE any audio, so a
bad-voice / no-provider condition surfaces as an ``error`` up front. Error
messages are generic/PHI-safe. One init → one stream → one done.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from tts.catalog.voices import VoiceNotFoundError
from tts.core.logging import get_logger
from tts.core.service_auth import dev_bypass_active, token_accepted
from tts.core.usage import compute_audio_seconds, count_characters, record_usage_metrics
from tts.providers.base import AudioFormat, SynthesisStream
from tts.routing.router import AllProvidersUnavailableError

logger = get_logger(__name__)
router = APIRouter(tags=["speech-stream"])

# Generic, PHI-safe error codes (never echo the input text).
_ERR_INVALID_VOICE = "invalid_voice"
_ERR_PROVIDER = "provider_unavailable"
_ERR_INVALID_INPUT = "invalid_input"
_ERR_INTERNAL = "internal"

# Auth-failure close code — matches the gateway's uniform 4401 (enumeration-safe).
_CLOSE_AUTH = 4401


class _SessionUsage:
    """Accumulates one session's accepted characters + synthesized audio bytes
    . Shared mutable state between the main audio loop and the
        ``_pump_input`` reader task, since "characters accepted" is everything the
        client pushed regardless of whether it was ever successfully synthesized.
    """

    def __init__(self) -> None:
        self.characters = 0
        self.audio_bytes = 0
        self.provider: str | None = None


def _str_list(value: Any) -> list[str] | None:
    """Coerce an init-frame field to a non-empty list[str], else None (ignore)."""
    if isinstance(value, list) and value:
        return [str(item) for item in value]
    return None


def _provider_overrides(value: Any) -> dict[str, dict[str, str]] | None:
    """Coerce init-frame provider_overrides to {provider: {k: str}}, else None."""
    if not isinstance(value, dict) or not value:
        return None
    out: dict[str, dict[str, str]] = {}
    for provider, creds in value.items():
        if isinstance(creds, dict) and creds.get("api_key"):
            out[str(provider)] = {str(k): str(v) for k, v in creds.items()}
    return out or None


def _voice_bindings(value: Any) -> dict[str, dict[str, str]] | None:
    """Coerce init-frame voice_bindings to {voiceId: {provider: voiceName}}.

    Malformed entries are dropped safely; an empty/invalid frame field → None
    (the catalog's DEFAULT_VOICES bindings stay in effect).
    """
    if not isinstance(value, dict) or not value:
        return None
    out: dict[str, dict[str, str]] = {}
    for voice_id, bindings in value.items():
        if not isinstance(voice_id, str) or not isinstance(bindings, dict):
            continue
        clean = {
            provider: name
            for provider, name in bindings.items()
            if isinstance(provider, str) and provider and isinstance(name, str) and name
        }
        if clean:
            out[voice_id] = clean
    return out or None


def _authorized(ws: WebSocket) -> bool:
    """The HTTP middleware's decision, applied to the WebSocket handshake.

    ``BaseHTTPMiddleware`` never runs for a WebSocket scope, so this is the ONLY
    gate on this endpoint. It must therefore accept exactly what
    ``ServiceAuthMiddleware`` accepts — the full ``accepted_service_tokens`` set
    (shared ``INTERNAL_ACCESS_TOKEN`` first, legacy token as fallback), not the
    legacy field alone. Reading only the legacy field is what made completing
    owner decision D-D — set the shared token, delete the legacy variable — open
    this socket to everyone while HTTP stayed protected.
    """
    accepted: tuple[str, ...] = ws.app.state.settings.accepted_service_tokens
    if dev_bypass_active(accepted):
        return True
    if token_accepted(ws.headers.get("x-service-token", ""), accepted):
        return True
    logger.warning(
        "tts.auth.ws_rejected",
        path=ws.url.path,
        reason="no_token_configured" if not accepted else "invalid_or_missing_token",
    )
    return False


@router.websocket("/audio/stream")
async def audio_stream(ws: WebSocket) -> None:
    if not _authorized(ws):
        await ws.close(code=_CLOSE_AUTH)
        return

    settings = ws.app.state.settings
    tts_router = ws.app.state.router
    catalog = ws.app.state.voice_catalog
    await ws.accept()

    try:
        init = await ws.receive_json()
    except WebSocketDisconnect:
        return
    except Exception:
        await _send_error(ws, _ERR_INVALID_INPUT, "expected an init message")
        return

    if not isinstance(init, dict) or init.get("type") != "init":
        await _send_error(ws, _ERR_INVALID_INPUT, "first message must be init")
        return
    if init.get("format", "pcm") != "pcm":
        await _send_error(ws, _ERR_INVALID_INPUT, "streaming supports pcm only")
        return
    voice = init.get("voice")
    if not isinstance(voice, str) or not voice:
        await _send_error(ws, _ERR_INVALID_VOICE, "missing voice")
        return
    try:
        speed = float(init.get("speed", 1.0))
    except (TypeError, ValueError):
        await _send_error(ws, _ERR_INVALID_INPUT, "invalid speed")
        return

    # Per-tenant routing overrides injected by the gateway on the init
    # frame (resolved from the tenant's config). None → static settings chains.
    routing_en = _str_list(init.get("routing_en"))
    routing_ml = _str_list(init.get("routing_ml"))
    allowed_providers = _str_list(init.get("allowed_providers"))
    provider_overrides = _provider_overrides(init.get("provider_overrides"))
    voice_bindings = _voice_bindings(init.get("voice_bindings"))

    try:
        stream = tts_router.stream(
            voice_id=voice,
            fmt=AudioFormat.PCM,
            speed=speed,
            routing_en=routing_en,
            routing_ml=routing_ml,
            allowed_providers=allowed_providers,
            provider_overrides=provider_overrides,
            voice_bindings=voice_bindings,
        )
    except VoiceNotFoundError:
        await _send_error(ws, _ERR_INVALID_VOICE, "unknown voice")
        return
    except AllProvidersUnavailableError:
        await _send_error(ws, _ERR_PROVIDER, "no provider available for this voice")
        return

    await ws.send_json(
        {"type": "ready", "sample_rate": settings.sample_rate, "format": "pcm", "channels": 1}
    )

    # Accumulated across the whole session (every "text" frame
    # pushed, every binary PCM frame sent) and surfaced at teardown — success
    # OR abort — so the gateway (which fronts this socket) can emit CHARACTER
    # + AUDIO_SECOND ledger rows. `locale` is resolved once, up front — the
    # voice is fixed for the session's lifetime (one init -> one stream).
    usage = _SessionUsage()
    locale = catalog.get(voice).locale

    reader = asyncio.ensure_future(_pump_input(ws, stream, usage))
    interrupted = True
    try:
        async for chunk in stream:
            if chunk.provider:
                usage.provider = chunk.provider
            usage.audio_bytes += len(chunk.data)
            await ws.send_bytes(chunk.data)
        interrupted = False
        await ws.send_json({"type": "done"})
    except AllProvidersUnavailableError:
        # NOT `_send_error` here — it also closes the socket, which would ship
        # before the usage frame below. Close happens once, in `finally`.
        await _send_error_frame(ws, _ERR_PROVIDER, "no provider available for this voice")
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.warning("tts.stream_error", exc_info=True)
        await _send_error_frame(ws, _ERR_INTERNAL, "synthesis failed")
    finally:
        reader.cancel()
        # `asyncio.CancelledError` is a `BaseException` (Py 3.8+), NOT an
        # `Exception` — `suppress(Exception)` alone lets a genuine cancel of
        # an in-flight `_pump_input` await escape THIS finally block (and
        # abort the metrics/usage-frame code below it, mid-teardown). Must be
        # named explicitly.
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await reader
        await stream.aclose()  # free upstream (Azure conn / GPU task)
        audio_seconds = compute_audio_seconds(
            AudioFormat.PCM, usage.audio_bytes, settings.sample_rate
        )
        record_usage_metrics(
            provider=usage.provider,
            locale=locale,
            characters=usage.characters,
            audio_seconds=audio_seconds,
            status="aborted" if interrupted else "ok",
        )
        with contextlib.suppress(Exception):
            # Best-effort: a disconnected client simply never receives it —
            # never let this raise ahead of closing the socket.
            await ws.send_json(
                {
                    "type": "usage",
                    "characters": usage.characters,
                    "audioSeconds": audio_seconds,
                    "interrupted": interrupted,
                    "provider": usage.provider,
                }
            )
        with contextlib.suppress(Exception):
            await ws.close()


async def _pump_input(ws: WebSocket, stream: SynthesisStream, usage: _SessionUsage) -> None:
    """Feed client control frames into the synthesis stream until end/disconnect."""
    try:
        while True:
            msg: Any = await ws.receive_json()
            mtype = msg.get("type") if isinstance(msg, dict) else None
            if mtype == "text":
                text = str(msg.get("text", ""))
                usage.characters += count_characters(text)
                await stream.push_text(text)
            elif mtype == "flush":
                await stream.flush()
            elif mtype == "end":
                await stream.end_input()
                return
            # unknown control frames are ignored (forward-compatible)
    except WebSocketDisconnect:
        await stream.aclose()  # unblocks the writer parked on __anext__
    except Exception:
        logger.debug("tts.stream_input_closed", exc_info=True)


async def _send_error(ws: WebSocket, code: str, message: str) -> None:
    with contextlib.suppress(Exception):
        await ws.send_json({"type": "error", "code": code, "message": message})
        await ws.close()


async def _send_error_frame(ws: WebSocket, code: str, message: str) -> None:
    """Same error frame as ``_send_error``, WITHOUT closing the socket.

    Used from the main audio loop's except branches: the
    ``finally`` block still has a usage frame to send after this, so closing
    here would ship before it. The early up-front-rejection paths (before any
    stream/reader exists — nothing to report usage for) keep using
    ``_send_error``, which closes immediately.
    """
    with contextlib.suppress(Exception):
        await ws.send_json({"type": "error", "code": code, "message": message})
