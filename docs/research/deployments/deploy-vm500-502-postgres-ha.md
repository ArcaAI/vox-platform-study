# Deploy High-Availability TimescaleDB — VMs 500–502

**Status**: BUILT — PostgreSQL HA cluster is live on VMs 500-502 per ground-truth VM inventory; this provides the primary database backend for the platform.

**Date**: 2026-03-18
**VMs**: 500 (`10.10.1.200`), 501 (`10.10.1.201`), 502 (`10.10.1.202`)
**Bridge**: vmbr1 | **Specs**: 8 vCPU / 16 GB RAM / 64 GB OS disk + data disk (each)
**Config files**: [`configs/postgres-ha/`](../configs/postgres-ha/) — docker-compose (generates patroni config at startup), haproxy.cfg, keepalived
**Cloudflare SSH**: `ssh-db0.taphuynh.dev` (VM 500) | `ssh-db1.taphuynh.dev` (VM 501) | `ssh-db2.taphuynh.dev` (VM 502)
**Related**: [Infrastructure Overview](../infrastructure/proxmox-infrastructure-gitlab-rancher-plan.md) | [MinIO (VM 402)](./deploy-vm402-minio.md) | [GitLab (VM 410)](./deploy-vm410-gitlab.md) | [Runner (VM 411)](./deploy-vm411-gitlab-runner.md) | [Cloudflare Tunnel](./deploy-ct101-cloudflare-tunnel.md) | [Database Access & Domains](../networking/setup-database-access-cloudflare-tunnel.md)

> **TimescaleDB** is a PostgreSQL extension for time-series data. The `timescale/timescaledb-ha` Docker image bundles PostgreSQL 18 + TimescaleDB 2.25 + Patroni 4.1.0 + pgBackRest in a single production-ready image — no custom Dockerfile needed. All standard PostgreSQL features, tools, and clients work unchanged.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Component Versions](#2-component-versions)
3. [Prerequisites](#3-prerequisites)
4. [Expand Disk (Proxmox Host)](#4-expand-disk-proxmox-host)
5. [Extend Filesystem (Inside Each VM)](#5-extend-filesystem-inside-each-vm)
6. [Prepare All Nodes](#6-prepare-all-nodes)
7. [Deploy etcd Cluster](#7-deploy-etcd-cluster)
8. [Deploy Patroni + TimescaleDB Cluster](#8-deploy-patroni--timescaledb-cluster)
9. [Deploy HAProxy + Keepalived](#9-deploy-haproxy--keepalived)
10. [Deploy PgBouncer (Transaction Mode)](#10-deploy-pgbouncer-transaction-mode)
11. [Deploy Monitoring (postgres_exporter)](#11-deploy-monitoring-postgres_exporter)
12. [Backup with pgBackRest](#12-backup-with-pgbackrest)
13. [Security Hardening](#13-security-hardening)
14. [Verify the Cluster](#14-verify-the-cluster)
15. [Failover Testing](#15-failover-testing)
16. [Operational Runbook](#16-operational-runbook)
17. [Connecting Applications](#17-connecting-applications)
18. [Troubleshooting](#18-troubleshooting)

---

## 1. Architecture Overview

Three Ubuntu 24.04 VMs, each running the full stack co-located. A floating VIP provides a single entry point for applications.

```
                        ┌──────────────────────────────────┐
                        │      APPLICATION / CLIENTS       │
                        │                                  │
                        │       VIP: 10.10.1.250           │
                        │       ┌──────┴──────┐            │
                        │     :5000 (R/W)  :5001 (R/O)     │
                        └───────┬─────────────┬────────────┘
                                │             │
        ┌───────────────────────┼─────────────┼───────────────────────┐
        │                       │             │                       │
   ┌────▼───────────┐     ┌─────▼─────────┐ ┌──▼───────────┐          │
   │  VM 500        │     │  VM 501       │ │  VM 502      │          │
   │  10.10.1.200   │     │  10.10.1.201  │ │  10.10.1.202 │          │
   ├────────────────┤     ├───────────────┤ ├──────────────┤          │
   │ TimescaleDB    │     │ TimescaleDB   │ │ TimescaleDB  │          │
   │ + PG 18        │     │ + PG 18       │ │ + PG 18      │          │
   │ (PRIMARY)      │     │ (REPLICA)     │ │ (REPLICA)    │          │
   │                │     │               │ │              │          │
   │ Patroni        │     │ Patroni       │ │ Patroni      │          │
   │ etcd           │     │ etcd          │ │ etcd         │          │
   │ HAProxy    ◄─VIP──── │ HAProxy       │ │              │          │
   │ Keepalived     │     │ Keepalived    │ │              │          │
   │ PgBouncer      │     │ PgBouncer     │ │ PgBouncer    │          │
   │ pg_exporter    │     │ pg_exporter   │ │ pg_exporter  │          │
   └────────────────┘     └───────────────┘ └──────────────┘          │
        │                       │                │                    │
        └───────────────────────┼────────────────┘                    │
                                │                                     │
                       ┌────────▼────────┐                            │
                       │  Backup Target  │   MinIO S3 (VM 402)        │
                       │  (pgBackRest)   │   or local/NFS             │
                       └─────────────────┘                            │
```

### Port Allocation (per node)

| Port | Service           | Purpose                                              |
| ---- | ----------------- | ---------------------------------------------------- |
| 5432 | PostgreSQL        | Direct database connections                          |
| 8008 | Patroni REST API  | Health checks, cluster status, Prometheus `/metrics` |
| 2379 | etcd client       | Client API                                           |
| 2380 | etcd peer         | Cluster peer communication                           |
| 5000 | HAProxy           | Read/Write — routes to primary                       |
| 5001 | HAProxy           | Read-Only — round-robin to replicas                  |
| 7000 | HAProxy           | Stats dashboard (HTTP)                               |
| 6432 | PgBouncer         | Connection pooling                                   |
| 9187 | postgres_exporter | Prometheus metrics                                   |

### Node Roles

| VM  | IP          | Hostname | Patroni | etcd | HAProxy | Keepalived | PgBouncer |
| --- | ----------- | -------- | ------- | ---- | ------- | ---------- | --------- |
| 500 | 10.10.1.200 | pg-node1 | Yes     | Yes  | Yes     | MASTER     | Yes       |
| 501 | 10.10.1.201 | pg-node2 | Yes     | Yes  | Yes     | BACKUP     | Yes       |
| 502 | 10.10.1.202 | pg-node3 | Yes     | Yes  | No      | No         | Yes       |

**VIP**: `10.10.1.250` — floats between VM 500 and VM 501 via Keepalived.

---

## 2. Component Versions

| Component         | Version    | Source                                          |
| ----------------- | ---------- | ----------------------------------------------- |
| Ubuntu            | 24.04 LTS  | Proxmox template                                |
| **TimescaleDB**   | **2.25.2** | Bundled in `timescale/timescaledb-ha` image     |
| PostgreSQL        | 18.x       | Bundled in `timescale/timescaledb-ha` image     |
| Patroni           | 4.1.0      | Bundled in `timescale/timescaledb-ha` image     |
| pgBackRest        | 2.54.x     | Bundled in `timescale/timescaledb-ha` image     |
| etcd              | 3.5.21     | `quay.io/coreos/etcd:v3.5.21`                   |
| HAProxy           | 3.1        | `haproxy:3.1-alpine`                            |
| PgBouncer         | 1.25.2-p0  | `edoburu/pgbouncer:v1.25.2-p0`                  |
| Keepalived        | 2.x        | apt package (host-level)                        |
| postgres_exporter | 0.16.0     | `prometheuscommunity/postgres-exporter:v0.16.0` |

> The `timescale/timescaledb-ha:pg18-all-amd64` image bundles TimescaleDB + PostgreSQL + Patroni + pgBackRest + 30+ extensions (PostGIS, pgvector, pg_cron, etc.) in a single image. No custom Dockerfile required.

### Why TimescaleDB

TimescaleDB is a PostgreSQL extension — it runs **inside** PostgreSQL, not alongside it. Everything that works with PostgreSQL works with TimescaleDB: Prisma, pgAdmin, pg_dump, streaming replication, all SQL, all extensions. You gain:

- **Hypertables** — automatic time-based partitioning with zero application changes
- **Compression** — 90-98% storage savings on time-series/log data
- **Continuous aggregates** — materialized views that refresh incrementally
- **Data retention policies** — automatic chunk dropping (e.g., "keep 90 days")
- **Hyperfunctions** — `time_bucket()`, `first()`, `last()`, gap-filling, percentile approximation

The **Community Edition (TSL)** is free for self-hosted use. The only restriction is you cannot resell it as a managed DBaaS.

### Why This Stack

| Decision          | Choice                        | Rationale                                                                                     |
| ----------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| Database          | **TimescaleDB 2.25 on PG 18** | PostgreSQL superset with time-series, compression, and continuous aggregates; PG 18 adds async I/O, UUIDv7, virtual generated columns, and data checksums by default |
| Docker image      | **timescale/timescaledb-ha**  | Production-ready: bundles Patroni + pgBackRest + 30+ extensions, maintained by Timescale      |
| HA orchestrator   | **Patroni 4.1.0**             | Industry standard, bundled in the HA image, native Prometheus metrics                         |
| DCS               | **etcd**                      | Lightest footprint (~50MB RAM), best Patroni integration, used by ~85% of Patroni deployments |
| Load balancer     | **HAProxy**                   | Layer 4 TCP routing with Patroni health check integration (`/primary`, `/replica` endpoints)  |
| Connection pooler | **PgBouncer**                 | Multiplexes many app connections onto fewer PG backend connections, transaction pooling       |
| VIP failover      | **Keepalived**                | Simple VRRP-based VIP management, no extra VMs needed                                         |
| Backup            | **pgBackRest**                | Block-level incremental, parallel backup/restore, S3 support, bundled in image                |

---

## 3. Prerequisites

- VMs 500, 501, 502 running Ubuntu 24.04 Server
- SSH access via Cloudflare Tunnel: `ssh db0`, `ssh db1`, `ssh db2` (aliases for `ssh-db0.taphuynh.dev`, `ssh-db1.taphuynh.dev`, `ssh-db2.taphuynh.dev` — see `~/.ssh/config`)
- Docker and Docker Compose installed on all 3 VMs
- Static IPs configured on all 3 VMs (already done via Proxmox/cloud-init)
- (Optional) MinIO on VM 402 for pgBackRest S3 backup target

---

## 4. Disk Sizing & Expansion

Each VM starts with a **64 GB OS disk** (`virtio0`). That covers the OS, Docker, and images but is far too small for database data. You need to add storage.

### Disk Budget Per Node

| Component                   | Space Needed            | Notes                                                  |
| --------------------------- | ----------------------- | ------------------------------------------------------ |
| OS + Docker + images        | ~15 GB                  | Included in the 64 GB OS disk                          |
| etcd data                   | 2-4 GB                  | Small but write-intensive — benefits from fast storage |
| PostgreSQL data             | **Depends on workload** | See sizing guide below                                 |
| WAL files (`max_wal_size`)   | 4-8 GB                  | Configured at 4 GB                                     |
| pgBackRest local cache      | 10-20 GB                | Temp space for backup operations                       |
| Headroom (logs, temp files)  | 10-20 GB                | PostgreSQL temp tablespace, sort spills                |

### How Much Data Disk to Add

| Scenario                  | Expected Data | Recommended Disk     | Resize Command                   |
| ------------------------- | ------------- | -------------------- | -------------------------------- |
| Small / getting started   | < 50 GB       | +100G (164 GB total) | `qm resize <vmid> virtio0 +100G` |
| Medium / production       | 50-200 GB     | +250G (314 GB total) | `qm resize <vmid> virtio0 +250G` |
| Large / heavy time-series | 200+ GB       | +500G (564 GB total) | `qm resize <vmid> virtio0 +500G` |

> **TimescaleDB compression** typically achieves 90-98% savings on time-series data. 100 GB of raw inserts may compress down to 2-10 GB on disk. Factor this into your sizing — you likely need less raw disk than you think.

> **Replicas hold a full copy** of the primary's data, so all 3 nodes need the same disk size.

> You can always expand later — Proxmox `qm resize` is instant, non-disruptive, and can be done while the VM is running.

### 4.1 Expand the OS Disk (Proxmox Host)

Pick a size from the table above. Example with +250G:

```bash
# On the Proxmox host (SSH or web shell)
qm resize 500 virtio0 +250G
qm resize 501 virtio0 +250G
qm resize 502 virtio0 +250G
```

### 4.2 (Alternative) Add a Dedicated Data Disk

For better I/O isolation, add a **second virtual disk** instead of expanding the OS disk. This separates OS I/O from database I/O:

```bash
# On the Proxmox host — add a 250 GB virtio-scsi disk to each VM
qm set 500 --scsi1 local-lvm:250,discard=on,ssd=1
qm set 501 --scsi1 local-lvm:250,discard=on,ssd=1
qm set 502 --scsi1 local-lvm:250,discard=on,ssd=1
```

Then inside each VM, format and mount it:

```bash
# Identify the new disk
lsblk
# Usually appears as /dev/sdb (scsi) or /dev/vdb (virtio)

# Format as XFS (best for PostgreSQL workloads)
sudo mkfs.xfs /dev/sdb

# Mount at /data
sudo mkdir -p /data
sudo mount /dev/sdb /data

# Persist across reboots
echo '/dev/sdb /data xfs defaults,noatime 0 2' | sudo tee -a /etc/fstab

# Verify
df -h /data
```

> **Which approach?** Expanding `virtio0` is simpler. A dedicated data disk gives better I/O isolation and makes it easier to snapshot/backup the data disk independently. For a homelab, either works fine.

---

## 5. Extend Filesystem (Inside Each VM)

**Skip this section if you added a dedicated data disk in 4.2** — go straight to [section 6](#6-prepare-all-nodes).

If you expanded the OS disk in 4.1, run on **all 3 VMs** (500, 501, 502):

```bash
# Check current layout
lsblk
df -h /

# Grow GPT partition (partition 3 for Ubuntu 24.04 LVM layout)
sudo growpart /dev/vda 3

# Resize LVM physical volume
sudo pvresize /dev/vda3

# Extend logical volume
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv

# Resize filesystem
sudo resize2fs /dev/mapper/ubuntu--vg-ubuntu--lv

# Verify
df -h /
```

> **Non-LVM?** Use `sudo growpart /dev/vda 2` then `sudo resize2fs /dev/vda2`.

---

## 6. Prepare All Nodes

Run the following on **all 3 VMs**.

### 6.1 Set Hostnames

```bash
# VM 500
sudo hostnamectl set-hostname pg-node1

# VM 501
sudo hostnamectl set-hostname pg-node2

# VM 502
sudo hostnamectl set-hostname pg-node3
```

### 6.2 Configure /etc/hosts

Add to `/etc/hosts` on **all 3 VMs**:

```
10.10.1.200  pg-node1
10.10.1.201  pg-node2
10.10.1.202  pg-node3
```

### 6.3 Install Docker (if not already installed)

```bash
# Remove old versions
sudo apt-get remove -y docker docker-engine docker.io containerd runc 2>/dev/null

# Install prerequisites
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

# Add Docker GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add user to docker group
sudo usermod -aG docker $USER

# Verify
docker --version
docker compose version
```

### 6.4 Create Data Directories

If you used a **dedicated data disk** (section 4.2), `/data` is already mounted. If you expanded the OS disk (section 4.1), just create `/data` on the root filesystem.

```bash
sudo mkdir -p /data/postgresql
sudo mkdir -p /data/etcd
sudo mkdir -p /data/pgbackrest
sudo chown -R 1000:1000 /data/postgresql   # postgres UID in timescaledb-ha image
sudo chown -R 1000:1000 /data/etcd
sudo chown -R 1000:1000 /data/pgbackrest
```

Verify:

```bash
ls -la /data/
# postgresql/  etcd/  pgbackrest/  — all owned by 1000:1000

df -h /data/
# Should show your expanded or dedicated disk
```

> **Note**: The `timescale/timescaledb-ha` image runs as UID 1000 (not 999 like the official `postgres` image). The default data directory inside the container is `/home/postgres/pgdata/data`.

### 6.5 Configure Firewall

> **Docker + UFW conflict**: Docker modifies iptables directly, bypassing UFW. Even with UFW enabled, Docker-published ports are reachable from any network. Step 2 below adds a `DOCKER-USER` iptables rule to restrict Docker-published ports to the private subnet only.

**Step 1 — UFW rules** (run on **all 3 VMs**):

```bash
# Install UFW (not included in Ubuntu Server minimal/cloud images)
sudo apt-get update && sudo apt-get install -y ufw

# Allow SSH first — prevents lockout when UFW is enabled
sudo ufw allow OpenSSH

# Allow all traffic from the private LAN (all VMs, VIP, runners, etc.)
# This covers: cluster nodes, VIP, GitLab Runner (10.10.1.111), Redis, etc.
sudo ufw allow from 10.10.1.0/24 to any comment "Private LAN - all infrastructure"

# Allow VRRP (Keepalived)
sudo ufw allow proto vrrp from 10.10.1.0/24

# Enable the firewall (type 'y' when prompted)
sudo ufw enable

# Verify — should show Status: active with the rules listed
sudo ufw status verbose
```

**Step 2 — Restrict Docker-published ports** (run on **all 3 VMs**):

> `iptables-persistent` and `ufw` are **mutually exclusive** packages — installing one removes the other. Use UFW's `before.rules` to persist the Docker iptables rule instead.

```bash
# Find your interface name (likely ens18 on Proxmox VMs)
ip -br a

# Add the DOCKER-USER rule to UFW's before.rules (persists across reboots)
# Replace ens18 with your actual interface name from the command above
# The grep guard makes this idempotent — safe to run multiple times
IFACE="enp6s18"
if ! grep -q "DOCKER-USER -i ${IFACE}" /etc/ufw/before.rules; then
  sudo sed -i '/^COMMIT$/i \
# Restrict Docker-published ports to private subnet only\
-I DOCKER-USER -i '"${IFACE}"' ! -s 10.10.1.0/24 -j DROP' /etc/ufw/before.rules
  echo "Rule added to before.rules for interface ${IFACE}"
else
  echo "Rule already exists in before.rules for interface ${IFACE} — skipping"
fi

# Apply the iptables rule immediately (so it takes effect without reboot)
# Only add if not already present in the live chain
if ! sudo iptables -L DOCKER-USER -n | grep -q "${IFACE}"; then
  sudo iptables -I DOCKER-USER -i "${IFACE}" ! -s 10.10.1.0/24 -j DROP
fi

# Reload UFW to pick up the before.rules change
sudo ufw reload
```

> **Fixing duplicate rules**: If you already ran the old (non-idempotent) version and have duplicate entries, clean them up:
>
> ```bash
> # 1. Remove ALL duplicate DOCKER-USER lines from before.rules, keep only one
> sudo sed -i '0,/DOCKER-USER/{//!b}; /DOCKER-USER/d' /etc/ufw/before.rules
> # That's fragile — easier to just edit manually:
> sudo nano /etc/ufw/before.rules
> # Search for "DOCKER-USER" and delete all duplicate lines, keeping exactly one
>
> # 2. Flush the live DOCKER-USER chain and re-add the single correct rule
> sudo iptables -F DOCKER-USER
> sudo iptables -A DOCKER-USER -j RETURN
> IFACE="enp6s18"  # replace with your actual interface
> sudo iptables -I DOCKER-USER -i "${IFACE}" ! -s 10.10.1.0/24 -j DROP
>
> # 3. Reload UFW so before.rules is re-applied cleanly
> sudo ufw reload
> ```

Verify:

```bash
sudo ufw status verbose
sudo iptables -L DOCKER-USER -n -v
```

Expected output — exactly **one** DROP rule for your interface, plus the default RETURN:

```
Chain DOCKER-USER (1 references)
 pkts bytes target     prot opt in     out     source               destination
    0     0 DROP       0    --  ens18  *      !10.10.1.0/24         0.0.0.0/0
    0     0 RETURN     0    --  *      *       0.0.0.0/0            0.0.0.0/0
```

### 6.6 Enable Watchdog Module

Patroni uses the Linux software watchdog to prevent split-brain. If Patroni crashes while holding the leader lock, the watchdog reboots the VM to ensure the old primary is truly dead.

```bash
# Load the softdog kernel module
sudo modprobe softdog

# Persist across reboots
echo "softdog" | sudo tee /etc/modules-load.d/softdog.conf

# Set permissions for the postgres user (UID 1000 in timescaledb-ha image)
echo 'KERNEL=="watchdog", OWNER="1000", GROUP="1000", MODE="0600"' | \
  sudo tee /etc/udev/rules.d/99-watchdog.rules

sudo udevadm control --reload-rules
sudo udevadm trigger

# Verify
ls -la /dev/watchdog
```

### 6.7 Tune Kernel Parameters

```bash
cat <<'EOF' | sudo tee /etc/sysctl.d/99-postgres-ha.conf
# Shared memory for PostgreSQL
vm.overcommit_memory = 2
vm.overcommit_ratio = 80

# Huge pages (optional — calculate: shared_buffers / hugepage_size)
# vm.nr_hugepages = 2048

# Network tuning for replication
net.core.somaxconn = 65535
net.ipv4.tcp_keepalive_time = 60
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 6

# Allow VRRP multicast (Keepalived)
net.ipv4.ip_nonlocal_bind = 1
EOF

sudo sysctl -p /etc/sysctl.d/99-postgres-ha.conf
```

---

## 7. Deploy etcd Cluster

etcd provides the distributed consensus layer. Patroni uses it for leader election and cluster state storage.

### 7.1 Copy Config Files to All Nodes

From your **workstation**, copy the config directory to each VM via Cloudflare Tunnel:

```bash
# From your workstation (VMs are behind Cloudflare Tunnel — use SSH aliases, not raw IPs)
scp -r research/configs/postgres-ha/ db0:~/   # VM 500
scp -r research/configs/postgres-ha/ db1:~/   # VM 501
scp -r research/configs/postgres-ha/ db2:~/   # VM 502
```

### 7.2 Create the .env File (Each Node)

The `docker-compose.yml` reads `NODE_NAME`, `NODE_IP`, and peer IPs from a `.env` file. **This file must exist before starting any service** — etcd, Patroni, HAProxy, and PgBouncer all depend on it.

First, generate passwords (run once, use the same values on all 3 nodes):

```bash
# Run on your workstation or any node — save these values
openssl rand -base64 24   # → PG_PASSWORD
openssl rand -base64 24   # → REPL_PASSWORD
openssl rand -base64 24   # → APP_PASSWORD
openssl rand -base64 24   # → PGBOUNCER_PASSWORD
```

Then SSH into **each VM** and create the `.env`:

**VM 500 (pg-node1):**

```bash
ssh db0
cd ~/postgres-ha
cp .env.example .env
```

Edit `.env` — set the node-specific values:

```env
NODE_NAME=pg-node1
NODE_IP=10.10.1.200
```

Set the passwords (same on all 3 nodes):

```env
PG_PASSWORD=<your-generated-superuser-password>
REPL_PASSWORD=<your-generated-replicator-password>
APP_PASSWORD=<your-generated-app-password>
PGBOUNCER_PASSWORD=<your-generated-pgbouncer-password>
```

Leave `PEER*_IP`, `APP_DB`, `APP_USER`, and `VIP` at their defaults.

**VM 501 (pg-node2):**

```bash
ssh db1
cd ~/postgres-ha
cp .env.example .env
# Edit .env — only NODE_NAME and NODE_IP differ:
#   NODE_NAME=pg-node2
#   NODE_IP=10.10.1.201
# Passwords must match VM 500
```

**VM 502 (pg-node3):**

```bash
ssh db2
cd ~/postgres-ha
cp .env.example .env
# Edit .env — only NODE_NAME and NODE_IP differ:
#   NODE_NAME=pg-node3
#   NODE_IP=10.10.1.202
# Passwords must match VM 500
```

> **Verify** before proceeding — on each VM, confirm the variables are set:
>
> ```bash
> grep -E '^(NODE_NAME|NODE_IP)=' .env
> # VM 500 should show: NODE_NAME=pg-node1  NODE_IP=10.10.1.200
> # VM 501 should show: NODE_NAME=pg-node2  NODE_IP=10.10.1.201
> # VM 502 should show: NODE_NAME=pg-node3  NODE_IP=10.10.1.202
> ```

### 7.3 Start etcd on All 3 Nodes

Start etcd on **all 3 nodes simultaneously** (or within a few seconds of each other):

```bash
# On VM 500
cd ~/postgres-ha
docker compose up -d etcd

# On VM 501
cd ~/postgres-ha
docker compose up -d etcd

# On VM 502
cd ~/postgres-ha
docker compose up -d etcd
```

### 7.4 Verify etcd Cluster

```bash
# From any node
docker exec etcd etcdctl endpoint health --cluster \
  --endpoints=http://10.10.1.200:2379,http://10.10.1.201:2379,http://10.10.1.202:2379

# Expected output:
# http://10.10.1.200:2379 is healthy: ...
# http://10.10.1.201:2379 is healthy: ...
# http://10.10.1.202:2379 is healthy: ...

# Check member list
docker exec etcd etcdctl member list \
  --endpoints=http://10.10.1.200:2379 \
  --write-out=table
```

---

## 8. Deploy Patroni + TimescaleDB Cluster

The `timescale/timescaledb-ha:pg18-all-amd64` image includes everything pre-installed — no build step needed. It bundles:

- PostgreSQL 18 with TimescaleDB 2.25.2
- Patroni 4.1.0 (HA orchestrator)
- pgBackRest (backup)
- 30+ extensions: PostGIS 3, pgvector, pg_cron, timescaledb_toolkit, pgai, and more

> **PG 18 highlights**: Async I/O (up to 3x faster sequential scans/vacuum), `uuidv7()` for time-ordered UUIDs, virtual generated columns, temporal constraints, OAuth 2.0 auth, data checksums enabled by default, and `pg_upgrade` now retains optimizer statistics.

### 8.1 Pull the Image

On **all 3 nodes**:

```bash
docker pull timescale/timescaledb-ha:pg18-all-amd64
```

### 8.2 Start Patroni — Node by Node

> The `.env` file was already created in [section 7.2](#72-create-the-env-file-each-node). Patroni uses the same `NODE_NAME`, `NODE_IP`, and password variables.

Start the **first node** (VM 500) first — it will bootstrap as the primary:

```bash
# VM 500 (first — becomes primary)
docker compose up -d patroni

# Wait 10-15 seconds, then verify
docker logs -f patroni
# Look for: "elected as the leader"
```

Then start the remaining nodes — they will join as replicas:

```bash
# VM 501
docker compose up -d patroni

# VM 502
docker compose up -d patroni
```

### 8.3 Verify Patroni Cluster

```bash
# From any node — install patronictl (or exec into the container)
docker exec patroni patronictl -c /home/postgres/postgres.yml list

# Expected output:
# + Cluster: hope-cluster -------+---------+---------+----+-----------+
# | Member   | Host         | Role    | State   | TL | Lag in MB |
# +----------+--------------+---------+---------+----+-----------+
# | pg-node1 | 10.10.1.200  | Leader  | running |  1 |           |
# | pg-node2 | 10.10.1.201  | Replica | running |  1 |         0 |
# | pg-node3 | 10.10.1.202  | Replica | running |  1 |         0 |
# +----------+--------------+---------+---------+----+-----------+

# Also check Patroni REST API
curl -s http://10.10.1.200:8008/cluster | python3 -m json.tool
```

### 8.4 Verify Dynamic Settings

The bootstrap DCS settings and PostgreSQL parameters are defined in [`patroni/entrypoint.sh`](../configs/postgres-ha/patroni/entrypoint.sh), which generates `/home/postgres/postgres.yml` from `.env` variables at container startup. A reference copy is at [`patroni/patroni.yml`](../configs/postgres-ha/patroni/patroni.yml). No manual `edit-config` step is needed for initial setup.

To view or adjust settings after bootstrap:

```bash
# View current dynamic config
docker exec patroni patronictl -c /home/postgres/postgres.yml show-config

# Edit dynamic config (if tuning is needed post-bootstrap)
docker exec -it patroni patronictl -c /home/postgres/postgres.yml edit-config
```

**Key design decisions in the config** (see `docker-compose.yml` and reference `patroni/patroni.yml` for full values):

- **TimescaleDB worker processes**: `max_worker_processes` = 27 (formula: 3 + `timescaledb.max_background_workers` 16 + `max_parallel_workers` 8)
- **work_mem = 128MB**: TimescaleDB compression/decompression and chunk aggregation are more memory-intensive than vanilla PostgreSQL
- **Synchronous replication**: `synchronous_mode: true` with `synchronous_node_count: 1` — every commit waits for at least one replica (RPO=0). `synchronous_mode_strict: false` allows fallback to async if all replicas are down

---

## 9. Deploy HAProxy + Keepalived

HAProxy routes connections to the correct PostgreSQL node. Keepalived provides a floating VIP so applications always connect to a single address.

### 9.1 Start HAProxy

HAProxy is configured in [`docker-compose.yml`](../configs/postgres-ha/docker-compose.yml) under the `haproxy` profile, with routing rules in [`haproxy/haproxy.cfg`](../configs/postgres-ha/haproxy/haproxy.cfg). Deploy on **VM 500 and VM 501** only:

```bash
# VM 500
docker compose --profile haproxy up -d

# VM 501
docker compose --profile haproxy up -d
```

Verify:

```bash
# Stats dashboard
curl -s http://10.10.1.200:7000/stats | head -5

# Test primary routing
docker exec haproxy sh -c 'echo "SELECT 1;" | timeout 3 nc -q1 127.0.0.1 5000' 2>/dev/null

# Or from any machine on the network:
psql -h 10.10.1.200 -p 5000 -U postgres -c "SELECT inet_server_addr();"
```

Open the HAProxy stats dashboard: `http://10.10.1.200:7000/` — you should see the primary node as UP in the `pg_primary` backend and replicas as UP in `pg_replicas`.

### 9.2 Install and Configure Keepalived

Keepalived runs on the **host** (not in Docker) because it needs direct access to the network interface for VRRP. Config files are in [`configs/postgres-ha/keepalived/`](../configs/postgres-ha/keepalived/).

> **Note**: Before copying, check your interface name with `ip a` — if it's not `eth0` (likely `ens18` on Proxmox VMs), edit the conf file after copying.

**On VM 500 (MASTER) and VM 501 (BACKUP):**

```bash
sudo apt-get install -y keepalived

# VM 500 — use the MASTER config
sudo cp ~/postgres-ha/keepalived/keepalived-master.conf /etc/keepalived/keepalived.conf

# VM 501 — use the BACKUP config
sudo cp ~/postgres-ha/keepalived/keepalived-backup.conf /etc/keepalived/keepalived.conf

# On both: edit interface name if needed (default is eth0)
sudo nano /etc/keepalived/keepalived.conf
```

Start Keepalived:

```bash
sudo systemctl enable keepalived
sudo systemctl start keepalived

# Verify VIP
ip addr show | grep 10.10.1.250
# Should appear on VM 500 (MASTER)

# Test VIP connectivity
ping -c 3 10.10.1.250
psql -h 10.10.1.250 -p 5000 -U postgres -c "SELECT 1;"
```

---

## 10. Deploy PgBouncer (Transaction Mode)

PgBouncer is configured in [`docker-compose.yml`](../configs/postgres-ha/docker-compose.yml) under the `pgbouncer` profile and is **mandatory** for HOPE production (no longer optional). It runs in **transaction pooling mode** with the settings validated by [TASK-302 Stream C Phase 1](../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-validation-report.md).

> ⚠️ **Do not change transaction-mode settings without re-running the validation rig** at `packages/database/tests/pgbouncer-validation/`. Critical guarantees (RLS GUC isolation, prepared-statement safety, `DISCARD ALL` between transactions) depend on the exact combination of `POOL_MODE=transaction`, `MAX_PREPARED_STATEMENTS=200`, and `SERVER_RESET_QUERY_ALWAYS=1`. See [`03-pgbouncer-rollout.md`](../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md) Phase 2A for the rollout plan.

### Effective configuration (Phase 2A)

| Setting | Value | Why |
|---|---|---|
| `POOL_MODE` | `transaction` | Maximum backend reuse; safe for Prisma 7 with the conditions below |
| `MAX_CLIENT_CONN` | `500` | Tuned per validation rig (pgbench 50-client baseline + 10× headroom) |
| `DEFAULT_POOL_SIZE` | `50` | ≤ 50 tenants by 2027; matches `max_connections=200` × 25% safety |
| `MIN_POOL_SIZE` | `5` | Pre-warmed idle backends per pool to avoid cold-start latency |
| `RESERVE_POOL_SIZE` | `10` | Absorb deploy spikes (was 5) |
| `MAX_PREPARED_STATEMENTS` | `200` | **Required** for Prisma's named prepared statements in txn mode (PgBouncer ≥ 1.21) |
| `SERVER_RESET_QUERY` | `DISCARD ALL` | Explicit; mirrors the default to ensure no GUC leak across transactions |
| `SERVER_RESET_QUERY_ALWAYS` | `1` | Force `DISCARD ALL` even in txn mode (default is 0) |
| `IGNORE_STARTUP_PARAMETERS` | `extra_float_digits,search_path` | Prisma sends both; harmless when ignored |
| `AUTH_TYPE` | `scram-sha-256` | Matches PG hashing (Patroni init seeds `scram-sha-256`) |

Start on **all 3 nodes**:

```bash
docker compose --profile pgbouncer up -d
```

Verify:

```bash
# Connect through PgBouncer
psql -h 10.10.1.200 -p 6432 -U hope_app -c "SELECT 1;"

# Check PgBouncer stats (confirm pool_mode=transaction)
psql -h 10.10.1.200 -p 6432 -U hope_admin -d pgbouncer -c "SHOW POOLS;"
psql -h 10.10.1.200 -p 6432 -U hope_admin -d pgbouncer -c "SHOW CONFIG;" | grep -E 'pool_mode|max_prepared|server_reset'
```

### Application URLs

Production app config must split connections:

```bash
# Pooled (port 6432) — runtime queries through pgbouncer
DATABASE_URL=postgresql://hope_app:****@10.10.1.250:6432/hope?sslmode=require&schema=core

# Direct (port 5000 HAProxy R/W) — migrations only; preserves Prisma Migrate advisory locks
DIRECT_URL=postgresql://hope_app:****@10.10.1.250:5000/hope?sslmode=require&schema=core
```

---

## 11. Deploy Monitoring (postgres_exporter)

The postgres_exporter exposes PostgreSQL metrics for Prometheus. Patroni 4.1.0 also exposes its own `/metrics` endpoint on port 8008.

Configured in [`docker-compose.yml`](../configs/postgres-ha/docker-compose.yml) under the `monitoring` profile. Start on **all 3 nodes**:

```bash
docker compose --profile monitoring up -d
```

Verify:

```bash
# PostgreSQL metrics
curl -s http://10.10.1.200:9187/metrics | head -20

# Patroni metrics (built-in)
curl -s http://10.10.1.200:8008/metrics | head -20

# etcd metrics (built-in)
curl -s http://10.10.1.200:2379/metrics | head -20
```

### Prometheus Scrape Config

Add to your Prometheus `prometheus.yml`:

```yaml
scrape_configs:
    - job_name: 'postgres'
      scrape_interval: 15s
      static_configs:
          - targets:
                - '10.10.1.200:9187'
                - '10.10.1.201:9187'
                - '10.10.1.202:9187'

    - job_name: 'patroni'
      scrape_interval: 10s
      metrics_path: '/metrics'
      static_configs:
          - targets:
                - '10.10.1.200:8008'
                - '10.10.1.201:8008'
                - '10.10.1.202:8008'

    - job_name: 'etcd'
      scrape_interval: 15s
      static_configs:
          - targets:
                - '10.10.1.200:2379'
                - '10.10.1.201:2379'
                - '10.10.1.202:2379'
```

### Recommended Grafana Dashboards

| Component  | Dashboard ID | Name                |
| ---------- | ------------ | ------------------- |
| PostgreSQL | 9628         | PostgreSQL Database |
| etcd       | 3070         | etcd by Prometheus  |
| HAProxy    | 2428         | HAProxy 2 Full      |

---

## 12. Backup with pgBackRest

pgBackRest is bundled in the `timescaledb-ha` image. It provides block-level incremental backups with parallel processing, zstd compression, and S3 support. Backups are stored in MinIO S3 (`10.10.1.102:9000`, bucket `pgbackrest`). The config is mounted from [`pgbackrest/pgbackrest.conf`](../configs/postgres-ha/pgbackrest/pgbackrest.conf) into the container at `/etc/pgbackrest/pgbackrest.conf`. The `PGBACKREST_CONFIG` environment variable overrides the image's default path (`/home/postgres/pgdata/backup/pgbackrest.conf`). A local-disk fallback config is available at [`pgbackrest-local.conf.example`](../configs/postgres-ha/pgbackrest/pgbackrest-local.conf.example).

### How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│  Patroni Container                                                   │
│                                                                     │
│  PostgreSQL ──archive_command──► pgBackRest archive-push ──► MinIO  │
│                                                                     │
│  Repo: MinIO S3 (10.10.1.102:9000, bucket: pgbackrest)             │
│  Fallback: local disk /var/lib/pgbackrest (see local.conf.example) │
│                                                                     │
│  Cron (host) ──docker exec──► pgbackrest backup ──► MinIO           │
│                                                                     │
│  Restore: pgbackrest restore ──► PGDATA                             │
│  Replicas: Patroni uses pgbackrest as create_replica_method         │
└─────────────────────────────────────────────────────────────────────┘
```

**Key integration points** (already configured in [`patroni/entrypoint.sh`](../configs/postgres-ha/patroni/entrypoint.sh)):

| Setting | Value | Purpose |
|---------|-------|---------|
| `archive_command` | `pgbackrest --stanza=hope-cluster archive-push "%p"` | Continuous WAL archiving |
| `archive_timeout` | `60` | Force archive every 60s even if WAL not full |
| `restore_command` | `pgbackrest --stanza=hope-cluster archive-get %f "%p"` | Replicas and PITR fetch WAL from repo |
| `create_replica_methods` | `pgbackrest, basebackup` | Replicas bootstrap from pgBackRest first (faster), fallback to pg_basebackup |

### 12.1 Prerequisites — MinIO Service Account & CA Certificate

Before configuring pgBackRest, set up MinIO access:

**1. Create service account and bucket** — follow [deploy-vm402-minio.md section 9b](./deploy-vm402-minio.md):
- Create the `pgbackrest` bucket
- Create the `pgbackrest-svc` user with a scoped policy
- Generate access keys

**2. Edit `configs/postgres-ha/pgbackrest/pgbackrest.conf`** and set:
- `repo1-s3-key` = your MinIO access key
- `repo1-s3-key-secret` = your MinIO secret key

**3. Copy the MinIO CA certificate** into the pgbackrest config directory. The CA cert was generated during MinIO TLS setup ([deploy-vm402-minio.md section 14](./deploy-vm402-minio.md)):

```bash
# From the machine where you generated the MinIO certs (or from any VM that has it)
scp ssh-minio:~/minio-certs/ca/ca.crt configs/postgres-ha/pgbackrest/minio-ca.crt
```

> The CA cert is mounted into the Patroni container at `/etc/pgbackrest/minio-ca.crt` and referenced by `repo1-storage-ca-file` in `pgbackrest.conf`. This enables proper TLS verification instead of skipping it.

**4. Copy the updated config to all VMs:**

```bash
scp -r configs/postgres-ha/ db0:~/postgres-ha/
scp -r configs/postgres-ha/ db1:~/postgres-ha/
scp -r configs/postgres-ha/ db2:~/postgres-ha/
```

### 12.2 Verify pgBackRest Is Available

```bash
docker exec patroni pgbackrest version
# Expected: pgBackRest 2.54.x or higher
```

### 12.3 Create Stanza and Initial Full Backup

Run on the **primary node** (VM 500 if it's still the leader):

```bash
# Create the stanza (registers this cluster with pgBackRest)
docker exec patroni pgbackrest --stanza=hope-cluster stanza-create

# Verify stanza
docker exec patroni pgbackrest --stanza=hope-cluster check

# Run initial full backup
docker exec patroni pgbackrest --stanza=hope-cluster --type=full backup

# Check backup info
docker exec patroni pgbackrest --stanza=hope-cluster info
```

Expected output from `info`:

```
stanza: hope-cluster
    status: ok
    cipher: none

    db (current)
        wal archive min/max (18): 000000010000000000000001/000000010000000000000005

        full backup: 20260322-020000F
            timestamp start/stop: 2026-03-22 02:00:00+00 / 2026-03-22 02:01:30+00
            wal start/stop: 000000010000000000000003 / 000000010000000000000003
            database size: 150MB, database backup size: 150MB
            repo1: backup set size: 25MB, backup size: 25MB
```

### 12.4 Schedule Automated Backups

Install cron on **all 3 nodes**. Each job checks if the node is the current primary before running — this way backups automatically follow the leader after failover.

```bash
# On ALL 3 VMs — create the cron file
sudo tee /etc/cron.d/pgbackrest << 'EOF'
# pgBackRest automated backups — only runs on the current Patroni primary
# The pg_is_in_recovery() check ensures only the primary executes the backup

# Full backup — Sunday 02:00 UTC
0 2 * * 0 root docker exec patroni bash -c 'if [ "$(psql -U postgres -tAc "SELECT NOT pg_is_in_recovery()")" = "t" ]; then pgbackrest --stanza=hope-cluster --type=full backup 2>&1 | tail -5; fi' >> /var/log/pgbackrest.log 2>&1

# Differential backup — Mon-Sat 02:00 UTC
0 2 * * 1-6 root docker exec patroni bash -c 'if [ "$(psql -U postgres -tAc "SELECT NOT pg_is_in_recovery()")" = "t" ]; then pgbackrest --stanza=hope-cluster --type=diff backup 2>&1 | tail -5; fi' >> /var/log/pgbackrest.log 2>&1

# Verify backup integrity — Sunday 06:00 UTC (after full backup completes)
0 6 * * 0 root docker exec patroni bash -c 'if [ "$(psql -U postgres -tAc "SELECT NOT pg_is_in_recovery()")" = "t" ]; then pgbackrest --stanza=hope-cluster verify 2>&1 | tail -5; fi' >> /var/log/pgbackrest.log 2>&1
EOF

sudo chmod 644 /etc/cron.d/pgbackrest
```

**Backup schedule summary:**

| Day | Time (UTC) | Type | What It Does |
|-----|-----------|------|-------------|
| Sunday | 02:00 | Full | Complete backup, resets the chain |
| Mon–Sat | 02:00 | Differential | Only changes since last full |
| Sunday | 06:00 | Verify | Integrity check of all backups |

**Retention**: 2 full backups + 7 differential backups. When a full backup expires, all its dependent diffs also expire. This gives ~2 weeks of recovery window.

### 12.5 Verify WAL Archiving Is Working

WAL archiving should start automatically after the stanza is created:

```bash
# Check WAL archive status from PostgreSQL
docker exec patroni psql -U postgres -c "SELECT * FROM pg_stat_archiver;"

# Check pgBackRest sees the WAL files
docker exec patroni pgbackrest --stanza=hope-cluster check

# If archiving was previously set to /bin/true, apply the new config:
docker exec patroni patronictl -c /home/postgres/postgres.yml reload hope-cluster
```

### 12.6 Fallback to Local Disk (If MinIO Is Unavailable)

If MinIO is down or not yet deployed, switch to local disk storage:

```bash
# 1. On your local machine, copy the local config
cp configs/postgres-ha/pgbackrest/pgbackrest-local.conf.example \
   configs/postgres-ha/pgbackrest/pgbackrest.conf

# 2. Copy to all VMs
scp -r configs/postgres-ha/ db0:~/postgres-ha/
scp -r configs/postgres-ha/ db1:~/postgres-ha/
scp -r configs/postgres-ha/ db2:~/postgres-ha/

# 3. Restart patroni on all nodes (replicas first, primary last)
ssh db1 "cd ~/postgres-ha && docker compose up -d patroni"
ssh db2 "cd ~/postgres-ha && docker compose up -d patroni"
ssh db0 "cd ~/postgres-ha && docker compose up -d patroni"

# 4. Re-create the stanza for the local repo
ssh db0 "docker exec patroni pgbackrest --stanza=hope-cluster stanza-create"

# 5. Run a full backup
ssh db0 "docker exec patroni pgbackrest --stanza=hope-cluster --type=full backup"
```

> **Note**: Local disk backups are stored at `/data/pgbackrest` on each VM. This is only suitable for short-term use — backups are not replicated across nodes and are lost if the disk fails.

### 12.7 Manual Backup Commands

```bash
# Full backup (complete copy — use weekly or before major changes)
docker exec patroni pgbackrest --stanza=hope-cluster --type=full backup

# Differential backup (changes since last full — use daily)
docker exec patroni pgbackrest --stanza=hope-cluster --type=diff backup

# Incremental backup (changes since last any backup — smallest, fastest)
docker exec patroni pgbackrest --stanza=hope-cluster --type=incr backup

# Check backup status
docker exec patroni pgbackrest --stanza=hope-cluster info

# Detailed JSON output (for scripting)
docker exec patroni pgbackrest --stanza=hope-cluster info --output=json

# Verify backup integrity
docker exec patroni pgbackrest --stanza=hope-cluster verify
```

### 12.8 Restore Procedures

#### Point-in-Time Recovery (PITR)

Restore the database to a specific point in time (e.g., just before an accidental `DROP TABLE`):

```bash
# 1. Stop Patroni on ALL nodes
ssh db0 "cd ~/postgres-ha && docker compose stop patroni"
ssh db1 "cd ~/postgres-ha && docker compose stop patroni"
ssh db2 "cd ~/postgres-ha && docker compose stop patroni"

# 2. Remove the cluster state from etcd
ssh db0 "docker exec etcd etcdctl del /service/hope-cluster --prefix"

# 3. On the target primary (VM 500), restore to a specific time
ssh db0 "docker exec patroni pgbackrest --stanza=hope-cluster \
  --delta \
  --type=time \
  --target='2026-03-22 14:30:00+00' \
  --target-action=promote \
  restore"

# 4. Clear data on replica nodes (they will re-bootstrap from the restored primary)
ssh db1 "sudo rm -rf /data/postgresql/data/*"
ssh db2 "sudo rm -rf /data/postgresql/data/*"

# 5. Start Patroni on the primary first
ssh db0 "cd ~/postgres-ha && docker compose up -d patroni"
# Wait for "server is ready to accept connections" in logs

# 6. Start replicas (they will bootstrap from pgBackRest or basebackup)
ssh db1 "cd ~/postgres-ha && docker compose up -d patroni"
ssh db2 "cd ~/postgres-ha && docker compose up -d patroni"

# 7. Verify cluster
ssh db0 "docker exec patroni patronictl -c /home/postgres/postgres.yml list"
```

#### Full Cluster Restore (Latest Backup)

```bash
# 1. Stop Patroni on ALL nodes
ssh db0 "cd ~/postgres-ha && docker compose stop patroni"
ssh db1 "cd ~/postgres-ha && docker compose stop patroni"
ssh db2 "cd ~/postgres-ha && docker compose stop patroni"

# 2. Remove cluster state from etcd
ssh db0 "docker exec etcd etcdctl del /service/hope-cluster --prefix"

# 3. Restore on the target primary
ssh db0 "docker exec patroni pgbackrest --stanza=hope-cluster --delta restore"

# 4. Clear replica data and start all nodes (primary first)
ssh db1 "sudo rm -rf /data/postgresql/data/*"
ssh db2 "sudo rm -rf /data/postgresql/data/*"
ssh db0 "cd ~/postgres-ha && docker compose up -d patroni"
# Wait, then:
ssh db1 "cd ~/postgres-ha && docker compose up -d patroni"
ssh db2 "cd ~/postgres-ha && docker compose up -d patroni"
```

#### Single Database Restore

PostgreSQL physical backups cannot selectively restore a single database. Use this workaround:

```bash
# 1. Restore the full cluster to a temporary container
docker run -d --name pg-restore-test \
  -e PGDATA=/home/postgres/pgdata/data \
  -v /tmp/restore-test:/home/postgres/pgdata \
  -v ~/postgres-ha/pgbackrest/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro \
  -v /data/pgbackrest:/var/lib/pgbackrest \
  timescale/timescaledb-ha:pg18-all-amd64 bash -c "sleep infinity"

# 2. Restore into the temp container
docker exec pg-restore-test pgbackrest --stanza=hope-cluster --archive-mode=off --delta restore

# 3. Start PostgreSQL (not Patroni) in the temp container
docker exec pg-restore-test pg_ctl start -D /home/postgres/pgdata/data

# 4. Dump the specific database
docker exec pg-restore-test pg_dump -U postgres -d hope -F c -f /tmp/hope.dump

# 5. Restore into production
docker cp pg-restore-test:/tmp/hope.dump /tmp/hope.dump
psql -h 10.10.1.250 -p 5000 -U postgres -c "DROP DATABASE IF EXISTS hope; CREATE DATABASE hope;"
pg_restore -h 10.10.1.250 -p 5000 -U postgres -d hope /tmp/hope.dump

# 6. Clean up
docker stop pg-restore-test && docker rm pg-restore-test
sudo rm -rf /tmp/restore-test /tmp/hope.dump
```

### 12.9 Monitoring Backups

Check backup health regularly:

```bash
# Quick status check
docker exec patroni pgbackrest --stanza=hope-cluster info

# Verify integrity (reads and checksums all backup files)
docker exec patroni pgbackrest --stanza=hope-cluster verify

# Check WAL archiving is current
docker exec patroni psql -U postgres -c \
  "SELECT archived_count, failed_count, last_archived_wal, last_archived_time FROM pg_stat_archiver;"

# Check backup repo disk usage (local repo)
du -sh /data/pgbackrest/
```

**Warning signs to watch for:**

| Symptom | Cause | Fix |
|---------|-------|-----|
| `failed_count` increasing in `pg_stat_archiver` | WAL archiving failing | Check `docker logs patroni` for pgBackRest errors |
| `last_archived_time` more than 2 minutes old | Archive lag | Check disk space, pgBackRest process |
| `pgbackrest info` shows no recent backups | Cron not running or primary check failing | Verify cron file, check `pg_is_in_recovery()` |
| `pgbackrest verify` reports errors | Corrupted backup files | Run a new full backup immediately |

---

## 13. Security Hardening

### 13.1 PostgreSQL Authentication

The `pg_hba.conf` rules are defined in the Patroni bootstrap config (generated at startup from [`docker-compose.yml`](../configs/postgres-ha/docker-compose.yml)) under `bootstrap.pg_hba` and applied automatically at cluster initialization. A reference copy is in [`patroni/patroni.yml`](../configs/postgres-ha/patroni/patroni.yml). Password encryption is set to `scram-sha-256`.

After bootstrap, verify the generated `pg_hba.conf` matches:

```bash
docker exec patroni cat /home/postgres/pgdata/data/pg_hba.conf
```

### 13.2 Create Application Databases and Users

Connect to the primary and create application-specific databases:

```bash
psql -h 10.10.1.250 -p 5000 -U postgres

-- Create application database
CREATE DATABASE hope;

-- Connect and enable TimescaleDB extension
\c hope
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Verify TimescaleDB is active
SELECT extname, extversion FROM pg_extension WHERE extname = 'timescaledb';
-- Should show: timescaledb | 2.25.2

-- (Optional) Enable additional extensions bundled in the image
CREATE EXTENSION IF NOT EXISTS postgis;       -- Geospatial
CREATE EXTENSION IF NOT EXISTS vector;        -- pgvector for embeddings
CREATE EXTENSION IF NOT EXISTS pg_cron;       -- Scheduled jobs

-- Create application user (least privilege)
CREATE USER hope_app WITH PASSWORD 'your-strong-password-here';
GRANT CONNECT ON DATABASE hope TO hope_app;
GRANT USAGE ON SCHEMA public TO hope_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO hope_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO hope_app;

-- Read-only user for replicas
CREATE USER hope_reader WITH PASSWORD 'another-strong-password';
GRANT CONNECT ON DATABASE hope TO hope_reader;
GRANT USAGE ON SCHEMA public TO hope_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO hope_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO hope_reader;
```

> **TimescaleDB must be enabled per-database** with `CREATE EXTENSION timescaledb`. The `shared_preload_libraries` setting loads the shared library into PostgreSQL, but each database still needs the extension created explicitly.

### 13.3 TLS (Future Enhancement)

For internal homelab traffic on a private VLAN, TLS is optional. To enable later:

1. Generate a private CA with `step-ca` or `openssl`
2. Issue certs for each node
3. Configure Patroni `postgresql.parameters.ssl = on`
4. Update `pg_hba.conf` to use `hostssl` instead of `host`
5. Enable TLS on etcd peer and client connections

### 13.4 Defensive Statement / Idle Timeouts (TASK-302 Stream C Phase 0)

A misbehaving client that opens a transaction and never commits — or issues a
runaway query — can pin a backend forever. With PgBouncer fronting the
cluster (Phase 2A/2B of TASK-302 Stream C), one such leak can starve the
entire pool. To bound the blast radius, the Patroni bootstrap config
([`patroni/entrypoint.sh`](../configs/postgres-ha/patroni/entrypoint.sh) and
the [`patroni/patroni.yml`](../configs/postgres-ha/patroni/patroni.yml)
reference copy) sets two GUCs in both `bootstrap.dcs.postgresql.parameters`
and `postgresql.parameters`:

| GUC                                       | Value     | Effect                                                              |
| ----------------------------------------- | --------- | ------------------------------------------------------------------- |
| `idle_in_transaction_session_timeout`     | `30000`   | Aborts any backend idle inside a transaction for >30 s              |
| `statement_timeout`                       | `60000`   | Aborts any single statement that runs for >60 s                     |

These are conservative defaults sized for HOPE's typical OLTP workload.
Long-running ETL / migrations either run via the un-pooled `DIRECT_URL`
(Prisma Migrate) or override the timeout for their session via
`SET LOCAL statement_timeout = 0` inside an explicit transaction.

**Applying on a live cluster** (Patroni rewrites `postgresql.conf` and
reloads the cluster without a restart):

```bash
docker exec -it patroni patronictl -c /home/postgres/postgres.yml edit-config \
  --set postgresql.parameters.idle_in_transaction_session_timeout=30000 \
  --set postgresql.parameters.statement_timeout=60000 \
  --force
```

**Verifying on the primary** (port 5000 is the HAProxy R/W VIP):

```bash
psql -h 10.10.1.250 -p 5000 -U hope_app -d hope -c \
  "SHOW idle_in_transaction_session_timeout; SHOW statement_timeout;"
# Expected:
#   idle_in_transaction_session_timeout
#   -------------------------------------
#    30s
#  (1 row)
#
#   statement_timeout
#  -------------------
#    1min
#  (1 row)
```

If either value comes back as `0` (no limit), the runtime apply did not stick
— check `patronictl show-config` and re-run with `--force` if necessary.

---

## 14. Verify the Cluster

### Full Stack Verification Checklist

```bash
# 1. etcd cluster health
docker exec etcd etcdctl endpoint health --cluster \
  --endpoints=http://10.10.1.200:2379,http://10.10.1.201:2379,http://10.10.1.202:2379

# 2. Patroni cluster status
docker exec patroni patronictl -c /home/postgres/postgres.yml list

# 3. TimescaleDB version
psql -h 10.10.1.250 -p 5000 -U postgres -d hope -c \
  "SELECT extname, extversion FROM pg_extension WHERE extname = 'timescaledb';"

# 4. PostgreSQL replication
psql -h 10.10.1.250 -p 5000 -U postgres -c "SELECT * FROM pg_stat_replication;"

# 5. Synchronous replication active
psql -h 10.10.1.250 -p 5000 -U postgres -c "SELECT application_name, sync_state FROM pg_stat_replication;"
# Should show one replica as 'sync' and one as 'async' (or 'potential')

# 6. HAProxy stats
curl -s http://10.10.1.200:7000/stats

# 7. VIP is reachable
ping -c 3 10.10.1.250

# 8. Read/Write through VIP — test with a hypertable
psql -h 10.10.1.250 -p 5000 -U postgres -d hope -c "
  CREATE TABLE test_ha (time TIMESTAMPTZ NOT NULL, value DOUBLE PRECISION);
  SELECT create_hypertable('test_ha', 'time');
  INSERT INTO test_ha VALUES (now(), 42.0);
  SELECT * FROM test_ha;
"

# 9. Read-Only through VIP
psql -h 10.10.1.250 -p 5001 -U postgres -d hope -c "SELECT * FROM test_ha;"

# 10. Clean up test table
psql -h 10.10.1.250 -p 5000 -U postgres -d hope -c "DROP TABLE test_ha;"

# 11. Monitoring endpoints
curl -s http://10.10.1.200:9187/metrics | grep pg_up
curl -s http://10.10.1.200:8008/metrics | grep patroni
```

---

## 15. Failover Testing

### 15.1 Planned Switchover (Zero Downtime)

```bash
# Switchover primary to pg-node2
docker exec patroni patronictl -c /home/postgres/postgres.yml switchover \
  --master pg-node1 --candidate pg-node2 --force

# Verify new primary
docker exec patroni patronictl -c /home/postgres/postgres.yml list

# Switchover back
docker exec patroni patronictl -c /home/postgres/postgres.yml switchover \
  --master pg-node2 --candidate pg-node1 --force
```

### 15.2 Simulate Primary Failure

```bash
# On VM 500 (current primary) — stop the Patroni container
docker stop patroni

# On VM 501 or 502 — watch failover (should take ~30-40 seconds)
watch -n 2 'docker exec patroni patronictl -c /home/postgres/postgres.yml list'

# After failover, pg-node2 or pg-node3 should be the new leader
# Applications connected via VIP (10.10.1.250:5000) should reconnect automatically

# Bring the old primary back
# On VM 500
docker start patroni
# It will rejoin as a replica automatically
```

### 15.3 Simulate etcd Node Failure

```bash
# Stop etcd on one node — cluster should remain healthy (2/3 quorum)
docker stop etcd   # on any one node

# Verify etcd still has quorum
docker exec etcd etcdctl endpoint health --cluster \
  --endpoints=http://10.10.1.201:2379,http://10.10.1.202:2379

# Patroni should continue operating normally
docker exec patroni patronictl -c /home/postgres/postgres.yml list

# Bring etcd back
docker start etcd
```

---

## 16. Operational Runbook

### Common patronictl Commands

```bash
# Cluster status
docker exec patroni patronictl -c /home/postgres/postgres.yml list

# Show cluster config
docker exec patroni patronictl -c /home/postgres/postgres.yml show-config

# Edit dynamic config
docker exec -it patroni patronictl -c /home/postgres/postgres.yml edit-config

# Planned switchover
docker exec patroni patronictl -c /home/postgres/postgres.yml switchover

# Restart PostgreSQL on a specific node (applies pending config changes)
docker exec patroni patronictl -c /home/postgres/postgres.yml restart hope-cluster pg-node1

# Reinitialize a broken replica (destroys data on that replica and re-clones)
docker exec patroni patronictl -c /home/postgres/postgres.yml reinit hope-cluster pg-node2

# Pause automatic failover (for maintenance)
docker exec patroni patronictl -c /home/postgres/postgres.yml pause

# Resume automatic failover
docker exec patroni patronictl -c /home/postgres/postgres.yml resume
```

### Startup Order (After Full Cluster Restart)

1. Start etcd on **all 3 nodes** simultaneously
2. Wait for etcd cluster to form (check with `etcdctl endpoint health`)
3. Start Patroni on **all 3 nodes** (order doesn't matter — Patroni elects leader)
4. Start HAProxy on VM 500 and VM 501
5. Start Keepalived on VM 500 and VM 501
6. Start PgBouncer on all 3 nodes
7. Start postgres_exporter on all 3 nodes

### Shutdown Order (For Planned Maintenance)

Reverse of startup:

1. Stop postgres_exporter, PgBouncer
2. Stop Keepalived
3. Stop HAProxy
4. Stop Patroni on replicas first, then primary
5. Stop etcd on all nodes

---

## 17. Connecting Applications

### Connection Strings

| Use Case                               | Connection String                                         |
| -------------------------------------- | --------------------------------------------------------- |
| **Read/Write (via VIP)**               | `postgresql://hope_app:password@10.10.1.250:5000/hope`    |
| **Read-Only (via VIP)**                | `postgresql://hope_reader:password@10.10.1.250:5001/hope` |
| **Read/Write (via PgBouncer on VIP)**  | `postgresql://hope_app:password@10.10.1.250:6432/hope?sslmode=require&schema=core` (set as `DATABASE_URL` — pooled, transaction mode) |
| **Direct to primary (bypass HAProxy)** | `postgresql://postgres:password@10.10.1.200:5432/hope`    |

### For Prisma (HOPE Project)

In `packages/database/.env`:

```env
DATABASE_URL="postgresql://hope_app:password@10.10.1.250:5000/hope?schema=public&connect_timeout=10"
```

### For NestJS API (apps/api)

The API Gateway connects through the VIP. PgBouncer is **mandatory** for production: runtime queries go through the pooler at port `6432` (transaction mode, validated by TASK-302 Stream C Phase 1), while migrations bypass the pooler and use the direct HAProxy R/W port `5000` via `DIRECT_URL`. See §10 above and [`03-pgbouncer-rollout.md`](../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md) for the full rationale.

---

## 18. Troubleshooting

### Common Issues

| Symptom                                       | Likely Cause                             | Fix                                                                                    |
| --------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `etcdctl: command not found` in container     | Using wrong image or entrypoint          | Verify etcd container is running: `docker ps`                                          |
| Patroni won't start — "etcd is not reachable" | etcd not ready or wrong endpoints        | Check etcd health, verify IP addresses in `.env`                                       |
| All nodes show as "Replica"                   | No leader elected — etcd quorum lost     | Check etcd cluster health, restart etcd if needed                                      |
| "Pending restart" on patronictl list          | Dynamic config changed, PG needs restart | Run `patronictl restart hope-cluster <node>`                                           |
| Replication lag growing                       | Network issue or replica overloaded      | Check `pg_stat_replication`, network latency, disk I/O                                 |
| VIP not responding                            | Keepalived down or interface wrong       | Check `systemctl status keepalived`, verify interface name                             |
| PgBouncer "Auth failed"                       | Password mismatch                        | Verify PgBouncer userlist.txt matches PG passwords                                     |
| "FATAL: no pg_hba.conf entry"                 | Client IP not in allowed range           | Check `pg_hba.conf` via Patroni config                                                 |
| Watchdog: "No such device"                    | softdog module not loaded                | Run `sudo modprobe softdog`, check `/dev/watchdog`                                     |
| `FATAL: could not load library "timescaledb"` | `shared_preload_libraries` not set       | Already set in docker-compose.yml Patroni config — check `show-config`                 |
| Continuous aggregates stuck after failover    | Known TimescaleDB bug #9360              | See [Known Issue](#known-issue-continuous-aggregate-refresh-jobs-after-failover) below |

### Known Issue: Continuous Aggregate Refresh Jobs After Failover

**TimescaleDB bug #9360** (open as of March 2026): If a continuous aggregate refresh job is mid-execution when the primary dies, the promoted replica inherits corrupted job state (`next_start = -infinity`). The scheduler never reschedules the job.

**Detection** — run after every failover:

```sql
SELECT j.id, j.application_name, js.last_start, js.last_finish, js.next_start
FROM timescaledb_information.jobs j
JOIN _timescaledb_internal.bgw_job_stat js ON j.id = js.job_id
WHERE js.next_start = '-infinity'::timestamptz;
```

**Fix** — reset stuck jobs:

```sql
UPDATE _timescaledb_internal.bgw_job_stat
SET last_finish = now(), next_start = now()
WHERE next_start = '-infinity'::timestamptz;
```

> This only affects jobs that were actively running at the exact moment of failover. Idle jobs survive intact.

### Logs

```bash
# Patroni logs (includes PG logs)
docker logs -f patroni

# etcd logs
docker logs -f etcd

# HAProxy logs
docker logs -f haproxy

# PgBouncer logs
docker logs -f pgbouncer

# Keepalived logs
journalctl -u keepalived -f
```

---

## Quick Reference

| What                            | Where                                                  |
| ------------------------------- | ------------------------------------------------------ |
| VIP (applications connect here) | `10.10.1.250`                                          |
| Read/Write port                 | `:5000`                                                |
| Read-Only port                  | `:5001`                                                |
| PgBouncer port                  | `:6432`                                                |
| HAProxy stats                   | `http://10.10.1.200:7000` or `http://10.10.1.201:7000` |
| Patroni API                     | `http://<any-node>:8008`                               |
| etcd client                     | `http://<any-node>:2379`                               |
| Config files                    | `~/postgres-ha/` on each VM                            |
| Data directory                  | `/data/postgresql/` on each VM                         |

### VM Specs

| VM  | IP          | vCPU | RAM   | OS Disk | Data Disk                                                    |
| --- | ----------- | ---- | ----- | ------- | ------------------------------------------------------------ |
| 500 | 10.10.1.200 | 8    | 16 GB | 64 GB   | Add via Proxmox (see [section 4](#4-disk-sizing--expansion)) |
| 501 | 10.10.1.201 | 8    | 16 GB | 64 GB   | Same as above                                                |
| 502 | 10.10.1.202 | 8    | 16 GB | 64 GB   | Same as above                                                |
