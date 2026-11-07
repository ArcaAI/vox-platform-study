# PostgreSQL Data Encryption — What Is Actually Encrypted

| Field | Value |
|---|---|
| **Question** | Is the data saved in PostgreSQL encrypted? |
| **Short answer** | Partly. Selected clinical free-text/PHI fields are encrypted by the API before insert and stored as Vault Transit ciphertext. The database as a whole is **not** encrypted by PostgreSQL, and identifiers, demographics, metadata, audit payloads, and some secrets remain plaintext. Disk/backup encryption is a deployment concern and is **unverified** in the repo. |
| **Scope** | Repository evidence in `project-hope`, verified 2026-10-29 |
| **Status** | Field-level encryption: implemented. Disk/backup encryption: specified, live state unverified. |
| **Primary sources** | `packages/domains/src/common/field-encryption.ts`, `packages/domains/src/common/phi-read-decrypt.ts`, `packages/applications/src/common/phi-field-encryption.ts`, `docs/archive/TASK-369-Data-Encryption/README.md`, `docs/research/deployments/encryption-at-rest-luks-minio-sse-runbook.md` |

> This document describes the code and schema in the repository. It is not a live production audit. The final section lists the checks that only an operator with host/database access can perform.

---

## 1. Bottom line

There are two different things people usually mean by "encrypted at rest":

| Layer | Who performs it | What it protects | State in this repo |
|---|---|---|---|
| **Field-level encryption** | The API, before `INSERT` | The selected column values, even in a logical dump or a DB read | **Implemented** for clinical free-text PHI and selected secrets |
| **Disk encryption (LUKS/dm-crypt)** | The host / VM | The whole data directory, WAL, temp files, and every plaintext column | **Specified, not verified** in the live environment |
| **Backup encryption** | pgBackRest / MinIO SSE | Backup archives and object-storage copies | **Specified, not verified** |
| **Transport encryption** | PostgreSQL TLS | Traffic between the API and PostgreSQL | `sslmode=require` appears in production deployment docs; the dev sample URL has no `sslmode` |

So the accurate statement is:

> **PostgreSQL stores ciphertext for selected PHI columns, plaintext for many other columns, and its files are only encrypted if the host deployment actually enabled LUKS and encrypted backups.**

---

## 2. What "field-level encryption" means here

HOPE does **not** use PostgreSQL transparent data encryption, `pgcrypto`, or a database-side encryption function. There is no `pgp_sym_encrypt` / `pgp_pub_encrypt` in the migrations, and no TDE configuration in the repository.

Instead, the API encrypts values before they reach the database:

- **Key:** Vault Transit key `hope-phi` (`PHI_TRANSIT_KEY` in `packages/domains/src/common/field-encryption.ts:26`). An operator can override the name through `getPhiTransitKeyName()`; the default is `hope-phi`.
- **Ciphertext format:** `vault:vN:<base64>`; `N` is the Transit key version (`field-encryption.ts:63`).
- **Storage:** usually a `Bytes` / `BYTEA` column named `encrypted<Field>`, paired with a `keyVersion` integer. A few secret columns store the ciphertext in a `String` column instead.
- **Encryption type:** randomized. Encrypting the same plaintext twice produces different ciphertext. That is why exact-match search and unique indexes are impossible on these columns.
- **Key rotation:** the key version is stored per field; `transit/rewrap` can re-wrap ciphertext without re-encrypting the plaintext.

### 2.1 Write path

```text
service
  → encryptPhiFields(...)               packages/applications/src/common/phi-field-encryption.ts
  → repository.encrypt<Field>IntoEntity()
  → SecretsService.encrypt(Buffer)      Vault Transit: transit/encrypt/hope-phi
  → Buffer.from("vault:vN:...")         stored in the Bytes column + keyVersion
```

The write guard is environment-gated (`phi-field-encryption.ts:32-33, 54-80`):

- `SECRETS_PROVIDER=vault` → **fail-closed**. If the `SecretsService` is missing or Vault encryption throws, the write aborts. The API never silently persists plaintext PHI.
- Any other value (`env`, unset) → **soft no-op** for dev/test. Because the plaintext columns have been dropped, the field is simply left unpersisted. There is no plaintext fallback.

### 2.2 Read path

```text
Prisma delegate
  → decryptPhiRows()                    packages/domains/src/common/phi-read-decrypt.ts
  → PHI_CIPHERTEXT_FIELDS registry
  → SecretsService.decryptBatch()
  → transient plaintext property on the entity → DTO mapper
```

- `PHI_CIPHERTEXT_FIELDS` maps each ciphertext column to its transient plaintext property (`phi-read-decrypt.ts:46`).
- `PHI_MODEL_CIPHERTEXT` limits decryption to columns the model actually declares, so audit/business JSONB snapshots that happen to contain an `encrypted*` key are not walked into and decrypted (`phi-read-decrypt.ts:102`).
- The base `Repository.db` getter wraps the Prisma delegate for row-returning methods: `findUnique`, `findFirst`, `findMany`, `create`, `update`, `upsert` (`phi-read-decrypt.ts:242-260`).
- The wrap is installed only when the secrets provider actually supports Transit — in practice, `SECRETS_PROVIDER=vault` (`secrets.module.ts:196-198`).
- Multi-row reads decrypt in **one batch** Transit call per result set (`phi-read-decrypt.ts:352`), not one call per row.

Consequence: for the Phase 6 PHI columns, PostgreSQL never receives or returns the plaintext. The API decrypts it in memory after the row is read.

---

## 3. What is encrypted

Current schema: **49 `encrypted*` columns across 26 models**.

| Bucket | Columns | Models | How reads decrypt |
|---|---:|---:|---|
| Free-text PHI in the global decrypt registry | 32 | 16 | `decryptPhiRows()` batch, automatic in Vault mode |
| Additional PHI columns on explicit service/repository paths | 7 | 6* | Per-model `decrypt*FromEntity()` helpers |
| WORM payloads (`HarnessAuditEvent`, `HarnessPolicyChange`) | 4 | 2 | `decryptPayloadsFromEntity()` |
| `AuditLog` envelope encryption | 2 | 1 | `fetchById` only; `list`/`export` still read plaintext |
| Secrets | 4 | 4 | Dedicated secret services |
| **Total** | **49** | **26** | |

`*` Three models are additional (`ConsultationAttachment`, `ConsultationFeedback`, `GuardrailEvaluation`); the other four columns belong to three models already counted in the 16 (`DnaWritingStyleReport`, `DnaWritingStyleVersion`, `SummaryMeta`).

### 3.1 Clinical free-text PHI

The main initiative (`TASK-369`) encrypted and then dropped the plaintext counterparts of **30 free-text clinical PHI columns across 14 models**. The global decrypt registry currently maps **32 ciphertext columns across 16 models**, including later additions such as `DocumentSection` and `WorkflowTestFixture`.

Representative fields:

- `ContextItem.content` — the highest-volume clinical free-text field. The plaintext `content` column has been **dropped**; `encryptedContent` is the system of record (`consultation.prisma:222-247`).
- `ContextItemVersion` — historical content, diffs, change summaries, and field-change JSON.
- `Highlight` — exact text, prefix, suffix, note.
- `NamedEntity` — free-text entity text, normalized text, and entity metadata. The coded fields (`umlsCui`, `snomedCode`, `rxnormCode`, `icdCode`, `loincCode`) are deliberately plaintext.
- `SummaryMeta` — `encryptedCitationsMap`, `encryptedGuardrailDecisions`, `encryptedCoverageReport`, `encryptedRedactionManifest`.
- `TranscriptionJob` — `encryptedResultText`, `encryptedResultMetadata`.
- `GoldenCase`, `EvalRun`, `EvalScore` — harness transcripts, reference notes, rationale, details.
- `DnaWritingStyleReport` / `DnaWritingStyleVersion` — style text, report data, redaction rules.
- `KnowledgeChunk.encryptedText`, `DocumentSection.encryptedContent`.
- `Notification.encryptedMessageText` / `encryptedMessageRichText` / `encryptedMessageContent`.
- `PromptTemplate.encryptedLastTestOutput`.
- `ConsultationAttachment.encryptedFileName`, `ConsultationFeedback.encryptedComment`, `GuardrailEvaluation.encryptedWithheldContent`.
- `WorkflowTestFixture.encryptedInput` — saved Workbench test payload.
- `HarnessAuditEvent` and `HarnessPolicyChange` payloads.

### 3.2 Audit payloads

`AuditLog` uses **envelope encryption**, not per-row Vault Transit:

1. One data encryption key (DEK) is generated per process.
2. The DEK is wrapped once through Vault Transit (`hope-phi`); the wrapped DEK and its key version are stored per row in `dekWrapped` / `dekKeyVersion`.
3. Each row's `data` and `previousData` are encrypted locally with AES-256-GCM into `encryptedData` / `encryptedPreviousData`.

This avoids a Vault round-trip on the highest-volume write path. See `audit.prisma:41-63` and `packages/applications/src/services/auditLog/auditLog-encryption.service.ts`.

The 49-column count above only includes `encrypted*` columns. `AuditLog` also has `dekWrapped` and `dekKeyVersion`, which are key-management columns rather than payload ciphertext.

**Important:** the plaintext JSONB columns `data` and `previousData` are still present and still populated. This is covered in §5.

### 3.3 Secrets and credentials

- `GlobalSetting.encryptedValue` — secret setting values are Transit-encrypted; the plaintext `value` column is retained as a dual-read fallback.
- `AiProviderConnection.encryptedApiKey` — provider API key ciphertext; the schema comment says plaintext is never stored.
- `TenantIdentityProvider.encryptedSecretRef` — OIDC client secret ciphertext.
- `WorkflowWebhookSecret.encryptedSecret` — webhook signing secret ciphertext.
- `StorageAccessKey.secretAccessKey` is **not** encrypted and **not** recoverable: it stores a one-way peppered HMAC-SHA256 hash of the issued secret. The real object-store credentials live in Vault (`tenant-bucket.prisma:74-84`).

---

## 4. What is not encrypted

These are deliberate design decisions, not omissions.

### 4.1 Identifiers and demographics

| Field | Why it stays plaintext |
|---|---|
| `User.username` | `@unique` login identifier; exact-match lookup must work |
| `User.externalId` | `@unique` external IdP subject |
| `UserProfile.email` | Indexed contact identifier |
| `Consultation.patientId` | Indexed patient reference |
| `UserProfile.phone` | Demographic PII; outside this initiative |
| `UserProfile.firstName` / `lastName` | Demographic PII; outside this initiative |

Field-encrypting these would break uniqueness constraints and indexed lookups. They are protected by RBAC and, if enabled, disk encryption — not by field encryption.

### 4.2 Other plaintext fields

- `Notification.title` — short label, no ciphertext counterpart.
- `PromptTemplate.content` — the prompt body remains plaintext.
- `NamedEntity` coded fields — `umlsCui`, `snomedCode`, `rxnormCode`, `icdCode`, `loincCode`.
- `UserVoiceProfile.embedding` — pgvector biometric embedding; encryption would break cosine-similarity/diarization search. Protected by RBAC + disk encryption.
- `AuditLog.data` / `previousData` — plaintext retained for dual-read (see §5).
- `AuditLog.metadata` — ids/flags, explicitly non-PHI.
- `GlobalSetting.value` — plaintext retained for dual-read, including secret rows (see §5).
- Structural data: UUIDs, tenant IDs, foreign keys, timestamps, statuses, counters, hashes, byte sizes, `contentHash`, `contentByteSize`.
- `TranscriptSegment` — structural metadata only; the transcript text lives in the parent `ContextItem.encryptedContent`.
- Audio and media files — not in PostgreSQL at all; they live in MinIO and are intended to be covered by MinIO SSE (unverified), not by database encryption.
- Passwords and API-key digests — one-way hashed, not reversibly encrypted.

---

## 5. Dual-write exceptions: "encrypted column" does not always mean "ciphertext only"

Three places retain plaintext alongside ciphertext. This matters when answering "is the data encrypted?" because a database dump will contain both.

### 5.1 `AuditLog.data` / `previousData`

New rows get envelope-encrypted `encryptedData` / `encryptedPreviousData`, but the plaintext JSONB columns are still written. The schema comment calls this a dual-read soak; `TASK-369` records that `AuditLog` plaintext was intentionally retained and that `list`/`export` paths still read it.

Implication: audit payloads are **not** ciphertext-only. A leaked dump exposes them.

### 5.2 `GlobalSetting.value`

Secret settings are encrypted into `encryptedValue`, but the plaintext `value` column is deliberately retained as a fallback. If Vault/Transit is unavailable when a value changes, the service clears the stale ciphertext and writes the fresh plaintext instead.

Implication: a leaked dump may expose secret setting values in plaintext until the `value` column is dropped.

### 5.3 WORM history

`HarnessAuditEvent` and `HarnessPolicyChange` encrypt new payloads before insert and write a non-PHI sentinel (`{ "_encrypted": true }`) into the immutable plaintext column. Historical rows predate encryption and remain plaintext because the tables are append-only (`UPDATE`/`DELETE` revoked).

Implication: new WORM rows are protected; old rows are not, and they cannot be rewritten in place.

---

## 6. Disk, backups, and transport

### 6.1 Disk encryption

The intended compliance floor is LUKS/dm-crypt on the PostgreSQL data and WAL volumes, plus Redis.

Evidence:

- `infrastructure/docker/docker-compose.yml:27-33` says dev relies on host full-disk encryption (macOS FileVault / Linux LUKS) and that production data+WAL volumes sit on LUKS/dm-crypt.
- The runbook `docs/research/deployments/encryption-at-rest-luks-minio-sse-runbook.md` is marked **UNVERIFIED** (as of 2026-08-07). It states that LUKS is not confirmed enabled in live-state audits and that MinIO SSE and pgBackRest AES-256-CBC are specified but have no live-deployment evidence.

This is the layer that protects the **plaintext** columns. If LUKS is not actually enabled on the host, a stolen disk or VM snapshot exposes identifiers, demographics, `Notification.title`, prompt bodies, `AuditLog` payloads, and `GlobalSetting.value`.

### 6.2 Backups and object storage

- pgBackRest repository cipher `aes-256-cbc` is specified with a Vault-managed passphrase. No live evidence of deployment was found.
- MinIO server-side encryption (SSE) for recordings, generated audio, documents, and backups is described as a manual `mc encrypt set sse-s3 ...` action; the compose file has it commented out.
- A **logical** backup (`pg_dump`) bypasses disk encryption by design. It contains ciphertext for encrypted columns and plaintext for everything else.

### 6.3 Transport

- Production deployment docs use `DATABASE_URL=...?sslmode=require` (`docs/research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md`).
- The sample development URL in `.env.sample:75` has no `sslmode`.
- This is transport encryption, not at-rest encryption, but it belongs in the same threat model.

---

## 7. Threat model: what this protects and what it does not

| Threat | Protection |
|---|---|
| Stolen disk / VM snapshot | Clinical free-text PHI is ciphertext; plaintext columns are protected only if LUKS is enabled |
| Leaked logical dump (`pg_dump`) | Encrypted PHI columns stay ciphertext; identifiers, demographics, audit payloads, and global-setting values are readable |
| Malicious DBA / read-only DB credentials | Cannot read encrypted PHI without Vault capability; can read all plaintext columns |
| SQL injection that only reads the database | Same as above; ciphertext is not useful without Vault |
| Compromised API node | **Not protected.** The node has Vault credentials and decrypts on read; field encryption is not a defense against a live application compromise |
| Stolen backup archive | Protected only if pgBackRest cipher / MinIO SSE were actually enabled |
| Network sniffing | Protected only if TLS is enforced (`sslmode=require` or stronger) |

Field encryption is specifically a defense against **data-at-rest disclosure** — a dumped table, a stolen disk, a backup file, or a DBA reading rows. It is not a substitute for access control, TLS, or host hardening.

---

## 8. Environment and migration caveats

1. **Vault is a hard runtime dependency for PHI reads/writes.**
   - `.env.sample:87` defaults to `SECRETS_PROVIDER=vault`.
   - `infrastructure/docker/README.md:50-56` says the sample ships Vault as the default; `.env.dev` also defaults to Vault.
   - With any non-Vault provider, PHI writes soft-no-op and the fields are unpersisted. Reads do not decrypt because the repository wrap is not installed.

2. **Fail-closed applies to the per-field PHI write path, not every encrypted path.**
   - `encryptPhiFields()` throws under `SECRETS_PROVIDER=vault` when secrets are missing or encryption fails.
   - `AuditLog` encryption, WORM encryption, and `GlobalSetting` secret encryption are best-effort by design and have plaintext fallbacks.
   - Do not generalize "fail-closed" to the entire encryption surface.

3. **Phase 6 was recorded as applied in dev, not staging/prod.**
   - `TASK-369` status is **Review**; the Phase 6 plaintext-column drop is recorded as dev-applied with user approval on 2026-06-19.
   - The committed schema is in the ciphertext-only end state, and the current `init` migration already reflects the dropped columns.
   - Verify the target environment's actual schema (`information_schema`) rather than assuming production matches the repository.

4. **The 30-column Phase 6 migration is not visible by name in the current migration directory.**
   - The current migration history starts at `20260817000000_init`, which already contains the ciphertext-only schema; the named Phase 6 migration is not present in the directory, consistent with a later squash.
   - Check the live schema and `_prisma_migrations`, not just filenames.

5. **Search behavior changed.**
   - Randomized encryption means you cannot use `WHERE encryptedContent = ...` or full-text indexes on those columns.
   - `NamedEntity_text_idx` was dropped.
   - Search must happen on plaintext identifiers/coded fields, or by decrypting and filtering in the application.

---

## 9. How to verify (read-only)

### 9.1 Confirm the schema has ciphertext and no plaintext twin

```sql
-- Should show encryptedContent (bytea), contentKeyVersion (int),
-- and NO column named content.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'core'
  AND table_name = 'ContextItem'
ORDER BY ordinal_position;
```

```sql
-- Inventory of encrypted columns by table.
SELECT table_name, count(*) AS encrypted_columns
FROM information_schema.columns
WHERE table_schema = 'core'
  AND column_name LIKE 'encrypted%'
GROUP BY table_name
ORDER BY table_name;
```

### 9.2 Confirm values are ciphertext, not plaintext

```sql
-- Safe: reports sizes and key versions, not content.
SELECT id,
       octet_length("encryptedContent") AS ciphertext_bytes,
       "contentKeyVersion"
FROM "ContextItem"
WHERE "encryptedContent" IS NOT NULL
LIMIT 5;
```

Do not `SELECT` and print decrypted PHI in a shared terminal or ticket.

### 9.3 Confirm the dual-write exceptions

```sql
-- Expect has_ciphertext = true AND has_plaintext = true
-- on recent AuditLog rows.
SELECT id,
       "encryptedData" IS NOT NULL AS has_ciphertext,
       data IS NOT NULL          AS has_plaintext
FROM "AuditLog"
ORDER BY "createdAt" DESC
LIMIT 5;
```

```sql
-- Expect has_ciphertext = true AND has_plaintext = true
-- for secret settings, until the legacy value column is dropped.
SELECT key,
       "encryptedValue" IS NOT NULL AS has_ciphertext,
       value <> ''                  AS has_plaintext
FROM "GlobalSetting"
WHERE "encryptedValue" IS NOT NULL
LIMIT 5;
```

### 9.4 Confirm the process is in Vault mode

```bash
# On the API host / container. Do not print secret values.
test -n "$SECRETS_PROVIDER" && echo "SECRETS_PROVIDER=$SECRETS_PROVIDER"
test -n "$VAULT_ADDR" && echo "VAULT_ADDR=$VAULT_ADDR"
test -n "$VAULT_ROLE_ID" && echo "VAULT_ROLE_ID=set"
test -n "$VAULT_SECRET_ID" && echo "VAULT_SECRET_ID=set"
test -n "$VAULT_WRAPPED_SECRET_ID" && echo "VAULT_WRAPPED_SECRET_ID=set"
```

`SECRETS_PROVIDER` must be `vault` for PHI reads/writes to work as designed.

### 9.5 Confirm disk encryption on the host

These commands require host/VM root access and are **not** something the repository can prove:

```bash
lsblk -f
findmnt -T /var/lib/postgresql
sudo cryptsetup status <mapped-device>
sudo dmsetup table              # no --showkeys; do not print key material
```

For backups:

```bash
sudo -u postgres pgbackrest info
# Check the repository cipher type in pgbackrest.conf:
grep -E 'repo[0-9]+-cipher-type|repo-cipher-type' /etc/pgbackrest/pgbackrest.conf
```

For MinIO SSE, use the MinIO client's encryption-info command against a known object; do not download PHI.

---

## 10. Evidence index

| File | What it proves |
|---|---|
| `packages/domains/src/common/field-encryption.ts` | `hope-phi` key name, `vault:vN:` format, ciphertext/key-version primitives |
| `packages/domains/src/common/phi-read-decrypt.ts` | Global registry, model-scoped columns, delegate wrap, batch decrypt |
| `packages/applications/src/common/phi-field-encryption.ts` | Fail-closed write policy; dev/test soft no-op |
| `packages/applications/src/services/baseServices/_meta/secrets/secrets.module.ts` | `setPhiReadSecrets()` only when the provider supports Transit |
| `packages/database/src/prisma/db_main/consultation.prisma` | `ContextItem.encryptedContent`; plaintext `content` dropped; `TranscriptSegment` has no text |
| `packages/database/src/prisma/db_main/audit.prisma` | AuditLog envelope columns and retained plaintext |
| `packages/applications/src/services/auditLog/auditLog-encryption.service.ts` | Per-process DEK, Vault-wrapped, local AES-256-GCM |
| `packages/database/src/prisma/db_main/globalSetting.prisma` | `encryptedValue` plus retained `value` |
| `packages/applications/src/services/globalSetting/globalSetting.service.ts` | Secret write path; plaintext fallback retained |
| `packages/database/src/prisma/db_main/tenant-bucket.prisma` | `StorageAccessKey.secretAccessKey` is a one-way HMAC, not ciphertext |
| `packages/database/src/prisma/db_main/ai-provider-connection.prisma` | `encryptedApiKey`; plaintext never stored |
| `packages/database/src/prisma/db_main/identity-provider.prisma` | `encryptedSecretRef` Transit ciphertext |
| `packages/database/src/prisma/db_main/workflow-webhook.prisma` | `encryptedSecret` ciphertext |
| `docs/archive/TASK-369-Data-Encryption/README.md` | Authoritative inventory, Phase 6 scope, retained plaintext, fail-closed policy |
| `docs/research/deployments/encryption-at-rest-luks-minio-sse-runbook.md` | LUKS/MinIO SSE/pgBackRest are **UNVERIFIED** |
| `infrastructure/docker/docker-compose.yml` | Production volumes expected on LUKS; MinIO SSE commented out |
| `.env.sample` | `SECRETS_PROVIDER=vault` default; dev DB URL has no `sslmode` |
| `infrastructure/docker/README.md` | Vault is the default secrets provider; `.env.dev` also defaults to Vault |

---

## Appendix A — Encrypted column inventory

### A.1 Free-text PHI in the global decrypt registry (32 columns / 16 models)

| Model | Encrypted columns |
|---|---|
| `ContextItem` | `encryptedContent` |
| `ContextItemVersion` | `encryptedChangeSummary`, `encryptedContent`, `encryptedContentDiff`, `encryptedFieldChanges` |
| `Highlight` | `encryptedExact`, `encryptedNote`, `encryptedPrefix`, `encryptedSuffix` |
| `NamedEntity` | `encryptedMetadata`, `encryptedNormalizedText`, `encryptedText` |
| `SummaryMeta` | `encryptedCitationsMap`, `encryptedGuardrailDecisions` |
| `TranscriptionJob` | `encryptedResultMetadata`, `encryptedResultText` |
| `GoldenCase` | `encryptedReferenceNote`, `encryptedTranscript` |
| `EvalRun` | `encryptedNotes` |
| `EvalScore` | `encryptedDetails`, `encryptedRationale` |
| `DnaWritingStyleReport` | `encryptedReportData`, `encryptedStyleText` |
| `DnaWritingStyleVersion` | `encryptedReportData`, `encryptedStyleText` |
| `KnowledgeChunk` | `encryptedText` |
| `Notification` | `encryptedMessageContent`, `encryptedMessageRichText`, `encryptedMessageText` |
| `PromptTemplate` | `encryptedLastTestOutput` |
| `DocumentSection` | `encryptedContent` |
| `WorkflowTestFixture` | `encryptedInput` |

> `SummaryMeta`, `DnaWritingStyleReport`, and `DnaWritingStyleVersion` also have encrypted columns on explicit read paths; those are listed in A.2.

### A.2 Additional PHI columns on explicit paths (7 columns)

| Model | Encrypted columns | Notes |
|---|---|---|
| `ConsultationAttachment` | `encryptedFileName` | Decrypted by the attachment service |
| `ConsultationFeedback` | `encryptedComment` | Decrypted on the feedback read path |
| `GuardrailEvaluation` | `encryptedWithheldContent` | Admin review route only |
| `DnaWritingStyleReport` | `encryptedRedactionRules` | Explicit DNA read path |
| `DnaWritingStyleVersion` | `encryptedRedactionRules` | Explicit DNA read path |
| `SummaryMeta` | `encryptedCoverageReport`, `encryptedRedactionManifest` | Explicit summary read path |

### A.3 WORM payloads (4 columns / 2 models)

| Model | Encrypted columns |
|---|---|
| `HarnessAuditEvent` | `encryptedCitations`, `encryptedSensorScores` |
| `HarnessPolicyChange` | `encryptedAfterJson`, `encryptedBeforeJson` |

### A.4 Audit and secrets (6 columns / 5 models)

| Model | Encrypted columns | Notes |
|---|---|---|
| `AuditLog` | `encryptedData`, `encryptedPreviousData` | Envelope AES-256-GCM under a Vault-wrapped DEK; plaintext retained |
| `GlobalSetting` | `encryptedValue` | Plaintext `value` retained |
| `AiProviderConnection` | `encryptedApiKey` | No plaintext key column |
| `TenantIdentityProvider` | `encryptedSecretRef` | OIDC client secret ciphertext |
| `WorkflowWebhookSecret` | `encryptedSecret` | Webhook signing secret ciphertext |

---

## Appendix B — Quick answers

**Is the whole PostgreSQL database encrypted?**
No. There is no TDE or database-side encryption. Only selected columns contain application-produced ciphertext.

**Are clinical transcripts and notes encrypted?**
Yes. `ContextItem.content` is ciphertext-only, and transcript text lives there. `TranscriptionJob` result text is also encrypted.

**Are patient identifiers encrypted?**
No. `Consultation.patientId`, `UserProfile.email`, `User.username`, `User.externalId`, names, and phone are plaintext by design.

**Are audit logs encrypted?**
New rows have an encrypted envelope copy, but the plaintext JSONB columns are still populated. Treat audit payloads as plaintext unless the plaintext columns are dropped.

**Are backups encrypted?**
Specified (pgBackRest AES-256-CBC, MinIO SSE), but not verified in the repo. Check the live configuration.

**Is the data encrypted on disk?**
Only if LUKS/dm-crypt is actually enabled on the PostgreSQL volume. The runbook marks this unverified.

**Does field encryption stop a compromised API server?**
No. The API has Vault access and decrypts on read. It protects data at rest, not a live application compromise.
