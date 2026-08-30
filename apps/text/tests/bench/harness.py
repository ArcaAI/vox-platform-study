"""Lane H benchmark harness — TASK-818 §4.8 / §5 (AC-1..AC-4, AC-7).

Drives the REAL `apps/text` service (`text_service_process.py`, unmodified
`text.main.create_app`) against the mock upstream (`mock_upstream.py`) in
either of two modes, sweeps concurrency, and reports the numbers this ticket
is judged on: proxy-added TTFT (AC-3), proxy-added inter-token latency
(AC-4), p50/p95/p99 latency at each concurrency level (never averages), and
per-stream RSS (AC-2).

Usage (see `bench/README.md` for the full walkthrough):

    uv run --extra test python tests/bench/harness.py \\
        --mode zero-latency --levels 10,25,50 --duration 5

    uv run --extra test python tests/bench/harness.py \\
        --mode latency-injecting --levels 10,25,50,100 --duration 10

Cross-process timing note: AC-3's delta is computed by subtracting the mock
upstream's own `time.monotonic()` timestamp (recorded in its process) from
this harness's `time.monotonic()` timestamp (recorded in ITS process).
`time.monotonic()` on POSIX (both Linux `CLOCK_MONOTONIC` and macOS
`mach_absolute_time`) is boot-relative, not process-relative, so two
processes ON THE SAME MACHINE read comparable values — verified empirically
for this environment (see the ticket report). This technique is NOT valid
across two different physical hosts; both processes here always run on one.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import socket
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))

from stats import Sample, summarize  # noqa: E402

_TENANT_ID = "11111111-1111-1111-1111-111111111111"
_BENCH_DIR = Path(__file__).parent
_TEXT_ENTRYPOINT = _BENCH_DIR / "text_service_process.py"
_MOCK_ENTRYPOINT = _BENCH_DIR / "mock_upstream.py"

# README §4.8: "(2) a latency-injecting mock (e.g. 800 ms TTFT, 30 tok/s)".
# 1000/30 ≈ 33ms/token.
_MODE_PRESETS: dict[str, dict[str, str]] = {
    "zero-latency": {"BENCH_MOCK_TTFT_MS": "0", "BENCH_MOCK_TOKEN_INTERVAL_MS": "0"},
    "latency-injecting": {"BENCH_MOCK_TTFT_MS": "800", "BENCH_MOCK_TOKEN_INTERVAL_MS": "33"},
}


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@dataclass
class ProcHandle:
    name: str
    proc: subprocess.Popen
    base_url: str
    health_path: str

    async def wait_healthy(self, client: httpx.AsyncClient, timeout_s: float = 20.0) -> None:
        deadline = time.monotonic() + timeout_s
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(
                    f"{self.name} exited early with code {self.proc.returncode} "
                    "before becoming healthy"
                )
            try:
                resp = await client.get(f"{self.base_url}{self.health_path}", timeout=2.0)
                if resp.status_code == 200:
                    return
            except httpx.HTTPError as exc:
                last_error = exc
            await asyncio.sleep(0.25)
        raise TimeoutError(f"{self.name} did not become healthy in {timeout_s}s: {last_error}")

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)


def start_mock(mode: str, token_count: int) -> ProcHandle:
    port = _free_port()
    env = {
        "BENCH_MOCK_PORT": str(port),
        "BENCH_MOCK_TOKEN_COUNT": str(token_count),
        **_MODE_PRESETS[mode],
    }
    proc = subprocess.Popen(
        [sys.executable, str(_MOCK_ENTRYPOINT)],
        cwd=_BENCH_DIR,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return ProcHandle("mock-upstream", proc, f"http://127.0.0.1:{port}", "/health")


def start_text() -> ProcHandle:
    import os

    port = _free_port()
    env = {
        **os.environ,
        "BENCH_TEXT_PORT": str(port),
        "CI": "true",
        "INTERNAL_ACCESS_TOKEN": "",
        "SERVICE_TOKEN": "",
        "TEXT_OTEL_EXPORTER_ENDPOINT": "",
    }
    proc = subprocess.Popen(
        [sys.executable, str(_TEXT_ENTRYPOINT)],
        cwd=_BENCH_DIR,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return ProcHandle("text-service", proc, f"http://127.0.0.1:{port}", "/api/v1/health")


@dataclass
class RequestResult:
    bench_id: str
    ok: bool
    error: str | None = None
    client_send_ts: float | None = None
    client_first_byte_ts: float | None = None
    client_done_ts: float | None = None
    chunk_arrival_ts: list[float] = field(default_factory=list)


async def run_one(
    client: httpx.AsyncClient,
    mock_base: str,
    *,
    stream: bool,
    model: str,
    protocol: str = "sse",
) -> RequestResult:
    bench_id = str(uuid.uuid4())
    result = RequestResult(bench_id=bench_id, ok=False)
    body = {
        "prompt": f"[[bench:{bench_id}]] Summarize the following clinical note in one sentence.",
        "provider": "lm-studio",
        "model": model,
        "stream": stream,
        "provider_overrides": {
            "lm-studio": {"api_key": "bench-key", "base_url": f"{mock_base}/v1"}
        },
    }
    headers = {"X-Tenant-Id": _TENANT_ID}
    try:
        result.client_send_ts = time.monotonic()
        if stream:
            await _run_stream(client, body, headers, result, protocol=protocol)
        else:
            resp = await client.post("/api/v1/generate", json=body, headers=headers, timeout=60.0)
            if resp.status_code != 200:
                result.error = f"generate returned {resp.status_code}: {resp.text[:200]}"
                return result
            now = time.monotonic()
            result.client_first_byte_ts = now
            result.client_done_ts = now
        if result.error:
            return result
        result.ok = True
    except Exception as exc:  # noqa: BLE001 - a failed request is a data point, not a crash
        result.error = f"{type(exc).__name__}: {exc}"
    return result


async def _read_sse(response: httpx.Response, result: RequestResult) -> str | None:
    """Timestamp every delivered frame; return the generation id from the first."""
    generation_id: str | None = None
    async for line in response.aiter_lines():
        if not line.startswith("data:"):
            continue
        now = time.monotonic()
        payload = line[5:].strip()
        if generation_id is None and "generation_id" in payload:
            # The `meta` frame. It is protocol overhead, not a token — counting
            # it as the client's first byte would flatter AC-3 by exactly the
            # cost of the first delta, so it is deliberately excluded from both
            # the TTFT and the inter-token series.
            try:
                generation_id = str(json.loads(payload)["generation_id"])
                continue
            except (ValueError, KeyError):
                pass
        if result.client_first_byte_ts is None:
            result.client_first_byte_ts = now
        result.chunk_arrival_ts.append(now)
    return generation_id


async def _run_stream(
    client: httpx.AsyncClient,
    body: dict,
    headers: dict,
    result: RequestResult,
    *,
    protocol: str,
) -> None:
    """Drive one streaming generation under the requested client protocol.

    Two protocols, because TASK-818 changed the wire contract and an honest
    before/after has to separate two different wins:

    ``sse`` (default, the shipped contract)
        One request. ``POST /generate`` answers 200 + SSE and streams.

    ``resume``
        Two requests, deliberately: POST, take the generation id from the first
        frame, abandon that response, and reconnect through
        ``GET /generations/{id}/stream``. This costs the SAME extra round trip
        the old 202-and-poll flow did, so comparing it against ``sse`` isolates
        "the round trip was removed" from "the per-token work was removed".
        Without it, an AC-3 improvement cannot be attributed to either.
    """
    async with client.stream(
        "POST", "/api/v1/generate", json=body, headers=headers, timeout=60.0
    ) as response:
        if response.status_code != 200:
            result.error = f"generate returned {response.status_code}"
            return
        if protocol == "sse":
            await _read_sse(response, result)
            result.client_done_ts = time.monotonic()
            return

        # `resume`: read only the meta frame, then drop this response.
        generation_id = None
        async for line in response.aiter_lines():
            if line.startswith("data:") and "generation_id" in line:
                generation_id = str(json.loads(line[5:].strip())["generation_id"])
                break
    if generation_id is None:
        result.error = "no generation id in the first frame"
        return

    async with client.stream(
        "GET",
        f"/api/v1/generations/{generation_id}/stream",
        headers=headers,
        timeout=60.0,
    ) as resumed:
        if resumed.status_code != 200:
            result.error = f"resume returned {resumed.status_code}"
            return
        await _read_sse(resumed, result)
    result.client_done_ts = time.monotonic()


async def sample_rss(pid: int) -> float | None:
    """RSS in KB for `pid`, or None if the process is gone or `ps` is unavailable.

    Shells out to `ps` rather than adding a `psutil` dependency: `apps/text`'s
    `pyproject.toml`/`uv.lock` are shared surfaces this lane does not own
    (EXECUTION-PLAN §4 — `uv lock` is orchestrator-only), and `ps -o rss=` is
    POSIX-portable (verified on this machine's Darwin `ps`).
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "ps",
            "-o",
            "rss=",
            "-p",
            str(pid),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await proc.communicate()
        text = stdout.decode().strip()
        return float(text) if text else None
    except (OSError, ValueError):
        return None


@dataclass
class LevelReport:
    concurrency: int
    requests: int
    errors: int
    duration_s: float
    client_ttft_ms: Sample
    provider_ttft_ms: Sample
    proxy_overhead_ms: Sample
    inter_token_ms: Sample
    total_latency_ms: Sample
    rss_baseline_kb: float | None
    rss_plateau_kb: float | None
    rss_per_stream_kb: float | None

    def as_dict(self) -> dict:
        return {
            "concurrency": self.concurrency,
            "requests": self.requests,
            "errors": self.errors,
            "duration_s": self.duration_s,
            "client_ttft_ms": self.client_ttft_ms.as_dict(),
            "provider_ttft_ms": self.provider_ttft_ms.as_dict(),
            "proxy_overhead_ms": self.proxy_overhead_ms.as_dict(),
            "inter_token_ms": self.inter_token_ms.as_dict(),
            "total_latency_ms": self.total_latency_ms.as_dict(),
            "rss_baseline_kb": self.rss_baseline_kb,
            "rss_plateau_kb": self.rss_plateau_kb,
            "rss_per_stream_kb": self.rss_per_stream_kb,
        }


async def run_level(
    *,
    client: httpx.AsyncClient,
    mock_base: str,
    mock_client: httpx.AsyncClient,
    text_pid: int,
    concurrency: int,
    duration_s: float,
    stream: bool,
    model: str,
    protocol: str = "sse",
) -> LevelReport:
    await mock_client.post("/__bench__/reset")
    rss_baseline = await sample_rss(text_pid)

    results: list[RequestResult] = []
    rss_samples: list[float] = []
    stop = asyncio.Event()

    async def worker() -> None:
        while not stop.is_set():
            results.append(
                await run_one(client, mock_base, stream=stream, model=model, protocol=protocol)
            )

    async def sampler() -> None:
        while not stop.is_set():
            v = await sample_rss(text_pid)
            if v is not None:
                rss_samples.append(v)
            await asyncio.sleep(0.25)

    tasks = [asyncio.create_task(worker()) for _ in range(concurrency)]
    sampler_task = asyncio.create_task(sampler())
    start = time.monotonic()
    await asyncio.sleep(duration_s)
    stop.set()
    # Let each worker's in-flight request finish naturally rather than
    # yanking the connection mid-stream — a bench artifact of cancellation
    # must never be reported as a real dropped-stream number.
    await asyncio.gather(*tasks, return_exceptions=True)
    sampler_task.cancel()
    elapsed = time.monotonic() - start
    rss_plateau = rss_samples[-1] if rss_samples else None

    provider_timings = (await mock_client.get("/__bench__/timings")).json()

    ok_results = [r for r in results if r.ok]
    client_ttft = [
        (r.client_first_byte_ts - r.client_send_ts) * 1000
        for r in ok_results
        if r.client_first_byte_ts is not None
    ]
    total_latency = [
        (r.client_done_ts - r.client_send_ts) * 1000
        for r in ok_results
        if r.client_done_ts is not None
    ]
    provider_ttft: list[float] = []
    proxy_overhead: list[float] = []
    for r in ok_results:
        timing = provider_timings.get(r.bench_id)
        if not timing or timing.get("first_byte_ts") is None or r.client_first_byte_ts is None:
            continue
        p_ttft_ms = (timing["first_byte_ts"] - timing["received_ts"]) * 1000
        provider_ttft.append(p_ttft_ms)
        delta_ms = (r.client_first_byte_ts - timing["first_byte_ts"]) * 1000
        proxy_overhead.append(delta_ms)

    inter_token: list[float] = []
    for r in ok_results:
        arrivals = r.chunk_arrival_ts
        for a, b in zip(arrivals, arrivals[1:], strict=False):
            inter_token.append((b - a) * 1000)

    rss_per_stream = None
    if rss_baseline is not None and rss_plateau is not None and concurrency > 0:
        rss_per_stream = (rss_plateau - rss_baseline) / concurrency

    return LevelReport(
        concurrency=concurrency,
        requests=len(results),
        errors=len(results) - len(ok_results),
        duration_s=elapsed,
        client_ttft_ms=summarize(client_ttft),
        provider_ttft_ms=summarize(provider_ttft),
        proxy_overhead_ms=summarize(proxy_overhead),
        inter_token_ms=summarize(inter_token),
        total_latency_ms=summarize(total_latency),
        rss_baseline_kb=rss_baseline,
        rss_plateau_kb=rss_plateau,
        rss_per_stream_kb=rss_per_stream,
    )


def _fmt_sample(s: Sample, unit: str) -> str:
    if s.count == 0:
        return "n/a (0 samples)"
    return f"p50={s.p50:.2f}{unit} p95={s.p95:.2f}{unit} p99={s.p99:.2f}{unit} (n={s.count})"


def print_report(mode: str, stream: bool, reports: list[LevelReport]) -> None:
    print(f"\n=== Lane H benchmark — mode={mode} stream={stream} ===\n")
    for r in reports:
        print(f"--- concurrency={r.concurrency} (ran {r.duration_s:.1f}s) ---")
        print(f"  requests={r.requests} errors={r.errors}")
        print(f"  client TTFT      : {_fmt_sample(r.client_ttft_ms, 'ms')}")
        print(f"  provider TTFT    : {_fmt_sample(r.provider_ttft_ms, 'ms')}")
        print(f"  AC-3 proxy delta : {_fmt_sample(r.proxy_overhead_ms, 'ms')}  <- judged number")
        print(f"  AC-4 inter-token : {_fmt_sample(r.inter_token_ms, 'ms')}")
        print(f"  total latency    : {_fmt_sample(r.total_latency_ms, 'ms')}")
        if r.rss_per_stream_kb is not None:
            print(
                f"  AC-2 RSS/stream  : {r.rss_per_stream_kb:.2f} KB "
                f"(baseline={r.rss_baseline_kb:.0f}KB plateau={r.rss_plateau_kb:.0f}KB)"
            )
        else:
            print("  AC-2 RSS/stream  : n/a (ps sampling unavailable)")
        print()


async def main_async(args: argparse.Namespace) -> list[LevelReport]:
    mock = start_mock(args.mode, args.tokens)
    text = start_text()
    reports: list[LevelReport] = []
    async with httpx.AsyncClient() as boot_client:
        try:
            await asyncio.gather(mock.wait_healthy(boot_client), text.wait_healthy(boot_client))

            limits = httpx.Limits(
                max_connections=max(args.levels) * 2 + 10,
                max_keepalive_connections=max(args.levels) * 2 + 10,
            )
            async with (
                httpx.AsyncClient(base_url=text.base_url, limits=limits) as client,
                httpx.AsyncClient(base_url=mock.base_url) as mock_client,
            ):
                # Warm-up: the FIRST real requests into a freshly-started
                # process pay one-time costs this harness must not attribute
                # to "proxy overhead" — provider adapter classes imported
                # lazily on first use (`main.py::_register_provider_factories`
                # docstring), the OpenAI SDK's own client construction, and
                # CPython's own import/bytecode-cache warm-up. Discarded, not
                # reported; every measured level below starts from a warm
                # process.
                for _ in range(args.warmup):
                    await run_one(
                        client,
                        mock.base_url,
                        stream=not args.no_stream,
                        model=args.model,
                        protocol=args.protocol,
                    )
                await mock_client.post("/__bench__/reset")

                for level in args.levels:
                    report = await run_level(
                        client=client,
                        mock_base=mock.base_url,
                        mock_client=mock_client,
                        text_pid=text.proc.pid,
                        concurrency=level,
                        duration_s=args.duration,
                        stream=not args.no_stream,
                        model=args.model,
                        protocol=args.protocol,
                    )
                    reports.append(report)
        finally:
            text.stop()
            mock.stop()
    return reports


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=sorted(_MODE_PRESETS), default="zero-latency")
    parser.add_argument(
        "--levels",
        type=lambda s: [int(x) for x in s.split(",")],
        default=[10, 25, 50, 100],
        help="Comma-separated concurrency levels to sweep (README §5 AC-1: >=100).",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=5.0,
        help="Seconds to sustain each concurrency level (AC-1's real bar is 600s; "
        "default is a short smoke sweep — see bench/README.md).",
    )
    parser.add_argument("--tokens", type=int, default=40, help="Synthetic tokens/completion.")
    parser.add_argument(
        "--warmup",
        type=int,
        default=20,
        help="Throwaway requests before the first measured level (discards cold-start costs).",
    )
    parser.add_argument("--model", default="mock-model")
    parser.add_argument(
        "--protocol",
        choices=("sse", "resume"),
        default="sse",
        help=(
            "Client protocol for streaming runs. 'sse' is the shipped contract "
            "(one request). 'resume' pays the same extra round trip the old "
            "202-and-poll flow did, which is what makes an AC-3 comparison "
            "attributable rather than merely favourable."
        ),
    )
    parser.add_argument("--no-stream", action="store_true", help="Exercise stream=false (AC-7).")
    parser.add_argument("--out", type=Path, default=None, help="Write JSON report to this path.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    reports = asyncio.run(main_async(args))
    print_report(args.mode, not args.no_stream, reports)
    if args.out:
        args.out.write_text(
            json.dumps(
                {
                    "mode": args.mode,
                    "stream": not args.no_stream,
                    "levels": [r.as_dict() for r in reports],
                },
                indent=2,
            )
        )
        print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
