# TEXT Load Tests (Locust)

Load tests for the TEXT text generation service to verify resilience features under sustained load: rate limiter, circuit breaker, semaphore, and queue behavior.

## Prerequisites

- **Locust** installed (`pip install locust` or `uv pip install locust`)
- **TEXT** running on port 8862
- **LM Studio** running with a model (e.g. `gemma-4-e2b-it-qat`) for generate requests
- **Redis** running (required by TEXT for task management)

## Installation

```bash
# From monorepo root or apps/text
pip install locust
# or with optional dependencies
uv pip install -e ".[load]"
```

## Usage

### Baseline Test (10 users, 60s)

Measures baseline throughput with normal pacing:

```bash
locust -f tests/load/locustfile.py --headless -u 10 -r 2 -t 60s --host http://localhost:8862
```

### Rate Limiter Test (50 users, 120s)

Triggers rate limiting to verify 429 responses and `Retry-After` header:

```bash
locust -f tests/load/locustfile.py --headless -u 50 -r 10 -t 120s --host http://localhost:8862 --tags rate-limit
```

### Concurrency / Semaphore Test

Saturates the semaphore to verify 503 responses when `max_concurrent` is exceeded:

```bash
locust -f tests/load/locustfile.py --headless -u 30 -r 5 -t 90s --host http://localhost:8862 --tags concurrency
```

### Streaming Test

Exercises streaming flow (202 + task polling):

```bash
locust -f tests/load/locustfile.py --headless -u 10 -r 2 -t 60s --host http://localhost:8862 --tags streaming
```

### Full Resilience Test

Runs all user types together to stress the full stack:

```bash
locust -f tests/load/locustfile.py --headless -u 100 -r 20 -t 300s --host http://localhost:8862
```

### Interactive Mode

For exploratory testing with the web UI:

```bash
locust -f tests/load/locustfile.py --host http://localhost:8862
```

Then open http://localhost:8089 and configure users/spawn rate.

## Expected Behavior

| Feature               | Trigger                              | Expected Response             |
| --------------------- | ------------------------------------ | ----------------------------- |
| **Rate limiter**      | TPM/RPM limits exceeded              | 429 with `Retry-After` header |
| **Circuit breaker**   | 5 consecutive failures               | 503 with `Retry-After: 30`    |
| **Semaphore**         | `max_concurrent` requests exceeded   | 503 with `Retry-After: 5`     |
| **Queue**             | Rate-limited + queue full or timeout | 429                           |
| **Graceful shutdown** | New requests during shutdown         | 503                           |

## Interpreting Results

- **RPS (Requests per second)**: Throughput under load
- **Response times (median, 95th, 99th)**: Latency percentiles
- **Failures**: Count of non-2xx responses; some 429/503 are expected when stressing limits
- **Retry-After**: When 429/503 occur, check that the header is present for client backoff

### Metrics Endpoint

TEXT exposes Prometheus metrics at `GET /metrics`. Correlate load test runs with:

- `text_rate_limit_rejections_total`
- `text_circuit_breaker_state`
- `text_concurrent_requests`
- `text_queue_size`

## User Classes

| Class           | Weight | Tag         | Purpose                              |
| --------------- | ------ | ----------- | ------------------------------------ |
| BaselineUser    | 3      | baseline    | Sync generate, health, providers     |
| RateLimitUser   | 2      | rate-limit  | Rapid-fire to trigger 429            |
| ConcurrencyUser | 2      | concurrency | Longer prompts to saturate semaphore |
| StreamingUser   | 1      | streaming   | Streaming flow (202 + task poll)     |

## Auth

All requests include `X-Service-Token` header. For local dev, an empty string is sufficient when auth is disabled.
