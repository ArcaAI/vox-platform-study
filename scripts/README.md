# Operational Scripts

Introduced: 2026-07-04 · Last verified: 2026-07-21

Shell and Python scripts that bootstrap, run, verify, and exercise the HOPE development, test, and staging environments. Most scripts are wired to root `package.json` aliases — prefer the `pnpm` form so you always run from the repo root with the right env files.

All scripts are safe to read before running; each has a usage header. Paths below are relative to the repo root.

## Prerequisites

- Node.js >= 22, pnpm, Docker + Docker Compose
- conda with the shared `arcaenv` environment (Python 3.11) for anything that starts a Python service — create it with `pnpm py:setup`
- `.env` (Docker Compose), `.env.dev` (dev API), `.env.test` (test stack) at the repo root

## Development environment

| Script | Purpose | Key env vars / flags | pnpm alias |
|---|---|---|---|
| `dev-setup.sh` | One-command dev bootstrap: infra up (core + vault + temporal + rag), wait for Postgres/Vault, `pnpm db:all` (migrate + seed), refresh Vault AppRole creds in `.env.dev`, bootstrap Vault dynamic DB creds. Idempotent. `-o` / `-e` add observability / inference tiers. | `PG_CONTAINER`, `VAULT_CONTAINER`, reads `VAULT_DEV_ROOT_TOKEN` / `POSTGRES_USER` from `.env.dev`; flags: `-o/--observability`, `-e/--inference` | `pnpm dev:setup` / `dev:setup-o` / `dev:setup-e` |
| `dev-infra.sh` | Docker infra wrapper (TASK-555 tiers). Default `up`: `vault` + `temporal` + `rag`. `-o/--observability` adds Prometheus/Grafana; `-e/--inference` adds vLLM/llama.cpp/TEI embed. `down`/`status`/`logs` always use the full known profile set so nothing lingers. Apple Silicon auto-selects TEI arm64 images when unset. | flags: `up\|down\|status\|logs`, `-o/--observability`, `-e/--inference`, `--rag` (no-op), `--print` | `pnpm infra:up` / `infra:down` / `infra:status` / `infra:logs`; `infra:observability:up` → `up -o` |
| `start-infra.sh` | Older infra wrapper: core services by default (Postgres, Redis, MinIO); `--all` adds the `vault` profile (Vault + Qdrant). Does NOT start Temporal/rag — use `dev-infra.sh` for the full stack. | flags: `--all`, `--stop`, `--logs`, `--status` | `pnpm docker:dev:up` / `docker:dev:up:all` / `docker:dev:down` / `docker:dev:logs` / `docker:dev:status` |
| `dev-stack.sh` | Aggregate supervisor. Ensures Docker infra is up first (`dev-infra.sh up`, optional `-o`/`-e`), then starts default apps (`DEFAULT_SERVICES`): api (8868), stt (8861), smr (8862), guardrail (8863), nlp (8864), harness (8866), Temporal worker, admin console (5176); tails logs; Ctrl-C stops apps (infra stays). `ALL_SERVICES` also offers `tts` (8865). Refuses busy ports / second Temporal worker. `down` stops pidfile orphans only. | `DRY_RUN=1`, `HOPE_DEV_STATE_DIR`, `HOPE_DEV_LOG_DIR`, per-service `*_PORT`; flags: `-o/--observability`, `-e/--inference` | `pnpm dev:stack` / `dev:stack-o` / `dev:stack-e` (subset: `pnpm dev:stack -- smr worker`; stop: `pnpm dev:stack down`) |
| `dev-service.sh` | Single Python service launcher with proven dev defaults baked in (conda `arcaenv`, loopback bind, LM Studio model wiring for smr/harness). `worker` runs the harness Temporal worker. | `CONDA_ENV`, `HOST` (default 127.0.0.1), `LM_STUDIO_MODEL`, `STT_PORT`/`SMR_PORT`/`GUARDRAIL_PORT`/`NLP_PORT`/`HARNESS_PORT`/`TTS_PORT`; flags: `--watch`, `--print`, `--check-stt-key` | `pnpm dev:stt-v2`, `dev:smr-v2`, `dev:guardrail`, `dev:nlp`, `dev:harness`, `dev:tts-v2`, `dev:harness:worker` (each with `:watch` variant except worker); also `py:harness:dev`, `py:harness:worker` |
| `dev-doctor.sh` | Read-only health probe of the whole local stack: Docker containers, infra endpoints, LM Studio/Ollama, all HOPE service health URLs, SMR provider registration, harness worker process, STT API-key preflight. Exit 1 if any required check fails. | `API_PORT`, `STT_PORT`, `SMR_PORT`, `NLP_PORT`, `HARNESS_PORT`, `GUARDRAIL_PORT`, `TEMPORAL_PORT`, ... | `pnpm dev:doctor` |
| `setup-python-env.sh` | Creates/updates the shared conda env `arcaenv` (Python 3.11) with dependencies for stt-v2, smr, nlp, harness, guardrail, and tts-v2. Checks prerequisites (node, pnpm, conda, uv, docker, make). | flags: `--check`, `--install`, `--apple` (MPS extras), `--gpu` (CUDA extras) | `pnpm py:setup` / `py:setup:check` / `py:setup:apple` / `py:setup:gpu` |

## Vault / security

| Script | Purpose | Key env vars / flags | pnpm alias |
|---|---|---|---|
| `refresh-vault-creds.sh` | Mints a fresh raw (reusable, ~30-day) AppRole `secret_id` from the dev Vault container and rewrites `VAULT_ROLE_ID` / `VAULT_SECRET_ID` in `.env.dev` (blanks the prod-only `VAULT_WRAPPED_SECRET_ID`). Re-run only after a Vault container/volume reset. | `VAULT_CONTAINER`, `VAULT_DEV_ROOT_TOKEN` | — (called by `pnpm dev:setup`) |
| `setup-dev-vault-db.sh` | Makes `PG_DYNAMIC_CREDS=true` work locally: creates `vault_admin` + `hope_app_template` PG roles, (re-)configures Vault's database engine against the dev DB, smoke-tests credential issuance. Idempotent; requires migrations applied first. | `PG_CONTAINER`, `VAULT_CONTAINER`, reads `VAULT_DB_*` from `.env.dev` | — (called by `pnpm dev:setup`) |
| `gitleaks-precommit.sh` | Staged-only gitleaks secret scan, installed as the git pre-commit hook via `simple-git-hooks` on `pnpm install`. Skips silently if gitleaks is not installed (CI is the back-stop). | — | — (git pre-commit hook) |

## Test environment bootstrapping

The test stack is isolated from dev: Postgres 5433, Redis 6380, MinIO 9002, Qdrant 6335, static credentials from `.env.test`, no Vault. See also [tests/README.md](../tests/README.md).

| Script | Purpose | Key env vars / flags | pnpm alias |
|---|---|---|---|
| `test-setup.sh` | One-command test bootstrap: test infra up + health validation, Prisma generate, schema push to the test DB, seed. Test counterpart of `dev-setup.sh`. | requires `.env.test` | `pnpm test:setup` |
| `start-test-infra.sh` | Manages the isolated test containers defined in `tests/docker-compose.test.yml`. `--stop` removes volumes; `--validate` health-checks Postgres/Redis/MinIO/Qdrant and the Qdrant init container. | flags: `--stop`, `--logs`, `--status`, `--validate` | `pnpm docker:test:up` / `docker:test:down` / `docker:test:logs` / `docker:test:status` / `docker:test:validate` |
| `start-test-service.sh` | Shared function library (env checks, container checks, port checks, `--build` handling). Sourced by the other `start-test-*.sh` scripts — not run directly. | — | — |
| `start-test-api.sh` | Starts the NestJS API Gateway on 8868 with `.env.test`. Fails fast if the port is taken (shared with `pnpm dev:api`). | flag: `--build` (build packages first) | `pnpm test:api:up` |
| `start-test-stt-v2.sh` | Starts STT-v2 (uvicorn, conda `arcaenv`) with `.env.test`, port 8861, reload on. | `STT_V2_PORT`; flag: `--build` | `pnpm test:stt-v2:up` |
| `start-test-smr-v2.sh` | Starts SMR-v2 with `.env.test`, port 8862, reload on. | `SMR_PORT`; flag: `--build` | `pnpm test:smr-v2:up` |
| `start-test-nlp.sh` | Starts NLP with `.env.test`, port 8864, reload on. | `NLP_PORT`; flag: `--build` | `pnpm test:nlp:up` |

## CI / backup / infrastructure operations

| Script | Purpose | Key env vars / flags | pnpm alias |
|---|---|---|---|
| `github-backup.sh` | Adds/updates a `github` remote and force-pushes the current HEAD to a GitHub backup branch (mirror style). Runs in CI (`github-backup` job in `.gitlab/ci/notify.yml`). | `GITHUB_REPO`, `GITHUB_USERNAME` (required), `GITHUB_TOKEN` (required), `BACKUP_BRANCH` (default `back-up`) | — |
| `deploy-ssh-keys.sh` | One-time homelab setup: generates an ed25519 key and deploys it to the homelab VMs over cloudflared tunnels using password auth. zsh script. | flags: `--dry-run`, VM aliases (`gpu`, `db0`, ...); expects cloudflared at `/opt/homebrew/bin/cloudflared` | — |
| `smoke-pgbouncer.sh` | Production/staging PgBouncer smoke tests: connectivity, app-user auth, `pool_mode=transaction`, a real Prisma query through the pooler, tenant-GUC leak check, pool stats. Run by the manual `smoke-pgbouncer-staging` CI job over SSH. zsh script. | `POOLED_HOST` (required), `ADMIN_PG_PASSWORD` (required), `APP_PG_PASSWORD` (required), `POOLED_PORT`, `ADMIN_USER`, `APP_USER`, `DB`, `SSL_MODE` | — |

## Diagnostics / performance

| Script | Purpose | Key env vars / flags | pnpm alias |
|---|---|---|---|
| `stt-latency-replay.sh` | Replays reference audio into a running stt-v2 over the real Redis Streams protocol at realtime pace; reports time-to-first-word, partial cadence, and final lag against the 800 ms/chunk SLA. Writes a JSON report. Skips cleanly if Redis/stt-v2/pipeline are unreachable. | `STT_V2_BASE_URL`, `REDIS_URL`, `DATABASE_URL`, `LATENCY_WAV_PATH`, `LATENCY_PIPELINE_ID`, `LATENCY_SLA_MS`, `LATENCY_REPORT_PATH`, ... | — |
| `spike-cadence-fast.py` | Spike (TASK-351 D-2): verifies `ai4bharat/Cadence-Fast` punctuation restoration loads and runs via transformers with `trust_remote_code` under the pinned repo revision. No production wiring. Run: `conda run -n arcaenv --no-capture-output python scripts/spike-cadence-fast.py` | `HF_HUB_*` hygiene vars set internally | — |

## Chaos / resilience

| Script | Purpose | Key env vars / flags | pnpm alias |
|---|---|---|---|
| `chaos/vault-drill.sh` | Chaos drills against a running HA Vault cluster on Kubernetes (staging/kind): A leader failover, B follower loss + auto-unseal, C transit-seal outage and recovery, D optional app health assertion. Requires `kubectl` + `jq`. | `CHAOS_CONFIRM=yes` (required), `DRILLS` (default `A B C`), `VAULT_NAMESPACE`, `SEAL_STATEFULSET`, `APP_HEALTH_URL`, `RECOVER_TIMEOUT` | — |

## Common workflows

### Fresh machine setup

```bash
pnpm install                 # also installs the gitleaks pre-commit hook
pnpm py:setup                # create conda env `arcaenv` (add --apple or --gpu for ML extras)
pnpm dev:setup               # infra up + migrate + seed + Vault bootstrap
pnpm dev:doctor              # verify everything required is green
```

### Daily dev loop

```bash
pnpm infra:up                # Postgres, Redis, MinIO, Qdrant, Vault, Temporal
pnpm dev:stack               # full clinical-workspace stack (Ctrl-C stops all)
# or a subset:
pnpm dev:api                 # API only
pnpm dev:stack -- smr worker # selected services
pnpm dev:doctor              # when something looks broken
pnpm dev:stack down          # stop orphans left by a killed supervisor
```

### Running test infrastructure

```bash
pnpm test:setup              # test containers + schema push + seed (one command)
# or step by step:
pnpm docker:test:up
pnpm test:db:push && pnpm test:db:seed
pnpm test:api:up             # test API on 8868 with .env.test
pnpm test:unit | pnpm test:integration | pnpm test:e2e
pnpm docker:test:down        # stops containers and removes volumes
```

## Troubleshooting

### One service shows "down" in the Admin Console (but you started it)

The Admin Console health card renders exactly what the gateway probe finds: a
red/"down" card means that service's port isn't answering *right now* — not a
false alarm. When you launch services as separate `pnpm dev:*` terminals, a
per-service startup crash (traceback scrolled off, port already in use, a shell
without `arcaenv` activated, or a closed terminal that took its child process
with it) is invisible except as that one red card ~30s later.

```bash
pnpm dev:doctor              # aggregated one-shot probe — a failed required
                             # service prints its exact restart command,
                             # e.g. "harness (8866) … — start with 'pnpm dev:harness'"
```

Then re-launch just the offending service in the foreground and read the output
verbatim. To avoid the hidden-crash trap entirely, prefer the supervisor, which
runs every service in one aggregated stream with port preflight and a cleanup
trap:

```bash
pnpm dev:stack               # api stt smr guardrail nlp harness worker admin
```

The harness worker (`pnpm dev:harness:worker`) has no port — it is a process
polling Temporal's task queue. `pnpm dev:doctor` reports it separately as
`harness worker process`.
