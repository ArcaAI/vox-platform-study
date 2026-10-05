"""OpenAI Realtime transcription — a :class:`DuplexAsrSession` over a WebSocket.

TASK-998 lane S3. This is the DUPLEX engine for OpenAI: HOPE pushes a
continuous frame feed, OpenAI's own endpointer decides where utterances end,
and partials arrive on the event stream. It sits alongside
:mod:`stt.streaming.openai_asr`, which stays exactly as it is and still serves
the per-utterance REST / batch path.

Protocol notes (researched 2026-09-21) — read these before changing anything:

* The beta interface is RETIRED. Sending ``OpenAI-Beta: realtime=v1`` now gets
  a **403**, so this module never sends it.
* Auth for a trusted backend is ``Authorization: Bearer <key>``. Ephemeral
  client secrets exist for browsers and are not used here.
* Session configuration is NESTED (``audio.input.format`` /
  ``.transcription`` / ``.turn_detection`` / ``.noise_reduction``), which is a
  change from the older flat-field tutorials. Note ``languages`` — a plural
  ARRAY, not a single ``language`` string.
* Delta granularity is MODEL-DEPENDENT. GPT-family transcribe models emit true
  incremental deltas; ``whisper-1`` restates the whole turn in every
  ``.delta``. :func:`_merge_delta` handles both without duplicating text.
* Max session duration is 60 minutes and there is no documented resume. A
  reconnect is a brand-new session; this module does not attempt one.
* **No word-level timestamps** are exposed on the transcription events, so
  every :class:`DuplexTranscript` from here carries an EMPTY
  ``word_timestamps``. Timings are not fabricated — see the contract's note on
  why inventing zeros is worse than ``None``.

Two things below are UNVERIFIED against current GA documentation and are
deliberately isolated so a wrong guess is a one-line fix:

1. :data:`_CONNECTION_STRATEGY` — how we reach the transcription socket.
2. :data:`_SESSION_UPDATE_EVENT_TYPE` / :func:`_build_session_config` — the
   byte-exact configuration payload.
"""

from __future__ import annotations

import asyncio
import base64
import collections
import contextlib
import json
import logging
import math
import time
from collections.abc import AsyncIterator
from typing import Any, Literal

import numpy as np

from stt.core.exceptions import (
    CloudASRAuthError,
    CloudASRQuotaError,
    CloudASRTranscriptionError,
)
from stt.core.metrics import STT_CLOUD_ASR_ERRORS_TOTAL
from stt.models.cloud_asr import CloudRestConfig
from stt.streaming.duplex_asr import (
    DuplexAsrSession,
    DuplexEndpointing,
    DuplexError,
    DuplexEvent,
    DuplexSessionClosed,
    DuplexSpeechActivity,
    DuplexTranscript,
)

logger = logging.getLogger(__name__)

PROVIDER = "openai"

# ---------------------------------------------------------------------------
# UNVERIFIED #1 — the connection strategy. THIS IS THE SWAP POINT.
# ---------------------------------------------------------------------------
# ``intent_query`` opens ``wss://…/v1/realtime?intent=transcription`` directly.
# It is community-confirmed working but is UNDOCUMENTED in the current GA
# docs, so it may disappear without notice.
#
# ``rest_session`` instead POSTs ``/v1/realtime/transcription_sessions`` to
# create a session and connects with what that response returns. It is the
# documented-looking path but was not verified live either.
#
# Flip this one constant to switch; both functions take and return the same
# things, and nothing else in the module knows which one ran.
_CONNECTION_STRATEGY: Literal["intent_query", "rest_session"] = "intent_query"

# ---------------------------------------------------------------------------
# UNVERIFIED #2 — the configuration event.
# ---------------------------------------------------------------------------
# GA moved from the beta-era ``transcription_session.update`` (flat fields) to
# ``session.update`` carrying a nested session object. We send the GA spelling
# because the nested ``audio.input.*`` shape we build below is the GA shape and
# the two must agree. If the server answers ``error`` instead of
# ``session.updated``, try ``"transcription_session.update"`` here first — the
# module logs loudly when that acknowledgement never arrives.
_SESSION_UPDATE_EVENT_TYPE = "session.update"
# The GA session object is discriminated by ``type``. ``None`` omits the field.
_SESSION_TYPE: str | None = "transcription"

# Realtime low-latency streaming transcription model. ``gpt-transcribe`` is the
# completed-audio sibling; ``gpt-4o-transcribe`` / ``gpt-4o-mini-transcribe`` /
# ``whisper-1`` still work but are not recommended for new integrations.
_DEFAULT_REALTIME_MODEL = "gpt-live-transcribe"

# We declare ONE wire rate at ``open()`` (the config is sent before the first
# frame arrives, so the rate cannot be discovered from the audio) and resample
# anything that does not match. 16 kHz is what the HOPE streaming preprocessor
# already emits, so the resample path is normally dead code.
_WIRE_SAMPLE_RATE = 16000
_WIRE_AUDIO_TYPE = "audio/pcm"

# Documented ceiling on one ``input_audio_buffer.append`` is 15 MiB. Frames are
# ~100 ms (~3 KiB of PCM16), so this only ever guards a caller that ignores the
# contract and pushes a whole utterance.
_MAX_APPEND_BYTES = 15 * 1024 * 1024

# Soft cap on the event buffer. Interim transcripts drop on overflow;
# everything else does not. See ``_EventBuffer.offer``.
_BUFFER_MAXSIZE = 512

_OPEN_TIMEOUT_S = 20.0
_CLOSE_TIMEOUT_S = 5.0
# ``websockets`` sends its own keepalive pings on this interval, which is all
# the keepalive this socket needs — OpenAI documents no idle-close for it.
_PING_INTERVAL_S = 20.0

# Vendor session ceiling. We do not reconnect (no documented resume); we log
# once as we approach it so a truncated transcript has an explanation.
_MAX_SESSION_SECONDS = 60 * 60


class _Fatal:
    """Buffer sentinel: a fatal error is pending on ``_OpenAiDuplexSession``."""

    __slots__ = ()


_FATAL = _Fatal()


# ---------------------------------------------------------------------------
# Bounded event buffer with an explicit overflow policy.
#
# NOTE (duplication): ``azure_continuous_asr`` carries a byte-identical copy.
# Lane S3 must not create a shared ``duplex_ws.py`` (a parallel lane may own
# that name), so the duplication is deliberate and flagged for the orchestrator
# to de-duplicate at merge.
# ---------------------------------------------------------------------------


class _EventBuffer:
    """Loop-affine event buffer. Every call happens ON the asyncio loop.

    Overflow policy, stated explicitly because it is a correctness decision:

    * An INTERIM transcript is DROPPED. A stale partial is worth nothing the
      moment a newer one exists.
    * A FINAL, a speech-activity transition, an error, or the terminal event is
      NEVER dropped — a dropped final is a hole in the clinical transcript. On
      overflow the buffer evicts its OLDEST interim to make room, and if it
      holds no interim at all it exceeds the soft cap and logs once. A buffer
      of nothing but finals means the consumer is gone, which ``close()``
      resolves; silently losing a final does not.
    """

    def __init__(self, maxsize: int) -> None:
        self._items: collections.deque[DuplexEvent | _Fatal] = collections.deque()
        self._maxsize = maxsize
        self._wake = asyncio.Event()
        self.dropped_interims = 0
        self._overflow_logged = False

    def offer(self, event: DuplexEvent | _Fatal) -> None:
        if len(self._items) >= self._maxsize:
            if isinstance(event, DuplexTranscript) and not event.is_final:
                self.dropped_interims += 1
                return
            if not self._evict_oldest_interim() and not self._overflow_logged:
                self._overflow_logged = True
                logger.warning(
                    "stt.duplex.buffer_over_cap",
                    extra={"provider": PROVIDER, "maxsize": self._maxsize},
                )
        self._items.append(event)
        self._wake.set()

    def _evict_oldest_interim(self) -> bool:
        for index, item in enumerate(self._items):
            if isinstance(item, DuplexTranscript) and not item.is_final:
                del self._items[index]
                self.dropped_interims += 1
                return True
        return False

    async def get(self) -> DuplexEvent | _Fatal:
        while not self._items:
            self._wake.clear()
            await self._wake.wait()
        return self._items.popleft()


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------


def _count(error_class: str) -> None:
    STT_CLOUD_ASR_ERRORS_TOTAL.labels(provider=PROVIDER, **{"class": error_class}).inc()


def _classify(code: str, message: str) -> Exception:
    """Map an OpenAI realtime ``error`` payload onto the CloudASR* taxonomy.

    ``code`` / ``message`` are vendor text. The API key never appears in either
    (we never format it into a payload), so they are safe to carry into the
    exception message.
    """
    haystack = f"{code} {message}".lower()
    if any(
        token in haystack
        for token in (
            "invalid_api_key",
            "unauthorized",
            "authentication",
            "permission",
            "forbidden",
        )
    ):
        _count("auth")
        return CloudASRAuthError(f"{PROVIDER} auth error ({code}): {message}")
    if any(
        token in haystack
        for token in ("rate_limit", "quota", "insufficient_quota", "too_many_requests", "429")
    ):
        _count("quota")
        return CloudASRQuotaError(f"{PROVIDER} quota error ({code}): {message}")
    _count("transcription")
    return CloudASRTranscriptionError(f"{PROVIDER} transcription error ({code}): {message}")


def _raise_for_handshake_status(status_code: int, detail: str) -> None:
    """Classify an HTTP status seen on the WebSocket upgrade (or the REST
    session create) and raise. Mirrors ``cloud_asr.raise_for_cloud_status`` —
    same buckets, same metric labels — without importing the HTTP-shaped
    helper into a socket path."""
    if status_code in (401, 403):
        _count("auth")
        raise CloudASRAuthError(f"{PROVIDER} auth error (HTTP {status_code}): {detail}")
    if status_code == 429:
        _count("quota")
        raise CloudASRQuotaError(f"{PROVIDER} quota error (HTTP {status_code}): {detail}")
    _count("transcription")
    raise CloudASRTranscriptionError(
        f"{PROVIDER} transcription error (HTTP {status_code}): {detail}"
    )


# ---------------------------------------------------------------------------
# Config helpers — one small named function per nested block, so a field
# rename upstream is a one-line change here.
# ---------------------------------------------------------------------------


def _realtime_ws_url(base_url: str, *, intent: str | None) -> str:
    """Derive the realtime WSS URL from ``CloudRestConfig.base_url``.

    Taking it from ``base_url`` is deliberate: a proxy or an
    Azure-OpenAI-style endpoint can be pointed at this engine without a code
    change, exactly as the REST helper already allows.
    """
    url = (base_url or "https://api.openai.com/v1").rstrip("/")
    if url.startswith("https://"):
        url = "wss://" + url[len("https://") :]
    elif url.startswith("http://"):
        url = "ws://" + url[len("http://") :]
    if not url.endswith("/realtime"):
        url = f"{url}/realtime"
    if intent:
        url = f"{url}?intent={intent}"
    return url


def _audio_input_format() -> dict[str, Any]:
    return {"type": _WIRE_AUDIO_TYPE, "rate": _WIRE_SAMPLE_RATE}


def _audio_input_transcription(
    *,
    model: str,
    languages: list[str],
    prompt: str | None,
    keywords: list[str],
) -> dict[str, Any]:
    """``audio.input.transcription``.

    ``languages`` is a plural ARRAY in the current schema — a single
    ``language`` string is the beta-era spelling and is not sent.
    """
    block: dict[str, Any] = {"model": model}
    if languages:
        block["languages"] = languages
    if prompt:
        block["prompt"] = prompt
    if keywords:
        block["keywords"] = keywords
    return block


def _turn_detection(endpointing: DuplexEndpointing) -> dict[str, Any] | None:
    """``audio.input.turn_detection``. ``None`` = manual segmentation, which
    makes ``input_audio_buffer.commit`` mandatory to close a turn."""
    if endpointing.mode == "manual":
        return None
    if endpointing.mode == "semantic":
        # ``semantic_vad`` has no threshold / silence knobs of its own; it
        # takes an eagerness dial instead. The caller's numeric knobs are
        # dropped, which ``_log_dropped_endpointing`` reports.
        return {"type": "semantic_vad", "eagerness": "auto"}
    block: dict[str, Any] = {"type": "server_vad"}
    if endpointing.threshold is not None:
        block["threshold"] = endpointing.threshold
    if endpointing.silence_duration_ms is not None:
        block["silence_duration_ms"] = endpointing.silence_duration_ms
    if endpointing.prefix_padding_ms is not None:
        block["prefix_padding_ms"] = endpointing.prefix_padding_ms
    return block


def _noise_reduction() -> dict[str, Any] | None:
    """``audio.input.noise_reduction``.

    ``None`` (off) is deliberate: HOPE's own preprocessor has already
    normalised and optionally denoised this audio, and stacking a second
    reduction stage on it is the signal-domain twin of the double-endpointer
    defect this ticket exists to remove.
    """
    return None


def _build_session_config(
    *,
    model: str,
    languages: list[str],
    prompt: str | None,
    keywords: list[str],
    endpointing: DuplexEndpointing,
) -> dict[str, Any]:
    """The whole nested session object. UNVERIFIED #2 — see the module docstring."""
    session: dict[str, Any] = {
        "audio": {
            "input": {
                "format": _audio_input_format(),
                "transcription": _audio_input_transcription(
                    model=model, languages=languages, prompt=prompt, keywords=keywords
                ),
                "turn_detection": _turn_detection(endpointing),
                "noise_reduction": _noise_reduction(),
            }
        }
    }
    if _SESSION_TYPE:
        session["type"] = _SESSION_TYPE
    return session


# ---------------------------------------------------------------------------
# Connection strategies. Both return an open ``websockets`` client connection.
# ---------------------------------------------------------------------------


async def _connect_via_intent_query(config: CloudRestConfig) -> Any:
    """Strategy ``intent_query`` (DEFAULT): connect straight to
    ``…/realtime?intent=transcription`` with the standing API key."""
    from websockets.asyncio.client import connect

    url = _realtime_ws_url(config.base_url, intent="transcription")
    headers = {"Authorization": f"Bearer {config.api_key.get_secret_value()}"}
    logger.info("stt.openai_realtime.connect", extra={"strategy": "intent_query", "url": url})
    return await connect(
        url,
        additional_headers=headers,
        open_timeout=_OPEN_TIMEOUT_S,
        close_timeout=_CLOSE_TIMEOUT_S,
        ping_interval=_PING_INTERVAL_S,
        max_size=None,
    )


async def _connect_via_rest_session(config: CloudRestConfig) -> Any:
    """Strategy ``rest_session``: create a transcription session over REST,
    then connect with whatever that response hands back.

    The response shape is itself unverified, so every field is read
    defensively: an explicit ``url``/``websocket_url`` is preferred, an
    ephemeral ``client_secret.value`` is used as the bearer when present, and a
    returned ``id`` is appended as a ``session_id`` query parameter when the
    response gave no URL of its own.
    """
    import httpx
    from websockets.asyncio.client import connect

    create_url = (config.base_url or "https://api.openai.com/v1").rstrip("/") + (
        "/realtime/transcription_sessions"
    )
    headers = {"Authorization": f"Bearer {config.api_key.get_secret_value()}"}
    try:
        async with httpx.AsyncClient(timeout=_OPEN_TIMEOUT_S) as client:
            response = await client.post(create_url, headers=headers, json={})
    except httpx.RequestError as exc:
        _count("transcription")
        raise CloudASRTranscriptionError(
            f"{PROVIDER} transport error creating realtime session: {type(exc).__name__}"
        ) from None
    if response.status_code >= 400:
        _raise_for_handshake_status(response.status_code, response.text[:500])

    payload: dict[str, Any] = response.json() if response.content else {}
    secret = payload.get("client_secret")
    token = secret.get("value") if isinstance(secret, dict) else None
    ws_url = payload.get("url") or payload.get("websocket_url")
    if not ws_url:
        ws_url = _realtime_ws_url(config.base_url, intent="transcription")
        session_id = payload.get("id")
        if session_id:
            ws_url = f"{ws_url}&session_id={session_id}"
    bearer = token or config.api_key.get_secret_value()
    logger.info("stt.openai_realtime.connect", extra={"strategy": "rest_session", "url": ws_url})
    return await connect(
        ws_url,
        additional_headers={"Authorization": f"Bearer {bearer}"},
        open_timeout=_OPEN_TIMEOUT_S,
        close_timeout=_CLOSE_TIMEOUT_S,
        ping_interval=_PING_INTERVAL_S,
        max_size=None,
    )


async def _open_socket(config: CloudRestConfig) -> Any:
    """Dispatch on :data:`_CONNECTION_STRATEGY` and normalise handshake
    failures onto the CloudASR* taxonomy."""
    from websockets.exceptions import InvalidStatus, WebSocketException

    connector = (
        _connect_via_intent_query
        if _CONNECTION_STRATEGY == "intent_query"
        else _connect_via_rest_session
    )
    try:
        return await connector(config)
    except InvalidStatus as exc:
        status = getattr(getattr(exc, "response", None), "status_code", 0) or 0
        _raise_for_handshake_status(
            int(status),
            f"realtime handshake rejected (strategy={_CONNECTION_STRATEGY})",
        )
        raise  # unreachable; _raise_for_handshake_status always raises
    except TimeoutError:
        _count("transcription")
        raise CloudASRTranscriptionError(
            f"{PROVIDER} transport error: realtime handshake timed out after {_OPEN_TIMEOUT_S}s"
        ) from None
    except WebSocketException as exc:
        _count("transcription")
        raise CloudASRTranscriptionError(
            f"{PROVIDER} transport error: {type(exc).__name__} opening realtime socket"
        ) from None
    except OSError as exc:
        _count("transcription")
        raise CloudASRTranscriptionError(
            f"{PROVIDER} transport error: {type(exc).__name__} opening realtime socket"
        ) from None


# ---------------------------------------------------------------------------
# Small private utilities. Deliberately duplicated with
# ``azure_continuous_asr`` rather than shared through a new module — lane S3
# must not create ``duplex_ws.py``; see the ticket notes.
# ---------------------------------------------------------------------------


def _to_pcm16_bytes(samples: np.ndarray, sample_rate: int, target_rate: int) -> bytes:
    """Float32 [-1, 1] mono → little-endian 16-bit PCM at ``target_rate``."""
    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    if sample_rate != target_rate and audio.size:
        audio = _resample(audio, sample_rate, target_rate)
    pcm = (audio * 32767.0).clip(-32768, 32767).astype("<i2")
    return pcm.tobytes()


def _resample(audio: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    """Rate-convert with ``scipy.signal.resample_poly``, falling back to linear
    interpolation if scipy is unavailable. Normally dead code — the HOPE
    preprocessor already emits the wire rate."""
    try:
        from scipy.signal import resample_poly

        divisor = math.gcd(int(source_rate), int(target_rate))
        return np.asarray(
            resample_poly(audio, target_rate // divisor, source_rate // divisor),
            dtype=np.float32,
        )
    except Exception:  # pragma: no cover — scipy is a declared dependency
        logger.debug("stt.openai_realtime.resample_fallback", exc_info=True)
        count = int(round(audio.size * (target_rate / float(source_rate))))
        if count <= 0:
            return np.zeros(0, dtype=np.float32)
        source_x = np.linspace(0.0, 1.0, num=audio.size, endpoint=False, dtype=np.float64)
        target_x = np.linspace(0.0, 1.0, num=count, endpoint=False, dtype=np.float64)
        return np.asarray(np.interp(target_x, source_x, audio), dtype=np.float32)


def _merge_delta(previous: str, delta: str) -> str:
    """Fold one ``…transcription.delta`` into the accumulated partial.

    Delta granularity is model-dependent: GPT-family transcribe models send
    true increments, ``whisper-1`` restates the whole turn every time. Treating
    a restatement as an increment would emit ``"hellohello there"``, so:

    * a delta that already CONTAINS everything we have is a restatement and
      REPLACES the accumulator;
    * a delta we already end with is a duplicate resend and is ignored;
    * anything else is a true increment and is appended.
    """
    if not previous:
        return delta
    if not delta:
        return previous
    if delta.startswith(previous):
        return delta
    if previous.endswith(delta):
        return previous
    return previous + delta


def _first_language(payload: dict[str, Any]) -> str | None:
    """``languages`` is an array on ``gpt-transcribe`` completions and absent
    elsewhere; take the first entry when the vendor named one."""
    languages = payload.get("languages")
    if isinstance(languages, list) and languages:
        first = languages[0]
        if isinstance(first, str) and first:
            return first
        if isinstance(first, dict):
            value = first.get("language") or first.get("code")
            return value if isinstance(value, str) and value else None
    language = payload.get("language")
    return language if isinstance(language, str) and language else None


def _resolve_endpointing(inference_config: Any) -> DuplexEndpointing:
    """Read the normalised endpointing request off ``inference_config``.

    Defensive by construction: the field does not exist on ``InferenceConfig``
    today (another lane adds it), the attribute name is not settled, and an
    unrelated ``endpointing`` value — a bare ``"semantic"`` string, an
    ``EndpointConfig`` — must not crash the session. Anything unrecognised
    yields the default and says so at debug level.
    """
    for attribute in ("duplex_endpointing", "endpointing"):
        value = getattr(inference_config, attribute, None)
        if value is None:
            continue
        if isinstance(value, DuplexEndpointing):
            return value
        if isinstance(value, dict):
            known = {
                key: value[key]
                for key in (
                    "mode",
                    "threshold",
                    "silence_duration_ms",
                    "min_speech_duration_ms",
                    "prefix_padding_ms",
                )
                if key in value
            }
            with contextlib.suppress(Exception):
                return DuplexEndpointing(**known)
        logger.debug(
            "stt.duplex.endpointing_unrecognised",
            extra={"attribute": attribute, "value_type": type(value).__name__},
        )
    return DuplexEndpointing()


def _log_dropped_endpointing(endpointing: DuplexEndpointing) -> None:
    """One INFO line per session naming every knob OpenAI has no home for, so
    an accepted-then-discarded setting is visible rather than silent."""
    dropped: list[str] = []
    if endpointing.min_speech_duration_ms is not None:
        dropped.append("min_speech_duration_ms")
    if endpointing.mode == "semantic":
        for name in ("threshold", "silence_duration_ms", "prefix_padding_ms"):
            if getattr(endpointing, name) is not None:
                dropped.append(f"{name} (semantic_vad takes eagerness only)")
    if endpointing.mode == "manual":
        for name in ("threshold", "silence_duration_ms", "prefix_padding_ms"):
            if getattr(endpointing, name) is not None:
                dropped.append(f"{name} (turn_detection disabled)")
    if dropped:
        logger.info(
            "stt.openai_realtime.endpointing_dropped",
            extra={"mode": endpointing.mode, "dropped": dropped},
        )


# ---------------------------------------------------------------------------
# The session
# ---------------------------------------------------------------------------


class _OpenAiDuplexSession:
    """A live OpenAI Realtime transcription session.

    Implements :class:`stt.streaming.duplex_asr.DuplexAsrSession`. ``open`` and
    ``close`` are idempotent; ``events()`` yields until the session ends, with
    exactly one :class:`DuplexSessionClosed` last on every non-raising path.
    """

    def __init__(
        self,
        config: CloudRestConfig,
        *,
        model: str,
        languages: list[str],
        prompt: str | None,
        keywords: list[str],
        endpointing: DuplexEndpointing,
    ) -> None:
        self._config = config
        self._model = model
        self._languages = languages
        self._prompt = prompt
        self._keywords = keywords
        self._endpointing = endpointing

        self._socket: Any = None
        self._reader: asyncio.Task[None] | None = None
        self._buffer = _EventBuffer(_BUFFER_MAXSIZE)
        self._opened = False
        self._closing = False
        self._terminal_claimed = False
        self._fatal: Exception | None = None
        self._partials: dict[str, str] = {}
        self._config_acked = False
        self._started_at = 0.0
        self._ceiling_warned = False

        # TASK-959 metering: a duplex session accounts on the SESSION, not per
        # event, so the per-event fields stay ``None`` and these carry the
        # totals for the session manager to read at teardown.
        self.request_bytes_total = 0
        self.response_bytes_total = 0

    # -- protocol ----------------------------------------------------------

    @property
    def provider(self) -> str:
        return PROVIDER

    async def open(self) -> None:
        if self._opened:
            return
        self._socket = await _open_socket(self._config)
        self._opened = True
        self._started_at = time.monotonic()
        _log_dropped_endpointing(self._endpointing)

        payload = {
            "type": _SESSION_UPDATE_EVENT_TYPE,
            "session": _build_session_config(
                model=self._model,
                languages=self._languages,
                prompt=self._prompt,
                keywords=self._keywords,
                endpointing=self._endpointing,
            ),
        }
        await self._send(payload)
        self._reader = asyncio.create_task(self._read_loop(), name="openai-realtime-reader")

    async def push_audio(self, samples: np.ndarray, sample_rate: int) -> None:
        if not self._opened or self._closing:
            return
        pcm = _to_pcm16_bytes(samples, sample_rate, _WIRE_SAMPLE_RATE)
        if not pcm:
            return
        self._warn_on_session_ceiling()
        for offset in range(0, len(pcm), _MAX_APPEND_BYTES):
            chunk = pcm[offset : offset + _MAX_APPEND_BYTES]
            await self._send(
                {
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(chunk).decode("ascii"),
                }
            )

    async def signal_utterance_end(self) -> None:
        """Commit the buffer so the vendor closes the turn.

        Only meaningful under ``mode='manual'``, where ``turn_detection`` is
        ``null`` and a commit is REQUIRED. Under server / semantic VAD the
        vendor owns the boundary and an unsolicited commit is at best noise, so
        this is a no-op there.
        """
        if not self._opened or self._closing:
            return
        if self._endpointing.mode != "manual":
            return
        await self._send({"type": "input_audio_buffer.commit"})

    def events(self) -> AsyncIterator[DuplexEvent]:
        return self._iter_events()

    async def close(self) -> None:
        if self._closing:
            return
        self._closing = True
        socket, self._socket = self._socket, None
        if socket is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(socket.close(), timeout=_CLOSE_TIMEOUT_S)
        reader, self._reader = self._reader, None
        if reader is not None and not reader.done():
            reader.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await reader
        if not self._config_acked and self._opened:
            logger.warning(
                "stt.openai_realtime.session_config_never_acked",
                extra={
                    "sent_event_type": _SESSION_UPDATE_EVENT_TYPE,
                    "strategy": _CONNECTION_STRATEGY,
                    "hint": (
                        "the server never acknowledged the session configuration — "
                        "this is the UNVERIFIED payload shape; try the alternative "
                        "_SESSION_UPDATE_EVENT_TYPE before assuming a network fault"
                    ),
                },
            )
        if self._buffer.dropped_interims:
            logger.info(
                "stt.openai_realtime.interims_dropped",
                extra={"count": self._buffer.dropped_interims},
            )
        self._emit_closed("client_closed")
        self._opened = False

    # -- internals ---------------------------------------------------------

    async def _iter_events(self) -> AsyncIterator[DuplexEvent]:
        while True:
            item = await self._buffer.get()
            if isinstance(item, _Fatal):
                raise self._fatal or CloudASRTranscriptionError(
                    f"{PROVIDER} transcription error: session failed without a cause"
                )
            yield item
            if isinstance(item, DuplexSessionClosed):
                return

    async def _send(self, payload: dict[str, Any]) -> None:
        socket = self._socket
        if socket is None:
            return
        from websockets.exceptions import ConnectionClosed, WebSocketException

        body = json.dumps(payload)
        self.request_bytes_total += len(body)
        try:
            await socket.send(body)
        except ConnectionClosed:
            # The reader owns the terminal event for a server-side close; a
            # send racing it must not manufacture a second one.
            logger.debug("stt.openai_realtime.send_after_close")
        except WebSocketException as exc:
            self._fail(
                CloudASRTranscriptionError(
                    f"{PROVIDER} transport error: {type(exc).__name__} sending "
                    f"{payload.get('type')}"
                )
            )
        except OSError as exc:
            self._fail(
                CloudASRTranscriptionError(
                    f"{PROVIDER} transport error: {type(exc).__name__} sending "
                    f"{payload.get('type')}"
                )
            )

    async def _read_loop(self) -> None:
        from websockets.exceptions import ConnectionClosed, ConnectionClosedOK, WebSocketException

        socket = self._socket
        if socket is None:
            return
        try:
            async for raw in socket:
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", errors="replace")
                self.response_bytes_total += len(raw)
                try:
                    payload = json.loads(raw)
                except (ValueError, TypeError):
                    logger.debug("stt.openai_realtime.unparsable_frame")
                    continue
                if isinstance(payload, dict):
                    self._handle(payload)
        except asyncio.CancelledError:
            raise
        except ConnectionClosedOK:
            self._emit_closed("server_closed")
        except ConnectionClosed as exc:
            self._emit_closed(f"server_closed_{getattr(exc, 'code', 'unknown')}")
        except WebSocketException as exc:
            self._fail(
                CloudASRTranscriptionError(
                    f"{PROVIDER} transport error: {type(exc).__name__} on realtime socket"
                )
            )
        except OSError as exc:
            self._fail(
                CloudASRTranscriptionError(
                    f"{PROVIDER} transport error: {type(exc).__name__} on realtime socket"
                )
            )
        else:
            self._emit_closed("stream_exhausted")

    def _handle(self, payload: dict[str, Any]) -> None:
        event_type = payload.get("type") or ""

        if event_type.endswith("session.created") or event_type.endswith("session.updated"):
            self._config_acked = True
            logger.debug("stt.openai_realtime.session_ack", extra={"event": event_type})
            return

        if event_type == "conversation.item.input_audio_transcription.delta":
            item_id = str(payload.get("item_id") or "")
            merged = _merge_delta(self._partials.get(item_id, ""), str(payload.get("delta") or ""))
            self._partials[item_id] = merged
            if merged:
                self._offer(
                    DuplexTranscript(
                        text=merged,
                        is_final=False,
                        language=_first_language(payload),
                    )
                )
            return

        if event_type == "conversation.item.input_audio_transcription.completed":
            item_id = str(payload.get("item_id") or "")
            transcript = payload.get("transcript")
            text = str(transcript) if transcript is not None else self._partials.get(item_id, "")
            self._partials.pop(item_id, None)
            if text.strip():
                self._offer(
                    DuplexTranscript(
                        text=text,
                        is_final=True,
                        language=_first_language(payload),
                        # No word-level timestamps are exposed on these events;
                        # an empty list is the honest answer, not zeros.
                        word_timestamps=[],
                    )
                )
            return

        if event_type == "conversation.item.input_audio_transcription.failed":
            error = payload.get("error")
            error = error if isinstance(error, dict) else {}
            self._on_error(error, source=event_type)
            return

        if event_type == "input_audio_buffer.speech_started":
            self._offer(
                DuplexSpeechActivity(started=True, at_time=_ms_to_s(payload.get("audio_start_ms")))
            )
            return

        if event_type == "input_audio_buffer.speech_stopped":
            self._offer(
                DuplexSpeechActivity(started=False, at_time=_ms_to_s(payload.get("audio_end_ms")))
            )
            return

        if event_type == "error":
            error = payload.get("error")
            self._on_error(error if isinstance(error, dict) else {}, source=event_type)
            return

        logger.debug("stt.openai_realtime.unhandled_event", extra={"event": event_type})

    def _on_error(self, error: dict[str, Any], *, source: str) -> None:
        code = str(error.get("code") or error.get("type") or "unknown")
        message = str(error.get("message") or "")
        if not self._config_acked:
            # Loud on purpose: an error before any acknowledgement almost
            # always means the UNVERIFIED session-config payload was rejected.
            logger.error(
                "stt.openai_realtime.error_before_session_ack",
                extra={
                    "code": code,
                    "message": message,
                    "sent_event_type": _SESSION_UPDATE_EVENT_TYPE,
                    "strategy": _CONNECTION_STRATEGY,
                },
            )
        classified = _classify(code, message)
        if isinstance(classified, (CloudASRAuthError, CloudASRQuotaError)):
            self._fail(classified)
            return
        logger.warning(
            "stt.openai_realtime.vendor_error",
            extra={"code": code, "message": message, "source": source},
        )
        self._offer(DuplexError(code=code, message=message, is_fatal=False))

    def _offer(self, event: DuplexEvent | _Fatal) -> None:
        self._buffer.offer(event)

    def _emit_closed(self, reason: str) -> None:
        """Exactly one terminal event, whichever path gets here first.

        Everything that can reach this — the reader task, ``close()``, a send
        that lost a race — runs on the one event loop, so a plain flag is a
        sufficient claim here. (Azure needs a real lock for the same job
        because its producers are native SDK threads.)
        """
        if self._terminal_claimed:
            return
        self._terminal_claimed = True
        self._offer(DuplexSessionClosed(reason=reason))

    def _fail(self, exc: Exception) -> None:
        if self._fatal is not None:
            return
        self._fatal = exc
        # A fatal error REPLACES the terminal event: ``_iter_events`` raises
        # instead of yielding, which is the contract's "raises / emits" split.
        self._terminal_claimed = True
        self._offer(_FATAL)

    def _warn_on_session_ceiling(self) -> None:
        if self._ceiling_warned or not self._started_at:
            return
        if time.monotonic() - self._started_at < _MAX_SESSION_SECONDS:
            return
        self._ceiling_warned = True
        logger.warning(
            "stt.openai_realtime.session_ceiling_reached",
            extra={"max_seconds": _MAX_SESSION_SECONDS},
        )


def _ms_to_s(value: Any) -> float | None:
    """Vendor millisecond offsets → seconds. ``None`` stays ``None`` — the
    contract forbids inventing a zero, which would collide with a real timing
    at the start of a session."""
    if isinstance(value, (int, float)):
        return float(value) / 1000.0
    return None


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def make_openai_duplex_session(
    loaded_model: Any,
    inference_config: Any,
    *,
    task: str = "transcribe",
) -> DuplexAsrSession:
    """Build an OpenAI Realtime :class:`DuplexAsrSession`.

    ``loaded_model.model`` is the ``CloudRestConfig`` the OpenAI loader
    produced. ``inference_config`` is read defensively throughout: this engine
    must not fail because a field another lane owns is absent or renamed.

    ``task`` is accepted for signature parity with the other engines. The
    realtime transcription surface has no translate mode, so anything other
    than ``"transcribe"`` is logged and ignored rather than silently honoured
    as something it is not.
    """
    config = getattr(loaded_model, "model", None)
    if not isinstance(config, CloudRestConfig):
        raise CloudASRTranscriptionError(
            f"{PROVIDER} realtime session requires a CloudRestConfig; "
            f"got {type(config).__name__}"
        )

    if task and task != "transcribe":
        logger.info(
            "stt.openai_realtime.task_ignored",
            extra={"task": task, "reason": "realtime transcription has no translate mode"},
        )

    language = getattr(inference_config, "language", None) or config.language_default
    code_switching = bool(getattr(inference_config, "code_switching", False))
    # ``languages`` is a hint array. Code-switching means "do not pin me to
    # one", so we send none and let the vendor decide; otherwise send the
    # ISO-639-1 primary tag, matching what the REST helper already does.
    languages: list[str] = []
    if language and not code_switching:
        languages = [str(language).split("-")[0]]

    prompt = getattr(inference_config, "initial_prompt_text", None) or None
    raw_keywords = getattr(inference_config, "hotwords", None)
    keywords = [str(k) for k in raw_keywords if str(k).strip()] if raw_keywords else []

    model = config.model_name or _DEFAULT_REALTIME_MODEL

    return _OpenAiDuplexSession(
        config,
        model=model,
        languages=languages,
        prompt=prompt,
        keywords=keywords,
        endpointing=_resolve_endpointing(inference_config),
    )
