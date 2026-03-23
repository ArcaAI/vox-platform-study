# Research & Infrastructure Documentation

> Technical research, deployment guides, and architecture analysis for the HOPE platform homelab infrastructure.

---

## Directory Structure

```
research/
├── infrastructure/     Proxmox host setup, GPU passthrough, networking, shared storage
├── deployments/        Per-VM/CT deployment guides (CT 101, VM 200, 400, 402, 410, 411, 500–502)
├── networking/         SSH access, Cloudflare Tunnel, database connectivity
├── ai-ml/             Whisper ONNX optimization, Apple Silicon inference
├── architecture/       Application audits, fit-gap analysis, streaming timeouts
└── configs/            Ready-to-deploy configuration files (Docker Compose, HAProxy, Patroni, etc.)
```

---

## Infrastructure — Proxmox Host Setup

| Document | Description |
|----------|-------------|
| [proxmox-setup-dell-7920-step-by-step.md](./infrastructure/proxmox-setup-dell-7920-step-by-step.md) | Step-by-step Proxmox VE 9.1 installation on Dell 7920 (96 CPU, 256 GB RAM, 2× RTX 2000 Ada) — BIOS, IOMMU, GPU passthrough, VM creation, networking |
| [proxmox-gpu-self-hosted-deployment-2026-03-12.md](./infrastructure/proxmox-gpu-self-hosted-deployment-2026-03-12.md) | Architecture analysis for HOPE platform on Dell 7920 with GPU passthrough using free/open-source software |
| [proxmox-infrastructure-gitlab-rancher-plan.md](./infrastructure/proxmox-infrastructure-gitlab-rancher-plan.md) | Master infrastructure overview (v6) — all VMs/LXCs, IPs, specs, apps, status, Cloudflare tunnel routes |
| [proxmox-network-topology-design.md](./infrastructure/proxmox-network-topology-design.md) | Network topology design — VLAN-aware bridges, IP addressing, NAT, firewall rules, cloudflared ingress |
| [proxmox-shared-storage-nfs.md](./infrastructure/proxmox-shared-storage-nfs.md) | Shared NFS storage from external 954 GB disk — NFS vs Samba, Docker bind mounts, per-environment access |

## Deployments — VM/CT Guides

| Document | VM/CT | IP |
|----------|-------|----|
| [deploy-ct101-cloudflare-tunnel.md](./deployments/deploy-ct101-cloudflare-tunnel.md) | CT 101 | 10.10.1.2 |
| [deploy-vm200-k3s-gpu.md](./deployments/deploy-vm200-k3s-gpu.md) | VM 200 | 10.10.1.10 |
| [deploy-vm400-master.md](./deployments/deploy-vm400-master.md) | VM 400 | 10.10.1.100 |
| [deploy-vm402-minio.md](./deployments/deploy-vm402-minio.md) | VM 402 | 10.10.1.102 |
| [deploy-vm410-gitlab.md](./deployments/deploy-vm410-gitlab.md) | VM 410 | 10.10.1.110 |
| [deploy-vm411-gitlab-runner.md](./deployments/deploy-vm411-gitlab-runner.md) | VM 411 | 10.10.1.111 |
| [deploy-vm500-502-postgres-ha.md](./deployments/deploy-vm500-502-postgres-ha.md) | VMs 500–502 | 10.10.1.200–202 |

## Networking & Access

| Document | Description |
|----------|-------------|
| [ssh-cloudflared-setup-mac.md](./networking/ssh-cloudflared-setup-mac.md) | Mac SSH client setup for all homelab VMs via Cloudflare Tunnel — SSH config, key deployment, iTerm2 profiles |
| [setup-database-access-cloudflare-tunnel.md](./networking/setup-database-access-cloudflare-tunnel.md) | Database access patterns — SSH port forwarding, `cloudflared access tcp`, HAProxy dashboard, internal VIP |

## AI / ML Research

| Document | Description |
|----------|-------------|
| [whisper-onnx-apple-silicon-best-practices.md](./ai-ml/whisper-onnx-apple-silicon-best-practices.md) | Whisper + ONNX Runtime on Apple Silicon — chunking, CoreML, generation parameters, session config |
| [whisper-onnx-optimum-inference-optimization-2025.md](./ai-ml/whisper-onnx-optimum-inference-optimization-2025.md) | Whisper inference optimization — VAD+Whisper pipelines, batched inference, faster-whisper comparison |

## Architecture & Audits

| Document | Description |
|----------|-------------|
| [ai-streaming-timeout-audit-2026.md](./architecture/ai-streaming-timeout-audit-2026.md) | Timeout audit across API gateway, SMR, STT, NLP for HTTP/SSE/WebSocket AI streaming |
| [encounter-workflow-fit-gap-analysis-2026-03-10.md](./architecture/encounter-workflow-fit-gap-analysis-2026-03-10.md) | Fit-gap analysis of HOPE data model against standard outpatient encounter workflow |

## Configuration Files

| Folder | Used By | Key Files |
|--------|---------|-----------|
| [configs/gitlab/](./configs/gitlab/) | VM 410 — GitLab CE | `gitlab.rb`, `docker-compose.yml` |
| [configs/gitlab-runner/](./configs/gitlab-runner/) | VM 411 — GitLab Runner | `config.toml` |
| [configs/minio/](./configs/minio/) | VM 402 — MinIO | `.env.example`, `docker-compose.yml`, `create-gitlab-buckets.sh` |
| [configs/postgres-ha/](./configs/postgres-ha/) | VMs 500–502 — TimescaleDB HA | `docker-compose.yml`, `haproxy.cfg`, `keepalived-*.conf`, `patroni.yml`, `pgbackrest.conf` |
