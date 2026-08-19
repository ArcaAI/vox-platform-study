# HOPE Documentation Index

Owner: Platform Engineering · Introduced: 2026-07-04 · Last verified: 2026-07-21

Index of everything under `docs/`. Start here.

## Directory Map

```
docs/
├── README.md                              # This index
├── architecture/                          # Authoritative system design (code-verified)
│   ├── overview.md                        # System context, topology, flows, deployments
│   ├── data-and-domain-model.md           # Prisma domain model, tenancy, audit, lifecycle
│   ├── model-and-config-plane.md          # Model selection, providers/BYO, runtime profiles, retention
│   ├── configuration-storage-classification.md  # Where an admin-controllable variable lives
│   └── environment-configuration-reference.md   # Per-variable env reference
├── traceability/                          # Per-domain capability traceability (successor to the matrix)
│   └── index.md                           # Roll-up index over the per-domain files
├── development-patterns-and-standards.md  # Coding patterns & layer standards
├── development-guide.md                   # Hands-on developer guide (setup, workflows)
├── section-syntax.md                      # Optional tabbed-rendering markers for docs
├── programs/                              # Multi-ticket program workspaces (planning artifacts)
│   └── agentic-workflow-platform/         # Design, backlog, execution log, conformance reviews
├── implementation/                        # Active ticket documentation (TASK-XXX)
├── backlog/                               # Parked residuals / deferred work
├── operations/                            # Operator runbooks (day-2)
├── research/                              # Research, infra guides, audits, prior art
└── archive/                               # Historical tickets — read-only record
```

## Architecture

| Document                                                                                                       | Contents                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture/overview.md](./architecture/overview.md)                                                         | What HOPE does, actors/tenants, service topology (apps, ports, protocols, dependencies), C4-style context and container diagrams, core data-flow sequences (live transcription, summarization, clinical documentation harness), API gateway structure, DDD layering, deployment topologies (local compose, k3s + ArgoCD, Vault)                               |
| [architecture/data-and-domain-model.md](./architecture/data-and-domain-model.md)                               | Prisma schema layout, standard model field template, entity groups (model → purpose → relations → owning module), multi-tenancy mechanics, soft-delete convention, sys-event/audit pipeline, PHI encryption, what lives in Postgres vs MinIO vs Qdrant vs Redis vs Vault                                                                                      |
| [architecture/model-and-config-plane.md](./architecture/model-and-config-plane.md)                             | Which model runs a task, where its provider lives and how it is authenticated (BYO credentials), hyperparameters/concurrency, model registry + discovery + source resolution, retention, pipeline template governance                                                                                                                                         |
| [architecture/configuration-storage-classification.md](./architecture/configuration-storage-classification.md) | The normative rule for WHERE an admin-controllable variable lives — the six data classes ↔ seven storage tiers (Vault kv-v2 / Transit-in-DB / dedicated table / GlobalSetting / Redis flag / entitlement / env), the `SettingDescriptor` anatomy, `failMode`, the assembly-time invariants, the write-lane guard order, anti-patterns and reusable primitives |
| [architecture/environment-configuration-reference.md](./architecture/environment-configuration-reference.md)   | Full env-var reference: how `.env.sample`/`.env.dev`/`.env.test` relate, per-service variable tables, provider/model default & fallback semantics                                                                                                                                                                                                             |
| [traceability/index.md](./traceability/index.md)                                                               | Roll-up index over the per-domain traceability files (auth, AI models, TTS, tenancy, consultation, transcription, summarization, harness, storage, platform-ops, admin-console, SDK, workflows) — each re-verified against code with its own `Last verified` stamp (successor to the matrix)                                                                  |

## Development

| Document                                                                         | Contents                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [development-patterns-and-standards.md](./development-patterns-and-standards.md) | Layer-by-layer coding standards and patterns (database → domains → applications → API; Python services; SDK)                                                                 |
| [development-guide.md](./development-guide.md)                                   | Practical developer guide: environment setup, dev stack, testing, common workflows                                                                                           |
| [section-syntax.md](./section-syntax.md)                                         | Optional `<!-- @section -->` / `<!-- @example -->` / `<!-- @tabs -->` markers for docs that render with Content/Example tabs; files without markers render as plain markdown |

## Programs — `programs/`

Workspaces for multi-ticket programs: the planning artifacts a program needs while it runs — design, decision records, ticket backlog, execution log, and conformance reviews measuring the code against the program's own brief. **These are the one place in `docs/` where ticket numbers are load-bearing** — a backlog row or an execution-log entry names the ticket it tracks. Everything else in `docs/` describes the code as it stands and cites no tickets.

| Program                                                                      | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [programs/agentic-workflow-platform/](./programs/agentic-workflow-platform/) | [product-brief.md](./programs/agentic-workflow-platform/product-brief.md) (owner-provided, authoritative) · [design.md](./programs/agentic-workflow-platform/design.md) · [backlog.md](./programs/agentic-workflow-platform/backlog.md) · [execution-log.md](./programs/agentic-workflow-platform/execution-log.md) · [owner-decisions-2026-08-17.md](./programs/agentic-workflow-platform/owner-decisions-2026-08-17.md) · [ticket-template.md](./programs/agentic-workflow-platform/ticket-template.md) · `conformance/` (gateway-and-sdk, python-services, admin-console) |

A program workspace is deliberately NOT in [`architecture/`](./architecture/): architecture documents are code-verified descriptions of what exists, while these record what is planned, decided and in flight.

## Implementation Tickets — `implementation/`

Active, ticket-based implementation documentation. One folder per ticket: `[TICKET]-[Short-Name]/README.md`, updated throughout the ticket lifecycle (single main document per ticket — no per-fix files).

- **Numbering**: `TASK-XXX`. To assign a new number, take the highest existing ticket across `implementation/` and `archive/` and increment by 1 — the folders themselves are the source of truth for the current maximum.
- **Required sections**: header (ticket, dates, status), requirement analysis, current-state evaluation, implementation plan (user-approved before coding), implementation summary, change history.
- **Status values**: `Pending | In Progress | Completed | Blocked | Review`.
- Completed/historical tickets are periodically moved to [`archive/`](./archive/).

## Backlog — `backlog/`

Deliberately parked work items with context and pickup instructions:

| Document                                                                       | Contents                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [2026-07-02-RESIDUALS.md](./backlog/2026-07-02-RESIDUALS.md)                   | Audit-payload field redaction sweep; MS-Graph live email credentials                                                                                                          |
| [2026-07-04-FEDL-MLFLOW-LEGACY.md](./backlog/2026-07-04-FEDL-MLFLOW-LEGACY.md) | Parked legacy federated-learning schema models + MinIO `mlflow` bucket (removal deferred — data-destructive)                                                                  |
| [2026-07-21-TODO-HARVEST.md](./backlog/2026-07-21-TODO-HARVEST.md)             | Live register of every TODO/FIXME encountered during the code-comment cleanup, each with a disposition (kept in code, candidate ticket, or resolved) — none deleted from code |

## Operations — `operations/`

Day-2 operator runbooks.

| Document                                                                                             | Contents                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [operations/inference/README.md](./operations/inference/README.md)                                   | Production inference engines runbook; companion [model-retention.md](./operations/inference/model-retention.md) covers when models load, idle-TTL eviction, and runtime retention changes without a redeploy                                  |
| [operations/retrieval-corpus-ingestion/README.md](./operations/retrieval-corpus-ingestion/README.md) | Ingesting a licensed guideline corpus into the harness institutional-RAG store and enabling retrieval tiers (owner-run — not CI)                                                                                                              |
| [operations/tts-model-mirror/README.md](./operations/tts-model-mirror/README.md)                     | Mirroring the gated `ai4bharat/indic-parler-tts` weights into an internal ungated store for offline TTS GPU pods                                                                                                                              |
| [operations/temporal/README.md](./operations/temporal/README.md)                                     | Temporal DR/backup operator runbook: architecture, backup/restore procedure, daily health checks. Self-hosted k3s is the decided path (decision signed off 2026-08-17); the Temporal Cloud sections are retained as the not-taken alternative |
| [operations/vault/README.md](./operations/vault/README.md)                                           | HOPE HA Vault operator runbook: architecture (3-node Raft + Transit auto-unseal), bootstrap, rotation, failover, recovery, monitoring                                                                                                         |

## Research — `research/`

Technical research, homelab infrastructure guides, and architecture prior art. See [research/README.md](./research/README.md) for the full index.

| Subfolder                                                  | Contents                                                                                                                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [research/infrastructure/](./research/infrastructure/)     | Proxmox host setup, GPU passthrough, network topology, shared storage                                                                                                              |
| [research/deployments/](./research/deployments/)           | Per-VM/CT deployment guides (k3s, MinIO, GitLab, Postgres HA, Vault, Redis), DR and encryption-at-rest runbooks                                                                    |
| [research/networking/](./research/networking/)             | SSH/Cloudflare Tunnel access, database connectivity                                                                                                                                |
| [research/ai-ml/](./research/ai-ml/)                       | Whisper ONNX optimization research                                                                                                                                                 |
| [research/architecture/](./research/architecture/)         | Streaming-timeout audit, encounter-workflow fit-gap analysis, system-config/multi-tenancy design notes (prior art — where it conflicts with `docs/architecture/`, the latter wins) |
| [research/clinical-harness/](./research/clinical-harness/) | Medical-AI research backing the clinical documentation harness (harness prior art)                                                                                                 |
| [research/configs/](./research/configs/)                   | Ready-to-deploy config files (GitLab, MinIO, Postgres HA, Redis, Langfuse)                                                                                                         |

> The former `research/security/` corpus (per-app security audit reports and vulnerability scans) was removed from HEAD; recover it from git history if needed.

## Archive — `archive/`

Historical ticket documentation (`MODEL-*`, `QA-*`, `SDK-*`, `SEC-*`, `STT-*`, `TASK-001` … ). Kept as an immutable record of past decisions — **do not edit**; references inside archived documents may describe removed components (e.g. `knowledge/`, `apps/admin`, `apps/tts`) and are intentionally left as-is.

## Related (outside `docs/`)

| Location                                                                                           | Contents                                   |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [`../README.md`](../README.md)                                                                     | Monorepo quick start and command reference |
| `apps/*/README.md`, `packages/*/README.md`                                                         | Per-app / per-package documentation        |
| [`../infrastructure/docker/README.md`](../infrastructure/docker/README.md)                         | Local Docker infrastructure guide          |
| [`../deployment/README.md`](../deployment/README.md)                                               | k3s + ArgoCD deployment guide              |
| [`../infrastructure/SECURITY_DEPLOYMENT_GUIDE.md`](../infrastructure/SECURITY_DEPLOYMENT_GUIDE.md) | Production security posture                |
