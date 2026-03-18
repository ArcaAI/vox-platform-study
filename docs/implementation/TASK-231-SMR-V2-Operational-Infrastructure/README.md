# TASK-231: SMR V2 Operational Infrastructure

- **Ticket**: TASK-231
- **Created**: 2026-02-28
- **Last Updated**: 2026-02-28
- **Status**: Completed
- **Depends on**: TASK-229 (SMR V2 Review & Enhancement)

## Requirement Analysis

Implement 6 operational tasks to make SMR V2 production-ready:

1. **E2E Tests** — Test against real Ollama (gemma3) and Azure OpenAI (gpt-4o-mini) endpoints
2. **Dockerfile / Docker Compose** — Fix port mismatch, add healthcheck, create compose file
3. **Grafana Dashboards** — Visualize 15 Prometheus metrics (overview, resilience, security)
4. **Redis Streams Consumer** — NestJS service to consume SMR V2 token streams directly
5. **Load Testing** — Locust-based verification of semaphore, rate limiter, circuit breaker
6. **IC-8: NestJS Prometheus Metrics** — Job processing metrics using existing ObservabilityModule

## Implementation Plan

### Task 1: E2E Tests with Real LLM Providers
- Create `apps/smr/src/smr_v2/tests/e2e/` with pytest tests
- Use `pytest.mark.e2e` marker (opt-in, not run in CI by default)
- Test Ollama (gemma3) and Azure OpenAI (gpt-4o-mini) for sync/streaming generation

### Task 2: Dockerfile / Docker Compose Updates
- Fix port from 5006 to 8862 in Dockerfile
- Add HEALTHCHECK instruction
- Create `apps/smr/docker-compose.yml` with monitoring profile
- Create `apps/smr/.env.example`

### Task 3: Grafana Dashboards
- Create `infrastructure/grafana/` directory
- 3 dashboards: Overview, Resilience, Security
- Provisioning configs for datasources and dashboards

### Task 4: Redis Streams Consumer for NestJS API
- New `SmrStreamConsumerService` using ioredis XREAD BLOCK
- Follow existing STT streaming pattern
- New `@Sse()` endpoint for direct Redis consumption
- Keep existing proxy-based endpoint as fallback

### Task 5: Load Testing
- Locust-based load tests in `apps/smr/tests/load/`
- Scenarios: baseline, rate limiter, circuit breaker, semaphore, queue, shutdown

### Task 6: IC-8 NestJS Prometheus Job Processing Metrics
- New `JobMetricsService` with 6 job-specific metrics
- Instrument all 4 BullMQ processors (summary, pre-summary, comprehensive, DNA)

## Implementation Summary

### Task 1: E2E Tests with Real LLM Providers -- COMPLETED
- Created `apps/smr/src/smr_v2/tests/e2e/` with 12 E2E test cases
- `conftest.py` maps `.env` vars to `SMR_V2_*` prefix, uses `fakeredis` for Redis
- Tests cover Ollama (gemma3) and Azure OpenAI (gpt-4o-mini): sync/streaming generation, health checks, provider listing
- Cross-provider tests: request ID propagation, invalid provider handling, empty prompt validation
- Added `pytest.mark.e2e` marker, excluded from default test runs via `-m "not e2e"` in addopts
- Added `fakeredis[lua]>=2.21.0` to test dependencies

### Task 2: Dockerfile / Docker Compose Updates -- COMPLETED
- Fixed port mismatch: `EXPOSE 8862`, ENTRYPOINT port `8862`
- Added `HEALTHCHECK` instruction using `/api/v2/health/live`
- Added OTel environment variables with defaults
- Created `apps/smr/docker-compose.yml` with SMR V2 + Redis + optional monitoring profile
- Created `apps/smr/monitoring/prometheus.yml` scrape config
- Created `apps/smr/.env.example` documenting all `SMR_V2_*` variables

### Task 3: Grafana Dashboards -- COMPLETED
- Created `infrastructure/grafana/` directory structure
- 3 dashboards (schema v39, Prometheus datasource, `provider` template variable):
  - **smr-v2-overview.json**: Request rate, active generations, concurrent requests, latency p50/p95/p99, TTFT, token rates, error rates
  - **smr-v2-resilience.json**: Circuit breaker states, rate limit rejections, queue size/wait, provider health
  - **smr-v2-security.json**: Guardrail scan rates, result distribution, risk level distribution
- Provisioning configs: `datasources.yml` (Prometheus), `dashboards.yml` (file provider)

### Task 4: Redis Streams Consumer for NestJS API -- COMPLETED
- Created `SmrStreamConsumerService` at `packages/applications/src/services/smr/streaming/`
- Uses ioredis `XREAD BLOCK` (same pattern as STT `StreamingAudioBridgeService`)
- Reads from `smr:stream:{taskId}`, emits `Observable<MessageEvent>` for NestJS `@Sse()`
- Supports `Last-Event-ID` for SSE resume
- New endpoint: `@Sse('api/v2/tasks/:taskId/stream/direct')` on `SmrController`
- Existing proxy-based `streamTask()` preserved as fallback
- 17 unit tests passing

### Task 5: Load Testing -- COMPLETED
- Created `apps/smr/tests/load/locustfile.py` with 4 user classes:
  - `BaselineUser` (weight=3), `RateLimitUser` (weight=2), `ConcurrencyUser` (weight=2), `StreamingUser` (weight=1)
- Created `apps/smr/tests/load/README.md` with usage instructions
- Added `locust>=2.32.0` to `[project.optional-dependencies.load]`

### Task 6: IC-8 NestJS Prometheus Job Processing Metrics -- COMPLETED
- Created `JobMetricsService` with 6 Prometheus metrics:
  - `hope_job_processing_total`, `hope_job_processing_duration_seconds`, `hope_job_waiting_duration_seconds`
  - `hope_job_errors_total`, `hope_job_active_count`, `hope_job_smr_call_duration_seconds`
- Registered in `ObservabilityModule` (providers + exports)
- Instrumented all 4 BullMQ processors with timing, error counting, and SMR call duration
- 13 new unit tests + all 198 processor tests passing

## Test Results Summary

| Suite | Tests | Status |
|-------|-------|--------|
| SMR V2 Python unit tests | 702 | All passing |
| NestJS Observability tests | 95 | All passing |
| NestJS SMR Stream Consumer tests | 17 | All passing |
| NestJS Processor tests | 198 | All passing |

## Change History

### 2026-02-28 -- Initial Implementation
- All 6 tasks implemented
- No regressions in existing test suites
