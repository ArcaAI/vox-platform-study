#!/usr/bin/env python3
"""TASK-1010 — concurrent-stream bench for vllm.

Simulates N realtime streams against ``POST /api/v1/transcriptions``. Each stream cuts
``--window-s`` windows out of a 16 kHz mono PCM16 WAV and posts window *i* at the moment
its audio would exist in real life (``stream start + window + i × hop``), sequentially per
stream — a stream never pipelines its own windows, exactly like an STT session. When the
server is slower than the stream, the next window goes out LATE; that lag is the backlog.

Per ladder step (N = 1, 2, 4, 8, 12, 16, 20, 25, 32 by default) it reports:

* request latency p50/p95/p99 — send → response;
* commit latency p50/p95/p99 — audio available → response (the TASK-1007 "commit"
  metric: includes backlog), judged against ``--commit-bar-s`` (pass bar: 15 s);
* throughput — windows/s and audio-seconds decoded per wall second;
* errors by HTTP status (or exception type);
* keeps_up — every stream's LAST window went out within one hop of its schedule;
* passes — keeps_up AND no errors AND commit p99 ≤ bar.

Standalone on purpose (stdlib + ``httpx``): it runs from a laptop against a remote
replica, e.g.::

    export VLLM_BENCH_TOKEN=...   # the INTERNAL_ACCESS_TOKEN; never on argv
    python apps/vllm/scripts/bench_concurrency.py \\
        --base-url https://vllm.example/ \\
        --tenant-id 50000000-0000-0000-0000-000000000000 \\
        --gateway-url https://api.example/api/v1 \\
        --agent-slug realtime-transcription-vllm-spike \\
        --wav "/Users/taphuynh/Desktop/lab/Woodman-2/output_aligned/Probiotic_Foods_Dr_Manoj_Johnson/0001_0.86_12.58/audio.wav" \\
        --language ml --output results.json

``--wav`` example: a TASK-994 ml-en fixture (real clinician audio, held OUTSIDE git — read
by absolute path, never copied into the repo). Before the ladder the script calls
``POST /api/v1/engines/warm`` once and records the cold start separately (``--no-warm``
to include it in the first step instead).

SELECTION IS AN AGENT, NEVER A MODEL. ``spec.json`` is the gateway's ``ResolvedAsrSpec``
(camelCase, exactly as ``buildResolvedAsrSpec`` emits it and STT forwards it): the ASR
Agent resolved to registry rows. The bench sends it verbatim and has no option that
names a model, a path, an engine or a quantization — those are facts of the registry
row the agent binds.

Where the spec comes from (TASK-1010 OD-12). ``--agent-slug`` (with ``--gateway-url``) asks
the gateway's ``GET /internal/agents/asr-spec`` for the ``ResolvedAsrSpec`` a live session on
that ASR Agent would get — the same ``AsrAgentResolverService``, so agent → registered model
is exercised exactly as in production (the token is the same ``INTERNAL_ACCESS_TOKEN``).
``--spec-file`` replays a spec captured earlier. Exactly one of the two is required.
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
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import httpx

SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2
DEFAULT_LADDER: tuple[int, ...] = (1, 2, 4, 8, 12, 16, 20, 25, 32)
TRANSCRIPTIONS_PATH = "/api/v1/transcriptions"
WARM_PATH = "/api/v1/engines/warm"
TOKEN_ENV_VARS = ("VLLM_BENCH_TOKEN", "INTERNAL_ACCESS_TOKEN")


class BenchInputError(ValueError):
    """The WAV or arguments cannot drive the bench."""


# ── pure helpers ────────────────────────────────────────────────────────────


def read_wav_pcm16(path: Path) -> bytes:
    """The raw PCM16 LE frames of a 16 kHz mono 16-bit WAV (anything else is refused)."""
    with wave.open(str(path), "rb") as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (SAMPLE_RATE, 1, 2):
            raise BenchInputError(
                f"{path} is {w.getframerate()} Hz / {w.getnchannels()} ch / "
                f"{8 * w.getsampwidth()}-bit; need 16 kHz mono PCM16 "
                "(ffmpeg -i in.wav -ar 16000 -ac 1 -sample_fmt s16 out.wav)"
            )
        return w.readframes(w.getnframes())


def validate_spec(spec: Any, source: str) -> dict[str, Any]:
    """``spec`` if it is a ``ResolvedAsrSpec`` — refused up front otherwise.

    Checked here, not left to the server, because a wrong shape would otherwise surface
    as a 422 on every window of every ladder step. Only the slice vllm reads is
    checked; the server validates it properly.
    """
    models = spec.get("models") if isinstance(spec, dict) else None
    asr = models.get("asr") if isinstance(models, dict) else None
    if not isinstance(spec, dict) or not spec.get("runtimeKey") or not isinstance(asr, dict):
        raise BenchInputError(
            f"{source}: not a ResolvedAsrSpec — it needs a runtimeKey and a models.asr row "
            "(the gateway's resolved ASR Agent, not a hand-written model slice)"
        )
    return spec


def load_spec(path: Path) -> dict[str, Any]:
    """The ``ResolvedAsrSpec`` captured in ``path``."""
    try:
        spec = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise BenchInputError(f"{path}: not readable JSON ({exc})") from exc
    return validate_spec(spec, str(path))


async def fetch_spec(
    client: httpx.AsyncClient,
    *,
    gateway_url: str,
    agent_slug: str,
    tenant_id: str,
    token: str,
) -> dict[str, Any]:
    """The ``ResolvedAsrSpec`` the gateway resolves for ``agent_slug`` in ``tenant_id``."""
    url = f"{gateway_url.rstrip('/')}/internal/agents/asr-spec"
    response = await client.get(
        url,
        params={"service": "vllm", "agentSlug": agent_slug, "tenantId": tenant_id},
        headers={"X-Service-Token": token, "X-Tenant-Id": tenant_id},
    )
    if response.status_code != 200:
        raise BenchInputError(
            f"{url}: gateway answered {response.status_code} for agent '{agent_slug}': "
            f"{response.text[:300]}"
        )
    return validate_spec(response.json(), f"{url} (agent '{agent_slug}')")


def cut_windows(
    pcm: bytes, *, window_s: float, hop_s: float, count: int, start_offset_s: float
) -> list[bytes]:
    """``count`` windows of ``window_s``, advancing ``hop_s`` each, wrapping at the end."""
    if not pcm:
        raise BenchInputError("the WAV has no audio frames")
    total = len(pcm) // BYTES_PER_SAMPLE
    size = int(round(window_s * SAMPLE_RATE))
    hop = int(round(hop_s * SAMPLE_RATE))
    start = int(round(start_offset_s * SAMPLE_RATE))
    looped = pcm * (size // total + 2)  # enough copies that any window can wrap
    windows = []
    for i in range(count):
        first = (start + i * hop) % total
        windows.append(looped[first * BYTES_PER_SAMPLE : (first + size) * BYTES_PER_SAMPLE])
    return windows


def percentile(values: list[float], q: float) -> float | None:
    """Linear-interpolated percentile (numpy's default method); ``None`` when empty."""
    if not values:
        return None
    ordered = sorted(values)
    rank = (len(ordered) - 1) * q / 100.0
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


def parse_ladder(text: str) -> tuple[int, ...]:
    steps = tuple(int(part) for part in text.split(",") if part.strip())
    if not steps or any(n < 1 for n in steps):
        raise ValueError(f"ladder must be positive integers, got {text!r}")
    return steps


def _ms(value: float | None) -> float | None:
    return None if value is None else round(value * 1000.0, 1)


# ── results ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class WindowResult:
    stream: int
    index: int
    available_at: float
    sent_at: float
    done_at: float
    status: int | None
    error: str | None

    @property
    def ok(self) -> bool:
        return self.status == 200


@dataclass(frozen=True)
class StepSummary:
    n: int
    windows: int
    ok: int
    errors: dict[str, int]
    latency_p50_ms: float | None
    latency_p95_ms: float | None
    latency_p99_ms: float | None
    commit_p50_ms: float | None
    commit_p95_ms: float | None
    commit_p99_ms: float | None
    throughput_windows_per_s: float
    audio_seconds_per_s: float
    final_lag_max_s: float
    keeps_up: bool
    passes: bool
    wall_s: float
    window_s: float
    hop_s: float


def summarize(
    results: list[WindowResult], *, n: int, window_s: float, hop_s: float, commit_bar_s: float
) -> StepSummary:
    ok = [r for r in results if r.ok]
    errors = Counter(
        str(r.status) if r.status is not None else (r.error or "error") for r in results if not r.ok
    )
    latency = [r.done_at - r.sent_at for r in ok]
    commit = [r.done_at - r.available_at for r in ok]
    wall = (max(r.done_at for r in results) - min(r.sent_at for r in results)) if results else 0.0
    last_index: dict[int, WindowResult] = {}
    for r in results:
        if r.stream not in last_index or r.index > last_index[r.stream].index:
            last_index[r.stream] = r
    final_lag = max((r.sent_at - r.available_at for r in last_index.values()), default=0.0)
    keeps_up = final_lag <= hop_s
    commit_p99 = percentile(commit, 99)
    passes = (
        keeps_up
        and not errors
        and bool(ok)
        and commit_p99 is not None
        and commit_p99 <= commit_bar_s
    )
    return StepSummary(
        n=n,
        windows=len(results),
        ok=len(ok),
        errors=dict(errors),
        latency_p50_ms=_ms(percentile(latency, 50)),
        latency_p95_ms=_ms(percentile(latency, 95)),
        latency_p99_ms=_ms(percentile(latency, 99)),
        commit_p50_ms=_ms(percentile(commit, 50)),
        commit_p95_ms=_ms(percentile(commit, 95)),
        commit_p99_ms=_ms(commit_p99),
        throughput_windows_per_s=round(len(ok) / wall, 3) if wall > 0 else 0.0,
        audio_seconds_per_s=round(len(ok) * window_s / wall, 3) if wall > 0 else 0.0,
        final_lag_max_s=round(final_lag, 3),
        keeps_up=keeps_up,
        passes=passes,
        wall_s=round(wall, 3),
        window_s=window_s,
        hop_s=hop_s,
    )


# ── the load ────────────────────────────────────────────────────────────────


async def _stream(
    client: httpx.AsyncClient,
    stream: int,
    *,
    windows_b64: list[str],
    t0: float,
    offset_s: float,
    window_s: float,
    hop_s: float,
    request_template: dict[str, Any],
    headers: dict[str, str],
    results: list[WindowResult],
) -> None:
    for index, audio_b64 in enumerate(windows_b64):
        available_at = t0 + offset_s + window_s + index * hop_s
        delay = available_at - time.perf_counter()
        if delay > 0:
            await asyncio.sleep(delay)
        sent_at = time.perf_counter()
        status: int | None = None
        error: str | None = None
        try:
            response = await client.post(
                TRANSCRIPTIONS_PATH,
                json={**request_template, "audio_b64": audio_b64},
                headers=headers,
            )
            status = response.status_code
        except httpx.HTTPError as exc:
            error = type(exc).__name__
        results.append(
            WindowResult(stream, index, available_at, sent_at, time.perf_counter(), status, error)
        )


async def run_step(
    client: httpx.AsyncClient,
    *,
    n: int,
    windows_per_stream: int,
    window_s: float,
    hop_s: float,
    pcm: bytes,
    request_template: dict[str, Any],
    headers: dict[str, str],
    commit_bar_s: float,
    stagger: bool = True,
) -> StepSummary:
    """N concurrent realtime streams; returns the step's summary.

    ``stagger`` spreads stream starts evenly over one hop (sessions do not start in
    lock-step in production); ``False`` is the worst-case synchronized burst.
    """
    total_s = len(pcm) / (BYTES_PER_SAMPLE * SAMPLE_RATE)
    streams: list[list[str]] = []
    for s in range(n):
        start = (s * total_s / n) if n else 0.0  # a different slice of the file per stream
        windows = cut_windows(
            pcm, window_s=window_s, hop_s=hop_s, count=windows_per_stream, start_offset_s=start
        )
        streams.append([base64.b64encode(w).decode("ascii") for w in windows])
    results: list[WindowResult] = []
    t0 = time.perf_counter()
    await asyncio.gather(
        *(
            _stream(
                client,
                s,
                windows_b64=streams[s],
                t0=t0,
                offset_s=(s * hop_s / n) if stagger else 0.0,
                window_s=window_s,
                hop_s=hop_s,
                request_template=request_template,
                headers=headers,
                results=results,
            )
            for s in range(n)
        )
    )
    return summarize(results, n=n, window_s=window_s, hop_s=hop_s, commit_bar_s=commit_bar_s)


async def warm_engine(
    client: httpx.AsyncClient, *, spec: dict[str, Any], headers: dict[str, str]
) -> dict[str, Any]:
    """Load the engine once before the ladder; the cold start is reported, not averaged in."""
    started = time.perf_counter()
    response = await client.post(WARM_PATH, json={"spec": spec}, headers=headers)
    wall = time.perf_counter() - started
    body: dict[str, Any] = response.json() if response.content else {}
    return {
        "status": response.status_code,
        "load_seconds": body.get("load_seconds"),
        "already_resident": body.get("already_resident"),
        "wall_seconds": round(wall, 3),
    }


# ── CLI ─────────────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--base-url", required=True, help="vllm base URL (scheme://host[:port])")
    p.add_argument("--tenant-id", required=True, help="sent as X-Tenant-Id")
    source = p.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--agent-slug",
        help="ASR Agent under test; its spec is resolved by the gateway (needs --gateway-url)",
    )
    source.add_argument(
        "--spec-file",
        type=Path,
        help="a ResolvedAsrSpec captured earlier from the gateway",
    )
    p.add_argument(
        "--gateway-url",
        default=None,
        help="gateway API base for --agent-slug, e.g. https://api.example/api/v1",
    )
    p.add_argument("--wav", required=True, type=Path, help="16 kHz mono PCM16 WAV")
    p.add_argument("--language", default="ml", help="Whisper language token (default ml)")
    p.add_argument("--ladder", type=parse_ladder, default=DEFAULT_LADDER, help="e.g. 1,2,4,8")
    p.add_argument("--window-s", type=float, default=7.0, help="window length (default 7.0)")
    p.add_argument(
        "--hop-s",
        type=float,
        default=None,
        help="new window every HOP seconds per stream (default = window: finals only; "
        "smaller adds sliding partial decodes)",
    )
    p.add_argument("--duration-s", type=float, default=60.0, help="stream length per step")
    p.add_argument("--commit-bar-s", type=float, default=15.0, help="commit p99 pass bar")
    p.add_argument("--timeout-s", type=float, default=120.0, help="per-request timeout")
    p.add_argument("--pause-s", type=float, default=5.0, help="idle gap between steps")
    p.add_argument("--temperature", type=float, default=0.0)
    p.add_argument("--max-tokens", type=int, default=None)
    p.add_argument("--no-warm", action="store_true", help="skip the warm-up call")
    p.add_argument("--no-stagger", action="store_true", help="start all streams together")
    p.add_argument("--output", type=Path, default=None, help="write JSON results here")
    return p


def _row(s: StepSummary) -> str:
    return (
        f"| {s.n:>3} | {s.ok}/{s.windows} | {s.latency_p50_ms} | {s.latency_p95_ms} | "
        f"{s.latency_p99_ms} | {s.commit_p99_ms} | {s.audio_seconds_per_s} | "
        f"{s.final_lag_max_s} | {'yes' if s.keeps_up else 'NO'} | "
        f"{'PASS' if s.passes else 'fail'} | {s.errors or ''} |"
    )


async def _main_async(args: argparse.Namespace) -> int:
    token = next((os.environ[v] for v in TOKEN_ENV_VARS if os.environ.get(v)), "")
    headers = {"X-Tenant-Id": args.tenant_id}
    if token:
        headers["X-Service-Token"] = token
    if args.agent_slug:
        if not args.gateway_url:
            raise BenchInputError("--agent-slug needs --gateway-url")
        if not token:
            raise BenchInputError(f"--agent-slug needs a service token in {TOKEN_ENV_VARS}")
        async with httpx.AsyncClient(timeout=args.timeout_s) as gateway:
            spec = await fetch_spec(
                gateway,
                gateway_url=args.gateway_url,
                agent_slug=args.agent_slug,
                tenant_id=args.tenant_id,
                token=token,
            )
    else:
        spec = load_spec(args.spec_file)
    pcm = read_wav_pcm16(args.wav)
    hop_s = args.hop_s or args.window_s
    windows_per_stream = max(1, int(args.duration_s // hop_s))
    template: dict[str, Any] = {
        "spec": spec,
        "language": args.language,
        "temperature": args.temperature,
    }
    if args.max_tokens is not None:
        template["max_tokens"] = args.max_tokens

    limits = httpx.Limits(
        max_connections=max(args.ladder) * 2, max_keepalive_connections=max(args.ladder) * 2
    )
    report: dict[str, Any] = {
        "base_url": args.base_url,
        "wav": str(args.wav),
        "window_s": args.window_s,
        "hop_s": hop_s,
        "windows_per_stream": windows_per_stream,
        "commit_bar_s": args.commit_bar_s,
        "steps": [],
    }
    async with httpx.AsyncClient(
        base_url=args.base_url, timeout=args.timeout_s, limits=limits
    ) as client:
        if not args.no_warm:
            report["cold_start"] = await warm_engine(client, spec=spec, headers=headers)
            print(f"cold start: {report['cold_start']}")
        print(
            "|   N | ok | lat p50 ms | lat p95 ms | lat p99 ms | commit p99 ms | audio s/s | final lag s | keeps up | bar | errors |"
        )
        print("|---|---|---|---|---|---|---|---|---|---|---|")
        for step, n in enumerate(args.ladder):
            if step:
                await asyncio.sleep(args.pause_s)
            summary = await run_step(
                client,
                n=n,
                windows_per_stream=windows_per_stream,
                window_s=args.window_s,
                hop_s=hop_s,
                pcm=pcm,
                request_template=template,
                headers=headers,
                commit_bar_s=args.commit_bar_s,
                stagger=not args.no_stagger,
            )
            report["steps"].append(asdict(summary))
            print(_row(summary), flush=True)
    if args.output:
        args.output.write_text(json.dumps(report, indent=2))
        print(f"wrote {args.output}")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        return asyncio.run(_main_async(args))
    except BenchInputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
