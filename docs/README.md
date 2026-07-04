# HOPE Documentation Index

Last updated: 2026-07-04

Index of everything under `docs/`. Start here.

## Directory Map

```
docs/
├── README.md                              # This index
├── architecture/                          # Authoritative system design (code-verified)
│   ├── overview.md                        # System context, topology, flows, deployments
│   └── data-and-domain-model.md           # Prisma domain model, tenancy, audit, lifecycle
├── traceability-matrix.md                 # Capability → service → models → routes → tests
├── development-patterns-and-standards.md  # Coding patterns & layer standards
├── development-guide.md                   # Hands-on developer guide (setup, workflows)
├── section-syntax.md                      # Optional tabbed-rendering markers for docs
├── implementation/                        # Active ticket documentation (TASK-XXX)
├── backlog/                               # Parked residuals / deferred work
├── operations/                            # Operator runbooks (day-2)
├── research/                              # Research, infra guides, audits, prior art
└── archive/                               # Historical tickets — read-only record
```

## Architecture

| Document | Contents |
|---|---|
| [architecture/overview.md](./architecture/overview.md) | What HOPE does, actors/tenants, service topology (apps, ports, protocols, dependencies), C4-style context and container diagrams, core data-flow sequences (live transcription, summarization, clinical documentation harness), API gateway structure, DDD layering, deployment topologies (local compose, k3s + ArgoCD, Vault) |
| [architecture/data-and-domain-model.md](./architecture/data-and-domain-model.md) | Prisma schema layout, standard model field template, entity groups (model → purpose → relations → owning module), multi-tenancy mechanics, soft-delete convention, sys-event/audit pipeline, PHI encryption, what lives in Postgres vs MinIO vs Qdrant vs Redis vs Vault |
| [traceability-matrix.md](./traceability-matrix.md) | One row per business capability: app/service, key packages/modules, Prisma models, verified API endpoints, test locations — with honest gap markers |

## Development

| Document | Contents |
|---|---|
| [development-patterns-and-standards.md](./development-patterns-and-standards.md) | Layer-by-layer coding standards and patterns (database → domains → applications → API; Python services; SDK) |
| [development-guide.md](./development-guide.md) | Practical developer guide: environment setup, dev stack, testing, common workflows |
| [section-syntax.md](./section-syntax.md) | Optional `<!-- @section -->` / `<!-- @example -->` / `<!-- @tabs -->` markers for docs that render with Content/Example tabs; files without markers render as plain markdown |

## Implementation Tickets — `implementation/`

Active, ticket-based implementation documentation. One folder per ticket: `[TICKET]-[Short-Name]/README.md`, updated throughout the ticket lifecycle (single main document per ticket — no per-fix files).

- **Numbering**: `TASK-XXX`. To assign a new number, take the highest existing ticket across `implementation/` and `archive/` and increment by 1.
- **Latest ticket**: TASK-412 (documentation realignment — this docs restructure).
- **Required sections**: header (ticket, dates, status), requirement analysis, current-state evaluation, implementation plan (user-approved before coding), implementation summary, change history.
- **Status values**: `Pending | In Progress | Completed | Blocked | Review`.
- Completed/historical tickets are periodically moved to [`archive/`](./archive/).

## Backlog — `backlog/`

Deliberately parked work items with context and pickup instructions. Current: [RESIDUALS-2026-07-02.md](./backlog/RESIDUALS-2026-07-02.md) (audit-payload field redaction sweep; MS-Graph live email credentials).

## Operations — `operations/`

Day-2 operator runbooks.

| Document | Contents |
|---|---|
| [operations/vault/README.md](./operations/vault/README.md) | HOPE HA Vault operator runbook: architecture (3-node Raft + Transit auto-unseal), bootstrap, rotation, failover, recovery, monitoring |

## Research — `research/`

Technical research, homelab infrastructure guides, security audits, and architecture prior art. See [research/README.md](./research/README.md) for the full index.

| Subfolder | Contents |
|---|---|
| [research/infrastructure/](./research/infrastructure/) | Proxmox host setup, GPU passthrough, network topology, shared storage |
| [research/deployments/](./research/deployments/) | Per-VM/CT deployment guides (k3s, MinIO, GitLab, Postgres HA, Vault, Redis), DR and encryption-at-rest runbooks |
| [research/networking/](./research/networking/) | SSH/Cloudflare Tunnel access, database connectivity |
| [research/ai-ml/](./research/ai-ml/) | Whisper ONNX optimization research |
| [research/architecture/](./research/architecture/) | Streaming-timeout audit, encounter-workflow fit-gap analysis, system-config/multi-tenancy design notes (prior art — where it conflicts with `docs/architecture/`, the latter wins) |
| [research/security/](./research/security/) | Security audit reports and vulnerability scans per app/package |
| [research/clinical-harness/](./research/clinical-harness/) | Medical-AI research backing the clinical documentation harness (TASK-330) |
| [research/configs/](./research/configs/) | Ready-to-deploy config files (GitLab, MinIO, Postgres HA, Redis, Langfuse) |

## Archive — `archive/`

Historical ticket documentation (`MODEL-*`, `QA-*`, `SDK-*`, `SEC-*`, `STT-*`, `TASK-001` … ). Kept as an immutable record of past decisions — **do not edit**; references inside archived documents may describe removed components (e.g. `knowledge/`, `apps/admin`, `apps/tts`) and are intentionally left as-is.

## Related (outside `docs/`)

| Location | Contents |
|---|---|
| [`../README.md`](../README.md) | Monorepo quick start and command reference |
| `apps/*/README.md`, `packages/*/README.md` | Per-app / per-package documentation |
| [`../infrastructure/docker/README.md`](../infrastructure/docker/README.md) | Local Docker infrastructure guide |
| [`../deployment/README.md`](../deployment/README.md) | k3s + ArgoCD deployment guide |
| [`../infrastructure/SECURITY_DEPLOYMENT_GUIDE.md`](../infrastructure/SECURITY_DEPLOYMENT_GUIDE.md) | Production security posture |
