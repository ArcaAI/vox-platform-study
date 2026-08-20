# HOPE Infrastructure — Docker Compose

This directory holds the local-dev Docker Compose stacks for HOPE.

| File                                                                      | Purpose                                                               |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `docker-compose.yml`                                                      | Core services always required for local dev (Postgres, Redis, MinIO). |
| `docker-compose.dev.yml`                                                  | Optional extensions (Vault, Qdrant) — opt-in via Compose profiles.    |
| `configs/vault/`                                                          | Vault dev-mode bootstrap (Phase 1A, TASK-302 Stream B).               |
| `python-base/`, `scripts/`                                                | Service-specific assets.                                              |
| `README-STT-ORCHESTRA.md`, `QDRANT-SETUP.md`, `QDRANT-QUICK-REFERENCE.md` | Per-service runbooks.                                                 |

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
pnpm setup:dev

# Then start the API (now boots against Vault with dynamic PG creds):
pnpm api:dev
```

`pnpm setup:dev` (→ `scripts/dev-setup.sh`) is the source of truth and is
idempotent — safe to re-run. It orchestrates three helper scripts you can also
run individually:

| Script                           | Does                                                                                                                                                                                           | Re-run when                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `scripts/refresh-vault-creds.sh` | Reads the current `role_id` and mints a fresh **raw, reusable** `secret_id`, writing `VAULT_ROLE_ID` + `VAULT_SECRET_ID` in `.env.dev` (and blanking the prod-only `VAULT_WRAPPED_SECRET_ID`). | After `docker compose down -v` or recreating the Vault container. **Not** per restart (see below). |
| `scripts/setup-dev-vault-db.sh`  | Creates the `vault_admin` + `hope_app_template` PG roles (via `vault-admin-bootstrap.sql`), (re-)points Vault's DB engine at the real dev DB (`hope`), and smoke-tests credential issuance.    | After a Docker volume reset, or whenever migrations recreate the schema.                           |
| `pnpm db:all`                    | Prisma migrations + seed (creates the `hope` DB + `core` schema the DB engine grants against).                                                                                                 | Standard migration workflow.                                                                       |

> **`pnpm db:all` RESETS the database.** It runs `prisma db push --force-reset
--accept-data-loss`, which **drops and recreates** the schema (and trips
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
token is not valid`. That's the right shape for **production** (a fresh
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

### Troubleshooting a failed `pnpm api:dev` boot

The errors below are the common first-boot failures on a fresh checkout (or
after `docker compose down -v`, which wipes the in-memory dev Vault). They
surface in boot order — fixing one reveals the next — so the fastest path is
just `pnpm setup:dev`, which performs every step idempotently. To debug a
single stage:

| Symptom in the boot log                                                                             | Root cause                                                                                                                                                                        | Fix                                                                                                                |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SecretsModule: VAULT_ROLE_ID (or VAULT_ROLE_ID_FILE) is required when SECRETS_PROVIDER=vault`      | `.env.dev` defaults to `SECRETS_PROVIDER=vault` but `VAULT_ROLE_ID` / `VAULT_SECRET_ID` are blank (fresh clone, or the Vault container was recreated).                            | `./scripts/refresh-vault-creds.sh` (needs the `hope-vault` container up).                                          |
| `CoreDatabaseService … failed to find entry for connection with name: "hope-main"`                  | Vault's `database` engine has the `hope-app-role` role but **no** `database/config/hope-main` connection — `setup-dev-vault-db.sh` hasn't run (or ran before migrations existed). | `./scripts/setup-dev-vault-db.sh`.                                                                                 |
| `setup-dev-vault-db.sh` → `ERROR: schema 'core' not found in database 'hope'`                       | The dev DB was never migrated/seeded.                                                                                                                                             | `pnpm gen:prisma push --all && pnpm db:seed`, then re-run `setup-dev-vault-db.sh`.                                 |
| `Starting inspector on 127.0.0.1:9229 failed: address already in use`, or the API can't bind `8868` | A stale `nest start --watch` from a previous session is still holding the port — watch-mode children outlive the shell that started them.                                         | `lsof -nP -iTCP:8868 -iTCP:9229 -sTCP:LISTEN` → `kill -9 <pid>` (or `pkill -9 -f 'hope-v2/apps/api'`), then retry. |
| `wrapping token is not valid` on the **2nd** boot (first `--watch` reload)                          | `VAULT_WRAPPED_SECRET_ID` (the single-use prod shape) is set in dev.                                                                                                              | Blank it and use the raw, reusable `VAULT_SECRET_ID`: re-run `refresh-vault-creds.sh`.                             |

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
[`TASK-312-Vault-Workflow-Hardening/README.md`](../../docs/archive/TASK-312-Vault-Workflow-Hardening/README.md) (archived),
the original migration in
[`02-vault-migration.md`](../../docs/archive/TASK-302-System-Config-Implementation-Roadmap/02-vault-migration.md) (archived),
and the HA deployment notes at
[`docs/research/deployments/deploy-vm430-432-vault.md`](../../docs/research/deployments/deploy-vm430-432-vault.md).

---

## Observability (optional, default off)

**Invariant (TASK-411):** services may expose `/metrics` (passive pull), but must
**never** require a reachable observability backend (Prometheus / Grafana / OTel
collector / Loki / Tempo) to start, serve traffic, or stay quiet in logs. Local
dev runs with **zero** observability tools by default.

### Opt-in pull stack (Prometheus + Grafana)

```bash
pnpm infra:dev:up:observability     # Prometheus :9090 · Grafana :3001
pnpm infra:dev:down
```

Alias for the TASK-397 canonical command
(`docker compose -f infrastructure/docker/docker-compose.dev.yml --profile prometheus up -d prometheus grafana`).
Without it the Admin Console metrics tiles render em-dashes **by design** (TASK-386).

### Opt-in push telemetry (OTel / OTLP)

Per-service master switches — all default **OFF**:

| Service                         | To enable export                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| API gateway                     | Set `OTEL_EXPORTER_OTLP_ENDPOINT` (only read by `pnpm start` / `start:prod` / Docker — never `pnpm dev`). Kill-switch: `OTEL_SDK_DISABLED=true`. |
| NLP                             | `NLP_OTEL_ENABLED=true` **and** `OTEL_EXPORTER_OTLP_ENDPOINT`.                                                                                   |
| STT / TEXT / Guardrail / Harness | Their existing `*_OTEL_ENABLED` flags (`OTEL_ENABLED`, `TEXT_OTEL_ENABLED`, `GUARDRAIL_V2_OTEL_ENABLED`, `HARNESS_OTEL_ENABLED`).                 |

See TASK-411 (this invariant + the opt-in gates) and TASK-397 (dev `prometheus` profile).

---

## API production image — `sharp` native binary (TASK-375 thumbnail follow-up)

The NestJS API image (`apps/api/Dockerfile`) bundles **`sharp`** (a native
module). `@arcaai/applications`' `ImageThumbnailService` uses it to generate WebP
thumbnails on image upload (TASK-375 §4.2 / 2026-06-27 Change History). If
`sharp`'s platform-native binary can't load at runtime, thumbnail generation
throws and the read path **silently degrades `thumbnailUrl` to the full-size
image URL** — no crash, just oversized payloads. This section documents how the
image guarantees the binary is present, and how to verify it.

### Base image is already glibc — no Alpine/musl or system `vips` needed

The runtime stage is **`node:22-slim`** (Debian Bookworm, **glibc 2.36**), not
Alpine/musl. `sharp@0.35.2`'s default prebuilt (`@img/sharp-linux-{x64,arm64}`
plus the bundled `@img/sharp-libvips-*`) loads out of the box — libvips 8.18.3
ships _inside_ the prebuilt, so no `apt-get install … libvips`/build deps are
required. Verified directly on both deploy arches:

```bash
# arm64 (Apple-Silicon host) and linux/amd64 (add: --platform linux/amd64)
docker run --rm node:22-slim bash -lc \
  'npm i -g pnpm >/dev/null && cd /tmp && pnpm init >/dev/null && \
   pnpm add sharp@0.35.2 >/dev/null && \
   node -e "console.log(require(\"sharp\").versions.vips)"'
# → 8.18.3   (both arm64 and amd64; @img/sharp-linux-x64 / -arm64 + libvips installed)
```

Because the base is glibc, the task's Alpine/musl branch (install
`@img/sharp-linuxmusl-*` + `vips`, or switch to a glibc base) does **not** apply
— the image is already on the reliable glibc path.

### What actually blocked `sharp`, and the fix

`sharp` itself is fine; the blocker was that the API image **could not build at
all**. The hand-maintained per-package `COPY …/package.json` lists (in both the
`dependencies` and `production` stages) were missing two workspace packages added
after the list was last curated: `@arcaai/types` (a **runtime** dep of
`@arcaai/applications`, TASK-318) and `eslint-plugin-arcaai-internal` (a dev dep
of `@arcaai/api` + `@arcaai/config-eslint`, TASK-307). pnpm resolves the **whole**
workspace graph before pruning dev deps, so a single missing `package.json`
aborts the install:

```text
ERR_PNPM_WORKSPACE_PKG_NOT_FOUND  In apps/api: "eslint-plugin-arcaai-internal@workspace:*"
  is in the dependencies but no package named "eslint-plugin-arcaai-internal" is present
```

With the install dead, **no** prod dependency installed — `sharp` included. The
surgical, Docker-only fix:

1. **`dependencies` + `production` stages** — add the two missing
   `COPY packages/{types,eslint-plugin-arcaai-internal}/package.json` lines so
   `pnpm install [--prod]` resolves and installs `sharp` + its platform optional
   dep (`@img/sharp-linux-x64` on amd64, `…-arm64` on arm64).
2. **`production` runtime copy** — add `packages/types/dist` (its
   `StorageProvider` **enum** is `require()`d at boot by the compiled storage
   providers), mirroring the existing domains/exceptions/logger copies.
3. **Build-time smoke gate** — right after `pnpm install --prod`, the build now
   runs `require('sharp')` from `@arcaai/applications`. If the native binary
   can't load, **the build fails loudly** instead of the app silently degrading
   at runtime. (It must resolve from the applications package: pnpm's isolated
   `node_modules` does **not** hoist `sharp` to `/app/node_modules`, so a naïve
   `node -e "require('sharp')"` from the image root would falsely fail.)

### Build + verify

```bash
# Build for the DEPLOYMENT target arch. On an Apple-Silicon host targeting x86-64
# servers, add --platform linux/amd64 so the amd64 sharp binary is installed:
docker build --target production -f apps/api/Dockerfile -t hope-api:local .
#   → build log shows the gate passing:  [build] sharp native binary OK — libvips 8.18.3

# Smoke-test the native binary inside the built image. Resolve from the package
# that OWNS sharp — the image root does not (pnpm isolated layout). cwd MUST be set
# BEFORE node launches: a `node -e` script's require() paths are fixed from cwd at
# startup, so an in-script `process.chdir('/app/packages/applications')` runs too
# late and fails with `Cannot find module 'sharp'`. Use `sh -c "cd … && node -e …"`
# (this also matches the build-time gate, which uses `cd … && node -e`):
docker run --rm hope-api:local \
  sh -c "cd /app/packages/applications && \
         node -e \"const s=require('sharp'); console.log('sharp ok', s.versions)\""
#   → sharp ok { … vips: '8.18.3', … sharp: '0.35.2' }
#   (require.resolve('sharp') → /app/node_modules/.pnpm/sharp@0.35.2/node_modules/sharp/dist/index.cjs)
```

**Verified (real output, this change):** a faithful reproduction of the
production stage's exact commands (`pnpm install --prod` → `pnpm store prune` →
`rm -rf ~/.pnpm-store`) on `node:22-slim` with the two COPY lines added installs
`@img/sharp-linux-arm64@0.35.2` and, **after pruning**, `require('sharp')` from
the applications dir prints `SHARP_OK … "vips":"8.18.3" … "sharp":"0.35.2"`. So
the binary survives the prune and ships in the final image.

> ✅ **RESOLVED (2026-06-27) — clean-build `@arcaai/types` TS2307.** The full image
> now builds end-to-end (real `--target production` build, native arm64).
>
> **Root cause (not a build-graph ordering bug).** `@arcaai/types`' build is
> `tsc --build` (incremental). Turbo _does_ already schedule `@arcaai/types#build`
> ahead of `@arcaai/applications#build` — verified with
> `turbo run build --filter=@arcaai/applications... --dry-run` — so `^build`
> ordering was never the problem. The build **no-op'd**: `tsconfig.tsbuildinfo` is
> gitignored (`*.tsbuildinfo`) but was **not** `.dockerignore`d, so
> `COPY packages/ ./packages/` carried a _host-stale_ buildinfo into the container
> while `**/dist` was excluded. `tsc --build` trusts that buildinfo, declares the
> project "up to date", and **skips emit even though `dist` is absent** (confirmed
> empirically). With `packages/types/dist` never created, `@arcaai/applications`'
> plain `tsc` couldn't resolve the dep → `TS2307: Cannot find module '@arcaai/types'`.
> It only "worked locally" because developer disks already have a real
> `packages/types/dist`.
>
> **Fix (build-graph / infra only — one line).** Add `**/*.tsbuildinfo` to
> `.dockerignore`, right beside `**/dist`, classifying the incremental cache as a
> build artifact rebuilt in-container. The stale cache can no longer leak in, so the
> already-correctly-scheduled `@arcaai/types#build` does a clean emit. No
> `packages/types` change; **local/dev builds are unaffected** — `.dockerignore`
> only governs the Docker build context, never local `turbo`/`tsc`.
>
> **Verified (real output, this change).** `@arcaai/types:build` now executes
> (`cache bypass, force executing` → `tsc --build`); turbo reports
> `Tasks: 8 successful, 8 total`; **zero** `TS2307`/`error TS`; the production stage
> `COPY … /app/packages/types/dist` succeeds; the build-time gate prints
> `[build] sharp native binary OK — libvips 8.18.3`; and the final image ships
> `/app/packages/types/dist/index.js` (runtime `StorageProvider` enum =
> `MINIO`/`AWS_S3`/`AZURE_BLOB`) alongside `/app/apps/api/dist/main.js`. The in-image
> sharp smoke (corrected `cd` form above) prints
> `sharp ok { … vips: '8.18.3' … sharp: '0.35.2' }`.

> **Cross-reference:** TASK-375 (Admin Backend Enhancements) `README.md` §7 +
> the 2026-06-27 "Real downscaled image thumbnails" Change History entry — the
> `sharp@^0.35.2` follow-up this image change supports.
