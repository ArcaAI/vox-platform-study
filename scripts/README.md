# Operational Scripts — dev/test/CI bootstrap and runners for HOPE

Shell and Python scripts that bootstrap, run, verify, and exercise the HOPE development, test,
and staging environments. Most scripts are wired to root `package.json` aliases — prefer the
`pnpm` form so you always run from the repo root with the right env files. All scripts are safe
to read before running; each has a usage header. Paths below are relative to the repo root.

## Layout

| Path | What it holds |
|---|---|
| `dev-*.sh` | Dev-environment bootstrap, infra, stack supervisor, single-service launcher, health doctor |
| `test-*.sh`, `start-test-*.sh` | Test-environment bootstrap, isolated infra, stack supervisor, single-target launcher, readiness doctor, managed runner |
| `lib/stack-supervisor.sh` | Shared process-supervisor library sourced by `dev-stack.sh` and `test-stack.sh` |
| `chaos/vault-drill.sh` | Chaos drills against a running HA Vault cluster |
| `pytest-support/` | `hope_worktree_guard` — asserts a Python test run resolves packages from the invoking worktree, not a stale conda editable install |
| `generated/` | Output of the code generators wired to `pnpm gen:*` |
| `__tests__/` | Vitest unit tests for the TypeScript scripts (`env-sync.mts`, etc.) |
| `refresh-vault-creds.sh`, `setup-dev-vault-db.sh`, `gitleaks-precommit.sh` | Vault/security bootstrap and the git pre-commit hook |
| `publish-sdk.sh` | Manual release of the browser SDK family |
| `github-backup.sh`, `deploy-ssh-keys.sh`, `smoke-pgbouncer.sh` | CI backup job and homelab operator scripts |
| `env-sync.mts`, `env-consumer-inventory.py`, `python-env-surface.py` | Env-var surface generators/checkers behind `pnpm env:*` |
| `check-migration-compat.ts`, `check-openapi-coverage.ts`, `verify-doc-claims.mjs`, `verify-traceability.mjs` | CI verification scripts |
| `changelog-draft.ts`, `changelog-from-commits.ts` | Release changelog generators |

## Commands

### Fresh machine setup

```bash
pnpm setup:node               # pnpm install; also installs the gitleaks pre-commit hook
pnpm setup:python             # conda env `arcaenv` (or setup:python:apple / setup:python:gpu)
pnpm setup:dev                # infra up + migrate + seed + Vault bootstrap
pnpm stack:dev:doctor         # verify everything required is green
```

### Daily dev loop

```bash
pnpm stack:dev                # infra + full clinical-workspace stack (Ctrl-C stops all)
pnpm stack:dev -- text worker # a subset only
pnpm stack:dev:doctor         # when something looks broken
pnpm stack:dev:down           # stop orphans left by a killed supervisor
```

### Running tests

The managed runners do the whole dance for you — infra check, service boot, suite, result,
teardown — and leave nothing behind:

```bash
pnpm test:unit:managed
pnpm test:e2e:managed         # also boots the API against .env.test and waits for health
```

Or drive it by hand:

```bash
pnpm setup:test               # test containers + schema push + seed (one command)
pnpm stack:test                # API on .env.test, waits until healthy (Ctrl-C stops it)
pnpm test:unit                 # in a second terminal
pnpm infra:test:down           # stops containers and REMOVES volumes
```

### Cleaning

```bash
pnpm clean                    # build artifacts + caches
pnpm clean:all                # the above plus every node_modules and pnpm-lock.yaml
pnpm setup:node:rebuild       # clean:deps + pnpm install + db:generate
pnpm setup:python:rebuild     # recreate the conda env from scratch
```

### Command -> script reference

| Command | Script | Purpose |
|---|---|---|
| `pnpm setup:dev` / `setup:dev:observability` / `setup:dev:inference` | `dev-setup.sh` | One-command dev bootstrap: `.env.dev` from `.env.sample` if missing, infra up (core + vault + temporal + rag), wait for Postgres/Vault, `pnpm db:all` (migrate + seed), refresh Vault AppRole creds, bootstrap Vault dynamic DB creds. Idempotent |
| `pnpm infra:dev:up` / `infra:dev:down` / `infra:dev:restart` / `infra:dev:status` / `infra:dev:logs` / `infra:dev:validate` / `infra:dev:up:observability` / `infra:dev:up:inference` | `dev-infra.sh` | The single dev-infra entrypoint. Default `up`: `vault` + `temporal` + `rag` profiles. `-o`/`--observability` adds Prometheus/Grafana; `-e`/`--inference` adds vLLM/llama.cpp/TEI embed. `up` also reconciles Vault with `.env.dev` (`SKIP_VAULT_RECONCILE=1` opts out) |
| `pnpm infra:dev:temporal-hop` | `temporal-volume-hop.sh` | Print-only runbook for a leftover 1.29.x Temporal auto-setup DB. Never starts/stops containers or runs `DELETE`/`DROP`/`TRUNCATE` |
| `pnpm infra:dev:temporal-terminate-orphans` | `temporal-terminate-orphans.sh` | Terminates every RUNNING Temporal workflow in the dev namespace; chained onto `pnpm db:all` so every reset path cleans up after itself. No-op when Temporal is down; refuses under `NODE_ENV=production` |
| `pnpm stack:dev` / `stack:dev:observability` / `stack:dev:inference` (subset: `pnpm stack:dev -- text worker`; stop: `pnpm stack:dev:down`) | `dev-stack.sh` | DEV app-stack supervisor. Ensures Docker infra is up first, optionally loads the LM Studio text model, then starts default apps: api (8868), stt (8861), stt-worker (Dramatiq batch queue, no port), text (8862), guardrail (8863), nlp (8864), harness (8866), Temporal worker, admin console (5176); tails logs; Ctrl-C stops apps (infra stays) |
| `pnpm stt:dev`, `text:dev`, `guardrail:dev`, `nlp:dev`, `harness:dev`, `tts:dev` (each with a `:dev:watch` variant), `worker:dev`, `stt:worker:dev` | `dev-service.sh` | Single-service launcher: conda `arcaenv`, loopback bind, per-service port overrides, LM Studio model pairing. Application config is read from `.env.dev` via `packages/py-env`, not baked into this script |
| `pnpm stack:dev:doctor` | `dev-doctor.sh` | Read-only health probe of the whole local DEV stack: Docker containers, infra endpoints, LM Studio/Ollama, every HOPE service health URL, TEXT provider registration, harness worker process, STT Dramatiq batch worker process, STT API-key preflight. Exit 1 if a required check fails |
| `pnpm setup:python` / `setup:python:apple` / `setup:python:gpu` / `setup:python:rebuild`; per service `pnpm <svc>:setup[:apple\|:gpu]` | `setup-python-env.sh` | Creates/updates the shared conda env `arcaenv` (Python 3.11) with dependencies for stt, text, nlp, harness, guardrail, tts |
| `pnpm clean` / `clean:build` / `clean:cache` / `clean:deps` / `clean:all` | `clean.sh` | Tiered workspace cleaner (`find`-based, works even without node_modules). `deps` requires a typed confirmation |
| `pnpm gen:mapper` / `pnpm gen:repository` | `gen-guard.sh` | Confirmation wrapper for the two unsafe domain-layer generators — see Gotchas |
| `pnpm setup:test` | `test-setup.sh` | One-command test bootstrap: `.env.test` from `.env.sample` if missing, test infra up + health validation, Vault AppRole creds, Prisma generate, schema push, seed. Idempotent |
| `pnpm infra:test:up` / `infra:test:down` / `infra:test:restart` / `infra:test:logs` / `infra:test:status` / `infra:test:validate` | `start-test-infra.sh` | Manages the isolated test containers in `tests/docker-compose.test.yml`. `--stop`/`--restart` REMOVE volumes |
| `pnpm test:up:<target>` (`api admin stt text nlp guardrail harness tts worker`) | `start-test-app.sh` | Starts ONE app/service/worker against `.env.test`, delegating Python launches to `dev-service.sh` so dev and test can never diverge. Refuses a bound port and a second Temporal worker |
| `pnpm stack:test` / `stack:test:down` (subset: `pnpm stack:test -- api stt`) | `test-stack.sh` | TEST app-stack supervisor; default service set is `api` alone. Shares `lib/stack-supervisor.sh` with `dev-stack.sh` |
| `pnpm stack:test:doctor` | `test-doctor.sh` | Read-only readiness probe of the TEST environment: containers, infra health, schema pushed + seeded, service health endpoints, and a warning when dev infra is also up |
| `pnpm test:unit:managed` / `test:integration:managed` / `test:e2e:managed` / `test:py:managed` / `pnpm <svc>:test:managed` | `test-run.sh` | Managed run: check infra (start if down) -> push/seed schema if missing -> start needed services and wait for health -> run the suite -> print the result before teardown -> stop only what this run started |
| `pnpm sdk:publish` / `sdk:publish:dry` | `publish-sdk.sh` | Manual release of the browser SDK family (`room`, `vad`, `noise-filter`, `stt`, `med-ner`, `vox`): lockstep version bump -> lockfile sync -> `pnpm sdk:build` -> publish in dependency order. Preflight refuses to publish if any intra-family peer is not `workspace:^` |
| -- | `refresh-vault-creds.sh` | Mints a fresh raw (reusable, ~30-day) AppRole `secret_id` and rewrites `VAULT_ROLE_ID`/`VAULT_SECRET_ID` in `.env.dev`. Called by `pnpm setup:dev`; re-run only after a Vault container/volume reset |
| -- | `setup-dev-vault-db.sh` | Creates `vault_admin` + `hope_app_template` PG roles, (re-)configures Vault's database engine, smoke-tests credential issuance. Called by `pnpm setup:dev`; idempotent; requires migrations applied first |
| -- (git pre-commit hook) | `gitleaks-precommit.sh` | Staged-only gitleaks secret scan, installed via `simple-git-hooks` on `pnpm install` |

## How it works

### Script naming (one taxonomy, no legacy aliases)

| Shape | Meaning | Examples |
|---|---|---|
| `<target>:<action>` | one app / service / worker / package | `api:dev`, `stt:test:cov`, `harness:lint`, `admin:build`, `worker:dev` |
| `<domain>:<action>` | cross-cutting concern | `db:migrate`, `gen:model`, `build:apps`, `lint:all`, `clean:cache` |
| `<domain>:<env>:<action>` | concern split by environment | `infra:dev:up`, `infra:test:validate`, `stack:dev:doctor`, `stack:test:down` |

Targets: `api`, `admin`, `ui`, `sdk`, `stt`, `text`, `nlp`, `guardrail`, `harness`, `tts`,
`worker`. Every target supports the same verbs where they apply: `setup` (+`:cpu`/`:apple`/`:gpu`
for Python), `dev`, `dev:watch`, `build`, `test` (+`:unit`/`:integration`/`:e2e`/`:cov`/`:managed`),
`lint`, `lint:fix`, `typecheck`, `format`, `format:check`, `clean`.

### Ports — DEV and TEST are fully independent

TEST application ports are **DEV + 100**, so both stacks can run at the same time:

| | api | stt | text | guardrail | nlp | tts | harness | admin | inspector |
|---|---|---|---|---|---|---|---|---|---|
| **dev** | 8868 | 8861 | 8862 | 8863 | 8864 | 8865 | 8866 | 5176 | 9229 |
| **test** | 8968 | 8961 | 8962 | 8963 | 8964 | 8965 | 8966 | 5276 | 9329 |

Infra ports already differ: Postgres 5432/5433, Redis 6379/6380, MinIO 9000/9002, Qdrant 6333/6335.

Every script reads these from `.env.test` rather than hardcoding them, and `pnpm stack:test:doctor`
fails if any test port has drifted back onto its dev counterpart — that drift is what would let a
suite silently hit the DEV database.

### Prerequisites

- Node.js >= 22.12, pnpm, Docker + Docker Compose
- conda with the shared `arcaenv` environment (Python 3.11) for anything that starts a Python
  service — create it with `pnpm setup:python`
- `.env` (Docker Compose interpolation, generated), `.env.sample` (tracked template), `.env.dev`
  (dev API, gitignored, created from `.env.sample` by `pnpm setup:dev`), `.env.test` (test stack,
  gitignored, created from `.env.sample` by `pnpm setup:test`) at the repo root

### Test environment isolation

The test stack is isolated from dev: Postgres 5433, Redis 6380, MinIO 9002, Qdrant 6335, Vault
8201, static DB/Redis/MinIO credentials, and its own isolated dev-mode Vault (`hope-vault-test`)
for secret warming + Transit encryption — the test infra runs its own Vault + init sidecar, it
does not borrow the dev `hope-vault` container. See also [../tests/README.md](../tests/README.md).

## Gotchas

- **`pnpm infra:test:down` (and `--restart`) REMOVE volumes.** Test infra is designed to be
  throwaway; do not run it against data you meant to keep.
- **`pnpm gen:mapper` / `pnpm gen:repository` are destructive/broken**, and `gen-guard.sh` is a
  confirmation wrapper, not permission: `generate-mapper` crashes partway through but not before
  rewriting the mappers it already processed, and its output drops the `FIELDS_NOT_WRITABLE =
  ['version']` OCC guard from every mapper it touches; `generate-repository` fails immediately on
  a bad argument. See `.claude/rules/03-domain-layer.md`.
- **`pnpm db:all` resets the database** (`prisma db push --force-reset --accept-data-loss`) —
  intended for a fresh/empty DB. On a DB whose data you want to keep, use `pnpm gen:prisma push
  --all` (no reset) followed by `pnpm db:seed`.
- **Two "no port" workers are invisible to a plain health probe**: the harness Temporal worker
  (`pnpm worker:dev`) polls Temporal's task queue, and the STT batch worker (`pnpm
  stt:worker:dev`) consumes the Dramatiq queue `dramatiq:stt_batch`. `pnpm stack:dev:doctor`
  reports them separately as `harness worker process` and `stt batch worker process`. If the STT
  batch worker is down, batch transcription jobs are still accepted and persisted as `QUEUED` but
  never execute.
- **`start-test-app.sh` and `dev-stack.sh` refuse a second Temporal worker and a bound port** —
  dev and test app ports are independent (see the table above), but a stray process holding a
  port from a previous run still blocks the next start.
- **Re-run `refresh-vault-creds.sh` only after a Vault container/volume reset**, not per restart —
  the dev AppRole's raw `secret_id` stays valid for ~30 days and survives `nest start --watch`
  process restarts.
- **`pnpm sdk:publish` peers must be `workspace:^`, not `workspace:*`** — pnpm rewrites
  `workspace:^` to a range (`^2.0.7`) that survives the next bump, but rewrites `workspace:*` to
  an exact pin (`2.0.7`) that breaks on any drift. A hardcoded literal is never rewritten at all
  and silently goes stale.
- `scripts/publish-sdk.sh` is the manual release path. CI also has its own `publish-sdk` job
  (`.gitlab/ci/publish.yml`, triggered by an `SDK-<ver>`/`ALL-<ver>` tag) that drives the release
  through Changesets (`.changeset/`, `@changesets/cli`) and publishes to GitHub Packages
  (`npm.pkg.github.com`) — the two paths are independent of each other.
- **The Admin Console health card renders exactly what the gateway probe finds** — a "down" card
  means that service's port isn't answering right now. When you launch services as separate `pnpm
  <svc>:dev` terminals, a per-service startup crash is otherwise invisible except as that red
  card ~30s later; prefer `pnpm stack:dev`, which runs every service in one aggregated stream with
  port preflight and a cleanup trap, or diagnose with `pnpm stack:dev:doctor`.

## Related

- [../tests/README.md](../tests/README.md) — shared test tree and isolated test infrastructure
- [../infrastructure/README.md](../infrastructure/README.md) — local Docker Compose infrastructure
- [../.claude/rules/01-development-workflow.md](../.claude/rules/01-development-workflow.md) — layer gates and the exact commands each one runs
- [../.claude/rules/09-infrastructure-devops.md](../.claude/rules/09-infrastructure-devops.md) — configuration tiers, env-file precedence, cluster deploys
