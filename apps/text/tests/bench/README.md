# TEXT Benchmark Harness (Lane H, TASK-818)

Measures `apps/text` honestly, per
`docs/implementation/TASK-818-Text-LLM-Router/README.md` §4.8 ("Benchmarking
honestly") and §5 (the AC table). This is **not** `tests/load/` (Locust
resilience/correctness smoke tests against a live, manually-started stack) —
this harness stands up its own two processes, drives them itself, and reports
percentiles.

## What it measures

| AC | What | How |
|---|---|---|
| AC-3 | Proxy-added TTFT (client first byte − provider first byte), p50/p95/p99 | The `AC-3 proxy delta` line in the printed report — **the number this ticket is judged on** |
| AC-2 | Steady-state RSS per active stream | `AC-2 RSS/stream` line, `ps -o rss=` sampled every 250ms on the real `text-service` subprocess |
| AC-4 | Proxy-added inter-token latency | `AC-4 inter-token` line (gaps between consecutive SSE chunk arrivals at the client) |
| AC-7 | Non-streaming added latency / RPS | `--no-stream` mode; `total latency` line + `requests` count over the run duration |
| AC-1 | ≥100 concurrent streams sustained 10 min, zero drops | `--levels 100 --duration 600` (see "Running the real AC-1 soak" below) |

Every report leads with **p50/p95/p99, never a bare average** (README §4.8),
and always prints both the client-observed number and the provider-observed
number the delta was computed from — never the delta alone.

## Architecture

```
harness.py (this process)
  │
  ├─ spawns mock_upstream.py  ──(real OpenAI-compatible HTTP)──┐
  │    (subprocess, own port)                                  │
  │                                                             ▼
  └─ spawns text_service_process.py            provider_overrides.base_url
       (subprocess, own port,               points the REAL openai_compat
        real `text.main.create_app()`,       adapter at the mock — zero
        fakeredis in place of Redis)         production-code changes
```

- **`mock_upstream.py`** — a real OpenAI-compatible `/v1/chat/completions`
  server (streaming + non-streaming), in two modes selected by env vars:
  - `zero-latency` (`BENCH_MOCK_TTFT_MS=0`) — isolates proxy overhead.
  - `latency-injecting` (`BENCH_MOCK_TTFT_MS=800`,
    `BENCH_MOCK_TOKEN_INTERVAL_MS=33` ≈ 30 tok/s) — the mode that exposes
    connection-pool exhaustion; README §4.8 calls "publishing only
    zero-latency numbers" the dominant 2026 methodological failure.
  It timestamps its own first-byte-write with `time.monotonic()` and exposes
  `GET /__bench__/timings` for correlation.

- **`text_service_process.py`** — imports the real, **unmodified**
  `text.main.create_app`. The only substitution is `app.state.redis =
  fakeredis.aioredis.FakeRedis()`, set BEFORE uvicorn's lifespan runs, using
  the exact extension point `main.py`'s lifespan already documents
  (`if not hasattr(app.state, "redis") or app.state.redis is None: ... else:
  redis_client = app.state.redis`). This is the same pattern
  `src/text/tests/integration/conftest.py` already uses for its `app`
  fixture — not a Lane-H invention. **No live Redis, Postgres, or gateway is
  required** to run this harness: the guardrail gate floors to disabled
  (`GUARDRAIL_ENABLED_FLOOR = False`) when the control-plane pull is
  unreachable, and the effective-config pull / self-registration are both
  fire-and-forget by design.

- **`harness.py`** — drives requests through the CURRENT contract (this
  runs *before* Lane B's rewrite lands): `POST /api/v1/generate` with
  `stream=true` returns `202 {task_id}`, then `GET
  /api/v1/tasks/{task_id}/stream` delivers the SSE. Once Lane B ships
  `POST /generate` returning `200 + SSE` immediately, only `run_one()` in
  `harness.py` needs to change — the mock and the process-launch machinery
  are unaffected (S-3 in the EXECUTION-PLAN: the wire contracts are frozen
  seams this harness consumes, not something it re-derives).

- **`stats.py`** — the one place a percentile is computed (nearest-rank
  method, no numpy dependency). Has its own unit tests (`test_stats.py`).

### Cross-process timing (read before trusting AC-3 numbers on a new machine)

AC-3's delta is `client_first_byte_ts (harness process) −
provider_first_byte_ts (mock process)`, both `time.monotonic()`. On POSIX
(Linux `CLOCK_MONOTONIC`, macOS `mach_absolute_time`) that clock is
boot-relative, not process-relative, so two processes on the **same machine**
read comparable values — verified empirically in this environment (see the
ticket report for the measurement). **This does not hold across two
different physical hosts.** Both processes this harness starts always run on
the machine that runs `harness.py`.

## Why no `psutil` / no live Redis

- **RSS** is sampled by shelling out to `ps -o rss= -p <pid>` instead of
  adding a `psutil` dependency. `apps/text/pyproject.toml` and the root
  `uv.lock` are shared surfaces this lane does not own (EXECUTION-PLAN §4:
  `uv lock` is orchestrator-only) — `ps` is already on the machine and is
  POSIX-portable.
- **Redis** is `fakeredis[lua]` (already an `apps/text` `test` extra), not a
  throwaway `redis-server` process, for the same reason: standing up
  infrastructure — even a scratch instance — is listed as an orchestrator
  surface (`infra:*` / Docker), and `fakeredis` already implements the
  Streams commands (`XADD`/`XREAD`) `TaskManager` needs.

## Running it

From `apps/text/`:

```bash
# Quick smoke sweep (a few seconds per level) — what you'd run to check the
# harness itself still works, or to eyeball the shape of the numbers:
uv run --extra test python tests/bench/harness.py \
  --mode zero-latency --levels 10,25,50 --duration 5

uv run --extra test python tests/bench/harness.py \
  --mode latency-injecting --levels 10,25,50 --duration 8 --tokens 20

# Non-streaming path (AC-7):
uv run --extra test python tests/bench/harness.py \
  --mode zero-latency --levels 10,50 --duration 5 --no-stream
```

### Running the real AC-1 soak (≥100 concurrent streams, 10 minutes)

```bash
uv run --extra test python tests/bench/harness.py \
  --mode latency-injecting --levels 100 --duration 600 --out ac1-soak.json
```

This is a **10+ minute run by design** (AC-1's actual bar) — do not treat a
5-second smoke sweep as satisfying AC-1; it only proves the harness runs.
`--out` writes the full per-level breakdown as JSON alongside the printed
report.

## TLS mode (`--tls`, `--connections-per-request`)

**Why this exists.** Lane A added a pooled, credential-keyed egress-client
cache to `apps/text` (`providers/clients.py`), whose entire value proposition
is avoiding a TLS handshake, DNS lookup and connection setup on every
outbound call. The mock upstream above is plain HTTP on loopback — no TLS, no
DNS, negligible TCP setup — so there was **nothing for connection reuse to
save**, and the harness could not tell whether the cache helped at all. See
`docs/implementation/TASK-818-Text-LLM-Router/baseline.md`, "After Lane A" /
"Harness gap to close before the next measurement" for the exact finding this
closes.

```bash
uv run --extra test python tests/bench/harness.py \
  --mode zero-latency --levels 10,25 --duration 4 --warmup 5 \
  --tls --connections-per-request
```

`--tls` makes `mock_upstream.py` generate a **self-signed cert fresh into a
temp directory at process start-up** (`ensure_self_signed_cert` — never
committed to git; a new one every run) and serve HTTPS instead of HTTP. It
also starts `text_service_process.py` — the same real, unmodified
`text.main.create_app()` this harness always uses — with `SSL_CERT_FILE`
pointed at that one cert file, so `provider_overrides.<provider>.base_url`
can be `https://127.0.0.1:<port>` exactly the way an `AiProviderConnection`
row's `base_url` would be in production, with **zero changes to
`apps/text/src/**`**.

**The trust story — read this before assuming any of it generalizes to
production.** `httpx` and `httpx2` (the transport libraries behind, between
them, every adapter in `apps/text` — see `providers/pool.py`'s module
docstring) both check the `SSL_CERT_FILE` environment variable and, if set,
trust ONLY that one file instead of their normal certifi/system trust store
(verified against the installed `httpx==0.28.1` and `httpx2==2.10.0`
`create_ssl_context()` — both read `os.environ["SSL_CERT_FILE"]` before
falling back to their default). That is exactly the lever this harness pulls,
and exactly why it must never be pulled anywhere else:

- It is **process-wide**. Every TLS connection that process makes — including
  a real Azure/Bedrock/vendor call, if one somehow existed in the same
  process — would be checked against this one file instead of the public CA
  set.
- It has **no place in any deployment config**. It exists only because this
  harness fully owns a disposable subprocess for the duration of one run and
  tears it down afterwards. `SSL_CERT_FILE` is never set outside
  `harness.py`'s own `start_text()` call, is never written to `.env.*`, and
  must never be proposed as a "how to trust an internal CA in production"
  answer — that is a Vault/system-trust-store problem, not an env var.

This narrows the harness's blind spot — a real TLS handshake with real
asymmetric crypto now happens on every egress call — but it does not erase
every gap to a real endpoint on the public internet: this is still loopback
(zero network RTT, zero DNS lookup, one physical host).

**`--connections-per-request`** asks the mock directly, per concurrency
level, how many NEW connections it accepted (`GET /__bench__/connections`,
reset alongside timings at the top of each level) versus how many requests it
served. This is the number latency alone cannot give you: AC-3's p50/p95/p99
deltas are only a few tens of milliseconds wide — the same order of magnitude
the client cache is trying to save — so a real win or a null result can both
hide inside that noise. A `conn/req` ratio near `1.0` means every request
opened a new connection (no reuse); a ratio well under `1.0` means many
requests shared few connections (reuse is working). The counter hooks
uvicorn's `connection_made` callback (both `h11` and `httptools` protocol
implementations), not the ASGI app layer, specifically because HTTP
keep-alive means many requests legitimately share one connection — the ASGI
layer sees one call per request, never one per connection, so it cannot
answer this question at all.

### CLI flags

| Flag | Default | Meaning |
|---|---|---|
| `--mode` | `zero-latency` | `zero-latency` or `latency-injecting` (§4.8) |
| `--levels` | `10,25,50,100` | Comma-separated concurrency levels to sweep |
| `--duration` | `5` | Seconds to sustain **each** level (set to `600` for the real AC-1 bar) |
| `--tokens` | `40` | Synthetic tokens per completion |
| `--warmup` | `20` | Throwaway requests before the first measured level — see below |
| `--no-stream` | off | Exercise `stream=false` instead (AC-7) |
| `--model` | `mock-model` | Model name sent on the wire (the mock ignores it) |
| `--tls` | off | Serve the mock over HTTPS with a self-signed cert; see "TLS mode" below |
| `--connections-per-request` | off | Report new-connection count vs. request count per level; see "TLS mode" below |
| `--out PATH` | none | Also write the full report as JSON |

### Why `--warmup` exists, and why level 1's numbers are still the noisiest

The first requests into a freshly-started process pay one-time costs a
benchmark must not attribute to "proxy overhead": provider adapter classes
imported lazily on first use (`main.py::_register_provider_factories`'s own
docstring), the OpenAI SDK's client construction, and CPython's own
import/bytecode warm-up. `--warmup` runs (and discards) that cost before the
first measured level.

Even with warm-up, **the RSS numbers at the very first swept concurrency
level run noisier than later levels** — `ps`'s RSS is a *high-water mark*,
not a live-set size, so a process that has not yet been pushed to a given
concurrency will show a larger apparent per-stream delta at that level than
it will once the allocator has stabilized. Prefer the trend across levels
(does RSS/stream keep shrinking, or plateau?) over any single level's number,
and raise `--warmup` if level 1 still looks like an outlier.

## Interpreting a report

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

- **`client TTFT`** and **`provider TTFT`** are always printed alongside the
  delta (README §4.6: "report both absolute numbers, never just the delta").
- In `zero-latency` mode, provider TTFT is sub-millisecond, so `client TTFT`
  ≈ the actual proxy overhead — this is the mode that isolates the code
  path's own cost.
- In `latency-injecting` mode, provider TTFT dominates (~800ms) and the
  AC-3 delta shrinks to single-digit-to-low-double-digit milliseconds —
  this is the expected, and desired, shape: it demonstrates the harness is
  measuring the PROXY's added cost, not re-measuring the mock's configured
  delay.
- **`AC-4 inter-token`** has `n` = total chunk-to-chunk gaps across every
  successful request at that level (not one per request), so its `n` is far
  larger than `requests`.

## Known baseline (pre-Lane-A/B, this harness's own smoke runs)

Captured against the CURRENT (pre-refactor) `apps/text` — the 202-and-poll
streaming contract, per-request provider client construction (Lane A's
keyed client cache has not landed), and per-chunk Redis writes (Lane B's
coalesced flush has not landed). These are **not** the Phase 0.1 "before"
baseline (that is the orchestrator's capture, over the full concurrency
sweep and the real 10-minute AC-1 duration) — they are this lane's own
end-to-end proof that the harness produces real, self-consistent numbers.
See the ticket report for the actual command output.

## TLS mode measurement (Lane H2, TASK-818) — what it proves and does not

Captured 2026-08-30 against `dev-2.2` WITH Lane A's client cache already
merged (`061ad8d84`), using:

```bash
uv run --extra test python tests/bench/harness.py \
  --mode zero-latency --levels 1,10,25 --duration 4 --warmup 5 \
  --tls --connections-per-request
```

| Concurrency | requests | AC-3 p50/p95/p99 | connections (new/requests) |
|---|---|---|---|
| 1  | 233 | 1.38 / 1.58 / 1.71 ms      | 233 / 233 — **1.000 conn/req** |
| 10 | 263 | 16.94 / 71.92 / 74.55 ms   | 263 / 263 — **1.000 conn/req** |
| 25 | 272 | 39.94 / 105.63 / 115.22 ms | 272 / 272 — **1.000 conn/req** |

**What this proves.** TLS mode works end-to-end: real HTTPS handshakes are
happening (a plain-HTTP client would simply fail the TLS negotiation against
this listener), and `--connections-per-request` is measuring a real,
independently-verified signal — a raw `httpx2.AsyncClient` reused directly
against the same TLS mock (bypassing the whole `apps/text` app) shows
`0` new connections across 6 sequential requests, both streamed and
non-streamed, on one instance, proving the mock and the counter are sound.

**What the numbers say, plainly, per the honest-result rule this ticket set
for itself: at every concurrency level tested — including `1`, where there is
no contention of any kind — the real `apps/text` request path opens a brand
new connection to the upstream on literally every single generation call.**
Calling `text.providers.clients.CLIENT_CACHE.get_or_create()` and
`text.providers.pool.pooled_http_client()` directly, by hand, with the exact
same `(provider, base_url, credential)` the bench sends, correctly returns
the SAME cached client and the SAME pooled transport object every time — so
the cache and pool code are not broken in isolation. Something in the path
between an incoming generation request and that cached client is not
resulting in connection reuse end-to-end, at ANY concurrency this lane
tested.

**This does not prove the client cache is worthless** — its unit tests
(`test_task818_client_cache.py`) still correctly prove one client per
credential, and the isolated check above proves the caching primitives work.
It DOES mean this benchmark, now that it can finally see a real TLS
handshake, sees a full one on every call rather than the occasional one a
working cache should produce. That is a genuine, unexpected, and actionable
finding this lane is flagging rather than diagnosing further — `apps/text/src/**`
is out of this lane's ownership (`tests/bench/**` only), and root-causing
which layer of the generate/stream request path fails to reach the cached
client belongs to whoever owns that code next.

**On the A/B comparison the ticket asked for:** Lane A's client cache has no
env-var kill switch (confirmed by reading `providers/clients.py` — the cache
is a bare module-level singleton with no `failMode`/toggle), so a true
"with-cache vs. without-cache" comparison under `--tls` is not possible
without editing `apps/text/src/**`, which this lane does not own. The
comparison above is therefore **one-sided**: it measures the current
(with-cache) code only. Given the `1.000 conn/req` finding, that one-sidedness
may matter less than it would have — a cache that is not observably reused end
-to-end cannot be distinguished from no cache at all by this measurement
either way.

## Extending this for Lane B (resumable streaming)

When `POST /generate` starts returning `200 + SSE` immediately (README §3C),
`run_one()`'s streaming branch changes from "POST for a `task_id`, then GET
the stream" to "read the POST response body as the stream directly" — the
mock, the process bootstrap, and the stats/report layers are unaffected.
AC-15..18 (resumability: reconnect-mid-generation, gateway/router restart
survival) are NOT covered by this harness yet — they need Lane B's resume
endpoint (`GET /generations/{gid}/stream`) to exist first.
