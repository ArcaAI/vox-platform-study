# TASK-346: Local Dev Service Scripts

- **Ticket**: TASK-346
- **Created**: 2026-06-10
- **Updated**: 2026-06-10
- **Status**: Completed
- **Type**: infrastructure

## Requirement Analysis

### Description

Review and improve the root pnpm scripts so the full local stack (clinical
workspace) can be brought up reliably for development and local testing.
Codify the operationally-proven service invocations discovered during the
2026-06-09/10 live-SOAP debugging sessions into first-class scripts.

### Business Context

A live mic test repeatedly failed for infrastructure reasons, not code
reasons. Each failure burned debugging time because the existing `dev:*`
scripts start services in misconfigured or fragile ways:

1. **SMR (:8862)** — `pnpm dev:smr-v2` starts SMR with **no LLM provider
   registered** (root `.env` has `SMR_V2_OLLAMA_ENABLED=false` and no
   `SMR_V2_OPENAI_COMPAT_*` keys; Python services do *not* read `.env.dev`,
   which is where the correct values live). Every `/api/v1/generate` then
   404s ("Provider 'lm-studio' not found") and live summaries silently die.
2. **STT (:8861)** — STT reads `API_GATEWAY_KEY` from gitignored
   `apps/stt-v2/.env`. A placeholder line whose inline comment was parsed
   *as the value* caused all internal calls to 401. Additionally, the
   `--reload` watcher in `dev:stt-v2` watches the **whole repo** (uvicorn
   default reload dir = cwd), so unrelated file churn kept cancelling STT's
   ~4 GB Cadence model warm-up.
3. **Harness Temporal worker** — `py:harness:worker` exists but starts the
   worker *bare*, inheriting stale values from gitignored
   `apps/harness/.env` (SMR base URL `:8872` — a dead port — provider
   `ollama`, retrieval `true`). The worker was instead started manually
   with inline env and silently died twice, stalling all SOAP drafts.
4. **No aggregate bring-up** — no single command starts the clinical
   workspace stack (API :8868, STT :8861, SMR :8862, NLP :8864, harness
   :8866, harness worker, UI :5175), and no infra wrapper starts the
   Temporal docker profile that the harness requires (`docker:dev:up:all`
   only activates the `vault` profile).
5. **No doctor command** — "why is X broken" was repeatedly answered by "a
   service was dead / wrong env". No script checks ports, docker
   containers, LM Studio/Ollama reachability, or the STT key.

### Acceptance Criteria

- [x] Each service has a `dev:*` script whose default behaviour equals the
      proven-working invocation (right env defaults, overridable).
- [x] The harness Temporal worker has a first-class script.
- [x] One command starts the full clinical-workspace stack; it refuses to
      double-start services whose ports are already bound.
- [x] `infra:up`/`infra:down` wrappers include the Temporal profile.
- [x] `dev:doctor` checks all service ports/health endpoints, docker
      containers, LM Studio/Ollama, Temporal, the harness worker process,
      and the STT key (placeholder detection) — without printing secrets.
- [x] Machine-specific values (LM Studio model name) are overridable via
      env; no new secrets are committed.
- [x] Verification is non-disruptive to the currently-running stack.

## Current State Evaluation

### Existing scripts (root `package.json`)

| Script | State | Problem |
|---|---|---|
| `dev:api`, `dev:api:watch`, `dev:api:test` | Working | None — kept as-is |
| `dev:ui-playground` | Working | None — kept as-is |
| `dev:stt-v2` | Broken-ish | Repo-wide `--reload` cancels 4 GB model warm-up; no key preflight |
| `dev:smr-v2` | Broken | No provider env → 0 providers registered; repo-wide `--reload` |
| `dev:nlp` | Fragile | Repo-wide `--reload` churns heavy HF model loads |
| `dev:guardrail` | OK-ish | Repo-wide `--reload`; config defaults otherwise fine |
| `dev:harness` / `py:harness:dev` | Duplicate + fragile | Repo-wide `--reload`; inherits stale `apps/harness/.env` values |
| `py:harness:worker` | Foot-gun | Bare start inherits stale `apps/harness/.env` (SMR `:8872`, provider `ollama`, retrieval `true`) |
| Aggregate bring-up | Missing | — |
| `docker:dev:up[:all]` | Partial | Never starts the `temporal` profile the harness needs |
| Doctor/health | Missing | — |
| `test:*` / `test:{api,stt-v2,smr-v2,nlp}:up` | Working | No harness/worker/guardrail test bring-up (gap documented, out of scope) |

### Env-loading facts that shaped the design

- Node apps load `.env.dev`/`.env.test` via `packages/database/src/env.ts`
  (NODE_ENV-mapped) or `dotenv -e`.
- Python services do **not** read `.env.dev`. SMR/harness walk up loading
  plain `.env` files (app-level overrides root; explicit env always wins).
  STT reads only `apps/stt-v2/.env` via pydantic `env_file`. NLP reads
  `PORT`/`NLP_*`. Guardrail reads `GUARDRAIL_*`.
- Therefore: the only deterministic, file-state-independent way to encode
  "the proven invocation" is **explicit env vars set by the launcher**,
  applied with `: "${VAR:=default}"` so the user's shell env still wins.
- `uvicorn --reload` with no `--reload-dir` watches the **cwd** (repo
  root) — the root cause of warm-up cancellation. Watch variants must
  scope the watcher to the service's own `src`.
- The dev seed service-account key (a committed dev fixture) lives in
  `packages/database/src/prisma/db_main/seed/00-constants.ts`
  (`API_KEYS.SERVICE_ACCOUNT`). Scripts reference its *location*, never
  its value.

### Live-stack snapshot at implementation time (2026-06-10)

API :8868, STT :8861, SMR :8862, NLP :8864, harness :8866, worker, UI
:5175 all up (must not be disturbed); guardrail :8863 down; LM Studio
:1234 and Ollama :11434 up; docker: hope-postgres/redis/minio/vault/
qdrant/temporal(+ui)/reranker up, plus the `*-test` containers.

## Implementation Plan

### Design decisions

1. **Launcher script, not inline package.json env** — per-service defaults
   live in `scripts/dev-service.sh` (bash, matching the existing
   `scripts/start-*.sh` convention). package.json scripts stay one-liners.
   Defaults are applied with `: "${VAR:=default}"` → precedence is
   *user env > script default*; script defaults intentionally override
   stale gitignored app `.env` files because explicit env beats `env_file`
   in every service's config loader (that is the whole point: deterministic
   startup regardless of local file drift).
2. **No-reload is the default for all Python services**; `:watch` variants
   add `--reload --reload-dir apps/<svc>/src` (scoped → unrelated churn no
   longer restarts services). Defaults now equal the proven invocations
   currently running (none of which use reload).
3. **Machine-specific model name** — single knob `LM_STUDIO_MODEL`
   (default `gemma-4-e4b-it-qat`) feeds both
   `SMR_V2_OPENAI_COMPAT_DEFAULT_MODEL` and `HARNESS_SMR_MODEL`; each is
   also individually overridable.
4. **STT key preflight** — fail fast (clear remediation message, no value
   printed) when neither env nor `apps/stt-v2/.env` provides a plausible
   `API_GATEWAY_KEY` (empty / inline-comment / placeholder detection).
   Reused by `dev:doctor` via `dev-service.sh --check-stt-key`.
5. **Aggregate runner = plain bash supervisor** (`scripts/dev-stack.sh`):
   no new dependency (`concurrently` is not in the workspace and adding a
   dep for this is unnecessary). Spawns each service via `dev-service.sh`,
   logs to `/tmp/hope-dev-logs/<svc>.log`, tails all logs in the
   foreground, kills the spawned process *trees* on exit (conda run
   wrappers included), and **refuses** to start anything whose port is
   already bound (protects a running stack; `dev:doctor` tells you what's
   up). Worker double-start is prevented via pgrep.
6. **Infra wrapper** (`scripts/dev-infra.sh`) — compose up/down/status/logs
   including the `vault` **and** `temporal` profiles (the existing
   `docker:dev:up:all` path stays untouched for backwards compatibility).
   `--rag` opts into the reranker profile.
7. **Doctor** (`scripts/dev-doctor.sh`) — read-only probes: docker
   container state, TCP/HTTP health per service, SMR **provider-registered**
   check (catches "up but useless"), harness worker process, LM
   Studio/Ollama, Temporal TCP, STT key preflight. Exit 1 if a required
   check fails (required set = clinical workspace + postgres/redis/
   temporal/LM Studio; guardrail/ollama/vault/qdrant/minio/reranker are
   informational).
8. **DRY_RUN/--print mode** on the launcher prints resolved env + the exact
   command without spawning — used both for non-disruptive verification of
   scripts whose services are live, and as documentation.

### Files

| File | Action |
|---|---|
| `scripts/dev-service.sh` | NEW — single-service launcher (env defaults, preflight, --print, --watch) |
| `scripts/dev-stack.sh` | NEW — aggregate supervisor |
| `scripts/dev-infra.sh` | NEW — compose wrapper incl. temporal profile |
| `scripts/dev-doctor.sh` | NEW — health/doctor checks |
| `package.json` (root) | EDIT — rewire `dev:*` Python scripts; add `dev:harness:worker`, `dev:stack`, `dev:doctor`, `infra:*`, `:watch` variants |
| `README.md` (root) | EDIT — add new commands to the Common Commands table |
| `docs/implementation/TASK-346-Local-Dev-Service-Scripts/README.md` | NEW — this document |

### Script catalogue (quick reference)

| Command | Starts | Port | Key env knobs (default) |
|---|---|---|---|
| `pnpm dev:api` | API gateway (NestJS, watch) | 8868 | unchanged (`.env.dev` via env.ts) |
| `pnpm dev:ui-playground` | UI playground (Vite) | 5175 | unchanged |
| `pnpm dev:stt-v2` | STT v2, **no reload** | 8861 | `STT_PORT`; key preflight on `API_GATEWAY_KEY` (from `apps/stt-v2/.env` or env) |
| `pnpm dev:stt-v2:watch` | STT v2, reload scoped to `apps/stt-v2/src` | 8861 | same |
| `pnpm dev:smr-v2` | SMR v2, **no reload**, LM Studio provider registered | 8862 | `SMR_PORT`; `SMR_V2_OPENAI_COMPAT_ENABLED` (true), `SMR_V2_OPENAI_COMPAT_BASE_URL` (`http://localhost:1234/v1`), `SMR_V2_OPENAI_COMPAT_DEFAULT_MODEL` (`$LM_STUDIO_MODEL` → `gemma-4-e4b-it-qat`), `SMR_V2_EXTERNAL_GUARDRAIL_ENABLED` (false) |
| `pnpm dev:smr-v2:watch` | SMR v2, scoped reload | 8862 | same |
| `pnpm dev:nlp` | NLP, **no reload** | 8864 | `NLP_PORT` |
| `pnpm dev:nlp:watch` | NLP, scoped reload | 8864 | same |
| `pnpm dev:guardrail` | Guardrail, **no reload** | 8863 | `GUARDRAIL_PORT`; engine defaults from `GUARDRAIL_V2_*` (LM Studio :1234) |
| `pnpm dev:guardrail:watch` | Guardrail, scoped reload | 8863 | same |
| `pnpm dev:harness` | Harness FastAPI, **no reload** | 8866 | `HARNESS_PORT`; `HARNESS_SMR_BASE_URL` (`http://localhost:8862`), `HARNESS_NLP_BASE_URL` (`http://localhost:8864`), `HARNESS_API_BASE_URL` (`http://localhost:8868`), `HARNESS_SMR_PROVIDER` (`lm-studio`), `HARNESS_SMR_MODEL` (`$LM_STUDIO_MODEL`), `HARNESS_RETRIEVAL_ENABLED` (false) |
| `pnpm dev:harness:watch` | Harness FastAPI, scoped reload | 8866 | same |
| `pnpm dev:harness:worker` | Harness Temporal worker (queue `harness-task-queue`) | — | same harness knobs + `TEMPORAL_ADDRESS` (`localhost:7233` via config/app `.env`) |
| `pnpm dev:stack` | All eight: api, stt, smr, guardrail, nlp, harness, worker, ui | all | `pnpm dev:stack -- smr worker` for a subset (guardrail included by default — the admin console monitors it) |
| `pnpm dev:doctor` | nothing (read-only checks) | — | exit 1 on required-check failure |
| `pnpm infra:up` / `infra:down` / `infra:status` / `infra:logs` | Docker infra incl. vault+temporal profiles | — | `--rag` for the reranker |
| `DRY_RUN=1 pnpm dev:<svc>` | nothing — prints resolved env + command | — | works for every launcher-based script |

### Verification criteria (non-disruptive — live stack must keep running)

1. `bash -n` on all new scripts.
2. `pnpm dev:doctor` against the live stack → all required checks green.
3. `--print` output for stt/smr/nlp/harness/worker is command-identical to
   the proven invocations currently running (equivalence evidence).
4. Guardrail (currently down): full start → health 200 → clean stop.
5. SMR script: full start on `SMR_PORT=18862` → `/api/v1/providers`
   non-empty → clean stop (proves provider registration end-to-end).
6. Harness FastAPI script: full start on `HARNESS_PORT=18866` → health 200
   → clean stop.
7. `dev:stack` refusal path: with the stack live, it must refuse and list
   bound ports (exit 1) without touching anything.
8. STT key preflight: simulated placeholder file → FAIL with remediation;
   real file → PASS (no value printed).
9. STT/NLP/worker scripts: dry-run validation only (model warm-up cost /
   Temporal queue-consumption risk; documented as validated-by-equivalence).

## Implementation Summary

- **New scripts**: `scripts/dev-service.sh` (launcher: env defaults,
  STT-key preflight, `--print`/`DRY_RUN`, `--watch` scoped reload, PORT
  overrides), `scripts/dev-stack.sh` (aggregate supervisor with port-guard
  refusal, per-service logs under `/tmp/hope-dev-logs`, process-tree
  cleanup), `scripts/dev-doctor.sh` (read-only health/doctor incl. SMR
  provider check, worker pgrep, STT key preflight), `scripts/dev-infra.sh`
  (compose wrapper incl. `vault`+`temporal` profiles, `--rag` opt-in,
  `--print`).
- **package.json**: `dev:stt-v2|smr-v2|nlp|guardrail|harness` rewired to
  the launcher (no-reload defaults) + `:watch` variants; new
  `dev:harness:worker`, `dev:stack`, `dev:doctor`, `infra:up|down|status|logs`;
  `py:harness:dev`/`py:harness:worker` repointed to the launcher so the
  stale-`apps/harness/.env` foot-gun is gone.
- **README.md**: Key Commands table extended (stack/doctor/worker/infra
  rows; SMR/STT rows annotated).
- **No DB, no .env value edits, no new secrets.** `apps/harness/.env`
  staleness left in place (explicit env now wins deterministically);
  documented here. Note `pnpm dev:guardrail` route check: guardrail mounts
  health at `/api/health` (no version segment), unlike the other services.
- **Deferred / known gaps**: test-mode bring-up for harness FastAPI +
  worker + guardrail (`test:harness:up` etc.) does not exist; Playwright
  e2e currently provisions only API/STT/SMR/NLP via `test:*:up`. Large
  enough to be its own ticket — documented, not built.

### Verification evidence (2026-06-10, against the live stack)

| Script | Method | Result |
|---|---|---|
| `dev:doctor` | Full run against live stack (twice) | exit 0; all required PASS; with guardrail temporarily up: **0 warnings** |
| `dev:smr-v2` | **Full start-verify** on `SMR_PORT=18862` | `smr_v2.started` with `"providers": ["lm-studio", "openai_compat"]`; `/api/v1/health` 200; `/api/v1/providers` non-empty; clean stop |
| `dev:harness` | **Full start-verify** on `HARNESS_PORT=18866` | `harness.temporal_connected` + health 200; clean stop |
| `dev:guardrail` | **Full start-verify** on its real port :8863 (was down) | provider `lm-studio` initialized, `/api/health` 200; clean stop |
| `dev:stt-v2` | Validated-by-equivalence (`--print`) | resolved command string-identical to the proven running invocation (no reload); key preflight PASS on real file, FAIL+remediation on simulated placeholder/empty (no value printed) |
| `dev:harness:worker` | Validated-by-equivalence (`--print`) | env+command identical to the proven running worker (plus `HARNESS_API_BASE_URL` = config default); not started to avoid a second consumer on `harness-task-queue` |
| `dev:nlp` | Validated-by-equivalence (`--print`) | identical to the proven invocation minus repo-wide `--reload` (intentional); not started to avoid duplicate HF model load during the live test |
| `dev:stack` | DRY_RUN plan (full + subset + pnpm `--` pass-through) and **refusal path** against live stack | refused with all 7 services listed (busy ports + existing worker), exit 1; nothing touched |
| `infra:*` | `dev-infra.sh up --print` + `status` (read-only) | correct compose command incl. `--profile vault --profile temporal`; `up`/`down` not executed against the user's running infra |
| All scripts | `bash -n`, ReadLints, `node JSON.parse(package.json)` | clean |

Post-verification: alternate-port instances and guardrail stopped; ports
8863/18862/18866 free; live stack (8861/8862/8864/8866/8868/5175 + worker)
untouched and re-verified green.

## Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-10 | Initial implementation of TASK-346 | scripts/dev-service.sh, scripts/dev-stack.sh, scripts/dev-doctor.sh, scripts/dev-infra.sh, package.json, README.md |
| 2026-06-10 | Guardrail added to the `dev:stack` DEFAULT set — first live `dev:stack` run left :8863 down and the admin console flagged it; the console monitors guardrail, so the default stack must include it. Subsets can still omit it. | scripts/dev-stack.sh, README.md |
