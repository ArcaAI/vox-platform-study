# Research & Infrastructure Documentation

> Technical research, deployment guides, and architecture analysis for the HOPE platform homelab infrastructure.

---

## Directory Structure

```
research/
├── infrastructure/     Proxmox host setup, GPU passthrough, networking, shared storage
├── deployments/        Per-VM/CT deployment guides (CT 101, VM 200, 400, 402, 410, 411, 500–502)
├── networking/         SSH access, Cloudflare Tunnel, database connectivity
├── ai-ml/             STT realtime+batch SOTA assessment (+ captured 17-agent research set), Whisper ONNX optimization, Apple Silicon inference
├── architecture/       Application audits, fit-gap analysis, streaming timeouts
├── configs/            Ready-to-deploy configuration files (Docker Compose, HAProxy, Patroni, etc.)
└── clinical-harness/   Medical-AI + harness-engineering research (scribes, RAG, evals, governance, India, FHIR)
```

---

## ⚠ Read first — the cross-cutting finding (2026-08-31)

**`rancher.taphuynh.dev` and `registry.taphuynh.dev` resolve to Cloudflare**, so
LAN→LAN traffic between VMs metres apart crosses to a Hong Kong edge and back.
The tunnel doc's own principle — *"All VM-to-VM traffic MUST stay on the
internal `10.10.1.x` network"* — was implemented for VM 400 and VM 411 but
**never for VM 200**, the k3s cluster that pulls the largest images and holds
the Rancher websocket.

Measured: **8.5 ms** direct to the k3s API and **1.1 ms** to the Rancher origin
on the LAN, versus **350–800 ms** through the edge; image pulls at **80–200
KB/s**. It presents as `sync from client` errors, partial Argo syncs (115 of 124
objects in one run), and Deployments missing their progress deadline — none of
which look like a network problem.

**Image pulls are FIXED as of 2026-08-31** (LAN mirror, no restart — 57 KB/s → ~25 MB/s). The Rancher
websocket half is unfixed; Argo was taken off it instead.

Full write-up: [cloudflare-lan-path-incident-2026-08-31.md](./infrastructure/cloudflare-lan-path-incident-2026-08-31.md).
Per-VM procedures:
[CT 101 — second failure mode](./deployments/deploy-ct101-cloudflare-tunnel.md#-second-failure-mode-long-lived-connections-and-latency-measured-2026-08-31)
· [VM 200 — internal DNS override](./deployments/deploy-vm200-k3s-gpu.md#51-internal-dns-override--keep-cluster-traffic-off-cloudflare)
· [VM 400 — register clusters directly](./deployments/deploy-vm400-master.md#-register-downstream-clusters-directly-not-through-the-rancher-proxy)

⚠ Do **not** "fix" it with an `/etc/hosts` entry for `rancher.taphuynh.dev`
alone — the origin serves no TLS for that host, so that breaks the agent rather
than speeding it up. The order of operations is in the VM 200 guide.

---

## Infrastructure — Proxmox Host Setup

| Document | Description |
|----------|-------------|
| [proxmox-setup-dell-7920-step-by-step.md](./infrastructure/proxmox-setup-dell-7920-step-by-step.md) | Step-by-step Proxmox VE 9.1 installation on Dell 7920 (96 CPU, 256 GB RAM, 2× RTX 2000 Ada) — BIOS, IOMMU, GPU passthrough, VM creation, networking |
| [proxmox-gpu-self-hosted-deployment-2026-03-12.md](./infrastructure/proxmox-gpu-self-hosted-deployment-2026-03-12.md) | Architecture analysis for HOPE platform on Dell 7920 with GPU passthrough using free/open-source software |
| [proxmox-infrastructure-gitlab-rancher-plan.md](./infrastructure/proxmox-infrastructure-gitlab-rancher-plan.md) | Master infrastructure overview (v6) — all VMs/LXCs, IPs, specs, apps, status, Cloudflare tunnel routes |
| [cloudflare-lan-path-incident-2026-08-31.md](./infrastructure/cloudflare-lan-path-incident-2026-08-31.md) | **Investigation write-up** — LAN traffic transiting Cloudflare (HKG edge): root cause, the three faults it masked, what was ruled out, the fixes applied (Argo direct endpoint; LAN registry mirror, no restart), what is still open, and reusable pull/tunnel diagnostics |
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
| [stt-realtime-batch-sota-assessment-2026-07.md](./ai-ml/stt-realtime-batch-sota-assessment-2026-07.md) | STT realtime + batch SOTA assessment (2026-07) — code-verified architecture map, findings, best-practice scorecard, prioritized roadmap |
| [stt-realtime-batch-sota-2026-07/](./ai-ml/stt-realtime-batch-sota-2026-07/README.md) | Complete captured source material behind the assessment — 17 agent reports (7 external deep-research + 10 codebase maps/spot checks); see its README for the fleet index |
| [whisper-onnx-apple-silicon-best-practices.md](./ai-ml/whisper-onnx-apple-silicon-best-practices.md) | Whisper + ONNX Runtime on Apple Silicon — chunking, CoreML, generation parameters, session config |
| [whisper-onnx-optimum-inference-optimization-2025.md](./ai-ml/whisper-onnx-optimum-inference-optimization-2025.md) | Whisper inference optimization — VAD+Whisper pipelines, batched inference, faster-whisper comparison |

## Architecture & Audits

| Document | Description |
|----------|-------------|
| [ai-streaming-timeout-audit-2026.md](./architecture/ai-streaming-timeout-audit-2026.md) | Timeout audit across API gateway, SMR, STT, NLP for HTTP/SSE/WebSocket AI streaming |
| [encounter-workflow-fit-gap-analysis-2026-03-10.md](./architecture/encounter-workflow-fit-gap-analysis-2026-03-10.md) | Fit-gap analysis of HOPE data model against standard outpatient encounter workflow |

## Clinical Documentation Harness — Medical-AI Research

Fully-cited research backing the Clinical Documentation Harness. See [clinical-harness/README.md](./clinical-harness/README.md) for the full index.

| Document | Description |
|----------|-------------|
| [clinical-harness/00-harness-engineering-foundations.md](./clinical-harness/00-harness-engineering-foundations.md) | Harness engineering — control model, agent building blocks, context engineering |
| [clinical-harness/01-ambient-clinical-documentation.md](./clinical-harness/01-ambient-clinical-documentation.md) | AI medical scribes — accuracy, omissions, clinician UX, trust, regulation |
| [clinical-harness/02-medical-knowledge-grounding.md](./clinical-harness/02-medical-knowledge-grounding.md) | Corpora/licensing, embeddings, hybrid retrieval, ontology linking, faithfulness, benchmarks |
| [clinical-harness/03-medical-ai-evaluation-guardrails-governance.md](./clinical-harness/03-medical-ai-evaluation-guardrails-governance.md) | Eval rubrics/tooling, LLM-as-judge, guardrails, HITL, FDA/EU/UK regulation, audit |
| [clinical-harness/04-clinical-interoperability-structured-output.md](./clinical-harness/04-clinical-interoperability-structured-output.md) | FHIR/HL7 mapping, structured output, CDS Hooks/SMART, safe clinical tool-calling |
| [clinical-harness/05-india-health-ai-regulation.md](./clinical-harness/05-india-health-ai-regulation.md) | DPDP 2023 + Rules 2025, ABDM/NRCeS FHIR, Telemedicine 2020, CDSCO, MeitY |
| [clinical-harness/06-sota-harness-implementation.md](./clinical-harness/06-sota-harness-implementation.md) | 2026 implementation SOTA — orchestration libs, eval/guardrail stacks, durable HITL |

## Configuration Files

| Folder | Used By | Key Files |
|--------|---------|-----------|
| [configs/gitlab/](./configs/gitlab/) | VM 410 — GitLab CE | `gitlab.rb`, `docker-compose.yml` |
| [configs/gitlab-runner/](./configs/gitlab-runner/) | VM 411 — GitLab Runner | `config.toml` |
| [configs/minio/](./configs/minio/) | VM 402 — MinIO | `.env.example`, `docker-compose.yml`, `create-gitlab-buckets.sh` |
| [configs/postgres-ha/](./configs/postgres-ha/) | VMs 500–502 — TimescaleDB HA | `docker-compose.yml`, `haproxy.cfg`, `keepalived-*.conf`, `patroni.yml`, `pgbackrest.conf` |
