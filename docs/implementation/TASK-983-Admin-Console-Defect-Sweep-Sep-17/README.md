# TASK-983 — Admin-console defect sweep (owner report of 2026-09-17)

| Field | Value |
|---|---|
| **Status** | Review — all nine lanes merged into `dev-2.2`, artifacts regenerated, gates green after the full merge (§5), live proof on the dev gateway; awaiting owner sign-off. Not pushed |
| **Type** | bugfix + UX + docs, cross-cutting: `apps/api`, `packages/applications`, `packages/database` (one data migration), `apps/admin-console`, `docs/guides` |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-09-17 |
| **Ticket number** | TASK-983 — next after TASK-982 (`docs/archive/**` is off-limits this sprint, so the archive was not checked; confirm, OD-0) |
| **Reported by** | Owner, 2026-09-17, a 13-item list (§1). Tested on the deployed `admin.taphuynh.dev` (recent deploy, **no data reset**) and the dev stack |

## 1. Requirement

The owner's list, verbatim in spirit, numbered here so every later section can point at an item:

| # | Report | Class |
|---|---|---|
| R1 | `/ai-models`: admin must refresh the page to see a model after registration | bugfix |
| R2 | No input field to configure the Sarvam provider | bugfix |
| R3 | Platform admin cannot change the Sarvam API key once a tenant admin configured it for their tenant; check every provider; BYO order is tenant (if any) → platform default (if any) → error | bugfix |
| R4 | Filter controls not working on `/ai-models`, `/dna-writing-styles`, `/consultations` | bugfix |
| R5 | Cannot approve any prompt template, even as super admin; related to seed data on the un-reset cluster? | bugfix |
| R6 | When a tenant admin creates a user they MUST assign a role, and the user is linked to the tenant automatically | feature |
| R7 | No admin can download bucket files: "Invalid file key: path traversal not allowed" | bugfix |
| R8 | Cannot define multiple protocols on an agent; unclear what the field means; socket still works after declaring only `http` | bugfix / decision |
| R9 | Integration guidance must cover socket use for workflows and transcription agents: input/output schema, connection protocol, auth, code samples | docs |
| R10 | `/prompt-templates?tab=governance`: whole content scrolls instead of just the list | UX |
| R11 | Drawers and dialogs are too small to read comfortably | UX |
| R12 | Agent management lists one row per version | UX (owned by TASK-965) |

Classification: **bugfix** program with two UX items and one docs item. One ticket, several lanes.

## 2. Current state (six read-only discovery lanes, sonnet tier, 2026-09-17; every claim below was file-verified by the lane and spot-checked by the orchestrator)

### 2.1 R1 + R4 — `/ai-models` list ignores every query param except page/limit (confirmed); DNA and consultations filters trace clean (unconfirmed report)

- `apps/api/src/modules/ai-model/ai-model-admin.controller.ts:123` — `list(@Query('page'), @Query('limit'))` and nothing else. `packages/applications/src/services/ai-model/aiModel.service.ts:592-600` hardcodes `sort: [{ name: 'asc' }]` and passes no search/filters. The console (`features/ai-models/components/ai-models-screen.tsx:107-108`) builds `search`, `searchFields=name,slug`, `filters`, `sort` through `useAdminGridParams` → all discarded silently (individual `@Query('x')` params, so no 400).
- Consequence for R1: the console's invalidation is correct (`features/ai-models/api/hooks.ts:45-48` invalidates `['ai-models']`, prefix-matching the list key; the BFF is `cache: 'no-store'`). After registration the refetch replays the admin's sort/filter/search, the server answers name-sorted page N regardless, so the new row lands off-screen. A refresh does not actually help either — the owner's "must refresh" is most likely "changed sort/filter/scrolled until it appeared". Confirm at runtime (§3.4 W0).
- TASK-973 lane 4 concluded "no change required — every search surface filters an UNPAGINATED endpoint"; that is wrong for this one endpoint, which is the paginated envelope the screen uses (`useModelsPaginated`).
- `/dna-writing-styles`: `dna-writing-style-admin.controller.ts:70-98` reads `tenantId` / `includeDisabled` / `doctorId`; `listReportsPaginated` (`dna-writing-style.service.ts:1203`) applies both and is unit-tested; e2e `dna-writing-styles.spec.ts:92-108` proves a bogus doctor id narrows to the empty state. There is **no free-text search box by design** (`globalSearch: false`, comment at `:36-39`), and the "Include disabled" toggle has no row-count assertion.
- `/consultations`: the screen calls `GET admin/consultations` (`admin-consultation.controller.ts:44-67`), which reads `patientId` / `doctorId` / `departmentId` / `status` and `listConsultationsForTenant` (`consultation.service.ts:1649-1701`) applies all four. TASK-973 FU-3 (params dropped) is about the clinician-facing `ConsultationController`, not this one. e2e proves doctor narrowing; the "Type" filter is page-only by documented design; the **Status** filter has no narrowing test at all; two e2e narrowing tests are vacuous (`rowCountAfter <= rowCountBefore`).
- Tests that would have caught R1/R4: `ai-models-screen.test.tsx:208-248` stubs every GET with `[]`; `ai-models.spec.ts` only asserts the search box is visible.

### 2.2 R2 + R3 — providers: the STT Sarvam card has no `baseUrl` field although the runtime requires one (confirmed); the platform-key block has no code cause yet (needs a live repro)

- R2 root cause: `apps/admin-console/src/features/ai-providers/components/provider-meta.ts:211-215` declares `stt:sarvam` with `fields: []` — the card can only hold the API key. But TASK-880 (`2e6f76ffc`) retired `stt.sarvam.baseUrl` and made `baseUrl` a per-row requirement: `apps/stt/src/stt/models/sarvam_loader.py:76-101` raises `CloudASRAuthError("Sarvam connection not configured … with its baseUrl set on the same row")` when either value is missing. That commit touched the seed and gateway constants, never the console. The SYSTEM row only works because the seed hand-sets `baseUrl: 'https://api.sarvam.ai'` (`17-ai-provider-connection.ts:516-523`, which itself warns the public API carries no BAA); a **tenant** BYO Sarvam STT row can never work, and nobody can point the platform row at an enterprise host. `tts:sarvam` (`provider-meta.ts:230-234`) and `stt:openai` (`:217-220`) DO carry the field; only `stt:sarvam` was left out — not a TASK-952 regression (that lane only removed the `model` extra).
- Compounding: `packages/applications/src/services/ai-provider-connection/provider-requirements.ts` (`PROVIDER_REQUIREMENTS`, ~120-165) has no `stt:sarvam` or `stt:openai` entry, so an incomplete row is accepted at write time (the file's own doc says an unlisted pair "requires nothing") and fails as a 503 in a Python worker at request time — the exact failure mode the file exists to prevent.
- R3: the lane traced the whole write path and found **no code dependency on a tenant row existing**: tier from the working tenant (`use-provider-scope.ts:85`), the BFF omits `x-tenant-id` when none is set (`hope-proxy.ts:34-36`), the console scopes writes by an explicit `?tenantId=` query (`api/client.ts:36`), `apps/api/src/shared/tenant-scope.ts:28-36` honours it for a super admin, `crossTenantLane` (`ai-provider-connection.service.ts:2084-2089`) uses the unscoped client for a SYSTEM write, `assertWriteAllowed` (`:2022-2033`) is role-only, and both unique indexes include `tenantId`. TASK-932 §6.2 claims this case passes. Ranked hypotheses for W0: (1) the working tenant was still set, so the admin was on the tenant tier while believing they were on the platform tier — nothing clears it automatically and the scope badge is the only tell; (2) an untested interleaving (tenant row first, then a SYSTEM edit) — no e2e covers it; (3) BFF caching. The lane refused to guess; the plan carries a W0 repro and an e2e for the interleaving regardless.
- R3 resolution order: `AiProviderConnectionService.cascadeRows` (`:1122-1219`) is the single implementation — tenant tier first → veto from the tenant DEFAULT row → `mayConsumePlatformDefault` entitlement gate → SYSTEM only then; all six injection call sites (agent resolver, TTS agent resolver, tenant STT config, text-request enrichment, harness internal, text-compat controller) go through `resolveTenantCloudOverrides` / `resolveCredential`. Python side: zero env API-key fallbacks in `apps/{text,tts,stt}` (locked by `test_task602_byok_credentials.py` and the two `test_task799_byok_credentials.py` mirrors); `apps/nlp` has no vendor credential plane by design; guardrail's SQL resolver is the documented exception. **No deviation found.** The one weakness is the write-time gap above: "throw error" happens at request time instead of at save.

### 2.3 R5 — approve is a silent no-op on seeded rows that are `APPROVED` with no pinned version (leading cause)

- `packages/database/src/prisma/db_main/seed/07-prompt-template.ts:20-46` documents that 16 seeded templates (3 ARCAAI, 13 Global) used to ship `status: APPROVED` with `approvedVersionNumber: null`. Commit `8de75bd2c` (TASK-890 BBJ2-7) fixed the **seed script only** and says "re-seed required". The one data migration that backfills a pin (`20260903120000_task_858_reown_system_catchall_soap/migration.sql:11-16`) covers exactly one hard-coded id. The deployed cluster was never reseeded (memory: a deploy never refreshes seed data), so the other 15 rows are still unpinned there.
- `packages/applications/src/services/prompt-management/prompt-management.service.ts:664-667` short-circuits on `template.status === 'APPROVED'` **before** the pin logic at `:691-735`, returning 200 with the row unchanged. The console then shows the green "Approved" badge next to the "not approved" pin badge (`features/prompt-templates/components/approval-pin.tsx:48-57`) and the admin's click "does nothing" — and clinically the template really is skipped by `PromptResolutionService`.
- Ruled out / low: the OD-3 split gate (`assertCanApprove`, `:1945-1957`) only 403s a non-super-admin; a stale JWT (`roles` baked at login, `jwt.strategy.ts:77`) would 403 and is cheap to rule out; the eval promotion gate reads unguarded by design and would 500 every approve; no recent NOT NULL migration on prompt tables. No unit test covers the idempotent branch.
- Runtime confirmation recipe (§3.4 W0): `GET admin/prompt-templates?status=APPROVED&limit=200` → rows with `approvedVersionNumber: null`; `POST admin/prompt-templates/:id/approve` with `If-Match` → 200, body unchanged = confirmed.

### 2.4 R6 — role is optional at every layer; a role-less user is an orphan

- `User` has no `tenantId` (`user.prisma:57-111`); tenancy lives on `UserRoleAssignment` (`@@unique([userId, roleId, tenantId])`) and `UserDepartment`. `assertUserBelongsToTenant` (`tenant-guards.ts` ~150) requires BOTH an enabled role assignment AND a department (service accounts exempt from the department half).
- `createUser.request.ts:42-50`: `roleId` and `departmentId` both `@IsOptional()`. `user.service.ts` `create()` (~132): `wantsMembership = Boolean(roleId || departmentId)`; when false the user is persisted with zero membership rows — excluded from `fetchAllByTenantId`, 404 on every `admin/users/:id/*` sub-route via `assertUserInScope`, and per the code's own comment cannot log in. When a role IS supplied, the existing `$transaction` creates User + role assignment (+ department) atomically with seat quota and three sys-events — the machinery exists, it is just optional.
- Console `features/users/components/create-user-dialog.tsx`: username, password, email, externalId, service-account switch — **no role or department field**; subtitle says "Roles and departments are assigned on the user detail". No test file for the dialog. No Zod schema in the feature.
- Precedent to copy: `ContextUserIdentityService` (TASK-950, `services/user/identity/context-user-identity.service.ts:336-563`) treats role AND department as mandatory, fail-closed, atomic.
- Policy seed already grants tenant admins `manage:User` + `manage:UserRoleAssignment` (`01-policy.ts:137,355`).

### 2.5 R7 — the legacy storage controller rejects any key containing `/`; every bucket path pattern contains `/`

- `apps/api/src/modules/storage/storage.controller.ts:222-224, 294-296, 309-311` (upload / getFileInfo = presign download / delete): `if (/[.]{2}|[/\\]/.test(fileKey)) throw new BadRequestException('Invalid file key: path traversal not allowed')`. Every system bucket's `pathPattern` is date-segmented (`TenantBucketFactory.ts:29-31,63`), so every real object fails. Listing has no validator, which is why only download is reported.
- The console (`features/storage-browser/api/client.ts:31`) encodes the key into one path segment; the BFF (`server/hope-proxy.ts:40-52`) correctly re-encodes; Express decodes `%2F` back to `/` in the param; the regex fires. The client file already carries a comment admitting nested keys "cannot be presigned/deleted through this surface".
- The sibling admin-plane service already has the right rule: `tenant-bucket.service.ts:812, 843, 874` rejects `..` only, with tests at `tenant-bucket.service.test.ts:773-795, 938-983` asserting `patients/2026/report-1.txt` succeeds. Never back-ported to `StorageController` (TASK-318 W2 regex, pinned by `storage.controller.task318-w2.test.ts:84-85` which lists `/etc/passwd` as a must-reject key — F-18).
- Object keys go straight to the S3/Azure SDK as strings; no `path.join` exists downstream, so `/` cannot escape a bucket. `..` and a leading `/` are the only shapes worth refusing.

### 2.6 R8 — `protocols` is not a field; it is a static per-task table that nothing enforces

- `packages/workflow-contract/src/agent-schemas.ts:78-86`: `AGENT_PROTOCOLS` keyed by `AgentTask` (STT `['http','socket']`, TEXT_GENERATION / TTS `['http','http-sse']`, NER `['http']`). No Prisma column, not on the create/update DTOs (`forbidNonWhitelisted` would reject it), derived in `agent.dto.mapper.ts:73-86` and frozen into `compiledConfig` at publish (`agent.service.ts:2450-2491`), duplicated in `seed/25-agents.ts:62-66`.
- Zero runtime reads: not in `agent.controller.ts` dispatch, not in `stt-ws.gateway.ts`. The one real mode refusal (NER `?mode=stream` → 400 `MODE_UNSUPPORTED`, `agent.controller.ts:474`) is hand-written. The console never renders it (zero hits under `features/agents`).
- Workflows are the mental model the owner expects: `workflow-schema-description.ts:73,99-113` derives protocols from the graph and `workflow-exposure.service.ts:78-82` refuses an undeclared mode with 400.

### 2.7 R9 — socket guidance: TASK-975 shipped the surfaces; two real gaps remain

- Shipped and verified in code (TASK-975, merged 2026-09-15, its §3.2 runtime pass still outstanding): `shared/docs/socket-snippets.ts` (Node / browser / websocat snippets for the workflow socket and realtime STT), a **Socket** tab on `IntegrationPanel` for workflows and SPEECH_TO_TEXT agents (`integration-panel.tsx:262-267, 291-320, 597-611, 779-793`), a WebSocket-surfaces table on `/developer/invoke` (`invoke-guide-screen.tsx:64-91, 368-441`), `hope.stt.*` / `RealtimeSttSocket` / `useWorkflowRun({transport:'socket'})` on `/developer/sdk`, both SDK READMEs.
- Gap 1 — **frame shapes** are documented in no user-facing surface: STT server→client `ready` / `transcript` / `status` / `error` / `resumed` / `resume_failed` and client→server `audio` / `metadata` / `stop` / `resume` / `close` (`stt-ws.gateway.ts:797-819, 1239-1323, 1334-1358, 1495-1520`); workflow socket `{event, id?, data}` with a snapshot first frame (`workflow-ws.gateway.ts:29-37, 94-97`). Auth per lane is documented correctly (JWT-only `POST auth/stream-ticket` vs API-key/service-account `POST workflows/:slug/runs/:runId/stream-ticket`; STT mints the ticket inline on `POST audio/transcription-jobs/stream/session`).
- Gap 2 — `docs/guides/client-integration-guide.md` §9 never mentions `transport: 'socket'`, the run stream-ticket route or `WorkflowRunSocketClient` (SSE only, `:592-643`).
- Gap 3 (TASK-975's own T8) — `socket-snippets.drift.test.ts` was never written; nothing pins the socket snippets to `SttResource` / `RealtimeSttSocket` / `useWorkflowRun` prototypes.
- The OpenAPI portal cannot host WS lanes (HTTP-route-derived); the workflow schema route already computes a live AsyncAPI fragment per tenant, so a static AsyncAPI page would drift. Precision note: `workflow-ws.gateway.ts:72` accepts `lastEventId`, so a fresh ticket + that param CAN resume; the "socket never resumes" copy means "no automatic reconnect".

### 2.8 R10 — governance tab is on `contentMode="scroll"` with a broken flex chain

- `features/prompt-templates/components/prompt-templates-screen.tsx:102`: `contentMode={tab === 'templates' ? 'fill' : 'scroll'}` → the ScreenTemplate becomes the single scroller for header + list + detail. `governance-tab.tsx:413` `<section className="flex min-h-0 flex-col gap-3">` and `:420` grid lack `flex-1`; `GovernanceList`'s `lg:h-full` Card (`:68`) and `overflow-y-auto` list (`:104`) are inert because no ancestor resolves a height; `TemplateGovernanceDetail` root (`:380`) has no scroll container. Exemplar: `/agents` (`agents-screen.tsx:262-263`, `fill` + grid).

### 2.9 R11 — the default drawer is 576px and most dense screens already worked around it

- `shared/detail/detail-drawer.tsx:26-30`: `md: 'md:max-w-xl'` (576px, the default), `lg: 'md:max-w-[40vw]'`, `xl: 'md:max-w-[56vw]'`. 33 call sites: 14 at `md` (9 implicit), 21 at `lg`, 2 at `xl`.
- `DialogContent` default `sm:max-w-lg` (576px). ~50 call sites: 4 bare default, ~28 `sm:max-w-md` confirms (correct per rule 11 §3), 10 `sm:max-w-lg` multi-field forms, 7 already on the rule-11 large convention (`h-[70vh] sm:max-w-[70vw]`), 7 ad-hoc widths (`40rem`, `46rem`, `36rem`, `640px`, `42rem`, `50vw`×3).
- No persisted/resizable width exists for drawers or dialogs; the only per-user layout precedent is `features/playground-consultation/hooks/use-column-layout.ts` (`useUserSettings`, not localStorage) + `@arcaai/ui` `ResizablePanelGroup`.

### 2.10 R12 — owned by TASK-965; WS-1 done, the grid rewrite is WS-2 + WS-4, both pending

- `AgentRepository.findAllForTenant` (`AgentRepository.ts:208-215`) returns every ENABLED version row ordered `slug asc, versionNumber desc`; `GET admin/agents` (`agent-admin.controller.ts:59-64`) takes only `task`; `agents-screen.tsx:113-152, 279` filters and pages the flat list. No `lineages` route exists yet anywhere.
- TASK-965 §3.2 OD-965-3 already approved the design (server-side `GET admin/agents/lineages`, one row per slug, contract pinned at its §3.4); WS-2 (backend, 2–3 days) → WS-3 (kit, 2 days, `IntegrationPanel` already pulled forward) → WS-4 (agents screen, 3 days). Nothing to re-plan — only sequencing (OD-9).

## 3. Design

### 3.1 Principles

1. Fix the cause the lane proved, not the symptom the owner saw; every fix has a RED test first.
2. Existing owners keep their scope: R12 executes under TASK-965, R9's gap 3 is TASK-975's T8. This ticket links, it does not duplicate.
3. Security-pinned tests are changed by owner decision only (R7's F-18).
4. Data healing ships as a migration, never as "click approve again" (R5).
5. Console-wide UX changes land once in the shared kit (`DetailDrawer`, a `dialogSize` map), never per feature.

### 3.2 Changes by area

| Item | Layer | Change | RED test |
|---|---|---|---|
| R1/R4 ai-models | `apps/api` + `packages/applications` | `AiModelAdminController.list` takes `@Query() query: PaginatedQuery` (search, searchFields, filters, sort, page, limit); `AiModelService.list` applies them through `withFormattedPaginatedProps` / the repository's standard filter formatting, keeping the SYSTEM-tenant scope; regenerate the five API artifacts | controller test: params forwarded; service test: search on `name`/`slug`, sort honoured; console `ai-models-screen.test.tsx`: second GET returns the new row and it renders |
| R4 dna / consultations | `apps/admin-console` e2e | Replace the two vacuous narrowing assertions in `consultations.spec.ts:122-149`; add a Status narrowing case; add an "Include disabled" row-count case to `dna-writing-styles.spec.ts`. Code fix only if W0's repro finds one (OD-3) | the new e2e cases |
| R2/R3 providers | `apps/admin-console` + `packages/applications` (+ `apps/api` e2e) | `provider-meta.ts`: add `{ name: 'baseUrl', label: 'Base URL', placeholder: 'https://api.sarvam.ai' }` to `stt:sarvam` (mirror `tts:sarvam`) and fix the comment above `STT_PROVIDERS`; `provider-requirements.ts`: add `stt:sarvam` and `stt:openai` entries requiring `baseUrl` + `apiKey` so an incomplete row is a 400 at save. R3: if W0 reproduces a real block, fix at the layer the captured response names; either way add the tenant-row-then-SYSTEM-edit e2e. Cascade order needs no change (§2.2) | `provider-meta.drift.test.ts`: `stt:sarvam` declares `baseUrl`; `provider-requirements.test.ts`: enabled `stt:sarvam` row without `baseUrl` refused; e2e in `task-958-provider-connections.spec.ts`: tenant creates `stt/sarvam`, super admin `PUT admin/providers/stt/sarvam?tenantId=SYSTEM` succeeds and reads back |
| R5 approve | `packages/applications` + `packages/database` | Idempotent short-circuit becomes `status === 'APPROVED' && approvedVersionNumber != null`; an unpinned APPROVED row falls through to the pin logic (self-heal). Data migration `task_983_pin_unpinned_approved_prompt_templates`: `UPDATE core."PromptTemplate" SET "approvedVersionNumber" = COALESCE("approvedVersionNumber", "currentVersionNumber", 1) WHERE status='APPROVED' AND "approvedVersionNumber" IS NULL` (authored against a shadow DB per rule 02) | service tests: unpinned APPROVED → pinned; pinned APPROVED → no writes |
| R6 users | `packages/applications` + `apps/admin-console` | Service-level rule in `UserService.create` (mirrors `ContextUserIdentityService`): a caller acting inside a tenant (CLS tenantId set) and not SUPER_ADMIN must supply `roleId` (400 `USER_ROLE_REQUIRED`), and — per OD-4 — `departmentId`; the existing atomic membership transaction is then the only path. Console create-user dialog gains a required Role select (tenant-assignable roles, SUPER_ADMIN excluded) and, per OD-4, a Department select; `valid` includes them; the service-account switch keeps its exemption | service test: tenant-admin create without role → 400; with role → user + assignment in one transaction; e2e `users-management-contract.spec.ts`: tenant admin omits role → 400; new `create-user-dialog.test.tsx` |
| R7 buckets | `apps/api` | Segment-aware guard shared by the three `StorageController` sites: reject any `..` segment, a leading `/`, and `\`; allow internal `/` (aligns with `tenant-bucket.service.ts`). Update F-18's `TRAVERSAL_KEYS` per OD-5, add positive nested-key cases | controller tests: nested key presigns; `../x`, `/etc/passwd`, `a\b` rejected; e2e same-tenant nested download 200 |
| R8 protocols | `packages/applications` + `packages/workflow-contract` + `packages/database` seed + SDK types | REMOVE (owner, OD-6): drop `protocols` from `agent-summary.response.ts`, `agent.dto.mapper.ts`, the `compile()` output in `agent.service.ts`, `seed/25-agents.ts`, `AGENT_PROTOCOLS`/`AgentProtocol` in `workflow-contract/src/agent-schemas.ts` (if nothing else consumes them), and the `AgentSummary` types in `@arcaai/vox` / `@arcaai/vox-node`; regenerate the five API artifacts; deprecation-register entry | mapper/service tests assert the key is absent; workflow-contract parity fixture updated; SDK type tests |
| R9 socket docs | `apps/admin-console` + `docs/guides` | Add a "Frame shapes" reference to the `/developer/invoke` WebSocket-surfaces card (one JSON example per event type, both lanes, auth column kept) and the same content as a section in `client-integration-guide.md` (§5 STT frames, new §9.x "Workflow run over WebSocket" with the ticket route, `transport: 'socket'`, resume note); write TASK-975's missing `socket-snippets.drift.test.ts` | drift test pins `SttResource` / `RealtimeSttSocket` / `useWorkflowRun` prototypes; `docs:check` green |
| R10 governance scroll | `apps/admin-console` | `prompt-templates-screen.tsx:102` → governance uses `fill`; `governance-tab.tsx:413/420` gain `flex-1`; detail column gets `min-h-0 overflow-y-auto` | `governance-tab.test.tsx` class-chain assertion + manual scroll proof |
| R11 sizes | `apps/admin-console` (+ `packages/ui` only if OD-7 picks a new Dialog default) | `DetailDrawer` scale per OD-7 (proposal: `md` 576 → `md:max-w-3xl` 768px, `lg` 40vw → 52vw, `xl` 56vw → 68vw, all `max-w-[calc(100vw-2rem)]` floor); new `shared/dialog/dialog-size.ts` map (small `sm:max-w-md`, medium `sm:max-w-[50vw]`, large `h-[70vh] sm:max-w-[70vw]`) and migrate the 10 `sm:max-w-lg` forms + 7 ad-hoc widths onto it; resizable drawer deferred unless OD-8 says now | `detail-drawer.test.tsx` size map; snapshot of the migrated call sites |
| R12 agents grid | TASK-965 | Execute WS-2 → WS-3 → WS-4 under TASK-965's own README (OD-9 for sequencing) | per TASK-965 §3.3 |

### 3.3 Lanes, tiers, order

Rule 14: one writer per worktree, disjoint files, the orchestrator owns merges, installs and the DB. Worktrees get `node_modules` by symlink, never `pnpm install` (memory: nested-worktree install corrupts the primary).

| Wave | Lane | Scope (files it owns) | Tier / effort | Depends on |
|---|---|---|---|---|
| W0 | Runtime confirmation (orchestrator, browser + BFF fetches on the dev stack; the cluster read-only) | R5 recipe; R1 repro with sort/filter state; R4 repro on DNA + consultations Status; R3 write path with a tenant row present | fable (orchestrator) | owner go |
| W1 | A — ai-models list params | `apps/api/src/modules/ai-model/**`, `packages/applications/src/services/ai-model/**`, console ai-models tests; artifacts regenerated by the orchestrator after merge | opus, low | — |
| W1 | B — providers (R2/R3) | `features/ai-providers/components/provider-meta.ts` + tests, `services/ai-provider-connection/provider-requirements.ts` + tests, the new interleaving e2e; any R3 code fix per W0 | opus, medium | W0 (R3) |
| W1 | C — approve self-heal + migration (R5) | `prompt-management.service.ts` + tests, one migration | sonnet, low (opus review of the migration SQL) | — |
| W1 | D — user create role/tenant (R6) | `services/user/user/**`, `features/users/components/create-user-dialog*`, users e2e | opus, medium | OD-4 |
| W1 | E — storage key guard (R7) | `apps/api/src/modules/storage/**`, storage e2e | sonnet, low | OD-5 |
| W1 | F — governance scroll + drawer/dialog sizes (R10/R11) | `features/prompt-templates/components/{prompt-templates-screen,governance-tab}.tsx`, `shared/detail/**`, `shared/dialog/**`, the migrated call sites | opus, low | OD-7/8 |
| W1 | G — socket docs + drift test (R9) | `features/developer-docs/**`, `shared/docs/__tests__/socket-snippets.drift.test.ts`, `docs/guides/client-integration-guide.md` | sonnet, medium | — |
| W1 | H — protocols removal (R8) | `services/agent/{agent-summary.response,agent.dto.mapper,agent.service}.ts` + tests, `workflow-contract/src/agent-schemas.ts`, `seed/25-agents.ts`, SDK `AgentSummary` types; artifacts regenerated by the orchestrator | sonnet, medium (opus review of the SDK surface) | — |
| W2 | I — dna/consultations filter fix if W0 finds one (R4) | per finding | sonnet | W0 |
| W3 | TASK-965 WS-2 → WS-3 → WS-4 (R12) | per TASK-965 | opus (its README's tiers) | OD-9 |
| Final | Orchestrator: merge, regenerate the five API artifacts, gates, runtime proof per item, README §5 | | fable | all |

Verify/judge stages stay at opus or above; discovery was sonnet (this section's evidence).

### 3.4 W0 — what the orchestrator checks before any lane writes

| Item | Check | Confirms |
|---|---|---|
| R5 | `GET admin/prompt-templates?status=APPROVED&limit=200` → count rows with `approvedVersionNumber: null`; `POST …/:id/approve` with `If-Match` → 200 and unchanged body | cause §2.3; also try a DRAFT row to rule out a universal blocker |
| R1 | Register a model while the grid holds a non-default sort or a filter; then clear sort/filter | §2.1 explanation of "must refresh" |
| R4 | On DNA: toggle "Include disabled" and read the row count; on consultations: set Status = SIGNED and read rows | whether a real defect exists beyond the ai-models one |
| R3 | First read the scope badge on `/ai-providers` (is a working tenant still set?); then, as super admin with NO working tenant, `PUT admin/providers/stt/sarvam?tenantId=<SYSTEM>` while a tenant `stt/sarvam` row exists; capture status + body; repeat for one text provider | §2.2 hypotheses 1–3 |
| R7 | Capture the failing download request URL from the network pane | §2.5 chain |

### 3.4a W0 results (orchestrator, 2026-09-17, dev gateway `localhost:8868` + read-only cluster checks)

| Item | Result | Consequence |
|---|---|---|
| R1/R4 ai-models | `GET admin/ai-models/list?limit=3&sort=name:desc` and `…&search=zzzz-no-such-model&searchFields=name,slug` return the same 33 rows in the same order as the bare call | §2.1 confirmed; lane A |
| R4 dna / consultations | `admin/dna-writing-styles?doctorId=no-such-doctor` → 0 of 7; `admin/consultations?departmentId=does-not-exist` → 0 of 8; `?status=SIGNED` → 0 (none signed); an invalid status is a 400 naming the enum | filters work at the API; the console traces clean (§2.1). Lane A hardens the e2e; a repro from the owner decides OD-3 |
| R3 providers | Tenant ARCAAI `PUT admin/providers/stt/sarvam?tenantId=<ARCAAI>` (If-Match "0") → 200; then super admin `PUT …?tenantId=<SYSTEM>` (If-Match "1") → 200, `keyVersion` 1, `_version` 2; the same with `x-tenant-id: <ARCAAI>` still set → 200 | no API defect; the block is console scope (§2.2 hypothesis 1) and, on the cluster, most likely the weak-ETag defect below. Lane B. Residue: the dev SYSTEM `stt/sarvam` row now holds a dummy key (`hasKey: true`, still `enabled: false`); the tenant row was deleted; `reset` is not offered for cloud providers |
| R5 approve | Cluster DB: 178 APPROVED rows, **all pinned**; the only non-approved rows are one DRAFT (Global "DNA Writing Style Analysis Prompt") and one PUBLISHED (ARCAAI "Radioly Report V2"). Dev: approving the DRAFT DNA template with `If-Match: "1"` → 200, APPROVED, pinned v3. Cluster gateway log: no `approve` request in 3 days — the click never left the browser. Through the ingress (`api.taphuynh.dev`): uncompressed GET → `etag: "1"`; browser-like (`accept-encoding: gzip`) → `etag: W/"1"` + `content-encoding: gzip`. The console discards weak validators (`shared/api/http.ts:157-158` → `etag: null`) and the governance tab disables Approve on a null etag (`governance-tab.tsx:353`) | **Root cause of R5 (and of every disabled/refused If-Match write in the deployed console): the compressing ingress weakens the ETag and the console throws it away.** Lane C: console normalises `W/"n"` → `"n"`; gateway adds `Cache-Control: no-transform` beside every ETag; the self-heal + migration stay as hardening. Seed hypothesis §2.3 ruled out for the cluster |
| R7 buckets | `GET storage/buckets/hope-recordings-arcaai/files/2026%2F09%2Ffile.wav` → 400 `Invalid file key: path traversal not allowed` | §2.5 confirmed; lane E |

Cluster access used: `psql` read-only SELECTs in `hope-postgres-0`, `kubectl logs` on the API pod, and the seeded super-admin login on `api.taphuynh.dev` for two GETs. Nothing on the cluster was written.

### 3.5 Decisions taken (owner may override)

| # | Decision | Why |
|---|---|---|
| D-1 | R1 and R4-ai-models are one defect and one lane | same endpoint, same missing params |
| D-2 | R5 ships both the runtime self-heal AND a data migration | the cluster is never reseeded; a migration heals every environment on deploy |
| D-3 | R6 is enforced in the service (fail-closed, like TASK-950's provisioning), with the console enforcing it a second time in the form | class-validator cannot see the caller's role; the service can |
| D-4 | R7 keeps `..`, leading `/` and `\` rejected; only internal `/` is allowed | matches the sibling service; keys never touch a filesystem |
| D-5 | R9 lands on the existing `/developer/invoke` surface and the client-integration guide, not a new page | TASK-975 chose the home; frame shapes are the missing content |
| D-6 | R11 is a scale bump in the shared kit plus a dialog-size map; feature files only change their size token | one place to tune later |
| D-7 | R12 is not re-planned here | TASK-965 §3.2 already has the owner-approved design |

### 3.6 Open decisions for the owner (OD)

| OD | Question | Recommendation |
|---|---|---|
| OD-0 | Ticket number TASK-983 (archive unchecked) | accept |
| OD-1 | R3: no code cause found (§2.2). Accept the W0 live repro as the gate, and accept that if the cause is "working tenant still set", the fix is a console affordance (a persistent "Acting on: ‹tenant› — clear" control on the providers screen) rather than a backend change | accept; the interleaving e2e is added either way |
| OD-2 | R2: should the platform SYSTEM Sarvam STT row's `baseUrl` be editable in the console (an enterprise / VPC Sarvam host), given the public `api.sarvam.ai` carries no BAA? | **yes**, editable on both tiers, with a card hint "Public api.sarvam.ai is not PHI-safe; use your enterprise endpoint" |
| OD-3 | R4 on DNA / consultations: the lanes found no code defect. If W0 reproduces nothing, is the complaint the **missing free-text search** on those two screens (by design today)? If yes: add server-side `search` on `admin/consultations` (patient name/id, doctor) and `admin/dna-writing-styles` (doctor) | ask for the exact filter; add the search boxes only on a yes |
| OD-4 | R6: role only, or role AND department mandatory? `assertUserBelongsToTenant` needs both, so a role-only user still cannot pass the tenant guard | **both** mandatory for a tenant-scoped human user; service accounts keep the department exemption; a super admin creating a tenant-less platform user keeps the no-membership path |
| OD-5 | R7: change the pinned F-18 test so `/etc/passwd` (leading `/`) stays rejected but `a/b/c.wav` is accepted | approve |
| OD-6 | R8: is `protocols` meant to be per-agent and enforced (option 3), or informational per task (option 1)? | **Owner, 2026-09-17: "remove it if it does not take any effect."** It takes no effect (§2.6), so lane H removes `protocols` from the agent summary response, the DTO mapper, the publish-time `compiledConfig`, the seed's copy and the SDK types; `AGENT_PROTOCOLS` in `@arcaai/workflow-contract` goes with it unless a parity fixture still names it; deprecation-register entry; five API artifacts regenerated |
| OD-7 | R11: new drawer scale. Proposal `md` 768px / `lg` 52vw / `xl` 68vw; dialog medium = 50vw | approve or name widths |
| OD-8 | R11: resizable, per-user-persisted drawer width now (reusing the playground column-layout pattern) or deferred | defer |
| OD-9 | R12: run TASK-965 WS-2/3/4 as W3 of this program (≈7–8 days) or as its own later cycle | W3 here, after W1 merges, since the IntegrationPanel and Socket tab work already sits on that screen |
| OD-10 | R9: complete TASK-975's outstanding §3.2 runtime pass inside lane G | yes, it is the same surfaces |

On **go**: W0 first (one session, ~1 h), then W1 lanes A–G in parallel worktrees, W2 after the ODs they depend on, W3 under TASK-965.

## 4. Implementation Summary

### 4.1 Lane E — storage object-key guard (R7) — merged `c790153d0`

`apps/api/src/modules/storage/object-key.guard.ts` (`assertSafeObjectKey`: rejects empty, `\`, a leading `/`, any `.`/`..` segment; allows internal `/`) replaces the three inline regexes in `storage.controller.ts`; F-18's traversal keys still reject; positive nested-key cases added; e2e `storage-cross-tenant.spec.ts` gained a same-tenant nested 200 case (unrun until the e2e pass). Primary re-run after merge: `vitest run src/modules/storage` → 5 files, 44 passed. Live on the watch-mode dev gateway: `GET storage/buckets/hope-recordings-arcaai/files/2026%2F09%2Ffile.wav` → 200 with a presigned URL (was 400).

### 4.2 Lane C — weak-ETag tolerance, `no-transform`, approve self-heal (R5) — merged `f8fdbfc99`

- `apps/admin-console/src/shared/api/http.ts`: `normalizeEtag` unwraps `W/"7"` → `"7"`; absent stays `null`. The BFF already forwards `etag` + `cache-control` down and `if-match` up (`hope-proxy.ts:11,16`). Console tests 31/31.
- `apps/api/src/interceptors/etag.interceptor.ts`: every ETag-carrying response also gets `Cache-Control: … no-transform` (merged with existing directives). Interceptor tests 29/29; e2e `task-776-response-parsing.spec.ts:92` updated to the new exact header. Live after merge: `GET admin/prompt-templates/:id` → `Cache-Control: private, no-cache, no-transform`, `ETag: "2"`.
- `prompt-management.service.ts`: an APPROVED row with `approvedVersionNumber == null` now falls through to the pin logic; 4 new tests, suite 267/267.
- Migration `20260917120000_task_983_pin_unpinned_approved_prompt_templates` (data-only). Shadow-DB proof (rule 02 recipe): ledger replayed → "All migrations have been successfully applied"; `prisma migrate diff --from-config-datasource --to-schema` → `-- This is an empty migration.`; shadow dropped.
- `@ExpectedVersion()` still rejects a weak `If-Match` with 400 on purpose: the fix is to stop the weakening, not to loosen the precondition.
### 4.3 Lane F — governance scroll, drawer scale, dialog size map (R10/R11) — merged `d03c6e7cd`

`prompt-templates-screen.tsx` puts the governance tab on `contentMode="fill"`; `governance-tab.tsx` completes the `min-h-0 flex-1` chain and gives the detail column its own `lg:overflow-y-auto` region (below `lg` the stacked grid is the single scroller). `DetailDrawer` scale: `md` 576 → 768px (`md:max-w-3xl`), `lg` 52vw, `xl` 68vw; mobile stays full-screen (pinned by a test). New `shared/dialog/dialog-size.ts` (`sm` / `md` 50vw / `lg` 70vh×70vw); 27 `DialogContent` call sites in 24 files migrated (call sites owned by lanes B/D and the agents feature listed in the lane report as follow-ups). Runtime on the worktree console, both themes, 1600×1000: list scrolls with heading/tabs/footer pinned; detail scrolls with the list unmoved; drawer 768px, dialog 800px; axe 0 violations (selected and unselected). Evidence `evidence/lane-F-*.png`. Also fixes `apps/admin-console/vitest.config.ts`'s importer-aware `@/` alias so `@arcaai/ui` resolves from the importer's own package root (needed in any worktree with symlinked `node_modules`).

### 4.4 Lane H — `protocols` removed (R8, OD-6) — merged `80efbdff1`

Removed from `AgentSummaryResponse`, `AgentDtoMapper.toSummary`, `AgentService.compile()`, `AgentCompiledConfig` (`@arcaai/types`), `AGENT_PROTOCOLS` / `AgentProtocol` (`@arcaai/workflow-contract`, no remaining consumer), the seed's copy, and `AgentSummary` in both SDKs; ~30 fixtures updated; deprecation-register entry under SDK. Old rows keep `compiledConfig.protocols` harmlessly (no strict validator; the harness mirror is `extra="ignore"`). Workflow `protocols` (enforced by `workflow-exposure`) untouched. The `AgentSummary` type change is an SDK contract change — release note needed at the next SDK version.

### 4.5 Lane A — `admin/ai-models/list` honours the grid query (R1/R4) — merged `98d3eb32d`

Controller binds one `@Query() query: PaginatedQuery`; the service applies `search`/`searchFields`/`filters`/`sort` through `withFormattedPaginatedProps` / `withFormattedCountProps` with the SYSTEM-tenant pin applied last; enum facets (`deploymentKind`, `availability`, `resourceStatus`) are member-validated → 400 instead of a Prisma 500; `isPlatformDefaultFor` / `languages` (list columns) deliberately not filterable. Behaviour changes: undeclared query params are now 400 (`forbidNonWhitelisted` finally applies) and an omitted `limit` defaults to 10 (the console always sends one; the regenerated vox-node admin area must be checked). Console regression pin: the registration test's refetch returns the new row. E2E narrowing assertions rewritten for ai-models, consultations (Status included) and DNA ("Include disabled").

### 4.6 Lane B — Sarvam STT endpoint + tenant-tier scope clarity (R2/R3, OD-1/OD-2) — merged `8b031d45e`

`provider-meta.ts`: `stt:sarvam` declares `baseUrl` with a card hint (public `api.sarvam.ai` carries no BAA); `stt:openai`'s label no longer says optional. `provider-requirements.ts`: `stt:sarvam` and `stt:openai` require `baseUrl` + `apiKey` on an ENABLED row (the seeded SYSTEM rows are disabled with `baseUrl` set, so they pass). Console: on the tenant tier an elevated caller sees a `ProviderScopeNotice` ("Editing ‹tenant› connections — platform defaults are edited with no working tenant") with a clear-working-tenant action, and every tenant-tier default card shows "Platform default: key set · enabled / no key / vetoed" (presence only, never a value). New e2e case: tenant row exists → super admin edits the SYSTEM row → 200, `keyVersion` increments. Live screenshot shows the SYSTEM `stt/sarvam` row "Off · key configured · v1" — the key was always writable; the tier was unreadable. Evidence `evidence/lane-B-*.png`. Follow-ups: the shell's global working-tenant banner and the in-page notice stack; `useSessionAction` is duplicated because the shell keeps it private.

### 4.7 Lane G — socket frame shapes, guide, drift test (R9, OD-10) — merged `213ff6ca1`

`/developer/invoke`'s WebSocket-surfaces card gains a ticket-route / credential-class column, literal client→server and server→client frame examples for `/ws/stt/stream` and `/ws/workflows`, the binary-frame format and the resume semantics (STT `resume`; the workflow socket accepts `lastEventId` but has no automatic reconnect). `client-integration-guide.md` §5 gains the STT frames; new §9 subsection "Workflow run over WebSocket". TASK-975's missing T8 `socket-snippets.drift.test.ts` written — and it caught a real bug: the STT Node snippet called `socket.send`, which `RealtimeSttSocket` does not expose (`sendPcm16` does). `docs:check` OK (19 SDK calls verified). TASK-975 §3.2 runtime pass performed on the worktree console (Socket tab on the STT agent and on a workflow, `/developer/invoke`, `/developer/sdk`) and closed in its README; screenshots could not be saved from that lane's browser, so the pass is recorded in prose.



### 4.8 Lane D — mandatory tenant membership on create (R6, OD-4) — merged `412a67252`

`UserService.create` gains `assertTenantMembershipSupplied()`: with a CLS tenant set, `roleId` is required (400 `USER_ROLE_REQUIRED`) and, for a human user, `departmentId` too (400 `USER_DEPARTMENT_REQUIRED`); service accounts keep the department exemption; a tenant-less super-admin create is unchanged; the path also gained the `SUPER_ADMIN` tier guard (403). The create-user dialog collects Role and Department (required, labelled, service-account switch relaxes department) through the existing catalog hooks; copy fixed; new dialog test; three e2e contract cases. Live on the worktree console as `tenant_admin`: submit disabled until both are chosen, `POST admin/users` → 201, the role assignment and department read back (evidence `evidence/lane-D-*.png`). Note: a super admin WITH a working tenant is held to the same rule (only the tenant-less create is exempt) — the plan's §3.2 wording said "not SUPER_ADMIN"; the brief and OD-4 said tenant-scoped, and that is what shipped.

### 4.9 After the merges (orchestrator)

- `@arcaai/types`, `workflow-contract`, `applications`, `vox-node`, `vox` rebuilt in the primary; the watch-mode gateway restarted by touching `apps/api/src/main.ts`.
- The five API artifacts regenerated in a separate worktree (`task-983/M`, merged `53496b5fe`): `openapi.json`, `route-manifest.json` (unchanged), the two portal documents, `packages/vox-node/src/resources/admin/{ai-model,schemas}.ts`. `api:openapi:check` OK, `api:portal:check` no drift (668 admin / 202 business ops), `gen:admin:check` no drift (49 areas, 426 routes, 444 schemas). The ai-models list handler's JSDoc was reworded first (`a7f038c45`) because the SDK codegen lifts it into the generated docstring.
- Two post-merge test fixes: lane B's new e2e asserted `keyVersion` increments on a platform key change, but `keyVersion` is the Vault Transit key version (stays 1 across rotations) — it now asserts the row version moved (`a25693ec3`'s sibling commit); two pre-existing `invoke-guide-screen` tests used single-match `getByText` on phrases lane G's frame-shape reference now repeats — switched to `getAllByText` (`a25693ec3`).
- Dev residue: the dev SYSTEM `stt/sarvam` row carries a dummy key from W0 and the e2e (enabled stays `false`); lane D's test user was soft-deleted; the platform `rate-limit.enabled` setting was switched off for the e2e runs and restored afterwards (§5).
- Worktrees `../hope-v2-983-{A..H,M}` removed and their branches deleted after every branch was confirmed an ancestor of `dev-2.2`.

### 4.10 Owner check on the local console (R9 follow-up) — `e74fe599f`

The owner tested locally and found no socket instructions for a realtime ASR agent. Captured on the dev console (`evidence/owner-check-*.png`): the guidance existed, but the agent's Integration tab opened on the **Node** lane with the batch `transcribe` call and a `POST …/transcriptions` endpoint line, so the socket setup sat one click away behind the wrong endpoint. For `SPEECH_TO_TEXT` the Socket lane now comes first and opens selected, and the header names the realtime session route (`POST /audio/transcription-jobs/stream/session` → `/ws/stt/stream?sessionId&ticket`) before the batch route. Panel test 46/46; lint and tsc clean on the two files; captured live as `owner-check-agent-integration-socket-first.png`.

Note on commit ids: a peer session rewrote every commit of this ticket on `dev-2.2` (identical trees, new SHAs, trailers stripped) and added two commits of its own (`5a53e82eb`, `cc83b699d`); the SHAs quoted in §4.1–4.9 are the pre-rewrite ones. `git log --grep task-983` finds the current ones.

Dev-stack incident, 2026-09-17 17:14: the gateway received a SIGTERM and stt/text/guardrail/nlp/harness died while the console I had restarted stayed up; the supervisor's exit trap only kills what it spawned, so the cause is outside this session. Recovered with `pnpm stack:dev -- api stt text guardrail nlp harness` after clearing the stale pid files; all six healthy within 25 s.

### 4.11 Owner requirement: the manual (no-SDK) socket path — `45797581a`

"The integration guidance must make clear that a developer who does not use the SDK will call the API and set up the socket manually." The STT Socket lane now opens with a "Without the SDK" section BEFORE any SDK sample: the four steps (open the session on an API key → open `/ws/stt/stream?sessionId&ticket` → stream PCM16 LE mono binary frames and read `transcript` frames → `stop`, and refresh-ticket + `resume` on reconnect), a table of every frame in both directions with a literal JSON example and its meaning (`ready`, binary audio, `audio`, `metadata`, `transcript`, `status`, `error`, `stop`, `resume`, `resumed`, `resume_failed`, `close`), a curl + websocat walkthrough, and a `fetch` + `WebSocket` sample with no SDK import. Data module `shared/docs/stt-socket-protocol.ts` (sourced from `transcription-job.controller.ts`, `stt-ws.gateway.ts`, `packages/vox-node/src/types/stt.ts`), pinned by `stt-socket-protocol.test.ts` (frames parse, both directions covered, snippets name the real routes and import no SDK). Panel + protocol tests 50/50; lint and tsc clean. Evidence `evidence/owner-check-socket-lane-*.png`.

### 4.12 Guidance followed by hand on the dev gateway (owner: "test locally first; guidance must be ABSOLUTELY correct and easy to follow")

Done as a developer would, with curl, plain `fetch` + `WebSocket` (Node 24), then the built `@arcaai/vox-node`, and an API key only. Scripts: `scratchpad/manual-stt.mjs`, `scratchpad/sdk-check.mjs` (session-local).

| Path | Result | Guidance defects found (fed to lanes I / J) |
|---|---|---|
| Realtime STT, no SDK | ✅ `POST audio/transcription-jobs/stream/session` → 201; `ready`; 22 s of binary PCM16; connection dropped at half-time; `refresh-ticket` → `resume` → `resumed { fromSeq: 6 }`; `stop` → `status: finalizing` → final transcript → `status: closed` | response `status` is `active` (example said `created`); a `finalizing` status frame exists; `websocat` is not installed here, so the fetch + WebSocket sample is the runnable one |
| Realtime STT, `@arcaai/vox-node` | ✅ `createStreamSession` → `socket(session)` → `connect()` / `sendPcm16()` / `stop()` / `close()`; finals + `finalizing`/`closed` | method names must match exactly in the snippet |
| Batch STT, no SDK | ✅ `POST audio/transcription-jobs/transcribe` multipart → 201 `{ id, status: QUEUED, sseUrl, audioUri, agentSlug, agentVersionId }`; `curl -N <sseUrl>` → `progress`×4, `transcript` (`data.data.text`, timings, word timestamps), `status COMPLETED` in 13 s; `GET …/{id}` → `resultText` | curl must send `-F "file=@x.wav;type=audio/wav"` (otherwise 400 `Unsupported audio type: application/octet-stream`); `POST agents/{slug}/transcriptions` is `{ mediaId }` only (400 on multipart, 404 on an unknown id) and there is no standalone media upload route — it is the second form, not the first; the finished text lives in `resultText` |
| Batch STT, `@arcaai/vox-node` | ❌ `hope.agents.transcribe(slug, { file })` → 400 "`mediaId` is required" — the SDK posts the multipart to the agent route | **SDK bug** (lane J): upload through `/audio/transcription-jobs/transcribe` with `agentSlug`, as the browser SDK already does |
| Text generation, blocking + SSE | ✅ on `medical-ner` (`{ text }` → 200, `output.entities`); ❌ on `general-medicine-summarization`: 400 "instruction references `trigger.context.language`…", then `safe_age`, … — nine `trigger.context.*` placeholders, revealed one per call; `GET agents/{slug}` does not list them | lane J: `requiredVariables` on the agent summary + one 400 naming every missing placeholder (`PROMPT_VARIABLES_MISSING`); lane I: derive bodies from `inputSchema` and render `variables` in full |
| API keys | a key minted by the tenant-less super admin answers 401 on every business route (bound to a human with no membership in the tenant); the seeded test key lacks `agent:invocation:write` | every lane names its exact scopes (`stt:transcription:write`, `agent:invocation:write`, …) and says to mint the key as a tenant user |

### 4.13 Lanes I and J — integration guidance by job; `requiredVariables`; the SDK fixes — merged `d0bb740c9`, `bfd123cb2`, `608272da5`

- **Lane I** (`apps/admin-console`): the agent half of `IntegrationPanel` is now four lanes — **Node** (`@arcaai/vox-node`), **Browser** (`@arcaai/vox`), **Manual** (HTTP + Socket merged), **Postman** — each organised as **Batch** / **Realtime** (Blocking / Realtime (SSE) for text generation; NER has no realtime view). New data modules `shared/docs/{gateway-scopes,batch-job-protocol,sse-frame-protocol}.ts` (routes, frames, scopes with file:line sources and tests that parse every example and cross-check every path against `route-manifest.json`); every lane names the exact API-key scope its requests need and says to mint the key as a tenant user; the Postman collection carries the multipart upload, the mediaId form, the job GET, the SSE progress, the stream session and refresh-ticket requests with the WebSocket handshake in the descriptions; `client-integration-guide.md` gained the batch job. Drift tests pin every printed SDK call to the real prototypes and option keys; `socket.stop()` (a deprecated alias whose old comment was wrong) is refused in favour of `finalize()`. Evidence `evidence/lane-I-*.png`.
- **Lane J** (`workflow-contract`, `types`, `applications`, both SDKs): `collectPlaceholders` / `requiredPromptVariables` / `unresolvedPromptVariables` in the grammar; `compile()` freezes `requiredVariables`; `GET /agents/{slug}` lists them (legacy rows recomputed from `resolvedPrompt`); one `400 PROMPT_VARIABLES_MISSING` with `missingVariables` + `suppliedUnder` — the seeded agents BIND their nine `trigger.context.*` paths (`seed/25-agents.ts:338-349`) and the eager binding resolution used to fire first, so the fix splits resolvable from unresolvable bindings before the diff. `hope.agents.transcribe(slug, { file })` now uploads through `/audio/transcription-jobs/transcribe` with `agentSlug`; new `hope.agents.transcriptionJob` / `subscribeTranscription` / `waitForTranscription` (resolves on COMPLETED | FAILED | CANCELLED | DEAD); `AgentSummary.requiredVariables` in both SDK type sets. Known gap: the draft bench still reports bindings one at a time.
- Post-merge: `agent-publish-dialog.task890.test.tsx` adapted to the job-first panel (`f2e721256`); the five API artifacts regenerated in a throwaway worktree (`829b72e6f`; +5 admin ops from WS-2, `requiredVariables` on the summary; all three drift checks clean).

### 4.14 Guidance re-followed on the final tree (2026-09-17, dev gateway)

| Path | Result |
|---|---|
| Realtime STT, no SDK (`manual-stt.mjs`) | ✅ ready → binary PCM → drop → refresh-ticket → `resumed { fromSeq: 5 }` → stop → `finalizing` → final → `closed` |
| `@arcaai/vox-node`: `invoke('medical-ner')` | ✅ 200, `output.entities` |
| `@arcaai/vox-node`: `transcribe(slug, { file })` → `waitForTranscription` | ✅ 201 QUEUED → COMPLETED in 26 s, `resultText` read |
| `@arcaai/vox-node`: `createStreamSession` → `socket().connect()` / `sendPcm16` / `stop` | ✅ finals, `finalizing`, `closed` |
| `GET /agents/general-medicine-summarization` | ✅ `requiredVariables` = the nine `trigger.context.*` paths |
| `POST …/invocations` `{ text }` | ✅ ONE 400 `PROMPT_VARIABLES_MISSING` naming all nine with `suppliedUnder: context` |
| `POST …/invocations` with all nine | ❌ 502 — environmental: the dev SYSTEM `llm/lm-studio` row carried the cluster hostname `hope-lmstudio:1234` (set to `127.0.0.1:1234/v1` here) and the restarted text service still reports "Connection error" to LM Studio while curl and the arcaenv Python reach it; the text service's provider URL comes from a plane I could not read without its service token. Needs the owner's look; not a guidance defect |

## 5. Verification

Owner rule (2026-09-17): no gating tests until everything is merged into `dev-2.2`. One full pass after the last merge, in the primary checkout (`scratchpad/gates.log`):

| Gate | Result |
|---|---|
| `@arcaai/workflow-contract test` | 55 files, 961 passed |
| `@arcaai/database test` | 92 files, 1835 passed |
| `@arcaai/applications test` | 892 files passed, **1 file failed**: `agentPromotion/__tests__/integration/membership-bounded-sync.integration.test.ts` — `PrismaClientKnownRequestError` in its `beforeAll`/`afterAll` against a live test DB that is not up (test infra on 5433); reproduced alone; pre-existing and unrelated (all three lanes that ran the suite saw the same file). 14326 tests passed, 10 skipped, 0 failed |
| `@arcaai/applications lint` / `typecheck` | exit 0 / exit 0 |
| `@arcaai/api test` / `lint` / `typecheck` | exit 0 / 0 / 0 |
| `@arcaai/vox-node test` / `typecheck` | exit 0 / 0 |
| `@arcaai/vox test` / `typecheck` | exit 0 / 0 |
| `@arcaai/admin-console test` | 354 files passed, 1 failed (2 tests, the `invoke-guide-screen` multi-match queries) → fixed in `a25693ec3`; `developer-docs` re-run 5 files / 51 passed; full suite 3388 + 2 passed |
| `@arcaai/admin-console lint` / `typecheck` | exit 0 / exit 0 |
| Artifact checks | `api:openapi:check` OK; `api:portal:check` no drift; `gen:admin:check` no drift |
| Migration | shadow DB: ledger replayed, `migrate diff` → `-- This is an empty migration.` |
| API e2e against the dev gateway (`SKIP_DB_PRECHECK=true RESET_DB=false API_URL=http://localhost:8868/api/v1`, rate limit off) | `storage-cross-tenant`, `task-958-provider-connections`, `users-management-contract`, `task-776-response-parsing`: 60 passed + 1 failed → assertion corrected → `task-958-provider-connections` 12/12 |
| Console e2e (`ai-models`, `consultations`, `dna-writing-styles` against the dev console on 5176, `API_URL=http://127.0.0.1:8868`) | 29/31 on the first complete run; the two `ai-models` failures were pre-existing selector drift (the Task field label, the discovery drawer's button and title, the Retire action — all renamed by earlier tickets, none touched by lane A) → selectors updated → `ai-models` 9/9; consultations 13/13 and DNA 9/9 including the new Status / doctor / department / include-disabled narrowing cases |

Live proof on the dev gateway (watch mode, after the merges):

| Item | Evidence |
|---|---|
| R7 | `GET storage/buckets/hope-recordings-arcaai/files/2026%2F09%2Ffile.wav` → 200 `{ key: "2026/09/file.wav", url: "http://localhost:9000/…X-Amz-Signature=…" }` |
| R5 | `GET admin/prompt-templates/:id` → `Cache-Control: private, no-cache, no-transform`, `ETag: "2"`; approving the DRAFT DNA template → APPROVED, pinned v3 |
| R6 | `tenant_admin` `POST admin/users` without role → 400 `USER_ROLE_REQUIRED`; with role, no department → 400 `USER_DEPARTMENT_REQUIRED` |
| R1/R4 | `admin/ai-models/list?limit=3&sort=name:desc` → reversed order; `…&search=zzzz-no-such-model&searchFields=name,slug` → total 0; `…&bogus=1` → 400 Validation error |
| R3 | tenant `stt/sarvam` row present → super admin `PUT …?tenantId=SYSTEM` → 200 (W0), e2e case 31 green |
| R2, R10, R11, R9 | screenshots under `evidence/lane-{B,D,F}-*.png` from the lane consoles; lane G's pass recorded in prose in the TASK-975 README |


### 5.1 Second full gate pass — after lanes I, J, TASK-965 WS-2/3/4 and the artifact regeneration (`scratchpad/gates2.log`)

| Gate | Result |
|---|---|
| `@arcaai/workflow-contract test`, `@arcaai/database test` | exit 0 |
| `@arcaai/applications test` | 14367 passed, 10 skipped, **0 failed tests**; the same 1 file needs the live test DB (`membership-bounded-sync.integration.test.ts`, reproduced alone) |
| `@arcaai/applications lint` / `typecheck` | exit 0 / 0 |
| `@arcaai/api test` / `typecheck` | exit 0 / 0; `lint` had 1 prettier error in WS-2's controller → fixed `a5dc31322` |
| `@arcaai/vox-node test` / `typecheck`, `@arcaai/vox test` / `typecheck` | exit 0 |
| `@arcaai/admin-console test` | 3573 passed, 2 failed in workflow-studio tests that queried a single vox-node group (the Node lane is now per job) → relaxed `571d3ca58`, both files 39/39; `lint` / `typecheck` exit 0 |
| Artifact drift checks | `api:openapi:check` OK; `api:portal:check` no drift (673 admin / 202 business ops); `gen:admin:check` no drift (49 areas, 431 routes, 456 schemas) |

## Change History

| Date | Change |
|---|---|
| 2026-09-17 | Ticket opened; six discovery lanes (sonnet, read-only, no worktrees) returned; plan written with §3.5 decisions and §3.6 ODs; status Pending — awaiting owner go |
| 2026-09-17 | Owner: "R8: remove it if it does not take any effect; for the rest, approve recommendations, go." OD-0..OD-10 closed as recommended, OD-6 → removal. Status In Progress; W0 started |
| 2026-09-17 | Second gate pass green (§5.1) after two test relaxations and one prettier fix; status stays Review — awaiting owner sign-off; not pushed |
| 2026-09-17 | Lanes I and J merged (§4.13), TASK-965 WS-4 merged (agents grid one row per lineage, `969c85b0f`), artifacts regenerated (`829b72e6f`), guidance re-followed on the final tree (§4.14); five worktrees removed |
| 2026-09-17 | Owner: batch vs realtime guidance for both SDKs and a merged Manual (HTTP + Socket) lane, Postman must drive both — lane I spawned; guidance followed by hand (§4.12): 5 defects found, lane J spawned for `requiredVariables`, the all-at-once 400 and the vox-node upload bug; TASK-965 WS-2 merged (`3249b7823`), `hidden` added to lineage rows, WS-4 spawned |
| 2026-09-17 | Owner: the guidance must cover the manual, no-SDK socket setup — §4.11 added to the Socket lane. TASK-965 WS-3 merged (`f6ed13d2d`) |
| 2026-09-17 | Owner check: socket guidance moved to the front of a speech-to-text agent's Integration tab (§4.10); TASK-965 WS-2 and WS-3 lanes spawned for the duplicate-version rows (R12) |
| 2026-09-17 | Console e2e: the owner's `next dev` on 5176 had died (no crash trace; the box was under gate + lane-server load) and, restarted, served a stale Turbopack dev cache that never hydrated the login form (two HMR-client chunk hashes) — restarted again with `.next` cleared via `pnpm stack:dev -- admin`; the three specs then ran; two stale `ai-models` selectors fixed; leftover e2e model rows retired; `rate-limit.enabled` restored to `true` |
| 2026-09-17 | Lane D merged (§4.8); artifacts regenerated in worktree M and merged (§4.9); single gate pass green (§5); two post-merge test fixes; API e2e subset green; worktrees removed; status Review |
| 2026-09-17 | Owner: "do NOT run any gating tests until things are merged completely to dev-2.2" — relayed to the running lanes; per-merge suite runs stopped; one gate pass after the last merge. Lanes F, H, A, B, G merged (§4.3–4.7); types, workflow-contract, applications, vox-node, vox rebuilt in the primary after H |
| 2026-09-17 | Lanes E and C merged into `dev-2.2` (§4.1, §4.2); applications rebuilt in the primary, watch API restarted, R7 and the `no-transform` header proven live; migration proven on a shadow DB |
| 2026-09-17 | W0 done (§3.4a): R5's live cause is the ingress weakening ETags + the console discarding weak validators, not seed data; lane C re-briefed. Eight worktrees `../hope-v2-983-{A..H}` (branches `task-983/<lane>`, node_modules + dist by symlink) spawned: A/B/C/D/F opus, E/G/H sonnet |
