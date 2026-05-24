# Section A — Rotation Log (Phase 0 Item 6)

> **Status**: Skeleton — awaiting operator entries for the actual portal-side rotation events.
>
> **Hard rule**: never paste a raw secret into this log. Only SHA-256 fingerprints (first 16 chars) are recorded.

## Rotation table

| Step | Performed by | Timestamp (UTC) | Old key fingerprint (SHA-256, first 16 chars) | New key fingerprint | Notes |
|---|---|---|---|---|---|
| Azure OpenAI key rotation | `<ops>` | `<ISO-8601>` | `<fp_old>` | `<fp_new>` | Old key revoked in Azure portal |
| SMR_V2 Azure key rotation | `<ops>` | `<ISO-8601>` | `<fp_old>` | `<fp_new>` | Old key revoked in Azure portal |
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
  • SMR_V2 Azure API key
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
  • SMR_V2 Azure key rotated, revoked old key. Fingerprint logged.
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
# Repeat for SMR_V2 Azure resource keys.

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

## Out of scope

- Backups and SIEM mirrors: see Section D backfill proposal (`_section-d-backfill-proposal.md`).
- Rotation of any non-Azure / non-JWT credential is **not** in Phase 0 scope (Stream B Vault handles those).
