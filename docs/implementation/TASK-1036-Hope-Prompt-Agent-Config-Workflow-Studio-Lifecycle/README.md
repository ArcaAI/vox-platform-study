# TASK-1036 — Hope Prompt, agent configuration, workflow management, Studio and lifecycle

**Status:** In Progress. Owner approved the plan, all decisions (§4) and the UX prototype on 2026-10-04. Wave A is starting (§5.4).
**Type:** feature + refactor (with three lifecycle bugfixes)
**Branch:** dev-2.2
**Raised:** 2026-10-04
**Programme:** TASK-1036 (this) · TASK-1038 (run integrity + delivery plane) · TASK-1039 (SDK 5.0) · TASK-1040 (payload codec, separate). See §5.1.
**Builds on:** TASK-1035 (one composer, `TemplateEditor`, schema inheritance, Prompt Inspector, guardrail opt-outs removed), TASK-982 (context-schema binding, follow-latest), TASK-893 (core vocabulary), TASK-930/931 (agent and workflow planes).

> Ticket number: TASK-1036 was the next free number on 2026-10-04 (`docs/implementation` + `git log --all`). Re-check immediately before the first commit, because parallel sessions take numbers.

## 1. Requirement Analysis

The owner brief of 2026-10-04 is condensed here. Each R-id is traced through §3–§5.

| # | Area | Requirement |
|---|---|---|
| R1 | Prompt | Consolidate the user-facing name as **Hope Prompt**. Mustache `{{}}` templating. |
| R2 | Prompt | **Derive from content** re-scans the body and *updates* the variable list. |
| R3 | Prompt | Declared variables become **nullable** inputs on the agent node. Template plus context renders the final instruction. |
| R4 | Prompt | Tags are **tenant-specific** and offered as type-ahead suggestions. |
| R5 | Agent | Per-task configuration, provider → model, capability-driven ADVANCED section, and a clean I/O schema for SDK, API, SSE, socket, realtime and batch. |
| R6 | Agent | **ASR:** VAD, noise suppression, diarization (with voice enrollment). |
| R7 | Agent | **Text:** guardrails on/off (default on; checks context and response only); tools and attachments only when the model supports them (future); DNA rewrite; structured output via a Document template; prompt from the library (version pinned) or inline; input = template variables, else `message`. |
| R8 | Agent | **TTS:** voice, speed and a prompt template. Audio is stored in the tenant bucket and streamable. |
| R9 | Agent | Advanced decoding hyperparameters are **platform-admin only**. |
| R10 | Agent | Agents can be created and updated **from inside the Studio**, and are published immediately. |
| R11 | Workflow mgmt | List screen, version history (open, delete, publish), multi-select bulk actions (delete all versions, publish, unpublish, export), create, import and settings. Opening a workflow or version goes to the Studio. |
| R12 | Studio | Header shows rename, copy slug, status, version count, history, settings, validate and publish/activate. Three tabs: **Composer**, **Test** and **Integration**. |
| R13 | Composer | Floating palette (hideable) and floating inspector (resizable and movable), both above the canvas. Inspector for nodes **and edges**. A new workflow starts with a Trigger node; deleting it is allowed but blocks publish. |
| R14 | Test | Runs draft or published versions. Executed nodes and edges are highlighted. Capability-driven controls: record with waveform, multi-line text, attachments. Consultation payload view, time-series event log, status bar (status, duration, tokens). Admin-only SSE trace. |
| R15 | Integration | Step-by-step guides with copyable snippets for vox-node, vox (browser) and raw API/SSE/socket. Each covers auth, connection type, input shape and output shape. |
| R16 | Settings | `contextSchema.inputShape` / `outputShape`. Audio is `stream` (forces socket) or `blob` (forces API). Attachment types are text/plain, text/markdown, application/pdf and image/jpeg. Output audio is stream or a blob in the tenant bucket. A **default** schema exists. |
| R17 | Settings | Connection kinds `api`, `webhook`, `sse` and `socket` move from the trigger node to **workflow settings**. `sse` ⇒ `api`; `socket` ⇒ `api`; `socket` is forced when the workflow uses an ASR or TTS agent. |
| R18 | Lifecycle | The owner's state and transition tables (DRAFT → VALIDATED → PUBLISHED [+active] → DEPRECATED), with the stated guards and run semantics. |
| R19 | Nodes | Pin agents, prompts and documents. Simple management of all three. |
| R20 | Process | Tiered agents (discovery, exploration, reasoning, evaluation). Parallel lanes within a token budget. Everything tested and verified before deployment. |

## 2. Current State Evaluation (code-verified 2026-10-04)

Four read-only `sonnet` discovery agents mapped the code, and the orchestrator re-read the TASK-1035 README. Line numbers are approximate.

### 2.1 Already done (reuse, do not rebuild)

| Capability | Where |
|---|---|
| Mustache-like grammar in TS and Python with a shared fixture. Missing variables fail by name. `default()` filter. | `workflow-contract/src/template.ts:14-23,332`; `harness/.../interpreter/templating.py:16-25`; `tests/contracts/prompt-template.fixture.json` |
| One composer (`composeMessages`), `TemplateEditor` (CodeMirror 6, `{{` completion and lint), Prompt Inspector | TASK-1035 §6.2 |
| Variable extraction (`templateReferences`, `collectPlaceholders` with `hasDefault`) | `template.ts:356,377` |
| Agent versioning: DRAFT, VALIDATED, PUBLISHED, DEPRECATED, `isActive`, `newVersion`, `activate`, `deprecate`, `compiledConfig` freeze | `agent.service.ts:559-720` |
| Provider → model picker, filtered by provider and task type | `features/agents/components/model-picker.tsx:118-205` |
| ASR VAD, denoise and diarization parameter blocks | `agent-schemas.ts:~369-480` |
| Workflow lifecycle backend: all 8 transitions exist; state names match R18; delete-active returns 409; deprecated-active returns 404 on invoke; runs record `workflowVersionId`; config is claim-checked at start; a DB immutability trigger protects frozen rows | `workflow-definition.service.ts:495-1723`; migration `20260817000100_task_734_*` |
| Export, import and clone of workflows; `GET /lineages` and `GET :id/versions` | `workflow-definition.controller.ts:117,229,254,306,332` |
| Version kit: `VersionHistoryPanel`, Activate, Deprecate and Discard dialogs, badges | `apps/admin-console/src/shared/versioning/*` |
| Integration panel with Node, Browser, Manual, Postman and Socket lanes, and snippets generated from `GET workflows/{slug}/schema` | `shared/versioning/integration-panel.tsx` |
| Push SSE run stream with exact `nodeId` events and `Last-Event-ID` resume | `workflows.controller.ts:402-436`; `workflow-runs/run-trace-screen.tsx` |
| Context-schema binding, pinned or follow-latest | `effective-trigger-schema.ts`; `compiler.ts:229-248` |
| Missing trigger blocks publish (`WF-CORE-001`) | `rule-catalogue.ts:259-268` |

### 2.2 Gaps by area

**Prompt (R1–R4)**
- "Hope Prompt" appears nowhere. There are more than 20 label sites, and the nav and page title say "Prompt Instruction Templates".
- Derive from content (`template-form-dialog.tsx:36-90`) has four problems:
  - It is add-only, so stale declarations are never removed.
  - Every derived variable gets type `string`.
  - Namespace roots are not filtered (`{{context.x}}` becomes a variable named `context`).
  - It has no server counterpart.
- Optional variables are not truly nullable:
  - An unresolved path throws (`templating.py:299-301`) unless the body uses `default()`.
  - The declaration's `required: false` is never applied at runtime.
- **Suspected defect:** `core.agent` `overrides.promptVariables` strings are bound literally. The schema says `{{…}}` interpolates (`node-config-schemas.ts:1060`), but `resolveBinding` / `_resolve_binding` return plain strings verbatim. Verify this in wave 0.
- Tags are free `String[]` columns with no suggest endpoint and no combobox. Prompt tags and agent tags follow different grammars.

**Agent (R5–R10)**
- One generic editor renders every schema field, with no Basic/Advanced split.
- There are no capability flags for `supportsTools`, `supportsVision` or `supportsAttachments`. Capabilities live in `AiModel._metadata.capabilities` (`model-catalogue.mapper.ts:28`) and are checked only at publish.
- Only one parameter is platform-managed (`diarization.embeddingModelSlug`, `agent.service.ts:1477`). Decoding and generation hyperparameters are all tenant-editable.
- **The guardrail toggle conflicts with TASK-1035 OD-1** (all opt-outs removed; `retired-guardrail-optout.ts`).
- The inbound screen inspects the whole composed prompt, not context only (`apps/text/.../egress.py:126-175,240-246`).
- DNA and the Document template live on the workflow `core.agent` node (`node-config-schemas.ts:140-215,935-975`), not on the agent.
- The prompt version pin is optional, so it is only pinned implicitly through `compiledConfig`.
- The text input field is `text`, not `message`.
- TTS has five gaps:
  - `voice` is free text.
  - There is no prompt template.
  - Output is relayed bytes only. There is no bucket and no `mediaId`, although the declared schema promises one (`agent.controller.ts:521-740`).
  - The TTS socket has no `agentSlug`.
  - There is no Studio inline create or edit; the inspector only deep-links to `/agents?create=1`.
- `AgentTask` has 4 values (NER included). There is no image-to-text agent task, only `AiTaskKind.VISION_EXTRACTION`.

**Workflow management (R11, R18)**
- There is no list screen. `/workflow-studio` redirects to the newest draft, and TASK-893 OD-1 deleted the grid. There is no version-history UI, and the client has no `activate` or `deprecate` calls. There are no bulk operations and no settings.
- Lifecycle deviations from R18:
  1. Create with an existing slug silently mints N+1 instead of returning 409 (`SVC:544-551`).
  2. Edit-as-new-draft is client-built. The server never checks that the source is PUBLISHED or DEPRECATED (`SVC:525-536`).
  3. Save resets to DRAFT only on a graph change (`SVC:1457-1472`).
  4. The Save, clone and import reports omit the publish gate. The Studio can therefore enable Publish when the server will then refuse.
  5. Activate runs its two writes outside a transaction.
  6. The DB trigger does not freeze `deprecatedAt`, and does not block DEPRECATED → anything.
  7. Publish pins prompts and documents only when the node carries a pin (`SVC:2530-2551`).

**Studio (R12–R15)**
- Docked 3-column grid (`workflow-studio-editor.tsx:127-145`). It has no top-level tabs, edges cannot be selected, there is no copy-slug button, and the version hook and panel are unused.
- The create form posts an empty graph. Deleting `core.trigger` is refused, which is the opposite of R13.
- Run lives in an inspector tab:
  - JSON-only start.
  - A 2 s poll-bridge SSE.
  - The node overlay is empty because the polled trace has no `nodeId`.
  - No token total.
- Integration is a dialog, available on PUBLISHED versions only.

**Settings (R16, R17)**
- There is no settings model. `kinds` is on `core.trigger`, with the vocabulary `consultation`, `api`, `webhook`, `schedule`. `protocols` is on `core.output`, with `http`, `http-sse`, `socket`. Both are enforced at the gateway only (`workflow-exposure.service.ts:245-262`).
- `STREAM_AUDIO` has no stream/blob axis, and `mimeTypes` are free strings.
- Seeds embed `kinds` (15 workflows) and OpenAPI mirrors `CORE_TRIGGER_KINDS`.

## 3. Target Design

> Round-1 design. Where it differs from §4 (final decisions) or §8–§10 (rounds 2–3 and the UX spec), **those win**. Notably:
> - parameters are reduced to temperature and max output tokens (W2, replacing §3.2's list);
> - data moves by bindings (§9.2);
> - document templates and DNA float to latest (W3);
> - Test-tab audio and attachments are in scope (OD-15, replacing §3.7's Phase B).

### 3.1 Hope Prompt (R1–R4)
- **Rename the labels only.** Console strings, nav and page titles, and OpenAPI tag display names become "Hope Prompt(s)". The RBAC subject `PromptTemplate`, API paths, Prisma names and contract keys stay as they are. They are wire and DB identifiers, and renaming them would cost a migration, an SDK major and a seed regeneration for no user-visible gain (OD-2).
- **Derive v2** is one pure function, `deriveVariableDeclarations(content, existing)`, in `@arcaai/workflow-contract`, mirrored by a Python fixture case:
  - It adds new roots and keeps existing declarations, preserving the user's type and description.
  - It marks unreferenced declarations stale. The UI shows a strike-through with a "Remove stale" action, so the user confirms before anything is removed.
  - It skips the namespace roots (`context`, `trigger`, `input`, `vars`, `nodes`, `variables`) and the `PLATFORM_CONTEXT_VARIABLES`.
  - `required` = `!hasDefault`.
  - The console button and the server's create/update validation both call it.
- **Nullable variables.** A declared `required: false` variable that is absent renders as `""` in both languages, and `composeMessages` drops an `EXTERNAL_DATA` block that renders empty. A required variable still fails by name (OD-10).
  - The Studio's `core.agent` inspector shows one row per declared variable: name, type, a required/optional badge, and a binding (context path via `TemplateEditor` completion, or a literal).
  - Fix the suspected override-literal defect: an override string containing `{{…}}` is rendered against the run scope.
- **Tags.** `GET admin/prompt-templates/tags?q=` returns the tenant's distinct tags, ranked by use count. It uses the tenant-scope extension, so it holds only the caller's tenant's tags; SYSTEM rows are never mixed in, per content rule TASK-890 OD-M.
  - `TagsField` becomes a combobox (free entry plus suggestions).
  - The same `key:value`-tolerant grammar applies to prompt and agent tags (lower-case, max 24).
  - The same endpoint shape is added for agents and workflows (`…/tags`), so the three tag inputs behave identically.

### 3.2 Agent configuration (R5–R10, R19)
- **Capabilities.** Add `supportsTools`, `supportsVision`, `supportsAttachments` and `voices[]` to `_metadata.capabilities`, surface them in `CatalogueModelResponse`, and seed them for the existing catalogue.
  - The editor reads the selected model's capabilities and **hides** unsupported sections.
  - Tools and attachments render as "Coming soon" sections when the model supports them (R7 says future), and are absent otherwise.
- **Basic / Advanced split per task.**
  - Basic: provider, model, prompt (library + pin, or inline), and the task extras (ASR: VAD, denoise and diarization switches; Text: DNA, Document template, structured output; TTS: voice picker from `capabilities.voices`, speed).
  - Advanced: parameters only, collapsed by default.
- **Platform-only parameters.** A schema annotation `x-platformManaged: true` generalises the existing `readOnly`/`collect()` mechanism (`platform-managed-parameters.ts:45`).
  - The server returns 403 `AGENT_PARAMETER_PLATFORM_MANAGED` to a non-super-admin. A super admin may write these in any tenant; today only SYSTEM is exempt (OD-11).
  - The editor hides the fields from tenant admins and shows "Managed by the platform".
  - Candidate list (OD-11):
    - ASR: `decoding.*` and VAD thresholds.
    - Text: `generation.{topP, topK, frequencyPenalty, presencePenalty, repetitionPenalty, seed}` and the reasoning budget.
    - Kept tenant-editable: `temperature` and `maxOutputTokens`.
- **Guardrails** — see OD-1:
  - Recommended: keep always-on (TASK-1035 OD-1 stands) and render a read-only "Guardrails: always on" row.
  - Separately, implement R7's *scope*: the inbound screen inspects only the `EXTERNAL_DATA` blocks (context), and the outbound screen inspects the response. Platform rules and template text are never sent to the screen.
- **DNA and Document template move to the agent.** Add `instruction.documentTemplate { slug, versionNumber }` and `parameters.dna { enabled }`. The node-level fields stay as optional per-node overrides for one release, then retire (OD-7).
- **Pins.**
  - Binding a library prompt stamps the current approved version into `instruction.promptVersionNumber`. The user may change it but not clear it.
  - Workflow publish freezes `agentRef.versionNumber` and the agent's prompt and document pins into `compiledConfig`, so a published workflow never follows a moving agent.
  - The Studio header shows a **Pins** rail listing agent vN, prompt vN and document vN, with an "update to latest" action on drafts (R19).
- **I/O contract.**
  - Text input is `{ message } | { variables }`; `text` stays accepted as a deprecated alias for one release (OD-8).
  - Output: text `{ text }`; ASR unchanged; TTS `{ audio: { mediaId, url, format, sampleRate }, durationMs }`.
  - TTS persists to the tenant bucket when the output shape says `blob`, and streams otherwise.
  - The TTS socket init takes `agentSlug`.
- **Inline agent create/edit in the Studio.** Extract `CreateAgentWizard` into `shared/agent-wizard`. Open it as a dialog from the `core.agent` picker:
  - Create runs create → publish(activate) and binds `agentRef`.
  - Edit runs `newVersion` → publish and re-pins the node to the new version.
  - A prompt that is not yet APPROVED keeps the agent DRAFT with an inline reason. No silent auto-approve.

### 3.3 Workflow management screen (R11)
`/workflow-studio` becomes a **lineage list** (one row per slug), using `ScreenTemplate` with `contentMode="fill"` and `AdminDataGrid`. This reverses TASK-893 OD-1 (OD-13).
- **Columns:** name, slug (copy), active version, newest draft, version count, status badges, assignments, updated.
- **Row click** opens the Studio on the active version, else the newest draft.
- **Row drawer (`DetailDrawer`):** `VersionHistoryPanel` with per-version open, publish, activate, deprecate and delete.
- **Bulk bar** (multi-select):
  - Publish (each newest VALIDATED draft) and Deprecate (labelled "Unpublish").
  - Export: one bundle per lineage, zipped.
  - "Delete all versions": deprecate the active version, then soft-delete every row, behind one typed confirmation.
  - Execution is client-side per item, with a per-item result list (OD-14).
- **Header actions:** New, Import, Templates.
- **Settings** opens the Studio's Settings dialog.

### 3.4 Lifecycle fixes (R18)
- `POST /` without `parentVersionId` on an existing slug returns 409 `WORKFLOW_SLUG_TAKEN`.
- New endpoint `POST :id/draft` (edit-as-new-draft):
  - The source must be PUBLISHED or DEPRECATED, else 400.
  - The graph is copied server-side and `parentVersionId` is set.
  - If an open draft already exists on the lineage, it returns 409 `OPEN_DRAFT_EXISTS` with that draft's id, and the console opens that draft.
- Save sets `status = DRAFT` on any change, and the Save, clone and import reports all include the publish gate. The Studio's Publish button becomes accurate.
- `activate` runs the demote and set in one transaction.
- Migration: the trigger also freezes `deprecatedAt` and refuses DEPRECATED → PUBLISHED and DEPRECATED → DRAFT status writes.
- Publish resolves and freezes the current version of every prompt and document reference, pinned or not (R19). Follow-latest context schemas stay as TASK-982 designed them, and are documented as the one live resolution.

### 3.5 Workflow settings (R16, R17)
- **Storage: `graph.settings`** (OD-5), inside the graph JSON. It is then checksummed, frozen by the existing trigger, exported in bundles and versioned with the graph. No new column is needed.
- `WorkflowSettings`, defined in `@arcaai/workflow-contract` with a Python mirror and fixture:
  ```ts
  { connections: ('api'|'webhook'|'sse'|'socket')[],
    sources: ('consultation'|'schedule')[],          // internal entry points, OD-4
    contextSchema: { contextSchemaId, versionNumber | null } | { inline } }
  ```
- **Implications** (validator, new rules `WF-SET-001..004`, ERROR):
  - `sse` ⇒ `api`, and `socket` ⇒ `api`.
  - An ASR or TTS agent, or a `stream` audio shape, ⇒ `socket`.
  - `blob` audio or an attachment ⇒ `api`.
  - The settings dialog applies the same implications live: checkboxes lock with the reason shown.
- **Migration path.**
  - The compiler reads `settings` first and falls back to the legacy `core.trigger.kinds` and `core.output.protocols` for one release.
  - A seed regeneration moves the 15 seeded workflows.
  - The gateway's `workflow-exposure.service.ts:245-262` gates on the compiled settings.
- **Shapes.** Context-schema definition v2 renames nothing on the wire. The UI calls `kinds` the **Input shape** and `outputs` the **Output shape**. It adds two things:
  - `delivery: 'stream' | 'blob'` on audio input and audio output.
  - The attachment MIME allow-list `text/plain`, `text/markdown`, `application/pdf`, `image/jpeg` (`image/jpg` normalises to `image/jpeg`), enforced in `constraintProblems`.
- **Default schema.** The seed ships a SYSTEM-authored `default_io` (input: `message` text + optional attachments; output: `text`), cloned into each tenant by the reference set (content rule). A new workflow's trigger binds the tenant default in follow-latest mode.

### 3.6 Workflow Studio (R12–R15)
- **Header:**
  - Name (inline rename), slug with copy button, and a status badge.
  - Version count, which opens the History sheet.
  - Pins rail, Settings, Validate, and Publish (with an activate switch).
  - The publish disabled-reason comes from the server report only.
- **Tabs** (`<TabsList variant="line">` in `ScreenTemplate` `tabs`): **Composer · Test · Integration**. Test is available for drafts too. Integration shows a "publish to get a live endpoint" banner on drafts.
- **Composer:**
  - The canvas fills the content region. Palette and inspector are absolutely positioned overlays.
  - Palette: collapsible.
  - Inspector:
    - Resizable through `react-resizable-panels` handles.
    - Movable: drag the header through `@dnd-kit`, keyboard-movable for WCAG 2.5.7.
    - Position and size persist in `localStorage` (try/catch).
    - Opens for a node or an edge. The edge view shows source/target ports, the condition (CEL via `TemplateEditor`) and delete.
  - Create seeds one `core.trigger` bound to the default schema. `core.trigger` becomes deletable; `WF-CORE-001` already blocks publish and the Problems view shows it.
- **Test:**
  - Left pane: the read-only graph with node **and** edge highlighting, driven by the push run stream (`useRunLiveEvents`, exact `nodeId`), not the polled trace.
  - Right-top pane: controls derived from `graph.settings` and the agent tasks found in the graph:
    - Record (waveform) when ASR is present.
    - Text dialog when text generation is present.
    - Attach when the input shape allows attachments.
    - Plus the consultation payload view, showing context items as they are built.
  - Right-bottom pane: the time-series event log (input, output, duration, error per node) from `run-trace-screen`'s feed.
  - Footer: `StatusFooter` with status, duration and tokens. Tokens come from a new `tokensTotal` on the run rollup, summed from usage events.
  - Admin-only: sandbox runs use the existing ticketed SSE. A sandbox run must resolve on the stream (to be verified), and it is never reachable by an API key.
- **Integration:**
  - `IntegrationPanel` moves into the tab and is rewritten as numbered steps in this order: 1 Authenticate → 2 Connect (lanes filtered by `settings.connections`) → 3 Send input (from the input shape: JSON body, audio stream over socket, blob/attachment upload) → 4 Receive output (output shape, SSE or socket frames, polling) → 5 Handle errors.
  - Each step has three snippets: vox-node, vox and raw HTTP/SSE/socket.

### 3.7 Test-tab audio and attachments (R14) — Phase B
Sandbox runs accept JSON only today. Phase B adds two inputs (OD-15):
- `POST admin/workflow-definitions/:id/sandbox-runs` accepts `attachments[]` as media ids, uploaded first to the tenant bucket with the R16 allow-list.
- The record control opens the existing STT streaming session (`/ws/stt/stream`) bound to a sandbox consultation that the run creates.
- Nothing in Phase A blocks Phase B.

## 4. Decisions (FINAL: owner approved 2026-10-04)

The owner answered "approved" on 2026-10-04 after reviewing rounds 1–3 and the UX prototype. That covers:
- every recommendation in §4.2 below, as written;
- directions W1–W5 (§8.1);
- the ticket split (OD-28);
- the `.claude/agents/` tier definitions.

Any line can still be overridden. An override goes in Change History and the affected lane brief is re-issued.

### 4.1 Owner directions (verbatim intent)

| Id | Direction |
|---|---|
| W1 | Nobody can delete Trigger or Output. Input is the entry point and Output is the exit. |
| W2 | Simple, friendly configuration. No advanced or encoder/decoder hyperparameters. Temperature and max output tokens only, when the provider and model support them. |
| W3 | Agents and prompt templates are pinned in every published agent and workflow. Document templates and DNA always use the latest available version. |
| W4 | Node data flow follows SOTA practice: standard node I/O, field mapping, access to context and consultation context. |
| W5 | High performance, integrity and stability. Streaming or polling. Complete SDK integration. Easy client setup. |
| W6 | A very friendly UI. Context and consultation data are offered as intelligent suggestions while composing. Testing shows the flow, the active node, all execution context and consultation data, and every event (§10, prototype). |

### 4.2 Decision register

| Id | Decision |
|---|---|
| D-1 | Keep the custom Mustache-like grammar. No library swap. |
| D-2 | Bulk actions run client-side per item with per-item results. No bulk route. |
| D-3 / OD-5 | Workflow settings live in `graph.settings`, so they are frozen, checksummed and exported with the graph. |
| D-4 | Legacy `core.trigger.kinds` and `core.output.protocols` are read as a fallback for one release, then removed (deprecation register). |
| D-5 | Every route change regenerates five artifacts (route-manifest, openapi, portal, `vox-node gen:admin`, plus the authz matrix). Cross-tenant e2e coverage on every new by-id route. |
| D-6 | The Test tab uses the push run stream. The polled trace overlay is removed. |
| D-7 | Inline agent create never auto-approves a prompt. |
| OD-1 | **Guardrails stay always on** (TASK-1035 OD-1 stands). Agents show a read-only "Guardrails: always on" row. R7's scope is implemented: the inbound screen sees only context data blocks, the outbound screen sees the response. |
| OD-2 | "Hope Prompt" is a **label-only** rename. RBAC subject, API paths and Prisma names are unchanged. |
| OD-3 | **Closed by W1.** Trigger and Output are undeletable, and the server seeds both on create. |
| OD-4 | `consultation` and `schedule` become `settings.sources`. `api`, `webhook`, `sse` and `socket` become `settings.connections`. |
| OD-6 | "Input shape" / "Output shape" are UI labels. The wire keeps `kinds` / `outputs`, plus `delivery` and a MIME allow-list. |
| OD-7 | The document template choice and the DNA switch move onto the **agent**. Both always resolve **latest** (W3). Node-level fields stay as overrides for one release. |
| OD-8 | The text agent input is `message`. `text` is a deprecated alias for one release. |
| OD-9 | **Replaced by W3.** Agent and prompt versions are frozen at publish **and enforced at runtime**. Document templates and DNA float to latest. |
| OD-10 | An optional variable with no value renders `""`, and an empty data block is dropped. A missing required variable fails by name. |
| OD-11 | **Replaced by W2.** Tenant surfaces expose only `temperature` and `maxOutputTokens`, and only when the model supports them (reasoning models: no temperature). All other parameters become platform model defaults, and a tenant write to them gets 403 `AGENT_PARAMETER_PLATFORM_MANAGED`. |
| OD-12 | An inline agent edit in the Studio publishes a new agent version and re-pins this workflow's node only. |
| OD-13 | `/workflow-studio` becomes a **lineage list** (one row per slug). |
| OD-14 | "Delete all versions" first deprecates the active version, then soft-deletes every row. One typed confirmation. |
| OD-15 | Test-tab microphone audio and attachments are **in scope**. The prototype makes them first-class, so they move from Phase B into wave C (C3), backed by B3b's sandbox input route. |
| OD-16 | Tools calling and agent attachments stay hidden until built. |
| OD-17 | The inspector floats, snaps right by default, is movable, resizable and keyboard-operable, and has a **Last run** tab. |
| OD-18 | Fan-in into a single-value input is refused. A **Merge** node combines values. |
| OD-19 | A Condition branch carries the router's input through. |
| OD-20 | References are shown by node label and stored by node id. Node config declares `label`. |
| OD-21 | A pinned agent version keeps running after it is deprecated. Deprecate warns "used by N published workflows". |
| OD-22 | "Latest" document template = latest **approved / published** version. |
| OD-23 | **Run protocol v2** for SSE and WS, both in one envelope `{seq, runId, type, ts, data}`. The six legacy shapes stay readable for one release behind a protocol header. The SDKs go to 5.0.0. |
| OD-24 | Text deltas stream from nodes wired into End, plus any node flagged `stream`. |
| OD-25 | Run events expire 24 h after terminal. Results are kept 30 days (`workflowRuns.resultRetentionDays`). |
| OD-26 | `POST /agents/:slug/runs` (async, poll, idempotent). `invocations` stays as sugar. |
| OD-27 / OD-28 | The work is split into four tickets: **TASK-1036** (this one: composer, agents, prompts, management, Studio), **TASK-1038** (run integrity + delivery plane), **TASK-1039** (SDK 5.0), **TASK-1040** (Temporal payload codec, planned separately). TASK-1037 was already taken by a parallel session (Prisma 8). |
| OD-29 | **Data moves by bindings.** Edges carry order and auto-map. |
| OD-30 | `consultation.*` is read at node start by default. `run-start` is available per binding. |
| OD-31 | Consultation writes happen only through explicit action nodes. |
| OD-32 | Lists are passed as whole values. Iteration uses an explicit Loop. |
| OD-33 | Every delta names its output field (`output.text.delta {nodeId, field}`). |
| OD-34 | The `consultation.*` read schema is platform-owned, versioned, and published with `@arcaai/workflow-contract`. Each field carries a PHI class. |

## 5. Implementation Plan (programme across TASK-1036 / 1038 / 1039)

### 5.1 Ticket ownership

| Ticket | Owns | Design record |
|---|---|---|
| TASK-1036 (this) | Hope Prompt, agent configuration, NodeIO and bindings contract, consultation read schema, settings, lifecycle fixes, management screen, Studio (Composer, Test, Integration), tags | §3, §8.4–§8.6, §9, §10 |
| TASK-1038 | Runtime integrity (D-A, D-B, D-H, D-I, R-1…R-9), run protocol v2, agent run resource, idempotency everywhere, stream and result retention, consultation declared-read route | TASK-1036 §8.2, §8.7, §8.8, §10.3 |
| TASK-1039 | SDK 5.0: vox-node `RunHandle`, vox `useRun` / `useRunAudio`, frame normaliser, docs snippets | TASK-1036 §8.7 |
| TASK-1040 | Temporal payload codec for PHI at rest (separate design, not scheduled in these waves) | TASK-1036 §8.2 R-7 |

### 5.2 Agent team: tier and effort per stage (rule 14 §1)

Four project agent types are defined in `.claude/agents/`:

| Agent type | Model | Effort | Tools |
|---|---|---|---|
| `hope-scout` | `haiku` | low | read-only |
| `hope-lane` | `sonnet` | medium | — |
| `hope-lane-deep` | `opus` | high | — |
| `hope-reviewer` | `opus` | high | read-only |

The tier and effort then live in files instead of memory. New agent files load only at **session start** (Claude Code docs, *sub-agents* frontmatter reference). This orchestrating session therefore spawns the built-in `general-purpose` and `Explore` types with an explicit `model:` per lane, and effort is stated in each brief. Later sessions use the defined types.

| Stage | Tier |
|---|---|
| Inventories, label sweep, "does X still exist" checks | `haiku` |
| Discovery (done: 8 agents, about 1.9M tokens) | `sonnet` |
| Mechanical lanes with a frozen contract and an exact file list | `sonnet` |
| Lanes whose code **is** the decision (contract, runtime integrity, streams, Composer, Test tab) | `opus` |
| One adversarial review of the frozen contract before any consumer lane starts | `fable` |
| Review, three distinct lenses | `opus` ×2 + `sonnet` (UX) |
| Integration, migrations, shared surfaces, gates, live proof | orchestrator (`opus`) |

### 5.3 Rules every lane brief carries

1. **Worktree, not the primary checkout.**
   - The orchestrator creates `../hope-v2-<lane>` on branch `task-<nnnn>/<lane>`, from `dev-2.2` at the wave's base commit.
   - Symlink `node_modules` from the primary (root and each package the lane tests).
   - Build workspace `dist/` inside the worktree.
   - **Never run `pnpm install` / `pnpm add`**, and never `git stash`.
2. **Shared surfaces belong to the orchestrator:**
   - `db:*`, migrations, seeds and Docker;
   - route-manifest, openapi, portal and `gen:admin` regeneration;
   - the `packages/workflow-contract/src/index.ts` barrel;
   - lockfile and dependency changes (TASK-1037 is upgrading Prisma in parallel, so no lane bumps a dependency).

   A lane that needs SQL writes it to `docs/implementation/<ticket>/sql/` and the orchestrator applies it through the shadow-DB recipe.
3. **TDD.** A RED test first for every behaviour in the brief. The lane runs **only its own test files**, per the owner rule (no package-wide gates before the full merge). Python lanes run `~/miniconda3/envs/arcaenv/bin/python -m pytest <files>`, because `conda run` is broken in the sandbox.
4. **Harness changes** go behind a `workflow.patched("task-1038-<name>")` (or `task-1036-…`) gate, and the missing replay fixtures are captured **before** `workflows.py` changes.
5. **Commit in the worktree** with a ticket-prefixed message. Do not merge, push or rebase onto another lane.
6. **Return contract.** The report is data for the orchestrator:
   - branch and head SHA;
   - files changed;
   - RED→GREEN evidence (pasted command output);
   - tests the lane could not run, and why;
   - contract assumptions;
   - follow-ups;
   - tokens used against the cap.
7. **Token cap.** At 1.5× its estimate a lane stops and reports what remains.

### 5.4 Waves

#### Wave A: start now (none of these lanes depends on the new contract)

| Lane | Ticket | Tier | Owns | Delivers |
|---|---|---|---|---|
| A1 RUN-HARNESS | 1038 | opus | `apps/harness/src/harness/temporal/**`, `apps/harness/src/harness/services/{api_client,text_client}.py`, their tests | See below |
| A2 RUN-GATEWAY | 1038 | opus | `apps/api/src/modules/workflows/**`, `packages/applications/src/services/{workflow-exposure,workflow-run}/**`, a NEW internal agent-by-version controller and service file | See below |
| A3 LIFECYCLE | 1036 | sonnet | `packages/applications/src/services/workflow-definition/**`, `apps/api/src/modules/workflow-definition/**` | See below |
| A4 PROMPT-TAGS | 1036 | sonnet | `packages/applications/src/services/prompt-management/**`, `apps/api/src/modules/prompt-management/**`, `apps/admin-console/src/features/prompt-templates/**`, `src/shared/prompt-picker/**`, a NEW `src/shared/tags-field/**` | See below |
| C0a CONTRACT-GRAPH | 1036 | opus | `packages/workflow-contract/src/` NEW `node-io.ts`, `bindings.ts`, `workflow-settings.ts`, `consultation-read-schema.ts`, `binding-source-paths.ts`; edits to `compiler.ts`, `rule-catalogue.ts`, `publish-findings.ts`, `schema-variable-paths.ts`, `node-config-schemas.ts`; NEW fixtures in `tests/contracts/` | See below |
| C0b CONTRACT-AGENT-PROTOCOL | 1036 + 1038 | opus | `packages/workflow-contract/src/{agent-schemas.ts, prompt-scope.ts, compose-messages.ts, context-schema-definition.ts}`, NEW `derive-variable-declarations.ts`; `packages/async-contract/src/` NEW `run-protocol.ts`; NEW fixtures | See below |

**A1 RUN-HARNESS delivers:**
- Replay fixtures first (`task-731/932/946` patches and the child workflows).
- **D-A:** resolve the agent by its pinned version through A2's route, and use that version's frozen prompt (no runtime template fetch).
- **D-B:** run timeout from `caps.maxTotalSeconds`.
- **R-4:** cancellation propagates to in-flight activities and children.
- **R-5:** `non_retryable_error_types` and backoff from the config.
- **D-H:** keep a degraded node's output.
- **R-3:**
  - claim-check node outputs larger than 20 KB;
  - stop copying the run payload into every activity;
  - a pre-flight size guard that fails the run by name with `PAYLOAD_TOO_LARGE`.
- **R-6:** one shared `httpx.AsyncClient` per worker, and an immutable agent-version cache keyed `(tenantId, slug, version)`.
- **D-I (producer):** `run.completed` carries the result inline when ≤ 64 KB, else a `resultRef`.

**A2 RUN-GATEWAY delivers:**
- **R-1:** a pooled or multiplexed Redis stream reader.
- **R-2:** watcher retry, plus a terminal fallback poll for watchers and SSE.
- **R-9:** SSE `drain` and WS `bufferedAmount` backpressure.
- **G11:** WS gap resync.
- **D-I (consumer):** persist the result into the read model, and add `GET workflows/:slug/runs/:runId/result` (inline, or a short-lived signed URL for a ref).
- Stream `EXPIRE` 24 h after terminal.
- Status falls back to the read model when the harness returns 404.
- The internal route `GET internal/agents/:slug/versions/:versionNumber/resolved`, with the same shape as today's resolve, tenant-checked, 404-over-403.

**A3 LIFECYCLE delivers:**
- §3.4 in full:
  - 409 `WORKFLOW_SLUG_TAKEN`;
  - `POST :id/draft` (409 `OPEN_DRAFT_EXISTS`);
  - Save resets to DRAFT on any change;
  - the publish gate is recorded on Save, clone and import;
  - activate runs in a transaction.
- **W1:** server-side seeding of `core.trigger` + `core.output` when the create graph is empty.
- SQL for the `deprecatedAt` / DEPRECATED freeze trigger, written to `docs/…/TASK-1036…/sql/`.

**A4 PROMPT-TAGS delivers:**
- `GET admin/prompt-templates/tags?q=`, tenant-scoped, ranked by use.
- The tag grammar unified with agents.
- A `TagsField` combobox.
- "Hope Prompt" labels inside the files it owns.

**C0a CONTRACT-GRAPH delivers:**
- `NodeIO` declarations for the 11 core nodes, plus agent outputs per task (§9.1).
- The binding model `from` / `value` / `template` (§9.2), and translation of legacy port bindings.
- Publish rules: ancestor-only, type compatibility, every required input bound, single producer per input (OD-18).
- `WorkflowSettings` with rules `WF-SET-001..004` (§3.5).
- The `consultation.*` read schema with a PHI class per field (§9.3), declared-read extraction, and `bindingSourcePaths(graph, nodeId)` for the picker (four scopes, typed).
- Node `label` declared (OD-20).
- `core.trigger` and `core.output` stay mandatory.

**C0b CONTRACT-AGENT-PROTOCOL delivers:**
- Agent schema: capability flags (`supportsTools`, `supportsVision`, `supportsAttachments`, `voices`); `x-platformManaged` on every parameter except `temperature` and `maxOutputTokens`; `instruction.documentTemplate { slug }` (always latest); `parameters.dna.enabled`; the `message` input with a `text` alias.
- `deriveVariableDeclarations` (§3.1).
- Nullable variable semantics, and dropping an empty data block (OD-10).
- Context-schema v2: `delivery`, and the MIME allow-list.
- **Run protocol v2:** envelope, the event catalogue of §10.3 plus the public subset, and the resume / `run.resync` rules.

**After wave A (orchestrator):**
1. Merge order: C0b → C0a → A3 → A4 → A2 → A1. Add the barrel exports.
2. Apply the A3 SQL on a shadow DB (replay plus an empty `migrate diff`), then sync the dev DB.
3. Regenerate the five artifacts.
4. Run **one `fable` adversarial review** of the merged contract against §9 and §10.3. It must answer three questions:
   - Can every seeded workflow translate?
   - Is every §10.3 event derivable?
   - Do the PHI classes cover every `consultation.*` field?
5. Fix the review's findings, then **freeze** the contract.

#### Wave B: contract consumers, backend

| Lane | Ticket | Tier | Owns | Delivers |
|---|---|---|---|---|
| B1 HARNESS-CONTRACT | 1036 + 1038 | opus | `apps/harness/src/harness/temporal/interpreter/**` | See below |
| B2 GATEWAY-AGENT | 1036 + 1038 | opus | `packages/applications/src/services/agent/**`, the model-catalogue mapper, `apps/api/src/modules/agent*/**`, `apps/api/src/modules/speech/tts-ws.gateway.ts` | See below |
| B3a GATEWAY-STREAMS | 1038 | opus | `apps/api/src/modules/workflows/**`, `apps/api/src/modules/consultation/consultation-job*`, `packages/applications/src/services/consultation/jobs/**`, `packages/applications/src/services/workflow-exposure/**` | See below |
| B3b GATEWAY-PUBLISH-READ | 1036 + 1038 | opus | `packages/applications/src/services/workflow-definition/**`, NEW `services/consultation-read/**`, NEW internal controller, `services/workflow-sandbox-run/**` | See below |
| B4 TEXT-EGRESS | 1036 | sonnet | `apps/text/src/text/**` egress and output gate | See below |

**B1 HARNESS-CONTRACT delivers:**
- Python mirror of NodeIO, bindings, settings and nullable semantics (fixture parity).
- A pure binding resolver inside the workflow.
- A `consultation.read` activity: declared reads only, through B3b's route, at node start or run start.
- NodeIO output envelopes.
- Protocol v2 debug events (§10.3).
- **LLM text streaming** (`stream:true`) for nodes wired to End or flagged `stream`.
- Settings read, with the legacy fallback.
- Replay-compatible.

**B2 GATEWAY-AGENT delivers:**
- Capability catalogue fields.
- The platform-managed guard generalised.
- The prompt version stamped into the agent at bind time.
- Document template and DNA on the agent.
- `message` alias.
- `POST /agents/:slug/runs` with `Idempotency-Key`.
- TTS: persist to the tenant bucket, return `mediaId` + a signed URL, and accept `agentSlug` on the TTS socket.
- `GET admin/agents/tags`.

**B3a GATEWAY-STREAMS delivers:**
- Protocol v2 emission on SSE and WS (a version header, legacy shapes kept).
- `Idempotency-Key` on summary, pre-summary and ASR starts.
- Job stream fixes G6, G10 and G16.
- Status and cancel vocabulary (G14).
- Run-scoped ticket for browser SSE with API keys (G12).

**B3b GATEWAY-PUBLISH-READ delivers:**
- At workflow publish, freeze `agentRef.versionNumber` and the agent's prompt pin. Documents and DNA stay floating (W3).
- Settings-gated exposure.
- `POST internal/consultations/:id/read {paths}`: declared paths only, per-field PHI, tenant-checked, 404-over-403.
- The sandbox run accepts `attachments[]` (media ids) and a recording session.
- `GET admin/workflow-definitions/tags`.

**B4 TEXT-EGRESS delivers:** the inbound screen inspects only `EXTERNAL_DATA` blocks; the outbound screen inspects the response (OD-1).

**After wave B (orchestrator):**
- Merge.
- Regenerate the seeds: 15 workflows to settings + bindings, the `default_io` schema, capability metadata, platform model defaults.
- Regenerate the five artifacts.
- Run replay-compat once.

#### Wave C: console and SDK

Launched in two batches of five so every report gets reviewed. Before batch 1, the orchestrator adds stub exports so no two lanes share a file: `TestTab`, `IntegrationTab`, `SettingsDialog`, `ManagementScreen`, `FloatingPane`.

| Lane | Ticket | Tier | Owns | Delivers |
|---|---|---|---|---|
| C1 MANAGEMENT | 1036 | sonnet | `app/(console)/(tenant)/workflow-studio/page.tsx`, `features/workflow-studio/components/management/**` | §3.3 lineage list, version drawer, bulk actions, import |
| C2a STUDIO-SHELL | 1036 | sonnet | `workflow-studio-editor.tsx`, `studio-toolbar.tsx`, `components/header/**`, `components/settings/**`, `FloatingPane` | §3.6 header: copy slug, version count and history sheet, pins rail, Settings dialog with live implications (§3.5). Composer / Test / Integration tabs. Floating, movable, resizable panes (OD-17). |
| C2b COMPOSER | 1036 | opus | `components/canvas/**`, `components/inspector/**`, `components/palette/**`, `packages/ui/src/components/**/workflow-canvas*`, `packages/ui/src/components/custom/template-editor.tsx` | §8.4 + §10.1: typed task ports, `isValidConnection`, auto-map, edge labels, + on edge, drop-to-add command menu; the four-scope picker with type ranking, samples and PHI badges in `TemplateEditor`; the Inputs panel; condition builder; Merge preset; edge inspector; Last run tab; W2 generation fields |
| C3 TEST-TAB | 1036 + 1038 | opus | `components/test-tab/**`, `shared/sandbox/**` | §10.2 in full: live flow, step panel, capability-driven controls (mic with waveform, message, attach), four context views, filtered and searchable event list, time travel, PHI toggle, status bar |
| C4 INTEGRATION | 1036 | sonnet | `components/integration-tab/**`, `shared/versioning/integration-panel.tsx`, `shared/docs/**` | §3.6 step-by-step lanes (auth → connect → input → output → errors) for vox-node, vox and raw, driven by settings and shapes |
| C5 AGENT-EDITOR | 1036 | sonnet | `features/agents/**`, NEW `shared/agent-wizard/**` | §8.6 simple editor (W2), capability-gated sections, voice picker, diarization enrollment hint, document template + DNA switch, "used by N" on deprecate (OD-21), the inline create/edit dialog used by C2b's picker |
| C6 PROMPT-UI | 1036 | sonnet | `features/prompt-templates/**` | Derive v2 UI (stale marking), variable types |
| S1 VOX-NODE-5 | 1039 | sonnet | `packages/vox-node/src/**` except `resources/admin/**` | `RunHandle` (`.text()`, `.events()`, `.result()`, `.wait()`, `.cancel()`, auto-resume), `hope.agents.run`, protocol v2 normaliser, media upload helper, `runWithAudio` |
| S2 VOX-5 | 1039 | sonnet | `packages/agentic-sdk-v2/src/**` | `useRun`, `useRunAudio`, resume on mount, run-scoped tickets, protocol v2 normaliser |
| C7 LABEL-SWEEP | 1036 | haiku | Remaining "Prompt template" labels outside the files above | Runs after every wave C merge |

Batches:
- **Batch 1:** C1, C2a, C2b, C5, S1.
- **Batch 2:** C3, C4, C6, S2, after batch 1 merges, because C3 and C4 mount inside C2a's tabs.
- C7 runs last.

#### Wave D: evaluation (read-only, in parallel, on the fully merged tree)

| Reviewer | Lens |
|---|---|
| R-A `opus` | Correctness: lifecycle against the R18 tables, W3 pin enforcement end to end, binding and type rules, Python parity, seed translation |
| R-B `opus` | Security and tenancy: every new route and stream (tags, draft, results, consultation read, agent runs, TTS media), 404-over-403, admin-only trace, PHI exposure in events, idempotency replay safety |
| R-C `sonnet` | UX and a11y against rules 10, 11 and 12 and the prototype: focus behind floating panes (2.4.11), keyboard move and resize (2.5.7), both themes |

Findings are data. The orchestrator verifies each one, then fixes it or rejects it with the reason in Change History.

### 5.5 Token budget

| Wave | Agents | Estimate | Cap (1.5×) |
|---|---|---|---|
| Discovery (spent) | 8 sonnet + 1 web | 1.9M | — |
| A | 4 opus + 2 sonnet | 1.0 + 0.9 + 0.9 + 0.7 + 0.5 + 0.4 = **4.4M** | 6.6M |
| Contract review | 1 fable | 0.3M | 0.45M |
| B | 4 opus + 1 sonnet | 1.0 + 0.8 + 0.8 + 0.7 + 0.3 = **3.6M** | 5.4M |
| C | 2 opus + 7 sonnet + 1 haiku | 1.1 + 0.9 + 7 × 0.5 + 0.1 = **5.6M** | 8.4M |
| D | 2 opus + 1 sonnet | **0.9M** | 1.35M |
| Orchestrator (merges, migrations, seeds, gates, live proof) | — | **2.0M** | — |
| **Programme** | | **≈ 16.8M** (+1.9M spent) | 22M ceiling |

The budget holds because:
- the contract is frozen before consumers start;
- briefs carry file:line maps from discovery, so no lane re-explores;
- file ownership is disjoint, and stubs remove shared files;
- no lane runs package-wide gates;
- reviewers read diffs;
- `haiku` does the sweep.

### 5.6 Verification before deployment (all required)

1. **One gate pass on dev-2.2 after wave C:**
   - `pnpm lint:all`, `typecheck:all`, `test:unit`, the affected `build`s;
   - `api:openapi:check`, `api:portal:check`, `vox-node gen:admin:check`;
   - `gen:model` / `gen:entity` / `gen:factory` checks;
   - pytest for harness (including `test_replay_compat`), text and guardrail;
   - `tests/contracts` parity.

   Output is pasted into §6. Pre-existing failures are listed, not fixed.
2. **API e2e:**
   - the authz matrix with the regenerated manifest;
   - cross-tenant specs for every new by-id route;
   - the console Playwright journey: list → Studio → compose (picker, auto-map) → test (mic sample, events, time travel) → publish → integration snippet → invoke through vox-node `RunHandle` with streamed text and `.result()`.
3. **Integrity proofs:**
   - Republish an agent; a published workflow still runs its pinned version (D-A).
   - A run over its timeout ends TIMED_OUT (D-B).
   - A 300 KB output survives through a claim-check (R-3).
   - Cancel stops in-flight activities (R-4).
   - API callers read results (D-I).
4. **Performance proof:**
   - 200 concurrent SSE streams, with p95 time-to-first-frame and per-event latency measured before and after R-1.
   - A 10-step workflow's history size before and after R-3.
5. **Live browser proof** (`next-dev-loop`): both themes, axe at 0 violations, screenshots in §6.
6. **Migration:** shadow-DB replay plus an empty `migrate diff`, then the dev DB synced.
7. **Release and deploy:**
   - SDK 5.0 is published locally per the runbook; the owner tags it.
   - Cluster rollout only after the owner pushes.
   - The cluster reseed needs `hope-reset` or an admin-API republish.
   - Live-check the seeded workflows' settings and bindings on the cluster.

## 6. Implementation Summary

Wave A in progress (2026-10-04). Per-wave merge commits, gate output and live evidence are recorded here as each wave lands.

### 6.1 Wave A: launched 2026-10-04 from base `45ce54bc6`

| Lane | Ticket | Tier | Worktree | Branch |
|---|---|---|---|---|
| A1 RUN-HARNESS | 1038 | opus | `../hope-v2-task-1038-a1-harness` | `task-1038/a1-harness` |
| A2 RUN-GATEWAY | 1038 | opus | `../hope-v2-task-1038-a2-gateway` | `task-1038/a2-gateway` |
| A3 LIFECYCLE | 1036 | sonnet | `../hope-v2-task-1036-a3-lifecycle` | `task-1036/a3-lifecycle` |
| A4 PROMPT-TAGS | 1036 | sonnet | `../hope-v2-task-1036-a4-tags` | `task-1036/a4-tags` |
| C0a CONTRACT-GRAPH | 1036 | opus | `../hope-v2-task-1036-c0a-contract` | `task-1036/c0a-contract-graph` |
| C0b CONTRACT-AGENT-PROTOCOL | 1036 + 1038 | opus | `../hope-v2-task-1036-c0b-protocol` | `task-1036/c0b-contract-protocol` |

Worktree setup:
- `node_modules` is symlinked from the primary checkout, along with every `packages/*/dist` except the packages that lane modifies, and the generated Prisma client.
- `.env.dev` and `.env.test` are copied in.
- Nothing is installed inside a worktree.

Lane briefs carry the cross-lane interfaces:
- `GET /api/v1/internal/agents/:slug/versions/:versionNumber/resolved`: A2 serves it, A1 calls it.
- The `run.completed.data.result` shape `{kind:'inline',value} | {kind:'ref',bucket,key,sizeBytes,sha256}`: A1 produces it, A2 consumes it, and C0b types it.
- C0b's nullable rendering and empty-block dropping are behind options that default off, so Python parity holds until B1.

### 6.2 Wave A: merged into dev-2.2 (2026-10-04)

**Lane results.** Every lane reported RED→GREEN evidence. The orchestrator re-ran each lane's tests on the merged tree.

| Lane | Head | Merge | Notes |
|---|---|---|---|
| C0b | `668edb89f` | merge(task-1036) c0b | 5 deliverables; existing goldens byte-identical; 26 of 38 seeded agents would fail `PROMPT_VERSION_UNPINNED` (seed pins come in wave B) |
| C0a | `4faf16fe2` | merge(task-1036) c0a | 1,217 package tests; all 15 seeds compile byte-identically with the new output switched off (`emitDataContract`, default off until B1); defect confirmed: `promptVariables` `"{{…}}"` binds literally (fix in B1) |
| A3 | `1b4099e13` | merge(task-1036) a3 | 7 deliverables; `POST :id/draft`; W1 seeding of Start/End; freeze SQL |
| A4 | `4430d5b9f` | merge(task-1036) a4 | Tags suggest route, grammar, `TagsField`, Hope Prompt labels in owned files |
| A2 | `61951fec3` | merge(task-1038) a2 | R-1 solved with ONE multiplexed `XREAD` hub per process (2 connections, `CLIENT UNBLOCK` wake-up) instead of a pool; result route; purge; 5 settings; pinned-version internal route |
| A1 | `570d995fd` | `1d3e4b27b` | D-A, D-B, R-3…R-6, D-H, D-I; 5 new patch markers; replay fixtures for task-731/932/946 and the child workflows |

**Integration commits:**

| Commit | What |
|---|---|
| `a902e8952` | Contract barrels; `PROMPT_VERSION_UNPINNED` in `AgentFindingCode`; 9 test files moved to the Hope Prompt labels; harness claim-check env surface regenerated |
| `4ae580b47` | Migration `…_task_1036_workflow_definition_freeze_deprecated` |
| `84bc407b3` | Workflow seed blobs regenerated (registry checksum) |
| `820ea91d9` | Route manifest, OpenAPI, portal and vox-node admin regenerated; authz inventory re-pinned to 39 internal public routes. TASK-1035 had added one without re-pinning. |

**Verification on the merged tree:**

| Check | Result |
|---|---|
| Type checks: applications, api, admin-console | Clean |
| `@arcaai/workflow-contract` | 76 files, 1,308 tests |
| `@arcaai/async-contract` | 6 files, 107 tests |
| Services and API: workflow-definition, prompt-management, workflow-exposure, workflow-run, agent version resolver, context schema, settings registry, the workflows / workflow-definition / prompt-management / internal / streaming modules | 208 files, 2,500 tests |
| Harness TASK-1038 plus all replay suites | 114 passed |
| Agents and inspector console suites | 348/348 |
| Database seed tests | 70 files, 943 tests |
| `api:openapi:check`, `api:portal:check`, `vox-node gen:admin:check`, `env:sync:check`, `env:python-surface:check` | Green |

**Migration, proven on a throwaway shadow DB** on the test Postgres (`:5433`; the dev Postgres container is not running):
- Full replay, then `migrate diff` empty.
- Deprecating a PUBLISHED row is allowed.
- On a DEPRECATED row, writes to `status` / `deprecatedAt` / `isActive=true` are refused by the trigger.
- Soft delete is allowed.

**Not done yet:**
- `db:push` to the dev DB, which is down. Run `pnpm db:push` when the dev stack is next up.
- Known red until B1 lands: `packages/py-workflow-contract` `test_parity.py` (+2 from the extended `compiled-config.schema.json`; one failure pre-existed).

**Deviations recorded:**
- A1's three node-output / inline / activity-input thresholds are `HARNESS_CLAIM_CHECK_*` env vars, following the existing claim-check pattern. Under the owner's config rule they move to settings-registry descriptors in B1.
- A2 edited the WS gateway and `internal.module.ts`, outside its strict ownership list, because the deliverables required it. No overlap with any other lane.
- The tags service and controller had partial RED evidence. The full gate covers them.

## 8. Discussion round 2 (2026-10-04)

### 8.1 Owner directions received

| # | Direction | Effect on the plan |
|---|---|---|
| W1 | Nobody can delete Trigger or Output. Input is the entry point and Output is the exit. | **Closes OD-3** (answer: no). This matches the code: both are in `MANDATORY_NODE_TYPES` (`node-config-schemas.ts:1626`). The remaining gap is that a new workflow starts empty, so seed both nodes (`initializeGraph` exists and only tests call it). |
| W2 | Friendly and simple. No advanced, encoder or decoder hyperparameters. Temperature and max output tokens only, when the provider and model support them. | **Replaces OD-11.** The agent editor and the node inspector show only those two, capability-gated. Every other parameter leaves tenant surfaces (§8.6). |
| W3 | Pin agents and prompt templates in every published agent and workflow. Document templates and DNA always resolve to the latest available version. | **Replaces OD-7/OD-9.** Pins must be *enforced at runtime*, which they are not today (§8.2 D-A). Document and DNA pins are removed. |
| W4 | Understand node-to-node data flow and use current SOTA practice. | §8.2–§8.4. |
| W5 | High performance, integrity and stability. Streaming or polling. Seamless, complete SDKs. Easy client setup. | §8.5–§8.7. |

Second discovery round, tiered: three `sonnet` code mappers (graph data flow, harness runtime, delivery plane and SDKs) and one `sonnet` web researcher, about 1.1M tokens in total. The orchestrator (`opus`) re-checked the four highest-impact claims in code before writing them here. Those four are marked **✔ verified**.

### 8.2 How data flows today, and the defects that matter

**Today's model in one paragraph.**
- A graph is `{nodes, edges}`. An edge is `{from, fromPort, to, toPort}` with no mapping or condition (`graph-model.ts:41-47`).
- At publish the compiler turns edges into input bindings, plus `branchGuards` for router handles (`compiler.ts:331-363`).
- At runtime one Temporal workflow per run walks precomputed **topological stages**. Each stage runs `asyncio.gather` over its nodes and waits for all of them before the next stage starts (`interpreter/workflow.py:571-585`).
- A node receives:
  - (a) the values on its bound input ports;
  - (b) the run scope `{trigger, vars, nodes.<id>}`, read by `{{ }}` templates and CEL;
  - (c) for `core.data`, dotted mappings.
- Outputs live in the workflow's memory and in Temporal history, inline. Only `core.output`, loop carry and TTS audio are claim-checked.

**Defects found (data flow and integrity).** D-A, D-B and D-I were confirmed in code by the orchestrator; the rest are discovery findings and are re-proved by a RED test before they are fixed.

| Id | Defect | Evidence | Impact |
|---|---|---|---|
| D-A | **Pins are not enforced.** The harness never reads `compiledConfig.policyBindings`. `agentRef.versionNumber` only *refuses* when the active version differs (`agent_version_drift`), and never runs the pinned version. Prompts resolve to the latest approved version at runtime. | grep: the only reader is the parser at `compiled_config.py:281`; `nodes/core.py:2038-2066`; `_llm_policy.py:167-187` | Republishing an agent silently changes or breaks published workflows. This contradicts W3. |
| D-B | **No whole-run timeout.** `maxTotalSeconds` is parsed and never enforced; start passes no execution timeout. | `compiled_config.py:259` is the only reference | A run can hang forever |
| D-C | **ASR → next agent passes nothing.** Dragging from an ASR agent resolves to `out → in`, but the ASR output key is `transcript`, so the binding is silently skipped. | `core.py:1750`; `workflow.py:641-642` | Silent wrong behaviour |
| D-D | **Trigger → agent passes no data.** `context<schema>` ⋢ `text`, so the drag becomes a control edge (`next → after`). | `socket-resolution.test.ts:61-64` | Users can't wire context |
| D-E | **Fan-in is last-write-wins.** Ports are declared `multiple:true` but only one value survives. | `compiler.ts:358`; `workflow.py:591-593` | Silent data loss |
| D-F | **The canvas can't draw the ports the seeds use** (`transcript`, `data`). The agent task never changes the ports in the Studio. | `canvas-handles.ts:62-109`; `seed/28-workflow-library.ts:267,291` | Seeded flows can't be authored |
| D-G | **No typed reference to upstream outputs.** Users type `{{nodes.node_k3x9_2.text}}`. Publish treats `nodes` as a wildcard. CEL is not type-checked. | `publish-findings.ts:437-439`; `create-graph-store.ts:138-140` | Fragile, unfriendly |
| D-H | **A degraded node's output is discarded.** A note that was generated and billed is lost. | `workflow.py:940-953`; `core.py:1652-1665` | Data loss |
| D-I | **Workflow result unreadable by API callers.** No terminal path passes `resultRef`, so `WorkflowRun.resultRef` stays null. `deliver.py:15-21` states this gap. | `workflow-run-completion.service.ts:151-164`; `workflow-exposure.service.ts:843-850` | Business-plane callers can't get the output. Consultation flows still work through their own write path. |

**Stability and performance risks (runtime and delivery).** R-1 was confirmed in code; the rest are discovery findings, re-proved by test before fixing.

| Id | Risk | Evidence |
|---|---|---|
| R-1 | Each of the stream and completion services holds **one** Redis reader connection, and every blocking `XREAD BLOCK 15s` from every SSE client, blocking call and watcher queues on it. That is head-of-line blocking: latency grows with the number of concurrent streams. | `workflow-stream.service.ts:312-331`; `workflow-run-completion.service.ts:243-244` |
| R-2 | A watcher dies silently on an XREAD error. The SSE stream has no terminal fallback poll, so a lost `run.completed` leaves the stream open forever. | `workflow-run-completion.service.ts:79`; `workflow-stream.service.ts:162-190` |
| R-3 | No 2 MB guard on the walk path. The run payload is copied about 4× into every `core.*` activity input, so history grows quadratically. An oversized payload stalls the run instead of failing it. | `workflow.py:1034-1039` |
| R-4 | Cancel is cooperative between stages. In-flight activities and children keep running while the run already reads CANCELED. | `workflow.py:428,1342-1347` |
| R-5 | Retries carry no `non_retryable_error_types`; the configured backoff is ignored. | `workflow.py:926` |
| R-6 | Per-request `httpx.AsyncClient`, no agent-resolution cache, prompt fetched at runtime. `HARNESS_LLM_MAX_CONCURRENCY=1` serialises parallel LLM nodes. The stage barrier waits for the slowest node. | `api_client.py:422`; `text_client.py:332`; `core.py:2038`; `llm_concurrency.py:53` |
| R-7 | Redis run streams have no TTL. TTS audio (possible PHI) sits there without expiry. Temporal history holds PHI with no payload codec. | `run_events.py:227`; `client.py:55-72` |
| R-8 | Replay fixtures are missing for three patches (`task-731/932/946`) and for the child workflows. | `workflow.py:165-172` |
| R-9 | No backpressure. Workflow SSE ignores `res.write()`'s return value and WS ignores `bufferedAmount`. | `workflow-stream.service.ts:187`; `workflow-ws.gateway.ts:171` |

### 8.3 What current practice does (sources in the research report, 2026-10-04)

- **Typed edges, validated at connect time.** OpenAI Agent Builder, Langflow, React Flow `isValidConnection`.
- **Reference upstream data through a picker built from typed output schemas:** Dify's `/` picker, n8n drag-a-field, Zapier `+`. Raw `{{ }}` is the escape hatch. Tokens are keyed by a stable node id and shown by label.
- **Mapping only references.** Reshaping happens in an explicit Transform / Set-state node (n8n, OpenAI).
- **Start and End are system nodes.** Start defines the inputs and End validates the output schema (OpenAI, Dify, Vellum).
- **Add nodes three ways:** palette, `+` on an edge (auto-rewires), and drop-on-canvas with a command menu.
- **Per-node "Last run" view and single-node test** with cached upstream values (Dify). Run trace as an ordered node list.
- **LLM node: model, prompt and output format up front; a few knobs behind Advanced** with presets. Controls driven by capabilities, for example no temperature on reasoning models, which return 400.
- **Draft vs published, immutable numbered versions, and production pinned by default** (Langfuse, Vellum, OpenAI, n8n 2.0).
- **One event model for SSE and WS:**
  - Typed events with a monotonic `sequence_number`, `ping` keepalive and `error` frames (OpenAI Responses, Anthropic).
  - Run then stream, resumable by cursor; poll when streaming isn't possible; idempotent cancel (OpenAI background mode).
  - An expired cursor gets an explicit resync.
  - A client disconnect never cancels the run (AI SDK resumable streams).
- **Starts and webhooks:** `Idempotency-Key` on starts; Standard Webhooks signing; WebSocket only for bidirectional audio (OpenAI Realtime).
- **Durable engine:** pin in-flight runs to their release; claim-check above about 20 KB; deterministic workflow code with replay tests in CI (Temporal).

### 8.4 Proposed composer model: simple by default

1. **System nodes.** Every new workflow opens with **Start** (`core.trigger`) and **End** (`core.output`) already placed and connected. Neither can be deleted, duplicated or disabled (W1).
   - Start shows the Input shape.
   - End shows the Output shape and is where the result is validated.
2. **Task-aware typed ports.** A `core.agent` node shows only its task's ports, and port colour encodes type.

   | Task | In | Out |
   |---|---|---|
   | ASR | `audio` | `transcript` (text) |
   | Text | `message` (text), `context` | `text`, plus `data` when structured |
   | TTS | `text` | `audio` |
   | NER | `text` | `entities` |

   - Connecting picks the matching port pair automatically and refuses incompatible types at connect time (`isValidConnection`), with a tooltip saying why. This fixes D-C, D-D and D-F.
   - `transcript ⊑ text` stays a valid subtype, so ASR → Text just works.
3. **Edges carry data, and only one producer per single-value port.**
   - Fan-in into `message` is refused at connect time (fixes D-E). To combine, the user inserts a **Merge** node (a preset of `core.data`).
   - A branch edge from a Condition carries the router's input through, so one edge is enough (OD-19).
4. **References by picker.**
   - Typing `{{` or `/` in any prompt, binding or condition field opens a tree: Start inputs, then each upstream node **by its label**, then its typed output fields.
   - The tree is built from port `outputKey`s and the agent's `outputSchema`.
   - Tokens are stored by stable id and rendered by label, so renaming a node never breaks a reference.
   - Publish type-checks `nodes.*` paths (fixes D-G). The existing `TemplateEditor` is extended, not replaced.
5. **Agent node inspector, three sections:**
   - **Agent:** picker, the pinned version badge, and "Create new agent" / "Edit (new version)" inline.
   - **Inputs:** one row per declared prompt variable. Each row binds from the picker or a literal, with an optional/required badge. Optional unbound renders empty.
   - **Output:** a read-only shape preview, which the picker uses downstream.
   - Generation is only temperature and max output tokens, and only when the model supports them (W2). Lane, cadence, raw JSON and the other five generation overrides leave the default view.
5b. **Pin placement.** The agent pin appears on the node as a "vN" badge, with "update to latest" offered on drafts only.
6. **Conditions without CEL.** A visual rule builder (field from the picker, operator, value) generates CEL. Raw CEL sits behind "Edit as expression".
7. **Adding nodes.** Palette (collapsible, floating per R13), `+` on an edge (insert and rewire), and drop-on-empty-canvas with a searchable command menu.
8. **Inspector.** Floats per the owner's R13, snaps to the right edge by default, and is resizable and movable with keyboard support. It gains a **Last run** tab showing this node's inputs, outputs and duration from the latest Test run (OD-17).

### 8.5 Pins: the W3 rule, enforced end to end

| Reference | At agent publish | At workflow publish | At runtime |
|---|---|---|---|
| Prompt template, in an agent | Frozen as `promptVersionNumber` plus content in `compiledConfig` (exists) | Carried inside the pinned agent version | The harness reads the **frozen** prompt from the pinned agent version. No runtime template fetch (fixes part of D-A and R-6). |
| Agent, in a workflow node | — | `agentRef.versionNumber` resolved and frozen. Unpinned means "active now", captured at publish. | The harness resolves the agent **by version** (a new internal by-version read). Drift is no longer an error, because the pinned version runs (fixes D-A). |
| Document template | — | **Not pinned** (`documentVersionNumber` removed from the node) | The latest published or approved version at run time (W3) |
| DNA writing style | — | Not pinned | The clinician's latest report at run time (unchanged) |
| Context schema | — | Pinned or follow-latest (TASK-982, unchanged) | Unchanged |

Consequence: deprecating an agent version that a published, active workflow pins does **not** break the workflow. Its published bytes keep running. The agent screen shows "used by N published workflows" before Deprecate (OD-21).

### 8.6 Simple configuration (W2)

- **Tenant-facing editor and inspector:** provider → model; prompt (library + pin, or inline); task switches; temperature and max output tokens.
  - The task switches are: ASR VAD, noise suppression, diarization (with an enrollment hint); Text DNA rewrite, document template, structured output; TTS voice picker, speed.
  - Temperature and max output tokens show only when `capabilities.supportedGenerationParams` includes them. Temperature is hidden for reasoning models.
- **Everything else moves off tenant surfaces** into model-level defaults on the platform Models screen (`AiModel` serving / generation defaults, platform admin): ASR decoding, VAD thresholds, top-p/k, penalties, seed, reasoning budget, streaming windows.
  - Existing agent rows keep their stored values. The publish gate refuses a tenant write to those paths with 403 `AGENT_PARAMETER_PLATFORM_MANAGED`, generalising the existing `readOnly` mechanism.
- **Capability flags** (`supportsTools`, `supportsVision`, `supportsAttachments`, `voices`) drive which sections exist. Tools and attachments stay hidden until built (OD-16).

### 8.7 Delivery plane: one run model, one protocol, SDK-first (W5)

| Concern | Target |
|---|---|
| Unit | Every agent invocation and workflow execution is a **Run** with an id. Start returns `{ runId, status, links: { self, events, result, cancel } }`. Modes: `blocking` (≤ 60 s, then 202 + links), `async`, `stream`. `POST /agents/:slug/runs` is added (OD-26); `invocations` stays as sugar. |
| Protocol | One envelope for SSE **and** WS: `{ seq, runId, type, ts, data }`, with SSE `id: <seq>`. |
| Event types | `run.started`, `node.started`, `node.completed`, `node.failed`, `output.text.delta`, `output.audio.delta`, `output.data`, `run.completed`, `run.failed`, `run.cancelled`, `run.resync`, `ping`. |
| Coexistence | The six existing shapes stay readable for one release behind a protocol version header (OD-23). |
| Result | `run.completed` carries the result inline (≤ 64 KB) or a `resultRef`. `GET /runs/:id/result` returns inline JSON or a short-lived signed URL (audio, large documents). Fixes D-I. |
| Text streaming | LLM nodes that feed End (or are flagged `stream`) call the text service with `stream:true` and emit `output.text.delta`. Today no workflow streams text. |
| Resume | `Last-Event-ID` or `?after=<seq>`. An expired cursor gets `run.resync` with a snapshot. The same applies on WS. |
| Cancel | Idempotent `POST …/cancel`. It propagates to in-flight activities and children through Temporal cancellation and heartbeats (fixes R-4). A client disconnect never cancels. |
| Integrity | `Idempotency-Key` on **every** start: agents, ASR, summary and workflows. Today only workflows honour it, and the docs claim more. |
| Retention | Event stream `EXPIRE` 24 h after terminal. Result and status survive in the read model per `workflowRuns.resultRetentionDays` (OD-25). Status falls back to the read model when the harness has no record. |
| Webhooks | Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`). The payload carries the result or `resultRef`. |
| Audio in | `stream` audio goes over a run-bound WS (the STT socket protocol with `runId`). `blob` audio and attachments use a tenant media upload, then `mediaId` in the input. |
| vox-node | `const run = await hope.workflows.run(slug, input, { idempotencyKey })` returns a **RunHandle** with `.text()` (async iterator of strings), `.events()`, `.result()`, `.wait({ poll })`, `.cancel()`, and auto-resume. `hope.agents.run(...)` returns the same handle. No tickets or frame shapes leak. |
| vox (browser) | `useRun({ workflow \| agent })` returns `{ start, text, events, result, status, cancel }`, with `resume` on mount, the run-scoped ticket for SSE (works for API keys), and `useRunAudio` for mic → run. |
| Stability fixes | Pooled per-stream Redis readers, or one multiplexed reader with demux (R-1). Watcher retry plus a terminal fallback poll (R-2). Write backpressure (R-9). |

### 8.8 Runtime integrity and performance fixes (Track 0, independent of UX)

| Fix | Addresses |
|---|---|
| Enforce run timeout (`maxTotalSeconds` → `execution_timeout`) and per-node `non_retryable_error_types` + backoff | D-B, R-5 |
| Claim-check every node output > 20 KB. Pass references, not copies, in activity inputs. Pre-flight size guard fails the run by name. | R-3 |
| Keep a degraded node's output | D-H |
| Shared `httpx.AsyncClient` per worker; agent-version cache keyed `(tenantId, slug, version)` (immutable, so safe); prompt and agent read from the frozen config | R-6 |
| Review `HARNESS_LLM_MAX_CONCURRENCY` against GPU capacity (TASK-1031 owns serving concurrency, so coordinate rather than change blindly) | R-6 |
| Capture the missing replay fixtures before touching `workflows.py`; all new behaviour behind `workflow.patched` | R-8 |
| Stream TTL; Temporal payload codec for PHI as a **separate ticket** (key management, OD-27) | R-7 |

### 8.9 Decision status after round 2

| Earlier id | Status |
|---|---|
| OD-3 | **Closed by W1.** Trigger and Output are undeletable; seed both on create. |
| OD-7 | **Replaced by W3.** Document templates and DNA always resolve latest. The question of agent vs node ownership remains: keep the document template choice on the agent (recommended), with DNA as an agent switch. |
| OD-9 | **Replaced by W3.** Agents and prompts are pinned and enforced; documents float. |
| OD-11 | **Replaced by W2** (§8.6). |
| OD-1, 2, 4, 5, 6, 8, 10, 12–16 | Still open as written in §4.2. |

New questions:

| Id | Question | Recommendation |
|---|---|---|
| OD-17 | The inspector floats (R13), but the research favours docked. | Floating, snapped right by default, movable and resizable, plus a "Last run" tab. |
| OD-18 | Fan-in into a single-value port. | Refuse at connect time; merge through a **Merge** node. |
| OD-19 | Should a Condition branch edge carry data? | Yes: pass-through of the router's input. |
| OD-20 | References shown by node label, stored by id. This needs a declared `label` on node config (today a rename would fail publish). | Yes. |
| OD-21 | A pinned agent version runs even after it is deprecated. | Yes, with a "used by N published workflows" warning on Deprecate. |
| OD-22 | "Latest available" document = latest **approved / published** version, never a draft. | Yes. |
| OD-23 | One run protocol replaces six shapes. Old shapes stay readable for one release, and the SDKs go to a **5.0.0** major with a compatibility normaliser. | Yes. |
| OD-24 | Which nodes stream text deltas? | Nodes wired into End, plus any node flagged `stream`. |
| OD-25 | Retention. | Events 24 h after terminal; results 30 days (`workflowRuns.resultRetentionDays`). |
| OD-26 | Should agents get a run resource (`POST /agents/:slug/runs`) with async, poll and idempotency? | Yes. `invocations` stays as blocking/stream sugar. |
| OD-27 | Temporal payload codec (PHI at rest in history). | A separate ticket. Key management is its own design. |
| OD-28 | Split the work? | Yes, in four parts. **TASK-1036** = composer, agents, prompts, management and Studio (UX). **TASK-1037** = runtime integrity and delivery plane (Track 0 + §8.7 server side). **TASK-1038** = SDK 5.0 (RunHandle, `useRun`). **TASK-1039** = payload codec. Track 0 ships first: it fixes live correctness defects (D-A, D-I) and does not wait for UX. |

### 8.10 Revised sequencing (subject to OD-28)

1. **Track 0 (TASK-1037, first).**
   - Fixes D-A pins, D-B timeout, D-H, D-I result, and R-1/R-2/R-3/R-5/R-9.
   - Lanes:
     - HARNESS (`opus`; replay-sensitive).
     - GATEWAY-STREAM (`opus`; concurrency).
     - EXPOSURE (`sonnet`).
   - Proof: replay-compat, load test of 200 concurrent SSE streams (p95 first-frame latency before and after), and a live run returning its result to vox-node.
2. **Contract freeze** (orchestrator + one `fable` review): run protocol v2, typed ports per task, reference-picker paths over `nodes.*`, settings, simple-config parameter allow-list.
3. **TASK-1036 waves** as in §5.2. The C2 STUDIO SHELL lane gains the connect-time typing, picker, Merge preset and condition builder. C5 gains the simplified editor (§8.6).
4. **TASK-1038 SDK 5.0** (`sonnet` ×2: vox-node and vox) on the frozen protocol.
5. **Evaluation and gates** as in §5.2 wave 4 and §5.5, plus a load test and a seeded-workflow regression: every seeded workflow publishes and runs end to end through the new ports.

## 9. Discussion round 3: node I/O contract, field mapping, context scopes (2026-10-04)

The owner asked whether three ideas are best practice and whether they can be built:
- (Q1) standardise node input and output;
- (Q2) let the user map which upstream output field feeds a node input;
- (Q3) let nodes read the **context object** (defined by the context schema) and the **consultation context** (our data model).

All three are established practice and can be built on today's code. The proposal follows.

### 9.1 Standard node I/O contract (Q1)

**Precedent.**
- n8n: every node takes and returns `items[{json, binary}]`.
- Dify: every node declares typed output variables.
- OpenAI Agent Builder: typed edges plus state.
- LangGraph: typed shared state.

**Today.** Ports carry only primitives (`text`, `object`, `audio`). Output dicts differ per node and per task: a text agent returns `{text, provider, model, usage…}` and ASR returns `{transcript, jobId}` (§8.2). Nothing declares field shapes.

**Proposal.** A `NodeIO` declaration per node spec in `@arcaai/workflow-contract`, with a Python mirror and a fixture:
- `inputs: { <field>: { type, required, description } }`
- `outputs: { <field>: { type | schema } }`

Types are `text`, `number`, `boolean`, `json` (with a schema), `list<T>`, `audio`, `file` and `document`. The last three are always **references**, never inline bytes.

Every node returns one envelope:

```
{ status, outputs: { …declared fields }, artifacts: [{ kind, ref, mime, size }],
  usage: { tokens, costUnits }, timing: { startedAt, durationMs }, error? }
```

Agent node outputs come from its task plus the agent's `outputSchema`:

| Task | Outputs |
|---|---|
| Text | `{ text, data? }` |
| ASR | `{ transcript, segments, language }` |
| TTS | `{ audio, durationMs }` |
| NER | `{ entities }` |

That one declaration drives the canvas handles, the picker, the publish type check, the Test tab's "Last run" view, `node.completed` events, and the SDK types. It is one source of truth instead of five.

### 9.2 Field mapping (Q2)

**Precedent.** Dify variable selectors, n8n drag-a-field, Zapier `+`, Make, and the Copilot Studio `{x}` picker. This is the dominant pattern.

**Proposal.** Each declared input field has exactly one **binding**:

| Binding | Example | UI |
|---|---|---|
| `from` (a path) | `nodes.transcribe.outputs.transcript`, `context.patient.age`, `consultation.notes.preSummary` | Picker (typed tree) |
| `value` (literal) | `"en"` | Plain input |
| `template` | `"Summarise: {{nodes.transcribe.outputs.transcript}}"` | `TemplateEditor` |

**Edges.** Edges keep order and gain **auto-mapping**. Connecting A → B binds B's primary input to A's first compatible output, so the simple case needs no mapping at all, and the user can re-point it. Bindings are what actually move data.

**Publish rules.**
- A `from` path must point to an **ancestor** node (or a context root), and the types must match.
- Every required input must be bound.
- An optional input left unbound renders empty.

This removes the fan-in ambiguity (D-E), the dropped-binding defects (D-C, D-D), and the opaque `{{nodes.node_k3x9_2…}}` typing (D-G).

**Mapping is pick-only plus templates.** Reshaping (merge, rename, compute) lives in a **Data** node, as in n8n and OpenAI. That keeps bindings deterministic and type-checkable.

**Runtime.** Bindings resolve with a pure function inside the workflow (replay-safe) from the stored envelopes. Large values move as references.

### 9.3 Context scopes (Q3)

**Precedent.** Dify `sys.*` / environment / conversation variables, Copilot Studio `Topic.` / `Global.` / `System.`, Agent Builder input plus state variables. All use namespaced read scopes.

**Today.** Consultation data is **flattened into `context.*`** as 11 gateway-derived `PLATFORM_CONTEXT_VARIABLES` (`safe_age`, `formatted_test_results`, `dna_style_text`…, `platform-context-variables.ts:42-52`). Three different lanes bind them differently: assembly, the realtime lane and the durable handoff. So "context" mixes the client's schema-defined input with platform-derived patient data, and its PHI classification is per kind, not per field (TASK-1035 open follow-up).

**Proposal: four scopes, all offered by the picker.**

| Root | What | Typed by | Writable |
|---|---|---|---|
| `context.*` | The run input, validated against the workflow's context schema (Input shape) | The context schema | No |
| `consultation.*` | Our data model as a **versioned, platform-published read schema** (see below) | A platform JSON Schema in `workflow-contract`, PHI class per field | No. Writes go only through explicit action nodes (save note, add context item). |
| `nodes.<id>.outputs.*` | Upstream outputs | `NodeIO` (§9.1) | No |
| `vars.*` / `run.*` | Run variables (Set node) / run id, tenant, now | Declared / fixed | `vars` via a Set node |

The `consultation.*` read schema contains:
- `consultation.{ id, visitType, department, language }`
- `patient{ age, gender, dob }`
- `clinician{ dna{ style, rules } }`
- `transcript{ text, segments }`
- `items[]` (case notes, attachments, vitals, tests, prior visits)
- `notes{ preSummary, summary }`

**Integrity rules for `consultation.*`.**
- **Declared reads.** The compiler computes the exact `consultation.*` paths each node references. The harness fetches only those, through one activity call to a gateway internal route that is tenant-checked. That gives least privilege, small payloads and PHI minimisation.
- **Snapshot semantics.** Values are read at **node start** by default, because the transcript grows during a live consultation. They are recorded in the activity result, so replay is deterministic. `run-start` is an option per binding.
- **Availability.** Only consultation-bound workflows (`settings.sources` includes `consultation`) may reference `consultation.*`. Anything else is a publish error.
- **Back-compatibility.** The 11 flat `context.<name>` names stay as deprecated aliases (for example `context.safe_age` → `consultation.patient.age` with the same "Unknown" formatting) for one release. Then they retire, with a deprecation-register entry.

### 9.4 Cost and placement

This is the contract layer that §8.4's picker and typed ports need anyway. It joins the **contract freeze** (§8.10 step 2) and the TASK-1036/1037 lanes. It adds no new waves.

| Layer | Work |
|---|---|
| Contract and compiler | NodeIO, binding model, ancestor and type rules, consultation read schema |
| Harness | Binding resolver, consultation read activity, all behind `workflow.patched`, with replay fixtures first |
| Gateway | Internal declared-read route |
| Console | Inputs panel, auto-map on connect |
| Seeds | Translate the 15 seeded workflows' edge-implied bindings |

The compiler auto-translates legacy port bindings, so existing published workflows keep running on their frozen configs.

### 9.5 Questions to settle

| Id | Question | Recommendation |
|---|---|---|
| OD-29 | Data moves by **bindings**; edges carry order and auto-map. Or keep edge-implied ports? | Bindings. Edges = order plus auto-map. |
| OD-30 | When `consultation.*` is read: node start or run start? | Node start by default; `run-start` per binding. |
| OD-31 | Can nodes write to the consultation implicitly? | Never. Only explicit action nodes. |
| OD-32 | Lists: n8n-style implicit per-item execution, or whole values plus an explicit Loop? | Whole values plus Loop. Implicit per-item is n8n's most-reported confusion. |
| OD-33 | Streaming deltas name the output field (`output.text.delta { nodeId, field }`)? | Yes. It ties §8.7 to NodeIO. |
| OD-34 | The `consultation.*` read schema is versioned and published with the contract (a platform schema, not tenant content)? | Yes. It is configuration-tier, owned by the platform. |

## 10. UX specification: suggestions while composing, full visibility while testing (2026-10-04)

The owner wants a very friendly UI. Context and consultation data should come up as intelligent suggestions while composing. While testing, the Studio should show the flow, the active node, all execution context and consultation data, and every event, for debugging.

There is a clickable prototype (private artifact, two screens: Composer and Test): https://claude.ai/artifact/DEcfoW7WKQuZJkArU34T8d. It is a design reference. The data in it is synthetic.

### 10.1 Composer: suggestions

| Rule | Detail |
|---|---|
| One picker everywhere | The same picker serves every place that takes data: input bindings, `{{` in prompt and template text, conditions and output fields. It opens on **Choose a field**, **Change**, **+ Insert field**, or typing `{{`. |
| Four colour-coded groups, always in this order | **Earlier steps** (only ancestors of this node; others are never offered). **Context** (the workflow's context schema, named with its version). **Consultation** (the platform read schema, §9.3). **Run & variables**. Colour encodes scope everywhere: chips, tokens, event rows. |
| Type-aware ranking | Items that fit the input's type come first, and the first one in Earlier steps is marked **Best match**. Convertible items say how they convert ("Formatted as text"). Incompatible items stay visible but disabled, with the reason ("Can't use audio here"), so users learn the model instead of guessing. |
| Every item shows what you'd get | Path (by step label, never a raw id; the stored id is in the tooltip), type, a PHI badge, and a **sample value** from the last test run or the schema example. |
| Filter as you type | Matches path, label and description. Empty groups say why ("Nothing runs before this step yet"). |
| Inputs come from the prompt | An agent node lists the variables found in its pinned prompt as input rows, each Required or Optional. Unset required inputs show red at the field and in the canvas problems pill. Unset optional inputs say "renders empty". |
| Auto-mapping | Connecting two steps binds the downstream main input to the best-matching upstream output. The link label shows the mapping (`transcript → message`). |
| Little to configure | Agent (pinned version, edit as new version, swap, create), Inputs, temperature and max output tokens only when the model supports them, and an Output preview of what later steps can use. |
| Last run in the inspector | Each node's resolved inputs, outputs, duration and tokens from the latest test. |

### 10.2 Test: full visibility

| Area | What it shows |
|---|---|
| Flow (left) | Every step live: Waiting, Running (pulsing), Done with duration, warning count. Links light up as data moves, and the active link animates (no animation under `prefers-reduced-motion`). Clicking a step selects it. |
| Step panel (left, below) | The selected step's pinned agent, prompt and document versions. Each input as `field ← source = resolved value`, including "optional, rendered empty". Outputs, streaming live. |
| Test input (right, top) | Only the controls the workflow can use. **Record** with a live waveform when there is a speech-to-text step (otherwise the sample audio). **Type a message** when the Input shape has one. **Attach** for the allowed file types. Each shows why it is there. Run, Pause/Play, Step, Reset and speed. |
| Execution context (right) | Four views. **Session**: consultation items building up (audio, transcript, entities, case note with an AI badge). **Context**: the run input against the schema. **Consultation**: every field, tagged "read by <step> at +t". **Run & variables**: id, status, version, elapsed, tokens, variables. |
| Events (right, bottom) | Every event in order with seq, +time, step, type and text. Filters with counts: Steps, Model, Guardrails, Data, Audio, Warnings. Search. Clicking an event expands its full JSON payload and **time-travels** the flow, step panel and context to that moment, with a "Back to live" banner. |
| Status bar | Status, elapsed time, tokens in and out, event count, run id. |
| Privacy | PHI is shown to admins with a one-click **Hide PHI**. Viewing PHI is audited. The trace exists only in the console and never on the business plane. |

### 10.3 What the events require from the backend

The Test tab only works if the run stream (§8.7) emits every one of these with `seq` and `nodeId`:

| Group | Events |
|---|---|
| Run | `run.started`, `run.completed`, `run.failed` |
| Input and binding | `input.validated`, `data.bound` (resolved bindings per input), `binding.warning` |
| Consultation reads | `consultation.read` (declared reads, snapshot point) |
| Steps | `node.started`, `node.completed`, `node.failed` |
| Audio | `transcript.partial`, `transcript.final` |
| Model | `prompt.composed` (layers and token counts; content only through the Prompt Inspector), `model.request`, `output.text.delta` |
| Guardrails | `guardrail.inbound`, `guardrail.outbound` |
| Output | `output.validated` |

Business-plane callers get the reduced public subset (§8.7). The admin trace adds the debug events.

The data each event needs:
- Time travel needs nothing more than the ordered events.
- The context snapshot shown at event N is a pure fold over events 1..N plus the run's input and declared reads.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-04 | Ticket raised. Discovery by 4 sonnet Explore agents (prompts/tags, agents, lifecycle/management, Studio/settings). Plan, decisions D-1..7 and open OD-1..16 written. Status Pending. |
| 2026-10-04 | Round 2 (§8). Owner directions W1–W5 received. Second discovery round: graph data flow, harness runtime, delivery plane and SDKs, plus SOTA web research. The orchestrator verified D-A (pins unread), D-B (no run timeout), D-I (no `resultRef` writer) and R-1 (single Redis reader) in code. OD-3/7/9/11 closed or replaced. OD-17..28 added. Proposed a ticket split (OD-28). |
| 2026-10-04 | Round 3 (§9): standard NodeIO contract, field bindings, the four context scopes (`context` / `consultation` / `nodes` / `vars`+`run`), and OD-29..34. The `PLATFORM_CONTEXT_VARIABLES` flattening was checked in code (`platform-context-variables.ts:42-52`). |
| 2026-10-04 | §10 UX specification (composer suggestions, test-time visibility, the debug event list) plus a clickable prototype artifact with Composer and Test screens. |
| 2026-10-04 | **Owner approved** the plan, every recommendation, W1–W6, the ticket split and the prototype. §4 rewritten as the final decision register. §5 rewritten as the cross-ticket programme (TASK-1036/1038/1039, with 1040 separate): agent tier map, lane rules, waves A–D with file ownership, a 16.8M-token budget, and the verification list. OD-15 moved into scope (C3), because the approved prototype makes microphone input and attachments first-class. TASK-1037 was already taken by a parallel Prisma-8 session, so the split tickets are 1038–1040. Status → In Progress. |
