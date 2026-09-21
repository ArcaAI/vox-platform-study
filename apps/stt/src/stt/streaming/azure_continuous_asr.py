"""Azure Speech continuous recognition — a :class:`DuplexAsrSession`.

TASK-998 lane S3. This is the DUPLEX engine for Azure Speech: HOPE pushes a
continuous frame feed into a ``PushAudioInputStream`` and Azure's own
segmentation decides where utterances end. It sits alongside
:mod:`stt.streaming.azure_asr`, which stays exactly as it is and still serves
the per-utterance ``recognize_once`` / batch path.

**This is not a WebSocket adapter.** Azure's supported production path for
continuous recognition is the ``azure-cognitiveservices-speech`` SDK, which
runs its own native threads and owns the transport. Azure does publish a
WS-native "Voice Live API", but it is public preview with no SLA and is
explicitly not recommended for production — for a healthcare platform that
rules it out. Noted here as a possible future transport, deliberately not used.

The consequence is a THREADING BRIDGE: every SDK callback fires on a native SDK
thread, never on the asyncio loop. See :meth:`_AzureDuplexSession._bridge` for
the exact mechanism and its failure modes.

Unlike Sarvam and OpenAI, Azure DOES give word-level timestamps. They are
parsed by :func:`stt.streaming.azure_asr._extract_word_timestamps` — reused
here rather than reimplemented, so there is exactly one parser for that shape
in the service. Semantic segmentation forfeits them (Azure returns no
NBest/confidence in that mode), which is logged when it is selected.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import logging
import math
import threading
from collections.abc import AsyncIterator
from concurrent.futures import Future as ConcurrentFuture
from typing import Any

import azure.cognitiveservices.speech as speechsdk
import numpy as np

from stt.core.exceptions import (
    CloudASRAuthError,
    CloudASRQuotaError,
    CloudASRTranscriptionError,
)
from stt.core.metrics import STT_CLOUD_ASR_ERRORS_TOTAL
from stt.models.azure_speech_loader import normalize_language_for_azure
from stt.models.cloud_asr import CloudRestConfig
from stt.streaming.azure_asr import _extract_word_timestamps
from stt.streaming.duplex_asr import (
    DuplexAsrSession,
    DuplexEndpointing,
    DuplexEvent,
    DuplexSessionClosed,
    DuplexSpeechActivity,
    DuplexTranscript,
)

#  ``DuplexError`` is deliberately NOT imported: the Azure SDK surfaces no
#  non-fatal vendor error on this path. A cancellation is either an error
#  (fatal, classified onto CloudASR*) or an ordinary end — see ``_on_canceled``.

logger = logging.getLogger(__name__)

# Matches ``CloudRestConfig.provider`` / ``AzureSpeechLoader.override_key`` /
# ``CLOUD_BYO_PROVIDERS.stt``. NOT ``azure`` — that is the LLM plane's
# spelling for a different credential, and the two disagreeing is the incident
# ``tests/contracts/cloud-asr-provider-identity.contract.test.ts`` exists to
# prevent.
PROVIDER = "azure-speech"

# Azure accepts 8 kHz or 16 kHz PCM16 mono. The stream format is fixed when the
# push stream is created, which is before the first frame arrives, so we
# declare one rate and resample anything that does not match. 16 kHz is what
# the HOPE streaming preprocessor already emits.
_WIRE_SAMPLE_RATE = 16000

# 100-ns ticks per second — Azure reports offsets and durations in ticks.
_TICKS_PER_SECOND = 10_000_000

# Soft cap on the event buffer. Interim transcripts drop on overflow;
# everything else does not. See ``_EventBuffer.offer``.
_BUFFER_MAXSIZE = 512


class _Fatal:
    """Buffer sentinel: a fatal error is pending on the session."""

    __slots__ = ()


_FATAL = _Fatal()


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------


def _count(error_class: str) -> None:
    STT_CLOUD_ASR_ERRORS_TOTAL.labels(provider=PROVIDER, **{"class": error_class}).inc()


def _classify_cancellation(details: Any) -> Exception:
    """Map Azure cancellation details onto the CloudASR* taxonomy.

    Same buckets and the same metric labels as the REST path's
    ``raise_for_cloud_status``. ``error_details`` is vendor text; the
    subscription key is never formatted into it by us.
    """
    error_details = str(getattr(details, "error_details", "") or "")
    reason = str(getattr(details, "reason", ""))
    haystack = error_details.lower()

    if (
        "401" in error_details
        or "403" in error_details
        or "unauthorized" in haystack
        or "forbidden" in haystack
    ):
        _count("auth")
        return CloudASRAuthError(f"{PROVIDER} auth error: {error_details}")
    if (
        "429" in error_details
        or "throttl" in haystack
        or "quota" in haystack
        or "rate limit" in haystack
    ):
        _count("quota")
        return CloudASRQuotaError(f"{PROVIDER} quota error: {error_details}")
    _count("transcription")
    return CloudASRTranscriptionError(
        f"{PROVIDER} transcription error (canceled, {reason}): {error_details}"
    )


# ---------------------------------------------------------------------------
# Bounded event buffer with an explicit overflow policy.
#
# NOTE (duplication): ``openai_realtime_asr`` carries a byte-identical copy.
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
# Small private utilities (also duplicated with ``openai_realtime_asr``).
# ---------------------------------------------------------------------------


def _to_pcm16_bytes(samples: np.ndarray, sample_rate: int, target_rate: int) -> bytes:
    """Float32 [-1, 1] mono → little-endian 16-bit PCM at ``target_rate``."""
    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    if sample_rate != target_rate and audio.size:
        audio = _resample(audio, sample_rate, target_rate)
    pcm = (audio * 32767.0).clip(-32768, 32767).astype("<i2")
    return pcm.tobytes()


def _resample(audio: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    try:
        from scipy.signal import resample_poly

        divisor = math.gcd(int(source_rate), int(target_rate))
        return np.asarray(
            resample_poly(audio, target_rate // divisor, source_rate // divisor),
            dtype=np.float32,
        )
    except Exception:  # pragma: no cover — scipy is a declared dependency
        logger.debug("stt.azure_duplex.resample_fallback", exc_info=True)
        count = int(round(audio.size * (target_rate / float(source_rate))))
        if count <= 0:
            return np.zeros(0, dtype=np.float32)
        source_x = np.linspace(0.0, 1.0, num=audio.size, endpoint=False, dtype=np.float64)
        target_x = np.linspace(0.0, 1.0, num=count, endpoint=False, dtype=np.float64)
        return np.interp(target_x, source_x, audio).astype(np.float32)


def _ticks_to_seconds(value: Any) -> float | None:
    """100-ns ticks → seconds. ``None`` stays ``None``: the contract forbids
    inventing a zero, which would collide with a real timing at session start.
    Azure also reports ``0`` for "not measured" on some interim results, which
    is treated the same way."""
    if isinstance(value, (int, float)) and value > 0:
        return float(value) / _TICKS_PER_SECOND
    return None


def _resolve_endpointing(inference_config: Any) -> DuplexEndpointing:
    """Read the normalised endpointing request off ``inference_config``.

    Defensive by construction — the field does not exist on ``InferenceConfig``
    today (another lane adds it), the attribute name is not settled, and an
    unrelated ``endpointing`` value must not crash the session.
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


def _clone_speech_config(source: Any) -> Any:
    """Return a per-session ``SpeechConfig``, never the loader's shared one.

    ``AzureSpeechLoader`` caches ONE ``SpeechConfig`` per loaded model and the
    existing per-utterance path mutates it in place. A duplex session lives for
    the length of a consultation and sets segmentation properties on it, so
    mutating a shared object would leak one session's endpointing into the
    next. The key and region are read back off the source config and used to
    build a fresh one; they are never logged.

    Falls back to the shared object (with a warning) if the readback is empty,
    which is the only behaviour that keeps a session working on an SDK build
    that hides those properties.
    """
    key = ""
    region = ""
    with contextlib.suppress(Exception):
        key = source.get_property(speechsdk.PropertyId.SpeechServiceConnection_Key) or ""
    with contextlib.suppress(Exception):
        region = source.get_property(speechsdk.PropertyId.SpeechServiceConnection_Region) or ""
    if not key or not region:
        logger.warning("stt.azure_duplex.speech_config_not_cloneable")
        return source
    cloned = speechsdk.SpeechConfig(subscription=key, region=region)
    cloned.output_format = speechsdk.OutputFormat.Detailed
    cloned.request_word_level_timestamps()
    return cloned


def _apply_endpointing(speech_config: Any, endpointing: DuplexEndpointing) -> None:
    """Map :class:`DuplexEndpointing` onto Azure's segmentation properties and
    log, once per session, every knob Azure has no home for."""
    dropped: list[str] = []

    if endpointing.mode == "semantic":
        # Semantic segmentation needs SDK >= 1.41, has NO tunables, supports a
        # limited language set, and returns no confidence/NBest — which means
        # no word timestamps. Selecting it is accepting that trade.
        speech_config.set_property(speechsdk.PropertyId.Speech_SegmentationStrategy, "Semantic")
        logger.info(
            "stt.azure_duplex.semantic_segmentation_selected",
            extra={
                "accepted_tradeoff": (
                    "no word timestamps, no confidence/NBest, no silence tunables, "
                    "limited language coverage"
                )
            },
        )
        for name in (
            "threshold",
            "silence_duration_ms",
            "min_speech_duration_ms",
            "prefix_padding_ms",
        ):
            if getattr(endpointing, name) is not None:
                dropped.append(f"{name} (Semantic strategy has no tunables)")
    else:
        speech_config.set_property(speechsdk.PropertyId.Speech_SegmentationStrategy, "Time")
        if endpointing.silence_duration_ms is not None:
            # Typical accepted band is 100–5000 ms; Azure rejects outside it.
            clamped = max(100, min(5000, int(endpointing.silence_duration_ms)))
            if clamped != endpointing.silence_duration_ms:
                logger.info(
                    "stt.azure_duplex.silence_timeout_clamped",
                    extra={"requested_ms": endpointing.silence_duration_ms, "applied_ms": clamped},
                )
            speech_config.set_property(
                speechsdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, str(clamped)
            )
        if endpointing.threshold is not None:
            dropped.append("threshold (Azure exposes no VAD sensitivity dial)")
        if endpointing.min_speech_duration_ms is not None:
            dropped.append("min_speech_duration_ms (no Azure equivalent)")
        if endpointing.prefix_padding_ms is not None:
            dropped.append("prefix_padding_ms (no Azure equivalent)")

    if endpointing.mode == "manual":
        # Continuous recognition has no manual-flush primitive; Azure always
        # segments. ``signal_utterance_end`` is therefore a no-op here.
        dropped.append("mode='manual' (Azure continuous recognition always segments)")

    # A consultation can legitimately open in silence, and the default initial
    # silence timeout would end the session before a word is spoken. 0 disables
    # it. This is a deliberate default, not a mapped knob.
    with contextlib.suppress(Exception):
        speech_config.set_property(
            speechsdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, "0"
        )

    if dropped:
        logger.info(
            "stt.azure_duplex.endpointing_dropped",
            extra={"mode": endpointing.mode, "dropped": dropped},
        )


def _log_bridge_future(future: ConcurrentFuture[Any]) -> None:
    """Surface a failed cross-thread delivery instead of swallowing it.

    ``run_coroutine_threadsafe`` returns a future whose exception is otherwise
    never observed. We must not block on it inside an SDK callback, so we watch
    it here instead. Runs on the loop thread.
    """
    try:
        future.result()
    except asyncio.CancelledError:
        pass
    except Exception:
        logger.warning("stt.azure_duplex.bridge_delivery_failed", exc_info=True)


# ---------------------------------------------------------------------------
# The session
# ---------------------------------------------------------------------------


class _AzureDuplexSession:
    """A live Azure Speech continuous-recognition session.

    Implements :class:`stt.streaming.duplex_asr.DuplexAsrSession`. ``open`` and
    ``close`` are idempotent; ``events()`` yields until the session ends, with
    exactly one :class:`DuplexSessionClosed` last on every non-raising path.
    """

    def __init__(
        self,
        speech_config: Any,
        *,
        language: str,
        code_switching: bool,
        endpointing: DuplexEndpointing,
    ) -> None:
        self._speech_config = speech_config
        self._language = language
        self._code_switching = code_switching
        self._endpointing = endpointing

        self._loop: asyncio.AbstractEventLoop | None = None
        self._recognizer: Any = None
        self._push_stream: Any = None
        self._buffer = _EventBuffer(_BUFFER_MAXSIZE)

        self._opened = False
        self._closing = False
        self._fatal: Exception | None = None

        # The terminal event is claimed exactly once. ``canceled`` and
        # ``session_stopped`` both fire on teardown, on DIFFERENT SDK threads,
        # and ``close()`` may be racing both — hence a real lock rather than a
        # bare flag.
        self._terminal_lock = threading.Lock()
        self._terminal_claimed = False

        self.request_bytes_total = 0
        self.response_bytes_total = 0

    # -- protocol ----------------------------------------------------------

    @property
    def provider(self) -> str:
        return PROVIDER

    async def open(self) -> None:
        if self._opened:
            return
        # Captured HERE, while we are provably on the loop. Every SDK callback
        # reaches asyncio through this reference and nothing else.
        self._loop = asyncio.get_running_loop()

        _apply_endpointing(self._speech_config, self._endpointing)

        audio_format = speechsdk.audio.AudioStreamFormat(
            samples_per_second=_WIRE_SAMPLE_RATE,
            bits_per_sample=16,
            channels=1,
        )
        self._push_stream = speechsdk.audio.PushAudioInputStream(stream_format=audio_format)
        audio_config = speechsdk.audio.AudioConfig(stream=self._push_stream)

        if self._code_switching:
            auto_detect = speechsdk.languageconfig.AutoDetectSourceLanguageConfig()
            self._recognizer = speechsdk.SpeechRecognizer(
                speech_config=self._speech_config,
                audio_config=audio_config,
                auto_detect_source_language_config=auto_detect,
            )
        else:
            self._speech_config.speech_recognition_language = self._language
            self._recognizer = speechsdk.SpeechRecognizer(
                speech_config=self._speech_config,
                audio_config=audio_config,
            )

        self._recognizer.recognizing.connect(self._on_recognizing)
        self._recognizer.recognized.connect(self._on_recognized)
        self._recognizer.session_started.connect(self._on_session_started)
        self._recognizer.session_stopped.connect(self._on_session_stopped)
        self._recognizer.canceled.connect(self._on_canceled)

        # ``*_async()`` returns a future whose ``.get()`` blocks on the native
        # transport, so it is offloaded rather than run on the loop.
        try:
            await asyncio.to_thread(self._recognizer.start_continuous_recognition_async().get)
        except Exception as exc:
            self._opened = True  # so close() tears the half-built session down
            await self.close()
            _count("transcription")
            raise CloudASRTranscriptionError(
                f"{PROVIDER} transcription error: failed to start continuous recognition "
                f"({type(exc).__name__})"
            ) from None
        self._opened = True

    async def push_audio(self, samples: np.ndarray, sample_rate: int) -> None:
        if not self._opened or self._closing or self._push_stream is None:
            return
        pcm = _to_pcm16_bytes(samples, sample_rate, _WIRE_SAMPLE_RATE)
        if not pcm:
            return
        self.request_bytes_total += len(pcm)
        stream = self._push_stream
        try:
            # ``write`` can block when the SDK's internal buffer is full, so it
            # is offloaded; the loop is never held by a native call.
            await asyncio.to_thread(stream.write, pcm)
        except Exception as exc:
            logger.debug("stt.azure_duplex.push_failed", exc_info=True)
            self._fail(
                CloudASRTranscriptionError(
                    f"{PROVIDER} transcription error: audio push failed ({type(exc).__name__})"
                )
            )

    async def signal_utterance_end(self) -> None:
        """No-op.

        Azure continuous recognition owns segmentation end to end and exposes
        no manual-flush primitive; closing the push stream is end-of-STREAM,
        not end-of-utterance, and belongs to :meth:`close`. Forcing a boundary
        locally is precisely the second endpointer this contract removes.
        """
        return None

    def events(self) -> AsyncIterator[DuplexEvent]:
        return self._iter_events()

    async def close(self) -> None:
        if self._closing:
            return
        self._closing = True

        recognizer, self._recognizer = self._recognizer, None
        stream, self._push_stream = self._push_stream, None

        if stream is not None:
            with contextlib.suppress(Exception):
                await asyncio.to_thread(stream.close)
        if recognizer is not None:
            with contextlib.suppress(Exception):
                await asyncio.to_thread(recognizer.stop_continuous_recognition_async().get)
            # Detach the handlers so a late SDK callback cannot reach a session
            # whose loop may already be gone.
            for signal in (
                "recognizing",
                "recognized",
                "session_started",
                "session_stopped",
                "canceled",
            ):
                with contextlib.suppress(Exception):
                    getattr(recognizer, signal).disconnect_all()

        if self._buffer.dropped_interims:
            logger.info(
                "stt.azure_duplex.interims_dropped",
                extra={"count": self._buffer.dropped_interims},
            )

        if self._claim_terminal():
            self._buffer.offer(DuplexSessionClosed(reason="client_closed"))
        self._opened = False

    # -- the threading bridge ---------------------------------------------

    def _bridge(self, event: DuplexEvent | _Fatal) -> None:
        """Hand one event from an SDK thread to the asyncio loop.

        The community-consensus pattern, and the only correct one available:
        ``run_coroutine_threadsafe`` schedules the delivery coroutine on the
        loop we captured at ``open()``. Three rules this respects:

        * A coroutine is NEVER awaited or called from a sync SDK callback.
        * The returned future is NOT blocked on here — that would stall an SDK
          thread on the loop — but its exception IS observed, in
          :func:`_log_bridge_future`.
        * The loop may be closed while a callback is in flight (it happens on
          teardown). That is checked, and the ``RuntimeError`` the check can
          still race is caught, so nothing ever raises out of an SDK thread.
        """
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            future = asyncio.run_coroutine_threadsafe(self._deliver(event), loop)
        except RuntimeError:
            # Loop closed between the check above and the call — teardown race.
            return
        future.add_done_callback(_log_bridge_future)

    async def _deliver(self, event: DuplexEvent | _Fatal) -> None:
        """Runs ON the loop. ``_EventBuffer`` is loop-affine, so this is the
        only place that touches it from the producer side."""
        self._buffer.offer(event)

    # -- SDK callbacks (native threads; none of these may raise) -----------

    def _on_recognizing(self, evt: Any) -> None:
        try:
            result = getattr(evt, "result", None)
            text = str(getattr(result, "text", "") or "")
            if not text.strip():
                return
            self._bridge(
                DuplexTranscript(
                    text=text,
                    is_final=False,
                    language=self._detected_language(result),
                    start_time=_ticks_to_seconds(getattr(result, "offset", None)),
                    end_time=self._end_time(result),
                    # Interims carry no NBest, hence no word timings.
                    word_timestamps=[],
                )
            )
        except Exception:
            logger.debug("stt.azure_duplex.recognizing_handler_failed", exc_info=True)

    def _on_recognized(self, evt: Any) -> None:
        try:
            result = getattr(evt, "result", None)
            reason = getattr(result, "reason", None)
            if reason == speechsdk.ResultReason.NoMatch:
                return
            text = str(getattr(result, "text", "") or "")
            # Continuous recognition is reported to emit a spurious empty
            # ``Recognized`` roughly every 30 s of silence. An empty final is
            # never useful and would show up downstream as a blank segment.
            if not text.strip():
                return
            raw = getattr(result, "json", None)
            if isinstance(raw, str):
                self.response_bytes_total += len(raw)
            self._bridge(
                DuplexTranscript(
                    text=text,
                    is_final=True,
                    language=self._detected_language(result),
                    start_time=_ticks_to_seconds(getattr(result, "offset", None)),
                    end_time=self._end_time(result),
                    word_timestamps=self._word_timestamps(result),
                )
            )
        except Exception:
            logger.debug("stt.azure_duplex.recognized_handler_failed", exc_info=True)

    def _on_session_started(self, evt: Any) -> None:
        try:
            # Azure has no speech-onset event of its own on this surface; the
            # session start is the closest advisory signal, and the contract
            # says these are advisory only and must not drive segmentation.
            self._bridge(DuplexSpeechActivity(started=True, at_time=None))
        except Exception:
            logger.debug("stt.azure_duplex.session_started_handler_failed", exc_info=True)

    def _on_session_stopped(self, evt: Any) -> None:
        try:
            if self._claim_terminal():
                self._bridge(DuplexSessionClosed(reason="session_stopped"))
        except Exception:
            logger.debug("stt.azure_duplex.session_stopped_handler_failed", exc_info=True)

    def _on_canceled(self, evt: Any) -> None:
        try:
            details = getattr(getattr(evt, "result", None), "cancellation_details", None)
            reason = getattr(details, "reason", None)
            # Fatal on the declared Error reason OR on any populated
            # ``error_details``. Matching the enum ALONE would let a
            # cancellation that carries a 401 body through under an
            # unrecognised reason close the session quietly instead of raising
            # — the per-utterance path (``azure_asr._raise_for_cancellation``)
            # raises on every cancellation, so erring toward raising keeps the
            # two paths' postures aligned.
            is_error_reason = reason == getattr(speechsdk.CancellationReason, "Error", object())
            has_error_body = bool(str(getattr(details, "error_details", "") or "").strip())
            if is_error_reason or has_error_body:
                self._fail(_classify_cancellation(details))
                return
            # EndOfStream and friends are an ordinary end, not a failure.
            if self._claim_terminal():
                self._bridge(DuplexSessionClosed(reason=f"canceled_{reason}"))
        except Exception:
            logger.debug("stt.azure_duplex.canceled_handler_failed", exc_info=True)

    # -- helpers -----------------------------------------------------------

    def _word_timestamps(self, result: Any) -> list[dict[str, Any]]:
        """Reuse the one Azure NBest/Words parser in the service.

        ``azure_asr._extract_word_timestamps`` already tolerates a missing
        ``NBest``, a missing ``Words``, and unparsable JSON, and returns ``[]``
        rather than raising. The exact key spelling was never independently
        verified, so the defensive behaviour matters: a missing timestamp must
        degrade to an empty list, never fail the transcript.
        """
        try:
            return _extract_word_timestamps(result)
        except Exception:
            logger.debug("stt.azure_duplex.word_timestamps_failed", exc_info=True)
            return []

    @staticmethod
    def _end_time(result: Any) -> float | None:
        offset = getattr(result, "offset", None)
        duration = getattr(result, "duration", None)
        if not isinstance(offset, (int, float)) or not isinstance(duration, (int, float)):
            return None
        if offset <= 0 and duration <= 0:
            return None
        return float(offset + duration) / _TICKS_PER_SECOND

    def _detected_language(self, result: Any) -> str | None:
        """The auto-detected language when code-switching is on, else the
        configured one. Never a fabricated value."""
        if self._code_switching:
            with contextlib.suppress(Exception):
                detected = speechsdk.AutoDetectSourceLanguageResult(result).language
                if detected:
                    return str(detected)
            return None
        return self._language or None

    def _claim_terminal(self) -> bool:
        """Test-and-set under a real lock. Returns ``True`` to exactly one
        caller across every SDK thread and the loop."""
        with self._terminal_lock:
            if self._terminal_claimed:
                return False
            self._terminal_claimed = True
            return True

    def _fail(self, exc: Exception) -> None:
        """Latch a fatal error. Claims the terminal slot under the same lock so
        a concurrent ``session_stopped`` cannot also emit a closed event — the
        contract's "raises / emits" split means a failed session raises out of
        ``events()`` instead of ending normally."""
        with self._terminal_lock:
            if self._terminal_claimed or self._fatal is not None:
                return
            self._terminal_claimed = True
            self._fatal = exc
        self._bridge(_FATAL)

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


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def make_azure_duplex_session(
    loaded_model: Any,
    inference_config: Any,
    *,
    task: str = "transcribe",
) -> DuplexAsrSession:
    """Build an Azure Speech continuous-recognition :class:`DuplexAsrSession`.

    ``loaded_model.model`` is a ``SpeechConfig`` from ``AzureSpeechLoader``.
    A ``CloudRestConfig`` is also accepted — the other three cloud loaders
    produce one and the shapes must not be allowed to diverge silently — in
    which case a ``SpeechConfig`` is built from its key and its
    ``extra['region']``.

    ``task`` is accepted for signature parity. Azure Speech's continuous
    recognition surface transcribes only (translation is a different
    recognizer), so anything other than ``"transcribe"`` is logged and ignored
    rather than silently honoured as something it is not.
    """
    if task and task != "transcribe":
        logger.info(
            "stt.azure_duplex.task_ignored",
            extra={"task": task, "reason": "continuous recognition transcribes only"},
        )

    model = getattr(loaded_model, "model", None)
    speech_config = _speech_config_from(model, loaded_model)

    language = normalize_language_for_azure(getattr(inference_config, "language", None))
    code_switching = bool(getattr(inference_config, "code_switching", False))

    return _AzureDuplexSession(
        speech_config,
        language=language,
        code_switching=code_switching,
        endpointing=_resolve_endpointing(inference_config),
    )


def _speech_config_from(model: Any, loaded_model: Any) -> Any:
    """Normalise whatever the loader put in ``LoadedModel.model`` into a
    per-session ``SpeechConfig``."""
    if isinstance(model, CloudRestConfig):
        region = (model.extra or {}).get("region") or (
            getattr(loaded_model, "extra", None) or {}
        ).get("region")
        if not region:
            _count("auth")
            raise CloudASRAuthError(
                f"{PROVIDER} auth error: Azure Speech requires a region; the resolved "
                "provider connection carried a credential but no `region`."
            )
        config = speechsdk.SpeechConfig(
            subscription=model.api_key.get_secret_value(), region=str(region)
        )
        config.output_format = speechsdk.OutputFormat.Detailed
        config.request_word_level_timestamps()
        return config

    if model is None:
        _count("auth")
        raise CloudASRAuthError(
            f"{PROVIDER} auth error: no Azure Speech credential was loaded for this session."
        )

    # An ``azure.cognitiveservices.speech.SpeechConfig`` from AzureSpeechLoader.
    return _clone_speech_config(model)
