# Resource Reallocation Plan — Live Migration

**Date**: 2026-03-24
**Host**: Dell Precision 7920 Tower — Proxmox VE 9.1
**Hardware**: 2x Intel Xeon Platinum 8168 (96 logical CPUs) | 256 GB DDR4 ECC | 2x NVIDIA RTX 2000 Ada 16 GB | 2 TB SSD
**Related**: [Infrastructure Overview](./proxmox-infrastructure-gitlab-rancher-plan.md) | [Network Topology](./proxmox-network-topology-design.md) | [GPU Deployment](./proxmox-gpu-self-hosted-deployment-2026-03-12.md) | [Redis Deployment](../deployments/deploy-vm420-421-redis.md) | [PostgreSQL HA Deployment](../deployments/deploy-vm500-502-postgres-ha.md)

> **Context**: All VMs/LXCs are currently running. This plan reallocates resources to optimize for 100 concurrent HOPE/ARCA-VOX users while reducing waste on over-provisioned VMs. CPU/RAM changes require VM shutdown/restart; disk expansions are online. Plan for maintenance windows.

---

## Table of Contents

1. [Current vs Proposed Allocation](#1-current-vs-proposed-allocation)
2. [Change Summary](#2-change-summary)
3. [Justification per VM](#3-justification-per-vm)
4. [Resource Budget](#4-resource-budget)
5. [NUMA Pinning Strategy](#5-numa-pinning-strategy)
6. [Pre-Migration Preparation](#6-pre-migration-preparation)
7. [Execution Plan — Phase-by-Phase](#7-execution-plan--phase-by-phase)
8. [Proxmox Commands Reference](#8-proxmox-commands-reference)
9. [Rollback Procedures](#9-rollback-procedures)
10. [Post-Migration Verification](#10-post-migration-verification)
11. [Disk I/O Optimization](#11-disk-io-optimization)
12. [Monitoring Setup](#12-monitoring-setup)
13. [Risk Assessment](#13-risk-assessment)

---

## 1. Current vs Proposed Allocation

### Current Allocation (Running)

| VMID | Name | vCPU | RAM | Boot Disk | Data Disk | IP | Apps |
|------|------|------|-----|-----------|-----------|-----|------|
| CT 100 | cloudflared | 1 | 0.5 GB | 2 GB | — | multi-homed | Cloudflare Tunnel |
| VM 200 | ubuntu-live-gpu | 64 | 128 GB | 64 GB | 300 GB | 10.10.1.10 | AI apps v2 + 2× GPU (api, stt-v2, smr, nlp) |
| VM 201 | rb | 2 | 8 GB | 64 GB | — | 10.10.2.11 | Marketing websites |
| VM 400 | master | 8 | 16 GB | 64 GB | — | 10.10.1.100 | Rancher, Argo CD |
| VM 401 | vuvu | 64 | 64 GB | 400 GB | — | 10.10.1.101 | AI apps v1 without GPU |
| VM 402 | minio | 8 | 16 GB | 300 GB | — | 10.10.1.102 | MinIO S3 object storage |
| VM 410 | gitlab | 8 | 16 GB | 64 GB | — | 10.10.1.110 | GitLab CE |
| VM 411 | gitlab-runner | 8 | 16 GB | 250 GB | — | 10.10.1.111 | GitLab Runners |
| VM 420 | redis-dev | 2 | 2 GB | 16 GB | — | 10.10.1.120 | Redis (dev) |
| VM 421 | redis-staging | 2 | 4 GB | 32 GB | — | 10.10.1.121 | Redis (staging) |
| VM 500 | database-00 | 8 | 16 GB | 64 GB | — | 10.10.1.200 | TimescaleDB HA (Patroni) |
| VM 501 | database-01 | 8 | 16 GB | 64 GB | — | 10.10.1.201 | TimescaleDB HA (Patroni) |
| VM 502 | database-02 | 8 | 16 GB | 64 GB | — | 10.10.1.202 | TimescaleDB HA (Patroni) |
| **TOTAL** | | **191** | **318.5 GB** | **1,438 GB** | **300 GB** | | |

**Current over-allocation:**

| Resource | Physical | Allocated | Over-commit Ratio |
|----------|----------|-----------|-------------------|
| CPU | 96 cores | 191 vCPU | **1.99:1** |
| RAM | 256 GB | 318.5 GB | **1.24:1** |
| Disk | 2,000 GB | 1,738 GB | 0.87:1 (OK) |

> RAM is **62.5 GB over-committed**. If all VMs hit peak simultaneously, the OOM killer will terminate processes. CPU over-commit is tolerable due to bursty workloads, but RAM over-commit is dangerous for databases and inference.

### Proposed Allocation

| VMID | Name | vCPU | RAM | Boot Disk | Data Disk | IP | Apps | Change |
|------|------|------|-----|-----------|-----------|-----|------|--------|
| CT 100 | cloudflared | 1 | 0.5 GB | 2 GB | — | multi-homed | Cloudflare Tunnel | — |
| VM 200 | ubuntu-live-gpu | **16** | **48 GB** | 64 GB | 300 GB | 10.10.1.10 | AI apps v2 + 2× GPU | ↓ CPU, ↓ RAM |
| VM 201 | rb | 2 | **4 GB** | 64 GB | — | 10.10.2.11 | Marketing websites | ↓ RAM |
| VM 400 | master | 8 | 16 GB | 64 GB | — | 10.10.1.100 | Rancher, Argo CD | — |
| VM 401 | vuvu | **16** | **32 GB** | 400 GB | — | 10.10.1.101 | AI apps v1 without GPU | ↓ CPU, ↓ RAM |
| VM 402 | minio | **4** | **8 GB** | 300 GB | — | 10.10.1.102 | MinIO S3 object storage | ↓ CPU, ↓ RAM |
| VM 410 | gitlab | 8 | 16 GB | **250 GB** | — | 10.10.1.110 | GitLab CE | ↑ Disk |
| VM 411 | gitlab-runner | 8 | **12 GB** | 250 GB | — | 10.10.1.111 | GitLab Runners | ↓ RAM |
| VM 420 | redis-dev | 2 | 2 GB | 16 GB | — | 10.10.1.120 | Redis (dev) | — (no change) |
| VM 421 | redis-staging | 2 | **2 GB** | 32 GB | — | 10.10.1.121 | Redis (staging) | ↓ RAM |
| VM 500 | database-00 | 8 | **32 GB** | **200 GB** | — | 10.10.1.200 | TimescaleDB HA primary | ↑ RAM, ↑ Disk |
| VM 501 | database-01 | 8 | **24 GB** | **200 GB** | — | 10.10.1.201 | TimescaleDB HA replica | ↑ RAM, ↑ Disk |
| VM 502 | database-02 | 8 | **24 GB** | **200 GB** | — | 10.10.1.202 | TimescaleDB HA replica | ↑ RAM, ↑ Disk |
| **TOTAL** | | **81** | **220.5 GB** | **1,874 GB** | **300 GB** | | | |

**After reallocation:**

| Resource | Physical | Allocated | Ratio | Status |
|----------|----------|-----------|-------|--------|
| CPU | 96 cores | 81 vCPU | **0.84:1** | No over-commit, 15 cores headroom |
| RAM | 256 GB | 220.5 GB | **0.86:1** | No over-commit, ~27 GB for Proxmox host + buffer |
| Disk | 2,000 GB | 2,174 GB | **1.09:1** | Thin provisioned — see [Disk note](#disk-over-allocation-note) |

### Disk Over-Allocation Note

Total proposed virtual disk (2,174 GB) exceeds physical SSD (2,000 GB) by 174 GB. This is acceptable because:
- Proxmox uses **thin provisioning** by default — disk images only consume space for data actually written, not the full virtual size.
- Actual disk usage will be well under 2 TB since most VMs use a fraction of their allocated disk (e.g., Redis VMs use < 1 GB of their 16-32 GB allocation).
- **Monitor actual disk usage** on the Proxmox host with `df -h /` and `zpool list` (if ZFS) or `lvs` (if LVM). Set an alert at 85% physical usage.
- If physical disk approaches 90%, expand by adding a second SSD or reducing VM disk allocations.

### Disk Note — Cannot Shrink

Proxmox **cannot shrink virtual disks**. The following VMs retain their original disk sizes even though the target was smaller:
- **VM 420 (Redis dev)**: Retains 16 GB (target was 8 GB) — 8 GB wasted
- **VM 421 (Redis staging)**: Retains 32 GB (target was 8 GB) — 24 GB wasted

The total wasted disk (32 GB) is negligible on a 2 TB SSD. Recreating disks to shrink them requires data migration and carries downtime risk — not justified for this small amount.

---

## 2. Change Summary

### Resources Being Reduced

| VM | Resource | Current | Proposed | Freed |
|----|----------|---------|----------|-------|
| VM 200 (AI + GPU) | vCPU | 64 | 16 | **48 cores** |
| VM 200 (AI + GPU) | RAM | 128 GB | 48 GB | **80 GB** |
| VM 201 (marketing) | RAM | 8 GB | 4 GB | **4 GB** |
| VM 401 (AI no GPU) | vCPU | 64 | 16 | **48 cores** |
| VM 401 (AI no GPU) | RAM | 64 GB | 32 GB | **32 GB** |
| VM 402 (MinIO) | vCPU | 8 | 4 | **4 cores** |
| VM 402 (MinIO) | RAM | 16 GB | 8 GB | **8 GB** |
| VM 411 (Runner) | RAM | 16 GB | 12 GB | **4 GB** |
| VM 421 (Redis staging) | RAM | 4 GB | 2 GB | **2 GB** |

**Total freed: 100 vCPUs, 130 GB RAM**

### Resources Being Increased

| VM | Resource | Current | Proposed | Added |
|----|----------|---------|----------|-------|
| VM 410 (GitLab) | Disk | 64 GB | 250 GB | **+186 GB** |
| VM 500 (DB primary) | RAM | 16 GB | 32 GB | **+16 GB** |
| VM 500 (DB primary) | Disk | 64 GB | 200 GB | **+136 GB** |
| VM 501 (DB replica) | RAM | 16 GB | 24 GB | **+8 GB** |
| VM 501 (DB replica) | Disk | 64 GB | 200 GB | **+136 GB** |
| VM 502 (DB replica) | RAM | 16 GB | 24 GB | **+8 GB** |
| VM 502 (DB replica) | Disk | 64 GB | 200 GB | **+136 GB** |

**Total added: 0 vCPUs, 32 GB RAM, 594 GB disk**

### Net Change

| Resource | Freed | Added | Net Saved |
|----------|-------|-------|-----------|
| CPU | 100 cores | 0 | **100 cores freed** |
| RAM | 130 GB | 32 GB | **98 GB freed** |

### VMs With No Changes

| VMID | Name | Specs | Reason |
|------|------|-------|--------|
| CT 100 | cloudflared | 1c/0.5G/2GB | Already minimal |
| VM 400 | master | 8c/16G/64GB | Appropriate for Rancher + ArgoCD |
| VM 420 | redis-dev | 2c/2G/16GB | Already at target size |

---

## 3. Justification per VM

### VM 200 — AI Apps with GPU (64 → 16 vCPU, 128 → 48 GB RAM)

**Why this is safe:**
- GPU-bound workloads (STT Whisper, NLP BERT) are limited by GPU compute, not CPU. The GPU pipeline needs CPU cores to feed data, but 16 cores is sufficient to saturate 2x RTX 2000 Ada.
- The STT execution profile for multi-GPU (2x RTX 2000 Ada) specifies 40 concurrent streams with batch size 8 — this needs ~8-12 CPU cores for audio preprocessing and data loading, not 64.
- 48 GB RAM covers: OS (~2 GB) + NestJS API gateway (~4 GB heap) + Python processes (~8-12 GB) + CUDA host memory (~8 GB) + model weights in CPU memory (~8 GB) + page cache (~8 GB).
- The K3s control plane and NVIDIA GPU Operator add ~4 GB overhead.
- Current 128 GB allocation leaves ~80 GB unused — pure waste.

**Risk:** If running many concurrent CPU-heavy preprocessing tasks, 16 cores could become a bottleneck. Monitor CPU utilization for the first week. If sustained above 80%, increase to 24 cores.

### VM 201 — Marketing Websites (8 → 4 GB RAM)

**Why this is safe:**
- Static websites served by Nginx/similar reverse proxy use minimal RAM.
- 4 GB provides ample room for a web server, PHP-FPM (if WordPress), and OS overhead.
- No change to CPU (2 cores) — already appropriately sized.

### VM 401 — AI Apps v1 Without GPU (64 → 16 vCPU, 64 → 32 GB RAM)

**Why this is safe:**
- CPU-only Whisper inference benefits from multiple cores for parallel processing, but the STT execution profile for CPU-only with 96 cores specifies 50 concurrent streams — that's across the entire host, not one VM.
- 16 cores provides good parallelism for CPU-only BERT and Whisper inference. The STT worker default is 2 processes × 4 threads = 8 active threads.
- 32 GB RAM covers model weights (~8-12 GB across all services) + inference buffers (~8 GB) + API processes (~4 GB) + OS (~2 GB).
- V1 apps serve as fallback/legacy — lower traffic than V2.

### VM 402 — MinIO (8 → 4 vCPU, 16 → 8 GB RAM)

**Why this is safe:**
- MinIO is I/O-bound, not CPU or RAM-bound at this scale. The Go binary is lightweight.
- 4 vCPUs handle concurrent S3 requests from GitLab, GitLab Runner, and HOPE apps simultaneously.
- 8 GB RAM provides sufficient page cache for read performance on frequently accessed objects (Docker layers, LFS objects).
- Production MinIO deployments at 10x this scale run on 4 cores / 8 GB.

### VM 410 — GitLab (disk 64 → 250 GB)

**Why this is needed:**
- Git repos with history (monorepo): 5-10 GB.
- Container registry layers: 20-50 GB with regular builds.
- CI artifacts retention: 10-20 GB.
- Embedded PostgreSQL data: 5-10 GB.
- Backups stored locally: 10-20 GB.
- 64 GB will fill within weeks of active CI/CD usage.
- CPU (8) and RAM (16 GB) are appropriate per GitLab official sizing for up to 1,000 users.

### VM 411 — GitLab Runner (16 → 12 GB RAM)

**Why this is safe:**
- 4 specialized runners with 9 total concurrent job slots.
- Each Docker executor job needs ~2-3 GB RAM for Node.js/TypeScript builds.
- 12 GB supports 4 concurrent builds (3 GB each) comfortably.
- Disk (250 GB) remains unchanged — needed for Docker layer caching.

### VM 420 — Redis Dev (no change)

Already at target: 2 vCPU, 2 GB RAM, 16 GB disk. The `maxmemory 512mb` setting leaves 1.5 GB for OS + Docker + AOF rewrite buffers.

### VM 421 — Redis Staging (4 → 2 GB RAM)

**Config changes required before RAM reduction:**

The staging Redis is deployed via Docker Compose at `/opt/redis/docker-compose.yml` with:
- Config file: `/opt/redis/redis.conf` (copied from `redis-staging.conf` during deployment)
- Docker memory limit: `${REDIS_MEM_LIMIT:-2560M}` (from `.env`)
- Redis `maxmemory`: `2gb` (in `redis.conf`)
- Dangerous commands renamed: `CONFIG` → `CONFIG_b4f8a2c1`

**Required updates before shutdown:**
1. Edit `/opt/redis/redis.conf` on VM 421: change `maxmemory 2gb` → `maxmemory 1gb`
2. Edit `/opt/redis/.env` on VM 421: set `REDIS_MEM_LIMIT=1536M` (1.5 GB for container, leaving 512 MB for OS + Docker)
3. Apply runtime change via Docker exec: `docker exec hope-redis redis-cli -a "$REDIS_PASS" CONFIG_b4f8a2c1 SET maxmemory 1gb` (uses the renamed CONFIG command)
4. Trigger BGSAVE before shutdown: `docker exec hope-redis redis-cli -a "$REDIS_PASS" BGSAVE`

With 2 GB VM RAM and `maxmemory 1gb`, Redis has 1 GB for data and the remaining 1 GB covers: OS (~300 MB), Docker runtime (~200 MB), AOF rewrite buffer (~300 MB), redis-exporter (~50 MB), and system buffers (~150 MB).

> Redis will evict keys per the `allkeys-lru` policy if 1 GB is reached — acceptable for staging.

### VMs 500-502 — TimescaleDB HA (16 → 32/24/24 GB RAM, 64 → 200 GB disk)

**Why RAM increase is critical:**
- PostgreSQL performance is dominated by `shared_buffers` and OS page cache.
- Current patroni.yml has `shared_buffers: 4GB` and `effective_cache_size: 12GB` (tuned for 16 GB RAM).
- New PostgreSQL parameters after RAM increase:

| Parameter | Current (16 GB) | Primary (32 GB) | Replica (24 GB) |
|-----------|-----------------|-----------------|-----------------|
| `shared_buffers` | 4 GB | **8 GB** | **6 GB** |
| `effective_cache_size` | 12 GB | **24 GB** | **18 GB** |
| `work_mem` | 128 MB | **256 MB** | **192 MB** |
| `maintenance_work_mem` | 1 GB | **2 GB** | **1.5 GB** |
| `wal_buffers` | 64 MB | **128 MB** | **96 MB** |
| `max_connections` | 200 | 200 | 200 |
| `max_wal_size` | 4 GB | 4 GB | 4 GB |
| `huge_pages` | try | try | try |

- With 16 GB, `shared_buffers` was limited to 4 GB — frequent cache misses on queries joining encounter data, transcriptions, and medical records.
- The primary handles all writes (encounters, transcriptions, medical events from both v1 and v2 apps) plus continuous aggregates and compression policies — needs more RAM than replicas.

**Why disk increase is critical:**
- 64 GB per database node is dangerously small:
  - WAL files during replication lag: 10-20 GB.
  - Base backup (pgBackRest): 10-30 GB.
  - Temporary tables for complex queries: 2-5 GB.
  - TimescaleDB chunks (pre-compression): grows with encounter volume.
- At 64 GB, the database will run out of disk within weeks of production use, causing writes to fail and the cluster to enter read-only mode.

---

## 4. Resource Budget

### CPU Budget (96 physical cores)

```
┌─────────────────────────────────────────────────────────┐
│                   96 PHYSICAL CORES                      │
├──────────────────┬──────────────────────────────────────┤
│ Allocated (81)   │ Available (15)                        │
├──────────────────┴──────────────────────────────────────┤
│                                                          │
│  GPU AI (VM 200)     ████████████████  16 cores          │
│  CPU AI (VM 401)     ████████████████  16 cores          │
│  Rancher (VM 400)    ████████  8 cores                   │
│  GitLab (VM 410)     ████████  8 cores                   │
│  Runner (VM 411)     ████████  8 cores                   │
│  DB Primary (VM 500) ████████  8 cores                   │
│  DB Replica (VM 501) ████████  8 cores                   │
│  DB Replica (VM 502) ████████  8 cores                   │
│  MinIO (VM 402)      ████  4 cores                       │
│  Marketing (VM 201)  ██  2 cores                         │
│  Redis Dev (VM 420)  ██  2 cores                         │
│  Redis Stg (VM 421)  ██  2 cores                         │
│  Tunnel (CT 100)     █  1 core                           │
│                                                          │
│  HEADROOM            ███████████████  15 cores           │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### RAM Budget (256 GB)

```
┌─────────────────────────────────────────────────────────┐
│                    256 GB RAM                            │
├──────────────────┬──────────────────────────────────────┤
│ Allocated (220.5)│ Available (35.5)                      │
├──────────────────┴──────────────────────────────────────┤
│                                                          │
│  GPU AI (VM 200)     ████████████████████████  48 GB     │
│  CPU AI (VM 401)     ████████████████  32 GB             │
│  DB Primary (VM 500) ████████████████  32 GB             │
│  DB Replica (VM 501) ████████████  24 GB                 │
│  DB Replica (VM 502) ████████████  24 GB                 │
│  Rancher (VM 400)    ████████  16 GB                     │
│  GitLab (VM 410)     ████████  16 GB                     │
│  Runner (VM 411)     ██████  12 GB                       │
│  MinIO (VM 402)      ████  8 GB                          │
│  Marketing (VM 201)  ██  4 GB                            │
│  Redis Dev (VM 420)  █  2 GB                             │
│  Redis Stg (VM 421)  █  2 GB                             │
│  Tunnel (CT 100)     ▌  0.5 GB                           │
│                                                          │
│  Proxmox Host        ████  ~8 GB (reserved)              │
│  HEADROOM            ██████████████  ~27.5 GB            │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

## 5. NUMA Pinning Strategy

The Dell 7920 with 2x Xeon Platinum 8168 has **2 NUMA nodes**, each with 48 logical cores and its own memory controller. Cross-NUMA memory access incurs ~40% latency penalty.

### Identify NUMA Topology (on Proxmox host)

```bash
numactl --hardware
lscpu | grep NUMA
lstopo-no-graphics
```

### Identify GPU NUMA Node

```bash
# List all NVIDIA GPUs and their PCI addresses
lspci | grep -i nvidia
# Example output:
#   17:00.0 VGA compatible controller: NVIDIA Corporation AD107GL [RTX 2000 Ada Generation]
#   65:00.0 VGA compatible controller: NVIDIA Corporation AD107GL [RTX 2000 Ada Generation]

# Check which NUMA node each GPU belongs to (replace with actual PCI address)
cat /sys/bus/pci/devices/0000:17:00.0/numa_node
cat /sys/bus/pci/devices/0000:65:00.0/numa_node

# If output is -1, the BIOS hasn't assigned a NUMA node — check the physical PCIe slot:
#   Slots connected to CPU1 (NUMA 0): usually lower PCI bus numbers
#   Slots connected to CPU2 (NUMA 1): usually higher PCI bus numbers
# Consult the Dell 7920 technical manual for slot-to-CPU mapping.
```

### Recommended NUMA Pinning

| VM | NUMA Node | Reason |
|----|-----------|--------|
| VM 200 (AI + GPU) | **Node closest to GPU PCIe slot** (determined above) | GPU DMA transfers should use local memory |
| VM 500 (DB primary) | **Node 0** | Memory-intensive writes benefit from local access |
| VM 501, 502 (DB replicas) | **Node 1** | Separate from primary to distribute memory bandwidth |
| VM 401 (AI no GPU) | **Node 1** | CPU-only inference uses the other NUMA node |
| Others | **Any (no pinning)** | Workloads not latency-sensitive |

### Apply in Proxmox

NUMA pinning is applied during the respective VM's shutdown window in the execution plan. The commands are included in each phase. For reference:

```bash
# Enable NUMA for a VM (takes effect on next boot)
qm set <VMID> --numa 1

# Bind to a specific NUMA node
# cpus=0-N must match the VM's core count minus 1
# hostnodes=0 or hostnodes=1 selects the NUMA node
# memory=<MB> must match the VM's RAM allocation
qm set <VMID> --numa0 "cpus=0-<CORES-1>,hostnodes=<NODE>,memory=<RAM_MB>,policy=bind"

# Verify after VM boot
numastat -c qemu    # On Proxmox host — shows memory distribution per VM
```

> **Note:** NUMA pinning is set in VM config and takes effect on next boot. The `policy=bind` forces strict local allocation — the VM will fail to start if the NUMA node doesn't have enough free memory. Ensure the node has capacity before binding.

---

## 6. Pre-Migration Preparation

### 6.1 Estimated Total Maintenance Window

| Phase | VMs | Estimated Duration | Downtime Impact |
|-------|-----|--------------------|-----------------|
| Pre-flight (snapshots) | All | 10-15 min | None (online snapshots) |
| Phase 1 (low-risk) | 201, 421 | 15-20 min | Marketing site, staging Redis |
| Phase 2 (infrastructure) | 402, 410, 411 | 30-45 min | GitLab, CI/CD, MinIO |
| Phase 3 (database rolling) | 500, 501, 502 | 45-60 min | Brief read-only during switchover (~10s) |
| Phase 4 (AI workloads) | 401, 200 | 30-45 min | HOPE v1 then v2 service interruption |
| Phase 5 (verification) | — | 15-20 min | None |
| **TOTAL** | | **~2.5-3.5 hours** | |

> Phases can be spread across multiple maintenance windows if a single long window is not feasible. Recommended split: Phase 1-2 in one window (evening), Phase 3 in another (low-traffic), Phase 4 during a scheduled maintenance.

### 6.2 Team Notification Template

Send this to the team before starting:

```
Subject: [Maintenance] Server Resource Reallocation — [DATE] [TIME]-[TIME] UTC

Hi team,

We will be performing resource reallocation on the homelab server to optimize
for production workloads. The following services will have brief interruptions:

Phase 1 (~15 min): Marketing site, staging Redis — minimal impact
Phase 2 (~30 min): GitLab, GitLab Runner, MinIO — NO CI/CD during this window
Phase 3 (~45 min): Database cluster — rolling upgrade, near-zero downtime
Phase 4 (~30 min): AI services — HOPE v1 and v2 will be briefly unavailable

Action required:
- Do NOT push code or trigger CI pipelines during Phase 2
- Active consultations on HOPE will be interrupted during Phase 4
- Save any unsaved work before the maintenance window

I will send updates as each phase completes.
```

### 6.3 Pre-Flight Checklist

Run these checks **before** starting any phase:

```bash
# On Proxmox host — verify all VMs are running
qm list | grep -E "running|stopped"

# Verify current resource allocation matches expectations
for vmid in 200 201 400 401 402 410 411 420 421 500 501 502; do
  echo "--- VM $vmid ---"
  qm config $vmid | grep -E 'cores|memory|balloon|numa'
done

# Check host resource availability
free -h                         # Available RAM on host
df -h /                         # Available disk on host
cat /proc/cpuinfo | grep processor | wc -l   # CPU count

# Verify no active CI jobs
ssh gitlab-runner "sudo gitlab-runner list"

# Verify database cluster health
ssh database-00 "docker exec patroni patronictl -c /home/postgres/postgres.yml list"

# Verify Redis health
redis-cli -h 10.10.1.120 -a '<dev-password>' ping
redis-cli -h 10.10.1.121 -a '<staging-password>' ping
```

### 6.4 Snapshot All VMs

```bash
# On Proxmox host — snapshot every VM before changes
for vmid in 200 201 400 401 402 410 411 420 421 500 501 502; do
  echo "Snapshotting VM $vmid..."
  qm snapshot $vmid pre-realloc-$(date +%Y%m%d) --description "Before resource reallocation $(date)"
done

# Verify all snapshots were created
for vmid in 200 201 400 401 402 410 411 420 421 500 501 502; do
  echo "--- VM $vmid snapshots ---"
  qm listsnapshot $vmid
done
```

> **Critical:** Snapshots allow instant rollback if a VM fails to boot or services crash after resource changes. LXC container CT 100 uses `pct snapshot 100` instead of `qm snapshot`.

---

## 7. Execution Plan — Phase-by-Phase

All VMs are running. CPU/RAM changes require shutdown. Disk expansions are online. The plan minimizes downtime by grouping changes to avoid cascading service interruptions.

---

### Phase 1 — Low-Risk VMs (No Service Dependencies)

**VMs:** VM 201 (marketing), VM 421 (Redis staging)
**Impact:** Marketing site brief downtime (~5 min), staging Redis brief restart (~5 min)
**Estimated duration:** 15-20 minutes total
**VM 420 (Redis dev):** No changes needed — already at target (2c/2G/16GB)

#### Phase 1a — VM 421 (Redis Staging): RAM 4 GB → 2 GB

**Step 1: Update Redis configuration on VM 421 BEFORE shutdown**

> **Important:** The staging Redis renames the `CONFIG` command to `CONFIG_b4f8a2c1` (see `redis-staging.conf` line 66). You must use the renamed command for runtime changes.

```bash
# SSH into VM 421
ssh hope@10.10.1.121
# Or via Cloudflare tunnel:
ssh ssh-redis-staging

# 1a. Update the redis.conf file on disk (this file is bind-mounted into Docker)
sudo sed -i 's/^maxmemory 2gb/maxmemory 1gb/' /opt/redis/redis.conf

# 1b. Verify the file change
grep '^maxmemory' /opt/redis/redis.conf
# Expected output: maxmemory 1gb

# 1c. Apply the change at runtime (uses renamed CONFIG command)
docker exec hope-redis redis-cli -a "$(grep REDIS_PASS /opt/redis/.env | cut -d= -f2)" \
  CONFIG_b4f8a2c1 SET maxmemory 1gb

# 1d. Verify runtime change
docker exec hope-redis redis-cli -a "$(grep REDIS_PASS /opt/redis/.env | cut -d= -f2)" \
  INFO memory | grep -E 'maxmemory:|maxmemory_human:'
# Expected: maxmemory:1073741824 / maxmemory_human:1.00G

# 1e. Update Docker Compose memory limit in .env
sudo sed -i 's/^REDIS_MEM_LIMIT=.*/REDIS_MEM_LIMIT=1536M/' /opt/redis/.env
# If REDIS_MEM_LIMIT doesn't exist in .env, add it:
grep -q REDIS_MEM_LIMIT /opt/redis/.env || echo 'REDIS_MEM_LIMIT=1536M' | sudo tee -a /opt/redis/.env

# 1f. Trigger persistence flush before shutdown
docker exec hope-redis redis-cli -a "$(grep REDIS_PASS /opt/redis/.env | cut -d= -f2)" BGSAVE
sleep 5

# 1g. Verify save completed
docker exec hope-redis redis-cli -a "$(grep REDIS_PASS /opt/redis/.env | cut -d= -f2)" LASTSAVE
# Should show a recent Unix timestamp

# 1h. Verify current memory usage is under new limit
docker exec hope-redis redis-cli -a "$(grep REDIS_PASS /opt/redis/.env | cut -d= -f2)" \
  INFO memory | grep used_memory_human
# Must be < 1.00G — if higher, eviction will trigger on restart (acceptable for staging)

exit
```

**Step 2: Shutdown VM and reduce RAM on Proxmox host**

```bash
# On Proxmox host
qm shutdown 421 --timeout 60
qm wait 421 --timeout 120

# Reduce RAM: 4 GB → 2 GB
qm set 421 --memory 2048

# Disable memory ballooning (prevents hypervisor from stealing RAM)
qm set 421 --balloon 0

# Verify config
qm config 421 | grep -E 'memory|balloon'
# Expected: memory: 2048, balloon: 0

# Start VM
qm start 421
```

**Step 3: Verify Redis is healthy**

```bash
# Wait for VM to boot and Docker to start (~30 seconds)
sleep 30

ssh hope@10.10.1.121

# Verify VM sees 2 GB RAM
free -h
# Expected: total ~2.0Gi

# Verify Docker container is running
docker ps | grep hope-redis
# Should show: hope-redis ... Up ...

# Verify Redis responds
docker exec hope-redis redis-cli -a "$(grep REDIS_PASS /opt/redis/.env | cut -d= -f2)" ping
# Expected: PONG

# Verify maxmemory is 1 GB
docker exec hope-redis redis-cli -a "$(grep REDIS_PASS /opt/redis/.env | cut -d= -f2)" \
  INFO memory | grep maxmemory_human
# Expected: maxmemory_human:1.00G

# Verify exporter is running
curl -s http://localhost:9121/metrics | head -5
# Should return Prometheus metrics

exit
```

#### Phase 1b — VM 201 (Marketing): RAM 8 GB → 4 GB

```bash
# On Proxmox host
qm shutdown 201 --timeout 60
qm wait 201 --timeout 120

# Reduce RAM: 8 GB → 4 GB
qm set 201 --memory 4096

# Verify config
qm config 201 | grep memory
# Expected: memory: 4096

# Start VM
qm start 201
```

**Verify:**

```bash
# Wait for boot (~20 seconds)
sleep 20

ssh hope@10.10.2.11
# Or: ssh rb

# Verify RAM
free -h
# Expected: total ~3.8Gi (some reserved by kernel)

# Verify web server is running
curl -s http://localhost | head -5
# Should return HTML content

# Verify from external (via Cloudflare Tunnel, if configured)
# curl -sI https://your-marketing-domain.com | head -3

exit
```

**Phase 1 checkpoint:** Redis staging and marketing site are back online with reduced resources.

---

### Phase 2 — Infrastructure VMs (GitLab, Runner, MinIO)

**VMs:** VM 402 (MinIO), VM 410 (GitLab), VM 411 (Runner)
**Impact:** GitLab, CI/CD, and object storage brief downtime
**Estimated duration:** 30-45 minutes total
**Dependency order:** MinIO first → GitLab disk (online) → Runner last
**Prerequisite:** No active CI pipelines. Verify with `ssh gitlab-runner "sudo gitlab-runner list"`

> **Notify the team** that GitLab will be briefly unavailable. No code pushes or CI triggers during this phase.

#### Phase 2a — VM 402 (MinIO): CPU 8→4, RAM 16→8 GB

**Step 1: Verify MinIO state before shutdown**

```bash
ssh hope@10.10.1.102

# Check MinIO health
curl -s http://localhost:9000/minio/health/live
# Expected: OK

# Check disk usage
df -h /
docker exec minio mc admin info local 2>/dev/null || true

exit
```

**Step 2: Shutdown and reconfigure**

```bash
# On Proxmox host
qm shutdown 402 --timeout 60
qm wait 402 --timeout 120

# Reduce CPU: 8 → 4
qm set 402 --cores 4

# Reduce RAM: 16 GB → 8 GB
qm set 402 --memory 8192

# Verify config
qm config 402 | grep -E 'cores|memory'
# Expected: cores: 4, memory: 8192

# Start VM
qm start 402
```

**Step 3: Verify MinIO is healthy**

```bash
# Wait for boot + Docker start (~30 seconds)
sleep 30

ssh hope@10.10.1.102

# Verify resources
nproc               # Expected: 4
free -h              # Expected: total ~7.7Gi

# Verify Docker container
docker ps | grep minio
# Should show running

# Verify MinIO health
curl -s http://localhost:9000/minio/health/live    # Expected: OK
curl -s http://localhost:9000/minio/health/ready   # Expected: OK

# Test S3 access (using mc if installed)
# mc alias set local http://localhost:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD
# mc ls local/

exit
```

#### Phase 2b — VM 410 (GitLab): Disk 64 → 250 GB (ONLINE — no restart)

> Disk expansion via `qm resize` is an online operation. No VM shutdown needed. The `growpart` + `resize2fs` commands run live inside the VM.

**Step 1: Expand virtual disk on Proxmox host**

```bash
# On Proxmox host — expand disk (instant, no downtime)
qm resize 410 virtio0 +186G

# Verify new size
qm config 410 | grep virtio0
# Should show ~250G
```

**Step 2: Extend filesystem inside the VM**

```bash
ssh hope@10.10.1.110

# Verify kernel sees the new disk size
lsblk
# vda should show ~250G total, but partitions still sum to ~64G

# Check current disk usage
df -h /

# Extend partition 3 (LVM PV)
sudo growpart /dev/vda 3

# Resize the LVM physical volume
sudo pvresize /dev/vda3

# Extend the logical volume to use all free space
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv

# Resize the ext4 filesystem (online, no unmount needed)
sudo resize2fs /dev/mapper/ubuntu--vg-ubuntu--lv

# Verify new size
df -h /
# Expected: ~245G total (some overhead for filesystem metadata)

# Verify GitLab is still running (should not have been affected)
curl -s http://localhost/-/readiness | python3 -m json.tool
# Expected: {"status":"ok"}

docker exec gitlab gitlab-ctl status
# All services should show: run

exit
```

#### Phase 2c — VM 411 (GitLab Runner): RAM 16 → 12 GB

**Step 1: Verify no active CI jobs**

```bash
ssh hope@10.10.1.111

# Check for running jobs
sudo gitlab-runner list
# Verify "Executor" column shows no active jobs

# If jobs are running, either:
#   - Wait for them to complete
#   - Cancel them in GitLab UI: Admin → CI/CD → Jobs → Cancel

exit
```

**Step 2: Shutdown and reconfigure**

```bash
# On Proxmox host
qm shutdown 411 --timeout 120    # Longer timeout for Docker cleanup
qm wait 411 --timeout 180

# Reduce RAM: 16 GB → 12 GB
qm set 411 --memory 12288

# Verify config
qm config 411 | grep memory
# Expected: memory: 12288

# Start VM
qm start 411
```

**Step 3: Verify Runner is healthy**

```bash
# Wait for boot + Docker daemon (~30 seconds)
sleep 30

ssh hope@10.10.1.111

# Verify RAM
free -h
# Expected: total ~11.7Gi

# Verify Docker daemon
docker info | head -5
# Should show Docker is running

# Verify all runners are registered and alive
sudo gitlab-runner verify
# Expected: "Verifying runner... is alive" for each runner

# Check runner status
sudo gitlab-runner list
# Should show 4 runners with correct tags

exit
```

**Phase 2 checkpoint:** GitLab, Runner, and MinIO are back online. Verify end-to-end by pushing a test commit or viewing GitLab in browser.

---

### Phase 3 — Database Cluster (Rolling Upgrade)

**VMs:** VM 500, 501, 502
**Impact:** Brief read-only period during primary failover (~10 seconds)
**Estimated duration:** 45-60 minutes total
**Estimated downtime:** Near zero (rolling upgrade with Patroni automatic failover)
**Order:** Replicas first (502 → 501) → Primary last (500 with planned switchover)

> **This is the highest-risk phase.** TimescaleDB serves both HOPE v1 and v2. Follow the rolling upgrade procedure carefully. Applications connect via the VIP (10.10.1.250) and HAProxy — they will automatically reconnect to the new primary.

#### Pre-Phase 3 — Verify Patroni Cluster Health

```bash
ssh hope@10.10.1.200

# Verify all 3 nodes are healthy
docker exec patroni patronictl -c /home/postgres/postgres.yml list
# Expected output:
# + Cluster: hope-cluster (timeline X) ---+----+-----------+
# | Member    | Host         | Role    | State   | TL | Lag in MB |
# +-----------+--------------+---------+---------+----+-----------+
# | pg-node1  | 10.10.1.200  | Leader  | running |  X |           |
# | pg-node2  | 10.10.1.201  | Replica | running |  X |         0 |
# | pg-node3  | 10.10.1.202  | Replica | running |  X |         0 |
# +-----------+--------------+---------+---------+----+-----------+

# Check replication lag (must be < 1 second)
docker exec patroni psql -U postgres -c \
  "SELECT client_addr, state, sent_lsn, replay_lsn, replay_lag FROM pg_stat_replication;"

# Check recent failover history
docker exec patroni patronictl -c /home/postgres/postgres.yml history

# Verify VIP responds
psql -h 10.10.1.250 -p 5000 -U postgres -c "SELECT 1;"
# Expected: 1

exit
```

> **STOP here if any node is not in `running` state or if replication lag is > 0.** Fix the cluster before proceeding.

#### Phase 3a — VM 502 (Replica 2): Disk +136 GB, RAM 16→24 GB

**Step 1: Expand disk online**

```bash
# On Proxmox host — expand disk (online, no restart)
qm resize 502 virtio0 +136G
```

**Step 2: Extend filesystem inside the VM**

```bash
ssh hope@10.10.1.202

# Extend partition + LVM + filesystem
sudo growpart /dev/vda 3
sudo pvresize /dev/vda3
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/mapper/ubuntu--vg-ubuntu--lv

# Verify
df -h /
# Expected: ~196G available

exit
```

**Step 3: Shutdown for RAM increase**

```bash
# On Proxmox host
qm shutdown 502 --timeout 120
qm wait 502 --timeout 180

# Increase RAM: 16 GB → 24 GB
qm set 502 --memory 24576

# Disable memory ballooning
qm set 502 --balloon 0

# Apply NUMA pinning (Node 1 — separate from primary)
qm set 502 --numa 1
qm set 502 --numa0 "cpus=0-7,hostnodes=1,memory=24576,policy=bind"

# Verify config
qm config 502 | grep -E 'memory|balloon|numa'

# Start VM
qm start 502
```

**Step 4: Wait for Patroni to rejoin**

```bash
# Wait for boot + Docker + Patroni startup (~60 seconds)
sleep 60

ssh hope@10.10.1.202

# Verify RAM
free -h
# Expected: total ~23Gi

# Verify Patroni has rejoined the cluster
docker exec patroni patronictl -c /home/postgres/postgres.yml list
# VM 502 (pg-node3) should show: Role=Replica, State=running, Lag=0

# If the node is still catching up, wait and re-check:
# docker exec patroni patronictl -c /home/postgres/postgres.yml list

exit
```

**Step 5: Update PostgreSQL configuration for new RAM**

```bash
ssh hope@10.10.1.200   # Connect to current primary to edit cluster config

# Edit the Patroni dynamic configuration (applies to all nodes)
# This opens an editor — update the postgresql.parameters section
docker exec -it patroni patronictl -c /home/postgres/postgres.yml edit-config

# In the editor, update these values under postgresql.parameters:
#   shared_buffers: 6GB        (was 4GB — for 24GB replica nodes)
#   effective_cache_size: 18GB (was 12GB)
#   work_mem: 192MB            (was 128MB)
#   maintenance_work_mem: 1536MB (was 1GB)
#   wal_buffers: 96MB          (was 64MB)
#
# IMPORTANT: shared_buffers change requires a PostgreSQL restart per node.
# Patroni will schedule pending restarts.

# After saving, check pending restarts
docker exec patroni patronictl -c /home/postgres/postgres.yml list
# Nodes needing restart will show "Pending restart" flag

# Restart the replica node we just upgraded (VM 502)
docker exec patroni patronictl -c /home/postgres/postgres.yml restart hope-cluster pg-node3 --force

# Wait for restart and rejoin (~30 seconds)
sleep 30
docker exec patroni patronictl -c /home/postgres/postgres.yml list
# pg-node3 should be: running, Lag=0, no pending restart

exit
```

#### Phase 3b — VM 501 (Replica 1): Disk +136 GB, RAM 16→24 GB

Repeat the exact same procedure as Phase 3a for VM 501.

**Step 1: Expand disk online**

```bash
# On Proxmox host
qm resize 501 virtio0 +136G
```

**Step 2: Extend filesystem inside the VM**

```bash
ssh hope@10.10.1.201

sudo growpart /dev/vda 3
sudo pvresize /dev/vda3
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/mapper/ubuntu--vg-ubuntu--lv
df -h /
# Expected: ~196G available

exit
```

**Step 3: Shutdown for RAM increase**

```bash
# On Proxmox host
qm shutdown 501 --timeout 120
qm wait 501 --timeout 180

# Increase RAM: 16 GB → 24 GB
qm set 501 --memory 24576
qm set 501 --balloon 0

# Apply NUMA pinning (Node 1)
qm set 501 --numa 1
qm set 501 --numa0 "cpus=0-7,hostnodes=1,memory=24576,policy=bind"

# Verify config
qm config 501 | grep -E 'memory|balloon|numa'

# Start VM
qm start 501
```

**Step 4: Wait for Patroni to rejoin and restart PostgreSQL**

```bash
# Wait ~60 seconds for rejoin
sleep 60

# Verify from primary
ssh hope@10.10.1.200
docker exec patroni patronictl -c /home/postgres/postgres.yml list
# pg-node2 should show: Replica, running

# Restart pg-node2 to apply shared_buffers change
docker exec patroni patronictl -c /home/postgres/postgres.yml restart hope-cluster pg-node2 --force
sleep 30
docker exec patroni patronictl -c /home/postgres/postgres.yml list
# pg-node2: running, Lag=0, no pending restart

exit
```

#### Phase 3c — VM 500 (Primary): Disk +136 GB, RAM 16→32 GB (Planned Failover)

> This node is the **current primary**. We must perform a planned switchover to a replica before shutting it down. Applications connect via VIP — they will experience ~10 seconds of read-only during switchover.

**Step 1: Expand disk online (while still primary)**

```bash
# On Proxmox host
qm resize 500 virtio0 +136G
```

**Step 2: Extend filesystem inside the VM**

```bash
ssh hope@10.10.1.200

sudo growpart /dev/vda 3
sudo pvresize /dev/vda3
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/mapper/ubuntu--vg-ubuntu--lv
df -h /
# Expected: ~196G available
```

**Step 3: Perform planned switchover**

```bash
# Still on VM 500 (current primary)

# Verify both replicas are healthy and in sync before switchover
docker exec patroni patronictl -c /home/postgres/postgres.yml list
# Both replicas must show: State=running, Lag=0

# Initiate planned switchover to pg-node2 (VM 501)
docker exec patroni patronictl -c /home/postgres/postgres.yml switchover \
  --candidate pg-node2 --force

# Wait for switchover to complete (~10 seconds)
sleep 15

# Verify switchover
docker exec patroni patronictl -c /home/postgres/postgres.yml list
# Expected:
#   pg-node1 (VM 500): Replica
#   pg-node2 (VM 501): Leader    ← new primary
#   pg-node3 (VM 502): Replica

# Verify VIP still works (now routed to VM 501)
psql -h 10.10.1.250 -p 5000 -U postgres -c "SELECT inet_server_addr();"
# Expected: 10.10.1.201 (VM 501 is now primary)

exit
```

**Step 4: Shutdown old primary (now replica) for RAM increase**

```bash
# On Proxmox host
qm shutdown 500 --timeout 120
qm wait 500 --timeout 180

# Increase RAM: 16 GB → 32 GB
qm set 500 --memory 32768
qm set 500 --balloon 0

# Apply NUMA pinning (Node 0 — primary node gets its own NUMA)
qm set 500 --numa 1
qm set 500 --numa0 "cpus=0-7,hostnodes=0,memory=32768,policy=bind"

# Verify config
qm config 500 | grep -E 'memory|balloon|numa'

# Start VM
qm start 500
```

**Step 5: Wait for rejoin and update primary config**

```bash
# Wait ~60 seconds
sleep 60

# Verify from the new primary (VM 501)
ssh hope@10.10.1.201
docker exec patroni patronictl -c /home/postgres/postgres.yml list
# pg-node1 (VM 500) should show: Replica, running

# Now update Patroni config with PRIMARY-specific PostgreSQL parameters
docker exec -it patroni patronictl -c /home/postgres/postgres.yml edit-config
# Update postgresql.parameters:
#   shared_buffers: 8GB         (primary gets more — 25% of 32 GB)
#   effective_cache_size: 24GB  (75% of 32 GB)
#   work_mem: 256MB
#   maintenance_work_mem: 2GB
#   wal_buffers: 128MB
#
# NOTE: These settings apply cluster-wide via Patroni DCS.
# If you need different settings per node, use ALTER SYSTEM on individual nodes
# and set "use_pg_rewind: true" in Patroni config to handle divergence.
#
# For simplicity, use the PRIMARY's optimal values cluster-wide — replicas
# will have slightly more headroom than needed, which is fine.

# Restart pg-node1 to apply
docker exec patroni patronictl -c /home/postgres/postgres.yml restart hope-cluster pg-node1 --force
sleep 30
```

**Step 6: Switchover back to VM 500 as primary (optional)**

```bash
# Still on VM 501
docker exec patroni patronictl -c /home/postgres/postgres.yml switchover \
  --candidate pg-node1 --force
sleep 15

docker exec patroni patronictl -c /home/postgres/postgres.yml list
# Expected:
#   pg-node1 (VM 500): Leader  ← primary again, now with 32 GB RAM
#   pg-node2 (VM 501): Replica
#   pg-node3 (VM 502): Replica

# Restart remaining nodes to pick up new shared_buffers
docker exec patroni patronictl -c /home/postgres/postgres.yml restart hope-cluster pg-node2 --force
sleep 30
docker exec patroni patronictl -c /home/postgres/postgres.yml restart hope-cluster pg-node3 --force
sleep 30

exit
```

> **Note:** If VM 500 doesn't need to be primary, you can skip Step 6 and leave VM 501 as the leader. The cluster works the same regardless of which node is primary.

#### Post-Phase 3 — Verify Cluster Integrity

```bash
# From any node with psql access (or Proxmox host)

# 1. Verify all 3 nodes are running
ssh hope@10.10.1.200
docker exec patroni patronictl -c /home/postgres/postgres.yml list
# Expected: 3 nodes, 1 Leader, 2 Replicas, all "running", Lag=0

# 2. Verify replication
docker exec patroni psql -U postgres -c \
  "SELECT client_addr, state, replay_lag FROM pg_stat_replication;"
# Expected: 2 rows, state=streaming, replay_lag < 1s

# 3. Verify write via VIP
psql -h 10.10.1.250 -p 5000 -U postgres -c "SELECT now();"
# Expected: current timestamp

# 4. Verify read via read pool (port 5001 if HAProxy is configured for it)
psql -h 10.10.1.250 -p 5001 -U postgres -c "SELECT now();"

# 5. Verify PostgreSQL config was applied
docker exec patroni psql -U postgres -c "SHOW shared_buffers;"
# Expected: 8GB (on primary)

docker exec patroni psql -U postgres -c "SHOW effective_cache_size;"
# Expected: 24GB

docker exec patroni psql -U postgres -c "SHOW work_mem;"
# Expected: 256MB

exit
```

**Phase 3 checkpoint:** Database cluster is fully upgraded with increased RAM and disk. All nodes running, replication healthy.

---

### Phase 4 — AI Workload VMs (Highest Impact)

**VMs:** VM 401 (CPU AI v1), VM 200 (GPU AI v2)
**Impact:** HOPE/ARCA-VOX v1 and v2 full service interruption during respective VM restarts
**Estimated duration:** 30-45 minutes total (including model reload time)
**Dependencies:** Database cluster (Phase 3) and Redis must be healthy before starting

> **Schedule during a maintenance window.** Notify all users that AI services will be briefly unavailable. Do VM 401 first, then VM 200, so at least v2 remains available while v1 restarts (and vice versa).

#### Pre-Phase 4 — Verify Dependencies

```bash
# Redis must be healthy
redis-cli -h 10.10.1.120 -a '<dev-password>' ping      # PONG
redis-cli -h 10.10.1.121 -a '<staging-password>' ping    # PONG

# Database must be healthy
psql -h 10.10.1.250 -p 5000 -U postgres -c "SELECT 1;"   # 1
```

#### Phase 4a — VM 401 (AI v1 — No GPU): CPU 64→16, RAM 64→32 GB

**Step 1: Drain active connections (if applicable)**

```bash
ssh hope@10.10.1.101

# Check for active AI processing
docker ps
# Note which containers are running

# If running K3s:
# kubectl get pods -A
# kubectl drain <node-name> --ignore-daemonsets --delete-emptydata

# If running Docker directly — check for active WebSocket connections or in-flight requests:
# docker logs <api-container> --tail 20 | grep -i "active\|connection\|processing"

# Allow 30 seconds for in-flight requests to complete
sleep 30

exit
```

**Step 2: Shutdown and reconfigure**

```bash
# On Proxmox host
qm shutdown 401 --timeout 120
qm wait 401 --timeout 180

# Reduce CPU: 64 → 16
qm set 401 --cores 16

# Reduce RAM: 64 → 32 GB
qm set 401 --memory 32768

# Disable memory ballooning
qm set 401 --balloon 0

# Apply NUMA pinning (Node 1)
qm set 401 --numa 1
qm set 401 --numa0 "cpus=0-15,hostnodes=1,memory=32768,policy=bind"

# Verify config
qm config 401 | grep -E 'cores|memory|balloon|numa'
# Expected: cores: 16, memory: 32768, balloon: 0, numa: 1

# Start VM
qm start 401
```

**Step 3: Verify — wait for services + model loading**

```bash
# Model loading takes 60-120 seconds (Whisper + BERT models in CPU mode)
sleep 120

ssh hope@10.10.1.101

# Verify resources
nproc                           # Expected: 16
free -h                         # Expected: total ~31Gi

# Verify services are running
docker ps                       # Check all containers are Up
# OR (if using K3s):
# kubectl get pods -A

# Verify API health
curl -s http://localhost:8868/health
# Expected: healthy response

# Check model loading status (service-specific)
# curl -s http://localhost:8861/health   # STT
# curl -s http://localhost:8862/health   # SMR
# curl -s http://localhost:8864/health   # NLP

exit
```

#### Phase 4b — VM 200 (AI v2 — GPU): CPU 64→16, RAM 128→48 GB

**Step 1: Drain active connections**

```bash
ssh hope@10.10.1.10

# Check K3s pods
kubectl get pods -A

# Check for active WebSocket connections / in-flight STT sessions
# kubectl logs <stt-pod> --tail 20 | grep -i "active\|session\|processing"

# If using K3s drain:
# kubectl drain $(hostname) --ignore-daemonsets --delete-emptydata --timeout=60s

# Allow 30 seconds for in-flight requests to complete
sleep 30

exit
```

**Step 2: Identify GPU PCI addresses (on Proxmox host)**

```bash
# On Proxmox host — find GPU PCI addresses for NUMA pinning
lspci | grep -i nvidia
# Example output:
#   17:00.0 VGA compatible controller: NVIDIA Corporation AD107GL [RTX 2000 Ada]
#   65:00.0 VGA compatible controller: NVIDIA Corporation AD107GL [RTX 2000 Ada]

# Check NUMA node for each GPU
cat /sys/bus/pci/devices/0000:17:00.0/numa_node
cat /sys/bus/pci/devices/0000:65:00.0/numa_node
# Note which NUMA node(s) the GPUs are on

# Verify GPU passthrough config is currently set
qm config 200 | grep hostpci
# Should show two hostpci entries for the GPUs
```

**Step 3: Shutdown and reconfigure**

```bash
# On Proxmox host
qm shutdown 200 --timeout 120
qm wait 200 --timeout 180

# Reduce CPU: 64 → 16
qm set 200 --cores 16

# Reduce RAM: 128 → 48 GB
qm set 200 --memory 49152

# Disable memory ballooning
qm set 200 --balloon 0

# Apply NUMA pinning (use the NUMA node from Step 2 — adjust hostnodes accordingly)
qm set 200 --numa 1
qm set 200 --numa0 "cpus=0-15,hostnodes=0,memory=49152,policy=bind"
# ^^^^^^^^^^^^^^ Adjust hostnodes=0 or hostnodes=1 based on GPU NUMA node from Step 2

# Verify GPU passthrough is still configured
qm config 200 | grep hostpci
# Must show both GPUs — if missing, the VM won't have GPU access

# Verify all settings
qm config 200 | grep -E 'cores|memory|balloon|numa|hostpci'

# Start VM
qm start 200
```

**Step 4: Verify — wait for K3s + GPU Operator + model loading**

```bash
# K3s startup + GPU Operator initialization + model loading = 3-5 minutes
sleep 180

ssh hope@10.10.1.10

# Verify resources
nproc                           # Expected: 16
free -h                         # Expected: total ~47Gi

# Verify GPUs are visible
nvidia-smi
# Expected: 2 GPUs, each showing 16384 MiB VRAM, no processes yet (or K3s pods loading)

# Verify K3s is running
kubectl get nodes
# Expected: 1 node, Ready

# Verify GPU allocatable
kubectl get nodes -o json | jq '.items[].status.allocatable["nvidia.com/gpu"]'
# Expected: "8" (with time-slicing) or "2" (without)

# Wait for all pods to be ready
kubectl get pods -A
# All pods should be Running or Completed

# Verify API health
curl -s http://localhost:30080/health
# Expected: healthy response

# Verify GPU is being used by inference pods
nvidia-smi
# Should show GPU processes from stt-v2, nlp pods

exit
```

**Phase 4 checkpoint:** Both AI service VMs are back online with reduced resources. Verify end-to-end by testing a consultation flow.

---

### Phase 5 — Verification & Rancher (No Resource Changes)

VM 400 (Rancher/Argo) has no resource changes. After Phase 4, verify the full stack.

#### 5a — Verify Rancher Sees Updated Clusters

```bash
ssh hope@10.10.1.100

# Verify K3s on master
kubectl get nodes
# Expected: Ready

# Verify Rancher
kubectl -n cattle-system get pods
# All pods: Running

# Verify Argo CD
kubectl -n argocd get pods
# All pods: Running

# Verify Rancher health
curl -sk https://localhost/healthz
# Expected: ok

exit
```

#### 5b — Full Stack Verification

Run the complete verification from [Section 10](#10-post-migration-verification).

---

## 8. Proxmox Commands Reference

### All Changes in One Reference Block

```bash
# ============================================================
# RESOURCE REALLOCATION — Proxmox Host Commands
# Run from: Proxmox host shell (pve)
# Date: 2026-03-24
# ============================================================

# --- PRE-FLIGHT: Snapshot all VMs ---
for vmid in 200 201 400 401 402 410 411 420 421 500 501 502; do
  qm snapshot $vmid pre-realloc-$(date +%Y%m%d) --description "Before resource reallocation"
done

# --- PHASE 1: Low-risk VMs ---

# VM 421 (Redis staging): RAM 4G→2G
# >>> First SSH into VM 421 and update Redis config (see Phase 1a Step 1) <<<
qm shutdown 421 --timeout 60 && qm wait 421 --timeout 120
qm set 421 --memory 2048 --balloon 0
qm start 421

# VM 201 (Marketing): RAM 8G→4G
qm shutdown 201 --timeout 60 && qm wait 201 --timeout 120
qm set 201 --memory 4096
qm start 201

# --- PHASE 2: Infrastructure VMs ---

# VM 402 (MinIO): CPU 8→4, RAM 16G→8G
qm shutdown 402 --timeout 60 && qm wait 402 --timeout 120
qm set 402 --cores 4 --memory 8192
qm start 402

# VM 410 (GitLab): Disk 64G→250G (ONLINE — no restart needed)
qm resize 410 virtio0 +186G
# >>> Then SSH into VM 410 and run growpart/resize2fs (see Phase 2b) <<<

# VM 411 (Runner): RAM 16G→12G
# >>> First verify no active CI jobs <<<
qm shutdown 411 --timeout 120 && qm wait 411 --timeout 180
qm set 411 --memory 12288
qm start 411

# --- PHASE 3: Database cluster (rolling — replicas first) ---

# VM 502 (DB replica 2): Disk +136G (online), RAM 16G→24G (restart)
qm resize 502 virtio0 +136G
# >>> SSH into VM 502 and run growpart/resize2fs <<<
qm shutdown 502 --timeout 120 && qm wait 502 --timeout 180
qm set 502 --memory 24576 --balloon 0
qm set 502 --numa 1
qm set 502 --numa0 "cpus=0-7,hostnodes=1,memory=24576,policy=bind"
qm start 502

# VM 501 (DB replica 1): Disk +136G (online), RAM 16G→24G (restart)
qm resize 501 virtio0 +136G
# >>> SSH into VM 501 and run growpart/resize2fs <<<
qm shutdown 501 --timeout 120 && qm wait 501 --timeout 180
qm set 501 --memory 24576 --balloon 0
qm set 501 --numa 1
qm set 501 --numa0 "cpus=0-7,hostnodes=1,memory=24576,policy=bind"
qm start 501

# VM 500 (DB primary): Disk +136G (online), RAM 16G→32G (after switchover)
qm resize 500 virtio0 +136G
# >>> SSH into VM 500, run growpart/resize2fs, then perform Patroni switchover <<<
qm shutdown 500 --timeout 120 && qm wait 500 --timeout 180
qm set 500 --memory 32768 --balloon 0
qm set 500 --numa 1
qm set 500 --numa0 "cpus=0-7,hostnodes=0,memory=32768,policy=bind"
qm start 500

# --- PHASE 4: AI VMs ---

# VM 401 (AI v1 no GPU): CPU 64→16, RAM 64G→32G
# >>> Drain connections first <<<
qm shutdown 401 --timeout 120 && qm wait 401 --timeout 180
qm set 401 --cores 16 --memory 32768 --balloon 0
qm set 401 --numa 1
qm set 401 --numa0 "cpus=0-15,hostnodes=1,memory=32768,policy=bind"
qm start 401

# VM 200 (AI v2 + GPU): CPU 64→16, RAM 128G→48G
# >>> Drain connections first, verify GPU NUMA node <<<
qm shutdown 200 --timeout 120 && qm wait 200 --timeout 180
qm set 200 --cores 16 --memory 49152 --balloon 0
qm set 200 --numa 1
qm set 200 --numa0 "cpus=0-15,hostnodes=0,memory=49152,policy=bind"
# Adjust hostnodes=0/1 based on GPU NUMA node
qm start 200
```

---

## 9. Rollback Procedures

If any VM fails to start or services crash after resource changes:

### Instant Rollback (per VM — from snapshot)

```bash
# DESTRUCTIVE — reverts VM to pre-migration state (all changes since snapshot are lost)
qm stop <VMID>                   # Force stop if shutdown hangs
qm rollback <VMID> pre-realloc-$(date +%Y%m%d)
qm start <VMID>

# Verify
qm config <VMID> | grep -E 'cores|memory'
```

### Manual Rollback (per VM — revert settings only)

```bash
# Preserves VM data, only reverts resource settings
qm shutdown <VMID> --timeout 60 && qm wait <VMID> --timeout 120
qm set <VMID> --cores <ORIGINAL_CORES>
qm set <VMID> --memory <ORIGINAL_MB>
qm set <VMID> --balloon 0        # Keep ballooning disabled
qm start <VMID>
```

### Original Values for Rollback

| VMID | Name | Original Cores | Original RAM (MB) | Notes |
|------|------|---------------|-------------------|-------|
| 200 | ubuntu-live-gpu | 64 | 131072 (128 GB) | Also revert NUMA if set |
| 201 | rb | 2 | 8192 (8 GB) | CPU unchanged |
| 401 | vuvu | 64 | 65536 (64 GB) | Also revert NUMA if set |
| 402 | minio | 8 | 16384 (16 GB) | |
| 411 | gitlab-runner | 8 | 16384 (16 GB) | CPU unchanged |
| 421 | redis-staging | 2 | 4096 (4 GB) | Also revert redis.conf maxmemory to 2gb |
| 500 | database-00 | 8 | 16384 (16 GB) | Also revert NUMA and patroni config |
| 501 | database-01 | 8 | 16384 (16 GB) | Also revert NUMA and patroni config |
| 502 | database-02 | 8 | 16384 (16 GB) | Also revert NUMA and patroni config |

### Redis Staging Rollback (VM 421)

If rolling back VM 421, also revert the Redis config:

```bash
ssh hope@10.10.1.121

# Revert redis.conf
sudo sed -i 's/^maxmemory 1gb/maxmemory 2gb/' /opt/redis/redis.conf

# Revert .env Docker memory limit
sudo sed -i 's/^REDIS_MEM_LIMIT=1536M/REDIS_MEM_LIMIT=2560M/' /opt/redis/.env

# Restart Redis to pick up config changes
cd /opt/redis && docker compose up -d

# Verify
docker exec hope-redis redis-cli -a "$(grep REDIS_PASS /opt/redis/.env | cut -d= -f2)" \
  INFO memory | grep maxmemory_human
# Expected: maxmemory_human:2.00G

exit
```

### Database Cluster Rollback (VMs 500-502)

If rolling back database VMs, also revert PostgreSQL parameters:

```bash
ssh hope@10.10.1.200   # Or whichever node is currently primary

docker exec -it patroni patronictl -c /home/postgres/postgres.yml edit-config
# Revert to original values:
#   shared_buffers: 4GB
#   effective_cache_size: 12GB
#   work_mem: 128MB
#   maintenance_work_mem: 1GB
#   wal_buffers: 64MB

# Restart each node to apply
docker exec patroni patronictl -c /home/postgres/postgres.yml restart hope-cluster pg-node1 --force
docker exec patroni patronictl -c /home/postgres/postgres.yml restart hope-cluster pg-node2 --force
docker exec patroni patronictl -c /home/postgres/postgres.yml restart hope-cluster pg-node3 --force
```

### Snapshot Cleanup (After 7 Days of Stable Operation)

```bash
# Only run after confirming all services are stable for at least 7 days
for vmid in 200 201 400 401 402 410 411 420 421 500 501 502; do
  qm delsnapshot $vmid pre-realloc-$(date +%Y%m%d)
done
```

---

## 10. Post-Migration Verification

Run this complete verification after all phases are complete.

### Resource Verification (Proxmox Host)

```bash
# Verify all VM specs match proposed allocation
for vmid in 200 201 400 401 402 410 411 420 421 500 501 502; do
  echo "=== VM $vmid ==="
  qm config $vmid | grep -E 'cores|memory|balloon|numa|virtio0|hostpci'
  echo ""
done

# Check host resource usage
free -h                          # Host memory (should show ~27+ GB free)
df -h /                          # Host disk (should be < 85% used)
uptime                           # Load average
cat /proc/meminfo | head -5      # Detailed memory info
```

### Service-by-Service Verification

```bash
# ── Cloudflare Tunnel (CT 100) ──
# Verify external access works
curl -sI https://git.taphuynh.dev | head -3          # HTTP/2 200 or 302
curl -sI https://api-staging.taphuynh.dev | head -3  # HTTP/2 200
curl -sI https://s3-console.taphuynh.dev | head -3   # HTTP/2 200

# ── Redis (VM 420, 421) ──
redis-cli -h 10.10.1.120 -a '<dev-password>' ping                    # PONG
redis-cli -h 10.10.1.121 -a '<staging-password>' ping                # PONG
redis-cli -h 10.10.1.121 -a '<staging-password>' INFO memory | grep maxmemory_human
# Expected: maxmemory_human:1.00G

# ── MinIO (VM 402) ──
curl -s http://10.10.1.102:9000/minio/health/live    # OK
curl -s http://10.10.1.102:9000/minio/health/ready   # OK

# ── GitLab (VM 410) ──
curl -s http://10.10.1.110/-/readiness | python3 -m json.tool   # status: ok
ssh gitlab "docker exec gitlab gitlab-ctl status"               # All services: run
ssh gitlab "df -h /"                                             # ~250 GB available

# ── GitLab Runner (VM 411) ──
ssh gitlab-runner "sudo gitlab-runner verify"                    # is alive
ssh gitlab-runner "free -h"                                      # ~12 GB total

# ── TimescaleDB HA (VMs 500-502) ──
ssh database-00 "docker exec patroni patronictl -c /home/postgres/postgres.yml list"
# Expected: 3 nodes, 1 Leader, 2 Replicas, all running, Lag=0

psql -h 10.10.1.250 -p 5000 -U postgres -c "SELECT 1;"          # VIP write responds
psql -h 10.10.1.250 -p 5001 -U postgres -c "SELECT 1;"          # VIP read responds

psql -h 10.10.1.250 -p 5000 -U postgres -c "SHOW shared_buffers;"   # 8GB
psql -h 10.10.1.250 -p 5000 -U postgres -c "SHOW work_mem;"         # 256MB

ssh database-00 "free -h"                                        # ~31 GB total
ssh database-01 "free -h"                                        # ~23 GB total
ssh database-02 "free -h"                                        # ~23 GB total

# ── AI v2 — GPU (VM 200) ──
ssh server-gpu "nproc"                                           # 16
ssh server-gpu "free -h"                                         # ~47 GB total
ssh server-gpu "nvidia-smi"                                      # 2 GPUs, 16 GB each
ssh server-gpu "kubectl get pods -A"                             # All pods Running
curl -s http://10.10.1.10:30080/health                           # API responds

# ── AI v1 — No GPU (VM 401) ──
ssh vuvu "nproc"                                                 # 16
ssh vuvu "free -h"                                               # ~31 GB total
ssh vuvu "docker ps"                                             # Services running
curl -s http://10.10.1.101:8868/health                           # API responds

# ── Rancher + Argo (VM 400) ──
curl -sk https://10.10.1.100/healthz                             # ok
ssh master "kubectl -n cattle-system get pods"                   # All Running
ssh master "kubectl -n argocd get pods"                          # All Running

# ── Marketing (VM 201) ──
ssh rb "free -h"                                                 # ~4 GB total
curl -s http://10.10.2.11 | head -5                             # HTML response
```

### NUMA Verification (Proxmox Host)

```bash
# Verify NUMA memory distribution
numastat -c qemu

# Verify VM NUMA binding
for vmid in 200 401 500 501 502; do
  echo "=== VM $vmid NUMA ==="
  qm config $vmid | grep numa
done
```

---

## 11. Disk I/O Optimization

### Problem

All VMs share a single 2 TB SSD. Database writes, GitLab CI artifacts, MinIO reads, and AI model loading compete for the same physical disk.

### Mitigations (No Additional Hardware)

> **Note:** The `--scsi0` and iothread changes below require the VM to be shut down. Apply during the respective VM's shutdown window in the execution plan, or schedule a separate mini-maintenance.

```bash
# On Proxmox host — enable I/O threads for database VMs
# These commands modify VM config and require restart to take effect
qm set 500 --scsi0 local-lvm:vm-500-disk-0,iothread=1
qm set 501 --scsi0 local-lvm:vm-501-disk-0,iothread=1
qm set 502 --scsi0 local-lvm:vm-502-disk-0,iothread=1

# Set I/O scheduler on Proxmox host (apply immediately, but not persistent across reboots)
echo mq-deadline > /sys/block/sda/queue/scheduler    # Replace sda with actual device

# To make I/O scheduler persistent across reboots, add a udev rule:
cat > /etc/udev/rules.d/60-io-scheduler.rules <<'EOF'
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/scheduler}="mq-deadline"
ACTION=="add|change", KERNEL=="nvme[0-9]*", ATTR{queue/scheduler}="none"
EOF
```

**Inside database VMs — optimize readahead for sequential scans:**

```bash
# On each database VM (500, 501, 502)
sudo blockdev --setra 4096 /dev/vda

# Make persistent via udev rule
cat | sudo tee /etc/udev/rules.d/60-readahead.rules <<'EOF'
ACTION=="add|change", KERNEL=="vd[a-z]", ATTR{bdi/read_ahead_kb}="2048"
EOF
```

### Long-Term Recommendation

Add a second SSD dedicated to database VMs (500-502). This single change provides the biggest reliability improvement by eliminating I/O contention between database writes and all other workloads.

**If adding a second SSD:**
1. Install the SSD in the Dell 7920 (available M.2 or SATA slot)
2. Create a new Proxmox storage pool: `pvesm add lvm <name> --vgname <vg> --content images`
3. Migrate database VM disks: `qm move-disk <VMID> virtio0 <new-storage>`
4. Verify and remove old disks

---

## 12. Monitoring Setup

### Prometheus Node Exporter (Deploy on All VMs)

```bash
# On each VM (Ubuntu 24.04)
sudo apt update && sudo apt install -y prometheus-node-exporter
sudo systemctl enable --now prometheus-node-exporter

# Verify
curl -s http://localhost:9100/metrics | head -5
# Should return Prometheus metrics
```

> **Redis VMs already have redis-exporter** running (port 9121, deployed via docker-compose). No additional setup needed.

### Existing Exporters

| VM | Exporter | Port | Source |
|----|----------|------|--------|
| VM 420, 421 | redis_exporter | 9121 | Docker Compose (already deployed) |
| VM 500-502 | postgres_exporter | 9187 | Docker Compose (already deployed) |
| VM 200 | nvidia-smi exporter | — | Requires separate setup if not deployed |

### Alert Thresholds

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| CPU usage (sustained) | > 80% for 5m | > 95% for 5m | Review process usage, consider scaling |
| RAM usage | > 85% | > 95% | Check for memory leaks, consider increasing |
| Disk usage (host) | > 80% | > 90% | Clean old data, expand disk, add SSD |
| Disk usage (per VM) | > 80% | > 90% | Expand VM disk via `qm resize` |
| GPU VRAM (VM 200) | > 14 GB / 16 GB | > 15.5 GB | Reduce model size or concurrent streams |
| DB replication lag | > 5s | > 30s | Check network, disk I/O, query load |
| Redis memory usage | > 80% maxmemory | > 95% maxmemory | Review key expiration, increase maxmemory |
| Load average | > 2× vCPU count | > 4× vCPU count | Identify runaway processes |
| Proxmox host free RAM | < 16 GB | < 8 GB | VMs consuming more than allocated; investigate |

### First-Week Monitoring Checklist

After migration, monitor these metrics daily for the first week:

- [ ] VM 200 CPU utilization — if sustained > 80%, increase to 24 cores
- [ ] VM 200 GPU VRAM — verify both GPUs have sufficient free memory
- [ ] VM 401 CPU utilization — if sustained > 80%, increase to 24 cores
- [ ] VM 421 Redis evictions — `redis-cli INFO stats | grep evicted_keys` should be low
- [ ] Database query performance — check `pg_stat_statements` for regression
- [ ] Proxmox host disk usage — `df -h /` on the host, must stay < 85%
- [ ] Proxmox host free RAM — `free -h`, must show > 20 GB available

---

## 13. Risk Assessment

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| VM fails to boot after resource change | Medium | Low | Pre-flight snapshots enable instant rollback |
| NUMA bind failure (not enough memory on target node) | Medium | Low | Verify NUMA node capacity before binding; remove NUMA bind if it fails |
| Services crash due to insufficient RAM | High | Low | Conservative allocations based on actual workload analysis; 27 GB host buffer for emergency increase |
| AI inference slower with fewer CPU cores | Medium | Medium | GPU workloads are GPU-bound, not CPU-bound; monitor first week; can increase to 24 cores if needed |
| Database performance degraded during rolling upgrade | Medium | Low | Patroni handles automatic failover; clients reconnect via VIP; total unavailability is ~10 seconds |
| Active WebSocket/STT sessions dropped during AI VM restart | High | High (by design) | Schedule during maintenance window; drain connections before shutdown; notify users |
| BullMQ jobs lost during Redis restart | Low | Low | Jobs are persisted via AOF; BGSAVE before shutdown ensures data safety; jobs resume on restart |
| Disk I/O contention increases with larger DB disks | Medium | Medium | Enable iothread, mq-deadline scheduler; long-term: add second SSD |
| Redis staging OOM with 2 GB RAM + 1 GB maxmemory | Low | Low | 1 GB maxmemory sufficient for staging; LRU eviction handles overflow; OS has 1 GB |
| Disk thin provisioning overrun (2,174 GB virtual > 2,000 GB physical) | Medium | Low | Monitor host `df -h`; actual usage will be ~60-70% of virtual size; alert at 85% |
| GitLab unavailable during Phase 2 blocks CI/CD | Medium | High (by design) | Schedule during off-hours; notify team; phase duration ~30 min |
| Patroni switchover causes brief application errors | Medium | Medium | Applications must handle transient DB connection errors; HAProxy with retries smooths this |

---

## Appendix A: Final State Quick Reference

```
INFRASTRUCTURE (Post-Reallocation):
  VMID  NAME             IP            vCPU  RAM    DISK       APPS
  CT100 cloudflared      multi-homed   1     0.5G   2G         Tunnel ingress
  200   ubuntu-live-gpu  10.10.1.10    16    48G    64G+300G   AI v2 + 2×GPU (stt-v2, smr, nlp, api)
  201   rb               10.10.2.11    2     4G     64G        Marketing websites
  400   master           10.10.1.100   8     16G    64G        Rancher, Argo CD
  401   vuvu             10.10.1.101   16    32G    400G       AI v1 no GPU (stt-v1, smr-v1, nlp, api)
  402   minio            10.10.1.102   4     8G     300G       MinIO S3 object storage
  410   gitlab           10.10.1.110   8     16G    250G       GitLab CE
  411   gitlab-runner    10.10.1.111   8     12G    250G       GitLab Runners
  420   redis-dev        10.10.1.120   2     2G     16G        Redis (dev)        maxmemory=512mb
  421   redis-staging    10.10.1.121   2     2G     32G        Redis (staging)    maxmemory=1gb
  500   database-00      10.10.1.200   8     32G    200G       TimescaleDB primary  shared_buffers=8GB
  501   database-01      10.10.1.201   8     24G    200G       TimescaleDB replica  shared_buffers=8GB*
  502   database-02      10.10.1.202   8     24G    200G       TimescaleDB replica  shared_buffers=8GB*
  VIP   —                10.10.1.250   —     —      —          Keepalived floating IP

  * Patroni DCS config is cluster-wide; shared_buffers applies to all nodes.

TOTALS:
  CPU:  81 / 96 cores  (84% — 15 cores headroom)
  RAM:  220.5 / 256 GB (86% — 27.5 GB for host + buffer)
  Disk: ~2,174 GB virtual / 2,000 GB physical (thin provisioned)

NUMA PINNING:
  VM 200 → NUMA node closest to GPU PCIe slot (determined at migration time)
  VM 500 → NUMA node 0
  VM 501 → NUMA node 1
  VM 502 → NUMA node 1
  VM 401 → NUMA node 1
```

## Appendix B: Configuration Files Changed

| File | VM | Change | When |
|------|-----|--------|------|
| `/opt/redis/redis.conf` | VM 421 | `maxmemory 2gb` → `maxmemory 1gb` | Phase 1a Step 1 |
| `/opt/redis/.env` | VM 421 | `REDIS_MEM_LIMIT=2560M` → `REDIS_MEM_LIMIT=1536M` | Phase 1a Step 1 |
| Patroni DCS config (via `patronictl edit-config`) | VM 500 (cluster-wide) | `shared_buffers`, `effective_cache_size`, `work_mem`, `maintenance_work_mem`, `wal_buffers` | Phase 3a Step 5 + Phase 3c Step 5 |

> **Version-controlled config files** (`research/configs/redis/redis-staging.conf` and `research/configs/postgres-ha/patroni/patroni.yml`) should also be updated to reflect the new values after successful migration.
