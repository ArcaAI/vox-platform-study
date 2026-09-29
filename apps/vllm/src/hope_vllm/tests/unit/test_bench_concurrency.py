"""scripts/bench_concurrency.py — exercised against an in-process fake server.

The script is deliberately standalone (stdlib + httpx) so it runs from a laptop
against a remote URL; it is loaded here by path rather than imported as a package.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import wave
from pathlib import Path
from types import ModuleType
from typing import Any

import httpx
import numpy as np
import pytest

SCRIPT = Path(__file__).resolve().parents[4] / "scripts" / "bench_concurrency.py"


@pytest.fixture(scope="module")
def bench() -> ModuleType:
    spec = importlib.util.spec_from_file_location("bench_concurrency", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["bench_concurrency"] = module
    spec.loader.exec_module(module)
    return module


def write_wav(path: Path, seconds: float, *, rate: int = 16_000, channels: int = 1) -> None:
    samples = (np.sin(np.arange(int(seconds * rate)) / 10) * 8000).astype("<i2")
    if channels == 2:
        samples = np.repeat(samples, 2)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())


class FakeServer:
    """ASGI app standing in for vllm: fixed latency, optional failures."""

    def __init__(self, delay_s: float = 0.0, fail_every: int = 0) -> None:
        self.delay_s = delay_s
        self.fail_every = fail_every
        self.calls = 0
        self.warms = 0
        self.max_concurrent = 0
        self._inflight = 0
        self.headers: list[dict[str, str]] = []

    async def __call__(self, scope, receive, send) -> None:  # type: ignore[no-untyped-def]
        assert scope["type"] == "http"
        body = b""
        while True:
            message = await receive()
            body += message.get("body", b"")
            if not message.get("more_body"):
                break
        self.headers.append({k.decode(): v.decode() for k, v in scope["headers"]})
        if scope["path"] == "/api/v1/engines/warm":
            self.warms += 1
            payload = {"runtime_key": "k", "already_resident": False, "load_seconds": 1.5}
            status = 200
        else:
            self.calls += 1
            self._inflight += 1
            self.max_concurrent = max(self.max_concurrent, self._inflight)
            try:
                await asyncio.sleep(self.delay_s)
            finally:
                self._inflight -= 1
            json.loads(body)
            if self.fail_every and self.calls % self.fail_every == 0:
                status, payload = 503, {"detail": {"code": "ENGINE_CAPACITY"}}
            else:
                status, payload = 200, {"text": "ok", "timings": {"decode_ms": 1.0}}
        raw = json.dumps(payload).encode()
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": raw})


def client_for(app: FakeServer) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://bench")


def test_reads_16k_mono_pcm16_wav(bench, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    path = tmp_path / "a.wav"
    write_wav(path, 1.0)
    assert len(bench.read_wav_pcm16(path)) == 16_000 * 2


def test_refuses_a_wav_that_is_not_16k_mono(bench, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    path = tmp_path / "stereo.wav"
    write_wav(path, 1.0, channels=2)
    with pytest.raises(bench.BenchInputError, match="16 kHz mono"):
        bench.read_wav_pcm16(path)


def test_cut_windows_advances_by_hop_and_wraps(bench) -> None:  # type: ignore[no-untyped-def]
    # A ramp modulo a prime: every sample position within the wrap distance is distinguishable.
    ramp = (np.arange(10 * 16_000) % 30011).astype("<i2")  # 10 s
    windows = bench.cut_windows(
        ramp.tobytes(), window_s=7.0, hop_s=7.0, count=3, start_offset_s=0.0
    )
    assert [len(w) for w in windows] == [7 * 16_000 * 2] * 3
    first = np.frombuffer(windows[0], dtype="<i2")
    second = np.frombuffer(windows[1], dtype="<i2")
    assert first[0] == ramp[0]
    # the second window starts 7 s in and wraps past the end of the 10 s file
    assert second[0] == ramp[7 * 16_000]
    assert second[3 * 16_000] == ramp[0]
    assert second[3 * 16_000 - 1] == ramp[-1]


def test_percentiles(bench) -> None:  # type: ignore[no-untyped-def]
    values = [float(v) for v in range(1, 101)]
    assert bench.percentile(values, 50) == pytest.approx(50.5)
    assert bench.percentile(values, 99) == pytest.approx(99.01)
    assert bench.percentile([], 50) is None


def test_default_ladder(bench) -> None:  # type: ignore[no-untyped-def]
    assert bench.DEFAULT_LADDER == (1, 2, 4, 8, 12, 16, 20, 25, 32)


async def test_a_fast_server_keeps_up_with_realtime(bench) -> None:  # type: ignore[no-untyped-def]
    server = FakeServer(delay_s=0.005)
    pcm = np.zeros(16_000, dtype="<i2").tobytes()
    async with client_for(server) as client:
        summary = await bench.run_step(
            client,
            n=4,
            windows_per_stream=3,
            window_s=0.02,
            hop_s=0.03,
            pcm=pcm,
            request_template={"spec": {"runtimeKey": "k"}, "language": "ml"},
            headers={"X-Tenant-Id": "t", "X-Service-Token": "s"},
            commit_bar_s=15.0,
            stagger=False,  # synchronized burst, so overlap is deterministic
        )
    assert summary.n == 4
    assert summary.windows == 12 and summary.ok == 12 and summary.errors == {}
    assert summary.keeps_up is True and summary.passes is True
    assert summary.latency_p50_ms is not None and summary.latency_p99_ms is not None
    assert summary.commit_p99_ms is not None
    assert summary.audio_seconds_per_s > 0
    assert server.headers[0]["x-tenant-id"] == "t"
    assert server.max_concurrent >= 2  # streams really run concurrently


async def test_a_slow_server_falls_behind_realtime(bench) -> None:  # type: ignore[no-untyped-def]
    server = FakeServer(delay_s=0.08)
    pcm = np.zeros(16_000, dtype="<i2").tobytes()
    async with client_for(server) as client:
        summary = await bench.run_step(
            client,
            n=2,
            windows_per_stream=4,
            window_s=0.02,
            hop_s=0.02,
            pcm=pcm,
            request_template={"spec": {"runtimeKey": "k"}, "language": "ml"},
            headers={},
            commit_bar_s=0.05,
        )
    assert summary.keeps_up is False
    assert summary.passes is False
    assert summary.final_lag_max_s > 0.02


async def test_errors_are_counted_by_status(bench) -> None:  # type: ignore[no-untyped-def]
    server = FakeServer(fail_every=2)
    pcm = np.zeros(16_000, dtype="<i2").tobytes()
    async with client_for(server) as client:
        summary = await bench.run_step(
            client,
            n=2,
            windows_per_stream=2,
            window_s=0.01,
            hop_s=0.02,
            pcm=pcm,
            request_template={"spec": {"runtimeKey": "k"}, "language": "ml"},
            headers={},
            commit_bar_s=15.0,
        )
    assert summary.ok == 2
    assert summary.errors == {"503": 2}
    assert summary.passes is False


async def test_warm_records_the_cold_start(bench) -> None:  # type: ignore[no-untyped-def]
    server = FakeServer()
    async with client_for(server) as client:
        cold = await bench.warm_engine(client, spec={"runtimeKey": "k"}, headers={})
    assert server.warms == 1
    assert cold["load_seconds"] == pytest.approx(1.5)
    assert cold["wall_seconds"] >= 0


def test_parse_ladder(bench) -> None:  # type: ignore[no-untyped-def]
    assert bench.parse_ladder("1, 4,25") == (1, 4, 25)
    with pytest.raises(ValueError):
        bench.parse_ladder("0,2")


async def test_the_bench_body_is_accepted_by_the_real_endpoint(bench, settings) -> None:  # type: ignore[no-untyped-def]
    """Bench ↔ service contract: the same app the tests build, with a fake engine."""
    from hope_vllm.main import create_app
    from hope_vllm.tests.conftest import TENANT_ID, spec_payload
    from hope_vllm.tests.fakes import FakeEngineFactory

    app = create_app(settings, engine_factory=FakeEngineFactory())
    pcm = np.zeros(16_000, dtype="<i2").tobytes()
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://svc"
        ) as client:
            cold = await bench.warm_engine(
                client, spec=spec_payload(), headers={"X-Tenant-Id": TENANT_ID}
            )
            summary = await bench.run_step(
                client,
                n=3,
                windows_per_stream=2,
                window_s=0.5,
                hop_s=0.01,
                pcm=pcm,
                request_template={"spec": spec_payload(), "language": "ml", "temperature": 0.0},
                headers={"X-Tenant-Id": TENANT_ID},
                commit_bar_s=15.0,
            )
    assert cold["status"] == 200
    assert summary.errors == {} and summary.ok == 6


# ── OD-12: selection is a gateway-resolved spec; the bench never names a model ──


def test_selection_is_a_spec_file_and_no_option_names_a_model(bench) -> None:  # type: ignore[no-untyped-def]
    parser = bench._build_parser()
    options = {opt for action in parser._actions for opt in action.option_strings}
    # Exactly one spec source: a captured spec file, or an ASR Agent the gateway resolves.
    with pytest.raises(SystemExit):
        parser.parse_args(["--base-url", "http://x", "--tenant-id", "t", "--wav", "a.wav"])
    with pytest.raises(SystemExit):
        parser.parse_args(
            ["--base-url", "http://x", "--tenant-id", "t", "--wav", "a.wav"]
            + ["--spec-file", "s.json", "--agent-slug", "a"]
        )
    forbidden = {
        "--model",
        "--model-slug",
        "--slug",
        "--model-path",
        "--local-path",
        "--source-uri",
        "--repo",
        "--engine",
        "--pipeline-id",
        "--hf-token",
        "--quantization",
    }
    assert forbidden.isdisjoint(options)


def test_the_spec_file_must_be_a_resolved_asr_spec(bench, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    from hope_vllm.tests.conftest import spec_payload

    good = tmp_path / "spec.json"
    good.write_text(json.dumps(spec_payload()))
    assert bench.load_spec(good)["runtimeKey"] == "agent-version-0001"

    # The pre-phase-B flat slice (model fields at the top level) is refused up front,
    # instead of as a 422 on every window of every step.
    flat = tmp_path / "flat.json"
    flat.write_text(json.dumps({"runtimeKey": "k", "slug": "x", "format": "SAFETENSOR"}))
    with pytest.raises(bench.BenchInputError, match="models.asr"):
        bench.load_spec(flat)

    for body in ("[]", '{"models": {"asr": {}}}', "not json"):
        bad = tmp_path / "bad.json"
        bad.write_text(body)
        with pytest.raises(bench.BenchInputError):
            bench.load_spec(bad)


# ── OD-12: --agent-slug resolves the spec through the gateway's ASR resolver ──


async def test_agent_slug_fetches_the_gateway_resolved_spec(bench) -> None:  # type: ignore[no-untyped-def]
    from hope_vllm.tests.conftest import spec_payload

    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        return httpx.Response(200, json=spec_payload())

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        spec = await bench.fetch_spec(
            client,
            gateway_url="http://gw:8868/api/v1/",
            agent_slug="realtime-transcription-vllm-spike",
            tenant_id="50000000-0000-0000-0000-000000000000",
            token="tok",
        )
    assert spec["runtimeKey"] == "agent-version-0001"
    url = httpx.URL(seen["url"])
    assert url.path == "/api/v1/internal/agents/asr-spec"
    assert url.params["service"] == "vllm"
    assert url.params["agentSlug"] == "realtime-transcription-vllm-spike"
    assert seen["headers"]["x-service-token"] == "tok"
    assert seen["headers"]["x-tenant-id"] == "50000000-0000-0000-0000-000000000000"


async def test_agent_slug_refuses_a_gateway_error_or_a_non_spec(bench) -> None:  # type: ignore[no-untyped-def]
    for response in (
        httpx.Response(503, json={"code": "AGENT_NOT_ASSIGNED"}),
        httpx.Response(200, json={"models": []}),
    ):
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _r, r=response: r)
        ) as client:
            with pytest.raises(bench.BenchInputError):
                await bench.fetch_spec(
                    client,
                    gateway_url="http://gw/api/v1",
                    agent_slug="a",
                    tenant_id="t",
                    token="tok",
                )
