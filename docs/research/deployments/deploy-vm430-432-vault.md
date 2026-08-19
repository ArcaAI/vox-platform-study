# Deploy HashiCorp Vault — VM 430 / 431 / 432 (3-node HA Cluster)

**Status**: SUPERSEDED — this file (dated 2026-05-24) describes a Shamir 5-of-3 unseal design, but the actual deployment (vault-ha-deployment 2026-08-07) uses a Raft-based cluster with Transit auto-unseal on dedicated VM 434 (vault-seal). The real infrastructure is live but implements a different architecture than documented here.

**Date**: 2026-05-24
**VMs**: 430 (`10.10.1.130`), 431 (`10.10.1.131`), 432 (`10.10.1.132`)
**Bridge**: vmbr1 | **Specs**: 2 vCPU / 4 GB RAM / 32 GB disk per node
**Config files**: inline in this runbook (there is no `configs/vault/` directory — the Vault configuration is reproduced in the sections below)
**Cloudflare SSH**: `ssh-vault-1.taphuynh.dev`, `ssh-vault-2.taphuynh.dev`, `ssh-vault-3.taphuynh.dev`
**API endpoint**: `https://vault.taphuynh.dev` (HAProxy-fronted, TLS-terminated)
**Related**: [Redis HA](./deploy-vm420-421-redis.md), [PostgreSQL HA](./deploy-vm500-502-postgres-ha.md), [Cloudflare Tunnel](./deploy-ct101-cloudflare-tunnel.md)

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

---

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

---

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

> **Recovery**: if 3 key holders are simultaneously unavailable, the cluster cannot be unsealed. Document this in the incident response plan. **Do NOT** store key shares in encrypted files, password managers, or any digital channel; they must be physical envelopes in geographically separated locations.

---

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

---

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

---

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
# 6. Verify: vault kv get secret/hope/JWT_SECRET_KEY  -> should return the production value
# 7. Tear down staging
```

Document outcome (success/failure, recovery time objective achieved) in `research/runbooks/vault-dr-drill-YYYY-MM.md` after each drill. **Quarterly cadence** is mandatory for SOC2; see Appendix B.2 of the migration plan.

---

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

App-side unwrapping happens once in `SecretsService.boot()` (see Plan Phase 2B Task 2.9). After unwrapping, `/run/hope/vault-wrapped-secret-id` is deleted by the post-start hook so the wrap token never sits on disk longer than necessary.

---

## 16. Manual secret rotation procedure

Static secrets (`JWT_SECRET_KEY`, `OIDC_CLIENT_SECRET`, `API_KEY_PEPPER`,
`SESSION_SECRET_KEY`, `TEXT_SERVICE_TOKEN`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY`, `MQTT_PASS`, `REDIS_PASS`) rotate via kv-v2 versioning.
Old version stays decryptable; new version is what new logins use.
Overlap window: 5 minutes (configurable per secret).

The rotation worker (`apps/api/src/workers/vault-rotation.worker.module.ts`,
Phase 6 Task 6.5) tails the Vault audit log on its leader pod and
publishes an invalidation event to Redis Pub/Sub channel
`arca:secrets:invalidate` on every `update`/`create` against
`secret/data/hope/*`. **The steps below describe the manual override
when the worker is paused or you need to force-evict without waiting
for the audit log tail.**

```bash
# 1. Write a new version of the secret.
vault kv put secret/hope/JWT_SECRET_KEY value="$(openssl rand -hex 32)"

# 2. Publish invalidation event to evict the in-memory caches on every
#    HOPE API pod. (The rotation worker does this automatically once it
#    reads the audit-log line, but for an immediate sync we publish
#    by hand here.)
redis-cli -h 10.10.1.121 -a "$REDIS_PASS" PUBLISH arca:secrets:invalidate \
  '{"key":"JWT_SECRET_KEY"}'

# 3. Wait for in-flight tokens to drain. For JWT_SECRET_KEY this is
#    JWT_EXPIRES_IN (default 1h). For symmetric secrets without a
#    grace window (e.g. API_KEY_PEPPER), schedule the rotation
#    during a maintenance window.
sleep 300

# 4. Trim kv-v2 history if you want to age out the previous version
#    (kv-v2 defaults to keeping unlimited versions; HOPE bounds to 3).
vault kv metadata patch -max-versions=3 secret/hope/JWT_SECRET_KEY
```

### Rotation matrix (policy-driven)

| Key                   | Cadence   | Overlap | Notes |
|-----------------------|-----------|---------|-------|
| `JWT_SECRET_KEY`      | 90 days   | 1h      | Drains naturally via JWT_EXPIRES_IN. |
| `OIDC_CLIENT_SECRET`  | 90 days   | n/a     | Coordinate with IdP — schedule a maintenance window. |
| `API_KEY_PEPPER`      | 180 days  | n/a     | API keys are stored hashed-with-pepper, so a pepper rotation forces every API key holder to re-pair. **Bigger change** — coordinate. |
| `SESSION_SECRET_KEY`  | 90 days   | n/a     | Forces re-login. |
| `TEXT_SERVICE_TOKEN`   | 90 days   | n/a     | Shared between API and SMR Python service. Rotate both simultaneously. |
| `S3_ACCESS_KEY/SECRET`| 365 days  | n/a     | Bound to provider IAM lifecycle. |

### Transit-key rotation (envelope-encrypted secrets)

For the `hope-globalsetting` Transit key (rotates the encryption key,
NOT the static secret values):

```bash
vault write -f transit/keys/hope-globalsetting/rotate
```

`min_decryption_version=1` (set at Phase 4 Task 4.4 init) ensures
historical ciphertexts continue to decrypt under the previous key
version. Verified by the integration test
`vault-secrets.provider.integration.test.ts > historical ciphertexts
decrypt after transit key rotation` (Phase 6 Task 6.1).

---

<!-- Sections 3, 4, 8, 10, 11, 14, 17 deferred to SRE (out of plan scope). -->

