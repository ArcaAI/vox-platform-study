# HOPE System Architecture

| | |
|---|---|
| **Owner** | Platform / Architecture |
| **Status** | Current-state, code-verified |
| **Last verified** | 2026-10-25 |
| **Scope** | Whole monorepo: gateway, six FastAPI AI services, vLLM shell, admin console, shared packages, infrastructure and configuration planes |

This is the entry point to the HOPE architecture set. It describes what runs, how the pieces
communicate, which rules the code enforces, and where the authoritative detail lives. Companion
documents: [component-reference.md](./component-reference.md),
[data-flow-and-domain-model.md](./data-flow-and-domain-model.md),
[environment-and-configuration.md](./environment-and-configuration.md),
[deployment-and-operations.md](./deployment-and-operations.md), and
[opd-summarization-walkthrough.md](./opd-summarization-walkthrough.md).

> **Verification convention.** Every non-obvious statement below is backed by a path. Line numbers
> are from the working tree on 2026-10-25. Product names follow the code: the summarization service
> is **`apps/text`** (the old `smr` name survives only in historical docs and some wire identifiers).

---

## 1. What HOPE is

HOPE is a multi-tenant clinical AI platform. A host EMR/clinic application embeds the `@arcaai/vox`
browser SDK, opens a consultation, streams consultation audio, and receives a live running note and
a final, sensor-scored, clinician-approved clinical document.

The platform has four planes:

| Plane | What it does | Where it lives |
|---|---|---|
| **Experience** | Browser capture/transport, live note UI, operator console | `packages/agentic-sdk-v2` (published `@arcaai/vox`), `packages/room`, `packages/stt`, `apps/admin-console` |
| **System of record** | Auth, tenancy, consent, lifecycle, persistence, all client-facing REST/WS/SSE | `apps/api` (NestJS) |
| **AI execution** | ASR, LLM text generation, medical NLP, guardrails, TTS, durable workflow interpretation | `apps/stt`, `apps/text`, `apps/nlp`, `apps/guardrail`, `apps/tts`, `apps/harness`, `apps/vllm` (FastAPI) |
| **Control plane** | Which model/provider/agent/prompt/workflow a tenant gets; policy, flags, quotas | PostgreSQL + Vault + Redis, fronted by `packages/applications` services |

The gateway is the only client entry point. Python services are internal: they are reached by the
gateway or by the harness, never directly by a browser.

### Actors

| Actor | Entry point | Notes |
|---|---|---|
| Clinician | Host app + `@arcaai/vox`; REST/WS/SSE to `/api/v1` and `/ws/*` | Opens, records, reviews and approves a consultation |
| Tenant admin | `apps/admin-console` BFF → `/api/v1/admin/*` | Tenant-scoped configuration |
| Platform super admin | `apps/admin-console` → `/api/v1/admin/*` | Cross-tenant/platform configuration |
| Host application / integrator | API key or OIDC/JWT; server SDK `@arcaai/vox-node` | Machine callers must name the clinician they act for |
| Patient | Referenced only by external `patientId` | **No patient record is stored in HOPE** |

### System context

![System context](./images/01-system-context.svg)

Source: [`diagrams/01-system-context.mmd`](./diagrams/01-system-context.mmd).

---

## 2. Runtime topology

### 2.1 Deployable processes

| Process | Tech | Port (dev) | Responsibility | Entry point |
|---|---|---|---|---|
| `apps/api` | NestJS 11, Node 22 | **8868** | System of record; REST `/api/v1`, WS `/ws/stt/stream`, `/ws/tts/stream`, `/ws/workflows`, SSE; BullMQ workers; live-documentation owner | `apps/api/src/main.ts` |
| `apps/stt` | FastAPI + Dramatiq | **8861** | Streaming and batch ASR, VAD, diarization, speaker embeddings | `apps/stt/src/stt/main.py` |
| `apps/text` | FastAPI | **8862** | Multi-provider LLM generation/summarization, SSE streaming, judge lane | `apps/text/src/text/main.py` |
| `apps/guardrail` | FastAPI | **8863** | Safety, PII, prompt-injection and medical-validation policy | `apps/guardrail/src/guardrail/main.py` |
| `apps/nlp` | FastAPI | **8864** | Medical NER, classification, correction, diagnosis suggestions | `apps/nlp/src/nlp/main.py` |
| `apps/tts` | FastAPI | **8865** | Multi-provider speech synthesis (self-hosted + cloud) | `apps/tts/src/tts/main.py` |
| `apps/harness` | FastAPI + Temporal | **8866** | HTTP surface + Temporal workflows/activities for note generation and the workflow interpreter | `apps/harness/src/harness/main.py` |
| `apps/vllm` | FastAPI + vLLM | **8867** | OpenAI-compatible pooled inference shell (Whisper ASR today), reached only via `apps/stt` | `apps/vllm/src/hope_vllm/main.py` |
| `apps/admin-console` | Next.js 16 / React 19 | **5176** dev, **3000** prod | Operator UI and BFF (`/api/hope/*` proxy) | `apps/admin-console` |

Two long-running **workers** have no port:

| Worker | Command | Purpose |
|---|---|---|
| Harness Temporal worker | `pnpm worker:dev` | Executes `harness-task-queue` workflows/activities (`apps/harness/src/harness/temporal/worker.py`) |
| STT batch worker | `pnpm stt:worker:dev` | Consumes Dramatiq `stt_batch` jobs; without it batch jobs stay `QUEUED` (`apps/stt/src/stt/worker.py`) |

The gateway also runs in-process BullMQ consumers (audit, sys-events, pre-summary, knowledge ingestion,
DNA analysis, model download, checkpoint export/restore). See
[deployment-and-operations.md](./deployment-and-operations.md) §3.

### 2.2 Backing services

| Service | Dev port | Used for |
|---|---|---|
| PostgreSQL 18 (TimescaleDB image, pgvector) | 5432 | Prisma system of record; Temporal databases |
| Redis 8 | 6379 | BullMQ, cache/rate limit, STT streams, text streams, Dramatiq |
| MinIO | 9000 (API), 9001 (console) | Recordings, generated audio, documents, claim-check, models, backups |
| Qdrant | 6333/6334 | Knowledge chunks and prompt/DNA collections |
| Vault | 8200 | KV v2 secrets, Transit encryption, dynamic Postgres credentials |
| Temporal | 7233 gRPC, 8233 UI | Durable workflow execution |
| Reranker (TEI) | 8870 | Hybrid-RAG reranking |
| vLLM / llama.cpp / TEI embeddings | 8000 / 8080 / 8871 | Self-hosted inference profile |
| Prometheus / Grafana | 9090 / 3001 | Dev observability |
| MLflow | 5000 | Experiment tracking (optional profile) |

Compose definitions: `infrastructure/docker/docker-compose.yml` (core) and
`infrastructure/docker/docker-compose.dev.yml` (profile-gated extensions). The authoritative local
operator guide is `infrastructure/README.md`.

### 2.3 Container view

![Container topology](./images/02-container-topology.svg)

---

## 3. Monorepo layering

HOPE is a pnpm + Turborepo workspace (Node >= 22.12, pnpm 10, TypeScript 5.9) plus a uv/conda
Python workspace (`arcaenv`, Python 3.11).

```
apps/api ──────────────┐
apps/admin-console     │  consume
                       ▼
              packages/applications   (application services, DTOs, orchestration)
                       ▼
              packages/domains        (entities, repositories, domain rules)
                       ▼
              packages/database       (Prisma schema/client, tenancy + soft-delete extensions)
```

The dependency direction is enforced by ESLint rules in `packages/config-eslint` and
`packages/eslint-plugin-arcaai-internal`; in `apps/api` violations are hard errors, in `packages/*`
they are warnings that CI still gates. Controllers and application services must not import
Prisma or touch the client directly — they go through a domain repository.

Other shared packages:

| Package | Purpose |
|---|---|
| `@arcaai/vox` (`packages/agentic-sdk-v2`) | Browser React consultation SDK |
| `@arcaai/vox-node` | Zero-dependency server SDK |
| `@arcaai/room`, `@arcaai/stt`, `@arcaai/pipeline` | Browser capture/transport primitives |
| `@arcaai/workflow-contract` + `py-workflow-contract` | The compiled workflow format, validation and compilation |
| `@arcaai/async-contract` + `py-async-contract` | TS/Python async envelope parity |
| `@arcaai/types`, `@arcaai/utils`, `@arcaai/exceptions`, `@arcaai/json-schema-subset` | Shared contracts |
| `@arcaai/py-env`, `@arcaai/py-otel`, `@arcaai/py-obs`, `@arcaai/py-runtime-models` | Python runtime helpers |
| `@arcaai/ui`, `@arcaai/tools`, config packages | UI, code generators, build/lint config |

![Monorepo layering](./images/03-monorepo-layering.svg)

---

## 4. The gateway request pipeline

Every client request crosses the same ordered pipeline:

1. **Bootstrap and CORS** — `apps/api/src/main.ts`.
2. **Global prefix** — `app.setGlobalPrefix(globalPrefix, API_GLOBAL_PREFIX_OPTIONS)` at
   `apps/api/src/main.ts:158`; the public contract is `/api/v1`, Swagger at `/api/v1/docs`.
3. **Security middleware** — helmet, compression, cookie parsing, raw-body handling.
4. **Auth guard** — `UnifiedAuthGuard` accepts JWT, API key, or service account and publishes the
   principal into CLS. Machine callers get their own CLS key so a machine action is never recorded
   as a person (`consultation.controller.ts` `getServiceAccountId`).
5. **Tenant context + tenant-scope interceptor** — `tenantId` comes from the session, never from
   the request body.
6. **Resource interceptor** — resolves the target row and enforces ownership; cross-tenant access
   answers **404**, never 403.
7. **Validation pipe** — DTO/schema validation; unknown or invalid fields produce a coded 400.
8. **Authorization** — `@Authorize([action, Subject])`, `@RequiredScopes`, `@RequiredSvcScopes`,
   `@RequiresConsent`.
9. **Controller → application service → domain repository**.
10. **Response mapping** — response DTOs, not entities.
11. **Events** — every mutation emits a `SysEventType` event for fan-out/audit.

![API request pipeline](./images/04-api-request-pipeline.svg)

### Versioning and concurrency

- `_version` is database-owned; mappers never write it.
- Versioned PATCH routes use `If-Match` / `@RequiresIfMatch()`: missing header → **428**, version
  drift → **412**.
- The consultation approve/close/reopen routes are versioned this way
  (`apps/api/src/modules/consultation/consultation.controller.ts:1057` onward).
- Approval snapshots are immutable; a later edit creates a new version rather than mutating the
  approved one.

---

## 5. Two orchestration substrates (the most important architectural split)

A consultation's note can be produced by one of two engines. They share the same activities and
persistence, but they must never both run for the same consultation.

| | **Substrate A — default loop** | **Substrate B — tenant workflow** |
|---|---|---|
| Trigger | Lazily, on the first `ContextAdded` signal after a transcription appears | At `POST /consultations/open` |
| Engine | `HarnessDocWorkflow` (+ `ConsultationLoopWorkflow`) | `WorkflowInterpreter` running a compiled `core` graph |
| Code | `apps/harness/src/harness/temporal/workflows.py` (`HarnessDocWorkflow` at line 337) | `apps/harness/src/harness/temporal/interpreter/workflow.py` (class at line 633, `run` at 732) |
| Dispatch | `LoopContextSignalService.handleContextAdded` | `ConsultationWorkflowDispatchService.dispatchForConsultation` (line 174) |
| When | No `WorkflowAssignment` resolves for the tenant/department | An assignment resolves to a published consultation-palette graph |
| Exclusivity | Governed consultations suppress it (`tenantWorkflowGoverns` in `note-generation.service.ts`) | At open, the gateway stamps `metadata.governingEngine = "tenant-workflow"` |
| Persistence | `persist_draft` activity → `POST internal/harness/draft` | The graph's finalize/persist node calls the **same** activity |

Evidence:

- `packages/applications/src/services/consultation/governing-engine.ts` documents both substrates
  and the durable marker (line 113, `tenantWorkflowGoverns`).
- `consultation.service.ts:1549` (`dispatchOnCreate`) is the **only** place
  `WorkflowRun.trigger = 'consultation open'` is written; dispatch is best-effort so a harness
  outage never blocks opening a consultation.
- `consultation-workflow-dispatch.service.ts:174` returns `{dispatched:false}` when no assignment
  resolves, when the definition is unpublished, when it has no compiled config, or when claim-check
  storage is missing.
- `note-generation.service.ts` shows the legacy auto-summary standing down when the marker is
  present.

The seeded tenants take **Substrate B** by default: phase 28 writes a `TENANT`-scope `core`
assignment to `general-medicine-consultation` for both the default seed tenant and SYSTEM
(`packages/database/src/prisma/db_main/seed/28-workflow-library.ts:505-516`). A fresh tenant with no
assignment takes Substrate A.

### Live transcription sequence

![Live transcription sequence](./images/05-live-transcription-sequence.svg)

### Realtime vs durable lanes inside a graph

A compiled `core` graph marks nodes with `execution.lane` and `cadence`:

- **`realtime`** nodes belong to the **live executor** — `LiveDocumentationService` in `apps/api`,
  driven by `flush()` at
  `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts:3546`.
  The durable interpreter **skips** them when the run has a live owner
  (`interpreter/workflow.py:1404-1429`).
- **durable** nodes run in Temporal. When a durable node binds an output from a realtime node, the
  interpreter performs a live handoff and waits for the live lane to settle
  (`_await_live_outputs`, ~line 1239).
- `cadence: perTurn` means the live lane may run the node after each transcript turn;
  `cadence: once`/`onEnd` runs once per consultation. `onStart` runs at session open (warm start).

This split is why a consultation can show a running note while the durable workflow is still
waiting at a human-review gate.

---

## 6. Data, tenancy and security posture

### Tenancy

- Every business row carries `tenantId`.
- The extended Prisma client applies tenant scope and soft-delete filtering
  (`packages/database/src/client.ts:326`, `:387-388`).
- New tenant-scoped models must be added to `TENANT_SCOPED_MODELS` and to the fixture inventory;
  models intentionally without soft delete must be listed in `MODELS_WITHOUT_SOFT_DELETE`.
- Cross-tenant reads/writes answer **404**. Deliberate privilege walls (e.g. super-admin-only
  settings) answer **403** and are enforced imperatively.

### Soft delete

No hard deletes: repositories expose `softDelete()`/`restore()`. The extended client filters
deleted rows by default.

### Secrets and PHI

- Secrets live in **Vault**, never in env files or plaintext DB columns. Tenant BYO secrets are
  Vault-Transit ciphertext in DB columns (`secret-field.util.ts`).
- PHI fields are encrypted with the platform Transit key before persistence.
- Request/response logs are structured and redacted; tokens are never logged.
- CI and production read **host environment only** — no env file is loaded
  (`packages/applications/src/common/env/env-file-resolution.ts:22-26`; mirrored in
  `packages/py-env/src/hope_env/__init__.py:15-23`).

### Audit and events

- Every mutation broadcasts a `SysEventType` event and writes an audit row where applicable.
- Approval and gate decisions are WORM-style records (`ApprovalSnapshot`, `GateDecision`); the
  harness records `GATE_DECISION` in the run trajectory.
- Workflow/agent/prompt definitions are immutable once published; changes create new versions.

---

## 7. Deployment shape

| Environment | Shape |
|---|---|
| Local development | Host-run Node/Python processes (`pnpm stack:dev`) + Docker Compose for infrastructure |
| Test | A second stack at dev port **+100** (API 8968, STT 8961, …, Postgres 5433, Redis 6380, MinIO 9002) |
| Staging / production | Containers built in CI, promoted **by digest** into the separate `arca/hope-v2-deployment` GitOps repository; Argo CD reconciles k3s |

There are **no Kubernetes manifests in this repository**. `infrastructure/README.md` states this
explicitly. The AGENTS.md reference to a local `deployment/` directory is stale in this checkout.

![Deployment topology](./images/07-deployment-topology.svg)

Details, including CI stages and image promotion, are in
[deployment-and-operations.md](./deployment-and-operations.md).

---

## 8. Architectural invariants (review checklist)

1. **One writer per consultation.** A consultation is governed by exactly one substrate; the
   persisted marker is the decision of record.
2. **Controllers and application services never import Prisma.** Go through a domain repository.
3. **No hard deletes.** Use `softDelete()`; add deliberate exceptions to the allow-list.
4. **Cross-tenant = 404.** Privilege walls are 403 and imperative.
5. **Versioned writes use `If-Match`.** Missing → 428, drift → 412.
6. **Published configuration is immutable.** Workflow, agent and prompt versions are frozen; edits
   create new versions.
7. **Provider/model selection is DB-owned.** Env is connection identity, not a tenant default. The
   one exception is the harness judge pair (`HARNESS_JUDGE_PROVIDER`/`HARNESS_JUDGE_MODEL`).
8. **Realtime and durable lanes never both execute the same node.** Lane ownership is checked
   before dispatch.
9. **Client-facing DTOs only.** No entity leaks across the HTTP boundary.
10. **Every mutation emits an event.** Silent writes are a defect.

---

## 9. Known discrepancies in this checkout

| Observation | Impact |
|---|---|
| The entire `docs/` tree is deleted in the working tree (`git status` shows `D`), except the untracked `docs/architecture/` output. Historical docs referenced by AGENTS.md (`docs/development-guide.md`, `docs/development-patterns-and-standards.md`, `docs/guides/*`) exist only at `git HEAD`. | Read historical docs via `git show HEAD:<path>`; do not assume they are on disk. |
| AGENTS.md says `apps/smr` and `deployment/`. The code has `apps/text` (renamed from `smr`) and **no** `deployment/` directory. | Use `apps/text`; cluster manifests live in the external deployment repo. |
| Historical architecture docs describe the old 12-state consultation lifecycle. The schema now has **7 states** plus a separate `ConsultationProcessing` axis (`enums.prisma:298-331`). | Use `OPEN / RECORDING / PAUSED / STOPPED / APPROVED / CLOSED_COMPLETE / CLOSED_INCOMPLETE` and `processing` (`IDLE / FINALIZING_TRANSCRIPT / SUMMARIZING / PROCESSING_ATTACHMENT / AWAITING_REVIEW / FAILED`). |
| The build pipeline tags the shared Python base image `:latest` (`.gitlab/ci/build.yml:157`), while service images are digest-pinned. | Base-image rollback is by digest, not by `:latest`; do not deploy `:latest`. |
| `apps/example` is mentioned in older docs but is not part of the current application set. | SDK example lives under `packages/agentic-sdk-v2` / tests. |

## Related documents

- [component-reference.md](./component-reference.md) — per-component responsibilities, routes and failure modes.
- [data-flow-and-domain-model.md](./data-flow-and-domain-model.md) — schema, aggregates, writes and lifecycle.
- [environment-and-configuration.md](./environment-and-configuration.md) — env/Vault/DB tiers and per-service keys.
- [deployment-and-operations.md](./deployment-and-operations.md) — local stack, CI/CD, runbooks.
- [opd-summarization-walkthrough.md](./opd-summarization-walkthrough.md) — one OPD consultation, start to signed note.
