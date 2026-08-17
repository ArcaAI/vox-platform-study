# Traceability — Summarization, LLM Generation & Prompt/DNA Management

Turning a consultation's clinical context into documentation: multi-tier summarization
(pre / final / comprehensive), the raw Text text-generation proxy, guardrail interception on
the generation path, and the two configuration surfaces that shape generation — the prompt
("agents") library with clinical approval governance, and the per-doctor DNA writing style.
Migrates legacy matrix rows **14**, **15**, **24**, **25**, and **34b**.

Route paths are relative to the global prefix `/api/v1`. Test shorthand is defined in
[`index.md`](./index.md#test-location-shorthand). `—` means verified-absent.

The summary routes mount on the shared `ConsultationController` (see
[`consultation.md`](./consultation.md)); the harness gating/approval step layered over
summarization is in [`harness.md`](./harness.md).

## Capabilities

### G1 — Summarization (pre / final / comprehensive) — legacy row 14

| Field | Value |
|---|---|
| App / service | `apps/api` + `apps/text` (port 8862) + BullMQ (`Generate*` queues) |
| Key modules | `apps/api/src/modules/consultation` (summary routes on `consultation.controller.ts`); `packages/applications/src/services/consultation/summary` (`summary.service.ts`, `chain-summary.service.ts`, `text-generate.ts`, `content-diff.util.ts`, `summary.dto.mapper.ts`); `packages/applications/src/services/consultation/prompt` (`prompt-resolution.service.ts`, `prompt-assembly.service.ts`) |
| Prisma models | `SummaryMeta`, `ContextItem` (`PRE_SUMMARY` / `RAW_SUMMARY` / `MODIFIED_SUMMARY` subtypes) — both `db_main/consultation.prisma` |
| Key API endpoints | `POST /consultations/:id/summary[/async]`, `POST /consultations/:id/summary/pre-summary[/async]`, `POST /consultations/:id/summary/comprehensive[/async]`, `GET /consultations/:id/summary`, `GET /consultations/:id/summary/latest`, `GET /consultations/:id/summary/pre-summary/latest`, `PATCH /consultations/:id/summary/:summaryId`, `GET /consultations/:id/summary/:contextItemId/{versions,provenance,diff}`, `GET/POST /consultations/:id/summary/:contextItemId/tags`, `DELETE /consultations/:id/summary/:contextItemId/tags/:tagId`, `POST /consultations/:id/summary/:contextItemId/extract-entities` (Text/NLP-driven entity enrichment) |
| Tests | unit(app): `consultation/summary/__tests__/*` (`summary.service`, `chain-summary.service`, `text-generate`, `content-diff.util`, `summary.service.provenance.task330`, `summary.service.edit-capture`, `summary.service.json-repair`, `summary.service.prompt-tier.task331`, `summary.service.preferred-prompt.task329`, `summary.service.trajectory`, `summary-meta.task329`); contract: `text.contract.test.ts`; py(text) |

### G2 — Text-generation proxy (raw LLM surface) — legacy row 15

| Field | Value |
|---|---|
| App / service | `apps/api` + `apps/text` |
| Key modules | `apps/api/src/modules/streaming` (`text-proxy.controller.ts`); `packages/applications/src/services/text/streaming` (`text-stream-consumer.service.ts` — Redis-Streams SSE resume) |
| Prisma models | — (proxy; Text streams over Redis, resumes by message id) |
| Key API endpoints | `@Controller('text')`: `POST /text/generate`, `POST /text/generate/assembled`, `GET /text/tasks/:taskId`, `POST /text/tasks/:taskId/cancel`, `GET /text/tasks/:taskId/stream` (SSE), `GET /text/providers`, `GET /text/guardrail-providers`. Text service side: `POST /api/v1/generate`, `GET /api/v1/tasks/*`, `GET /api/v1/providers`, SSE `/api/v1/stream` |
| Console | consumed by the playground LLM surface |
| Tests | unit(app): `text/streaming/__tests__/text-stream-consumer.service.test.ts`; e2e: `services-proxy.spec.ts`; py(text): `unit/*` |

### G3 — Guardrail interception on the generation path

Guardrail is applied **inside** Text generation, not as a gateway hop: every prompt is
validated before an LLM call, and the gate fails closed (a wired-but-unreachable guardrail
blocks the generation rather than shipping an unmoderated PHI prompt).

| Field | Value |
|---|---|
| App / service | `apps/text` → `apps/guardrail` (port 8863), URL from settings |
| Key modules | `apps/text/src/text/services/external_guardrail.py` (`ExternalGuardrailClient`); `apps/text/src/text/api/endpoints/generate.py` (validate-before-generate; guardrail outage → retryable 503, genuine content violation → block); `apps/guardrail/src/guardrail/api/endpoints` (`guardrails.py`, `medical.py`, `groundedness.py`, `jobs.py`) |
| Prisma models | — (guardrail is stateless; tenant config resolved per request) |
| Key API endpoints | Guardrail `POST /api/v1/guardrail/analyze[/batch|/async]`, `GET /api/v1/guardrail/types`, `POST /api/v1/medical/validate[/batch]`; surfaced to the gateway via `GET /text/guardrail-providers` (G2). This is the capability-service view of legacy row 18 as it composes with summarization |
| Tests | py(text): `unit/test_external_guardrail_client.py`, `unit/test_generate_guardrail_wiring.py`, `unit/test_provider_guardrails.py`, `unit/test_guardrails.py`; py(grd) |

### G4 — Prompt management ("agents" / instruction library) — legacy row 24

| Field | Value |
|---|---|
| App / service | `apps/api` |
| Key modules | `apps/api/src/modules/prompt-management` (`prompt-management.controller.ts` admin, `prompt-template.controller.ts` user self-service); `packages/applications/src/services/prompt-management` (`prompt-management.service.ts`, `prompt-management.dto.mapper.ts`) |
| Prisma models | `PromptTemplate`, `PromptVersion` (`db_main/prompt-template.prisma`); `PromptUsageRecord` (`db_main/dna-writing-style.prisma`) |
| Key API endpoints | `@Controller('prompt-templates')` (self-service): `GET /prompt-templates/available`, `PUT /prompt-templates/preferred`, `POST ''`, `PATCH :id`, `DELETE :id`. `@Controller('admin/prompt-templates')`: `POST ''`, `GET ''`, `GET /analytics/usage`, `GET /usage-records`, `GET /:id`, `PATCH :id` (OCC), `DELETE /:id`, `GET :id/versions`, `GET :id/versions/:versionNumber`, `GET :id/versions/:from/diff/:to`, `GET :id/usage`, `POST :id/test`, `POST :id/versions/:versionNumber/activate`, `POST assign-department`. **AUTH-NOTE:** self-service writes on personal (`USER_PERSONAL`) templates are declared `@Authorize(['read','PromptTemplate'])` with ownership enforced in the service (rule 05) |
| Console | `apps/admin-console` feature `agents` (`agents-screen`, `versions-panel`); route `/agents` (tier 30–49, tenant-scoped; `/prompt-studio` redirects to `/agents?tab=governance` for one release) |
| Tests | unit(app): `prompt-management/__tests__/{prompt-management.service,prompt-management.dto.mapper,update-prompt-template.request}.test.ts`; unit(console): `agents/components/__tests__/agents-screen.test.tsx`, `agents/api/__tests__/agents-api.test.ts`; e2e: `agent-management-contract.spec.ts`, `agents-backend-backlog.spec.ts` |

### G5 — Prompt governance (approval, versions, diff) — legacy row 34b

| Field | Value |
|---|---|
| App / service | `apps/api` + `apps/admin-console` |
| Key modules | `apps/api/src/modules/prompt-management` (`:id/approve` on `prompt-management.controller.ts`) |
| Prisma models | `PromptTemplate` (`status = APPROVED`), `PromptVersion` (pinned snapshot) |
| Key API endpoints | `POST /admin/prompt-templates/:id/approve` — flips to `APPROVED` (the gate `prompt-resolution` requires for clinical flows), pins a `PromptVersion`, writes a WORM change row. `@RequiresIfMatch()` (missing → 428, drift → 412). **AUTH-NOTE:** SUPER_ADMIN-only — the class decorator understates it; the real 403 is raised imperatively in the service (`isSuperAdmin`), not the 404-over-403 cross-tenant posture (a cross-tenant id is still 404 via `assertOwnedByTenant`). See rule 05 |
| Console | `apps/admin-console` feature `agents` Governance tab (`governance-tab`), route `/agents?tab=governance` (folded in from the retired `/prompt-studio`) |
| Tests | unit(app): prompt-management approval path in `prompt-management.service.test.ts`; unit(console): `agents/components/__tests__/agents-screen.test.tsx` (Governance specs) |

### G6 — DNA writing style — legacy row 25

Per-doctor stylistic fingerprint applied to generated documentation.

| Field | Value |
|---|---|
| App / service | `apps/api` (+ Text generation, BullMQ regeneration) |
| Key modules | `apps/api/src/modules/dna-writing-style` (`dna-writing-style.controller.ts` self-service, `dna-writing-style-admin.controller.ts` admin, `dna-writing-style-job-stream.ts`); `packages/applications/src/services/dna-writing-style` (`dna-writing-style.service.ts`, `dna-writing-style.processor.ts`, `dna-regeneration.scheduler.ts`, `dna-writing-style.dto.mapper.ts`) |
| Prisma models | `DnaWritingStyleReport`, `DnaWritingStyleVersion`, `DnaUsageRecord` (`db_main/dna-writing-style.prisma`) — report content envelope-encrypted |
| Key API endpoints | `@Controller('dna-writing-styles')`: `POST /generate`, `GET /my-style`, `GET/PUT /settings`, `GET /mine`, `GET /doctor/:doctorId`, `PATCH :reportId`, `PATCH :reportId/default`, `GET :reportId/versions`, `GET /jobs/:jobId`, SSE `GET /jobs/:jobId/stream`. `@Controller('admin/dna-writing-styles')`: `GET /dashboard`, `GET ''`, `GET /doctor/:doctorId`, `PATCH :reportId`, `POST /generate/:doctorId`, `GET :reportId/versions`, `GET /jobs/:jobId`, SSE `GET /jobs/:jobId/stream` |
| Console | `apps/admin-console` feature `dna-writing-styles` (`dna-writing-styles-screen`); route `/dna-writing-styles` (tier 30–49, tenant-scoped) |
| Tests | unit(app): `dna-writing-style/__tests__/*` (`dna-writing-style.service`, `dna-writing-style.processor`, `dna-writing-style.dto.mapper`, `dna-writing-style.encryption`, `dna-writing-style.service.dashboard`, `dna-writing-style.service.task329p5`, `dna-regeneration.scheduler`); unit(console): `dna-writing-styles/components/__tests__/dna-writing-styles-screen.test.tsx`, `dna-writing-styles/api/__tests__/{dna-api.test.ts,use-dna-job-progress.test.tsx}` |

## Honest notes / gaps

- **No DNA e2e.** G6 is covered across unit(app)/unit(console) only; there is no `apps/api/tests/e2e` spec exercising the DNA generate → version → apply round-trip (legacy row 25's e2e cell was already `—`).
- **Guardrail is a capability service shared with the medical-NLP domain (legacy row 18).** G3 records it only as it intercepts summarization; the standalone guardrail service surface (jobs, groundedness, medical-config) stays with the capability-services domain in the legacy matrix until that domain migrates.
- **The summary approval step is documented in [`harness.md`](./harness.md), not here.** `POST /consultations/:id/summary/:contextItemId/approve` is the harness gate's attestation write, not a summarization primitive.
- **`text.contract.test.ts` / `stt.contract.test.ts` are present** under `tests/contracts/` — note the legacy matrix's claim that the TTS contract was removed in TASK-414 does not extend to the Text/STT contracts, which remain.

Last verified: 2026-07-22
