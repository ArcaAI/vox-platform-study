# Section D — Audit-Log Backfill Proposal

**Status**: PROPOSED — DO NOT EXECUTE WITHOUT USER APPROVAL  
**Risk**: Workspace rule forbids `DELETE` / `DROP` / `TRUNCATE` without explicit approval.  
**Owner / approver**: HOPE platform DBA + on-call security lead.  
**Related**: Phase 0 Item 4 (TASK-302 Stream A), TASK-301 §P0-6.

---

## Problem

`AuditLog` rows persisted **before** Phase 0 Item 4 was deployed may contain plaintext `value` and `defaultValue` for locked `GlobalSetting` rows (e.g., `JWT_SECRET_KEY`, `AZURE_OPENAI_API_KEY`, `SMR_V2_AZURE_API_KEY`). HIPAA audit retention is 6+ years; these rows persist in primary storage, backups, and SIEM mirrors even after the Item 4 scrubber starts redacting new writes.

This document captures the SQL needed to retroactively scrub these rows in **primary storage only**. Backup and SIEM-mirror remediation is out of scope (see *Out of scope* below).

---

## Scope (read-only probe)

Run this first to enumerate the affected rows and confirm the population size before deciding whether to proceed with the mitigation:

```sql
-- Identify affected rows. SAFE — read-only.
-- Replace <PHASE_0_DEPLOY_TIMESTAMP> with the actual production deploy
-- timestamp of the D.4 commit (see git log for `feat(applications):
-- scrub @Secret fields from SysEvent for locked rows`).
SELECT
  al.id,
  al."resourceId",
  al."createdAt",
  gs.key
FROM "core"."AuditLog" al
LEFT JOIN "core"."GlobalSetting" gs ON gs.id = al."resourceId"
WHERE al."resourceType" = 'GlobalSetting'
  AND gs."locked" = true
  AND al."createdAt" < '<PHASE_0_DEPLOY_TIMESTAMP>'
ORDER BY al."createdAt" DESC;
```

Expected output: a list of `(id, resourceId, createdAt, key)` tuples — one row per audit event that captured a locked-row mutation. Sanity check before approving the mitigation:

- Row count is bounded by the number of `locked === true` settings × the number of historical updates per setting.
- Every `key` should be one of the known platform secrets (JWT, Azure, SMR, etc.).
- Every `createdAt` should precede the D.4 deploy timestamp.

---

## Proposed mitigation (requires user approval before executing)

### Option A (preferred — surgical `UPDATE`, no row deletion)

```sql
-- AWAITS USER APPROVAL.
-- Replaces value/defaultValue inside the JSONB payload with '[REDACTED]'
-- for rows that match the scope query. Preserves all other audit fields
-- (resourceId, actor, IP, timestamps) for compliance continuity.
UPDATE "core"."AuditLog"
SET "data" = "data"
  || jsonb_build_object(
       'value', '[REDACTED]',
       'defaultValue', '[REDACTED]'
     )
WHERE id IN (
  SELECT al.id
    FROM "core"."AuditLog" al
    LEFT JOIN "core"."GlobalSetting" gs ON gs.id = al."resourceId"
    WHERE al."resourceType" = 'GlobalSetting'
      AND gs."locked" = true
      AND al."createdAt" < '<PHASE_0_DEPLOY_TIMESTAMP>'
);
```

Notes:

- `data || jsonb_build_object(...)` is an upsert-on-existing JSONB operation; the target keys (`value`, `defaultValue`) are overwritten in-place. Other keys in `data` are preserved unchanged.
- The `WHERE id IN (...)` clause is materialised first (PostgreSQL plans this as a NestLoop/HashSemiJoin against the scope subquery). Confirm with `EXPLAIN` in staging before running in production.
- Run inside an explicit transaction:

  ```sql
  BEGIN;
  -- (paste the UPDATE here)
  -- Confirm: SELECT count(*) FROM "core"."AuditLog" WHERE ...
  COMMIT; -- or ROLLBACK if the count is off
  ```

### Option B (deprecated): `DELETE` affected rows

**Forbidden by workspace rule.** Documented here only so reviewers know it was considered and explicitly rejected. Deleting audit rows breaks HIPAA retention and destroys forensic evidence of pre-Item-4 mutations.

---

## Rollback

`UPDATE` on a JSONB column is destructive (the original `value` / `defaultValue` are not preserved by the operation itself). Before running Option A in production, take a logical backup of the affected rows so the transformation is reversible if a downstream consumer turns out to depend on the cleartext (e.g., a forensic investigation already in flight):

```sql
-- Pre-backup (run BEFORE the UPDATE)
CREATE TABLE IF NOT EXISTS "core"."AuditLog_phase0_backup_2026Q2" AS
SELECT al.*
FROM "core"."AuditLog" al
LEFT JOIN "core"."GlobalSetting" gs ON gs.id = al."resourceId"
WHERE al."resourceType" = 'GlobalSetting'
  AND gs."locked" = true
  AND al."createdAt" < '<PHASE_0_DEPLOY_TIMESTAMP>';
```

The backup table is itself a sensitive surface — restrict access to the `dba` role only, and schedule a separate cleanup (e.g., 90 days) after the Item-4 deployment has stabilised.

---

## Out of scope

- **Database backups**: nightly snapshots taken before the D.4 deploy retain the unscrubbed audit rows. The org-wide incident response (per the JWT rotation runbook in `_section-a-rotation-log.md`) should treat these as a separate retention surface — typical approach is to either accelerate the natural backup-retention rollover or schedule a one-shot scrub job on the backup target.
- **SIEM mirrors / log ship targets** (Datadog, Splunk, etc.): same caveat — the secrets that hit these surfaces before D.4 may need a vendor-specific scrub request.
- **Read replicas**: a regular `UPDATE` on the primary propagates through replication. No additional action needed beyond confirming replication lag is healthy before approving.

---

## Approval workflow

1. Run the read-only probe in production, paste the row count + sample into this proposal as a new appendix.
2. DBA + security lead sign off in writing (Slack thread linked to the appendix).
3. Schedule a maintenance window — the `UPDATE` itself completes in seconds even for thousands of rows, but the explicit `BEGIN / COMMIT` pattern + backup table creation needs a 15-minute change window to be safe.
4. Run Option A's transaction.
5. Re-run the read-only probe — expect zero rows (`gs.locked = true AND al.createdAt < deploy` should still match, but the JSONB payload now has `[REDACTED]`; if you want to enumerate only un-scrubbed rows, add `AND al."data" ->> 'value' != '[REDACTED]'`).
6. Update this proposal's *Status* line from `PROPOSED` to `EXECUTED <date>`.

Until step 6 is recorded, treat the proposal as still-pending.
