# Deploy HashiCorp Vault — VM 430 / 431 / 432 (3-node HA Cluster)

**Date**: 2026-05-24
**VMs**: 430 (`10.10.1.130`), 431 (`10.10.1.131`), 432 (`10.10.1.132`)
**Bridge**: vmbr1 | **Specs**: 2 vCPU / 4 GB RAM / 32 GB disk per node
**Config files**: [`configs/vault/`](../configs/vault/)
**Cloudflare SSH**: `ssh-vault-1.taphuynh.dev`, `ssh-vault-2.taphuynh.dev`, `ssh-vault-3.taphuynh.dev`
**API endpoint**: `https://vault.taphuynh.dev` (HAProxy-fronted, TLS-terminated)
**Related**: [Redis HA](./deploy-vm420-421-redis.md), [PostgreSQL HA](./deploy-vm500-502-postgres-ha.md), [Cloudflare Tunnel](./deploy-ct101-cloudflare-tunnel.md), [TASK-302 Vault Migration Plan](../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/02-vault-migration.md)

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

<REMAINING SECTIONS TO BE FILLED PER TASKS 1.10–1.14>
