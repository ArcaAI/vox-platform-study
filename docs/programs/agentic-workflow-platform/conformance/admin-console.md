# Conformance review — Admin Console

| | |
|---|---|
| **Scope** | `apps/admin-console` (+ read-only inspection of the backend surfaces it consumes) |
| **Measured against** | [product-brief.md](../product-brief.md) §1, §2, §4 · [tenant-authoring-boundary.md](../tenant-authoring-boundary.md) §4 · [owner-decisions-2026-08-17.md](../owner-decisions-2026-08-17.md) D-C, D-E |
| **Method** | Static inspection only — no builds, no test runs, no DB access. Every claim is file:line anchored. |
| **Date** | 2026-08-18 |
| **Branch** | `feat/loop` |

---

## 1. The reactflow question — plain verdict

**A real, interactive React Flow node-graph builder exists. It is not a form/list editor wearing
the name. But it only covers two of the brief's three surfaces, and the node it lets you
*configure* is effectively a raw-JSON textarea.**

### It is genuinely a canvas

`@xyflow/react@^12.11.3` is a real dependency of `@arcaai/ui`
(`packages/ui/package.json:133`) — declared there, not in the console
(`apps/admin-console/package.json:18-36` has no xyflow; the console reaches it through
`@arcaai/ui/components/workflow-canvas`, which is the correct arrangement, not a gap).

`packages/ui/src/components/workflow-canvas/workflow-canvas.tsx:165-186` mounts a real
`<ReactFlow>` with `Background`, `Controls`, custom `nodeTypes`/`edgeTypes`, and live
`nodesDraggable` / `nodesConnectable` / `edgesReconnectable` / `deleteKeyCode`. It is a
props-in/callbacks-out composite that owns no graph state (`:70-81`).

`apps/admin-console/src/features/workflow-studio/components/workflow-studio-editor.tsx:280-303`
wires every mutation callback to a Zustand graph store: `onConnect` → `connect()`,
`onNodesChange` → `moveNode()`, `onDeleteRequest` → `deleteNode()`, `onSelect` → `selectNode()`.
A palette rail adds nodes (`:271-276`), an inspector edits the selected node (`:328-334`), a
validation rail surfaces findings (`:335`), and there is debounced autosave with If-Match/OCC
(`:113-117`), draft→publish with version immutability (`:185-197`, `:152-167`).

Accessibility was designed in, not bolted on: `role="application"` + `aria-label`, focusable
nodes with `aria-describedby` pointing at the validation summary, real `<button>` controls so
pointer-drag is never the only mutation path, `prefers-reduced-motion` on fit-view
(`workflow-canvas.tsx:70-81`, `:161-164`), plus a full structured **list view** as a pointer-free
equivalent (`workflow-studio-editor.tsx:304-324`). The list editor is an *alternative* to the
canvas, not a substitute for it — the canvas is the default (`?view=canvas`, `:139`).

The canvas is reused read-only for run tracing with per-node run overlays
(`apps/admin-console/src/features/workflow-runs/components/run-trace-screen.tsx:185`).

### Where it falls short of the brief

The brief says **all three** surfaces are built this way. The node registry
(`apps/harness/src/harness/temporal/interpreter/registry.py`) says otherwise:

| Palette | Registry state | Evidence |
|---|---|---|
| `summarization` | Complete — 5 node types | `registry.py:103-149` |
| `stt` | 8 node types; `stt.phiHop` is `implemented=False` | `registry.py:150-222` |
| **`consultation`** | **3 of 13 declared; only 2 implemented** | `registry.py:223-257` |

`registry.py:223-227` states it outright: *"a PARTIAL pass: only 3 of the palette's 13 node types
are wired."* Those 3 are `consentGate`, `phiHop`, `hitlGate` — all **safety gates**.
`consultation.hitlGate` is `implemented=False`, so `compile()` refuses any graph containing it
(`:246-248`). There is **no agent node, no sub-agent node, no tool-calling node** in the
consultation palette at all. The brief calls Consultation the *"main / core business"* surface and
describes it as an *"agent-orchestrator with agents and sub-agents, workflow management, tool
calling"* (product-brief.md:22). The builder cannot express any of that today.

Two smaller but real defects in the same area:

- **The surface is chosen by free-text.** `create-definition-form.tsx:59` renders `paletteKey` as
  a plain `<Input>`, not a curated `<Select>` over the registry's palettes. A typo produces a
  definition bound to a palette that does not exist.
- **No node type has a config schema, so node configuration is hand-written JSON.**
  `workflow-studio-editor.tsx:330` passes `configSchema={undefined}` unconditionally, and
  `inspector/inspector-panel.tsx:140-146` therefore always falls back to a whole-config JSON editor
  plus a prompt-template picker. The panel's own docblock is explicit (`:18-20`): *"the real
  registry state today: no delivered node type has a config schema at all, so `promptTemplateId`
  is otherwise unreachable except by hand-editing raw JSON."* This is the `configSchema` gap that
  [tenant-authoring-boundary.md](../tenant-authoring-boundary.md) §1 names as orphaned across
  TASK-715/716/719/731.

### Verdict summary

| Claim | Verdict |
|---|---|
| Is `@xyflow/react` a dependency? | **Yes** — `packages/ui/package.json:133` |
| Is TASK-719's "workflow studio" a real node-graph canvas? | **Yes** — drag, connect, delete, select, palette-add, autosave, validate, publish |
| Does it cover all three surfaces? | **No** — Summarization yes, STT yes (1 placeholder), Consultation 3/13 nodes with no agent/tool nodes |
| Can a tenant admin configure a node without writing JSON? | **No** — no node type ships a config schema |

---

## 2. Context-schema authoring — verdict

**PRESENT and genuinely tenant-authorable. This is the strongest part of the console and the
closest thing to the owner's headline requirement being met. It stops short at the developer
handoff.**

Route `(console)/(tenant)/context-schemas` (tier 30-49), nav-gated on
`manage:ConsultationContextSchema` (`nav-config.ts:314-322`) — a *tenant* ability, not
`manage:all`. The backend agrees: `apps/api/src/modules/consultation-context-schema/consultation-context-schema.controller.ts:38`
is a class-level `@CanManage('ConsultationContextSchema')` and the docblock at `:27` says that is
*the whole gate*. No `isSuperAdmin` check anywhere in the module. A tenant admin really can author.

The authoring surface is complete, not a stub — full CRUD + versions + publish + version pinning
(`features/context-schemas/api/client.ts:29-68`), a definition editor, kind/output forms, a
versions panel, and a sample-payload tester that validates against the **same** server-side
evaluator rather than a client copy (`components/payload-tester.tsx:1-14`, using
`@arcaai/json-schema-subset`). Schemas carry `scope: 'TENANT' | 'DEPARTMENT'` and
`status: 'DRAFT' | 'PUBLISHED' | 'APPROVED'` (`api/types.ts:10-11`).

The tenant/platform boundary is correctly drawn and correctly enforced in the UI: a tenant
declares its own vocabulary, but every kind must map to one of five **closed** platform primitives
(`STREAM_AUDIO | TEXT | DOCUMENT | IMAGE | STRUCTURED`), and `api/types.ts:56-63` instructs that
*"the admin console must never let an author type a sixth value."* That is exactly
tenant-authoring-boundary.md §4's approved line.

The schema is load-bearing at runtime, not decorative — consumed by
`packages/applications/src/services/consultation/context/context.service.ts`,
`.../consultation/loop/loop-config.service.ts`, `.../departmentAgent/departmentAgent.service.ts`,
and the browser SDK (`packages/agentic-sdk-v2/src/core/ConsultationSchemaClient.ts`,
`.../hooks/useConsultationSchema.ts`).

### What is missing — and it is the half the owner actually asked for

The requirement is *"a tenant admin defines the context schema **so a developer can integrate**
against a specific tenant's shape."* Authoring is done. Integration is not:

- **No developer handoff artifact.** No OpenAPI fragment, no JSON-Schema download, no TypeScript
  emit, no copyable integration snippet on the screen — only a `CopyButton` on the drawer
  (`components/context-schema-detail-drawer.tsx:22`).
- **No schema→types codegen exists anywhere in the repo.** Searched
  `packages/vox-node`, `packages/agentic-sdk-v2`, `packages/tools/src` for
  `json-schema-to-typescript` / `quicktype` / `generateTypes` / `codegen` — zero hits.
  tenant-authoring-boundary.md §3 explicitly warns that hand-written SDK types *"would drift the
  first time a tenant edited anything."*
- **The server SDK cannot see context schemas at all.** `packages/vox-node/src/resources/` contains
  only `summarization.ts`, `consultations.ts`, `consultation-summaries.ts`, `jobs.ts` — no context
  schema resource, no workflow resource. `@arcaai/vox-node` is the SDK a backend integrator would
  use, and it is blind to the tenant's declared shape. This is a direct D-E violation.

---

## 3. Prompt-template authoring and per-surface configuration

**Prompt templates: PRESENT.** `(console)/(tenant)/prompt-templates` (`nav-config.ts:306-313`,
`manage:PromptTemplate`) is the one authoritative editor — CRUD, versions, version diff, clinical
approval, fallbacks, test-run panel (`features/agents/components/`). Correctly, the Studio
inspector offers a **picker with a deep link**, never a second editor
(`inspector/prompt-template-picker.tsx:1-19` cites rule 13's one-authoritative-editor rule).

**Caveat, per workflow:** because no node ships a config schema, the picker is injected
synthetically for any field path ending in `promptTemplateId`
(`inspector-panel.tsx:164-166`, `:18-20`). Prompt binding per node therefore works by naming
convention, not by contract — it will silently stop working for any node type whose config names
the field differently.

**Per-surface configuration: PRESENT.**

| Surface | Screen |
|---|---|
| STT | `(tenant)/audio/pipelines` (`AsrPipeline`), `(tenant)/audio/transcription-jobs` |
| Text / TTS / models | `(tenant)/ai-configuration` → `features/tenant-stt-config/components/speech-and-voice-screen.tsx` (the Speech tab reads `TenantSttConfig`; the Voice tab is a pointer to `/agents?task=TEXT_TO_SPEECH` since TASK-888 retired `TenantTtsConfig`), `(tenant)/agents` |
| Platform defaults | `(global)/ai-models`, `(global)/ai-task-defaults`, `(global)/ai-services` |

**Exposure (brief §1: "expose it as APIs / Sockets / Webhooks"): backend yes, console no.**
`apps/api/src/modules/workflows/workflows.controller.ts` + `workflow-stream.service.ts` implement
the public invoke + SSE surface over `IWorkflowExposureService`. But there is **no console screen
for it** — zero hits for `exposure|Exposure` in `apps/admin-console/src`. A tenant admin can build
and publish a workflow and has nowhere to see its endpoint, its stream URL, or how to call it.

---

## 4. Brief §4 coverage table

Legend: **PRESENT** = routed, reachable, and does the thing · **PARTIAL** = routed but materially
incomplete or mis-tiered · **ABSENT** = no route.

### Super-admin (tier 10-19 / 20-29)

| Brief item | Status | Route / module | Gap |
|---|---|---|---|
| tenant | **PRESENT** | `(global)/tenants`, `/tenants/[id]` (`nav-config.ts:124-134`) | — |
| user | **PRESENT** | `(shared)/users`, `/users/[id]` (`nav-config.ts:216`) | — |
| store & bucket | **PRESENT** | `(global)/tenants/storage` (`:136-151`), `(tenant)/storage` browser (`:291-301`) | — |
| plan | **PRESENT** | `(global)/entitlements` (`:135`) | — |
| feature | **PRESENT** | `(global)/entitlements` (plans + feature flags share the screen) | — |
| configuration | **PRESENT** | `(shared)/settings` (`:250`), `(global)/ai-task-defaults`, `/rate-limits`, `/agentic-policy` | — |
| audit trail | **PRESENT** | `(global)/audit-logs` (`:210`), with CSV export (`features/audit-logs/`) | — |
| reporting & analytics | **PARTIAL** | `(global)/dashboard`, `/ai-operations/metrics`, `/ai-operations/consumption`, `/billing` | Operational + cost analytics only. No report builder, no scheduled/exported reports outside audit logs. |

### Tenant admin (own tenant, tier 30-49)

| Brief item | Status | Route / module | Gap |
|---|---|---|---|
| tenant | **PRESENT** | `(shared)/tenant-profile` (`:252-261`) | — |
| tenant user | **PRESENT** | `(shared)/users` + `(tenant)/departments` members panel | — |
| store & bucket | **PRESENT** | `(tenant)/storage` (`:291-301`) | — |
| agentic loop / workflow | **PARTIAL** | `(tenant)/workflow-studio`, `/workflow-studio/[definitionId]` (`:427-435`) | Consultation palette 3/13 nodes with no agent/tool nodes (`registry.py:223`); no node config schemas; `paletteKey` free-text; no exposure screen. |
| prompt & instruction | **PRESENT** | `(tenant)/prompt-templates` (`:306-313`), `(tenant)/agents` (`:302`) | Per-node binding relies on a field-name convention (§3). |
| agent | **PRESENT** | `(tenant)/agents` — agents tab, DepartmentAgent CRUD, lineage, governance, loop config (`features/agents/`) | Gated on `manage:PromptTemplate`, not an `Agent` subject. |
| tool & MCP | **ABSENT for tenant admin** | `/tools-mcp` is tier **10-19**, `manage:all` (`nav-config.ts:207`) | Backend reads are `@CanManage('McpServer')` but **writes are SUPER_ADMIN-only by design** (`mcp-admin.controller.ts:29-32`, `mcp-server-admin.service.ts:162`). Console hides the screen entirely from tenant admins. Brief says tenant admin manages this — **needs an owner decision**, not a silent fix. |
| **memory** | **ABSENT** | — | **No `Memory` Prisma model exists** (searched `packages/database/src/prisma/db_main/*.prisma`). No backend plane, no route. `nav-config.ts:323-327` concedes it: Knowledge Base is *"the only real clinical 'memory' concept the platform has today"* — that is institutional RAG documents, not agent memory. |
| monitoring & alerting | **PARTIAL** | `(tenant)/harness/observability`, `(tenant)/workflow-runs`, `/workflow-runs/[runId]` run trace | Monitoring yes. **Alerting is absent platform-wide** — zero hits for `alertRule|AlertRule|alerting` in `apps/admin-console/src`. `(global)/monitoring` is super-admin only. |

### Test & debug surfaces (tier 50-59)

| Brief item | Status | Route / module | Gap |
|---|---|---|---|
| agentic loop / workflow | **PARTIAL** | `(tenant)/playground/workbench` (`:498-506`) — sandboxed interpreter runs over a definition + fixture | Isolated **single-node** test deliberately not built: the interpreter has no single-node dispatch entry point (`workbench-screen.tsx:30-32`). |
| agent | **PRESENT** | `(tenant)/playground/llm` "Agent Playground" (`:481`); `features/agents/components/test-run-panel.tsx` | — |
| tool & MCP | **ABSENT** | — | No tool/MCP invocation or connection test surface anywhere. |
| memory | **ABSENT** | — | Nothing to test — no memory plane exists. |
| speech-to-text | **PRESENT** | `(tenant)/playground/live-transcription` (`:471`), `/playground/voice-profiles` (`:473-479`) | — |
| text generation | **PRESENT** | `(tenant)/playground/llm` (`:481`) | — |

---

## 5. Tier / role correctness

**Broadly correct. SUPER_ADMIN consolidation (brief §2) is complete and clean. Two real holes.**

### What is right

- `ELEVATED_ROLES = ['SUPER_ADMIN']` — single elevated role, one definition each side:
  `apps/admin-console/src/shared/auth/ability.ts:17`, `src/server/session.ts:104-107`,
  `packages/applications/src/common/tenant-guards.ts:28,37`.
- **Zero production `GLOBAL_ADMIN` references.** All 17 repo-wide hits are negative assertions or
  comments asserting it is *not* an alias (`ability.test.ts:61-62`, `session.test.ts:117-118`,
  `seed.test.ts:498-500`). Brief §2's consolidation requirement is met.
- Tier guards match the taxonomy and use 404-over-403: `(global)/layout.tsx:10-13` elevated-only;
  `(tenant)/layout.tsx:14-17` `TENANT_ADMIN` or elevated; both `notFound()`, never 403.
- **Tenant admins cannot escape their tenant.** `src/server/hope-proxy.ts:34-36` attaches
  `X-Tenant-Id` **only** for elevated users with a working tenant — a tenant-bound JWT pins the
  tenant server-side and the console cannot spoof it. Backed by nav filtering
  (`nav-config.ts:524-530`) and the route guard.
- **The "super-admin screen over per-tenant data" combination is used correctly** (legitimate per
  rule 13, listed here as the inventory you asked for): `/ai-operations/runs`
  (`ai-operations-runs-screen.tsx:57`), `/ai-operations/metrics` (`:138`),
  `/ai-operations/consumption` (`consumption-cost-screen.tsx:43`), `/billing`
  (`billing-screen.tsx:48`) — each `(global)` + `WorkingTenantGate`.
  `/ai-operations/reconciliation` and `/tenants/storage` deliberately omit the gate (genuinely
  platform-wide) — also correct.
- `WorkingTenantGate` (`shared/tenant-scope/working-tenant-gate.tsx:18-60`) blocks the child tree
  before any query fires, so an elevated user with no working tenant gets an empty state rather
  than a 400. It is presentational, not a security boundary — correctly so.

### Defects

1. **`(tenant)/consultation-review` has no working-tenant gate but its docblock claims one.**
   `app/(console)/(tenant)/consultation-review/page.tsx:10-11` says it *"inherits that group
   layout's working-tenant guard"* — `(tenant)/layout.tsx:15` is a **roles-only** check, and
   `consultation-review-screen.tsx` never imports `WorkingTenantGate`. A SUPER_ADMIN with no
   working tenant lands on a screen that queries with no tenant header. This is the sharpest
   correctness defect found, and it sits on clinical encounter data.
2. **`(tenant)/playground/workbench` has no gate** while reading and *executing* tenant
   `WorkflowDefinition` rows (`nav-config.ts:498-506`). Same elevated-no-tenant hole, on an
   explicitly tenant-owned resource. (Contrast `playground/voice-profiles`, whose gate-less state
   **is** justified and documented at `voice-profiles-screen.tsx:16-19` — user-owned rows in the
   caller's home tenant.)
3. **A tenant admin cannot see their own billing or consumption.** Both live in `(global)`, so
   `(global)/layout.tsx:11` 404s them before the per-tenant gate runs. Whether that is intended is
   an owner call, but the brief lists neither under tenant admin, so this is recorded as an
   observation rather than a gap.
4. **Tier 20-29 has no server-side guard at all** (`(shared)/layout.tsx:9-11`, documented as
   intentional). `/settings`, `/rbac/*`, `/api-keys`, `/users` rely entirely on nav-ability plus
   gateway enforcement — defensible, but it is the one tier without route-level defense in depth.
5. Stale redirect stubs sit in the wrong tier: `(global)/prompt-studio` redirects to the
   **`(tenant)`** route `/prompt-templates`, so a tenant admin following a stale bookmark gets a
   404 instead of the redirect. Same shape for `(global)/pstudio` → `/db-studio`.

---

## 6. Personalization — per-department workflows, end-user personalization

**The brief's Consultation requirement — per-DEPARTMENT workflows with END-USER personalization —
is NOT met. Neither half.**

### Per-department workflows: ABSENT at the workflow layer

`WorkflowDefinition` has **no `departmentId` and no per-department pointer**. Fields are
`tenantId`, `slug`, `versionNumber`, `status`, `graph`, `paletteKey`, `isActive`
(`packages/database/src/prisma/db_main/workflow-definition.prisma:60-74`;
`features/workflow-studio/api/types.ts:69-98`). `isActive` is described as *"the movable pointer:
the version the dispatcher resolves for new runs"* — meaning **one active workflow per tenant, full
stop**. `grep departmentId` across `workflow-definition | workflow-run | workflow-sandbox-run |
workflow-exposure` in `packages/applications/src` returns nothing.

Department scoping *does* exist, but on an older, parallel plane that the Studio does not touch:

- Department → 4 hardcoded prompt slots (`features/departments/components/department-prompt-config-panel.tsx:29-34`)
- `DepartmentAgent` → `PromptTemplate` + pinned version (`features/agents/api/types.ts:381-393`)
- `PromptTemplate.departmentId` optional (`features/agents/components/template-form-dialog.tsx:64`)
- Context schemas support `scope: 'DEPARTMENT'` (`features/context-schemas/api/types.ts:10`)
- Pipeline-policy cascade system → tenant → DEPARTMENT → DOCTOR (`features/pipeline-policy/components/cascade.ts:152-174`)

So the platform knows how to scope by department — it just does not do it for workflows.

### End-user personalization: ABSENT

The closest surface is `(shared)/account` over `PATCH /user/me/preferences`
(`features/account/components/account-screen.tsx:68-69`), settable fields
`workflowMode | language | dnaStyleId` (`features/account/api/types.ts:38-45`). `workflowMode` is
**`'local' | 'remote'`** (`:6`) — a transcription execution-location toggle, not a choice of
workflow. The assigned pipeline is explicitly read-only and admin-assigned (`:16-20`, `:37`).

The three adjacent candidates are all narrower than the requirement:

- `features/dna-writing-styles` (tier 30-49) is an **admin oversight console over other doctors'**
  DNA reports (`api/types.ts:8-24`) — personalizes writing style, operated by the admin.
- `playground/voice-profiles` is genuinely user-owned but is speaker biometrics enrollment.
- `playground/dna-writing-style` is the caller's own style — again style, not workflow.

Every other `personaliz*` hit in the console is data-grid column persistence
(`shared/data/grid-persistence.ts:10,137`) — UI chrome. Note the backing service already
anticipates more (`packages/applications/src/services/user/userPreferences/userPreferences.service.ts:62`
— *"for the SDK v2 PersonalizationManager"*); the console exposes three scalars of it.

---

## 7. Implementation-gate compliance (D-C)

The Figma gate is waived; these are not. Spot-check:

- **Semantic tokens** — no hardcoded colors found in the reviewed features; the canvas ships its
  own token file (`packages/ui/src/components/workflow-canvas/canvas-tokens.css`).
- **Axe scans** — broad and real: 95 files reference `axe`, including
  `workflow-studio` (inspector, palette, list-editor, validation, toolbar) and
  `context-schemas`. Not a gap.
- **Both themes** — canvas tokens are theme-driven; not verifiable by static inspection alone.
- **Screen template / skeletons** — `ScreenTemplate` + `StatusFooter` + `Skeleton` used
  consistently in the reviewed screens.

D-C is in reasonable shape. The conformance debt is in *coverage*, not in build quality.

---

## 8. Prioritized gap register

Ticket numbers are **proposals** — highest existing is TASK-739 (`docs/implementation/`), so these
start at 740. Confirm with the owner before use.

| # | Gap | Sev | Proposed ticket | Size |
|---|---|---|---|---|
| G1 | **Consultation palette is 3/13 nodes with no agent, sub-agent or tool-calling node.** The brief's core business surface cannot be authored. `registry.py:223-257` | **Blocker** | TASK-740 — Consultation palette completion: the remaining 10 node types incl. agent / sub-agent / tool-call, plus the interpreter durable-wait extension that unblocks `consultation.hitlGate` | **XL** |
| G2 | **No node type ships a `configSchema`**, so every node is configured by hand-editing raw JSON. Orphaned across TASK-715/716/719/731. `workflow-studio-editor.tsx:330`, `inspector-panel.tsx:18-20,140-146` | **Blocker** | TASK-741 — `NODE_CONFIG` schema kind + registry delivery + generated inspector forms (implements tenant-authoring-boundary.md §2) | **L** |
| G3 | **Context schema has no developer handoff**: no JSON-Schema/OpenAPI export, no TypeScript emit, no codegen anywhere in the repo | **Blocker** for the owner's headline requirement | TASK-742 — Context-schema developer handoff: per-tenant schema export endpoint + `json-schema-to-typescript` emit + console download/snippet affordance | **M** |
| G4 | **`@arcaai/vox-node` cannot see context schemas or workflows** — resources are summarization/consultations/jobs only. Direct D-E violation | **Blocker** for the owner's headline requirement | TASK-743 — vox-node `contextSchemas` + `workflows` resources with types generated from G3's emit | **M** |
| G5 | **Memory management does not exist** — no `Memory` model, no backend, no console, no test surface. Brief §4 lists it for both tenant admin and test/debug | High | TASK-744 — Agent memory plane: Prisma model + domain trio + service + tenant console screen + workbench memory inspector | **XL** |
| G6 | **Per-department workflows + end-user personalization absent.** `WorkflowDefinition` is tenant-scoped only; one active version per tenant | High | TASK-745 — Department- and user-scoped workflow resolution (`departmentId` on the definition or a binding table, resolution cascade tenant → department → user, console binding screen) | **L** |
| G7 | **Tool & MCP is invisible to tenant admins** and MCP writes are SUPER_ADMIN-only by design — conflicts with brief §4. Needs an owner decision, not a unilateral fix. `nav-config.ts:207`, `mcp-server-admin.service.ts:162` | High | TASK-746 — Owner decision + implementation: tenant-scoped MCP server registration, or an explicit documented exception in tenant-authoring-boundary.md §4 | **M** (L if tenant-scoped registration is chosen) |
| G8 | **No workflow exposure console surface** — backend `/workflows` invoke + SSE exists, but a tenant admin cannot discover their endpoint. Brief §1 | High | TASK-747 — Workflow exposure screen: endpoint/stream/webhook surface, API-key scoping, copyable SDK snippet | **M** |
| G9 | **`consultation-review` has no `WorkingTenantGate`** despite its docblock claiming one; queries fire with no tenant header for an elevated user with no working tenant. Clinical data | High | TASK-748 — Add `WorkingTenantGate` to `consultation-review` and `playground/workbench`; correct the misleading docblock; add a lint/test guard that every `(tenant)` screen either wraps the gate or documents why not | **S** |
| G10 | **Alerting absent platform-wide** — monitoring exists, alerting does not. Brief §4 tenant "monitoring & alerting" | Medium | TASK-749 — Alert rules: model + evaluation + notification channels + tenant-scoped console screen | **L** |
| G11 | **`paletteKey` is a free-text input** — a typo binds a definition to a nonexistent palette. `create-definition-form.tsx:59` | Medium | TASK-750 — Palette selector driven by the node registry (fold into TASK-740 if convenient) | **S** |
| G12 | **Prompt binding per node works by field-name convention**, not contract (`promptTemplateId` path matching). `inspector-panel.tsx:164-166` | Medium | Fold into TASK-741 (G2) — a real `configSchema` makes the convention unnecessary | **S** |
| G13 | **Reporting & analytics is operational/cost only** — no report builder or scheduled export outside audit logs. Brief §4 super-admin | Medium | TASK-751 — Reporting & analytics: saved reports, scheduled export, cross-tenant rollups | **L** |
| G14 | **No tool/MCP test-and-debug surface.** Brief §4 test & debug | Medium | Fold into TASK-746 (G7) — connection test + tool invocation panel | **S** |
| G15 | **No isolated single-node test** in the Workbench — the interpreter has no single-node dispatch entry point. Documented, not built (`workbench-screen.tsx:30-32`) | Low | TASK-752 — Interpreter single-node dispatch + Workbench isolated node test | **M** |
| G16 | **Stale redirect stubs in the wrong tier** — `(global)/prompt-studio` → `(tenant)/prompt-templates` 404s tenant admins | Low | TASK-753 — Move or delete the expired redirect stubs (rule 13: one release) | **S** |
| G17 | **Tier 20-29 has no route-level guard** (documented as intentional) — the one tier without defense in depth | Low | No ticket; recorded as an accepted design decision | — |

### Blocks the owner's "tenant admin defines the context schema so a developer can integrate"

Authoring is **done**. Integration is not. Exactly four gaps stand between the current state and
that sentence being true end-to-end:

**G3** (no machine-readable export of a tenant's schema) → **G4** (server SDK cannot consume it) →
**G2** (workflow nodes cannot be configured against the declared shape without hand-written JSON) →
**G8** (no way to discover the endpoint the integrator would call).

G3 and G4 are the hard blockers; G2 and G8 make the loop usable rather than merely possible.
