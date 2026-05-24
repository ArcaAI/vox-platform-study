# TASK-302 Phase 7 Task 7.6 — Env-Var Decommission Proposal

**Status**: PROPOSAL — awaiting user approval before any modification
of production environment files or removal of `.env.dev` fallback
values.
**Phase entry condition**: 7-day production soak (Task 7.5)
**signed off** with no Vault-related P0/P1 incidents.

---

## 1. Purpose

After the production cutover (Tasks 7.3/7.4) and the 7-day soak
(Task 7.5), the env-var copies of every migrated secret are dead
weight. They aren't read in prod (the env provider is disabled), but
they still exist on disk in the systemd unit env file and (for
non-secret config) in `.env.dev`. Phase 7 Task 7.6 is the cleanup.

Because env-var deletion is functionally equivalent to a DELETE-from-
config-store operation (and any rollback that flips the
`SECRETS_PROVIDER` env back to `env` without these values would
hard-crash), this step is **user-gated** per workspace policy.

## 2. Affected files

### 2.1 Production systemd unit (`/etc/systemd/system/hope-api.service`)

**Current** (representative — actual values are on the prod box):

```ini
[Service]
Environment=NODE_ENV=production
Environment=SECRETS_PROVIDER=vault
Environment=VAULT_ADDR=https://vault.production.arcaai.com
Environment=VAULT_ROLE_ID=<role_id_uuid>
EnvironmentFile=/run/hope/vault-wrapped-secret-id

# ⬇ THE BLOCK BELOW IS DEAD WEIGHT AFTER VAULT CUTOVER ⬇

Environment=JWT_SECRET_KEY=<rotated_value_no_longer_read>
Environment=JWT_REFRESH_SECRET=<rotated_value_no_longer_read>
Environment=SESSION_SECRET_KEY=<rotated_value_no_longer_read>
Environment=API_KEY_PEPPER=<rotated_value_no_longer_read>
Environment=OIDC_CLIENT_SECRET=<rotated_value_no_longer_read>
Environment=SMR_SERVICE_TOKEN=<rotated_value_no_longer_read>
Environment=S3_ACCESS_KEY=<rotated_value_no_longer_read>
Environment=S3_SECRET_KEY=<rotated_value_no_longer_read>
Environment=MINIO_ACCESS_KEY=<rotated_value_no_longer_read>
Environment=MINIO_SECRET_KEY=<rotated_value_no_longer_read>
Environment=MQTT_PASS=<rotated_value_no_longer_read>
Environment=REDIS_PASS=<rotated_value_no_longer_read>
```

**Proposed end-state**:

```ini
[Service]
Environment=NODE_ENV=production
Environment=SECRETS_PROVIDER=vault
Environment=VAULT_ADDR=https://vault.production.arcaai.com
Environment=VAULT_ROLE_ID=<role_id_uuid>
EnvironmentFile=/run/hope/vault-wrapped-secret-id
# Phase 5 DB engine bootstrap (when Stream C lands)
Environment=PG_DYNAMIC_CREDS=true
Environment=PG_HOST=10.10.1.150
Environment=PG_DATABASE=hope_main
```

### 2.2 `.env.dev` (local-development file)

Local development continues to use `SECRETS_PROVIDER=env`, so the
secret env vars MUST remain in `.env.dev` (they're feed for the dev
container; no Vault is required for `pnpm dev`).

**No changes proposed to `.env.dev`** beyond the existing Phase 0
hotfix work. The values must continue to be (a) unique to dev
(never used in staging/prod), (b) covered by `.gitignore`, and (c)
flagged by `.gitleaks.toml` if the dev shape collides with the
production token regex.

### 2.3 `apps/api/.env.production`

This file is committed-but-empty (placeholders). Verify
post-cutover that it contains **only** the bootstrap variables (no
secret values). The grep check in §3 enforces this.

## 3. Verification commands (run by user/SRE post-merge)

```bash
# 1. Production unit must contain no secret-value Environment lines.
ssh hope@prod-vm 'sudo grep -E "^Environment=(JWT_SECRET_KEY|JWT_REFRESH_SECRET|SESSION_SECRET_KEY|API_KEY_PEPPER|OIDC_CLIENT_SECRET|SMR_SERVICE_TOKEN|S3_ACCESS_KEY|S3_SECRET_KEY|MINIO_ACCESS_KEY|MINIO_SECRET_KEY|MQTT_PASS|REDIS_PASS)=" /etc/systemd/system/hope-api.service'
# Expected: NO matches (rc=1)

# 2. Repository grep — verify no committed file under deployment/
#    or infrastructure/single-deployment/ assigns a value to any of
#    the migrated secrets.
git grep -nE '(JWT_SECRET_KEY|SESSION_SECRET_KEY|API_KEY_PEPPER|OIDC_CLIENT_SECRET|SMR_SERVICE_TOKEN|S3_ACCESS_KEY|S3_SECRET_KEY|MQTT_PASS|REDIS_PASS|MINIO_ACCESS_KEY|MINIO_SECRET_KEY)=[A-Za-z0-9]' \
  -- infrastructure/single-deployment/ \
     deployment/ \
     ansible/ \
     k8s/ \
     2>/dev/null || true
# Expected: empty output

# 3. CI gitleaks job still passes.
gitleaks dir --config .gitleaks.toml --no-banner --redact
# Expected: 0 leaks on the production cutover branch
```

## 4. Pre-deletion checklist (operator must check ALL)

- [ ] 7-day prod soak signed off (Task 7.5)
- [ ] Pre-cutover Raft snapshot still available (`pre-cutover.snap`)
      AND a fresh post-soak snapshot exists
- [ ] All 12 secret rows visible via `vault kv metadata get
      secret/hope/<KEY>` with the cutover-date as `created_time`
- [ ] No `apps/api/dist` or `apps/api/build` artefact in
      production cache references the removed env vars
- [ ] On-call engineer notified of the change window
- [ ] Rollback procedure tested in staging: flip
      `SECRETS_PROVIDER=env` on a staging pod and re-introduce one
      `.env`-set secret — does it work without Vault? (validates
      that the env provider still functions as a rollback path)

## 5. Rollback plan

If the post-deletion deploy breaks, the recovery path is:

```bash
# 1. Restore /etc/systemd/system/hope-api.service from the
#    pre-deletion snapshot taken at the start of the deploy.
sudo cp /etc/systemd/system/hope-api.service.preremove \
        /etc/systemd/system/hope-api.service

# 2. Flip SECRETS_PROVIDER back to env (the values are again
#    available because we restored the file in step 1).
sudo sed -i 's|^Environment=SECRETS_PROVIDER=vault|Environment=SECRETS_PROVIDER=env|' \
        /etc/systemd/system/hope-api.service

# 3. Reload and restart.
sudo systemctl daemon-reload
sudo systemctl restart hope-api
```

The pre-cutover Raft snapshot is a separate safety net — it lets
SRE rebuild the Vault cluster to its pre-cutover state if rollback
to env is insufficient (the secret values it contained were the
fresh-rotated ones from Task 7.2, so they're still authoritative).

## 6. Operator approval template

To accept this proposal and proceed with deletion, the operator
should respond with the following (or a substantively equivalent
statement):

```
TASK-302 Task 7.6 — env-var decommission approval

I, <name>, on-call <date>, confirm:
- 7-day prod soak signed off
- Pre-deletion snapshot available at <path>
- Rollback procedure tested in staging
- Notification sent to <distribution list>

APPROVE removal of secret env vars from prod systemd unit.
```

## 7. Out of scope

- `.env.dev` cleanup (local-dev keeps env provider; no changes)
- Stream C's DB-credential env vars (`DATABASE_URL`, etc.) — covered
  by Phase 5 and Stream C's own decommission proposal
- Schema-level cleanup of any DB-stored plaintext (covered by
  Phase 4D's separate user-gated proposal at
  `04-vault-phase-4d-cleanup-proposal.md`)

---

**Decision sought**:  approval to execute §3 commands after the
7-day soak completes and §4 checklist is all green.

**If declined**: leave the env vars in place; document the
trade-off (dead-but-tracked secret values in the systemd unit
mitigated by Vault as the only read path; gitleaks CI catches any
new commits) in `_section-a-rotation-log.md`.
