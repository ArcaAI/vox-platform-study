# Research & Infrastructure Documentation — a dated homelab research archive

Technical research, deployment guides, and configuration snapshots for the HOPE platform's
Proxmox/k3s homelab infrastructure, plus AI/ML investigations. **This is a point-in-time research
archive, not current operational guidance** — several documents in `deployments/` and
`infrastructure/` carry their own `Status: BUILT / SUPERSEDED / UNVERIFIED` header because the
live infrastructure has since diverged from what they describe; verify against
`.claude/rules/09-infrastructure-devops.md` and the live cluster/estate before acting on anything
here. One finding is worth flagging even in an index: a 2026-08-31 investigation
([`infrastructure/cloudflare-lan-path-incident-2026-08-31.md`](./infrastructure/cloudflare-lan-path-incident-2026-08-31.md))
found LAN-to-LAN traffic between VMs metres apart transiting a Cloudflare edge; the image-pull half
was fixed, the Rancher-websocket half was not — read that document before touching Rancher/Argo
network paths on VM 200.

## Layout

| Directory | Contents |
|---|---|
| `infrastructure/` | Proxmox host setup, GPU passthrough, networking, shared storage |
| `deployments/` | Per-VM/CT deployment guides |
| `networking/` | SSH access, Cloudflare Tunnel, database connectivity |
| `ai-ml/` | STT realtime+batch SOTA assessment (+ captured research set), Whisper ONNX, MLflow/vLLM/s3fs inference research |
| `architecture/` | Application audits, fit-gap analysis, streaming timeouts, a multi-tenancy config design set |
| `configs/` | Ready-to-deploy configuration files (Docker Compose, HAProxy, Patroni, etc.) |
| `clinical-harness/` | Medical-AI + harness-engineering research (scribes, RAG, evals, governance, India, FHIR) |

### Infrastructure — Proxmox host setup

| Document | Description |
|---|---|
| `proxmox-setup-dell-7920-step-by-step.md` | Proxmox VE 9.1 installation on Dell 7920 (96 CPU, 256 GB RAM, 2x RTX 2000 Ada) — BIOS, IOMMU, GPU passthrough, VM creation, networking |
| `proxmox-gpu-self-hosted-deployment-2026-03-12.md` | Architecture analysis for HOPE on Dell 7920 with GPU passthrough |
| `proxmox-infrastructure-gitlab-rancher-plan.md` | Master infrastructure overview — all VMs/LXCs, IPs, specs, apps, status, Cloudflare tunnel routes |
| `cloudflare-lan-path-incident-2026-08-31.md` | Investigation write-up — LAN traffic transiting Cloudflare (see the lede above) |
| `proxmox-network-topology-design.md` | Network topology design — VLAN-aware bridges, IP addressing, NAT, firewall, cloudflared ingress |
| `proxmox-shared-storage-nfs.md` | Shared NFS storage from an external disk — NFS vs Samba, Docker bind mounts |
| `resource-reallocation-plan.md` | Live-migration resource reallocation plan (2026-03-24) |

### Deployments — per VM/CT guides

| Document | VM/CT | IP | Note |
|---|---|---|---|
| `deploy-ct101-cloudflare-tunnel.md` | CT 101 | 10.10.1.2 | |
| `deploy-vm200-k3s-gpu.md` | VM 200 | 10.10.1.10 | |
| `deploy-vm400-master.md` | VM 400 | 10.10.1.100 | |
| `deploy-vm400-langfuse.md` | VM 400 | 10.10.1.100 | Self-declared `Status: UNVERIFIED` — no evidence Langfuse is actually running |
| `deploy-vm402-minio.md` | VM 402 | 10.10.1.102 | |
| `deploy-vm410-gitlab.md` | VM 410 | 10.10.1.110 | |
| `deploy-vm411-gitlab-runner.md` | VM 411 | 10.10.1.111 | |
| `deploy-vm420-421-redis.md` | VMs 420-421 | | Self-declared `Status: BUILT` — live per ground-truth VM inventory |
| `deploy-vm430-432-vault.md` | VMs 430-432 | | Self-declared `Status: SUPERSEDED` — describes a Shamir design; the actual deployment used Raft + Transit auto-unseal, itself since retired (see `../operations/vault/README.md`) |
| `deploy-vm500-502-postgres-ha.md` | VMs 500-502 | 10.10.1.200-202 | Pairs with `../configs/postgres-ha/` |
| `dr-break-glass-runbook.md` | | | Self-declared `Status: SUPERSEDED` — Shamir-based break-glass procedures, inapplicable to the Raft/Transit design that replaced them |
| `encryption-at-rest-luks-minio-sse-runbook.md` | | | Self-declared `Status: UNVERIFIED` — a specification/playbook, not a record of current state |
| `vault-transit-key-rotation.md` | | | Self-declared `Status: BUILT (PARTIAL)` — Transit auto-unseal is live; routine key rotation is an untested operator procedure |

### Networking & access

| Document | Description |
|---|---|
| `ssh-cloudflared-setup-mac.md` | Mac SSH client setup for homelab VMs via Cloudflare Tunnel |
| `setup-database-access-cloudflare-tunnel.md` | Database access patterns — SSH port forwarding, `cloudflared access tcp`, HAProxy dashboard |
| `ubuntu-desktop-networkmanager-conflict.md` | Ubuntu Desktop + NetworkManager conflict resolution on VM 400 |

### AI / ML research

| Document | Description |
|---|---|
| `stt-realtime-batch-sota-assessment-2026-07.md` | STT realtime + batch SOTA assessment (2026-07) — architecture map, findings, scorecard, roadmap |
| `stt-realtime-batch-sota-2026-07/` | Complete captured source material behind the assessment — see [its own README](./ai-ml/stt-realtime-batch-sota-2026-07/README.md) |
| `whisper-onnx-apple-silicon-best-practices.md` | Whisper + ONNX Runtime on Apple Silicon |
| `whisper-onnx-optimum-inference-optimization-2025.md` | Whisper inference optimization — VAD+Whisper pipelines, batched inference |
| `mlflow-vllm-minio-onprem-inference-2026-09.md` | MLflow + vLLM + MinIO for on-prem k8s inference |
| `s3fs-model-store-for-lmstudio-2026-09.md` | Mounting the MinIO models bucket into LM Studio with an s3fs sidecar |
| `mlflow-gateway-jit-model-serving-2026-09.md` | Whether MLflow can front inference with JIT model loading |

### Architecture & audits

| Document | Description |
|---|---|
| `ai-streaming-timeout-audit-2026.md` | Timeout audit across the gateway, Text, STT, NLP for HTTP/SSE/WebSocket streaming |
| `encounter-workflow-fit-gap-analysis-2026-03-10.md` | Fit-gap analysis of the HOPE data model against a standard outpatient encounter workflow |
| `system-config-multi-tenancy/` | A 5-document config design set: `00-overview.md`, `01-layered-resolution-migration.md`, `02-secrets-cloud-kms-migration.md`, `03-pgbouncer-prisma.md`, `04-optimistic-locking.md` |

### Clinical Documentation Harness research

Fully-cited research backing the harness design. See
[`clinical-harness/README.md`](./clinical-harness/README.md) for the full index.

### Configuration files

| Folder | Used by |
|---|---|
| `configs/gitlab/` | VM 410 — GitLab CE (`gitlab.rb`, `docker-compose.yml`) |
| `configs/gitlab-runner/` | VM 411 — GitLab Runner (`config.toml`) |
| `configs/langfuse/` | VM 400 — Langfuse (`docker-compose.yml`) |
| `configs/minio/` | VM 402 — MinIO (`docker-compose.yml`, `create-gitlab-buckets.sh`) |
| `configs/redis/` | Application caching/queuing Redis (`docker-compose.yml`, `redis-dev.conf`, `redis-staging.conf`, `backup.sh`) |
| `configs/postgres-ha/` | VMs 500-502 — TimescaleDB HA; see [its own README](./configs/postgres-ha/README.md) |

## Related

- [`../../.claude/rules/09-infrastructure-devops.md`](../../.claude/rules/09-infrastructure-devops.md) — current, authoritative cluster/infrastructure state
- [`../operations/vault/README.md`](../operations/vault/README.md) — the current, live Vault (superseding two designs recorded in `deployments/` above)
- [`../architecture/consultation-session-workflow/assessment/README.md`](../architecture/consultation-session-workflow/assessment/README.md) — a later, code-verified assessment covering the consultation vertical
