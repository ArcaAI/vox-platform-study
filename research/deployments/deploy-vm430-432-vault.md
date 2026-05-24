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

<REMAINING SECTIONS TO BE FILLED PER TASKS 1.8–1.14>
