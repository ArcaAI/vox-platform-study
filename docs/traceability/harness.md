# Traceability — Clinical Documentation Harness & Agentic Loop

The durable clinical-documentation harness and the agentic-loop surfaces around it: the
Temporal-orchestrated guides→generate→sensors→gate workflow, harness admin & observability,
the realtime pipeline-policy cascade, RAG knowledge ingestion, evaluation golden sets +
edit-burden, the global agentic-policy engine console, and the MCP tool registry. Migrates
legacy matrix rows **19**, **20**, **21**, **22**, **23**, and the agentic-loop console rows
**34c** (golden sets / edit burden) and **34d** (MCP registry). Agent-trajectory
observability (row 34d's trajectory half) is migrated in
[`ai-models-providers.md`](./ai-models-providers.md) (M7) and cross-referenced here.

Route paths are relative to the global prefix `/api/v1`. Test shorthand is defined in
[`index.md`](./index.md#test-location-shorthand). `—` means verified-absent.

Architecture: `apps/harness` runs a FastAPI app (best-effort Temporal connect in `lifespan`;
it must boot even when Temporal is down) plus a **separate** Temporal worker process
(`pnpm worker:dev`, task queue `harness-task-queue`). Workflows are deterministic;
all side effects live in idempotent activities. The gateway drives the harness over internal
service-token routes and streams progress/assurance to the browser over SSE.

## Capabilities

### H1 — Clinical documentation harness (guides → generate → sensors → gate) — legacy row 19

| Field | Value |
|---|---|
| App / service | `apps/harness` (port 8866) + `apps/api` + Temporal |
| Key modules | `apps/harness/src/harness/temporal` (`workflows.py`, `activities.py`, `worker.py`, `client.py`, `models.py`, `claim_check.py`, `prompt_cache.py`), `apps/harness/src/harness/{sensors,guides,guards,eval,tools}`; gateway `apps/api/src/modules/consultation` (`harness-internal.controller.ts`, `harness-service-token.guard.ts`); `packages/applications/src/services/consultation/harness` (`harness-internal.service.ts`, `harness-gateway.service.ts`, `harness-progress.service.ts`, `harness-assurance.service.ts`) |
| Prisma models | `HarnessPolicy`, `HarnessPolicyChange`, `HarnessAuditEvent`, `GateEditExemplar` (`db_main/harness.prisma`); `SummaryMeta` (scores/gate), `ContextItemVersion` (attestation) |
| Key API endpoints | Harness service: `POST /api/v1/internal/consultations/:id/document:start`, `POST /api/v1/internal/workflows/:id/signal/approve`, `POST /api/v1/internal/workflows/:id/signal/edit`. Gateway internal `@Controller('internal/harness')`: `GET /policy`, `GET /mcp-token`, `POST /consultations/:id/entities`, `GET /consultations/:id/entities`, `POST /consultations/:id/{assemble,draft,gate-decision,escalation,assurance,assurance-event,progress}`, `POST /trajectory`. Browser SSE (on `ConsultationController`): `GET /consultations/:id/harness-progress/stream`, `GET /consultations/:id/harness-assurance/stream`, `GET /consultations/:id/trajectory/stream` (TASK-533 agentic loop); approval `POST /consultations/:id/summary/:contextItemId/approve` |
| Tests | unit(app): `consultation/harness/__tests__/*` (`harness-internal.service`, `harness-gateway.service`, `harness-progress.service`, `harness-assurance.service`, `harness-internal.dto`, `harness-internal.mcp-token`); unit(api): `consultation/__tests__/*` (`harness-internal.controller`, `harness-service-token.guard`, `consultation.controller.harness-progress`, `consultation.controller.harness-assurance`, `consultation.controller.trajectory`); e2e: `harness-gate.spec.ts`, `harness-progress-stream-cross-tenant.spec.ts`; py(hrn) incl. `test_replay_compat` |

### H2 — Harness admin & observability — legacy row 20

| Field | Value |
|---|---|
| App / service | `apps/api` + `apps/harness` |
| Key modules | `apps/api/src/modules/harness-admin` (`harness-admin.controller.ts`, `harness-ops.client.ts`); `packages/applications/src/services/{harness-policy,harness-observability,harness-audit}`; `apps/harness/src/harness/api/endpoints/admin.py` |
| Prisma models | `HarnessPolicy`, `HarnessAuditEvent`, `EvalRun`, `EvalScore` (`db_main/harness.prisma`) |
| Key API endpoints | `@Controller('admin/harness')`: `GET/PATCH /policy`, `GET/PATCH /policy/global`, `GET /audit`, `GET /gate-queue`, `GET /gate-edit-exemplars`, `GET /workflows`, `GET /workflows/:id`, `POST /workflows/:id/{cancel,terminate,signal}`, `GET /live/sessions`, `GET /live/sessions/:id`, `GET/PATCH /live/config`. Harness service side (mounted `prefix="/api/v1/internal/harness"`): `GET /workflows`, `GET /workflows/:workflow_id`, `POST /workflows/:workflow_id/{cancel,terminate,signal}` |
| Console | `apps/admin-console` feature `harness-ops` (`harness-workflows-screen`, `harness-observability-screen`); routes `/harness/workflows`, `/harness/observability` (tier 30–49, tenant-scoped). Policy editing surfaces in `harness-policy` (`harness-policy-screen`), route `/harness/policy` |
| Tests | unit(app): `harness-policy/__tests__/*`, `harness-observability/__tests__/*`, `harness-audit/__tests__/*`; unit(console): `harness-ops/components/__tests__/{harness-workflows-screen,harness-observability-screen}.test.tsx`, `harness-ops/api/__tests__/harness-ops-api.test.ts`, `harness-policy/components/__tests__/harness-policy-screen.test.tsx`, `harness-policy/api/__tests__/harness-policy-api.test.ts`; e2e: `super-admin-ops-surfaces.spec.ts` (partial); py(hrn) |

### H3 — Realtime pipeline-policy cascade — legacy row 21

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/pipeline-policy-admin` (`pipeline-policy-admin.controller.ts`); `packages/applications/src/services/pipeline-policy` (`pipeline-policy.service.ts`) |
| Prisma models | `PipelinePolicy`, `PipelinePolicyChange` (`db_main/pipeline-policy.prisma`) |
| Key API endpoints | `@Controller('admin/harness/pipeline-policy')`: `GET ''`, `GET /row`, `PUT /row` (create/CAS under `If-Match`). **AUTH-NOTE:** the `globalOnly` descriptor lock is enforced imperatively (rule 05) |
| Console | `apps/admin-console` feature `pipeline-policy` (`pipeline-policy-screen`); route `/harness/pipeline-policy` (tier 30–49, tenant-scoped) |
| Tests | unit(app): `pipeline-policy/__tests__/{pipeline-policy.service,pipeline-policy.service.encryption}.test.ts`; unit(console): `pipeline-policy/components/__tests__/pipeline-policy-screen.test.tsx`, `pipeline-policy/api/__tests__/pipeline-policy-api.test.ts`; e2e: `backend-residuals.spec.ts` (partial) |

### H4 — Institutional knowledge / RAG ingestion — legacy row 22

| Field | Value |
|---|---|
| App / service | `apps/api` (BullMQ) + `apps/harness` + Qdrant (+ TEI reranker) |
| Key modules | `packages/applications/src/services/knowledge` (`knowledge-document.service.ts`, `ingest-knowledge-document.processor.ts`, `knowledge-ingest.client.ts`); `apps/harness/src/harness/api/endpoints/knowledge.py`; harness `retrieve_context` activity |
| Prisma models | `KnowledgeDocument`, `KnowledgeChunk` (`db_main/knowledge.prisma`) |
| Key API endpoints | Harness service `POST /api/v1/internal/knowledge/ingest` (internal service token: chunk → dense+sparse embed → upsert). **No public gateway REST surface** — ingestion is BullMQ-driven from the applications layer |
| Tests | unit(app): `knowledge/__tests__/*` (`knowledge-document.service`, `knowledge-ingest.client`, `ingest-knowledge-document.processor`, `ingest-knowledge-document.processor.encryption`); e2e: `harness-institutional-rag.spec.ts` |

### H5 — Evaluation golden sets, runs & edit burden — legacy row 23 + 34c

Row 23's legacy "service layer only; no dedicated controller yet" note is now **stale** —
eval runs and golden sets ARE exposed through `harness-admin`.

| Field | Value |
|---|---|
| App / service | `apps/api` (+ `apps/harness` eval harness) |
| Key modules | `apps/api/src/modules/harness-admin` (eval/golden-set routes on `harness-admin.controller.ts`, `GateEditMiningService`); `packages/applications/src/services/eval` (`eval.service.ts`); `packages/applications/src/services/harness-observability` (`edit-burden.ts`); `apps/harness/src/harness/eval` (`draft_eval.py`, `golden/`, `judge/`, `metrics/`, `calibration/`) |
| Prisma models | `GoldenSet`, `GoldenCase`, `EvalRun`, `EvalScore` (`db_main/harness.prisma`) |
| Key API endpoints | `@Controller('admin/harness')`: `GET /eval-runs`, `GET /eval-runs/:id`, `GET /golden-sets`, `GET /golden-sets/:id`, `GET /golden-sets/:id/cases`, `POST /golden-sets`, `POST /golden-sets/:id/cases`, `GET /edit-burden`. Golden-case reads surface PHI-SAFE METADATA ONLY (TASK-532 M-09) |
| Console | `apps/admin-console` feature `harness-ops` (`GoldenSetsPanel`, `EditBurdenCard`), under routes `/harness/workflows` / `/harness/observability` (tier 30–49) |
| Tests | unit(app): `eval/__tests__/{eval.service,eval.service.encryption}.test.ts`, `harness-observability/__tests__/edit-burden.test.ts`; unit(console): `harness-ops/components/__tests__/{golden-sets-panel,edit-burden-card}.test.tsx` (PHI-leak + axe specs); py(hrn) eval suite |

### H6 — Agentic-policy engine console (global default + kill-switch)

The single authoritative editor for the SYSTEM-tenant GLOBAL-DEFAULT harness policy and the
engine kill-switch (rule 13: `/agentic-policy` owns `harness/policy/global` +
`harness/live/config`; `/harness/policy` links to it).

| Field | Value |
|---|---|
| App / service | `apps/api` + `apps/admin-console` |
| Key modules | `apps/api/src/modules/harness-admin` (`policy/global` + `live/config` on `harness-admin.controller.ts`); `packages/applications/src/services/{harness-policy,agentic-instructions}` |
| Prisma models | `HarnessPolicy` (SYSTEM-tenant global-default row), `HarnessPolicyChange` |
| Key API endpoints | `GET/PATCH /admin/harness/policy/global` (`@RequiresIfMatch()` even on first edit — 428/412), `GET/PATCH /admin/harness/live/config` (engine kill-switch; NOT versioned). **AUTH-NOTE:** SUPER_ADMIN-only via `SUPER_ADMIN_ONLY_POLICY_KEYS` enforced imperatively (rule 05) |
| Console | `apps/admin-console` feature `agentic-policy` (`agentic-policy-screen`, `agentic-context-tab`); route `/agentic-policy` (tier 10–19, global) |
| Tests | unit(app): `harness-policy/__tests__/*`, `agentic-instructions/__tests__/agentic-instructions.service.test.ts`; unit(console): `agentic-policy/components/__tests__/{agentic-policy-screen,agentic-context-tab}.test.tsx`; e2e: `agentic-policy.spec.ts` |

### H7 — MCP tool registry (agentic-loop tools) — legacy row 34d (MCP half)

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/mcp-admin` (`mcp-admin.controller.ts`); `packages/applications/src/services/mcp-server` (`mcp-server-admin.service.ts`) |
| Prisma models | `McpServer` (`db_main/mcp-server.prisma`) — dedicated `McpServer` (read/manage) RBAC subject added in TASK-532 M-12 |
| Key API endpoints | `@Controller('admin/mcp-servers')`: `GET ''`, `GET :id`, `POST ''`, `PATCH :id`, `DELETE :id`. **AUTH-NOTE:** MCP writes stay SUPER_ADMIN-only in the service (rule 05) |
| Console | `apps/admin-console` feature `tools-mcp` (`tools-mcp-screen`); route `/tools-mcp` (tier 10–19, global) |
| Tests | unit(app): `mcp-server/__tests__/mcp-server-admin.service.test.ts`, `harness-policy/__tests__/harness-policy.mcp.test.ts`; unit(api): decorator-subject specs in `mcp-admin`; unit(console): `tools-mcp/components/__tests__/tools-mcp-screen.test.tsx` |

## Honest notes / gaps

- **Row 23 was stale.** Eval runs + golden sets now have a controller surface (`harness-admin`); the legacy "no dedicated controller yet" note is corrected in H5. Golden-case reads are PHI-safe-metadata-only.
- **RAG has no public REST surface (H4).** Ingestion is internal service-token + BullMQ only; there is no browser-facing knowledge API. `harness-institutional-rag.spec.ts` is the only e2e.
- **Agent-trajectory observability is NOT duplicated here.** The `AgentTrajectoryStep` model, `admin/agent-trajectory/*` routes, and AI-operations console screens are migrated in [`ai-models-providers.md`](./ai-models-providers.md) (M7); this file records only the MCP half of legacy row 34d.
- **Harness e2e is partial.** H2/H3 lean on `task-403`/`task-406` (marked partial in the legacy matrix) plus unit + py(hrn) coverage; there is no full workflow-ops e2e beyond the gate + progress specs. Harness CI (`test-harness`) is hermetic (Temporal/LLM/reranker stubbed) — it is not evidence of live-infra behavior.
- **The admin router mounts under `/api/v1/internal/harness`, not `/api/v1/admin/harness`.** The gateway `admin/harness/workflows*` routes proxy to the harness service's `internal/harness/workflows*` — the browser-facing path is the gateway one.

Last verified: 2026-07-22
