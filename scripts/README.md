# Operational Scripts

Introduced: 2026-07-04 · Last verified: 2026-07-25 (TASK-557)

Shell and Python scripts that bootstrap, run, verify, and exercise the HOPE development, test, and staging environments. Most scripts are wired to root `package.json` aliases — prefer the `pnpm` form so you always run from the repo root with the right env files.

All scripts are safe to read before running; each has a usage header. Paths below are relative to the repo root.

## Script naming (TASK-557)

Root `package.json` uses one taxonomy, with no legacy aliases:

| Shape                     | Meaning                              | Examples                                                                     |
| ------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| `<target>:<action>`       | one app / service / worker / package | `api:dev`, `stt:test:cov`, `harness:lint`, `admin:build`, `worker:dev`       |
| `<domain>:<action>`       | cross-cutting concern                | `db:migrate`, `gen:model`, `build:apps`, `lint:all`, `clean:cache`           |
| `<domain>:<env>:<action>` | concern split by environment         | `infra:dev:up`, `infra:test:validate`, `stack:dev:doctor`, `stack:test:down` |

Targets: `api`, `admin`, `ui`, `sdk`, `stt`, `text`, `nlp`, `guardrail`, `harness`, `tts`, `worker`.
Every target supports the same verbs where they apply: `setup` (+`:cpu`/`:apple`/`:gpu` for Python), `dev`, `dev:watch`, `build`, `test` (+`:unit`/`:integration`/`:e2e`/`:cov`/`:managed`), `lint`, `lint:fix`, `typecheck`, `format`, `format:check`, `clean`.

### Ports — DEV and TEST are fully independent

TEST application ports are **DEV + 100**, so both stacks can run at the same time:

|          | api  | stt  | text | guardrail | nlp  | tts  | harness | admin | inspector |
| -------- | ---- | ---- | ---- | --------- | ---- | ---- | ------- | ----- | --------- |
| **dev**  | 8868 | 8861 | 8862 | 8863      | 8864 | 8865 | 8866    | 5176  | 9229      |
| **test** | 8968 | 8961 | 8962 | 8963      | 8964 | 8965 | 8966    | 5276  | 9329      |

Infra ports already differed: Postgres 5432/5433, Redis 6379/6380, MinIO 9000/9002, Qdrant 6333/6335.

Every script reads these from `.env.test` rather than hardcoding them, and `pnpm stack:test:doctor` fails if any test port has drifted back onto its dev counterpart — that drift is what would let a suite silently hit the DEV database.

## Prerequisites

- Node.js >= 22, pnpm, Docker + Docker Compose
- conda with the shared `arcaenv` environment (Python 3.11) for anything that starts a Python service — create it with `pnpm setup:python`
- `.env` (Docker Compose, generated), `.env.sample` (tracked template, TASK-583), `.env.dev` (dev API, gitignored, created from `.env.sample` by `pnpm setup:dev`), `.env.test` (test stack, gitignored, created from `.env.sample` by `pnpm setup:test`) at the repo root

## Development environment

| Script                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Key env vars / flags                                                                                                                                                                    | pnpm alias                                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev-setup.sh`            | One-command dev bootstrap: creates `.env.dev` from `.env.sample` if missing (TASK-583), infra up (core + vault + temporal + rag), wait for Postgres/Vault, `pnpm db:all` (migrate + seed), refresh Vault AppRole creds in `.env.dev`, bootstrap Vault dynamic DB creds. Idempotent — safe on a completely fresh clone. `-o` / `-e` add observability / inference tiers.                                                                                                                                                                                                                              | `PG_CONTAINER`, `VAULT_CONTAINER`, reads `VAULT_DEV_ROOT_TOKEN` / `POSTGRES_USER` from `.env.dev`; flags: `-o/--observability`, `-e/--inference`                                        | `pnpm setup:dev` / `dev:setup-o` / `dev:setup-e`                                                                                                                                                                                 |
| `generate-env-file.sh`    | Shared helper (TASK-583): `ensure_env_file <target> <dev\|test>` copies `.env.sample` to `<target>` only if it doesn't already exist (never overwrites real local config), applying test-specific port/endpoint overrides for `mode=test`. Sourced by `dev-setup.sh` and `test-setup.sh`; also runnable standalone.                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                                       | — (sourced by `dev-setup.sh` / `test-setup.sh`; standalone: `./scripts/generate-env-file.sh .env.dev dev`)                                                                                                                       |
| `dev-infra.sh`            | The ONLY dev-infra entrypoint (TASK-555 tiers). Default `up`: `vault` + `temporal` + `rag`. `-o/--observability` adds Prometheus/Grafana; `-e/--inference` adds vLLM/llama.cpp/TEI embed. `down`/`status`/`logs` always use the full known profile set so nothing lingers; `down` also tears down the legacy `hope-infra` compose project. `validate` health-probes containers + Postgres/Redis. Apple Silicon auto-selects TEI arm64 images when unset. `up` also RECONCILES Vault with `.env.dev` (AppRole creds + kv-v2 secrets) — the dev Vault's storage is in-memory, so recreating the container resets kv to `dev-init.sh`'s placeholders and every internal hop 401s at request time; `SKIP_VAULT_RECONCILE=1` opts out (what `dev-setup.sh` does, since it runs those steps itself).                                                                                                                                             | flags: `up\|down\|restart\|status\|logs\|validate`, `-o/--observability`, `-e/--inference`, `--rag` (no-op), `--print`                                                                  | `pnpm infra:dev:up` / `infra:dev:down` / `infra:dev:restart` / `infra:dev:status` / `infra:dev:logs` / `infra:dev:validate` / `infra:dev:up:observability` / `infra:dev:up:inference`                                            |
| `temporal-volume-hop.sh`  | TASK-702 print-only Temporal hop runbook. If `hope-temporal` fails on a leftover auto-setup 1.29.x DB, prints the 1.30.4 then 1.31.2 commands. Never starts/stops containers, never passes `-v`, never runs `DELETE`/`DROP`/`TRUNCATE`.                                                                                                                                                                                                                                                                                                                                                                 | print-only; no flags                                                                                                                                                                    | `pnpm infra:dev:temporal-hop`                                                                                                                                                                                                |
| `temporal-terminate-orphans.sh` | Terminates every RUNNING Temporal workflow in the dev namespace. Temporal's history lives in its own `temporal`/`temporal_visibility` DBs inside `hope-postgres`, which `pnpm db:all --force-reset` does NOT touch — so a DB reset leaves open workflows retrying against deleted rows forever. Chained onto the tail of `pnpm db:all`, so every reset path (`pnpm db:all`, `pnpm setup:dev`) cleans up after itself; the alias below is for running it standalone. No-op when Temporal is down or nothing is running; refuses under `NODE_ENV=production`. | `--dry-run`, `--reason "..."` (pass flags to the script directly — `pnpm ... -- --dry-run` swallows the `--`) | `pnpm infra:dev:temporal-terminate-orphans` |
| `dev-stack.sh`            | DEV app-stack supervisor. Ensures Docker infra is up first (`dev-infra.sh up`, optional `-o`/`-e`), then starts default apps: api (8868), stt (8861), stt-worker (Dramatiq batch queue, no port), text (8862), guardrail (8863), nlp (8864), harness (8866), Temporal worker, admin console (5176); tails logs; Ctrl-C stops apps (infra stays). `ALL_SERVICES` also offers `tts` (8865). Refuses busy ports / second Temporal worker (deliberately NOT a second `stt-worker` — parallel Dramatiq consumers are legitimate). `down` stops pidfile orphans only. Supervisor logic is shared with `test-stack.sh` via `lib/stack-supervisor.sh`.                                                                                          | `DRY_RUN=1`, `HOPE_DEV_STATE_DIR`, `HOPE_DEV_LOG_DIR`, per-service `*_PORT`; flags: `-o/--observability`, `-e/--inference`                                                              | `pnpm stack:dev` / `stack:dev:observability` / `stack:dev:inference` (subset: `pnpm stack:dev -- text worker`; stop: `pnpm stack:dev:down`)                                                                                       |
| `lib/stack-supervisor.sh` | Shared process supervisor **library** (state dirs, pidfiles with pid-reuse fingerprints, kill trees, cleanup trap, log tailing). Sourced by `dev-stack.sh` and `test-stack.sh`; state is namespaced per stack so `stack:dev:down` can never kill test services. Not executable directly.                                                                                                                                                                                                                                                                                                             | contract: `STACK_NAME`, `SCRIPT_DIR`, `REPO_ROOT`, `set_command_for()`, `port_for()`                                                                                                    | —                                                                                                                                                                                                                                |
| `dev-service.sh`          | Single Python service launcher. Since TASK-558 it supplies only LAUNCH concerns — conda `arcaenv`, loopback bind, per-service port overrides — plus the machine-specific LM Studio model pairing (`LM_STUDIO_MODEL` → `TEXT_OPENAI_COMPAT_DEFAULT_MODEL` / `HARNESS_TEXT_MODEL`). Application config is NO LONGER baked in here: services read `.env.dev` themselves via `packages/py-env`, so adding a `: "${VAR:=default}"` for app config would silently outrank the env file. `worker` runs the harness Temporal worker; `stt-worker` runs the STT Dramatiq batch consumer (`dramatiq stt.worker`, `PYTHONPATH=apps/stt/src`) — a separate process from `stt`, without which batch jobs stay `QUEUED` (BUG-011). Neither worker supports `--watch`. Also the launch backend for the TEST environment via `start-test-app.sh`. | `CONDA_ENV`, `HOST` (default 127.0.0.1), `LM_STUDIO_MODEL`, `STT_PORT`/`TEXT_PORT`/`GUARDRAIL_PORT`/`NLP_PORT`/`HARNESS_PORT`/`TTS_PORT`; flags: `--watch`, `--print`, `--check-stt-key` | `pnpm stt:dev`, `text:dev`, `guardrail:dev`, `nlp:dev`, `harness:dev`, `tts:dev` (each with a `:dev:watch` variant), `worker:dev`                                                                                                 |
| `dev-doctor.sh`           | Read-only health probe of the whole local DEV stack: Docker containers, infra endpoints, LM Studio/Ollama, all HOPE service health URLs, TEXT provider registration, harness worker process, STT Dramatiq batch worker process, STT API-key preflight. Exit 1 if any required check fails.                                                                                                                                                                                                                                                                                                                                               | `API_PORT`, `STT_PORT`, `TEXT_PORT`, `NLP_PORT`, `HARNESS_PORT`, `GUARDRAIL_PORT`, `TEMPORAL_PORT`, ...                                                                                  | `pnpm stack:dev:doctor`                                                                                                                                                                                                          |
| `setup-python-env.sh`     | Creates/updates the shared conda env `arcaenv` (Python 3.11) with dependencies for stt, text, nlp, harness, guardrail, and tts. `--service` narrows the install to one service; `--rebuild` recreates the env without a prompt. Checks prerequisites (node, pnpm, conda, uv, docker, make).                                                                                                                                                                                                                                                                                                           | flags: `--check`, `--install`, `--rebuild`, `--service <name>` (repeatable), `--cpu`, `--apple` (MPS extras), `--gpu` (CUDA extras)                                                     | `pnpm setup:python` / `setup:python:check` / `setup:python:apple` / `setup:python:gpu` / `setup:python:rebuild`; per service `pnpm stt:setup` / `stt:setup:apple` / `stt:setup:gpu` (same for text, nlp, guardrail, harness, tts) |
| `clean.sh`                | Tiered workspace cleaner implemented with `find`, so it still works once node_modules is gone. `build` = dist/.next/storybook-static/coverage/test-results/tsbuildinfo/Prisma client; `cache` = .turbo/.vite/eslint/playwright-report + Python `__pycache__`/`.pytest_cache`/`.ruff_cache`/`.mypy_cache`; `deps` = every node_modules + pnpm-lock.yaml (typed confirmation required).                                                                                                                                                                                                                | tiers: `build\|cache\|deps\|default\|all`; flags: `--dry-run`, `--yes`; `CLEAN_DRY_RUN_SAMPLE`                                                                                          | `pnpm clean` (build+cache) / `clean:build` / `clean:cache` / `clean:deps` / `clean:all`                                                                                                                                          |
| `gen-guard.sh`            | Confirmation wrapper for the two unsafe domain-layer generators. Prints the exact damage, requires a clean git worktree for the target path (so `git checkout` can always undo it) and a typed confirmation. `generate-mapper` is DESTRUCTIVE (drops the `_version` OCC guard before crashing); `generate-repository` is BROKEN.                                                                                                                                                                                                                                                                     | `GEN_GUARD_FORCE=1` + `--yes` for non-interactive callers                                                                                                                               | `pnpm gen:mapper` / `pnpm gen:repository`                                                                                                                                                                                        |

## Vault / security

| Script                   | Purpose                                                                                                                                                                                                                                                   | Key env vars / flags                                                  | pnpm alias                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------ |
| `refresh-vault-creds.sh` | Mints a fresh raw (reusable, ~30-day) AppRole `secret_id` from the dev Vault container and rewrites `VAULT_ROLE_ID` / `VAULT_SECRET_ID` in `.env.dev` (blanks the prod-only `VAULT_WRAPPED_SECRET_ID`). Re-run only after a Vault container/volume reset. | `VAULT_CONTAINER`, `VAULT_DEV_ROOT_TOKEN`                             | — (called by `pnpm setup:dev`) |
| `setup-dev-vault-db.sh`  | Makes `PG_DYNAMIC_CREDS=true` work locally: creates `vault_admin` + `hope_app_template` PG roles, (re-)configures Vault's database engine against the dev DB, smoke-tests credential issuance. Idempotent; requires migrations applied first.             | `PG_CONTAINER`, `VAULT_CONTAINER`, reads `VAULT_DB_*` from `.env.dev` | — (called by `pnpm setup:dev`) |
| `gitleaks-precommit.sh`  | Staged-only gitleaks secret scan, installed as the git pre-commit hook via `simple-git-hooks` on `pnpm install`. Skips silently if gitleaks is not installed (CI is the back-stop).                                                                       | —                                                                     | — (git pre-commit hook)        |

## Test environment bootstrapping

The test stack is isolated from dev: Postgres 5433, Redis 6380, MinIO 9002, Qdrant 6335, Vault 8201, static DB/Redis/MinIO credentials, and (TASK-689) its own isolated dev-mode Vault (`hope-vault-test`) for secret warming + Transit encryption (`SECRETS_PROVIDER=vault`) — the test infra runs its own Vault + init sidecar, it does not borrow the dev `hope-vault` container. See also [tests/README.md](../tests/README.md).

| Script                  | Purpose                                                                                                                                                                                                                                                                                                                                                              | Key env vars / flags                                                                                                            | pnpm alias                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `test-setup.sh`         | One-command test bootstrap: creates `.env.test` from `.env.sample` if missing (TASK-583), test infra up + health validation, provisions Vault AppRole creds into `.env.test`, Prisma generate, schema push to the test DB, seed. Test counterpart of `dev-setup.sh`. Idempotent — safe on a completely fresh clone.                                                  | —                                                                                                                               | `pnpm setup:test`                                                                                                                 |
| `start-test-infra.sh`   | Manages the isolated test containers defined in `tests/docker-compose.test.yml`. `--stop` and `--restart` remove volumes; `--validate` health-checks Postgres/Redis/MinIO/Qdrant/Vault and the Qdrant/Vault init containers.                                                                                                                                          | flags: `--stop`, `--restart`, `--logs`, `--status`, `--validate`                                                                | `pnpm infra:test:up` / `infra:test:down` / `infra:test:restart` / `infra:test:logs` / `infra:test:status` / `infra:test:validate` |
| `start-test-service.sh` | Shared function library (env checks, container checks, port checks, `--build` handling). Sourced by `start-test-app.sh` — not run directly.                                                                                                                                                                                                                          | —                                                                                                                               | —                                                                                                                                 |
| `start-test-app.sh`     | Starts ONE app/service/worker against `.env.test`. Replaces the former per-service `start-test-{api,stt,text,nlp}.sh`, which each re-implemented a uvicorn command `dev-service.sh` already owns — Python launches now delegate to `dev-service.sh`, so dev and test can never diverge. Refuses a bound port (dev/test share app ports) and a second Temporal worker. | targets: `api admin stt text nlp guardrail harness tts worker`; flag: `--build`                                                  | `pnpm test:up:<target>`                                                                                                           |
| `test-stack.sh`         | TEST app-stack supervisor. Ensures test infra + schema, then starts the requested services through `start-test-app.sh` and waits for their health endpoints so a suite cannot race the boot. Default service set is `api` alone. Shares `lib/stack-supervisor.sh` with `dev-stack.sh`.                                                                               | `DRY_RUN=1`, `TEST_STACK_WAIT=0`, `TEST_STACK_TIMEOUT` (default 90)                                                             | `pnpm stack:test` / `stack:test:down` (subset: `pnpm stack:test -- api stt`)                                                      |
| `test-doctor.sh`        | Read-only readiness probe of the TEST environment: containers, Postgres/Redis/MinIO/Qdrant health, **schema pushed + seeded**, service health endpoints (optional), and a warning when the dev infra is also up (app ports are shared). Exit 1 if a required check fails.                                                                                            | flag: `--infra-only`                                                                                                            | `pnpm stack:test:doctor`                                                                                                          |
| `test-run.sh`           | Managed test run: check infra (start it if down) → push/seed schema if missing → start the services the suite needs and wait for health → run the suite → **print the result before teardown** → stop only what this run started. Exits with the suite's exit code.                                                                                                  | suites: `unit integration e2e py stt text nlp guardrail harness tts`; flags: `--keep`, `--no-teardown-infra`; `TEST_RUN_TIMEOUT` | `pnpm test:unit:managed` / `test:integration:managed` / `test:e2e:managed` / `test:py:managed` / `pnpm <svc>:test:managed`        |

## CI / backup / infrastructure operations

| Script               | Purpose                                                                                                                                                                                                                                             | Key env vars / flags                                                                                                                              | pnpm alias |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `github-backup.sh`   | Adds/updates a `github` remote and force-pushes the current HEAD to a GitHub backup branch (mirror style). Runs in CI (`github-backup` job in `.gitlab/ci/notify.yml`).                                                                             | `GITHUB_REPO`, `GITHUB_USERNAME` (required), `GITHUB_TOKEN` (required), `BACKUP_BRANCH` (default `back-up`)                                       | —          |
| `deploy-ssh-keys.sh` | One-time homelab setup: generates an ed25519 key and deploys it to the homelab VMs over cloudflared tunnels using password auth. zsh script.                                                                                                        | flags: `--dry-run`, VM aliases (`gpu`, `db0`, ...); expects cloudflared at `/opt/homebrew/bin/cloudflared`                                        | —          |
| `smoke-pgbouncer.sh` | Production/staging PgBouncer smoke tests: connectivity, app-user auth, `pool_mode=transaction`, a real Prisma query through the pooler, tenant-GUC leak check, pool stats. Run by the manual `smoke-pgbouncer-staging` CI job over SSH. zsh script. | `POOLED_HOST` (required), `ADMIN_PG_PASSWORD` (required), `APP_PG_PASSWORD` (required), `POOLED_PORT`, `ADMIN_USER`, `APP_USER`, `DB`, `SSL_MODE` | —          |

## Package publishing

| Script             | Purpose                                                                                                                                                                                                                                                                                                                                                | Key env vars / flags                                                          | pnpm alias                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------- |
| `publish-sdk.sh`   | Manual release of the browser SDK family (`room`, `vad`, `noise-filter`, `stt`, `med-ner`, `vox`): lockstep version bump → lockfile sync → `pnpm sdk:build` → publish in dependency order (room first, vox last). Preflight REFUSES to publish if any intra-family peer is not `workspace:^`. `set -e` stops the run before dependents ship on a failure. | `<version>` (required, semver); flags: `--dry-run`, `--yes`, `--skip-build`   | `sdk:publish`, `sdk:publish:dry` |

Registry auth comes from `~/.npmrc` for the `publishConfig.registry` in each package (`npm.pkg.github.com`); there is no repo-level `.npmrc`.

> **The CI `publish-sdk` job (`.gitlab/ci/publish.yml`) does not work as written** — it calls `pnpm changeset version` / `pnpm changeset publish`, but the repo has no `.changeset/` directory and changesets is not a dependency. It also targets the GitLab Package Registry while every package's `publishConfig.registry` points at GitHub Packages. Until that is reconciled, `pnpm sdk:publish` is the only working release path.

**Why peers must be `workspace:^`:** pnpm rewrites the workspace protocol at pack time — `workspace:^` → `^2.0.7` (a range that survives the next bump), `workspace:*` → `2.0.7` (an exact pin that breaks on any drift). A hardcoded literal such as `^0.1.0` is never rewritten at all and silently goes stale, which is what shipped in 2.0.6 and produced unmet-peer errors for every consumer.

## Diagnostics / performance

| Script                  | Purpose                                                                                                                                                                                                                                                                             | Key env vars / flags                                                                                                                 | pnpm alias |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `spike-cadence-fast.py` | Spike (TASK-351 D-2): verifies `ai4bharat/Cadence-Fast` punctuation restoration loads and runs via transformers with `trust_remote_code` under the pinned repo revision. No production wiring. Run: `conda run -n arcaenv --no-capture-output python scripts/spike-cadence-fast.py` | `HF_HUB_*` hygiene vars set internally                                                                                               | —          |

## Chaos / resilience

| Script                 | Purpose                                                                                                                                                                                                                         | Key env vars / flags                                                                                                                   | pnpm alias |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `chaos/vault-drill.sh` | Chaos drills against a running HA Vault cluster on Kubernetes (staging/kind): A leader failover, B follower loss + auto-unseal, C transit-seal outage and recovery, D optional app health assertion. Requires `kubectl` + `jq`. | `CHAOS_CONFIRM=yes` (required), `DRILLS` (default `A B C`), `VAULT_NAMESPACE`, `SEAL_STATEFULSET`, `APP_HEALTH_URL`, `RECOVER_TIMEOUT` | —          |

## Common workflows

### Fresh machine setup

```bash
pnpm setup:node              # pnpm install; also installs the gitleaks pre-commit hook
pnpm setup:python            # conda env `arcaenv` (or setup:python:apple / setup:python:gpu)
pnpm setup:dev               # infra up + migrate + seed + Vault bootstrap
pnpm stack:dev:doctor        # verify everything required is green
```

### Daily dev loop

```bash
pnpm stack:dev               # infra + full clinical-workspace stack (Ctrl-C stops all)
```

```bash
pnpm stack:dev -- text worker # a subset only
```

```bash
pnpm stack:dev:doctor        # when something looks broken
```

```bash
pnpm stack:dev:down          # stop orphans left by a killed supervisor
```

### Running tests

The managed runners do the whole dance for you — infra check, service boot, suite, result, teardown — and leave nothing behind:

```bash
pnpm test:unit:managed
```

```bash
pnpm test:e2e:managed        # also boots the API against .env.test and waits for health
```

Or drive it by hand:

```bash
pnpm setup:test              # test containers + schema push + seed (one command)
pnpm stack:test              # API on .env.test, waits until healthy (Ctrl-C stops it)
pnpm test:unit               # in a second terminal
pnpm infra:test:down         # stops containers and removes volumes
```

### Cleaning

```bash
pnpm clean                   # build artifacts + caches
```

```bash
pnpm clean:all               # the above plus every node_modules and pnpm-lock.yaml
```

```bash
pnpm setup:node:rebuild      # clean:deps + pnpm install + db:generate
```

```bash
pnpm setup:python:rebuild    # recreate the conda env from scratch
```

## Troubleshooting

### One service shows "down" in the Admin Console (but you started it)

The Admin Console health card renders exactly what the gateway probe finds: a
red/"down" card means that service's port isn't answering _right now_ — not a
false alarm. When you launch services as separate `pnpm dev:*` terminals, a
per-service startup crash (traceback scrolled off, port already in use, a shell
without `arcaenv` activated, or a closed terminal that took its child process
with it) is invisible except as that one red card ~30s later.

```bash
pnpm stack:dev:doctor              # aggregated one-shot probe — a failed required
                             # service prints its exact restart command,
                             # e.g. "harness (8866) … — start with 'pnpm harness:dev'"
```

Then re-launch just the offending service in the foreground and read the output
verbatim. To avoid the hidden-crash trap entirely, prefer the supervisor, which
runs every service in one aggregated stream with port preflight and a cleanup
trap:

```bash
pnpm stack:dev               # api stt stt-worker text guardrail nlp harness worker admin
```

Two of those have no port, so a bad start is invisible to any health probe:
the harness worker (`pnpm worker:dev`) polls Temporal's task queue, and the STT
batch worker (`pnpm stt:worker:dev`) consumes the Dramatiq queue
`dramatiq:stt_batch`. `pnpm stack:dev:doctor` reports them separately as
`harness worker process` and `stt batch worker process`. If the STT batch worker
is down, batch transcription jobs are still accepted and persisted as `QUEUED`
but never execute (BUG-011).
