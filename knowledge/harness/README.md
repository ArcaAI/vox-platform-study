# Clinical Documentation Harness

> Python / FastAPI orchestrator that runs the bounded clinical-documentation loop as a Temporal durable workflow.

## Overview

The Harness (`apps/harness`) drives the **`guides → generate → sensors → gate`** clinical-documentation loop. The API gateway (`apps/api`, NestJS) remains the gateway and system-of-record (authZ, tenant/CLS, Postgres, WORM audit, consent, sign-off); the Harness reuses **STT-v2 / NLP / SMR / Qdrant as tools** (agentic-compute-interface pattern) and isolates the Temporal SDK so `apps/api` is the only caller.

- **Port:** 8866
- **Stack:** Python 3.11 · FastAPI · Temporal (durable workflows)

## Architecture (Temporal mapping)

The loop body is a **deterministic** Temporal **workflow**; all non-deterministic work (LLM/tool I/O, clock, randomness) lives in **activities**. The clinician sign-off gate is a `workflow.wait_condition()` on an approval **Signal** with SLA/escalation timers.

| Loop element | Temporal construct |
|---|---|
| guide / generate / sensors | Activity (idempotent, retryable) |
| bounded regen | deterministic loop in the Workflow |
| gate (clinician sign-off) | `wait_condition()` on an approval Signal + durable timer |

Internal structure (`src/harness/`): `main.py` (FastAPI app + best-effort Temporal connect), `api/` (health + internal routes), `temporal/` (workflows, activities, client, worker), `sensors/`, `guides/`, `guards/`, `eval/`, `services/`, `core/` (config + structlog logging).

## Getting Started

Python always runs in the conda env `arcaenv`.

```bash
# Install (handled by `pnpm py:setup`, or manually):
conda run -n arcaenv pip install -e "apps/harness[dev,test]"

# Start the Temporal dev stack (opt-in `temporal` compose profile):
docker compose -f infrastructure/docker/docker-compose.yml \
               -f infrastructure/docker/docker-compose.dev.yml \
               --profile temporal up -d temporal temporal-ui
#   Temporal Web UI: http://localhost:8233 · gRPC frontend: localhost:7233

# Run the FastAPI app + the worker (separate terminals):
pnpm dev:harness          # → http://localhost:8866/api/v1/health · docs: /api/v1/docs
pnpm py:harness:worker
```

The FastAPI app starts even when Temporal is down (it degrades to "not ready" rather than crashing). The **worker** requires a reachable Temporal server.

**One-time per cluster:** register the tenant search attribute so the admin list can filter server-side:

```bash
temporal operator search-attribute create --name HarnessTenantId --type Keyword
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `HARNESS_HOST` | `0.0.0.0` | Bind host |
| `HARNESS_PORT` | `8866` | Service port |
| `HARNESS_LOG_LEVEL` | `info` | Log verbosity |
| `HARNESS_METRICS_ENABLED` | `true` | Prometheus `/metrics` |
| `HARNESS_SERVICE_TOKEN` | — | Shared `X-Service-Token` for internal routes (empty disables the guard for local dev) |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal frontend (gRPC) |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_TASK_QUEUE` | `harness-task-queue` | Worker task queue |
| `HARNESS_LLM_MAX_CONCURRENCY` | `1` | Max in-flight requests per LLM provider endpoint (see [Operations → inferential-pass latency](#inferential-pass-latency--timeouts)) |
| `HARNESS_LLM_REQUEST_TIMEOUT_S` | `120` | Per-**call** LLM wall-clock timeout; the latency safety net for the inferential pass (see [Operations → inferential-pass latency](#inferential-pass-latency--timeouts)) |

> The full LLM concurrency-governor + retry knob set (`HARNESS_LLM_*`) is documented in [`apps/harness/.env.example`](../../apps/harness/.env.example).

## API Reference

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/health` | Detailed health (echoes configured Temporal substrate) |
| GET | `/api/v1/health/live` | Liveness |
| GET | `/api/v1/health/ready` | Readiness — 503 unless Temporal is reachable |
| GET | `/metrics` | Prometheus metrics |
| GET | `/api/v1/docs` | Swagger UI |

Internal routes (service-to-service, `X-Service-Token`, mounted under `/api/v1/internal`) start the document loop, forward clinician sign-off signals, ingest knowledge documents, and expose admin workflow-ops (list/describe/cancel/terminate/signal). `apps/api` is the only caller.

## Testing

```bash
pnpm py:harness:test        # all tests (Temporal time-skipping WorkflowEnvironment — no external server needed)
pnpm py:harness:test:cov    # with coverage
pnpm py:harness:lint        # ruff
pnpm py:harness:typecheck   # mypy
```

## Operations (runbook)

The loop is a Temporal durable workflow; the failure modes below are drawn from the 2026-06-11/12 incident and its fixes (TASK-354).

### Inferential-pass latency & timeouts

`run_inferential_sensors` is the long pole — a healthy single-attempt pass is ≈344 s of serialized judge/guardian calls (everything else < 25 s). Three layers stop one hung LM Studio call from stalling the whole pipeline:

| Layer | Knob | Default | Effect |
|---|---|---|---|
| Per-call wall-clock timeout | `HARNESS_LLM_REQUEST_TIMEOUT_S` | `120` | Bounds **each** model call (judge / citation_verify / Granite). A timed-out call is transient → retried within `HARNESS_LLM_MAX_ATTEMPTS`, then the owning sensor self-degrades (reduced assurance, **never** auto-PASS). `<=0` disables. |
| Activity heartbeat | 15 s background `activity.heartbeat()` + `heartbeat_timeout=60s` (workflow option) | — | Temporal detects a dead worker / hung attempt within ~60 s instead of the 900 s `start_to_close`. |
| Activity budget | `start_to_close_timeout=900s` + `retry_policy` (2 attempts) | — | Whole-pass ceiling, kept at 900 s for headroom over the 344 s healthy pass. |

The per-call timeout is the safety net that makes `HARNESS_LLM_MAX_CONCURRENCY > 1` (raised to 2 in TASK-355 Phase A) safe: a hung call now ties up a real slot, so it **must** be bounded. The heartbeat is option-only (it does not change the recorded command sequence), so it is replay-safe with no patch gate.

### Detecting & terminating nondeterministic "zombie" workflows

A workflow whose definition changed in a replay-incompatible way (an added/removed/reordered activity or `workflow.patched()` gate landed **without** a captured fixture + replay test) fails **every** workflow task with `[TMPRL1100] Nondeterminism error`. It stays `Running` forever and cannot even process a cancel — delivering the cancel itself needs a workflow task, which also fails. The 2026-06-11/12 incident had 3 such zombies.

Detect:

```bash
# Running workflows on the queue
temporal workflow list --query 'WorkflowType="HarnessDocWorkflow" AND ExecutionStatus="Running"'

# A wedged run shows a PendingWorkflowTask with a climbing Attempt count + the failure cause:
temporal workflow describe -w <workflow-id>
# Full history (look for WorkflowTaskFailed / TMPRL1100), or use the Temporal Web UI (:8233):
temporal workflow show -w <workflow-id>
```

**Distinguish from by-design gate-waiters:** a `PENDING_REVIEW` draft parked on the clinician `approval` signal (24 h SLA + 12 h re-escalation) is **not** a zombie — its last workflow task is healthy and a draft ContextItem exists. Terminate **only** runs that are *failing* workflow tasks with TMPRL1100.

Terminate (operator action, irreversible — confirm the workflow-id first):

```bash
temporal workflow terminate -w <workflow-id> --reason "TASK-354 nondeterministic zombie (TMPRL1100)"
```

### One worker version per task queue

The incident's root enabler was **multiple worker processes of different code vintages polling `harness-task-queue` at once** — an old worker replaying a new-era history (or vice-versa) wedges it. Policy:

- Deploy harness workers as a single rollout; never run two code versions against one task queue at the same time (drain/replace, don't overlap).
- Make every workflow-definition change replay-safe (see the checklist below) so a brief overlap during a rolling deploy is survivable.
- Temporal Worker Versioning (Build IDs) is the durable long-term fix but is **not** yet rolled out (TASK-354 non-goal).

### Zero-poller / backlog-age monitoring

A queue with no pollers silently stops producing notes — in the incident the whole stack was down and the workflow-task backlog aged ~13 h before anyone noticed. Watch:

```bash
# Pollers attached to the queue (zero workflow pollers = no worker → drafts stall)
temporal task-queue describe --task-queue harness-task-queue --task-queue-type workflow
```

The Temporal Web UI (`:8233`) task-queue view shows backlog size + age. Alert when **workflow pollers == 0** or backlog age exceeds the healthy loop time (~9 min). Note: FastAPI `/api/v1/health/ready` returns 503 only when Temporal is *unreachable* — it does **not** catch a reachable server with zero workers, so monitor the task queue directly.

### Patch-gate checklist (every workflow change)

`workflow.patched()` protects only histories recorded **after** the marker exists; it cannot repair already-recorded marker-less histories. For ANY change to `HarnessDocWorkflow`'s command sequence (add/remove/reorder an `execute_activity`, `wait_condition`, child workflow, timer, or signal handling):

1. **Gate** the change behind `workflow.patched("task-<n>-<slug>")` (collapse to `workflow.deprecate_patch()` once no old-era runs can still be in flight).
2. **Capture** a new current-era fixture with `_capture_replay_fixture.py` (pass `--failure` to also exercise the failure-terminal gate).
3. **Add** a replay test in `test_replay_compat.py` against that fixture.
4. **Run** the replay suite — it must pass on the new definition and fail on any *ungated* sequence change.

Option-only edits (timeouts, `heartbeat_timeout`, retry policy) do **not** change the recorded command sequence and need no gate — but still run the replay suite to confirm (TASK-354 Step 1 added `heartbeat_timeout` exactly this way).

## Related Documentation

- [Architecture Overview](../architecture/README.md) — system topology
- [Guardrail](../guardrail/README.md) — content-safety service used in the generate path
- [SMR V2](../smr-v2/README.md) · [STT V2](../stt-v2/README.md) · [NLP](../nlp/README.md) — tools the Harness orchestrates
- Full service docs: [`apps/harness/README.md`](../../apps/harness/README.md)
