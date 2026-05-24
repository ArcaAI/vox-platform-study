# TASK-302 Phase 4D — Plaintext seed cleanup proposal (USER-GATED)

**Ticket**: TASK-302 (Stream B — Vault Migration)
**Phase**: 4D — Remove plaintext seed rows and DB values for migrated secrets
**Status**: **PROPOSAL — DO NOT EXECUTE WITHOUT USER APPROVAL**
**Author**: Stream B executor (autonomous agent)
**Created**: 2026-05-25

---

## STOP — Workspace policy

> "When working with any SQL and Database, you are NOT allowed to
> execute any DELETE or DROP or TRUNCATE statement/query. You must
> confirm with me and get the approval from me for those dangerous
> statement/query."  — workspace user rule

This document is the proposal that the agent presents to the human
before any destructive action runs. **No part of this proposal may be
executed by an agent autonomously.** Both the `git rm` of the seed
rows and the SQL `UPDATE … SET value=NULL` / `DELETE` statements are
strictly user-gated.

---

## 1. Background and entry criteria

After Phase 4C the application:

- Writes secrets into `GlobalSetting.encryptedValue` via Vault Transit
  whenever the row is `locked = true` (backfill script in
  `packages/database/scripts/backfill-globalsetting-encryption.ts`).
- Reads through `GlobalSettingRepository.findByIdWithDecryptedValue`
  which prefers `encryptedValue` when present and falls back to the
  legacy plaintext `value` otherwise (one-release legacy bridge).
- Scrubs both `value` and `encryptedValue` from SysEvent audit logs
  for `locked` rows via `scrubLockedForAudit`.

Phase 4C deliberately **leaves `value` untouched on encrypted rows**
so the system can dual-read for one release. Phase 4D removes the
plaintext residue. Two surfaces need cleanup:

1. **Seed code** — `packages/database/src/prisma/db_main/seed/06-stt.ts`
   still ships `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` as plaintext
   `process.env` fallbacks. New tenants seeded after the cutover
   would re-introduce plaintext values without this fix.
2. **Database state** — existing rows still carry plaintext `value`
   even after encryption. A `UPDATE … SET value = NULL` (or `DELETE`
   of legacy keys entirely) is required to flush them.

### Pre-deletion checklist (all must be ✅ before user approves)

- [ ] **Phase 7 cutover signed off in staging**: SECRETS_PROVIDER=vault
      is the active provider in staging for >=24h with zero rollback
      events.
- [ ] **One-release dual-read soak completed**: staging has run with
      both encryptedValue + value populated for >=1 release cycle,
      proving the application never reaches the legacy `value`
      fallback in steady-state operation.
- [ ] **Fresh database snapshot taken** immediately before the
      destructive UPDATE/DELETE. Snapshot label:
      `pre-task302-phase4d-cleanup-YYYYMMDD`.
- [ ] **Staging dry-run executed** with the proposed SQL (sections 3
      and 4 below) wrapped in a transaction that is rolled back.
      Row counts captured and attached to the user approval ping.
- [ ] **All known consumers verified** via grep against the affected
      keys, confirming no code path still reads `.value` for a
      migrated key (the Phase 3 coverage-check test pins this).

---

## 2. Affected secrets (canonical list)

The following keys have been migrated to SecretsService → Vault during
Phase 3. After cutover, their `GlobalSetting.value` (and the seed
fallbacks where applicable) become legacy material that should be
flushed.

| Key                  | Phase 3 site                                                                       | Seed file fallback?   |
|----------------------|------------------------------------------------------------------------------------|-----------------------|
| `JWT_SECRET_KEY`     | `packages/applications/src/services/auth/{gateway-auth,jwt,oidc}.strategy.ts`      | No (env-only)         |
| `OIDC_CLIENT_SECRET` | `packages/applications/src/services/auth/auth.service.module.ts`                   | No (env-only)         |
| `API_KEY_PEPPER`     | `packages/applications/src/services/apiKey/apikey.service.ts`                      | No (env-only)         |
| `SESSION_SECRET_KEY` | `apps/api/src/main.ts`                                                             | No (env-only)         |
| `SMR_SERVICE_TOKEN`  | 8 sites (summary/chain-summary/processors/base-proxy/smr-proxy)                    | No (env-only)         |
| `S3_ACCESS_KEY`      | `packages/applications/src/services/baseServices/storage/s3/s3.service.ts`         | **YES — seed/06-stt.ts:1696** |
| `S3_SECRET_KEY`      | `packages/applications/src/services/baseServices/storage/s3/s3.service.ts`         | **YES — seed/06-stt.ts:1707** |
| `MQTT_PASS`          | `packages/applications/src/services/baseServices/_meta/config/config.service.ts`   | No (env-only fallback inside config.service) |
| `REDIS_PASS`         | `packages/applications/src/services/baseServices/_meta/config/config.service.ts`   | No (env-only fallback inside config.service) |

The only seed file that ships plaintext fallback is `06-stt.ts`. All
other keys live exclusively in `process.env` (legacy) → Vault
(post-Phase-3). The SQL UPDATE in §4 handles the existing rows.

---

## 3. Proposed seed-code change (committable in a separate PR after approval)

Remove the two plaintext entries from `packages/database/src/prisma/db_main/seed/06-stt.ts`:

```typescript
// 06-stt.ts — lines 1691-1712 (current state, to be removed)

    {
        id: '82000000-0000-0000-0003-000000000011',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_ACCESS_KEY',
        value: process.env.MINIO_ACCESS_KEY || 'minio_admin',
        defaultValue: 'minio_admin',
        dataType: ValueType.String,
        description: 'S3 access key',
    },
    {
        id: '82000000-0000-0000-0003-000000000012',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_SECRET_KEY',
        value: process.env.MINIO_SECRET_KEY || 'minio_admin',
        defaultValue: 'minio_admin',
        dataType: ValueType.String,
        description: 'S3 secret key',
    },
```

**Replacement**: leave the `id`s in the seed array but flip them to a
non-secret marker row (the keys still need to exist for the
GlobalSetting lookup to succeed; only the *value* is now sourced from
Vault). Concretely:

```typescript
// Proposed replacement (NOT autonomously applied — present for user review)
    {
        id: '82000000-0000-0000-0003-000000000011',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_ACCESS_KEY',
        value: '', // VAULT-MANAGED: see SecretsService('S3_ACCESS_KEY')
        defaultValue: '',
        locked: true,
        dataType: ValueType.String,
        description: 'S3 access key — value managed by Vault Transit (TASK-302).',
    },
    {
        id: '82000000-0000-0000-0003-000000000012',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_SECRET_KEY',
        value: '',
        defaultValue: '',
        locked: true,
        dataType: ValueType.String,
        description: 'S3 secret key — value managed by Vault Transit (TASK-302).',
    },
```

(`locked: true` ensures the audit-log scrubber redacts these rows
even if a future seed run leaks them, and SecretsService.boot's
warmup will pull the actual value from Vault into the cache.)

---

## 4. Proposed SQL (USER-GATED — DO NOT RUN)

> Run as a single transaction with explicit BEGIN/COMMIT. Apply
> ONLY after the pre-deletion checklist (section 1) is ✅.
> Always have an open `psql` session with `BEGIN` ready and verify the
> row counts before `COMMIT`. Rollback path: see section 6.

### 4A. Update pass — flush plaintext on migrated locked rows (least destructive)

```sql
-- TASK-302 Phase 4D — flush plaintext value for migrated locked secrets.
-- Pre-requisite: each row's encryptedValue is non-null (proves migration
-- happened) and the row is locked (extra guard against accidentally
-- nulling a non-secret config).
--
-- DO NOT RUN AUTONOMOUSLY. USER APPROVAL REQUIRED.

BEGIN;

-- Dry-run check (must report > 0 if there's anything to do; the actual
-- UPDATE uses the same WHERE so the count matches the affected rows).
SELECT COUNT(*) AS rows_to_flush
FROM "core"."GlobalSetting"
WHERE locked = TRUE
  AND "encryptedValue" IS NOT NULL
  AND value <> ''
  AND key IN (
    'JWT_SECRET_KEY',
    'OIDC_CLIENT_SECRET',
    'API_KEY_PEPPER',
    'SESSION_SECRET_KEY',
    'SMR_SERVICE_TOKEN',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'MQTT_PASS',
    'REDIS_PASS'
  );

-- The real UPDATE — replaces plaintext value with empty string.
-- We use empty string rather than NULL because GlobalSetting.value is
-- a NOT NULL column.
UPDATE "core"."GlobalSetting"
SET value = '', "updatedAt" = NOW()
WHERE locked = TRUE
  AND "encryptedValue" IS NOT NULL
  AND value <> ''
  AND key IN (
    'JWT_SECRET_KEY',
    'OIDC_CLIENT_SECRET',
    'API_KEY_PEPPER',
    'SESSION_SECRET_KEY',
    'SMR_SERVICE_TOKEN',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'MQTT_PASS',
    'REDIS_PASS'
  );

-- Verify: every targeted row now has empty value.
SELECT key, tenantId, length(value), "encryptedValue" IS NOT NULL AS migrated
FROM "core"."GlobalSetting"
WHERE locked = TRUE
  AND key IN (
    'JWT_SECRET_KEY',
    'OIDC_CLIENT_SECRET',
    'API_KEY_PEPPER',
    'SESSION_SECRET_KEY',
    'SMR_SERVICE_TOKEN',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'MQTT_PASS',
    'REDIS_PASS'
  );

-- Operator inspects the output. If correct:
COMMIT;
-- otherwise:
-- ROLLBACK;
```

### 4B. (Optional) Delete pass — remove legacy unencrypted rows entirely

This is **strictly stricter** than 4A and only applies to rows that
were never migrated (e.g. orphan rows left over from a stale tenant).
Skip this section unless the operator explicitly requests it after
inspecting the dataset.

```sql
-- TASK-302 Phase 4D OPTIONAL — delete legacy rows that were never
-- migrated to Vault Transit. Only applies to rows whose
-- encryptedValue IS NULL despite being locked = TRUE. These should
-- not exist after Phase 7 cutover, so this query is a safety net.
--
-- DO NOT RUN WITHOUT USER APPROVAL AND A FRESH SNAPSHOT.

BEGIN;

SELECT id, key, tenantId
FROM "core"."GlobalSetting"
WHERE locked = TRUE
  AND "encryptedValue" IS NULL
  AND key IN (
    'JWT_SECRET_KEY',
    'OIDC_CLIENT_SECRET',
    'API_KEY_PEPPER',
    'SESSION_SECRET_KEY',
    'SMR_SERVICE_TOKEN',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'MQTT_PASS',
    'REDIS_PASS'
  );

-- THIS DELETE IS DESTRUCTIVE AND PROHIBITED FOR AUTONOMOUS EXECUTION.
-- DO NOT UNCOMMENT WITHOUT USER APPROVAL.
-- DELETE FROM "core"."GlobalSetting"
-- WHERE locked = TRUE
--   AND "encryptedValue" IS NULL
--   AND key IN (...same list as SELECT above...);

-- ROLLBACK;
```

---

## 5. Operator approval ping (template)

Paste into the user channel along with the staging dry-run output:

> **TASK-302 Phase 4D — request for destructive SQL approval**
>
> Affected rows (staging dry-run): N rows in GlobalSetting where
> locked=TRUE AND encryptedValue IS NOT NULL AND value <> ''.
> Affected keys: JWT_SECRET_KEY, OIDC_CLIENT_SECRET, API_KEY_PEPPER,
> SESSION_SECRET_KEY, SMR_SERVICE_TOKEN, S3_ACCESS_KEY, S3_SECRET_KEY,
> MQTT_PASS, REDIS_PASS.
>
> Proposed action: §4A UPDATE pass against production. ETA <2s.
>
> Rollback: pre-cleanup snapshot `pre-task302-phase4d-cleanup-YYYYMMDD`
> is taken and verified. Restore window: <5 min.
>
> May I proceed?

---

## 6. Rollback plan

If the production UPDATE produces unexpected results:

1. **Immediate**: `ROLLBACK;` the open transaction if not yet
   committed.
2. **Post-commit**: restore the affected rows from the
   pre-cleanup snapshot. The snapshot was taken in section 1's
   pre-deletion checklist; SREs run a partial pg_restore against the
   `core."GlobalSetting"` table only:

   ```bash
   pg_restore --data-only \
              --table=core.GlobalSetting \
              --dbname=hope_main \
              pre-task302-phase4d-cleanup-YYYYMMDD.dump
   ```

3. **Worst case**: the dual-read fallback path
   (`decryptValueFromEntity` → `entity.value`) still functions for
   any row whose `encryptedValue` is present, so even if the UPDATE
   somehow nullified a row that wasn't encrypted, the application
   would not lose access — it would surface a clear "no plaintext
   and no ciphertext" error at the call site. SREs can then
   selectively re-seed.

---

## 7. Sign-off block (filled in at execution time, NOT by agent)

```
Approval requested at:  ____________________ (UTC)
Approval granted by:    ____________________ (name, role)
Approval granted at:    ____________________ (UTC)

Pre-checklist verified: [ ] section 1 all ✅
Snapshot ID:            ____________________
Staging dry-run count:  ____________________

Section 4A executed at: ____________________ (UTC)
Section 4B executed:    [ ] N/A  [ ] yes
Rows actually flushed:  ____________________

Outcome:                [ ] success  [ ] rolled back
Operator signature:     ____________________
```
