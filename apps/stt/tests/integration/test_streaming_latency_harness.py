"""Realtime streaming latency replay harness.

Replays a reference WAV (or a deterministic synthetic speech-like signal)
into a RUNNING stt instance over the real Redis Streams wire protocol,
at realtime pace, and measures end-to-end latency against the 800 ms/chunk
SLA.

Wire protocol (discovered from ``stt/streaming/redis_streams.py`` +
``stt/streaming/schemas.py`` + the API gateway's
``packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts``):

* Session bootstrap:  ``POST {STT_BASE_URL}/internal/streaming/sessions``
  with JSON ``{session_id, tenant_id, pipeline_id, sample_rate, ...}``
  (201 = admitted, 503 = at capacity / streaming not initialized).
* Audio in:           ``XADD stt:audio:{session_id} MAXLEN ~ 10000 *``
  fields ``seq`` ``sr`` ``enc`` ``ch`` ``data`` (binary PCM) ``final`` ``ts``.
  The gateway always sends ``final="0"`` and ends the session via control.
* Control:            ``XADD stt:control:{session_id} * action finalize``.
* Results out:        ``XREAD stt:result:{session_id}`` entries of
  ``type=segment`` (``text``, ``start_time``, ``end_time``, ``is_final``,
  ``inference_ms``, …), ``type=status`` (``finalizing``/``closed``/
  ``cancelled``) and ``type=error`` (``message``).

Clock domain: every measurement uses the millisecond prefix of Redis Stream
entry IDs (``<unix-ms>-<seq>``, stamped by the Redis server on XADD), so
audio-feed times and result-publish times share a single clock and the
metrics are immune to client/server clock skew.

Metric definitions (reported in the JSON output under ``definitions``):

* ``ttfw_ms``          — first partial segment with non-empty text minus the
  XADD time of the first speech-bearing audio frame (Time To First Word).
* ``partial_cadence_ms`` — deltas between consecutive partial publishes with
  no final in between (intra-utterance cadence). NOTE: the service emits
  partials on a ~1.0 s design interval (``_PARTIAL_INTERVAL_S``), so cadence
  is reported for drift detection rather than judged against the 800 ms SLA.
* ``final_lag_ms``     — per final segment: publish time minus the XADD time
  of the audio frame that contained that segment's ``end_time`` (i.e.
  speech-end as fed → final publish). Includes the VAD silence-confirmation
  window by design.
* ``inference_ms``     — service-reported per-result inference duration.

Environment variables:

============================ ==================================================
``STT_BASE_URL``          stt HTTP base (default ``http://localhost:8861``)
``REDIS_URL``                Redis URL; defaults to the same settings stt
                             loads (``apps/stt/.env`` → ``redis://localhost:6379/0``)
``DATABASE_URL``             Postgres URL for read-only pipeline discovery;
                             defaults to stt's own settings.
``LATENCY_PIPELINE_ID``      explicit pipeline UUID (skips DB discovery)
``LATENCY_TENANT_ID``        explicit tenant for the session (else looked up
                             read-only from ``core."AsrPipeline"``)
``LATENCY_PIPELINE_SLUG``    preferred slug for DB discovery
                             (default ``best-practice-realtime``)
``LATENCY_WAV_PATH``         real-speech WAV (16-bit PCM); overrides the
                             synthetic fixture. Strongly recommended for
                             quality-relevant runs — e.g. the committed
                             ``apps/stt/tests/e2e/fixtures/20260205_52886591770282917_ml.wav``
                             (16 kHz mono, 107 s real Malayalam speech).
``LATENCY_MAX_SECONDS``      cap on replayed WAV duration (default 60; <=0 = full)
``LATENCY_FRAME_MS``         frame size in ms (default 80, like the gateway path)
``LATENCY_TIMEOUT_S``        wait after feed for finals + ``closed`` (default 90)
``LATENCY_SLA_MS``           SLA threshold (default 800)
``LATENCY_REPORT_PATH``      JSON report path (default ``./stt-latency-report.json``)
============================ ==================================================

Run (GPU host / anywhere with the dev stack up)::

    ./scripts/stt-latency-replay.sh
    # or directly:
    conda run -n arcaenv --no-capture-output pytest \
        apps/stt/tests/integration/test_streaming_latency_harness.py -v -s

Skips cleanly (never breaks CI) when Redis, stt, or a usable pipeline is
unreachable. The synthetic fixture is deterministic; Silero VAD may still
score synthetic audio below the speech threshold on some checkpoints — if no
final ever publishes the test fails with guidance to supply
``LATENCY_WAV_PATH`` (real speech). Transcribed *text* from the synthetic
fixture is expected to be garbage; only timing is meaningful.

Redis keys created by a run (``stt:audio/result/control/session:{sid}``) are
left for stt's own TTL cleanup (it expires them after session close); the
harness deletes nothing.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
import wave
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

import numpy as np
import pytest

from stt.streaming.redis_streams import (
    audio_stream_key,
    control_stream_key,
    result_stream_key,
)
from stt.streaming.schemas import AudioEncoding, AudioFrame

pytestmark = [pytest.mark.integration]

_SAMPLE_RATE = 16000
_AUDIO_STREAM_MAXLEN = 10_000  # mirrors the gateway's XADD MAXLEN ~ 10000


@pytest.fixture(scope="session")
def verify_test_environment():  # noqa: D401 — fixture override
    """Override the integration conftest's docker-compose-test-infra gate.

    The directory-level ``conftest.py`` autouse fixture skips every
    integration test unless the *test* Postgres (port 5433) is up. This
    harness instead targets a *running dev stack* (dev Redis + stt) and
    performs its own reachability probes with clean skips, so the test-infra
    gate does not apply here.
    """
    yield


# ---------------------------------------------------------------------------
# Environment / endpoint resolution (read-only discovery)
# ---------------------------------------------------------------------------


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def _resolve_redis_url() -> str:
    explicit = os.environ.get("REDIS_URL", "").strip()
    if explicit:
        return explicit
    try:
        from stt.core.config.settings import get_settings

        return get_settings().redis_url
    except Exception:
        return "redis://localhost:6379/0"


def _resolve_database_url() -> str | None:
    explicit = os.environ.get("DATABASE_URL", "").strip()
    if explicit:
        return explicit
    try:
        from stt.core.config.settings import get_settings

        return get_settings().database_url
    except Exception:
        return None


def _sanitize_url(url: str | None) -> str | None:
    """Strip password from a URL for the report."""
    if not url:
        return url
    try:
        parsed = urlparse(url)
        if parsed.password:
            netloc = parsed.netloc.replace(f":{parsed.password}@", ":***@")
            return urlunparse(parsed._replace(netloc=netloc))
        return url
    except Exception:
        return "<unparseable>"


def _redis_unreachable_reason(redis_url: str) -> str | None:
    import redis as redis_sync

    try:
        client = redis_sync.Redis.from_url(redis_url, socket_connect_timeout=2, socket_timeout=2)
        try:
            client.ping()
        finally:
            client.close()
        return None
    except Exception as exc:
        return f"Redis unreachable at {_sanitize_url(redis_url)}: {exc}"


def _stt_unreachable_reason(base_url: str) -> str | None:
    import httpx

    try:
        resp = httpx.get(f"{base_url}/api/v1/health/live", timeout=5.0)
        if resp.status_code != 200:
            return f"stt liveness at {base_url} returned HTTP {resp.status_code}"
        return None
    except Exception as exc:
        return f"stt unreachable at {base_url}: {exc}"


def _streaming_unavailable_reason(base_url: str) -> str | None:
    import httpx

    try:
        resp = httpx.get(f"{base_url}/internal/streaming/availability", timeout=5.0)
        if resp.status_code != 200:
            return f"availability endpoint returned HTTP {resp.status_code}"
        body = resp.json()
        if not body.get("available", False):
            return f"streaming module not available: status={body.get('status')}"
        return None
    except Exception as exc:
        return f"availability probe failed: {exc}"


async def _discover_pipeline(database_url: str | None) -> dict[str, str]:
    """Resolve a (pipeline_id, tenant_id) pair for session bootstrap.

    Priority: explicit env override → read-only SELECT against the same
    Postgres stt reads its pipeline configs from (``core."AsrPipeline"``,
    ``resourceStatus='ENABLED'``), preferring ``LATENCY_PIPELINE_SLUG``.
    Only ever executes SELECT statements.
    """
    env_pipeline = os.environ.get("LATENCY_PIPELINE_ID", "").strip()
    env_tenant = os.environ.get("LATENCY_TENANT_ID", "").strip()
    preferred_slug = os.environ.get("LATENCY_PIPELINE_SLUG", "").strip() or "best-practice-realtime"

    if env_pipeline and env_tenant:
        return {"pipeline_id": env_pipeline, "tenant_id": env_tenant, "source": "env"}

    rows: list[tuple[str, str | None, str]] = []
    if database_url:
        try:
            from sqlalchemy import text
            from sqlalchemy.ext.asyncio import create_async_engine

            engine = create_async_engine(database_url, pool_pre_ping=True)
            try:
                async with engine.connect() as conn:
                    result = await conn.execute(
                        text(
                            'SELECT "id", "tenantId", "slug" FROM core."AsrPipeline" '
                            "WHERE \"resourceStatus\" = 'ENABLED' "
                            'ORDER BY "tenantId" ASC NULLS FIRST, "slug" ASC'
                        )
                    )
                    rows = [(str(r[0]), r[1], str(r[2])) for r in result.fetchall()]
            finally:
                await engine.dispose()
        except Exception:
            rows = []

    if env_pipeline:
        # Pipeline pinned via env but tenant unknown: look it up, else fall
        # back to "" (empty tenant skips the reader's tenant filter).
        tenant = next((t for pid, t, _ in rows if pid == env_pipeline), None)
        return {
            "pipeline_id": env_pipeline,
            "tenant_id": tenant or "",
            "source": "env+db" if tenant else "env (tenant filter disabled)",
        }

    if not rows:
        pytest.skip(
            "No pipeline available for session bootstrap: set "
            "LATENCY_PIPELINE_ID + LATENCY_TENANT_ID, or make the stt "
            f"Postgres reachable ({_sanitize_url(database_url) or 'DATABASE_URL unset'})."
        )

    chosen = next((r for r in rows if r[2] == preferred_slug), rows[0])
    return {
        "pipeline_id": chosen[0],
        "tenant_id": chosen[1] or "",
        "slug": chosen[2],
        "source": f"db (preferred slug: {preferred_slug})",
    }


# ---------------------------------------------------------------------------
# Audio fixture — replay source
# ---------------------------------------------------------------------------


@dataclass
class ReplayAudio:
    """PCM16 mono audio plus the speech-segment timeline used for labeling."""

    samples: np.ndarray  # int16 mono at _SAMPLE_RATE
    speech_segments: list[tuple[float, float]]  # (start_s, end_s)
    source: str
    path: str | None = None

    @property
    def duration_s(self) -> float:
        return len(self.samples) / _SAMPLE_RATE


def synthesize_speech_like_audio(seed: int = 351) -> ReplayAudio:
    """Deterministic speech-like signal: 3 utterances separated by silence.

    Voiced harmonic stack with a wobbling F0, formant-shaped harmonic
    amplitudes, a syllabic (~3.2 Hz) AM envelope, and consonant-like noise
    bursts. Designed to look as speech-like as a synthetic signal can to
    Silero VAD; transcription text is expected to be garbage (timing only).
    """
    rng = np.random.default_rng(seed)
    sr = _SAMPLE_RATE
    lead_in_s, gap_s = 0.6, 1.6
    utterance_durations = [3.0, 3.5, 2.5]

    def synth_utterance(dur_s: float) -> np.ndarray:
        n = int(dur_s * sr)
        t = np.arange(n) / sr
        f0 = 120.0 * (
            1.0
            + 0.12 * np.sin(2 * np.pi * 0.7 * t + rng.uniform(0, 2 * np.pi))
            + 0.03 * np.sin(2 * np.pi * 2.3 * t + rng.uniform(0, 2 * np.pi))
        )
        phase = 2 * np.pi * np.cumsum(f0) / sr
        formants, bandwidths = (500.0, 1500.0, 2500.0), (200.0, 300.0, 400.0)
        mean_f0 = float(np.mean(f0))
        voiced = np.zeros(n)
        for h in range(1, 13):
            f_h = h * mean_f0
            weight = sum(
                np.exp(-(((f_h - fc) / bw) ** 2))
                for fc, bw in zip(formants, bandwidths, strict=True)
            )
            voiced += (1.0 / h + 1.5 * weight) * np.sin(h * phase)
        voiced /= np.max(np.abs(voiced)) + 1e-9

        syl_rate = 3.2
        syl_phase = rng.uniform(0, 2 * np.pi)
        envelope = (
            0.15
            + 0.85
            * np.clip(0.5 - 0.5 * np.cos(2 * np.pi * syl_rate * t + syl_phase), 0.0, 1.0) ** 0.7
        )

        out = 0.32 * envelope * voiced

        # Consonant-ish noise bursts at syllable onsets (high-passed noise).
        burst_len = int(0.03 * sr)
        n_syllables = max(1, int(dur_s * syl_rate))
        for k in range(n_syllables):
            onset = int((k / syl_rate) * sr)
            if onset + burst_len >= n:
                break
            noise = rng.standard_normal(burst_len + 1)
            out[onset : onset + burst_len] += 0.12 * np.diff(noise)

        fade = int(0.02 * sr)
        ramp = np.linspace(0.0, 1.0, fade)
        out[:fade] *= ramp
        out[-fade:] *= ramp[::-1]
        return out

    pieces: list[np.ndarray] = [np.zeros(int(lead_in_s * sr))]
    segments: list[tuple[float, float]] = []
    cursor = lead_in_s
    for dur in utterance_durations:
        pieces.append(synth_utterance(dur))
        segments.append((round(cursor, 3), round(cursor + dur, 3)))
        cursor += dur
        pieces.append(np.zeros(int(gap_s * sr)))
        cursor += gap_s

    signal = np.concatenate(pieces)
    samples = np.clip(signal * 32767.0, -32768, 32767).astype(np.int16)
    return ReplayAudio(samples=samples, speech_segments=segments, source="synthetic")


def _label_speech_segments(samples: np.ndarray, frame_s: float = 0.08) -> list[tuple[float, float]]:
    """Energy-based speech labeling for real WAVs (RMS over 80 ms frames)."""
    norm = samples.astype(np.float32) / 32768.0
    frame_len = int(frame_s * _SAMPLE_RATE)
    n_frames = max(1, len(norm) // frame_len)
    rms = np.array(
        [
            float(np.sqrt(np.mean(norm[i * frame_len : (i + 1) * frame_len] ** 2)))
            for i in range(n_frames)
        ]
    )
    threshold = max(0.01, 0.12 * float(np.percentile(rms, 95)))
    is_speech = rms > threshold

    # Merge runs, tolerating gaps <= 2 frames; drop segments < 0.2 s.
    segments: list[tuple[float, float]] = []
    start: int | None = None
    gap = 0
    for i, flag in enumerate(is_speech):
        if flag:
            if start is None:
                start = i
            gap = 0
        elif start is not None:
            gap += 1
            if gap > 2:
                segments.append((start, i - gap + 1))
                start, gap = None, 0
    if start is not None:
        segments.append((start, n_frames))
    return [
        (round(s * frame_s, 3), round(e * frame_s, 3))
        for s, e in segments
        if (e - s) * frame_s >= 0.2
    ]


def load_replay_audio() -> ReplayAudio:
    """Load LATENCY_WAV_PATH if set, else the deterministic synthetic fixture."""
    wav_path = os.environ.get("LATENCY_WAV_PATH", "").strip()
    if not wav_path:
        return synthesize_speech_like_audio()

    path = Path(wav_path)
    if not path.is_file():
        pytest.skip(f"LATENCY_WAV_PATH does not exist: {wav_path}")

    with wave.open(str(path), "rb") as wav:
        if wav.getsampwidth() != 2:
            pytest.skip(f"LATENCY_WAV_PATH must be 16-bit PCM (got sampwidth={wav.getsampwidth()})")
        n_channels = wav.getnchannels()
        src_rate = wav.getframerate()
        raw = wav.readframes(wav.getnframes())

    samples = np.frombuffer(raw, dtype=np.int16)
    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1).astype(np.int16)
    if src_rate != _SAMPLE_RATE:
        # Linear resample — adequate for a timing harness.
        duration = len(samples) / src_rate
        target_n = int(duration * _SAMPLE_RATE)
        x_src = np.linspace(0.0, duration, num=len(samples), endpoint=False)
        x_dst = np.linspace(0.0, duration, num=target_n, endpoint=False)
        samples = np.interp(x_dst, x_src, samples.astype(np.float32)).astype(np.int16)

    max_seconds = _env_float("LATENCY_MAX_SECONDS", 60.0)
    if max_seconds > 0:
        samples = samples[: int(max_seconds * _SAMPLE_RATE)]

    return ReplayAudio(
        samples=samples,
        speech_segments=_label_speech_segments(samples),
        source="wav",
        path=str(path),
    )


# ---------------------------------------------------------------------------
# Feed + watch
# ---------------------------------------------------------------------------


@dataclass
class FrameRecord:
    seq: int
    audio_start_s: float
    audio_end_s: float
    is_speech: bool
    entry_ms: int  # Redis server clock (XADD entry ID prefix)


@dataclass
class ResultEvent:
    kind: str  # partial | final | status | error | other
    entry_ms: int
    text: str = ""
    start_time: float = 0.0
    end_time: float = 0.0
    inference_ms: float = 0.0
    status: str = ""
    message: str = ""


def _entry_ms(entry_id: bytes | str) -> int:
    raw = entry_id.decode() if isinstance(entry_id, bytes) else entry_id
    return int(raw.split("-")[0])


def _fields_to_str(fields: dict[Any, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in fields.items():
        k = key.decode() if isinstance(key, bytes) else str(key)
        out[k] = value.decode(errors="replace") if isinstance(value, bytes) else str(value)
    return out


def _parse_result_entry(entry_id: bytes | str, fields: dict[Any, Any]) -> ResultEvent:
    decoded = _fields_to_str(fields)
    ms = _entry_ms(entry_id)
    entry_type = decoded.get("type", "")
    if entry_type == "segment":
        return ResultEvent(
            kind="final" if decoded.get("is_final") == "1" else "partial",
            entry_ms=ms,
            text=decoded.get("text", ""),
            start_time=float(decoded.get("start_time") or 0.0),
            end_time=float(decoded.get("end_time") or 0.0),
            inference_ms=float(decoded.get("inference_ms") or 0.0),
        )
    if entry_type == "status":
        return ResultEvent(kind="status", entry_ms=ms, status=decoded.get("status", ""))
    if entry_type == "error":
        return ResultEvent(kind="error", entry_ms=ms, message=decoded.get("message", ""))
    return ResultEvent(kind="other", entry_ms=ms, message=json.dumps(decoded)[:200])


async def _feed_audio_realtime(
    redis_client: Any,
    session_id: str,
    audio: ReplayAudio,
    frame_ms: float,
) -> list[FrameRecord]:
    """XADD PCM frames at realtime pace (drift-free absolute schedule)."""
    frame_s = frame_ms / 1000.0
    frame_samples = int(_SAMPLE_RATE * frame_s)
    samples = audio.samples
    n_frames = (len(samples) + frame_samples - 1) // frame_samples

    def frame_is_speech(start_s: float, end_s: float) -> bool:
        return any(
            start_s < seg_end and end_s > seg_start for seg_start, seg_end in audio.speech_segments
        )

    records: list[FrameRecord] = []
    stream_key = audio_stream_key(session_id)
    loop = asyncio.get_running_loop()
    t0 = loop.time()

    for i in range(n_frames):
        await asyncio.sleep(max(0.0, t0 + i * frame_s - loop.time()))

        chunk = samples[i * frame_samples : (i + 1) * frame_samples]
        if len(chunk) < frame_samples:
            chunk = np.pad(chunk, (0, frame_samples - len(chunk)))

        # Exact gateway wire format (final is always "0"; end via control).
        frame = AudioFrame(
            seq=i,
            sr=_SAMPLE_RATE,
            enc=AudioEncoding.PCM_S16LE,
            ch=1,
            data=chunk.tobytes(),
            final=False,
            ts=time.time(),
        )
        entry_id = await redis_client.xadd(
            stream_key,
            frame.to_redis_dict(),
            maxlen=_AUDIO_STREAM_MAXLEN,
            approximate=True,
        )
        start_s, end_s = i * frame_s, (i + 1) * frame_s
        records.append(
            FrameRecord(
                seq=i,
                audio_start_s=round(start_s, 4),
                audio_end_s=round(end_s, 4),
                is_speech=frame_is_speech(start_s, end_s),
                entry_ms=_entry_ms(entry_id),
            )
        )

    # End-of-stream exactly like the gateway: control-stream finalize.
    await redis_client.xadd(control_stream_key(session_id), {"action": "finalize"})
    return records


async def _watch_results(redis_client: Any, session_id: str, events: list[ResultEvent]) -> bool:
    """Append result-stream entries to ``events`` until status closed/cancelled.

    Mutates the shared list so the caller keeps the events captured so far
    even when this coroutine is cancelled by an outer timeout.
    """
    stream_key = result_stream_key(session_id)
    last_id = "0-0"
    while True:
        entries = await redis_client.xread({stream_key: last_id}, count=100, block=1000)
        if not entries:
            continue
        for _stream, messages in entries:
            for entry_id, fields in messages:
                last_id = entry_id.decode() if isinstance(entry_id, bytes) else entry_id
                event = _parse_result_entry(entry_id, fields)
                events.append(event)
                if event.kind == "status" and event.status in ("closed", "cancelled"):
                    return True


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def _stats(values: list[float]) -> dict[str, float] | None:
    if not values:
        return None
    arr = np.asarray(values, dtype=np.float64)
    return {
        "count": int(arr.size),
        "mean": round(float(arr.mean()), 1),
        "p50": round(float(np.percentile(arr, 50)), 1),
        "p95": round(float(np.percentile(arr, 95)), 1),
        "min": round(float(arr.min()), 1),
        "max": round(float(arr.max()), 1),
    }


def compute_latency_metrics(
    frames: list[FrameRecord],
    events: list[ResultEvent],
    frame_ms: float,
    sla_ms: float,
) -> dict[str, Any]:
    """Derive TTFW / partial cadence / final lag from the captured timeline."""
    frame_s = frame_ms / 1000.0
    ordered = sorted(events, key=lambda e: e.entry_ms)
    partials = [e for e in ordered if e.kind == "partial"]
    finals = [e for e in ordered if e.kind == "final"]

    first_speech_frame = next((f for f in frames if f.is_speech), None)

    # TTFW
    ttfw_ms: float | None = None
    first_partial_any_ms: float | None = None
    if first_speech_frame is not None:
        first_any = next((p for p in partials), None)
        if first_any is not None:
            first_partial_any_ms = float(first_any.entry_ms - first_speech_frame.entry_ms)
        first_worded = next((p for p in partials if p.text.strip()), None)
        if first_worded is not None:
            ttfw_ms = float(first_worded.entry_ms - first_speech_frame.entry_ms)

    # Partial cadence: consecutive partials with no final in between.
    cadence_gaps: list[float] = []
    last_partial_ms: int | None = None
    for event in ordered:
        if event.kind == "partial":
            if last_partial_ms is not None:
                cadence_gaps.append(float(event.entry_ms - last_partial_ms))
            last_partial_ms = event.entry_ms
        elif event.kind == "final":
            last_partial_ms = None

    # Final lag: publish − XADD of the frame containing the segment's end_time.
    per_final: list[dict[str, Any]] = []
    final_lags: list[float] = []
    for fin in finals:
        idx = min(max(int(fin.end_time / frame_s), 0), len(frames) - 1) if frames else 0
        lag = float(fin.entry_ms - frames[idx].entry_ms) if frames else 0.0
        final_lags.append(lag)
        per_final.append(
            {
                "segment_end_time_s": round(fin.end_time, 3),
                "lag_ms": round(lag, 1),
                "inference_ms": round(fin.inference_ms, 1),
                "text_preview": fin.text.strip()[:80],
                "sla_pass": lag <= sla_ms,
            }
        )

    final_lag_stats = _stats(final_lags)
    ttfw_pass = (ttfw_ms is not None and ttfw_ms <= sla_ms) if ttfw_ms is not None else None
    final_pass = (
        final_lag_stats is not None and final_lag_stats["p95"] <= sla_ms
        if final_lag_stats is not None
        else None
    )

    return {
        "ttfw_ms": round(ttfw_ms, 1) if ttfw_ms is not None else None,
        "first_partial_any_text_ms": (
            round(first_partial_any_ms, 1) if first_partial_any_ms is not None else None
        ),
        "partial_cadence_ms": _stats(cadence_gaps),
        "final_lag_ms": final_lag_stats,
        "per_final": per_final,
        "inference_ms": {
            "finals": _stats([f.inference_ms for f in finals if f.inference_ms > 0]),
            "partials": _stats([p.inference_ms for p in partials if p.inference_ms > 0]),
        },
        "counts": {
            "partials": len(partials),
            "finals": len(finals),
            "errors": len([e for e in ordered if e.kind == "error"]),
        },
        "sla": {
            "threshold_ms": sla_ms,
            "ttfw_pass": ttfw_pass,
            "final_lag_p95_pass": final_pass,
            "overall_pass": bool(ttfw_pass) and bool(final_pass),
            "notes": [
                "partial cadence is design-paced (~1.0 s emit interval) and is "
                "reported for drift detection, not judged against the SLA",
                "final lag includes the VAD min-silence confirmation window by design",
            ],
        },
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_synthetic_fixture_is_deterministic_and_speech_shaped() -> None:
    """Self-check: fixture generation is reproducible and well-formed.

    Pure CPU — runs even when no services are reachable, so the harness
    module always has at least collect+run coverage in CI.
    """
    a = synthesize_speech_like_audio()
    b = synthesize_speech_like_audio()
    assert np.array_equal(a.samples, b.samples), "fixture must be deterministic"
    assert a.samples.dtype == np.int16
    assert len(a.speech_segments) == 3
    assert 10.0 < a.duration_s < 20.0

    # Speech segments must carry real energy; gaps must be silent.
    norm = a.samples.astype(np.float32) / 32768.0
    seg_start, seg_end = a.speech_segments[0]
    speech_rms = float(
        np.sqrt(np.mean(norm[int(seg_start * _SAMPLE_RATE) : int(seg_end * _SAMPLE_RATE)] ** 2))
    )
    lead_rms = float(np.sqrt(np.mean(norm[: int(0.5 * _SAMPLE_RATE)] ** 2)))
    assert speech_rms > 0.05
    assert lead_rms < 0.001


async def test_streaming_latency_replay_harness() -> None:
    """Feed reference audio at realtime pace; report TTFW / cadence / final lag."""
    import httpx
    import redis.asyncio as redis_async

    sla_ms = _env_float("LATENCY_SLA_MS", 800.0)
    frame_ms = _env_float("LATENCY_FRAME_MS", 80.0)
    timeout_s = _env_float("LATENCY_TIMEOUT_S", 90.0)
    report_path = Path(
        os.environ.get("LATENCY_REPORT_PATH", "").strip() or "./stt-latency-report.json"
    )
    base_url = os.environ.get("STT_BASE_URL", "").strip() or "http://localhost:8861"
    redis_url = _resolve_redis_url()
    database_url = _resolve_database_url()

    # --- Reachability gates (clean skips — never break CI) -----------------
    reason = _redis_unreachable_reason(redis_url)
    if reason:
        pytest.skip(reason)
    reason = _stt_unreachable_reason(base_url)
    if reason:
        pytest.skip(reason)
    reason = _streaming_unavailable_reason(base_url)
    if reason:
        pytest.skip(reason)

    pipeline = await _discover_pipeline(database_url)
    audio = load_replay_audio()
    session_id = f"latency-harness-{uuid.uuid4().hex[:12]}"

    # --- Session bootstrap (same endpoint the API gateway calls) -----------
    async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as http:
        create_resp = await http.post(
            "/internal/streaming/sessions",
            json={
                "session_id": session_id,
                "tenant_id": pipeline["tenant_id"],
                "pipeline_id": pipeline["pipeline_id"],
                "sample_rate": _SAMPLE_RATE,
            },
        )
        if create_resp.status_code == 503:
            pytest.skip(f"stt refused the session (503): {create_resp.text}")
        assert create_resp.status_code == 201, (
            f"session bootstrap failed: HTTP {create_resp.status_code} — "
            f"{create_resp.text} (pipeline={pipeline})"
        )

        redis_client = redis_async.from_url(redis_url)
        events: list[ResultEvent] = []
        closed_seen = False
        try:
            watch_task = asyncio.create_task(_watch_results(redis_client, session_id, events))
            frames = await _feed_audio_realtime(redis_client, session_id, audio, frame_ms)
            try:
                closed_seen = await asyncio.wait_for(watch_task, timeout=timeout_s)
            except TimeoutError:
                closed_seen = False
        finally:
            # Best-effort teardown; idempotent 204 even if already finalized.
            try:
                await http.delete(f"/internal/streaming/sessions/{session_id}")
            except Exception:
                pass
            await redis_client.aclose()

    # --- Metrics + report ---------------------------------------------------
    metrics = compute_latency_metrics(frames, events, frame_ms, sla_ms)
    feed_span_ms = frames[-1].entry_ms - frames[0].entry_ms if len(frames) > 1 else 0
    report = {
        "harness": " P2-5 streaming latency replay (AC-11)",
        "generated_at": datetime.now(UTC).isoformat(),
        "target": {
            "stt_base_url": base_url,
            "redis_url": _sanitize_url(redis_url),
            "pipeline": pipeline,
            "session_id": session_id,
        },
        "fixture": {
            "source": audio.source,
            "path": audio.path,
            "duration_s": round(audio.duration_s, 2),
            "sample_rate": _SAMPLE_RATE,
            "frame_ms": frame_ms,
            "n_frames": len(frames),
            "speech_segments_s": audio.speech_segments,
        },
        "feed": {
            "first_frame_redis_ms": frames[0].entry_ms if frames else None,
            "last_frame_redis_ms": frames[-1].entry_ms if frames else None,
            "feed_span_s": round(feed_span_ms / 1000.0, 2),
            "realtime_ratio": (
                round(feed_span_ms / 1000.0 / audio.duration_s, 3)
                if audio.duration_s and feed_span_ms
                else None
            ),
            "closed_status_received": closed_seen,
        },
        "metrics": metrics,
        "definitions": {
            "clock": "all *_ms values derive from Redis stream entry IDs (server clock)",
            "ttfw_ms": "first non-empty-text partial publish − XADD of first speech frame",
            "partial_cadence_ms": "gaps between consecutive partials (no final in between)",
            "final_lag_ms": "final publish − XADD of the frame containing the segment's end_time",
            "inference_ms": "service-reported inference duration per result",
        },
        "events": [
            {
                "kind": e.kind,
                "redis_ms": e.entry_ms,
                "text_preview": e.text.strip()[:80],
                "start_time": e.start_time,
                "end_time": e.end_time,
                "inference_ms": e.inference_ms,
                "status": e.status,
                "message": e.message,
            }
            for e in sorted(events, key=lambda e: e.entry_ms)
        ],
    }

    report_json = json.dumps(report, indent=2, ensure_ascii=False)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(report_json, encoding="utf-8")
    print(f"\n===== STT LATENCY REPORT ({report_path.resolve()}) =====")
    print(report_json)

    # --- Evidence assertions (report is already on disk either way) --------
    assert closed_seen, (
        f"session never reached 'closed' within {timeout_s}s after the feed — "
        f"captured {len(events)} result events; see {report_path.resolve()}"
    )
    assert metrics["counts"]["finals"] >= 1, (
        "no final segment was published — VAD likely never confirmed speech on "
        "this fixture. Re-run with real speech, e.g. LATENCY_WAV_PATH="
        "apps/stt/tests/e2e/fixtures/20260205_52886591770282917_ml.wav "
        f"(report: {report_path.resolve()})"
    )
