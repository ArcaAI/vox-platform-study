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
import hmac
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from tts_v2.catalog.voices import VoiceNotFoundError
from tts_v2.core.logging import get_logger
from tts_v2.providers.base import AudioFormat, SynthesisStream
from tts_v2.routing.router import AllProvidersUnavailableError

logger = get_logger(__name__)
router = APIRouter(tags=["speech-stream"])

# Generic, PHI-safe error codes (never echo the input text).
_ERR_INVALID_VOICE = "invalid_voice"
_ERR_PROVIDER = "provider_unavailable"
_ERR_INVALID_INPUT = "invalid_input"
_ERR_INTERNAL = "internal"

# Auth-failure close code — matches the gateway's uniform 4401 (enumeration-safe).
_CLOSE_AUTH = 4401


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
    """Constant-time X-Service-Token check (empty configured token = dev bypass)."""
    token: str = ws.app.state.settings.service_token.get_secret_value()
    if not token:
        return True
    provided = ws.headers.get("x-service-token", "")
    return bool(provided) and hmac.compare_digest(provided, token)


@router.websocket("/audio/stream")
async def audio_stream(ws: WebSocket) -> None:
    if not _authorized(ws):
        await ws.close(code=_CLOSE_AUTH)
        return

    settings = ws.app.state.settings
    tts_router = ws.app.state.router
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

    reader = asyncio.ensure_future(_pump_input(ws, stream))
    try:
        async for chunk in stream:
            await ws.send_bytes(chunk.data)
        await ws.send_json({"type": "done"})
    except AllProvidersUnavailableError:
        await _send_error(ws, _ERR_PROVIDER, "no provider available for this voice")
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.warning("tts_v2.stream_error", exc_info=True)
        await _send_error(ws, _ERR_INTERNAL, "synthesis failed")
    finally:
        reader.cancel()
        with contextlib.suppress(Exception):
            await reader
        await stream.aclose()  # free upstream (Azure conn / GPU task)
        with contextlib.suppress(Exception):
            await ws.close()


async def _pump_input(ws: WebSocket, stream: SynthesisStream) -> None:
    """Feed client control frames into the synthesis stream until end/disconnect."""
    try:
        while True:
            msg: Any = await ws.receive_json()
            mtype = msg.get("type") if isinstance(msg, dict) else None
            if mtype == "text":
                await stream.push_text(str(msg.get("text", "")))
            elif mtype == "flush":
                await stream.flush()
            elif mtype == "end":
                await stream.end_input()
                return
            # unknown control frames are ignored (forward-compatible)
    except WebSocketDisconnect:
        await stream.aclose()  # unblocks the writer parked on __anext__
    except Exception:
        logger.debug("tts_v2.stream_input_closed", exc_info=True)


async def _send_error(ws: WebSocket, code: str, message: str) -> None:
    with contextlib.suppress(Exception):
        await ws.send_json({"type": "error", "code": code, "message": message})
        await ws.close()
