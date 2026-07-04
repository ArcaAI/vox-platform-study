# TASK-302 Phase 7 — Production Vault Secret Provisioning Runbook

**Document Type**: Operator runbook (SRE-executed; no autonomous agent steps)
**Pre-requisite**: Phases 1–6 of Stream B verified in staging.
**Hard gate**: This runbook is the code-only artefact for Task 7.2.
The actual provisioning is performed by SRE during the production
cutover window (Task 7.4) and **MUST NOT** be executed by any
autonomous agent.

---

## 1. Why a separate provisioning step

The cutover from `SECRETS_PROVIDER=env` to `SECRETS_PROVIDER=vault`
needs every secret that prod reads to **already exist in the Vault
cluster** at the moment we flip the env var. This document describes
the one-shot, fresh-rotation procedure that runs in Vault BEFORE
Task 7.3/7.4 flips the env.

Critically — per Decision D2 of the plan — **the new Vault values
are NOT copies of the existing `.env` values**. The cutover is a
synchronous rotation: a fresh `openssl rand -hex 32` becomes the
new value, and the old `.env` value is dropped at end-of-cutover
(Task 7.6). This ensures any historical `.env` leakage is
neutralised at the same moment the new pathway goes live.

## 2. Secrets to provision

| Vault path | Source value | Used by |
|---|---|---|
| `secret/hope/JWT_SECRET_KEY` | `openssl rand -hex 32` | Authentication (signs/verifies JWTs) |
| `secret/hope/JWT_REFRESH_SECRET` | `openssl rand -hex 32` | Refresh tokens |
| `secret/hope/SESSION_SECRET_KEY` | `openssl rand -hex 32` | Express session middleware |
| `secret/hope/API_KEY_PEPPER` | `openssl rand -hex 32` | API key hashing (**bigger change** — see §4) |
| `secret/hope/OIDC_CLIENT_SECRET` | Provided by IdP | OIDC client (**coordinate with IdP**) |
| `secret/hope/SMR_SERVICE_TOKEN` | `openssl rand -hex 32` | API ↔ SMR Python service authn |
| `secret/hope/S3_ACCESS_KEY` | Provided by S3 IAM | Object storage |
| `secret/hope/S3_SECRET_KEY` | Provided by S3 IAM | Object storage |
| `secret/hope/MINIO_ACCESS_KEY` | Provided by Minio operator | Local-staging object storage |
| `secret/hope/MINIO_SECRET_KEY` | Provided by Minio operator | Local-staging object storage |
| `secret/hope/MQTT_PASS` | Provided by MQTT broker | STT realtime fan-out |
| `secret/hope/REDIS_PASS` | Provided by Redis operator | Cache + Pub/Sub + BullMQ |

Note: PostgreSQL credentials are NOT in this list — they are managed
by Vault's Database secrets engine (Phase 5, gated by Stream C).

## 3. Procedure (run in this exact order)

### 3.1 Pre-flight

```bash
# On the SRE bastion VM with vault-cli installed and authenticated
# under the hope-operator policy (Appendix A.2 of 02-vault-migration.md).
vault status                          # Sealed=false; HA=true; leader=...
vault token lookup -format=json | jq '.data.policies'
                                      # Must include "hope-operator"

# Take a pre-cutover Raft snapshot — this is the rollback artefact.
mkdir -p /var/backups/vault/$(date +%F)
vault operator raft snapshot save \
  /var/backups/vault/$(date +%F)/pre-cutover.snap
```

### 3.2 Write fresh values

For each row in §2, run **exactly one** of the following depending on
the source-value column:

```bash
# Group A — locally-minted random values
for key in JWT_SECRET_KEY JWT_REFRESH_SECRET SESSION_SECRET_KEY \
           API_KEY_PEPPER SMR_SERVICE_TOKEN; do
  vault kv put secret/hope/$key value="$(openssl rand -hex 32)"
done

# Group B — externally-supplied (IdP, IAM, etc.)
# Do NOT pipe these into the shell or set them as env vars before
# the put — paste each as a heredoc to avoid leaving the value in
# the shell history.
vault kv put secret/hope/OIDC_CLIENT_SECRET value=@-<<EOF
<paste secret>
EOF

vault kv put secret/hope/S3_ACCESS_KEY value=@-<<EOF
<paste access key>
EOF

vault kv put secret/hope/S3_SECRET_KEY value=@-<<EOF
<paste secret>
EOF

# repeat for MINIO_*, MQTT_PASS, REDIS_PASS
```

### 3.3 Verify

```bash
# Verify every key landed (kv-v2 metadata read; never the value).
for key in JWT_SECRET_KEY JWT_REFRESH_SECRET SESSION_SECRET_KEY \
           API_KEY_PEPPER OIDC_CLIENT_SECRET SMR_SERVICE_TOKEN \
           S3_ACCESS_KEY S3_SECRET_KEY MINIO_ACCESS_KEY \
           MINIO_SECRET_KEY MQTT_PASS REDIS_PASS; do
  echo "--- $key ---"
  vault kv metadata get secret/hope/$key
done
```

Expected: each call returns `current_version: 1` and a `created_time`
inside the cutover window.

### 3.4 Audit-log confirmation

```bash
# The Vault audit log captures every kv put above. Confirm one entry
# per key (not the value — `hmac_request=true` is the default).
journalctl -u vault | grep '"operation":"update"' | grep secret/data/hope/ | wc -l
# Expected: 12 (one per key in §2)
```

## 4. Special-case notes per secret

### `API_KEY_PEPPER` — bigger change

API keys are stored hashed-with-pepper, so a pepper rotation forces
every API key holder to re-pair. Schedule a maintenance window and
notify all API consumers BEFORE running the rotation. Coordinate
with the platform team to plan the re-pair flow.

### `OIDC_CLIENT_SECRET`

The IdP (Auth0/Keycloak/etc.) is the source of truth for this value.
Rotate the IdP-side secret FIRST, capture the new value, then write
to Vault. Coordinate the staging-then-prod IdP rotation with the
identity team.

### `JWT_SECRET_KEY` rotation has a natural overlap window

Existing JWTs continue to validate under the OLD value until they
expire (`JWT_EXPIRES_IN`, default 1h). Plan the cutover so:
- t=0: new JWT_SECRET_KEY visible in Vault
- t=0 → t=1h: both keys valid (Vault returns the new; the rotation
  worker invalidates caches; in-flight JWTs continue to validate
  because the API keeps the old key cached during the overlap)
- t=1h+: all JWTs issued under the new key only

The `kv-v2` `max-versions` setting keeps the previous version
decryptable; the API's `SecretsService` reads the latest version.

## 5. Rollback

If anything goes wrong during 3.2/3.3:

```bash
# Restore from the pre-cutover snapshot taken in 3.1.
vault operator raft snapshot restore \
  /var/backups/vault/$(date +%F)/pre-cutover.snap
```

Then re-attempt or escalate to security-auditor.

## 6. Hand-off to Task 7.3 (staging cutover)

Once §3 is green:
- File a ticket to flip `SECRETS_PROVIDER=vault` in the staging
  systemd unit (Task 7.3).
- After 48h staging soak with no incidents, schedule the prod
  cutover (Task 7.4).
- Capture cutover metrics (Vault request rate, p50/p99, cache hit
  ratio) for the 7-day prod soak doc (Task 7.5).

---

## Soak results (post-cutover; populated by code-reviewer + on-call)

Reserved space for the production soak summary (Task 7.5). Capture:

- Date range
- Total Vault requests
- p50 / p99 read latency (cached / cold)
- Error rate (% of reads that hit Vault non-200)
- Cache hit ratio
- Any incidents (P0/P1/P2/P3) and their root cause + mitigation
- Sign-off names
