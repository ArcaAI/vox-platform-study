# Text load tests — Locust resilience suite

Locust load tests against a **live, already-running** `apps/text` instance to
verify resilience behavior under sustained load: rate limiter, circuit
breaker, semaphore and queue shedding. This is **not** `tests/bench/`
(a self-contained harness that spawns its own subprocesses and reports
percentiles) — this suite drives a real, manually-started stack and checks
response codes/headers.

## Layout

| Path | What it holds |
|---|---|
| `locustfile.py` | Four Locust user classes (`BaselineUser`, `RateLimitUser`, `ConcurrencyUser`, `StreamingUser`) tagged for selective runs |

### Prerequisites
- Locust installed (`pip install locust` or `uv pip install -e ".[load]"` from `apps/text`)
- `apps/text` running on port 8862 (`pnpm text:dev`)
- An LLM backend the tenant/connection resolves to (e.g. LM Studio with a model loaded)
- Redis running (required by `apps/text` for task management)

## Commands

```bash
# Baseline (10 users, 60s)
locust -f tests/load/locustfile.py --headless -u 10 -r 2 -t 60s --host http://localhost:8862

# Rate limiter (50 users, 120s) -- verifies 429 + Retry-After
locust -f tests/load/locustfile.py --headless -u 50 -r 10 -t 120s --host http://localhost:8862 --tags rate-limit

# Concurrency / semaphore (30 users, 90s) -- verifies 503 when max_concurrent is exceeded
locust -f tests/load/locustfile.py --headless -u 30 -r 5 -t 90s --host http://localhost:8862 --tags concurrency

# Streaming flow (202 + task poll)
locust -f tests/load/locustfile.py --headless -u 10 -r 2 -t 60s --host http://localhost:8862 --tags streaming

# Full resilience stress (all user types together)
locust -f tests/load/locustfile.py --headless -u 100 -r 20 -t 300s --host http://localhost:8862

# Interactive mode with the web UI
locust -f tests/load/locustfile.py --host http://localhost:8862
# then open http://localhost:8089
```

## How it works

### User classes (`locustfile.py`)

| Class | Weight | Tag | Purpose |
|---|---|---|---|
| `BaselineUser` | 3 | `baseline` | Sync generate, health, providers |
| `RateLimitUser` | 2 | `rate-limit` | Rapid-fire to trigger 429 |
| `ConcurrencyUser` | 2 | `concurrency` | Longer prompts to saturate the semaphore |
| `StreamingUser` | 1 | `streaming` | Streaming flow (202 + task poll) |

### Expected behavior

| Feature | Trigger | Expected response |
|---|---|---|
| Rate limiter | TPM/RPM limits exceeded | 429 with `Retry-After` header |
| Circuit breaker | 5 consecutive failures | 503 with `Retry-After: 30` |
| Semaphore | `max_concurrent` requests exceeded | 503 with `Retry-After: 5` |
| Queue | Rate-limited + queue full or timeout | 429 |
| Graceful shutdown | New requests during shutdown | 503 |

### Auth

All requests include an `X-Service-Token` header. For local dev, an empty
string is sufficient when auth is disabled (no `INTERNAL_ACCESS_TOKEN`
configured).

### Interpreting results

- **RPS**: throughput under load.
- **Response times** (median, p95, p99): latency percentiles.
- **Failures**: count of non-2xx responses; some 429/503 are *expected* when
  deliberately stressing a limit.
- **`Retry-After`**: when a 429/503 occurs, confirm the header is present so
  a real client can back off correctly.

### Metrics endpoint

`apps/text` exposes Prometheus metrics at `GET /metrics`. Correlate a load
test run against: `text_rate_limit_rejections_total`,
`text_circuit_breaker_state`, `text_concurrent_requests`, `text_queue_size`.

## Related

- [`06-python-services.md`](../../../../.claude/rules/06-python-services.md) — service conventions this suite exercises without modifying
- [`../bench/README.md`](../bench/README.md) — the self-contained latency/RSS benchmark harness (different purpose, needs no live stack)
- [`../../README.md`](../../README.md) — the service under test
