# Downstream Dependency Failure Modes & Degradation Matrix

This document defines what happens to the HOPE API Gateway ([`apps/api`](file:///Users/apple/repos/VOX/project-hope/apps/api)) when supporting infrastructure or downstream Python microservices fail, slow down, or become partitioned.

---

## 1. Quick Reference Degradation Matrix

| Component | Port / Transport | Failure Behavior | Gateway Response to Client | Fail Safe Mode |
|---|---|---|---|---|
| **Python STT** | `8861` (WS / HTTP) | WebSocket connection closes; batch job status marked `FAILED` | WS close code 1011 / 502 Bad Gateway | **Fail-Closed** |
| **Python Text** | `8862` (HTTP) | Gateway drops SSE token stream; returns 504 on timeout | 504 Gateway Timeout or 502 Bad Gateway | **Fail-Closed** |
| **Python TTS** | `8865` (WS / HTTP) | Synthesis request throws `SpeechSynthesisException` | 502 Bad Gateway / fallback to Azure Speech | **Graceful Degradation** |
| **Python NLP** | `8864` (HTTP) | NER / coding suggestions return empty set | 200 OK (with partial annotations) or 502 | **Graceful Degradation** |
| **PostgreSQL** | `5432` (TCP) | Prisma pool starvation; transactions throw connection error | 503 Service Unavailable | **Fail-Closed** |
| **Redis** | `6379` (TCP) | Throttling fails closed; stream tickets throw 500 | 500 Internal Server Error | **Fail-Closed** |
| **Temporal** | `7233` (gRPC) | Note generation jobs remain in `pending` | Async job accepts (202), but note never completes | **Fail-Closed** |
| **MinIO / S3**| `9000` (HTTP) | Audio upload presigned URL creation fails | 500 Internal Server Error | **Fail-Closed** |
| **Vault** | `8200` (HTTP) | Secrets rotation worker logs warning; uses cached in-memory key | 200 OK (cached) or 500 (if cold start) | **Graceful Degradation** |
| **Qdrant** | `6333` (gRPC) | Institutional knowledge search returns empty citations | 200 OK (un-cited generation) or 502 | **Graceful Degradation** |

---

## 2. Component Deep Dives & Triage Steps

### 1. Downstream Python STT Service (Port 8861)
- **Role:** Real-time speech-to-text transcription engine.
- **Symptom in Gateway:**
  - `SttWsGateway` receives `ECONNREFUSED` or socket hangup from upstream.
  - Gateway immediately closes client WebSocket with code `1011 (Internal Error)`.
- **Operator Triage:**
  ```bash
  # Check if STT service process is alive
  curl -i http://localhost:8861/health
  # Check GPU VRAM memory usage
  nvidia-smi
  # Inspect Docker container logs
  docker logs project-hope-stt-1 --tail 100
  ```

---

### 2. Downstream Python Text / LLM Service (Port 8862)
- **Role:** LLM generation, prompt assembly, and SOAP pre-summaries.
- **Symptom in Gateway:**
  - `TextProxyController` logs: `Downstream service error: target=http://localhost:8862/generate status=504`.
  - Client receives HTTP 504 Gateway Timeout after 60 seconds.
- **Operator Triage:**
  ```bash
  # Test health endpoint
  curl -i http://localhost:8862/health
  # Test direct inference ping
  curl -X POST http://localhost:8862/v1/models
  # Check upstream LLM provider status (Azure OpenAI / Anthropic / LM Studio)
  ```

---

### 3. Redis Sentinel / Cluster (Port 6379)
- **Role:** Rate limiting (`TieredThrottlerGuard`), stream ticket store, and BullMQ queues.
- **Symptom in Gateway:**
  - Throttler guard throws `RedisConnectionError`.
  - Calling `POST /api/v1/auth/stream-ticket` returns 500.
  - SSE streams disconnect immediately because ticket lookup fails.
- **Operator Triage:**
  ```bash
  # Check Redis responsiveness
  redis-cli ping
  # Inspect Redis memory usage
  redis-cli info memory
  # Check connected clients
  redis-cli info clients
  ```

---

### 4. PostgreSQL & Prisma Database Pool (Port 5432)
- **Role:** Relational store for users, consultations, notes, and audit logs.
- **Symptom in Gateway:**
  - `PrismaClientInitializationError: Can't reach database server at localhost:5432`.
  - Or latency spikes with `prisma_pool_wait_duration_seconds > 0`.
- **Operator Triage:**
  ```bash
  # Check active database connections in PostgreSQL
  psql -U postgres -d hope_db -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"
  # Check for deadlocks or long-running transactions
  psql -U postgres -d hope_db -c "SELECT pid, age(clock_timestamp(), query_start), query FROM pg_stat_activity WHERE state != 'idle' ORDER BY 2 DESC LIMIT 5;"
  ```

---

### 5. Temporal Workflow Server (Port 7233)
- **Role:** Coordinates the clinical documentation harness loop (`guides → generate → sensors → gate`).
- **Symptom in Gateway:**
  - `POST /api/v1/consultations/:id/summary` returns `{ jobId: "...", status: "pending" }`.
  - Consultation stays in `IN_PROGRESS` or `RECORDED` state indefinitely.
- **Operator Triage:**
  ```bash
  # Open Temporal Web Console
  open http://localhost:8233
  # Check if workers are polling the "harness-tasks" queue
  # Inspect failed activity stack traces in Temporal UI
  ```
