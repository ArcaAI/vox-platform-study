"""TASK-455 (S1-EVAL) — Wire-level streaming loss/latency harness (AC-5/6).

Extends the pattern of ``test_streaming_latency_harness.py`` but routes audio
through the **WS gateway** (the API at :8868, path ``/ws/stt-v2/stream``) instead
of XADD-ing straight onto Redis. It therefore measures the FULL realtime loop —

    mic frames → WS ``/ws/stt-v2/stream`` → Redis ``stt:audio`` → STT-v2
               → Redis ``stt:result`` → WS caption messages

— which is exactly the transport TASK-457 (Redis consumer-groups migration)
reshapes. This harness is that migration's measurement gate: it emits a
quantitative BASELINE (first-partial latency, commit/stable-latency P50/P99,
partial-revision rate, and frames-sent-vs-transcribed loss) as a JSON artifact.
No pass/fail threshold is asserted on the numbers — baseline only (AC-6).

CLOCK DOMAIN
------------
Unlike the straight-to-Redis latency harness (which reads Redis entry-ID
server timestamps for both feed and result), this harness IS the WS client, so
every timestamp is taken on ONE monotonic clock (``time.perf_counter()`` inside
this process): a frame's *send* time is when ``ws.send()`` returned, a caption's
*receive* time is when it arrived. Single clock ⇒ immune to skew, and it
measures the true end-to-end client-observed loop latency.

METRIC DEFINITIONS (also embedded in the JSON under ``definitions``)
-------------------------------------------------------------------
* ``first_partial_ms`` — first transcript (any) receive − send of first speech
  frame.
* ``ttfw_ms``          — first NON-EMPTY-text transcript receive − send of first
  speech frame (Time To First Word).
* ``commit_latency_ms``— per FINAL transcript: receive − send of the audio frame
  that contained that segment's ``endTime``. Reported P50/P99/mean/min/max.
* ``partial_revision_rate`` — of all PARTIAL transcripts, the fraction whose text
  is NOT a forward-extension (``startswith``) of the immediately-preceding
  partial's text (i.e. a rewrite of already-shown characters). churn signal.
* ``loss`` — frames_sent vs how much audio the finals actually covered
  (``final_coverage_seconds`` / ``audio_seconds_sent``), PLUS the strongest
  client-observable loss signal: gaps in the gateway's monotonic transcript
  ``seq`` (a missing seq = a caption the transport dropped).

ENV VARS
--------
============================= =================================================
``STREAM_API_URL``            API/WS base (default ``http://localhost:8868``)
``STREAM_STT_V2_URL``         stt-v2 health base (default ``http://localhost:8861``)
``STREAM_LOGIN_USER``         seeded user (default ``doctor``)
``STREAM_LOGIN_PASSWORD``     (default ``password123``)
``STREAM_LOGIN_TENANT_KEY``   (default ``__GLOBAL__``)
``STREAM_PIPELINE_ID``        ASR pipeline id the caller OWNS. Default
                              ``81000000-0000-0000-0001-000000000402``
                              (``turbo-whisper-large-v3``, __GLOBAL__-owned,
                              model ``openai/whisper-large-v3-turbo`` — cached on
                              the offline test volume). SYSTEM ``best-practice-*``
                              pipelines are NOT resolvable by a __GLOBAL__ caller
                              on this path.
``STREAM_WAV_PATH``           16-bit PCM mono WAV (default the committed
                              107 s Malayalam fixture).
``STREAM_MAX_SECONDS``        cap on replayed audio (default 30; <=0 = full).
``STREAM_FRAME_MS``           frame size ms (default 80, like the gateway path).
``STREAM_WARMUP``             ``1`` = load the ASR model via a throwaway session
                              first so latency reflects transport, not the
                              one-time cold model load (default ``1``).
``STREAM_TIMEOUT_S``          wait after feed for finals + closed (default 45).
``STREAM_LOSS_REPORT_PATH``   JSON report path (default ``./stt-loss-report.json``)
============================= =================================================

Run::

    pnpm py:stt-v2:test:integration      # runs this + the latency harness
    # or just this module:
    conda run -n arcaenv --no-capture-output pytest \
        apps/stt-v2/tests/integration/test_streaming_loss_harness.py -v -s

Skips cleanly (never breaks CI) when the API, STT-v2, login, session bootstrap,
or a usable pipeline is unavailable, or when the offline volume has no cached
model (no transcripts). The report is written to disk regardless when the loop
produced any events.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

import numpy as np
import pytest

pytestmark = [pytest.mark.integration]

_DEFAULT_PIPELINE_ID = "81000000-0000-0000-0001-000000000402"
# Resolve relative to THIS file (apps/stt-v2/tests/integration/…) so the fixture
# is found regardless of the pytest working directory (repo root or apps/stt-v2).
_DEFAULT_WAV = str(
    Path(__file__).resolve().parents[1] / "e2e" / "fixtures" / "20260205_52886591770282917_ml.wav"
)


@pytest.fixture(scope="session")
def verify_test_environment():  # noqa: D401 — fixture override
    """Override the integration conftest's docker-compose-test-infra gate.

    Like the latency harness, this targets a RUNNING stack (API + WS gateway +
    STT-v2) and performs its own reachability probes with clean skips, so the
    directory-level test-Postgres gate does not apply here.
    """
    yield


# ---------------------------------------------------------------------------
# Env helpers
# ---------------------------------------------------------------------------


def _env(name: str, default: str) -> str:
    return os.environ.get(name, "").strip() or default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def _sanitize_url(url: str | None) -> str | None:
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


def _ws_origin(api_url: str) -> str:
    """`ws://host` from the HTTP base (WS path sits OUTSIDE `/api/v1`)."""
    origin = api_url
    if origin.startswith("http"):
        origin = "ws" + origin[len("http"):]
    return origin.rstrip("/").removesuffix("/api/v1")


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------

_SAMPLE_RATE = 16000


@dataclass
class ReplayAudio:
    samples: np.ndarray  # int16 mono @ 16k
    source: str
    path: str | None = None

    @property
    def duration_s(self) -> float:
        return len(self.samples) / _SAMPLE_RATE


def load_replay_audio() -> ReplayAudio:
    """Load STREAM_WAV_PATH (16-bit PCM mono), cap at STREAM_MAX_SECONDS."""
    import wave

    wav_path = _env("STREAM_WAV_PATH", _DEFAULT_WAV)
    path = Path(wav_path)
    if not path.is_file():
        pytest.skip(f"STREAM_WAV_PATH does not exist: {wav_path}")

    with wave.open(str(path), "rb") as wav:
        if wav.getsampwidth() != 2:
            pytest.skip(f"WAV must be 16-bit PCM (sampwidth={wav.getsampwidth()})")
        n_channels = wav.getnchannels()
        src_rate = wav.getframerate()
        raw = wav.readframes(wav.getnframes())

    samples = np.frombuffer(raw, dtype=np.int16)
    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1).astype(np.int16)
    if src_rate != _SAMPLE_RATE:
        duration = len(samples) / src_rate
        target_n = int(duration * _SAMPLE_RATE)
        x_src = np.linspace(0.0, duration, num=len(samples), endpoint=False)
        x_dst = np.linspace(0.0, duration, num=target_n, endpoint=False)
        samples = np.interp(x_dst, x_src, samples.astype(np.float32)).astype(np.int16)

    max_seconds = _env_float("STREAM_MAX_SECONDS", 30.0)
    if max_seconds > 0:
        samples = samples[: int(max_seconds * _SAMPLE_RATE)]
    return ReplayAudio(samples=samples, source="wav", path=str(path))


def _first_speech_frame(samples: np.ndarray, frame_ms: float) -> int:
    """Index of the first frame whose RMS crosses an adaptive speech threshold."""
    frame_len = max(1, int(_SAMPLE_RATE * frame_ms / 1000.0))
    n = max(1, len(samples) // frame_len)
    norm = samples.astype(np.float32) / 32768.0
    rms = np.array(
        [float(np.sqrt(np.mean(norm[i * frame_len : (i + 1) * frame_len] ** 2))) for i in range(n)]
    )
    if rms.size == 0:
        return 0
    threshold = max(0.01, 0.2 * float(np.percentile(rms, 90)))
    above = np.nonzero(rms > threshold)[0]
    return int(above[0]) if above.size else 0


# ---------------------------------------------------------------------------
# Feed + receive over the WS gateway (single monotonic clock)
# ---------------------------------------------------------------------------


@dataclass
class FrameRecord:
    seq: int
    send_ms: float
    audio_start_s: float
    audio_end_s: float


@dataclass
class MessageRecord:
    recv_ms: float
    kind: str  # transcript_partial | transcript_final | status | resumed | error | other
    seq: int | None = None
    text: str = ""
    start_time: float = 0.0
    end_time: float = 0.0
    status: str = ""
    # LocalAgreement-2 committed-prefix length: text[:stable_chars] is settled,
    # text[stable_chars:] is the provisional tentative tail (None ⇒ not emitted).
    stable_chars: int | None = None


@dataclass
class Capture:
    events: list[MessageRecord] = field(default_factory=list)
    closed: asyncio.Event = field(default_factory=asyncio.Event)


def _classify(raw: dict[str, Any], recv_ms: float) -> MessageRecord:
    kind = raw.get("type", "other")
    if kind == "transcript":
        is_final = raw.get("isFinal") is True or raw.get("is_final") in (True, "1")
        return MessageRecord(
            recv_ms=recv_ms,
            kind="transcript_final" if is_final else "transcript_partial",
            seq=raw.get("seq") if isinstance(raw.get("seq"), int) else None,
            text=str(raw.get("text") or ""),
            start_time=_num(raw.get("startTime", raw.get("start_time"))),
            end_time=_num(raw.get("endTime", raw.get("end_time"))),
            stable_chars=_stable_chars(raw),
        )
    if kind == "status":
        return MessageRecord(recv_ms=recv_ms, kind="status", status=str(raw.get("status") or ""))
    if kind in ("resumed", "resume_failed"):
        return MessageRecord(recv_ms=recv_ms, kind=kind)
    if kind == "error":
        return MessageRecord(recv_ms=recv_ms, kind="error", text=str(raw.get("message") or raw.get("code") or ""))
    return MessageRecord(recv_ms=recv_ms, kind="other")


def _num(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _stable_chars(raw: dict[str, Any]) -> int | None:
    """LA-2 committed-prefix length from a transcript frame, or None if absent.

    Mirrors the SDK/gateway convention: ``stableChars`` (camelCase, forwarded by
    the gateway) preferred, ``stable_chars`` (snake, direct from stt-v2) fallback.
    """
    sc = raw.get("stableChars")
    if not isinstance(sc, int):
        sc = raw.get("stable_chars")
    return sc if isinstance(sc, int) and sc >= 0 else None


async def _receive(ws: Any, cap: Capture, t0: float) -> None:
    try:
        async for message in ws:
            recv_ms = (time.perf_counter() - t0) * 1000.0
            if isinstance(message, bytes):
                continue
            try:
                raw = json.loads(message)
            except json.JSONDecodeError:
                continue
            rec = _classify(raw, recv_ms)
            cap.events.append(rec)
            if rec.kind == "status" and rec.status in ("closed", "cancelled"):
                cap.closed.set()
    except Exception:
        # Connection closed by peer / cancelled — the caller handles timeouts.
        return


async def _feed(ws: Any, audio: ReplayAudio, frame_ms: float, t0: float) -> list[FrameRecord]:
    frame_len = int(_SAMPLE_RATE * frame_ms / 1000.0)
    samples = audio.samples
    n_frames = (len(samples) + frame_len - 1) // frame_len
    frame_s = frame_ms / 1000.0
    records: list[FrameRecord] = []
    loop = asyncio.get_running_loop()
    start = loop.time()
    for i in range(n_frames):
        # Drift-free realtime pacing.
        await asyncio.sleep(max(0.0, start + i * frame_s - loop.time()))
        chunk = samples[i * frame_len : (i + 1) * frame_len]
        await ws.send(chunk.tobytes())
        send_ms = (time.perf_counter() - t0) * 1000.0
        records.append(
            FrameRecord(
                seq=i,
                send_ms=send_ms,
                audio_start_s=round(i * frame_s, 4),
                audio_end_s=round((i + 1) * frame_s, 4),
            )
        )
    return records


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
        "p99": round(float(np.percentile(arr, 99)), 1),
        "min": round(float(arr.min()), 1),
        "max": round(float(arr.max()), 1),
    }


def partial_revision_rate(partial_texts: list[str]) -> dict[str, Any]:
    """Fraction of partials that REWRITE (not forward-extend) the prior partial.

    A partial is a "revision" when its trimmed text does not ``startswith`` the
    immediately-preceding partial's trimmed text (a new/reset/rewritten prefix).
    """
    trimmed = [t.strip() for t in partial_texts]
    revisions = 0
    for prev, cur in zip(trimmed, trimmed[1:], strict=False):
        if not cur.startswith(prev):
            revisions += 1
    total = len(trimmed)
    denom = max(1, total)
    return {
        "partials": total,
        "revisions": revisions,
        "rate": round(revisions / denom, 4),
    }


def committed_revision_rate(entries: Sequence[tuple[str, int | None]]) -> dict[str, Any]:
    """Fraction of partials that REWRITE the already-COMMITTED prefix (TASK-487 A1).

    Unlike :func:`partial_revision_rate` (which compares the FULL caption), this
    compares only the LocalAgreement-2 committed region ``text[:stable_chars]`` —
    the settled text the UI renders as final. Re-transcribing the not-yet-committed
    tentative tail (``text[stable_chars:]``, which the UI ghosts) is by design and
    is NOT churn, so it does not count here.

    ``stable_chars`` None/≤0 carries NO committed-prefix information for that frame:
    it is a tentative-tail-only refresh (TASK-471 emits stableChars=0 on those), and
    the UI carries the previously-settled prefix forward unchanged — it does NOT
    un-settle it. So such frames are SKIPPED, not read as a retraction to empty; each
    committed frame is compared against the last frame that actually reported a
    committed prefix. This is the real caption-churn guardrail; LA-2's monotonic
    commit-with-rollback keeps it ≈ 0, so a non-trivial value means genuine
    settled-text flicker (a real regression), not tail volatility.
    """

    def _committed(text: str, sc: int | None) -> str | None:
        # None ⇒ this frame carries no committed-prefix info (skip, carry forward).
        if not isinstance(sc, int) or sc <= 0:
            return None
        return text[:sc].strip()

    total = len(entries)
    revisions = 0
    prev: str | None = None  # last frame that actually reported a committed prefix
    for text, sc in entries:
        cur = _committed(text, sc)
        if not cur:  # no committed info this frame (tail-only) → prefix unchanged
            continue
        if prev is not None and not cur.startswith(prev):
            revisions += 1
        prev = cur
    denom = max(1, total)
    return {
        "partials": total,
        "revisions": revisions,
        "rate": round(revisions / denom, 4),
    }


def seq_loss(seqs: list[int]) -> dict[str, Any]:
    """Gaps in the gateway's monotonic transcript seq = dropped captions."""
    present = sorted({s for s in seqs if isinstance(s, int) and s > 0})
    if not present:
        return {"max_seq": 0, "distinct": 0, "missing": [], "gap_count": 0}
    max_seq = present[-1]
    present_set = set(present)
    missing = [s for s in range(1, max_seq + 1) if s not in present_set]
    return {
        "max_seq": max_seq,
        "distinct": len(present),
        "missing": missing[:50],
        "gap_count": len(missing),
    }


def compute_metrics(
    frames: list[FrameRecord],
    events: list[MessageRecord],
    audio: ReplayAudio,
    frame_ms: float,
) -> dict[str, Any]:
    frame_s = frame_ms / 1000.0
    ordered = sorted(events, key=lambda e: e.recv_ms)
    partials = [e for e in ordered if e.kind == "transcript_partial"]
    finals = [e for e in ordered if e.kind == "transcript_final"]
    transcripts = partials + finals

    first_speech_idx = _first_speech_frame(audio.samples, frame_ms)
    first_speech_send_ms = frames[first_speech_idx].send_ms if first_speech_idx < len(frames) else (
        frames[0].send_ms if frames else 0.0
    )

    first_transcript = min(transcripts, key=lambda e: e.recv_ms) if transcripts else None
    first_worded = next(
        (e for e in sorted(transcripts, key=lambda e: e.recv_ms) if e.text.strip()), None
    )
    first_partial_ms = (
        round(first_transcript.recv_ms - first_speech_send_ms, 1) if first_transcript else None
    )
    ttfw_ms = round(first_worded.recv_ms - first_speech_send_ms, 1) if first_worded else None

    # Commit latency per final: receive − send of the frame holding its end_time.
    commit_latencies: list[float] = []
    per_final: list[dict[str, Any]] = []
    for fin in finals:
        idx = min(max(int(fin.end_time / frame_s), 0), len(frames) - 1) if frames else 0
        send_ms = frames[idx].send_ms if frames else 0.0
        lag = round(fin.recv_ms - send_ms, 1)
        commit_latencies.append(lag)
        per_final.append(
            {
                "seq": fin.seq,
                "end_time_s": round(fin.end_time, 3),
                "commit_latency_ms": lag,
                "text_preview": fin.text.strip()[:60],
            }
        )

    audio_seconds_sent = round(audio.duration_s, 2)
    final_coverage_max = round(max((f.end_time for f in finals), default=0.0), 2)
    final_coverage_sum = round(sum(max(0.0, f.end_time - f.start_time) for f in finals), 2)
    coverage_ratio = round(final_coverage_max / audio_seconds_sent, 3) if audio_seconds_sent else None

    return {
        "first_partial_ms": first_partial_ms,
        "ttfw_ms": ttfw_ms,
        "commit_latency_ms": _stats(commit_latencies),
        # Full-caption revision (informational) + committed-region revision (the
        # TASK-487 A1 guardrail — measures settled-text churn, excludes the tail).
        "partial_revision": partial_revision_rate([p.text for p in partials]),
        "committed_revision": committed_revision_rate([(p.text, p.stable_chars) for p in partials]),
        "loss": {
            "frames_sent": len(frames),
            "audio_seconds_sent": audio_seconds_sent,
            "final_coverage_seconds_max": final_coverage_max,
            "final_coverage_seconds_sum": final_coverage_sum,
            "audio_coverage_ratio": coverage_ratio,
            "seq": seq_loss([t.seq for t in transcripts if t.seq is not None]),
        },
        "counts": {
            "partials": len(partials),
            "finals": len(finals),
            "errors": len([e for e in ordered if e.kind == "error"]),
            "statuses": [e.status for e in ordered if e.kind == "status"],
        },
        "per_final": per_final,
    }


# ---------------------------------------------------------------------------
# Reachability + session bootstrap (through the gateway)
# ---------------------------------------------------------------------------


async def _api_unreachable_reason(http: Any, api_url: str) -> str | None:
    try:
        resp = await http.get(f"{api_url}/api/v1/health", timeout=5.0)
        if resp.status_code != 200:
            return f"API health at {api_url} returned HTTP {resp.status_code}"
        return None
    except Exception as exc:
        return f"API unreachable at {api_url}: {exc}"


async def _stt_v2_unreachable_reason(http: Any, base_url: str) -> str | None:
    try:
        resp = await http.get(f"{base_url}/api/v1/health", timeout=5.0)
        if resp.status_code != 200:
            return f"stt-v2 health at {base_url} returned HTTP {resp.status_code}"
        return None
    except Exception as exc:
        return f"stt-v2 unreachable at {base_url}: {exc}"


async def _login(http: Any, api_url: str) -> str | None:
    resp = await http.post(
        f"{api_url}/api/v1/auth/login",
        json={
            "username": _env("STREAM_LOGIN_USER", "doctor"),
            "password": _env("STREAM_LOGIN_PASSWORD", "password123"),
            "tenantKey": _env("STREAM_LOGIN_TENANT_KEY", "__GLOBAL__"),
        },
        timeout=15.0,
    )
    if resp.status_code != 200:
        return None
    return resp.json().get("token")


async def _create_session(http: Any, api_url: str, token: str) -> dict[str, Any] | tuple[int, str]:
    resp = await http.post(
        f"{api_url}/api/v1/audio/transcription-jobs/stream/session",
        headers={"Authorization": f"Bearer {token}"},
        json={"pipelineId": _env("STREAM_PIPELINE_ID", _DEFAULT_PIPELINE_ID), "sampleRate": _SAMPLE_RATE},
        timeout=30.0,
    )
    if resp.status_code != 201:
        return resp.status_code, resp.text[:200]
    return resp.json()


async def _delete_session(http: Any, api_url: str, token: str, session_id: str) -> None:
    try:
        await http.delete(
            f"{api_url}/api/v1/audio/transcription-jobs/stream/session/{session_id}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=10.0,
        )
    except Exception:
        pass


async def _run_one_session(
    http: Any,
    api_url: str,
    ws_origin: str,
    token: str,
    audio: ReplayAudio,
    frame_ms: float,
    timeout_s: float,
) -> tuple[list[FrameRecord], list[MessageRecord], bool, str]:
    """Create → WS → feed → collect. Returns (frames, events, closed, session_id)."""
    import websockets

    created = await _create_session(http, api_url, token)
    if isinstance(created, tuple):
        status, body = created
        pytest.skip(f"session bootstrap failed: HTTP {status} — {body}")
    session_id = created["sessionId"]
    ticket = created["ticket"]
    url = f"{ws_origin}/ws/stt-v2/stream?sessionId={session_id}&ticket={ticket}"

    cap = Capture()
    frames: list[FrameRecord] = []
    try:
        async with websockets.connect(url, max_size=None, open_timeout=10, close_timeout=5) as ws:
            t0 = time.perf_counter()
            recv_task = asyncio.create_task(_receive(ws, cap, t0))
            frames = await _feed(ws, audio, frame_ms, t0)
            await ws.send(json.dumps({"type": "stop"}))
            try:
                await asyncio.wait_for(cap.closed.wait(), timeout=timeout_s)
            except TimeoutError:
                pass
            recv_task.cancel()
    finally:
        await _delete_session(http, api_url, token, session_id)
    return frames, cap.events, cap.closed.is_set(), session_id


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_metric_functions_are_correct() -> None:
    """Pure-CPU self-check: metric math is right (runs with no services up)."""
    # Revision rate: b extends a (no revision); c rewrites b (revision).
    rev = partial_revision_rate(["he", "hello", "help"])
    assert rev["partials"] == 3
    assert rev["revisions"] == 1  # "help" does not startswith "hello"
    assert rev["rate"] == round(1 / 3, 4)

    # Seq loss: 1,2,4,5 → seq 3 missing.
    loss = seq_loss([1, 2, 4, 5])
    assert loss["max_seq"] == 5
    assert loss["distinct"] == 4
    assert loss["missing"] == [3]
    assert loss["gap_count"] == 1

    # No gaps.
    assert seq_loss([1, 2, 3])["gap_count"] == 0

    # Percentiles present.
    st = _stats([100.0, 200.0, 300.0, 400.0])
    assert st is not None
    assert st["p50"] == 250.0
    assert "p99" in st


async def test_streaming_loss_latency_harness() -> None:
    """Route audio through the WS gateway; emit the loss/latency BASELINE JSON."""
    import httpx

    api_url = _env("STREAM_API_URL", "http://localhost:8868")
    stt_v2_url = _env("STREAM_STT_V2_URL", "http://localhost:8861")
    ws_origin = _ws_origin(api_url)
    frame_ms = _env_float("STREAM_FRAME_MS", 80.0)
    timeout_s = _env_float("STREAM_TIMEOUT_S", 45.0)
    warmup = _env("STREAM_WARMUP", "1") not in ("0", "false", "no")
    report_path = Path(_env("STREAM_LOSS_REPORT_PATH", "./stt-loss-report.json"))

    async with httpx.AsyncClient() as http:
        # --- Reachability gates (clean skips) ------------------------------
        for reason in (
            await _api_unreachable_reason(http, api_url),
            await _stt_v2_unreachable_reason(http, stt_v2_url),
        ):
            if reason:
                pytest.skip(reason)

        token = await _login(http, api_url)
        if not token:
            pytest.skip("login failed — is the test DB seeded (pnpm test:db:seed)?")

        audio = load_replay_audio()

        # --- Warmup: load the ASR model so latency reflects transport ------
        warmed = False
        if warmup:
            try:
                warm_clip = ReplayAudio(samples=audio.samples[: 5 * _SAMPLE_RATE], source="warmup")
                await _run_one_session(http, api_url, ws_origin, token, warm_clip, frame_ms, min(timeout_s, 20.0))
                warmed = True
            except Exception:
                warmed = False  # best-effort; measured run proceeds regardless

        # --- Measured run --------------------------------------------------
        frames, events, closed, session_id = await _run_one_session(
            http, api_url, ws_origin, token, audio, frame_ms, timeout_s
        )

    metrics = compute_metrics(frames, events, audio, frame_ms)
    feed_span_s = round((frames[-1].send_ms - frames[0].send_ms) / 1000.0, 2) if len(frames) > 1 else 0.0
    report = {
        "harness": "TASK-455 S1-EVAL streaming loss/latency (AC-5/6) — through the WS gateway",
        "generated_at": datetime.now(UTC).isoformat(),
        "target": {
            "api_url": api_url,
            "ws_origin": ws_origin,
            "pipeline_id": _env("STREAM_PIPELINE_ID", _DEFAULT_PIPELINE_ID),
            "session_id": session_id,
            "warmed": warmed,
        },
        "fixture": {
            "source": audio.source,
            "path": _sanitize_url(audio.path),
            "duration_s": round(audio.duration_s, 2),
            "sample_rate": _SAMPLE_RATE,
            "frame_ms": frame_ms,
            "n_frames": len(frames),
        },
        "feed": {
            "feed_span_s": feed_span_s,
            "realtime_ratio": round(feed_span_s / audio.duration_s, 3) if audio.duration_s else None,
            "closed_status_received": closed,
        },
        "metrics": metrics,
        "definitions": {
            "clock": "all *_ms values are on this WS client's monotonic perf_counter clock "
            "(send = ws.send() return; receive = onmessage) — single clock, no skew; measures "
            "the full mic→WS→Redis→STT-v2→Redis→WS caption loop",
            "first_partial_ms": "first transcript (any) receive − send of first speech frame",
            "ttfw_ms": "first non-empty-text transcript receive − send of first speech frame",
            "commit_latency_ms": "per final: receive − send of the frame containing the segment endTime",
            "partial_revision_rate": "fraction of partials whose text is not a startswith-extension of the prior partial",
            "loss.audio_coverage_ratio": "max final endTime / audio seconds sent",
            "loss.seq": "gaps in the gateway monotonic transcript seq = dropped captions",
        },
        "baseline_contract_for_TASK_457": (
            "This is the BASELINE only (no thresholds asserted). TASK-457 (Redis consumer-groups "
            "migration) must show NO REGRESSION vs these numbers: commit_latency_ms P50/P99 not "
            "materially higher, partial_revision.rate not higher, loss.seq.gap_count and "
            "audio_coverage_ratio not worse, on the same fixture + pipeline + frame_ms."
        ),
        "events": [
            {
                "recv_ms": round(e.recv_ms, 1),
                "kind": e.kind,
                "seq": e.seq,
                "text_preview": e.text.strip()[:60],
                "end_time": e.end_time,
                "status": e.status,
            }
            for e in sorted(events, key=lambda e: e.recv_ms)
        ],
    }

    report_json = json.dumps(report, indent=2, ensure_ascii=False)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(report_json, encoding="utf-8")
    print(f"\n===== STT LOSS/LATENCY REPORT ({report_path.resolve()}) =====")
    print(report_json)

    # --- Baseline sanity (report is on disk either way) --------------------
    if metrics["counts"]["partials"] == 0 and metrics["counts"]["finals"] == 0:
        pytest.skip(
            "no transcripts produced — the offline volume may not have the ASR model cached for "
            f"pipeline {_env('STREAM_PIPELINE_ID', _DEFAULT_PIPELINE_ID)}. Baseline not captured; "
            f"see {report_path.resolve()}"
        )
    assert metrics["counts"]["finals"] >= 1, (
        "no FINAL segment published — VAD likely never confirmed speech on this fixture. "
        f"See {report_path.resolve()}"
    )
