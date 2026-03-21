# Deploy High-Availability TimescaleDB — VMs 500–502

**Date**: 2026-03-18
**VMs**: 500 (`10.10.1.200`), 501 (`10.10.1.201`), 502 (`10.10.1.202`)
**Bridge**: vmbr1 | **Specs**: 8 vCPU / 16 GB RAM / 64 GB OS disk + data disk (each)
**Config files**: [`configs/postgres-ha/`](./configs/postgres-ha/) — docker-compose, patroni.yml, haproxy.cfg, keepalived
**Cloudflare SSH**: `ssh-db0.taphuynh.dev` (VM 500) | `ssh-db1.taphuynh.dev` (VM 501) | `ssh-db2.taphuynh.dev` (VM 502)
**Related**: [Infrastructure Overview](./proxmox-infrastructure-gitlab-rancher-plan.md) | [MinIO (VM 402)](./deploy-vm402-minio.md) | [GitLab (VM 410)](./deploy-vm410-gitlab.md) | [Runner (VM 411)](./deploy-vm411-gitlab-runner.md) | [Cloudflare Tunnel](./deploy-ct101-cloudflare-tunnel.md)

> **TimescaleDB** is a PostgreSQL extension for time-series data. The `timescale/timescaledb-ha` Docker image bundles PostgreSQL 17 + TimescaleDB 2.25 + Patroni 4.1.0 + pgBackRest in a single production-ready image — no custom Dockerfile needed. All standard PostgreSQL features, tools, and clients work unchanged.

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
10. [Deploy PgBouncer (Optional)](#10-deploy-pgbouncer-optional)
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
   │ + PG 17        │     │ + PG 17       │ │ + PG 17      │          │
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
| PostgreSQL        | 17.x       | Bundled in `timescale/timescaledb-ha` image     |
| Patroni           | 4.1.0      | Bundled in `timescale/timescaledb-ha` image     |
| pgBackRest        | 2.54.x     | Bundled in `timescale/timescaledb-ha` image     |
| etcd              | 3.5.21     | `quay.io/coreos/etcd:v3.5.21`                   |
| HAProxy           | 3.1        | `haproxy:3.1-alpine`                            |
| PgBouncer         | 1.23.1     | `edoburu/pgbouncer:1.23.1`                      |
| Keepalived        | 2.x        | apt package (host-level)                        |
| postgres_exporter | 0.16.0     | `prometheuscommunity/postgres-exporter:v0.16.0` |

> The `timescale/timescaledb-ha:pg17-all-amd64` image bundles TimescaleDB + PostgreSQL + Patroni + pgBackRest + 30+ extensions (PostGIS, pgvector, pg_cron, etc.) in a single image. No custom Dockerfile required.

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
| Database          | **TimescaleDB 2.25 on PG 17** | PostgreSQL superset with time-series, compression, and continuous aggregates                  |
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
- SSH access: `ssh hope@10.10.1.200`, `ssh hope@10.10.1.201`, `ssh hope@10.10.1.202`
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

```bash
# Allow cluster communication between nodes
sudo ufw allow from 10.10.1.200 to any
sudo ufw allow from 10.10.1.201 to any
sudo ufw allow from 10.10.1.202 to any

# Allow VIP
sudo ufw allow from 10.10.1.250 to any

# Allow VRRP (Keepalived)
sudo ufw allow proto vrrp from 10.10.1.0/24

# Verify
sudo ufw status
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

### 7.1 Deploy on All 3 Nodes

Copy the config files from `configs/postgres-ha/` to each VM, then deploy node-by-node.

```bash
# On each VM, create the project directory
mkdir -p ~/postgres-ha
cd ~/postgres-ha

# Copy configs (adjust per node — see configs/postgres-ha/README)
# scp from your workstation, or git clone, etc.
```

The etcd service is defined in each node's `docker-compose.yml`. Start etcd on **all 3 nodes simultaneously** (or within a few seconds of each other):

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

### 7.2 Verify etcd Cluster

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

The `timescale/timescaledb-ha:pg17-all-amd64` image includes everything pre-installed — no build step needed. It bundles:

- PostgreSQL 17 with TimescaleDB 2.25.2
- Patroni 4.1.0 (HA orchestrator)
- pgBackRest (backup)
- 30+ extensions: PostGIS 3, pgvector, pg_cron, timescaledb_toolkit, pgai, and more

### 8.1 Pull the Image

On **all 3 nodes**:

```bash
docker pull timescale/timescaledb-ha:pg17-all-amd64
```

### 8.2 Create the .env File

Copy `.env.example` to `.env` on each node and fill in passwords:

```bash
cp .env.example .env
# Edit .env — set strong passwords for PG_PASSWORD, REPL_PASSWORD
```

> **Security**: use `openssl rand -base64 24` to generate passwords. Never commit `.env` to version control.

### 8.3 Start Patroni — Node by Node

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

### 8.4 Verify Patroni Cluster

```bash
# From any node — install patronictl (or exec into the container)
docker exec patroni patronictl -c /etc/patroni/patroni.yml list

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

### 8.5 Configure Dynamic Settings

After the cluster is bootstrapped, apply production settings via `patronictl`:

```bash
docker exec -it patroni patronictl -c /etc/patroni/patroni.yml edit-config

# This opens an editor. Set:
```

```yaml
loop_wait: 10
ttl: 30
retry_timeout: 10
maximum_lag_on_failover: 1048576
synchronous_mode: true
synchronous_mode_strict: false
synchronous_node_count: 1
failsafe_mode: true
postgresql:
    use_pg_rewind: true
    use_slots: true
    parameters:
        # TimescaleDB (MUST be in shared_preload_libraries)
        shared_preload_libraries: 'timescaledb'
        timescaledb.max_background_workers: 16
        timescaledb.telemetry_level: 'off'
        # Memory (16 GB RAM per node)
        shared_buffers: 4GB
        effective_cache_size: 12GB
        work_mem: 128MB
        maintenance_work_mem: 1GB
        wal_buffers: 64MB
        # WAL
        max_wal_size: 4GB
        min_wal_size: 1GB
        # Connections
        max_connections: 200
        max_wal_senders: 10
        max_replication_slots: 10
        # Workers (formula: 3 + timescaledb.max_background_workers + max_parallel_workers)
        max_worker_processes: 27
        max_parallel_workers: 8
        max_parallel_workers_per_gather: 4
        max_parallel_maintenance_workers: 4
        # Checkpoints
        checkpoint_completion_target: 0.9
        checkpoint_timeout: 15min
        # I/O
        random_page_cost: 1.1
        effective_io_concurrency: 200
        # Replication
        hot_standby: 'on'
        wal_level: replica
        wal_log_hints: 'on'
        archive_mode: 'on'
        archive_command: '/bin/true'
        # Logging
        log_min_duration_statement: 1000
        log_checkpoints: 'on'
        log_connections: 'on'
        log_disconnections: 'on'
        log_lock_waits: 'on'
        # Security
        password_encryption: scram-sha-256
        huge_pages: try
```

> **TimescaleDB worker processes**: `max_worker_processes` must be at least `3 + timescaledb.max_background_workers + max_parallel_workers`. For 8 CPUs with 16 background workers: 3 + 16 + 8 = 27.

> **work_mem raised to 128MB**: TimescaleDB compression/decompression and aggregation over chunks are more memory-intensive than vanilla PostgreSQL queries.

> **Synchronous replication**: With `synchronous_mode: true` and `synchronous_node_count: 1`, every commit waits for at least one replica to confirm — zero data loss (RPO=0) during normal operation. `synchronous_mode_strict: false` allows fallback to async if all replicas are down, maintaining availability at the cost of potential data loss during that degraded state.

---

## 9. Deploy HAProxy + Keepalived

HAProxy routes connections to the correct PostgreSQL node. Keepalived provides a floating VIP so applications always connect to a single address.

### 9.1 Start HAProxy

HAProxy is defined in the docker-compose on **VM 500 and VM 501** only:

```bash
# VM 500
docker compose up -d haproxy

# VM 501
docker compose up -d haproxy
```

Verify:

```bash
# Stats dashboard
curl -s http://10.10.1.200:7000/stats | head -5

# Test primary routing
docker exec haproxy bash -c 'echo "SELECT 1;" | timeout 3 nc -q1 127.0.0.1 5000' 2>/dev/null

# Or from any machine on the network:
psql -h 10.10.1.200 -p 5000 -U postgres -c "SELECT inet_server_addr();"
```

Open the HAProxy stats dashboard: `http://10.10.1.200:7000/` — you should see the primary node as UP in the `pg_primary` backend and replicas as UP in `pg_replicas`.

### 9.2 Install and Configure Keepalived

Keepalived runs on the **host** (not in Docker) because it needs direct access to the network interface for VRRP.

**On VM 500 and VM 501:**

```bash
sudo apt-get install -y keepalived
```

**VM 500** (`/etc/keepalived/keepalived.conf`) — MASTER:

```
vrrp_script check_haproxy {
    script "/usr/bin/docker inspect --format='{{.State.Health.Status}}' haproxy | grep -q healthy"
    interval 3
    weight -20
    fall 3
    rise 2
}

vrrp_instance VI_PG {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 100
    advert_int 1

    authentication {
        auth_type PASS
        auth_pass hopepgha
    }

    virtual_ipaddress {
        10.10.1.250/24
    }

    track_script {
        check_haproxy
    }
}
```

**VM 501** (`/etc/keepalived/keepalived.conf`) — BACKUP:

```
vrrp_script check_haproxy {
    script "/usr/bin/docker inspect --format='{{.State.Health.Status}}' haproxy | grep -q healthy"
    interval 3
    weight -20
    fall 3
    rise 2
}

vrrp_instance VI_PG {
    state BACKUP
    interface eth0
    virtual_router_id 51
    priority 90
    advert_int 1

    authentication {
        auth_type PASS
        auth_pass hopepgha
    }

    virtual_ipaddress {
        10.10.1.250/24
    }

    track_script {
        check_haproxy
    }
}
```

> **Note**: Replace `eth0` with your actual interface name (`ip a` to check — may be `ens18` on Proxmox VMs).

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

## 10. Deploy PgBouncer (Optional)

PgBouncer sits between applications and PostgreSQL, multiplexing many client connections onto fewer database connections. Recommended for any application with more than ~50 concurrent connections.

PgBouncer is defined in each node's docker-compose. Start on **all 3 nodes**:

```bash
docker compose up -d pgbouncer
```

Verify:

```bash
# Connect through PgBouncer
psql -h 10.10.1.200 -p 6432 -U postgres -c "SELECT 1;"

# Check PgBouncer stats
psql -h 10.10.1.200 -p 6432 -U pgbouncer -d pgbouncer -c "SHOW POOLS;"
```

---

## 11. Deploy Monitoring (postgres_exporter)

The postgres_exporter exposes PostgreSQL metrics for Prometheus. Patroni 4.1.0 also exposes its own `/metrics` endpoint on port 8008.

Start on **all 3 nodes**:

```bash
docker compose up -d postgres-exporter
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

pgBackRest provides block-level incremental backups with parallel processing and S3 support.

### 12.1 Configure pgBackRest

On the **primary node** (wherever it is — Patroni manages this), create the pgBackRest config:

```bash
# Inside the patroni container
docker exec -it patroni bash

cat > /etc/pgbackrest/pgbackrest.conf << 'EOF'
[global]
repo1-path=/var/lib/pgbackrest
repo1-retention-full=2
repo1-retention-diff=7
compress-type=zst
compress-level=6
process-max=4
log-level-console=info
log-level-file=detail
start-fast=y
delta=y

[hope-cluster]
pg1-path=/home/postgres/pgdata/data
pg1-port=5432
pg1-user=postgres
EOF
```

> **For MinIO S3 backup target** (if VM 402 is available), replace `repo1-path` with:
>
> ```ini
> repo1-type=s3
> repo1-s3-endpoint=10.10.1.102:9000
> repo1-s3-bucket=pgbackrest
> repo1-s3-key=<minio-access-key>
> repo1-s3-key-secret=<minio-secret-key>
> repo1-s3-region=us-east-1
> repo1-s3-uri-style=path
> repo1-s3-verify-tls=n
> ```

### 12.2 Create Stanza and Initial Backup

```bash
# Create the stanza
docker exec patroni pgbackrest --stanza=hope-cluster stanza-create

# Run initial full backup
docker exec patroni pgbackrest --stanza=hope-cluster --type=full backup

# Verify
docker exec patroni pgbackrest --stanza=hope-cluster info
```

### 12.3 Schedule Automated Backups

Add cron jobs on the primary VM (or on all nodes — pgBackRest is smart enough to only backup from the primary):

```bash
# /etc/cron.d/pgbackrest
# Full backup every Sunday at 02:00
0 2 * * 0 root docker exec patroni pgbackrest --stanza=hope-cluster --type=full backup >> /var/log/pgbackrest-full.log 2>&1

# Differential backup every day at 02:00 (except Sunday)
0 2 * * 1-6 root docker exec patroni pgbackrest --stanza=hope-cluster --type=diff backup >> /var/log/pgbackrest-diff.log 2>&1
```

---

## 13. Security Hardening

### 13.1 PostgreSQL Authentication

The Patroni bootstrap config sets `scram-sha-256` for password encryption. After bootstrap, verify `pg_hba.conf`:

```bash
docker exec patroni cat /home/postgres/pgdata/data/pg_hba.conf
```

The Patroni config generates a `pg_hba.conf` with these entries:

```
# TYPE    DATABASE    USER          ADDRESS         METHOD
local     all         all                           peer
host      all         all           127.0.0.1/32    scram-sha-256
host      all         all           ::1/128         scram-sha-256
host      replication replicator    10.10.1.0/24    scram-sha-256
host      all         all           10.10.1.0/24    scram-sha-256
host      all         all           0.0.0.0/0       reject
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

---

## 14. Verify the Cluster

### Full Stack Verification Checklist

```bash
# 1. etcd cluster health
docker exec etcd etcdctl endpoint health --cluster \
  --endpoints=http://10.10.1.200:2379,http://10.10.1.201:2379,http://10.10.1.202:2379

# 2. Patroni cluster status
docker exec patroni patronictl -c /etc/patroni/patroni.yml list

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
docker exec patroni patronictl -c /etc/patroni/patroni.yml switchover \
  --master pg-node1 --candidate pg-node2 --force

# Verify new primary
docker exec patroni patronictl -c /etc/patroni/patroni.yml list

# Switchover back
docker exec patroni patronictl -c /etc/patroni/patroni.yml switchover \
  --master pg-node2 --candidate pg-node1 --force
```

### 15.2 Simulate Primary Failure

```bash
# On VM 500 (current primary) — stop the Patroni container
docker stop patroni

# On VM 501 or 502 — watch failover (should take ~30-40 seconds)
watch -n 2 'docker exec patroni patronictl -c /etc/patroni/patroni.yml list'

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
docker exec patroni patronictl -c /etc/patroni/patroni.yml list

# Bring etcd back
docker start etcd
```

---

## 16. Operational Runbook

### Common patronictl Commands

```bash
# Cluster status
docker exec patroni patronictl -c /etc/patroni/patroni.yml list

# Show cluster config
docker exec patroni patronictl -c /etc/patroni/patroni.yml show-config

# Edit dynamic config
docker exec -it patroni patronictl -c /etc/patroni/patroni.yml edit-config

# Planned switchover
docker exec patroni patronictl -c /etc/patroni/patroni.yml switchover

# Restart PostgreSQL on a specific node (applies pending config changes)
docker exec patroni patronictl -c /etc/patroni/patroni.yml restart hope-cluster pg-node1

# Reinitialize a broken replica (destroys data on that replica and re-clones)
docker exec patroni patronictl -c /etc/patroni/patroni.yml reinit hope-cluster pg-node2

# Pause automatic failover (for maintenance)
docker exec patroni patronictl -c /etc/patroni/patroni.yml pause

# Resume automatic failover
docker exec patroni patronictl -c /etc/patroni/patroni.yml resume
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
| **Read/Write (via PgBouncer on VIP)**  | `postgresql://hope_app:password@10.10.1.250:6432/hope`    |
| **Direct to primary (bypass HAProxy)** | `postgresql://postgres:password@10.10.1.200:5432/hope`    |

### For Prisma (HOPE Project)

In `packages/database/.env`:

```env
DATABASE_URL="postgresql://hope_app:password@10.10.1.250:5000/hope?schema=public&connect_timeout=10"
```

### For NestJS API (apps/api)

The API Gateway connects through the VIP. Prisma handles connection pooling, so PgBouncer is optional if you use Prisma exclusively.

---

## 18. Troubleshooting

### Common Issues

| Symptom                                       | Likely Cause                             | Fix                                                                                    |
| --------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `etcdctl: command not found` in container     | Using wrong image or entrypoint          | Verify etcd container is running: `docker ps`                                          |
| Patroni won't start — "etcd is not reachable" | etcd not ready or wrong endpoints        | Check etcd health, verify IP addresses in patroni.yml                                  |
| All nodes show as "Replica"                   | No leader elected — etcd quorum lost     | Check etcd cluster health, restart etcd if needed                                      |
| "Pending restart" on patronictl list          | Dynamic config changed, PG needs restart | Run `patronictl restart hope-cluster <node>`                                           |
| Replication lag growing                       | Network issue or replica overloaded      | Check `pg_stat_replication`, network latency, disk I/O                                 |
| VIP not responding                            | Keepalived down or interface wrong       | Check `systemctl status keepalived`, verify interface name                             |
| PgBouncer "Auth failed"                       | Password mismatch                        | Verify PgBouncer userlist.txt matches PG passwords                                     |
| "FATAL: no pg_hba.conf entry"                 | Client IP not in allowed range           | Check `pg_hba.conf` via Patroni config                                                 |
| Watchdog: "No such device"                    | softdog module not loaded                | Run `sudo modprobe softdog`, check `/dev/watchdog`                                     |
| `FATAL: could not load library "timescaledb"` | `shared_preload_libraries` not set       | Must be in patroni.yml `postgresql.parameters` section                                 |
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
