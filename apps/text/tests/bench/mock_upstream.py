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

AC-3 instrumentation: this process is the "provider" half of "first byte
received FROM the mock provider vs first byte forwarded TO the client". It
timestamps its OWN first-byte-write with `time.monotonic()` and exposes the
per-request timings at `GET /__bench__/timings` for the harness to correlate
against its own client-observed timestamps — see `harness.py`. Correlation
key: a `[[bench:<uuid>]]` marker the harness embeds in the prompt text, which
survives the wire unmodified because a provider's message content is never
inspected or rewritten anywhere upstream — extracted here from the LAST
message's content.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

_BENCH_ID_RE = re.compile(r"\[\[bench:([0-9a-fA-F-]{36})\]\]")


@dataclass
class MockConfig:
    ttft_ms: float
    token_interval_ms: float
    token_count: int
    port: int

    @classmethod
    def from_env(cls) -> MockConfig:
        return cls(
            ttft_ms=float(os.environ.get("BENCH_MOCK_TTFT_MS", "0")),
            token_interval_ms=float(os.environ.get("BENCH_MOCK_TOKEN_INTERVAL_MS", "0")),
            token_count=int(os.environ.get("BENCH_MOCK_TOKEN_COUNT", "40")),
            port=int(os.environ.get("BENCH_MOCK_PORT", "8899")),
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
    app = FastAPI(title="bench-mock-upstream")
    app.state.config = cfg
    app.state.timings = timings

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/__bench__/timings")
    async def get_timings() -> dict[str, dict[str, float | None]]:
        return timings.snapshot()

    @app.post("/__bench__/reset")
    async def reset_timings() -> dict[str, str]:
        timings.reset()
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
    uvicorn.run(create_app(cfg), host="127.0.0.1", port=cfg.port, log_level="warning")
