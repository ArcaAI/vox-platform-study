# TASK-760 — Business-Plane URI Normalization

| | |
|---|---|
| **Status** | Pending |
| **Owner** | Platform / Architecture |
| **Date** | 2026-08-18 |
| **Type** | refactor (breaking wire change) |
| **Source** | `docs/architecture/api-design-conformance-review.md` §2.6 (finding) and §3.5 (recommendation) |
| **Evidence base** | `docs/architecture/api-controller-inventory.md` (re-verified against source 2026-08-18), `docs/architecture/api-controller-groupings.md` |
| **Related tickets** | TASK-754 / TASK-755 (WebSocket owner binding, review §2.1/§3.4), TASK-757 (admin plane ⇒ JWT-only, review §3.1), TASK-758 (business plane A1 exemption list, review §3.3), TASK-759 (`/internal/*` posture + `SttInternalController` carve-out, review §3.2), **TASK-761 (mechanical conformance gates, review §3.6)**. Precedent for the mechanics: TASK-707 (naming alignment), whose route-rename regression suite is `apps/api/src/__tests__/controller-route-renames.test.ts`. |
| **Sequencing** | **LAST of the review's batch — order 7 of 8 in `api-design-conformance-review.md` §4.** See §"Why this goes last" below. |

> **Scope fence.** Compat surfaces are **explicitly out of scope**: `TextCompatController`
> (`api/smr/api/v1`, `apps/api/src/modules/text-compat/text-compat.controller.ts:166`),
> `SttCompatController` (`api/stt`, `apps/api/src/modules/stt-compat/stt-compat.controller.ts:61`),
> and `SttCompatGateway` (`ws /stt`, `apps/api/src/modules/stt-compat/stt-compat.gateway.ts:31`).
> They are frozen wire contracts with a dedicated deprecation ticket (review rule **A3**, §4 order 8).
> No route under those three prefixes may be touched by this ticket, and no redirect may be added to them.

---

## 1. Requirement Analysis

### 1.1 What is being asked

The four plane rules under review (P1/P2/P3, A1/A2) say nothing about the *shape* of a URI once
the plane is right. Once the planes are separated, the business plane's shape drift becomes
visible and is itself a defect class: it makes the API unpredictable for SDK authors and external
integrators, and it is the only category in the review with **no** security or correctness
consequence — purely coherence.

Five drift categories, all verified against live `@Controller(...)` prefixes (evidence in §2):

| # | Drift | Verified instances |
|---|---|---|
| D-A | Singular/plural mixed | `user/me/*` vs `users/:id/roles` vs `users/password-reset`; `tenant` vs `admin/tenants`; `voice-profile` (singular) vs `dna-writing-styles` (plural) |
| D-B | "Mine" has three competing shapes | bare (`billing`, `usage`, `entitlements`, `tenant`), `user/me/*`, `tenant/me/context-schema` |
| D-C | Verb-as-resource | `rbac/check` — RPC, not a resource |
| D-D | Service-named prefixes leak internal topology | `ai` (`AiInferenceController`), `text` (`TextProxyController`), `speech` (`SpeechProxyController`) |
| D-E | Misleading class name | `AudioPipelinePublicController` is JWT-only + `@ForbidApiKey()`, **not** `@Public()` |

### 1.2 Target state (review §3.5)

- Plural resource collections.
- A single self alias — `/users/me/**` — replacing the singular `user/me/*` and the bare
  `billing` / `usage` / `entitlements` / `tenant` "mine" surfaces. **See decision D-1: the bare
  three are tenant-scoped, not user-scoped, so a literal reading of this bullet is semantically
  wrong and needs an owner ruling before any code moves.**
- `rbac/check` replaced with a resource form (e.g. `POST /users/me/permission-checks`).
- Capability prefixes renamed off internal service names.
- `AudioPipelinePublicController` renamed (class only — its path does not change).
- Retired paths keep a redirect for one release, with a comment naming the release in which the
  redirect is deleted (the existing convention, stated for Next.js routes in
  `.claude/rules/13-nextjs-apps.md` §Routing and adopted here for gateway routes).

### 1.3 The non-negotiable constraint

**Every rename in this ticket is a BREAKING CHANGE for the SDK and for external consumers.**
`@arcaai/vox` publishes these paths as its endpoint constants and its README documents the
credential paths that reach them; the SDK family is versioned in lockstep (rule
`.claude/rules/08-vox-sdk.md`), so any path change ships as a MAJOR of the SDK family, not a patch.
The blast radius is enumerated per rename in §2.3 and the lockstep change list in §3.

### 1.4 Explicit non-goals

- No change to auth model, scopes, guards, or CASL subjects. That is TASK-757 / TASK-758.
- No change to `/admin/*` or `/internal/*` prefixes. `MonitoringController` →
  `admin/monitoring` and `health/services` → `admin/health/services` belong to review §2.5
  (order 5), not here.
- No compat-surface change (see the scope fence above).
- No new resources, no DTO changes, no response-shape changes. A route that moves must move
  byte-identically in request and response.

---

## 2. Current State Evaluation

All prefixes below were read directly from source on 2026-08-18 (`grep -rn "@Controller(" apps/api/src`)
and cross-checked against the inventory's summary table.

### 2.1 The drift, with file:line evidence

#### D-A — singular/plural mixed

| Path | Controller | Evidence |
|---|---|---|
| `user/me/preferences` | `UserPreferencesController` | `apps/api/src/modules/user/controllers/user-preferences.controller.ts:12` |
| `user/me/settings` | `UserSettingsController` | `apps/api/src/modules/user/controllers/user-settings.controller.ts:29` |
| `user/me/departments` | `UserDepartmentsMeController` | `apps/api/src/modules/user/controllers/user-departments-me.controller.ts:16` |
| `users` (+ `@Get(':id/roles')`) | `UserRolesController` | `apps/api/src/modules/user/controllers/user-roles.controller.ts:23`, route at `:41` |
| `users/password-reset` | `PasswordResetController` | `apps/api/src/modules/user/controllers/password-reset.controller.ts:15` |
| `tenant` | `MyTenantController` | `apps/api/src/modules/tenant/my-tenant.controller.ts:21` |
| `admin/tenants` | `TenantController` | `apps/api/src/modules/tenant/tenant.controller.ts:48` |
| `voice-profile` (singular) | `VoiceProfileController` | `apps/api/src/modules/voice-profile/voice-profile.controller.ts:30` |
| `dna-writing-styles` (plural) | `DnaWritingStyleController` | `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts:52` |

Note the sub-finding the review does not state: **`users` is already a plural collection hosting
`:id/roles`**, and `users/password-reset` is a *separate* controller mounted at a literal segment
under the same collection. Adding `/users/me/**` therefore collides with the existing `:id`
parameter route — `GET /users/me/roles` would match `UserRolesController`'s `@Get(':id/roles')`
with `id === 'me'`. This is a real implementation hazard, handled in §3 step 1.

#### D-B — three "mine" shapes

| Shape | Path | Controller | Evidence | Scope of "me" |
|---|---|---|---|---|
| bare | `billing` (`me/invoices`, `me/invoices/:id`, `me/spend`) | `MyBillingController` | `apps/api/src/modules/billing/my-billing.controller.ts:26,42,50,58` | **tenant** (`read:Tenant`, inventory: "CLS tenant only. 404-over-403 on foreign invoice") |
| bare | `usage` (`me/summary`, `me/burndown`) | `MyUsageController` | `apps/api/src/modules/admin-usage/my-usage.controller.ts:18,34,42` | **tenant** (`read:Tenant`, inventory: "No tenantId override") |
| bare | `entitlements` (`me`) | `MyEntitlementsController` | `apps/api/src/modules/entitlements/my-entitlements.controller.ts:18,35` | **tenant** (`read:Tenant`) |
| bare | `tenant` (`me`, `me/config`) | `MyTenantController` | `apps/api/src/modules/tenant/my-tenant.controller.ts:21,47,62,92` | **tenant** |
| `user/me/*` | preferences / settings / departments | see D-A | | **user** |
| `tenant/me/*` | `tenant/me/context-schema` | `MyTenantContextSchemaController` | `apps/api/src/modules/consultation-context-schema/consultation-context-schema.controller.ts:173,190` | **tenant** |

**Finding not in the review:** the bare four and `tenant/me/context-schema` are *tenant*-scoped
self views; only `user/me/*` is *user*-scoped. Collapsing all of them under one `/users/me/**`
alias would assert that a tenant's invoices belong to the calling user, which is exactly the
"me" ambiguity review §3.3 warns integrators about ("an API key is bound to a user, so
`/user/me/*` under a key resolves to the *key's bound user*"). Decision D-1 resolves this.

#### D-C — verb-as-resource

`PermissionCheckController` — `apps/api/src/modules/rbac/permission-check.controller.ts:17`
(`@Controller('rbac/check')`), three POST handlers:

- `:38` `@Post()` — check for a (possibly other) user
- `:99` `@Post('bulk')`
- `:169` `@Post('my-permissions')`

Inventory row: `api/v1/rbac/check | 3 | JWT only | forbidden | @Authorize(); other-user checks
need manage:User` (`docs/architecture/api-controller-inventory.md:152`). So the surface is
**two** resources wearing one verb: a self check and an other-user check with a different
privilege gate.

#### D-D — service-named prefixes

| Prefix | Controller | Evidence | What it actually exposes |
|---|---|---|---|
| `ai` | `AiInferenceController` | `apps/api/src/modules/ai-inference/ai-inference.controller.ts:48`; routes `guardrail/analyze` `:96`, `nlp/entities` `:109`, `nlp/diagnosis` `:189`, `nlp/topic` `:210`, `nlp/intent` `:230` | a safety check + four NLP analyses — two capabilities, one prefix named after neither |
| `text` | `TextProxyController` | `apps/api/src/modules/streaming/text-proxy.controller.ts:181`; `generate` `:517`, `tasks/:taskId` `:554`, `tasks/:taskId/cancel` `:584`, `tasks/:taskId/stream` `:608`, `generate/assembled` `:776`, `providers` `:1151`, `guardrail-providers` `:1214` | text generation — prefix is the name of `apps/text` (port 8862) |
| `speech` | `SpeechProxyController` | `apps/api/src/modules/speech/speech-proxy.controller.ts:67`; `synthesize` `:251`, `voices` `:390` | speech synthesis |

**Correction to the review's framing, verified:** of the three, only `ai` and `text` are literally
service names (`apps/text`). The backing service for `speech` is `apps/tts` (port 8865), so
`speech` is already capability-shaped and is arguably the *target* naming style, not an offender.
Decision D-3 records this rather than renaming a path for no gain.

#### D-E — misleading class name

`apps/api/src/modules/pipeline/audio-pipeline-public.controller.ts`:

```
6:  @ApiBearerAuth()
8:  @Controller('audio/pipelines')
9:  @Authorize()
18: @ForbidApiKey()
19: export class AudioPipelinePublicController {
```

There is no `@Public()` anywhere in the file. Inventory row: `api/v1/audio/pipelines | 3 | JWT
only | forbidden | @Authorize() | Read-only catalog for clinicians.`
(`docs/architecture/api-controller-inventory.md:145`). "Public" here means "non-admin", which is
the opposite of what `@Public()` means everywhere else in this codebase (it is the deny-by-default
opt-out read by `admin-route-permission-audit.ts` and `api-key-surface-audit.ts:84-87`).
**The path is fine; only the class name lies.**

### 2.2 What already exists that this ticket must reuse

- **Route-rename regression suite:** `apps/api/src/__tests__/controller-route-renames.test.ts`.
  It asserts, per controller file, the expected `@Controller(...)` literal (`:33`), the *absence*
  of the old literal (`:39`), the full resolved URL under the `api/v1` global prefix (`:63`),
  `@ApiTags` alignment (`:88`), an explicit "unchanged controllers" list (`:106` — which currently
  pins `rbac/check`, `monitoring`, `health`, `auth`, `storage` as *unchanged*), and runtime
  `Reflect.getMetadata(PATH_METADATA, …)` (`:197`). **Three of the entries this ticket changes are
  currently pinned as "unchanged" there**, so the suite fails until it is updated in the same
  commit — which is the intended RED.
- **SDK endpoint constants are centralized:** `packages/agentic-sdk-v2/src/core/constants.ts` is a
  single file holding every path (see §2.3). No path literal is scattered across hooks; hooks
  reference the constants. This is what makes the SDK half of the change mechanical.
- **Console clients are per-feature and thin:** e.g. `apps/admin-console/src/features/playground-voice-profiles/api/client.ts:11`
  holds `const BASE = 'voice-profile';` — one line for the whole feature.

### 2.3 Blast radius — verified consumer inventory

Method: `grep -rn "<path>" packages/agentic-sdk-v2/src packages/vox-node/src apps/admin-console/src apps/example`,
excluding `node_modules` and test files, on 2026-08-18.

| Rename group | `@arcaai/vox` (`packages/agentic-sdk-v2`) | `apps/admin-console` | `@arcaai/vox-node` | `apps/example` |
|---|---|---|---|---|
| `user/me/*` | `src/core/constants.ts:191,192` (prefs), `:661,662` (settings); doc refs in `src/core/ConfigManager.ts:32`, `src/providers/AgenticProvider.tsx:110,125,166,612,850,945`, `src/hooks/useUserSettings.ts:4,5`, `src/hooks/usePipelines.ts:18,100` | `src/features/account/api/client.ts:32,36,40,45,49`; copy in `src/features/account/components/account-screen.tsx:68,69,143,195`; `src/features/playground-consultation/hooks/use-column-layout.ts:8` | none | none |
| `tenant` / `tenant/me/*` | `src/core/constants.ts:371,372,378`; `src/core/ModelRegistry.ts:301`, `src/core/ConsultationSchemaClient.ts:4`, `src/types/consultationSchema.ts:5,16,146`, `src/types/config.ts:861,928`, `src/hooks/useConsultationSchema.ts:6` | `src/features/account/api/client.ts:11,19,24`; `src/features/agents/api/client.ts:230,235`; `src/features/agents/api/types.ts:503`; copy in `src/features/account/components/tenant-profile-screen.tsx:63,200,239`, `tenant-settings-tab.tsx:124`, `src/features/context-schemas/components/context-schemas-list.tsx:110`, `src/features/account/lib/config-categories.ts:4` | none | none |
| `entitlements/me` | `src/core/constants.ts:650`; `src/hooks/useEntitlements.ts:7,48` | `src/features/account/api/client.ts:28`; `src/features/entitlements/api/types.ts:43` | none | none |
| `billing` / `usage` (self plane) | none found | none found (`src/features/billing/api/keys.ts:5` is a TanStack query key, not a path; the console's usage screens read the **admin** plane `admin/usage/*`) | none | none |
| `voice-profile` | `src/core/constants.ts:1093-1097`; `src/hooks/useVoiceEmbedding.ts:4-9`, `src/hooks/useLocalVoiceEmbedding.ts:11`, `src/hooks/useVoiceEnrollmentStatus.ts:45`, `src/core.ts:667` | `src/features/playground-voice-profiles/api/client.ts:11` (`BASE`), `.../api/types.ts:2,9`, `.../components/profile-list-card.tsx:59,98`, `.../components/enrollment-card.tsx:151` | none | none |
| `rbac/check` | none found | `src/shared/auth/hooks.ts:40` (the only runtime caller: `POST /api/hope/rbac/check/my-permissions`); copy in `src/shared/auth/ability.ts:3`, `src/shared/layout/app-sidebar.tsx:23` | none | none |
| `text` | `src/core/constants.ts:1022,1024` | `src/features/playground-llm/api/client.ts:45,50`; `.../api/types.ts:30,105`; copy in `.../components/prompt-editor-card.tsx:89`, `playground-llm-screen.tsx:178`, `output-pane.tsx:93` | none | none |
| `speech` | `src/core/constants.ts:102`; `src/core/AgenticClient.ts:584`; `src/hooks/useTtsPlayback.ts:4` | none found | none | none |
| `ai` | none found | `src/features/playground-llm/api/inference-client.ts:12,16` | none | none |
| `users/password-reset` | `src/core/constants.ts:706` | `src/app/api/auth/reset-password/route.ts:19` | none | none |
| `users/:id/roles` | `src/core/constants.ts:784,790` (+ the doc block at `:766,773,799` distinguishing it from the admin plane at `:804,805,809,810`) | none found | none | none |
| `audio/pipelines` (path **unchanged**; class rename only) | `src/core/constants.ts:480,481,485,487,489` (read plane) | `src/features/playground-consultation/api/client.ts:35`, `src/features/playground-live-transcription/api/client.ts:99` | none | none |

**`@arcaai/vox-node` is unaffected — verified, not assumed.** Its only paths are the compat
surface `api/smr/api/v1/{presummary,summary/sync}` (`packages/vox-node/src/client.ts:67`,
`src/types/summarization.ts:5,127,168,265,301,315,329`) and `consultations/*` /
`consultations/jobs/*` (`src/types/consultation.ts:6,7,15,16`). Neither is in the rename set;
the first is fenced out of scope.

**`apps/example` is unaffected — verified.** Its only gateway paths are
`api/v1/audio/transcription-jobs/stream/session[…]` (`apps/example/src/LiveTranscriptionDemo.tsx:120,203`).

**API e2e specs that touch at least one affected path: 20 files**, including
`apps/api/tests/e2e/rbac.spec.ts`, `voice-profile-cross-tenant.spec.ts`, `authorization.spec.ts`,
`tenant-access-control.spec.ts`, `task-658-context-schema-plane.spec.ts`,
`task-708-apikey-scope-contract.spec.ts`, `users-backend-backlog.spec.ts`,
`password-security-hardening.spec.ts`, `ai-inference-proxy.spec.ts`,
`task-729-nlp-task-expansion.spec.ts`, `optimistic-locking.spec.ts`,
`shared-component-contracts.spec.ts`, `admin-features-contract.spec.ts`,
`cross-tenant-aggregate-audit.spec.ts`, `phase-0-redteam.spec.ts`, `tenant-detail-contract.spec.ts`,
`user-impersonation.spec.ts`, `task-615-usage-analytics-cross-tenant.spec.ts`,
`byo-llm-credentials.spec.ts`, `speech-proxy-auth.spec.ts`
(`grep -rlE "voice-profile|rbac/check|user/me|tenant/me|entitlements/me|billing/me|usage/me|/text/generate|/speech/synthesize|/ai/nlp|users/password-reset" apps/api/tests/e2e`).

---

## 3. Implementation Plan

### Phase 0 — Owner decisions (blocking; no code until each is answered)

| # | Decision | Why it cannot be defaulted |
|---|---|---|
| **D-1** | Is the self plane **one** alias (`/users/me/**`, per review §3.5 as literally written) or **two** (`/users/me/**` for user-scoped, `/tenants/me/**` for tenant-scoped)? | Verified in §2.1 D-B: `billing`/`usage`/`entitlements`/`tenant`/`tenant/me/context-schema` are all `read:Tenant`, CLS-tenant-scoped. Folding them under `/users/me` states something false about ownership and worsens exactly the "me" ambiguity review §3.3 flags for API keys. Recommendation: **two aliases**, `/users/me/**` and `/tenants/me/**`. |
| **D-2** | Final target names for `ai` and `text`. | Naming is an owner call, not a derivable fact. Candidate set for `ai`: split into `safety-checks` (from `ai/guardrail/analyze`) and `text-analyses` (from `ai/nlp/*`), since they are two capabilities; candidate for `text`: `text-generations` or `completions`. |
| **D-3** | Does `speech` move at all? | Verified §2.1 D-D: `speech` is not a service name (the service is `apps/tts`); it is already capability-shaped. Recommendation: **leave it**, and record the correction in the review. |
| **D-4** | The release in which each redirect is deleted. | The convention requires the deleting release to be **named in the comment** at the time the redirect is added. |

### Phase 1 — Gateway: move routes, add redirect shims (one commit per rename group)

Ordering matters; group 1 must land first because it defines the alias namespace.

1. **Self alias namespace.** Introduce `/users/me/**` (and, per D-1, `/tenants/me/**`).
   **Hazard, verified:** `UserRolesController` is `@Controller('users')` with `@Get(':id/roles')`
   (`user-roles.controller.ts:23,41`), so a `me` literal is swallowed by the `:id` parameter route
   unless the literal-segment controller is registered first. Nest resolves in module/controller
   registration order — the `users/me/**` controllers must be registered **before**
   `UserRolesController` in their module's `controllers` array, and the ordering must be pinned by
   a test (§3.2 T-2), not left to import order.
2. `user/me/preferences|settings|departments` → `users/me/…`.
3. `tenant` → `tenants/me` (`me`, `me/config`) and `tenant/me/context-schema` → `tenants/me/context-schema`.
4. `billing|usage|entitlements` self routes → under the D-1 alias
   (`tenants/me/invoices`, `tenants/me/invoices/:id`, `tenants/me/spend`, `tenants/me/usage-summary`,
   `tenants/me/usage-burndown`, `tenants/me/entitlements` — exact leaf names subject to D-1).
5. `voice-profile` → `voice-profiles`.
6. `rbac/check` → resource form: `POST /users/me/permission-checks` (from `my-permissions`,
   `permission-check.controller.ts:169`) and `POST /users/:id/permission-checks` +
   `POST /users/:id/permission-checks/bulk` (from `@Post()` `:38` and `@Post('bulk')` `:99`,
   which carry the `manage:User` gate for other-user checks).
7. Capability prefixes per D-2/D-3.
8. **Class rename only:** `AudioPipelinePublicController` → `AudioPipelineCatalogController`
   (path `audio/pipelines` unchanged). Update `apps/api/src/bootstrap/admin-scope-audit.ts` only if
   the class is referenced there — it is **not** (verified: the list at `:98-163` contains
   `AudioPipelineController`, the admin one, at `:131`).

**Redirect shim rules (per group):**

- Keep the old `@Controller(...)` as a thin shim whose handlers issue a redirect to the new path,
  preserving query string and, for `:id`-style routes, path params.
- **Use 308, not 301/302.** 301/302 permit a client to downgrade POST/PATCH/DELETE to GET, which
  silently drops the body. 307/308 preserve method and body; 308 is the permanent form.
  Nest's `@Redirect()` decorator is GET-shaped — non-GET shims must set the status and `Location`
  header explicitly on the response object.
- Every shim carries the mandated comment, e.g.
  `// TASK-760 redirect shim — DELETE IN <release named by D-4>. Old path retired <date>.`
- Shims inherit the *original* route's auth decorators unchanged, so a redirect never becomes an
  unauthenticated hop. They must still satisfy the deny-by-default audits
  (`admin-route-permission-audit.ts`) and the API-key surface audit
  (`api-key-surface-audit.ts:84-109`) — i.e. each shim carries `@Public()`, `@RequiredScopes(...)`,
  or `@ForbidApiKey()` exactly as its target does.
- **No shim on compat prefixes** (scope fence).

### Phase 2 — `@arcaai/vox` (lockstep, same MR)

- Update `packages/agentic-sdk-v2/src/core/constants.ts` at every line listed in §2.3.
- Update the doc comments that quote paths (they are the SDK's contract surface for integrators):
  `src/hooks/useVoiceEmbedding.ts:4-9`, `useUserSettings.ts:4,5`, `usePipelines.ts:18,100`,
  `useEntitlements.ts:7,48`, `useConsultationSchema.ts:6`, `useTtsPlayback.ts:4`,
  `src/core/ConsultationSchemaClient.ts:4`, `src/core/ModelRegistry.ts:301`,
  `src/core/AgenticClient.ts:584`, `src/types/consultationSchema.ts:5,16,146`,
  `src/types/config.ts:861,928`, `src/providers/AgenticProvider.tsx:110,125,166,612,850,945`.
- **Version:** MAJOR for the SDK family (`@arcaai/vox`, `@arcaai/vox-node`, published in lockstep
  by the same `publish-sdk` CI job per `.claude/rules/08-vox-sdk.md`). `@arcaai/vox-node` has no
  code change but takes the version bump with the family.
- README/CHANGELOG: an explicit old → new path table, and a statement that the old paths 308 for
  one release only.

### Phase 3 — `apps/admin-console` (lockstep, same MR)

Per §2.3: `src/features/account/api/client.ts` (5 call sites), `src/features/agents/api/client.ts:235`,
`src/features/playground-voice-profiles/api/client.ts:11`, `src/shared/auth/hooks.ts:40`,
`src/features/playground-llm/api/client.ts:45,50`, `src/features/playground-llm/api/inference-client.ts:12,16`,
`src/app/api/auth/reset-password/route.ts:19`, `src/features/playground-consultation/api/client.ts:35`,
`src/features/playground-live-transcription/api/client.ts:99`. Plus the on-screen path captions
(they are user-visible documentation of the endpoint and will be wrong otherwise) at
`account-screen.tsx:143,195`, `tenant-profile-screen.tsx:239`,
`live-transcription-screen.tsx:109`, `audio-pipelines-screen.tsx:210`,
`profile-list-card.tsx:98`, `my-dna-style-screen.tsx:138`, `context-schemas-list.tsx:110`,
`prompt-editor-card.tsx:89`, `playground-llm-screen.tsx:178`, `consumption-cost-screen.tsx:45`.

### Phase 4 — Documentation

- Regenerate/patch `docs/architecture/api-controller-inventory.md` (summary table rows at
  `:118,145,151,152,168,186` and the corresponding per-controller sections) and
  `api-controller-groupings.md`.
- Append a decision note to `docs/architecture/api-design-conformance-review.md` §3.5 recording
  D-1..D-4 (including the `speech` correction), rather than editing the finding text.

### Phase 5 — Redirect deletion (a separate, later MR)

Delete every shim in the release named by D-4. Tracked by the comment on each shim.

---

### TDD test list (RED first — each test is written and seen failing BEFORE the phase that makes it pass)

| # | Test file | RED assertion (must fail before the code change) |
|---|---|---|
| **T-1** | `apps/api/src/__tests__/controller-route-renames.test.ts` (extend) | Add TASK-760 cases to the `cases` array (`:25`) asserting `extractControllerPath()` returns `'users/me/preferences'`, `'users/me/settings'`, `'users/me/departments'`, `'tenants/me'`, `'tenants/me/context-schema'`, `'voice-profiles'`. RED because the files still read `user/me/preferences` etc. **Also move `rbac/check` out of the `unchanged` list (`:100-105`)** — leaving it there makes the suite pass for the wrong reason. |
| **T-2** | `apps/api/src/modules/user/__tests__/users-me-route-precedence.test.ts` (new) | Build a `Test.createTestingModule` with `UserRolesController` and the `users/me/*` controllers and assert `GET /users/me/roles` reaches the literal-segment handler, **not** `UserRolesController.findRoles` with `id === 'me'`. RED today (no `users/me` controller exists) and RED again if someone reorders the module's `controllers` array. |
| **T-3** | `apps/api/tests/e2e/task-760-uri-normalization.spec.ts` (new) | For each renamed route: (a) the NEW path returns the same status + body as the old one did; (b) the OLD path returns **308** with a `Location` header pointing at the new path; (c) a POST/PATCH old path returns 308 (never 301/302 — assert the exact code, since a 302 would silently drop the body); (d) the old path's auth posture is unchanged (an unauthenticated call still 401s at the shim, it does not redirect first). All RED — the new paths 404 today. |
| **T-4** | `apps/api/tests/e2e/task-760-uri-normalization.spec.ts` (same file, separate describe) | **Scope-fence regression:** `POST /api/smr/api/v1/presummary`, `POST /api/stt/start_session` and the `ws /stt` handshake still resolve at their exact current paths and are **not** redirected. GREEN today and must stay green — this is the fence, and it is the one test in this ticket that must never turn RED. |
| **T-5** | `packages/agentic-sdk-v2/src/core/__tests__/constants.task760.test.ts` (new; matches the existing `constants.task<NNN>.test.ts` convention) | Assert every renamed constant's new literal (`USER_PREFERENCES.GET_PREFERENCES === '/users/me/preferences'`, `VOICE_PROFILE.list === '/voice-profiles'`, `TENANT.INFO === '/tenants/me'`, …) **and** that no exported constant still contains `'/user/me/'`, `'/voice-profile/'`, `'/tenant/me/'`, `'/rbac/check'`. RED today. |
| **T-6** | `apps/admin-console/src/features/account/api/__tests__/account-api.test.ts` (extend) | Assert the mocked fetch is called with `users/me/settings`, `users/me/preferences`, `users/me/departments`, `tenants/me`, `tenants/me/config`, `tenants/me/entitlements`. RED today (asserts the old literals). |
| **T-7** | `apps/admin-console/src/shared/auth/__tests__/ability.test.ts` (extend) or a new sibling for `hooks.ts` | Assert the permissions fetch targets `/api/hope/users/me/permission-checks`. RED today (`hooks.ts:40` posts to `/api/hope/rbac/check/my-permissions`). |
| **T-8** | The 20 affected `apps/api/tests/e2e/*.spec.ts` files (§2.3) | Update path literals. These are not new tests; they turn RED on the gateway change and must be fixed in the same MR, never by adding a redirect the spec follows silently. |
| **T-9** | `apps/api/src/__tests__/controller-route-renames.test.ts` (class-name case) | Assert `AudioPipelineCatalogController` is exported from `apps/api/src/modules/pipeline/audio-pipeline-public.controller.ts` (or its renamed file) **and** that its `PATH_METADATA` is still `'audio/pipelines'` — the class rename must not move the path. RED on the class name, GREEN on the path. |

---

## 4. Verification Criteria

- [ ] Phase 0 decisions D-1..D-4 answered by the owner and recorded in §"Change History" before any code.
- [ ] `pnpm --filter @arcaai/applications build test` green.
- [ ] `pnpm api:build` green; `pnpm test:unit` green (T-1, T-2, T-9).
- [ ] `pnpm test:up:api` + `pnpm test:e2e` green, including T-3 and **T-4 (scope fence)**.
- [ ] `pnpm --filter @arcaai/vox build test lint typecheck` green (T-5); `pnpm sdk-node:build` green
      (no code change, version bump only).
- [ ] `pnpm --filter @arcaai/admin-console build lint test` green (T-6, T-7).
- [ ] `pnpm lint` clean — no new warnings in `packages/*` either (they are hard errors by policy).
- [ ] Every retired path answers **308** with a correct `Location`, and every shim carries a
      deletion comment naming the D-4 release.
- [ ] No file under `text-compat/`, `stt-compat/` changed (`git diff --stat` shows zero lines there).
- [ ] `docs/architecture/api-controller-inventory.md` and `api-controller-groupings.md` regenerated;
      `api-design-conformance-review.md` §3.5 carries the appended decision note.
- [ ] SDK MAJOR version + CHANGELOG entry with the old → new path table.

---

## 5. Why this goes last (and why it is the lowest-urgency item in the set)

`api-design-conformance-review.md` §4 sequences this as **order 7 of 8**, and that placement should
be treated as binding:

- **It is the only item in the review with zero security or correctness consequence.** §2.1 is an
  exploitable same-tenant session hijack; §3.1 step 1 is a privilege-escalation ceiling; §3.1 step 2
  removes a long-lived static credential with an admin's blast radius. This ticket makes URIs
  predictable. Nothing is unsafe while it is undone.
- **It has the largest diff and the widest blast radius of anything in the batch** — 11 rename
  groups across 3 first-party consumers, ~40 SDK/console call sites, 20 e2e spec files, and a MAJOR
  SDK release. Landing it before the security work would force every security change to rebase
  across a repo-wide path churn.
- **It is the only item that breaks external consumers.** Everything else in the batch either
  tightens an internal gate or moves an admin-only path.
- **It depends on the others' outcomes.** TASK-758's exemption list decides which business routes
  carry `@RequiredScopes` vs `@ForbidApiKey`, and every redirect shim must reproduce that posture
  (Phase 1 shim rules). Running this first means writing the shims twice.
- **Pre-launch is the only window.** Per `no old tickets / build for day-1` posture there is no
  production data or external integrator yet, so the redirect shims are a courtesy to first-party
  consumers rather than a compatibility obligation. That is exactly why the work is cheap *now* and
  expensive later — but it is still the last thing to do, not the first.

---

## 6. Implementation Summary

pending

---

## 7. Change History

| Date | Change |
|---|---|
| 2026-08-18 | Created. Documented business-plane URI shape drift from `api-design-conformance-review.md` §2.6/§3.5, verified every prefix and consumer call site against source, enumerated the per-rename blast radius across `@arcaai/vox` / `apps/admin-console` (and verified `@arcaai/vox-node` + `apps/example` are unaffected), and recorded four blocking owner decisions (D-1 self-plane split, D-2 capability names, D-3 `speech` correction, D-4 redirect-deletion release). Status: Pending. |
| 2026-08-18 | **Owner decisions recorded.** Scope: **full normalization with 308 redirect shims** (not deferred, not naming-only) — accepted with its ~30 SDK sites / ~20 admin-console sites / 20 e2e specs blast radius. **D-1 resolved: TWO aliases** — `/users/me/**` for user-scoped and `/tenants/me/**` for tenant-scoped; a single `users/me` alias is rejected because `billing`/`usage`/`entitlements`/`tenant` are `read:Tenant`-scoped and would assert false ownership. **D-3 resolved: `speech` does NOT move** — its backing service is `apps/tts`, so it is already capability-shaped; only `ai` and `text` are renamed. **D-2 (target names for `ai`/`text`) remains OPEN** and still blocks step 7 only. The `/users/me/roles` vs `UserRolesController` `@Get(':id/roles')` collision must be pinned by test before the alias lands. |
