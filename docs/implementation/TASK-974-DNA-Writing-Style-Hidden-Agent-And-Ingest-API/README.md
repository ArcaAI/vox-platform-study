# TASK-974 — DNA Writing Style: platform hidden analyst agent + writing-sample ingest API + SDK support

| Field | Value |
|---|---|
| Status | Review |
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

### D-1 (owner decision, 2026-09-14; CONFIRMED by the owner 2026-09-15) — the DNA analyst is a PLATFORM SERVICE AGENT, i.e. CONFIGURATION, not tenant content

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

Merged on `dev-2.2` on 2026-09-14/15 as four `--no-ff` lane merges (`4f5e67f3b` core, `023c747bd` node,
`4f6849d61` vox, `185840d00` console) plus `c5e36e311` (rules 00/05/08 + the e2e owner-access fix).
Worktrees removed after the merge. No schema change; **a reseed is required** wherever the feature must
work (`RUN_SEED=all pnpm db:seed` on dev; the test DB was reseeded here) — without the SYSTEM analyst row
every DNA job fails closed with `DNA_ANALYST_AGENT_UNAVAILABLE`, and the new scope grants exist only in
freshly seeded credentials.

### What landed

| Area | Files (key) | Notes |
|---|---|---|
| Platform hidden agent registry | `packages/applications/src/services/agent/platform-hidden-agents.ts` (+ mirror `PLATFORM_HIDDEN_AGENT_SLUGS` in `packages/domains/.../AgentRepository.ts`, parity test) | `dna-writing-style-analyst`, task `TEXT_GENERATION` |
| Hidden semantics | `tenant-reference-set.service.ts` (no clone), `agent-resolver.service.ts` (`allowPlatformHidden` opt-in — the one by-slug chokepoint: invoke / speech / transcribe / `core.agent` / realtime all refuse), `agent.service.ts` (`listPublished` omits), `agent-assignment.service.ts` (409 `AGENT_NOT_ASSIGNABLE`), `agent.dto.mapper.ts` + `agent.response.ts` (`hidden: boolean`) | Admin list/get still serve it, flagged |
| SYSTEM-pinned read | `AgentRepository.findPlatformHiddenBySlug(baseClient, slug)` | Unscoped, explicit `tenantId = SYSTEM`, allow-listed slug; `SYSTEM_SHARED_READ_MODELS` untouched |
| Processor | `dna-writing-style.processor.ts` — `resolveAnalyst` (fail closed `DNA_ANALYST_AGENT_UNAVAILABLE`), `callText` on the analyst's spec (provider / model / temperature / max_tokens / reasoning; credential + funding for the JOB tenant via `TextAgentResolverService.resolveFromAgent`), instruction cascade (tenant `DNA_ANALYSIS` newest ENABLED → agent prompt), schema cascade (tenant `promptConfig.outputSchema` → the SYSTEM row's AUTHORED `outputSchema` → fail closed), `samples` branch (chronological render, oldest-first truncation, `reportData.ingest` + `reportData.generator`) | Pre-existing `textSamples` / approved-summary paths byte-identical; all 259 pre-existing DNA tests unchanged |
| Ingest surface | `IDnaWritingStyleService.ingestWritingSamples`, `dna-writing-style.service.ts`, DTOs `ingest-dna-writing-samples.request.ts` / `dna-ingest-job.response.ts`, `apps/api/.../dna-writing-style-ingest.controller.ts`, `dna-writing-style-job-stream.ts` (machine principal gate) | 202; clinician rules per §4.1; 409 `DNA_STYLE_DISABLED` pre-check |
| Scopes | `apikey-scopes.registry.ts` (`dna-writing-style:ingest`), `service-account-scopes.registry.ts` (derived `svc:dna-writing-style:ingest`), `apps/api/src/bootstrap/service-account-surface-audit.ts` (sixth family) | Granted to the seeded SDK keys (`SDK_DAY_ONE_SCOPES`) and the ArcaAI tenant-admin service account |
| Seeds | `seed/25-agents.ts` (7th spec, Global + SYSTEM, `modelSlug: lms-gemma-4-e2b-it-qat`, `temperature 0 / maxTokens 2048 / reasoning off`, `instruction.systemPrompt = DNA_ANALYSIS_CONTENT_V3`, `outputSchema = DNA_OUTPUT_SCHEMA`, NO assignment), `02-apikey.ts`, `94-service-account.ts` | Agent totals 12 → 14 |
| Artifacts | `route-manifest.json` (749 routes), `openapi.json`, admin-console portal JSON, vox-node generated schemas | all `:check`s green |
| `@arcaai/vox-node` | `resources/dna-writing-style.ts`, `types/dna-writing-style.ts`, `core/errors.ts` (`DnaIngestJobTimeoutError`), `client.ts` (`hope.dnaWritingStyle`), README | polling only |
| `@arcaai/vox` | `hooks/useDnaWritingStyle.ts`, `DNA_WRITING_STYLE_ENDPOINTS`, `types/dna.ts`, exports + gate tests, API-Reference, CHANGELOG | removed TASK-890 names stay absent |
| Admin console | `AgentHiddenBadge` (`Hidden · platform`) on `/agents` list + detail; `listAgentOptions()` filters hidden rows out of the workflow-studio `core.agent` picker | |
| Rules | `00-project-context.md` (platform service agents = configuration, D-1), `05-nestjs-api.md` (imperative-check row for ingest), `08-vox-sdk.md` (new SDK surface) | |

### Adversarial review (opus, three lenses) and the fix lane (merged `fcbda23ea`)

| # | Finding | Severity | Fix |
|---|---|---|---|
| R-1 | An API key bound to one clinician could ingest for ANY clinician of the tenant (scope was the whole decision; a credential exceeded its human) and the bound human could then read the other doctor's job result through the personal `jobs/:jobId` route | blocker | API key may name only its BOUND user unless that human holds `SUPER_ADMIN`/`TENANT_ADMIN` in this tenant (tenant-scoped role assignments, never the cross-tenant role list); service account keeps "any clinician of its tenant"; machine-enqueued jobs stamp `userId = doctorId` and the personal route no longer accepts `jobUserId` as owner for a machine-enqueued job |
| R-2 | Super admin (session `tenantId: ''`, elevated only in CLS) could never read back its own ingest job | should-fix | ingest controller reads `DnaJobAccess.tenantId` from CLS like its sibling |
| R-3 | `@IsISO8601()` accepts week/basic dates `Date.parse` cannot parse → 500 AFTER enqueue, corpus order undefined | should-fix | `strict` ISO on the DTO + 400 `DNA_INGEST_WRITTEN_AT_INVALID` before `queue.add`; the renderer refuses NaN |
| R-4 | `primaryBinding: 'mark'` swallowed an unusable connection binding while nothing walks the chain | should-fix | `'fail-closed'`; chain walk recorded as follow-up F-6 |
| R-5 | Fail-closed now applies to the pre-existing generate/admin/scheduler paths; an already-seeded environment has no SYSTEM analyst row | should-fix | documented: reseed is mandatory (§6); pre-production, no migration |
| R-6 | vox-node advertised `Idempotency-Key` retry-safety the gateway did not implement, and the flag lifted the SDK's POST retry guard → duplicate jobs | should-fix | gateway honours the header (≤200 chars): `jobId = sha256(tenant|principal|key)`, `queue.getJob` first so a retry JOINS the original job and answers the same 202 |
| R-7 | e2e inlined service-account fixtures its own header forbade | nit | exported from `tests/helpers/e2e.helper.ts` |
| R-8 | `origin` only ever stamped by ingest | nit | `generate` / `scheduler` stamp theirs |
| DB | **Found by the orchestrator's DB check, not the review:** the SEED's own reference-set phase (`26-tenant-reference-set.ts`) cloned the hidden agent into the ArcaAI tenant — it mirrors the runtime clone but shares no code | blocker (AC-2) | seed skips `PLATFORM_HIDDEN_AGENT_SLUGS` (declared in `seed/00-constants.ts`); THREE-way parity test applications ↔ domains ↔ seed; a create-only seed does not remove an existing clone — recreate the DB or delete by provenance (`sourceAgentId = 9c000000-0000-0000-0001-000000000007`) |

Checked and clean by the review: hidden-agent containment on every by-slug path (list, get, invocations, speech, `core.agent` internal route, assignment, reference set), CLS restoration around the SYSTEM read, BYO credential folded for the JOB tenant, reasoning on the wire, `reportData.ingest` carries no PHI, 404-over-403 ordering, three-way contract parity gateway ↔ vox-node ↔ vox.

### Contract deviations (from §4, all deliberate)

- Business-plane exclusion lives in `AgentResolverService.resolve` (opt-in flag), not in `agent.controller.ts` — stronger, one chokepoint.
- The agent-tier output schema is the SYSTEM row's **authored** `outputSchema`, not `compiledConfig.outputSchema` (compilation substitutes the `{ text }` task default, which would have turned "no schema" into a fail-open constraint).
- The real invoke route is `POST /agents/{slug}/invocations`; assignment write is `POST /admin/agent-assignments`.
- Machine job-status reads compare `requestedBy.principalId`; the clinician the job is ABOUT keeps owner access (200) — the first e2e draft expected 404 there and was corrected.

### Evidence (post-merge, primary checkout, 2026-09-15)

```
domains test        Test Files 169 passed | 2 skipped   Tests 1980 passed
database test       Test Files 91 passed               Tests 1822 passed
applications test   (task-974 surfaces) 79 files / 1858 tests passed; the 1 "failed" file is
                    agentPromotion/__tests__/integration/membership-bounded-sync.integration.test.ts —
                    a LIVE-DB integration test swept in by the path filter, not a unit test
api unit            (dna + bootstrap + agent) Test Files 34 passed   Tests 599 passed
vox-node            Test Files 37 passed  Tests 531 passed; attw/publint clean; gen:admin:check no drift
vox                 Test Files 246 passed Tests 3729 passed
admin-console       typecheck clean; agents + workflow-studio tests 23 files / 164 passed (lane: full 339/3229 + build)
artifacts           openapi-coverage OK · api portal no drift (admin 667 / business 202 ops) · vox-node codegen no drift
lint                api 0 errors (65 pre-existing warnings, none in touched files — eslint on the touched files is clean)
e2e                 task-974-dna-ingest.spec.ts  18 passed (2.0s) against a live test gateway on :8968
                    (seeded test DB; RESET_DB=false)
live probe          POST …/ingest via the seeded API key → 202 → job queued (progress 10) → the job reached the
                    PHI-redaction hop and failed there with ECONNREFUSED :8963 (guardrail is not running in the
                    test env). Ingest, enqueue and the samples branch are proven live; the analyst resolution and
                    the model call are proven by unit tests (`dna-writing-style.processor.hidden-agent.task974.test.ts`)
                    and by the seeded rows (SYSTEM + Global `dna-writing-style-analyst`, PUBLISHED/active, prompt +
                    schema + generation present; 0 assignments; 0 tenant clones).
```

Round 2 (after the fix merge `fcbda23ea`, 2026-09-15): rebuilt; test DB DROPPED + recreated + reseeded
(`RUN_SEED=all`); hidden analyst rows = SYSTEM + Global ONLY, 0 assignments (the ArcaAI clone is gone);
gateway `0.0.0-dev-2-2.fcbda23e` on :8968; `task-974-dna-ingest.spec.ts` **21 passed (2.4s)** — the three
new cases: an API key bound to one clinician may not name another (400), an unorderable `writtenAt` is
refused before anything is queued (400), a retry carrying the same `Idempotency-Key` joins the original job.
Fix-lane unit gates: domains 1980 passed; applications targeted 938 passed (+ full suite 863 files passed);
database 1825 passed; api targeted 483 passed; vox-node 531 passed; artifacts no drift.

Pre-existing reds on `dev-2.2` NOT caused here: `tests/contracts/npm-publish-policy.contract.test.ts`
(vox family version drift `3.4.0` vs `3.3.0`, from `d3c8f0086`); `audit-correlation.test.ts` sits at its
30 s timeout boundary (21 s at base).

### Operator notes

- Platform admin authoring path: edit `dna-writing-style-analyst` in the Global working tenant on `/agents`
  (model, fallbacks, `parameters.generation`, the inline system prompt), then `POST admin/agents/promote-to-system`.
- Tenant override: create a `PromptTemplate` with category `DNA_ANALYSIS` in the tenant (the newest ENABLED wins);
  optionally give it `metaData.promptConfig.outputSchema`.
- The `visibility:hidden` tag on the seeded rows is a label; the gate is the code allow-list.

## 9. Requirement (d) — count and measure DNA usage for billing (owner, 2026-09-15)

### 9.1 Current state (verified 2026-09-15)

The DNA path records NOTHING in the AI usage ledger: `DnaWritingStyleProcessor.callText` types the text
response as `{ content, usage?, latency_ms? }` and discards `usage_detail` / `guardrail_usage` / `task_id`;
the processor injects no `IUsageLedgerService`, `IComputeDeviceResolver`, `IEntitlementsService` or
`IBillingService`; `DnaWritingStyleService` runs no `assertMeterQuota` / `assertSpendLimit` before
`queue.add`. `DnaUsageRecord` / `PromptUsageRecord` are explainability rows (ids only, no tokens, no cost).
Every other text caller (text proxy, comprehensive-summary processor, agent invocations) parses
`usage_detail` and calls `IUsageLedgerService.recordUsage` itself — nothing meters automatically.

### 9.2 Design D-5 — two closed operations on the existing ledger, no schema change

| Event | Emitted where | `capability` / `operation` | Units | Attribution |
|---|---|---|---|---|
| **DNA analysis** (the analyst LLM call) | `DnaWritingStyleProcessor`, after the text call, INSIDE the same `runInTransaction` as the report / version / usage-record writes (the `persistSummaryMetaWithUsage` shape: metering failure ⇒ roll back, re-persist unmetered, count `hope_usage_emission_failed_total`) | `LLM` / **`dna.analyze`** (+ the guardrail COGS batch exactly as `buildGuardrailUsageBatches` emits it) | `INPUT_TOKEN`, `OUTPUT_TOKEN` (+ reasoning/cache tokens when reported), `REQUEST` 1, plus the compute / byte rows `buildLlmUsageBatches` appends (`GPU_SECOND`/`CPU_SECOND` for self-hosted via `IComputeDeviceResolver`, `INGRESS/EGRESS_BYTE`) | `tenantId`, `doctorId`, `requestId = text task_id`, `sessionId = dna job id`; `consultationId`/`departmentId` null; `attributesJson.origin ∈ generate\|ingest\|scheduler` (allow-listed) |
| **DNA ingest** (the API call that feeds the learning) | `DnaWritingStyleService.ingestWritingSamples`, right after the job is enqueued (fire-and-forget with the emission-failure metric; a retry that JOINS an existing job emits nothing — same idempotency key) | `LLM` / **`dna.ingest`** | `REQUEST` 1, `CHARACTER` = Σ item text length, `INGRESS_BYTE` = serialized batch bytes | `tenantId`, `doctorId = clinician`, `requestId = job id`, `attributesJson.credentialClass` |

- **Idempotency**: analysis rows `llm:<task_id>:<UNIT>` (`UsageIdempotencyKey.llmRequest`); ingest rows `dna-ingest:<jobId>:<UNIT>` (new recipe). A BullMQ retry re-runs the LLM and costs again — it gets its own text `task_id`, so it is a second event, correctly.
- **Provider / model / deployment / costBasis** come from `usage_detail` through `toLedgerProvider` + `resolveDeployment` + `BYOK_NOTIONAL` iff `byok` — never hand-rolled; the SYSTEM analyst served through a tenant's BYO key therefore rates as BYOK for that tenant, through the platform key as CLOUD/SELF_HOSTED — funding is DERIVED from the row that served the credential (rule 09).
- **Precheck** (mirrors `summary.service.ts` and `agent.controller.ts`): `assertMeterQuota(tenantId, 'monthlyLlmTokens')` then `billing.assertSpendLimit(tenantId)` BEFORE `queue.add` in `generateDnaReport` AND `ingestWritingSamples` (429 / 402, outside any try/catch so they are never disguised), and per tenant inside `DnaRegenerationScheduler.regenerateAllDoctors` (a tenant over its allowance is SKIPPED with a warn, never fails the sweep). No new meter key: DNA draws on the tenant's LLM allowance like every other text call (a DNA-specific cap is owner item O-1 below).
- **Reporting**: `GET admin/usage/summary|timeseries` already break down by `operation`; `dna.analyze` and `dna.ingest` appear with no console change (the console renders the operation string). `AiUsageRollup*` carry `operation` since TASK-959.
- **Pricing**: `AiPriceBook` rates on `(capability, provider, model, unit)`, so DNA tokens are rated like any other LLM call on that model; a DNA-specific SELL price is owner item O-2.

### 9.4 Implementation (lane L6, merged `3575dee23`)

| Item | Where | Pinned by |
|---|---|---|
| Vocabulary: `dna.analyze`, `dna.ingest` in `USAGE_OPERATIONS` (13 → 15); `UsageIdempotencyKey.dnaIngest(jobId)`; `origin` + `credentialClass` as CLOSED attribute vocabularies; provider `hope-api` (listed in `KNOWN_PROVIDERS` and `SELF_HOSTED_PROVIDER_IDS`) for the model-less ingest rows so they never pollute a real connection's token rollup | `packages/applications/src/services/usageLedger/{vocabulary,idempotency-keys,usage-attributes}.ts` | `__tests__/dna-vocabulary.task974.test.ts` (13) |
| Processor: `callText` now returns `usage_detail` / `guardrail_usage` / `task_id`; `persistReportWithUsage` runs the four business creates AND every `recordUsage(input, tx)` in ONE `runInTransaction` (`dna.analyze` + guardrail batch, `sessionId = jobId`, `attributesJson.origin`, compute device for self-hosted, fail-open); metering failure ⇒ roll back, re-persist unmetered, `hope_usage_emission_failed_total`; the `isLatest` demotion deliberately stays OUTSIDE the transaction | `dna-writing-style.processor.ts` (+ four `@Optional()` trailing deps; `MetricsServiceModule` added to the DNA module) | `dna-writing-style.processor.usage.task974.test.ts` (11) |
| Service: `assertMaySpend` = `assertMeterQuota(tenantId,'monthlyLlmTokens')` then `billing.assertSpendLimit(tenantId)` before `queue.add` in `generateDnaReport` and `ingestWritingSamples` (after the DNA-enabled gate, before the idempotency JOIN — a join re-runs nothing and emits nothing); `emitIngestUsage` fire-and-forget: `REQUEST 1`, `CHARACTER Σ text`, `INGRESS_BYTE`, `requestId = sessionId = jobId`, `attributesJson.credentialClass` | `dna-writing-style.service.ts` | `dna-writing-style.billing.task974.test.ts` (16 + module-wiring) |
| Scheduler: per-tenant precheck, memoised; a refused tenant is skipped with a warn and listed on `result.errors` | `dna-regeneration.scheduler.ts` | same file |
| API docs: 402 / 429 documented on the ingest route and BOTH generate routes; `openapi.json` + portal regenerated (additive); route manifest + vox-node admin unchanged | `apps/api/src/modules/dna-writing-style/*.controller.ts` | `api:openapi:check`, `api:portal:check`, `gen:admin:check` |

All 302 pre-existing DNA tests green with zero fixture changes. Lane gates: applications targeted 957 passed; api dna module 106 passed; wider sweep applications 1912 / api 603 passed; lint 0 errors, no new warnings.

**Live evidence (2026-09-15, gateway `0.0.0-dev-2-2.3575dee2` on :8968, seeded test DB):** e2e
`task-974-dna-ingest.spec.ts` 21 passed (13.7s). `core."AiUsageOutbox"`: 7 rows, all `DISPATCHED` (payload
shape `{ "events": [...] }`); drained `core."AiUsageEvent"` rows for `dna.ingest` per live ingest — `REQUEST 1`,
`CHARACTER 200`, `INGRESS_BYTE 351/408`, `provider hope-api`, `doctorId` = the clinician, `requestId = sessionId =
jobId`, `attributesJson {origin: ingest, credentialClass: jwt | api-key | service-account}`; the idempotent
retry (sha256 jobId) produced ONE set of rows. `dna.analyze` rows cannot be produced in the test env (the job
stops at the PHI-redaction hop, guardrail :8963 not running) — proven by
`dna-writing-style.processor.usage.task974.test.ts`. Verification SQL is in the L6 lane notes above.

### 9.3 Owner items opened by (d)

- O-1: a DNA-specific meter (`monthlyDnaGenerations`) needs `MeterCapabilityKey` + `ResolvedLimits` + a `PlanEntitlement` column + the plan-matrix UI — not built; DNA draws on `monthlyLlmTokens`.
- O-2: a DNA-specific SELL price is not expressible on the current price book (keyed by capability/provider/model/unit, not operation).
- O-3: billing per DNA-personalised SUMMARY (style recall) is not emitted; the style text is already inside the summarisation call's `INPUT_TOKEN`s and `DnaUsageRecord` counts recalls for explainability. Decide whether recall is a SELL feature.

## 7. Follow-ups (not in scope)

- F-1: SSE on the ingest job route with `@StreamScope` so machine callers can subscribe instead of polling.
- F-2: `dna-regen.*` keys are read through `IAppSettingsService` with in-code defaults and are absent from the settings registry (found by lane 1); register descriptors.
- F-3: the business-plane `GET dna-writing-styles/jobs/:jobId/stream` still carries no `@StreamScope` (pre-existing, documented at the controller).
- F-4: `useArcaSummary.analyzeDNA` / `useArca.analyzeDNA` stubs reference a removed hook; retire or re-point at `useDnaWritingStyle`.
- F-5: six other e2e specs still inline the service-account fixture pair now exported by `tests/helpers/e2e.helper.ts`.
- F-6: the DNA job dispatches `spec.primary` only; walking the analyst's fallback chain (`spec.fallback.chain`) on a primary failure is unbuilt (why R-4 is fail-closed).
- F-7: reseed policy for already-seeded environments — the SYSTEM analyst row and the two scope grants exist only in a fresh seed (pre-production, so `pnpm db:all` is the documented path; a data migration would be needed once real data exists).

## 8. Change History

| Date | Change |
|---|---|
| 2026-09-14 | Ticket opened; exploration (3 read-only lanes); design D-1..D-4; contract §4 frozen; lanes spawned. |
| 2026-09-15 | Four lanes merged (`--no-ff`); post-merge gates + artifacts green; test DB reseeded; e2e 18/18 live; rules 00/05/08 updated; worktrees removed; adversarial review run. |
| 2026-09-15 | Owner CONFIRMED D-1 and added requirement (d): DNA usage must be COUNTED and MEASURED for billing — scoped as §9 below. |
| 2026-09-15 | Requirement (d) billing: lane L6 merged `3575dee23` — `dna.analyze` + `dna.ingest` on the usage ledger, prechecks, scheduler skip, 402/429 documented; rebuilt; e2e 21/21; `dna.ingest` rows verified end to end in `AiUsageEvent`. Owner items O-1..O-3 open. |
| 2026-09-15 | Review findings R-1..R-8 + the seed-clone defect fixed in lane L5 (merged `fcbda23ea`); test DB recreated from the fixed seed; e2e 21/21 live; rule 05 row refined (API key binds to its human); fix worktree removed. Status: Review — awaiting owner confirmation; dev DB still needs `RUN_SEED=all pnpm db:seed` (or `pnpm db:all`). |
