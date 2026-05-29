# HOPE Infrastructure — Docker Compose

This directory holds the local-dev Docker Compose stacks for HOPE.

| File | Purpose |
|---|---|
| `docker-compose.yml` | Core services always required for local dev (Postgres, Redis, MinIO). |
| `docker-compose.dev.yml` | Optional extensions (Vault, Qdrant) — opt-in via Compose profiles. |
| `configs/vault/` | Vault dev-mode bootstrap (Phase 1A, TASK-302 Stream B). |
| `mlflow/`, `python-base/`, `scripts/` | Service-specific assets. |
| `README-STT-ORCHESTRA.md`, `QDRANT-SETUP.md`, `QDRANT-QUICK-REFERENCE.md` | Per-service runbooks. |

---

## HashiCorp Vault (default for local dev — TASK-312)

As of TASK-312 Phase A, `.env.dev` ships **Vault as the default secrets
provider** (`SECRETS_PROVIDER=vault`) **with dynamic PostgreSQL credentials
enabled** (`PG_DYNAMIC_CREDS=true`). The API authenticates to Vault via AppRole,
warms its secret cache from `secret/hope/*`, and mints a short-lived PG user
from Vault's database engine on every boot — the same posture used in
production, so local dev exercises the real code path.

> **Production Vault** (HA Raft + Transit auto-unseal on Proxmox k3s) is a
> separate stack: [`infrastructure/single-deployment/vault/`](../single-deployment/vault/README.md)
> for deployment, [`docs/operations/vault/`](../../docs/operations/vault/README.md)
> for the day-2 operator runbook (rotation, failover, recovery, monitoring, chaos).
> This Compose stack is **local dev only**.

### Quickstart — one command

```bash
# From the monorepo root. Brings a fresh (or freshly-reset) checkout to a
# bootable state: infra up → wait for Postgres+Vault → migrations+seed →
# refresh AppRole creds in .env.dev → bootstrap Vault's DB engine + smoke test.
pnpm dev:setup

# Then start the API (now boots against Vault with dynamic PG creds):
pnpm dev:api
```

`pnpm dev:setup` (→ `scripts/dev-setup.sh`) is the source of truth and is
idempotent — safe to re-run. It orchestrates three helper scripts you can also
run individually:

| Script | Does | Re-run when |
|---|---|---|
| `scripts/refresh-vault-creds.sh` | Reads the current `role_id` and mints a fresh **raw, reusable** `secret_id`, writing `VAULT_ROLE_ID` + `VAULT_SECRET_ID` in `.env.dev` (and blanking the prod-only `VAULT_WRAPPED_SECRET_ID`). | After `docker compose down -v` or recreating the Vault container. **Not** per restart (see below). |
| `scripts/setup-dev-vault-db.sh` | Creates the `vault_admin` + `hope_app_template` PG roles (via `vault-admin-bootstrap.sql`), (re-)points Vault's DB engine at the real dev DB (`hope`), and smoke-tests credential issuance. | After a Docker volume reset, or whenever migrations recreate the schema. |
| `pnpm db:all` | Prisma migrations + seed (creates the `hope` DB + `core` schema the DB engine grants against). | Standard migration workflow. |

> **`pnpm db:all` RESETS the database.** It runs `prisma db push --force-reset
> --accept-data-loss`, which **drops and recreates** the schema (and trips
> Prisma's built-in agent guard that refuses the reset without explicit
> consent). That's the intended behaviour for a fresh/empty DB. On a DB whose
> data you want to keep, use the **non-destructive** push instead:
>
> ```bash
> pnpm gen:prisma push --all   # plain `prisma db push` — no reset / data loss
> pnpm db:seed
> ```

### Why you don't re-run the refresh script on every restart

The dev AppRole is provisioned with `secret_id_ttl=720h` and
`secret_id_num_uses=0` (TASK-312 A.1), and dev uses the **raw** `secret_id`
(`VAULT_SECRET_ID`). That secret_id stays valid for **~30 days** and is
reusable across unlimited restarts — including the constant process restarts
that `nest start --watch` performs on every file save. Re-run
`refresh-vault-creds.sh` only after wiping the Vault container (dev-mode state
is in-memory) or once the 30-day TTL lapses.

> **Dev vs. prod credential shape.** A response-wrapped `secret_id`
> (`VAULT_WRAPPED_SECRET_ID`) is **single-use** — `VaultSecretsProvider.boot()`
> unwraps it on every process start, so the second boot fails with `wrapping
> token is not valid`. That's the right shape for **production** (a fresh
> wrapped token is injected per pod), but it breaks the watch loop in dev.
> Local dev therefore uses the raw, reusable `secret_id`. If both vars are set,
> the provider prefers the wrapped one — so dev keeps `VAULT_WRAPPED_SECRET_ID`
> blank.

### What the `vault-init` sidecar provisions

- `kv-v2` at `secret/` — static secrets; `secret/hope/*` seeded with
  `dev-*-not-for-prod` placeholders for all 11 `COMMON_SERVICE_WARMUP_KEYS`.
- `transit` at `transit/` — envelope encryption for `GlobalSetting` rows.
- `database` at `database/` — dynamic PostgreSQL credentials. The sidecar runs
  before migrations exist, so its initial connection test is expected to fail;
  `setup-dev-vault-db.sh` re-applies the config once the DB + roles exist.
- File audit device at `/vault/audit/vault-audit.log` (TASK-312 A.4),
  bind-mounted to the host at `/tmp/hope-vault-audit`. The API's
  `VaultRotationWorker` tails this host path (`VAULT_AUDIT_LOG_PATH`) to
  publish cache-invalidation events on operator-driven rotations.

The `hope-app` policy and AppRole are pre-provisioned.

### Opting out (env-mode)

To run without Vault, set `SECRETS_PROVIDER=env` and `PG_DYNAMIC_CREDS=false`
in `.env.dev`; the app then reads secrets directly from `.env.dev` and connects
with the static `DATABASE_URL`. The Vault containers can stay down in this mode.

### Troubleshooting a failed `pnpm dev:api` boot

The errors below are the common first-boot failures on a fresh checkout (or
after `docker compose down -v`, which wipes the in-memory dev Vault). They
surface in boot order — fixing one reveals the next — so the fastest path is
just `pnpm dev:setup`, which performs every step idempotently. To debug a
single stage:

| Symptom in the boot log | Root cause | Fix |
|---|---|---|
| `SecretsModule: VAULT_ROLE_ID (or VAULT_ROLE_ID_FILE) is required when SECRETS_PROVIDER=vault` | `.env.dev` defaults to `SECRETS_PROVIDER=vault` but `VAULT_ROLE_ID` / `VAULT_SECRET_ID` are blank (fresh clone, or the Vault container was recreated). | `./scripts/refresh-vault-creds.sh` (needs the `hope-vault` container up). |
| `CoreDatabaseService … failed to find entry for connection with name: "hope-main"` | Vault's `database` engine has the `hope-app-role` role but **no** `database/config/hope-main` connection — `setup-dev-vault-db.sh` hasn't run (or ran before migrations existed). | `./scripts/setup-dev-vault-db.sh`. |
| `setup-dev-vault-db.sh` → `ERROR: schema 'core' not found in database 'hope'` | The dev DB was never migrated/seeded. | `pnpm gen:prisma push --all && pnpm db:seed`, then re-run `setup-dev-vault-db.sh`. |
| `Starting inspector on 127.0.0.1:9229 failed: address already in use`, or the API can't bind `8868` | A stale `nest start --watch` from a previous session is still holding the port — watch-mode children outlive the shell that started them. | `lsof -nP -iTCP:8868 -iTCP:9229 -sTCP:LISTEN` → `kill -9 <pid>` (or `pkill -9 -f 'hope-v2/apps/api'`), then retry. |
| `wrapping token is not valid` on the **2nd** boot (first `--watch` reload) | `VAULT_WRAPPED_SECRET_ID` (the single-use prod shape) is set in dev. | Blank it and use the raw, reusable `VAULT_SECRET_ID`: re-run `refresh-vault-creds.sh`. |

A clean boot ends with:

```text
[VaultSecretsProvider] Vault AppRole login successful (lease_duration=3600s, renewable=true)
[NestApplication] Nest application successfully started
[Bootstrap] Application started { environment=development, port=8868, … }
```

Verify it serves traffic: `curl -s http://localhost:8868/api/v1/health` → `{"status":"healthy",…}`.

### Manual AppRole bootstrap (reference / debugging)

`refresh-vault-creds.sh` automates the steps below; they're kept here for
understanding the flow:

```bash
# role_id (committable, non-secret)
docker exec hope-vault sh -lc 'VAULT_TOKEN=root vault read -field=role_id auth/approle/role/hope-app/role-id'

# DEV: raw secret_id (reusable; goes in VAULT_SECRET_ID)
docker exec hope-vault sh -lc 'VAULT_TOKEN=root vault write -f -field=secret_id auth/approle/role/hope-app/secret-id'

# PROD: one-shot response-wrapped secret_id (goes in VAULT_WRAPPED_SECRET_ID)
# Size -wrap-ttl to the MAX delay between minting and pod boot, not longer — a
# wrapped token is meant to be unwrapped immediately at startup. 60-300s is
# typical; 86400s (24h) shown only to survive a slow manual copy/paste in a demo.
docker exec hope-vault sh -lc 'VAULT_TOKEN=root vault write -wrap-ttl=120s -f -field=wrapping_token auth/approle/role/hope-app/secret-id'
```

See the full plan + production HA / multi-cloud blueprint in
[`TASK-312-Vault-Workflow-Hardening/README.md`](../../docs/implementation/TASK-312-Vault-Workflow-Hardening/README.md),
the original migration in
[`02-vault-migration.md`](../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/02-vault-migration.md),
and the HA deployment notes at
[`research/deployments/deploy-vm430-432-vault.md`](../../research/deployments/deploy-vm430-432-vault.md).
