# BUG-011 — STT batch (Dramatiq) worker has no dev start path; batch jobs sit QUEUED forever

| Field | Value |
|---|---|
| **Status** | `Review` — Option A + D implemented and verified by dry-run/doctor evidence; two runtime criteria (live `pnpm stack:dev` spawn, end-to-end batch job) are owner-gated, see Implementation Summary |
| **Type** | `bugfix` |
| **Branch** | `dev-2.1` |
| **Discovered** | 2026-08-03, during compat-playground batch-upload E2E testing (TASK-603) |
| **Severity** | High — batch transcription is silently non-functional in local dev; no signal anywhere |
| **Affected apps/packages** | `apps/stt` (Dramatiq worker), `scripts/` (`dev-service.sh`, `dev-stack.sh`, `dev-doctor.sh`), root `package.json` (script surface), `apps/api` + `packages/applications` (enqueue side, unchanged but affected), `apps/compat-playground` (reporting surface) |
| **Related tickets** | TASK-603 (Compat Batch Upload — the surface that exposed this), TASK-557 (script-surface consolidation), TASK-346/TASK-555 (dev-service / dev-stack), TASK-007 (STT worker architecture, archived) |

> **Scope note:** this document is **diagnosis only**. No source code was modified. No service was
> restarted and no database was reset while producing it.

---

## Requirement Analysis

Batch transcription in HOPE is a two-process design:

1. The **gateway** (`apps/api`) accepts an upload, persists a `TranscriptionJob` row with
   `status = QUEUED`, uploads audio to object storage, and hand-writes a Dramatiq message into
   Redis (`HSET` + `RPUSH` + `PUBLISH`).
2. A **separate STT Dramatiq worker process** consumes `dramatiq:stt_batch`, runs ASR, and drives
   the job to `PROCESSING` → `COMPLETED`/`FAILED`, publishing progress on
   `stt:transcription:{jobId}` for the SSE stream.

Requirement, stated plainly: **for batch transcription to work at all, a second long-running
process must be running alongside the STT FastAPI app.** The platform must therefore provide

- **R1** — a supported, discoverable way to start that worker in local development, matching the
  monorepo's own script taxonomy (`01-development-workflow.md` §Script Naming);
- **R2** — that worker being part of the supervised dev stack, like every other required process;
- **R3** — an observable signal when the worker is absent, so "jobs never run" surfaces as a
  diagnosable fault rather than an indefinitely-pending UI spinner.

All three are currently unmet. R1 and R2 are outright missing; R3 has no implementation at all.

---

## Current State Evaluation

### 1. Symptom (observed 2026-08-03, compat-playground `:5177` → "Batch upload" tab)

Jobs submitted from the playground were accepted by the gateway (HTTP 2xx, job id returned,
SSE stream opened) and persisted, but never executed. `core."TranscriptionJob"` rows stayed at
`status='QUEUED'`, `progress=0`, `startedAt=NULL`, `workerId=NULL` for >10 minutes.

Redis showed the queue existed and was backing up, with a stale ack set belonging to a worker
whose heartbeat had gone cold:

```
llen dramatiq:stt_batch                                                     = 2
hlen dramatiq:stt_batch.msgs                                                = 7
scard dramatiq:__acks__.4703f969-c70c-4e1a-9a45-ac2f081b9fd5.stt_batch      = 5   (unacked)
```

`ps aux` showed **only** the FastAPI app — no `dramatiq` process at all:

```
uvicorn stt.main:app --host 127.0.0.1 --port 8861 --app-dir apps/stt/src
```

Jobs submitted earlier the same day **had** completed, stamped `workerId='worker-33830'` — a
process that had since exited. The queue consumer disappeared; nothing restarted it and nothing
reported its absence.

### 2. State re-verified while writing this document (2026-08-03 14:10 UTC)

The evidence above is from the E2E session. By the time this document was written a worker had
been started **by hand** (the workaround), so the live state differs and is recorded here for
honesty. It does not weaken the diagnosis — it confirms it, because the only thing that changed
was a manually launched process.

```
$ ps aux | grep dramatiq
taphuynh 42466 ... /Users/taphuynh/miniconda3/envs/arcaenv/bin/dramatiq stt.worker --processes 1 --threads 4
taphuynh 42448 ... conda run -n arcaenv --no-capture-output env NODE_ENV=development \
                   PYTHONPATH=apps/stt/src dramatiq stt.worker --processes 1 --threads 4
```

Note the invocation: a hand-assembled `conda run … env NODE_ENV=… PYTHONPATH=apps/stt/src
dramatiq stt.worker …`. **There is no script in the repo that produces that command line** (see
§3–§6) — it had to be reconstructed by a human from `apps/stt/docker/Dockerfile`.

Redis after that manual start:

```
$ docker exec hope-redis redis-cli time
1785766256                                  # 2026-08-03 14:10:56 UTC
$ docker exec hope-redis redis-cli llen dramatiq:stt_batch
0
$ docker exec hope-redis redis-cli hlen dramatiq:stt_batch.msgs
8
$ docker exec hope-redis redis-cli zrange dramatiq:__heartbeats__ 0 -1 WITHSCORES
4703f969-c70c-4e1a-9a45-ac2f081b9fd5
1785764814960                               # 1441 s stale — the dead worker
0c9efe4a-cba6-476d-9f7b-ebe4298d3f40
1785766242094                               # 14 s old — the manually started worker
$ docker exec hope-redis redis-cli smembers dramatiq:__acks__.4703f969-….stt_batch
019fc7c8-e540-7914-81bc-4e17106b6ce8
019fc7c9-d950-7751-a238-e05dadbd38e0
019fc7d0-7ec0-7660-a5e5-de37dc87e572
019fc7d0-7ec0-7660-a5e5-de391816fdd9
019fc7db-a969-7b5a-be7c-138b641f34bf     # 5 messages, never redelivered
```

Database (read-only query, no reset performed):

```
$ docker exec hope-postgres psql -U postgres -d hope -c \
  'SELECT id, status, progress, "startedAt", "workerId", "createdAt"
     FROM core."TranscriptionJob" ORDER BY "createdAt" DESC LIMIT 15;'

                  id                  |   status   | progress |        startedAt        |   workerId    |        createdAt
--------------------------------------+------------+----------+-------------------------+---------------+-------------------------
 019fc7f4-de96-76d9-ad92-fddaa746e52e | COMPLETED  |      100 | 2026-08-03 14:09:01.991 | worker-42468  | 2026-08-03 14:09:01.59
 019fc7eb-7358-7c05-8474-c086ea098b5f | COMPLETED  |      100 | 2026-08-03 14:08:38.255 | worker-42468  | 2026-08-03 13:58:44.312
 019fc7eb-7357-7180-96ba-a22b843cb37d | QUEUED     |        0 |                         |               | 2026-08-03 13:58:44.311
 019fc7db-a92e-7118-b8a5-bdcb00ba584c | QUEUED     |        0 |                         |               | 2026-08-03 13:41:29.518
 019fc7d0-7e6a-700c-aa7f-9c127038f64e | QUEUED     |        0 |                         |               | 2026-08-03 13:29:17.674
 019fc7d0-7e69-7151-af05-60cadf45e8d6 | COMPLETED  |      100 | 2026-08-03 13:29:18.376 | worker-33830  | 2026-08-03 13:29:17.673
 019fc7c9-d906-7b14-943c-ab9cc0f5452e | COMPLETED  |      100 | 2026-08-03 13:22:02.648 | worker-33830  | 2026-08-03 13:22:02.118
 019fc7c8-e49e-74da-95c1-d75920dcef5d | FAILED     |        5 | 2026-08-03 13:21:00.194 | worker-33830  | 2026-08-03 13:20:59.55
 …  (rows 98000000-… are seed fixtures, not this session)
```

Two observations from the re-verification:

- `worker-33830` (the earlier, now-dead worker) and `worker-42468` (the manual one) confirm the
  worker id is derived from the process — a dead process leaves jobs permanently unclaimed.
- **Secondary finding:** the 5 messages stranded in the dead worker's ack set were *not*
  redelivered even after a new worker came up; jobs `019fc7d0-7e6a-…`, `019fc7db-a92e-…` and
  `019fc7eb-7357-…` remain `QUEUED`. Their message-id UUIDv7 timestamp prefixes (`019fc7c8`,
  `019fc7c9`, `019fc7d0`×2, `019fc7db`) line up with those jobs' creation times, so the
  correlation is strong — but this was **not** traced through Dramatiq's requeue path and is
  recorded as an observation, not a root cause.

### 3. The worker is a genuinely separate process — verified

`apps/stt/src/stt/worker.py` is a standalone entrypoint. It configures the Redis broker, imports
the actors, initializes DB/MinIO/VAD/diarization/punctuation, then constructs and runs a Dramatiq
`Worker`:

- `apps/stt/src/stt/worker.py:48` — `broker = configure_broker(settings.redis_url)`
- `apps/stt/src/stt/worker.py:52` — `from stt.transcription.workers import transcribe_file  # noqa: E402, F401`
- `apps/stt/src/stt/worker.py:149` — `def main() -> None:`
- `apps/stt/src/stt/worker.py:186` — `queues={"stt_batch", "default"}`

The actor it consumes:

- `apps/stt/src/stt/transcription/workers/transcribe_file.py:32-38`

```python
@dramatiq.actor(
    queue_name="stt_batch",
    max_retries=3,
    min_backoff=10000,  # 10 seconds
    max_backoff=300000,  # 5 minutes
    time_limit=get_settings().transcription_timeout_seconds * 1000,
)
```

A console entry point exists:

- `apps/stt/pyproject.toml:212` — `stt-worker = "stt.worker:main"`

Nothing in the FastAPI app (`apps/stt/src/stt/main.py`) starts it — `stt.main:app` is a pure
HTTP/WebSocket surface.

### 4. Root `package.json` has NO script that starts the STT worker — confirmed

The complete `stt:*` block (`package.json:85-101`) is setup / dev / test / lint / typecheck /
format only. The dev entry is:

- `package.json:89` — `"stt:dev": "./scripts/dev-service.sh stt"`

There is exactly one `worker:dev` script, and it is the **harness Temporal worker**, not the STT
Dramatiq worker. The section header in the file says so explicitly:

- `package.json:190` — `"── WORKER — harness Temporal worker ──────────────": "",`
- `package.json:191` — `"worker:dev": "./scripts/dev-service.sh worker",`

`grep -n "dramatiq" package.json` returns nothing.

### 5. `scripts/dev-service.sh` has no `stt-worker` target — confirmed

The accepted target list is fixed and does not contain a batch-worker target:

- `scripts/dev-service.sh:21` (usage) —
  `#   ./scripts/dev-service.sh <stt|smr|nlp|guardrail|harness|tts|worker> [--watch] [--print]`
- `scripts/dev-service.sh:146` (argument parser) —
  `stt|smr|nlp|guardrail|harness|tts|worker) SERVICE="$arg" ;;`
  — anything else exits 2 with "Unknown argument" (`:147`).

The `stt` target starts only uvicorn:

- `scripts/dev-service.sh:201-206`

```bash
    stt)
        : "${STT_PORT:=8861}"
        ENV_REPORT+=("HOST=$HOST" "STT_PORT=$STT_PORT")
        CMD=(uvicorn stt.main:app --host "$HOST" --port "$STT_PORT" --app-dir apps/stt/src)
        RELOAD_DIR="apps/stt/src"
        ;;
```

The `worker` target is unambiguously the harness Temporal worker:

- `scripts/dev-service.sh:239-246`

```bash
    worker)
        apply_harness_env
        CMD=(python -m harness.temporal.worker)
        if [ "$WATCH" = "1" ]; then
            echo -e "${YELLOW}--watch is not supported for the Temporal worker; ignoring.${NC}" >&2
            WATCH=0
        fi
        ;;
```

The script's own header confirms the intent — `scripts/dev-service.sh:3`:
`# TASK-346 — Single-service dev launcher (Python services + harness worker)`.

### 6. `scripts/dev-stack.sh` cannot supervise it — confirmed

The supervisor's service vocabulary is two fixed arrays; neither contains an STT worker:

- `scripts/dev-stack.sh:50` — `DEFAULT_SERVICES=(api stt smr guardrail nlp harness worker admin)`
- `scripts/dev-stack.sh:51` — `ALL_SERVICES=(api stt smr nlp harness worker admin guardrail tts)`

Any other name is rejected — `scripts/dev-stack.sh:115`:
`echo -e "${RED}Unknown service '$arg'.${NC} Known: ${ALL_SERVICES[*]} (or 'down')"`.

And its header (`scripts/dev-stack.sh:6-7`) enumerates what "the full local clinical-workspace
stack" means — the STT batch worker is not in it:

```
#   api (8868), stt (8861), smr (8862), guardrail (8863), nlp (8864),
#   harness (8866), worker (Temporal task queue), admin (5176)
```

Every non-`api`/`admin` service is delegated straight to `dev-service.sh`
(`scripts/dev-stack.sh:73` — `*) CMD=("$SCRIPT_DIR/dev-service.sh" "$1") ;;`), so §5 is the
binding constraint: `dev-stack.sh` cannot supervise a process `dev-service.sh` cannot launch.

### 7. Production DOES run it — only the container image knows how

The worker is a first-class deployment artifact. It is its own Docker stage and its own CI build
job — proving it is a required runtime component, not an optional extra:

- `apps/stt/docker/Dockerfile:284` —
  `CMD ["python3.11", "-m", "dramatiq", "stt.worker", "--processes", "2", "--threads", "4"]`
  (stage `worker`, declared at `apps/stt/docker/Dockerfile:282` — `FROM ml-runtime AS worker`;
  the `CMD` is the file's last line)
- `.gitlab/ci/build.yml:270` — `build-stt-worker:`; `:278` `SERVICE_NAME: stt-worker`;
  `:283` `BUILD_TARGET: worker`
- `.gitlab/ci/deploy.yml:75` and `:125` — `stt-worker` is one of the services promoted to staging

**This is the gap in one sentence: the container image is the only place in the repository that
knows how to start the STT batch worker, so batch transcription works in staging/production and
is silently dead in local development.**

### 8. Nothing monitors, alerts, or reports the missing consumer — confirmed

Checked exhaustively; the answer is **no** on every axis.

| Signal | Present? | Evidence |
|---|---|---|
| Worker readiness/liveness endpoint | **No** | `stt/worker.py` starts no HTTP server; the only health routes live in `apps/stt/src/stt/health/api/routes.py`, served by `stt.main:app` |
| Health check for queue depth / consumer presence | **No** | `apps/stt/src/stt/health/api/routes.py:52,59,66,73,75` — the entire `checks` map is `database`, `minio`, `redis`, `streaming`, `processors`. The `redis` check (`:192`) only pings the connection; it never inspects `dramatiq:stt_batch`, `dramatiq:__heartbeats__`, or any ack set. `grep -rn "stt_batch" apps/stt/src/stt` returns **only** `worker.py:176`, `worker.py:186`, `transcribe_file.py:33` — no health/metrics module references the queue at all. |
| Readiness gate | **No** | `apps/stt/src/stt/health/api/routes.py:112` — `for check_fn in [_check_database, _check_minio, _check_redis]:`. A fully-functional-looking `/health/ready` is returned with zero batch consumers running. |
| Prometheus queue-depth / consumer metric | **No** | `apps/stt/src/stt/core/metrics.py` declares no queue-depth metric. |
| Prometheus worker metrics | **Declared but dead** | `apps/stt/src/stt/core/metrics.py:140` `WORKER_JOBS_IN_PROGRESS` and `:145` `WORKER_JOBS_TOTAL` exist, but `grep -rn "WORKER_JOBS_IN_PROGRESS\|WORKER_JOBS_TOTAL" apps/stt/src/stt` returns **only those two declaration sites** — zero call sites. Even if they were incremented, the worker process exposes no `/metrics`: the Prometheus instrumentator is mounted only on the FastAPI app (`apps/stt/src/stt/main.py:255-258`). |
| Dev doctor check | **No** | `scripts/dev-doctor.sh:132-139` checks exactly one worker process — `pgrep -f 'harness\.temporal\.worker'` — and fails with "start with 'pnpm worker:dev'". No STT/Dramatiq equivalent exists. |
| Gateway-side timeout on a stuck job | **Not found** | The dispatch path (`apps/api/src/modules/streaming/transcription-job.controller.ts:289`; `packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts:28`, `:297-302`) fire-and-forgets into Redis. `failJob` is called only when *upload or dispatch itself* throws — the `catch` block at `transcription-job.controller.ts:303`, calling `failJob` at `:307` — never for a job that is accepted and then never picked up. No reaper for stale `QUEUED` rows was found in this investigation. |

Consequence: an operator's only symptom is a job that stays `QUEUED` forever — exactly what
TASK-603's batch tab surfaced. Every health and readiness surface reports green.

### 9. Existing documentation understates or misstates the problem

- `docs/architecture/overview.md:100` claims the worker is started by
  ``` `stt-worker` / `pnpm stt:dev` stack ```. **`pnpm stt:dev` does not start it** (§5), and
  `stt-worker` is a console script that is only on `PATH` if the `stt` package is pip-installed
  into the conda env — it is not a monorepo script. This line should be corrected as part of the
  fix.
- `apps/stt/README.md:299-304` is the only accurate instruction in the repo, and it is a manual
  two-terminal recipe (`# Terminal 2: Start Dramatiq workers` → `python -m stt.worker`), not
  wired into any supported workflow.

### 10. Root cause

**The STT Dramatiq batch worker is a required runtime process whose start path exists only in the
container image (`apps/stt/docker/Dockerfile:284`). The local development surface — root
`package.json`, `scripts/dev-service.sh`, `scripts/dev-stack.sh` — has no target for it, and no
health, readiness, metric, or doctor check reports its absence. A developer therefore runs a stack
that looks complete and green while `dramatiq:stt_batch` has zero consumers; batch jobs are
accepted, persisted as `QUEUED`, and never executed.**

This is a platform/tooling defect, not a defect in the STT worker code or in TASK-603's batch
upload feature — both are correct. TASK-603 merely became the first surface that routinely
exercises the batch path in local development, which is why it surfaced now.

---

## Implementation Plan

Not started. Proposed options, in the order they should be evaluated.

### Option A (recommended) — make the worker a first-class dev target

Mirrors the existing harness-worker precedent exactly, so it needs no new concepts.

1. **`scripts/dev-service.sh`** — add an `stt-worker` target:
   - extend the usage line (`:21`) and the argument matcher (`:146`) to accept `stt-worker`;
   - add a `case` arm alongside `stt)` (`:201`) building the Dramatiq command. Use the container
     command as the reference (`apps/stt/docker/Dockerfile:284`), scaled down for a laptop, and
     keep it consistent with the manual invocation that is known to work:
     `CMD=(dramatiq stt.worker --processes 1 --threads 4)` with `PYTHONPATH=apps/stt/src`.
     Reject `--watch` with the same message the harness worker uses (`:242-245`) — a reload would
     cancel the multi-GB model warm-up.
   - reuse the existing `check_stt_key` preflight (`:71`, applied at `:277`) — the worker calls
     back into the gateway and needs the same key.
   - Naming: `stt-worker` (hyphenated, matching the `stt-worker` console script at
     `apps/stt/pyproject.toml:212`, the Dockerfile stage, and the CI job name) is preferred over
     inventing a new word.
2. **Root `package.json`** — add `"stt:worker:dev": "./scripts/dev-service.sh stt-worker"` next to
   the `stt:*` block (`:85-101`). This matches the `<target>:<action>` taxonomy of
   `01-development-workflow.md` §Script Naming; note it makes `stt` a target with a sub-target, so
   confirm the spelling (`stt:worker:dev` vs a new top-level `stt-worker:dev`) against TASK-557's
   taxonomy before committing.
3. **`scripts/dev-stack.sh`** — add the new name to `DEFAULT_SERVICES` (`:50`) and `ALL_SERVICES`
   (`:51`), give it an empty port in `port_for` (`:53-65`, same as `worker)` at `:63`), and update
   the header comment (`:6-7`). Consider a "refuse to start a second STT worker" preflight only if
   duplicate consumers are actually harmful — unlike the Temporal worker (`:27-28`), multiple
   Dramatiq consumers on one queue are normally fine, so **do not** copy that guard blindly.
4. **`scripts/dev-doctor.sh`** — add an STT-worker check next to the harness one (`:132-139`),
   e.g. `pgrep -f 'dramatiq stt\.worker'`, failing with "start with 'pnpm stt:worker:dev'".

### Option B — supervise the worker from the `stt` target

Have `dev-service.sh stt` spawn both uvicorn and the Dramatiq worker. Rejected on first read:
`dev-service.sh` is explicitly a *single-service* launcher (`:3`), the two processes have very
different memory profiles and restart semantics, and it would break `--watch` scoping. Record the
rejection rather than re-litigating it later.

### Option C — observability (do this regardless of A or B)

A start script fixes today's incident; it does not stop the process dying silently again — which
is precisely what happened to `worker-33830` (§2). At least one of:

1. **Queue-depth-without-consumer signal.** Add a check to `apps/stt/src/stt/health/api/routes.py`
   that reads `LLEN dramatiq:stt_batch` and the freshness of `dramatiq:__heartbeats__`, and reports
   a `batch_worker` component: `healthy` (fresh heartbeat), `degraded` (no heartbeat but queue
   empty), `unhealthy` (no fresh heartbeat **and** queue non-empty). Follow the BUG-010 precedent —
   do **not** let a cold-but-idle system report `unhealthy`, and do **not** gate `/health/ready`
   (`:112`) on it, since the FastAPI app serves streaming traffic independently of the batch worker.
2. **Make the declared worker metrics real.** `WORKER_JOBS_IN_PROGRESS` / `WORKER_JOBS_TOTAL`
   (`apps/stt/src/stt/core/metrics.py:140,145`) have zero call sites and the worker exposes no
   `/metrics`. Either wire them up in `transcribe_file.py` and expose a metrics port from
   `worker.py`, or delete them — a declared-but-dead metric is worse than none.
3. **Stale-`QUEUED` reaper / alert on the gateway side.** A `TranscriptionJob` that has been
   `QUEUED` beyond a threshold with `startedAt IS NULL` is a fault; today nothing notices. Scope
   this against the §2 secondary finding (messages stranded in a dead worker's ack set are, on the
   evidence collected, never redelivered) — investigate Dramatiq's requeue behaviour before
   designing the reaper, so the two fixes do not fight each other.

### Option D — documentation corrections (cheap, do with A)

- Fix `docs/architecture/overview.md:100` — it currently attributes the start to `pnpm stt:dev`,
  which is false.
- Replace the manual two-terminal recipe in `apps/stt/README.md:299-304` with the new script.

### Verification criteria (for whoever implements this)

1. From a clean stack, `pnpm stack:dev` starts a process matching `dramatiq stt.worker`
   (`ps aux` evidence pasted into this README).
2. A batch upload from the compat playground reaches `COMPLETED` with a non-null `workerId` and
   `startedAt` without any manual process start.
3. `pnpm stack:dev:doctor` reports the STT worker, and **fails** when it is killed.
4. With the worker killed and a job submitted, the chosen Option C signal turns non-green within
   its stated window; with the worker running and the queue idle, it stays green (no false alarm).
5. `pnpm lint` / affected package builds green; `scripts/README.md` script table regenerated or
   updated to include the new script.

---

## Implementation Summary

**Option A implemented (first-class `stt-worker` dev target) + Option D (documentation
corrections). Option C (observability) NOT implemented — see "Deliberately not done".**

The STT batch worker now has a supported start path, is part of the supervised dev stack, and its
absence is reported by the doctor. The interim manual workaround below is no longer needed.

### Files changed

| File | Change |
|---|---|
| `scripts/dev-service.sh` | New `stt-worker` target. Header (`:3`) retitled "Python services + workers"; usage line now `<stt\|stt-worker\|smr\|nlp\|guardrail\|harness\|tts\|worker>`; a new `WORKERS` header block documents both portless workers (and `usage()`'s `sed -n '2,43p'` range was bumped to `2,51p` to match the longer header). The argument matcher accepts `stt-worker`. The new `case` arm builds `env PYTHONPATH=apps/stt/src[:$PYTHONPATH] python -m dramatiq stt.worker --processes 1 --threads 4` — the Dockerfile's command shape (`apps/stt/docker/Dockerfile:284`) with `--processes` scaled 2 → 1 for a laptop; `dramatiq` has no equivalent of uvicorn's `--app-dir`, hence the `PYTHONPATH` prefix (relative, as the script `cd`s to the repo root). `--watch` is refused with the same message style as the Temporal-worker arm. The `check_stt_key` preflight and the `--print` masked-key line, previously gated on `stt`, now also cover `stt-worker` (the worker calls back into the gateway with the same key). |
| `scripts/dev-stack.sh` | `stt-worker` added to `DEFAULT_SERVICES` and `ALL_SERVICES`, and to `port_for()` as a portless entry (`echo ""`, like `worker`). Header service list updated. A `BEHAVIOUR` note records that there is deliberately **no** second-instance guard for `stt-worker` (see below). No `set_command_for()` change was needed — the `*)` arm already delegates to `dev-service.sh`. |
| `scripts/dev-doctor.sh` | New required check `stt batch worker process` (`pgrep -f 'dramatiq stt\.worker'`), placed next to the harness-worker check, failing with `start with 'pnpm stt:worker:dev'`. Header updated to name both portless workers. |
| `package.json` | `"stt:worker:dev": "./scripts/dev-service.sh stt-worker"` added to the `STT — Python service` block, directly after `stt:dev:watch`. |
| `scripts/README.md` | `dev-stack.sh`, `dev-service.sh` and `dev-doctor.sh` rows updated; the "Troubleshooting" paragraph now describes both portless workers instead of only the harness one. |
| `docs/architecture/overview.md` | The false claim at `:100` (`` `stt-worker` / `pnpm stt:dev` stack ``) replaced with `pnpm stt:worker:dev` / `pnpm stack:dev` / the Dockerfile `worker` stage, plus an explicit note that it is a separate process from `pnpm stt:dev`. |

### Naming decision (plan step 2 asked for it to be confirmed)

`stt:worker:dev` is correct under the TASK-557 taxonomy in `01-development-workflow.md`
§Script Naming: the shape is `<target>:<action>` with `stt` as the target, and every target
"supports, where applicable" a set of actions — `worker:dev` is an action on the `stt` target,
exactly as `test:cov` and `lint:fix` are. A new top-level `stt-worker:dev` target was rejected: it
would add a second target name for one app and split `stt`'s block in the script list. The
`dev-service.sh` argument keeps the hyphenated `stt-worker` spelling, which matches the console
script (`apps/stt/pyproject.toml:212`), the Dockerfile stage, and the CI job name.

### No duplicate-worker guard (plan step 3)

`dev-stack.sh` refuses to start a second harness Temporal worker. That guard is **not** replicated
for `stt-worker`, for two reasons: parallel Dramatiq consumers on one queue are the normal scaling
mode (the plan says not to copy the guard blindly), and the refusal logic lives in
`scripts/lib/stack-supervisor.sh:136-139`, which is outside this change's file scope. A developer
who already started a worker by hand should start a subset (`pnpm stack:dev -- api stt smr ...`).
Documented in the `dev-stack.sh` header.

### Verification (2026-08-03)

Syntax check on every edited script:

```
$ for f in scripts/dev-service.sh scripts/dev-stack.sh scripts/dev-doctor.sh; do printf '%-28s ' "$f"; bash -n "$f" && echo "syntax OK"; done
scripts/dev-service.sh       syntax OK
scripts/dev-stack.sh         syntax OK
scripts/dev-doctor.sh        syntax OK
```

`package.json` still parses, and the script resolves:

```
$ node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json: valid JSON')"
package.json: valid JSON
$ node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('stt:worker:dev =', p.scripts['stt:worker:dev'])"
stt:worker:dev = ./scripts/dev-service.sh stt-worker
```

The new target's dry run — note the command shape matches `apps/stt/docker/Dockerfile:284`
(`python -m dramatiq stt.worker --processes N --threads N`), and `--watch` is refused:

```
$ ./scripts/dev-service.sh stt-worker --print
service: stt-worker
process shape (user env > these defaults); everything else comes from
the service's own loader: host env > .env.<NODE_ENV> > pydantic default
  PYTHONPATH=apps/stt/src
  API_GATEWAY_KEY=<masked> (from .env.dev or apps/stt/.env — run --check-stt-key)
command:
  conda run -n arcaenv --no-capture-output env PYTHONPATH=apps/stt/src python -m dramatiq stt.worker --processes 1 --threads 4

$ ./scripts/dev-service.sh stt-worker --watch --print
--watch is not supported for the STT batch worker; ignoring.
service: stt-worker
...
  conda run -n arcaenv --no-capture-output env PYTHONPATH=apps/stt/src python -m dramatiq stt.worker --processes 1 --threads 4

$ grep -n 'CMD \["python3.11", "-m", "dramatiq"' apps/stt/docker/Dockerfile
284:CMD ["python3.11", "-m", "dramatiq", "stt.worker", "--processes", "2", "--threads", "4"]
```

Both halves of that command line resolve inside `arcaenv` (import-spec lookup only — no worker
started; `python -m dramatiq` and the `dramatiq` console script share one entrypoint,
`dramatiq.cli.main`):

```
$ env PYTHONPATH=apps/stt/src /Users/taphuynh/miniconda3/envs/arcaenv/bin/python -c "…find_spec…"
stt.worker  -> /Users/…/hope-v2/apps/stt/src/stt/worker.py
dramatiq -m -> /Users/…/envs/arcaenv/lib/python3.11/site-packages/dramatiq/__main__.py
```

The stack plan now contains the worker (nothing started — `DRY_RUN=1`), and unknown targets are
still rejected:

```
$ DRY_RUN=1 ./scripts/dev-stack.sh
stack:dev plan (DRY_RUN=1 — nothing started):
  infra: ./scripts/dev-infra.sh up
  api        8868   pnpm api:dev
  stt        8861   …/scripts/dev-service.sh stt
  stt-worker —      …/scripts/dev-service.sh stt-worker
  smr        8862   …/scripts/dev-service.sh smr
  guardrail  8863   …/scripts/dev-service.sh guardrail
  nlp        8864   …/scripts/dev-service.sh nlp
  harness    8866   …/scripts/dev-service.sh harness
  worker     —      …/scripts/dev-service.sh worker
  admin      5176   pnpm admin:dev

$ DRY_RUN=1 ./scripts/dev-stack.sh stt-worker
  stt-worker —      …/scripts/dev-service.sh stt-worker

$ ./scripts/dev-service.sh stt-workerx --print   # exit=2
Unknown argument: stt-workerx
```

`pnpm stack:dev:doctor` (read-only) now reports the worker — this run detected the
hand-started worker from §2 (the conda wrapper pid 42448 + the dramatiq process pid 42466, hence
"2 matching process(es)"):

```
$ ./scripts/dev-doctor.sh
…
PASS   smr providers registered           anthropic azure azure-openai bedrock llama-cpp lm-studio ollama openai openai_compat vertex vllm
FAIL   harness worker process             not running — start with 'pnpm worker:dev'
PASS   stt batch worker process           2 matching process(es)
── Preflight ──
PASS   stt API_GATEWAY_KEY                STT key preflight OK (source: …/.env.dev, value not shown)
4 required check(s) failed, 1 optional warning(s).     # exit 1
```

The other four failures (`lm-studio`, `nlp (8864)`, `harness (8866)`, `harness worker process`) are
pre-existing state of this machine — those processes were simply not running — and are unrelated to
this change. The failure branch of the new check was exercised without killing the live worker, by
running the same expression against a pattern that matches nothing:

```
FAIL   stt batch worker process   not running — start with 'pnpm stt:worker:dev' (batch jobs would stay QUEUED)
```

`shellcheck -S warning` on the three scripts reports only pre-existing findings
(`dev-stack.sh` SC2034 ×3 for `GREEN`/`YELLOW`/`STACK_NAME`, all consumed by the sourced
supervisor library, and `dev-doctor.sh:24` SC2164) — no new warning from any edited line.
`pnpm lint` was not run: this change touches no TypeScript.

### Deliberately not done

- **Did not start or restart anything.** One worker (pid 42466) was already running from the §2
  manual workaround, and `api`/`stt`/`smr` were in use; starting a second consumer or bouncing a
  service was explicitly out of bounds for this session. Every check above is therefore
  dry-run/`--print`/read-only.
- **Verification criteria 1 and 2 remain open for the owner** — that a clean `pnpm stack:dev`
  spawns a matching `dramatiq stt.worker`, and that a playground batch upload reaches `COMPLETED`
  with non-null `workerId`/`startedAt` with no manual start. Both require stopping the existing
  hand-started worker first. Criterion 3 is half-proven (doctor reports the worker; the failing
  branch was simulated, not produced by killing it). This is why the status is `Review`.
- **Option C (observability) not implemented** — criterion 4 is therefore untouched. A start script
  does not stop the process from dying silently again, which is what happened to `worker-33830`;
  Option C should be scoped as its own ticket (it changes `apps/stt` source, outside this change's
  file scope).
- **`apps/stt/README.md:299-304` left as-is** (the manual two-terminal recipe). It is accurate, and
  the file was outside the agreed file scope; fold it into the Option C ticket.
- The §2 secondary finding (messages stranded in a dead worker's ack set are not redelivered) is
  **not** addressed here and still stands: pre-existing `QUEUED` rows must be re-submitted.

### Superseded workaround (kept for history)

```bash
conda run -n arcaenv --no-capture-output \
  env NODE_ENV=development PYTHONPATH=apps/stt/src \
  dramatiq stt.worker --processes 1 --threads 4
```

Now replaced by `pnpm stt:worker:dev`.

---

## Change History

| Date | Author | Change |
|---|---|---|
| 2026-08-03 | Claude (implementation) | **Option A + D implemented.** `scripts/dev-service.sh` gained an `stt-worker` target (usage line, argument matcher, `WORKERS` header block with the `usage()` `sed` range bumped `2,43p` → `2,51p`, and a `case` arm running `env PYTHONPATH=apps/stt/src python -m dramatiq stt.worker --processes 1 --threads 4` — the `apps/stt/docker/Dockerfile:284` shape with `--processes` 2 → 1; `--watch` refused like the Temporal-worker arm; `check_stt_key` + the `--print` masked-key line extended to it). `scripts/dev-stack.sh`: `stt-worker` added to `DEFAULT_SERVICES`/`ALL_SERVICES` and to `port_for()` as portless, header updated, and a note recording that NO second-instance guard is added (parallel Dramatiq consumers are legitimate, and the guard lives in the out-of-scope `lib/stack-supervisor.sh`). `scripts/dev-doctor.sh`: new required `stt batch worker process` check (`pgrep -f 'dramatiq stt\.worker'`). Root `package.json`: `"stt:worker:dev": "./scripts/dev-service.sh stt-worker"` (taxonomy decision recorded in the Implementation Summary). Docs corrected: `docs/architecture/overview.md:100` no longer claims `pnpm stt:dev` starts the worker; `scripts/README.md` rows for the three scripts and the troubleshooting paragraph updated. Verified by `bash -n` ×3, `--print`/`DRY_RUN=1` dry runs (command line matches the Dockerfile), module-spec resolution in `arcaenv`, `node -e JSON.parse` on `package.json`, and a live read-only `./scripts/dev-doctor.sh` run showing `PASS stt batch worker process — 2 matching process(es)`. Status `Review`, not `Completed`: nothing was started or restarted this session (a hand-started worker and `api`/`stt`/`smr` were in use), so verification criteria 1–2 (clean `stack:dev` spawn; end-to-end batch job to `COMPLETED`) and 4 (Option C signal) remain open. Option C and `apps/stt/README.md:299-304` deliberately deferred to a follow-up ticket. |
| 2026-08-03 | Claude (diagnosis) | Ticket created. Discovered during compat-playground (`:5177`) batch-upload E2E testing of TASK-603: uploaded jobs were accepted by the gateway and persisted as `QUEUED` but never executed (`progress=0`, `startedAt=NULL`, `workerId=NULL`, >10 min). Traced to the STT Dramatiq batch worker being a separate required process (`apps/stt/src/stt/worker.py:149`, actor at `apps/stt/src/stt/transcription/workers/transcribe_file.py:32-38`) with **no local-dev start path**: root `package.json` has no such script (its only `worker:dev`, `:191`, is the harness Temporal worker per the section header at `:190`), `scripts/dev-service.sh` accepts no `stt-worker` target (`:21`, `:146`; `worker)` at `:239-246` is `harness.temporal.worker`), and `scripts/dev-stack.sh` cannot supervise it (`:50-51`). Only `apps/stt/docker/Dockerfile:284` knows the start command. Confirmed **no** health, readiness, metric, or doctor signal reports the missing consumer (`apps/stt/src/stt/health/api/routes.py:52-75,112`; `apps/stt/src/stt/core/metrics.py:140,145` declared with zero call sites and no worker `/metrics`; `scripts/dev-doctor.sh:132-139` checks only the harness worker). Live Redis/Postgres evidence captured; state re-verified at 14:10 UTC after a manual worker start, including a secondary finding that 5 messages stranded in a dead worker's ack set were not redelivered. Status `Pending`; no code changed. |
