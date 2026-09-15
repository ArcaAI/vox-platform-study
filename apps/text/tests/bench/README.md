# Text bench harness — standalone latency/RSS benchmarking for apps/text

A self-contained benchmark harness for `apps/text`: it stands up its own two
subprocesses (a mock upstream LLM and a real, unmodified `text` app), drives
load against them, and reports p50/p95/p99 latency and RSS. It is **not**
`tests/load/` (Locust resilience/correctness smoke tests against a live,
manually-started stack) — this harness needs no external infrastructure at
all.

## Layout

| Path | What it holds |
|---|---|
| `harness.py` | Drives the benchmark: spawns both subprocesses, sweeps concurrency levels, prints/writes the report |
| `mock_upstream.py` | A real OpenAI-compatible `/v1/chat/completions` server (streaming + non-streaming), zero-latency or latency-injecting |
| `text_service_process.py` | Boots the real, unmodified `text.main.create_app()` with `fakeredis` in place of Redis — no live Redis, Postgres or gateway needed |
| `stats.py` | Percentile computation (nearest-rank, no numpy) — has its own unit tests |
| `test_mock_upstream.py`, `test_stats.py` | Unit tests for the two modules above |

## Commands

Run from `apps/text/`:

```bash
# Quick smoke sweep — checks the harness still works / eyeballs the shape:
uv run --extra test python tests/bench/harness.py \
  --mode zero-latency --levels 10,25,50 --duration 5

uv run --extra test python tests/bench/harness.py \
  --mode latency-injecting --levels 10,25,50 --duration 8 --tokens 20

# Non-streaming path (AC-7):
uv run --extra test python tests/bench/harness.py \
  --mode zero-latency --levels 10,50 --duration 5 --no-stream

# The real soak (>=100 concurrent streams, 10 minutes):
uv run --extra test python tests/bench/harness.py \
  --mode latency-injecting --levels 100 --duration 600 --out ac1-soak.json

# TLS mode (real HTTPS handshake, self-signed cert, connection-reuse counting):
uv run --extra test python tests/bench/harness.py \
  --mode zero-latency --levels 10,25 --duration 4 --warmup 5 \
  --tls --connections-per-request
```

A 5-second smoke sweep only proves the harness runs; a `--duration 600`
soak is the actual bar for a sustained-load claim — do not conflate the two.

### CLI flags

| Flag | Default | Meaning |
|---|---|---|
| `--mode` | `zero-latency` | `zero-latency` or `latency-injecting` |
| `--levels` | `10,25,50,100` | Comma-separated concurrency levels to sweep |
| `--duration` | `5` | Seconds to sustain **each** level |
| `--tokens` | `40` | Synthetic tokens per completion |
| `--warmup` | `20` | Throwaway requests before the first measured level |
| `--no-stream` | off | Exercise `stream=false` instead |
| `--model` | `mock-model` | Model name sent on the wire (the mock ignores it) |
| `--tls` | off | Serve the mock over HTTPS with a self-signed cert |
| `--connections-per-request` | off | Report new-connection count vs. request count per level |
| `--out PATH` | none | Also write the full report as JSON |

## How it works

```
harness.py (this process)
  |
  +- spawns mock_upstream.py  --(real OpenAI-compatible HTTP)--+
  |    (subprocess, own port)                                  v
  +- spawns text_service_process.py            provider_overrides.base_url
       (subprocess, own port,               points the REAL openai_compat
        real text.main.create_app(),         adapter at the mock -- zero
        fakeredis in place of Redis)          production-code changes
```

- **`mock_upstream.py`** has two modes selected by env vars: `zero-latency`
  (`BENCH_MOCK_TTFT_MS=0`) isolates proxy overhead; `latency-injecting`
  (`BENCH_MOCK_TTFT_MS=800`, `BENCH_MOCK_TOKEN_INTERVAL_MS=33`, ~30 tok/s) is
  the mode that exposes connection-pool exhaustion — publishing only
  zero-latency numbers is the dominant benchmarking failure mode this harness
  is built to avoid. It timestamps its own first-byte-write and exposes
  `GET /__bench__/timings` for correlation.

- **`text_service_process.py`** substitutes ONLY `app.state.redis =
  fakeredis.aioredis.FakeRedis()`, set before uvicorn's lifespan runs, at the
  same extension point `main.py`'s lifespan already documents. The guardrail
  gate floors to disabled when the control-plane pull is unreachable, and the
  effective-config pull / self-registration are both fire-and-forget by
  design, so nothing else needs to be live.

- **`harness.py`** drives requests through the current wire contract:
  `POST /api/v1/generate` with `stream=true` returns `202 {task_id}`, then
  `GET /api/v1/tasks/{task_id}/stream` delivers the SSE. If that contract
  changes to `200 + SSE` immediately, only `run_one()`'s streaming branch
  needs to change.

### Cross-process timing

AC-3's delta is `client_first_byte_ts (harness process) -
provider_first_byte_ts (mock process)`, both `time.monotonic()`. On POSIX
that clock is boot-relative, not process-relative, so two processes on the
**same machine** read comparable values. **This does not hold across two
different physical hosts** — both subprocesses this harness starts always run
on the machine that runs `harness.py`.

### Why no `psutil` / no live Redis

RSS is sampled by shelling out to `ps -o rss= -p <pid>` rather than adding a
`psutil` dependency to the shared `apps/text/pyproject.toml`/`uv.lock`. Redis
is `fakeredis[lua]` (already an `apps/text` `test` extra) rather than a
throwaway `redis-server` process, for the same reason: this harness does not
own `uv lock` or infra bring-up.

### TLS mode (`--tls`, `--connections-per-request`)

The mock upstream is plain HTTP on loopback by default — no TLS, no DNS,
negligible TCP setup — so there is nothing for connection reuse to save and
no way to tell whether `apps/text`'s pooled egress-client cache
(`providers/clients.py`) helps at all. `--tls` makes `mock_upstream.py`
generate a self-signed cert fresh into a temp directory at process start-up
(never committed to git; a new one every run) and serve HTTPS, and starts
`text_service_process.py` with `SSL_CERT_FILE` pointed at that one cert file
— exactly the way an `AiProviderConnection` row's `base_url` would look in
production, with zero changes to `apps/text/src/**`.

**The trust story.** Both transport libraries behind every adapter in
`apps/text` (`httpx`, `httpx2`) check `SSL_CERT_FILE` and, if set, trust
*only* that one file instead of their normal certifi/system trust store. That
lever is process-wide and has no place in any deployment config —
`SSL_CERT_FILE` is never set outside `harness.py`'s own `start_text()` call,
is never written to `.env.*`, and must never be proposed as "how to trust an
internal CA in production" (that is a Vault/system-trust-store problem).

`--connections-per-request` asks the mock, per concurrency level, how many
NEW connections it accepted (`GET /__bench__/connections`) versus how many
requests it served. The counter hooks uvicorn's `connection_made` callback
(both `h11` and `httptools`), not the ASGI layer — HTTP keep-alive means many
requests legitimately share one connection, and the ASGI layer sees one call
per request regardless, so it cannot answer this question at all. A
`conn/req` ratio near `1.0` means no reuse; well under `1.0` means reuse is
working.

### `--warmup`

The first requests into a freshly-started process pay one-time costs
(lazily-imported provider adapter classes, SDK client construction, CPython
import/bytecode warm-up) that must not be attributed to "proxy overhead".
`--warmup` runs and discards that cost before the first measured level. Even
with warm-up, the RSS numbers at the very first swept concurrency level run
noisier than later levels — `ps`'s RSS is a high-water mark, not a live-set
size — so prefer the trend across levels over any single level's number.

### Interpreting a report
```
--- concurrency=25 (ran 4.7s) ---
  requests=98 errors=0
  client TTFT      : p50=462.20ms p95=1047.42ms p99=1141.60ms (n=98)
  provider TTFT    : p50=0.21ms p95=1.86ms p99=4.20ms (n=98)
  AC-3 proxy delta : p50=115.71ms p95=337.39ms p99=694.97ms (n=98)  <- judged number
  AC-4 inter-token : p50=7.12ms p95=50.70ms p99=97.21ms (n=4018)
  total latency    : p50=1106.18ms p95=1690.69ms p99=1778.65ms (n=98)
  AC-2 RSS/stream  : 154.24 KB (baseline=179120KB plateau=182976KB)
```

Both `client TTFT` and `provider TTFT` are always printed alongside the
delta. In `zero-latency` mode, provider TTFT is sub-millisecond, so `client
TTFT` approximates the proxy overhead itself. In `latency-injecting` mode,
provider TTFT dominates (~800ms) and the AC-3 delta shrinks to
single-digit-to-low-double-digit milliseconds — the expected shape, since it
demonstrates the harness measures the proxy's added cost, not the mock's
configured delay. `AC-4 inter-token`'s `n` is the total chunk-to-chunk gap
count across every successful request at that level, so it is far larger
than `requests`.

## Gotchas

- A run against `--tls` with `--connections-per-request` at every tested
  concurrency (including `1`, with zero contention) has previously shown a
  `1.000 conn/req` ratio through the real `apps/text` request path — i.e. a
  brand-new connection on every single generation call — even though calling
  `providers.clients.CLIENT_CACHE.get_or_create()` and
  `providers.pool.pooled_http_client()` directly, by hand, correctly returns
  the same cached client and pooled transport every time. This means the
  caching primitives work in isolation but something between an incoming
  generation request and the cached client was not resulting in reuse
  end-to-end. Re-run `--tls --connections-per-request` after any change to
  the request path and compare against `1.000` before trusting a "the cache
  helps" claim.
- There is no env-var kill switch for the client cache, so a true
  with-cache-vs-without-cache A/B comparison under `--tls` is not possible
  without editing `apps/text/src/**` (outside this directory's ownership).
- This harness's own smoke-run numbers are internal self-consistency checks,
  not a substitute for a real 10-minute AC-1 soak at the declared concurrency.

## Related

- [`06-python-services.md`](../../../../.claude/rules/06-python-services.md) — service conventions this harness exercises without modifying
- [`../load/README.md`](../load/README.md) — the Locust-based resilience/load suite (different purpose, needs a live stack)
- [`../../README.md`](../../README.md) — the service this harness benchmarks
