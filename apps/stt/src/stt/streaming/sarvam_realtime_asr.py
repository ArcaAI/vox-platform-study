"""Sarvam AI realtime streaming ASR — a ``DuplexAsrSession`` over the vendor WebSocket.

This is the duplex sibling of :mod:`stt.streaming.sarvam_asr`. That module stays
exactly as it is and keeps serving the per-utterance REST path (batch, and the
``StreamingAsrCallable`` shape HOPE drives with its own VAD). This one hands the
conversation to Sarvam: HOPE pushes a continuous 16 kHz frame feed and consumes the
vendor's own partials, VAD transitions and finals. See
:mod:`stt.streaming.duplex_asr` for the contract and for why the local endpointer
must not run in front of it.

Protocol (verified against Sarvam's realtime-streaming guide, 2026-09-21)::

    wss://<host>/speech-to-text-realtime/ws?language_code=…&model=…&mode=…
    header: api-subscription-key: <key>            # NEVER a query parameter
    up:   {"event":"audio_input","audio":"<base64 linear16 16 kHz mono>"}
          {"event":"speech_start"} / {"event":"speech_end"}   # endpointing=manual
          {"event":"flush"} | {"event":"ping"} | {"event":"end"}
    down: session.begin · vad.speech_start/end · transcript.partial/final
          · config.updated · pong · session.end · error
    close: 1008 idle timeout · 4000 bad sample rate · 1003 rate limit / quota

Security invariant (mirrors ``stt.models.cloud_asr``): the subscription key lives
only inside ``CloudRestConfig.api_key`` as a ``SecretStr``. It is read once per
connect straight into the request header and never reaches a URL, a log line, an
exception message or a ``repr``.

Transport: ``websockets`` (the asyncio client). It is already in this service's
dependency tree — ``uvicorn[standard]`` pulls it in and ``uv.lock`` pins 16.1.1 —
so no new dependency was added for this module.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
from collections.abc import AsyncIterator
from math import gcd
from typing import Any, cast
from urllib.parse import urlencode

import numpy as np
import structlog
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import (
    ConnectionClosed,
    ConnectionClosedOK,
    InvalidHandshake,
    InvalidStatus,
)

from stt.core.exceptions import (
    CloudASRAuthError,
    CloudASRError,
    CloudASRQuotaError,
    CloudASRTranscriptionError,
)
from stt.core.metrics import STT_CLOUD_ASR_ERRORS_TOTAL
from stt.models.cloud_asr import (
    CloudRestConfig,
    raise_for_cloud_status,
    raise_for_cloud_transport,
)
from stt.streaming.duplex_asr import (
    DuplexAsrSession,
    DuplexEndpointing,
    DuplexError,
    DuplexEvent,
    DuplexSessionClosed,
    DuplexSpeechActivity,
    DuplexTranscript,
)
from stt.streaming.sarvam_asr import _normalize_language_for_sarvam

logger = structlog.get_logger(__name__)

__all__ = [
    "SarvamDuplexSession",
    "make_sarvam_duplex_session",
]

_PROVIDER = "sarvam"
_REALTIME_PATH = "/speech-to-text-realtime/ws"

#  Sarvam's realtime endpoint accepts 16000 or 8000 only; HOPE conditions to 16 kHz.
_TARGET_SAMPLE_RATE = 16000
#  ~100 ms of 16 kHz mono PCM16 — the frame size the vendor guide asks for.
_FRAME_BYTES = 3200

#  An idle socket is closed with 1008. The guide does not publish the timeout, so
#  this is deliberately well under any plausible value; an app-level ping is cheap.
_PING_INTERVAL_S = 15.0
_OPEN_TIMEOUT_S = 15.0
_CLOSE_TIMEOUT_S = 5.0

#  One reconnect, and only for a close that is neither auth nor quota. A reconnect
#  starts a FRESH vendor session (Sarvam documents no resume), so the gap is real
#  and is always announced as a DuplexError before it happens.
_MAX_RECONNECTS = 1

_CLOSE_RATE_LIMIT = 1003
_CLOSE_INACTIVITY = 1008
_CLOSE_BAD_SAMPLE_RATE = 4000
_GRACEFUL_CLOSE_CODES = (1000, 1001)

_AUTH_ERROR_TOKENS = (
    "auth",
    "unauthorized",
    "unauthorised",
    "forbidden",
    "credential",
    "api_key",
    "api-key",
    "subscription",
)
_QUOTA_ERROR_TOKENS = (
    "quota",
    "rate_limit",
    "rate-limit",
    "ratelimit",
    "limit_exceeded",
    "too_many",
    "insufficient",
)


# ---------------------------------------------------------------------------
# Small pure helpers
# ---------------------------------------------------------------------------


def _as_float(value: Any) -> float | None:
    """Coerce a vendor numeric field, or ``None`` — never a fabricated 0.0."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _as_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _to_pcm16(samples: np.ndarray) -> bytes:
    """float32 [-1, 1] mono -> 16-bit signed little-endian PCM."""
    scaled = np.asarray(samples, dtype=np.float32) * 32767.0
    return cast(bytes, scaled.clip(-32768, 32767).astype("<i2").tobytes())


def _realtime_ws_url(base_url: str, params: dict[str, str]) -> str:
    """Derive the realtime WS URL from the configured REST base URL.

    The host comes from configuration (``CloudRestConfig.base_url``), never a
    literal. Only the scheme is rewritten. The subscription key is NOT here — it
    travels as a header, because a URL is the one thing that reliably gets logged.
    """
    root = (base_url or "").strip().rstrip("/")
    lowered = root.lower()
    if lowered.startswith("https://"):
        root = "wss://" + root[len("https://") :]
    elif lowered.startswith("http://"):
        root = "ws://" + root[len("http://") :]
    elif not lowered.startswith(("ws://", "wss://")):
        root = "wss://" + root
    return f"{root}{_REALTIME_PATH}?{urlencode(params)}"


def _sarvam_mode(*, code_switching: bool, task: str) -> str:
    if code_switching:
        return "codemix"
    if task == "translate":
        return "translate"
    return "transcribe"


def _build_query(
    *,
    model: str,
    language: str | None,
    mode: str,
    endpointing: DuplexEndpointing,
) -> tuple[dict[str, str], list[str]]:
    """Map the normalised config onto Sarvam query parameters.

    Returns the parameters and the list of ``DuplexEndpointing`` knobs that were
    DROPPED because Sarvam exposes no equivalent. The contract requires the
    omission to be visible rather than silent, so the caller logs that list once
    per session — nothing is emulated locally.
    """
    dropped: list[str] = []
    params: dict[str, str] = {
        #  REQUIRED by the vendor. "auto" is the documented detect-everything value.
        "language_code": language or "auto",
        "model": model,
        "mode": mode,
        "encoding": "linear16",
        "sample_rate": str(_TARGET_SAMPLE_RATE),
        #  So finals carry start_s / end_s instead of forcing a wall-clock guess.
        "return_timestamps": "true",
    }

    if endpointing.mode == "manual":
        params["endpointing"] = "manual"
    else:
        params["endpointing"] = "vad"
        if endpointing.mode == "semantic":
            dropped.append("mode=semantic (no Sarvam semantic endpointer; using vendor VAD)")

    vad_mode = params["endpointing"] == "vad"
    if endpointing.threshold is not None:
        if vad_mode:
            params["threshold"] = f"{endpointing.threshold:g}"
        else:
            dropped.append("threshold (Sarvam accepts it only with endpointing=vad)")
    if endpointing.silence_duration_ms is not None:
        if vad_mode:
            params["silence_duration_ms"] = str(int(endpointing.silence_duration_ms))
        else:
            dropped.append("silence_duration_ms (Sarvam accepts it only with endpointing=vad)")
    if endpointing.min_speech_duration_ms is not None:
        if vad_mode:
            params["min_speech_duration_ms"] = str(int(endpointing.min_speech_duration_ms))
        else:
            dropped.append("min_speech_duration_ms (Sarvam accepts it only with endpointing=vad)")
    if endpointing.prefix_padding_ms is not None:
        dropped.append("prefix_padding_ms (Sarvam exposes no pre-roll knob)")

    return params, dropped


def _error_class(code: str) -> str:
    """Classify a vendor ``error`` code onto the CloudASR* taxonomy bucket."""
    lowered = code.lower()
    if any(token in lowered for token in _AUTH_ERROR_TOKENS):
        return "auth"
    if any(token in lowered for token in _QUOTA_ERROR_TOKENS):
        return "quota"
    return "transcription"


# ---------------------------------------------------------------------------
# The session
# ---------------------------------------------------------------------------


class SarvamDuplexSession:
    """A live Sarvam realtime recognition session (``DuplexAsrSession``).

    Lifecycle is ``open() -> (push_audio* || events()) -> close()``; ``open`` and
    ``close`` are idempotent and ``events()`` yields exactly one
    :class:`DuplexSessionClosed` last.

    **How a fatal failure surfaces.** The terminal event is always yielded, and
    then ``events()`` RAISES the mapped ``CloudASR*`` exception, so a consumer
    reconciling metering still sees the close while ``EngineSwitchController``
    still gets a typed error to classify. ``push_audio`` /
    ``signal_utterance_end`` re-raise the same stored exception, because a
    producer must stop feeding a dead session. ``close()`` never raises — it is
    cleanup.
    """

    def __init__(
        self,
        config: CloudRestConfig,
        *,
        language: str | None = None,
        code_switching: bool = False,
        endpointing: DuplexEndpointing | None = None,
        task: str = "transcribe",
    ) -> None:
        self._config = config
        self._endpointing = endpointing or DuplexEndpointing()
        self._manual = self._endpointing.mode == "manual"
        #  The BCP-47 alias table is OWNED by the REST helper and imported, never
        #  copied — two tables are how the two Sarvam paths drift apart.
        self._language = _normalize_language_for_sarvam(language or config.language_default)
        self._mode = _sarvam_mode(code_switching=code_switching, task=task)
        params, self._dropped_knobs = _build_query(
            model=config.model_name,
            language=self._language,
            mode=self._mode,
            endpointing=self._endpointing,
        )
        self._query = params
        self._url = _realtime_ws_url(config.base_url, params)

        self._ws: ClientConnection | None = None
        self._queue: asyncio.Queue[DuplexEvent | None] = asyncio.Queue()
        self._send_lock = asyncio.Lock()
        self._reader_task: asyncio.Task[None] | None = None
        self._keepalive_task: asyncio.Task[None] | None = None

        self._opened = False
        self._closing = False
        self._terminated = False
        self._events_taken = False
        self._fatal: CloudASRError | None = None
        self._reconnects_left = _MAX_RECONNECTS
        self._manual_speech_open = False

        self._pcm = bytearray()
        self._request_bytes = 0
        self._response_bytes = 0

        #  Stateful polyphase resampler (same technique as StreamingPreprocessor):
        #  a per-frame interpolation applies no low-pass and folds HF content into
        #  the speech band.
        self._src_rate: int | None = None
        self._rs_up = 1
        self._rs_down = 1
        self._rs_ctx = 0
        self._rs_carry = np.zeros(0, dtype=np.float32)

    def __repr__(self) -> str:  # never leak the key
        return (
            f"SarvamDuplexSession(model={self._config.model_name!r}, "
            f"language={self._language!r}, mode={self._mode!r}, "
            f"endpointing={self._query.get('endpointing')!r})"
        )

    # -- contract --------------------------------------------------------

    @property
    def provider(self) -> str:
        return _PROVIDER

    @property
    def request_bytes(self) -> int:
        """Wire bytes sent on this session (TASK-959 metering, session-level)."""
        return self._request_bytes

    @property
    def response_bytes(self) -> int:
        """Wire bytes received on this session (TASK-959 metering, session-level)."""
        return self._response_bytes

    async def open(self) -> None:
        if self._opened:
            return
        if self._closing:
            raise RuntimeError("SarvamDuplexSession.open() after close()")
        await self._connect()
        self._opened = True
        self._reader_task = asyncio.create_task(self._read_loop(), name="sarvam-duplex-reader")
        self._keepalive_task = asyncio.create_task(
            self._keepalive_loop(), name="sarvam-duplex-keepalive"
        )
        if self._dropped_knobs:
            #  Once per session, at INFO: an endpointing knob the vendor cannot
            #  express is dropped, never emulated — and never silently.
            logger.info(
                "stt.sarvam_duplex.endpointing_dropped",
                requested_mode=self._endpointing.mode,
                applied_endpointing=self._query.get("endpointing"),
                dropped=self._dropped_knobs,
            )
        logger.info(
            "stt.sarvam_duplex.opened",
            model=self._config.model_name,
            language=self._language,
            mode=self._mode,
            endpointing=self._query.get("endpointing"),
        )

    async def push_audio(self, samples: np.ndarray, sample_rate: int) -> None:
        if self._fatal is not None:
            raise self._fatal
        if self._closing:
            return
        if not self._opened:
            raise RuntimeError("SarvamDuplexSession.push_audio() before open()")
        frame = np.asarray(samples, dtype=np.float32).reshape(-1)
        conditioned = self._resample(frame, int(sample_rate))
        if conditioned.size:
            self._pcm.extend(_to_pcm16(conditioned))
        await self._flush_buffer()

    async def signal_utterance_end(self) -> None:
        if self._fatal is not None:
            raise self._fatal
        if not self._opened or self._closing:
            return
        await self._flush_buffer(force=True)
        if self._manual and self._manual_speech_open:
            self._manual_speech_open = False
            await self._send({"event": "speech_end"})
        await self._send({"event": "flush"})

    async def events(self) -> AsyncIterator[DuplexEvent]:
        if self._events_taken:
            raise RuntimeError("SarvamDuplexSession.events() supports a single consumer")
        self._events_taken = True
        while True:
            item = await self._queue.get()
            if item is None:
                break
            yield item
        if self._fatal is not None:
            raise self._fatal

    async def close(self) -> None:
        if self._closing:
            return
        self._closing = True

        if self._ws is not None:
            try:
                await self._flush_buffer(force=True)
                await self._send({"event": "end"})
            except Exception:  # close is cleanup; it never raises
                logger.debug("stt.sarvam_duplex.close_send_failed", exc_info=True)

        keepalive, self._keepalive_task = self._keepalive_task, None
        if keepalive is not None:
            keepalive.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await keepalive

        ws, self._ws = self._ws, None
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()

        reader, self._reader_task = self._reader_task, None
        if reader is not None:
            try:
                await asyncio.wait_for(reader, timeout=_CLOSE_TIMEOUT_S)
            except TimeoutError:
                logger.debug("stt.sarvam_duplex.reader_close_timeout")
            except Exception:  # already classified by the reader
                logger.debug("stt.sarvam_duplex.reader_error_on_close", exc_info=True)

        self._pcm.clear()
        self._finish("closed")

    # -- transport -------------------------------------------------------

    async def _connect(self) -> None:
        #  The key is read here and nowhere else, straight into the header.
        headers = {"api-subscription-key": self._config.api_key.get_secret_value()}
        try:
            self._ws = await connect(
                self._url,
                additional_headers=headers,
                open_timeout=_OPEN_TIMEOUT_S,
                close_timeout=_CLOSE_TIMEOUT_S,
            )
        except InvalidStatus as exc:
            raise_for_cloud_status(
                _PROVIDER,
                exc.response.status_code,
                "realtime websocket handshake rejected",
            )
        except InvalidHandshake as exc:
            raise_for_cloud_transport(
                _PROVIDER, f"realtime handshake failed ({type(exc).__name__})"
            )
        except (OSError, TimeoutError) as exc:
            raise_for_cloud_transport(_PROVIDER, f"realtime connect failed ({type(exc).__name__})")

    async def _send(self, payload: dict[str, Any]) -> None:
        message = json.dumps(payload, separators=(",", ":"))
        async with self._send_lock:
            ws = self._ws
            if ws is None:
                return
            try:
                await ws.send(message)
            except ConnectionClosed:
                #  The reader owns close classification; do not double-report here.
                logger.debug("stt.sarvam_duplex.send_after_close", wire_event=payload.get("event"))
                return
            self._request_bytes += len(message)

    async def _send_audio(self, chunk: bytes) -> None:
        if self._manual and not self._manual_speech_open:
            self._manual_speech_open = True
            await self._send({"event": "speech_start"})
        await self._send({"event": "audio_input", "audio": base64.b64encode(chunk).decode("ascii")})

    async def _flush_buffer(self, *, force: bool = False) -> None:
        while len(self._pcm) >= _FRAME_BYTES:
            chunk = bytes(self._pcm[:_FRAME_BYTES])
            del self._pcm[:_FRAME_BYTES]
            await self._send_audio(chunk)
        if force and self._pcm:
            chunk = bytes(self._pcm)
            self._pcm.clear()
            await self._send_audio(chunk)

    async def _keepalive_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(_PING_INTERVAL_S)
                await self._send({"event": "ping"})
        except asyncio.CancelledError:
            raise
        except Exception:  # the reader classifies transport failure
            logger.debug("stt.sarvam_duplex.keepalive_stopped", exc_info=True)

    # -- reader ----------------------------------------------------------

    async def _read_loop(self) -> None:
        try:
            while True:
                ws = self._ws
                if ws is None:
                    self._finish("closed")
                    return
                try:
                    raw = await ws.recv()
                except ConnectionClosedOK:
                    if not await self._handle_disconnect(None):
                        return
                    continue
                except ConnectionClosed as exc:
                    if not await self._handle_disconnect(exc):
                        return
                    continue
                if isinstance(raw, (bytes, bytearray)):
                    self._response_bytes += len(raw)
                    text = bytes(raw).decode("utf-8", errors="replace")
                else:
                    text = raw
                    self._response_bytes += len(text.encode("utf-8"))
                if self._dispatch(text):
                    return
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # every reader fault is a provider fault
            self._fail("transcription", f"realtime reader failed ({type(exc).__name__})")

    async def _handle_disconnect(self, exc: ConnectionClosed | None) -> bool:
        """Return ``True`` when the stream was reconnected and reading continues."""
        if self._closing:
            self._finish("closed")
            return False

        code: int | None = None
        if exc is not None:
            frame = exc.rcvd or exc.sent
            code = frame.code if frame is not None else None

        if exc is None or code in _GRACEFUL_CLOSE_CODES:
            self._finish("vendor_closed")
            return False

        if code == _CLOSE_RATE_LIMIT:
            self._fail("quota", f"realtime stream closed: rate limit / quota ({code})")
            return False

        if self._reconnects_left <= 0:
            self._fail("transcription", f"realtime stream closed unexpectedly (code={code})")
            return False

        self._reconnects_left -= 1
        reason = {
            _CLOSE_INACTIVITY: "inactivity timeout",
            _CLOSE_BAD_SAMPLE_RATE: "invalid sample rate",
        }.get(code or -1, "unexpected close")
        #  Sarvam documents no resume: the reconnect opens a FRESH vendor session
        #  and whatever was mid-utterance is gone. Announce the gap.
        self._emit(
            DuplexError(
                code=f"reconnect_{code}",
                message=(
                    f"sarvam realtime stream dropped ({reason}); reopening a new vendor "
                    "session — in-flight audio for the current turn is lost"
                ),
                is_fatal=False,
            )
        )
        try:
            await self._connect()
        except CloudASRError as reconnect_exc:
            #  The CloudASR* helpers already counted this one.
            self._set_fatal(reconnect_exc)
            self._emit(
                DuplexError(code="reconnect_failed", message=str(reconnect_exc), is_fatal=True)
            )
            self._finish("error")
            return False
        self._manual_speech_open = False
        logger.info("stt.sarvam_duplex.reconnected", close_code=code, reason=reason)
        return True

    def _dispatch(self, text: str) -> bool:
        """Handle one vendor message. Returns ``True`` when the session ended."""
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            logger.debug("stt.sarvam_duplex.unparseable_message")
            return False
        if not isinstance(payload, dict):
            return False
        #  Documented shape is flat; a `data` envelope is tolerated so a nested
        #  payload does not silently read back as empty text.
        body: dict[str, Any] = payload
        nested = payload.get("data")
        if isinstance(nested, dict):
            body = {**payload, **nested}

        name = str(body.get("event") or body.get("type") or "")
        if name == "transcript.partial":
            self._emit(self._transcript(body, is_final=False))
        elif name == "transcript.final":
            self._emit(self._transcript(body, is_final=True))
        elif name == "vad.speech_start":
            self._emit(DuplexSpeechActivity(started=True, at_time=_as_float(body.get("start_s"))))
        elif name == "vad.speech_end":
            self._emit(DuplexSpeechActivity(started=False, at_time=_as_float(body.get("end_s"))))
        elif name == "error":
            return self._dispatch_error(body)
        elif name == "session.end":
            self._finish("session.end", _as_float(body.get("audio_duration_s")))
            return True
        elif name in ("session.begin", "config.updated", "pong"):
            logger.debug("stt.sarvam_duplex.control_event", vendor_event=name)
        else:
            logger.debug("stt.sarvam_duplex.unknown_event", vendor_event=name)
        return False

    def _dispatch_error(self, body: dict[str, Any]) -> bool:
        code = str(body.get("code") or "unknown")
        message = str(body.get("message") or "sarvam realtime error")
        if not bool(body.get("is_fatal", False)):
            self._emit(DuplexError(code=code, message=message, is_fatal=False))
            return False
        self._fail(_error_class(code), f"realtime error {code}: {message}")
        return True

    @staticmethod
    def _transcript(body: dict[str, Any], *, is_final: bool) -> DuplexTranscript:
        return DuplexTranscript(
            text=str(body.get("text") or ""),
            is_final=is_final,
            language=_as_str(body.get("language")),
            language_confidence=_as_float(body.get("language_confidence")),
            #  None when the vendor did not say — never a fabricated 0.0, which
            #  would collide with a real timing at the start of a session.
            start_time=_as_float(body.get("start_s")),
            end_time=_as_float(body.get("end_s")),
        )

    # -- event plumbing --------------------------------------------------

    def _emit(self, event: DuplexEvent) -> None:
        if self._terminated:
            return
        self._queue.put_nowait(event)

    def _finish(self, reason: str, audio_duration_s: float | None = None) -> None:
        if self._terminated:
            return
        self._terminated = True
        self._queue.put_nowait(
            DuplexSessionClosed(reason=reason, audio_duration_s=audio_duration_s)
        )
        self._queue.put_nowait(None)

    def _classify(self, error_class: str, message: str) -> CloudASRError:
        """Count on ``stt_cloud_asr_errors_total`` with the same ``provider``/``class``
        labels the REST path uses, and build the matching exception."""
        STT_CLOUD_ASR_ERRORS_TOTAL.labels(provider=_PROVIDER, **{"class": error_class}).inc()
        detail = f"{_PROVIDER} {message}"
        if error_class == "auth":
            return CloudASRAuthError(detail)
        if error_class == "quota":
            return CloudASRQuotaError(detail)
        return CloudASRTranscriptionError(detail)

    def _set_fatal(self, exc: CloudASRError) -> None:
        if self._fatal is None:
            self._fatal = exc

    def _fail(self, error_class: str, message: str) -> None:
        exc = self._classify(error_class, message)
        self._set_fatal(exc)
        logger.warning("stt.sarvam_duplex.failed", error_class=error_class, reason=message)
        self._emit(DuplexError(code=exc.error_code, message=str(exc), is_fatal=True))
        self._finish("error")

    # -- audio conditioning ----------------------------------------------

    def _configure_resampler(self, sample_rate: int) -> None:
        if self._src_rate is not None:
            logger.warning(
                "stt.sarvam_duplex.input_rate_changed",
                previous=self._src_rate,
                current=sample_rate,
            )
        divisor = gcd(_TARGET_SAMPLE_RATE, sample_rate) or 1
        self._rs_up = _TARGET_SAMPLE_RATE // divisor
        self._rs_down = max(1, sample_rate // divisor)
        ctx = 20 * max(self._rs_up, self._rs_down)
        #  Context a multiple of `down` keeps the leading trim sample-exact.
        self._rs_ctx = -(-ctx // self._rs_down) * self._rs_down
        self._rs_carry = np.zeros(0, dtype=np.float32)
        self._src_rate = sample_rate

    def _resample(self, frame: np.ndarray, sample_rate: int) -> np.ndarray:
        if sample_rate <= 0:
            raise ValueError(f"invalid sample rate: {sample_rate}")
        if sample_rate != self._src_rate:
            self._configure_resampler(sample_rate)
        if sample_rate == _TARGET_SAMPLE_RATE:
            return frame

        from scipy.signal import resample_poly

        x = np.concatenate([self._rs_carry, frame])
        y = resample_poly(x, self._rs_up, self._rs_down).astype(np.float32)
        lead = len(self._rs_carry) * self._rs_up // self._rs_down
        out = y[lead:]
        carry_len = min(self._rs_ctx, (len(x) // self._rs_down) * self._rs_down)
        self._rs_carry = x[len(x) - carry_len :].copy()
        return cast(np.ndarray, out)


# ---------------------------------------------------------------------------
# Factory — the entry point the engine registry calls
# ---------------------------------------------------------------------------


def _read_endpointing(inference_config: Any) -> DuplexEndpointing:
    """Read the duplex endpointing request off the inference config.

    Defensive by design: ``endpointing`` is an overloaded name in this service
    (``AsrSpecModelRole``, ``StreamingSpec.endpointing``), so only a real
    :class:`DuplexEndpointing` is accepted and anything else falls back to the
    contract's defaults rather than being coerced.
    """
    for attribute in ("duplex_endpointing", "endpointing"):
        candidate = getattr(inference_config, attribute, None)
        if isinstance(candidate, DuplexEndpointing):
            return candidate
    return DuplexEndpointing()


def make_sarvam_duplex_session(
    loaded_model: Any,
    inference_config: Any,
    *,
    task: str = "transcribe",
) -> DuplexAsrSession:
    """Build a Sarvam realtime :class:`DuplexAsrSession`.

    ``loaded_model.model`` is the :class:`CloudRestConfig` produced by
    ``SarvamLoader``; ``inference_config`` supplies the language, the
    code-switch flag and (optionally) a :class:`DuplexEndpointing`.
    """
    config = getattr(loaded_model, "model", None)
    if not isinstance(config, CloudRestConfig):
        raise CloudASRTranscriptionError(
            "sarvam duplex session requires a CloudRestConfig-backed loaded model"
        )
    return SarvamDuplexSession(
        config,
        language=getattr(inference_config, "language", None),
        code_switching=bool(getattr(inference_config, "code_switching", False)),
        endpointing=_read_endpointing(inference_config),
        task=task,
    )
