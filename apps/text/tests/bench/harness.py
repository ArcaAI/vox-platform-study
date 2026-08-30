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

## `--tls`: closing the harness's own blind spot (baseline.md, "Harness gap")

Lane A's pooled egress-client cache is supposed to save TLS handshakes, DNS
and connection setup — and the mock upstream was plain HTTP on loopback, so
there was nothing for connection reuse to save; the harness could not price
the thing Lane A fixed. `--tls` serves the mock over HTTPS with a self-signed
cert `mock_upstream.py` generates fresh into a temp dir at start-up (never
committed — see its `ensure_self_signed_cert`).

**The trust story, stated plainly, because a green run here must never read
as "this is fine in production":** the REAL, unmodified `apps/text` process
(`text_service_process.py`) is started with `SSL_CERT_FILE` pointed at that
one temp cert. `httpx` and `httpx2` (the two transport libraries the OpenAI
SDK and this service's adapters use — see `providers/pool.py`'s module
docstring) both read `SSL_CERT_FILE` before falling back to their default
trust store (verified against the installed `httpx==0.28.1` / `httpx2==2.10.0`
`create_ssl_context()`), so this achieves "trust one extra self-signed CA"
with ZERO changes to `apps/text/src/**` — consistent with this harness's
standing rule that measuring the real code means never patching it.

`SSL_CERT_FILE` is a **process-wide, benchmark-only affordance**, never a
production pattern: it would make that process trust ONLY the named file for
EVERY TLS connection it makes, silently dropping every publicly-trusted CA
(a real deployment's Azure/Bedrock/vendor calls would go from "verified
against the public CA set" to "verified against this one file" — a
regression, not a config option, if it ever leaked into a real environment
variable). It is set here, and ONLY here, in a throwaway subprocess this
harness owns start-to-finish.

This narrows the harness's blind spot; it does not erase every difference
from a real TLS endpoint on the public internet (this is still loopback: zero
network RTT, zero DNS lookup, one physical host). See `--connections-per-request`
below for the number that actually settles whether pooling helped, independent
of how much of the difference TLS vs plain-HTTP loopback can show in
latency alone.

## `--connections-per-request`: the number latency noise cannot hide

AC-3's p50/p95/p99 deltas are a few tens of milliseconds wide even before
concurrency is added, which is the same order of magnitude the client cache
is trying to save — noise can hide a real win or manufacture a fake one.
`--connections-per-request` sidesteps that by asking the mock directly: how
many NEW connections did you accept at this concurrency level, versus how
many requests did you serve? A cache that is doing its job reports a ratio
well under 1 (many requests share few connections); a cache doing nothing
reports close to 1 (a new connection every request). See `mock_upstream.py`'s
module docstring ("Connection-count instrumentation") for how the count is
taken.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))

from mock_upstream import TLS_CERT_FILENAME  # noqa: E402
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


def start_mock(
    mode: str, token_count: int, *, tls: bool = False, tls_cert_dir: str | None = None
) -> ProcHandle:
    port = _free_port()
    env = {
        "BENCH_MOCK_PORT": str(port),
        "BENCH_MOCK_TOKEN_COUNT": str(token_count),
        **_MODE_PRESETS[mode],
    }
    if tls:
        env["BENCH_MOCK_TLS"] = "1"
        if tls_cert_dir:
            env["BENCH_MOCK_TLS_CERT_DIR"] = tls_cert_dir
    proc = subprocess.Popen(
        [sys.executable, str(_MOCK_ENTRYPOINT)],
        cwd=_BENCH_DIR,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    scheme = "https" if tls else "http"
    return ProcHandle("mock-upstream", proc, f"{scheme}://127.0.0.1:{port}", "/health")


def start_text(*, ssl_cert_file: str | None = None) -> ProcHandle:
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
    if ssl_cert_file:
        # `--tls`: makes the REAL, unmodified `openai_compat` adapter's
        # httpx/httpx2 transport trust the mock's self-signed cert. See the
        # module docstring's "--tls" section for why this is a benchmark-only
        # affordance and never a production pattern.
        env["SSL_CERT_FILE"] = ssl_cert_file
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
    new_connections: int | None = None

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
            "new_connections": self.new_connections,
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
    track_connections: bool = False,
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

    new_connections: int | None = None
    if track_connections:
        # `--connections-per-request`: the number that proves or disproves
        # connection reuse independent of latency noise (module docstring).
        # Reset happened at the top of THIS level, so this is scoped to it.
        conn_resp = await mock_client.get("/__bench__/connections")
        new_connections = conn_resp.json().get("new_connections")

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
        new_connections=new_connections,
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
        if r.new_connections is not None:
            ratio = (r.new_connections / r.requests) if r.requests else float("nan")
            print(
                f"  connections      : new={r.new_connections} requests={r.requests} "
                f"({ratio:.3f} conn/req)  <- proves/disproves reuse"
            )
        print()


async def main_async(args: argparse.Namespace) -> list[LevelReport]:
    tls_dir: str | None = None
    tls_cert_path: Path | None = None
    if args.tls:
        tls_dir = tempfile.mkdtemp(prefix="bench-tls-")
        tls_cert_path = Path(tls_dir) / TLS_CERT_FILENAME

    mock = start_mock(args.mode, args.tokens, tls=args.tls, tls_cert_dir=tls_dir)
    text = start_text(ssl_cert_file=str(tls_cert_path) if tls_cert_path else None)
    reports: list[LevelReport] = []
    # `--tls`: THIS harness's own diagnostic clients (never the real
    # `text_service_process.py` — that one trusts the cert via `SSL_CERT_FILE`,
    # see the module docstring) need to trust the mock's self-signed cert too,
    # to reach its plain `/health` and `/__bench__/*` endpoints over HTTPS.
    # The mock writes the cert as one of its first start-up actions, before it
    # opens its listening socket — but "spawned" is not "written yet", so wait
    # for the file rather than racing it.
    verify: bool | ssl.SSLContext = True
    if tls_cert_path:
        deadline = time.monotonic() + 20.0
        while not tls_cert_path.exists():
            if mock.proc.poll() is not None:
                raise RuntimeError(
                    f"mock-upstream exited early with code {mock.proc.returncode} "
                    "before writing its TLS cert"
                )
            if time.monotonic() > deadline:
                raise TimeoutError(f"mock-upstream did not write {tls_cert_path} in 20s")
            await asyncio.sleep(0.1)
        verify = ssl.create_default_context(cafile=str(tls_cert_path))
    try:
        async with httpx.AsyncClient(verify=verify) as boot_client:
            try:
                await asyncio.gather(mock.wait_healthy(boot_client), text.wait_healthy(boot_client))

                limits = httpx.Limits(
                    max_connections=max(args.levels) * 2 + 10,
                    max_keepalive_connections=max(args.levels) * 2 + 10,
                )
                async with (
                    httpx.AsyncClient(base_url=text.base_url, limits=limits) as client,
                    # `keepalive_expiry=None`: this client's own connection to
                    # the mock must never expire and reopen mid-run — a
                    # reopen would increment `/__bench__/connections` itself
                    # and corrupt the exact number `--connections-per-request`
                    # exists to report cleanly.
                    httpx.AsyncClient(
                        base_url=mock.base_url,
                        verify=verify,
                        limits=httpx.Limits(keepalive_expiry=None),
                    ) as mock_client,
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
                            track_connections=args.connections_per_request,
                        )
                        reports.append(report)
            finally:
                text.stop()
                mock.stop()
    finally:
        if tls_dir:
            shutil.rmtree(tls_dir, ignore_errors=True)
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
    parser.add_argument(
        "--tls",
        action="store_true",
        help="Serve the mock upstream over HTTPS with a self-signed cert generated at "
        "start-up, and trust it in the real text-service via SSL_CERT_FILE — a "
        "benchmark-only affordance, never a production pattern (see module docstring). "
        "Closes the harness gap in docs/implementation/TASK-818-Text-LLM-Router/baseline.md: "
        "a plain-HTTP loopback mock gives connection pooling nothing to save.",
    )
    parser.add_argument(
        "--connections-per-request",
        action="store_true",
        help="Query the mock's new-connection counter after each level and report "
        "new_connections/requests — the number that proves or disproves connection "
        "reuse independent of latency noise.",
    )
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
