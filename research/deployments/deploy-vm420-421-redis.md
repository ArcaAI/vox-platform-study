# Deploy Redis — VM 420 (Dev) & VM 421 (Staging)

**Date**: 2026-03-24
**VMs**: 420 (`10.10.1.120`) — Dev | 421 (`10.10.1.121`) — Staging
**Bridge**: vmbr1 | **Specs**: 2 vCPU / 2 GB RAM / 16 GB disk (Dev) | 2 vCPU / 4 GB RAM / 32 GB disk (Staging)
**Config files**: [`configs/redis/`](../configs/redis/)
**Cloudflare SSH**: `ssh-redis-dev.taphuynh.dev` (VM 420) | `ssh-redis-staging.taphuynh.dev` (VM 421)
**Related**: [Infrastructure Overview](../infrastructure/proxmox-infrastructure-gitlab-rancher-plan.md) | [Cloudflare Tunnel](./deploy-ct101-cloudflare-tunnel.md) | [PostgreSQL HA](./deploy-vm500-502-postgres-ha.md) | [MinIO](./deploy-vm402-minio.md)

> **Redis is not exposed through the Cloudflare Tunnel.** It uses a binary protocol and must only be reachable on the internal `10.10.1.0/24` network. Only SSH access is tunneled for remote management. Developer access from external machines uses SSH port forwarding through the existing Cloudflare SSH tunnel.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Why Separate VMs Per Environment](#2-why-separate-vms-per-environment)
3. [Redis Database Segmentation](#3-redis-database-segmentation)
4. [Prerequisites](#4-prerequisites)
5. [Create VMs (Proxmox Host)](#5-create-vms-proxmox-host)
6. [Prepare Each VM](#6-prepare-each-vm)
7. [Deploy Redis — Dev (VM 420)](#7-deploy-redis--dev-vm-420)
8. [Deploy Redis — Staging (VM 421)](#8-deploy-redis--staging-vm-421)
9. [Security Hardening](#9-security-hardening)
10. [Cloudflare Tunnel — SSH Only](#10-cloudflare-tunnel--ssh-only)
11. [Update Application Configuration](#11-update-application-configuration)
12. [Automated Backup](#12-automated-backup)
13. [Monitoring](#13-monitoring)
14. [Verify](#14-verify)
15. [Operational Runbook](#15-operational-runbook)
16. [Troubleshooting](#16-troubleshooting)
17. [Appendix A: Alpine Linux Instead of Ubuntu](#appendix-a-alpine-linux-instead-of-ubuntu)

---

## 1. Architecture Overview

Redis serves multiple roles in the HOPE platform: BullMQ job queues, application caching, real-time Pub/Sub for STT transcriptions, Redis Streams for audio bridging and SMR task chunks, Celery/Dramatiq broker, and rate limiting. Each environment (dev/staging) gets its own isolated Redis VM.

```
                         ┌──────────────────────────────────────────────┐
                         │            HOPE APPLICATION STACK            │
                         │                                              │
                         │  NestJS API (BullMQ, Cache, Pub/Sub, Streams)│
                         │  STT-V2    (Dramatiq, Pub/Sub, Streams)      │
                         │  SMR       (Task state, Streams, Celery)     │
                         │  NLP       (Celery)                          │
                         └──────────┬──────────────────┬────────────────┘
                                    │                  │
                    ┌───────────────▼──┐     ┌─────────▼──────────────┐
                    │   VM 420 — Dev   │     │   VM 421 — Staging     │
                    │   10.10.1.120    │     │   10.10.1.121          │
                    ├──────────────────┤     ├────────────────────────┤
                    │ Redis 8 Alpine   │     │ Redis 8 Alpine         │
                    │ redis-exporter   │     │ redis-exporter         │
                    │                  │     │                        │
                    │ maxmemory: 512mb │     │ maxmemory: 2gb         │
                    │ AOF + RDB        │     │ AOF + RDB              │
                    │ Dangerous cmds   │     │ Dangerous cmds renamed │
                    │   ALLOWED        │     │   BLOCKED              │
                    └──────────────────┘     └────────────────────────┘
                    Port: 6379                Port: 6379
                    Exporter: 9121            Exporter: 9121
```

### Port Allocation (per VM)

| Port | Service | Purpose |
|------|---------|---------|
| 6379 | Redis | All client connections (BullMQ, cache, Pub/Sub, Streams) |
| 9121 | redis_exporter | Prometheus metrics |

### Why Single-Node (No Sentinel/Cluster)

Redis in HOPE is **not a primary datastore** — PostgreSQL is the source of truth. All Redis data is either:

- **Reconstructable** — BullMQ jobs can be re-enqueued, caches rebuild on miss
- **Ephemeral** — Pub/Sub messages, audio stream frames, rate limit counters
- **Short-lived** — SMR task state with TTL, Dramatiq job results

A single Redis instance with AOF persistence provides sufficient durability. If Redis goes down, the platform degrades gracefully (the `IRedisCacheService` already returns null/false when disconnected). Adding Sentinel complexity for data that is fundamentally transient is not worth it.

---

## 2. Why Separate VMs Per Environment

| Concern | Shared VM | Separate VMs |
|---------|-----------|--------------|
| Isolation | Dev `FLUSHALL` kills staging | Independent lifecycle |
| Resource contention | STT audio streams in dev starve staging | Dedicated memory/CPU |
| Independent restarts | Affects both environments | Restart dev freely |
| Security | Single breach exposes both | Staging can have stricter hardening |
| Cost on Proxmox | Saves 1 lightweight VM | 2 VMs at ~2-4 GB RAM — negligible |
| Pattern consistency | Breaks convention | Matches PG, GitLab, MinIO — each service owns its VM(s) |

---

## 3. Redis Database Segmentation

Redis logical databases (`SELECT N`) isolate concerns without running multiple processes. This prevents key collisions and allows selective `FLUSHDB` per subsystem.

| DB | Purpose | Consumers |
|----|---------|-----------|
| 0 | **BullMQ job queues** | NestJS API — consultation jobs (PreSummary, Summary, ComprehensiveSummary, ExtractNamedEntities) |
| 1 | **Application cache + rate limiting** | `IRedisCacheService` — get/set/setex/del, `ApiKeyRateLimiter`, `RateLimitingService` |
| 2 | **STT Pub/Sub + Streams** | `RedisSubscriberService` (stt:transcription:*), `StreamingAudioBridgeService` (stt:audio:*, stt:control:*, stt:result:*), STT-V2 Python (redis.asyncio) |
| 3 | **SMR Pub/Sub + Streams** | `SmrStreamConsumerService` (smr:stream:*), SMR Python `TaskManager` (smr:task:*) |
| 4 | **Celery broker + results** | SMR/MLflow/FedL async tasks |
| 5 | **Dramatiq broker + results** | STT-V2 `RedisBroker` + `RedisBackend` |

> **Note**: Pub/Sub in Redis is global — it works across all databases. The database number only isolates key-based operations (GET/SET/XADD/etc). Pub/Sub channel naming conventions (`stt:`, `smr:`) provide logical isolation.

---

## 4. Prerequisites

- Proxmox host with available resources (4 vCPU / 6 GB RAM / 48 GB disk total for both VMs)
- Ubuntu 24.04 Server cloud-init template — or Alpine Linux 3.21 (see [Appendix A](#appendix-a-alpine-linux-instead-of-ubuntu))
- SSH access to Proxmox host
- Cloudflare Tunnel (CT 101) running — for SSH access only

---

## 5. Create VMs (Proxmox Host)

### 5.1 — VM Hardware Best Practices for Redis

Before creating the VMs, understand the hardware choices and why they matter for Redis:

| Setting | Value | Rationale |
|---------|-------|-----------|
| **SCSI Controller** | `virtio-scsi-single` | Each disk gets its own VirtIO SCSI controller with a dedicated I/O thread. Proxmox default since 7.3. Recommended by Proxmox docs for performance. |
| **IO Thread** | `iothread=1` | Offloads disk I/O to a dedicated QEMU thread instead of the main event loop. Reduces latency for I/O-intensive workloads like Redis AOF fsync. |
| **Disk cache** | `cache=none` | Default and recommended — bypasses host page cache (O_DIRECT), lets Redis manage its own memory. Avoids double-caching. |
| **Discard** | `discard=on` | Passes TRIM from guest to host storage. Keeps thin-provisioned LVM volumes small. |
| **SSD emulation** | `ssd=1` | Tells guest the disk is SSD-backed. Enables TRIM in guest, avoids unnecessary I/O scheduling overhead. |
| **CPU type** | `host` | Exposes all host CPU features to the VM (AES-NI, AVX, etc.). Since these VMs won't be live-migrated, `host` is safe and gives best performance. |
| **Machine type** | `q35` | Modern PCIe-based chipset. Better interrupt handling than i440fx. |
| **Ballooning** | `balloon=0` | **Disabled.** Redis must have guaranteed memory — the balloon driver reclaims RAM from VMs under host memory pressure. If Redis loses memory unexpectedly, it hits OOM or triggers evictions. For a cache/queue service, predictable memory is critical. |
| **NUMA** | `numa=0` | Not needed for 2 vCPU VMs. NUMA is relevant for multi-socket hosts with 4+ vCPUs. |
| **QEMU Guest Agent** | `agent=1` | Enables Proxmox to do clean shutdown, filesystem freeze for snapshots, and report guest IP. |
| **Start at boot** | `onboot=1` | Auto-start Redis VMs when the Proxmox host boots. |

#### On Shared Memory (Inter-VM Shared Memory)

Proxmox offers `ivshmem` for sharing a memory region between VMs or between host and guest. **This is not what you want for Redis.** `ivshmem` is designed for:

- GPU framebuffer sharing (Looking Glass)
- Inter-VM communication bypassing the network
- Custom DPDK/SPDK applications

Redis clients connect over TCP — they don't share memory with the Redis process. The correct way to give Redis more usable memory is to:

1. **Disable ballooning** (`balloon=0`) so the VM keeps its full RAM allocation
2. **Set fixed memory** — don't use min/max dynamic allocation
3. **Tune `maxmemory`** in `redis.conf` to ~70% of VM RAM (leave room for OS, Docker, AOF rewrite buffers)

### 5.2 — Clone from Template

```bash
# On Proxmox host (SSH or web shell)

# ── Dev VM (420) ──────────────────────────────────────────────────────
qm clone <template-id> 420 --name redis-dev --full

# CPU: 2 cores, host passthrough, no NUMA
qm set 420 --cores 2 --cpu cputype=host --numa 0

# Memory: 2 GB fixed, ballooning disabled
qm set 420 --memory 2048 --balloon 0

# Machine type: q35 (modern PCIe chipset)
qm set 420 --machine q35

# Network: virtio on internal bridge
qm set 420 --net0 virtio,bridge=vmbr1

# Disk: virtio-scsi-single with IO thread, SSD emulation, TRIM
qm set 420 --scsihw virtio-scsi-single
qm set 420 --scsi0 local-lvm:16,iothread=1,discard=on,ssd=1,cache=none

# QEMU Guest Agent
qm set 420 --agent 1

# Auto-start on host boot
qm set 420 --onboot 1

# Cloud-init
qm set 420 --ipconfig0 ip=10.10.1.120/24,gw=10.10.1.1

qm start 420

# ── Staging VM (421) ─────────────────────────────────────────────────
qm clone <template-id> 421 --name redis-staging --full

qm set 421 --cores 2 --cpu cputype=host --numa 0
qm set 421 --memory 4096 --balloon 0
qm set 421 --machine q35
qm set 421 --net0 virtio,bridge=vmbr1
qm set 421 --scsihw virtio-scsi-single
qm set 421 --scsi0 local-lvm:32,iothread=1,discard=on,ssd=1,cache=none
qm set 421 --agent 1
qm set 421 --onboot 1
qm set 421 --ipconfig0 ip=10.10.1.121/24,gw=10.10.1.1

qm start 421
```

> Replace `<template-id>` with your Ubuntu 24.04 (or Alpine 3.21) cloud-init template ID.

#### Expected VM Config (verify with `qm config`)

```bash
qm config 420
```

Key lines to check:

```
agent: 1
balloon: 0
cores: 2
cpu: cputype=host
machine: q35
memory: 2048
net0: virtio=...,bridge=vmbr1
numa: 0
onboot: 1
scsi0: local-lvm:vm-420-disk-0,discard=on,iothread=1,ssd=1,cache=none
scsihw: virtio-scsi-single
```

### 5.3 — Verify Connectivity

```bash
# From any VM on the internal network
ping -c 3 10.10.1.120
ping -c 3 10.10.1.121

# SSH in
ssh hope@10.10.1.120
ssh hope@10.10.1.121
```

---

## 6. Prepare Each VM

Run on **both VMs** (420 and 421).

### 6.1 Set Hostnames

```bash
# VM 420
sudo hostnamectl set-hostname redis-dev

# VM 421
sudo hostnamectl set-hostname redis-staging
```

### 6.2 Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Log out and back in
exit
```

```bash
# Reconnect and verify
docker --version
docker compose version
```

### 6.3 Create Directories

```bash
sudo mkdir -p /opt/redis/{data,logs,backups}
sudo chown -R $USER:$USER /opt/redis
```

### 6.4 Configure Firewall

```bash
sudo apt-get update && sudo apt-get install -y ufw

# Allow SSH first
sudo ufw allow OpenSSH

# Redis from internal network only
sudo ufw allow from 10.10.1.0/24 to any port 6379 proto tcp comment "Redis"

# Prometheus scraping (redis-exporter)
sudo ufw allow from 10.10.1.0/24 to any port 9121 proto tcp comment "redis-exporter"

# Allow CT 101 (Cloudflare Tunnel) for SSH
sudo ufw allow from 10.10.1.2 to any comment "CT 101 - Cloudflare Tunnel"

sudo ufw enable
sudo ufw status verbose
```

### 6.5 Restrict Docker-Published Ports

Docker bypasses UFW by modifying iptables directly. Add a `DOCKER-USER` rule to restrict Docker-published ports to the private subnet:

```bash
# Find interface name (likely enp6s18 on Proxmox VMs)
ip -br a

IFACE="enp6s18"
if ! grep -q "DOCKER-USER -i ${IFACE}" /etc/ufw/before.rules; then
  sudo sed -i '/^COMMIT$/i \
# Restrict Docker-published ports to private subnet only\
-I DOCKER-USER -i '"${IFACE}"' ! -s 10.10.1.0/24 -j DROP' /etc/ufw/before.rules
  echo "Rule added to before.rules for interface ${IFACE}"
else
  echo "Rule already exists — skipping"
fi

# Apply immediately
if ! sudo iptables -L DOCKER-USER -n | grep -q "${IFACE}"; then
  sudo iptables -I DOCKER-USER -i "${IFACE}" ! -s 10.10.1.0/24 -j DROP
fi

sudo ufw reload
```

Verify:

```bash
sudo iptables -L DOCKER-USER -n -v
# Expected: one DROP rule for your interface, plus the default RETURN
```

### 6.6 Tune Kernel Parameters

```bash
cat <<'EOF' | sudo tee /etc/sysctl.d/99-redis.conf
# Redis recommended settings
vm.overcommit_memory = 1
net.core.somaxconn = 65535

# Disable THP (Redis warns about this)
# Handled by systemd service below
EOF

sudo sysctl -p /etc/sysctl.d/99-redis.conf
```

Disable Transparent Huge Pages (Redis performance recommendation):

```bash
sudo tee /etc/systemd/system/disable-thp.service <<'EOF'
[Unit]
Description=Disable Transparent Huge Pages
DefaultDependencies=no
After=sysinit.target local-fs.target
Before=docker.service

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled && echo never > /sys/kernel/mm/transparent_hugepage/defrag'

[Install]
WantedBy=basic.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now disable-thp.service
```

---

## 7. Deploy Redis — Dev (VM 420)

### 7.1 Copy Config Files

```bash
# From your workstation
scp -r research/configs/redis/ hope@10.10.1.120:/opt/redis/
# Or via Cloudflare Tunnel
scp -r research/configs/redis/ ssh-redis-dev:/opt/redis/
```

### 7.2 Create Environment File

```bash
ssh hope@10.10.1.120
cd /opt/redis

cat > .env <<'EOF'
REDIS_PASS=CHANGE_ME_dev_password_here
ENVIRONMENT=dev
EOF

chmod 600 .env
```

> Generate a strong password: `openssl rand -base64 24`

### 7.3 Start Services

```bash
cd /opt/redis

# Use dev config
cp redis-dev.conf redis.conf

docker compose pull
docker compose up -d

# Verify
docker compose ps
docker logs hope-redis --tail 20
```

### 7.4 Quick Verification

```bash
# Ping
docker exec hope-redis redis-cli -a "$REDIS_PASS" ping
# → PONG

# Info
docker exec hope-redis redis-cli -a "$REDIS_PASS" info server | grep redis_version
# → redis_version:8.x.x

# Check maxmemory
docker exec hope-redis redis-cli -a "$REDIS_PASS" config get maxmemory
# → 536870912 (512 MB)

# Exporter
curl -s http://10.10.1.120:9121/metrics | grep redis_up
# → redis_up 1
```

---

## 8. Deploy Redis — Staging (VM 421)

### 8.1 Copy Config Files

```bash
scp -r research/configs/redis/ hope@10.10.1.121:/opt/redis/
```

### 8.2 Create Environment File

```bash
ssh hope@10.10.1.121
cd /opt/redis

cat > .env <<'EOF'
REDIS_PASS=CHANGE_ME_staging_password_here
ENVIRONMENT=staging
EOF

chmod 600 .env
```

> **Use a different password than dev.** Generate: `openssl rand -base64 24`

### 8.3 Start Services

```bash
cd /opt/redis

# Use staging config
cp redis-staging.conf redis.conf

docker compose pull
docker compose up -d

docker compose ps
docker logs hope-redis --tail 20
```

### 8.4 Verify

```bash
docker exec hope-redis redis-cli -a "$REDIS_PASS" ping
# → PONG

docker exec hope-redis redis-cli -a "$REDIS_PASS" config get maxmemory
# → 2147483648 (2 GB)

curl -s http://10.10.1.121:9121/metrics | grep redis_up
# → redis_up 1
```

---

## 9. Security Hardening

### 9.1 Dev vs Staging Differences

| Setting | Dev (VM 420) | Staging (VM 421) |
|---------|-------------|-----------------|
| `maxmemory` | 512 MB | 2 GB |
| `FLUSHALL` | Allowed | **Renamed** (blocked) |
| `FLUSHDB` | Allowed | **Renamed** (blocked) |
| `CONFIG` | Allowed | **Renamed** |
| `DEBUG` | Allowed | **Renamed** (blocked) |
| `KEYS` | Allowed | **Renamed** |
| `appendonly` | yes | yes |
| `save` (RDB) | yes | yes |

### 9.2 Password Rotation

To rotate the Redis password:

```bash
# 1. Update the password in .env
nano /opt/redis/.env

# 2. Update redis.conf
# Change the requirepass line

# 3. Restart Redis
docker compose down && docker compose up -d

# 4. Update all application .env files that reference this Redis
# 5. Restart application services
```

### 9.3 Network Security

Redis is protected by three layers:

1. **UFW** — only allows `10.10.1.0/24` on port 6379
2. **Docker-USER iptables chain** — restricts Docker-published ports to `10.10.1.0/24`
3. **Redis `requirepass`** — authentication required for all commands

Redis is **never exposed** through the Cloudflare Tunnel. The binary protocol should not traverse HTTP tunnels.

---

## 10. Cloudflare Tunnel — SSH Only

Add SSH-only routes for remote management. **Do not add Redis port routes.**

### 10.1 Add Public Hostnames in Cloudflare Dashboard

Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/) → **Networks** → **Tunnels** → **hope-homelab** → **Public Hostnames**:

| Subdomain | Domain | Type | URL |
|-----------|--------|------|-----|
| `ssh-redis-dev` | `taphuynh.dev` | SSH | `ssh://10.10.1.120:22` |
| `ssh-redis-staging` | `taphuynh.dev` | SSH | `ssh://10.10.1.121:22` |

### 10.2 Developer Access to Redis (SSH Port Forwarding)

Developers needing direct Redis access from their Mac can use SSH tunneling through the Cloudflare Tunnel:

```bash
# Forward local port 6379 to dev Redis
ssh -L 6379:10.10.1.120:6379 ssh-redis-dev.taphuynh.dev

# Then in another terminal:
redis-cli -h 127.0.0.1 -p 6379 -a '<dev-password>'

# For staging:
ssh -L 6380:10.10.1.121:6379 ssh-redis-staging.taphuynh.dev
redis-cli -h 127.0.0.1 -p 6380 -a '<staging-password>'
```

### 10.3 Update Cloudflare Tunnel Documentation

After adding the SSH routes, update [`deploy-ct101-cloudflare-tunnel.md`](./deploy-ct101-cloudflare-tunnel.md) with the new entries:

```markdown
### VM 420 — redis-dev

| Subdomain | Domain | Type | URL | Notes |
|-----------|--------|------|-----|-------|
| `ssh-redis-dev` | `taphuynh.dev` | SSH | `ssh://10.10.1.120:22` | |

### VM 421 — redis-staging

| Subdomain | Domain | Type | URL | Notes |
|-----------|--------|------|-----|-------|
| `ssh-redis-staging` | `taphuynh.dev` | SSH | `ssh://10.10.1.121:22` | |
```

---

## 11. Update Application Configuration

### 11.1 Environment Variables

Update `.env` files for each environment. The database number in the URL controls which logical database is used.

**Dev environment** (all services connecting to `10.10.1.120`):

```env
# NestJS API — BullMQ + Cache
REDIS_HOST=10.10.1.120
REDIS_PORT=6379
REDIS_PASS=<dev-password>

# STT-V2 — Dramatiq broker (db5) + Pub/Sub + Streams (db2)
REDIS_URL=redis://:${REDIS_PASS}@10.10.1.120:6379/5

# SMR — Task state + Streams (db3)
SMR_V2_REDIS_URL=redis://:${REDIS_PASS}@10.10.1.120:6379/3

# Celery — Broker + results (db4)
CELERY_BROKER_URL=redis://:${REDIS_PASS}@10.10.1.120:6379/4
CELERY_RESULT_BACKEND=redis://:${REDIS_PASS}@10.10.1.120:6379/4

# Summary agent (db3 — shares with SMR)
SUMMARY_AGENT_REDIS_URL=redis://:${REDIS_PASS}@10.10.1.120:6379/3
```

**Staging environment** (all services connecting to `10.10.1.121`):

```env
# NestJS API — BullMQ + Cache
REDIS_HOST=10.10.1.121
REDIS_PORT=6379
REDIS_PASS=<staging-password>

# STT-V2
REDIS_URL=redis://:${REDIS_PASS}@10.10.1.121:6379/5

# SMR
SMR_V2_REDIS_URL=redis://:${REDIS_PASS}@10.10.1.121:6379/3

# Celery
CELERY_BROKER_URL=redis://:${REDIS_PASS}@10.10.1.121:6379/4
CELERY_RESULT_BACKEND=redis://:${REDIS_PASS}@10.10.1.121:6379/4

# Summary agent
SUMMARY_AGENT_REDIS_URL=redis://:${REDIS_PASS}@10.10.1.121:6379/3
```

### 11.2 Application Code Considerations

The NestJS API's `RedisServiceModule` reads from `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASS` — no code changes needed. BullMQ defaults to `db0`.

For database-specific connections in services that need a specific DB number, the connection URL with `/<db-number>` suffix handles selection automatically (e.g., `redis://:pass@host:6379/4`).

The `IRedisCacheService` should be configured to use `db1`. If it currently defaults to `db0`, update the `redis-cache.module.ts` connection options:

```typescript
db: 1, // Application cache database
```

---

## 12. Automated Backup

### 12.1 Deploy Backup Script

The backup script is included in the config files at `configs/redis/backup.sh`. Deploy it on **both VMs**:

```bash
sudo cp /opt/redis/backup.sh /usr/local/bin/redis-backup.sh
sudo chmod +x /usr/local/bin/redis-backup.sh
```

### 12.2 Schedule via Cron

```bash
# Dev — daily at 04:00
(sudo crontab -l 2>/dev/null; echo '0 4 * * * REDIS_PASS="<dev-password>" /usr/local/bin/redis-backup.sh >> /opt/redis/logs/backup.log 2>&1') | sudo crontab -

# Staging — daily at 04:00
(sudo crontab -l 2>/dev/null; echo '0 4 * * * REDIS_PASS="<staging-password>" /usr/local/bin/redis-backup.sh >> /opt/redis/logs/backup.log 2>&1') | sudo crontab -
```

### 12.3 Retention

| Environment | Retention | Schedule |
|-------------|-----------|----------|
| Dev | 3 days | Daily 04:00 |
| Staging | 7 days | Daily 04:00 |

### 12.4 Manual Backup

```bash
# Trigger an immediate backup
sudo REDIS_PASS="<password>" /usr/local/bin/redis-backup.sh

# Check backup files
ls -lah /opt/redis/backups/
```

---

## 13. Monitoring

### 13.1 redis-exporter

The `redis-exporter` sidecar is included in the Docker Compose file. It exposes Prometheus metrics on port `9121`.

### 13.2 Prometheus Scrape Config

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'redis'
    scrape_interval: 15s
    static_configs:
      - targets: ['10.10.1.120:9121']
        labels:
          environment: 'dev'
          service: 'redis'
      - targets: ['10.10.1.121:9121']
        labels:
          environment: 'staging'
          service: 'redis'
```

### 13.3 Key Metrics to Monitor

| Metric | Alert Threshold | Meaning |
|--------|----------------|---------|
| `redis_memory_used_bytes` | > 80% of `maxmemory` | Memory pressure — evictions starting |
| `redis_connected_clients` | > 500 (spike) | Possible connection leak |
| `redis_rejected_connections_total` | > 0 | `maxclients` reached |
| `redis_keyspace_hits_total / (hits + misses)` | < 80% | Poor cache hit ratio |
| `redis_rdb_last_bgsave_status` | != 1 | RDB snapshot failed |
| `redis_aof_last_bgrewrite_status` | != 1 | AOF rewrite failed |
| `redis_evicted_keys_total` | increasing | Memory full, keys being evicted |
| `redis_commands_duration_seconds` | p99 > 10ms | Slow commands — check slow log |

### 13.4 Recommended Grafana Dashboard

| Dashboard ID | Name |
|-------------|------|
| 763 | Redis Dashboard for Prometheus Redis Exporter |

---

## 14. Verify

### Full Verification Checklist

Run on **each VM** after deployment:

```bash
# 1. Service running and healthy
docker compose ps
# → hope-redis: running (healthy), redis-exporter: running

# 2. Redis responds
docker exec hope-redis redis-cli -a "$REDIS_PASS" ping
# → PONG

# 3. Correct version
docker exec hope-redis redis-cli -a "$REDIS_PASS" info server | grep redis_version
# → redis_version:8.x.x

# 4. Correct maxmemory
docker exec hope-redis redis-cli -a "$REDIS_PASS" config get maxmemory
# Dev: 536870912 (512 MB)
# Staging: 2147483648 (2 GB)

# 5. Persistence enabled
docker exec hope-redis redis-cli -a "$REDIS_PASS" config get appendonly
# → yes

# 6. Database isolation works
docker exec hope-redis redis-cli -a "$REDIS_PASS" -n 0 set test:bullmq "ok"
docker exec hope-redis redis-cli -a "$REDIS_PASS" -n 1 set test:cache "ok"
docker exec hope-redis redis-cli -a "$REDIS_PASS" -n 0 get test:cache
# → (nil) — keys are isolated per database
docker exec hope-redis redis-cli -a "$REDIS_PASS" -n 0 del test:bullmq
docker exec hope-redis redis-cli -a "$REDIS_PASS" -n 1 del test:cache

# 7. Reachable from other VMs
# From any other VM on 10.10.1.0/24:
redis-cli -h 10.10.1.120 -a '<dev-password>' ping
# → PONG

# 8. Exporter metrics
curl -s http://10.10.1.120:9121/metrics | grep redis_up
# → redis_up 1

# 9. Firewall rules active
sudo ufw status verbose
sudo iptables -L DOCKER-USER -n -v

# 10. Not reachable from outside internal network
# This should time out from any non-10.10.1.x machine
```

---

## 15. Operational Runbook

### Common Commands

```bash
# Redis CLI (from the VM)
docker exec -it hope-redis redis-cli -a "$REDIS_PASS"

# Monitor all commands in real-time
docker exec hope-redis redis-cli -a "$REDIS_PASS" monitor

# Slow log (commands taking > 10ms)
docker exec hope-redis redis-cli -a "$REDIS_PASS" slowlog get 10

# Memory usage report
docker exec hope-redis redis-cli -a "$REDIS_PASS" info memory

# Client connections
docker exec hope-redis redis-cli -a "$REDIS_PASS" client list

# Keyspace stats (keys per database)
docker exec hope-redis redis-cli -a "$REDIS_PASS" info keyspace

# Flush a specific database (dev only — blocked in staging)
docker exec hope-redis redis-cli -a "$REDIS_PASS" -n 0 FLUSHDB

# Trigger RDB snapshot
docker exec hope-redis redis-cli -a "$REDIS_PASS" BGSAVE

# Trigger AOF rewrite
docker exec hope-redis redis-cli -a "$REDIS_PASS" BGREWRITEAOF
```

### Restart Procedure

```bash
cd /opt/redis

# Graceful restart (waits for persistence to complete)
docker compose restart redis

# Full restart (down + up)
docker compose down
docker compose up -d
```

### Upgrading Redis

```bash
cd /opt/redis

# 1. Check current version
docker exec hope-redis redis-cli -a "$REDIS_PASS" info server | grep redis_version

# 2. Update image tag in docker-compose.yml
# Edit the redis image tag

# 3. Pull and recreate
docker compose pull
docker compose up -d

# 4. Verify
docker exec hope-redis redis-cli -a "$REDIS_PASS" info server | grep redis_version
```

---

## 16. Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `NOAUTH Authentication required` | Missing or wrong password | Check `REDIS_PASS` in `.env`, verify `redis.conf` has matching `requirepass` |
| `OOM command not allowed` | Memory limit reached, eviction policy can't free keys | Check `maxmemory-policy`, increase `maxmemory`, or flush unneeded databases |
| `Connection refused` | Redis not running or firewall blocking | `docker compose ps`, check UFW rules, verify port 6379 is published |
| High latency / slow commands | Large keys, blocking commands, or THP enabled | Check `slowlog`, verify THP is disabled, check `KEYS` usage |
| AOF rewrite failing | Disk full | Check `df -h`, clean old backups, expand disk |
| Exporter shows `redis_up 0` | Exporter can't connect | Verify exporter `REDIS_PASSWORD` matches, check container networking |
| `ERR unknown command` (staging) | Command has been renamed | Expected for `FLUSHALL`, `CONFIG`, etc. Use renamed versions or connect to dev |
| BullMQ jobs stuck | Redis memory full or connection issues | Check `info memory`, check `info clients`, restart BullMQ workers |

### Logs

```bash
# Redis logs
docker logs -f hope-redis

# Exporter logs
docker logs -f redis-exporter

# Backup logs
tail -f /opt/redis/logs/backup.log
```

---

## Quick Reference

```
VM 420 — Redis Dev
  IP:         10.10.1.120
  Port:       6379
  Exporter:   9121
  maxmemory:  512 MB
  Config:     /opt/redis/redis.conf (redis-dev.conf)
  Data:       /opt/redis/data/
  Backups:    /opt/redis/backups/ (3-day retention)
  Compose:    /opt/redis/docker-compose.yml
  SSH:        ssh-redis-dev.taphuynh.dev

VM 421 — Redis Staging
  IP:         10.10.1.121
  Port:       6379
  Exporter:   9121
  maxmemory:  2 GB
  Config:     /opt/redis/redis.conf (redis-staging.conf)
  Data:       /opt/redis/data/
  Backups:    /opt/redis/backups/ (7-day retention)
  Compose:    /opt/redis/docker-compose.yml
  SSH:        ssh-redis-staging.taphuynh.dev
```

### Connection Strings

| Environment | Purpose | Connection String |
|-------------|---------|-------------------|
| Dev | BullMQ (db0) | `redis://:password@10.10.1.120:6379/0` |
| Dev | Cache (db1) | `redis://:password@10.10.1.120:6379/1` |
| Dev | STT Streams (db2) | `redis://:password@10.10.1.120:6379/2` |
| Dev | SMR Streams (db3) | `redis://:password@10.10.1.120:6379/3` |
| Dev | Celery (db4) | `redis://:password@10.10.1.120:6379/4` |
| Dev | Dramatiq (db5) | `redis://:password@10.10.1.120:6379/5` |
| Staging | BullMQ (db0) | `redis://:password@10.10.1.121:6379/0` |
| Staging | Cache (db1) | `redis://:password@10.10.1.121:6379/1` |
| Staging | STT Streams (db2) | `redis://:password@10.10.1.121:6379/2` |
| Staging | SMR Streams (db3) | `redis://:password@10.10.1.121:6379/3` |
| Staging | Celery (db4) | `redis://:password@10.10.1.121:6379/4` |
| Staging | Dramatiq (db5) | `redis://:password@10.10.1.121:6379/5` |

---

## Appendix A: Alpine Linux Instead of Ubuntu

Redis VMs are lightweight single-service hosts — ideal candidates for Alpine Linux. Alpine's ~150 MB footprint (vs ~2.5 GB Ubuntu) saves disk, reduces attack surface, and boots faster. This appendix provides the complete Alpine-specific instructions that **replace** sections 5 and 6 of the main guide.

### A.1 Why Alpine for Redis VMs

| Aspect | Ubuntu 24.04 | Alpine 3.21 |
|--------|-------------|-------------|
| Base install size | ~2.5 GB | ~150 MB |
| Init system | systemd | OpenRC |
| Package manager | apt | apk |
| Firewall | UFW (iptables wrapper) | awall (iptables/nftables) |
| Docker install | `docker-ce` from Docker repo | `docker` from community repo |
| RAM overhead (idle) | ~300 MB | ~50 MB |
| Security model | AppArmor | Musl libc + PaX (hardened kernel optional) |
| Disk expansion | `growpart` + LVM | Manual `parted` + `resize2fs` |

**Trade-offs**: Alpine uses musl libc instead of glibc, BusyBox instead of GNU coreutils, and OpenRC instead of systemd. This means:

- No `systemctl` — use `rc-service` and `rc-update`
- No `journalctl` — logs go to `/var/log/messages` (syslog)
- No UFW — use `awall` (Alpine Wall) or raw iptables
- Some GNU tool flags differ (BusyBox `sed`, `grep`, `find` are simpler)

For a single-service Redis VM that only runs Docker containers, none of these are blockers.

### A.2 Create Alpine VM (Proxmox Host)

#### Option A — From Alpine ISO (Manual)

Download the Alpine **Virtual** ISO from [alpinelinux.org/downloads](https://alpinelinux.org/downloads/):

```bash
# On Proxmox host — download Alpine Virtual ISO
cd /var/lib/vz/template/iso/
wget https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/alpine-virt-3.21.0-x86_64.iso
```

Create the VM with the same hardware best practices as section 5.1:

```bash
# Dev VM
qm create 420 --name redis-dev \
  --cores 2 --cpu cputype=host --numa 0 \
  --memory 2048 --balloon 0 \
  --machine q35 \
  --net0 virtio,bridge=vmbr1 \
  --scsihw virtio-scsi-single \
  --scsi0 local-lvm:16,iothread=1,discard=on,ssd=1,cache=none \
  --agent 1 --onboot 1 \
  --ide2 local:iso/alpine-virt-3.21.0-x86_64.iso,media=cdrom \
  --boot order=ide2

# Staging VM
qm create 421 --name redis-staging \
  --cores 2 --cpu cputype=host --numa 0 \
  --memory 4096 --balloon 0 \
  --machine q35 \
  --net0 virtio,bridge=vmbr1 \
  --scsihw virtio-scsi-single \
  --scsi0 local-lvm:32,iothread=1,discard=on,ssd=1,cache=none \
  --agent 1 --onboot 1 \
  --ide2 local:iso/alpine-virt-3.21.0-x86_64.iso,media=cdrom \
  --boot order=ide2
```

Start and connect via Proxmox console:

```bash
qm start 420
# Open noVNC console in Proxmox web UI → VM 420 → Console
```

Run the Alpine installer:

```bash
# Login as root (no password initially)
setup-alpine
```

During `setup-alpine`, configure:

| Prompt | Value |
|--------|-------|
| Keyboard layout | `us` |
| Hostname | `redis-dev` (or `redis-staging`) |
| Network interface | `eth0` |
| IP address | `10.10.1.120/24` (or `.121`) |
| Gateway | `10.10.1.1` |
| DNS | `8.8.8.8 8.8.4.4` |
| Timezone | `UTC` |
| Root password | Set a strong password |
| SSH server | `openssh` |
| Disk | `sda`, type `sys` |

After installation:

```bash
# Reboot and remove the ISO
reboot

# On Proxmox host — detach the ISO
qm set 420 --ide2 none
qm set 420 --boot order=scsi0
```

#### Option B — From Cloud-Init Template (Automated)

If you have an Alpine cloud-init template already prepared:

```bash
# Dev VM
qm clone <alpine-template-id> 420 --name redis-dev --full
qm set 420 --cores 2 --cpu cputype=host --numa 0
qm set 420 --memory 2048 --balloon 0
qm set 420 --machine q35
qm set 420 --net0 virtio,bridge=vmbr1
qm set 420 --scsihw virtio-scsi-single
qm set 420 --scsi0 local-lvm:16,iothread=1,discard=on,ssd=1,cache=none
qm set 420 --agent 1 --onboot 1
qm set 420 --ipconfig0 ip=10.10.1.120/24,gw=10.10.1.1
qm start 420

# Staging VM
qm clone <alpine-template-id> 421 --name redis-staging --full
qm set 421 --cores 2 --cpu cputype=host --numa 0
qm set 421 --memory 4096 --balloon 0
qm set 421 --machine q35
qm set 421 --net0 virtio,bridge=vmbr1
qm set 421 --scsihw virtio-scsi-single
qm set 421 --scsi0 local-lvm:32,iothread=1,discard=on,ssd=1,cache=none
qm set 421 --agent 1 --onboot 1
qm set 421 --ipconfig0 ip=10.10.1.121/24,gw=10.10.1.1
qm start 421
```

#### Creating an Alpine Cloud-Init Template

If you don't have one yet, create a reusable template:

```bash
# 1. Install Alpine manually per Option A above (use a temporary VM ID)
# 2. Inside the VM, install cloud-init:
apk add cloud-init qemu-guest-agent e2fsprogs-extra util-linux

# 3. Enable services
rc-update add qemu-guest-agent
rc-update add cloud-init-local boot
rc-update add cloud-init default
rc-update add cloud-config default
rc-update add cloud-final default

# 4. Configure cloud-init datasource
cat > /etc/cloud/cloud.cfg.d/99-proxmox.cfg <<'EOF'
datasource_list: [NoCloud, ConfigDrive]
disable_root: false
ssh_pwauth: true
EOF

# 5. Clean up and prepare for templating
cloud-init clean
rm -f /etc/machine-id
truncate -s 0 /etc/hostname
poweroff

# 6. On Proxmox host — add cloud-init drive and convert to template
qm set <temp-vm-id> --ide2 local-lvm:cloudinit
qm template <temp-vm-id>
```

### A.3 Prepare Alpine VM (Replaces Section 6)

SSH into the new VM and run the following setup.

#### A.3.1 Enable Community Repository

```bash
# Uncomment the community repo line
sed -i 's|#\(.*community\)|\1|' /etc/apk/repositories
apk update
```

#### A.3.2 Install Essentials

```bash
apk add \
  docker docker-cli-compose \
  qemu-guest-agent \
  iptables ip6tables \
  awall \
  curl \
  bash \
  sudo \
  coreutils \
  shadow
```

> `coreutils` provides GNU `date`, `find`, etc. needed by the backup script. `shadow` provides `useradd` for creating the `hope` user if not already done via cloud-init.

#### A.3.3 Create Service User

```bash
# If not created during setup-alpine or cloud-init
adduser -D hope
echo "hope ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/hope
addgroup hope docker
```

#### A.3.4 Enable Docker

```bash
rc-update add docker default
rc-update add qemu-guest-agent
service docker start
service qemu-guest-agent start

# Verify
docker --version
docker compose version
```

#### A.3.5 Create Directories

```bash
mkdir -p /opt/redis/{data,logs,backups}
chown -R hope:hope /opt/redis
```

#### A.3.6 Configure Firewall (awall)

Alpine uses **awall** (Alpine Wall), a JSON-based iptables frontend. It replaces UFW.

```bash
# Create the Redis firewall policy
cat > /etc/awall/optional/redis.json <<'POLICY'
{
  "description": "Redis server firewall policy",

  "zone": {
    "internal": { "iface": "eth0" }
  },

  "filter": [
    {
      "in": "internal",
      "src": "10.10.1.0/24",
      "dest": "_fw",
      "service": { "proto": "tcp", "port": 22 },
      "action": "accept",
      "comment": "SSH from internal network"
    },
    {
      "in": "internal",
      "src": "10.10.1.0/24",
      "dest": "_fw",
      "service": { "proto": "tcp", "port": 6379 },
      "action": "accept",
      "comment": "Redis from internal network"
    },
    {
      "in": "internal",
      "src": "10.10.1.0/24",
      "dest": "_fw",
      "service": { "proto": "tcp", "port": 9121 },
      "action": "accept",
      "comment": "redis-exporter from internal network"
    },
    {
      "in": "internal",
      "src": "10.10.1.2",
      "dest": "_fw",
      "action": "accept",
      "comment": "CT 101 Cloudflare Tunnel full access"
    }
  ],

  "policy": [
    { "in": "_fw", "action": "accept" },
    { "in": "internal", "action": "drop" }
  ]
}
POLICY

# Enable and activate
awall enable redis
awall activate

# Persist across reboots
rc-update add iptables
rc-update add ip6tables
```

Verify:

```bash
awall list
# → redis  enabled

iptables -L -n
# Should show ACCEPT rules for 22, 6379, 9121 from 10.10.1.0/24
# and DROP for everything else
```

#### A.3.7 Restrict Docker-Published Ports

Docker on Alpine also bypasses the host firewall. Add the `DOCKER-USER` chain restriction:

```bash
# Find interface name
ip -br a
# Likely eth0 on Alpine

IFACE="eth0"

# Create a local.d script (Alpine's equivalent of systemd oneshot)
cat > /etc/local.d/docker-firewall.start <<EOF
#!/bin/sh
# Restrict Docker-published ports to private subnet only
iptables -I DOCKER-USER -i ${IFACE} ! -s 10.10.1.0/24 -j DROP 2>/dev/null || true
EOF

chmod +x /etc/local.d/docker-firewall.start
rc-update add local default

# Apply immediately
/etc/local.d/docker-firewall.start
```

Verify:

```bash
iptables -L DOCKER-USER -n -v
# Expected: DROP rule for eth0, non-10.10.1.0/24 sources
```

#### A.3.8 Tune Kernel Parameters

```bash
cat > /etc/sysctl.d/99-redis.conf <<'EOF'
vm.overcommit_memory = 1
net.core.somaxconn = 65535
EOF

sysctl -p /etc/sysctl.d/99-redis.conf
```

Disable Transparent Huge Pages (Alpine uses `/etc/local.d/` instead of systemd):

```bash
cat > /etc/local.d/disable-thp.start <<'EOF'
#!/bin/sh
echo never > /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null || true
echo never > /sys/kernel/mm/transparent_hugepage/defrag 2>/dev/null || true
EOF

chmod +x /etc/local.d/disable-thp.start
rc-update add local default

# Apply now
/etc/local.d/disable-thp.start

# Verify
cat /sys/kernel/mm/transparent_hugepage/enabled
# → always madvise [never]
```

### A.4 Disk Expansion (Alpine)

If you need to expand the disk later, the process differs from Ubuntu because Alpine typically uses a raw partition layout (no LVM):

```bash
# On Proxmox host
qm resize 420 scsi0 +8G

# Inside the Alpine VM
apk add parted e2fsprogs-extra

# Check layout
lsblk
fdisk -l /dev/sda

# Resize partition (usually sda3 for sys install)
parted /dev/sda resizepart 3 100%

# Resize filesystem
resize2fs /dev/sda3

# Verify
df -h /
```

> If Alpine was installed with LVM (`lvmsys` option), use the same LVM expansion commands as Ubuntu: `pvresize` → `lvextend` → `resize2fs`.

### A.5 Alpine-Specific Operational Differences

Once the VM is prepared, sections 7–16 of the main guide apply unchanged — Docker Compose, Redis config, backup script, and monitoring all work identically. The only differences are in host-level commands:

| Task | Ubuntu (systemd) | Alpine (OpenRC) |
|------|-----------------|-----------------|
| Start a service | `sudo systemctl start docker` | `sudo service docker start` |
| Enable at boot | `sudo systemctl enable docker` | `sudo rc-update add docker default` |
| Check service status | `sudo systemctl status docker` | `sudo service docker status` |
| View system logs | `journalctl -u docker -f` | `tail -f /var/log/messages` |
| Reboot | `sudo systemctl reboot` | `sudo reboot` |
| Firewall status | `sudo ufw status` | `awall list && iptables -L -n` |
| Add firewall rule | `sudo ufw allow from ...` | Edit `/etc/awall/optional/redis.json` → `awall activate` |
| Scheduled tasks | `crontab -e` or `/etc/cron.d/` | `crontab -e` (install `dcron`: `apk add dcron && rc-update add dcron default`) |

### A.6 Install Cron (Required for Backups)

Alpine doesn't include cron by default:

```bash
apk add dcron
rc-update add dcron default
service dcron start

# Verify
service dcron status
```

Then schedule the backup as described in section 12 of the main guide.

### A.7 Alpine Verification Checklist

```bash
# OS info
cat /etc/alpine-release
# → 3.21.x

# Docker
docker --version && docker compose version

# Firewall
awall list
iptables -L DOCKER-USER -n -v

# Kernel tuning
sysctl vm.overcommit_memory
# → 1

cat /sys/kernel/mm/transparent_hugepage/enabled
# → always madvise [never]

# Services enabled at boot
rc-update show default
# Should include: docker, qemu-guest-agent, local, dcron, iptables

# Redis running
docker compose -f /opt/redis/docker-compose.yml ps
docker exec hope-redis redis-cli -a "$REDIS_PASS" ping
# → PONG
```
