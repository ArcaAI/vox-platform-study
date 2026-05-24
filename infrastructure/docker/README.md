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

## HashiCorp Vault (opt-in for local dev)

Local development uses `EnvSecretsProvider` by default (`.env.dev` values).
Vault is **not** required for normal `pnpm dev`. To exercise the Vault code path
locally, opt in:

```bash
# 1. Start Vault + init container (from monorepo root)
docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault up -d

# Or from this directory:
#   cd infrastructure/docker && docker compose --profile vault up -d

# 2. Note the printed AppRole role_id (committable, non-secret)
docker logs hope-vault-init | grep 'role_id'

# 3. Mint a one-shot wrapped secret_id (60-second TTL)
docker exec hope-vault vault write -wrap-ttl=60s -f auth/approle/role/hope-app/secret-id

# 4. Switch the app to the Vault provider
export SECRETS_PROVIDER=vault
export VAULT_ADDR=http://localhost:8200
export VAULT_ROLE_ID=<role_id from step 2>
export VAULT_WRAPPED_SECRET_ID=<wrapping_token from step 3>
pnpm dev:api
```

The `vault-init` sidecar mounts:
- `kv-v2` at `secret/` (versioned static secrets — `secret/hope/*` seeded with `dev-*-not-for-prod` placeholders)
- `transit` at `transit/` (envelope encryption for `GlobalSetting` rows, Phase 4)
- `database` at `database/` (dynamic PostgreSQL credentials, Phase 5)
- File audit device writing to `/vault/file/vault-audit.log` (inside the container)

The `hope-app` policy and AppRole are pre-provisioned. See
[`02-vault-migration.md`](../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/02-vault-migration.md)
for the full plan and the production HA blueprint at
[`research/deployments/deploy-vm430-432-vault.md`](../../research/deployments/deploy-vm430-432-vault.md).
