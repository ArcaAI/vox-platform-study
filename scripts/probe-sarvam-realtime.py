#!/usr/bin/env python3
"""Probe Sarvam AI's realtime speech-to-text WebSocket directly. TASK-998.

This talks to the VENDOR, not to HOPE. That is the point: it establishes what
Sarvam actually returns for a given audio file and configuration, independent of
our pipeline, so a disagreement between this transcript and the one HOPE renders
is unambiguously ours.

Audio is streamed in PACED ~100 ms frames, not dumped. A dump would not exercise
the server-side endpointer at all, and endpointing is precisely what we are
evaluating — an unpaced run tells you almost nothing about how the transcript
will segment live.

    export SARVAM_API_KEY=...
    python scripts/probe-sarvam-realtime.py
    python scripts/probe-sarvam-realtime.py --audio path/to.wav --mode codemix --language ml-IN
    python scripts/probe-sarvam-realtime.py --raw          # every event, for protocol debugging

Requires only `websockets` (already in the arcaenv env and in uv.lock).
The key is read from the environment and never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlencode

try:
    import websockets
except ImportError:  # pragma: no cover - operator-facing
    sys.exit("websockets is not installed. Run inside the arcaenv env: conda run -n arcaenv python scripts/probe-sarvam-realtime.py")

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_AUDIO = REPO_ROOT / "apps/stt/tests/e2e/fixtures/20260205_52886591770282917_ml.wav"
WS_BASE = "wss://api.sarvam.ai/speech-to-text-realtime/ws"

#  Sarvam accepts 8000 or 16000 only, and ~3200 bytes is the documented ~100 ms
#  frame at 16 kHz mono 16-bit. Both clinical fixtures are already in that exact
#  format, so the probe does no resampling — if you point it at something else,
#  convert first rather than letting this script guess.
FRAME_MS = 100
REQUIRED_RATE = 16000


@dataclass
class Stats:
    partials: int = 0
    finals: int = 0
    empty_finals: int = 0
    first_event_at: float | None = None
    final_texts: list[str] = field(default_factory=list)
    final_spans: list[tuple[float | None, float | None]] = field(default_factory=list)
    partial_latencies: list[float] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    audio_duration_s: float | None = None


def load_pcm(path: Path) -> tuple[bytes, int, float]:
    with wave.open(str(path), "rb") as wf:
        if wf.getnchannels() != 1 or wf.getsampwidth() != 2:
            sys.exit(f"{path.name}: need mono 16-bit PCM, got {wf.getnchannels()}ch/{wf.getsampwidth() * 8}-bit")
        rate = wf.getframerate()
        if rate != REQUIRED_RATE:
            sys.exit(f"{path.name}: need {REQUIRED_RATE} Hz, got {rate}. Convert it first — this probe does not resample.")
        frames = wf.readframes(wf.getnframes())
    return frames, rate, len(frames) / (rate * 2)


def build_url(args: argparse.Namespace) -> str:
    params = {
        "model": args.model,
        "language_code": args.language,
        "mode": args.mode,
        "endpointing": args.endpointing,
        "encoding": "linear16",
        "sample_rate": str(REQUIRED_RATE),
        "return_timestamps": "true",
        "stream_type": args.stream_type,
    }
    if args.endpointing == "vad":
        params["threshold"] = str(args.threshold)
        params["silence_duration_ms"] = str(args.silence_ms)
        params["min_speech_duration_ms"] = str(args.min_speech_ms)
    if args.prompt:
        params["prompt"] = args.prompt
    return f"{WS_BASE}?{urlencode(params)}"


async def pump_audio(ws, pcm: bytes, *, realtime: bool, stats: Stats) -> None:
    """Feed paced frames, then flush and close the turn."""
    frame_bytes = int(REQUIRED_RATE * 2 * FRAME_MS / 1000)
    started = time.monotonic()
    for index, offset in enumerate(range(0, len(pcm), frame_bytes)):
        chunk = pcm[offset : offset + frame_bytes]
        await ws.send(json.dumps({"event": "audio_input", "audio": base64.b64encode(chunk).decode("ascii")}))
        if realtime:
            #  Pace against the wall clock rather than sleeping a flat interval,
            #  so send-side jitter cannot make the stream drift ahead of real time.
            target = started + (index + 1) * FRAME_MS / 1000
            drift = target - time.monotonic()
            if drift > 0:
                await asyncio.sleep(drift)
    await ws.send(json.dumps({"event": "flush"}))
    #  Give the endpointer room to emit the tail final before we say goodbye.
    await asyncio.sleep(3.0)
    await ws.send(json.dumps({"event": "end"}))


async def read_events(ws, stats: Stats, *, raw: bool, started: float) -> None:
    last_audio_seen = started
    async for message in ws:
        try:
            payload = json.loads(message)
        except (TypeError, ValueError):
            print(f"  [non-JSON frame: {message!r:.80}]")
            continue
        event = payload.get("event") or payload.get("type") or "?"
        elapsed = time.monotonic() - started
        if raw:
            print(f"  [{elapsed:7.2f}s] RAW {json.dumps(payload, ensure_ascii=False)}")
        if stats.first_event_at is None and event.startswith("transcript"):
            stats.first_event_at = elapsed

        if event == "transcript.partial":
            stats.partials += 1
            stats.partial_latencies.append(elapsed - last_audio_seen)
            if not raw:
                print(f"  [{elapsed:7.2f}s] … {payload.get('text', '')}")
        elif event == "transcript.final":
            text = (payload.get("text") or "").strip()
            stats.finals += 1
            if not text:
                stats.empty_finals += 1
            else:
                stats.final_texts.append(text)
                stats.final_spans.append((payload.get("start_s"), payload.get("end_s")))
            span = ""
            if payload.get("start_s") is not None:
                span = f" ({payload['start_s']:.2f}–{payload.get('end_s', 0):.2f}s)"
            if not raw:
                lang = payload.get("language") or ""
                print(f"  [{elapsed:7.2f}s] ✓{span} [{lang}] {text or '<empty>'}")
            last_audio_seen = time.monotonic()
        elif event == "error":
            detail = f"{payload.get('code')}: {payload.get('message')}"
            stats.errors.append(detail)
            print(f"  [{elapsed:7.2f}s] ERROR {detail}  (fatal={payload.get('is_fatal')})")
            if payload.get("is_fatal"):
                return
        elif event == "session.end":
            stats.audio_duration_s = payload.get("audio_duration_s")
            print(f"  [{elapsed:7.2f}s] session.end  audio_duration_s={stats.audio_duration_s}")
            return
        elif event in {"session.begin", "vad.speech_start", "vad.speech_end", "pong", "config.updated"}:
            if not raw:
                print(f"  [{elapsed:7.2f}s] {event}")


async def keepalive(ws) -> None:
    try:
        while True:
            await asyncio.sleep(10)
            await ws.send(json.dumps({"event": "ping"}))
    except asyncio.CancelledError:
        pass


def report(stats: Stats, audio_s: float, wall_s: float) -> None:
    print("\n" + "=" * 72)
    print(f"audio {audio_s:.1f}s · wall {wall_s:.1f}s · finals {stats.finals} "
          f"(empty {stats.empty_finals}) · partials {stats.partials}")
    if stats.first_event_at is not None:
        print(f"first transcript event at {stats.first_event_at:.2f}s")
    if stats.partial_latencies:
        ordered = sorted(stats.partial_latencies)
        print(f"partial latency  p50 {ordered[len(ordered) // 2]:.2f}s  max {ordered[-1]:.2f}s")
    if stats.errors:
        print(f"errors: {len(stats.errors)}")
        for err in stats.errors:
            print(f"  - {err}")

    #  Segment geometry is the whole point of the probe: a transcript that
    #  "looks chunked" is one with many short finals. Print the distribution so
    #  a config change can be judged on evidence rather than on how the prose felt.
    spans = [(a, b) for a, b in stats.final_spans if a is not None and b is not None]
    if spans:
        durations = sorted(b - a for a, b in spans)
        print(f"final duration   p50 {durations[len(durations) // 2]:.2f}s  "
              f"min {durations[0]:.2f}s  max {durations[-1]:.2f}s")
        gaps = [b[0] - a[1] for a, b in zip(spans, spans[1:]) if b[0] is not None and a[1] is not None]
        if gaps:
            gaps.sort()
            print(f"inter-final gap  p50 {gaps[len(gaps) // 2]:.2f}s  max {gaps[-1]:.2f}s")
    if stats.finals:
        print(f"mean chars/final {sum(len(t) for t in stats.final_texts) / max(1, len(stats.final_texts)):.0f}")

    print("\n--- assembled transcript (finals joined with a single space) ---")
    print(" ".join(stats.final_texts) or "<nothing>")
    print("=" * 72)


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--audio", type=Path, default=DEFAULT_AUDIO, help="16 kHz mono 16-bit WAV")
    parser.add_argument("--model", default="saaras:v4")
    parser.add_argument("--language", default="ml-IN", help="BCP-47, or 'auto'")
    parser.add_argument("--mode", default="codemix", choices=["transcribe", "translate", "verbatim", "translit", "codemix"])
    parser.add_argument("--endpointing", default="vad", choices=["vad", "manual"])
    parser.add_argument("--stream-type", default="balanced", choices=["fast", "balanced", "simulated"])
    parser.add_argument("--threshold", type=float, default=0.3)
    parser.add_argument("--silence-ms", type=int, default=500)
    parser.add_argument("--min-speech-ms", type=int, default=250)
    parser.add_argument("--prompt", default=None, help="terminology hint (measure before trusting it — see TASK-994)")
    parser.add_argument("--max-seconds", type=float, default=None, help="truncate the audio, for a quick smoke run")
    parser.add_argument("--no-realtime", action="store_true", help="send as fast as possible (does NOT exercise endpointing)")
    parser.add_argument("--raw", action="store_true", help="print every event verbatim")
    args = parser.parse_args()

    key = os.environ.get("SARVAM_API_KEY")
    if not key:
        print("SARVAM_API_KEY is not set.", file=sys.stderr)
        return 1
    if not args.audio.exists():
        print(f"no such audio file: {args.audio}", file=sys.stderr)
        return 1

    pcm, rate, audio_s = load_pcm(args.audio)
    if args.max_seconds:
        pcm = pcm[: int(args.max_seconds * rate * 2)]
        audio_s = min(audio_s, args.max_seconds)

    url = build_url(args)
    #  Log the URL WITHOUT the key — the key rides a header precisely so it
    #  never lands in a log line or a shell history.
    print(f"→ {WS_BASE}")
    print(f"  model={args.model} mode={args.mode} language={args.language} "
          f"endpointing={args.endpointing} stream_type={args.stream_type}")
    print(f"  audio={args.audio.name} {audio_s:.1f}s @ {rate} Hz, paced={'no' if args.no_realtime else 'yes'}\n")

    stats = Stats()
    started = time.monotonic()
    try:
        async with websockets.connect(url, additional_headers={"api-subscription-key": key}) as ws:
            ka = asyncio.create_task(keepalive(ws))
            reader = asyncio.create_task(read_events(ws, stats, raw=args.raw, started=started))
            await pump_audio(ws, pcm, realtime=not args.no_realtime, stats=stats)
            try:
                await asyncio.wait_for(reader, timeout=30)
            except asyncio.TimeoutError:
                print("  (reader timed out waiting for session.end)")
                reader.cancel()
            ka.cancel()
    except websockets.exceptions.InvalidStatus as exc:
        #  A 401/403 here is the single most common first failure; name it plainly.
        print(f"\nhandshake rejected: {exc}", file=sys.stderr)
        print("check SARVAM_API_KEY, and that the account has realtime streaming enabled.", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"\nconnection failed: {exc}", file=sys.stderr)
        return 1

    report(stats, audio_s, time.monotonic() - started)
    return 1 if stats.errors and not stats.final_texts else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
