# HOPE Documentation Index — start here

Index of everything under `docs/` in the HOPE monorepo.

## Layout

```
docs/
|-- README.md                              This index
|-- architecture/                          Authoritative system design (code-verified)
|   |-- overview.md                        System context, topology, flows, deployments
|   |-- data-and-domain-model.md           Prisma domain model, tenancy, audit, lifecycle
|   |-- model-and-config-plane.md          Model selection, providers/BYO, runtime profiles, retention
|   |-- configuration-storage-classification.md   Where an admin-controllable variable lives
|   `-- environment-configuration-reference.md    Per-variable env reference
|-- traceability/                          Per-domain capability traceability
|   `-- index.md                           Roll-up index over the per-domain files
|-- development-patterns-and-standards.md  Coding patterns & layer standards
|-- development-guide.md                   Hands-on developer guide (setup, workflows)
|-- consultation-context-schema-integration-guide.md   Context schema: codegen + vox / vox-node integration
|-- section-syntax.md                      Optional tabbed-rendering markers for docs
|-- programs/                              Multi-ticket program workspaces (planning artifacts)
|   `-- agentic-workflow-platform/         Design, backlog, execution log, conformance reviews
|-- implementation/                        Active ticket documentation (TASK-XXX)
|-- backlog/                               Parked residuals / deferred work
|-- operations/                            Operator runbooks (day-2) — a large, growing directory
|-- research/                              Research, infra guides, audits, prior art
|-- test-result/                           Standalone evaluation reports (e.g. ML accuracy runs)
`-- archive/                               Historical tickets — read-only record, off-limits this sprint
```

## Architecture — `architecture/`

| Document | Contents |
|---|---|
| [architecture/overview.md](./architecture/overview.md) | What HOPE does, actors/tenants, service topology (apps, ports, protocols, dependencies), C4-style context/container diagrams, core data-flow sequences, API gateway structure, DDD layering, deployment topologies |
| [architecture/data-and-domain-model.md](./architecture/data-and-domain-model.md) | Prisma schema layout, standard model field template, entity groups, multi-tenancy mechanics, soft-delete convention, sys-event/audit pipeline, PHI encryption |
| [architecture/model-and-config-plane.md](./architecture/model-and-config-plane.md) | Which model runs a task, where its provider lives and how it is authenticated (BYO credentials), model registry + discovery + source resolution, retention |
| [architecture/configuration-storage-classification.md](./architecture/configuration-storage-classification.md) | The normative rule for WHERE an admin-controllable variable lives (data classes vs. storage tiers), `SettingDescriptor` anatomy, `failMode` |
| [architecture/environment-configuration-reference.md](./architecture/environment-configuration-reference.md) | Full env-var reference: how `.env.sample`/`.env.dev`/`.env.test` relate, per-service variable tables |
| [traceability/index.md](./traceability/index.md) | Roll-up index over the per-domain traceability files (auth, AI models, TTS, tenancy, consultation, transcription, summarization, harness, storage, platform-ops, admin-console, SDK, workflows) |

## Development

| Document | Contents |
|---|---|
| [development-patterns-and-standards.md](./development-patterns-and-standards.md) | Layer-by-layer coding standards and patterns (database -> domains -> applications -> API; Python services; SDK) |
| [development-guide.md](./development-guide.md) | Practical developer guide: environment setup, dev stack, testing, common workflows |
| [consultation-context-schema-integration-guide.md](./consultation-context-schema-integration-guide.md) | Building against a tenant-declared consultation context schema: declaration + discovery contract, `@arcaai/vox-codegen` type generation, the `@arcaai/vox-node` and `@arcaai/vox` integration lanes |
| [section-syntax.md](./section-syntax.md) | Optional `<!-- @section -->` / `<!-- @example -->` / `<!-- @tabs -->` markers for docs that render with Content/Example tabs |

## Programs — `programs/`

Workspaces for multi-ticket programs: the planning artifacts a program needs while it runs —
design, decision records, ticket backlog, execution log, and conformance reviews measuring the
code against the program's own brief. **These are the one place in `docs/` where ticket numbers
are load-bearing** — a backlog row or an execution-log entry names the ticket it tracks.
Everything else in `docs/` describes the code as it stands and cites no tickets.

| Program | Contents |
|---|---|
| [programs/agentic-workflow-platform/](./programs/agentic-workflow-platform/) | [product-brief.md](./programs/agentic-workflow-platform/product-brief.md) (owner-provided, authoritative), [design.md](./programs/agentic-workflow-platform/design.md), [backlog.md](./programs/agentic-workflow-platform/backlog.md), [execution-log.md](./programs/agentic-workflow-platform/execution-log.md), plus supporting decision/analysis docs (`owner-decisions-2026-08-17.md`, `async-contract.md`, `review-2026-08-16.md`, `tenant-authoring-boundary.md`, `smr-task-key-findings.md`) and `conformance/` (gateway-and-sdk, python-services, admin-console) |

A program workspace is deliberately NOT in [`architecture/`](./architecture/): architecture
documents are code-verified descriptions of what exists, while these record what is planned,
decided and in flight.

## Implementation Tickets — `implementation/`

Active, ticket-based implementation documentation. One folder per ticket:
`[TICKET]-[Short-Name]/README.md`, updated throughout the ticket lifecycle (single main document
per ticket — no per-fix files).

- **Numbering**: `TASK-XXX`. To assign a new number, take the highest existing ticket across
  `implementation/` and `archive/` and increment by 1 — the folders themselves are the source of
  truth for the current maximum.
- **Required sections**: header (ticket, dates, status), requirement analysis, current-state
  evaluation, implementation plan (user-approved before coding), implementation summary, change
  history.
- **Status values**: `Pending | In Progress | Completed | Blocked | Review`.
- Completed/historical tickets are periodically moved to `archive/`.

## Backlog — `backlog/`

Deliberately parked work items with context and pickup instructions:

| Document | Contents |
|---|---|
| [2026-07-02-RESIDUALS.md](./backlog/2026-07-02-RESIDUALS.md) | Audit-payload field redaction sweep; MS-Graph live email credentials |
| [2026-07-04-FEDL-MLFLOW-LEGACY.md](./backlog/2026-07-04-FEDL-MLFLOW-LEGACY.md) | Parked legacy federated-learning schema models + MinIO `mlflow` bucket (removal deferred — data-destructive) |
| [2026-07-21-TODO-HARVEST.md](./backlog/2026-07-21-TODO-HARVEST.md) | Live register of every inline code marker found during the code-comment cleanup sweep, each with a disposition |

## Operations — `operations/`

Day-2 operator runbooks and reference material — a large directory; the table below is not
exhaustive. Notable documents:

| Document | Contents |
|---|---|
| [operations/inference/README.md](./operations/inference/README.md) | Production inference engines runbook; companion `model-retention.md` covers idle-TTL eviction and runtime retention changes without a redeploy |
| [operations/retrieval-corpus-ingestion/README.md](./operations/retrieval-corpus-ingestion/README.md) | Ingesting a licensed guideline corpus into the harness institutional-RAG store (owner-run — not CI) |
| [operations/tts-model-mirror/README.md](./operations/tts-model-mirror/README.md) | Mirroring the gated `ai4bharat/indic-parler-tts` weights into an internal ungated store |
| [operations/temporal/README.md](./operations/temporal/README.md) | Temporal DR/backup operator runbook |
| [operations/vault/README.md](./operations/vault/README.md) | HOPE Vault operator runbook: rotation, failover, recovery, monitoring |
| [operations/versioning.md](./operations/versioning.md) | Release tag grammar and build-metadata contract |
| [operations/deprecation-register.md](./operations/deprecation-register.md) | Live register of deprecated surfaces and their removal window |
| [operations/api-documentation.md](./operations/api-documentation.md) | The API gateway's documentation pipeline (tags, OpenAPI, portal) |

Other subdirectories present: `consultation/`, `deployment/`, `observability/`, `proxmox-mcp/`,
`release-notes/`, `storage/`, `testing/`, `vox-sdk-release/`, plus standalone runbooks
(`day-one-deployment.md`, `jwt-secret-rotation.md`, `rate-limiting.md`, `release-runbook.md`,
`telemetry-phi-guardrails.md`, `build-info.schema.json`).

## Research — `research/`

Technical research, homelab infrastructure guides, and architecture prior art. See
[research/README.md](./research/README.md) for the full index.

| Subfolder | Contents |
|---|---|
| [research/infrastructure/](./research/infrastructure/) | Proxmox host setup, GPU passthrough, network topology, shared storage |
| [research/deployments/](./research/deployments/) | Per-VM/CT deployment guides (k3s, MinIO, GitLab, Postgres HA, Vault, Redis), DR and encryption-at-rest runbooks |
| [research/networking/](./research/networking/) | SSH/Cloudflare Tunnel access, database connectivity |
| [research/ai-ml/](./research/ai-ml/) | Inference-serving research (MLflow/vLLM/MinIO on-prem, s3fs model store, ASR SOTA) |
| [research/architecture/](./research/architecture/) | Streaming-timeout audit, encounter-workflow fit-gap analysis, system-config/multi-tenancy design notes (prior art — where it conflicts with `docs/architecture/`, the latter wins) |
| [research/clinical-harness/](./research/clinical-harness/) | Medical-AI research backing the clinical documentation harness |
| [research/configs/](./research/configs/) | Ready-to-deploy config files (GitLab, MinIO, Postgres HA, Redis, Langfuse) |

## Archive — `archive/`

Historical ticket documentation. Kept as an immutable record of past decisions. **Off-limits this
sprint** — do not read from or write to `archive/`, and never link into it from other docs;
references inside archived documents may describe removed components and are intentionally left
as-is.

## Related

- [`../README.md`](../README.md) — monorepo quick start and command reference
- `apps/*/README.md`, `packages/*/README.md` — per-app / per-package documentation
- [`../infrastructure/README.md`](../infrastructure/README.md) — local Docker infrastructure guide
- [`../infrastructure/SECURITY_DEPLOYMENT_GUIDE.md`](../infrastructure/SECURITY_DEPLOYMENT_GUIDE.md) — production security posture

Cluster deployment manifests (k3s + Argo CD) are not in this repository — they live in the
separate `arca/hope-v2-deployment` repository.
