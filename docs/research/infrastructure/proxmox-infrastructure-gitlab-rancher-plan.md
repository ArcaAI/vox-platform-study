# Proxmox Infrastructure Overview

**Date**: 2026-03-24 (revised v7)
**Host**: Dell Precision 7920 Tower — Proxmox VE 9.1
**Related**: [Network Topology](./proxmox-network-topology-design.md) | [GPU Setup](./proxmox-setup-dell-7920-step-by-step.md) | [Shared Storage](./proxmox-shared-storage-nfs.md) | [Resource Reallocation Plan](./resource-reallocation-plan.md)

---

## Table of Contents

1. [Current State](#1-current-state)
2. [Deployment Guides](#2-deployment-guides)
3. [Disk Expansion](#3-disk-expansion)
4. [Deployment Order](#4-deployment-order)
5. [Verification Checklist](#5-verification-checklist)
6. [Quick Reference Card](#6-quick-reference-card)

---

## 1. Current State

### VM / LXC Inventory

| VMID | Name | IP | Specs | Apps | Status |
|------|------|----|-------|------|--------|
| CT 100 | cloudflared | multi-homed | 1c/0.5G/2GB LXC | Cloudflare Tunnel ingress | Running |
| VM 200 | ubuntu-live-gpu | 10.10.1.10 | 16c/48G/64GB+300GB + 2× GPU | AI apps v2 with GPU (api, stt, smr, nlp) | Running |
| VM 201 | rb | 10.10.2.11 | 2c/4G/64GB | Marketing websites | Running |
| VM 400 | master | 10.10.1.100 | 8c/16G/64GB | Rancher, Argo CD | Running |
| VM 401 | vuvu | 10.10.1.101 | 16c/32G/400GB | AI apps v1 without GPU (api-v1, stt-v1, smr-v1, nlp) | Running |
| VM 402 | minio | 10.10.1.102 | 4c/8G/300GB | MinIO S3 object storage | Running |
| VM 410 | gitlab | 10.10.1.110 | 8c/16G/250GB | GitLab CE | Running |
| VM 411 | gitlab-runner | 10.10.1.111 | 8c/12G/250GB | GitLab Runners | Running |
| VM 420 | redis-dev | 10.10.1.120 | 2c/2G/16GB | Redis (dev environment) | Running |
| VM 421 | redis-staging | 10.10.1.121 | 2c/2G/32GB | Redis (staging environment) | Running |
| VM 500 | database-00 | 10.10.1.200 | 8c/32G/200GB | TimescaleDB HA primary (Patroni) | Running |
| VM 501 | database-01 | 10.10.1.201 | 8c/24G/200GB | TimescaleDB HA replica (Patroni) | Running |
| VM 502 | database-02 | 10.10.1.202 | 8c/24G/200GB | TimescaleDB HA replica (Patroni) | Running |
| — | (VIP) | 10.10.1.250 | (Keepalived) | TimescaleDB floating IP | Floats between VM 500/501 |

### Resource Totals

| Resource | Physical | Allocated | Utilization |
|----------|----------|-----------|-------------|
| CPU | 96 cores | 81 vCPU | 84% (15 cores headroom) |
| RAM | 256 GB | 220.5 GB | 86% (27.5 GB for host + buffer) |
| Disk | 2 TB SSD | ~2.1 TB virtual | Thin provisioned |
| GPU | 2× RTX 2000 Ada 16 GB | Passthrough to VM 200 | 100% |

> See [Resource Reallocation Plan](./resource-reallocation-plan.md) for the migration procedure and justification.

### Cloudflare Tunnel Routes (CT 101)

| Hostname | Service Target | VM |
|----------|---------------|----|
| `server-gpu.taphuynh.dev` | `ssh://10.10.1.10:22` | VM 200 |
| `api-staging.taphuynh.dev` | `http://10.10.1.10:30080` | VM 200 |
| `ssh-master.taphuynh.dev` | `ssh://10.10.1.100:22` | VM 400 |
| `rancher.taphuynh.dev` | `http://10.10.1.100:80` | VM 400 |
| `ssh-vuvu.taphuynh.dev` | `ssh://10.10.1.101:22` | VM 401 |
| `ssh-minio.taphuynh.dev` | `ssh://10.10.1.102:22` | VM 402 |
| `s3.taphuynh.dev` | `http://10.10.1.102:9000` | VM 402 |
| `s3-console.taphuynh.dev` | `http://10.10.1.102:9001` | VM 402 |
| `ssh-git.taphuynh.dev` | `ssh://10.10.1.110:22` | VM 410 |
| `git-remote.taphuynh.dev` | `ssh://10.10.1.110:2222` | VM 410 |
| `git.taphuynh.dev` | `http://10.10.1.110:80` | VM 410 |
| `registry.taphuynh.dev` | `http://10.10.1.110:5050` | VM 410 |
| `pages.taphuynh.dev` | `http://10.10.1.110:8090` | VM 410 |
| `ssh-git-runner.taphuynh.dev` | `ssh://10.10.1.111:22` | VM 411 |
| `ssh-db0.taphuynh.dev` | `ssh://10.10.1.200:22` | VM 500 |
| `ssh-db1.taphuynh.dev` | `ssh://10.10.1.201:22` | VM 501 |
| `ssh-db2.taphuynh.dev` | `ssh://10.10.1.202:22` | VM 502 |
| `ssh-redis-dev.taphuynh.dev` | `ssh://10.10.1.120:22` | VM 420 |
| `ssh-redis-staging.taphuynh.dev` | `ssh://10.10.1.121:22` | VM 421 |

> Full tunnel configuration, ingress rules, DNS setup, and the Cloudflare Free Tier 100 MB upload limit analysis are in the [Cloudflare Tunnel deployment guide](../deployments/deploy-ct101-cloudflare-tunnel.md).

---

## 2. Deployment Guides

Each service has a dedicated deployment guide with step-by-step instructions, config files, and verification steps.

| Service | VM/CT | Deployment Guide | Config Files |
|---------|-------|-----------------|--------------|
| Cloudflare Tunnel | CT 101 | [deploy-ct101-cloudflare-tunnel.md](../deployments/deploy-ct101-cloudflare-tunnel.md) | `/etc/cloudflared/config.yml` on CT 101 |
| K3s + GPU | VM 200 | [deploy-vm200-k3s-gpu.md](../deployments/deploy-vm200-k3s-gpu.md) | — |
| Rancher + Argo | VM 400 | [deploy-vm400-master.md](../deployments/deploy-vm400-master.md) | — |
| MinIO Object Storage | VM 402 | [deploy-vm402-minio.md](../deployments/deploy-vm402-minio.md) | [`configs/minio/`](../configs/minio/) |
| GitLab CE | VM 410 | [deploy-vm410-gitlab.md](../deployments/deploy-vm410-gitlab.md) | [`configs/gitlab/`](../configs/gitlab/) — `gitlab.rb` + `docker-compose.yml` |
| GitLab Runner | VM 411 | [deploy-vm411-gitlab-runner.md](../deployments/deploy-vm411-gitlab-runner.md) | [`configs/gitlab-runner/`](../configs/gitlab-runner/) — `config.toml` |
| Redis (Dev/Staging) | VMs 420–421 | [deploy-vm420-421-redis.md](../deployments/deploy-vm420-421-redis.md) | [`configs/redis/`](../configs/redis/) |
| TimescaleDB HA | VMs 500–502 | [deploy-vm500-502-postgres-ha.md](../deployments/deploy-vm500-502-postgres-ha.md) | [`configs/postgres-ha/`](../configs/postgres-ha/) |

> VM 201 (`rb` — marketing websites) and VM 401 (`vuvu` — non-GPU AI apps) do not have deployment guides yet.

---

## 3. Disk Expansion

### Why 64 GB Is Not Enough

| VM | Current | Recommended | Reason |
|----|---------|-------------|--------|
| **VM 410 (gitlab)** | 64 GB | **250 GB** | Git repos, LFS objects, Container Registry layers, CI artifacts, PostgreSQL data, uploads, backups. A single monorepo with history can be 5–10 GB; registry layers add 20–50 GB quickly. |
| **VM 411 (gitlab-runner)** | 64 GB | **150 GB** | Docker images (build + base layers), build cache, temporary artifacts. Each concurrent build consumes 2–5 GB in layers. With 4 concurrent jobs and layer caching, 100+ GB fills fast. |
| VM 400 (master) | 64 GB | 64 GB (fine) | K3s + Rancher + Argo is lightweight. Etcd data is small. |
| **VM 402 (minio)** | 64 GB | **200 GB+** | Object storage for GitLab artifacts, LFS, uploads, packages, container registry, and backups. Grows with CI usage and registry layers. |

### Expand Disk on Proxmox Host

```bash
# VM 410 (gitlab): 64G → 250G
qm resize 410 virtio0 +186G

# VM 411 (gitlab-runner): 64G → 150G
qm resize 411 virtio0 +86G

# VM 402 (minio): 64G → 200G
qm resize 402 virtio0 +136G
```

> These commands are instant — Proxmox extends the virtual disk without downtime. The guest OS still needs to see the new space.

### Extend Filesystem Inside the VM

SSH into each VM and grow the partition + filesystem:

```bash
lsblk
df -h /

# Ubuntu 24.04 Server with LVM (default installer layout):
#   /dev/vda1 = EFI (512M)
#   /dev/vda2 = /boot (1G)
#   /dev/vda3 = LVM PV (rest)
#     └── ubuntu-vg/ubuntu-lv = / (ext4)

sudo growpart /dev/vda 3
sudo pvresize /dev/vda3
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/mapper/ubuntu--vg-ubuntu--lv

df -h /
```

> **Non-LVM?** Use `sudo growpart /dev/vda 2` then `sudo resize2fs /dev/vda2`.

---

## 4. Deployment Order

Services have dependencies that dictate the deployment sequence.

```
Phase 1 ─── MinIO (VM 402) ──────────────────────────────────┐
             Object storage — no dependencies                 │
                                                              │
Phase 2 ─── GitLab CE (VM 410) ──────────────────────────────┤
             Depends on: MinIO (for object storage)           │
                                                              │
Phase 3 ─── GitLab Runner (VM 411) ──────────────────────────┤
             Depends on: GitLab                               │
                                                              │
Phase 4 ─── Cloudflare Tunnel (CT 101) ──────────────────────┤
             Update routes after services are deployed        │
                                                              │
Phase 5 ─── Rancher + Argo (VM 400) ─────────────────────────┤
             Independent, but benefits from tunnel access     │
                                                              │
Phase 6 ─── K3s + GPU (VM 200) ──────────────────────────────┤
             Depends on: Rancher (for cluster import)         │
                                                              │
Phase 7 ─── TimescaleDB HA (VMs 500–502) ────────────────────┘
             Independent — deploy when needed for app data
```

> **Disk expansion** (Section 3) should be done before deploying each VM's service. Each deployment guide includes the specific disk expansion step.

---

## 5. Verification Checklist

After deploying all services, verify end-to-end connectivity.

### GitLab (VM 410)

```bash
curl -s http://10.10.1.110/-/readiness | python3 -m json.tool
# → {"status":"ok"}

docker exec -it gitlab gitlab-ctl status
# All services: run

curl -sSI https://git.taphuynh.dev | head -5
# → HTTP/2 200 or 302

ssh -T git@git.taphuynh.dev
# → "Welcome to GitLab, @yourusername!"

docker login registry.taphuynh.dev -u <user> -p <token>
# → Login Succeeded

ls -lah /srv/gitlab/backups/*.tar
# → Recent backup file exists
```

### GitLab Runner (VM 411)

```bash
sudo gitlab-runner verify
# → Verifying runner... is alive

# In GitLab UI: Admin → CI/CD → Runners → shows "online"
```

### Rancher + Argo (VM 400)

```bash
kubectl get nodes
kubectl -n cattle-system get pods
kubectl -n argocd get pods
# All Running

curl -sk https://10.10.1.100/healthz
# → ok
```

### Cloudflare Tunnel (CT 101)

```bash
curl -sSI https://git.taphuynh.dev | head -5
curl -sSI https://rancher.taphuynh.dev | head -5
curl -sSI https://s3-console.taphuynh.dev | head -5
```

### K3s + GPU (VM 200)

```bash
kubectl get nodes -o json | jq '.items[].status.allocatable["nvidia.com/gpu"]'
# → "8"
```

### TimescaleDB HA (VMs 500–502)

```bash
psql -h 10.10.1.250 -p 5000 -U postgres -c "SELECT pg_is_in_recovery();"
# → f (connected to primary)
```

---

## 6. Quick Reference Card

```
INFRASTRUCTURE (v7 — 2026-03-24):
  VMID  NAME             IP            SPECS          APPS
  CT100 cloudflared      multi-homed   1c/0.5G/2G     Tunnel ingress
  200   ubuntu-live-gpu  10.10.1.10    16c/48G/364G   AI v2 + 2×GPU (api, stt, smr, nlp)
  201   rb               10.10.2.11    2c/4G/64G      Marketing websites
  400   master           10.10.1.100   8c/16G/64G     Rancher, Argo CD
  401   vuvu             10.10.1.101   16c/32G/400G   AI v1 no GPU (api-v1, stt-v1, smr-v1, nlp)
  402   minio            10.10.1.102   4c/8G/300G     MinIO S3 object storage
  410   gitlab           10.10.1.110   8c/16G/250G    GitLab CE (Docker Compose)
  411   gitlab-runner    10.10.1.111   8c/12G/250G    GitLab Runners (Docker executor)
  420   redis-dev        10.10.1.120   2c/2G/16G      Redis (dev)
  421   redis-staging    10.10.1.121   2c/2G/32G      Redis (staging)
  500   database-00      10.10.1.200   8c/32G/200G    TimescaleDB HA primary (Patroni)
  501   database-01      10.10.1.201   8c/24G/200G    TimescaleDB HA replica (Patroni)
  502   database-02      10.10.1.202   8c/24G/200G    TimescaleDB HA replica (Patroni)
  VIP   —                10.10.1.250   —              Keepalived floating IP

RESOURCE BUDGET:
  CPU:  81 / 96 cores  (84%)
  RAM:  220.5 / 256 GB (86%)
  Disk: ~2.1 TB virtual / 2 TB physical (thin provisioned)
  GPU:  2× RTX 2000 Ada 16 GB → VM 200

EXTERNAL ACCESS (via Cloudflare Tunnel):
  server-gpu.taphuynh.dev       → ssh://10.10.1.10:22       (VM 200 SSH)
  api-staging.taphuynh.dev      → http://10.10.1.10:30080   (VM 200 staging API)
  ssh-master.taphuynh.dev       → ssh://10.10.1.100:22      (VM 400 SSH)
  rancher.taphuynh.dev          → http://10.10.1.100:80     (VM 400 Rancher)
  ssh-vuvu.taphuynh.dev         → ssh://10.10.1.101:22      (VM 401 SSH)
  ssh-minio.taphuynh.dev        → ssh://10.10.1.102:22      (VM 402 SSH)
  s3.taphuynh.dev               → http://10.10.1.102:9000   (VM 402 MinIO API)
  s3-console.taphuynh.dev       → http://10.10.1.102:9001   (VM 402 MinIO Console)
  ssh-git.taphuynh.dev          → ssh://10.10.1.110:22      (VM 410 SSH)
  git-remote.taphuynh.dev       → ssh://10.10.1.110:2222    (VM 410 Git SSH)
  git.taphuynh.dev              → http://10.10.1.110:80     (VM 410 GitLab)
  registry.taphuynh.dev         → http://10.10.1.110:5050   (VM 410 Registry)
  pages.taphuynh.dev            → http://10.10.1.110:8090   (VM 410 Pages)
  ssh-git-runner.taphuynh.dev   → ssh://10.10.1.111:22      (VM 411 SSH)
  ssh-redis-dev.taphuynh.dev    → ssh://10.10.1.120:22      (VM 420 SSH)
  ssh-redis-staging.taphuynh.dev→ ssh://10.10.1.121:22      (VM 421 SSH)
  ssh-db0.taphuynh.dev          → ssh://10.10.1.200:22      (VM 500 SSH)
  ssh-db1.taphuynh.dev          → ssh://10.10.1.201:22      (VM 501 SSH)
  ssh-db2.taphuynh.dev          → ssh://10.10.1.202:22      (VM 502 SSH)

CONFIG FILES (version-controlled):
  configs/gitlab/gitlab.rb                GitLab Omnibus config
  configs/gitlab/docker-compose.yml       GitLab container definition
  configs/gitlab-runner/config.toml       Runner configuration
  configs/minio/docker-compose.yml        MinIO container definition
  configs/minio/.env.example              MinIO environment template
  configs/minio/create-gitlab-buckets.sh  Bucket creation script
  configs/redis/docker-compose.yml        Redis container definition
  configs/redis/redis-dev.conf            Redis dev config
  configs/redis/redis-staging.conf        Redis staging config
  configs/redis/.env.example              Redis environment template
  configs/redis/backup.sh                 Redis backup script
  configs/postgres-ha/docker-compose.yml  TimescaleDB HA stack
  configs/postgres-ha/patroni/patroni.yml Patroni cluster config
  configs/postgres-ha/haproxy/haproxy.cfg HAProxy load balancer
  configs/postgres-ha/keepalived/         Keepalived VIP configs

DEPLOYMENT GUIDES:
  deploy-ct101-cloudflare-tunnel.md       Tunnel ingress + 100MB limit analysis
  deploy-vm200-k3s-gpu.md                K3s + NVIDIA GPU Operator
  deploy-vm400-master.md                 Rancher + Argo CD
  deploy-vm402-minio.md                  MinIO S3 object storage
  deploy-vm410-gitlab.md                 GitLab CE (full guide)
  deploy-vm411-gitlab-runner.md          GitLab Runner (4 specialized runners)
  deploy-vm420-421-redis.md              Redis dev + staging
  deploy-vm500-502-postgres-ha.md        TimescaleDB HA (Patroni + etcd)

MAINTENANCE:
  GitLab backup:     sudo /usr/local/bin/gitlab-backup.sh  (daily 03:00)
  Registry GC:       docker exec gitlab gitlab-ctl registry-garbage-collect -m  (weekly Sun 05:00)
  Runner cleanup:    /usr/local/bin/runner-cleanup.sh  (weekly Sun 04:00)
  Redis backup:      /usr/local/bin/redis-backup.sh  (daily, both VMs)
  GitLab upgrade:    Edit tag in docker-compose.yml → docker compose pull && up -d
  GitLab health:     curl http://10.10.1.110/-/readiness
  GitLab logs:       docker logs -f gitlab --tail 200
  Redis health:      redis-cli -h 10.10.1.120 ping / redis-cli -h 10.10.1.121 ping
  Rancher logs:      kubectl -n cattle-system logs -f deployment/rancher
  Argo CD logs:      kubectl -n argocd logs -f deployment/argocd-server
  K3s logs:          sudo journalctl -u k3s -f
  DB cluster:        ssh database-00 "patronictl list"
```
