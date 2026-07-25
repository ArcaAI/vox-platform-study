# Secrets Storage: Migration to a Managed Secrets Manager

> **Status**: Research / pre-planning. Not currently scheduled.
> **Companion ticket**: `TASK-3XX-Secrets-Manager-Migration` (reserve when prioritized)
> **Cross-references**: TASK-301 P0-1 (AppSettings cache collision), P0-2 (mass-assignment), P0-6 (audit-log plaintext leak), P0-7 (secrets in DB).
> **Decision today**: Keep all secrets in env vars. This document prepares the migration path for when one of the trip-wires in §1.4 fires.

---

## 1. Why migrate

### 1.1 Current state (as of TASK-301 audit)

HOPE handles PHI under HIPAA. The secrets surface today spans three locations, none of them ideal:

| Location | Examples | Issues |
|---|---|---|
| Process env (typed in `IAppConfig`) | `JWT_SECRET_KEY`, `REDIS_PASS`, `MQTT_PASS`, `SESSION_SECRET_KEY`, `API_KEY_PEPPER`, `SMR_SERVICE_TOKEN`, `OIDC_CLIENT_SECRET`, `DATABASE_URL` (with password) | Committed in `.env.dev` plaintext. Real `AZURE_OPENAI_API_KEY` and `SMR_AZURE_API_KEY` visible in `.env.dev` today (immediate rotation required). |
| Process env (raw `process.env.*`) | `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `AZURE_SPEECH_KEY`, `HUGGINGFACE_TOKEN`, `API_GATEWAY_KEY`, `LANGFUSE_SECRET_KEY` | No central inventory; no rotation; leaks into shell history. |
| `GlobalSetting` table (`value: String`, `locked: true`) | `JWT_SECRET_KEY` (duplicates env), `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `OIDC_CLIENT_SECRET` (duplicates env) | Plaintext at rest. Cached in process memory. **`AuditLog.data` captures full entity `toObject()` on every update — secret values land in audit log.** |

The `loadVaultSecrets()` stub at `packages/applications/src/services/baseServices/_meta/config/config.service.ts:195` was scaffolded for a future vault integration but currently throws.

### 1.2 Concrete benefits of a managed secrets manager

- **Audit trail**: every `GetSecretValue` call is logged to CloudTrail / Azure Activity Log with the IAM principal that requested it. Required for HIPAA §164.312(b) audit controls and SOC2 CC6.1.
- **Rotation without redeploy**: secret rotation produces a new version; consumers refresh on `SecretNearExpiry` events or on cache TTL expiry. No restart loop.
- **Central revocation**: a compromised credential is killed in one place; all consumers see the new version on next refresh.
- **Envelope encryption at rest**: KMS-backed data keys mean even a DB dump or backup file leak doesn't expose secrets.
- **BAA-covered managed service**: removes "secrets in `.env`" from the BAA scope; reduces the auditor's blast radius.
- **No more `.env` files in deployments**: bootstrap secrets are the only env material; everything else fetched at boot.

### 1.3 Concrete costs

- **Cold-start latency**: 100–300 ms per secret fetch on cold boot. Batched fetch + warmup mitigates this but it's not free.
- **Network dependency**: if the secrets manager is unreachable at boot, the app cannot start. Need a clearly-defined fail mode (typically fail-closed for prod, stale-while-revalidate for steady state).
- **Vendor lock-in**: AWS Secrets Manager API ≠ Azure Key Vault API ≠ Vault HTTP API. Mitigated by the `ISecretsProvider` adapter in §4.
- **IAM complexity**: each pod / function needs the right IAM role / Managed Identity / Vault policy. One-time setup cost but easy to mis-configure.
- **Operational overhead**: someone owns the secrets store. Self-hosted Vault carries ~1 person-day setup + ongoing patching.

### 1.4 Trip-wires (when does cost-benefit clearly tip)

Migrate when **any** of the following becomes true:

1. **Real PHI is in production** with a regulator / partner asking for evidence of secret-rotation policy. (Most likely first trigger.)
2. **More than one production environment** (staging + prod + DR) — `.env` divergence becomes the dominant source of bugs.
3. **An incident requires immediate JWT secret rotation** — today this means a coordinated redeploy.
4. **A new tenant requests BYOK** (bring-your-own-key, e.g. their own Azure OpenAI subscription) — implies per-tenant secrets that don't belong in env vars.
5. **The audit-log plaintext leak (TASK-301 P0-6) is fixed in isolation** but the underlying GlobalSetting plaintext remains — a partial fix is reviewer-bait.
6. **The `loadVaultSecrets()` stub** in `config.service.ts:195` shows up in a security review.

Until then, the env-var approach is fine *if* the immediate hygiene fixes in §5 Phase 0 ship.

---

## 2. Reference architectures (2024-2026)

### 2.1 AWS Secrets Manager + KMS envelope encryption

AWS Secrets Manager encrypts every secret with a unique data key that is wrapped by a KMS key (envelope encryption). The data key is decrypted in memory only at request time and removed as soon as possible (AWS docs, 2025) [1]. For PHI workloads, **use a customer-managed KMS key** rather than the `aws/secretsmanager` default — it allows tighter IAM policy attachments, cross-account access controls, and explicit key-rotation policies [1].

Standard pattern for NestJS + Prisma:
- `@aws-sdk/client-secrets-manager` at boot fetches all required secrets.
- For DB credentials, layer **dynamic rotation** via `@prisma/adapter-pg`: the pg `Pool` accepts a `password` callback that re-fetches on each new connection. Rayan Aradha's Medium walkthrough (2024) shows the exact pattern for handling Prisma migrations + runtime rotation [3].
- KMS automatic key rotation (90-day default) applies to the KMS key, *not* the secrets themselves. Secret rotation is configured per-secret via Lambda.
- BAA coverage: AWS Secrets Manager and KMS are both HIPAA-eligible. Confirm BAA is signed for the AWS account before storing PHI-adjacent material [5].

### 2.2 Azure Key Vault + Managed Identity + Event Grid rotation

Azure Key Vault uses HSM-backed keys (Premium tier) and supports automatic key rotation policies (e.g. `expiresIn: P90D`, `timeAfterCreate: P30D`) [4]. The recommended Node.js pattern:

- `@azure/identity` `DefaultAzureCredential` automatically picks up Managed Identity in Azure-hosted environments and local Azure CLI credentials for dev [1] (Azure docs, 2025).
- `@azure/keyvault-secrets` `SecretClient` provides `getSecret`, `setSecret`, `listPropertiesOfSecretVersions`.
- **Rotation via Event Grid**: configure a `SecretNearExpiry` subscription on the vault → Function App rotates the secret and writes a new version 30 days before expiry. The "dual-credentials" tutorial (Azure docs, 2025) is the canonical pattern for credentials with primary/secondary keys (storage accounts, Cosmos DB) [3].
- BAA coverage: Azure Key Vault is covered under the standard Microsoft Online Services BAA.

### 2.3 HashiCorp Vault (self-hosted) — alternative

Vault Transit secrets engine ("encryption as a service") encrypts/decrypts on Vault's side; the ciphertext is what gets stored in your database. Vault never stores the data itself — the caller is responsible for storing the ciphertext (`vault:v1:...` prefix) [2]. Two relevant patterns:

- **Vault Transit for column encryption**: open-source `pg_pii_vault` PostgreSQL extension provides a `piitext` column type that calls `transit/encrypt` and `transit/decrypt` transparently (AES-256-GCM, 12-byte IV, AAD = `col:piitext:id:<uuid>`). Note: pre-production status — useful as a reference implementation, not as a dependency [g0ddest/pg_pii_vault, 2025].
- **Vault Database Secrets Engine**: generates short-lived database credentials dynamically. Useful if HOPE wants Vault-issued per-pod DB users rather than long-lived service accounts [4].

Self-hosted trade-offs: zero license cost, but you own patching, HA, backups, and the unsealing dance. For HOPE's scale (≤ 50 tenants), Vault adds operational burden that AWS Secrets Manager or Azure Key Vault avoid.

### 2.4 Local-dev story (all three options)

- **AWS**: `LocalStack` provides a Secrets Manager + KMS mock that speaks the real API. Dev `.env` points the SDK at `http://localhost:4566`.
- **Azure**: `Azurite` mocks Storage but **does not currently mock Key Vault**. Dev pattern is to use a shared dev-tenant Key Vault or fall back to `EnvSecretsProvider`.
- **Vault**: `vault server -dev` is fully self-contained, root token printed at boot.

**HOPE recommendation for local-dev**: don't replicate the cloud secrets store. Use `EnvSecretsProvider` from `.env.dev` in `NODE_ENV=development` and never wire local devs to a real KMS. The adapter (§4) makes this trivial.

---

## 3. Target architecture

### 3.1 Three-tier secret model

```
┌─────────────────────────────────────────────────────────┐
│ Tier 1: Bootstrap secrets (in-band, env / instance md)  │
│ - AWS IAM role / Azure Managed Identity / Vault token   │
│ - Enough to reach the secrets manager itself            │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│ Tier 2: Application secrets (fetched on boot, cached)   │
│ - JWT_SECRET_KEY, SESSION_SECRET_KEY, API_KEY_PEPPER    │
│ - DATABASE_URL password (via pg password callback)      │
│ - OIDC_CLIENT_SECRET, MQTT_PASS, REDIS_PASS             │
│ - S3 access/secret keys                                 │
│ - Provider API keys (Azure/OpenAI/HF/Langfuse)          │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│ Tier 3: Tenant-specific secrets (lazy, per-tenant)      │
│ - BYOK provider keys for an individual tenant           │
│ - Tenant-issued webhook signing secrets                 │
│ - Per-tenant integration tokens, etc.                   │
│ Either: per-tenant entries in secrets manager           │
│ Or:     KMS-envelope-encrypted GlobalSetting column     │
└─────────────────────────────────────────────────────────┘
```

### 3.2 AWS vs Azure decision matrix (for HOPE)

| Criterion | AWS Secrets Manager | Azure Key Vault | Self-hosted Vault |
|---|---|---|---|
| Today's deployment (Proxmox/self-hosted) | – | – | ✔ (natural fit) |
| Future cloud move | ✔ if AWS-bound | ✔ if Azure-bound | ✔ portable |
| Per-secret cost | $0.40/mo + $0.05/10k reads | $0.03/10k ops (Standard) | $0 |
| HSM-backed keys | Customer-managed via KMS | Premium tier ($0.03/op) | yes (Enterprise) |
| Rotation automation | Lambda + scheduled events | Function App + Event Grid | manual or via Sidecar |
| Local-dev story | LocalStack | poor (no Azurite KV) | `vault -dev` |
| HIPAA BAA | covered | covered | self-attest |
| Operational burden | low | low | medium-high |
| Recommendation for HOPE | if AWS migration likely | if Azure migration likely | only if multi-cloud / on-prem-permanent |

**HOPE today** is on Proxmox VMs (`research/infrastructure/`). When the cloud move happens it is most likely **Azure** (Azure OpenAI integration already wired in `SMR_AZURE_*` env vars). Recommendation:

> **Pick Azure Key Vault for the v1 cloud migration.** Until then, the adapter (§4) lets `EnvSecretsProvider` carry all loads without committing to either cloud.

If the migration is to AWS, every reference to "Key Vault" / "Managed Identity" maps cleanly to "Secrets Manager" / "IAM Role" — the adapter abstraction is the insulator.

### 3.3 Per-tenant BYOK consideration

For Tier 3 (per-tenant secrets), two viable designs:

| Design | Description | Pros | Cons |
|---|---|---|---|
| **Per-tenant secrets manager entries** | Each tenant's secret is a separate entry: `hope/tenants/{tenantId}/azure-openai-key` | Native rotation; native audit; native ACLs | Cost per secret; requires more IAM granularity |
| **KMS-envelope-encrypted DB column** | `GlobalSetting.encryptedValue` column; decrypt with KMS `Decrypt` at trusted call sites only | One round-trip per secret type; works with current `GlobalSetting` shape | Custom audit; manual rotation; key-management responsibility on HOPE |

**HOPE recommendation**: defer BYOK to a later phase. For v1 of the secrets migration, keep all secrets in Tier 2. Add Tier 3 only when the first BYOK customer signs.

---

## 4. Adapter design

A pluggable `ISecretsProvider` interface lets HOPE swap providers without touching consumers.

### 4.1 Interface

```typescript
export interface SecretFetchOptions {
  ttlSec?: number;       // cache TTL; default 300s
  required?: boolean;    // if true, throw on missing; if false, return undefined
  refresh?: boolean;     // bypass cache for this call
}

export interface ISecretsProvider {
  getSecret(key: string, opts?: SecretFetchOptions): Promise<string>;
  getSecretOptional(key: string, opts?: SecretFetchOptions): Promise<string | undefined>;
  getSecretJson<T>(key: string, opts?: SecretFetchOptions): Promise<T>;
  rotateSecret(key: string): Promise<void>;
  /** Bulk fetch — most providers do this in one API call. */
  getSecrets(keys: string[], opts?: SecretFetchOptions): Promise<Record<string, string>>;
  /** Health check used by /readiness probe. */
  health(): Promise<{ ok: boolean; latencyMs: number; provider: string }>;
}
```

### 4.2 Implementations

```typescript
@Injectable()
export class EnvSecretsProvider implements ISecretsProvider {
  // Reads from process.env; the only provider used in NODE_ENV=development
}

@Injectable()
export class AwsSecretsManagerProvider implements ISecretsProvider {
  // Uses @aws-sdk/client-secrets-manager; bulk-fetches via BatchGetSecretValue
  // Cache: LRU(size=200, ttl=300s) with Redis pub/sub invalidation on rotation
}

@Injectable()
export class AzureKeyVaultProvider implements ISecretsProvider {
  // Uses @azure/keyvault-secrets + DefaultAzureCredential
  // Cache: LRU + EventGrid SecretNearExpiry webhook → cache invalidation
}

@Injectable()
export class InMemorySecretsProvider implements ISecretsProvider {
  // Used in unit tests; constructor takes a Record<string, string>
}
```

Selection via `SECRETS_PROVIDER=env|aws|azure` env var, defaulting to `env`. The factory lives in `SecretsModule.forRootAsync()`.

### 4.3 Caching strategy

- **In-process LRU** with per-secret TTL (default 300s). Avoids hot path on every JWT verification.
- **Refresh on rotation event**: AWS via SNS topic, Azure via Event Grid webhook, Vault via lease renewal. Adapter publishes to local Redis Pub/Sub channel `arca:secrets:invalidate` → all pods clear the cached key.
- **Stale-while-revalidate** for non-critical reads: if the secrets manager is briefly unreachable, return the cached value but log a warning and trigger background re-fetch.
- **Fail-closed for critical reads** (e.g. `JWT_SECRET_KEY` at boot): if no cached value and the provider is unreachable, fail health check → pod is not added to load balancer.

### 4.4 Bulk fetch optimization

At boot, the app needs ~10 secrets. Each fetch is a round-trip. Both AWS (`BatchGetSecretValue`, GA 2024) and Azure (parallel `getSecret` calls) support bulk patterns. The adapter exposes `getSecrets(keys: string[])` and consumers should prefer it over N individual calls.

```typescript
// In AppBootstrap:
const secrets = await secretsProvider.getSecrets([
  'JWT_SECRET_KEY',
  'SESSION_SECRET_KEY',
  'API_KEY_PEPPER',
  'OIDC_CLIENT_SECRET',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
  'SMR_SERVICE_TOKEN',
  'API_GATEWAY_KEY',
]);
```

One round-trip; ~100 ms cold-boot overhead.

### 4.5 Local-dev story (concrete)

```dotenv
# .env.dev
SECRETS_PROVIDER=env
JWT_SECRET_KEY=dev-secret-not-for-prod
SESSION_SECRET_KEY=dev-session-not-for-prod
# ... etc
```

```dotenv
# .env.staging
SECRETS_PROVIDER=azure
AZURE_KEY_VAULT_URL=https://hope-staging-kv.vault.azure.net/
# Managed Identity assigned to the pod / VM — no creds in env
```

Tests use `InMemorySecretsProvider` injected via `SecretsModule.forFeature({ provider: testProvider })`.

---

## 5. Migration phases

Each phase is independently shippable and reversible.

### Phase 0 — Hygiene (do before anything else; ~2 eng-days)

These should ship even if the rest of the migration is deferred indefinitely.

1. **Rotate the real Azure keys currently in `apps/api/.env.dev`** (`AZURE_OPENAI_API_KEY`, `SMR_AZURE_API_KEY`). Treat them as compromised.
2. **Add a `@Secret` field decorator** + serializer hook on `BaseEntity.toObject()` that returns `'[REDACTED]'` for decorated fields. Apply to `GlobalSettingEntity.value` when `locked: true`. (This fixes TASK-301 P0-6 standalone, no provider change needed.)
3. **Add a CI lint rule** that fails the build if `.env.dev` or `.env.example` contains any value matching common secret patterns (high entropy, `sk-`, `xoxb-`, `eyJ...`, etc.). Use `truffleHog` or `gitleaks` in pre-commit.
4. **Document** which secrets exist, where they live, and why (this section is the start).

**Rollback**: trivial — just revert the decorator + lint.

### Phase A — Adapter foundation (~3 eng-days)

Introduce `ISecretsProvider` with `EnvSecretsProvider` only. Pure abstraction layer; no behavior change.

1. Create `packages/applications/src/services/baseServices/_meta/secrets/` with:
   - `ISecretsProvider.ts` (interface)
   - `env-secrets.provider.ts` (default impl)
   - `in-memory-secrets.provider.ts` (test impl)
   - `secrets.service.ts` (DI wrapper, cache logic)
   - `secrets.module.ts`
2. Replace every `process.env.X` read of a secret with `secretsService.getSecret('X')`:
   - `gateway-auth.strategy.ts:20`
   - `jwt.strategy.ts:19`
   - `oidc.strategy.ts:82,83`
   - `auth.service.module.ts:38,41,42,43`
   - `apikey.service.ts:98`
   - `s3.service.ts:225,231,232`
   - `main.ts:210` (session secret)
   - (full list comes from the backend inventory — Section K rename/delete list)
3. Remove the `loadVaultSecrets()` stub at `config.service.ts:195`; replace with a typed `SecretsService.boot()` call.

**Verification**: existing tests pass unchanged (because `EnvSecretsProvider` reads the same `process.env`). Add new unit tests for the cache + the rotation invalidation hook.

**Rollback**: revert the read-site refactors — env vars still work.

### Phase B — Add cloud provider (~5 eng-days, single cloud)

Pick AWS or Azure (per §3.2 decision). Add the corresponding adapter.

1. **Azure path** (recommended):
   - `pnpm add @azure/identity @azure/keyvault-secrets` in `packages/applications`
   - `azure-keyvault-secrets.provider.ts` using `DefaultAzureCredential` + `SecretClient`
   - Add `SECRETS_PROVIDER=azure` toggle in factory
   - Add `AZURE_KEY_VAULT_URL` to the env-var allow-list (this is bootstrap, stays in env)
2. **AWS path**:
   - `pnpm add @aws-sdk/client-secrets-manager`
   - `aws-secrets-manager.provider.ts` using IAM role chain
   - Add `SECRETS_PROVIDER=aws` toggle
   - Bootstrap is the IAM role itself; no env needed beyond `AWS_REGION`
3. Deploy to **staging** with the cloud provider active.
4. Smoke test: `secretsService.health()` must return `{ ok: true, latencyMs < 500ms }`.
5. Validate: rotate one secret in the cloud console → verify all pods pick up the new value within the cache TTL (or immediately via invalidation event).

**Verification**: pre-prod smoke; chaos test (kill secrets manager, confirm fail-closed behavior).

**Rollback**: flip `SECRETS_PROVIDER=env` and redeploy. All env values still present as fallback.

### Phase C — Envelope encryption for DB-stored secrets (~5 eng-days)

For `GlobalSetting` rows with `settingType: SECRET`:

1. Add `encryptedValue: Bytes?` column to `GlobalSetting`.
2. Add `keyVersion: Int?` column for forward compatibility with key rotation.
3. On write: encrypt `value` using a KMS data key (`GenerateDataKey` → encrypt-with-DEK locally → store encrypted DEK + ciphertext). For Azure: use Key Vault key wrap/unwrap. For AWS: KMS `Encrypt`/`Decrypt` directly for small values.
4. On read: decrypt only at trusted call sites; never expose to logs or audit.
5. Migrate existing `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `JWT_SECRET_KEY` / `OIDC_CLIENT_SECRET` rows.

**Verification**: query `GlobalSetting` directly with `psql` — secret rows show `[encrypted]` only. Decrypted access requires the IAM role.

**Rollback**: keep dual-write to `value` for one release; flip read back to plaintext if needed.

### Phase D — Audit-log scrubbing (~2 eng-days)

This is partially achieved by Phase 0 (`@Secret` decorator). Phase D completes it:

1. Audit serializer (`audit-log.service.ts`) must never write decrypted values. Verify by intentionally including a `[REDACTED]` field in the test fixture.
2. Add `auditLog.dataRedactions: string[]` column to record which fields were scrubbed (forensic transparency).
3. Backfill: scan existing `auditLog.data` rows for entries containing now-known secret keys; produce a deletion / re-write report.

**Verification**: SQL query — no audit log row's `data` contains a value matching `JWT_SECRET_KEY` regex pattern (high entropy, base64-ish string > 32 chars in a field named like `value` or `secret`).

**Rollback**: log scrub is forward-only — once stripped, ciphertext is gone. Keep a one-time backup of the pre-scrub audit table.

### Phase E — Rotation automation (~3 eng-days)

1. For each non-DB secret: set a rotation policy in the cloud provider (90 days for JWT_SECRET_KEY, 180 days for OIDC_CLIENT_SECRET).
2. Configure rotation events:
   - **Azure**: Event Grid subscription on `Microsoft.KeyVault.SecretNearExpiry` → Function App that generates a new value and calls `setSecret(name, newValue)`.
   - **AWS**: Lambda with `SecretsManager.RotateSecret` trigger.
3. Both emit to internal Redis Pub/Sub channel `arca:secrets:invalidate` on completion.
4. Adapter listens to that channel and clears its cache for the rotated key.

**Verification**: rotate a non-critical secret in staging; confirm new value visible across all pods within 30s.

**Rollback**: disable the rotation policy; manual rotation still works.

---

## 6. HIPAA-specific guidance

- **BAA**: both AWS Secrets Manager + KMS, and Azure Key Vault, are covered under their respective standard BAAs. AWS requires a signed BAA per AWS account; Azure requires the Microsoft Online Services BAA at the tenant level. See [AWS HIPAA-eligible services list](https://aws.amazon.com/compliance/hipaa-eligible-services-reference/) and Microsoft's HIPAA/HITECH attestation. Verify currency annually.
- **Audit retention**: HIPAA requires 6-year retention of audit logs. CloudTrail / Activity Log default retention varies — configure long-term archival to S3 / Storage Account with Glacier / Cool tier and an explicit lifecycle policy.
- **Key rotation**: KMS keys auto-rotate every 90 days by default (configurable). Application-layer secrets (JWT, OIDC) should rotate on a separate cadence (typically 90 days for symmetric secrets; longer for asymmetric).
- **Encryption verification, not attestation** (HIPAA CI/CD note, 2026): your deploy pipeline must *test* that TLS 1.2+ is enforced and that secrets are reachable through the right BAA-covered path on every deploy, not just at audit time [HIPAA CI/CD article, 2026].
- **TLS in transit**: never set `rejectUnauthorized: false` in production [3]. Both AWS Secrets Manager and Azure Key Vault enforce TLS 1.2+ by default.

---

## 7. Local-dev story

Devs MUST NOT need AWS / Azure credentials to run HOPE locally.

```dotenv
# .env.dev (only file devs need)
SECRETS_PROVIDER=env
JWT_SECRET_KEY=dev-secret-not-for-prod-do-not-rotate
# ... etc
```

The `EnvSecretsProvider` reads from `process.env` exactly as today. The only new thing is the indirection.

For optional integration testing of the cloud path:
- **AWS**: spin up LocalStack via `infrastructure/docker/docker-compose.dev.yml`; set `SECRETS_PROVIDER=aws`, `AWS_ENDPOINT_URL=http://localhost:4566`. Pre-seed the test secrets with a `make secrets-seed-local` target.
- **Azure**: no local Key Vault emulator. Use a shared dev tenant Key Vault or stick with `EnvSecretsProvider` locally.

Unit tests use `InMemorySecretsProvider` injected into the test module.

---

## 8. Cost analysis (cloud)

### AWS Secrets Manager
- Per secret: $0.40 / month
- Per 10,000 API calls: $0.05
- HOPE estimate: 20 secrets × $0.40 = **$8/mo**, plus ~5,000 calls/day × 30 days = 150k calls/mo × $0.05/10k = **$0.75/mo**
- **Total**: ~$9/month/region

### Azure Key Vault (Standard tier)
- Per 10,000 operations: $0.03
- HOPE estimate: 150k ops/mo × $0.03/10k = **$0.45/mo**
- (Premium tier with HSM-backed keys: $1/key/mo + $0.03/10k ops)
- **Total**: ~$1/month/region

### Self-hosted Vault
- License: $0 (OSS); Enterprise pricing on request
- Operational: ~1 person-day initial setup; ongoing ~2 hours/month for upgrades, backup verification, unsealing rotation
- VM cost: ~$30/month for a 3-node HA cluster on small VMs

**Verdict**: cloud costs are negligible at HOPE's scale. The driver for adoption is *operational + compliance*, not cost.

---

## 9. Risks + open questions

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cold-boot fetch adds 100-300ms per secret | high | low | Bulk fetch; warmup cache before declaring readiness |
| Secrets manager unreachable at boot | low | high | Fail-closed; explicit alert; cached values for steady state |
| Cross-region replication (multi-region HOPE) | speculative | medium | Defer until multi-region is real |
| Per-tenant BYOK | speculative | medium | Defer to Tier 3 / Phase D+ |
| Cost overrun from chatty consumers | low | low | LRU cache + bulk fetch; monitor API call count |
| IAM mis-configuration locks pod out of secrets | medium | high | Staging deploy + smoke test; explicit rollback to env provider |
| Developer accidentally commits a secret while using env provider | medium | high | Pre-commit hook (`gitleaks` / `truffleHog`); CI lint |
| Secret rotation breaks an active session (JWT) | medium | medium | Use overlapping validity window (accept old + new for 1h after rotation) |
| Audit-log retention pre-Phase D contains decrypted secrets | known | medium | Phase D scrub + one-time backfill |

### Open questions

1. **IaC tool**: Terraform vs CDK vs Bicep? HOPE doesn't have an IaC convention yet (see `infrastructure/single-deployment/`). Recommend Terraform for vendor portability.
2. **Single-region or multi-region?** If HOPE goes multi-region, Secrets Manager / Key Vault replication needs explicit setup. Cost roughly doubles.
3. **Per-tenant BYOK timing**: do we commit to Tier 3 now, or design it later? Recommendation: design the column shape now (`encryptedValue`, `keyVersion`), don't implement decryption logic until needed.
4. **Vault Transit for PHI columns**: separate from secrets manager. If HOPE wants column-level encryption for `Patient.firstName` etc., that's a different project — but the same KMS / Key Vault key can back both.

---

## 10. Effort estimate

| Phase | Description | Eng-days (1 engineer) | Eng-days (parallel, 2 engs) | Notes |
|---|---|---|---|---|
| Phase 0 | Hygiene (rotation + `@Secret` + gitleaks) | 2 | 2 | Single engineer; serial |
| Phase A | Adapter foundation + EnvProvider | 3 | 3 | One engineer touches all read sites |
| Phase B | Cloud provider (Azure or AWS) | 5 | 4 | Pair on staging deploy |
| Phase C | Envelope encryption for DB secrets | 5 | 4 | DB migration adds serial gate |
| Phase D | Audit-log scrubbing | 2 | 2 | Largely independent |
| Phase E | Rotation automation | 3 | 2 | Cloud Function + Pub/Sub work |
| **Total** | | **~20 eng-days** | **~17 eng-days** | ~4 weeks elapsed with one engineer |
| Plus | Ops/SRE for IaC, IAM policies | +3 days | +2 days | Outside engineering bandwidth |
| Plus | Training (dev + ops) | +2 days | +2 days | Brown-bag + runbook |

**Total elapsed**: ~5-6 weeks if scheduled as a single push, including soak. Realistically interleave with feature work over 8-10 calendar weeks.

---

## 11. References

### External (2024-2026)

1. AWS — *AWS Secrets Manager best practices* — https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html (2025)
2. AWS — *Data protection in AWS Secrets Manager* (KMS envelope encryption) — https://docs.aws.amazon.com/secretsmanager/latest/userguide/data-protection.html (2025)
3. Rayan Aradha — *Handling Dynamic Database Credential Rotation in Prisma with AWS Secrets Manager* (Medium, 2024) — https://medium.com/tales-from-nimilandia/title-handling-dynamic-database-credential-rotation-in-prisma-with-aws-secrets-manager-b9c8cd418b9b
4. Microsoft — *Azure Key Vault secret client library quickstart (Node.js v4)* — https://learn.microsoft.com/en-us/azure/key-vault/secrets/quick-create-node (2025)
5. Microsoft — *Rotation tutorial for resources with two sets of credentials* (Azure Key Vault + Event Grid) — https://learn.microsoft.com/en-us/azure/key-vault/secrets/tutorial-rotation-dual (2025)
6. Microsoft — *Create, update, or rotate Azure Key Vault keys with JavaScript* — https://learn.microsoft.com/en-us/azure/key-vault/keys/javascript-developer-guide-create-update-rotate-key (2025)
7. HashiCorp — *Transit secrets engine* — https://docs.hashicorp.com/vault/docs/secrets/transit (2025)
8. HashiCorp — *Encrypt data in transit with Vault* (Transit tutorial) — https://developer.hashicorp.com/vault/tutorials/encryption-as-a-service/eaas-transit (2025)
9. `g0ddest/pg_pii_vault` — *PostgreSQL extension for GDPR-compliant column-level encryption using HashiCorp Vault Transit Engine* — https://github.com/g0ddest/pg_pii_vault (2025)
10. DEV Community — *HIPAA CI/CD vs SOC 2 CI/CD: where the controls differ* — https://dev.to/stonebridgetechsolutions/hipaa-cicd-vs-soc-2-cicd-where-the-controls-differ-32ag (2026)
11. DEV Community — *How to Architect a Scalable and HIPAA-Compliant HealthTech Application (Node.js + React + AWS Guide)* (2025)

### Internal cross-references

- TASK-301 `docs/implementation/TASK-301-System-Config-Multi-Tenancy-Assessment/README.md` — P0-1 (AppSettings cache collision), P0-2 (mass-assignment), P0-6 (audit-log plaintext leak), P0-7 (DB-stored secrets).
- `packages/applications/src/services/baseServices/_meta/config/config.service.ts:195` — `loadVaultSecrets()` stub (anchor for Phase A).
- `packages/database/src/prisma/db_main/seed/06-stt.ts:1690-1712` — `S3_ACCESS_KEY` / `S3_SECRET_KEY` rows scheduled for deletion in Phase C.
- `packages/database/src/prisma/db_main/seed/11-global-setting.ts` — `locked: true` rows that should carry `settingType: SECRET` after Phase C migration.
- `apps/api/src/main.ts:210` — `SESSION_SECRET_KEY` direct env read (anchor for Phase A).
- `research/architecture/system-config-multi-tenancy/01-layered-resolution-migration.md` — companion plan; the `SettingType: SECRET` enum is co-designed there.
- `research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md` — companion plan; database credential rotation via pg password callback ties into Phase B.

---

**End of plan.** Update `Status` and assign a real ticket number when this lands in a planning session.
