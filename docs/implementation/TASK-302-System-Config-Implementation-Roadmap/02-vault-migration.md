# Plan: TASK-302 Stream B — HashiCorp Vault Secrets Migration

**Required Skill**: executing-plans
**Plan Version**: 1.0 (2026-05-24)
**Stream**: B (Vault) of the TASK-302 Implementation Roadmap
**Parent Ticket**: [TASK-301 System-Config Assessment](../TASK-301-System-Config-Multi-Tenancy-Assessment/README.md)
**Companion Stream A (Phase 0 Hotfix)**: [`01-phase-0-hotfix.md`](./01-phase-0-hotfix.md) — **hard dependency**
**Source Research**: [`research/architecture/system-config-multi-tenancy/02-secrets-cloud-kms-migration.md`](../../../research/architecture/system-config-multi-tenancy/02-secrets-cloud-kms-migration.md)
**Status**: Pending (awaits Phase 0 sign-off before kickoff)

---

## Goal

Replace HOPE's three-location secrets sprawl (process env, `process.env.*` raw reads, plaintext `GlobalSetting` rows) with a single audited, rotatable, fail-closed secrets path backed by **HashiCorp Vault** (primary) behind an `ISecretsProvider` adapter that keeps **AWS Secrets Manager** and **Azure Key Vault** wireable as drop-in alternatives without consumer code changes.

## Architecture Overview

A pluggable `SecretsModule` in `packages/applications` selects between four implementations of `ISecretsProvider` at boot via the `SECRETS_PROVIDER=env|vault|aws|azure` environment variable. `EnvSecretsProvider` is the **default in `NODE_ENV=development`** and reads from `.env.dev` for zero-config local work; `VaultSecretsProvider` is the **only wired non-env path** and is the **default in all non-development environments** (`staging`, `production`, `test:integration`). AWS and Azure providers compile but throw `NotImplementedException` so the interface stays portable for a future cloud cutover. All consumers get a single typed `SecretsService` (LRU cache + Redis Pub/Sub invalidation + `/readiness` health) that replaces every `process.env.*` secret read and every `AppSettingsService.getValueWithDefault('JWT_SECRET_KEY', …)` call site cited in the TASK-301 inventory.

Vault itself runs in three shapes: a dev-mode auto-unsealed container in `infrastructure/docker/docker-compose.dev.yml` for local work, a single-node bootstrap on a Proxmox VM for staging, and a 3-node Raft-storage HA cluster (deployed via the SRE blueprint at `research/deployments/deploy-vm430-432-vault.md`) for production. Pods authenticate via AppRole (`role_id` committed, `secret_id` response-wrapped at pod start). Vault's Transit secrets engine handles envelope encryption of DB-stored secrets (`GlobalSetting.encryptedValue`); Vault's Database secrets engine handles short-lived PostgreSQL credentials per pod via Prisma's `@prisma/adapter-pg` `password` callback. Static-secret rotation flows through `kv-v2` versioning + Vault webhook → Redis Pub/Sub `arca:secrets:invalidate` → in-process LRU eviction.

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Secrets manager (primary) | **HashiCorp Vault** | **1.18.x** (matches container, see Phase 1) |
| Vault storage backend (HA) | **Raft (integrated storage)** | bundled |
| Vault TLS termination | **HAProxy** (self-hosted) | 3.0+ |
| Secrets engines used | `kv-v2`, `transit`, `database`, `pki` (optional) | — |
| Auth methods | `approle` (machines), `userpass` (humans dev), `oidc` (humans prod opt) | — |
| Audit device | `file` (rotated by logrotate); future `socket` to SIEM | — |
| Node client (primary) | **`node-vault`** | `^0.10.4` (pure-TS, light) |
| Node client (alt) | `@hashicorp/vault-client-typescript` | `^0.4.x` (generated, heavier) — kept off the dep list unless we need OpenAPI types |
| Cache | in-process LRU (`mnemonist/lru-cache`) + Redis Pub/Sub (`ioredis`) | already in `packages/applications` |
| AWS provider (stub) | `@aws-sdk/client-secrets-manager` | not installed; `peerDependenciesMeta` optional |
| Azure provider (stub) | `@azure/identity` + `@azure/keyvault-secrets` | not installed; optional |
| Test harness | Vitest + Vault dev container + `testcontainers` | already in `packages/applications` |
| Prisma adapter | `@prisma/adapter-pg` `password` callback | Phase 5 only |
| CI gate | `gitleaks` (Phase 0) + new `vault-policy-lint` (Phase 1) | — |

## Decision Log

These decisions constrain every task below; revisit only with explicit user approval.

| # | Decision | Rationale | Implication |
|---|---|---|---|
| D1 | **Vault is the primary secrets manager** for local + self-hosted dev/staging/prod | HOPE is on Proxmox today; Vault is the only OSS option with a fully self-contained local-dev story (`vault server -dev`) and a clean HA story (Raft + Transit). Avoids cloud BAA dependency. | All non-stub provider work in this plan targets Vault. Cloud providers are kept as stubs for **future** cutover only. |
| D2 | **AWS Secrets Manager + Azure Key Vault providers are stub implementations** that throw `NotImplementedException` | The research doc keeps both cloud paths viable. Stubs preserve the `ISecretsProvider` abstraction and lock the interface shape; they are not deployed and require **no IAM / Managed Identity setup** in this plan. | Phase 2 ships 4 providers (`env`, `vault`, `aws`, `azure`) but only `env` + `vault` are wired in CI/CD. Cloud activation is a future ticket. |
| D3 | **Default provider per environment is**: `env` in `NODE_ENV=development`; `vault` in `staging`/`production`/`test:integration`; `env` in `test:unit` | Local devs must never need Vault credentials. Vault dev-mode container is opt-in via `SECRETS_PROVIDER=vault`. | Phase 2 factory hard-codes this default; selection cannot silently flip in prod. |
| D4 | **Bootstrap secret = AppRole `secret_id` response-wrapped at pod start; `role_id` lives in env/config-map** | OWASP guidance: never ship a long-lived `secret_id`. Wrapped `secret_id` is single-use with TTL. | Deployment pipeline mints the wrapped token via SRE-controlled job; pod unwraps once and authenticates. Phase 1B + Phase 7 cover this. |
| D5 | **Vault is NOT a BAA-covered managed service** | HashiCorp does not sign a BAA for self-hosted Vault; HOPE owns the operational + compliance responsibility for it. | Document this in the staging/prod runbooks (Appendix B). When the cloud move happens, swap provider via `SECRETS_PROVIDER=azure` and re-evaluate BAA scope. |
| D6 | **Fail-closed at boot, stale-while-revalidate at steady state** | Avoids degraded-mode silent failures (HIPAA §164.312(a)(2)(iv) breach risk). | `health()` returns `ok:false` if no cached value AND Vault unreachable; readiness probe drops the pod from LB. |
| D7 | **Local dev MUST NOT require Vault**; `EnvSecretsProvider` reads from `.env.dev` exactly as today | Friction-free onboarding; new dev needs only `pnpm install && pnpm dev`. | Phase 1A creates an **opt-in** Vault profile, never the default. Devs run `SECRETS_PROVIDER=vault docker compose --profile vault up vault vault-init` for the opt-in path. |
| D8 | **Envelope encryption uses Vault Transit** (not pg_pii_vault or libsodium-locally) | Centralised key management + rotation; HOPE never sees the DEK. Transit is the official Vault story. | Phase 4 adds `GlobalSetting.encryptedValue Bytes? + keyVersion Int?`; encrypt/decrypt round-trips Vault per write/read (mitigated by LRU cache + bulk transit operations). |
| D9 | **DB credentials migrate to Vault Database secrets engine** (Phase 5) using Prisma's `password` callback | Eliminates static `DATABASE_URL` password sprawl; aligns with research doc §2.1 and §5 Phase B. | Requires `@prisma/adapter-pg` and Phase 5 PgBouncer-session compatibility (separate Stream C). Phase 5 sequences AFTER Stream C reaches PgBouncer-session, OR uses direct pg in staging until C lands. |
| D10 | **Static-secret rotation via Vault `kv-v2` versioning + Redis Pub/Sub cache invalidation** | Industry-standard pattern; no Lambda/Function-App dependency for self-hosted; reuses HOPE's existing Redis 7 fleet. | Phase 6 introduces a small Vault audit-log tailer + BullMQ job; no third-party orchestrator. |
| D11 | **No PHI tables touched in this stream**; only the secrets layer | Reduces blast radius; allows parallel work with PHI-related streams. | `GlobalSetting` is **the only schema touched**, and only for two additive columns (`encryptedValue Bytes?`, `keyVersion Int?`); coordinated with Stream D (Optimistic Locking) — see Cross-stream Dependencies. |
| D12 | **No DELETE/DROP/TRUNCATE without explicit user approval** | User rule (workspace policy). | Phase 4D "remove plaintext seed rows" is **gated** by a user-approval task; the plan documents the SQL but does not execute it. |

---

## Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | **Vault unsealed unintentionally in prod** by an unauthorised operator | Medium | Critical (full key material exposure) | (a) HSM/auto-unseal **deferred** — manual key-shares (Shamir 5-of-3) only; (b) Recovery key material printed to physically locked envelopes; (c) Audit-log alert on any `seal/unseal` event | `security-auditor` |
| R2 | **AppRole `secret_id` leaked from pod start logs** | Medium | High | Response-wrap with TTL ≤ 60 s; pod unwraps and forgets immediately; never log `secret_id` (add CI lint regex `secret_id.*=.*[a-f0-9]{36}`) | `security-auditor` |
| R3 | **Vault unreachable at boot** locks out the entire fleet | Low | Critical | Fail-closed at boot is the policy. Mitigation: 3-node HA + Raft on independent VMs; pod readiness probe drops it from LB instead of crash-looping (gives ops a window) | `cicd-manager` |
| R4 | **Cold-start latency** exceeds k8s/systemd readiness window (default 60s) | Medium | Medium | Bulk-fetch ~10 secrets at boot in one `getSecrets()` call (~150ms); warmup hook in `SecretsService.boot()` runs before `app.listen()`. Health probe declares ready only after warmup. | `tester` |
| R5 | **Transit key rotation breaks decryption** of existing rows | Low | High | Transit's `min_decryption_version` is set to `1` (decrypt all historical versions); `min_encryption_version` advanced on rotation; old versions disabled, not destroyed | `security-auditor` |
| R6 | **Vault DB engine produces credentials** that exceed PostgreSQL `max_connections` | Medium | Medium | TTL = 1 h, `max_ttl` = 24 h, `max_open_connections` per role = 50 (3-node HA × 50 = 150 < default 200). Phase 5 staging soak measures actual N. | `database-admin` |
| R7 | **Schema collision with Stream D** (Optimistic Locking) on `GlobalSetting` | High (if not coordinated) | Medium | Phase 4 ships the additive columns FIRST in a dedicated migration; Stream D rebases. See Cross-stream Dependencies. | `git-manager` |
| R8 | **`AppSettingsService` cross-tenant cache collision** (TASK-301 P0-1) re-introduced for secrets | Low | Critical | All secret reads route through `SecretsService` (this stream), NOT `AppSettingsService`. Phase 3 verifies via static grep `appSettingsService.getValueWithDefault.*SECRET` returns zero hits. | `code-reviewer` |
| R9 | **Vault audit log fills disk** | High over time | Medium | `logrotate` config in Phase 1B blueprint (daily rotate, 90-day retention); `df -h /var/log/vault` alert in Prometheus | `pipeline-architect` |
| R10 | **Backup restore fails** due to Raft snapshot incompatibility with new version | Low | High | Phase 1B blueprint pins Vault version; major-version upgrades require snapshot test in staging first. Appendix B DR runbook documents the procedure. | `cicd-manager` |
| R11 | **Devs accidentally commit `.env.dev` with real Vault token** | High (without guard) | High | Phase 0 ships `gitleaks`. Stream B adds rule for `VAULT_TOKEN=hvs\.[A-Za-z0-9]+` to the allowlist file. | `cicd-manager` |
| R12 | **Phase 5 DB engine + PgBouncer transaction-mode incompatibility** | Medium | Medium | Phase 5 starts only AFTER Stream C reaches **session-mode** PgBouncer OR runs against direct pg (staging only); cross-checked with Stream C ownership before kickoff | `database-admin` |
| R13 | **Race condition between Redis Pub/Sub invalidation and in-flight requests** during rotation | Low | Low | Stale-while-revalidate semantics in cache; rotation rolls over a 5-min overlap window (old + new key both valid) | `tester` |
| R14 | **Vault Enterprise feature dependency creeps in** (sentinel, namespaces, replication) | Medium | High (licensing cost) | CI policy: any `.hcl` change diffed against `vault.hashicorp.com/community-edition` allowlist; ER review required for new engines | `security-auditor` |
| R15 | **Plaintext seed rows for `S3_ACCESS_KEY`/`S3_SECRET_KEY` removed before all consumers migrate** | Medium | High (breaks S3 in prod) | Phase 4D is gated behind two human approvals (security + user) and shipped only AFTER Phase 7 cutover sign-off | `git-manager` |

---

## Team Allocation

Each task carries an **`Agent:`** field that maps to one of the subagent types in `executing-plans`. Code-review gates use `code-reviewer`. Cross-cutting roles:

| Subagent | Primary responsibilities in this plan |
|---|---|
| `pipeline-architect` | Docker Compose changes, Vault dev-mode profile, VM blueprint, HAProxy TLS terminator config |
| `database-admin` | Prisma schema additive migration (Phase 4A), Vault DB secrets engine config + role creation, PgBouncer + Vault DB integration smoke |
| `security-auditor` | AppRole policy review, Transit engine policy, threat model deltas, gitleaks rules, audit-log alert definitions, sealed-key handling runbook review |
| `tester` | Vitest unit tests (provider, cache, invalidation), integration tests against `vault-dev` container via `testcontainers`, chaos tests (Vault unreachable) |
| `code-reviewer` | Every Code Review Gate (~every 4-5 tasks). Refuses to advance the plan if tests do not match implementation, if `process.env.*` secret reads remain, if any policy widens without justification |
| `debugger` | Triage of Vault auth failures, Transit `permission denied` errors, AppRole `secret_id` exhaustion |
| `docs-manager` | Update `apps/api/README.md`, `infrastructure/docker/README.md`, write the Vault runbook section in `research/deployments/deploy-vm430-432-vault.md` SRE stub |
| `cicd-manager` | GitLab CI changes (gitleaks job, Vault dev container provisioning for integration tests), nightly Vault snapshot job |
| `git-manager` | Branch naming, PR scoping per phase, coordination with Stream D on `GlobalSetting` migrations, **never pushes to remote without explicit user approval** |

Single-engineer assumption per task; only Phase 1B (SRE blueprint) is intentionally light because the actual VM provisioning is handed off to the SRE team and is outside this plan's execution scope.

---

## Effort Estimate

Numbers are eng-days per phase. "Solo" is one experienced backend engineer; "2-eng parallel" is two engineers working on independent tasks (most phases can split cleanly). Estimates exclude the SRE bandwidth for Phase 1B VM provisioning.

| Phase | Section | Tasks | Solo eng-days | 2-eng parallel | Critical Path |
|---|---|---|---|---|---|
| 1 | 1A — Local dev Vault container | 6 | 1.5 | 1.5 | yes (blocks Phase 2 integ tests) |
| 1 | 1B — HA cluster blueprint (planner stub) | 8 | 1.0 | 1.0 | no (SRE owns VM build) |
| 2 | 2A — Interface + env provider + in-memory | 6 | 2.0 | 1.5 | yes |
| 2 | 2B — VaultSecretsProvider | 9 | 3.0 | 2.0 | yes |
| 2 | 2C — Cache + invalidation + health | 5 | 2.0 | 1.5 | yes |
| 3 | Migrate all secret read sites | 12 | 3.0 | 2.0 | yes (depends on 2) |
| 4 | 4A — Schema migration | 3 | 1.0 | 1.0 | yes (sequenced before Stream D Phase B) |
| 4 | 4B — Vault Transit setup | 4 | 1.5 | 1.0 | no |
| 4 | 4C — Encrypt-on-write / decrypt-on-read | 5 | 2.5 | 1.5 | no |
| 4 | 4D — Remove plaintext seed rows (user-gated) | 2 | 0.5 | 0.5 | no |
| 5 | Vault DB Secrets Engine | 10 | 4.0 | 3.0 | sequenced AFTER Stream C session-mode |
| 6 | Rotation automation | 8 | 2.5 | 2.0 | no |
| 7 | Production cutover + decommission | 6 | 2.0 | 1.5 | yes (final gate) |
| — | **Total** | **84 tasks** | **~26.5 eng-days** | **~20 eng-days** | — |
| + | SRE VM build (Phase 1B real work, outside plan) | — | +3 days SRE | +2 days SRE | — |
| + | Buffer for unknowns / on-call interruptions | — | +3 days | +3 days | — |
| + | Documentation + runbook polish | — | +2 days | +2 days | — |
| — | **Grand total** | — | **~34.5 eng-days** | **~27 eng-days** | — |

Aligned with the research doc's §10 baseline (~20 eng-days for v1; +10 for Vault HA + Phase 5 DB credentials = ~30) and the user's brief (~30 eng-days, ~6 weeks solo, ~4 weeks two-eng).

---

## Cross-stream Dependencies

This stream is part of the broader TASK-302 implementation roadmap. Coordinate at branch/PR level with the streams below.

| Stream | Document | Relationship | Coordination Point |
|---|---|---|---|
| **Stream A — Phase 0 Hotfix** | [`01-phase-0-hotfix.md`](./01-phase-0-hotfix.md) | **Hard predecessor.** This stream MUST NOT start until Phase 0 is shipped to prod AND verified. Items 4 (`@Secret` decorator) and 6 (credential rotation + `gitleaks`) are the specific foundations Phase 3/4 build on. | `git-manager` checks at kickoff that the Phase 0 PR is **merged + deployed + verified** (CI red-team tests green) before opening Stream B branch. |
| **Stream C — PgBouncer + Prisma 7** | `research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md` (separate roadmap doc, TBA) | **Loosely coupled.** Phase 1–4 + 6–7 of Stream B can run in parallel with Stream C. **Phase 5 (Vault DB credentials)** depends on Stream C reaching **PgBouncer session-mode** to issue per-pod dynamic credentials safely. | If Stream C lags, Phase 5 of this stream runs against **direct pg in staging only**, with prod cutover gated on Stream C completion. |
| **Stream D — Optimistic Locking on `GlobalSetting`** | `research/architecture/system-config-multi-tenancy/04-optimistic-locking.md` (separate roadmap doc, TBA) | **Schema conflict potential.** Both streams touch `GlobalSetting`. **Sequence required**: Phase 4A of this stream (additive columns) ships **first** as a dedicated migration; Stream D's Phase B (`updateWithVersion` repository method) rebases on the new schema. | `database-admin` coordinates at the Prisma schema PR. Phase 4A ships in `feat/task-302-vault-globalsetting-encrypted-cols` branch; Stream D opens its branch only after this migration is merged. |
| **Stream E — Layered Config Resolution** | `research/architecture/system-config-multi-tenancy/01-layered-resolution-migration.md` | **Independent.** No schema conflict; Stream E's `SettingDefinition` catalog is orthogonal to secrets. | No coordination required beyond awareness. |
| **External: TASK-281 MedNER E2E** | `docs/implementation/TASK-281-MedNER-E2E-Infra/README.md` | **Independent.** TASK-281 owns Python NLP service infra; no overlap. | None. |
| **External: TASK-258 Tenant Config Provisioning** | (closed) | **Reference only.** Established the `__GLOBAL__` clone pattern that Phase 3 inherits but does not change. | None. |

> **Branch/PR convention for this stream**: `feat/task-302-vault/<phase-id>-<short-name>` (e.g., `feat/task-302-vault/p1a-dev-container`, `feat/task-302-vault/p3-jwt-strategy-migration`). One PR per phase section (1A, 1B, 2A, …) or per group of 4-5 tasks where the phase is large. Code-review gates correspond to PR boundaries.

---

# Phase 1 — Vault Infrastructure

**Phase Goal**: A working Vault instance reachable from a HOPE pod in each environment. Local dev gets a one-command opt-in container with `kv-v2`, `transit`, `database`, and AppRole pre-configured. Staging/prod get a documented HA-cluster blueprint (real VM provisioning is SRE's job).

**Entry Criteria**:
- Phase 0 verified (Items 4 and 6 from `01-phase-0-hotfix.md` shipped).
- Working branch `feat/task-302-vault/p1a-dev-container` created off `dev`.

**Exit Criteria**:
- `docker compose --profile vault up -d` produces a healthy Vault container with all four engines mounted and the `hope-app` AppRole registered.
- `research/deployments/deploy-vm430-432-vault.md` is committed with the SRE hand-off block filled.
- Code-review gates 1A and 1B both signed.

---

## Section 1A — Local dev Vault container

The existing `docker-compose.dev.yml` already declares a `vault` service in dev-mode (file: `infrastructure/docker/docker-compose.dev.yml:38-59`, image `hashicorp/vault:1.15`). This section **upgrades** it to a usable migration target by adding an init container that mounts engines + creates AppRole policies, pins to Vault 1.18, adds a Compose profile for opt-in, and writes a smoke-test script.

---

### Task 1.1: Pin Vault container to 1.18 and move under a Compose profile

**Agent**: `pipeline-architect`

**Files**:
- Modify: `infrastructure/docker/docker-compose.dev.yml`

**Steps**:

1. Write failing smoke test (one-liner shell):

   ```bash
   cat > /tmp/vault-smoke-1.1.sh <<'EOF'
   #!/usr/bin/env bash
   set -euo pipefail
   docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault config \
     | grep -q 'image: hashicorp/vault:1.18'
   docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault config \
     | grep -q 'profiles:'
   EOF
   chmod +x /tmp/vault-smoke-1.1.sh
   ```

2. Verify test fails:

   ```bash
   /tmp/vault-smoke-1.1.sh
   # Expected: exit 1, prints "image: hashicorp/vault:1.15" instead of 1.18, and no profile line
   ```

3. Implement: edit `infrastructure/docker/docker-compose.dev.yml`:

   ```yaml
   services:
     vault:
       container_name: hope-vault
       image: hashicorp/vault:1.18
       profiles: ["vault"]
       networks:
         - hope-network
       restart: unless-stopped
       ports:
         - '8200:8200'
       volumes:
         - vault-data:/vault/file
         - ./configs/vault/dev-init.sh:/vault/init/dev-init.sh:ro
       environment:
         VAULT_ADDR: 'http://0.0.0.0:8200'
         VAULT_DEV_ROOT_TOKEN_ID: ${VAULT_DEV_ROOT_TOKEN:-root}
         VAULT_DEV_LISTEN_ADDRESS: '0.0.0.0:8200'
       command: server -dev -dev-root-token-id="${VAULT_DEV_ROOT_TOKEN:-root}"
       cap_add:
         - IPC_LOCK
       healthcheck:
         test: ['CMD-SHELL', 'wget -q -O- http://127.0.0.1:8200/v1/sys/health | grep -q "\"initialized\":true"']
         interval: 10s
         timeout: 5s
         retries: 5
         start_period: 15s
   ```

4. Verify test passes:

   ```bash
   /tmp/vault-smoke-1.1.sh
   # Expected: exit 0
   docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault up -d vault
   docker inspect hope-vault --format='{{.Config.Image}}'
   # Expected: hashicorp/vault:1.18
   ```

5. Commit:

   ```bash
   git add infrastructure/docker/docker-compose.dev.yml
   git commit -m "infra(vault): pin to 1.18 and gate dev container behind compose profile"
   ```

---

### Task 1.2: Create `dev-init.sh` to mount engines + audit log

**Agent**: `pipeline-architect`

**Files**:
- Create: `infrastructure/docker/configs/vault/dev-init.sh`
- Create: `infrastructure/docker/configs/vault/.gitkeep` (if dir missing)

**Steps**:

1. Write failing smoke test:

   ```bash
   cat > /tmp/vault-smoke-1.2.sh <<'EOF'
   #!/usr/bin/env bash
   set -euo pipefail
   test -x infrastructure/docker/configs/vault/dev-init.sh
   grep -q 'vault secrets enable -path=transit transit' infrastructure/docker/configs/vault/dev-init.sh
   grep -q 'vault secrets enable -path=kv -version=2 kv-v2' infrastructure/docker/configs/vault/dev-init.sh
   grep -q 'vault secrets enable -path=database database' infrastructure/docker/configs/vault/dev-init.sh
   grep -q 'vault audit enable file' infrastructure/docker/configs/vault/dev-init.sh
   EOF
   chmod +x /tmp/vault-smoke-1.2.sh
   ```

2. Verify test fails:

   ```bash
   /tmp/vault-smoke-1.2.sh
   # Expected: exit 1, file not found
   ```

3. Implement (create the directory + script):

   ```bash
   mkdir -p infrastructure/docker/configs/vault
   ```

   ```bash
   # infrastructure/docker/configs/vault/dev-init.sh
   #!/usr/bin/env sh
   set -eu
   export VAULT_ADDR="http://127.0.0.1:8200"
   export VAULT_TOKEN="${VAULT_DEV_ROOT_TOKEN:-root}"

   echo "[vault-init] waiting for Vault to be ready"
   until vault status >/dev/null 2>&1; do sleep 1; done

   echo "[vault-init] enabling kv-v2 at path 'secret'"
   vault secrets enable -path=secret -version=2 kv-v2 2>/dev/null || true

   echo "[vault-init] enabling transit at path 'transit'"
   vault secrets enable -path=transit transit 2>/dev/null || true

   echo "[vault-init] enabling database at path 'database'"
   vault secrets enable -path=database database 2>/dev/null || true

   echo "[vault-init] enabling file audit device"
   mkdir -p /vault/audit
   vault audit enable file file_path=/vault/audit/vault-audit.log 2>/dev/null || true

   echo "[vault-init] OK"
   ```

   ```bash
   chmod +x infrastructure/docker/configs/vault/dev-init.sh
   ```

4. Verify test passes:

   ```bash
   /tmp/vault-smoke-1.2.sh
   # Expected: exit 0
   ```

5. Commit:

   ```bash
   git add infrastructure/docker/configs/vault/dev-init.sh
   git commit -m "infra(vault): add dev-init.sh to bootstrap kv-v2, transit, database, audit"
   ```

---

### Task 1.3: Add `vault-init` sidecar container to docker-compose.dev.yml

**Agent**: `pipeline-architect`

**Files**:
- Modify: `infrastructure/docker/docker-compose.dev.yml`

**Steps**:

1. Write failing smoke test:

   ```bash
   cat > /tmp/vault-smoke-1.3.sh <<'EOF'
   #!/usr/bin/env bash
   set -euo pipefail
   docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault config | grep -q 'hope-vault-init'
   docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault config | grep -q 'depends_on:'
   EOF
   chmod +x /tmp/vault-smoke-1.3.sh
   ```

2. Verify test fails:

   ```bash
   /tmp/vault-smoke-1.3.sh
   # Expected: exit 1
   ```

3. Implement: append the `vault-init` service inside `services:` block:

   ```yaml
     vault-init:
       container_name: hope-vault-init
       image: hashicorp/vault:1.18
       profiles: ["vault"]
       networks:
         - hope-network
       depends_on:
         vault:
           condition: service_healthy
       restart: 'no'
       environment:
         VAULT_ADDR: 'http://vault:8200'
         VAULT_DEV_ROOT_TOKEN: ${VAULT_DEV_ROOT_TOKEN:-root}
       volumes:
         - ./configs/vault/dev-init.sh:/vault/init/dev-init.sh:ro
         - vault-data:/vault/file
       entrypoint: ["/vault/init/dev-init.sh"]
   ```

4. Verify test passes:

   ```bash
   /tmp/vault-smoke-1.3.sh
   # Expected: exit 0
   docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault up -d
   docker logs hope-vault-init
   # Expected: lines including "enabling transit", "OK"
   docker exec hope-vault vault secrets list -format=json | jq 'keys[]'
   # Expected output includes "transit/", "secret/", "database/"
   ```

5. Commit:

   ```bash
   git add infrastructure/docker/docker-compose.dev.yml
   git commit -m "infra(vault): add vault-init sidecar to mount engines on profile up"
   ```

---

### Task 1.4: Add AppRole auth method + `hope-app` role with sample policy

**Agent**: `security-auditor`

**Files**:
- Modify: `infrastructure/docker/configs/vault/dev-init.sh`
- Create: `infrastructure/docker/configs/vault/policies/hope-app.hcl`

**Steps**:

1. Write failing test (script):

   ```bash
   cat > /tmp/vault-smoke-1.4.sh <<'EOF'
   #!/usr/bin/env bash
   set -euo pipefail
   test -f infrastructure/docker/configs/vault/policies/hope-app.hcl
   grep -q 'path "secret/data/hope/\*"' infrastructure/docker/configs/vault/policies/hope-app.hcl
   grep -q 'vault auth enable approle' infrastructure/docker/configs/vault/dev-init.sh
   grep -q 'vault write auth/approle/role/hope-app' infrastructure/docker/configs/vault/dev-init.sh
   EOF
   chmod +x /tmp/vault-smoke-1.4.sh
   ```

2. Verify test fails:

   ```bash
   /tmp/vault-smoke-1.4.sh
   # Expected: exit 1, policies file missing
   ```

3. Implement — create the policy file:

   ```hcl
   # infrastructure/docker/configs/vault/policies/hope-app.hcl
   path "secret/data/hope/*" {
     capabilities = ["read", "list"]
   }

   path "secret/metadata/hope/*" {
     capabilities = ["read", "list"]
   }

   path "transit/encrypt/hope-globalsetting" {
     capabilities = ["update"]
   }

   path "transit/decrypt/hope-globalsetting" {
     capabilities = ["update"]
   }

   path "database/creds/hope-app-role" {
     capabilities = ["read"]
   }

   path "sys/health" {
     capabilities = ["read"]
   }
   ```

   Add to `dev-init.sh` (append before the final `echo OK`):

   ```bash
   echo "[vault-init] enabling AppRole auth"
   vault auth enable approle 2>/dev/null || true

   echo "[vault-init] writing hope-app policy"
   vault policy write hope-app /vault/init/policies/hope-app.hcl

   echo "[vault-init] creating hope-app role"
   vault write auth/approle/role/hope-app \
     token_policies="hope-app" \
     token_ttl=1h \
     token_max_ttl=24h \
     secret_id_ttl=24h \
     secret_id_num_uses=1

   echo "[vault-init] role_id (committable):"
   vault read -field=role_id auth/approle/role/hope-app/role-id
   ```

   Update the `vault-init` service in `docker-compose.dev.yml` to mount the policies dir:

   ```yaml
     vault-init:
       # …existing fields…
       volumes:
         - ./configs/vault/dev-init.sh:/vault/init/dev-init.sh:ro
         - ./configs/vault/policies:/vault/init/policies:ro
         - vault-data:/vault/file
   ```

4. Verify test passes:

   ```bash
   /tmp/vault-smoke-1.4.sh
   docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault up -d --force-recreate vault-init
   docker logs hope-vault-init | grep 'role_id'
   # Expected: a UUID printed after "role_id (committable):"
   docker exec hope-vault vault auth list -format=json | jq -r 'keys[]'
   # Expected output includes "approle/"
   ```

5. Commit:

   ```bash
   git add infrastructure/docker/configs/vault/policies/hope-app.hcl \
           infrastructure/docker/configs/vault/dev-init.sh \
           infrastructure/docker/docker-compose.dev.yml
   git commit -m "infra(vault): add AppRole auth + hope-app policy for dev container"
   ```

---

### Task 1.5: Seed dev `secret/` paths with placeholder secrets

**Agent**: `pipeline-architect`

**Files**:
- Modify: `infrastructure/docker/configs/vault/dev-init.sh`

Adds **placeholder** values for every secret the app boot will request, so dev devs running `SECRETS_PROVIDER=vault` get a populated KV store. Real values stay in `.env.dev` for the default `SECRETS_PROVIDER=env` path.

**Steps**:

1. Write failing test:

   ```bash
   cat > /tmp/vault-smoke-1.5.sh <<'EOF'
   #!/usr/bin/env bash
   set -euo pipefail
   docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault up -d --force-recreate vault-init
   sleep 2
   for k in JWT_SECRET_KEY SESSION_SECRET_KEY API_KEY_PEPPER OIDC_CLIENT_SECRET \
            MINIO_ACCESS_KEY MINIO_SECRET_KEY SMR_SERVICE_TOKEN MQTT_PASS REDIS_PASS; do
     docker exec hope-vault vault kv get -format=json secret/hope/$k >/dev/null
   done
   EOF
   chmod +x /tmp/vault-smoke-1.5.sh
   ```

2. Verify test fails:

   ```bash
   /tmp/vault-smoke-1.5.sh
   # Expected: exit 1 (kv get fails on missing paths)
   ```

3. Implement: append to `dev-init.sh`:

   ```bash
   echo "[vault-init] seeding dev placeholder secrets"
   for kv in \
     "JWT_SECRET_KEY=dev-jwt-secret-not-for-prod" \
     "SESSION_SECRET_KEY=dev-session-secret-not-for-prod" \
     "API_KEY_PEPPER=dev-api-key-pepper-not-for-prod" \
     "OIDC_CLIENT_SECRET=dev-oidc-client-secret-not-for-prod" \
     "MINIO_ACCESS_KEY=minio_admin" \
     "MINIO_SECRET_KEY=minio_admin" \
     "SMR_SERVICE_TOKEN=dev-smr-service-token-not-for-prod" \
     "MQTT_PASS=" \
     "REDIS_PASS="; do
     k=${kv%%=*}
     v=${kv#*=}
     vault kv put "secret/hope/${k}" value="${v}"
   done
   ```

4. Verify test passes:

   ```bash
   /tmp/vault-smoke-1.5.sh
   # Expected: exit 0
   docker exec hope-vault vault kv get -format=json secret/hope/JWT_SECRET_KEY | jq '.data.data.value'
   # Expected: "dev-jwt-secret-not-for-prod"
   ```

5. Commit:

   ```bash
   git add infrastructure/docker/configs/vault/dev-init.sh
   git commit -m "infra(vault): seed dev placeholder secrets in kv-v2 'secret/hope/*'"
   ```

---

### Task 1.6: Document Vault dev opt-in in `infrastructure/docker/README.md`

**Agent**: `docs-manager`

**Files**:
- Modify: `infrastructure/docker/README.md`

**Steps**:

1. Write failing check:

   ```bash
   grep -q 'compose --profile vault' infrastructure/docker/README.md
   # Expected: exit 1
   ```

2. Verify it fails:

   ```bash
   grep -q 'compose --profile vault' infrastructure/docker/README.md
   echo "rc=$?"
   # Expected: rc=1
   ```

3. Implement: add a new section to `infrastructure/docker/README.md` (insert after the existing "Vault" mention; if none, append before the last `---`):

   ```markdown
   ## HashiCorp Vault (opt-in for local dev)

   Local development uses `EnvSecretsProvider` by default (`.env.dev` values). To exercise the Vault code path locally, opt in:

   ```bash
   # 1. Start Vault + init container
   docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault up -d

   # 2. Note the printed AppRole role_id (committable)
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

   Vault is **not** required for normal `pnpm dev`. Real values are seeded under `secret/hope/*` by the `vault-init` container.
   ```

4. Verify test passes:

   ```bash
   grep -q 'compose --profile vault' infrastructure/docker/README.md
   echo "rc=$?"
   # Expected: rc=0
   ```

5. Commit:

   ```bash
   git add infrastructure/docker/README.md
   git commit -m "docs(infra): document Vault opt-in profile for local development"
   ```

---

### Code Review Gate 1A — `code-reviewer`

**Inputs**: Tasks 1.1–1.6 commits on `feat/task-302-vault/p1a-dev-container`.

**Checks**:

- [ ] `docker compose --profile vault up -d` produces three healthy containers (`hope-vault`, `hope-vault-init` exits with code 0, `hope-vault` healthy)
- [ ] `vault secrets list` returns `kv/`, `secret/`, `transit/`, `database/`
- [ ] `vault auth list` includes `approle/`
- [ ] `vault policy read hope-app` returns the expected policy
- [ ] `docker logs hope-vault-init` prints the role_id
- [ ] `.env.dev` and `.env` were not modified
- [ ] README updated
- [ ] No `VAULT_TOKEN` value committed to any tracked file (`git grep -i 'VAULT_TOKEN=hvs\\.'` returns empty)

**Action if pass**: open PR `feat/task-302-vault/p1a-dev-container` → `dev`; merge after one approval.
**Action if fail**: list specific failures, return tasks to author.

---

## Section 1B — Self-hosted HA Vault cluster blueprint (planner stub)

This section produces the **SRE hand-off document** for a 3-node Vault HA cluster on Proxmox. The actual VM provisioning is **out of scope** for engineering; engineering writes a precise, executable blueprint that the SRE team consumes. The blueprint mirrors the existing conventions in `research/deployments/` (Ubuntu 24.04, hope user, Cloudflare SSH tunnel, systemd, named bridge `vmbr1`, IP plan).

The HA cluster blueprint lives at `research/deployments/deploy-vm430-432-vault.md`. Engineering writes the structure + commands; SRE fills VM IDs, IPs (subject to availability), and DNS.

---

### Task 1.7: Create blueprint skeleton with TOC and prereqs

**Agent**: `docs-manager`

**Files**:
- Create: `research/deployments/deploy-vm430-432-vault.md`

**Steps**:

1. Write failing test:

   ```bash
   test ! -f research/deployments/deploy-vm430-432-vault.md && echo "missing"
   # Expected: "missing"
   ```

2. Verify it doesn't exist:

   ```bash
   ls research/deployments/deploy-vm430-432-vault.md 2>&1 | head -1
   # Expected: "No such file or directory"
   ```

3. Implement — create the file:

   ```markdown
   # Deploy HashiCorp Vault — VM 430 / 431 / 432 (3-node HA Cluster)

   **Date**: 2026-05-24
   **VMs**: 430 (`10.10.1.130`), 431 (`10.10.1.131`), 432 (`10.10.1.132`)
   **Bridge**: vmbr1 | **Specs**: 2 vCPU / 4 GB RAM / 32 GB disk per node
   **Config files**: [`configs/vault/`](../configs/vault/)
   **Cloudflare SSH**: `ssh-vault-1.taphuynh.dev`, `ssh-vault-2.taphuynh.dev`, `ssh-vault-3.taphuynh.dev`
   **API endpoint**: `https://vault.taphuynh.dev` (HAProxy-fronted, TLS-terminated)
   **Related**: [Redis HA](./deploy-vm420-421-redis.md), [PostgreSQL HA](./deploy-vm500-502-postgres-ha.md), [Cloudflare Tunnel](./deploy-ct101-cloudflare-tunnel.md), [TASK-302 Vault Migration Plan](../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/02-vault-migration.md)

   > **Vault is the secrets root of trust** for HOPE production. A successful exploit on these VMs grants attacker decryption of every transit-encrypted column and access to every dynamic DB credential. Harden accordingly.

   ---

   ## Table of Contents

   1. Architecture Overview
   2. Prerequisites (SRE checklist)
   3. Create VMs (Proxmox host)
   4. Prepare each VM
   5. Install Vault (1.18) + systemd unit
   6. Configure Raft integrated storage on node 1
   7. Initialize + unseal (Shamir 5-of-3)
   8. Join nodes 2 and 3 to the Raft cluster
   9. HAProxy TLS terminator (separate VM or co-located on cluster)
   10. Mount engines (kv-v2, transit, database, pki-optional)
   11. AppRole + policies (mirror dev-init.sh)
   12. Audit log persistence + rotation
   13. Raft snapshot backup + offline restore drill
   14. Cloudflare SSH tunnel
   15. Application configuration (`SECRETS_PROVIDER=vault` for staging/prod)
   16. Monitoring + alerting
   17. Operational Runbook
   18. Disaster Recovery (see Appendix B of plan doc)

   ---

   ## 1. Architecture Overview

   <SRE: fill ASCII diagram showing 3 nodes + HAProxy + Cloudflare front>

   ## 2. Prerequisites

   - [ ] Proxmox host has 3 free VM IDs (430-432)
   - [ ] DNS records pre-created: `vault.taphuynh.dev` (HAProxy VIP), `ssh-vault-{1,2,3}.taphuynh.dev` (per-node SSH)
   - [ ] Cloudflare Tunnel updated to route `https://vault.taphuynh.dev` to HAProxy
   - [ ] 5 separate operators identified to hold Shamir key shares (any 3 required to unseal); shares stored in physical envelopes, not encrypted files

   <REMAINING SECTIONS TO BE FILLED PER TASKS 1.8–1.14>
   ```

4. Verify test passes:

   ```bash
   test -f research/deployments/deploy-vm430-432-vault.md && echo "ok"
   # Expected: "ok"
   ```

5. Commit:

   ```bash
   git add research/deployments/deploy-vm430-432-vault.md
   git commit -m "docs(deployments): scaffold Vault HA cluster blueprint (vm 430-432)"
   ```

---

### Task 1.8: Fill Section 5 — Install Vault 1.18 + systemd unit

**Agent**: `docs-manager`

**Files**:
- Modify: `research/deployments/deploy-vm430-432-vault.md`

**Steps**:

1. Write failing test:

   ```bash
   grep -q '/etc/systemd/system/vault.service' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify it fails:

   ```bash
   grep -q '/etc/systemd/system/vault.service' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=1
   ```

3. Implement — replace the `<REMAINING SECTIONS TO BE FILLED…>` placeholder with section 5 content:

   ```markdown
   ## 5. Install Vault (1.18) + systemd unit

   On EACH node (run as `hope` user with sudo):

   ```bash
   wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
   echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
     | sudo tee /etc/apt/sources.list.d/hashicorp.list
   sudo apt update
   sudo apt install -y vault=1.18.*
   vault --version  # expect Vault v1.18.x

   sudo mkdir -p /opt/vault/data /etc/vault.d /var/log/vault
   sudo chown -R vault:vault /opt/vault /etc/vault.d /var/log/vault

   sudo tee /etc/systemd/system/vault.service > /dev/null <<'EOF'
   [Unit]
   Description=HashiCorp Vault
   Documentation=https://developer.hashicorp.com/vault/docs
   Requires=network-online.target
   After=network-online.target
   ConditionFileNotEmpty=/etc/vault.d/vault.hcl

   [Service]
   User=vault
   Group=vault
   ProtectSystem=full
   ProtectHome=read-only
   PrivateTmp=yes
   PrivateDevices=yes
   SecureBits=keep-caps
   AmbientCapabilities=CAP_IPC_LOCK
   CapabilityBoundingSet=CAP_SYSLOG CAP_IPC_LOCK
   NoNewPrivileges=yes
   ExecStart=/usr/bin/vault server -config=/etc/vault.d/vault.hcl
   ExecReload=/bin/kill -SIGHUP $MAINPID
   KillMode=process
   Restart=on-failure
   RestartSec=5
   TimeoutStopSec=30
   LimitNOFILE=65536
   LimitMEMLOCK=infinity

   [Install]
   WantedBy=multi-user.target
   EOF

   sudo systemctl daemon-reload
   ```
   ```

4. Verify test passes:

   ```bash
   grep -q '/etc/systemd/system/vault.service' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=0
   ```

5. Commit:

   ```bash
   git add research/deployments/deploy-vm430-432-vault.md
   git commit -m "docs(deployments): add Vault 1.18 install + systemd unit (section 5)"
   ```

---

### Task 1.9: Fill Section 6 — Raft storage HCL config

**Agent**: `pipeline-architect`

**Files**:
- Modify: `research/deployments/deploy-vm430-432-vault.md`

**Steps**:

1. Write failing test:

   ```bash
   grep -q 'storage "raft"' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails:

   ```bash
   grep -q 'storage "raft"' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=1
   ```

3. Implement — append section 6:

   ```markdown
   ## 6. Raft integrated storage — `/etc/vault.d/vault.hcl` (per node, edit `node_id` and `api_addr` per host)

   ```hcl
   ui = true
   cluster_addr  = "https://10.10.1.130:8201"   # change per node: .130 / .131 / .132
   api_addr      = "https://10.10.1.130:8200"   # change per node
   log_level     = "info"
   log_format    = "json"
   default_lease_ttl = "168h"
   max_lease_ttl     = "8760h"
   disable_mlock = false

   listener "tcp" {
     address       = "0.0.0.0:8200"
     tls_cert_file = "/etc/vault.d/tls/vault.crt"
     tls_key_file  = "/etc/vault.d/tls/vault.key"
     tls_min_version = "tls12"
     telemetry {
       unauthenticated_metrics_access = false
     }
   }

   storage "raft" {
     path    = "/opt/vault/data"
     node_id = "vault-1"   # change per node: vault-1 / vault-2 / vault-3
     retry_join {
       leader_api_addr = "https://10.10.1.130:8200"
       leader_ca_cert_file = "/etc/vault.d/tls/vault-ca.crt"
     }
     retry_join {
       leader_api_addr = "https://10.10.1.131:8200"
       leader_ca_cert_file = "/etc/vault.d/tls/vault-ca.crt"
     }
     retry_join {
       leader_api_addr = "https://10.10.1.132:8200"
       leader_ca_cert_file = "/etc/vault.d/tls/vault-ca.crt"
     }
   }

   telemetry {
     prometheus_retention_time = "30s"
     disable_hostname = true
   }
   ```

   <SRE: generate TLS material via your existing internal CA; private key file mode 0600 vault:vault>
   ```

4. Verify test passes:

   ```bash
   grep -q 'storage "raft"' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=0
   ```

5. Commit:

   ```bash
   git add research/deployments/deploy-vm430-432-vault.md
   git commit -m "docs(deployments): add Vault Raft HCL config (section 6)"
   ```

---

### Task 1.10: Fill Section 7 — Initialize + Shamir unseal procedure

**Agent**: `security-auditor`

**Files**:
- Modify: `research/deployments/deploy-vm430-432-vault.md`

**Steps**:

1. Write failing test:

   ```bash
   grep -q 'vault operator init -key-shares=5 -key-threshold=3' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails:

   ```bash
   grep -q 'vault operator init -key-shares=5 -key-threshold=3' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=1
   ```

3. Implement — append section 7:

   ```markdown
   ## 7. Initialize + Shamir unseal (5-of-3)

   Run **once on node 1 only**:

   ```bash
   export VAULT_ADDR=https://10.10.1.130:8200
   export VAULT_CACERT=/etc/vault.d/tls/vault-ca.crt
   vault operator init -key-shares=5 -key-threshold=3 -format=json > /tmp/init.json
   ```

   `init.json` contains 5 unseal key shares + initial root token. **Distribute the 5 key shares to 5 separate operators** (printed envelopes, no email, no chat). Destroy `/tmp/init.json` after distribution. Record the initial root token in the secure SRE password vault for emergency use only; rotate it after creating per-operator userpass accounts in section 11.

   Unseal node 1:

   ```bash
   vault operator unseal <key-share-1>   # operator A enters
   vault operator unseal <key-share-2>   # operator B enters
   vault operator unseal <key-share-3>   # operator C enters
   vault status | grep -E 'Sealed|HA Mode'
   # Expected: Sealed=false, HA Mode=active
   ```

   Repeat the three `unseal` commands on nodes 2 and 3 after section 8 join completes.

   > **Recovery**: if 3 key holders are simultaneously unavailable, the cluster cannot be unsealed. Document this in the incident response plan.
   ```

4. Verify test passes:

   ```bash
   grep -q 'vault operator init -key-shares=5 -key-threshold=3' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=0
   ```

5. Commit:

   ```bash
   git add research/deployments/deploy-vm430-432-vault.md
   git commit -m "docs(deployments): add Shamir 5-of-3 init + unseal procedure (section 7)"
   ```

---

### Task 1.11: Fill Section 9 — HAProxy TLS terminator config

**Agent**: `pipeline-architect`

**Files**:
- Modify: `research/deployments/deploy-vm430-432-vault.md`

**Steps**:

1. Write failing test:

   ```bash
   grep -q 'frontend vault_https' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails:

   ```bash
   grep -q 'frontend vault_https' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=1
   ```

3. Implement — append section 9:

   ```markdown
   ## 9. HAProxy TLS terminator (on bastion VM 401 OR co-located on node 1)

   ```haproxy
   global
     log /dev/log local0
     log /dev/log local1 notice
     daemon
     maxconn 4096

   defaults
     log     global
     mode    http
     option  httplog
     option  dontlognull
     timeout connect 5s
     timeout client  60s
     timeout server  60s

   frontend vault_https
     bind *:443 ssl crt /etc/haproxy/certs/vault.taphuynh.dev.pem
     mode http
     http-request set-header X-Forwarded-Proto https
     default_backend vault_active

   backend vault_active
     mode http
     option httpchk GET /v1/sys/health?standbyok=true
     http-check expect status 200
     server vault-1 10.10.1.130:8200 check ssl verify required ca-file /etc/haproxy/certs/vault-ca.crt
     server vault-2 10.10.1.131:8200 check ssl verify required ca-file /etc/haproxy/certs/vault-ca.crt backup
     server vault-3 10.10.1.132:8200 check ssl verify required ca-file /etc/haproxy/certs/vault-ca.crt backup
   ```

   Note: Vault returns `200` for active, `429` for performance standby, `473` for DR standby, `501` for unsealed. The `standbyok=true` query parameter accepts both active and performance standby as healthy.

   <SRE: provision `vault.taphuynh.dev.pem` from internal CA (chain + key, mode 0600 haproxy:haproxy)>
   ```

4. Verify test passes:

   ```bash
   grep -q 'frontend vault_https' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=0
   ```

5. Commit:

   ```bash
   git add research/deployments/deploy-vm430-432-vault.md
   git commit -m "docs(deployments): add HAProxy TLS terminator config (section 9)"
   ```

---

### Task 1.12: Fill Section 12 — Audit log + logrotate config

**Agent**: `security-auditor`

**Files**:
- Modify: `research/deployments/deploy-vm430-432-vault.md`

**Steps**:

1. Write failing test:

   ```bash
   grep -q '/etc/logrotate.d/vault' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails:

   ```bash
   grep -q '/etc/logrotate.d/vault' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=1
   ```

3. Implement — append section 12:

   ```markdown
   ## 12. Audit log persistence + rotation

   Enable file audit device (run once on active node, replicates via Raft):

   ```bash
   vault audit enable file file_path=/var/log/vault/audit.log
   vault audit list
   # Expected: file/   file   n/a   File-based audit log device
   ```

   Logrotate (each node):

   ```bash
   sudo tee /etc/logrotate.d/vault > /dev/null <<'EOF'
   /var/log/vault/audit.log {
     daily
     rotate 90
     compress
     delaycompress
     missingok
     notifempty
     create 0600 vault vault
     postrotate
       /usr/bin/killall -HUP vault 2>/dev/null || true
     endscript
   }
   EOF

   sudo logrotate -d /etc/logrotate.d/vault
   # Expected: dry-run output without errors
   ```

   Disk-fill alert (Prometheus + node_exporter): `node_filesystem_avail_bytes{mountpoint="/var/log"} / node_filesystem_size_bytes{mountpoint="/var/log"} < 0.15` → warn; `< 0.05` → page.
   ```

4. Verify test passes:

   ```bash
   grep -q '/etc/logrotate.d/vault' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=0
   ```

5. Commit:

   ```bash
   git add research/deployments/deploy-vm430-432-vault.md
   git commit -m "docs(deployments): add audit log persistence + logrotate (section 12)"
   ```

---

### Task 1.13: Fill Section 13 — Raft snapshot backup + DR restore drill

**Agent**: `cicd-manager`

**Files**:
- Modify: `research/deployments/deploy-vm430-432-vault.md`

**Steps**:

1. Write failing test:

   ```bash
   grep -q 'vault operator raft snapshot save' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails:

   ```bash
   grep -q 'vault operator raft snapshot save' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=1
   ```

3. Implement — append section 13:

   ```markdown
   ## 13. Raft snapshot backup + offline restore drill

   ### Backup (cron on active node)

   ```bash
   sudo tee /usr/local/bin/vault-snapshot.sh > /dev/null <<'EOF'
   #!/usr/bin/env bash
   set -euo pipefail
   export VAULT_ADDR=https://127.0.0.1:8200
   export VAULT_CACERT=/etc/vault.d/tls/vault-ca.crt
   TS=$(date -u +%Y%m%dT%H%M%SZ)
   OUT=/var/backups/vault/snapshot-${TS}.snap
   mkdir -p /var/backups/vault
   vault operator raft snapshot save "${OUT}"
   # Mirror to MinIO (pgbackrest-compatible offline backup target)
   /usr/local/bin/mc cp "${OUT}" minio/vault-backups/
   # Keep last 14 days locally
   find /var/backups/vault -name 'snapshot-*.snap' -mtime +14 -delete
   EOF
   sudo chmod +x /usr/local/bin/vault-snapshot.sh

   # cron: every 4 hours
   echo "0 */4 * * * vault /usr/local/bin/vault-snapshot.sh >> /var/log/vault/snapshot.log 2>&1" \
     | sudo tee /etc/cron.d/vault-snapshot
   ```

   ### Restore drill (quarterly, on staging cluster only)

   ```bash
   # 1. Bring up a fresh single-node Vault on staging VM
   # 2. Initialize it but DON'T unseal yet
   vault operator init -key-shares=1 -key-threshold=1 -format=json > /tmp/init-staging.json
   # 3. Unseal with the staging key (only 1 share needed)
   # 4. Restore the production snapshot
   vault operator raft snapshot restore -force /var/backups/vault/snapshot-<TS>.snap
   # 5. Re-unseal with PRODUCTION key shares (Shamir 3-of-5)
   # 6. Verify: vault kv get secret/hope/JWT_SECRET_KEY  → should return the production value
   # 7. Tear down staging
   ```

   Document outcome (success/failure, recovery time objective achieved) in `research/runbooks/vault-dr-drill-YYYY-MM.md` after each drill.
   ```

4. Verify test passes:

   ```bash
   grep -q 'vault operator raft snapshot save' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=0
   ```

5. Commit:

   ```bash
   git add research/deployments/deploy-vm430-432-vault.md
   git commit -m "docs(deployments): add Raft snapshot backup + DR restore drill (section 13)"
   ```

---

### Task 1.14: Fill Section 15 — Application config for staging/prod

**Agent**: `docs-manager`

**Files**:
- Modify: `research/deployments/deploy-vm430-432-vault.md`

**Steps**:

1. Write failing test:

   ```bash
   grep -q 'SECRETS_PROVIDER=vault' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails:

   ```bash
   grep -q 'SECRETS_PROVIDER=vault' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=1
   ```

3. Implement — append section 15:

   ```markdown
   ## 15. Application configuration (HOPE API)

   In staging/prod systemd units (`/etc/systemd/system/hope-api.service`), add:

   ```
   Environment=SECRETS_PROVIDER=vault
   Environment=VAULT_ADDR=https://vault.taphuynh.dev
   Environment=VAULT_NAMESPACE=
   Environment=VAULT_ROLE_ID=<value committed in config-repo>
   EnvironmentFile=/run/hope/vault-wrapped-secret-id
   # The deployment pipeline writes /run/hope/vault-wrapped-secret-id at deploy time
   # with VAULT_WRAPPED_SECRET_ID=<60s-TTL response-wrapping token>
   ```

   Deployment hook (called by `.gitlab/ci/deploy.yml` before `systemctl start hope-api`):

   ```bash
   # On the SRE control plane (not in the app VM)
   WRAP_TOKEN=$(vault write -wrap-ttl=60s -f auth/approle/role/hope-app/secret-id -format=json | jq -r '.wrap_info.token')
   ssh hope@$APP_VM "echo VAULT_WRAPPED_SECRET_ID=${WRAP_TOKEN} | sudo tee /run/hope/vault-wrapped-secret-id"
   ssh hope@$APP_VM "sudo systemctl restart hope-api"
   ```

   App-side unwrapping happens once in `SecretsService.boot()` (see Plan Phase 2B Task 2.10). After unwrapping, `/run/hope/vault-wrapped-secret-id` is deleted by the post-start hook.
   ```

4. Verify test passes:

   ```bash
   grep -q 'SECRETS_PROVIDER=vault' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=0
   ```

5. Commit:

   ```bash
   git add research/deployments/deploy-vm430-432-vault.md
   git commit -m "docs(deployments): add application config + wrapped secret_id flow (section 15)"
   ```

---

### Code Review Gate 1B — `code-reviewer` + `security-auditor`

**Inputs**: Tasks 1.7–1.14 commits on `feat/task-302-vault/p1b-cluster-blueprint`.

**Checks**:

- [ ] All blueprint sections present (TOC items 1–18)
- [ ] HCL config compiles in dev-mode emulation: `docker run --rm -v $(pwd)/research/deployments/configs:/etc/vault.d hashicorp/vault:1.18 server -config=/etc/vault.d/vault.hcl -dev 2>&1 | head -20` should not error on syntax
- [ ] No real key material / token committed (`git grep 'hvs\\.[a-zA-Z0-9]\\{20,\\}'` returns nothing)
- [ ] Section 7 explicitly forbids storing key shares in encrypted files (operational requirement, see R1)
- [ ] HAProxy backend health check matches Vault's `/v1/sys/health?standbyok=true` semantics
- [ ] DR runbook references quarterly drill cadence
- [ ] Application config in section 15 uses response-wrapped `secret_id` (D4) not raw `secret_id`

**Action if pass**: PR `feat/task-302-vault/p1b-cluster-blueprint` → `dev`; hand off to SRE for VM provisioning (separate ticket, outside this plan).
**Action if fail**: return to authoring tasks; do not advance.

---

# Phase 2 — `ISecretsProvider` Adapter

**Phase Goal**: A `SecretsModule` in `packages/applications` exposing `SecretsService` (typed wrapper) backed by an `ISecretsProvider` interface with four implementations (`env`, `vault`, `aws` stub, `azure` stub, `in-memory` test-only). Selection at boot via `SECRETS_PROVIDER` env var. LRU + TTL cache + Redis Pub/Sub invalidation. `health()` wired to NestJS `/readiness`.

**Entry Criteria**: Phase 1A merged (Vault dev container available for integration tests).

**Exit Criteria**:
- All four providers exist and compile.
- `SecretsModule.forRootAsync()` factory selects provider per `SECRETS_PROVIDER`.
- Unit tests pass on all providers; integration tests pass against the `--profile vault` dev container.
- `/readiness` returns `503` when provider is unhealthy.
- No consumer code touched yet (that's Phase 3).

---

## Section 2A — Interface + Env provider + In-memory test provider

The foundation: types, the env-only provider (which behaves identically to the current code), and the test helper. No behavior change for any consumer because nothing imports `SecretsService` yet.

---

### Task 2.1: Scaffold the `secrets/` directory + barrel exports

**Agent**: `pipeline-architect`

**Files**:
- Create: `packages/applications/src/services/baseServices/_meta/secrets/index.ts`
- Create: `packages/applications/src/services/baseServices/_meta/secrets/.gitkeep`
- Modify: `packages/applications/src/services/baseServices/_meta/index.ts`

**Steps**:

1. Write failing test:

   ```bash
   test -d packages/applications/src/services/baseServices/_meta/secrets && echo "exists" || echo "missing"
   # Expected: "missing"
   ```

2. Verify fails:

   ```bash
   ls packages/applications/src/services/baseServices/_meta/secrets 2>&1 | head -1
   # Expected: "No such file or directory"
   ```

3. Implement:

   ```bash
   mkdir -p packages/applications/src/services/baseServices/_meta/secrets
   touch packages/applications/src/services/baseServices/_meta/secrets/.gitkeep
   ```

   Create `packages/applications/src/services/baseServices/_meta/secrets/index.ts`:

   ```typescript
   export * from './ISecretsProvider';
   export * from './SecretsService';
   export * from './secrets.module';
   export * from './providers/env-secrets.provider';
   export * from './providers/vault-secrets.provider';
   export * from './providers/in-memory-secrets.provider';
   export * from './providers/aws-secrets-manager.provider';
   export * from './providers/azure-keyvault.provider';
   ```

   Update `packages/applications/src/services/baseServices/_meta/index.ts`:

   ```typescript
   // This file is auto-generated. Be careful to edit manually
   export * from './appSettings';
   export * from './config';
   export * from './secrets';
   ```

4. Verify test passes:

   ```bash
   ls packages/applications/src/services/baseServices/_meta/secrets/index.ts
   # Expected: lists the file (tsc will fail next steps until files exist; that's fine)
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/ \
           packages/applications/src/services/baseServices/_meta/index.ts
   git commit -m "feat(secrets): scaffold secrets/ folder + barrel under _meta"
   ```

---

### Task 2.2: Define `ISecretsProvider` interface + DTO types

**Agent**: `tester`

**Files**:
- Create: `packages/applications/src/services/baseServices/_meta/secrets/ISecretsProvider.ts`
- Create: `packages/applications/src/services/baseServices/_meta/secrets/__tests__/ISecretsProvider.test.ts`

**Steps**:

1. Write failing test:

   ```typescript
   // packages/applications/src/services/baseServices/_meta/secrets/__tests__/ISecretsProvider.test.ts
   import { describe, it, expect } from 'vitest';
   import { ISecretsProvider, SECRETS_PROVIDER_TOKEN } from '../ISecretsProvider';

   describe('ISecretsProvider', () => {
     it('exposes a DI token symbol', () => {
       expect(SECRETS_PROVIDER_TOKEN.toString()).toContain('ISecretsProvider');
     });

     it('describes the contract via TS structural typing', () => {
       const sample: ISecretsProvider = {
         getSecret: async () => 'x',
         getSecretOptional: async () => undefined,
         getSecretJson: async () => ({} as unknown as never),
         getSecrets: async () => ({}),
         rotateSecret: async () => {},
         health: async () => ({ ok: true, latencyMs: 0, provider: 'test' }),
       };
       expect(typeof sample.getSecret).toBe('function');
     });
   });
   ```

2. Verify test fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- ISecretsProvider
   # Expected: 0 passing, 1 failing  ("Cannot find module ../ISecretsProvider")
   ```

3. Implement:

   ```typescript
   // packages/applications/src/services/baseServices/_meta/secrets/ISecretsProvider.ts
   export const SECRETS_PROVIDER_TOKEN = Symbol.for('ISecretsProvider');

   export interface SecretFetchOptions {
     /** Cache TTL in seconds; default 300. */
     ttlSec?: number;
     /** If true, throw on missing; if false, return undefined. Default true. */
     required?: boolean;
     /** Bypass cache for this call. */
     refresh?: boolean;
   }

   export interface SecretsHealth {
     ok: boolean;
     latencyMs: number;
     provider: string;
     /** Optional human-readable detail; never include secret material. */
     detail?: string;
   }

   export interface ISecretsProvider {
     getSecret(key: string, opts?: SecretFetchOptions): Promise<string>;
     getSecretOptional(key: string, opts?: SecretFetchOptions): Promise<string | undefined>;
     getSecretJson<T>(key: string, opts?: SecretFetchOptions): Promise<T>;
     getSecrets(keys: string[], opts?: SecretFetchOptions): Promise<Record<string, string>>;
     rotateSecret(key: string): Promise<void>;
     health(): Promise<SecretsHealth>;
   }

   export type SecretsProviderName = 'env' | 'vault' | 'aws' | 'azure' | 'in-memory';
   ```

4. Verify test passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- ISecretsProvider
   # Expected: 2 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/ISecretsProvider.ts \
           packages/applications/src/services/baseServices/_meta/secrets/__tests__/ISecretsProvider.test.ts
   git commit -m "feat(secrets): define ISecretsProvider interface + DI token"
   ```

---

### Task 2.3: Implement `EnvSecretsProvider`

**Agent**: `tester`

**Files**:
- Create: `packages/applications/src/services/baseServices/_meta/secrets/providers/env-secrets.provider.ts`
- Create: `packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/env-secrets.provider.test.ts`

**Steps**:

1. Write failing test:

   ```typescript
   // packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/env-secrets.provider.test.ts
   import { describe, it, expect, beforeEach, afterEach } from 'vitest';
   import { EnvSecretsProvider } from '../env-secrets.provider';

   describe('EnvSecretsProvider', () => {
     const originalEnv = process.env;
     beforeEach(() => { process.env = { ...originalEnv }; });
     afterEach(() => { process.env = originalEnv; });

     it('returns value from process.env', async () => {
       process.env.MY_SECRET = 'shh';
       const provider = new EnvSecretsProvider();
       await expect(provider.getSecret('MY_SECRET')).resolves.toBe('shh');
     });

     it('throws on missing when required=true (default)', async () => {
       const provider = new EnvSecretsProvider();
       await expect(provider.getSecret('NONEXISTENT')).rejects.toThrow(/NONEXISTENT/);
     });

     it('returns undefined on missing when required=false', async () => {
       const provider = new EnvSecretsProvider();
       await expect(provider.getSecretOptional('NONEXISTENT')).resolves.toBeUndefined();
     });

     it('bulk-fetches multiple keys', async () => {
       process.env.A = '1'; process.env.B = '2';
       const provider = new EnvSecretsProvider();
       const out = await provider.getSecrets(['A', 'B']);
       expect(out).toEqual({ A: '1', B: '2' });
     });

     it('health returns ok:true with provider=env', async () => {
       const provider = new EnvSecretsProvider();
       const h = await provider.health();
       expect(h.ok).toBe(true);
       expect(h.provider).toBe('env');
     });
   });
   ```

2. Verify test fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- env-secrets.provider
   # Expected: cannot find module
   ```

3. Implement:

   ```typescript
   // packages/applications/src/services/baseServices/_meta/secrets/providers/env-secrets.provider.ts
   import { Injectable, Logger } from '@nestjs/common';
   import {
     ISecretsProvider,
     SecretFetchOptions,
     SecretsHealth,
   } from '../ISecretsProvider';

   @Injectable()
   export class EnvSecretsProvider implements ISecretsProvider {
     private readonly logger = new Logger(EnvSecretsProvider.name);

     async getSecret(key: string, opts?: SecretFetchOptions): Promise<string> {
       const v = process.env[key];
       if (v === undefined || v === '') {
         if (opts?.required === false) return '';
         throw new Error(`EnvSecretsProvider: required secret '${key}' is not set in process.env`);
       }
       return v;
     }

     async getSecretOptional(key: string): Promise<string | undefined> {
       const v = process.env[key];
       return v && v.length > 0 ? v : undefined;
     }

     async getSecretJson<T>(key: string, opts?: SecretFetchOptions): Promise<T> {
       const raw = await this.getSecret(key, opts);
       try {
         return JSON.parse(raw) as T;
       } catch (e) {
         throw new Error(`EnvSecretsProvider: secret '${key}' is not valid JSON`);
       }
     }

     async getSecrets(keys: string[]): Promise<Record<string, string>> {
       const out: Record<string, string> = {};
       for (const k of keys) {
         const v = process.env[k];
         if (v !== undefined && v !== '') out[k] = v;
       }
       return out;
     }

     async rotateSecret(_key: string): Promise<void> {
       throw new Error('EnvSecretsProvider does not support rotation; restart pod with new env');
     }

     async health(): Promise<SecretsHealth> {
       return { ok: true, latencyMs: 0, provider: 'env' };
     }
   }
   ```

4. Verify test passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- env-secrets.provider
   # Expected: 5 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/providers/env-secrets.provider.ts \
           packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/env-secrets.provider.test.ts
   git commit -m "feat(secrets): add EnvSecretsProvider with process.env reads"
   ```

---

### Task 2.4: Implement `InMemorySecretsProvider`

**Agent**: `tester`

**Files**:
- Create: `packages/applications/src/services/baseServices/_meta/secrets/providers/in-memory-secrets.provider.ts`
- Create: `packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/in-memory-secrets.provider.test.ts`

**Steps**:

1. Write failing test:

   ```typescript
   import { describe, it, expect } from 'vitest';
   import { InMemorySecretsProvider } from '../in-memory-secrets.provider';

   describe('InMemorySecretsProvider', () => {
     it('returns seeded values', async () => {
       const provider = new InMemorySecretsProvider({ FOO: 'bar' });
       await expect(provider.getSecret('FOO')).resolves.toBe('bar');
     });

     it('supports setSecret + rotation', async () => {
       const provider = new InMemorySecretsProvider({});
       await provider.setSecret('K', 'v1');
       expect(await provider.getSecret('K')).toBe('v1');
       await provider.rotateSecret('K', 'v2');
       expect(await provider.getSecret('K')).toBe('v2');
     });

     it('throws on missing required', async () => {
       const provider = new InMemorySecretsProvider({});
       await expect(provider.getSecret('NOPE')).rejects.toThrow();
     });

     it('health returns ok:true with provider=in-memory', async () => {
       const provider = new InMemorySecretsProvider({});
       await expect(provider.health()).resolves.toMatchObject({ ok: true, provider: 'in-memory' });
     });
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- in-memory-secrets.provider
   # Expected: module not found
   ```

3. Implement:

   ```typescript
   // packages/applications/src/services/baseServices/_meta/secrets/providers/in-memory-secrets.provider.ts
   import { Injectable } from '@nestjs/common';
   import {
     ISecretsProvider,
     SecretFetchOptions,
     SecretsHealth,
   } from '../ISecretsProvider';

   @Injectable()
   export class InMemorySecretsProvider implements ISecretsProvider {
     private store: Map<string, string>;

     constructor(seed: Record<string, string> = {}) {
       this.store = new Map(Object.entries(seed));
     }

     async setSecret(key: string, value: string): Promise<void> {
       this.store.set(key, value);
     }

     async getSecret(key: string, opts?: SecretFetchOptions): Promise<string> {
       const v = this.store.get(key);
       if (v === undefined) {
         if (opts?.required === false) return '';
         throw new Error(`InMemorySecretsProvider: required secret '${key}' is not seeded`);
       }
       return v;
     }

     async getSecretOptional(key: string): Promise<string | undefined> {
       return this.store.get(key);
     }

     async getSecretJson<T>(key: string, opts?: SecretFetchOptions): Promise<T> {
       const raw = await this.getSecret(key, opts);
       return JSON.parse(raw) as T;
     }

     async getSecrets(keys: string[]): Promise<Record<string, string>> {
       const out: Record<string, string> = {};
       for (const k of keys) {
         const v = this.store.get(k);
         if (v !== undefined) out[k] = v;
       }
       return out;
     }

     async rotateSecret(key: string, newValue?: string): Promise<void> {
       if (newValue !== undefined) this.store.set(key, newValue);
     }

     async health(): Promise<SecretsHealth> {
       return { ok: true, latencyMs: 0, provider: 'in-memory' };
     }
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- in-memory-secrets.provider
   # Expected: 4 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/providers/in-memory-secrets.provider.ts \
           packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/in-memory-secrets.provider.test.ts
   git commit -m "feat(secrets): add InMemorySecretsProvider for tests"
   ```

---

### Task 2.5: Implement `AwsSecretsManagerProvider` stub (throws NotImplementedException)

**Agent**: `tester`

**Files**:
- Create: `packages/applications/src/services/baseServices/_meta/secrets/providers/aws-secrets-manager.provider.ts`
- Create: `packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/aws-secrets-manager.provider.test.ts`

**Steps**:

1. Write failing test:

   ```typescript
   import { describe, it, expect } from 'vitest';
   import { NotImplementedException } from '@nestjs/common';
   import { AwsSecretsManagerProvider } from '../aws-secrets-manager.provider';

   describe('AwsSecretsManagerProvider (stub)', () => {
     it('throws NotImplementedException on getSecret', async () => {
       const p = new AwsSecretsManagerProvider();
       await expect(p.getSecret('X')).rejects.toBeInstanceOf(NotImplementedException);
     });
     it('throws NotImplementedException on health', async () => {
       const p = new AwsSecretsManagerProvider();
       await expect(p.health()).rejects.toBeInstanceOf(NotImplementedException);
     });
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- aws-secrets-manager.provider
   # Expected: module not found
   ```

3. Implement:

   ```typescript
   // packages/applications/src/services/baseServices/_meta/secrets/providers/aws-secrets-manager.provider.ts
   import { Injectable, NotImplementedException } from '@nestjs/common';
   import { ISecretsProvider, SecretsHealth } from '../ISecretsProvider';

   @Injectable()
   export class AwsSecretsManagerProvider implements ISecretsProvider {
     private fail(): never {
       throw new NotImplementedException(
         'AwsSecretsManagerProvider is a future-option stub. Set SECRETS_PROVIDER=vault or =env.',
       );
     }
     async getSecret(): Promise<string> { this.fail(); }
     async getSecretOptional(): Promise<string | undefined> { this.fail(); }
     async getSecretJson<T>(): Promise<T> { this.fail(); }
     async getSecrets(): Promise<Record<string, string>> { this.fail(); }
     async rotateSecret(): Promise<void> { this.fail(); }
     async health(): Promise<SecretsHealth> { this.fail(); }
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- aws-secrets-manager.provider
   # Expected: 2 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/providers/aws-secrets-manager.provider.ts \
           packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/aws-secrets-manager.provider.test.ts
   git commit -m "feat(secrets): add AwsSecretsManagerProvider stub (NotImplementedException)"
   ```

---

### Task 2.6: Implement `AzureKeyVaultProvider` stub

**Agent**: `tester`

**Files**:
- Create: `packages/applications/src/services/baseServices/_meta/secrets/providers/azure-keyvault.provider.ts`
- Create: `packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/azure-keyvault.provider.test.ts`

**Steps**:

1. Write failing test (mirror Task 2.5):

   ```typescript
   import { describe, it, expect } from 'vitest';
   import { NotImplementedException } from '@nestjs/common';
   import { AzureKeyVaultProvider } from '../azure-keyvault.provider';

   describe('AzureKeyVaultProvider (stub)', () => {
     it('throws NotImplementedException on getSecret', async () => {
       await expect(new AzureKeyVaultProvider().getSecret('X')).rejects.toBeInstanceOf(NotImplementedException);
     });
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- azure-keyvault.provider
   # Expected: module not found
   ```

3. Implement (mirror Task 2.5 structure):

   ```typescript
   // packages/applications/src/services/baseServices/_meta/secrets/providers/azure-keyvault.provider.ts
   import { Injectable, NotImplementedException } from '@nestjs/common';
   import { ISecretsProvider, SecretsHealth } from '../ISecretsProvider';

   @Injectable()
   export class AzureKeyVaultProvider implements ISecretsProvider {
     private fail(): never {
       throw new NotImplementedException(
         'AzureKeyVaultProvider is a future-option stub. Set SECRETS_PROVIDER=vault or =env.',
       );
     }
     async getSecret(): Promise<string> { this.fail(); }
     async getSecretOptional(): Promise<string | undefined> { this.fail(); }
     async getSecretJson<T>(): Promise<T> { this.fail(); }
     async getSecrets(): Promise<Record<string, string>> { this.fail(); }
     async rotateSecret(): Promise<void> { this.fail(); }
     async health(): Promise<SecretsHealth> { this.fail(); }
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- azure-keyvault.provider
   # Expected: 1 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/providers/azure-keyvault.provider.ts \
           packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/azure-keyvault.provider.test.ts
   git commit -m "feat(secrets): add AzureKeyVaultProvider stub (NotImplementedException)"
   ```

---

### Code Review Gate 2A — `code-reviewer`

**Checks**:

- [ ] All 5 providers compile (`pnpm --filter @arcaai/applications build` green)
- [ ] All 5 provider unit tests pass (`pnpm --filter @arcaai/applications test:unit`)
- [ ] Stubs throw `NotImplementedException` (not `Error`) so NestJS maps to 501
- [ ] Barrel exports complete and ordered consistently
- [ ] No `console.log` left in provider code

**Action if pass**: PR `feat/task-302-vault/p2a-interface-providers` → `dev`; merge.
**Action if fail**: return tasks; do not advance.

---

## Section 2B — `VaultSecretsProvider`

The Vault implementation. Uses `node-vault` (pure-TS, ~50KB, no native deps). Wraps `kv-v2` reads, AppRole login (with response-wrapping unwrap on boot), `transit` encrypt/decrypt helpers (used by Phase 4), and `database/creds/<role>` for Phase 5.

---

### Task 2.7: Add `node-vault` dependency + type stubs

**Agent**: `pipeline-architect`

**Files**:
- Modify: `packages/applications/package.json`

**Steps**:

1. Write failing test:

   ```bash
   grep -q '"node-vault"' packages/applications/package.json
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails:

   ```bash
   grep -q '"node-vault"' packages/applications/package.json
   echo "rc=$?"
   # Expected: rc=1
   ```

3. Implement:

   ```bash
   cd packages/applications
   pnpm add node-vault@^0.10.4
   pnpm add -D @types/node-vault@^0.10.0 || true   # @types may be unavailable; rely on .d.ts shim
   ```

   If `@types/node-vault` is not on npm, create a local type shim:

   ```typescript
   // packages/applications/src/types/node-vault.d.ts
   declare module 'node-vault' {
     interface VaultOptions {
       apiVersion?: string;
       endpoint?: string;
       token?: string;
       namespace?: string;
       requestOptions?: { timeout?: number };
     }
     interface KvV2ReadResult { data: { data: Record<string, unknown>; metadata: { version: number } } }
     interface VaultClient {
       token?: string;
       help(path: string): Promise<unknown>;
       read(path: string): Promise<KvV2ReadResult & Record<string, unknown>>;
       write(path: string, data: unknown): Promise<unknown>;
       approleLogin(opts: { role_id: string; secret_id: string }): Promise<{ auth: { client_token: string; lease_duration: number; renewable: boolean } }>;
       unwrap(token: string): Promise<{ data: Record<string, unknown> }>;
       status(): Promise<{ initialized: boolean; sealed: boolean; standby: boolean }>;
       health(opts?: { standbyok?: boolean }): Promise<{ initialized: boolean; sealed: boolean }>;
     }
     function vault(opts?: VaultOptions): VaultClient;
     export default vault;
     export { VaultOptions, VaultClient };
   }
   ```

4. Verify passes:

   ```bash
   grep -q '"node-vault"' packages/applications/package.json
   echo "rc=$?"
   # Expected: rc=0
   pnpm --filter @arcaai/applications build
   # Expected: build succeeds
   ```

5. Commit:

   ```bash
   git add packages/applications/package.json pnpm-lock.yaml packages/applications/src/types/node-vault.d.ts
   git commit -m "feat(secrets): add node-vault dependency + type shim"
   ```

---

### Task 2.8: Scaffold `VaultSecretsProvider` with constructor + config types

**Agent**: `pipeline-architect`

**Files**:
- Create: `packages/applications/src/services/baseServices/_meta/secrets/providers/vault-secrets.provider.ts`
- Create: `packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/vault-secrets.provider.test.ts`

**Steps**:

1. Write failing test:

   ```typescript
   import { describe, it, expect } from 'vitest';
   import { VaultSecretsProvider, VaultProviderConfig } from '../vault-secrets.provider';

   describe('VaultSecretsProvider (construction)', () => {
     it('requires VAULT_ADDR + VAULT_ROLE_ID', () => {
       expect(() => new VaultSecretsProvider({} as unknown as VaultProviderConfig)).toThrow(/VAULT_ADDR/);
     });

     it('accepts a valid config', () => {
       const p = new VaultSecretsProvider({
         addr: 'http://vault:8200',
         roleId: 'rid',
         kvMount: 'secret',
         kvPrefix: 'hope',
         transitMount: 'transit',
         transitKey: 'hope-globalsetting',
       });
       expect(p).toBeDefined();
     });
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- vault-secrets.provider
   # Expected: module not found
   ```

3. Implement:

   ```typescript
   // packages/applications/src/services/baseServices/_meta/secrets/providers/vault-secrets.provider.ts
   import { Injectable, Logger } from '@nestjs/common';
   import vault, { VaultClient } from 'node-vault';
   import {
     ISecretsProvider,
     SecretFetchOptions,
     SecretsHealth,
   } from '../ISecretsProvider';

   export interface VaultProviderConfig {
     addr: string;
     roleId: string;
     /** Wrapped secret_id token; unwrapped once during boot(). */
     wrappedSecretId?: string;
     /** Raw secret_id; only allowed in dev / opt-in path. */
     secretId?: string;
     namespace?: string;
     /** kv-v2 mount name (default 'secret'). */
     kvMount: string;
     /** Prefix beneath the mount (default 'hope'). Final path: secret/data/<kvPrefix>/<KEY>. */
     kvPrefix: string;
     /** Transit mount name (default 'transit'). */
     transitMount: string;
     /** Transit key name (default 'hope-globalsetting'). */
     transitKey: string;
     requestTimeoutMs?: number;
   }

   @Injectable()
   export class VaultSecretsProvider implements ISecretsProvider {
     private readonly logger = new Logger(VaultSecretsProvider.name);
     private client: VaultClient;
     private booted = false;

     constructor(private readonly config: VaultProviderConfig) {
       if (!config.addr) throw new Error('VAULT_ADDR is required');
       if (!config.roleId) throw new Error('VAULT_ROLE_ID is required');
       if (!config.wrappedSecretId && !config.secretId) {
         throw new Error('Either VAULT_WRAPPED_SECRET_ID or VAULT_SECRET_ID is required');
       }
       this.client = vault({
         apiVersion: 'v1',
         endpoint: config.addr,
         namespace: config.namespace,
         requestOptions: { timeout: config.requestTimeoutMs ?? 5000 },
       });
     }

     // boot(), getSecret(), etc. implemented in Tasks 2.9–2.10
     async getSecret(): Promise<string> { throw new Error('not yet implemented'); }
     async getSecretOptional(): Promise<string | undefined> { throw new Error('not yet implemented'); }
     async getSecretJson<T>(): Promise<T> { throw new Error('not yet implemented'); }
     async getSecrets(): Promise<Record<string, string>> { throw new Error('not yet implemented'); }
     async rotateSecret(): Promise<void> { throw new Error('not yet implemented'); }
     async health(): Promise<SecretsHealth> { throw new Error('not yet implemented'); }
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- vault-secrets.provider
   # Expected: 2 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/providers/vault-secrets.provider.ts \
           packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/vault-secrets.provider.test.ts
   git commit -m "feat(secrets): scaffold VaultSecretsProvider with config validation"
   ```

---

### Task 2.9: Implement `boot()` — AppRole login + wrapped secret_id unwrap

**Agent**: `security-auditor`

**Files**:
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/providers/vault-secrets.provider.ts`
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/vault-secrets.provider.test.ts`

**Steps**:

1. Write failing test (add to file):

   ```typescript
   import { vi } from 'vitest';

   describe('VaultSecretsProvider.boot()', () => {
     it('unwraps a wrapped secret_id and logs in via AppRole', async () => {
       const mockUnwrap = vi.fn().mockResolvedValue({ data: { secret_id: 'real-sid' } });
       const mockLogin = vi.fn().mockResolvedValue({ auth: { client_token: 'hvs.xxx', lease_duration: 3600, renewable: true } });
       const p = new VaultSecretsProvider({
         addr: 'http://vault:8200', roleId: 'rid', wrappedSecretId: 'wrap.token',
         kvMount: 'secret', kvPrefix: 'hope', transitMount: 'transit', transitKey: 'hope-globalsetting',
       });
       // @ts-expect-error swap private client for test
       p.client = { unwrap: mockUnwrap, approleLogin: mockLogin };
       await p.boot();
       expect(mockUnwrap).toHaveBeenCalledWith('wrap.token');
       expect(mockLogin).toHaveBeenCalledWith({ role_id: 'rid', secret_id: 'real-sid' });
     });

     it('uses raw secret_id without unwrap when wrappedSecretId is absent', async () => {
       const mockUnwrap = vi.fn();
       const mockLogin = vi.fn().mockResolvedValue({ auth: { client_token: 'hvs.xxx', lease_duration: 3600, renewable: true } });
       const p = new VaultSecretsProvider({
         addr: 'http://vault:8200', roleId: 'rid', secretId: 'raw-sid',
         kvMount: 'secret', kvPrefix: 'hope', transitMount: 'transit', transitKey: 'hope-globalsetting',
       });
       // @ts-expect-error
       p.client = { unwrap: mockUnwrap, approleLogin: mockLogin };
       await p.boot();
       expect(mockUnwrap).not.toHaveBeenCalled();
       expect(mockLogin).toHaveBeenCalledWith({ role_id: 'rid', secret_id: 'raw-sid' });
     });
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- vault-secrets.provider
   # Expected: 2 failures ("not yet implemented" / no boot)
   ```

3. Implement: replace the stub `boot()` and add the method:

   ```typescript
   async boot(): Promise<void> {
     let secretId = this.config.secretId;
     if (this.config.wrappedSecretId) {
       const unwrapped = await this.client.unwrap(this.config.wrappedSecretId);
       secretId = (unwrapped.data as { secret_id: string }).secret_id;
     }
     if (!secretId) {
       throw new Error('VaultSecretsProvider.boot(): no secret_id available after unwrap');
     }
     const login = await this.client.approleLogin({ role_id: this.config.roleId, secret_id: secretId });
     this.client.token = login.auth.client_token;
     this.booted = true;
     this.logger.log({
       message: 'Vault AppRole login successful',
       leaseSec: login.auth.lease_duration,
       renewable: login.auth.renewable,
     });
   }

   private ensureBooted(): void {
     if (!this.booted) throw new Error('VaultSecretsProvider not booted; call boot() before reads');
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- vault-secrets.provider
   # Expected: 4 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/providers/vault-secrets.provider.ts \
           packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/vault-secrets.provider.test.ts
   git commit -m "feat(secrets): VaultSecretsProvider boot() with wrapped secret_id unwrap"
   ```

---

### Task 2.10: Implement `getSecret()` / `getSecretOptional()` / `getSecretJson()`

**Agent**: `tester`

**Files**:
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/providers/vault-secrets.provider.ts`
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/vault-secrets.provider.test.ts`

**Steps**:

1. Write failing test:

   ```typescript
   describe('VaultSecretsProvider reads', () => {
     it('getSecret reads kv-v2 at secret/data/hope/<KEY> and returns .data.data.value', async () => {
       const mockRead = vi.fn().mockResolvedValue({ data: { data: { value: 'shh' }, metadata: { version: 1 } } });
       const p = new VaultSecretsProvider({
         addr: 'http://vault:8200', roleId: 'rid', secretId: 'sid',
         kvMount: 'secret', kvPrefix: 'hope', transitMount: 'transit', transitKey: 'hope-globalsetting',
       });
       // @ts-expect-error
       p.client = { read: mockRead, approleLogin: () => ({ auth: { client_token: 't', lease_duration: 1, renewable: false } }) };
       await p.boot();
       await expect(p.getSecret('JWT_SECRET_KEY')).resolves.toBe('shh');
       expect(mockRead).toHaveBeenCalledWith('secret/data/hope/JWT_SECRET_KEY');
     });

     it('getSecretOptional returns undefined on 404', async () => {
       const mockRead = vi.fn().mockRejectedValue({ response: { statusCode: 404 } });
       const p = new VaultSecretsProvider({
         addr: 'http://vault:8200', roleId: 'rid', secretId: 'sid',
         kvMount: 'secret', kvPrefix: 'hope', transitMount: 'transit', transitKey: 'hope-globalsetting',
       });
       // @ts-expect-error
       p.client = { read: mockRead, approleLogin: () => ({ auth: { client_token: 't', lease_duration: 1, renewable: false } }) };
       await p.boot();
       await expect(p.getSecretOptional('MISSING')).resolves.toBeUndefined();
     });
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- vault-secrets.provider
   # Expected: 2 failures
   ```

3. Implement:

   ```typescript
   async getSecret(key: string, opts?: SecretFetchOptions): Promise<string> {
     this.ensureBooted();
     try {
       const path = `${this.config.kvMount}/data/${this.config.kvPrefix}/${key}`;
       const res = await this.client.read(path);
       const value = (res?.data as { data?: { value?: string } })?.data?.value;
       if (value === undefined || value === '') {
         if (opts?.required === false) return '';
         throw new Error(`VaultSecretsProvider: empty value at ${path}`);
       }
       return value;
     } catch (err: unknown) {
       const status = (err as { response?: { statusCode?: number } })?.response?.statusCode;
       if (status === 404 && opts?.required !== true) {
         throw new Error(`VaultSecretsProvider: secret '${key}' not found`);
       }
       throw err;
     }
   }

   async getSecretOptional(key: string): Promise<string | undefined> {
     this.ensureBooted();
     try {
       const path = `${this.config.kvMount}/data/${this.config.kvPrefix}/${key}`;
       const res = await this.client.read(path);
       return (res?.data as { data?: { value?: string } })?.data?.value;
     } catch (err: unknown) {
       const status = (err as { response?: { statusCode?: number } })?.response?.statusCode;
       if (status === 404) return undefined;
       throw err;
     }
   }

   async getSecretJson<T>(key: string, opts?: SecretFetchOptions): Promise<T> {
     const raw = await this.getSecret(key, opts);
     try { return JSON.parse(raw) as T; }
     catch { throw new Error(`VaultSecretsProvider: secret '${key}' is not valid JSON`); }
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- vault-secrets.provider
   # Expected: 6 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/providers/vault-secrets.provider.ts \
           packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/vault-secrets.provider.test.ts
   git commit -m "feat(secrets): VaultSecretsProvider getSecret/getSecretOptional/getSecretJson"
   ```

---

### Task 2.11: Implement `getSecrets()` (bulk) + `health()`

**Agent**: `tester`

**Files**:
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/providers/vault-secrets.provider.ts`
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/vault-secrets.provider.test.ts`

**Steps**:

1. Write failing test:

   ```typescript
   describe('VaultSecretsProvider bulk + health', () => {
     it('getSecrets fetches multiple keys concurrently', async () => {
       const mockRead = vi.fn(async (path: string) => {
         const key = path.split('/').pop()!;
         return { data: { data: { value: `v-${key}` }, metadata: { version: 1 } } };
       });
       const p = new VaultSecretsProvider({
         addr: 'http://vault:8200', roleId: 'rid', secretId: 'sid',
         kvMount: 'secret', kvPrefix: 'hope', transitMount: 'transit', transitKey: 'hope-globalsetting',
       });
       // @ts-expect-error
       p.client = { read: mockRead, approleLogin: () => ({ auth: { client_token: 't', lease_duration: 1, renewable: false } }) };
       await p.boot();
       const out = await p.getSecrets(['A', 'B', 'C']);
       expect(out).toEqual({ A: 'v-A', B: 'v-B', C: 'v-C' });
     });

     it('health returns ok:false when sys/health throws', async () => {
       const mockHealth = vi.fn().mockRejectedValue(new Error('refused'));
       const p = new VaultSecretsProvider({
         addr: 'http://vault:8200', roleId: 'rid', secretId: 'sid',
         kvMount: 'secret', kvPrefix: 'hope', transitMount: 'transit', transitKey: 'hope-globalsetting',
       });
       // @ts-expect-error
       p.client = { health: mockHealth, approleLogin: () => ({ auth: { client_token: 't', lease_duration: 1, renewable: false } }) };
       await p.boot();
       const h = await p.health();
       expect(h).toMatchObject({ ok: false, provider: 'vault' });
     });
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- vault-secrets.provider
   # Expected: 2 failures
   ```

3. Implement:

   ```typescript
   async getSecrets(keys: string[], opts?: SecretFetchOptions): Promise<Record<string, string>> {
     this.ensureBooted();
     const entries = await Promise.all(keys.map(async (k) => {
       try { return [k, await this.getSecret(k, opts)] as const; }
       catch { return [k, undefined] as const; }
     }));
     const out: Record<string, string> = {};
     for (const [k, v] of entries) { if (v !== undefined) out[k] = v; }
     return out;
   }

   async rotateSecret(_key: string): Promise<void> {
     throw new Error('Use kv-v2 versioning + Phase 6 rotation worker; client-side rotateSecret is not supported');
   }

   async health(): Promise<SecretsHealth> {
     const t0 = Date.now();
     try {
       const h = await this.client.health({ standbyok: true });
       const ok = h.initialized && !h.sealed;
       return { ok, latencyMs: Date.now() - t0, provider: 'vault', detail: ok ? 'active' : `initialized=${h.initialized} sealed=${h.sealed}` };
     } catch (err: unknown) {
       return { ok: false, latencyMs: Date.now() - t0, provider: 'vault', detail: (err as Error).message };
     }
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- vault-secrets.provider
   # Expected: 8 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/providers/vault-secrets.provider.ts \
           packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/vault-secrets.provider.test.ts
   git commit -m "feat(secrets): VaultSecretsProvider getSecrets + health"
   ```

---

### Task 2.12: Add Vault transit `encrypt()` + `decrypt()` helpers (used by Phase 4)

**Agent**: `security-auditor`

**Files**:
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/providers/vault-secrets.provider.ts`
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/vault-secrets.provider.test.ts`

These do not implement `ISecretsProvider` — they are vault-specific extras invoked by the encryption helper in Phase 4. Keep on the provider class so the transit mount stays in one place.

**Steps**:

1. Write failing test:

   ```typescript
   describe('VaultSecretsProvider transit helpers', () => {
     it('encrypt sends plaintext base64-encoded and returns ciphertext', async () => {
       const mockWrite = vi.fn().mockResolvedValue({ data: { ciphertext: 'vault:v1:abc==' } });
       const p = new VaultSecretsProvider({
         addr: 'http://vault:8200', roleId: 'rid', secretId: 'sid',
         kvMount: 'secret', kvPrefix: 'hope', transitMount: 'transit', transitKey: 'hope-globalsetting',
       });
       // @ts-expect-error
       p.client = { write: mockWrite, approleLogin: () => ({ auth: { client_token: 't', lease_duration: 1, renewable: false } }) };
       await p.boot();
       const ct = await p.encrypt(Buffer.from('hello'));
       expect(mockWrite).toHaveBeenCalledWith('transit/encrypt/hope-globalsetting', { plaintext: 'aGVsbG8=' });
       expect(ct).toBe('vault:v1:abc==');
     });

     it('decrypt sends ciphertext and returns base64-decoded plaintext', async () => {
       const mockWrite = vi.fn().mockResolvedValue({ data: { plaintext: 'aGVsbG8=' } });
       const p = new VaultSecretsProvider({
         addr: 'http://vault:8200', roleId: 'rid', secretId: 'sid',
         kvMount: 'secret', kvPrefix: 'hope', transitMount: 'transit', transitKey: 'hope-globalsetting',
       });
       // @ts-expect-error
       p.client = { write: mockWrite, approleLogin: () => ({ auth: { client_token: 't', lease_duration: 1, renewable: false } }) };
       await p.boot();
       const pt = await p.decrypt('vault:v1:abc==');
       expect(pt.toString('utf8')).toBe('hello');
     });
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- vault-secrets.provider
   # Expected: 2 failures
   ```

3. Implement:

   ```typescript
   async encrypt(plaintext: Buffer): Promise<string> {
     this.ensureBooted();
     const path = `${this.config.transitMount}/encrypt/${this.config.transitKey}`;
     const res = await this.client.write(path, { plaintext: plaintext.toString('base64') });
     const ct = (res as { data?: { ciphertext?: string } })?.data?.ciphertext;
     if (!ct) throw new Error(`VaultSecretsProvider.encrypt: empty ciphertext`);
     return ct;
   }

   async decrypt(ciphertext: string): Promise<Buffer> {
     this.ensureBooted();
     const path = `${this.config.transitMount}/decrypt/${this.config.transitKey}`;
     const res = await this.client.write(path, { ciphertext });
     const pt = (res as { data?: { plaintext?: string } })?.data?.plaintext;
     if (!pt) throw new Error(`VaultSecretsProvider.decrypt: empty plaintext`);
     return Buffer.from(pt, 'base64');
   }

   async issueDbCredential(role: string): Promise<{ username: string; password: string; leaseId: string; ttlSec: number }> {
     this.ensureBooted();
     const res = await this.client.read(`database/creds/${role}`);
     const data = (res as { data?: { username: string; password: string } }).data;
     const meta = res as unknown as { lease_id: string; lease_duration: number };
     if (!data?.username || !data?.password) throw new Error(`VaultSecretsProvider.issueDbCredential: empty creds`);
     return { username: data.username, password: data.password, leaseId: meta.lease_id, ttlSec: meta.lease_duration };
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- vault-secrets.provider
   # Expected: 10 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/providers/vault-secrets.provider.ts \
           packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/vault-secrets.provider.test.ts
   git commit -m "feat(secrets): add transit encrypt/decrypt + db cred helpers to VaultSecretsProvider"
   ```

---

### Task 2.13: Integration test against the dev Vault container

**Agent**: `tester`

**Files**:
- Create: `packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/vault-secrets.provider.integration.test.ts`

Runs against `docker compose --profile vault up` Vault dev container; marked with `describe.skipIf(!process.env.INTEG_VAULT)` so it only runs in CI's integration job and on manual `INTEG_VAULT=1 pnpm test`.

**Steps**:

1. Write failing test:

   ```typescript
   import { describe, it, expect, beforeAll } from 'vitest';
   import { VaultSecretsProvider } from '../vault-secrets.provider';
   import { execSync } from 'node:child_process';

   const enabled = !!process.env.INTEG_VAULT;
   const VAULT_ADDR = process.env.VAULT_ADDR ?? 'http://localhost:8200';
   const ROOT_TOKEN = process.env.VAULT_DEV_ROOT_TOKEN ?? 'root';

   describe.skipIf(!enabled)('VaultSecretsProvider (integration)', () => {
     let roleId: string;
     let wrappedSecretId: string;

     beforeAll(() => {
       const env = `VAULT_ADDR=${VAULT_ADDR} VAULT_TOKEN=${ROOT_TOKEN}`;
       roleId = execSync(`${env} vault read -field=role_id auth/approle/role/hope-app/role-id`).toString().trim();
       wrappedSecretId = execSync(`${env} vault write -wrap-ttl=60s -f -format=json auth/approle/role/hope-app/secret-id | jq -r .wrap_info.token`, { shell: '/bin/bash' as never }).toString().trim();
     });

     it('boots and reads a seeded secret', async () => {
       const p = new VaultSecretsProvider({
         addr: VAULT_ADDR, roleId, wrappedSecretId,
         kvMount: 'secret', kvPrefix: 'hope', transitMount: 'transit', transitKey: 'hope-globalsetting',
       });
       await p.boot();
       const v = await p.getSecret('JWT_SECRET_KEY');
       expect(v).toBe('dev-jwt-secret-not-for-prod');
     });

     it('round-trips transit encrypt/decrypt', async () => {
       const env = `VAULT_ADDR=${VAULT_ADDR} VAULT_TOKEN=${ROOT_TOKEN}`;
       execSync(`${env} vault write -f transit/keys/hope-globalsetting`);
       const p = new VaultSecretsProvider({
         addr: VAULT_ADDR, roleId, wrappedSecretId,
         kvMount: 'secret', kvPrefix: 'hope', transitMount: 'transit', transitKey: 'hope-globalsetting',
       });
       await p.boot();
       const ct = await p.encrypt(Buffer.from('payload'));
       expect(ct).toMatch(/^vault:v\d+:/);
       const pt = await p.decrypt(ct);
       expect(pt.toString('utf8')).toBe('payload');
     });
   });
   ```

2. Verify fails (without dev container):

   ```bash
   pnpm --filter @arcaai/applications test:unit -- vault-secrets.provider.integration
   # Expected: 0 tests run (skipped) — but file exists and compiles
   ```

3. Implement: the test file IS the implementation; trigger the integration profile:

   ```bash
   docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault up -d
   INTEG_VAULT=1 VAULT_DEV_ROOT_TOKEN=root pnpm --filter @arcaai/applications test:unit -- vault-secrets.provider.integration
   ```

4. Verify passes:

   ```bash
   INTEG_VAULT=1 VAULT_DEV_ROOT_TOKEN=root pnpm --filter @arcaai/applications test:unit -- vault-secrets.provider.integration
   # Expected: 2 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/providers/__tests__/vault-secrets.provider.integration.test.ts
   git commit -m "test(secrets): add VaultSecretsProvider integration test against dev container"
   ```

---

### Code Review Gate 2B — `code-reviewer` + `security-auditor`

**Checks**:

- [ ] `pnpm --filter @arcaai/applications build` green
- [ ] Unit + integration tests pass
- [ ] AppRole login uses wrapped `secret_id` by default (D4)
- [ ] No `console.log` of secrets, tokens, or `secret_id`
- [ ] `getSecret` honors `required` semantic (throws by default; returns `''` when `required:false`)
- [ ] `health()` is non-blocking and never throws — returns `{ok:false}` on error

**Action if pass**: PR `feat/task-302-vault/p2b-vault-provider` → `dev`; merge.

---

## Section 2C — `SecretsService` (typed wrapper) + cache + invalidation + module factory

The consumer-facing service. Cache + Redis Pub/Sub invalidation + module wiring.

---

### Task 2.14: Add `mnemonist` LRU dependency

**Agent**: `pipeline-architect`

**Files**:
- Modify: `packages/applications/package.json`

**Steps**:

1. Write failing test:

   ```bash
   grep -q '"mnemonist"' packages/applications/package.json
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails:

   ```bash
   grep -q '"mnemonist"' packages/applications/package.json && echo found || echo missing
   # Expected: missing
   ```

3. Implement:

   ```bash
   pnpm --filter @arcaai/applications add mnemonist@^0.40.0
   ```

4. Verify passes:

   ```bash
   grep -q '"mnemonist"' packages/applications/package.json
   echo "rc=$?"
   # Expected: rc=0
   ```

5. Commit:

   ```bash
   git add packages/applications/package.json pnpm-lock.yaml
   git commit -m "feat(secrets): add mnemonist for LRU cache in SecretsService"
   ```

---

### Task 2.15: Implement `SecretsService` with LRU cache + TTL

**Agent**: `tester`

**Files**:
- Create: `packages/applications/src/services/baseServices/_meta/secrets/SecretsService.ts`
- Create: `packages/applications/src/services/baseServices/_meta/secrets/__tests__/SecretsService.test.ts`

**Steps**:

1. Write failing test:

   ```typescript
   import { describe, it, expect, vi, beforeEach } from 'vitest';
   import { SecretsService } from '../SecretsService';
   import { InMemorySecretsProvider } from '../providers/in-memory-secrets.provider';

   describe('SecretsService', () => {
     let provider: InMemorySecretsProvider;
     let service: SecretsService;
     beforeEach(() => {
       provider = new InMemorySecretsProvider({ FOO: 'bar', JWT_SECRET_KEY: 'abc' });
       service = new SecretsService(provider, { defaultTtlSec: 300, lruMax: 200 });
     });

     it('returns the value', async () => {
       expect(await service.getSecret('FOO')).toBe('bar');
     });

     it('caches subsequent reads (delegate called once)', async () => {
       const spy = vi.spyOn(provider, 'getSecret');
       await service.getSecret('FOO');
       await service.getSecret('FOO');
       await service.getSecret('FOO');
       expect(spy).toHaveBeenCalledTimes(1);
     });

     it('refresh:true bypasses cache', async () => {
       const spy = vi.spyOn(provider, 'getSecret');
       await service.getSecret('FOO');
       await service.getSecret('FOO', { refresh: true });
       expect(spy).toHaveBeenCalledTimes(2);
     });

     it('invalidate(key) clears the cached value', async () => {
       const spy = vi.spyOn(provider, 'getSecret');
       await service.getSecret('FOO');
       service.invalidate('FOO');
       await service.getSecret('FOO');
       expect(spy).toHaveBeenCalledTimes(2);
     });
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- SecretsService
   # Expected: module not found
   ```

3. Implement:

   ```typescript
   // packages/applications/src/services/baseServices/_meta/secrets/SecretsService.ts
   import { Inject, Injectable, Logger } from '@nestjs/common';
   import LRUCache from 'mnemonist/lru-cache';
   import {
     ISecretsProvider,
     SECRETS_PROVIDER_TOKEN,
     SecretFetchOptions,
     SecretsHealth,
   } from './ISecretsProvider';

   export interface SecretsServiceOptions {
     defaultTtlSec?: number;
     lruMax?: number;
   }

   interface CacheEntry { value: string; expiresAt: number; }

   @Injectable()
   export class SecretsService {
     private readonly logger = new Logger(SecretsService.name);
     private readonly cache: LRUCache<string, CacheEntry>;
     private readonly defaultTtlMs: number;

     constructor(
       @Inject(SECRETS_PROVIDER_TOKEN) private readonly provider: ISecretsProvider,
       opts: SecretsServiceOptions = {},
     ) {
       this.cache = new LRUCache(opts.lruMax ?? 200);
       this.defaultTtlMs = (opts.defaultTtlSec ?? 300) * 1000;
     }

     async getSecret(key: string, opts?: SecretFetchOptions): Promise<string> {
       if (!opts?.refresh) {
         const hit = this.cache.get(key);
         if (hit && hit.expiresAt > Date.now()) return hit.value;
       }
       const v = await this.provider.getSecret(key, opts);
       const ttlMs = (opts?.ttlSec ?? this.defaultTtlMs / 1000) * 1000;
       this.cache.set(key, { value: v, expiresAt: Date.now() + ttlMs });
       return v;
     }

     async getSecretOptional(key: string, opts?: SecretFetchOptions): Promise<string | undefined> {
       try { return await this.getSecret(key, opts); } catch { return undefined; }
     }

     async getSecretJson<T>(key: string, opts?: SecretFetchOptions): Promise<T> {
       const raw = await this.getSecret(key, opts);
       return JSON.parse(raw) as T;
     }

     async getSecrets(keys: string[], opts?: SecretFetchOptions): Promise<Record<string, string>> {
       const out: Record<string, string> = {};
       const missing: string[] = [];
       for (const k of keys) {
         if (opts?.refresh) { missing.push(k); continue; }
         const hit = this.cache.get(k);
         if (hit && hit.expiresAt > Date.now()) out[k] = hit.value;
         else missing.push(k);
       }
       if (missing.length === 0) return out;
       const fetched = await this.provider.getSecrets(missing, opts);
       const ttlMs = (opts?.ttlSec ?? this.defaultTtlMs / 1000) * 1000;
       for (const [k, v] of Object.entries(fetched)) {
         this.cache.set(k, { value: v, expiresAt: Date.now() + ttlMs });
         out[k] = v;
       }
       return out;
     }

     invalidate(key: string): void { this.cache.delete(key); }
     invalidateAll(): void { this.cache.clear(); }

     health(): Promise<SecretsHealth> { return this.provider.health(); }
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- SecretsService
   # Expected: 4 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/SecretsService.ts \
           packages/applications/src/services/baseServices/_meta/secrets/__tests__/SecretsService.test.ts
   git commit -m "feat(secrets): SecretsService with LRU cache + TTL + invalidation"
   ```

---

### Task 2.16: Redis Pub/Sub invalidation subscriber

**Agent**: `tester`

**Files**:
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/SecretsService.ts`
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/__tests__/SecretsService.test.ts`

**Steps**:

1. Write failing test (append to file):

   ```typescript
   import { EventEmitter } from 'node:events';

   describe('SecretsService Pub/Sub invalidation', () => {
     it('subscribes to arca:secrets:invalidate and clears keys on message', async () => {
       const provider = new InMemorySecretsProvider({ K: 'v' });
       const sub = new EventEmitter() as unknown as { subscribe: (ch: string, cb: (err: Error|null, c: number) => void) => void; on: typeof EventEmitter.prototype.on };
       sub.subscribe = (_ch, cb) => cb(null, 1);
       const service = new SecretsService(provider, { defaultTtlSec: 300 });
       service.attachRedisSubscriber(sub as never);
       await service.getSecret('K');
       (sub as unknown as EventEmitter).emit('message', 'arca:secrets:invalidate', JSON.stringify({ key: 'K' }));
       const spy = vi.spyOn(provider, 'getSecret');
       await service.getSecret('K');
       expect(spy).toHaveBeenCalledTimes(1);
     });
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- SecretsService
   # Expected: 1 failure (no attachRedisSubscriber)
   ```

3. Implement: add to `SecretsService`:

   ```typescript
   import type { Redis } from 'ioredis';

   // …in class…
   attachRedisSubscriber(sub: Redis): void {
     sub.subscribe('arca:secrets:invalidate', (err) => {
       if (err) this.logger.error({ message: 'subscribe failed', err: err.message });
     });
     sub.on('message', (channel: string, raw: string) => {
       if (channel !== 'arca:secrets:invalidate') return;
       try {
         const msg = JSON.parse(raw) as { key?: string; all?: boolean };
         if (msg.all) this.invalidateAll();
         else if (msg.key) this.invalidate(msg.key);
       } catch (e) {
         this.logger.warn({ message: 'bad invalidation payload', raw });
       }
     });
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- SecretsService
   # Expected: 5 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/SecretsService.ts \
           packages/applications/src/services/baseServices/_meta/secrets/__tests__/SecretsService.test.ts
   git commit -m "feat(secrets): wire Redis Pub/Sub invalidation in SecretsService"
   ```

---

### Task 2.17: `SecretsModule.forRootAsync()` factory selects provider per `SECRETS_PROVIDER`

**Agent**: `pipeline-architect`

**Files**:
- Create: `packages/applications/src/services/baseServices/_meta/secrets/secrets.module.ts`
- Create: `packages/applications/src/services/baseServices/_meta/secrets/__tests__/secrets.module.test.ts`

**Steps**:

1. Write failing test:

   ```typescript
   import { Test } from '@nestjs/testing';
   import { describe, it, expect, beforeEach, afterEach } from 'vitest';
   import { SecretsModule } from '../secrets.module';
   import { SecretsService } from '../SecretsService';
   import { EnvSecretsProvider } from '../providers/env-secrets.provider';
   import { VaultSecretsProvider } from '../providers/vault-secrets.provider';

   describe('SecretsModule', () => {
     const env = process.env;
     beforeEach(() => { process.env = { ...env }; });
     afterEach(() => { process.env = env; });

     it('selects EnvSecretsProvider when SECRETS_PROVIDER=env', async () => {
       process.env.SECRETS_PROVIDER = 'env';
       const mod = await Test.createTestingModule({ imports: [SecretsModule.forRoot()] }).compile();
       const provider = mod.get('ISecretsProviderInstance');
       expect(provider).toBeInstanceOf(EnvSecretsProvider);
     });

     it('selects VaultSecretsProvider when SECRETS_PROVIDER=vault and required env present', async () => {
       process.env.SECRETS_PROVIDER = 'vault';
       process.env.VAULT_ADDR = 'http://vault:8200';
       process.env.VAULT_ROLE_ID = 'rid';
       process.env.VAULT_SECRET_ID = 'sid';
       const mod = await Test.createTestingModule({ imports: [SecretsModule.forRoot()] }).compile();
       const provider = mod.get('ISecretsProviderInstance');
       expect(provider).toBeInstanceOf(VaultSecretsProvider);
     });

     it('exposes SecretsService', async () => {
       process.env.SECRETS_PROVIDER = 'env';
       const mod = await Test.createTestingModule({ imports: [SecretsModule.forRoot()] }).compile();
       expect(mod.get(SecretsService)).toBeInstanceOf(SecretsService);
     });
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- secrets.module
   # Expected: module not found
   ```

3. Implement:

   ```typescript
   // packages/applications/src/services/baseServices/_meta/secrets/secrets.module.ts
   import { DynamicModule, Global, Module, NotImplementedException } from '@nestjs/common';
   import { SecretsService } from './SecretsService';
   import {
     ISecretsProvider,
     SECRETS_PROVIDER_TOKEN,
     SecretsProviderName,
   } from './ISecretsProvider';
   import { EnvSecretsProvider } from './providers/env-secrets.provider';
   import { VaultSecretsProvider } from './providers/vault-secrets.provider';
   import { AwsSecretsManagerProvider } from './providers/aws-secrets-manager.provider';
   import { AzureKeyVaultProvider } from './providers/azure-keyvault.provider';
   import { InMemorySecretsProvider } from './providers/in-memory-secrets.provider';

   export interface SecretsModuleOptions {
     /** Override the env-derived provider; useful in tests. */
     providerOverride?: ISecretsProvider;
     defaultTtlSec?: number;
     lruMax?: number;
   }

   const PROVIDER_INSTANCE = 'ISecretsProviderInstance';

   function pickProviderName(): SecretsProviderName {
     const v = (process.env.SECRETS_PROVIDER ?? '').toLowerCase();
     if (v === 'vault' || v === 'aws' || v === 'azure' || v === 'in-memory') return v;
     return 'env';
   }

   function createProvider(name: SecretsProviderName): ISecretsProvider {
     switch (name) {
       case 'vault':
         return new VaultSecretsProvider({
           addr: required('VAULT_ADDR'),
           roleId: required('VAULT_ROLE_ID'),
           wrappedSecretId: process.env.VAULT_WRAPPED_SECRET_ID,
           secretId: process.env.VAULT_SECRET_ID,
           namespace: process.env.VAULT_NAMESPACE,
           kvMount: process.env.VAULT_KV_MOUNT ?? 'secret',
           kvPrefix: process.env.VAULT_KV_PREFIX ?? 'hope',
           transitMount: process.env.VAULT_TRANSIT_MOUNT ?? 'transit',
           transitKey: process.env.VAULT_TRANSIT_KEY ?? 'hope-globalsetting',
           requestTimeoutMs: Number(process.env.VAULT_REQUEST_TIMEOUT_MS ?? 5000),
         });
       case 'aws':
         return new AwsSecretsManagerProvider();
       case 'azure':
         return new AzureKeyVaultProvider();
       case 'in-memory':
         return new InMemorySecretsProvider();
       default:
         return new EnvSecretsProvider();
     }
   }

   function required(envKey: string): string {
     const v = process.env[envKey];
     if (!v) throw new Error(`SecretsModule: ${envKey} is required when SECRETS_PROVIDER=vault`);
     return v;
   }

   @Global()
   @Module({})
   export class SecretsModule {
     static forRoot(options: SecretsModuleOptions = {}): DynamicModule {
       return {
         module: SecretsModule,
         providers: [
           {
             provide: PROVIDER_INSTANCE,
             useFactory: () => options.providerOverride ?? createProvider(pickProviderName()),
           },
           {
             provide: SECRETS_PROVIDER_TOKEN,
             useExisting: PROVIDER_INSTANCE,
           },
           {
             provide: SecretsService,
             useFactory: (p: ISecretsProvider) => new SecretsService(p, options),
             inject: [SECRETS_PROVIDER_TOKEN],
           },
         ],
         exports: [SECRETS_PROVIDER_TOKEN, SecretsService, PROVIDER_INSTANCE],
       };
     }
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- secrets.module
   # Expected: 3 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/secrets.module.ts \
           packages/applications/src/services/baseServices/_meta/secrets/__tests__/secrets.module.test.ts
   git commit -m "feat(secrets): SecretsModule.forRoot() factory selects provider per SECRETS_PROVIDER"
   ```

---

### Task 2.18: Boot-time `SecretsService.boot()` wires Vault login + warmup

**Agent**: `security-auditor`

**Files**:
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/SecretsService.ts`
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/__tests__/SecretsService.test.ts`

**Steps**:

1. Write failing test:

   ```typescript
   describe('SecretsService.boot()', () => {
     it('calls provider.boot() if present and warmups configured keys', async () => {
       const provider = new InMemorySecretsProvider({ JWT_SECRET_KEY: 'v' });
       const bootSpy = vi.spyOn(provider as unknown as { boot?: () => Promise<void> }, 'boot' as never).mockImplementation(undefined as never);
       const service = new SecretsService(provider, { defaultTtlSec: 300 });
       await service.boot({ warmupKeys: ['JWT_SECRET_KEY'] });
       const fetchSpy = vi.spyOn(provider, 'getSecret');
       await service.getSecret('JWT_SECRET_KEY');
       expect(fetchSpy).toHaveBeenCalledTimes(0);
     });
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- SecretsService
   # Expected: failing test ("service.boot is not a function")
   ```

3. Implement: add to `SecretsService`:

   ```typescript
   async boot(opts: { warmupKeys?: string[] } = {}): Promise<void> {
     const maybeBoot = (this.provider as unknown as { boot?: () => Promise<void> }).boot;
     if (typeof maybeBoot === 'function') {
       await maybeBoot.call(this.provider);
     }
     if (opts.warmupKeys && opts.warmupKeys.length > 0) {
       await this.getSecrets(opts.warmupKeys);
     }
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- SecretsService
   # Expected: 6 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/SecretsService.ts \
           packages/applications/src/services/baseServices/_meta/secrets/__tests__/SecretsService.test.ts
   git commit -m "feat(secrets): SecretsService.boot() warmup + provider boot delegation"
   ```

---

### Task 2.19: Health indicator for `@nestjs/terminus` `/readiness`

**Agent**: `pipeline-architect`

**Files**:
- Create: `packages/applications/src/services/baseServices/_meta/secrets/secrets.health.ts`
- Create: `packages/applications/src/services/baseServices/_meta/secrets/__tests__/secrets.health.test.ts`

**Steps**:

1. Write failing test:

   ```typescript
   import { describe, it, expect, vi } from 'vitest';
   import { SecretsHealthIndicator } from '../secrets.health';
   import { SecretsService } from '../SecretsService';

   describe('SecretsHealthIndicator', () => {
     it('returns up when provider.health.ok=true', async () => {
       const svc = { health: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5, provider: 'vault' }) } as unknown as SecretsService;
       const ind = new SecretsHealthIndicator(svc);
       const res = await ind.isHealthy('secrets');
       expect(res).toEqual({ secrets: { status: 'up', provider: 'vault', latencyMs: 5 } });
     });

     it('throws when ok=false', async () => {
       const svc = { health: vi.fn().mockResolvedValue({ ok: false, latencyMs: 9, provider: 'vault', detail: 'sealed' }) } as unknown as SecretsService;
       const ind = new SecretsHealthIndicator(svc);
       await expect(ind.isHealthy('secrets')).rejects.toThrow(/sealed/);
     });
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- secrets.health
   # Expected: module not found
   ```

3. Implement:

   ```typescript
   // packages/applications/src/services/baseServices/_meta/secrets/secrets.health.ts
   import { Injectable } from '@nestjs/common';
   import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
   import { SecretsService } from './SecretsService';

   @Injectable()
   export class SecretsHealthIndicator extends HealthIndicator {
     constructor(private readonly secrets: SecretsService) { super(); }

     async isHealthy(key: string): Promise<HealthIndicatorResult> {
       const h = await this.secrets.health();
       const detail = { provider: h.provider, latencyMs: h.latencyMs, ...(h.detail ? { detail: h.detail } : {}) };
       const out = this.getStatus(key, h.ok, detail);
       if (!h.ok) throw new HealthCheckError(`Secrets provider unhealthy: ${h.detail ?? h.provider}`, out);
       return out;
     }
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- secrets.health
   # Expected: 2 passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/secrets.health.ts \
           packages/applications/src/services/baseServices/_meta/secrets/__tests__/secrets.health.test.ts
   git commit -m "feat(secrets): SecretsHealthIndicator for terminus /readiness"
   ```

---

### Task 2.20: Register `SecretsModule` in `CommonServiceModule` + health indicator

**Agent**: `pipeline-architect`

**Files**:
- Modify: `packages/applications/src/services/baseServices/common.service.module.ts`

**Steps**:

1. Write failing test (grep-based, then a full module test):

   ```bash
   grep -q 'SecretsModule' packages/applications/src/services/baseServices/common.service.module.ts
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails:

   ```bash
   grep -q 'SecretsModule' packages/applications/src/services/baseServices/common.service.module.ts
   echo "rc=$?"
   # Expected: rc=1
   ```

3. Implement: add `SecretsModule.forRoot()` to the imports + exports of `CommonServiceModule`:

   ```typescript
   import { SecretsModule } from './_meta';
   // …
   @Module({
     imports: [
       ConfigModule,
       CoreDatabaseModule,
       SecretsModule.forRoot({ defaultTtlSec: Number(process.env.SECRETS_TTL_SEC ?? 300) }),
       AppSettingsModule.forRoot(),
       // …rest unchanged
     ],
     exports: [ConfigModule, CoreDatabaseModule, SecretsModule, AppSettingsModule, /* …rest */],
   })
   export class CommonServiceModule {}
   ```

   Then register `SecretsHealthIndicator` in `HealthCheckController` (file path discovered via grep):

   ```bash
   grep -rn 'TerminusModule\|HealthCheckService' packages/applications/src/services/baseServices/health/ | head
   ```

   In the discovered controller's `@HealthCheck()` method, add `() => this.secretsIndicator.isHealthy('secrets')`.

4. Verify passes:

   ```bash
   grep -q 'SecretsModule' packages/applications/src/services/baseServices/common.service.module.ts
   echo "rc=$?"
   # Expected: rc=0
   pnpm --filter @arcaai/applications build
   # Expected: build green
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/common.service.module.ts \
           packages/applications/src/services/baseServices/health/
   git commit -m "feat(secrets): wire SecretsModule + SecretsHealthIndicator into CommonServiceModule"
   ```

---

### Code Review Gate 2C — `code-reviewer`

**Checks**:

- [ ] `SecretsModule` is `@Global()` — all consumers can inject `SecretsService` without re-importing
- [ ] `SecretsService.boot()` is called from `apps/api/src/main.ts` before `app.listen()` (Phase 3 Task 3.1 sets this up; flag if missing)
- [ ] Cache eviction on `arca:secrets:invalidate` works end-to-end (unit-test pass counts toward this)
- [ ] `/readiness` returns 503 when Vault is sealed/unreachable
- [ ] Provider factory rejects unknown `SECRETS_PROVIDER` values (default to `env`, log a warning — verify in code)
- [ ] No secret value appears in any log output (Logger never receives `value`)

**Action if pass**: PR `feat/task-302-vault/p2c-secrets-module` → `dev`; merge. Phase 2 complete.

---

# Phase 3 — Migrate Every Secret Read Site

**Phase Goal**: Replace every `process.env.<SECRET>` and every `appSettingsService.getValueWithDefault('<SECRET_KEY>', '<dev-default>')` call with `secretsService.getSecret('<SECRET>')`. Behavior is preserved because `SECRETS_PROVIDER=env` (the dev default from D3) reads `process.env` exactly as today.

**Entry Criteria**: Phase 2 merged. `SecretsModule` available via `CommonServiceModule`.

**Exit Criteria**:
- `git grep -nE "process\\.env\\.(JWT_SECRET_KEY|SESSION_SECRET_KEY|API_KEY_PEPPER|OIDC_CLIENT_SECRET|S3_ACCESS_KEY|S3_SECRET_KEY|SMR_SERVICE_TOKEN|MQTT_PASS|REDIS_PASS|MINIO_ACCESS_KEY|MINIO_SECRET_KEY)" packages/ apps/` returns **zero hits** (excluding `.env*` files and `config.service.ts` env load).
- `git grep -n "appSettingsService.getValueWithDefault('JWT_SECRET_KEY'" packages/ apps/` returns **zero hits**.
- Existing tests pass without modification (because env provider is the default in dev/test).
- `apps/api/src/main.ts` calls `SecretsService.boot({ warmupKeys: [...] })` before `app.listen()`.

**Branching**: one PR per cluster (auth strategies, S3, main.ts, summary service, config service). One code-review gate after **every 4 tasks**.

---

### Task 3.1: Call `SecretsService.boot()` in `apps/api/src/main.ts` before `app.listen()`

**Agent**: `pipeline-architect`

**Files**:
- Modify: `apps/api/src/main.ts`

**Steps**:

1. Write failing test (manual smoke):

   ```bash
   grep -n 'secretsService.boot' apps/api/src/main.ts
   echo "rc=$?"
   # Expected: rc=1 (not present)
   ```

2. Verify fails:

   ```bash
   grep -n 'secretsService.boot' apps/api/src/main.ts
   echo "rc=$?"
   # Expected: rc=1
   ```

3. Implement: in `bootstrap()` after `app.useGlobalPipes(...)` and BEFORE `app.listen(...)`, fetch the SecretsService and boot it:

   ```typescript
   // apps/api/src/main.ts — inside bootstrap() before app.listen()
   import { SecretsService } from '@arcaai/applications';

   const secretsService = app.get(SecretsService);
   await secretsService.boot({
     warmupKeys: [
       'JWT_SECRET_KEY',
       'SESSION_SECRET_KEY',
       'API_KEY_PEPPER',
       'OIDC_CLIENT_SECRET',
       'MINIO_ACCESS_KEY',
       'MINIO_SECRET_KEY',
       'S3_ACCESS_KEY',
       'S3_SECRET_KEY',
       'SMR_SERVICE_TOKEN',
       'MQTT_PASS',
       'REDIS_PASS',
     ],
   });
   loggingService.info('Secrets warmed up', { count: 11 });
   ```

   Also import `SecretsService` from `@arcaai/applications` at top.

4. Verify passes:

   ```bash
   grep -n 'secretsService.boot' apps/api/src/main.ts
   echo "rc=$?"
   # Expected: rc=0
   pnpm build:api
   # Expected: build green
   ```

5. Commit:

   ```bash
   git add apps/api/src/main.ts
   git commit -m "feat(api): boot SecretsService before app.listen() with warmup keys"
   ```

---

### Task 3.2: Migrate `apps/api/src/main.ts:210` `SESSION_SECRET_KEY`

**Agent**: `tester`

**Files**:
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/__tests__/main.bootstrap.test.ts` (create or extend if absent)

**Steps**:

1. Write failing test:

   ```typescript
   // apps/api/src/__tests__/session-secret.test.ts
   import { describe, it, expect } from 'vitest';
   import { readFileSync } from 'node:fs';
   describe('main.ts session secret', () => {
     it('no longer reads process.env.SESSION_SECRET_KEY directly', () => {
       const src = readFileSync('apps/api/src/main.ts', 'utf8');
       expect(src).not.toMatch(/process\.env\.SESSION_SECRET_KEY/);
       expect(src).toMatch(/secretsService\.getSecret\(['"]SESSION_SECRET_KEY['"]\)/);
     });
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/api test:unit -- session-secret
   # Expected: 1 failing (process.env.SESSION_SECRET_KEY still present at main.ts:210)
   ```

3. Implement: replace the session config:

   ```typescript
   // apps/api/src/main.ts — replace lines 208-219
   const sessionSecret = await secretsService.getSecret('SESSION_SECRET_KEY');
   app.use(
     session({
       secret: sessionSecret,
       resave: false,
       saveUninitialized: false,
       cookie: {
         secure: isProduction,
         httpOnly: !isProduction,
         maxAge: 24 * 60 * 60 * 1000,
       },
     }),
   );
   ```

   > **Ordering**: this requires `secretsService.boot()` (Task 3.1) to have completed. The boot call must come BEFORE this line. Verify the sequence in the diff.

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/api test:unit -- session-secret
   # Expected: 1 passing
   pnpm dev:api &
   sleep 5
   curl -sf http://localhost:8868/api/v1/health
   # Expected: 200 OK
   ```

5. Commit:

   ```bash
   git add apps/api/src/main.ts apps/api/src/__tests__/session-secret.test.ts
   git commit -m "feat(api): replace process.env.SESSION_SECRET_KEY with SecretsService"
   ```

---

### Task 3.3: Migrate `packages/applications/src/services/apiKey/apikey.service.ts:98` `API_KEY_PEPPER`

**Agent**: `tester`

**Files**:
- Modify: `packages/applications/src/services/apiKey/apikey.service.ts`
- Modify: `packages/applications/src/services/apiKey/apikey.service.module.ts` (if needed for DI)
- Modify: tests under `packages/applications/src/services/apiKey/__tests__/`

> `hashKey` is currently a static method. Static methods cannot use DI; convert it to an instance method OR inject the pepper as a constructor field via a static factory. Choose the **instance method** path since the only call site (`apikey.service.ts` itself) already has access to `this`.

**Steps**:

1. Write failing test:

   ```typescript
   // packages/applications/src/services/apiKey/__tests__/apikey-pepper.test.ts
   import { describe, it, expect } from 'vitest';
   import { readFileSync } from 'node:fs';
   it('does not read process.env.API_KEY_PEPPER directly', () => {
     const src = readFileSync('packages/applications/src/services/apiKey/apikey.service.ts', 'utf8');
     expect(src).not.toMatch(/process\.env\.API_KEY_PEPPER/);
     expect(src).toMatch(/secretsService\.getSecret\(['"]API_KEY_PEPPER['"]\)/);
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- apikey-pepper
   # Expected: 1 failing
   ```

3. Implement:

   ```typescript
   // packages/applications/src/services/apiKey/apikey.service.ts
   // 1. Inject SecretsService in the constructor (add to existing inject list)
   //    constructor(..., private readonly secretsService: SecretsService) { super(); }
   // 2. Convert hashKey to an instance method (or keep static + accept pepper as arg)

   async hashKey(rawKey: string): Promise<string> {
     const pepper = await this.secretsService.getSecretOptional('API_KEY_PEPPER');
     if (pepper) {
       return createHmac('sha256', pepper).update(rawKey).digest('hex');
     }
     return createHash('sha256').update(rawKey).digest('hex');
   }
   ```

   Update every call site of `ApikeyService.hashKey(...)` (grep first):

   ```bash
   git grep -n 'ApikeyService.hashKey\|hashKey(' packages/applications/src/services/apiKey/ apps/api/src/
   ```

   Adjust callers to `await this.apikeyService.hashKey(raw)` (now async).

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- apikey
   # Expected: all existing + new tests passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/apiKey/
   git commit -m "feat(apikey): inject SecretsService for API_KEY_PEPPER (instance method)"
   ```

---

### Task 3.4: Migrate `packages/applications/src/services/consultation/summary/summary.service.ts:452` `SMR_SERVICE_TOKEN`

**Agent**: `tester`

**Files**:
- Modify: `packages/applications/src/services/consultation/summary/summary.service.ts`
- Modify: `packages/applications/src/services/consultation/summary/__tests__/summary.service.test.ts`

**Steps**:

1. Write failing test:

   ```typescript
   import { readFileSync } from 'node:fs';
   it('does not read process.env.SMR_SERVICE_TOKEN directly', () => {
     const src = readFileSync('packages/applications/src/services/consultation/summary/summary.service.ts', 'utf8');
     expect(src).not.toMatch(/process\.env\.SMR_SERVICE_TOKEN/);
     expect(src).toMatch(/secretsService\.getSecret\(['"]SMR_SERVICE_TOKEN['"]\)/);
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- summary.service
   # Expected: 1 failing
   ```

3. Implement: replace the inline `process.env.SMR_SERVICE_TOKEN`:

   ```typescript
   // In SummaryService constructor: add `private readonly secretsService: SecretsService`
   // Replace line 452 region:
   const smrToken = await this.secretsService.getSecret('SMR_SERVICE_TOKEN');
   const response = await this.httpService.axiosRef.post(`${this.smrServiceUrl}/api/v1/generate`, smrPayload, {
     headers: {
       'Content-Type': 'application/json',
       'X-Service-Token': smrToken,
     },
   });
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- summary.service
   # Expected: all passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/consultation/summary/
   git commit -m "feat(summary): use SecretsService for SMR_SERVICE_TOKEN bearer"
   ```

---

### Code Review Gate 3A — `code-reviewer` (after Task 3.4)

**Checks**:

- [ ] `git grep -nE "process\\.env\\.(SESSION_SECRET_KEY|API_KEY_PEPPER|SMR_SERVICE_TOKEN)" apps/ packages/ | grep -v __tests__ | grep -v .env` returns nothing
- [ ] All four PRs (3.1–3.4) ordered correctly; `boot()` before `getSecret()` consumers
- [ ] No async/await regressions in `hashKey` callers
- [ ] Build green, tests green

**Action if pass**: PR `feat/task-302-vault/p3-cluster-1-app-init` → `dev`; merge.

---

### Task 3.5: Migrate `packages/applications/src/services/auth/gateway-auth.strategy.ts:23` `JWT_SECRET_KEY`

**Agent**: `tester`

**Files**:
- Modify: `packages/applications/src/services/auth/gateway-auth.strategy.ts`
- Modify: tests in `packages/applications/src/services/auth/__tests__/`

> **Note**: this site currently reads from `appSettingsService.getValueWithDefault('JWT_SECRET_KEY', '…')`. The migration switches to `secretsService.getSecret('JWT_SECRET_KEY')`. Passport strategies receive the secret in the constructor — `secretsService.getSecret` is async, so use a NestJS factory pattern: register the strategy as a provider with `useFactory` that awaits the secret.

**Steps**:

1. Write failing test:

   ```typescript
   import { readFileSync } from 'node:fs';
   it('uses SecretsService not AppSettingsService for JWT_SECRET_KEY', () => {
     const src = readFileSync('packages/applications/src/services/auth/gateway-auth.strategy.ts', 'utf8');
     expect(src).not.toMatch(/appSettingsService\.getValueWithDefault\(['"]JWT_SECRET_KEY['"]/);
     expect(src).toMatch(/secretsService\.getSecret\(['"]JWT_SECRET_KEY['"]\)/);
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- gateway-auth
   # Expected: 1 failing
   ```

3. Implement: convert from `AppSettingsService` to `SecretsService` in the constructor:

   ```typescript
   // packages/applications/src/services/auth/gateway-auth.strategy.ts
   import { SecretsService } from '../baseServices/_meta/secrets/SecretsService';

   @Injectable()
   export class GatewayAuthStrategy extends PassportStrategy(Strategy, 'gateway-jwt') {
     constructor(
       @Inject(SecretsService) private readonly secretsService: SecretsService,
       @Inject(IAuthService) private readonly authService: IAuthService,
     ) {
       // SecretsService.boot() has been called by main.ts (Task 3.1); cache is warm.
       // Synchronously read from cache (constructor-safe because warmup completed).
       const jwtSecret = (secretsService as unknown as { getSecretSync?: (k: string) => string }).getSecretSync?.('JWT_SECRET_KEY')
         ?? throwMissing('JWT_SECRET_KEY');
       super({
         jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
         ignoreExpiration: false,
         secretOrKey: jwtSecret,
       });
     }
   }

   function throwMissing(k: string): never { throw new Error(`Strategy constructor: ${k} not warmed`); }
   ```

   Add `getSecretSync(key: string): string | undefined` to `SecretsService` (returns cached value or undefined; does NOT fetch):

   ```typescript
   // SecretsService addition
   getSecretSync(key: string): string | undefined {
     const hit = this.cache.get(key);
     return hit && hit.expiresAt > Date.now() ? hit.value : undefined;
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- gateway-auth
   # Expected: passing
   ```

5. Commit:

   ```bash
   git add packages/applications/src/services/auth/gateway-auth.strategy.ts \
           packages/applications/src/services/baseServices/_meta/secrets/SecretsService.ts \
           packages/applications/src/services/baseServices/_meta/secrets/__tests__/SecretsService.test.ts
   git commit -m "feat(auth): GatewayAuthStrategy reads JWT_SECRET_KEY from SecretsService"
   ```

---

### Task 3.6: Migrate `packages/applications/src/services/auth/jwt.strategy.ts:20` `JWT_SECRET_KEY`

**Agent**: `tester`

**Files**:
- Modify: `packages/applications/src/services/auth/jwt.strategy.ts`

Mirror Task 3.5. Same pattern: replace `appSettingsService.getValueWithDefault('JWT_SECRET_KEY', …)` with `secretsService.getSecretSync('JWT_SECRET_KEY')`. Update the existing test under `packages/applications/src/services/auth/__tests__/jwt.strategy.test.ts` to inject `SecretsService` mock.

**Steps**:

1. Write failing test (the grep test as in 3.5).
2. Verify fails.
3. Implement (same constructor swap).
4. Verify passes (`pnpm --filter @arcaai/applications test:unit -- jwt.strategy`).
5. Commit: `feat(auth): JwtStrategy reads JWT_SECRET_KEY from SecretsService`.

---

### Task 3.7: Migrate `packages/applications/src/services/auth/oidc.strategy.ts:82-83` `JWT_SECRET_KEY` + non-secret OIDC fields

**Agent**: `tester`

**Files**:
- Modify: `packages/applications/src/services/auth/oidc.strategy.ts`

> **Scope**: only `JWT_SECRET_KEY` (line 82) is a secret. `OIDC_SCOPES`, `OIDC_CALLBACK_URL`, `JWT_EXPIRES_IN` (lines 31-32, 83) are **non-secret config** and stay in `AppSettingsService`. Migrate ONLY the secret.

**Steps**:

1. Write failing test:

   ```typescript
   import { readFileSync } from 'node:fs';
   it('reads JWT_SECRET_KEY from SecretsService but keeps OIDC_SCOPES in AppSettings', () => {
     const src = readFileSync('packages/applications/src/services/auth/oidc.strategy.ts', 'utf8');
     const jwtLine = src.match(/JWT_SECRET_KEY/g) ?? [];
     // every JWT_SECRET_KEY reference must be on a secretsService line
     expect(src).not.toMatch(/appSettingsService\.getValueWithDefault\(['"]JWT_SECRET_KEY['"]/);
     // OIDC_SCOPES stays on appSettings (it's not a secret)
     expect(src).toMatch(/appSettingsService\.getValueWithDefault\(['"]OIDC_SCOPES['"]/);
   });
   ```

2. Verify fails.
3. Implement: line 82 → `const jwtSecretKey = this.secretsService.getSecretSync('JWT_SECRET_KEY') ?? throwMissing('JWT_SECRET_KEY');`. Add `SecretsService` to constructor injection. Leave OIDC_SCOPES/CALLBACK_URL untouched.
4. Verify passes.
5. Commit: `feat(auth): OidcStrategy uses SecretsService for JWT_SECRET_KEY only`.

---

### Task 3.8: Migrate `packages/applications/src/services/auth/auth.service.module.ts:42` `OIDC_CLIENT_SECRET`

**Agent**: `tester`

**Files**:
- Modify: `packages/applications/src/services/auth/auth.service.module.ts`

> **Scope**: only line 42 (`OIDC_CLIENT_SECRET`) is a secret. Lines 38, 41, 43 (`OIDC_DISCOVERY_URL`, `OIDC_CLIENT_ID`, `OIDC_CALLBACK_URL`) stay on `AppSettingsService`.

**Steps**:

1. Write failing test (file-based grep, same shape as 3.7).
2. Verify fails.
3. Implement: in the `useFactory` of the `OPENID_CLIENT` provider, inject `SecretsService` and call `getSecretSync('OIDC_CLIENT_SECRET')`. Add `SecretsService` to the `inject:` array.

   ```typescript
   {
     provide: 'OPENID_CLIENT',
     useFactory: async (appSettingsService: IAppSettingsService, secretsService: SecretsService) => {
       try {
         const oidc_discovery_url = appSettingsService.getValueWithDefault('OIDC_DISCOVERY_URL', 'https://example.com/.well-known/openid_configuration');
         const oidc_client_id = appSettingsService.getValueWithDefault('OIDC_CLIENT_ID', 'default-client-id');
         const oidc_client_secret = secretsService.getSecretSync('OIDC_CLIENT_SECRET') ?? '';
         const oidc_callback_url = appSettingsService.getValueWithDefault('OIDC_CALLBACK_URL', 'http://localhost:8001/auth/callback');
         // …
       }
     },
     inject: [IAppSettingsService, SecretsService],
   }
   ```

4. Verify passes.
5. Commit: `feat(auth): OPENID_CLIENT factory uses SecretsService for OIDC_CLIENT_SECRET`.

---

### Code Review Gate 3B — `code-reviewer` (after Task 3.8)

**Checks**:

- [ ] `git grep -n "appSettingsService.getValueWithDefault('JWT_SECRET_KEY'" packages/` → no hits
- [ ] `git grep -n "appSettingsService.getValueWithDefault('OIDC_CLIENT_SECRET'" packages/` → no hits
- [ ] OIDC non-secret fields (scopes, callback URL, discovery URL) **still** on AppSettings (confirms surgical scope)
- [ ] Auth strategies' tests pass

**Action if pass**: PR `feat/task-302-vault/p3-cluster-2-auth` → `dev`; merge.

---

### Task 3.9: Migrate `packages/applications/src/services/baseServices/storage/s3/s3.service.ts:231-232` `S3_ACCESS_KEY` + `S3_SECRET_KEY`

**Agent**: `tester`

**Files**:
- Modify: `packages/applications/src/services/baseServices/storage/s3/s3.service.ts`

> **Scope**: only lines 231 (`S3_ACCESS_KEY`) and 232 (`S3_SECRET_KEY`) are secrets. Lines 225 (`S3_ENDPOINT`), 230 (`S3_REGION`), 233 (`S3_PUBLIC_BUCKET`) are non-secret and remain on `AppSettingsService`.

**Steps**:

1. Write failing test:

   ```typescript
   import { readFileSync } from 'node:fs';
   it('reads S3 keys from SecretsService but bucket from AppSettings', () => {
     const src = readFileSync('packages/applications/src/services/baseServices/storage/s3/s3.service.ts', 'utf8');
     expect(src).not.toMatch(/appSettingsService\.getValueWithDefault\(['"]S3_ACCESS_KEY['"]/);
     expect(src).not.toMatch(/appSettingsService\.getValueWithDefault\(['"]S3_SECRET_KEY['"]/);
     expect(src).toMatch(/secretsService\.getSecret\(['"]S3_ACCESS_KEY['"]\)/);
     expect(src).toMatch(/secretsService\.getSecret\(['"]S3_SECRET_KEY['"]\)/);
     // bucket stays on appSettings
     expect(src).toMatch(/appSettingsService\.getValueWithDefault\(['"]S3_PUBLIC_BUCKET['"]/);
   });
   ```

2. Verify fails.
3. Implement: this is a config-builder method that returns a `{ endpoint, region, accessKey, secretKey, publicBucket }` shape. Convert to async (`async getS3Config()`), inject `SecretsService`, and `await this.secretsService.getSecret('S3_ACCESS_KEY')`:

   ```typescript
   async getS3Config() {
     const endpoint = this.appSettingsService.getValueWithDefault('S3_ENDPOINT', '');
     const isMinIO = this.isMinIOEndpoint(endpoint);
     return {
       endpoint,
       region: this.appSettingsService.getValueWithDefault('S3_REGION', isMinIO ? 'us-east-1' : 'us-east-1'),
       accessKey: await this.secretsService.getSecret('S3_ACCESS_KEY'),
       secretKey: await this.secretsService.getSecret('S3_SECRET_KEY'),
       publicBucket: this.appSettingsService.getValueWithDefault('S3_PUBLIC_BUCKET', ''),
       // …rest unchanged
     };
   }
   ```

   Update all call sites to `await s3Service.getS3Config()`.

4. Verify passes (run S3 tests).
5. Commit: `feat(s3): use SecretsService for S3 access/secret keys (config builder now async)`.

---

### Task 3.10: Migrate `packages/applications/src/services/baseServices/_meta/config/config.service.ts:156` `MQTT_PASS`

**Agent**: `tester`

**Files**:
- Modify: `packages/applications/src/services/baseServices/_meta/config/config.service.ts`

> **Architectural note**: `ConfigService.loadBaseConfig()` is **synchronous** (runs in constructor). We cannot `await` here. The fix: leave `MQTT_PASS: process.env.MQTT_PASS || ''` in `loadBaseConfig()` as a **fallback empty string**, then have `loadConfig()` (which is async and runs in `onModuleInit`) call `await this.loadVaultSecrets()` to overwrite `MQTT_PASS` from `SecretsService`. **This replaces the stub at line 195.**

**Steps**:

1. Write failing test:

   ```typescript
   import { readFileSync } from 'node:fs';
   it('loadVaultSecrets is no longer a throw stub', () => {
     const src = readFileSync('packages/applications/src/services/baseServices/_meta/config/config.service.ts', 'utf8');
     expect(src).not.toMatch(/throw new Error\(['"]Vault secrets are not supported yet/);
     expect(src).toMatch(/secretsService\.getSecret\(['"]MQTT_PASS['"]\)/);
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- config.service
   # Expected: 1 failing
   ```

3. Implement: replace the `loadVaultSecrets()` body with a real implementation, and have `loadConfig()` call it. Inject `SecretsService`:

   ```typescript
   // packages/applications/src/services/baseServices/_meta/config/config.service.ts
   constructor(
     @Inject('CONFIG_OPTIONS') private options: ConfigModuleOptions,
     @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
   ) {
     // …existing constructor body unchanged…
   }

   public async loadConfig(): Promise<void> {
     try {
       this.loadBaseConfig();
       await this.loadVaultSecrets();
       this.validateConfiguration();
       this.logger.log('Configuration loaded successfully');
     } catch (error) {
       this.logger.error('Failed to load configuration:', error);
       throw error;
     }
   }

   private async loadVaultSecrets(): Promise<void> {
     if (!this.secretsService) {
       this.logger.warn('SecretsService not available; skipping vault secret merge (env-only mode)');
       return;
     }
     const overrides = await this.secretsService.getSecrets(['MQTT_PASS', 'REDIS_PASS']);
     if (overrides.MQTT_PASS) this.config.MQTT_PASS = overrides.MQTT_PASS;
     if (overrides.REDIS_PASS) this.config.REDIS_PASS = overrides.REDIS_PASS;
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/applications test:unit -- config.service
   # Expected: passing
   ```

5. Commit: `feat(config): implement loadVaultSecrets() merging MQTT_PASS + REDIS_PASS from SecretsService`.

---

### Task 3.11: Migrate `packages/applications/src/services/baseServices/_meta/config/config.service.ts:161` `REDIS_PASS`

**Agent**: `tester`

This was completed in Task 3.10's `loadVaultSecrets()` (same patch handles both). The separate task exists to register the verification:

**Files**:
- Verify: `packages/applications/src/services/baseServices/_meta/config/config.service.ts`

**Steps**:

1. Write failing test:

   ```typescript
   import { readFileSync } from 'node:fs';
   it('REDIS_PASS is merged from SecretsService in loadVaultSecrets', () => {
     const src = readFileSync('packages/applications/src/services/baseServices/_meta/config/config.service.ts', 'utf8');
     expect(src).toMatch(/secretsService\.getSecrets\(\['MQTT_PASS', 'REDIS_PASS'\]\)/);
   });
   ```

2. Verify fails (only if Task 3.10 used different shape).
3. Implement (no-op if 3.10 already covered).
4. Verify passes.
5. Commit (if changes): `test(config): pin REDIS_PASS merge path under SecretsService`.

---

### Task 3.12: Coverage check — grep for residual `process.env.<SECRET>` reads

**Agent**: `code-reviewer`

**Files**:
- N/A (verification task; produces a report file)

**Steps**:

1. Write failing check:

   ```bash
   ! git grep -nE "process\\.env\\.(JWT_SECRET_KEY|SESSION_SECRET_KEY|API_KEY_PEPPER|OIDC_CLIENT_SECRET|S3_ACCESS_KEY|S3_SECRET_KEY|SMR_SERVICE_TOKEN|MQTT_PASS|REDIS_PASS|MINIO_ACCESS_KEY|MINIO_SECRET_KEY)" \
       -- packages/ apps/ \
       ':(exclude)**/.env*' \
       ':(exclude)**/__tests__/**' \
       ':(exclude)packages/applications/src/services/baseServices/_meta/config/config.service.ts' \
       ':(exclude)packages/database/src/prisma/db_main/seed/**'
   echo "rc=$?"
   # Expected: rc=0 (no matches)
   ```

2. Verify fails initially if any read site was missed.

3. Implement: fix any remaining hits using the patterns from 3.1–3.11. The seed file (`06-stt.ts:1691-1712`) and `config.service.ts` env load are intentionally excluded — `config.service.ts` keeps `process.env.MQTT_PASS` as the fallback that `loadVaultSecrets()` overwrites; the seed will be handled in Phase 4D.

4. Verify passes:

   ```bash
   ! git grep -nE "process\\.env\\.(JWT_SECRET_KEY|SESSION_SECRET_KEY|API_KEY_PEPPER|OIDC_CLIENT_SECRET|S3_ACCESS_KEY|S3_SECRET_KEY|SMR_SERVICE_TOKEN)" \
       -- packages/ apps/ \
       ':(exclude)**/.env*' \
       ':(exclude)**/__tests__/**' \
       ':(exclude)packages/database/src/prisma/db_main/seed/**'
   echo "rc=$?"
   # Expected: rc=0
   ```

5. Commit (if any fixes): `chore(secrets): finalize Phase 3 coverage — no stray process.env secret reads`.

---

### Code Review Gate 3C — `code-reviewer` + `security-auditor` (Phase 3 close-out)

**Checks**:

- [ ] All 12 task grep tests pass
- [ ] `apps/api/src/main.ts` bootstraps `SecretsService.boot()` before any read
- [ ] No log line ever contains a secret value (grep for `console.log.*JWT_SECRET\|logger.*JWT_SECRET` returns nothing)
- [ ] Existing test suite green (no regressions) — `pnpm test:unit` across all touched packages
- [ ] `apps/api` E2E smoke (run `pnpm test:e2e` if available; manual `curl /api/v1/health` otherwise)
- [ ] One round of `INTEG_VAULT=1` end-to-end: start dev compose with `--profile vault`, set `SECRETS_PROVIDER=vault`, hit `/api/v1/health` → 200; check Vault audit log for the `secret/data/hope/JWT_SECRET_KEY` read entry

**Action if pass**: PR `feat/task-302-vault/p3-cluster-3-config-s3` → `dev`; merge. Phase 3 complete.
**Action if fail**: list specific failures; do not advance.

---

# Phase 4 — Envelope Encryption for DB-Stored Secrets

**Phase Goal**: Move plaintext secret values stored in `GlobalSetting.value` to a Vault-transit-encrypted column `encryptedValue Bytes?` with `keyVersion Int?` for forward compatibility. Decrypt only at trusted call sites; never log or audit decrypted material.

**Entry Criteria**: Phase 3 merged. Phase 1A's `transit` engine available locally (`transit/encrypt/hope-globalsetting`).

**Exit Criteria**:
- `GlobalSetting` schema has `encryptedValue Bytes?` + `keyVersion Int?` columns (additive migration only).
- `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `JWT_SECRET_KEY`, `OIDC_CLIENT_SECRET` (where stored in `GlobalSetting`) carry ciphertext in `encryptedValue`; `value` is the legacy fallback (kept readable for one release, then user-gated DELETE in 4D).
- All consumers of these settings read via `SecretsService` (Phase 3); the `value` column is no longer queried for these keys.
- `AuditLog` never persists plaintext decrypted values.

**Coordination with Stream D (Optimistic Locking)**: Phase 4A ships the additive columns FIRST. Stream D rebases on the new schema before adding its own changes. `database-admin` and `git-manager` confirm at the schema PR.

---

## Section 4A — Schema migration

### Task 4.1: Add `encryptedValue Bytes?` + `keyVersion Int?` to `GlobalSetting` Prisma schema

**Agent**: `database-admin`

**Files**:
- Modify: `packages/database/src/prisma/db_main/globalSetting.prisma`

**Steps**:

1. Write failing test:

   ```bash
   grep -q 'encryptedValue' packages/database/src/prisma/db_main/globalSetting.prisma
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails:

   ```bash
   grep -q 'encryptedValue' packages/database/src/prisma/db_main/globalSetting.prisma
   echo "rc=$?"
   # Expected: rc=1
   ```

3. Implement: in the model block (after the `value` field), add:

   ```prisma
   model GlobalSetting {
       // …existing fields unchanged…
       value          String
       encryptedValue Bytes?
       keyVersion     Int?
       dataType       ValueType @default(String)
       // …rest unchanged…
   }
   ```

4. Verify passes:

   ```bash
   grep -q 'encryptedValue' packages/database/src/prisma/db_main/globalSetting.prisma
   echo "rc=$?"
   # Expected: rc=0
   ```

5. Commit (do NOT generate migration yet; that's Task 4.2):

   ```bash
   git add packages/database/src/prisma/db_main/globalSetting.prisma
   git commit -m "feat(db): add encryptedValue + keyVersion columns to GlobalSetting (schema only)"
   ```

---

### Task 4.2: Generate + review Prisma migration

**Agent**: `database-admin`

**Files**:
- Create: `packages/database/src/prisma/db_main/migrations/<timestamp>_add_globalsetting_encryptedvalue/migration.sql`

**Steps**:

1. Write failing test (no migration exists):

   ```bash
   ls packages/database/src/prisma/db_main/migrations/ | grep -q 'add_globalsetting_encryptedvalue'
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails:

   ```bash
   ls packages/database/src/prisma/db_main/migrations/ | tail -5
   # No matching directory
   ```

3. Implement (in `packages/database`):

   ```bash
   pnpm --filter @arcaai/database prisma:migrate -- --name add_globalsetting_encryptedvalue
   ```

   Inspect the generated SQL (must be **ADD COLUMN only**; no DROP, no constraint changes):

   ```sql
   -- packages/database/src/prisma/db_main/migrations/<ts>_add_globalsetting_encryptedvalue/migration.sql
   -- AlterTable
   ALTER TABLE "core"."GlobalSetting"
     ADD COLUMN "encryptedValue" BYTEA,
     ADD COLUMN "keyVersion" INTEGER;
   ```

   If anything else is in the diff (e.g. unrelated changes from concurrent edits), **abort** and reset.

4. Verify passes:

   ```bash
   ls packages/database/src/prisma/db_main/migrations/ | grep -q 'add_globalsetting_encryptedvalue'
   echo "rc=$?"
   # Expected: rc=0
   pnpm --filter @arcaai/database prisma:generate
   # Expected: client regenerates without error
   ```

5. Commit:

   ```bash
   git add packages/database/src/prisma/db_main/migrations/ packages/database/
   git commit -m "feat(db): migration — add GlobalSetting.encryptedValue + keyVersion (additive)"
   ```

---

### Task 4.3: Update `GlobalSettingEntity` + Mapper + Factory for new fields

**Agent**: `database-admin`

**Files**:
- Modify: `packages/domains/src/entities/generated/core/GlobalSettingEntity.ts`
- Modify: `packages/domains/src/mappers/generated/core/GlobalSettingEntityMapper.ts`
- Modify: `packages/domains/src/factories/generated/core/GlobalSettingFactory.ts`
- Modify: `packages/domains/src/models/generated/core/GlobalSettingModel.ts`

**Steps**:

1. Write failing test:

   ```typescript
   // packages/domains/src/__tests__/globalSetting-encrypted.test.ts
   import { describe, it, expect } from 'vitest';
   import { GlobalSettingEntity } from '../entities/generated/core/GlobalSettingEntity';
   it('GlobalSettingEntity exposes encryptedValue + keyVersion', () => {
     const e = Object.create(GlobalSettingEntity.prototype);
     e.encryptedValue = Buffer.from([1, 2, 3]);
     e.keyVersion = 1;
     expect(e.encryptedValue).toEqual(Buffer.from([1, 2, 3]));
     expect(e.keyVersion).toBe(1);
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/domains test:unit -- globalSetting-encrypted
   # Expected: failure (properties not on entity)
   ```

3. Implement: regenerate from Prisma:

   ```bash
   pnpm --filter @arcaai/domains generate:entities  # or the project's regen script
   ```

   If no auto-regen exists, hand-add to `GlobalSettingEntity.ts`:

   ```typescript
   export class GlobalSettingEntity extends BaseEntity {
     // …existing fields…
     encryptedValue?: Buffer;
     keyVersion?: number;
   }
   ```

   Update the mapper to round-trip `encryptedValue` (Bytes → Buffer) and `keyVersion` (Int → number). Update the factory `CreateGlobalSetting()` to accept `encryptedValue?: Buffer; keyVersion?: number` in props.

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/domains test:unit -- globalSetting-encrypted
   # Expected: passing
   pnpm --filter @arcaai/domains build
   # Expected: build green
   ```

5. Commit:

   ```bash
   git add packages/domains/
   git commit -m "feat(domain): expose encryptedValue + keyVersion on GlobalSettingEntity"
   ```

---

### Code Review Gate 4A — `code-reviewer` + `database-admin`

**Checks**:

- [ ] Migration SQL is additive only (no DROP, no ALTER)
- [ ] Forward compatibility: `keyVersion` is nullable so existing rows aren't broken
- [ ] No backfill of existing rows in this migration (deliberate — done via Phase 4C)
- [ ] Stream D coordinator notified that schema is now bumped; Stream D rebases

**Action if pass**: PR `feat/task-302-vault/p4a-schema-additive` → `dev`; merge.

---

## Section 4B — Vault Transit setup

### Task 4.4: Bootstrap `transit/keys/hope-globalsetting` in dev-init.sh

**Agent**: `security-auditor`

**Files**:
- Modify: `infrastructure/docker/configs/vault/dev-init.sh`

**Steps**:

1. Failing test:

   ```bash
   grep -q 'vault write -f transit/keys/hope-globalsetting' infrastructure/docker/configs/vault/dev-init.sh
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails (above).

3. Implement: append to `dev-init.sh` before the final `echo "[vault-init] OK"`:

   ```bash
   echo "[vault-init] creating transit key 'hope-globalsetting'"
   vault write -f transit/keys/hope-globalsetting 2>/dev/null || true

   # min_decryption_version=1 ensures historical ciphertexts remain decryptable after rotation
   vault write transit/keys/hope-globalsetting/config \
     min_decryption_version=1 \
     deletion_allowed=false \
     exportable=false 2>/dev/null || true
   ```

4. Verify passes:

   ```bash
   grep -q 'vault write -f transit/keys/hope-globalsetting' infrastructure/docker/configs/vault/dev-init.sh
   echo "rc=$?"
   # Expected: rc=0
   docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault up -d --force-recreate vault-init
   docker exec hope-vault vault read transit/keys/hope-globalsetting -format=json | jq '.data.name'
   # Expected: "hope-globalsetting"
   ```

5. Commit:

   ```bash
   git add infrastructure/docker/configs/vault/dev-init.sh
   git commit -m "infra(vault): provision transit/keys/hope-globalsetting + config"
   ```

---

### Task 4.5: Add `SECRETS_PROVIDER=vault` requirement check at boot when encryption used

**Agent**: `security-auditor`

**Files**:
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/SecretsService.ts`

This guards against the dev-mode path where `SECRETS_PROVIDER=env` is active but code paths try to encrypt — we should fail-fast at construction with a clear message rather than midway through a request.

**Steps**:

1. Failing test:

   ```typescript
   it('encrypt throws if provider is not vault', async () => {
     const provider = new InMemorySecretsProvider({});
     const service = new SecretsService(provider, {});
     await expect(service.encrypt(Buffer.from('x'))).rejects.toThrow(/requires vault/i);
   });
   ```

2. Verify fails.

3. Implement: add `encrypt`/`decrypt` proxy on `SecretsService` that delegates to the underlying Vault provider if present:

   ```typescript
   // packages/applications/src/services/baseServices/_meta/secrets/SecretsService.ts
   async encrypt(plaintext: Buffer): Promise<string> {
     const maybe = this.provider as unknown as { encrypt?: (b: Buffer) => Promise<string> };
     if (typeof maybe.encrypt !== 'function') {
       throw new Error('SecretsService.encrypt() requires Vault provider (SECRETS_PROVIDER=vault)');
     }
     return maybe.encrypt(plaintext);
   }

   async decrypt(ciphertext: string): Promise<Buffer> {
     const maybe = this.provider as unknown as { decrypt?: (s: string) => Promise<Buffer> };
     if (typeof maybe.decrypt !== 'function') {
       throw new Error('SecretsService.decrypt() requires Vault provider (SECRETS_PROVIDER=vault)');
     }
     return maybe.decrypt(ciphertext);
   }
   ```

4. Verify passes.

5. Commit:

   ```bash
   git add packages/applications/src/services/baseServices/_meta/secrets/SecretsService.ts \
           packages/applications/src/services/baseServices/_meta/secrets/__tests__/SecretsService.test.ts
   git commit -m "feat(secrets): SecretsService.encrypt/decrypt proxies to Vault provider with guard"
   ```

---

### Code Review Gate 4B — `security-auditor`

**Checks**:

- [ ] `min_decryption_version=1` set (no historical lockout on rotation)
- [ ] `deletion_allowed=false`, `exportable=false` (production posture)
- [ ] No error path leaks plaintext or ciphertext into log lines

---

## Section 4C — Encrypt-on-write / decrypt-on-read for GlobalSetting secrets

### Task 4.6: Add `encryptSecret`/`decryptSecret` helper to GlobalSetting repository

**Agent**: `database-admin`

**Files**:
- Modify: `packages/domains/src/repositories/generated/core/GlobalSettingRepository.ts`
- Create: `packages/domains/src/__tests__/GlobalSettingRepository-encrypted.test.ts`

> **Note**: this helper is non-generated logic on a generated file. If the project regenerates the repository from a template, move the helper to a sibling file (e.g. `GlobalSettingRepository.encryption.ts`) that augments the class via TS declaration merging or a mixin. Confirm regeneration policy with `git-manager` first.

**Steps**:

1. Failing test:

   ```typescript
   describe('GlobalSettingRepository encryption helpers', () => {
     it('encryptValueIntoEntity writes encryptedValue and clears value when locked secret', async () => {
       const secretsSvc = {
         encrypt: vi.fn(async (b: Buffer) => `vault:v1:${b.toString('base64')}`),
       } as unknown as SecretsService;
       const repo = new GlobalSettingRepository({} as never, secretsSvc);
       const entity = { value: 'plain', locked: true } as GlobalSettingEntity;
       await repo.encryptValueIntoEntity(entity);
       expect(entity.encryptedValue).toBeInstanceOf(Buffer);
       expect(entity.keyVersion).toBe(1);
       expect(entity.value).toBe(''); // cleared
     });
   });
   ```

2. Verify fails.

3. Implement: add methods (or extension):

   ```typescript
   // packages/domains/src/repositories/generated/core/GlobalSettingRepository.ts (or extension file)
   async encryptValueIntoEntity(entity: GlobalSettingEntity): Promise<void> {
     if (!entity.value) return;
     const ct = await this.secretsService.encrypt(Buffer.from(entity.value, 'utf8'));
     entity.encryptedValue = Buffer.from(ct, 'utf8');
     entity.keyVersion = parseInt(ct.split(':')[1].slice(1), 10) || 1;
     entity.value = '';
   }

   async decryptValueFromEntity(entity: GlobalSettingEntity): Promise<string> {
     if (entity.encryptedValue) {
       const ct = entity.encryptedValue.toString('utf8');
       const pt = await this.secretsService.decrypt(ct);
       return pt.toString('utf8');
     }
     // legacy fallback: read from .value (one-release transition)
     return entity.value ?? '';
   }
   ```

4. Verify passes.

5. Commit: `feat(domain): GlobalSettingRepository encryption/decryption helpers`.

---

### Task 4.7: Backfill script — encrypt existing locked secret rows in-place

**Agent**: `database-admin`

**Files**:
- Create: `packages/database/scripts/backfill-globalsetting-encryption.ts`

**Steps**:

1. Failing test (file existence):

   ```bash
   test -f packages/database/scripts/backfill-globalsetting-encryption.ts && echo "exists" || echo "missing"
   # Expected: "missing"
   ```

2. Verify fails.

3. Implement:

   ```typescript
   // packages/database/scripts/backfill-globalsetting-encryption.ts
   /**
    * Backfill: read all locked GlobalSetting rows whose `encryptedValue` is null,
    * encrypt their `value` via Vault Transit, write encryptedValue + keyVersion,
    * and leave `value` untouched for one-release rollback safety.
    *
    * Usage:
    *   SECRETS_PROVIDER=vault VAULT_ADDR=... VAULT_ROLE_ID=... VAULT_WRAPPED_SECRET_ID=... \
    *     pnpm --filter @arcaai/database tsx scripts/backfill-globalsetting-encryption.ts \
    *       --keys=JWT_SECRET_KEY,OIDC_CLIENT_SECRET,S3_ACCESS_KEY,S3_SECRET_KEY \
    *       [--dry-run]
    */
   import { getPrismaClient } from '../src';
   import { SecretsService, EnvSecretsProvider, VaultSecretsProvider } from '@arcaai/applications';

   const args = new Map(process.argv.slice(2).map(a => { const [k,v=''] = a.replace(/^--/, '').split('='); return [k, v]; }));
   const keys = (args.get('keys') ?? '').split(',').filter(Boolean);
   const dryRun = args.has('dry-run');

   if (keys.length === 0) { console.error('--keys=A,B,C required'); process.exit(2); }
   if (process.env.SECRETS_PROVIDER !== 'vault') { console.error('SECRETS_PROVIDER=vault required'); process.exit(2); }

   const prisma = getPrismaClient();
   const provider = new VaultSecretsProvider({
     addr: process.env.VAULT_ADDR!,
     roleId: process.env.VAULT_ROLE_ID!,
     wrappedSecretId: process.env.VAULT_WRAPPED_SECRET_ID,
     kvMount: 'secret', kvPrefix: 'hope',
     transitMount: 'transit', transitKey: 'hope-globalsetting',
   });
   const secrets = new SecretsService(provider, {});
   (async () => {
     await secrets.boot();
     const rows = await prisma.globalSetting.findMany({ where: { locked: true, key: { in: keys }, encryptedValue: null } });
     console.log(`Found ${rows.length} rows to encrypt`);
     for (const row of rows) {
       const ct = await secrets.encrypt(Buffer.from(row.value, 'utf8'));
       const buf = Buffer.from(ct, 'utf8');
       const kv = parseInt(ct.split(':')[1].slice(1), 10) || 1;
       console.log(` - ${row.tenantId}/${row.key}: ${row.value.length} bytes plaintext → ${ct.length} bytes ciphertext (key v${kv})`);
       if (!dryRun) {
         await prisma.globalSetting.update({ where: { id: row.id }, data: { encryptedValue: buf, keyVersion: kv } });
       }
     }
     console.log(dryRun ? 'DRY-RUN complete; no writes performed' : 'Backfill complete');
   })().catch(e => { console.error(e); process.exit(1); });
   ```

4. Verify passes:

   ```bash
   test -f packages/database/scripts/backfill-globalsetting-encryption.ts && echo "ok"
   # Expected: ok
   # Local dry-run sanity (Vault must be up via compose --profile vault):
   docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault up -d
   docker exec hope-vault vault write -f transit/keys/hope-globalsetting
   SECRETS_PROVIDER=vault VAULT_ADDR=http://localhost:8200 \
     VAULT_ROLE_ID=$(docker exec hope-vault vault read -field=role_id auth/approle/role/hope-app/role-id) \
     VAULT_WRAPPED_SECRET_ID=$(docker exec hope-vault vault write -wrap-ttl=60s -f -format=json auth/approle/role/hope-app/secret-id | jq -r .wrap_info.token) \
     pnpm --filter @arcaai/database tsx scripts/backfill-globalsetting-encryption.ts \
       --keys=JWT_SECRET_KEY --dry-run
   # Expected: prints "Found N rows", "DRY-RUN complete"
   ```

5. Commit: `feat(db): backfill script for GlobalSetting encryption (idempotent, dry-run safe)`.

---

### Task 4.8: Audit-log scrubbing — never persist decrypted secret values

**Agent**: `security-auditor`

**Files**:
- Modify: `packages/applications/src/services/tenant/tenant.service.ts` (around line 520, the `broadcastSysEvent` payload)
- Tie in `@Secret` decorator from Phase 0 Item 4

**Steps**:

1. Failing test:

   ```typescript
   it('SysEvent for locked GlobalSetting update contains [REDACTED] not the value', async () => {
     // arrange a tenant.service test that invokes updateTenantConfigs with a locked row
     // verify the emitted SysEvent payload's data[].value is '[REDACTED]'
     // (Phase 0 Item 4 must have shipped the @Secret decorator; this test verifies the integration)
   });
   ```

2. Verify fails.

3. Implement: in `tenant.service.ts`, replace `data: updatedConfigs.map((config) => config.toObject())` with:

   ```typescript
   data: updatedConfigs.map((config) => {
     const obj = config.toObject();
     if (config.locked) {
       // The @Secret decorator (Phase 0 Item 4) on GlobalSettingEntity.value already redacts,
       // but defense-in-depth: explicitly strip plaintext + ciphertext here too.
       obj.value = '[REDACTED]';
       obj.encryptedValue = '[REDACTED]';
     }
     obj.defaultValue = config.locked ? '[REDACTED]' : obj.defaultValue;
     return { id: obj.id, key: obj.key, locked: obj.locked, changedFields: Array.from(config.getChangedFieldNames?.() ?? []) };
   }),
   ```

4. Verify passes; manually inspect a freshly-emitted SysEvent in dev (`docker logs` or audit log table).

5. Commit: `fix(audit): scrub plaintext + ciphertext from SysEvent for locked GlobalSetting updates`.

---

### Task 4.9: Update read paths — repository auto-decrypts when callers request the value

**Agent**: `database-admin`

**Files**:
- Modify: `packages/domains/src/repositories/generated/core/GlobalSettingRepository.ts` (or extension file)

> **Scope**: only when callers explicitly request decrypted material (e.g. `repository.findByIdWithDecryptedValue(id)`). Callers continue to read non-secret rows via standard `findById`.

**Steps**:

1. Failing test: add `findByIdWithDecryptedValue` method that returns the decrypted string and never touches `entity.value`. Test verifies decrypt round-trip.

2. Verify fails.

3. Implement:

   ```typescript
   async findByIdWithDecryptedValue(id: string): Promise<{ entity: GlobalSettingEntity; plaintext: string } | undefined> {
     const entity = await this.findById(id);
     if (!entity) return undefined;
     const plaintext = await this.decryptValueFromEntity(entity);
     return { entity, plaintext };
   }
   ```

4. Verify passes.

5. Commit: `feat(domain): findByIdWithDecryptedValue helper for GlobalSettingRepository`.

---

### Code Review Gate 4C — `code-reviewer` + `security-auditor`

**Checks**:

- [ ] No code path returns decrypted value from a generic `findById()` (only the explicit `findByIdWithDecryptedValue`)
- [ ] Audit log scrub verified against real fixture
- [ ] Backfill script is idempotent (re-running with `--dry-run` after a real run reports 0 rows)
- [ ] No regression — non-secret GlobalSetting rows unchanged

---

## Section 4D — Remove plaintext seed rows (user-gated)

### Task 4.10: Document the plaintext seed cleanup proposal + STOP for user approval

**Agent**: `git-manager` (then `database-admin` after approval)

**Files**:
- Create: `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/04-vault-phase-4d-cleanup-proposal.md`

This is **not** a code task. The user has a workspace policy: "When working with any SQL and Database, you are NOT allowed to execute any DELETE or DROP or TRUNCATE statement/query. You must confirm with me and get the approval from me for those dangerous statement/query."

The cleanup involves:
- Removing the `S3_ACCESS_KEY` / `S3_SECRET_KEY` seed entries at `packages/database/src/prisma/db_main/seed/06-stt.ts:1690-1712`
- Optionally `DELETE FROM "core"."GlobalSetting" WHERE locked=true AND key IN ('S3_ACCESS_KEY','S3_SECRET_KEY','JWT_SECRET_KEY','OIDC_CLIENT_SECRET') AND encryptedValue IS NOT NULL` (after Phase 7 cutover sign-off)

**Steps**:

1. Failing test (file existence + STOP marker):

   ```bash
   test -f docs/implementation/TASK-302-System-Config-Implementation-Roadmap/04-vault-phase-4d-cleanup-proposal.md && echo "exists" || echo "missing"
   # Expected: missing
   ```

2. Verify fails.

3. Implement: create the proposal doc with sections:
   - Affected files / SQL
   - Pre-deletion checklist (Phase 7 cutover sign-off, 1-release dual-read soak, snapshot taken)
   - Rollback plan (restore from snapshot)
   - Explicit STOP block: "**This task requires user approval before execution. Do not run the DELETE statement. Ping the user with the affected row count from the latest staging dry-run.**"

4. Verify passes.

5. Commit: `docs(vault): Phase 4D plaintext seed cleanup proposal (user-gated)`.

> **Execution gate**: The actual `git rm` of the seed rows + the SQL DELETE is intentionally **NOT** in this plan as an automatable task. After Phase 7 cutover, the executing agent must STOP here and present the proposal to the user; only then proceed with a new mini-PR.

---

# Phase 5 — Vault PostgreSQL Database Secrets Engine

**Phase Goal**: Issue short-lived PostgreSQL credentials per pod from Vault instead of long-lived static `DATABASE_URL` passwords. Uses Prisma's `@prisma/adapter-pg` `password` callback (research doc §2.1).

**Entry Criteria**:
- Phases 1–4 merged.
- **Stream C — PgBouncer session-mode** reached production OR Phase 5 runs against direct pg in staging only.
- PostgreSQL admin credentials available to Vault's database engine (one-time setup, SRE-controlled).

**Exit Criteria**:
- Vault `database/` engine configured against `db_main`.
- `hope-app-role` issues users with 1h TTL / 24h max-TTL.
- Application reads DB password via Vault per new connection.
- Staging soak: 24h without expired-credential errors.

> **Important**: Phase 5 is the riskiest of the stream. Stage with a long soak before prod cutover.

---

## Section 5A — Vault Database Engine Setup

### Task 5.1: Create dedicated PostgreSQL admin user for Vault management

**Agent**: `database-admin`

**Files**:
- Create: `packages/database/src/prisma/db_main/manual/vault-admin-bootstrap.sql`

> Manual SQL (not a Prisma migration; this is an out-of-band ops step on the DB cluster). Documented as a runbook the SRE runs once per environment.

**Steps**:

1. Failing test: file existence:

   ```bash
   test -f packages/database/src/prisma/db_main/manual/vault-admin-bootstrap.sql && echo "ok" || echo "missing"
   # Expected: missing
   ```

2. Verify fails.

3. Implement:

   ```sql
   -- packages/database/src/prisma/db_main/manual/vault-admin-bootstrap.sql
   -- Run ONCE per environment as the PostgreSQL superuser.
   -- Creates the admin role Vault uses to mint short-lived app roles.

   CREATE ROLE vault_admin LOGIN PASSWORD '<PROVIDED-AT-RUNTIME-OR-VAULT-CONNECT-CALL>';
   ALTER ROLE vault_admin WITH CREATEROLE;
   GRANT CONNECT ON DATABASE hope_main TO vault_admin;
   GRANT USAGE ON SCHEMA core, audit, public TO vault_admin;

   -- Template role that Vault clones for each dynamic user.
   -- Permissions match what the running NestJS app actually needs.
   CREATE ROLE hope_app_template NOLOGIN;
   GRANT CONNECT ON DATABASE hope_main TO hope_app_template;
   GRANT USAGE ON SCHEMA core, audit TO hope_app_template;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, audit TO hope_app_template;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, audit TO hope_app_template;
   ALTER DEFAULT PRIVILEGES IN SCHEMA core, audit GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hope_app_template;
   ALTER DEFAULT PRIVILEGES IN SCHEMA core, audit GRANT USAGE, SELECT ON SEQUENCES TO hope_app_template;
   ```

4. Verify passes (file exists; SQL applied manually by SRE during environment bootstrap).

5. Commit: `feat(db): manual SQL for Vault admin + template role bootstrap`.

---

### Task 5.2: Configure Vault `database/config/hope-main` (dev container)

**Agent**: `database-admin`

**Files**:
- Modify: `infrastructure/docker/configs/vault/dev-init.sh`

**Steps**:

1. Failing test:

   ```bash
   grep -q 'vault write database/config/hope-main' infrastructure/docker/configs/vault/dev-init.sh
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails.

3. Implement: append:

   ```bash
   echo "[vault-init] configuring database/config/hope-main"
   # NOTE: for local dev, point at the host postgres on docker.host.internal:5432
   vault write database/config/hope-main \
     plugin_name=postgresql-database-plugin \
     allowed_roles="hope-app-role" \
     connection_url='postgresql://{{username}}:{{password}}@host.docker.internal:5432/hope_main?sslmode=disable' \
     username="vault_admin" \
     password="${VAULT_DB_ADMIN_PASS:-vault_admin_dev_pw}" 2>/dev/null || true

   echo "[vault-init] creating database/roles/hope-app-role"
   vault write database/roles/hope-app-role \
     db_name=hope-main \
     creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}' INHERIT IN ROLE hope_app_template;" \
     default_ttl="1h" \
     max_ttl="24h" 2>/dev/null || true
   ```

4. Verify passes (post-up):

   ```bash
   docker exec hope-vault vault read database/roles/hope-app-role -format=json | jq '.data.default_ttl'
   # Expected: 3600
   ```

5. Commit: `infra(vault): provision database engine + hope-app-role for dev`.

---

### Task 5.3: Add `requestDbCredential()` to `SecretsService`

**Agent**: `tester`

**Files**:
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/SecretsService.ts`
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/__tests__/SecretsService.test.ts`

**Steps**:

1. Failing test (mirror previous patterns):

   ```typescript
   it('requestDbCredential proxies to provider.issueDbCredential', async () => {
     const provider = new InMemorySecretsProvider({});
     (provider as unknown as { issueDbCredential?: (r: string) => Promise<unknown> }).issueDbCredential = vi.fn(async () => ({
       username: 'v-token-h-h-1', password: 'pw', leaseId: 'database/creds/hope-app-role/abc', ttlSec: 3600,
     }));
     const service = new SecretsService(provider, {});
     const cred = await service.requestDbCredential('hope-app-role');
     expect(cred.username).toBe('v-token-h-h-1');
   });
   ```

2. Verify fails.

3. Implement: add proxy on `SecretsService`:

   ```typescript
   async requestDbCredential(role: string): Promise<{ username: string; password: string; leaseId: string; ttlSec: number }> {
     const maybe = this.provider as unknown as { issueDbCredential?: (r: string) => Promise<{ username: string; password: string; leaseId: string; ttlSec: number }> };
     if (typeof maybe.issueDbCredential !== 'function') {
       throw new Error('SecretsService.requestDbCredential() requires Vault provider');
     }
     return maybe.issueDbCredential(role);
   }
   ```

4. Verify passes.

5. Commit: `feat(secrets): SecretsService.requestDbCredential proxy`.

---

### Task 5.4: Add `@prisma/adapter-pg` dependency

**Agent**: `database-admin`

**Files**:
- Modify: `packages/database/package.json`

**Steps**:

1. Failing test:

   ```bash
   grep -q '"@prisma/adapter-pg"' packages/database/package.json
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails.

3. Implement:

   ```bash
   pnpm --filter @arcaai/database add @prisma/adapter-pg pg
   pnpm --filter @arcaai/database add -D @types/pg
   ```

4. Verify passes:

   ```bash
   grep -q '"@prisma/adapter-pg"' packages/database/package.json
   echo "rc=$?"
   # Expected: rc=0
   ```

5. Commit: `feat(db): add @prisma/adapter-pg for dynamic credential support`.

---

### Task 5.5: Switch `PrismaClient` factory to use `@prisma/adapter-pg` with Vault-issued password

**Agent**: `database-admin`

**Files**:
- Modify: `packages/database/src/index.ts` (where `getPrismaClient` lives)
- Modify: `packages/database/src/__tests__/prisma-vault-adapter.test.ts`

**Steps**:

1. Failing test:

   ```typescript
   it('getPrismaClientWithVault uses adapter-pg password callback that calls SecretsService', async () => {
     const calls: string[] = [];
     const secrets = { requestDbCredential: async (r: string) => { calls.push(r); return { username: 'u', password: 'p', leaseId: 'lid', ttlSec: 60 }; } };
     const client = getPrismaClientWithVault(secrets as never, 'hope-app-role');
     // adapter-pg invokes password callback on connection — simulate via a no-op query
     await client.$queryRaw`SELECT 1`;
     expect(calls).toContain('hope-app-role');
   });
   ```

2. Verify fails:

   ```bash
   pnpm --filter @arcaai/database test:unit -- prisma-vault-adapter
   # Expected: failure (function not exported)
   ```

3. Implement: add a new factory in `packages/database/src/index.ts`:

   ```typescript
   // packages/database/src/index.ts
   import { PrismaClient } from './generated/core-prisma-client';
   import { PrismaPg } from '@prisma/adapter-pg';
   import { Pool } from 'pg';

   export function getPrismaClientWithVault(
     secretsService: { requestDbCredential: (role: string) => Promise<{ username: string; password: string; leaseId: string; ttlSec: number }> },
     role = 'hope-app-role',
   ): PrismaClient {
     const pool = new Pool({
       host: process.env.PG_HOST ?? 'localhost',
       port: Number(process.env.PG_PORT ?? 5432),
       database: process.env.PG_DATABASE ?? 'hope_main',
       // password callback: invoked per new connection
       password: async () => {
         const cred = await secretsService.requestDbCredential(role);
         return cred.password;
       },
       // user callback (pg ≥ 8.10)
       user: undefined as unknown as string, // pg requires either user or via env; we set per-connection in beforeConnect below
       max: Number(process.env.PG_MAX_POOL_SIZE ?? 20),
     });
     // For dynamic username, prefer pg.beforeConnect when pg version supports it,
     // else cache the username on first request and rotate the pool on lease expiry.
     return new PrismaClient({ adapter: new PrismaPg(pool) });
   }
   ```

4. Verify passes:

   ```bash
   pnpm --filter @arcaai/database test:unit -- prisma-vault-adapter
   # Expected: 1 passing
   ```

5. Commit: `feat(db): getPrismaClientWithVault using @prisma/adapter-pg password callback`.

---

### Task 5.6: Wire `getPrismaClientWithVault` in `CoreDatabaseModule` when `SECRETS_PROVIDER=vault`

**Agent**: `database-admin`

**Files**:
- Modify: the file exporting `CoreDatabaseModule` (grep `packages/domains/src` for `CoreDatabaseModule`)

**Steps**:

1. Failing test (file-level grep):

   ```bash
   grep -rn 'getPrismaClientWithVault' packages/domains/src packages/applications/src
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails.

3. Implement: in `CoreDatabaseModule`, switch the `PrismaClient` provider to a factory:

   ```typescript
   // packages/domains/src/database/core-database.module.ts (or wherever the module lives)
   import { getPrismaClient, getPrismaClientWithVault } from '@arcaai/database';
   import { SecretsService } from '@arcaai/applications';

   {
     provide: PrismaClient,
     useFactory: (secretsService: SecretsService) => {
       const useVault = process.env.SECRETS_PROVIDER === 'vault' && process.env.PG_DYNAMIC_CREDS === 'true';
       return useVault ? getPrismaClientWithVault(secretsService, 'hope-app-role') : getPrismaClient();
     },
     inject: [SecretsService],
   }
   ```

4. Verify passes (build + module test if available).

5. Commit: `feat(db): switch PrismaClient to vault-backed when PG_DYNAMIC_CREDS=true`.

---

### Task 5.7: Lease renewal worker (BullMQ-based)

**Agent**: `tester`

**Files**:
- Create: `packages/applications/src/services/baseServices/_meta/secrets/vault-lease-renewer.ts`
- Create: tests

> Vault's lease (default 1h) needs renewal before expiry, otherwise the DB user is dropped mid-request. Use a BullMQ-style periodic worker that renews at 50% TTL (every 30 min for default 1h TTL).

**Steps**:

1. Failing test:

   ```typescript
   it('renewer schedules renewals at 50% of TTL and updates the lease', async () => {
     // mock renewLease to return new ttlSec, assert next scheduled call uses it
   });
   ```

2. Verify fails.

3. Implement: a small class `VaultLeaseRenewer` that takes a `leaseId`, a `renewer.renew()` callback (delegated to `node-vault`'s `tokenRenew`/`leaseRenew`), and a logger. Initial timer = `(ttlSec * 1000) / 2`. On each tick, call `renew()`, reschedule for half of the new TTL. On three consecutive renewal failures, mark `SecretsService.health()` as degraded.

4. Verify passes.

5. Commit: `feat(secrets): VaultLeaseRenewer for DB credentials`.

---

### Task 5.8: Staging smoke — Vault DB engine end-to-end

**Agent**: `tester`

**Files**:
- Create: `packages/database/scripts/vault-db-smoke.ts`

**Steps**:

1. Failing test (script existence).

2. Verify fails.

3. Implement:

   ```typescript
   // packages/database/scripts/vault-db-smoke.ts
   // Issues a vault credential and runs SELECT 1 through PrismaClient.
   // Asserts no exception and reports the dynamic username.
   import { getPrismaClientWithVault } from '../src';
   import { SecretsService, VaultSecretsProvider } from '@arcaai/applications';

   (async () => {
     const provider = new VaultSecretsProvider({
       addr: process.env.VAULT_ADDR!, roleId: process.env.VAULT_ROLE_ID!,
       wrappedSecretId: process.env.VAULT_WRAPPED_SECRET_ID,
       kvMount: 'secret', kvPrefix: 'hope',
       transitMount: 'transit', transitKey: 'hope-globalsetting',
     });
     const secrets = new SecretsService(provider, {});
     await secrets.boot();
     const cred = await secrets.requestDbCredential('hope-app-role');
     console.log('Dynamic creds:', cred.username, 'TTL', cred.ttlSec);
     const client = getPrismaClientWithVault(secrets);
     const rows = await client.$queryRaw`SELECT 1 AS ok`;
     console.log('SELECT 1 →', rows);
     await client.$disconnect();
   })().catch((e) => { console.error(e); process.exit(1); });
   ```

4. Verify passes (manual run against staging).

5. Commit: `feat(db): vault-db-smoke.ts smoke script for staging`.

---

### Task 5.9: 24-hour staging soak + report

**Agent**: `tester` + `database-admin`

**Files**:
- Create: `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/05-vault-phase-5-staging-soak.md`

Captures the soak results: no expired-credential errors, no connection storms, mean credential count over time, peak active dynamic users vs. `max_connections`. Sign-off by `database-admin` required.

**Steps**:

1. Failing test: file existence.
2. Verify fails.
3. Implement: template the doc with sections `Plan`, `Metrics`, `Pass criteria`, `Findings`, `Sign-off`.
4. Verify passes.
5. Commit: `docs(vault): Phase 5 staging soak template`.

---

### Task 5.10: Decision gate — promote to production OR rollback

**Agent**: `code-reviewer` + `security-auditor` + `database-admin` (joint)

**Files**:
- Modify: `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/05-vault-phase-5-staging-soak.md`

Joint review fills the "Sign-off" section. If pass → enable in prod via systemd env (`PG_DYNAMIC_CREDS=true`). If fail → set `PG_DYNAMIC_CREDS=false`; Phase 5 reverts cleanly because the factory falls back to `getPrismaClient()` (Task 5.6).

### Code Review Gate 5 — `code-reviewer`

Final check on all of Phase 5 commits. Pass → PR `feat/task-302-vault/p5-db-engine` → `dev`; merge.

---

# Phase 6 — Rotation Automation

**Phase Goal**: Static-secret rotation (JWT_SECRET_KEY, SESSION_SECRET_KEY, API_KEY_PEPPER, OIDC_CLIENT_SECRET, etc.) without code changes or pod restarts. Vault Transit handles encryption-key rotation; KV-v2 versioning handles value rotation; Redis Pub/Sub propagates cache invalidation.

**Entry Criteria**: Phases 1–4 merged. Redis Pub/Sub channel `arca:secrets:invalidate` reachable from the app + a worker.

**Exit Criteria**:
- Vault Transit key `hope-globalsetting` can rotate (`vault write -f transit/keys/hope-globalsetting/rotate`); existing ciphertexts still decrypt.
- A small `vault-rotation-worker` BullMQ job watches Vault's audit-log file for write events on `secret/data/hope/*` and publishes `arca:secrets:invalidate`.
- Manual rotation procedure documented in Appendix B.

---

### Task 6.1: Transit key rotation test (round-trip pre+post)

**Agent**: `security-auditor`

**Files**:
- Create: `packages/applications/src/services/baseServices/_meta/secrets/__tests__/transit-rotation.integration.test.ts`

**Steps**:

1. Failing test:

   ```typescript
   describe.skipIf(!process.env.INTEG_VAULT)('Vault Transit rotation', () => {
     it('historical ciphertexts decrypt after rotate', async () => {
       const p = makeVaultProvider();
       await p.boot();
       const ct1 = await p.encrypt(Buffer.from('payload-v1'));
       execSync(`VAULT_ADDR=${process.env.VAULT_ADDR} VAULT_TOKEN=${process.env.VAULT_DEV_ROOT_TOKEN} vault write -f transit/keys/hope-globalsetting/rotate`);
       const ct2 = await p.encrypt(Buffer.from('payload-v2'));
       expect(ct1.split(':')[1]).toBe('v1');
       expect(ct2.split(':')[1]).toBe('v2');
       expect((await p.decrypt(ct1)).toString('utf8')).toBe('payload-v1');
       expect((await p.decrypt(ct2)).toString('utf8')).toBe('payload-v2');
     });
   });
   ```

2. Verify fails (without dev container).

3. Implement: above test plus reusable `makeVaultProvider()` factory inlined in the test file.

4. Verify passes:

   ```bash
   docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault up -d
   INTEG_VAULT=1 VAULT_DEV_ROOT_TOKEN=root pnpm --filter @arcaai/applications test:unit -- transit-rotation
   # Expected: 1 passing
   ```

5. Commit: `test(secrets): integration test for Vault Transit rotation round-trip`.

---

### Task 6.2: `kv-v2` value rotation procedure documented

**Agent**: `docs-manager`

**Files**:
- Modify: `research/deployments/deploy-vm430-432-vault.md` (append a new section, "16. Manual secret rotation procedure")

**Steps**:

1. Failing test:

   ```bash
   grep -q 'Manual secret rotation procedure' research/deployments/deploy-vm430-432-vault.md
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails.

3. Implement: append:

   ```markdown
   ## 16. Manual secret rotation procedure

   Static secrets (`JWT_SECRET_KEY` etc.) rotate via kv-v2 versioning. Old version stays decryptable; new version is what new logins use. Overlap window: 5 minutes (configurable).

   ```bash
   # 1. Write new version
   vault kv put secret/hope/JWT_SECRET_KEY value="$(openssl rand -hex 32)"

   # 2. Publish invalidation event (manual override; the rotation worker also does this)
   redis-cli -h 10.10.1.121 -a "$REDIS_PASS" PUBLISH arca:secrets:invalidate '{"key":"JWT_SECRET_KEY"}'

   # 3. Wait 5 minutes for in-flight JWTs to drain (or expire — JWT_EXPIRES_IN is 1h by default)

   # 4. Disable the previous version (optional; default kv-v2 keeps history)
   vault kv metadata patch -max-versions=3 secret/hope/JWT_SECRET_KEY
   ```

   For symmetric secrets that don't have an in-flight grace window (e.g. `API_KEY_PEPPER`), schedule the rotation during a maintenance window.
   ```

4. Verify passes (grep returns rc=0).

5. Commit: `docs(vault): manual secret rotation procedure (section 16)`.

---

### Task 6.3: Rotation worker — tail Vault audit log + publish Redis events

**Agent**: `tester`

**Files**:
- Create: `packages/applications/src/services/baseServices/_meta/secrets/vault-rotation-worker.ts`
- Create: tests

**Steps**:

1. Failing test:

   ```typescript
   it('parses an audit log line for kv-v2 write and emits an invalidation event', async () => {
     const sent: Array<[string, string]> = [];
     const publisher = { publish: async (ch: string, msg: string) => { sent.push([ch, msg]); return 1; } };
     const w = new VaultRotationWorker({ publisher: publisher as never, channel: 'arca:secrets:invalidate' });
     const line = JSON.stringify({ type: 'request', request: { operation: 'update', path: 'secret/data/hope/JWT_SECRET_KEY' } });
     await w.handleAuditLine(line);
     expect(sent).toEqual([['arca:secrets:invalidate', JSON.stringify({ key: 'JWT_SECRET_KEY' })]]);
   });
   ```

2. Verify fails.

3. Implement:

   ```typescript
   // packages/applications/src/services/baseServices/_meta/secrets/vault-rotation-worker.ts
   import { Injectable, Logger } from '@nestjs/common';
   import type { Redis } from 'ioredis';

   export interface VaultRotationWorkerOptions {
     publisher: Redis;
     channel?: string;
     kvPrefix?: string;
   }

   @Injectable()
   export class VaultRotationWorker {
     private readonly logger = new Logger(VaultRotationWorker.name);
     private readonly channel: string;
     private readonly kvPrefix: string;

     constructor(private readonly opts: VaultRotationWorkerOptions) {
       this.channel = opts.channel ?? 'arca:secrets:invalidate';
       this.kvPrefix = opts.kvPrefix ?? 'hope';
     }

     async handleAuditLine(line: string): Promise<void> {
       try {
         const entry = JSON.parse(line) as { type?: string; request?: { operation?: string; path?: string } };
         if (entry.type !== 'request') return;
         const op = entry.request?.operation;
         const path = entry.request?.path;
         if (!path || (op !== 'update' && op !== 'create')) return;

         const m = path.match(new RegExp(`^secret/data/${this.kvPrefix}/(.+)$`));
         if (!m) return;
         const key = m[1];
         await this.opts.publisher.publish(this.channel, JSON.stringify({ key }));
         this.logger.log({ message: 'invalidation published', key, channel: this.channel });
       } catch (e) {
         this.logger.debug({ message: 'bad audit line ignored', err: (e as Error).message });
       }
     }
   }
   ```

4. Verify passes.

5. Commit: `feat(secrets): VaultRotationWorker for cache invalidation on kv-v2 writes`.

---

### Task 6.4: File-tail loop for Vault audit log

**Agent**: `pipeline-architect`

**Files**:
- Modify: `packages/applications/src/services/baseServices/_meta/secrets/vault-rotation-worker.ts`

**Steps**:

1. Failing test (small loop test): provide a fake file path with a single line and verify `handleAuditLine` is called.

2. Verify fails.

3. Implement:

   ```typescript
   import { createReadStream, statSync } from 'node:fs';
   import { createInterface } from 'node:readline';

   async run(auditLogPath: string, signal?: AbortSignal): Promise<void> {
     let position = statSync(auditLogPath).size;
     while (!signal?.aborted) {
       await new Promise((r) => setTimeout(r, 1000));
       const size = statSync(auditLogPath).size;
       if (size <= position) continue;
       const stream = createReadStream(auditLogPath, { start: position, end: size });
       const rl = createInterface({ input: stream });
       for await (const line of rl) await this.handleAuditLine(line);
       position = size;
     }
   }
   ```

4. Verify passes.

5. Commit: `feat(secrets): VaultRotationWorker.run() file-tail loop`.

---

### Task 6.5: Deployment unit for the worker

**Agent**: `pipeline-architect`

**Files**:
- Create: `apps/api/src/workers/vault-rotation.worker.module.ts`

Registers `VaultRotationWorker` as a NestJS provider that starts on app boot when `SECRETS_PROVIDER=vault` and `VAULT_AUDIT_LOG_PATH` is set (e.g. `/var/log/vault/audit.log` mounted into the pod). The worker runs only on **one** pod (use a Redis-backed leader election: BullMQ's `WorkerOptions { lockDuration }` or a simple `SET key NX EX 30` lease).

**Steps**:

1. Failing test (file existence + grep for leader-election guard).
2. Verify fails.
3. Implement skeleton (provider that constructs `VaultRotationWorker`, starts on `onModuleInit` only if it can acquire the `arca:secrets:rotation-worker:leader` lock).
4. Verify passes.
5. Commit: `feat(api): vault-rotation worker module with leader election`.

---

### Task 6.6: Rotation playbook for production (BullMQ scheduled rotation)

**Agent**: `security-auditor` + `docs-manager`

**Files**:
- Create: `apps/api/src/workers/scheduled-rotation.processor.ts`

Optional. Provides a BullMQ scheduled job (`@nestjs/bullmq`) that, on a configurable cron (default monthly), rotates static secrets that policy demands: `API_KEY_PEPPER` (180d), `OIDC_CLIENT_SECRET` (90d). Calls `vault kv put` then publishes invalidation. **Disabled by default**; opt-in via `VAULT_ROTATION_SCHEDULE` env.

**Steps**: same TDD pattern. Each rotation logs an audit entry to `auditLog` table with the key name and timestamp (never the value).

5. Commit: `feat(workers): scheduled rotation processor for policy-driven static secret rotation`.

---

### Task 6.7: End-to-end rotation smoke (staging)

**Agent**: `tester`

**Files**:
- Create: `packages/applications/scripts/rotation-smoke.ts`

A script the team runs in staging: rotate JWT_SECRET_KEY, observe Redis Pub/Sub fan-out, verify all pods evict their cached value, hit `/api/v1/auth/whoami` with old + new tokens and confirm only new tokens succeed (assuming overlap-window cron has elapsed).

5. Commit: `feat(secrets): rotation-smoke.ts staging end-to-end script`.

---

### Task 6.8: CI gate — verify rotation worker is idempotent on duplicate events

**Agent**: `tester`

**Files**:
- Modify: tests for `VaultRotationWorker`

Add a test that sending the same audit line twice publishes exactly two events (no dedup needed — the consumer is idempotent). Document the rationale: the cache `delete()` is a no-op when the key is already absent.

5. Commit: `test(secrets): assert rotation worker is idempotent on duplicate audit lines`.

---

### Code Review Gate 6 — `code-reviewer` + `security-auditor`

**Checks**:
- [ ] Transit key rotation does NOT break existing ciphertexts (integration test pass)
- [ ] Rotation worker leader-elects (only one pod publishes)
- [ ] No secret value appears in audit-log line published to Redis (`key` only, not `value`)

---

# Phase 7 — Production Cutover + Decommission of Env-Var Secrets

**Phase Goal**: Flip prod from `SECRETS_PROVIDER=env` to `SECRETS_PROVIDER=vault`, soak, then remove env-var fallbacks (with user-gated DELETE for any DB rows). End-state: prod reads every secret from Vault; env vars carry only bootstrap (`VAULT_ADDR`, `VAULT_ROLE_ID`, wrapped `secret_id`).

**Entry Criteria**: Phases 1–6 verified in staging.

**Exit Criteria**:
- Prod `hope-api.service` env file contains only bootstrap secrets + Vault connect vars.
- `git grep -nE "(JWT_SECRET_KEY|SESSION_SECRET_KEY|API_KEY_PEPPER|OIDC_CLIENT_SECRET|SMR_SERVICE_TOKEN|S3_ACCESS_KEY|S3_SECRET_KEY|MQTT_PASS|REDIS_PASS|MINIO_ACCESS_KEY|MINIO_SECRET_KEY)=" infrastructure/single-deployment/ ansible/ k8s/ 2>/dev/null || true` returns no production-target hits.
- `gitleaks` CI step passes on a tree where all `.env*` example files use only placeholder values.
- 7-day prod soak with no Vault-related incidents.

---

### Task 7.1: CI gate — `gitleaks` rule for Vault tokens + secret env-name allowlist

**Agent**: `cicd-manager`

**Files**:
- Modify: `.gitlab/ci/scan.yml`
- Create: `.gitleaks.toml` (if not present)

**Steps**:

1. Failing test:

   ```bash
   grep -q 'gitleaks' .gitlab/ci/scan.yml
   echo "rc=$?"
   # Expected: rc=1
   ```

2. Verify fails.

3. Implement: append a new `secrets-scan` job to `.gitlab/ci/scan.yml`:

   ```yaml
   secrets-scan:
     stage: scan
     image:
       name: zricethezav/gitleaks:v8.21.2
       entrypoint: [""]
     script:
       - gitleaks dir --config .gitleaks.toml --no-banner --redact --report-format json --report-path gitleaks-report.json .
     artifacts:
       when: always
       paths: [gitleaks-report.json]
       expire_in: 7 days
     rules:
       - if: '$PIPELINE_TYPE != "notify_only"'
   ```

   Create `.gitleaks.toml` with rules tuned to HOPE's secrets surface:

   ```toml
   title = "HOPE gitleaks config"

   [[rules]]
   id = "vault-token"
   description = "HashiCorp Vault token"
   regex = '''hvs\.[A-Za-z0-9_-]{20,}'''
   tags = ["vault", "token"]

   [[rules]]
   id = "jwt-private-key"
   description = "JWT signing material > 16 chars"
   regex = '''(?i)JWT_SECRET_KEY\s*=\s*["']?[A-Za-z0-9+/=_-]{16,}'''
   tags = ["jwt"]

   [[rules]]
   id = "azure-openai-key"
   description = "Azure OpenAI API key"
   regex = '''(?i)(AZURE_OPENAI_API_KEY|SMR_V2_AZURE_API_KEY)\s*=\s*["']?[A-Za-z0-9]{32,}'''
   tags = ["azure", "openai"]

   [allowlist]
   description = "Allowlist for known-safe placeholders"
   regexes = [
     '''<CHANGE_ME>-''',
     '''dev-.*-not-for-prod''',
     '''minio_admin''',
   ]
   paths = [
     '''docs/implementation/TASK-301-System-Config-Multi-Tenancy-Assessment/README\.md''',
     '''research/architecture/system-config-multi-tenancy/.*\.md''',
     '''docs/implementation/TASK-302-System-Config-Implementation-Roadmap/.*\.md''',
   ]
   ```

4. Verify passes (CI re-run; or local: `gitleaks dir --config .gitleaks.toml --no-banner .`).

5. Commit: `ci(scan): add gitleaks job with Vault-aware rules + placeholder allowlist`.

---

### Task 7.2: Provision real Vault secrets in production cluster

**Agent**: `security-auditor` (writes the runbook); SRE executes

**Files**:
- Create: `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/06-vault-phase-7-prod-secret-provisioning.md`

Document the **one-time SRE procedure**:
1. Generate fresh values for every secret (`openssl rand -hex 32`).
2. `vault kv put secret/hope/JWT_SECRET_KEY value="<new>"` etc.
3. Verify with `vault kv get secret/hope/JWT_SECRET_KEY` (audit log written).
4. **Old `.env` values are NOT used as the new Vault values** — fresh rotation simultaneous with cutover.

Steps follow standard TDD: write the doc, grep-check it exists, commit.

5. Commit: `docs(vault): Phase 7 prod secret provisioning runbook`.

---

### Task 7.3: Stage cutover — flip staging to `SECRETS_PROVIDER=vault`

**Agent**: `cicd-manager`

**Files**:
- Modify: staging systemd unit (`/etc/systemd/system/hope-api.service` on staging VM)
- Modify: `.gitlab/ci/deploy.yml` to mint wrapped `secret_id` per deploy

**Steps** (procedural, not a code task):

1. Set `Environment=SECRETS_PROVIDER=vault` and Vault connect vars in the staging unit.
2. Restart `hope-api`; observe boot logs for "Secrets warmed up", "Vault AppRole login successful".
3. Hit `/api/v1/health` → 200; `/api/v1/auth/login` → 200 → verifies JWT_SECRET_KEY round-trip.
4. Soak 48h; check Vault audit log for any 4xx/5xx responses.

If pass → proceed to 7.4.

---

### Task 7.4: Production cutover — flip prod to `SECRETS_PROVIDER=vault`

**Agent**: `cicd-manager` + on-call engineer

**Files**:
- Modify: prod systemd units

**Steps**:

1. Schedule maintenance window (off-peak; HOPE: ~03:00 ICT typical).
2. Take Raft snapshot of prod Vault.
3. Deploy with new env vars; restart `hope-api`.
4. Smoke: synthetic transaction (login → consultation start → summary fetch → S3 presigned URL).
5. Monitor for 1h before declaring cutover successful.
6. Rollback plan (Appendix C):  `SECRETS_PROVIDER=env` + restart → reverts cleanly because env vars never deleted yet (Task 7.6).

---

### Task 7.5: 7-day production soak + sign-off

**Agent**: `code-reviewer` + on-call

**Files**:
- Modify: `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/06-vault-phase-7-prod-secret-provisioning.md` (append "Soak results")

Capture metrics: Vault request rate, p50/p99 latency, error rate, cache hit ratio. Sign-off requires: zero P0/P1 secrets-related incidents, error rate < 0.01%, p99 < 50ms cached / < 200ms cold.

---

### Task 7.6: Decommission env-var secret fallbacks (user-gated for DB seeds)

**Agent**: `git-manager` (proposes); user approves; then `cicd-manager` removes

**Files**:
- Modify: `apps/api/.env.dev` (replace secret values with `<see Vault>` markers); local devs keep using env provider, so values stay for non-secret config
- Modify: prod environment files (`/etc/systemd/system/hope-api.service` env-only — leave just bootstrap vars)
- **HOLD**: `packages/database/src/prisma/db_main/seed/06-stt.ts:1690-1712` deletion → covered in Phase 4D's user-gated proposal (Task 4.10)

**Steps**:

1. Failing test:

   ```bash
   ! grep -E '^(JWT_SECRET_KEY|SESSION_SECRET_KEY|API_KEY_PEPPER|OIDC_CLIENT_SECRET|SMR_SERVICE_TOKEN)=' /etc/systemd/system/hope-api.service
   echo "rc=$?"
   # Expected: rc=0 (no matches)
   ```

2. Verify fails initially.

3. Implement: replace with bootstrap-only env:

   ```ini
   Environment=NODE_ENV=production
   Environment=SECRETS_PROVIDER=vault
   Environment=VAULT_ADDR=https://vault.taphuynh.dev
   Environment=VAULT_ROLE_ID=<role_id>
   EnvironmentFile=/run/hope/vault-wrapped-secret-id
   Environment=PG_DYNAMIC_CREDS=true
   Environment=PG_HOST=10.10.1.150
   Environment=PG_DATABASE=hope_main
   ```

4. Verify passes.

5. Commit: `chore(ops): remove env-var secret fallbacks from prod systemd unit`.

---

### Final Code Review Gate (Phase 7 close-out) — `security-auditor` + `code-reviewer` (sign-off)

**Checks**:

- [ ] All earlier gates passed (1A, 1B, 2A, 2B, 2C, 3A, 3B, 3C, 4A, 4B, 4C, 5, 6)
- [ ] Production soak signed by code-reviewer + on-call
- [ ] `gitleaks` CI job green on `dev`, `staging`, `main`
- [ ] Production `hope-api.service` env has no secret values
- [ ] Vault snapshot taken pre-cutover and post-cutover
- [ ] DR runbook reviewed by SRE
- [ ] HIPAA self-attestation update: Vault listed as the secrets store; HOPE owns operational responsibility per D5

**Action if pass**: TASK-302 Stream B closed. Tag release `v<X.Y.0>-vault`.
**Action if fail**: file specific blocker tickets; do not close.

---

# Appendix A — Vault Policies (HCL)

These are the policies referenced throughout the plan. Save under `infrastructure/docker/configs/vault/policies/` (dev) and on the production Vault cluster's policy store. Mirror identical for staging.

## A.1 `hope-app` — primary application AppRole policy

Path: `infrastructure/docker/configs/vault/policies/hope-app.hcl` (also installed on prod cluster). Used by the NestJS API pods.

```hcl
# Read all hope application secrets (kv-v2 path requires both data/ and metadata/)
path "secret/data/hope/*" {
  capabilities = ["read", "list"]
}
path "secret/metadata/hope/*" {
  capabilities = ["read", "list"]
}

# Transit encrypt/decrypt for envelope-encrypted GlobalSetting rows
path "transit/encrypt/hope-globalsetting" {
  capabilities = ["update"]
}
path "transit/decrypt/hope-globalsetting" {
  capabilities = ["update"]
}

# Dynamic DB credentials (Phase 5)
path "database/creds/hope-app-role" {
  capabilities = ["read"]
}

# Health endpoint
path "sys/health" {
  capabilities = ["read"]
}

# Renew its own token + lease
path "auth/token/renew-self" {
  capabilities = ["update"]
}
path "sys/leases/renew" {
  capabilities = ["update"]
}
```

## A.2 `hope-operator` — human operator policy (Phase 7 rotation)

Used by `userpass`/`oidc` human accounts to rotate secrets. **Not** assigned to applications. Add to the production Vault cluster only.

```hcl
# Rotate kv-v2 secrets (write new version)
path "secret/data/hope/*" {
  capabilities = ["create", "read", "update", "list"]
}
path "secret/metadata/hope/*" {
  capabilities = ["read", "list", "delete"]
}

# Rotate transit key
path "transit/keys/hope-globalsetting/rotate" {
  capabilities = ["update"]
}
path "transit/keys/hope-globalsetting/config" {
  capabilities = ["read", "update"]
}

# Database engine ops
path "database/roles/hope-app-role" {
  capabilities = ["read", "list"]
}
path "database/config/hope-main" {
  capabilities = ["read"]
}

# Audit log read
path "sys/audit" {
  capabilities = ["read"]
}
```

## A.3 `hope-ci` — CI/CD pipeline policy (Phase 7)

Used by the GitLab CI runner to mint wrapped `secret_id` for each deploy. Scope is intentionally narrow: only `auth/approle/role/hope-app/secret-id` write with `wrap-ttl`.

```hcl
# Mint a wrapped secret_id for the hope-app AppRole
path "auth/approle/role/hope-app/secret-id" {
  capabilities = ["update"]
  required_parameters = []
  min_wrapping_ttl = "30s"
  max_wrapping_ttl = "5m"
}

# Read role-id (for sanity check; role_id is non-secret)
path "auth/approle/role/hope-app/role-id" {
  capabilities = ["read"]
}
```

## A.4 `hope-rotation-worker` — Phase 6 worker policy

Used by the BullMQ worker pod that publishes invalidation events. Only needs to *read* the audit-log file (mounted as a volume) and publish to Redis — Vault permissions are minimal.

```hcl
# No Vault permissions required beyond the base hope-app policy.
# The audit log is on disk; the worker reads it directly.
# Listed here for documentation completeness only; the worker uses the same AppRole as the app.
```

---

# Appendix B — Disaster Recovery Runbook

## B.1 Scenarios

| Scenario | Detection | Action | RTO | RPO |
|---|---|---|---|---|
| Single Vault node down | HAProxy health check fails; Prometheus alert | HAProxy fails over to backup; no app impact | 0 | 0 |
| Vault leader election deadlock | All pods readiness flips to 503 | SSH to node 1, `vault status`, force election: `vault operator step-down` on stuck node | 5 min | 0 |
| Raft quorum loss (2 of 3 nodes down) | Vault unsealable; writes fail | Run `vault operator raft peers`; if all peers visible, restore from snapshot to a fresh node; if not, escalate | 30 min | last snapshot interval (≤ 4h) |
| Full cluster loss | All 3 VMs gone | Restore from MinIO-stored snapshot to fresh 3-node cluster; re-issue all wrapped `secret_id`s | 2h | ≤ 4h |
| Application can't reach Vault | All HOPE pods readiness 503 | (1) Verify HAProxy health (2) `nc -zv vault.taphuynh.dev 443` (3) Roll back `SECRETS_PROVIDER=env` (Appendix C) | 10 min | 0 |
| Wrapped `secret_id` not consumed in TTL | Pod fails to authenticate at boot | CI/CD re-mints; pod restart picks up new wrap | 5 min | 0 |
| Transit key corrupted | Decrypt returns garbage | Restore from snapshot (Transit key is part of Vault's storage) | 2h | last snapshot |

## B.2 Quarterly DR drill

Run the procedure in section 13 of the cluster blueprint quarterly. Document each drill in `research/runbooks/vault-dr-drill-YYYY-MM.md` with:
- Date, operators present, snapshot used
- Time to declare service restored (RTO actual)
- Issues encountered + remediation
- Sign-off

## B.3 Key share holders

Maintain a current list in the SRE password vault (out of band):
- Key share 1: SRE Lead
- Key share 2: CTO
- Key share 3: Engineering Manager
- Key share 4: Security Auditor (external; sealed envelope)
- Key share 5: Backup (cold storage, retrievable in 24h)

Rotate the holder roster when any holder leaves. Re-shamir requires `vault operator rekey -init -key-shares=5 -key-threshold=3`.

## B.4 Compliance recordkeeping (HIPAA / SOC2)

- Vault audit log retained 6 years (HIPAA §164.316(b)(2)(i))
- Each rotation event logged in `auditLog` (via Phase 6 worker)
- Annual access review: re-issue every operator's `userpass` credential

---

# Appendix C — Backout / Rollback Procedure Per Phase

Backout from any phase **must** preserve secret material; never zero out existing Vault data unless restoring from a snapshot.

## C.1 Phase 1A rollback

- Stop the dev container: `docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault down`
- Revert commits `git revert <range>`
- No production impact (dev only).

## C.2 Phase 1B rollback

- Documentation only; revert markdown commit. SRE-built VMs are decommissioned separately.

## C.3 Phase 2 rollback

- Revert `SecretsModule` import from `CommonServiceModule`
- All consumers continue to use `AppSettingsService` / `process.env` directly because Phase 2 did not change them yet.
- Re-run tests; should be green.

## C.4 Phase 3 rollback

- Set `SECRETS_PROVIDER=env` in the affected environment (`.env.dev` / systemd unit) and restart.
- All `secretsService.getSecret(K)` calls fall back to `process.env[K]` reads (env provider behavior).
- **No code revert needed** — the provider abstraction insulates consumers from the storage backend.
- If `SecretsService` itself has bugs, revert the latest cluster's PR; auth strategies remain backward-compatible because the `getSecretSync` API will simply return the env value via cache.

## C.5 Phase 4 rollback

- Read fallback: `decryptValueFromEntity` already prefers `encryptedValue` and falls back to `value` (legacy column kept readable for one release). Setting `Environment=USE_ENCRYPTED_GLOBALSETTING=false` (gate to add) flips read priority back to `value`.
- Schema rollback (DELETE columns): **NEVER auto-execute** — user-gated; see Phase 4D.
- Re-run backfill in `--dry-run` mode to confirm parity.

## C.6 Phase 5 rollback

- Set `Environment=PG_DYNAMIC_CREDS=false` and restart.
- `CoreDatabaseModule` factory (Task 5.6) falls back to `getPrismaClient()` with the static `DATABASE_URL`.
- Vault database engine remains configured (idempotent); no Vault data lost.
- If Vault DB engine itself is corrupted, `vault disable database` then re-run Tasks 5.1–5.2.

## C.7 Phase 6 rollback

- Stop the rotation worker module (`apps/api/src/workers/vault-rotation.worker.module.ts`).
- Cache invalidation still functional via manual `redis-cli PUBLISH`.
- Transit key rotation events have no app-side dependency.

## C.8 Phase 7 rollback

- Same as Phase 3 (toggle `SECRETS_PROVIDER=env`).
- Restore env values from the SRE password vault (kept until decommission window passes).
- Restore from Vault snapshot if values were rotated to fresh material during cutover.

---

# Appendix D — Verification Cheat Sheet

Quick commands to verify each phase's completion. Run from monorepo root.

```bash
# Phase 1A
docker compose -f infrastructure/docker/docker-compose.dev.yml --profile vault up -d
docker exec hope-vault vault status

# Phase 2 — provider selection
SECRETS_PROVIDER=env pnpm --filter @arcaai/applications test:unit -- SecretsService
SECRETS_PROVIDER=vault \
  VAULT_ADDR=http://localhost:8200 \
  VAULT_ROLE_ID=$(docker exec hope-vault vault read -field=role_id auth/approle/role/hope-app/role-id) \
  VAULT_WRAPPED_SECRET_ID=$(docker exec hope-vault vault write -wrap-ttl=60s -f -format=json auth/approle/role/hope-app/secret-id | jq -r .wrap_info.token) \
  INTEG_VAULT=1 \
  pnpm --filter @arcaai/applications test:unit -- vault-secrets.provider.integration

# Phase 3 — no stray secret env reads
! git grep -nE "process\\.env\\.(JWT_SECRET_KEY|SESSION_SECRET_KEY|API_KEY_PEPPER|OIDC_CLIENT_SECRET|S3_ACCESS_KEY|S3_SECRET_KEY|SMR_SERVICE_TOKEN)" -- packages/ apps/ ':(exclude)**/.env*' ':(exclude)**/__tests__/**' ':(exclude)packages/applications/src/services/baseServices/_meta/config/config.service.ts' ':(exclude)packages/database/src/prisma/db_main/seed/**'

# Phase 4 — transit round-trip
docker exec hope-vault sh -c 'echo -n hello | base64 | xargs -I{} vault write -field=ciphertext transit/encrypt/hope-globalsetting plaintext={}'
# Take ciphertext output, then:
# docker exec hope-vault sh -c 'vault write -field=plaintext transit/decrypt/hope-globalsetting ciphertext=<paste> | base64 -d'

# Phase 5 — dynamic credential
docker exec hope-vault vault read database/creds/hope-app-role -format=json | jq

# Phase 6 — manual rotation
docker exec hope-vault vault kv put secret/hope/JWT_SECRET_KEY value="rotated-$(date +%s)"
docker exec hope-vault vault kv metadata get secret/hope/JWT_SECRET_KEY -format=json | jq '.data.current_version'

# Phase 7 — production cutover smoke
curl -sf https://api.hope.taphuynh.dev/api/v1/health
curl -sX POST https://api.hope.taphuynh.dev/api/v1/auth/login -H 'content-type: application/json' -d '{"email":"smoke@hope","password":"…"}'
```

---

# End of Plan

**Total content**: Phase 0 dependency + 7 implementation phases + 4 appendices.
**Tasks**: 84 numbered + 7 code-review gates + 4 phase-level decision gates.
**Estimated effort**: ~34.5 solo eng-days / ~27 paired eng-days (excluding SRE VM provisioning).
**Critical path**: Phase 0 (predecessor) → Phase 1A → Phase 2 → Phase 3 → Phase 7. Phases 4, 5, 6 parallelizable around 3 and 7.

> **Execution**: hand this file to the `executing-plans` skill. The skill spins a fresh subagent per task, requires `code-reviewer` between tasks, and STOPs at every user-gate (Task 4.10, Phase 4D, Phase 7.6 DB cleanup).


