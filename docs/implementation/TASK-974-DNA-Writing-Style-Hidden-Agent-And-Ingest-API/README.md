# TASK-974 — DNA Writing Style: platform hidden analyst agent + writing-sample ingest API + SDK support

| Field | Value |
|---|---|
| Status | In Progress |
| Type | feature |
| Branch | `dev-2.2` (lanes in worktrees `../hope-v2-t974-{core,node,vox,console}`) |
| Owner request | 2026-09-14 (verbatim in §1) |
| Related | TASK-890 (content is cloned / config cascades), TASK-876 (agent-first text), TASK-933 (machine callers on the consultation plane), TASK-968 (reasoning posture), TASK-930/931 (SDK 3.1 agent plane) |

## 1. Requirement Analysis

Owner request (2026-09-14):

> DNA-writing Style is a user personalization feature for rewrite and redaction following understanding the end-user's favors. (1) the system uses a time-series of text data (case-notes, work-notes, any writing text), extracts the writing style (abbreviations, grammar, spelling) and stores it as long-term memory per end-user; (2) when redaction is enabled on the summarization agent and the user has a DNA report/memory, summarization recalls it and rewrites/redacts the output.
>
> Make sure: (a) a HIDDEN text-generation agent for extracting/generating the DNA report is available to ALL tenants; the PLATFORM admin configures its LLM provider, model and hyper-parameters; a GENERAL instruction prompt is shared across tenants as default and fallback; each tenant MAY author its own instruction prompt instead. (b) an API for INGESTING a time-series of text for a clinician/end-user creates a job for the hidden agent to generate the report and update the memory. (c) `@arcaai/vox-node` and `@arcaai/vox` support the ingest API.

Classification: `feature`, full-stack (applications + api + database seed + two SDKs + a console badge).

### Acceptance criteria

| # | Criterion | Proof |
|---|---|---|
| AC-1 | One SYSTEM-tenant agent `dna-writing-style-analyst` (task `TEXT_GENERATION`) serves DNA report generation for EVERY tenant; its model, fallback chain, `parameters.generation` (temperature / maxTokens / reasoning) and inline `instruction.systemPrompt` are the platform admin's to set. | seed + processor unit tests asserting the outgoing `/api/v1/generate` body carries the SYSTEM agent's provider/model/hyper-parameters; e2e run against a live gateway |
| AC-2 | The agent is HIDDEN: never cloned into a tenant by the reference set, never listed by `GET /agents`, never invokable through `POST /agents/:slug/invoke`, never assignable through `AgentAssignment`; admin surfaces still see it with `hidden: true`. | unit tests on reference-set, agent service, assignment service, DTO mapper |
| AC-3 | Instruction cascade: a tenant-owned `PromptTemplate` of category `DNA_ANALYSIS` (ENABLED, newest `updatedAt`) wins; otherwise the SYSTEM agent's `instruction.systemPrompt` (the general prompt). Output schema: tenant template `metaData.promptConfig.outputSchema` → agent `outputSchema` → fail closed. | processor unit tests (three branches) |
| AC-4 | `POST /api/v1/dna-writing-styles/ingest` accepts a time-ordered batch of writing samples for a clinician, enqueues `GenerateDnaReport`, answers `202 { jobId, … }`; reachable by JWT (self, or a tenant admin naming a clinician), API key (scope `dna-writing-style:ingest`) and service account (`svc:dna-writing-style:ingest`). Cross-tenant clinician → 404. | controller + service unit tests; e2e spec `task-974-dna-ingest.spec.ts` |
| AC-5 | The job renders the samples CHRONOLOGICALLY, keeps the most recent when over the char budget, PHI-redacts (existing hop), and the written report is explainable (`reportData.ingest = { itemCount, from, to, kinds }`). | processor unit tests |
| AC-6 | `GET /api/v1/dna-writing-styles/ingest/jobs/:jobId` reports status; a machine caller may read only jobs it enqueued (principal match), a human caller only their own doctor's jobs (existing owner gate). | unit + e2e |
| AC-7 | `hope.dnaWritingStyle.ingest / getIngestJob / waitForIngestJob` in `@arcaai/vox-node`; `useDnaWritingStyle()` + `DNA_WRITING_STYLE_ENDPOINTS` in `@arcaai/vox` — both credential classes; browser SDK stays business-plane-only. | SDK unit tests, `check:exports`, exports/business-plane gate tests |
| AC-8 | Route artifacts regenerated together: `api:route-manifest`, `api:openapi`, `api:portal`, `vox-node gen:admin` (+ their `:check`s green). | command output in §5 |

## 2. Current State Evaluation (verified 2026-09-14 by three read-only lanes)

What exists (all on `dev-2.2`):

- **Storage / recall are done.** `DnaWritingStyleReport` / `DnaWritingStyleVersion` (Vault-Transit-encrypted `reportData` + `styleText` + redaction rules), `DnaUsageRecord`; recall into summarization prompts via `ConfigResolver.resolveEffectiveDnaStyleEnabled` (tenant graph node `agent.dna_style` AND doctor opt-in `dna.styleEnabled`) → `SummaryService.resolveEffectiveDnaStyleId` → `PromptAssemblyService` (variable substitution or the appended `--- CLINICIAN WRITING STYLE ---` block). Redaction: `resolveEffectiveDnaRedactionEnabled` + `RedactionRuleSet`. Requirement (2) of the request is therefore already live and is NOT touched here.
- **Generation exists but borrows its selection.** `DnaWritingStyleProcessor` (`packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts`) gathers the doctor's APPROVED summaries (or explicit `textSamples`), PHI-redacts (`IPhiRedactor`, full mode), loads the instruction via `PromptManagementService.listPromptTemplates({ category: 'DNA_ANALYSIS' })[0]` (caller-tenant only, B-12 pin), reads the schema from that template's `metaData.promptConfig.outputSchema` (FAIL-CLOSED, D-A 2026-08-17), resolves provider/model through `HarnessPolicyService.resolveTextSelection()` = the tenant's **finalize** `TEXT_GENERATION` agent (no dedicated agent; `:461`), posts to `apps/text /api/v1/generate` with `response_format: json_schema`, validates, renders `styleText` deterministically and writes report + version + usage rows.
- **The instruction template is seeded ONLY into the Global playground tenant** (`07-prompt-template.ts:536-554`, `tenantId: DEFAULT_TENANT_ID = 50000000-…`, id `71000000-0000-0000-0000-000000000003`, DRAFT). No SYSTEM row exists; the reference set clones only SYSTEM templates. **Every other tenant resolves zero DNA templates and the job fails closed on the missing schema** — DNA generation only works in Global today.
- **Triggers are JWT-only.** `POST dna-writing-styles/generate` (doctor self, `@ForbidApiKey()` — a NAMED exemption in `BUSINESS_PLANE_KEY_FORBIDDEN`) and `POST admin/dna-writing-styles/generate/:doctorId` (svc scope `svc:admin:dna-writing-style:manage`). `textSamples` is an unordered `string[]` with no timestamps — not a time series.
- **No hidden-agent concept anywhere** (`Agent` has no visibility column; `AGENT_TASKS` has four members; console lists all agents). The runtime assignment cascade is `department → tenant → AGENT_NOT_ASSIGNED` (TASK-890 OD-M) and `Agent`/`PromptTemplate` are deliberately OUT of `SYSTEM_SHARED_READ_MODELS`. The only "available to all tenants" mechanism is the reference-set CLONE (`TenantReferenceSetService.copyAgents`: every PUBLISHED SYSTEM agent).
- **SDKs.** `@arcaai/vox-node` has only the GENERATED admin resource (`hope.admin.dnaWritingStyle.*`); no business-plane DNA resource. `@arcaai/vox` carries `types/dna.ts` only — `useDnaStyle` / `DNA_STYLE_ENDPOINTS` were REMOVED under TASK-890 and two gate tests (`exports.task032.test.ts`, `business-plane-only.task890.test.ts`) pin those names as absent.

## 3. Design decisions

### D-1 (owner decision, 2026-09-14) — the DNA analyst is a PLATFORM SERVICE AGENT, i.e. CONFIGURATION, not tenant content

The request asks for one agent whose model/hyper-parameters the PLATFORM admin owns, shared by all tenants, with a general prompt as default/fallback and a per-tenant prompt override. That is the semantics of rule 2 (tenant → SYSTEM on absence) applied to an agent — the same shape `AiRoutingPolicy` gives guardrail / NLP / judge tasks — not the clone-and-own semantics of tenant content. Cloning (the TASK-890 OD-M default for `Agent`) would (i) let every tenant change the model of its copy and (ii) leave a platform admin's model change stranded in SYSTEM because `resync` is `missing-only` and `refresh-locked` is unimplemented. So:

- **One SYSTEM row, read at runtime by an EXPLICIT, slug-allow-listed, unscoped read** (`AgentRepository` reference-library pattern: base client + explicit `tenantId = SYSTEM` in the `where`). `SYSTEM_SHARED_READ_MODELS` is NOT widened; `AgentAssignmentService.resolve` is NOT changed. This is a second declared family of two-tenant reads, documented next to the first.
- **The allow-list is code:** `PLATFORM_HIDDEN_AGENTS` (`packages/applications/src/services/agent/platform-hidden-agents.ts`) — `{ 'dna-writing-style-analyst': { task: 'TEXT_GENERATION', purpose } }` + `isPlatformHiddenAgentSlug()`. Adding a second hidden agent is a code change + owner decision, by design.
- **Hidden means:** excluded from the reference-set clone; excluded from the business-plane agent list/get/invoke (`GET /agents`, `POST /agents/:slug/invoke`, both SDK planes) in EVERY tenant including Global; refused as an `AgentAssignment.agentSlug`; surfaced to ADMIN routes with `hidden: true` so the console can label it.
- **Authoring path is unchanged:** the platform admin edits the Global playground row (`/agents` in the Global working tenant) and runs `POST admin/agents/promote-to-system`; the SYSTEM row is what every tenant uses from the next job on. The seed ships both rows (Global authored, SYSTEM promoted copy with provenance) exactly like the six existing agents.
- **Credentials still cascade tenant-first**: the provider credential for the SYSTEM agent's model is resolved for the JOB tenant (BYO key wins, SYSTEM default otherwise; disabled = veto) through the existing `TextAgentResolverService.resolveFromAgent(agent, jobTenantId)` + `applyTenantProviderOverrides`; funding tier is derived, never stamped.
- **Rule update** (`00-project-context.md` §Content is cloned) records this as the documented exception with today's date; `docs/operations/deprecation-register.md` is untouched (nothing is deprecated).

### D-2 — the general instruction lives ON the hidden agent; the tenant override is a tenant-owned `DNA_ANALYSIS` PromptTemplate

- General prompt = SYSTEM agent `instruction: { systemPrompt: DNA_ANALYSIS_CONTENT_V3 }` and `outputSchema: DNA_OUTPUT_SCHEMA` (both constants already in `07-prompt-template.ts`). A SYSTEM `PromptTemplate` row is deliberately NOT introduced: the reference set clones every SYSTEM template, which would hand every tenant an "override" on day one and defeat the cascade.
- Tenant override = a `PromptTemplate` the tenant authors with `category: 'DNA_ANALYSIS'` (existing category, existing `/prompt-templates` screen, existing admin routes). Resolution in the processor: newest ENABLED tenant `DNA_ANALYSIS` template (any status — DNA has never had a publication gate, see `07-prompt-template.ts:13-22`) → else the agent's compiled prompt. Schema: tenant `promptConfig.outputSchema` → agent `outputSchema` → fail closed (D-A posture kept).
- The Global playground keeps its seeded `DNA_ANALYSIS` template (id `71000000-…-0003`); it simply IS Global's override now.

### D-3 — ingest carries the batch in the job, not in a new table

The request's "long-term memory" is the REPORT. The raw notes are PHI and the existing design keeps only the schema-constrained profile at rest, so no `DnaWritingSample` table is added. The batch rides the BullMQ payload exactly as `textSamples` already does (Redis persistence is disabled — PHI posture). Bounded: ≤ 200 items, ≤ 20 000 chars each, ≤ 400 000 chars total (400 `DNA_INGEST_TOO_LARGE`); the processor then keeps the MOST RECENT whole items under `dna-regen.max-context-chars`.

### D-4 — a separate controller for the ingest routes

`DnaWritingStyleController` is a named `@ForbidApiKey()` exemption (a clinician's personal model, owner checks in the service). The ingest surface is the FIRST machine-reachable DNA route by owner request (c), so it gets its own controller with declared scopes rather than un-exempting the personal routes.

## 4. Interface contract (frozen for the lanes — change it here first)

### 4.1 Gateway

`POST /api/v1/dna-writing-styles/ingest` — `DnaWritingStyleIngestController` (`apps/api/src/modules/dna-writing-style/dna-writing-style-ingest.controller.ts`, `@Controller('dna-writing-styles/ingest')`, `@ApiTags('dna-writing-styles')`, class-level bare `@Authorize()` + `@RequiredScopes('dna-writing-style:ingest')` + `@RequiredSvcScopes('svc:dna-writing-style:ingest')`; module: `DnaWritingStyleModule`). HTTP 202.

Request `IngestDnaWritingSamplesRequest` (class-validator, `@ApiProperty` on every field):

```ts
{
  clinicianUserId?: string;   // uuid. REQUIRED for API-key / service-account callers.
                              // Human JWT: absent ⇒ the caller (must be acting as a doctor — same
                              // assertActingAsDoctor rule as `generate`); present ⇒ allowed only for a
                              // caller holding role SUPER_ADMIN or TENANT_ADMIN (AUTH-NOTE), else 400
                              // DNA_INGEST_CLINICIAN_NOT_ALLOWED. Must belong to the tenant ⇒ else 404.
  items: Array<{
    text: string;             // 1..20000 chars
    writtenAt: string;        // ISO-8601 date-time; the time-series key
    kind?: 'CASE_NOTE' | 'WORK_NOTE' | 'OTHER';   // default OTHER
    sourceRef?: string;       // ≤ 200 chars, opaque caller reference (explainability only)
  }>;                          // 1..200 items; Σ text ≤ 400000 chars ⇒ else 400 DNA_INGEST_TOO_LARGE
}
```

Response `DnaIngestJobResponse`:

```ts
{ jobId: string; status: 'PENDING'; clinicianUserId: string; acceptedItems: number; window: { from: string; to: string } }
```

`GET /api/v1/dna-writing-styles/ingest/jobs/:jobId` → existing `DnaJobStatusResponseDto` (`{ jobId, status: 'queued'|'processing'|'completed'|'failed', progress, result?, error? }`). Gate (`assertDnaJobAccess` extended): tenant must match; human caller ⇒ `doctorId` must be the caller (existing rule, impersonation-aware); machine caller ⇒ `requestedBy.principalId` must equal the caller's credential id. 404-over-403 throughout. No SSE on this controller (follow-up F-1).

Errors: 400 validation / `DNA_INGEST_TOO_LARGE` / `DNA_INGEST_CLINICIAN_NOT_ALLOWED` / `DNA_INGEST_CLINICIAN_REQUIRED` (machine caller without `clinicianUserId`); 404 cross-tenant clinician or job; 409 `DNA_STYLE_DISABLED` when the effective DNA flag (tenant AND doctor) is off (pre-checked at enqueue so a caller is told immediately; the processor still re-checks).

### 4.2 Scopes

- API key: `'dna-writing-style:ingest'` in `apikey-scopes.registry.ts` — `{ description: "Ingest a clinician's writing samples to build their DNA writing style", category: <existing category the registry uses for clinician-facing scopes>, implies: [{ action: 'create', subject: 'DnaWritingStyleReport' }] }` (NOT reserved).
- Service account: derived family `DNA_WRITING_STYLE_SCOPE_SOURCES = ['dna-writing-style:ingest']` → `svc:dna-writing-style:ingest` via `deriveFamilyInto` in `service-account-scopes.registry.ts`.
- Seeds: grant the new scope to the seeded service account and to `SEEDED_API_KEY` (whatever the e2e helper's default key is) so the e2e spec can exercise both classes; keep a seeded key WITHOUT it for the 403 case.

### 4.3 Job payload (`GenerateDnaReportJobPayload`, additive)

```ts
{
  jobId; doctorId; tenantId; userId;             // unchanged
  textSamples?: string[]; sourceIds?: string[];   // unchanged
  samples?: Array<{ text: string; writtenAt: string; kind: 'CASE_NOTE'|'WORK_NOTE'|'OTHER'; sourceRef?: string }>;
  origin?: 'generate' | 'ingest' | 'scheduler';
  requestedBy?: { credentialClass: 'jwt' | 'api-key' | 'service-account'; principalId: string };
}
```

Processor rules for `samples`: sort ascending by `writtenAt`; drop OLDEST whole items until Σ chars ≤ `dna-regen.max-context-chars`; render `[i/n] <YYYY-MM-DD> · <kind>\n<text>` blocks joined by `\n\n---\n\n`; then the existing PHI redaction hop; `reportData.ingest = { itemCount, from, to, kinds: Record<kind, number> }` (never the text, never `sourceRef` values — those stay in the job only). `origin` is stamped on the `ResourceCreated` sys-event data.

### 4.4 Hidden-agent resolution in the processor (replaces `resolveTextSelection()` in `callText`)

1. `PLATFORM_HIDDEN_AGENTS['dna-writing-style-analyst']` → `AgentRepository.findPlatformHiddenBySlug(baseClient, slug)`: unscoped, `where: { tenantId: SYSTEM_TENANT_ID, slug, status: PUBLISHED, isActive: true, resourceStatus: ENABLED }`; absent ⇒ fail closed `DNA_ANALYST_AGENT_UNAVAILABLE` (503-class error; job fails with that reason).
2. Resolve to a `ResolvedAgent` + `ResolvedTextGenerationSpec` for the JOB tenant (models materialised under SYSTEM via the existing `inAgentTenant` shape; credential + funding for the job tenant via `TextAgentResolverService.resolveFromAgent(resolved, jobTenantId)`).
3. Wire: `provider`, `model`, `generation` (temperature / maxTokens / topP / reasoning → the same fields `buildTextGeneratePayload` + `applyTextRuntimeProfile` already put on the wire), `applyTenantProviderOverrides`, `response_format` from D-2.
4. `PromptUsageRecord` is written only when a TENANT template served the instruction; the agent id/version is recorded on `reportData.generator = { agentSlug, agentVersionId, provider, model }` for explainability.

### 4.5 `@arcaai/vox-node`

`hope.dnaWritingStyle: DnaWritingStyleResource` (`packages/vox-node/src/resources/dna-writing-style.ts`, types in `src/types/dna-writing-style.ts`, exported from `types/index.ts` and the package root; both credential classes; no `assertCredentialClass` restriction):

```ts
ingest(request: DnaWritingSamplesIngestRequest, options?: { signal?; idempotencyKey? }): Promise<DnaIngestJobResponse>   // POST dna-writing-styles/ingest
getIngestJob(jobId: string, options?): Promise<DnaIngestJobStatus>                                                       // GET  dna-writing-styles/ingest/jobs/:jobId
waitForIngestJob(jobId: string, options?: { pollIntervalMs?: number (1000); timeoutMs?: number (120000); signal? }): Promise<DnaIngestJobStatus>  // polls until completed|failed; TimeoutError on expiry
```

Type names: `DnaWritingSampleKind`, `DnaWritingSample`, `DnaWritingSamplesIngestRequest`, `DnaIngestJobResponse`, `DnaIngestJobStatus` (mirror 4.1 exactly). `resources/admin/**` untouched.

### 4.6 `@arcaai/vox` (browser)

- `DNA_WRITING_STYLE_ENDPOINTS = { INGEST: '/dna-writing-styles/ingest', INGEST_JOB: (jobId) => '/dna-writing-styles/ingest/jobs/<enc>' }` in `core/constants.ts` (a NEW name — `DNA_STYLE_ENDPOINTS` stays absent per the TASK-890 gate tests).
- `useDnaWritingStyle()` hook (`src/hooks/useDnaWritingStyle.ts`): `{ ingest(input): Promise<DnaIngestJobResponse>; getIngestJob(jobId): Promise<DnaIngestJobStatus>; pollIngestJob(jobId, { intervalMs?, timeoutMs? }): Promise<DnaIngestJobStatus>; job: DnaIngestJobStatus | null; isIngesting: boolean; error: Error | null }` — same shape/idioms as `useConsultationJob`. Types appended to `src/types/dna.ts`. Exported from `hooks/index.ts`, `core.ts`, root; locked in `exports.task032.test.ts`.

### 4.7 Admin console

`AgentResponse.hidden?: boolean` (from the DTO mapper) → `/agents` list and detail show a `Hidden · platform` badge (`variant="outline"`), and hidden agents are filtered OUT of every tenant-facing picker (agent assignment, workflow-studio `core.agent` node picker). No new screen.

## 5. Implementation Plan (lanes)

| Lane | Worktree / branch | Tier | Owns | Must NOT touch |
|---|---|---|---|---|
| L1 core | `../hope-v2-t974-core` / `task-974-core` | opus | `packages/applications/**`, `packages/domains/**` (repository read + enum barrels only), `packages/database/src/prisma/db_main/seed/**` (+ seed tests), `apps/api/src/modules/dna-writing-style/**`, `apps/api/src/bootstrap/**` (only if an audit needs the new controller named), `apps/api/tests/e2e/task-974-dna-ingest.spec.ts`, route artifacts (`route-manifest.json`, `openapi.json`, portal, vox-node generated admin) | `packages/vox-node/src/resources/*.ts` hand-authored files, `packages/agentic-sdk-v2/**`, `apps/admin-console/**`, `.claude/rules/**` |
| L2 node | `../hope-v2-t974-node` / `task-974-node` | sonnet | `packages/vox-node/**` except `src/resources/admin/**` | everything else |
| L3 vox | `../hope-v2-t974-vox` / `task-974-vox` | sonnet | `packages/agentic-sdk-v2/**` | everything else |
| L4 console | `../hope-v2-t974-console` / `task-974-console` | sonnet | `apps/admin-console/**` | everything else |

Orchestrator (this session) owns: merges into `dev-2.2` (`--no-ff`, order L1 → L2 → L3 → L4), `.claude/rules/**` + this README, `pnpm db:push` / seed on the dev DB, test-infra bring-up, the post-merge gates and the live e2e run.

### 5.1 L1 TDD list (RED first, each)

1. `platform-hidden-agents.test.ts` — registry shape; `isPlatformHiddenAgentSlug`.
2. `tenant-reference-set.service.test.ts` — `copyAgents` skips the hidden slug (SYSTEM has it PUBLISHED; the tenant gets no clone; summary counts it as skipped with a reason).
3. `agent.service.test.ts` — `listPublished` omits hidden slugs; business-plane get/invoke of a hidden slug → 404; admin `toResponse` carries `hidden: true`.
4. `agent-assignment.service.test.ts` — writing an assignment with a hidden `agentSlug` → 409.
5. `AgentRepository` — `findPlatformHiddenBySlug` (unit, mocked client) returns only the SYSTEM PUBLISHED+ACTIVE row.
6. Processor — (a) `callText` carries the SYSTEM agent's provider/model/temperature/max_tokens/reasoning; (b) fails closed when the SYSTEM agent is absent; (c) instruction cascade three branches; (d) schema cascade; (e) `samples` chronological render + most-recent truncation + `reportData.ingest`; (f) existing `textSamples` / approved-summary paths byte-identical (existing suites stay green, incl. `phi-containment` and `reasoning.task968`).
7. Service — `ingestWritingSamples(caller, dto)`: clinician resolution rules (4.1), tenant membership 404, DNA-disabled 409, payload shape, sys-event `dna-ingest-requested` with `origin: 'ingest'`.
8. Controller — credential-class branches, `clinicianUserId` rules, 202 body; job status principal gate (`dna-writing-style-job-stream.access.test.ts` extended).
9. Scopes — registry entries exist (api-key + derived svc); `RequiredSvcScopes('svc:dna-writing-style:ingest')` decorates without throwing.
10. Seeds — `catalogue()` has 7 specs; SYSTEM + Global rows for `dna-writing-style-analyst` with `instruction.systemPrompt`, `outputSchema`, `parameters.generation.reasoning.enabled=false`; NO assignment for it; seed tests' counts updated; scope grants to seeded credentials.
11. e2e `task-974-dna-ingest.spec.ts` — API key with scope 202; key without scope 403; service account 202; doctor JWT self 202; doctor JWT naming another clinician 400; tenant admin naming a clinician 202; cross-tenant clinician 404; job status principal/owner gate (404 for a foreign job); `GET /agents?task=TEXT_GENERATION` never lists the hidden slug; `POST /agents/dna-writing-style-analyst/invoke` 404.

Gates: `pnpm --filter @arcaai/domains build test`, `pnpm --filter @arcaai/applications build test`, `pnpm --filter @arcaai/database test`, `pnpm api:build`, `pnpm test:unit` (apps/api), `pnpm lint`, then `pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin` + the three `:check`s.

### 5.2 L2 / L3 / L4 TDD lists

- L2: resource tests (URL, method, body, headers incl. `Idempotency-Key`), `waitForIngestJob` polling + timeout + abort, type exports; `pnpm sdk-node:build test lint typecheck check:exports`; README section.
- L3: hook tests (ingest → client POST; poll → terminal), constants test, exports test additions, business-plane gate still green; `pnpm --filter @arcaai/vox build test lint typecheck`; `docs/API-Reference.md` + `CHANGELOG.md` entry (unreleased).
- L4: types + screen tests (badge rendered when `hidden`, picker filters), `pnpm --filter @arcaai/admin-console build lint test`.

## 6. Implementation Summary

_Pending — filled in at merge._

## 7. Follow-ups (not in scope)

- F-1: SSE on the ingest job route with `@StreamScope` so machine callers can subscribe instead of polling.
- F-2: `dna-regen.*` keys are read through `IAppSettingsService` with in-code defaults and are absent from the settings registry (found by lane 1); register descriptors.
- F-3: the business-plane `GET dna-writing-styles/jobs/:jobId/stream` still carries no `@StreamScope` (pre-existing, documented at the controller).
- F-4: `useArcaSummary.analyzeDNA` / `useArca.analyzeDNA` stubs reference a removed hook; retire or re-point at `useDnaWritingStyle`.

## 8. Change History

| Date | Change |
|---|---|
| 2026-09-14 | Ticket opened; exploration (3 read-only lanes); design D-1..D-4; contract §4 frozen; lanes spawned. |
