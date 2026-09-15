# HOPE Infrastructure — Docker Compose (local dev only)

Local-dev Docker Compose stacks for HOPE: the always-on core services and a set of
profile-gated extensions (Vault, Temporal, Qdrant, reranker, observability, self-host inference,
MLflow, GGUF servers). Not used by CI or the cluster deployment.

## Layout

| Path | Purpose |
|---|---|
| `docker-compose.yml` | Core services always required for local dev (Postgres, Redis, MinIO) |
| `docker-compose.dev.yml` | Optional extensions (Vault, Temporal, Qdrant, reranker, observability, inference, MLflow, GGUF) — opt-in via Compose profiles, except Qdrant which is unprofiled |
| `configs/vault/` | Vault dev-mode bootstrap (`dev-init.sh`, `test-init.sh`, `policies/*.hcl`) |
| `configs/temporal/`, `configs/prometheus/`, `configs/grafana/` | Per-profile service config, mounted read-only |
| `python-base/` | `hope-python-base` shared image (Python 3.11 + uv + non-root user) |
| `scripts/init-qdrant-collections.py` | Qdrant collection bootstrap shared by dev and test |
| `lmstudio/` | The `hope-lmstudio` headless GPU serving image — see [lmstudio/README.md](lmstudio/README.md) |
| `minio/` | MinIO bucket layout, IAM policies, `hope-models` publishing convention — see [minio/README.md](minio/README.md) |
| `README-STT-ORCHESTRA.md`, `QDRANT-SETUP.md`, `QDRANT-QUICK-REFERENCE.md` | Historical per-service runbooks |
| `env.stt-dev.example` | Legacy STT Orchestra env template |

## Commands

```bash
# From the monorepo root. Brings a fresh (or freshly-reset) checkout to a
# bootable state: infra up -> wait for Postgres+Vault -> migrations+seed ->
# refresh AppRole creds in .env.dev -> bootstrap Vault's DB engine + smoke test.
pnpm setup:dev

# Then start the API:
pnpm api:dev
```

`pnpm setup:dev` (-> `scripts/dev-setup.sh`) is idempotent and orchestrates three helper scripts
you can also run individually:

| Script | Does | Re-run when |
|---|---|---|
| `scripts/refresh-vault-creds.sh` | Reads the current `role_id` and mints a fresh **raw, reusable** `secret_id`, writing `VAULT_ROLE_ID` + `VAULT_SECRET_ID` in `.env.dev` (blanking the prod-only `VAULT_WRAPPED_SECRET_ID`) | After `docker compose down -v` or recreating the Vault container. Not per restart — see Gotchas |
| `scripts/setup-dev-vault-db.sh` | Creates the `vault_admin` + `hope_app_template` PG roles, (re-)points Vault's DB engine at the dev DB (`hope`), smoke-tests credential issuance | After a Docker volume reset, or whenever migrations recreate the schema — only needed if you opt in to dynamic DB credentials (see How it works) |
| `pnpm db:all` | Prisma migrations + seed | Standard migration workflow |

```bash
pnpm infra:dev:up:observability     # Prometheus :9090 + Grafana :3001
pnpm infra:dev:down
```

## How it works

### Secrets provider and dynamic DB credentials

`.env.sample` ships **Vault as the default secrets provider** (`SECRETS_PROVIDER=vault`). The API
authenticates to Vault via AppRole and warms its secret cache from `secret/hope/*`. **Dynamic
PostgreSQL credentials are opt-in, not the default** (`.env.sample` ships `PG_DYNAMIC_CREDS=false`)
— set `PG_DYNAMIC_CREDS=true` in `.env.dev` to have the API mint a short-lived PG user from
Vault's database engine on boot, the same posture used in production.

To run without Vault entirely, set `SECRETS_PROVIDER=env` in `.env.dev`; the app then reads
secrets directly from `.env.dev` and connects with the static `DATABASE_URL`. The Vault
containers can stay down in this mode.

### What the `vault-init` sidecar provisions

- `kv-v2` at `secret/` — static secrets; `secret/hope/*` seeded with `dev-*-not-for-prod`
  placeholders for the service warmup keys.
- `transit` at `transit/` — envelope encryption for `GlobalSetting` rows.
- `database` at `database/` — dynamic PostgreSQL credentials (only exercised when
  `PG_DYNAMIC_CREDS=true`). The sidecar runs before migrations exist, so its initial connection
  test is expected to fail; `setup-dev-vault-db.sh` re-applies the config once the DB + roles
  exist.
- File audit device at `/vault/audit/vault-audit.log`, bind-mounted to the host at
  `/tmp/hope-vault-audit`. The API's `VaultRotationWorker` tails this host path
  (`VAULT_AUDIT_LOG_PATH`) to publish cache-invalidation events on operator-driven rotations.

The `hope-app` policy and AppRole are pre-provisioned.

### Dev vs. prod credential shape

A response-wrapped `secret_id` (`VAULT_WRAPPED_SECRET_ID`) is single-use — `VaultSecretsProvider.boot()`
unwraps it on every process start, so a second boot fails with `wrapping token is not valid`.
That's the right shape for **production** (a fresh wrapped token is injected per pod), but it
breaks the watch loop in dev. Local dev therefore uses the raw, reusable `secret_id`
(`VAULT_SECRET_ID`, ~30-day TTL, unlimited uses). If both vars are set, the provider prefers the
wrapped one — so dev keeps `VAULT_WRAPPED_SECRET_ID` blank.

### Observability (optional, default off)

Services may expose `/metrics` (passive pull), but must never require a reachable observability
backend to start, serve traffic, or stay quiet in logs. Local dev runs with zero observability
tools by default.

| Service | To enable OTLP export |
|---|---|
| API gateway | Set `OTEL_EXPORTER_OTLP_ENDPOINT` (only read by `pnpm api:start` / Docker — never `pnpm api:dev`). Kill-switch: `OTEL_SDK_DISABLED=true` |
| NLP | `NLP_OTEL_ENABLED=true` **and** `OTEL_EXPORTER_OTLP_ENDPOINT` |
| STT / TEXT / Guardrail / Harness | Their own `*_OTEL_ENABLED` flags (`OTEL_ENABLED`, `TEXT_OTEL_ENABLED`, `GUARDRAIL_V2_OTEL_ENABLED`, `HARNESS_OTEL_ENABLED`), each defaulting to `false` |

Without the observability profile up, the Admin Console metrics tiles render em-dashes by design.

### API production image — the `sharp` native binary

The NestJS API image (`apps/api/Dockerfile`) bundles `sharp` (`^0.35.4`, a native module used by
`ImageThumbnailService` for WebP thumbnails) on a **glibc** runtime base
(`node:24-bookworm-slim`, `ARG NODE_VERSION=24`) — not Alpine/musl — so `sharp`'s default
prebuilt loads with no extra system packages. If the native binary fails to load at runtime,
thumbnail generation degrades silently to the full-size image URL instead of crashing; a
build-time smoke gate (`require('sharp')` right after `pnpm install --prod`) exists so a broken
binary fails the build instead.

## Gotchas

- **Don't re-run `refresh-vault-creds.sh` on every restart.** The dev AppRole's raw `secret_id`
  stays valid for ~30 days across unlimited restarts, including the process restarts `nest start
  --watch` performs on every file save.
- **`pnpm db:all` RESETS the database** (`prisma db push --force-reset --accept-data-loss`). On a
  DB whose data you want to keep, use the non-destructive push instead: `pnpm gen:prisma push
  --all` then `pnpm db:seed`.
- **The hand-maintained per-package `COPY package.json` lists in `apps/api/Dockerfile` must list
  every workspace package the image needs at runtime.** pnpm resolves the whole workspace graph
  before pruning dev deps, so a single missing `package.json` aborts `pnpm install` entirely — no
  prod dependency installs, `sharp` included. `**/*.tsbuildinfo` is excluded in `.dockerignore`
  for the same class of failure: a host-stale incremental-build cache convinces `tsc --build` a
  package is already built and it skips emitting `dist`, so a downstream package's `tsc` cannot
  resolve it.
- A clean API boot against Vault ends with `[VaultSecretsProvider] Vault AppRole login successful`
  then `[NestApplication] Nest application successfully started`. Verify it serves traffic:
  `curl -s http://localhost:8868/api/v1/health`.
- **First-boot failure symptoms, in the order they surface** (fixing one reveals the next — or
  just run `pnpm setup:dev`, which performs every step idempotently):

  | Symptom | Root cause | Fix |
  |---|---|---|
  | `SecretsModule: VAULT_ROLE_ID (or VAULT_ROLE_ID_FILE) is required when SECRETS_PROVIDER=vault` | `.env.dev` defaults to `SECRETS_PROVIDER=vault` but `VAULT_ROLE_ID` / `VAULT_SECRET_ID` are blank | `./scripts/refresh-vault-creds.sh` (needs `hope-vault` up) |
  | `CoreDatabaseService ... failed to find entry for connection with name: "hope-main"` | With `PG_DYNAMIC_CREDS=true`, Vault's `database` engine has the role but no `database/config/hope-main` connection yet | `./scripts/setup-dev-vault-db.sh` |
  | `setup-dev-vault-db.sh` -> `ERROR: schema 'core' not found in database 'hope'` | The dev DB was never migrated/seeded | `pnpm gen:prisma push --all && pnpm db:seed`, then re-run `setup-dev-vault-db.sh` |
  | `Starting inspector on 127.0.0.1:9229 failed: address already in use`, or the API can't bind `8868` | A stale `nest start --watch` from a previous session still holds the port | `lsof -nP -iTCP:8868 -iTCP:9229 -sTCP:LISTEN` then kill the pid, and retry |
  | `wrapping token is not valid` on the 2nd boot | `VAULT_WRAPPED_SECRET_ID` (the single-use prod shape) is set in dev | Blank it and use the raw `VAULT_SECRET_ID` via `refresh-vault-creds.sh` |

## Related

- [../README.md](../README.md) — the infrastructure directory map (local dev vs. retired blueprints vs. cluster)
- [../single-deployment/vault/README.md](../single-deployment/vault/README.md) — the retired production Vault HA blueprint
- [../../docs/operations/vault/README.md](../../docs/operations/vault/README.md) — day-2 Vault operator runbook (rotation, failover, recovery, monitoring)
- [../../docs/research/deployments/deploy-vm430-432-vault.md](../../docs/research/deployments/deploy-vm430-432-vault.md) — HA deployment notes for the retired VM-based blueprint
- [../../.claude/rules/09-infrastructure-devops.md](../../.claude/rules/09-infrastructure-devops.md) — configuration tiers, in-cluster deployment topology
