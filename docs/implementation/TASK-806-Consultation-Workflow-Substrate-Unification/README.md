# TASK-806 — Consultation Workflow Substrate Unification

| Field | Value |
|---|---|
| **Status** | `Pending` — **MASTER ticket**; sub-tickets TASK-808…815 (§7). All decisions answered. No blockers — TASK-808 and the TASK-814 D-25 lane can start immediately. |
| **Type** | `refactor` + `feature` (multi-phase program) |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-08-25 |
| **Supersedes / relates to** | TASK-715/719/721/724/731 (workflow platform), TASK-799 lane B (env-plane collapse), TASK-805 (consent plane) |

> **One-line problem statement.** The Workflow Studio is not missing — it is **disconnected**. A
> complete graph-authoring platform exists, but it does not govern what a clinician actually
> experiences during a consultation; the live loop runs hardcoded TypeScript regardless of what a
> tenant admin authored.

---

## 1. Requirement Analysis

Verbatim owner requirements (2026-08-25), decomposed into acceptance criteria.

### R1 — Tenant admin creates a consultation workflow

> *"entrypoint: define the consultation schema; core: where we control the capabilities, features and
> functions by connecting Agent nodes … endpoint: define sequence of actions before closing the
> session (set timeout, finalize the summary, capture feedback, etc.)"*

| AC | Criterion |
|---|---|
| **AC-1.1** | A single `WorkflowDefinition` spans entrypoint → core → endpoint. The entrypoint **references** the tenant's `ConsultationContextSchema` by id + pinned version — it does not re-declare a schema. |
| **AC-1.2** | The core is a graph in which a **transcription** node, an **NER** node and a **text-generation** node can be connected **to each other in one definition**. |
| **AC-1.3** | Transcription node: input `STREAM_AUDIO` (or a context audio-stream variable), output partial transcript; configuration derives from the audio pipeline. |
| **AC-1.4** | NER node: input is text **or any variable in the context object**; output is extracted entities. |
| **AC-1.5** | Text-generation node: input is text and/or the context object; output is text; configuration is a prompt instruction. |
| **AC-1.6** | Edges are **type-checked** against declared node ports (owner decision D-3: constrained DAG over a typed catalog). An incompatible edge is refused at author time, not at run time. |
| **AC-1.7** | The endpoint is an **admin-ordered, extensible** action sequence. It must express at minimum: set session timeout, finalize the summary, capture feedback. |
| **AC-1.8** | A session timeout runs the endpoint sequence. Timing out must not skip finalization. |

### R2 — Developer configures context + workflow via the Vox SDK

> *"consultation context schema will be fetched from the pre-defined schema set by tenant admin"*

| AC | Criterion |
|---|---|
"Vox SDK" is **two packages**, and requirement R2 splits cleanly across them:
`@arcaai/vox` (browser, React, session-time) and `@arcaai/vox-node` (server, zero-dependency,
configuration-time). "Configure the context and consultation workflow" is a `vox-node` concern;
"for end-user to use" is a `@arcaai/vox` concern.

| AC | Package | Criterion |
|---|---|---|
| **AC-2.1** | `@arcaai/vox` | The SDK fetches the tenant-admin-defined context schema. **(Already met — see §2.4.)** |
| **AC-2.2** | `@arcaai/vox` | The SDK can discover **which workflow governs** a session, and that workflow's declared input schema. |
| **AC-2.3** | `@arcaai/vox` | Owner decision required (**OD-1**, §5): may a developer *select* a workflow at session-open time, or is assignment strictly an admin action? |
| **AC-2.4** | `@arcaai/vox-node` | A developer can author/publish a context schema and a workflow definition, and set its assignment, entirely through `hope.admin.*` — **without hand-editing generated code**. (Largely met today — see §2.6.) |
| **AC-2.5** | `@arcaai/vox-node` | Every gateway surface added or changed by this ticket is reachable from the regenerated `hope.admin.*` plane, with `generate-vox-node-admin-check` green. |
| **AC-2.6** | both | The credential split is explicit in the docs a developer reads: the `/admin/*` configuration plane is **service-account only** (`@ForbidApiKey()`), and `workingTenantId` binds at token **exchange**, so `X-Tenant-Id` is never sent alongside it. |

### R3 — Clinical users run the consultation

| AC | Criterion |
|---|---|
| **AC-3.1** | A clinical user can reach and use the consultation surface. **Per OD-2 this is the tenant-admin playground with clinician impersonation** — not a widened console tier and not a separate clinical app. Blocked today by D-25. |
| **AC-3.2** | They see the live transcript. |
| **AC-3.3** | They see the partial summary as it is generated. |
| **AC-3.4** | They can **add details and information during** the consultation. |
| **AC-3.5** | Failure of the summary stream is visible and unambiguous — never an indefinite "waiting" skeleton. |

---

## 2. Current State Evaluation

Method: five parallel read-only reviewers (admin-console authoring, data model, runtime execution,
Vox SDK, playground UX), followed by orchestrator re-verification of every load-bearing claim
against the working tree on `dev-2.2`. Every claim below carries `path:line` evidence and was
**independently re-read** unless marked *(reviewer-reported)*.

### 2.1 The two-substrate finding — the root cause

| | **Substrate A** — what clinicians see | **Substrate B** — what admins author |
|---|---|---|
| Config artifact | `DepartmentAgent` (flat row) | `WorkflowDefinition` (real graph, `graph Json`) |
| Executor | `LiveDocumentationService.flush()` — hardcoded TypeScript | Temporal `WorkflowInterpreter` |
| Cadence | per-turn, in-process, streams SSE | **one-shot, at consultation OPEN** |
| Tunable surface | 3 booleans, 5 numeric knobs, model/prompt selection | the entire graph |
| Authoring UI | `/agents` | `/workflow-studio` |

The two are held mutually exclusive per consultation via a marker in `Consultation.metadata`
(`governing-engine.ts`) — **but the recording path ignores it**:

`apps/api/src/modules/consultation/consultation.controller.ts:594-599` — `startRecording` calls
`this.liveDocumentationService.start({...})` after only `verifyConsultationOwnership` and
`consultationService.startRecording`. There is **no substrate gate**. The hardcoded loop runs for
every recording session regardless of which engine governs the consultation.

### 2.2 Evidence table — verified defects

| # | Defect | Evidence (re-verified) |
|---|---|---|
| **D-1** | `paletteKey` is immutable and single-palette — *"Create-only by design: `UpdateWorkflowDefinitionRequest` carries no `paletteKey`"* | `packages/applications/src/services/workflow-definition/workflow-definition.service.ts:432-443` |
| **D-2** | Transcription (`stt`) and NER/text-gen (`consultation`) are in **different palettes**, so AC-1.2 is structurally impossible today | registry palettes, `packages/workflow-contract/src/node-registry.ts` |
| **D-3** | All eight `stt.*` interpreter nodes are `DELIBERATE PLACEHOLDERS, not the real execution path`; an STT graph compiles to an `AsrPipeline` YAML side-channel | `apps/harness/src/harness/temporal/interpreter/nodes/stt_placeholder.py:1-6` |
| **D-4** | **Ports are untyped and undeclared.** `WorkflowNodeDescriptor` declares `key/implemented/activityName/classes/paletteKey/critical/externalWrite/timeouts/entitlementKey/configSchema` — **no `inputs`/`outputs`** | `packages/workflow-contract/src/node-registry.ts:46-80` |
| **D-5** | Edge validation checks only that `fromPort`/`toPort` are non-empty strings | `packages/workflow-contract/src/graph-model.ts:34,36,160` |
| **D-6** | Interpreter threads the **whole upstream output object** when a port name does not match | `apps/harness/src/harness/temporal/interpreter/workflow.py:189-201` *(reviewer-reported)* |
| **D-7** | `DEFAULT_POLICY_BINDINGS.contextSchemaVersionId` is hardcoded `null` (as are `promptTemplateRefs`, `entitlementKeys`) and passed unconditionally at every compile — a published graph **never pins the tenant's context schema** | `packages/applications/src/services/workflow-definition/workflow-definition.service.ts:56-62` |
| **D-8** | The graph's entrypoint inlines a **literal** schema with no `schemaId`, over only `TEXT`/`STRUCTURED` — vs the admin schema's five primitives (`STREAM_AUDIO`, `TEXT`, `DOCUMENT`, `IMAGE`, `STRUCTURED`) | `packages/workflow-contract/src/node-config-schemas.ts` *(reviewer-reported)* |
| **D-9** | **17 of 33** node types have no config schema — `passthrough` + all 16 `consultation.*`. `NODE_CONFIG_SCHEMAS` holds 16 entries | `node-config-schemas.ts:322-339` *(corrected — see D-30)* |
| **D-10** | Endpoint sequence is a hardcoded literal; `neverActions` can only **subtract** | `packages/applications/src/services/consultation/loop/loop-config.service.ts:322-330` |
| **D-11** | No feedback-capture node/activity exists anywhere | absence across `node-registry.ts`, `registry.py` |
| **D-12** | Idle timeout deliberately **does not run ending actions** on expiry — so a timed-out consultation never finalizes | `harness-loop.descriptors.ts:41` *(reviewer-reported)* |
| **D-13** | Live capability surface is 3 booleans: `LIVE_TOOL_KEYS = ['ner','vitals','groundedness']` | `packages/applications/src/services/departmentAgent/constants.ts:61` |
| **D-14** | NER input hardcoded to `delta \|\| transcript`; its input type carries `sourceText` and nothing else *by design* | `live-documentation.service.ts:1176`, `live-tool-registry.ts:71-82` *(reviewer-reported)* |
| **D-15** | Only the `summarization` palette is invokable over the exposure plane — `EXPOSURE_ALLOWED_PALETTES = new Set(['summarization'])` | `packages/applications/src/services/workflow-exposure/exposure-palette-policy.ts:61` |
| **D-16** | **Clinical users cannot reach the consultation surface**: `notFound()` for anyone not elevated / `TENANT_ADMIN`. `DOCTOR` and `NURSE` are real seeded roles | `apps/admin-console/src/app/(console)/(tenant)/layout.tsx:13-19` |
| **D-17** | "Add details mid-consultation" unimplemented — the screen never destructures `context` from `useArca()`; zero `addCaseNote` call sites in `apps/admin-console` | `features/playground-consultation/components/consultation-demo-screen.tsx:208` *(reviewer-reported)* |
| **D-18** | Stream failures invisible — `live.status` / `live.error` are computed by the hook and never passed to any column | `consultation-demo-screen.tsx:619-636` *(reviewer-reported)* |
| **D-19** | `OpenSessionInput` carries only `patientId` / `appointmentDate` / `departmentId` / `metadata` — no workflow/agent/schema selector | `packages/agentic-sdk-v2/src/types/consultation.ts:100-127` |
| **D-20** | No per-definition input schema on the exposure plane — *"slug + identity — no per-definition input schema exists yet"* | `apps/api/src/modules/workflows/workflows.controller.ts:45` *(reviewer-reported)* |

### 2.3 What is already correct (do not rebuild)

- The graph substrate itself: typed `WorkflowGraph{nodes,edges}`, structural validation, topological
  compiler → `compiledConfig`, rows-are-versions immutability (service guard + DTO whitelist +
  checksum + DB trigger), `(scope,scopeId,paletteKey)→slug` assignment cascade, run + trajectory
  read models, sandbox runs, cross-language registry parity gate.
- `@xyflow/react` canvas in `packages/ui/src/components/workflow-canvas/`, exported by dedicated
  subpath, consumed by `features/workflow-studio` with autosave + OCC (`If-Match`/ETag).
- `ConsultationContextSchema` head + immutable version + movable pin, with a genuine field builder
  at `/context-schemas` and a closed primitive vocabulary.
- `ContextItem.kindKey` + `contextSchemaVersionId` correctly pin the version a value was validated
  against — definition and runtime values are properly separated.

### 2.4 AC-2.1 is already met

`GET /api/v1/tenants/me/context-schema` → `ConsultationSchemaClient.fetchConsultationSchema()`,
auto-fetched by `AgenticProvider` at mount and on tenant/department switch, exposed read-only via
`useConsultationSchema()`. Server-side validation via `IConsultationContextSchemaService.validateContextPayload`
is authoritative; the client check is an explicit fast-fail UX aid.

### 2.5 The `@arcaai/vox-node` admin plane — mostly built, and it is GENERATED

The server SDK already exposes the configuration surface R2 asks for. Present under
`packages/vox-node/src/resources/admin/`:

| Resource | Covers |
|---|---|
| `consultation-context-schema.ts` | schema CRUD + `publish` / `pin` / `listVersions` — the **entrypoint** authoring path |
| `workflow-definition.ts` | definition CRUD, assignment fetch/update, sandbox runs — the **core** authoring path |
| `workflow-node.ts` | the node catalogue a client renders a palette from |
| `workflow-run.ts`, `workflow-test-fixture.ts` | run read model, Workbench fixtures |
| `department-agent.ts`, `agent-promotion.ts`, `agent-trajectory.ts`, `agentic.ts`, `prompt-template.ts`, `consultation-admin.ts` | Substrate-A agent config, prompts, trajectories |

Non-admin (business plane, API-key auth): `consultations.ts`, `consultation-summaries.ts`,
`summarization.ts`, `jobs.ts`, `tenants.ts`.

**The constraint that changes this plan:** `src/resources/admin/**` is machine-generated —
*"@generated by @arcaai/vox-node-codegen — DO NOT EDIT BY HAND"*
(`packages/vox-node/src/resources/admin/workflow-definition.ts:1-9`). Source of truth is
`apps/api/route-manifest.json` cross-checked against `apps/api/openapi.json`. Only
`admin-resource.ts` is hand-authored.

So **any** gateway route this ticket adds or reshapes (ports on `workflow-nodes`, `contextSchemaId`
on the entrypoint, lane fields, endpoint-sequence routes, workflow exposure) propagates to the SDK
only by regeneration — and CI enforces it.

### 2.6 The regenerate-together rule is stale, and it has already cost a red pipeline

`.claude/rules/05-nestjs-api.md:155` states the definition of done as **four** artifacts:

```
pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal
```

It omits the fifth — `pnpm --filter @arcaai/vox-node gen:admin` — whose output (`schemas.ts`) is
derived from `openapi.json` and is gated by `generate-vox-node-admin-check`
(`.gitlab/ci/validate.yml:217-244`, triggered by changes to `apps/api/openapi.json`,
`apps/api/route-manifest.json`, `packages/vox-node-codegen/**`, or
`packages/vox-node/src/resources/admin/**`).

This is not hypothetical: TASK-805 recorded it as I-3 — *"Pipeline #990 red on
`generate-vox-node-admin-check`; regenerated vox-node `schemas.ts`"* (commit `5daca9ddd`). TASK-806
touches admin routes in five of its nine phases, so leaving the rule stale means paying that
failure five more times. Fixing it is Phase 0 work (step 0.5).

**The real rule, used by every phase below:**

```
pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal \
  && pnpm --filter @arcaai/vox-node gen:admin
```

Verify with `pnpm api:openapi:check`, `pnpm api:portal:check`, and
`pnpm --filter @arcaai/vox-node gen:admin:check`.

### 2.7 Relationship to the live TEXT 503 incident

The concurrent production symptom (no partial summary, no finalization) has a **distinct mechanical
cause**: since TASK-799 lane B (`70eec34d5`, 2026-08-23) removed `apps/text`'s per-provider env
plane, TEXT fails closed with `503 PROVIDER_CREDENTIALS_MISSING` unless the caller injects
`provider_overrides`. Five summarization call sites never do; only `prompt-management.service.ts`
and `text-proxy.controller.ts` call `TextRequestEnrichmentService.applyTenantProviderOverrides`.

**This is architectural evidence, not a coincidence.** The live loop is a hand-rolled path outside
the governed exposure plane, which is exactly why it bypassed the shared enrichment service. Fixing
the architecture does not fix the 503 — Phase 0 does, and must land first.

---

### 2.8 Inventory sweep (2026-08-25) — five parallel read-only explorers

Scope: DepartmentAgent deletion surface · playground + admin-console · Prisma + DDD layers ·
both SDK surfaces · compat boundary. Orchestrator re-verified every load-bearing claim below
against the working tree; one explorer claim was **rejected** (see D-29 note).

#### New defects

| # | Defect | Evidence |
|---|---|---|
| **D-23** | `HarnessPolicyEntityMapper` and `PipelinePolicyEntityMapper` carry **no** `FIELDS_NOT_WRITABLE = ['version']` despite both models being OCC-written — a direct violation of `03-domain-layer.md`. Not a live bug (`Repository.updateWithVersion` strips `version` defensively at `packages/domains/src/common/repository.ts:216-219`), but the mandated mapper-level layer is absent. **Do not copy either mapper as a template** — use `AiTaskDefaultEntityMapper.ts:9` or `ContextItemEntityMapper.ts:14`. | mapper files, `harness-policy.service.ts:705`, `pipeline-policy.service.ts:206,338` |
| **D-24** | `HarnessPolicyChange` / `PipelinePolicyChange` are identity-only WORM tables (same shape as `WorkflowAssignmentChange`) but neither appears in `MODELS_WITHOUT_SOFT_DELETE`, while `WorkflowAssignmentChange` does (`client.ts:203`). Latent; no `findAll`/`findFirst` call site exercises it today. | `packages/database/src/client.ts` |
| **D-25** | **A tenant admin cannot impersonate a clinician in the console.** The BFF calls only `admin/users/:id/impersonate` (`@Authorize(['manage','all'])` — SUPER_ADMIN). The gateway *already has* `POST /auth/impersonate` permitting `TENANT_ADMIN` to impersonate non-admin users in its own tenant (`auth.controller.ts:589-618,634-636`), but nothing wires it. The comment at `persona-control.tsx:29-30` asserting no such endpoint exists is **stale**. **This blocks OD-2's premise.** | `app/api/auth/impersonate/route.ts:38-40,53`; `persona-control.tsx:82-92` |
| **D-26** | `/agents` nav gate requires `manage:PromptTemplate` (`nav-config.ts:546-553`) but the screen CRUDs **`DepartmentAgent`** (`agents-screen.tsx:15,50`). Nav gate and the screen's actual resource are already decoupled, before any TASK-806 change. | as cited |
| **D-27** | **Retiring `DepartmentAgent` silently disables the eval gate on every prompt-template approval.** `PromptManagementService.approveTemplate()` — a **surviving** core flow — calls `promotionGate.evaluatePromotion()` (`prompt-management.service.ts:506-519`), and `EvalPromotionGateService` discovers golden sets **only** via `DepartmentAgentRepository.findByBoundTemplate` (`eval-promotion-gate.service.ts:2,55,93-94`). No other discovery path exists. | verified directly |
| **D-28** | **`AgentPromotion` has no promotable object after the deletion.** Its entire subject is a `DepartmentAgentVersion.configSnapshot`; its authorization keys on the CASL subject being deleted — class-level `@CanManage('DepartmentAgent')` (`agent-promotion.controller.ts:27`) and `ability.can('manage','DepartmentAgent')` (`agentPromotion.service.ts:344`); and `apikey-scopes.registry.ts:341` makes `admin:agent-promotion:manage` **imply** `manage:DepartmentAgent`. | verified directly |
| **D-29** | *(claim rejected)* An explorer reported the workflow node registry as effectively empty. **False** — the registry holds 33 entries, 32 of them `implemented: true`; the `palette-rail.tsx` comment it quoted is conditional on TASK-720, which has landed. | orchestrator re-verification |
| **D-30** | *(orchestrator error, corrected 2026-08-25)* This ticket previously stated the registry held **14** nodes. It holds **33** — a regex matched only `key: '…'` entries while the registry declares keyed object literals. The consultation palette grew 3 → 16 across TASK-731/791. D-9 was consequently understated: **17 of 33** node types lack a config schema (`passthrough` + all 16 `consultation.*`), not "13 of 16". | committed parity fixture `node-registry.snapshot.json` (33 entries), cross-checked against both parity tests |

#### Load-bearing structural findings

- **Node config needs NO Prisma change.** `WorkflowDefinition.graph` / `compiledConfig` are opaque
  `Json @db.JsonB` interpreted by a **code-owned** registry (`packages/workflow-contract/src/node-registry.ts`
  + the Python mirror + the parity fixture). Adding `ports` / `trigger` / `requires[]` / `llmBinding`
  is a **contract-package change, not a migration**. This materially shrinks the node-contract sub-ticket.
- **The versioning pattern to copy is `ConsultationContextSchema`** (head → immutable version →
  movable pin), **not** `WorkflowDefinition`'s rows-are-versions shape. Recipe: head carries
  `pinnedVersionNumber Int?`; version row carries `versionNumber` + payload + `checksum`
  (sha256 over canonical JSON) and has **no update path** — immutability is enforced by the absence
  of a write method. Consumers stamp the validated-against version id at write time
  (`ContextItem.contextSchemaVersionId`).
- **That pattern does NOT come with a DB trigger.** Only `WorkflowDefinition` has one
  (`workflow_definition_immutability_guard`, TASK-734). `ConsultationContextSchemaVersion` has no
  trigger and no `REVOKE`. → **OD-13**.
- **`kindKey` is exact precedent for `documentKey`** — a nullable soft discriminator layered above
  `type` without splitting the enum, zero backfill (`consultation.prisma:42-49`). OD-6 is cheap.
- **But `documentKey` does not solve per-section state.** `ContextItem.encryptedContent` is a single
  opaque blob with no section addressability and no per-section lifecycle. → **OD-7**.
- **`TranscriptSegment`** (`consultation.prisma:628+`) already carries `idx`, `t0Ms/t1Ms`,
  `charStart/charEnd` — the exact span-anchor shape per-section provenance needs.
- **Six playground screens, not five** — Workbench (TASK-721) is gated on
  `manage:WorkflowDefinition` + `manage:WorkflowRun`; the other five carry `required: []`.
- **The canvas has `isValidConnection`** (`packages/ui/.../workflow-canvas/types.ts:64-69`) — typed
  ports hook straight into it. It does **not** support multi-select (`selectedNodeId` is singular,
  `workflow-canvas.tsx:196-201`) and has no port-type concept (handles are plain strings).
- **Session-open workflow selection is a six-point change** (OD-1): `OpenSessionInput` →
  `OpenConsultationRequest` (must be declared or the global pipe 400s it) → `ConsultationService.getOrCreate`
  → `DispatchForConsultationInput` → `ConsultationWorkflowDispatchService.dispatchForConsultation`
  (today it *always* trusts `assignments.resolve(...)`) → authorize the override against the cascade.
- **Workflow discovery is absent.** Nothing exposes which workflow governs a consultation
  (`Consultation.metadata.governingEngine` is written but never returned) nor a definition's input
  schema — `workflows.controller.ts:47` says so in its own summary.

#### `@arcaai/vox` authentication — OD-5 needs a positioning call

The SDK supports `accessToken` (JWT) **and** `apiKey` simultaneously (`AgenticClient.ts:68-76`,
sent independently on every request). But `config.ts:207-217` documents `apiKey` as *"for
system/third-party keys"*, the README quick-start leads with a JWT from a login flow, and **admin
hooks require the JWT**. Session open is business-plane, so an API key **can** open consultations —
OD-5 is achievable, but it is not the documented default and confines the integrator to the
business plane. → **OD-14**.

#### Compat entanglement (the fence is real, with two transitive reaches)

- **Direct:** none. `TextCompatController` calls TEXT `/generate` over HTTP
  (`text-compat.controller.ts:964`) — it never touches `LiveDocumentationService`, `SummaryService`,
  `PreSummaryProcessor`, `ChainSummaryService` or `ComprehensiveSummaryProcessor`. Compat apps
  import no workflow-canvas component. Nothing compat imports `ContextItemType.PRE_SUMMARY` or the
  live-summary payload types. `task-635-conformance.test.ts` already locks "no live route on
  text-compat" in both gateway and SDK.
- **Transitive #1 — binds the DepartmentAgent retirement:** `TextCompatController` →
  `TextCompatTemplateService.resolveGovernedInstruction()` (`text-compat-template.service.ts:86-130,97,173,200`)
  → `PromptResolutionService.resolve()` → **`DepartmentAgentRepository`**
  (`prompt-resolution.service.ts:67,327,455,551,834`).
  **Hard acceptance criterion:** the retirement MUST preserve `PromptResolutionService.resolve()`'s
  public signature and the `ResolvedPromptConfig` field set (`resolvedFrom`, `resolvedAgentId`,
  `content`, `resolvedVersionNumber`) while moving its internal Tier-1a source onto node config.
  Hold that and the compat file needs zero edits.
- **Transitive #2 — touches Phase 0:** TASK-732's deletion manifest records the owner decision that
  `SummaryService.generatePreSummary`/`generateSummary` (`summary.service.ts:328-384,486-560`) and
  `PreSummaryProcessor` are **v1-compat surfaces to become standalone features**. They sit outside
  `text-compat/`, so they are not literally inside the fence — but they are **three of the five
  callers Phase 0 must patch**. → **OD-9**.
- **`apps/api/src/modules/stt-compat/**` exists** and is frozen by the identical mechanism (same
  global-prefix exclusion, same conformance guard) but is not named in §5.1. → **OD-8**.

## 3. Target Architecture

### 3.1 One definition, two lanes

A `WorkflowDefinition` declares **lanes**, and the compiler emits one `compiledConfig` per lane:

```
WorkflowDefinition
├── entrypoint   → contextSchemaId + pinnedVersionNumber   (references, never re-declares)
├── core
│   ├── realtime lane  → executed IN-PROCESS, per turn   (transcription · NER · text-gen)
│   └── durable lane   → executed in TEMPORAL, one-shot  (retrieval · assurance · persistence)
└── endpoint     → ordered action sequence → TEMPORAL     (timeout · finalize · feedback)
```

### 3.2 Why the split (owner asked me to recommend after the review)

The evidence forces it. `apps/harness/.../interpreter/nodes/consultation_realtime.py:29-31` states
that **no per-frame audio and no per-token transcript may cross a Temporal workflow boundary**. So
the per-turn work a clinician sees cannot move to Temporal. Conversely, the endpoint sequence
(timeout → finalize → capture feedback) is precisely the work that must survive a process restart,
which is what Temporal is for.

- **Realtime lane → in-process.** `LiveDocumentationService.flush()` stops being a fixed 11-step
  sequence and becomes an **executor that walks the compiled realtime lane**. The live tool registry
  becomes node dispatch; step inputs resolve by declared port over the context object.
- **Durable lane + endpoint → Temporal.** Extends the interpreter that already exists.

### 3.2a Settled design decisions (owner, 2026-08-25 brainstorm)

Full rationale and diagrams: **[Consultation Graph Architecture](https://claude.ai/code/artifact/b6b68b73-3cb9-4cec-89f3-8afd1553c13b)**
(rev 3, settled). Recorded here so the ticket stands alone.

| Id | Decision | Consequence |
|---|---|---|
| **DD-1** | **Templates are shapes.** SOAP, discharge summary and patient background are rows in one catalog; none is privileged. | `SOAP` leaves every type name. `SOAP_SECTION_TITLES` and the hardcoded `json_schema` are replaced by compiled-per-shape artifacts. |
| **DD-2** | **No runtime shape switching.** A generation node binds one shape statically in its config. | The selector node, runtime classification, eligibility sets and switch-locking are all **dropped** from the plan. |
| **DD-3** | **Multiple documents per workflow.** A discharge node sits alongside the summarization node in the same realtime lane when the admin configures both. | The lane split is per **node**, not per template. `sectionKey` is no longer unique → every patch needs a `documentKey`. The clinical screen renders N documents. |
| **DD-4** | **Two independent model calls, run concurrently.** Each generation node calls its own model rather than sharing a combined schema. | Failure isolates (a discharge timeout leaves SOAP intact). Wall-clock is the slowest call, not the sum. Budget and staleness are tracked **per node**, not per flush. |
| **DD-5** | **`trigger` is a node property, orthogonal to `lane`** — `on-start` / `per-turn` / `on-end`. | Pre-summarization and the running note share the realtime lane without sharing a cadence; the endpoint stage becomes `trigger: on-end` uniformly. |
| **DD-6** | **Pre-summarization is a node**, fed from context supplied at runtime, running on start. | Formalizes today's `caseNoteIds`-driven pre-summary and widens its input to admin-selected context kinds. Stays **non-signable**. |
| **DD-7** | **Guards attach per node**, not per lane. | Per-document thresholds. Publish validation runs per node instance. Cost is contained by memoizing guards on `(guard, config, inputHash)` within a flush. |
| **DD-8** | **Corrections stay advisory.** Corrected transcript runs alongside raw; only clinician feedback promotes one. | Raw transcript remains the record of truth, preserving the anti-laundering chain NER depends on. |
| **DD-9** | **One generation engine, three palette entries** — pre-summarization, summarization, discharge — differing only in default trigger, ports and bound shape. | Keeps the catalog at nine connectable nodes while staying discoverable in the palette. |
| **DD-10** | **LLM binding is per node.** | `AiTaskDefault` semantics relocate onto node `llmBinding` in Phase 8 rather than dissolving into policy bindings. |

| **DD-11** | **A text-generation agent node MUST reference a prompt/prompt template**, and prompt edits have TWO distinct update semantics. Editing the prompt **from within the node** creates a new `PromptVersion` and moves the node's pin to it **immediately**. Editing the same template from the **Prompt/Instruction management screen** creates a new version but **does not move any node's pin** — each node must be re-pinned separately, with a "new version available" affordance. | Maps directly onto the existing `PromptTemplate` → `PromptVersion` head/version/pin triple. In-node edit = create-version + move-pin atomically; out-of-band edit = create-version only. This is what keeps a shared template from silently changing every workflow that references it. |

**Two defects this surfaced, both worth fixing regardless of TASK-806:**

- **D-21 — confabulation pressure.** `LIVE_SOAP_RESPONSE_FORMAT` is `strict: true` with all four
  sections `required`, forcing the model to emit every heading even when nothing was discussed.
  Mild at four sections; serious at a ten-section discharge summary. Sections must become
  nullable or carry an explicit "not discussed" sentinel.
- **D-22 — `PRE_SUMMARY` is overloaded.** `ContextItemType.PRE_SUMMARY` stores both the
  context-derived pre-summary (`context.service.ts:1458`) **and** the running-note snapshot
  persisted at recording stop (`recording.dto.ts:26`, `persistSnapshot`). Different lifecycles,
  different provenance, different trust levels, one name. Split it **before** pre-summary becomes
  a streamed document.

### 3.3 Typed ports (AC-1.6, owner decision D-3 "constrained DAG over a typed catalog")

`WorkflowNodeDescriptor` gains declared ports, typed over the **same** closed vocabulary the context
schema uses (`CONTEXT_PRIMITIVES`), so "input is any variable in the context object" becomes
expressible and checkable:

```ts
readonly inputs:  readonly WorkflowPortDescriptor[];   // { name, primitive, required, multiple }
readonly outputs: readonly WorkflowPortDescriptor[];
```

Edge validation then refuses an incompatible connection at author time, and the interpreter's
"thread the whole upstream object" fallback (D-6) is **removed** — an unresolved binding becomes an
error, consistent with the platform's fail-closed posture.

---

## 4. Implementation Plan

> **Ordering change from the review conversation.** The clinical-access lane (originally proposed as
> P6) is **moved to Phase 1**. Rationale: today no clinical user can reach the feature at all
> (D-16), it is the single most severe user-facing gap, and it is almost entirely independent of the
> graph work — so it should not queue behind an eight-phase refactor. Phase numbering below is the
> **execution order**. Owner may veto.

Each phase is independently shippable and independently verifiable. TDD per
`01-development-workflow.md` §Phase 4: failing test first, always see RED.

### Phase 0 — Unblock generation (prerequisite, blocks everything)

Nothing below is observable until TEXT generates again.

| Step | Change |
|---|---|
| 0.1 | Inject `TextRequestEnrichmentService` into the five summarization callers: `live-documentation.service.ts:2033`, `pre-summary.processor.ts:313`, `comprehensive-summary.processor.ts:430`, `chain-summary.service.ts:650`, `summary.service.ts:1654` (and `dna-writing-style.processor.ts:450`). |
| 0.2 | `await this.textRequestEnrichment.applyTenantProviderOverrides(payload)` before each POST. |
| 0.3 | Fix the NLP model cache: `PermissionError at /home/hope` downloading `blaze999/Medical-NER` — writable `HF_HOME` volume in the `hope-nlp` manifest (deployment repo `arca/hope-v2-deployment`). |
| 0.4 | Investigate `hope-api` readiness flapping (Endpoints flipped to `notReadyAddresses` 09:02 → ready 09:03 on 2026-08-25), which also breaks TEXT's effective-config pull (`last_refresh_ok:false`). |
| 0.5 | **Fix the stale regenerate-together rule** (§2.6): add `pnpm --filter @arcaai/vox-node gen:admin` to the definition of done at `.claude/rules/05-nestjs-api.md:155` ("four artifacts" → five) and to the `gen:admin:check` line in the same checklist. Cheap, and it pre-empts the same red pipeline in five later phases. |

**Tests (RED first):** per caller, assert the posted body carries `provider_overrides` for the
resolved provider. This is the regression gate whose absence let the outage ship.
**Verify:** `pnpm --filter @arcaai/applications test`; then a live consultation producing a non-empty
`summaryChars` in the `Live summary flush` log line.

### Phase 1 — Clinical access and safety-of-use (AC-3.1, 3.4, 3.5)

| Step | Change |
|---|---|
| 1.1 | **OD-2 required (§5)** — decide the clinician surface: open a route group to `DOCTOR`/`NURSE` with its own guard, or stand up a dedicated clinician app. Do not simply widen `(tenant)/layout.tsx`, which is a tier gate for admin screens. |
| 1.2 | Wire `context` from `useArca()` into the consultation screen; add an "add detail / note / attachment" affordance calling `addCaseNote` / `addWorknote` / `addAttachment`, or the schema-validated `session.addContext({kindKey,payload})`. |
| 1.3 | Pass `live.status` / `live.error` (and the harness/assurance equivalents) into the columns; render a distinct error state. |
| 1.4 | Resolve the contradictory empty-first-flush state: header "assistant unavailable" + body "waiting…" skeleton simultaneously. |
| 1.5 | Replace free-text patient-ID entry with a patient lookup scoped to the clinician. |
| 1.6 | **DD-3**: the screen renders **N documents**, not one summary column. Settle the multi-document layout before building — it is no longer a single panel. |

**Tests:** RBAC tests proving a `DOCTOR`-only session reaches the surface; component tests for the
add-detail flow, the stream-error state, and the empty-first-flush state.
**Verify:** `pnpm --filter @arcaai/admin-console build lint test`; axe scan 0 violations; both themes;
Playwright e2e for the clinician path.

### Phase 2 — Typed ports + node config schemas (AC-1.4, 1.6)

| Step | Change |
|---|---|
| 2.1 | Add `inputs`/`outputs` `WorkflowPortDescriptor[]` to `WorkflowNodeDescriptor` and mirror in `registry.py` (parity gate must stay green). |
| 2.2 | Extend `graph-model.ts` edge validation to type-check ports against the registry. |
| 2.3 | Author the 13 missing `consultation.*` config schemas (D-9). |
| 2.4 | Remove the interpreter's whole-object binding fallback (D-6); unresolved binding → error. |
| 2.5 | Surface ports in `GET /api/v1/admin/workflow-nodes` + `workflow-node.response.ts`; enforce connection validity in the canvas via `isValidConnection`. |
| 2.6 | **vox-node**: regenerate (§2.6 five-artifact rule). `admin/workflow-node.ts` + `schemas.ts` must carry the new port fields so an SDK consumer can render a palette and validate a graph client-side. Never hand-edit `resources/admin/**`. |
| 2.7 | **DD-5 / DD-7**: descriptors gain `trigger` (`on-start`/`per-turn`/`on-end`) and `requires[]`. Port vocabulary extends `CONTEXT_PRIMITIVES` with `transcript`, `entities`, `document`, `edits`, `verdict`. |
| 2.8 | **DD-7**: publish validation checks `requires[]` **per node instance**. Studio ships multi-select guard attach / "copy guards from…" in the same phase — per-node wiring that is tedious is per-node wiring that gets skipped. |

**Tests:** contract tests for compatible/incompatible edges; registry parity snapshot; per-node config
schema validation; interpreter binding-failure test.
**Verify:** `pnpm --filter @arcaai/applications test`; `pnpm harness:test`; `pnpm --filter @arcaai/ui test` (only because `packages/ui` is touched — otherwise excluded per owner directive).

### Phase 3 — Entrypoint binds the real schema (AC-1.1)

| Step | Change |
|---|---|
| 3.1 | Replace the inlined literal `contextSchema` with `contextSchemaId` (+ resolved pinned version) in the entrypoint node config. |
| 3.2 | Populate `compiledConfig.policyBindings.contextSchemaVersionId` at publish — kill `DEFAULT_POLICY_BINDINGS`' hardcoded `null` (D-7). Populate `promptTemplateRefs` and `entitlementKeys` in the same pass. |
| 3.3 | Widen entrypoint primitives to all five, including `STREAM_AUDIO` — this is what makes AC-1.3's audio input expressible. |
| 3.4 | Publish-time validation: referenced schema exists, is published, and its kinds satisfy the graph's declared inputs. |
| 3.5 | **vox-node**: regenerate. This is the phase that makes AC-2.4 real end-to-end — a developer can `admin.consultationContextSchema.publish()` then reference that schema id from `admin.workflowDefinition.update()`. Add an integration test in `packages/vox-node/src/resources/__tests__` covering that two-call sequence. |

**Tests:** publish pins the version; republish after a schema version bump re-pins; publishing against
an unpublished schema is refused.

### Phase 4 — Multi-lane definition; retire immutable `paletteKey` (AC-1.2)

| Step | Change |
|---|---|
| 4.1 | Introduce lane membership on node descriptors (`realtime` \| `durable`). |
| 4.2 | Replace the single immutable `paletteKey` with a capability/entitlement set derived from the nodes actually used; migrate existing rows. |
| 4.3 | Compiler emits one `compiledConfig` per lane. |
| 4.4 | Allow transcription + NER + text-gen in one definition; update `EXPOSURE_ALLOWED_PALETTES` (D-15). |
| 4.5 | Prisma migration `task_806_workflow_lanes` (authored against a throwaway shadow DB per `02-database-prisma.md`; **never** `gen:mapper`). |
| 4.6 | **vox-node**: regenerate. `paletteKey` disappearing from the create contract is a **breaking change** to `admin.workflowDefinition.create()`. Coordinate with the SDK-family version bump (currently 2.0.4, published by `publish-sdk`) and note it in the vox-node changelog. |

### Phase 5 — Graph-driven realtime executor (AC-1.2, 1.4, 1.5)

| Step | Change |
|---|---|
| 5.1 | Replace `flush()`'s hardcoded 11-step sequence with an executor walking the compiled realtime lane. |
| 5.2 | Convert `LIVE_TOOL_KEYS` (D-13) from a 3-boolean allow-list into node dispatch. |
| 5.3 | Resolve step inputs by declared port over the context object — retire the hardcoded `delta \|\| transcript` (D-14). **Preserve the anti-hallucination-laundering invariant**: NER must still never see the generated note. Encode it as a port-type rule, not a convention. |
| 5.4 | Gate `liveDocumentationService.start()` on the governing substrate (D-1 / §2.1). |
| 5.5 | Make transcription a real node whose config binds the `AsrPipeline`, producing the transcript stream NER/text-gen consume (D-3). |
| 5.6 | **DD-1/DD-2**: template compiler — shape → strict JSON schema + frozen checklist + section state machine, compiled at publish, frozen per session. Replaces `SOAP_SECTION_TITLES`, `LIVE_SOAP_RESPONSE_FORMAT`, `parseSoapJson`, `buildRunningSummary`. Re-pin the prompt checksum tests deliberately. Fix **D-21** here. |
| 5.7 | **DD-3**: re-anchor annotations from global `runningSummary` offsets to `{documentKey, sectionKey, local offsets}`. Per-document, per-section state (`empty`/`provisional`/`confirmed`/`locked`); a clinician edit → `confirmed`, never overwritten by a later flush. |
| 5.8 | **DD-4**: concurrent per-node generation with **per-node** timeout, budget and staleness. The flush emits whatever completed and marks the rest unchanged; one slow model must not stall the other. |
| 5.9 | **DD-7**: guard memoization on `(guard, config, inputHash)` within a flush, so per-node attachment does not multiply guard cost. |

**Tests:** executor walks a fixture graph in declared order; a disabled node is skipped; NER cannot
receive generated-note text; per-node failure degrades exactly as today.

### Phase 6 — First-class endpoint stage (AC-1.7, 1.8)

| Step | Change |
|---|---|
| 6.1 | Replace the hardcoded `endingActionsBase` literal (D-10) with an admin-ordered, persisted action list. |
| 6.2 | Add `session.timeout`, `summary.finalize`, `feedback.capture` node types + activities (D-11). |
| 6.3 | Fix D-12: timeout expiry **runs** the endpoint sequence rather than skipping it. |
| 6.4 | Studio UI for ordering the endpoint sequence. |
| 6.5 | **vox-node**: regenerate so the endpoint sequence is authorable from `hope.admin.*`, not only from the console. |
| 6.6 | **DD-3**: `summary.finalize` locks **every** document, not just the SOAP note. |
| 6.7 | **DD-8**: `feedback.capture` is the promotion path for advisory transcript corrections — the only way a correction becomes preferred over raw. |

### Phase 7 — SDK exposure, both packages (AC-2.2, AC-2.5, AC-2.6, OD-1)

| Step | Change |
|---|---|
| 7.1 | **Gateway**: expose the governing workflow + its declared input schema (closes D-20 — *"slug + identity — no per-definition input schema exists yet"*). Decide whether this lives on the existing exposure plane or a new `tenants/me/workflow` discovery route mirroring `tenants/me/context-schema`. |
| 7.2 | **`@arcaai/vox`**: a `useConsultationWorkflow()` hook mirroring `useConsultationSchema()` — read-only view of the governing workflow, pinned per session alongside the schema bundle by `AgenticProvider`. Same fail-open posture as `UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE`. |
| 7.3 | **`@arcaai/vox`**: per **OD-1**, if session-time selection is permitted, add the selector to `OpenSessionInput` (D-19) with server-side authorization against the assignment cascade. If not permitted, document the refusal explicitly on the type so integrators stop looking for it. |
| 7.4 | **`@arcaai/vox-node`**: regenerate; confirm the full R2 developer journey is expressible server-side — publish schema → author + publish definition → set assignment → verify via a sandbox run. |
| 7.5 | **Docs (AC-2.6)**: state the credential split where a developer will actually hit it — `/admin/*` is service-account-only (`@ForbidApiKey()`, checked before the scope check), `workingTenantId` binds at exchange so `X-Tenant-Id` is never sent with it, and an API key can configure nothing. Update `packages/vox-node/README.md`. |

### Phase 8 — Retire legacy config surfaces (owner decision: replace outright)

> **Sequencing constraint — do not move this earlier.** The live loop resolves its model through
> `AiTaskDefault` via `resolveTextSelection(tenantId,'live')`. Deleting those rows before the graph
> carries model selection re-breaks generation exactly as the 2026-08-25 outage did.

| Step | Change |
|---|---|
| 8.1 | Migrate `AiTaskDefault` / `HarnessPolicy` / `PipelinePolicy` semantics onto node config + policy bindings. |
| 8.2 | Migrate `DepartmentAgent` (the Substrate-A agent) onto graph nodes; retire `FrozenLiveAgentSnapshot` or redefine it as the frozen compiled lane. |
| 8.3 | Retire `/agentic-policy`, `/ai-task-defaults`, `/agents` authoring; leave one-release `redirect()` pages per `13-nextjs-apps.md`. |
| 8.4 | Drop the tables once no reader remains. |

---

## 5. Owner Decisions

### 5.A RESOLVED 2026-08-25 — the original six

Recorded verbatim in intent, with the consequence each carries. Eight further decisions were
raised by the inventory sweep and are OPEN in §5.0.

| Id | Answer | Consequence for the plan |
|---|---|---|
| **OD-1** | **Yes — a developer MUST be able to select a workflow at session-open time.** | `OpenSessionInput` gains a workflow selector (closes D-19). The gateway must authorize the selection against the assignment cascade — a developer may choose among workflows the tenant is entitled to, not any workflow. The global pipe runs `forbidNonWhitelisted`, so the request DTO must declare the field or the open is rejected with 400. |
| **OD-2** | **No clinical app.** Clinical usage happens in the **tenant-admin playground** (impersonating a clinician): live transcription, DNA writing style, consultation. | **Phase 1 is re-scoped.** D-16 is NOT a defect — the `(tenant)` tier gate is correct and stays. The work moves to the existing tier 50–59 playground under `(console)/(tenant)/playground/*`. No route-group widening, no `DOCTOR`/`NURSE` RBAC change. The add-details, stream-error and multi-document work all land in the playground consultation screen. |
| **OD-3** | **Yes — reorder, and split.** TASK-806 becomes a **master ticket**; the phases become sub-tickets. | This document is now the master. Sub-tickets carry the executable detail; see §9. |
| **OD-4** | **Retire `DepartmentAgent` completely and properly** — interfaces, logic, schema table, and related APIs. | Becomes its own sub-ticket with a full deletion inventory. Everything `DepartmentAgent` currently carries (`FrozenLiveAgentSnapshot`, `llmOverrides`/`liveLlm`, `neverActions`, `LIVE_TOOL_KEYS`) must be absorbed by node config **before** deletion — this is a strict ordering constraint, not a preference. |
| **OD-5** | **Both SDKs are developer-facing.** `@arcaai/vox` = frontend → HOPE backend with an **API key**. `@arcaai/vox-node` = system-to-system with a **service account OR an API key**. | Confirms R2 spans both packages. Note the standing constraint this interacts with: `/admin/*` carries `@ForbidApiKey()`, so an API key reaches the **business plane only** — workflow *authoring* remains service-account work, while workflow *selection at session open* is business-plane and API-key-reachable. |
| **OD-6** | **Discriminate by `documentKey` on ONE `ContextItem` type** rather than splitting the type. | Resolves D-22 with a smaller migration: no new enum value, no backfill of existing rows into a new type. `documentKey` becomes the discriminator across pre-summary / SOAP / discharge. |

### 5.0 OPEN — raised by the 2026-08-25 inventory sweep

Eight new decisions. **OD-7, OD-9, OD-10 and OD-11 block sub-tickets from starting**; the rest can
be answered during their phase.

| Id | Decision | Recommendation | Blocks |
|---|---|---|---|
| **OD-7** | **Per-section state + provenance: child table or JSON?** `documentKey` (OD-6) is cheap and precedented, but `ContextItem.encryptedContent` is one opaque blob — `empty/provisional/confirmed/locked` and transcript-span provenance cannot live on it. Options: a `DocumentSection` child table (mirroring `TranscriptSegment`) or a JSON array in `ContextItem.metaData`. | **Child table.** The deciding argument is concurrency, not queryability: the rule "a confirmed section is never overwritten by a flush" needs **per-section OCC**. With one blob and one `_version`, every flush contends with every clinician edit — and with two documents generating concurrently, with each other. JSON is cheaper today and fails exactly where the design is most safety-critical. | 809, 810 |
| **OD-8** | Is `apps/api/src/modules/stt-compat/**` inside the do-not-touch fence? | **Yes.** Frozen by the identical mechanism; TASK-806 has no business reason to touch STT session lifecycle. | 807, 810 |
| **OD-9** | `SummaryService.generatePreSummary`/`generateSummary` + `PreSummaryProcessor` are owner-designated v1-compat-to-become-standalone, yet are 3 of the 5 callers Phase 0 must patch to fix the live 503. | **Repair-only exemption.** Phase 0 may add the missing `provider_overrides` — restoring behaviour TASK-799 broke — and nothing else touches them. The alternative is leaving them 503-ing until their own ticket. | **808** |
| **OD-10** | **`AgentPromotion` has no promotable object after the deletion (D-28).** Rewrite it around a successor promotable (`WorkflowDefinition` versions), or retire it alongside `DepartmentAgent`? | Needs an owner call — this is a product decision, not a refactor. Note its only console surface is the `/agents` Lineage tab, which the deletion removes; without a replacement screen `AgentPromotion` becomes invisible. | **815** |
| **OD-11** | **What replaces the eval gate's `PromptTemplate ↔ goldenSetId` binding (D-27)?** Today the gate on the surviving `approveTemplate()` flow discovers golden sets only through `DepartmentAgentRepository.findByBoundTemplate`. | Bind `goldenSetId` directly to the `PromptTemplate` (or to the node that references it) before deletion. Silently losing the gate on every template approval is the failure mode to avoid. | **815** |
| **OD-12** | Per-agent `HarnessPolicy` overrides (`applyAgentOverrides`, run on **every** `getEffectivePolicy` return path) — retire the feature outright, or repoint to a node-level override? | Repoint only if a real tenant uses it; otherwise retire. No successor is named anywhere in the current plan. | 814 |
| **OD-13** | Does the new template-version table get `WorkflowDefinition`'s DB immutability trigger, or follow `ConsultationContextSchemaVersion`'s convention-only posture? | **Add the trigger.** The convention-only posture is one careless `update()` away from rewriting published clinical templates; TASK-734 added the trigger to `WorkflowDefinition` for exactly this reason. | 809 |
| **OD-14** | Make API-key auth the documented primary path for `@arcaai/vox` (per OD-5), or keep it JWT-first with API keys for server-to-server? | Needs your call — see §2.8. Either way it is a docs + positioning change plus a business-plane scope audit, not a code rewrite. | 812 |

### 5.0-R RESOLVED 2026-08-25 (second round)

| Id | Answer | Effect |
|---|---|---|
| **OD-7** | **Child table.** | `DocumentSection` per §3; per-section OCC is what makes "a confirmed section is never overwritten" hold. Lands in TASK-810 + TASK-811. |
| **OD-8** | **Yes** — `stt-compat` is inside the fence. | Added to §5.1. |
| **OD-9** | **Repair-only exemption confirmed** — "repair and fix if any". | TASK-808 may restore `provider_overrides` on the three compat-designated callers, and fix defects it finds there; nothing else touches them. |
| **OD-10** | **Rewrite `AgentPromotion` around a successor promotable: agent nodes / workflows.** | The promoted artifact becomes a `WorkflowDefinition` version (or a node within one) instead of a `DepartmentAgentVersion.configSnapshot`. Its CASL subject moves off `DepartmentAgent`. TASK-815. |
| **OD-11** | **REVISED 2026-08-25 (second answer supersedes the first).** Bind `goldenSetId` **directly to the node that references it**, before deletion. The eval gate **SURVIVES**; a tenant admin can enable or disable it. | `EvalPromotionGateService` is **kept**, its discovery repointed from `DepartmentAgentRepository.findByBoundTemplate` onto node config. `GoldenSet`/`GoldenCase`/`EvalRun` all survive. Adds an enable/disable toggle. The earlier "remove it along with goldenSet" reading is **withdrawn**. |
| **OD-12** | **Retire per-agent harness overrides outright.** | `applyAgentOverrides` + `TENANT_TIER_HARNESS_OVERRIDE_KEYS` + the `overridesSource` provenance fields are deleted, not repointed. TASK-815. |
| **OD-13** | **Follow best practice** (add the immutability trigger) **plus a new prompt-binding requirement** — see DD-11. | TASK-810. |
| **OD-14** | **Follow the recommendation.** | See below. |

#### OD-11 resolved — the gate survives, its binding moves

The first answer ("remove it along with goldenSet") was flagged because `GoldenSet` owns
`GoldenCase[]` and `EvalRun[]` (`harness.prisma:54,93`) and has consumers far outside the gate:
`eval.service.ts` (32 refs), `eval-run.service.ts` (17), `golden-case-promotion.service.ts` (7),
`harness-gateway.service.ts`, `harness-observability.service.ts`.

**The revised answer keeps all of it.** `goldenSetId` moves from `DepartmentAgent` onto the
**workflow node** that references the prompt template. `EvalPromotionGateService` survives with its
discovery repointed. `PromptManagementService.approveTemplate()` keeps calling the gate. A tenant
admin gets an explicit **enable/disable** control.

Consequences: **D-27 is closed by repointing, not by deletion**; TASK-815 is **UNBLOCKED**; and the
node config schema gains an optional `evalGate: { goldenSetId, enabled }` block (TASK-809 defines
the field; TASK-815 migrates the binding).

#### OD-14 — recommendation applied: `@arcaai/vox` stays JWT-first

Both credentials remain supported. The **documented primary path for a user-facing frontend stays
the JWT** obtained from a login flow; the API key stays the **server-side / integration**
credential, business-plane only.

Rationale, and why this refines rather than contradicts OD-5: an API key shipped to a browser is a
static, long-lived, shared credential sitting in client code. A JWT is per-user, expiring,
revocable, and — decisively — carries the human identity that abilities compose against. Scopes
bind the *credential*; abilities bind the *bound human*, and the two compose as AND. A shared API
key cannot express "this clinician", so per-user authorization and audit attribution both collapse
onto it. On a PHI platform that is the wrong default. Admin hooks already require the JWT.

**What OD-5 still gets:** an API key genuinely can open consultations and drive business-plane
surfaces, so an integrator building server-side against HOPE uses one. TASK-813 documents the split
explicitly and audits business-plane scope coverage so the API-key path is honest about its reach.

### 5.1 Hard scope constraint (owner, 2026-08-25)

> **Do NOT touch the compat things.**

Out of scope for every sub-ticket: `apps/compat-playground`, `apps/quick-compat-app`,
`TextCompatController` / the `text-compat` module, the `/api/smr/*` routes, the v1-compat lanes in
`@arcaai/vox-node` (`summarization.*`, the `core/url.ts` prefix exemption) and
`useArcaSessionManager` in `@arcaai/vox`. Where a TASK-806 change would otherwise force a breaking
edit to one of these, the change must be made **additively** instead. The entanglement analysis
that makes this enforceable is recorded in §7.

### 5.2 Superseded — the original open questions

Retained for provenance; all now answered in §5 above.

| Id | Original question | Why it needed an owner call |
|---|---|---|
| **OD-1** | May a developer select a workflow at session-open time, or is assignment strictly a tenant-admin action? | Changes the SDK contract and the authorization model. The reviewer flagged this as genuine product ambiguity: the code today supports only admin assignment. |
| **OD-2** | Clinician surface: widen the admin console to clinical roles, or stand up a dedicated clinician app? | Architectural + security posture. The console's `(tenant)` group is an admin tier gate; clinical users are not admins, and the current documented path is SUPER_ADMIN impersonation. |
| **OD-3** | Confirm Phase 1 jumping ahead of the graph work (§4 preamble). | Reordering the owner's stated P0–P8. |
| **OD-4** | Is `DepartmentAgent` retired (Phase 8.2) or kept as a per-department overlay on a shared graph? | Determines whether Phase 8 is a migration or a deletion. |
| **OD-6** | **D-22** — split the overloaded `PRE_SUMMARY` context item type, or discriminate by `documentKey` on one type? | A small migration either way, but it must land **before** pre-summary becomes a streamed document, and the choice affects existing rows. |
| **OD-5** | Which package is the "developer" in R2 actually holding — `@arcaai/vox-node` (configuration-time, service account) or `@arcaai/vox` (session-time, browser)? | The reviewer flagged this as genuine product ambiguity. Read as **vox-node**, AC-2.4 is largely met today and Phase 7 is a small delta. Read as **vox**, it depends on OD-1 and is a new contract. The plan currently serves both; confirming lets us drop whichever is not wanted. |

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Phase 5 rewrites the highest-volume internal hop in the platform | Land behind a per-tenant flag; keep the legacy path executable until parity is proven on trajectory records. |
| Anti-hallucination invariant (NER never sees the generated note) is currently enforced by an input **type** with one field | Phase 5.3 must re-encode it as a port-type rule before that type is generalized. Regression test is mandatory, not optional. |
| Removing the interpreter's binding fallback (2.4) may break seeded graphs | Audit `seed/23-arcaai-workflow-authoring.ts` first; migrate seeds in the same commit. |
| "Replace outright" (Phase 8) has the largest blast radius | Strict ordering: nothing deleted until Phase 5 + 7 are in production and the graph demonstrably carries selection. |
| Prisma migration authoring | Shadow-DB recipe in `02-database-prisma.md`. **Never run `pnpm gen:mapper`** — it strips the `_version` OCC guard. |
| **`generate-vox-node-admin-check` goes red in five of nine phases** | Phase 0.5 fixes the stale rule; every admin-route-touching phase carries an explicit regenerate step. Run `pnpm --filter @arcaai/vox-node gen:admin:check` locally before pushing. |
| **Hand-editing `packages/vox-node/src/resources/admin/**`** — plausible-looking and silently wrong | The files carry a `@generated … DO NOT EDIT BY HAND` header and CI fails on any hand-edit. Only `admin-resource.ts` is hand-authored. |
| Phase 4 breaks `admin.workflowDefinition.create()` for existing vox-node consumers | Treat as a breaking SDK change: version bump across the SDK family, changelog entry, and a migration note — not a silent regeneration. |

---

## 7. Sub-Ticket Map — TASK-806 is the MASTER

Nine sub-tickets. Numbering starts at **TASK-808** — TASK-807 was claimed on 2026-08-25 by an unrelated Vault-session fix (commit `fe7fc77c1`). Each carries its own
README with scope boundary, TDD test list, verification commands, per-layer checklist
(Prisma → DDD → applications → API → SDKs → admin-console) and the compat fence from §5.1.

### 7.1 Layer coverage — every sub-ticket declares which layers it touches

| # | Sub-ticket | Prisma | DDD | API | vox | vox-node | console | python |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **808** | Unblock generation (Phase 0) | — | — | — | — | — | — | ✓ |
| **809** | Node contract — ports · trigger · requires · llmBinding | **—** | — | ✓ | — | ✓ | ✓ | ✓ |
| **810** | Template/shape catalog | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| **811** | Multi-document realtime runtime | ✓ | ✓ | ✓ | ✓ | — | ✓ | — |
| **812** | Endpoint stage · feedback · timeout | — | — | ✓ | — | ✓ | ✓ | ✓ |
| **813** | SDK workflow selection + discovery | — | — | ✓ | ✓ | ✓ | — | — |
| **814** | Playground clinical surface | — | — | ✓ | ✓ | — | ✓ | — |
| **815** | `DepartmentAgent` retirement | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| **816** | Legacy config retirement | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |

**808 touches no Prisma** — node vocabulary lives in the code-owned registry, not the schema (§2.8).
**Every ✓ in the `vox-node` column means a regeneration**, never a hand-edit — `pnpm --filter
@arcaai/vox-node gen:admin`, gated by `generate-vox-node-admin-check`.

### 7.1a Sub-ticket index — all authored 2026-08-25

| # | Ticket | Status |
|---|---|---|
| 808 | [Unblock TEXT Generation](../TASK-808-Unblock-TEXT-Generation/README.md) | **`Completed`** |
| 809 | [Workflow Node Contract](../TASK-809-Workflow-Node-Contract/README.md) | **`Completed`** |
| 810 | [Template / Shape Catalog](../TASK-810-Template-Shape-Catalog/README.md) | **`Completed`** |
| 811 | [Multi-Document Realtime Runtime](../TASK-811-Multi-Document-Realtime-Runtime/README.md) | **`Completed`** |
| 812 | [Workflow Endpoint Stage](../TASK-812-Workflow-Endpoint-Stage/README.md) | **`Completed`** |
| 813 | [SDK Workflow Selection](../TASK-813-SDK-Workflow-Selection/README.md) | `Review` — merged; one open follow-on: **selectable-set discovery** (813 §8), owner decision needed |
| 814 | [Playground Clinical Surface](../TASK-814-Playground-Clinical-Surface/README.md) | **`Completed`** |
| 815 | [`DepartmentAgent` Retirement](../TASK-815-DepartmentAgent-Retirement/README.md) | **`Completed`** |
| 816 | [Legacy Config Retirement](../TASK-816-Legacy-Config-Retirement/README.md) | `Pending` |

### 7.2 Sequencing

```
807  (urgent, independent)
 └─ 808 ──┬─ 809 ─┬─ 810 ─┬─ 811
          │       │       └─ 812
          │       └─ 813 (needs 810's payload; D-25 wiring is independent)
          └───────────────── 814 ── 815
```

**Hard ordering constraints, not preferences:**
1. **814 after 808 + 810.** Everything `DepartmentAgent` carries (`FrozenLiveAgentSnapshot`,
   `llmOverrides`/`liveLlm`, `neverActions`/`alwaysActions`, `LIVE_TOOL_KEYS`) must be **absorbed by
   node config first**. Deleting earlier removes live capabilities with no successor.
2. **815 last.** The live loop still resolves its model through `AiTaskDefault` via
   `resolveTextSelection(tenantId,'live')`. Dropping those rows before the graph carries selection
   re-breaks generation exactly as the 2026-08-25 outage did.
3. **810 before 813.** The playground renders N documents; it needs the payload shape 810 defines.
4. **809 before 810.** The executor consumes compiled template artifacts.

### 7.3 Agent + model-tier alignment (per `14-multi-agent-worktrees.md` §1)

Tier is assigned **per sub-ticket by the complexity of the stage whose verdict is acted on** — never
downshifted on a deciding stage, never uniformly raised.

| # | Agent type | Model | Effort | Isolation | Why this tier |
|---|---|---|---|---|---|
| **808** | `debugger` | `opus` | medium | main tree | Root cause is known and proven; the work is a contained six-call-site fix plus an infra change. Opus because it touches a compat-adjacent file under an OD-9 exemption — the judgement of *what not to touch* is the risky part, not the edit. |
| **809** | `planner` → `general-purpose` | `opus` | high | worktree | Designs a contract every later ticket consumes, across TS **and** the Python mirror with a parity gate. A wrong port vocabulary is expensive to unwind. |
| **810** | `database-admin` → `general-purpose` | `opus` | high | worktree | New model pair + migration + the versioning triple replicated exactly. Migration authoring is unforgiving (`gen:mapper` is destructive; shadow-DB recipe mandatory). |
| **811** | `general-purpose` | `opus` | **max** | worktree | Highest-risk ticket: rewrites the highest-volume internal hop, re-anchors every annotation offset, introduces per-section concurrency, and must preserve the anti-laundering invariant. |
| **812** | `general-purpose` | `sonnet` | high | worktree | Mostly additive — ordered action list, two new node types, one timeout-semantics fix. Escalate to `opus` if the Temporal replay-compat tests surface trouble. |
| **813** | `api-designer` | `opus` | medium | worktree | Six-point change across two SDKs plus an authorization decision (a selector that trusts client input is a cross-tenant hazard). |
| **814** | `ui-ux-designer` | `sonnet` | medium | worktree | Screen work against a defined payload, plus the D-25 impersonation wiring. Well-bounded; a11y + both themes are checklist items, not judgement calls. |
| **815** | `general-purpose` | `opus` | **max** | worktree | A deletion touching every layer, with two surviving features silently depending on the deleted thing (D-27, D-28) and a compat contract that must not move. Deletions are unrecoverable if over-scoped. |
| **816** | `general-purpose` | `opus` | high | worktree | Config-plane migration with a proven outage as its failure mode. |

**Review lens per ticket** — distinct angles, never N identical reviewers:
`code-reviewer` (correctness) on all; **`security-auditor`** additionally on 812 (workflow-selection
authorization) and 814 (CASL subject removal, scope registry); **`database-admin`** additionally on
809, 814, 815 (migration review); **`tester`** on 810 (concurrency + staleness).

**Orchestrator-owned, never delegated** (§3 of rule 14): all merges, `pnpm install`,
`db:push`/`db:migrate`/`test:db:reset`, Docker/infra commands, and every `gen:*` invocation.

### 7.4 Brief requirements every sub-ticket agent receives

Non-negotiable, per `14-multi-agent-worktrees.md` §2 — a subagent inherits none of this context:

1. Ticket id, target branch (**`dev-2.2`**, never `dev`), and worktree path.
2. The file/package boundary it OWNS, and the §5.1 compat fence verbatim as **must-not-touch**.
3. Which `.claude/rules/NN-*.md` to read (per the layer table in §7.1).
4. Exact verification commands, with output pasted as evidence — assertions alone are not results.
5. The destructive-tooling warnings: **never run `pnpm gen:mapper`**; `gen:entity`/`gen:factory`
   reconcile only; `gen:repository` is broken; shadow-DB recipe for migrations.
6. The five-artifact regeneration rule (§2.6) whenever an admin route changes.
7. Its return contract — final message is DATA for the orchestrator, with named fields.
8. **The finishing protocol (owner directive, 2026-08-25):** merge `dev-2.2` in, re-run gates, merge
   out to `dev-2.2`, then remove the worktree AND delete the branch — in that order. Prove
   `git log <branch> --not dev-2.2` is empty first. If the merge cannot be completed, LEAVE the
   worktree and report it at the top of the final message. Never `--force`, never `prune`.
   When lanes overlap, the orchestrator serializes the final merge so they do not race.

## 8. Implementation Summary

_Not started — awaiting owner answers on OD-7…OD-14, then sub-ticket authoring._

---

## 9. Change History

| Date | Change |
|---|---|
| 2026-08-25 | Ticket opened. Five-lens read-only architecture review completed; 20 defects recorded with re-verified evidence; target architecture and 9-phase plan drafted. Status `Pending` pending owner approval and OD-1..OD-4. |
| 2026-08-28 | **TASK-808, 809, 810 and 811 all `Completed` and merged to `dev-2.2`.** The root cause in §2.1 is closed: `startRecording` is gated on the governing-engine marker, and the realtime lane is graph-driven behind a per-tenant flag with trajectory parity. 809 §2y1 closed by 811. Three follow-ons carried on 811 §9a — `descriptor.lane` reconciliation (needs a lane owning `apps/harness`), a `DocumentSection` REST surface, and `pipelineId` observability. |
| 2026-08-25 | **OD-11 revised** — the eval gate SURVIVES; `goldenSetId` binds to the node that references it, with a tenant-admin enable/disable. The earlier "remove it along with goldenSet" reading is withdrawn; the `GoldenSet`/`GoldenCase`/`EvalRun` subsystem is untouched. D-27 closed by repointing. **TASK-815 unblocked.** All findings, best practices, standing instructions, destructive-tooling warnings, the full compat fence and a copy-verbatim agent brief pushed down into all nine sub-tickets. |
| 2026-08-25 | **Sub-tickets authored** — TASK-808…816 created (renumbered from 807…815; TASK-807 was claimed by an unrelated Vault-session fix, `fe7fc77c1`). Second-round decisions OD-7…OD-14 recorded in §5.0-R, plus **DD-11** (prompt binding + two-path versioning). OD-11 applied under a narrow reading with the scope confirmation flagged as blocking on TASK-815. |
| 2026-08-25 | **Promoted to MASTER ticket.** OD-1…OD-6 answered and recorded (§5.A). Five parallel read-only inventories run (DepartmentAgent deletion surface, playground/console, Prisma+DDD, both SDKs, compat boundary) — findings in §2.8, with seven new defects **D-23…D-28** and one explorer claim **rejected on re-verification (D-29)**. Eight new decisions raised as **OD-7…OD-14** (§5.0); four block sub-tickets. Sub-ticket map TASK-808…815 authored with layer coverage, sequencing constraints, agent + model-tier alignment and brief requirements (§7). Header, AC-3.1 and the problem statement corrected to match OD-2 (no clinical app; D-16 is not a defect). |
| 2026-08-25 | **Design settled** (owner brainstorm). Ten decisions recorded as DD-1…DD-10 in §3.2a, with diagrams in the [Consultation Graph Architecture](https://claude.ai/code/artifact/b6b68b73-3cb9-4cec-89f3-8afd1553c13b) artifact. Dropped: the template selector and everything it implied. Added: multi-document workflows, `trigger` as a node property, pre-summarization, per-node guards with memoization, concurrent per-node generation. Two new defects recorded — **D-21** (strict-schema confabulation pressure) and **D-22** (`PRE_SUMMARY` type overload, now **OD-6**). Phase steps added to 1, 2, 5, 6. |
| 2026-08-25 | **`@arcaai/vox-node` lane added** (owner: "one missing thing: Vox-node SDK"). R2 split across the two SDK packages (AC-2.4/2.5/2.6); §2.5 records the existing generated admin plane; §2.6 records that `.claude/rules/05-nestjs-api.md:155` still says "four artifacts" and omits `gen:admin` — the omission that turned TASK-805's pipeline #990 red (I-3, commit `5daca9ddd`). Regenerate steps added to Phases 2, 3, 4, 6; Phase 7 rewritten to cover both packages; three risks and OD-5 added. |
