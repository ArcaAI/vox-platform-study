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

## Extending this for Lane B (resumable streaming)

When `POST /generate` starts returning `200 + SSE` immediately (README §3C),
`run_one()`'s streaming branch changes from "POST for a `task_id`, then GET
the stream" to "read the POST response body as the stream directly" — the
mock, the process bootstrap, and the stats/report layers are unaffected.
AC-15..18 (resumability: reconnect-mid-generation, gateway/router restart
survival) are NOT covered by this harness yet — they need Lane B's resume
endpoint (`GET /generations/{gid}/stream`) to exist first.
