# Section A — Rotation Log (Phase 0 Item 6)

> **Status**: Skeleton — awaiting operator entries for the actual portal-side rotation events.
>
> **Hard rule**: never paste a raw secret into this log. Only SHA-256 fingerprints (first 16 chars) are recorded.

## Rotation table

| Step | Performed by | Timestamp (UTC) | Old key fingerprint (SHA-256, first 16 chars) | New key fingerprint | Notes |
|---|---|---|---|---|---|
| Azure OpenAI key rotation | `<ops>` | `<ISO-8601>` | `<fp_old>` | `<fp_new>` | Old key revoked in Azure portal |
| SMR Azure key rotation | `<ops>` | `<ISO-8601>` | `<fp_old>` | `<fp_new>` | Old key revoked in Azure portal |
| JWT_SECRET_KEY rotation (staging) | `<ops>` | `<ISO-8601>` | `<fp_old>` | `<fp_new>` | env-store updated; pods restarted |
| JWT_SECRET_KEY rotation (production) | `<ops>` | `<ISO-8601>` | `<fp_old>` | `<fp_new>` | env-store updated; pods restarted; old refresh tokens expired |

## Communications block (Slack `#engineering`, copy/paste record)

- **Pre-cutover announcement**: `<link>`
- **In-cutover status**: `<link>`
- **Post-cutover all-clear**: `<link>`

### Pre-cutover announcement template

```text
:rotating_light: TASK-302 Phase 0 Item 6 — credential rotation window opening in 10 minutes.

What is changing:
  • Azure OpenAI API key (alaas-openai resource)
  • SMR Azure API key
  • JWT_SECRET_KEY (staging + production)

Impact:
  • All currently-issued user sessions will be invalidated after JWT rotation.
  • Users will be required to re-authenticate within the next JWT_REFRESH_EXPIRES_IN window.
  • SMR / NLP pipelines using the rotated Azure key will briefly fail (≤5 min) until pods reload.

Roll-back: rotation cannot be reverted. New keys are persisted to the env-store before old keys are revoked.

Window: <ISO-8601 start>  →  <ISO-8601 +30min>
Owner: <ops-on-call>
```

### Post-cutover all-clear template

```text
:white_check_mark: TASK-302 Phase 0 Item 6 — rotation window complete.

Status:
  • Azure OpenAI key rotated, revoked old key. Fingerprint logged.
  • SMR Azure key rotated, revoked old key. Fingerprint logged.
  • JWT_SECRET_KEY rotated in staging + prod. Pods rolled. Sample sessions verified invalid.

Next: gitleaks pre-commit hook now active for every developer on next `pnpm install`.
```

## Manual operator runbook

```bash
# In Azure portal:
# 1. Navigate to Azure OpenAI resource → Keys and Endpoint
# 2. Click "Regenerate Key 1"
# 3. Confirm — note the new value into a secrets manager
# 4. After 5 minutes (allow downstream caches to drain), revoke the OLD key
#
# Repeat for SMR Azure resource keys.

# Fingerprint computation (operator's private terminal only):
echo -n "<new-key-here>" | shasum -a 256 | cut -c1-16
#   → record into the table above; never log the raw value.
```

## JWT cutover sub-runbook

```bash
# 1. Generate a new 64-byte hex secret on a trusted host:
openssl rand -hex 64

# 2. Push the new value to the staging env-store (e.g., kubectl create secret …).
# 3. Roll the staging API pods:
kubectl rollout restart deploy/hope-api -n staging
# 4. Sample three previously-valid sessions; confirm Authorization rejected.
# 5. Repeat for production with a 30-minute soak between steps 3 and 5.
```

## Section E — Staging duplicate-key smoke (Phase 0 Item 5, Task E.4)

> **Status**: PROPOSED — awaits execution by `database-admin` against staging during the Phase 0 deploy window.

The E.2 invariant (`AppSettingsService.cacheAppSettings`) only earns its keep if a real staging boot has been observed to refuse a primed-duplicate row. The probe and smoke below are additive (`SELECT` + `INSERT` + soft-delete `UPDATE`) and per workspace rule contain **no** `DELETE` / `DROP` / `TRUNCATE`.

### 1. Prime the duplicate (staging DB)

```sql
-- Phase 0 Item 5 staging primer (read-only verification + additive INSERT).
BEGIN;

SELECT id, key, "tenantId"
  FROM "core"."GlobalSetting"
  WHERE key = 'crypto.saltRounds'
    AND "tenantId" = '50000000-0000-0000-0000-000000000000';

INSERT INTO "core"."GlobalSetting"
  ("id", "tenantId", "key", "name", "value", "defaultValue", "dataType",
   "namespace", "description", "locked", "version", "resourceStatus",
   "createdAt", "updatedAt", "createdBy", "updatedBy")
VALUES
  ('11111111-aaaa-bbbb-cccc-dddddddddddd',
   '50000000-0000-0000-0000-000000000000',
   'crypto.saltRounds', 'crypto.saltRounds DUPLICATE',
   '12', '10', 'Integer', 'com.flw.crypto', 'Phase 0 Item 5 smoke',
   false, 1, 'ENABLED', now(), now(), NULL, NULL);

SELECT count(*)
  FROM "core"."GlobalSetting"
  WHERE key = 'crypto.saltRounds'
    AND "tenantId" = '50000000-0000-0000-0000-000000000000';

COMMIT;
```

### 2. Roll the staging API and observe refusal

```bash
kubectl rollout restart deploy/hope-api -n staging
kubectl logs -n staging -l app=hope-api --tail=120 | grep -i 'duplicate platform key'
# Expected line in logs:
#   Error: Phase 0 Item 5 (TASK-302): duplicate platform key(s) detected
#          — crypto.saltRounds (2 rows). Refuse to start.
# Expected pod state: CrashLoopBackOff (non-zero exit).
```

Record the timestamp + pod name in the table below.

### 3. Cleanup (soft-delete only — never `DELETE`)

```sql
-- Mark the primer row as logically gone. Restores normal boot.
UPDATE "core"."GlobalSetting"
  SET "resourceStatus" = 'DELETED', "updatedAt" = now()
WHERE id = '11111111-aaaa-bbbb-cccc-dddddddddddd';
```

### 4. Confirm boot succeeds

```bash
kubectl rollout restart deploy/hope-api -n staging
# Expected: pod Ready within the normal startup window;
#   logs include: AppSettingsService Service initialized
```

### Smoke result table (operator fills in)

| Step | Executed by | Timestamp (UTC) | Pod name | Log evidence (sanitised) |
|---|---|---|---|---|
| 1 — Prime duplicate | `<ops>` | `<ISO-8601>` | n/a | `count = 2` |
| 2 — Observe refusal | `<ops>` | `<ISO-8601>` | `<pod>` | `Phase 0 Item 5 (TASK-302): duplicate platform key(s) detected — crypto.saltRounds (2 rows). Refuse to start.` |
| 3 — Soft-delete primer | `<ops>` | `<ISO-8601>` | n/a | `1 row updated` |
| 4 — Confirm clean boot | `<ops>` | `<ISO-8601>` | `<pod>` | `AppSettingsService Service initialized` |

## Section F.3 — Production deploy verification checklist

> **Status**: PROPOSED — awaits execution by `git-manager` + `database-admin` + on-call security lead during the Phase 0 production deploy window.

The Stream A worktree has shipped every Phase 0 code/config change. The remaining work is operational: deploying the merged branch, executing the rotation, and ticking the TASK-301 §Phase 0 exit-criteria boxes against real production evidence.

### Pre-deploy

- [ ] All Section A/B/C/D/E commits merged into `fix/2605-review` and then into `dev`.
- [ ] CI green on `dev` for the merge commit — note pipeline URL.
- [ ] Slack #engineering notified of the production deploy window (use *Pre-cutover announcement template* above).
- [ ] On-call security lead has acknowledged the deploy in Slack thread.

### Deploy

- [ ] Deploy to **staging**.
- [ ] Run `pnpm test:e2e -- phase-0-redteam` against the staging URL — paste the trailing summary block into this log.
- [ ] Execute Section E staging duplicate-key smoke (table above) — record evidence in the smoke result table.
- [ ] Deploy to **production**.
- [ ] Within 5 minutes of production deploy, rotate `JWT_SECRET_KEY` in the production env-store and roll the pods (use *JWT cutover sub-runbook* above).
- [ ] Record the new JWT fingerprint in the rotation table at the top of this document.
- [ ] Sample 3 user sessions issued before rotation — confirm refresh tokens are rejected within `JWT_REFRESH_EXPIRES_IN`. Record sanitised user-id fingerprints (not raw IDs).

### Post-deploy

- [ ] Run `gitleaks detect --source . --config .gitleaks.toml --no-banner --redact` against the deployed branch — expect `no leaks found`. Paste the trailing summary line.
- [ ] Execute the AuditLog SQL probe documented in `_section-d-backfill-proposal.md` (*Scope read-only probe*) with `<PHASE_0_DEPLOY_TIMESTAMP>` set to the production deploy ISO timestamp. Paste a sanitised count + sample (no secrets).
- [ ] Confirm production API boot logs contain:
  - `AppSettingsService Service initialized` (no Phase 0 Item 5 duplicate-key error).
  - The boot-time admin route audit summary line (Phase 0 Item 3 — no offenders listed; if the audit added a summary log line, capture it here).
- [ ] (Optional, recommended) Run the Section D backfill probe — if non-zero, surface for user approval per `_section-d-backfill-proposal.md`.

### Sign-off

| Role | Signer | Timestamp (UTC) | Notes |
|---|---|---|---|
| On-call security lead | `<name>` | `<ISO-8601>` | |
| DBA | `<name>` | `<ISO-8601>` | |
| Platform engineer | `<name>` | `<ISO-8601>` | |

Once every box above is ticked and every signer has signed, follow Task F.4 — flip `docs/implementation/TASK-301-System-Config-Multi-Tenancy-Assessment/README.md` §Phase 0 status to `Completed (YYYY-MM-DD)` and update the exit-criteria checklist with evidence URLs.

## Out of scope

- Backups and SIEM mirrors: see Section D backfill proposal (`_section-d-backfill-proposal.md`).
- Rotation of any non-Azure / non-JWT credential is **not** in Phase 0 scope (Stream B Vault handles those).
