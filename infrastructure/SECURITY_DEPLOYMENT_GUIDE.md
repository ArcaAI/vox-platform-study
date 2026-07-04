# HOPE Security Deployment Guide — Data Encryption

**Ticket**: TASK-369 (Data Encryption Initiative)
**Purpose**: One index for HOPE's at-rest, in-transit, backup, and key-management
encryption — what the repo configures vs. what an operator must do on real hosts.

This guide is the **infrastructure/OPS** view. Application-layer pieces
(CryptoService field encryption, StorageAccessKey) and the ticket README are
owned by other workstreams and are intentionally not duplicated here.

---

## 1. Encryption posture at a glance

| Layer | Mechanism | Where configured | Runbook |
|---|---|---|---|
| **At rest — Postgres** | LUKS/dm-crypt on data+WAL disks | host/VM (operator) | [encryption-at-rest-luks-minio-sse-runbook.md](../docs/research/deployments/encryption-at-rest-luks-minio-sse-runbook.md) §1–4 |
| **At rest — MinIO** | SSE-S3 via KES/KMS | `mc encrypt set` + dev compose hooks | at-rest runbook §5 |
| **At rest — Redis** | Persistence off, or LUKS volume | `docker-compose.yml` (comment) | at-rest runbook §0/§4 |
| **At rest — backups** | pgBackRest AES-256-CBC (client-side) | [`pgbackrest.conf`](../docs/research/configs/postgres-ha/pgbackrest/pgbackrest.conf) | at-rest runbook §6 |
| **In transit — Postgres** | TLS (`sslmode=require`→`verify-full`) | env files (see §2) | this guide §2 |
| **In transit — MinIO** | HTTPS (`MINIO_USE_SSL=true`) | `.env.production` | this guide §2 |
| **Field-level PHI** | Vault Transit key `hope-phi` | app (CryptoService) | [vault-transit-key-rotation.md](../docs/research/deployments/vault-transit-key-rotation.md) |
| **Key mgmt / DR** | Vault Shamir unseal + escrow | Vault VMs 430–432 | [dr-break-glass-runbook.md](../docs/research/deployments/dr-break-glass-runbook.md) |
| **Monitoring** | Prometheus alerts | [`vault-transit-alerts.yml`](../docs/research/configs/postgres-ha/prometheus/vault-transit-alerts.yml) | DR runbook §2 |

---

## 2. In-transit TLS — env changes (Phase 2)

PostgreSQL TLS is enforced via the connection string. **Driver matters**: Node/
Prisma (libpq) uses `sslmode=`, Python/asyncpg uses `ssl=`. Local dev stays
plaintext (loopback, no cert); production/staging examples enforce TLS.

| File | Change |
|---|---|
| `.env.production` | `DATABASE_URL` MUST carry `sslmode=require` (target `verify-full` + `sslrootcert`); `MINIO_USE_SSL=true` confirmed |
| `.env.dev` / `.env.test` | Commented: dev/test intentionally no-TLS; HA examples show `sslmode=require` |
| `apps/api/.env.example` | `DATABASE_URL` + `DIRECT_URL` TLS guidance (`verify-full` target) |
| `apps/stt-v2/.env.production` | `DATABASE_URL=...?ssl=require` (asyncpg), `MINIO_SECURE=true` |
| `apps/guardrail/.env.example` | `GUARDRAIL_DATABASE_URL` `?ssl=require` guidance (asyncpg) |

> `apps/smr/**` and `apps/harness/**` env files carry **no** Postgres/MinIO
> connection strings (SMR's DB URL is unset in its env; harness talks HTTP +
> Temporal gRPC and never connects to Postgres directly), so no Phase 2 change
> applies there.
>
> **`verify-full` is the target** — it encrypts AND validates the server
> certificate + hostname against a trusted CA, defeating MITM. `require` only
> encrypts (no identity check) and is the interim until the CA is distributed to
> every client host. asyncpg's `verify-full` needs an `ssl.SSLContext` built from
> the CA via `connect_args` (app-side wiring — hardened follow-up).

---

## 3. Backups — pgBackRest encryption (Phase 4)

- [`pgbackrest.conf`](../docs/research/configs/postgres-ha/pgbackrest/pgbackrest.conf):
  `repo1-cipher-type=aes-256-cbc`; the passphrase + S3 creds are **env-injected**
  (`PGBACKREST_REPO1_CIPHER_PASS`, `PGBACKREST_REPO1_S3_KEY[_SECRET]`) via the
  patroni container, sourced from Vault — **never committed**.
- The previously committed `repo1-s3-key`/`repo1-s3-key-secret` literals are
  **compromised** and must be rotated in MinIO (see §4).
- Verify encryption + restore: at-rest runbook §6, DR runbook §4.

---

## 4. Outstanding operator actions (require real host access)

These cannot be done from the repo. Owner: SRE.

- [ ] **LUKS-format** Postgres data disks on VMs 500–502 (and single-server) at
  provisioning, before initdb — at-rest runbook §1.
- [ ] Choose + configure **auto-unlock custody** (clevis-tang or Vault) and
  **escrow** every LUKS passphrase — at-rest runbook §2–3.
- [ ] Stand up **KES/KMS** and enable **MinIO SSE** on `recordings`,
  `generated-audio`, `documents`, `pgbackrest` — at-rest runbook §5.1.
- [ ] **ROTATE the exposed `pgbackrest-svc` MinIO credentials** (deploy-vm402-minio.md
  §9b.3); store the new pair + a fresh `openssl rand -base64 48` cipher pass in
  Vault under `secret/hope/PGBACKREST_*`.
- [ ] Enable **server-side Postgres TLS** on Patroni/PgBouncer + distribute the
  CA so clients can move `require`→`verify-full`.
- [ ] Initialise the `hope-phi` Transit key **non-exportable**; set
  `auto_rotate_period` + the `hope-transit-rotate` policy — rotation doc §5/§7.
- [ ] Load the **Vault alert rules** into the central Prometheus and enable
  `unauthenticated_metrics_access` + a 24h `prometheus_retention_time` so seal
  alerts work — alert file header.

---

## 5. Runbook directory

- At-rest (LUKS / MinIO SSE / Redis / backup verify): [`docs/research/deployments/encryption-at-rest-luks-minio-sse-runbook.md`](../docs/research/deployments/encryption-at-rest-luks-minio-sse-runbook.md)
- DR / break-glass (Vault unseal + LUKS recovery + restore): [`docs/research/deployments/dr-break-glass-runbook.md`](../docs/research/deployments/dr-break-glass-runbook.md)
- Transit key rotation + rewrap (`hope-phi`): [`docs/research/deployments/vault-transit-key-rotation.md`](../docs/research/deployments/vault-transit-key-rotation.md)
- Vault/Transit alerts: [`docs/research/configs/postgres-ha/prometheus/vault-transit-alerts.yml`](../docs/research/configs/postgres-ha/prometheus/vault-transit-alerts.yml)
- Upstream infra deploy guides: `docs/research/deployments/deploy-vm430-432-vault.md`,
  `deploy-vm500-502-postgres-ha.md`, `deploy-vm402-minio.md`.
