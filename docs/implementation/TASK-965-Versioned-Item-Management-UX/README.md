# TASK-965 — Versioned-item management: published state, lineage, active + default, one UX

| Field | Value |
|---|---|
| Status | **In Progress** — plan approved 2026-09-13; **WS-1 done** (console hotfixes, this README §4.1); WS-2 … WS-7 pending |
| Type | bugfix + UX |
| Branch | `dev-2.2` |
| Screens | `/agents`, `/workflow-studio` (+ `/workflow-studio/assignments`); head+version screens `/prompt-templates`, `/context-schemas`, `/document-templates`, `/dna-writing-styles` reviewed for consistency |
| Reported | Owner, 2026-09-13: a tenant admin cannot see the published information after publishing an agent or a workflow; the versioning screens are chaotic — a new version appears as a new row and versions, the active state and the default state are hard to see and manage |

---

## 1. Requirement Analysis

Two owner statements, in their words:

1. *"Currently the tenant admin cannot see the published information after publishing an agent or workflow."*
2. *"Current versioning items management screens such as agents and workflow management screens are really chaos: when creating a new item version, it shows a new row, and it's hard to see and manage item versions, activate and default state, etc. Prepare a plan for fixing all found defects/issues, and apply the best-practice UX/UI for managing versioned items."*

Classification: **bugfix** (statement 1 is a reproducible defect) **+ UX redesign** (statement 2 is a
pattern problem shared by every versioned-item screen). Both land under this one ticket because the
fix for 1 is only durable once the version model of 2 is in place.

### 1.1 The two versioning models the console has to present

| Model | Entities | Shape in the database |
|---|---|---|
| **A — Row-per-version lineage** | `Agent`, `WorkflowDefinition` | Every version is its own row keyed `(tenantId, slug, versionNumber)`; shared `status` enum DRAFT → VALIDATED → PUBLISHED → DEPRECATED; `isActive` is a movable pointer (partial unique index + `demoteExistingActive`: at most one active PUBLISHED row per slug; `publish {activate}` demotes the previous one). Which SLUG serves a task/palette is a separate `AgentAssignment` / `WorkflowAssignment` row (department → tenant, tag selectors) — the "tenant default". |
| **B — Head + version rows** | `PromptTemplate`+`PromptVersion`, `ConsultationContextSchema`+`…Version`, `DocumentTemplate`+`…Version`, `DnaWritingStyleReport`+`DnaWritingStyleVersion` | One head row carries `status` and a movable pin to an immutable version row. (Two sub-shapes: mutable head auto-versioned on save — prompt templates, DNA; immutable content only via publish — context schemas, document templates.) |

The "chaos" is confined to model A: the Agents grid renders one row per VERSION, and the Workflow
Studio (no grid since TASK-893 OD-1) lists every version row flat in a combobox. Neither surface
shows a lineage, its active pointer, or the assignment that makes a slug the tenant's default, as
one object. Model B screens are structurally sound and already contain the patterns worth reusing
(§2.6).

### 1.2 Success criteria

1. After publishing from either screen, the tenant admin sees the published state without a reload, and can reach the integration details (endpoint, accepted modes, SDK snippet, API-key link) at any later time.
2. One row per lineage in every model-A list; the active version, the open draft, the version count and the assignment ("serves") are readable on the row.
3. A published-but-inactive version can be activated from the UI (rollback), and every irreversible action names its consequence in a confirm dialog.
4. One vocabulary and one badge set for lifecycle status (Draft / Validated / Published / Deprecated), liveness (Active) and assignment (Tenant default / Assigned) across all seven screens.
5. Every finding in §2.4 marked P1 or P2 is fixed or explicitly deferred by owner decision; tests, axe scans and a tenant-admin Playwright pass prove it.

## 2. Current State Evaluation

### 2.1 Reproduced 2026-09-13 as the seeded `tenant_admin` (tenant Global, key `__GLOBAL__`) against the running dev stack

Method: a throwaway draft per entity was created through the admin API (a clone of
`platform-default-summarization` as `review-repro-965`; a v2 branch of
`general-medicine-summarization`), then published through the console with headless Playwright
driving the real screens. Both rows were soft-deleted afterwards.

| Screen | Publish result in the DB | After closing the "Published" dialog | After a page reload |
|---|---|---|---|
| Workflow Studio | `status=PUBLISHED`, `isActive=true`, `publishedAt` set | **Still `DRAFT`**: Save + Discard + Publish buttons, "Unsaved changes — press Save", no lock banner, switcher row unchanged | `PUBLISHED`, "Locked", read-only banner, "Edit as new draft" |
| Agents drawer | `status=PUBLISHED`, `isActive=false` (activation switched off) | Correct: `Published` badge, `Deprecate` button, dialog showed endpoint + SDK snippet | same |

**Not a permissions problem.** The seeded tenant-admin role holds `manage:Agent`,
`manage:AgentAssignment`, `manage:WorkflowDefinition`, `manage:WorkflowRun`
(`packages/database/src/prisma/db_main/seed/01-policy.ts:273-274, 322-323`); the JWT branch of
`UnifiedAuthGuard` honours them; both publish services stamp status, `publishedAt`, compiled config
and `isActive` for a tenant row.

### 2.2 Investigation lanes (rule 14 — read-only fan-out, no worktrees), all returned 2026-09-13

| Lane | Tier | Lens | Output |
|---|---|---|---|
| INV | sonnet | inventory of the seven entities' console surfaces, gateway routes, shared blocks, cross-screen inconsistencies | §2.4 E, §2.5 |
| AG | opus | Agents screen: functional / version-UX / rule compliance | AG-1 … AG-24 |
| WF | opus | Workflow Studio + Assignments: same three lenses | WF-1 … WF-30 |
| HV | sonnet | head+version screens: same lenses, patterns to reuse | HV-1 … HV-12 |
| SEM | sonnet | verified state machine, invariants, list-route shapes, backend gaps | G1 … G10 |
| UX | sonnet + web | best practices for versioned-item management, mapped to shadcn | §3.1 |

Every P1 the plan acts on was re-verified by the orchestrator against source (column *V*: **O** =
orchestrator, code and/or runtime; **L** = lane, file:line cited).

### 2.3 Verified backend semantics (SEM lane, orchestrator-checked)

- Lifecycle is identical for both model-A entities: `create` → DRAFT; `update`/`validate` only on DRAFT/VALIDATED (`assertMutable` → 400 otherwise); a graph/config edit demotes VALIDATED back to DRAFT; `publish {activate ?? true}` stamps compiled config + `publishedAt`, and with `activate` sets `isActive` and calls `demoteExistingActive`. The demoted sibling stays PUBLISHED, `isActive=false`.
- **The only writer of `isActive=true` is `publish()`**, which `assertMutable` refuses on a PUBLISHED row. Hence a published-but-inactive version can never be activated, and an active version can only be demoted by publishing a sibling. DEPRECATED is a dead end (agents), and **does not exist at all for workflow definitions** (no route, no service writer — `workflow-definition.service.ts:1842` is the only mention, inside the guard).
- `deleteById`: agents refuse to delete the active version (409, `agent.service.ts:420-421`); **workflow definitions have no such guard** (`workflow-definition.service.ts` `deleteById` = tenant check + `softDelete`), so the live version can be soft-deleted and its assignment silently falls through at dispatch.
- Assignment resolution is **department → tenant, two tiers**; an unresolved chain is `unassigned` → **503 `AGENT_NOT_ASSIGNED`** (`agent-assignment.service.ts:37-40, 96-108`). There is no platform fallback tier for content (TASK-890 OD-M). Assignments store the SLUG only; a new active version moves every assignment forward, and deprecating/deleting the active version makes the assignment point at nothing (warning + fall-through), without the row changing.
- List routes: `GET admin/agents` is **unpaginated**, every version row; `GET admin/workflow-definitions` is paginated per version, `paletteKey` is the only typed filter — a bare `?status=` is a **400** under `forbidNonWhitelisted` (the generic `filters=status[equals]:PUBLISHED` grammar works).
- `WorkflowDefinitionResponse` carries no `createdBy`/`updatedBy`, and `publishEntity` never stamps `updatedBy`, so "who published" is unanswerable for workflows.
- Runtime-probed: `GET admin/agents/:id` for a SYSTEM agent as a tenant admin answers **404** (the tenant-scope extension force-injects `tenantId`), while the controller's Swagger says "own or SYSTEM template". Consistent with OD-M; the doc string is what is wrong. Follow-up, not in scope (§3.7).

### 2.4 Defect register

Severity: **P1** blocks the owner's goal · **P2** degrades it · **P3** polish. Lens: **F** functional, **UX** version-management UX, **R** rule/consistency, **B** backend gap.

#### A. Publish → visible state (statement 1)

| Id | Sev | Lens | Finding | Evidence | V |
|---|---|---|---|---|---|
| O-1 / WF-1 | P1 | F | Workflow Studio never refreshes after publish: `handlePublish` calls the client directly then `router.refresh()`, which does not touch the TanStack cache (`staleTime 30s`, no focus refetch). The invalidating `usePublishWorkflowDefinition` hook is unused. | `workflow-studio-editor.tsx:768-780`; `api/hooks.ts:114-121`; `shared/providers.tsx:28-36` | O (runtime) |
| WF-2 | P1 | F | Validate commits through `updateWithVersion` (row `_version` bumps) but the console's `postJson` drops the returned ETag, so the canonical edit → Validate → Save loop always 412s on the Save; status badge also stays DRAFT after DRAFT→VALIDATED. | `workflow-definition.service.ts:1395-1410`; `shared/api/http.ts:176-178`; `workflow-studio-editor.tsx:751-766` | O (code) |
| WF-10 | P2 | F | `onSaved` keeps only `version`/ETag; the server's `status` and `validationReport` (rewritten on every graph PATCH) are discarded, so header badge and publish gate show pre-save values. | `workflow-studio-editor.tsx:313-317`; service `:1318-1333` | L |
| WF-11 | P2 | F | In-node prompt edit ignores the new ETag returned by `putWithEtag`; the next graph Save 412s. | `node-prompt-editor.tsx:82,112`; `api/hooks.ts:196-199` | L |
| O-2 / AG-8 / WF-24 | P1 | UX | Endpoint, `?mode=` set, SDK snippet and API-key link exist only in the one-shot publish dialog on both screens; nothing shows them afterwards (agent Overview = date + checksum; studio = nothing). The workflow panel also never says "this version now serves your departments — assign it". | `agent-publish-dialog.tsx:62-96`; `publish-dialog.tsx:53-141`; `agent-detail.tsx:426-441` | O |
| O-3 | P2 | F | Workflow endpoints panel 404s on three legitimate outcomes (published inactive; non-`core` palette; tenant exposure gate off) and shows one generic "reopen to retry" error that cannot succeed. | `WorkflowDefinitionRepository.ts:47`; `exposure-palette-policy.ts:67`; `workflow-exposure.service.ts:556-562, 638-643` | O |
| AG-7 | P2 | F | The create wizard's "Create & publish" bypasses the publish dialog: no freeze confirmation, no activate choice, no integration info; silently demotes the current active. | `create-agent-wizard.tsx:175-190` | L |

#### B. Studio editor integrity (found while tracing A)

| Id | Sev | Lens | Finding | Evidence | V |
|---|---|---|---|---|---|
| WF-4 | P1 | F | Editor ETag and validation report are initial-value `useState` on an unkeyed component; switching to a cached definition keeps the previous one's ETag → 412, or a silent wrong-precondition write when versions coincide. | `workflow-studio-editor.tsx:186-187`; `workflow-studio-screen.tsx:235` | O (code) |
| WF-3 | P1 | F | After a 412 both `OccConflictAlert` escapes are inert: "Reload latest" is `router.refresh()`, "Overwrite anyway" resumes with the same stale ETag. Only a browser reload recovers, losing the buffer. | `workflow-studio-editor.tsx:993`; `use-save-model.ts:79-91, 119-123` | L |
| WF-5 | P1 | F | Publish is not gated on unsaved changes — it freezes the last SAVED graph, unlike the sandbox Run, which is gated. | `workflow-studio-editor.tsx:1015, 1198`; `validation-rail.tsx:25-29` | L |
| WF-6 | P1 | F | Save/Validate/Publish failures other than 412/428 are a 4-word toast or a badge; the gateway's publish-gate findings, capability refusals and "is PUBLISHED and can no longer be edited" are lost (clone/import already surface `GatewayError.message`). | `workflow-studio-editor.tsx:318, 761-762, 775-776`; `occ-alert.tsx:51` | L |
| WF-7 | P1 | F | Five `router.push` navigations (Edit as new draft, clone, import, New, the switcher) bypass the unsaved-changes guard, which only intercepts anchor clicks and `beforeunload`. | `use-unsaved-changes-guard.ts:11-15`; editor `:415,433,449,960`; `workflow-switcher.tsx:91` | L |
| O-4 / WF-8 | P1 | F | Phantom "Unsaved changes" on a fresh clone/template/import: nodes with no stored position default to (0,0), the initial auto-layout is applied via `moveNode`, which dirties the store. The read-only branch already applies it through `hydrate`. | `graph-serialization.ts:31`; editor `:334-357`; `create-graph-store.ts:268-272` | O (runtime) + L (cause) |
| WF-9 | P2 | F | A metadata-only save always sends `graph`, which resets VALIDATED → DRAFT server-side. | editor `:383-391`; service `:1318-1333` | L |
| WF-16 | P3 | F | A non-integer ETag makes `versionFromEtag` throw inside the save path → badge with no message. | `shared/api/http.ts:97-103`; `api/client.ts:112` | L |

#### C. Version management (statement 2) — Agents

| Id | Sev | Lens | Finding | Evidence | V |
|---|---|---|---|---|---|
| AG-13 | P1 | UX | Grid is row-per-version, no lineage grouping; one agent with four versions is four near-identical rows, and client-side pagination can split a lineage across pages. | `AgentRepository.ts:156-163`; `agents-screen.tsx:111, 279-322` | O |
| AG-14 | P1 | UX | Every count counts versions ("12 agent versions"); no distinct-slug count anywhere; facets filter version rows. | `agents-screen.tsx:243, 276, 92-110` | O |
| AG-2 / G1 | P1 | B | No route to activate an already-published version → rollback impossible; the only way back is branch + republish, which adds another row. | `agent-admin.controller.ts:142-177`; `agent.service.ts:446-448, 2541` | O |
| AG-1 | P1 | F | Drawer local state (`editing`, `draft`, `published`, `confirm`, test fields) is not keyed by agent and has no reset effect; an edit form opened on v2 saves onto v3 after "New version" or a Versions-tab click, and the form can appear on a PUBLISHED row. | `agent-detail.tsx:161-188`; `agents-screen.tsx:333` | O (code) |
| AG-3 | P1 | F | The assignment section says "Currently the platform default" when no assignment exists, but resolution is department → tenant → **503 `AGENT_NOT_ASSIGNED`**; the one sentence answering "what serves this task" is false. | `agent-detail.tsx:456`; `agent-assignment.service.ts:37-40, 96-108` | O (code) |
| AG-4 | P2 | F | Deprecating the active version sets `isActive=false`, leaves the assignment pointing at nothing; the confirm never mentions the slug is the tenant default. | `agent.service.ts:544-556`; `agent-detail.tsx:674-686` | L |
| AG-6 | P2 | F | The publish dialog's "Make this the active version" switch is `useState(true)` on a component that stays mounted; turning it off once makes every later publish default to inactive. | `agent-publish-dialog.tsx:60`; `agent-detail.tsx:660-672` | L |
| AG-5 | P2 | F | A 412 on the edit form is a bare toast; the stale ETag is reused on retry. Settings/RBAC already use the inline `OccConflictAlert` + refetch pattern. | `agent-detail.tsx:260`; `setting-drawer.tsx:33`; `role-detail.tsx:64-86` | L |
| AG-9 | P2 | F | Assignments half-wired: only `scope: 'TENANT'` is ever written; `useRemoveAgentAssignment`, `useDepartments`, `useCloneAgent` have no callers; a DEPARTMENT row silently outranks what the drawer shows; a tenant default cannot be removed from the UI. | `agent-detail.tsx:200-203, 279-288`; `api/hooks.ts:107-128` | L |
| AG-15 | P2 | UX | "Tenant default" badge is attached to a version row although the assignment is per-slug — a DRAFT v4 is badged as serving traffic. | `agent-detail.tsx:204, 349`; `api/types.ts:230` | L |
| AG-16 | P2 | UX | The assignment section renders only on the active published row; after the active version is deprecated no row shows it. | `agent-detail.tsx:448` | L |
| AG-17 | P2 | UX | No grid column answers "which agent serves this task"; the assignments data is already loaded in the drawer. | `agents-screen.tsx:146-232` | L |
| AG-18 | P2 | UX | Versions tab shows `vN · name`, status, `updatedAt` only; `publishedAt`, `deprecatedAt`, `createdBy`, model, checksum, active marker, row actions and compare are all absent. | `agent-detail.tsx:602-623`; `api/types.ts:140-170` | L |
| AG-19 | P2 | UX | "New version" is offered on drafts, so a slug accumulates identical-looking drafts — the reported symptom, literally. | `agent-detail.tsx:400-412`; `agent.service.ts:484-542` | L |
| AG-10 | P2 | F | The published "Test run" tab spends metered tokens with no dry-run and no cost line, unlike `DraftTestPanel`. | `agent-detail.tsx:320-332`; `draft-test-panel.tsx:101-109` | L |
| AG-21 | P3 | UX | `?agent=` deep link pins a version row id; a shared link opens a superseded version after the next publish. | `agents-screen.tsx:69, 299` | L |
| AG-20 | P3 | UX | Version column is hideable and the choice persists → permanently duplicated-looking list. | `agents-screen.tsx:184-191, 288-297` | L |
| AG-11 | P3 | F | Assignments fetched twice per page load (key `all` then per task). | `api/hooks.ts:52-54`; `agent-detail.tsx:166` | L |
| AG-12 | P3 | UX | Footer "N of M shown" counts filtered rows, not the page; Delete copy describes a button that is hidden when active. | `agents-screen.tsx:276`; `agent-detail.tsx:413, 691` | L |

#### D. Version management (statement 2) — Workflow Studio + Assignments

| Id | Sev | Lens | Finding | Evidence | V |
|---|---|---|---|---|---|
| WF-17 | P1 | UX | `isActive` is rendered nowhere in the feature (type + picker filter only); the header shows `slug · vN`, status, Locked, Needs review; the switcher `name · vN · STATUS`. | grep; editor `:934-948`; `workflow-switcher.tsx:94-98` | O |
| WF-18 | P1 | UX | No lineage view although `GET :id/versions`, the client fn and `useWorkflowDefinitionVersions` exist with zero consumers. | `workflow-definition.controller.ts:228-235`; `api/hooks.ts:54-56` | O |
| WF-19 / WF-13 / G1 | P1 | B | Rollback not expressible: no activate route; publishing with the switch off creates a permanently inactive version; `UpdateWorkflowDefinitionRequest` has no `status`. | `publish-dialog.tsx:152-158`; service `:1841-1845` | O |
| G2 | P1 | B | Workflow definitions have **no deprecate lifecycle** at all (no route, no writer). | grep; `workflow-definition.service.ts:1842` | O |
| G9 | P2 | B | Workflow `deleteById` has no `isActive` guard (agents have a 409); the live version can be soft-deleted, orphaning assignments. | `workflow-definition.service.ts` `deleteById` | O |
| WF-12 | P2 | F | "Edit as new draft" is unguarded and unconfirmed; the server mints `max+1` with no open-draft check; `useDeleteWorkflowDefinition` / `DELETE :id` have no console consumer, so abandoned drafts are permanent. | editor `:404-419`; service `:419-427`; `api/hooks.ts:101-104` | L |
| WF-20 | P2 | UX | Flat per-version list truncates silently at 100 (switcher, resolver) / 200 (assignment picker); no count, no paging, no notice. | `workflow-switcher.tsx:23,41`; `workflow-studio-screen.tsx:52`; `assignment-matrix-screen.tsx:53` | L |
| WF-21 | P2 | UX | Four words for version state — Locked, Read-only, PUBLISHED/DEPRECATED, invisible Active — two of them the same fact. | editor `:938-943`; `studio-toolbar.tsx:223` | L |
| WF-22 | P2 | UX | Assignment matrix cell shows a bare slug: no name, no active version, no marker when the slug has no active version. | `assignment-matrix-grid.tsx:60` | L |
| WF-14 | P2 | F | Matrix ignores `selectorTags` (part of row identity server-side): the cell may display one row and PATCH another with the displayed row's version. | `api/types.ts:243-266`; `assignment-cascade.ts:29-36`; `workflow-assignment.service.ts:187-195` | L |
| WF-15 | P2 | F | A cell pointing at a slug with no active version opens a blank editor (no matching `SelectItem`) and is badged "Explicit" although the dispatcher skips it. | `assignment-matrix-screen.tsx:89-101`; `assignment-edit-drawer.tsx:94,207`; service `:98-112` | L |
| WF-23 | P2 | UX | `/workflow-studio` resolves to the newest editable row across ALL slugs; publishing your last draft lands you on an unrelated workflow. | `workflow-studio-screen.tsx:78-83` | L |
| G3 | P2 | B | No `createdBy`/`updatedBy` on `WorkflowDefinitionResponse`; `publishEntity` never stamps `updatedBy`. | `workflow-definition.dto.mapper.ts`; service `:1438-1524` | L |
| G4 / G10 | P2 | B | No lineage-grouped list for either entity; agents list is unpaginated, workflow list is paginated per version (client-side grouping across pages is wrong). | `agent-admin.controller.ts:59-65`; `workflow-definition.service.ts:331-355` | L |
| WF-25 | P3 | UX | Stale copy: "Name and description autosave"; "definitions list". | `definition-metadata-form.tsx:32, 41` | L |

#### E. Rule compliance and cross-screen consistency (INV + lanes)

| Id | Sev | Lens | Finding | Evidence | V |
|---|---|---|---|---|---|
| WF-26 | P2 | R | Rule 13: mutations must go through TanStack mutations; the editor imports client functions directly (mechanism behind WF-1/WF-2). | `workflow-studio-editor.tsx:68, 754, 771` | O |
| INV-1 | P2 | R | Same `WorkflowDefinitionStatus` enum coloured differently: DEPRECATED is `destructive` on Agents, `outline` in the switcher; no shared status badge. | `agent-status-badge.tsx:13`; `workflow-switcher.tsx:29` | L |
| INV-2 | P2 | R | Four verbs for "make this the served version": Publish(+activate), Approve, Activate (prompt templates: copies content forward), Pin (schemas/templates). "Active" also means `resourceStatus=ENABLED` in `ResourceStatusBadge` next to "serving vN". | `approval-pin.tsx`; `version-diff-panel.tsx:198`; `versions-panel.tsx:130`; `resource-status-badge.tsx:12` | L |
| INV-3 | P3 | R | Prompt Templates grid persists its column layout under `gridPersistence('agents')`, sharing storage with the Agents grid. | `templates-tab.tsx:345`; `agents-screen.tsx:288` | L |
| INV-4 | P3 | R | Two `AgentDetailDrawer` exports (agents, prompt-templates) and two `VersionsPanel` exports in prompt-templates (`versions-panel.tsx:41`, `version-diff-panel.tsx:70`). | as cited | L |
| INV-5 | P3 | R | Shared `HistoryTimelineList` (`packages/ui/.../timeline`) and `collection/*` are unused; every versions panel is a bespoke `<ul>`. Context-schemas / document-templates / governance lists are hand-rolled instead of the grid (rule 11 §8). | `context-schemas-list.tsx:119-124`; `document-templates-list.tsx:126-130`; `governance-tab.tsx:93-111` | L |
| WF-27 | P2 | R | Rule 10: switcher renders "Loading workflows…" text instead of `Skeleton`. | `workflow-switcher.tsx:78-79` | L |
| WF-28 | P2 | R | No axe scan on the studio editor/screen tests. | `__tests__/workflow-studio-editor.test.tsx`, `workflow-studio-screen.test.tsx` | L |
| WF-29 | P3 | R | WCAG 2.5.3: switcher `aria-label="Switch workflow"` shares no words with its visible label. | `workflow-switcher.tsx:56-72` | L |
| AG-22 | P2 | R | No test covers version switching, active/default rendering, drawer reset, or the unassigned copy; assignments are stubbed `[]` in every suite. | `agents/components/__tests__/*` | L |
| AG-23 | P3 | R | `/agents` has no segment `loading.tsx` / `error.tsx`. | `app/(console)/(tenant)/agents/` | L |
| AG-24 / WF-30 | P3 | R | Raw `VirtualizedDataGrid` + hand-rolled paging instead of the `AdminDataGrid` wrapper; className concatenation instead of `cn()`. | `agents-screen.tsx:111, 279`; editor `:1045-1062` | L |
| Delete confirm | P3 | R | Agents' Delete confirm lacks `typeToConfirm`, unlike prompt templates / schemas / document templates. | `agent-detail.tsx:687-702` | L |

#### F. Head+version screens (model B) — consistency and defects

| Id | Sev | Lens | Finding | Evidence | V |
|---|---|---|---|---|---|
| HV-9 | P1 | F | DNA styles: the grid lists every report row per doctor (no `isLatest` filter) but row click selects by `doctorId` and the drawer reads the LATEST report — clicking an older row silently opens the current one. | `dna-writing-styles-screen.tsx:334`; `client.ts:31-36`; `dna-writing-style.service.ts:721-736` | L |
| HV-10 | P2 | F | DNA styles: no delete action in the UI although `DELETE admin/dna-writing-styles/doctor/{doctorId}` exists and an `includeDisabled` filter implies disabled rows. | `dna-writing-styles/**`; `route-manifest.json` | L |
| HV-4 | P2 | UX | Context schemas + document templates: "Pin" (the rollback) fires with no confirm and no diff; prompt templates' equivalent is confirm-gated beside a diff. | `versions-panel.tsx:69,128`; `template-versions-panel.tsx:64-133` | L |
| HV-5 | P2 | UX | Context schemas + document templates: status badge is always `outline`; APPROVED is indistinguishable from DRAFT. | `context-schemas-list.tsx:36`; `document-templates-list.tsx:38` | L |
| HV-6 | P2 | UX/governance | Context schemas + document templates reach APPROVED through a plain status `<Select>` in the metadata form (no reason, no confirm, no super-admin split gate); prompt templates use a dedicated governed `/approve`. | `settings-form.tsx:23,41,51`; `template-settings-form.tsx:27` | L |
| HV-7 | P2 | UX | Context schemas have no "what is served now" signal; document templates have `EffectiveTemplateBanner`. | `document-templates/components/effective-template-banner.tsx` | L |
| HV-8 | P2 | UX | `sourceTemplateSlug` / `templateLocked` are on the wire but rendered nowhere on schemas/templates; prompt templates show `TemplateOriginBadge`. | `context-schemas/api/types.ts:23-25` | L |
| HV-11 | P3 | UX | DNA version timeline shows number/date/reason only; archived text is on the wire but unviewable. | `doctor-detail.tsx:30-64`; `types.ts:29-38` | L |
| HV-1/2/3/12 | P3 | R | Duplicate `VersionsPanel` symbol; Versions tab without count; unused `getVersion` read; Approve without confirm. | as cited by lane | L |

### 2.5 What works today and stays

- Agents: `AgentStatusBadge` renders "Published · ★ Active" in text, not colour alone; `problemToast` surfaces coded gateway findings; `DraftTestPanel`'s dry-run default and cost sentence; the instruction round-trip pair; `ModelPicker` greys unusable models with a reason; the page frame (ScreenTemplate fill + DetailDrawer + Skeleton/Empty/Error) and axe gates.
- Studio: the explicit save-state machine (`dirtied()`, baseline + discard); `useSaveModel`'s pause-after-412 single flight; "read-only is a state, not a silence" (lock chip + banner + inert palette, gated on both add paths); clone/import surfacing `GatewayError.message` verbatim; reflow gate + one scroll container; assignment matrix source badges with a legend.
- Model B: coarse root-key invalidation on every mutation (no stale cache found); OCC used correctly; belt-and-braces refetch in drawers.

### 2.6 Patterns already in the codebase to generalise (reference implementations)

| Pattern | Where | Reuse in |
|---|---|---|
| "What is served right now, and why not" banner | `document-templates/components/effective-template-banner.tsx` + `lib/effective-template.ts` | Context schemas (HV-7); the lineage row's "Serves" state for agents/workflows |
| "serving vN · editing vM" single badge | `prompt-templates/components/approval-pin.tsx` (`ApprovalPin`) | Lineage rows: active version + open draft in one chip |
| Reference-set provenance badge | `approval-pin.tsx` (`TemplateOriginBadge`) | Schemas/templates (HV-8); replaces `AgentOwnerBadge` |
| Version list with pin + server skew badge | `context-schemas/components/versions-panel.tsx` | The shared `VersionHistoryPanel` (model B flavour) |
| Confirm-gated activate beside a diff | `prompt-templates/components/version-diff-panel.tsx` | Activate (model A) and Pin (model B) |
| Inline OCC conflict alert + refetch | `shared/occ/occ-alert.tsx`, `features/settings/components/setting-drawer.tsx:33` | Agents edit form (AG-5), studio (WF-3) |
| Type-to-confirm destructive dialog | `shared/confirm/confirm-dialog.tsx` | Agents delete, Discard draft |
| Virtualised timeline with expansion + restore icon | `packages/ui/src/components/timeline/history-timeline-list.tsx` | Optional renderer for the Versions tab |

## 3. Implementation Plan

### 3.1 Target UX (from the research lane, mapped to the house kit)

Sourced from AWS Lambda versions/aliases, Cloud Run revisions, Vercel promote/rollback, Salesforce Flow's one-active-version, Auth0 Actions revert, Retool releases (Live tag + diff), LangSmith prompt tags, n8n/Dify history; full table in the session report. The consistent findings:

1. **One row per lineage**, versions in a drill-down — never one row per version in the primary list.
2. **Two orthogonal axes, two badge families:** lifecycle status (Draft / Validated / Published / Deprecated) and liveness (**Active** = the one published version this slug serves). A third, separate family for **assignment** (Tenant default / Assigned to Cardiology) — which SLUG serves a task. Never the same variant, never colour alone.
3. **Activate is its own verb** (rollback = "Activate v2" on a published-inactive version, confirm dialog naming what is demoted). Publish freezes a draft; it must not silently be the only way to move the pointer.
4. **Immutable published bodies are edited as a new draft** ("New draft" / "Branch from v2"), never "Edit"; an open draft is continued, not duplicated.
5. **Consequences are named** in every irreversible confirm (Vercel/Auth0 pattern): "v3 becomes active, v2 stops serving; 2 department assignments follow the slug".
6. **Integration details persist** on the lineage (LangSmith `name:tag`, GitHub release page): an Integration tab derived from `slug` + task, "always calls the Active version".
7. **Compare against the previous version** as the minimum diff affordance (client-side, the versions route already returns full bodies).

**Vocabulary (one table for all seven screens)**

| Concept | Label | Badge variant | Icon | Verb(s) |
|---|---|---|---|---|
| Draft | Draft | `outline` | `IconPencil` | New draft, Edit, Discard draft |
| Validated | Validated | `secondary` | `IconCircleCheck` | Validate |
| Published (immutable) | Published | `default` | `IconCloudUpload` | Publish |
| Deprecated | Deprecated | `outline` + `text-muted-foreground` (not destructive) | `IconArchive` | Deprecate |
| The served version of a slug (model A) | Active | `default` + text "Active" + `IconPlayerPlayFilled` (kept from `AgentStatusBadge`) | | Activate (rollback) |
| Pinned version (model B) | Pinned vN | `default` | | Pin (confirm + diff) |
| Which slug serves a task/palette | Tenant default · Assigned to «Dept» · Unassigned (warning) | `secondary`; Unassigned = `outline` + warning icon | `IconLink` | Assign, Reassign, Remove assignment |
| Provenance | Platform origin (+ Locked) | `secondary` | `IconLock` when locked | — |

**Row model — Agents (`/agents`)**: one row per slug — Name · Slug · Task · **Active** (vN Published · Active, or "None active" warning) · **Draft** (vM Draft/Validated when an open draft exists, else —) · Versions (count) · **Serves** (Tenant default / Assigned ×N / —) · Origin · Tags · Updated. Header: "7 agents · 19 versions". Facets: task, has active, has draft, serves, origin, tags. Deep link `?agent=<slug>[&v=<n>]`.

**Detail drawer (lineage) — Agents**: header = name, slug, Active vN, Serves badges, origin. Tabs: **Overview** (active version summary, model, fallbacks, published date/by, checksum, integration teaser) · **Versions** (newest first: vN, status, Active marker, validated/published/deprecated dates, by, model, checksum; row actions Open · Activate · Deprecate · New draft from this · Compare with previous · Export · Discard draft) · **Draft** (the open draft's Configuration editor + Validate/Publish/Test bench; when no draft: "New draft") · **Assignments** (every row for the task: scope, department, selector, slug, source; Set tenant default; per-department; Remove; the resolved answer "Cardiology → v3 of this slug" or the fail-closed warning) · **Integration** (endpoint, `?mode=` set, vox-node snippet, API-keys link, "calls the Active version vN") · **Test run** (published bench with the dry-run/cost line).

**Workflow Studio**: OD-1 (TASK-893) stays — no definitions grid. Instead: (a) **lineage-grouped switcher**: one entry per slug, `name · Active vN · Draft vM`, expandable to the versions, sorted by name, server-paged with a count; (b) a **Versions panel** opened from a header chip `v3 · Published · Active` (same `VersionHistoryPanel` as agents, actions Open · Activate · Deprecate · New draft · Discard draft · Compare); (c) header line "Serves: 3 departments · tenant default" linking to the matrix, and "None active" warning; (d) publish dialog's second step becomes "Published — what happens next": active state, assignment summary + "Assign this workflow", integration block (with the three 404 cases explained: not active / palette not exposable / exposure off); (e) **Integration** entry in the inspector rail for published versions; (f) resolver `/workflow-studio` opens the last-opened lineage (localStorage) else the newest lineage's active-or-draft row, never another slug.

**Model B screens**: keep their shape; align vocabulary (shared `LifecycleStatusBadge`), confirm + diff on Pin, origin badge, effective banner on context schemas, DNA row identity + delete.

### 3.2 Owner decisions — **all recommendations approved by the owner on 2026-09-13** ("approve all recommendations, start WS-1")

| Id | Decision | Recommendation (approved) |
|---|---|---|
| **OD-965-1** | Add `POST admin/agents/:id/activate` and `POST admin/workflow-definitions/:id/activate` (PUBLISHED-only, sets `isActive`, calls `demoteExistingActive`, emits `ResourceUpdated`). Without it rollback stays impossible (AG-2, WF-19). | **Yes.** Thin service methods; five artifacts + authz matrix; two cross-tenant e2e specs. |
| **OD-965-2** | Add `POST admin/workflow-definitions/:id/deprecate` mirroring agents (G2), and the `isActive` delete guard (G9). | **Yes.** No migration (the DB trigger already special-cases DEPRECATED). |
| **OD-965-3** | Lineage list: (a) new read-only `GET admin/{agents,workflow-definitions}/lineages` (one row per slug: active row, newest draft row, version count, assignment summary; paginated by slug) vs (b) client-side grouping over the per-version lists. | **(a).** Agents' list is unpaginated (G10) and the workflow list pages per version, so client grouping is wrong at scale. The per-version routes stay for the Versions tab. |
| **OD-965-4** | Reopen TASK-893 OD-1 (a Workflows list screen, one row per lineage, with the studio as its editor) vs keep "one studio" and add the lineage-grouped switcher + Versions panel inside it. | **Keep OD-1**, add the in-studio lineage affordances (§3.1). Revisit only if the switcher does not scale in use. |
| **OD-965-5** | `createdBy`/`updatedBy` on `WorkflowDefinitionResponse` and stamping `updatedBy` in `publishEntity` (G3) — needed for "published by". | **Yes** (additive DTO change; regenerate artifacts). |
| **OD-965-6** | HV-6: bring context schemas / document templates' APPROVED under a governed approve action like prompt templates, or leave as is. | **Separate ticket**; out of 965's scope beyond the badge (HV-5). |
| **OD-965-7** | Diff: client-side "Compare with previous" over the existing versions payload vs a server diff route (G5). | **Client-side** in 965; no backend. |
| **OD-965-8** | Scope of model-B fixes in 965: HV-9 (P1), HV-10, HV-4, HV-5, HV-7, HV-8 in; HV-1/2/3/11/12 polish in if cheap. | **As stated.** |
| **OD-965-9** | Agents: keep "New version" only on Published/Deprecated rows, and route the wizard's "Create & publish" through the publish dialog (AG-7, AG-19). | **Yes.** |

### 3.3 Workstreams and order

Layer order per rule 01 (DB → domain → services → API → console). Worktrees per rule 14 once the backend contract (WS-2) is committed; WS-1 is shippable on its own first.

#### WS-1 — Stop the bleeding (console only, no redesign) — ≈ 2 days

Small surgical fixes for the P1 functional defects, each TDD (test first, RED, then GREEN):

1. Route Publish and Validate through `usePublishWorkflowDefinition` / `useValidateWorkflowDefinition`; adopt the response's `status`, `validationReport`, `isActive`, ETag into the editor; invalidate the studio namespace (WF-1, WF-2, WF-10, WF-26).
   *Test:* after publish the editor renders PUBLISHED + Locked + read-only toolbar; after validate the ETag moves and a Save carries it.
2. Key `WorkflowStudioEditor` by `definitionId` (WF-4). *Test:* switching definitions resets ETag/report.
3. `OccConflictAlert` escapes: Reload = invalidate detail + adopt ETag; Overwrite = refetch, take ETag, re-PATCH (WF-3). *Test:* 412 → Reload → Save succeeds.
4. Gate Publish on `dirty || metadataDirty` with the Run panel's wording (WF-5).
5. Surface `GatewayError.message` + `findings` for Save/Validate/Publish in the Problems rail and a toast (WF-6).
6. `confirmNavigate(href)` for the five programmatic navigations (WF-7).
7. Apply the initial auto-layout through `hydrate` on the editable branch (WF-8, O-4). *Test:* a positionless graph opens clean.
8. Send `graph` only when the store is dirty (WF-9); pass the ETag back from the node-prompt editor (WF-11).
9. Key `AgentDetailDrawer` by `agentId` and reset the publish dialog's switch per open (AG-1, AG-6).
10. Replace "Currently the platform default" with the resolved truth + warning (AG-3); name the assignment consequence in the Deprecate confirm (AG-4).
11. Publish dialog (workflow): when `activate=false`, say "Published, not active — activate it from Versions" instead of fetching; map the 404 to the palette/exposure explanation (O-3).
12. DNA styles: key the row/drawer by report id or filter the grid to latest (HV-9).

Gate: `pnpm --filter @arcaai/admin-console build lint test`; tenant-admin Playwright pass of publish → visible state on both screens.

#### WS-2 — Backend lineage API (OD-965-1/2/3/5) — ≈ 2–3 days

Domain/service/API in that order; `packages/applications` unit tests first, then `apps/api` controller tests, then e2e.

1. Repository: `WorkflowDefinitionRepository.findPublishedBySlugVersion` (parity with agents, G7); lineage projections `findLineagesForTenant(tenantId, page)` for both (group by slug: active row, newest draft row, version count, `maxVersionNumber`).
2. Services: `activate(id)` ×2 (PUBLISHED-only, `demoteExistingActive`, sys-event); `WorkflowDefinitionService.deprecate(id)`; `isActive` guard in `WorkflowDefinitionService.deleteById` (409); stamp `updatedBy` in `publishEntity`; `listLineages(query)` ×2 joining the assignment summary (tenant default + department count per slug).
3. DTOs: `AgentLineageResponse` / `WorkflowLineageResponse` (paginated); `createdBy`/`updatedBy` on `WorkflowDefinitionResponse`.
4. Controllers: `POST admin/agents/:id/activate`, `POST admin/workflow-definitions/:id/activate`, `POST admin/workflow-definitions/:id/deprecate`, `GET admin/agents/lineages`, `GET admin/workflow-definitions/lineages` (declared above `:id`), all `@CanManage`, `@ForbidApiKey`, `svc:admin:*:manage`, tags from the taxonomy, summary + description + 4xx.
5. Regenerate the five artifacts: `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin`; `*:check` green.
6. e2e: lifecycle spec (publish inactive → activate → previous demoted; deprecate → assignment falls through with the fail-closed 503 for agents), cross-tenant specs for the new routes (404 posture), authz matrix green.

Gate: `pnpm --filter @arcaai/applications build test`, `pnpm api:build`, `pnpm test:unit`, `pnpm test:e2e` (against `test:up:api`).

#### WS-3 — Shared versioning kit (`apps/admin-console/src/shared/versioning/`) — ≈ 2 days

Console-shared, feature-agnostic, tested and axe-scanned in isolation:

- `LifecycleStatusBadge` (the vocabulary table; replaces `AgentStatusBadge`'s status half, `STATUS_VARIANT`, the bare `outline` badges on schemas/templates, `TemplateStatusBadge` stays for its APPROVED semantics but shares the map).
- `ActiveBadge`, `AssignmentBadges` (tenant default / assigned / unassigned warning), `OriginBadge` (generalised `TemplateOriginBadge`).
- `VersionHistoryPanel` — one list for both models: rows (vN, status, active/pinned marker, dates, by, checksum/skew), row action menu supplied by the caller, keyboard-operable, `aria-expanded` on expansion; optional `HistoryTimelineList` renderer.
- `ActivateVersionDialog` / `DeprecateVersionDialog` / `DiscardDraftDialog` — consequence-naming `AlertDialog`s (what becomes active, what stops serving, which assignments follow).
- `IntegrationPanel` — endpoint, modes, snippet (from `shared/docs/sdk-snippets`), API-keys link, "calls the Active version vN"; handles the not-active / not-exposable / exposure-off cases with copy.
- `VersionCompareDialog` — client-side JSON diff of two versions (`CodeEditor`-based, unified/split), used by both models.

#### WS-4 — Agents screen on the lineage model — ≈ 3 days

- Grid from `GET admin/agents/lineages` via `AdminDataGrid` (row model in §3.1); counts, facets, `Version` no longer hideable; deep link by slug (AG-13/14/17/20/21/24).
- Drawer rebuilt on the kit: tabs Overview · Versions · Draft · Assignments · Integration · Test run; lineage-level actions; "New draft" only when no draft is open (else "Continue draft vM"); Activate/Deprecate/Discard via the dialogs; OCC inline alert on the draft form (AG-5); assignment tab with scope/department/selector rows and remove (AG-9/15/16); cost line on the published bench (AG-10); wizard publishes through the dialog (AG-7); `loading.tsx`/`error.tsx` (AG-23).
- Tests: lineage grouping, active/default rendering, drawer reset on version switch, unassigned copy, activate → previous demoted, axe on grid + drawer. Existing tests listed in §3.5 updated.

#### WS-5 — Workflow Studio on the lineage model — ≈ 3 days

- Lineage-grouped switcher with count + paging + Skeleton (WF-17/18/20/27/29); header chip → `VersionHistoryPanel`; "Serves" line; `isActive` in the header (WF-21: drop "Locked" in favour of status + Active, keep the banner).
- Publish dialog second step = "what happens next" (WF-24, O-2); Integration entry in the rail.
- "Edit as new draft" → continue-or-branch with confirm; Discard draft wired to `DELETE :id` (WF-12).
- Resolver keeps the last-opened lineage (WF-23).
- Assignment matrix: name + active vN + "no active version" marker per cell; carry `selectorTags` on the row model and the write; disable Save with a reason when the slug has no active version (WF-14/15/22).
- Stale copy (WF-25), `cn()` (WF-30), axe scans on editor + screen (WF-28).

#### WS-6 — Model-B consistency — ≈ 2 days

`LifecycleStatusBadge` on schemas/templates (HV-5, INV-1/2); confirm + diff on Pin (HV-4); `OriginBadge` (HV-8); effective banner on context schemas (HV-7); DNA delete with type-to-confirm (HV-10) and version text view (HV-11, if cheap); `gridPersistence('prompt-templates')` (INV-3); rename the duplicate `AgentDetailDrawer`/`VersionsPanel` symbols (INV-4, HV-1); Versions tab count (HV-2); Agents delete gets `typeToConfirm`.

#### WS-7 — Verification and documentation — ≈ 1–2 days

Tenant-admin Playwright pass (publish → visible; activate → rollback; deprecate → warning; integration tab reachable), axe 0 violations per screen in both themes, manual keyboard + 200 % zoom pass, README §4–5 with pasted output, deprecation-register entry for `AgentOwnerBadge`/`STATUS_VARIANT` if removed.

**Parallelism (rule 14):** WS-1 first, single lane (touches the same files as WS-5). Then WS-2 (backend) and WS-3 (kit) in parallel worktrees — the lineage DTO shape is written into this README before spawning (the interface contract). WS-4 and WS-5 fan out after WS-2 + WS-3 merge; WS-6 can run beside them (disjoint features). Tier: opus for WS-1/WS-4/WS-5 (multi-file, judgement), sonnet for WS-6 and the mechanical parts of WS-2 with opus review of the service methods.

### 3.4 Interface contract for the new routes (fixed before WS-2/WS-4/WS-5 spawn)

```
GET admin/agents/lineages?page&limit&task&filters=…            → Paginated<AgentLineageResponse>
GET admin/workflow-definitions/lineages?page&limit&paletteKey   → Paginated<WorkflowLineageResponse>

LineageResponse (both):
  slug, name (of the active row, else newest), task | paletteKey,
  versionCount, latestVersionNumber,
  active:  { id, versionNumber, publishedAt, publishedBy?, modelSlug? | registryChecksum? } | null,
  draft:   { id, versionNumber, status: 'DRAFT'|'VALIDATED', updatedAt } | null,
  deprecatedCount,
  assignment: { tenantDefault: boolean, departmentCount: number, selectorCount: number },
  origin:  { sourceTenantId | sourceTemplateSlug, templateLocked },
  tags, updatedAt

POST admin/agents/:id/activate                → AgentResponse            (PUBLISHED-only; 400 otherwise; demotes sibling)
POST admin/workflow-definitions/:id/activate  → WorkflowDefinitionResponse
POST admin/workflow-definitions/:id/deprecate → WorkflowDefinitionResponse (PUBLISHED-only; isActive=false)
DELETE admin/workflow-definitions/:id         → 409 when isActive (new guard)
WorkflowDefinitionResponse += createdBy, updatedBy
```

### 3.5 Existing tests that pin behaviour the plan changes (update, do not delete)

- Agents: `agents-screen.test.tsx` ("lists this tenant's own agents", five tab names, footer labels), `agent-detail.task890.test.tsx` (integration info in the dialog; "Create vN" copy), `agent-publish-dialog.task890.test.tsx` (two-phase dialog, activate default), `agents-portability.task884.test.tsx` (export of the open version; selector write shape).
- Studio: `workflow-studio-editor.test.tsx` (If-Match "1" from the prop; `beforeunload` only; no multi-node fixture), `workflow-switcher.test.tsx` (aria-label), `workflow-studio-screen.test.tsx` (`pickDefaultDefinition`), `studio-toolbar-and-publish-dialog.test.tsx` (publish gate report-only; activate default; the five endpoint-panel cases), `use-save-model.test.tsx` (412 pause/resume), `use-unsaved-changes-guard.test.tsx`, `ensure-canvas-layout.test.ts`, `graph-store-save-model.test.ts`, `assignment-matrix-screen.test.tsx` (tuple write without selector tags).
- Model B: `prompt-templates-screen.test.tsx:453` (confirm-gated activate — the pattern to copy), `context-schemas-screen.test.tsx:315,339` and `document-templates-screen.test.tsx:332,349` (Pin interaction sequence), `dna-writing-styles-screen.test.tsx:281`.
- Backend (must stay green): `agent.service.test.ts`, `workflow-definition.service.test.ts`, `agent-assignment.service.test.ts`, `workflow-assignment.service.test.ts` + `.resolution.test.ts`, `task-779-workflow-lifecycle.spec.ts`, `task-890-agent-resolve-fail-closed.spec.ts`, `task-776-route-authz-matrix.spec.ts`.

### 3.6 Verification criteria (definition of done)

- All P1/P2 rows in §2.4 either fixed with a named test or deferred by an OD in §3.2.
- Tenant-admin Playwright evidence for: publish → PUBLISHED visible without reload (both screens); activate an older version → previous demoted, assignment follows; deprecate the active version → consequence named, assignment shown as unresolved; Integration tab reachable after closing the dialog.
- `pnpm --filter @arcaai/admin-console build lint test`, `pnpm --filter @arcaai/applications build test`, `pnpm api:build`, `pnpm test:unit`, `pnpm test:e2e`, the five API artifacts regenerated with `*:check` green.
- axe 0 violations on `/agents`, `/workflow-studio`, `/workflow-studio/assignments`, both themes; keyboard pass documented.

### 3.7 Out of scope / follow-ups

- G8 doc drift: `GET admin/agents/:id` Swagger says "own or SYSTEM template" but the tenant-scope extension answers 404 for SYSTEM ids (runtime-probed); fix the doc strings, keep OD-M behaviour.
- G6 restore route for soft-deleted versions; the stale `workflow-assignment.prisma` header describing a SYSTEM fallback tier; the retired `AsrPipeline` controller with two list routes and no consumer; HV-6 governance for schemas/templates (OD-965-6).

## 4. Implementation Summary

### 4.1 WS-1 — stop the bleeding (console only, 2026-09-13)

TDD: six new test files were written first and all 20 cases were RED against the unchanged code
(run captured in the session), then made GREEN. No redesign; every change is a surgical fix of a
§2.4 P1/P2 row.

| Fix | Rows | Change |
|---|---|---|
| Publish/Validate through the studio's TanStack mutations; the editor adopts the response's `status`, `validationReport` and ETag; the namespace is invalidated so the definition, versions and switcher refetch | WF-1, WF-2, WF-10, WF-26 | `workflow-studio-editor.tsx` (`handleValidate`, `handlePublish`), `api/client.ts` (`validate`/`publish` now return `WithEtag`), new `postWithEtag` in `shared/api/http.ts` |
| Lifecycle `status` and the ETag are local state that FOLLOW the props (render-time adjustment, the compiler-lint-safe form of "derive state from a prop change"), so an out-of-band refetch never leaves a stale If-Match behind | WF-4 (adjacent), WF-11 | `workflow-studio-editor.tsx` |
| Publish withheld while the buffer is dirty, with the Run panel's wording | WF-5 | `workflow-studio-editor.tsx` (`publishDisabledReason`) |
| Save/Validate/Publish failures surface the gateway message (plus the first finding) instead of a four-word toast or a bare badge | WF-6 | `lifecycleFailureMessage`, the `save.lastError` toast |
| Every programmatic navigation ("New", "Edit as new draft", clone, import, the switcher) asks about unsaved changes through one helper | WF-7 | `confirmLeave` in `use-unsaved-changes-guard.ts`; `WorkflowSwitcher.onNavigate` |
| Initial auto-layout of a positionless graph goes through `hydrate` (display bookkeeping), never `moveNode` — a fresh clone/template/import opens clean | WF-8 / O-4 | `workflow-studio-editor.tsx` (layout effect) |
| A metadata-only Save no longer sends `graph`, so a VALIDATED version keeps its status | WF-9 | `buildPatch` |
| `OccConflictAlert` escapes are real: Reload latest re-hydrates from the server (confirmed first); Overwrite anyway takes the fresh ETag and re-sends the buffer in the same tick | WF-3 | `handleReloadLatest`, `handleOverwriteAnyway`; `useSaveModel.save(patch, { etag })` override |
| Published dialog explains the three non-error outcomes (not active; palette not exposable; exposure gate off) instead of "reopen to retry"; the first two never hit the network | O-3 | `publish-dialog.tsx` (`activated`, `exposable`, `paletteKey` props); `CORE_PALETTE_KEY` exported from `lib/palette-keys.ts` |
| Agent drawer resets every transient state when `agentId` changes; the activate switch resets per open | AG-1, AG-6 | `agent-detail.tsx`, `agent-publish-dialog.tsx` |
| Assignment copy tells the fail-closed truth (`AGENT_NOT_ASSIGNED`, no platform fallback); the Deprecate confirm names the tenant-default consequence | AG-3, AG-4 | `agent-detail.tsx` |
| DNA styles: superseded report rows are badged and refuse to open the latest report in their place | HV-9 | `dna-writing-styles-screen.tsx` |

Files changed (12) — `apps/admin-console/src/`: `shared/api/http.ts`, `shared/api/index.ts`,
`features/workflow-studio/{api/client.ts, hooks/use-save-model.ts, hooks/use-unsaved-changes-guard.ts, lib/palette-keys.ts, components/publish-dialog.tsx, components/workflow-switcher.tsx, components/workflow-studio-editor.tsx}`,
`features/agents/components/{agent-detail.tsx, agent-publish-dialog.tsx}`,
`features/dna-writing-styles/components/dna-writing-styles-screen.tsx`.
Tests added (6): `workflow-studio-editor.task965.test.tsx` (11 cases), `publish-dialog.task965.test.tsx` (3),
`use-unsaved-changes-guard.task965.test.tsx` (2), `agent-detail.task965.test.tsx` (3),
`agent-publish-dialog.task965.test.tsx` (1), `dna-writing-styles-screen.task965.test.tsx` (2).
No existing test was changed; no backend change; no migration.

Deferred to later workstreams on purpose: WF-12 (continue-or-branch), WF-13/AG-2 (activate route,
WS-2), the lineage row model (WS-4/5), the model-B badge/confirm alignment (WS-6).

### 4.2 WS-1 addendum (2026-09-13) — the Integration surface pulled forward, and the invisible trigger → agent binding

Owner, after WS-1, as super admin impersonating the ArcaAI tenant admin: *"I don't see anywhere I
can get the published information (endpoints, etc) of any agents or any workflows"* and
*"`Platform Default — Summarization` shows no connection between the trigger node and the agent
node — get me the root cause."*

**Integration surface (O-2 / AG-8 / WF-24, originally WS-3/4/5).** WS-1 had left the endpoint,
`?mode=` set, SDK snippet and API-key link inside the one-shot publish dialogs, so an admin who did
not publish in this session (or closed the dialog) had no way to see them. Pulled forward:

| Change | Where |
|---|---|
| `IntegrationPanel` — the console-shared "how developers reach this" surface for a published agent (task-shaped endpoint, note, `hope.agents.invoke`/`transcribe`/`speak` snippet) or workflow (`POST /workflows/{slug}/runs`, admitted `?mode=` values without `socket`, snippet), plus the API-keys link. Everything derives from the LINEAGE (slug, task/palette, active flag), never from a publish response. The three workflow non-error outcomes (not active / palette not exposable / exposure gate off) are explained; the first two never fetch. | new `apps/admin-console/src/shared/versioning/{integration-panel.tsx,index.ts}` (the first piece of the WS-3 kit) |
| Agents drawer gains an **Integration** tab: the panel for PUBLISHED/DEPRECATED rows, an empty state ("Publish this version to expose …") otherwise | `agent-detail.tsx` |
| Workflow Studio header gains an **Integration** button on every PUBLISHED version, opening the panel in a dialog | `workflow-studio-editor.tsx` |
| Both publish dialogs render the SAME shared panel as their published step, so the dialog and the persistent surface cannot disagree | `publish-dialog.tsx`, `agent-publish-dialog.tsx` |

**Root cause — the trigger → agent connection that does not draw.** Verified against the ArcaAI
tenant's row (`platform-default-summarization` v1, PUBLISHED, active): the graph carries TWO edges,
`n_trigger.out → n_summary.context` and `n_summary.out → n_output.in`. The registry declares
`context` (object) as an input of `core.agent` and `out` (`context<schemaRef>`) as the trigger's
data output, so the wire is valid — the footer counted it ("3 nodes · 2 connections"). It was
invisible because the editor's canvas projection **filtered out every edge whose target port is a
"secondary input"** — any data input other than `in` — before handing the graph to the canvas
(`workflow-studio-editor.tsx` `canvasEdges`, `.filter((edge) => !isSecondaryBinding(edge))`).
TASK-893 §3.1 moved secondary inputs (`context`, `audio`, …) from canvas wires to inspector
binding fields ("Context ← ① Trigger") and dropped them from the canvas entirely. The platform's
own default workflow feeds the agent exclusively through `context`, so its primary data flow
became a trigger connected to nothing. Not a data problem, not a seed problem, not a permission
problem.

**Fix.** The shared canvas gains `WorkflowCanvasEdge.kind: 'wire' | 'binding'`
(`packages/ui/src/components/workflow-canvas/{types.ts,workflow-canvas.tsx,workflow-edge.tsx}`): a
binding edge is drawn dashed (`strokeDasharray 6 4`, 75 % opacity), always labelled with the port
name (mono, with a title naming the node it is bound on), lands on the primary input dot, and is
**never deletable from the canvas** (no hover-X, `deletable: false` for the Delete key). The
editor now projects secondary bindings as `kind: 'binding'` instead of dropping them; the
inspector stays the one place they are edited (TASK-893 §3.1 honoured, only the invisibility is
gone). Alongside: `shortNodeId` keeps a digit-free authored id whole (the seed's `n_trigger`
rendered as "rigger" and `n_summary` as "ummary", which read as typos); generated ids and uuids
still show their stable tail.

Files: `packages/ui/src/components/workflow-canvas/{types.ts,workflow-canvas.tsx,workflow-edge.tsx}` +
`__tests__/workflow-canvas-binding-edge.vitest.tsx`; `apps/admin-console/src/shared/versioning/**` (+ tests);
`features/workflow-studio/{components/workflow-studio-editor.tsx,components/publish-dialog.tsx,lib/node-identity.ts}`;
`features/agents/components/{agent-detail.tsx,agent-publish-dialog.tsx}`. Tests added: 7 (panel), 2 (agent
Integration tab), 4 (studio Integration + binding edge + node names), 2 (short id), 1 (canvas binding edge).

## 5. Verification

### 5.1 WS-1 evidence (2026-09-13)

| Gate | Command | Result |
|---|---|---|
| RED | `npx vitest run <6 new files>` before the fixes | `Test Files 5 failed (5) · Tests 20 failed (20)` (DNA file written after; failed on the same run pattern) |
| GREEN + no regressions | `npx vitest run src/features/workflow-studio src/features/agents src/features/dna-writing-styles` | `Test Files 88 passed (88) · Tests 743 passed (743)` |
| Lint | `npx eslint <all 18 touched files>` | exit 0 (four `react-hooks/set-state-in-effect` errors surfaced on the first pass and were fixed by moving to render-time adjustment) |
| Typecheck | `pnpm --filter @arcaai/admin-console typecheck` | exit 0 |
| Build | `pnpm --filter @arcaai/admin-console build` | exit 0 (the only "error" lines are pre-existing Edge Runtime warnings in `instrumentation.ts`) |
| Runtime, tenant admin | headless Playwright against the running dev console (`tenant_admin` / `__GLOBAL__`), on a fresh clone `review-965-ws1` (soft-deleted afterwards) | fresh clone: `All changes saved.` (was "Unsaved changes") · Validate → `VALIDATED` · metadata Save → `PATCH 200`, no 412, still `VALIDATED` · Publish → `POST 200` then `GET` refetch of the definition, versions and list · after Done, **no reload**: `PUBLISHED` + `Locked` + `Read-only`, no `DRAFT`, no Save, "Edit as new draft" offered; dialog showed `POST /workflows/review-965-ws1/runs`, modes, snippet, API-key link |

Screenshots (session scratchpad): `v-1-fresh.png`, `v-2-after-save.png`, `v-3-published-dialog.png`, `v-4-after-done.png`; the pre-fix state is `wf-3-after-done.png`.

### 5.2 WS-1 addendum evidence (2026-09-13)

| Gate | Command | Result |
|---|---|---|
| Shared canvas | `npx vitest run src/components/workflow-canvas` (packages/ui) | `10 files · 63 tests passed` (one pre-existing case pinned the exact edge shape handed back to `onEdgesChange`; `kind` is now emitted only for bindings, so it stays green) |
| Console | `npx vitest run src/features/workflow-studio src/features/agents src/features/dna-writing-styles src/shared/versioning` | `89 files · 758 tests passed` |
| Lint | `npx eslint <touched files>` in both packages | exit 0 |
| Typecheck | `pnpm --filter @arcaai/ui typecheck`, `pnpm --filter @arcaai/admin-console typecheck` | exit 0 / exit 0 |
| Build | `pnpm --filter @arcaai/ui build` (the console resolves `@arcaai/ui/components/workflow-canvas` to `dist`, so the running dev server only sees the canvas change after this build) | exit 0 |
| Runtime, tenant admin | headless Playwright on the Global tenant's `platform-default-summarization` (PUBLISHED, active) and on `/agents` | canvas renders BOTH edges — `e1` with `stroke-dasharray: 6, 4`, `data-kind="binding"`, label `context`; `e2` solid — node headers `Core.trigger · n_trigger` / `Core.agent · n_summary`, footer `3 nodes · 2 connections`; header **Integration** opens `POST /workflows/platform-default-summarization/runs` + snippet + API-keys link; the agent drawer's **Integration** tab shows `POST /agents/general-medicine-summarization/invocations` + `hope.agents.invoke` snippet + link |

Screenshots: `b-1-studio-canvas.png`, `b-2-studio-integration.png`, `b-3-agent-integration.png`.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-13 | Ticket opened. Runtime repro of the "cannot see published information" report as the seeded tenant admin; O-1…O-4 recorded; six investigation lanes dispatched. |
| 2026-09-13 | All six lanes returned; P1 claims re-verified against source and runtime (G2, G8, G9 probed); defect register §2.4 (77 findings), target UX §3.1, nine owner decisions §3.2, seven workstreams §3.3 and the route contract §3.4 written. Status → Review. |
| 2026-09-13 | Owner approved every §3.2 recommendation ("approve all recommendations, start WS-1"). **WS-1 delivered** (§4.1, §5.1): 12 console fixes, 6 new test files (22 cases, RED → GREEN), 743/743 feature tests, lint + typecheck + build green, tenant-admin runtime pass. Status → In Progress (WS-2 next: backend lineage API per §3.4). |
| 2026-09-13 | **WS-1 addendum** (§4.2, §5.2) on two owner reports: the persistent Integration surface pulled forward from WS-3/4/5 (`shared/versioning/IntegrationPanel`, agent drawer tab, studio header dialog, both publish dialogs on the same panel); root cause of the invisible trigger → agent connection on `Platform Default — Summarization` (the editor dropped every secondary-input binding edge before the canvas) fixed with a dashed, labelled, non-deletable `binding` edge kind in the shared canvas; authored node ids no longer sliced ("rigger"). 758/758 console tests, 63/63 canvas tests, lint/typecheck/build green, runtime pass. |
