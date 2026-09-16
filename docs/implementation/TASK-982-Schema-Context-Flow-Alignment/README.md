# TASK-982 — Schema-driven consultation context: make the whole flow hold, end to end

| Field | Value |
|---|---|
| **Status** | In Progress — owner approved every recommendation and said go (2026-09-17); §3.4 contracts pinned; wave 1 lanes (A, B1, C, D) spawned |
| **Type** | feature + bugfix + docs, cross-cutting: `packages/types`, `packages/database` (one migration + seed), `packages/domains`, `packages/applications`, `packages/workflow-contract`, `apps/harness`, `apps/api`, `packages/vox-node`, `packages/agentic-sdk-v2`, `packages/vox-codegen`, `apps/admin-console`, `docs/` |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-09-17 |
| **Ticket number** | TASK-982 — next after the end-to-end evidence ticket (confirm, OD-0) |
| **Baseline** | The end-to-end run of 2026-09-16 on the ArcaAI tenant (evidence under `docs/implementation/TASK-981-E2E-Schema-Codegen-Workflow-Context/evidence/`). Every fix below has an acceptance criterion phrased as "re-run that journey and observe X" |

## 1. Requirement

Owner ask (2026-09-17, verbatim):

> Lets plan then align agents using appropriate model-effort tier to fix all issues found, all findings. […] ensure all things meet the expectation and requirement as the end-to-end tests expectations. Keep in mind that the Admin-Console screens and interfaces MUST BE simple, friendly, easy-to-use for the first sign. DO NOT MAKE it complicated or confused to any admins, eg: creating too many controllers, so many inputs, buttons; use big modal or new screen instead of drawer in case there are many information and details to be displayed. We need the hope platform, SDKs, codegen packages, Client-side Development & Integration document and Tenant Admin User Guide to be aligned completely, properly, and ready on Day-1.

The expectations the flow must meet, stated once as behaviour (the acceptance oracle for the whole ticket):

| # | Expectation | Today |
|---|---|---|
| E1 | A tenant admin defines/evolves the consultation context schema in the console and can see, before confirming, what the change does to the workflows and agents that depend on it | Publishes blind; no "used by"; a new kind silently breaks every consultation workflow's run |
| E2 | A client developer generates types from the tenant's schema and the tenant's published catalogue with one documented command per credential; the generated types are usable at the `open()` call site and tell the truth about what each workflow accepts; drift is detectable in CI | Tenant-schema mode works; catalogue mode fails 403 with the seeded SDK key; the request type is untyped so the generated map buys nothing at the call site; no provenance, no `--check` |
| E3 | A single typed `open()` with the schema's kinds selects department, visit type, clinician (provisioning when new), persists the context, and starts the department's workflow; every refusal is precise and reaches the client with its detail; the client can read back what it sent and the run it got | Works, except `problems[]` never reaches the client, context items cannot be listed through the SDK, and a failed governing run is invisible |
| E4 | Every prompt the platform composes can use what the client sent: vitals, previous case notes, visit type, department, chief complaint | Vitals never reach any prompt; previous notes reach only the summary agent's clinician-notes block and the pre-summary's mislabelled "transcript" block |
| E5 | Admins can see a consultation's governing run and why it failed | Consultation screens never show or link the run |
| E6 | Run status means the same thing on every surface | Live surface says DEGRADED, persisted row says COMPLETED with zero degraded nodes |
| E7 | One Client-side Development & Integration Guide and one Tenant Admin User Guide, Day-1 complete, consistent with each other, with the console's own developer pages and with the SDK/codegen packages; the whole documented journey (credentials → types → open → stream → stop → release the gate → approve → close → read) is executable | Two accurate-but-partial developer guides that contradict each other on webhooks; no tenant-admin guide; the review gate, approve and close are documented nowhere |

## 2. Current state (verified by four read-only discovery lanes and three reviews, 2026-09-17)

### 2.1 Prompt variables (E4)

- `buildPreSummaryVariables(sources)` (`packages/applications/src/services/consultation/prompt/pre-summary-variables.ts:97`) already accepts `vitals` / `previousVisits` / `testResults`. Three call sites; only the realtime lane passes them:
  - `PromptAssemblyService.buildVariables` (`prompt/prompt-assembly.service.ts:862`) — department / visit type / language only; `PromptAssemblyParams` has no vitals/previousVisits fields; the comment beside it ("the v2 data model holds no vitals or prior-visit text") is stale.
  - `LiveDocumentationService.handoffClinicalContext` (`live-documentation/live-documentation.service.ts:6644`) — same three, so the harness handoff carries `formatted_previous_visits = ''`.
  - `LiveDocumentationService.realtimeRunContext` (`:4225`) — reads the client kinds by `kindKey` (`readClientContext` / `latestContextItemOfKind` / `formatClientVitalsForPrompt` / `formatPreviousVisitsForPrompt`, all private to that file, memoised per session at `:4264`, decrypting through `contextItemRepository.decryptContentFromEntity(entity, secretsService)` at `:4326`) and passes both; its consumers, the department live templates, reference neither variable.
- `SummaryService.generatePreSummary` (`summary/summary.service.ts:429`) feeds `findCaseNotes()` into `assemble({ transcript })`, so the pre-summary agent receives the case notes under `<<<EXTERNAL_DATA section="transcript">>>`. Every other `assemble()` caller (`harness-internal.service.ts:1049`, `jobs/processors/pre-summary.processor.ts:185`, `comprehensive-summary.processor.ts:429`, `summary/chain-summary.service.ts:627`, `summary.service.ts:717`) already holds the consultation entity, so all can read the client kinds.
- Import graph inside `packages/applications`: `prompt/live-agent-resolution.service.ts:43` value-imports `live-documentation.service`, and `live-documentation.service.ts:114` imports `prompt/pre-summary-variables` — a directory-level cycle already exists; a new shared reader must sit in a leaf that imports neither.
- The seeded ArcaAI graphs declare `formatted_previous_visits` and `formatted_vitals` as REQUIRED properties of the `context` kind their prompts bind to; the pre-summary body renders `{{context.safe_vitals}}` / `{{context.formatted_previous_visits}}`.
- `ContextItemRepository` has `findCaseNotes()` (by `type`) but no read by `kindKey`.

### 2.2 Schema evolution vs frozen triggers (E1, E3)

- `publish` (`consultation-context-schema.service.ts:215`) classifies with `classifyDefinitionChange` (`definition-diff.ts:54`), which iterates PREVIOUS kinds only — a new kind is never inspected, so adding one is `ADDITIVE` and the pin moves unconditionally (`:266`).
- `payloadSchemaFromDefinition` (`context-schema-definition.ts:811`) sets `additionalProperties: false` at the kind level; that derived schema is frozen onto the `core.trigger` at workflow publish (`workflow-contract/src/compiler.ts:401-420`, `compiledConfig.contextSchema.resolved`). The compiled config ALSO carries `policyBindings.contextSchemaRefs[]` = `{ nodeId, schemaId, versionNumber, versionId }` (`compiled-config.schema.json:354-366`), so the bound version is recoverable from the compiled bytes today.
- Two documented invariants govern this: `compiler.ts:391` ("no run may re-read a schema row to learn it") and `compiled-config.schema.json:356` ("the interpreter validates a run payload against the schema the workflow was PUBLISHED with, never against whatever the tenant has edited since"). The studio's trigger field promises the opposite for its "Follow latest (currently vN)" option (`workflow-studio/components/inspector/context-schema-ref-field.tsx:133-168`: "a republish changes what this trigger accepts") — the runtime resolves the pin at COMPILE time (`workflow-definition.service.ts:2177`) and the harness `interpreter_core_trigger` (`apps/harness/src/harness/temporal/interpreter/nodes/core.py:186-215`, an activity, not workflow code) validates against `resolved` only, raising on any undeclared kind (critical node → run FAILED).
- Per-run configuration already exists: `HarnessGatewayService.startWorkflowRun` mints a claim-checked `configRef` per dispatch (`harness-gateway.service.ts:544`) for BOTH dispatch paths (consultation open and `POST workflows/:slug/runs`).
- Nothing enumerates consumers of a schema: `Agent.contextSchemaId` is a column; `WorkflowDefinition` has none (binding lives in `graph`/`compiledConfig` JSON). The immutability guard on PUBLISHED workflow rows (`migration 20260817000100_task_734_*`) protects a CLOSED list of columns, so new columns are silently mutable unless added to it.
- Failure feedback: `dispatchForConsultation` records `metadata.governingEngine` right after the run STARTS (`consultation-workflow-dispatch.service.ts:273-309`); the completion watcher's `failGovernedRun` (`harness-internal.service.ts:746-755`) acts only when the consultation is `DRAINING`, so a trigger failure at open leaves it `OPEN` with no status change, event or SSE. Dispatch is best-effort by contract ("a harness outage must never stop a clinician opening a consultation", `consultation.service.ts:1136`) and fires on the CREATE path only; the idempotent re-open branch (`:1019-1046`) dispatches nothing. Row, context items and the METER unit are all written before dispatch (`:1049` → `persistOpenContext` → dispatch).
- `open` validates the payload against the CURRENT pinned version (`validateContextPayload`, `:455-524`), so the gateway accepts what the frozen workflow refuses a second later. Every existing `open` refusal is a **400** carrying `{ message, code, problems? }` (`:470-475`, `:564`, `:685`, `:801`); the gateway emits no 422 anywhere (`agent.controller.ts:278` records the house rule).

### 2.3 Console (E1, E5)

- `/context-schemas`: list + `DetailDrawer` (size `xl`) with 4 tabs (Settings 6 inputs, Definition, Versions, Tester), drawer chrome (2 badges, 3 meta items, a standing Delete button). A STRUCTURED kind exposes **23 controls** (26 with Deprecated on): kind form 16 + `FieldRoleTable` 7. Publish = optional change reason + one button; server refusals inline; breaking → "Publish anyway". No "used by", no impact preview. Version list shows drift badges against the pin only.
- `/workflow-studio/[id]`: trigger schema field as above; `PublishDialog` is a short confirm; no re-freeze action.
- `/consultations`, `/consultation-review`: never read `GET consultations/:id/workflow` (exists; answers `governed`, `workflowDefinitionSlug`, `workflowRunId`); no link to `/workflow-runs/[runId]`, whose `run-status-badge.tsx` (no DEGRADED entry, by design) and `failure-panel.tsx` already render a failure.
- `/api-keys`: create dialog = name + **99 scope checkboxes** (15 categories, `apikey-scopes.registry.ts`) + expiry + 2 buttons ≈ 103 controls; no presets; raw key shown once with an "I stored it" checkbox.
- `/developer/*` in-console docs: credential classes, error contract, OCC, streams — zero mention of context schema, codegen, review gate, approve or close.

### 2.4 SDKs, codegen, seeds, status, guardrail (E2, E3, E6)

- Seed `SDK_DAY_ONE_SCOPES` (`02-apikey.ts:128-158`, 20 scopes) lacks `agent:definition:read` and `workflow:definition:read`; pinned by `seed-apikey-sdk-scopes.test.ts`. `packages/database` depends on `@arcaai/types` only — it cannot import from `packages/applications`.
- vox-node: `OpenConsultationRequest.context` is `Record<string, unknown>` (`types/consultation-realtime.ts:146`); there is NO `listContext()` (only `addContext`); `ConsultationGetResponse` omits `language`, `metadata`, `parentConsultationId` although the gateway returns one `ConsultationResponse` for `open` and `GET`; `fromResponse` (`core/errors.ts:478`) lifts `status`/`code`/`message` only (no `problems[]`, no 422 class); refusal codes exist only in JSDoc; `workflows.reviews.get/decide` exist (`resources/workflows.ts:492-548`) but the review node id is undiscoverable (`WorkflowSchemaDescription` lists no review nodes) and neither they nor `summaries.approve()` / `consultations.close()` (both require `ifMatch`) appear in any README, guide or example.
- Browser SDK: `ContextItem.kindKey?` is declared (`types/context.ts:35`) but never filled by the wire; `AgenticClient.ts:331-344` lifts `code` and `currentVersion` but not `problems`; no `governingRun` anywhere; `useConsultationSchema` validates against the session-pinned bundle (`useConsultationSchema.ts:22,50`), so under a PINNED trigger a locally-valid payload can still be refused.
- `ContextDtoMapper.toResponse` never projects `kindKey` / `contextSchemaVersionId` (the entity has both).
- `WorkflowSchemaDescription` (`workflow-exposure/workflow-schema-description.ts:44`) exposes the resolved input schema but not the schema id / version it was frozen from, nor review nodes; codegen's per-workflow JSDoc is `slug vN — name`; the tenant-schema generator prints `Schema: <slug> v<n> (<versionId>)` in its header (`generate.ts:188`) and emits ticket numbers into customer-facing JSDoc (`generate.ts:54-67`); there is no `--check` mode.
- Run status: `workflow-run.prisma:107-109` already has `nodeCount`, `failedNodeCount`, `degradedNodeCount` (unfilled), and `:49-55` records the owner decision "degraded is a per-run FLAG, never a run STATE". `WorkflowRunCompletionService.terminalStatusOf` (`apps/api/src/modules/workflows/workflow-run-completion.service.ts:17-33`) folds `SUCCEEDED/DEGRADED → COMPLETED` but `recordTerminal` leaves the counts untouched because the interpreter's `workflow.run.completed` event carries none; the live read (`workflow-exposure.service.ts:399`) returns the interpreter's word verbatim; `TERMINAL_RUN_STATUSES` (`:60`) gates the PERSISTED vocabulary and lacks `DEGRADED`, so the read-path sync no-ops on it.
- Pre-summary: `LivePreSummaryAdapter.run` (`summary/live-pre-summary.adapter.ts:59-89`) calls `generatePreSummary` once and degrades on any error; TEXT's guardrail client is 3 × 10 s fail-closed (platform-only knobs). The first judge call on a cold LM Studio model took ~37 s in the baseline run.

### 2.5 Docs (E7)

- `docs/consultation-context-schema-integration-guide.md` and `docs/architecture/clinician-integration-guide.md` are accurate on what they cover but omit the open-time markers and refusal codes, the review gate and the approve → close finish; the clinician guide's finalize snippet calls `close()` where the gateway now answers 409 without a prior approve; the two documents CONTRADICT each other on whether a run-completed webhook exists (vox-node README: "poll or hold the stream"; clinician guide §Webhooks: the `WorkflowRun` sys-event and webhook fire).
- `packages/vox-node/README.md` omits `summaries.approve()` / `consultations.close()` / `workflows.reviews.*`; `packages/vox-codegen/README.md` never names the two catalogue scopes; no example covers approve/close.
- No tenant-admin guide exists; `docs/operations/*` are platform-operator runbooks. A Day-1 tenant has no departments, users, agent assignments or consent yet — any guide that starts at "define the schema" starts at step 5.

## 3. Design

### 3.1 Principles

1. **The schema version a consultation was validated with is the version its workflow run is checked against.** "Follow latest" means the tenant's pin at RUN time; an explicitly pinned trigger keeps its pin. `open` learns BEFORE dispatch whether the governing workflow accepts the payload and refuses synchronously with the house 400 shape — but only when the check is conclusive; an unresolvable dependency falls through to today's ungoverned open, never to a refusal.
2. **Publish shows impact; it never silently changes what a workflow accepts.** "Used by N workflows · M agents" with a verdict per consumer, before confirming.
3. **What the client sends is available to every prompt, through one shared reader** with injected decrypt and per-consultation memoisation.
4. **One vocabulary per fact.** Run status: `COMPLETED | FAILED | CANCELED | TIMED_OUT` persisted, plus node counts and a derived `degraded` flag, identical on both surfaces. Context item: `kindKey` visible wherever the item is. Refusal codes: exported values, not JSDoc.
5. **Console: fewer, clearer surfaces.** A record with many details gets a page, one primary action, presets before checklists, progressive disclosure inside the kind editor.
6. **Docs are part of the deliverable and cannot drift**: examples are compiled files, constants are imported, a `docs:check` gate verifies every scope, code and method name in the guides against the code.

### 3.2 Changes by area

#### A. Prompt variables from client context (E4)

| Change | Where |
|---|---|
| New leaf module `client-clinical-context.ts` (imports neither `prompt/` nor `live-documentation/`): `CLIENT_KIND_KEYS`, `latestContextItemOfKind`, `readClientKindPayload(entity, decrypt)` with `decrypt` injected, `formatClientVitalsForPrompt`, `formatPreviousVisitsForPrompt`, the two payload types, and a `ClientClinicalContextReader` with per-consultation memoisation. `live-documentation.service.ts` becomes a consumer | `packages/applications/src/services/consultation/context/` |
| `ContextItemRepository.findLatestByKindKey(consultationId, kindKey)` (mirrors `findCaseNotes`) | `packages/domains` |
| `PromptAssemblyParams` + `PreSummaryVariableSources` gain `vitals?`, `previousVisits?` (formatted strings); `buildVariables` passes them; the stale comment is replaced by the rule | `prompt-assembly.service.ts` |
| Every `assemble()` caller (`generatePreSummary`, `generateSummary`, `harness-internal`, both processors, chain summary) reads the client kinds through the reader and passes them | `summary/`, `harness/`, `jobs/` |
| `handoffClinicalContext` passes `vitals` and `previousVisits` (persisted PRE items, readable after the session); `live-handoff.dto.ts` description updated | `live-documentation.service.ts:6644` |
| Pre-summary input records wrapped as `section="case_notes"` (header `CASE NOTES`), not `transcript`; when the client sent `previous_case_notes`, `formatted_previous_visits` carries them and the same entries are NOT repeated as case-note records — OD-3 | `prompt-assembly.service.ts`, `summary.service.ts` |
| Department live templates: assembly appends `section="recent_vitals"` and `section="previous_case_notes_summary"` data blocks whenever non-empty; template text untouched, no seed regeneration — OD-4 | `live-documentation/realtime/*` |

Acceptance: re-run journey 2 → the pre-summary prompt captured from LM Studio shows `Recent Vitals: BP 128/82 mmHg · HR 88 bpm · …` and `Previous Visits:` with both notes; the live-lane prompt carries the two data blocks; the harness handoff carries `formatted_previous_visits` non-empty; no note text appears twice in one prompt.

#### B. Schema evolution interlock (E1, E3)

| Change | Where |
|---|---|
| **Usages.** `WorkflowDefinition.contextSchemaId String?`, `contextSchemaVersionNumber Int?`, `contextSchemaFollowsLatest Boolean @default(false)` (indexed), stamped at publish from the compiler's resolution; backfill from `compiledConfig.policyBindings.contextSchemaRefs[]`; the three columns ADDED to the PUBLISHED-row immutability guard in the same migration (`task_982_*`, shadow-DB recipe, hand-authored entity/factory/mapper/repo, never `gen:mapper`). `IConsultationContextSchemaService.usages(schemaId, againstVersion?)` → `{ workflows: [{ id, slug, name, versionNumber, isActive, binding: 'latest' \| 'pinned', boundVersion, verdict: 'accepts' \| 'refuses', problems[] }], agents: [...] }`; route `GET admin/consultation-context-schemas/:id/usages`; `publish` and `pin` responses embed `impact` (same shape, computed against the version being published/pinned) | database, domains, applications, api |
| **Classification is honest about consumers.** `classifyDefinitionChange` also iterates NEW kinds and returns `additions[]` (classification stays `ADDITIVE`); `publish` requires `acknowledgeImpact: true` when any bound consumer `refuses` (distinct code `SCHEMA_IMPACT_UNACKNOWLEDGED`, same gate shape as `allowBreakingChange`) — OD-1 | applications |
| **Follow-latest honoured at run time, through the per-run config.** The compiler freezes `contextSchema.followsLatest` beside `resolved` (the version/versionId already ride `policyBindings.contextSchemaRefs[]`). At dispatch — both paths, since both mint the per-run `configRef` — the gateway resolves the EFFECTIVE schema (pinned → frozen `resolved`; follows-latest → the tenant's current pin, derived with `payloadSchemaFromDefinition`) and writes it as `contextSchema.resolved` in the per-run compiled config. `interpreter_core_trigger` is UNCHANGED (still validates `resolved`, no DB read, no new request field, no replay concern). The two invariant texts (`compiler.ts:391`, `compiled-config.schema.json:356`) are rewritten to state the new rule: "a PINNED trigger validates against the schema the workflow was published with; a FOLLOW-LATEST trigger validates against the tenant's pin at dispatch, resolved by the gateway and frozen into that run's config" — D-1 | workflow-contract, applications |
| **Pre-dispatch compatibility check at open.** On the CREATE path only, after the idempotent re-open lookup and before the meter unit, row and context items are written: resolve the governing workflow, derive its effective schema, validate the authored context with `jsonSchemaValueProblems`. Refusal → **400 `WORKFLOW_CONTEXT_INCOMPATIBLE`** `{ message, code, workflowDefinitionSlug, boundSchemaVersion, problems[] }`, nothing written. Inconclusive (workflow unresolvable, config unreadable) → proceed exactly as today (ungoverned open + warning log) — D-2, OD-2 | applications |
| **Async failure is surfaced.** `failGovernedRun` handles a terminal FAILED/TIMED_OUT while the consultation is `OPEN` / `RECORDING` / `PRIMED`: stamps `metadata.governingEngine.runStatus = 'FAILED'` + `terminalReason`, emits the sys-event and a live-summary SSE `workflow.failed` event; consultation status unchanged — OD-5. `ConsultationResponse.governingRun: { slug, runId, status, decidedAt, failureReason? } \| null` derived from the marker (no live harness call per GET); `GET consultations/:id/workflow` returns the same object | applications, api, both SDKs |
| `WorkflowSchemaDescription` gains `contextSchema: { schemaId, slug, versionNumber, followsLatest } \| null` and `reviewNodes: [{ nodeId, label }]` | applications |
| Contract fixtures under `tests/contracts/` for the per-run compiled-config `contextSchema` block and the run-completed counts (the TS↔Python parity idiom); `compiled-config.schema.json` snapshot refreshed | tests, workflow-contract |

Acceptance: (a) re-run the S3 probe with the GEN workflow pinned to v1 → `open` answers 400 `WORKFLOW_CONTEXT_INCOMPATIBLE` naming `referral`, nothing written; with the GEN workflow on follow-latest (the seeded state) the same open succeeds and `core.trigger` passes; (b) the publish response and console show 11 workflows (follow latest, accepts) for an additive publish and red rows + acknowledgement for a pinned refuser; (c) a run failing after open flips `governingRun.status` to FAILED within the watcher's window and the console shows it; (d) harness replay-compat suite green, no `workflow.patched` needed.

#### C. Run status alignment (E6)

| Change | Where |
|---|---|
| Interpreter's `workflow.run.completed` event carries `nodeCount`, `failedNodeCount`, `degradedNodeCount`, `skippedNodeCount`; `recordTerminal` persists them into the EXISTING columns | harness, api |
| The live `WorkflowRunStatusResponse.status` is mapped through `terminalStatusOf` before the `TERMINAL_RUN_STATUSES` check (the set is NOT widened; DEGRADED stays a flag, no enum change); both surfaces expose `degraded: boolean` + the counts; vox-node / browser `useWorkflowRun` types follow; `run-status-badge.tsx` renders "Completed with warnings" from the flag | applications, SDKs, console |
| Warm-start pre-summary gets ONE bounded retry after a transient failure, governed by a `global-kv` descriptor `consultation.preSummary.retry.attempts` (default 1, `failMode: open-to-default`) — never a literal | applications, settings registry |

#### D. SDKs, codegen, seed (E2, E3)

| Change | Where |
|---|---|
| `API_KEY_SCOPE_PRESETS` in **`@arcaai/types`** (the seed can import only that package): `consultation-app`, `types-codegen`, `agents-and-workflows`, each `{ key, label, description, scopes[] }`; the scope registry re-exports and validates every preset scope exists; `SDK_DAY_ONE_SCOPES` = union of the first two + today's self-service scopes (adds `agent:definition:read`, `workflow:definition:read`); seed test pins the list; `GET admin/api-keys/scopes` returns `presets` beside the catalogue — D-6 | types, applications, database seed |
| Refusal codes as exported values: `OPEN_REFUSAL_CODES` / `OpenRefusalCode` union in `@arcaai/types`, used by the gateway's `open` path, re-exported by both SDKs, re-exported by codegen | types, applications, SDKs, codegen |
| `ContextItemResponse` + mapper project `kindKey`, `contextSchemaVersionId`; vox-node adds `ContextItemResponse.kindKey`; the browser `ContextItem.kindKey` finally fills (no type change needed) | applications, SDKs |
| vox-node: `open<TContext extends Record<string, unknown>>(request: OpenConsultationRequest<TContext>)`; `consultations.listContext(id)`; `ConsultationGetResponse` = same partial view as `ConsultationOpenResponse` (adds `language`, `metadata`, `parentConsultationId`, `governingRun`); `HopeAPIError.problems?: string[]` lifted in `fromResponse`; `workflows.reviews.*` documented; example `06-realtime-consultation.ts` covering open → record → stream → stop → release the gate → approve → close | vox-node |
| Browser SDK: `AgenticError.context.problems`; `governingRun` on `useArcaSession()`'s consultation view and `useConsultationWorkflow`; `useConsultationSchema` documents (and, where the workflow is pinned, warns about) validating against the session bundle vs the workflow's bound version; `useWorkflowRun` exposes `degraded` + counts | agentic-sdk-v2 |
| Codegen: tenant-schema mode also emits `OpenConsultationContext` (the client-produced PRE kinds, so no hand-written `Pick`) and `@schemaVersion`; catalogue mode emits `@contextSchema <slug> vN (follows latest \| pinned)` and `reviewNodes` per workflow; **`--check`** for both modes (regenerate in memory, diff, exit 1) as the CI recipe; ticket numbers removed from generated JSDoc | vox-codegen |
| Five artifacts regenerated (`api:build`, route manifest, `api:openapi`, `api:portal` — which also emits `openapi.business.json` — and `vox-node gen:admin`), all `:check`s green | api |
| Release: one lockstep minor (3.6.0) for the nine linked packages; CHANGELOGs name the new methods/types with their scopes, `governingRun` superseding the raw `metadata.governingEngine` read, the NEW 400 `WORKFLOW_CONTEXT_INCOMPATIBLE` refusal on an existing call (with a read-this banner), `problems[]`, and codegen `--check` + the two emitted types — OD-7 | all SDK packages |

#### E. Admin console (E1, E5, simplicity)

Design rules for this lane: one primary action per surface; no tab where a line or a menu will do; a page for a record with many details; `ConfirmDialog` for confirmations; presets before checklists; progressive disclosure inside the kind editor; every verdict carries text, never colour alone; axe 0 violations and both themes on every touched surface including dialogs.

| Surface | Change |
|---|---|
| `/context-schemas/[id]` (NEW PAGE, `ScreenTemplate contentMode="scroll"`, replaces the `xl` drawer) | ONE column. Header: name · status · `Default` · `Pinned vN`; actions: **Publish** (only primary) + `⋯` menu (Rename & settings → 5-control dialog; Delete → type-to-confirm). One line under the header: `Used by 11 workflows · 2 agents — all accept v3.` with a `View` link opening a plain dialog of rows (name · `follows latest` / `pinned vK` · verdict text). Two line-variant tabs, deep-linkable (`?tab=definition\|versions`): **Definition** (the editor) · **Versions** (list + Pin). Tester becomes a "Try a sample payload" button inside each kind (modal). Footer: `Draft · 4 kinds, 1 output · unsaved changes` / `Saved`. Segment `loading.tsx` skeleton (header + tabs + three collapsed rows); not-found copy "This context schema does not exist or is outside your access scope."; a route-change guard when the draft is dirty ("You have unpublished changes to this definition. Leave without publishing?"). The list row navigates to the page; the drawer is retired — D-5 |
| Kind editor (inside the existing accordion) | Three disclosures: **Basics** open (Key, Label, Primitive, Produced by, Required, Description — 6 controls); **Field roles** collapsed (the existing `FieldRoleTable`, header "Mark which fields tell HOPE the clinician, the department, the visit type or your own reference id."); **Advanced** collapsed (PHI class, Cardinality, Lifecycle, Fields JSON Schema, MIME types, Max bytes, Deprecated, Remove kind). First sight per kind: 23 → 6. Badge `Ext. ref` → `Reference id` |
| Publish confirmation (`ConfirmDialog` extended with `body` + optional `acknowledgement`) | Change reason moves here. Copy leads with the effect: *all accept* — "Publish version 4? This adds one new kind, `referral`. Nothing is removed or renamed, so apps built on version 3 keep working. 11 workflows follow the latest version and will accept it. None will refuse it."; *some refuse* — "Publish version 4? 2 workflows will refuse it … pinned to an older version. They will refuse any consultation that sends `referral` until you republish them: · Cardiology intake — pinned v2 …" + checkbox "I understand these 2 workflows will refuse new consultations until they are republished." (Publish disabled with the label as its visible reason until ticked); *breaking* — "This change breaks apps already using version 3 · Removes the kind `vitals` … " + checkbox "I understand existing integrations will stop working until they are updated." → **Publish anyway** (destructive) |
| Workflow studio trigger field | Helper text only. Follow latest: "This trigger uses whichever version is pinned under Context Schemas — currently v3. Publishing and pinning a new version takes effect here immediately, with no republish." Pinned: "This trigger always validates against v2, whatever the schema is pinned to. Republish this workflow to move it." |
| Consultation detail (`consultation-detail-panel.tsx`, in the `<dl>` right after Status, `col-span-2`) | `MetaItem label="Workflow"`: not governed → "Not governed by a workflow" (muted); running/completed → `<slug>` · chip · `View run →`; degraded → chip "Completed with warnings"; failed → chip "Failed" · `View run →` + muted line "This consultation ran without its workflow. Reason: the context didn't match what the workflow accepts." + raw reason in `font-mono text-xs`. From `governingRun`, no extra request |
| `/api-keys` create dialog (one dialog, reordered) | **Purpose** (4 radio cards: **Consultation app** "For a clinic app that opens consultations, streams audio and reads summaries." · **Type generation (build tools)** "For a build pipeline that generates TypeScript types from this tenant's schema and catalogue. Read-only." · **Agents & workflows** "For a server that calls this tenant's published agents and runs its workflows." · **Custom** "Choose individual permissions yourself.") → Name → Expires → `▸ Show all scopes (12 selected)` (the 99, collapsed, editable) → Cancel / Create. Visible controls 103 → 9. Raw-key reveal unchanged |
| `/developer` | A **Context schema & codegen** SECTION on the existing developer page (no new nav entry): one command per credential, the generated-type example incl. `OpenConsultationContext`, reading `@contextSchema`, the `--check` CI line, the refusal-code table and preset table RENDERED FROM the `@arcaai/types` constants; links to the two guides |

#### F. Documentation (E7)

| Deliverable | Contents |
|---|---|
| `docs/guides/client-integration-guide.md` — **Client-side Development & Integration Guide** | 1 Credentials (API key presets vs service account; who issues what) · 2 Generate types (both modes, exact scopes, `--check` in CI) · 3 Open a consultation with typed context (every marker, every refusal code incl. `WORKFLOW_CONTEXT_INCOMPATIBLE`, `problems[]`) · 4 Read back context items (`listContext`, `kindKey`) · 5 Stream audio (`stt`, socket, metadata) · 6 Live summary and events (incl. `workflow.failed`) · 7 Stop, release the review gate (`reviews.get/decide`, finding the node via `reviewNodes`), approve (`ifMatch`), close (`ifMatch`, legal states) · 8 Read the note and the governing run · 9 Completion signals: polling vs the run-completed webhook — ONE answer, resolved against the code · 10 Browser SDK equivalents per step · 11 Idempotent re-open, "you cannot list your runs", inbound webhooks, known gaps (ported from the current guides) · 12 Appendix: what changed per SDK minor. Every snippet > 3 lines is a compiled file under `packages/vox-node/examples/` (or the browser SDK's) with a one-line pointer; the two existing developer guides become pointer stubs — OD-8 |
| `docs/guides/tenant-admin-user-guide.md` — **Tenant Admin User Guide** (click-paths, one screenshot per task) | 1 Sign in and orient · 2 Departments (the code the integrator sends) · 3 Clinicians and auto-provisioning (unknown staff id behaviour) · 4 Consent and PHI posture before the first consultation · 5 Define the context schema (kinds, roles, what the client must send) · 6 Publish and read "Used by" (accepts / refuses / breaking; acknowledge; roll back by pinning) · 7 Agents per department (ASR, note agents) · 8 Workflows (trigger: follow latest vs pinned; department assignment) · 9 Issue an API key from a preset; when a service account is needed and who issues it · 10 Watch a consultation (status, Workflow row, opening a failed run) · 11 What each refusal means to your integrator · 12 Troubleshooting: five symptoms → the screen that answers |
| Package READMEs + CHANGELOGs | vox-node: reviews, approve → close, `governingRun`, `listContext`, `problems`, typed `open`; vox-codegen: the two catalogue scopes, `--check`, `OpenConsultationContext`, `@contextSchema`; browser SDK: `kindKey`, `problems`, `governingRun` |
| `docs:check` gate (`scripts/check-docs-constants.ts`, the `api:portal:check` shape) | Every scope string, refusal code and SDK method name in a fenced block of `docs/guides/*.md` must exist in `@arcaai/types` presets/registry, the refusal union and the SDKs' public `index.ts`; wired into `pnpm verify` |

### 3.3 Lanes, tiers, order

Execution model: pinned contracts per lane (§3.4, written by the orchestrator BEFORE any lane spawns), one worktree per writer, no lane runs gates, the orchestrator merges into `dev-2.2` and gates. Every brief starts with `git merge --ff-only dev-2.2` plus a file-existence proof of its base, and states its boundary, its rules files, and its return contract.

| Lane | Tier / effort | Owns | Must honour |
|---|---|---|---|
| **W1 contracts** (orchestrator) | — | §3.4: TS interfaces, `@arcaai/types` constants (presets, refusal union), route paths, error codes, migration SQL, harness event fields, per-run config block | — |
| **A prompt context** | opus-5 / high | §3.2 A | leaf module; injected decrypt; memoised; every `assemble()` caller; one note once per prompt |
| **B1 usages + publish impact** | opus-5 / high | migration + backfill + guard extension, usages service/route, `impact` in publish/pin, `additions[]`, `acknowledgeImpact`, `WorkflowSchemaDescription.contextSchema/reviewNodes` | shadow-DB recipe; hand-authored trio; no cross-tenant read |
| **B2 dispatch + failure** | opus-5 / high | compiler `followsLatest`, effective-schema resolution into the per-run config on both dispatch paths, pre-dispatch 400 on the create path, `failGovernedRun` widening + SSE + sys-event, `governingRun`, invariant texts, contract fixtures | harness code untouched except the completed-event counts (lane C); replay suite green |
| **C run status + retry** | sonnet-5 / medium | §3.2 C | vocabulary and event fields from W1 |
| **D SDKs + codegen + seed** | sonnet-5 / medium (opus-5 review pass on the public types) | §3.2 D | types mirror W1; vox-node keeps zero runtime deps; both SDKs or state why not |
| **E console** | opus-5 / high | §3.2 E | the design rules; control counts in the report; axe 0 on page AND dialogs; both themes |
| **F docs** | sonnet-5 / medium, after A–E merge | §3.2 F | every command run against the dev gateway; no ticket numbers; `docs:check` green |
| **G acceptance** (orchestrator) | — | five artifacts, seed test, all gates, SDK 3.6.0 versioning, then the two journeys + S3 probe re-run with the typed client (now on `OpenConsultationContext`, `listContext`, `governingRun`) and LM Studio prompt capture; console walkthrough in the browser pane producing the guide's screenshots | the acceptance lines of §3.2 |

Order: W1 → {A, B1, C, D} → {B2 (needs B1 columns), E (needs B1 route + D presets; starts on mocks)} → F → G.

### 3.4 Pinned contracts (W1, written 2026-09-17 before any lane spawned)

Every lane implements EXACTLY these names and shapes. A lane that needs a different shape stops and reports; it does not improvise.

#### 3.4.1 `@arcaai/types` (lane D owns the files; every other lane imports)

`packages/types/src/consultation-context.ts` (exported from `index.ts`):

```ts
/** Every refusal `POST consultations/open` can answer with a 4xx `{ message, code, problems? }` body. */
export const OPEN_REFUSAL_CODES = [
  'CONTEXT_SCHEMA_VIOLATION', 'DEPARTMENT_UNKNOWN', 'DEPARTMENT_AMBIGUOUS', 'DEPARTMENT_MISMATCH',
  'VISIT_TYPE_INVALID', 'CLINICIAN_REQUIRED', 'CLINICIAN_MISMATCH', 'CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER',
  'USER_IDENTITY_UNKNOWN', 'USER_IDENTITY_AMBIGUOUS', 'USER_IDENTITY_INVALID', 'USER_IDENTITY_NOT_USABLE',
  'USER_IDENTITY_DEPARTMENT_UNRESOLVED', 'WORKFLOW_CONTEXT_INCOMPATIBLE',
] as const;
export type OpenRefusalCode = (typeof OPEN_REFUSAL_CODES)[number];

/** The governing run of a consultation, derived from `Consultation.metadata.governingEngine`. */
export interface GoverningRunSummary {
  workflowDefinitionSlug: string;
  workflowRunId: string;
  /** Persisted vocabulary only — never the interpreter's `SUCCEEDED`/`DEGRADED`. */
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT';
  /** True when the run finished with at least one degraded or skipped-for-cause node. */
  degraded: boolean;
  decidedAt: string;
  failureReason: string | null;
}
```

`packages/types/src/api-key-presets.ts` (exported from `index.ts`):

```ts
export type ApiKeyScopePresetKey = 'consultation-app' | 'types-codegen' | 'agents-and-workflows';
export interface ApiKeyScopePreset { key: ApiKeyScopePresetKey; label: string; description: string; scopes: readonly string[] }
export const API_KEY_SCOPE_PRESETS: readonly ApiKeyScopePreset[];
// consultation-app      = consultation:session:{read,write}, consultation:report:{read,write}, stt:transcription:{read,write}, stt:stream:write,
//                          stt:model:read, tts:speech:write, tts:voice:read, tenant:context-schema:read, tenant:profile:read,
//                          user:profile:read, user:preferences:{read,write}, user:settings:{read,write}, prompt:template:read, dna-writing-style:ingest
// types-codegen         = tenant:context-schema:read, agent:definition:read, workflow:definition:read
// agents-and-workflows  = agent:definition:read, agent:invocation:write, workflow:definition:read, workflow:run:read, workflow:run:write, workflows:execute
```

Labels/descriptions are the §3.2 E copy verbatim. The seed's `SDK_DAY_ONE_SCOPES` = the de-duplicated union of `consultation-app` + `types-codegen` + `webhook:event:{read,write}` + `platform:changelog:read` + `tenant:account:read` (everything today's list has, plus the two catalogue scopes). `apikey-scopes.registry.ts` re-exports the presets and a unit test asserts every preset scope is a registry key and none is `reserved`.

#### 3.4.2 Gateway response shapes (lane B2 adds `governingRun`; lane D adds the context-item fields; lane B1 adds the workflow-schema fields)

```ts
// ConsultationResponse (open, GET, list) — applications dto/consultation.response.ts
governingRun: GoverningRunSummary | null;        // ALWAYS present (null when ungoverned)

// ConsultationWorkflowResponse — GET consultations/:id/workflow
run: GoverningRunSummary | null;                 // beside the existing fields

// ContextItemResponse — GET consultations/:id/context
kindKey: string | null;
contextSchemaVersionId: string | null;

// WorkflowSchemaDescription — GET workflows/:slug/schema
contextSchema: { schemaId: string; slug: string; versionNumber: number; followsLatest: boolean } | null;
reviewNodes: Array<{ nodeId: string; label: string }>;   // every core.humanReview node, graph order

// WorkflowRunStatusResponse — GET workflows/:slug/runs/:runId, and WorkflowRunResponse (admin list)
status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT';   // mapped through terminalStatusOf; never SUCCEEDED/DEGRADED
degraded: boolean;
nodeCount: number | null; failedNodeCount: number | null; degradedNodeCount: number | null; skippedNodeCount: number | null;
```

`metadata.governingEngine` marker (applications `governing-engine.ts`) gains optional `runStatus`, `degraded`, `terminalReason`, `endedAt`; `GoverningRunSummary` is derived from it by one pure function `governingRunOf(metadata)` in the same file (status defaults to `RUNNING` when `runStatus` is absent).

#### 3.4.3 Schema usages + impact (lane B1)

```ts
// GET admin/consultation-context-schemas/:id/usages?againstVersion=<n>   (default: the pinned version)
export type ContextSchemaBinding = 'latest' | 'pinned';
export type ContextSchemaVerdict = 'accepts' | 'refuses' | 'unknown';
export interface ContextSchemaWorkflowUsage {
  definitionId: string; slug: string; name: string; versionNumber: number; status: WorkflowDefinitionStatus; isActive: boolean;
  binding: ContextSchemaBinding; boundVersion: number | null; verdict: ContextSchemaVerdict; problems: string[];
}
export interface ContextSchemaAgentUsage {
  agentId: string; slug: string; name: string; versionNumber: number; status: AgentStatus; isActive: boolean;
  binding: ContextSchemaBinding; boundVersion: number | null; verdict: ContextSchemaVerdict; problems: string[];
}
export interface ContextSchemaUsagesResponse { schemaId: string; againstVersion: number | null; workflows: ContextSchemaWorkflowUsage[]; agents: ContextSchemaAgentUsage[] }
```

Verdict rule (pure, unit-tested): `binding === 'latest'` → `accepts`. `pinned` → derive the target version's payload schema; every kind key the target admits that the bound version's frozen `resolved.properties` lacks is one problem `"/<kindKey>: not declared in the bound version v<n>"`; any problem → `refuses`, else `accepts`. `unknown` only when the consumer's compiled config cannot be read. Only ACTIVE (`isActive`) PUBLISHED consumers count toward the acknowledgement gate; others are listed with their status.

`publish` and `pin` responses (`ConsultationContextSchemaResponse`) gain `impact: ContextSchemaUsagesResponse` computed against the version being published/pinned. `PublishContextSchemaRequest` gains `acknowledgeImpact?: boolean`; when `impact.workflows.some(w => w.isActive && w.verdict === 'refuses') || impact.agents.some(...)` and it is not `true` → **400 `{ message, code: 'SCHEMA_IMPACT_UNACKNOWLEDGED', impact }`**, nothing written. `classifyDefinitionChange` returns `{ classification, breakingChanges, additions: string[] }` where `additions` = new kind keys (classification unchanged).

Columns (`packages/database/src/prisma/db_main/workflow-definition.prisma`, migration folder name `<timestamp>_task_982_workflow_definition_context_schema_binding`):

```prisma
contextSchemaId            String?
contextSchemaVersionNumber Int?
contextSchemaFollowsLatest Boolean @default(false)
@@index([tenantId, contextSchemaId], name: "WorkflowDefinition_tenantId_contextSchemaId_idx")
```

Backfill in the same migration: `contextSchemaId`/`contextSchemaVersionNumber` from `compiledConfig->'policyBindings'->'contextSchemaRefs'->0` (the trigger's entry); `contextSchemaFollowsLatest = true` when the trigger node's `graph` config `contextSchema` has a `contextSchemaId` and no `versionNumber`. The `workflow_definition_immutability_guard` function is `CREATE OR REPLACE`d with the three columns added to its `IS DISTINCT FROM` list. Entity/factory/mapper/repository are hand-authored (`gen:model` for the model only; `gen:mapper` is never run).

#### 3.4.4 Compiler + per-run config + dispatch (lane B2; compiler file shared with B1 only through `followsLatest`, which B1 does NOT touch)

- `ResolvedTriggerContextSchema.followsLatest: boolean` (workflow-contract). `compiledConfigFor` writes `contextSchema.followsLatest` beside `resolved`. `compiled-config.schema.json`: add `followsLatest` (boolean, optional, default false) under the trigger's `contextSchema`, and rewrite the two invariant descriptions to: *"A PINNED trigger validates against the schema the workflow was published with. A FOLLOW-LATEST trigger validates against the tenant's pin at dispatch: the gateway resolves it and freezes it into THAT RUN's config before the run starts. The interpreter never reads a schema row."* `compiler.ts:391` comment likewise.
- Effective schema at dispatch (both paths: `ConsultationWorkflowDispatchService.dispatchForConsultation` and `WorkflowExposureService.startRun`), one pure helper `effectiveTriggerConfig(compiledConfig, currentPin)` in applications `services/workflow-exposure/effective-trigger-schema.ts`: when the trigger's `contextSchema.followsLatest === true`, replace `resolved` with `payloadSchemaFromDefinition(pin.definition)`, re-derive `userIdentity`/`openBindings` from the pin, and set `contextSchema.effectiveVersionNumber = pin.versionNumber`; otherwise return the config unchanged. The per-run claim-checked config (`configRef`) is minted from the RESULT. `interpreter_core_trigger` is not modified.
- Pre-dispatch check at `open` (create path only, after the idempotent lookup, before the meter/row/items are written): resolve the workflow the department assignment would select → its effective trigger config → `jsonSchemaValueProblems(effective.resolved, authoredContext)`. Problems → throw `BadRequestException({ message, code: 'WORKFLOW_CONTEXT_INCOMPATIBLE', workflowDefinitionSlug, boundSchemaVersion, problems })`. Any resolution failure (no assignment, config unreadable, schema pin missing) → log at warn and continue exactly as today (ungoverned open).
- `failGovernedRun` accepts `OPEN | RECORDING | PRIMED | DRAINING`; for the three new states it stamps `governingEngine.runStatus = 'FAILED'`, `terminalReason`, `endedAt`, leaves `status` unchanged, broadcasts the existing sys-event, and publishes one live-summary SSE frame `{ event: 'workflow.failed', consultationId, workflowRunId, workflowDefinitionSlug, reason }`. The completion watcher also stamps `runStatus`/`degraded`/`endedAt` on COMPLETED.

#### 3.4.5 Run-completed counts (lane C)

Harness `RunEventSpec` gains `node_count: int | None`, `failed_node_count`, `degraded_node_count`, `skipped_node_count` (all optional, default `None`); `_emit_run_completed` fills them from the settled node results (`DEGRADED` and `SKIPPED` nodes count as degraded and skipped respectively). The emitted envelope carries `nodeCount`, `failedNodeCount`, `degradedNodeCount`, `skippedNodeCount` (camelCase). Applications `RecordRunFinishedInput` gains the same four optional numbers; `WorkflowRun` rows are written from them; `WorkflowRunCompletionService.recordTerminal` passes them; the live `getRunStatus` maps `upstream.status` through `terminalStatusOf` (fallback `RUNNING`) and computes `degraded = (degradedNodeCount ?? 0) + (skippedNodeCount ?? 0) > 0 && status === 'COMPLETED'`. `TERMINAL_RUN_STATUSES` is unchanged. Parity fixture `tests/contracts/workflow-run-completed.fixture.json` pins the envelope.

Settings descriptor (lane C): key `consultation.preSummary.retry.attempts`, tier `global-kv`, type integer, min 0, max 3, default 1, `failMode: 'open-to-default'`, description "Additional attempts the warm-start pre-summary makes after a transient text-service failure."

#### 3.4.6 Prompt assembly (lane A)

`packages/applications/src/services/consultation/context/client-clinical-context.ts` exports `CLIENT_VITALS_KIND_KEY = 'vitals'`, `CLIENT_PREVIOUS_CASE_NOTES_KIND_KEY = 'previous_case_notes'`, `ClientVitalsPayload`, `ClientPreviousCaseNote`, `latestContextItemOfKind`, `formatClientVitalsForPrompt`, `formatPreviousVisitsForPrompt`, and `class ClientClinicalContextReader { constructor(repo: ContextItemRepository, decrypt: (entity) => Promise<string>); read(consultationId): Promise<{ vitals?: string; previousVisits?: string; raw: {...} }> }` memoised per `consultationId` for the reader instance's lifetime. `PromptAssemblyParams` and `PreSummaryVariableSources` gain `vitals?: string; previousVisits?: string`. `wrapExternalData` sections added: `case_notes` (header `CASE NOTES`), `recent_vitals` (header `RECENT VITALS`), `previous_case_notes_summary` (header `PREVIOUS CASE NOTES SUMMARY`). `generatePreSummary` passes the case-note records as `caseNotes` (rendered under `case_notes`), not as `transcript`; when the client `previous_case_notes` kind exists, `previousVisits` is built from it and the matching `CASE_NOTE` records (same `text`) are excluded from `caseNotes`.

#### 3.4.7 SDK surfaces (lane D)

vox-node: `HopeAPIError.problems?: string[]`; `open<TContext extends Record<string, unknown> = Record<string, unknown>>(request: OpenConsultationRequest<TContext>)`; `consultations.listContext(id, options?) → ContextItemResponse[]` (`GET consultations/:id/context`); `ConsultationGetResponse` adds `language?`, `metadata?`, `parentConsultationId?`, `governingRun`; `ConsultationOpenResponse` adds `governingRun`; `WorkflowRunStatus` adds `degraded`, the four counts; `WorkflowSchemaDescription` mirror adds `contextSchema`, `reviewNodes`; re-export `OPEN_REFUSAL_CODES`, `OpenRefusalCode`, `GoverningRunSummary`, `API_KEY_SCOPE_PRESETS` from `@arcaai/types` (a `dependencies` entry on the workspace package is allowed — it is types and constants, zero runtime deps remain true; confirm with `check:exports`/publint). Browser SDK: `AgenticError.context.problems`, `governingRun` on the session's consultation view + `useConsultationWorkflow`, `useWorkflowRun` exposes `degraded` + counts, `useConsultationSchema` JSDoc caveat. Codegen: `--check` (both modes; exit 1 + unified diff), `export type OpenConsultationContext = { <kind>?: <KindPayload> }` for every STRUCTURED kind with `lifecycle: 'PRE'` and `producedBy` including `CLIENT` (required when the kind is `required: true`), `@schemaVersion <n>` header tag, `@contextSchema <slug> v<n> (follows latest | pinned)` per workflow, `@reviewNodes n_review` per workflow, and NO ticket numbers in emitted text.

### 3.5 Decisions taken (owner may override)

| # | Decision | Why |
|---|---|---|
| D-1 | "Follow latest" is honoured at RUN time by resolving the effective schema into the per-run compiled config; pinned triggers stay frozen; the harness trigger code is unchanged | It is what the console already promises; uses the existing per-run `configRef`; no new request channel, no replay concern; the two invariant texts are rewritten rather than quietly broken |
| D-2 | Incompatibility is refused synchronously at `open` with the house **400** shape, on the create path only, and only when the check is conclusive | A consultation that silently loses its governing workflow is worse than a precise refusal; 422 would be the API's only one; re-opens never dispatched and must keep working; a dependency outage must never stop a clinician |
| D-3 | Publish stays `ADDITIVE` for a new kind but requires `acknowledgeImpact` when a bound consumer would refuse | Client compatibility and consumer compatibility are two facts, two gates |
| D-4 | Client vitals / previous notes reach prompts through assembly DATA blocks and the existing variables, not template edits | No content regeneration; tenants' own templates keep working |
| D-5 | The context-schema detail moves from the `xl` drawer to a one-column page with a single primary action | The owner's rule; four tabs and 23-control kinds do not fit a drawer |
| D-6 | Scope presets and the refusal-code union live in `@arcaai/types` | The seed, the registry, both SDKs, codegen and the console can all import it — Day-1 alignment by construction |
| D-7 | `governingRun` is derived from the persisted marker, updated by the completion watcher | Latency and blast radius |
| D-8 | Pre-summary retry count is a `global-kv` setting, default 1, open-to-default | Tuning knob, not a literal |
| D-9 | DEGRADED remains a per-run FLAG (counts + `degraded: boolean`), never a persisted status | Existing owner decision on the run model; the count columns already exist |
| D-10 | Codegen ships `--check`, `OpenConsultationContext`, `@contextSchema`, and drops ticket numbers from generated files | Drift must be mechanical, not eyeball; customers read generated code |

### 3.6 Open decisions for the owner (OD)

| # | Question | Options | Recommendation |
|---|---|---|---|
| OD-0 | Ticket number | TASK-982 / other | TASK-982 |
| OD-1 | Publish that would make a PINNED consumer refuse: acknowledge checkbox (recommended) / refuse until the workflow is republished / warn only | ack / refuse / warn | **ack** |
| OD-2 | Incompatible governing workflow at `open`: refuse 400 (recommended) / open UNGOVERNED with a marker | refuse / ungoverned | **refuse** (inconclusive checks still fall through to ungoverned) |
| OD-3 | Pre-summary input labelled `case_notes` and client `previous_case_notes` rendered once via `formatted_previous_visits` | as proposed / keep `transcript` | **as proposed** |
| OD-4 | Department live templates receive vitals / prior notes as appended data blocks vs. editing the v3 templates | data blocks / template edit | **data blocks** |
| OD-5 | A governed run failing after open: consultation status unchanged + `governingRun.status = FAILED` vs. a new terminal status | unchanged / new status | **unchanged** |
| OD-6 | Preset names and contents (§3.2 D/E) | as proposed / edit | **as proposed** |
| OD-7 | SDK release: lockstep minor 3.6.0 when D lands, or the next release train | now / later | **now** |
| OD-8 | Retire the two existing developer guides to pointer stubs once the new guide exists (their load-bearing sections are ported, §3.2 F item 11) | stubs / keep both | **stubs** |
| OD-9 | Run-completed webhook: the code says the `WorkflowRun` sys-event fires; the vox-node README says "poll". Lane F documents ONE answer after verifying live — confirm the intended posture | webhook + poll / poll only | **webhook + poll** |
| OD-10 | Tenant Admin User Guide screenshots: taken from the dev console by lane G (13, listed in §3.2 F) and committed under `docs/guides/images/` | commit / link to the live console | **commit** |

## 4. Verification

Gates per affected package (build / lint / typecheck / test), harness unit + replay-compat, seed test, contract fixtures, the five artifacts and their `:check`s, `docs:check`, console `build lint test` + axe per touched screen and dialog in both themes; then the live acceptance run of §3.3 G with evidence saved beside this README.

## Change History

| Date | Entry |
|---|---|
| 2026-09-17 | Opened from the owner's "plan then align agents" ask after the end-to-end run. Four read-only discovery lanes (console, docs, prompt/freeze plumbing, SDK/seed/status/guardrail). Plan v1 written. |
| 2026-09-17 | Owner: "approved the recommendations, lets go" — OD-0…OD-10 = the recommendations. §3.4 contracts written from the live code shapes. Wave 1 spawned: A (opus), B1 (opus), C (sonnet), D (sonnet) in worktrees off `dev-2.2`; no lane runs gates. Status → **In Progress**. |
| 2026-09-17 | Lane D merged `6d5f54933` (orchestrator fixes: readonly preset arrays in the scopes DTO; lockfile links `@arcaai/types` into the two SDK packages; `@arcaai/types` gains a `test` script). Verified in D's worktree before merge: types 41, seed 46, applications apiKey+context 572, api api-key 23 + tsc clean, vox-node 565 + publint "All good" (no `dependencies` key), browser SDK 3756, codegen 106; lint 0 errors. Deviation accepted: `SDK_DAY_ONE_SCOPES` excludes the two `webhook:event:*` scopes because they are `reserved` (policy A2) and the seed test forbids them on SDK keys. Wave-1 worktrees removed after merge. Lane E (console, opus) spawned off `6d5f54933`; B2 in flight. |
| 2026-09-17 | Wave 1 merged into `dev-2.2`: B1 `92893b60b` (migration replayed on a fresh shadow DB — 45 migrations, empty drift, guard extended; one backfill statement rewritten without a LATERAL reference to the update target), A `b7570d665`, C `0401fefa4` (orchestrator fix: `toStatusResponse` keeps its positional callers, `status` folds by default). Dev DB `db:push`ed to the new columns; `gen:model/entity/factory:check` no drift. Incident: a `pnpm install` run inside a nested worktree rewired the PRIMARY checkout's dependency links and took the dev stack down; repaired with a primary-root install; lanes now get `node_modules` by symlink. B2 spawned off `0401fefa4`; D still running; E waits for D. |
| 2026-09-17 | Three independent reviews (architecture & tenancy rules; console simplicity; Day-1 docs & SDK contract) folded in: follow-latest via the per-run config instead of a harness change; 400 not 422; create-path-only gate that never refuses on an inconclusive check; backfill from `contextSchemaRefs`, immutability guard extended; DEGRADED stays a flag (count columns exist); presets + refusal union in `@arcaai/types`; one-column schema page, kind editor 23 → 6 first-sight controls, publish copy leading with the effect, API-key dialog 103 → 9 visible controls; typed `open`, `listContext`, `reviewNodes`, codegen `--check` + `OpenConsultationContext`, webhook contradiction, 12-chapter admin guide, `docs:check` gate. Status Pending — awaiting OD answers and the go. |
