"""OpenAI-compatible mock upstream for the Lane H benchmark harness.

README §4.8 / TASK-818 H-1: "Mock the upstream, but publish both numbers."
Serves the exact wire shape `apps/text`'s real `openai_compat` provider
(`src/text/providers/openai_compat.py`) already speaks to (it builds requests
with the official `openai` SDK's `AsyncOpenAI(base_url=...)`), so pointing
Text at this process requires ZERO production-code changes — only a
`provider_overrides` entry naming this process's `base_url`.

Two modes, selected by env vars (never hardcoded — a benchmark script is not
exempt from "config, not a literal", it just has different callers than the
service it measures):

- ``BENCH_MOCK_TTFT_MS`` (default ``0``)              — delay before the
  first token/response byte. ``0`` = zero-latency mode (isolates proxy
  overhead). ``800`` = the README's latency-injecting mode.
- ``BENCH_MOCK_TOKEN_INTERVAL_MS`` (default ``0``)    — delay between
  subsequent streamed tokens. README's latency-injecting mode uses ~33ms
  (≈30 tok/s).
- ``BENCH_MOCK_TOKEN_COUNT`` (default ``40``)         — synthetic tokens per
  completion.
- ``BENCH_MOCK_PORT`` (default ``8899``)              — listen port.
- ``BENCH_MOCK_TLS`` (default ``0``)                  — serve HTTPS with a
  self-signed cert generated at start-up (see "TLS mode" below) instead of
  plain HTTP.
- ``BENCH_MOCK_TLS_CERT_DIR`` (default: a fresh ``tempfile.mkdtemp()``) —
  where to write/read the generated cert+key. `harness.py` sets this so it
  can also point the real `apps/text` process's ``SSL_CERT_FILE`` at the same
  file — see `harness.py`'s module docstring for the trust story.

AC-3 instrumentation: this process is the "provider" half of "first byte
received FROM the mock provider vs first byte forwarded TO the client". It
timestamps its OWN first-byte-write with `time.monotonic()` and exposes the
per-request timings at `GET /__bench__/timings` for the harness to correlate
against its own client-observed timestamps — see `harness.py`. Correlation
key: a `[[bench:<uuid>]]` marker the harness embeds in the prompt text, which
survives the wire unmodified because a provider's message content is never
inspected or rewritten anywhere upstream — extracted here from the LAST
message's content.

## TLS mode — why it exists and what it does NOT prove

`docs/implementation/TASK-818-Text-LLM-Router/baseline.md` ("Harness gap to
close"): Lane A's pooled egress-client cache is supposed to save TLS
handshakes, DNS and connection setup, and this mock was plain HTTP on
loopback — nothing for connection reuse to save, so the harness could not
observe the thing Lane A fixed. ``BENCH_MOCK_TLS=1`` closes that gap: a
self-signed cert is generated fresh into a temp dir at start-up (NEVER
committed — see `ensure_self_signed_cert`), and uvicorn serves over it.

This still measures ONE machine talking to itself over loopback TLS — a real
handshake with real asymmetric crypto, but zero network RTT and zero DNS
lookup. It narrows the harness's blind spot; it does not eliminate every gap
between this bench and a real Azure/Bedrock endpoint over the public
internet.

## Connection-count instrumentation

`GET /__bench__/connections` exposes how many NEW connections (TCP handshake
complete, and — in TLS mode — TLS handshake complete, since
`asyncio`'s `SSLProtocol` withholds the app-level `connection_made` callback
until the handshake finishes) this process has accepted since the last
`POST /__bench__/reset`. This is `harness.py --connections-per-request`'s
data source: comparing it against the request count at the same concurrency
level proves or disproves connection reuse directly, independent of latency
noise. Counting hooks `connection_made` on uvicorn's HTTP protocol classes
(`h11`/`httptools`, whichever uvicorn selects) rather than the ASGI app layer,
because keep-alive means many requests legitimately share one connection —
the ASGI layer sees one call per request, not per connection.
"""

from __future__ import annotations

import asyncio
import datetime
import ipaddress
import os
import re
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

_BENCH_ID_RE = re.compile(r"\[\[bench:([0-9a-fA-F-]{36})\]\]")

#: Filenames the generated cert/key are written under. Shared with
#: `harness.py` (imported from here) so both processes agree on the path
#: without either hardcoding the other's layout.
TLS_CERT_FILENAME = "bench-mock-cert.pem"
TLS_KEY_FILENAME = "bench-mock-key.pem"


@dataclass
class MockConfig:
    ttft_ms: float
    token_interval_ms: float
    token_count: int
    port: int
    tls: bool
    tls_cert_dir: str | None

    @classmethod
    def from_env(cls) -> MockConfig:
        return cls(
            ttft_ms=float(os.environ.get("BENCH_MOCK_TTFT_MS", "0")),
            token_interval_ms=float(os.environ.get("BENCH_MOCK_TOKEN_INTERVAL_MS", "0")),
            token_count=int(os.environ.get("BENCH_MOCK_TOKEN_COUNT", "40")),
            port=int(os.environ.get("BENCH_MOCK_PORT", "8899")),
            tls=os.environ.get("BENCH_MOCK_TLS", "0") == "1",
            tls_cert_dir=os.environ.get("BENCH_MOCK_TLS_CERT_DIR") or None,
        )


@dataclass
class Timing:
    received_ts: float
    first_byte_ts: float | None = None
    last_byte_ts: float | None = None


@dataclass
class TimingStore:
    """In-memory, single-process timing log keyed by bench request id.

    Deliberately unbounded-but-small: a benchmark run resets this between
    phases via ``POST /__bench__/reset`` and a single sweep is at most a few
    thousand requests.
    """

    _entries: dict[str, Timing] = field(default_factory=dict)

    def start(self, bench_id: str) -> None:
        self._entries[bench_id] = Timing(received_ts=time.monotonic())

    def first_byte(self, bench_id: str) -> None:
        entry = self._entries.get(bench_id)
        if entry is not None and entry.first_byte_ts is None:
            entry.first_byte_ts = time.monotonic()

    def last_byte(self, bench_id: str) -> None:
        entry = self._entries.get(bench_id)
        if entry is not None:
            entry.last_byte_ts = time.monotonic()

    def snapshot(self) -> dict[str, dict[str, float | None]]:
        return {
            bench_id: {
                "received_ts": t.received_ts,
                "first_byte_ts": t.first_byte_ts,
                "last_byte_ts": t.last_byte_ts,
            }
            for bench_id, t in self._entries.items()
        }

    def reset(self) -> None:
        self._entries.clear()


@dataclass
class ConnectionCounter:
    """How many NEW connections this process has accepted since the last reset.

    Backs `GET /__bench__/connections` — the `--connections-per-request`
    diagnostic's data source (module docstring, "Connection-count
    instrumentation"). One counter per `create_app()` call, exactly like
    `TimingStore`.
    """

    _count: int = 0

    def increment(self) -> None:
        self._count += 1

    @property
    def count(self) -> int:
        return self._count

    def reset(self) -> None:
        self._count = 0


class _ActiveCounterHolder:
    """The one counter `connection_made` should notify right now.

    A module-level indirection rather than a closure captured at patch time:
    `_install_connection_counting()` patches the protocol CLASSES exactly
    once per process (guarded below), while `create_app()` may run more than
    once in-process (tests). Re-pointing this holder is how a later
    `create_app()` call keeps counting to the right place without patching
    twice.
    """

    counter: ConnectionCounter | None = None


_active_counter = _ActiveCounterHolder()


def _install_connection_counting() -> None:
    """Patch uvicorn's HTTP protocol classes to notify `_active_counter`.

    Hooked at `connection_made`, not the ASGI app layer: keep-alive means many
    requests legitimately share one connection, so the ASGI layer sees one
    call per REQUEST, never one per connection. `connection_made` fires
    exactly once per accepted connection — and, for a TLS listener,
    `asyncio`'s `SSLProtocol` withholds it until the handshake completes, so
    the same hook counts "new TCP connection" in plain-HTTP mode and
    "new TCP+TLS connection" in TLS mode without the caller needing to know
    which.

    Patches BOTH shipped protocol implementations (`h11` and `httptools`)
    because uvicorn's default `http="auto"` picks whichever is installed —
    this process must count correctly either way. Idempotent: a second call
    (e.g. two `create_app()`s in one test session) does not double-patch.
    """
    from uvicorn.protocols.http.h11_impl import H11Protocol
    from uvicorn.protocols.http.httptools_impl import HttpToolsProtocol

    for protocol_cls in (H11Protocol, HttpToolsProtocol):
        if getattr(protocol_cls, "_bench_original_connection_made", None) is not None:
            continue
        original = protocol_cls.connection_made
        protocol_cls._bench_original_connection_made = original

        def _patched(self: Any, transport: Any, _original: Any = original) -> None:
            if _active_counter.counter is not None:
                _active_counter.counter.increment()
            return _original(self, transport)

        protocol_cls.connection_made = _patched  # type: ignore[method-assign]


def ensure_self_signed_cert(cert_dir: Path) -> tuple[Path, Path]:
    """Generate (or reuse) a self-signed cert+key for 127.0.0.1 in `cert_dir`.

    **Benchmark affordance only — never a production pattern.** Generated
    fresh into a temp directory at process start-up and never committed to
    git; the trust story that makes the REAL `apps/text` process accept it is
    ``SSL_CERT_FILE`` (see `harness.py`'s module docstring), which is a
    process-wide "trust this one extra CA" override with no place in any real
    deployment config.

    Idempotent so a standalone re-run against the same `cert_dir` (or two
    processes racing on one, though nothing here does that) reuses the file
    rather than rotating it out from under a running listener.
    """
    cert_path = cert_dir / TLS_CERT_FILENAME
    key_path = cert_dir / TLS_KEY_FILENAME
    if cert_path.exists() and key_path.exists():
        return cert_path, key_path

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    cert_dir.mkdir(parents=True, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")])
    now = datetime.datetime.now(datetime.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    return cert_path, key_path


def _extract_bench_id(body: dict[str, Any]) -> str | None:
    messages = body.get("messages") or []
    for message in reversed(messages):
        content = message.get("content")
        if isinstance(content, str):
            match = _BENCH_ID_RE.search(content)
            if match:
                return match.group(1)
        elif isinstance(content, list):
            for part in content:
                text = part.get("text") if isinstance(part, dict) else None
                if isinstance(text, str):
                    match = _BENCH_ID_RE.search(text)
                    if match:
                        return match.group(1)
    return None


def _chunk_payload(
    *, model: str, delta: dict[str, Any], finish_reason: str | None, chunk_id: str
) -> dict[str, Any]:
    return {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason, "logprobs": None}],
    }


def _usage_only_chunk(*, model: str, chunk_id: str, usage: dict[str, int]) -> dict[str, Any]:
    return {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [],
        "usage": usage,
    }


def create_app(config: MockConfig | None = None) -> FastAPI:
    cfg = config or MockConfig.from_env()
    timings = TimingStore()
    connections = ConnectionCounter()
    _install_connection_counting()
    _active_counter.counter = connections
    app = FastAPI(title="bench-mock-upstream")
    app.state.config = cfg
    app.state.timings = timings
    app.state.connections = connections

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/__bench__/timings")
    async def get_timings() -> dict[str, dict[str, float | None]]:
        return timings.snapshot()

    @app.get("/__bench__/connections")
    async def get_connections() -> dict[str, int]:
        return {"new_connections": connections.count}

    @app.post("/__bench__/reset")
    async def reset_timings() -> dict[str, str]:
        timings.reset()
        connections.reset()
        return {"status": "reset"}

    @app.post("/v1/chat/completions")
    async def chat_completions(request: Request) -> Any:
        body = await request.json()
        model = body.get("model") or "mock-model"
        stream = bool(body.get("stream", False))
        bench_id = _extract_bench_id(body)
        chunk_id = f"bench-{bench_id or 'unknown'}"

        if bench_id is not None:
            timings.start(bench_id)

        prompt_tokens = 10
        completion_tokens = cfg.token_count
        usage = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        }

        if not stream:
            if cfg.ttft_ms > 0:
                await asyncio.sleep(cfg.ttft_ms / 1000)
            content = " ".join(f"token{i}" for i in range(cfg.token_count))
            if bench_id is not None:
                timings.first_byte(bench_id)
                timings.last_byte(bench_id)
            return JSONResponse(
                {
                    "id": chunk_id,
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": content},
                            "finish_reason": "stop",
                            "logprobs": None,
                        }
                    ],
                    "usage": usage,
                }
            )

        include_usage = bool((body.get("stream_options") or {}).get("include_usage"))

        async def event_stream():
            if cfg.ttft_ms > 0:
                await asyncio.sleep(cfg.ttft_ms / 1000)
            if bench_id is not None:
                timings.first_byte(bench_id)
            for i in range(cfg.token_count):
                if i > 0 and cfg.token_interval_ms > 0:
                    await asyncio.sleep(cfg.token_interval_ms / 1000)
                payload = _chunk_payload(
                    model=model,
                    delta={"content": f"token{i} "},
                    finish_reason=None,
                    chunk_id=chunk_id,
                )
                yield f"data: {_dumps(payload)}\n\n"
            yield (
                f"data: "
                f"{_dumps(_chunk_payload(model=model, delta={}, finish_reason='stop', chunk_id=chunk_id))}"
                "\n\n"
            )
            if include_usage:
                yield f"data: {_dumps(_usage_only_chunk(model=model, chunk_id=chunk_id, usage=usage))}\n\n"
            yield "data: [DONE]\n\n"
            if bench_id is not None:
                timings.last_byte(bench_id)

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app


def _dumps(payload: dict[str, Any]) -> str:
    import orjson

    return orjson.dumps(payload).decode()


if __name__ == "__main__":
    cfg = MockConfig.from_env()
    app = create_app(cfg)
    tls_kwargs: dict[str, str] = {}
    if cfg.tls:
        cert_dir = Path(cfg.tls_cert_dir or tempfile.mkdtemp(prefix="bench-mock-tls-"))
        cert_path, key_path = ensure_self_signed_cert(cert_dir)
        tls_kwargs = {"ssl_certfile": str(cert_path), "ssl_keyfile": str(key_path)}
    uvicorn.run(app, host="127.0.0.1", port=cfg.port, log_level="warning", **tls_kwargs)
