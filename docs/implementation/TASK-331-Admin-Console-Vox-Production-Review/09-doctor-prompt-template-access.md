# TASK-331 · doc-09 — Doctor Prompt-Template Access (Pre-Summary / Summary 403 fix)

| Field | Value |
|---|---|
| Parent | TASK-331 (follow-up to doc-06 / doc-07) |
| Type | bugfix / security (access-control plane violation) |
| Status | **Completed** (code + tests; RBAC reseed to be run by owner) |
| Created | 2026-06-05 |
| Updated | 2026-06-05 |
| Scope (code) | `apps/api/src/modules/prompt-management/**`, `apps/api/src/modules/streaming/smr-proxy.controller.ts`, `packages/applications/src/services/prompt-management/**`, `packages/database/src/prisma/db_main/seed/{01-policy,03-role}.ts`, `apps/ui-playground/src/features/summarization/{pre-summary,summary,api}/**`, `packages/agentic-sdk-v2/src/core/constants.ts` (+ optional `hooks/usePrompts`) |

---

## 1. Requirement Analysis

### Symptom
When an admin **impersonates a doctor** (or a doctor logs in directly), opening **Pre-Summary** or **Summary** in the ui-playground bounces the whole app to `/403`. The doctor cannot use either screen.

### Root cause (verified, file:line)
A **doctor-facing screen consumes an admin-plane endpoint**, gets `403`, and the **global query-cache error handler redirects to `/403`**:

1. Both screens fetch the template list from the admin API module:
   - `apps/ui-playground/src/features/summarization/pre-summary/index.tsx:45-46,121-123`
   - `apps/ui-playground/src/features/summarization/summary/index.tsx:30-31,113-117`
   - Gate is `!ctx.requiresImpersonation`; while impersonating a doctor `requiresImpersonation === false`, so the query **runs** with the doctor's token.
2. `usePromptTemplates` → `adminClient.get('/admin/prompt-templates')` — `apps/ui-playground/src/features/admin/api/prompts.ts:193-200`.
3. The controller requires an admin ability — `apps/api/src/modules/prompt-management/prompt-management.controller.ts:27-28` (`@Controller('admin/prompt-templates')` + class-level `@Authorize(['read','PromptTemplate'])`).
4. The `DOCTOR` role has **no** `PromptTemplate` ability — `packages/database/src/prisma/db_main/seed/03-role.ts:57` (`consultation-own-manage`, `consultation-shared-patient-read`, `user-profile-own`, `api-key-own-manage`, `storage-upload`). `read:PromptTemplate` comes only from `prompt-template-manage`, granted only to `TENANT_ADMIN` (`03-role.ts:48`) / `SUPER_ADMIN`. ⇒ **403 Forbidden**.
5. Global handler turns any 403 into a redirect — `apps/ui-playground/src/lib/query-client.ts:53-54` (`navigate({ to: '/403' })`).

> This affects a **directly-logged-in doctor too** — not only impersonation — because the query is enabled whenever `!requiresImpersonation`.

### Secondary finding (latent cross-tenant IDOR — fix alongside)
The doctor *generation* path resolves a template by ID with **no tenant/scope check** (contrast the DNA guard right below it):
- `apps/api/src/modules/streaming/smr-proxy.controller.ts:653-660` — bare `findById`, no `tenantId` comparison.
- DNA guard for comparison: `smr-proxy.controller.ts:668-693`.

### Why prior TASK-331 work missed it
doc-07 F2 fixed the *generation* path (`/text/generate/assembled`) but never touched the **template-list fetch**, which still routes through the admin module/endpoint. The SDK is wired the same way: `PROMPT_TEMPLATE_ENDPOINTS.LIST = '/admin/prompt-templates'` (`packages/agentic-sdk-v2/src/core/constants.ts:184-187`).

### Acceptance criteria
1. A `DOCTOR` (impersonated or direct) can open Pre-Summary and Summary, see the template selector populated, and generate — **no `/403` redirect**.
2. The doctor-facing template list is served by an **end-user route** (not `/admin/*`) and returns only templates the caller may read: `TENANT_DEFAULT` + the caller's `DEPARTMENT_DEFAULT` + the caller's own `USER_PERSONAL`. No drafts/other users' personal templates/analytics.
3. Granting clinicians `read:PromptTemplate` must **not** open the existing `/admin/prompt-templates` GET routes to doctors (see §3 plane-separation).
4. `prompt_template_id` resolution in the assembled SMR route enforces caller-tenant scope (Forbidden/NotFound on mismatch).
5. Admin console (TENANT_ADMIN / SUPER_ADMIN) prompt-template management is unchanged.
6. TDD: each change has a RED test first; all affected packages build + lint clean.

---

## 2. Current State Evaluation

- **Service methods already exist** (built by TASK-294, never exposed via a controller — see that ticket's "Future work"):
  - `listDefaultsForDepartment(departmentId)` — `prompt-management.service.ts:376-390` (tenant-scoped, ENABLED, `scope=TENANT_DEFAULT` OR `DEPARTMENT_DEFAULT && departmentId`).
  - `listMyPersonalForDepartment(departmentId)` — `prompt-management.service.ts:392-400` (tenant + `ownerUserId=caller`).
  - Interface: `IPromptManagementService.ts:38-39`.
  - ⚠️ Neither supports a `category` filter, and `listDefaultsForDepartment` with an empty `departmentId` would mis-scope `DEPARTMENT_DEFAULT` — both handled by the new method in §3.
- **End-user client exists & is impersonation-aware**: `apps/ui-playground/src/features/summarization/api/smr-client.ts` (effective token + tenant; same gateway). Right client for the doctor-facing call.
- **Caller department**: frontend has `ctx.primaryDepartmentId` (`use-doctor-context.ts:42,45`). Backend should resolve it server-side (don't trust client) — see §3 decision D2.
- **Module wiring**: `apps/api/src/modules/prompt-management/prompt-management.module.ts` imports `PromptManagementServiceModule` and registers `PromptManagementController`; a second (end-user) controller can be added to the same module.

---

## 3. Key design decisions (please review)

**D1 — Plane separation (prevents a privilege leak). REQUIRED.**
Granting doctors `read:PromptTemplate` would *also* satisfy the existing admin controller's class-level `@Authorize(['read','PromptTemplate'])`, letting doctors call the admin GET routes (list **all** tenant templates incl. drafts + other users' personal + usage analytics). To prevent this:
- **End-user route** → `@Authorize(['read','PromptTemplate'])` (clinicians get this).
- **Admin controller read surface** → bump class-level (and the inheriting GETs: `list`, `getById`, `getVersions`, `getUsageStats`, `analytics/usage`) to **`@Authorize(['manage','PromptTemplate'])`**. Admins already have `manage` (no regression); doctors with only `read` are excluded. Per-method `create/update/delete/test/activate` tuples are unchanged (subsumed by `manage`).
- Update the admin controller test that currently asserts class-level `['read','PromptTemplate']` → `['manage','PromptTemplate']`.

*(Alternative if you'd rather not touch admin authz at all: gate the new end-user route as authenticated + tenant-scoped with no `PromptTemplate` ability — but you chose the CASL-policy route, and D1 is the clean way to honor it without the leak.)*

**D2 — Department resolution.** The new endpoint resolves the **caller's** department server-side (CLS user → primary department) rather than trusting a client-supplied `departmentId`. If the caller has no department, return `TENANT_DEFAULT` (+ personal) only. Accept an optional `category` query param (Pre-Summary defaults to `PRE_SUMMARY`/pre-summary-tagged; Summary uses `SUMMARY`).

**D3 — New service method** `listAvailableForCaller({ category?, departmentId? })` (single scoped query) instead of merging the two existing calls in the controller:
```
tenantId = caller tenant; ENABLED;
( scope = TENANT_DEFAULT )
OR ( scope = DEPARTMENT_DEFAULT AND departmentId = caller.dept )
OR ( scope = USER_PERSONAL AND ownerUserId = caller )
[ AND category = :category ]
```
Reuses the existing repository/query-builder pattern; dedupes; maps to `PromptTemplateResponse`.

**D4 — Endpoint name/shape.** `GET /prompt-templates/available?category=&` (end-user plane, under the global `/api/v1` prefix). Returns a plain array (matches how the pages already normalize `data`/array). New `PromptTemplateController` (`@Controller('prompt-templates')`).

**D5 — SDK fidelity (recommended, since this is the SDK reference).** Add `PROMPT_TEMPLATE_ENDPOINTS.AVAILABLE` + a read-only `usePrompts().listAvailable()` so integrators copy the doctor-safe path. Keep existing admin endpoints for the admin console.

---

## 4. Implementation Plan (TDD order, layer chain)

Layer chain: **Seed/Policy → Domain (n/a, reuse) → Service → API (controllers + SMR guard) → SDK → UI.**

### Step 1 — Service: `listAvailableForCaller` (`packages/applications`)
- RED: `prompt-management.service.test.ts` — returns tenant-defaults + caller-dept defaults + caller's personal; **excludes** other users' personal, other tenants, disabled, and other departments' dept-defaults; honors `category`; `BadRequest` when no tenant.
- GREEN: add method to `IPromptManagementService` + `PromptManagementService` (D3 query).
- Verify: `pnpm test:unit --filter @arcaai/applications`.

### Step 2 — API: end-user controller + admin plane bump (`apps/api`)
- RED:
  - New `prompt-template.controller.test.ts` — route is `prompt-templates` (not `admin/*`); `available` method `@Authorize(['read','PromptTemplate'])`; delegates to `listAvailableForCaller`.
  - Update `prompt-management.controller.test.ts` — class-level now `['manage','PromptTemplate']` (D1).
- GREEN: add `PromptTemplateController` (`@Controller('prompt-templates')`, `GET available`) → register in `prompt-management.module.ts`; bump admin class-level decorator to `manage`.
- Verify: `pnpm --filter @arcaai/api test`.

### Step 3 — API: SMR template tenant guard (`apps/api`)
- RED: `smr-proxy` test — cross-tenant `prompt_template_id` → `Forbidden`/`NotFound`.
- GREEN: in `assemble...()` template branch (`:653-660`) compare `template.tenantId` to caller tenant (mirror DNA guard `:668-693`); reject mismatch.
- Verify: api unit tests.

### Step 4 — Seed/Policy: clinician read ability (`packages/database`)
- RED: `seed.test.ts` — a new `prompt-template-read` policy exists (`read`+`list` `PromptTemplate`, tenant-scoped); `DOCTOR` (and `SPECIALIST`/`CONSULTANT` if seeded) role includes it; `DOCTOR` still does **not** have `manage PromptTemplate`.
- GREEN: add `prompt-template-read` to `01-policy.ts`; attach to clinician roles in `03-role.ts`.
- Verify: `pnpm test:unit --filter @arcaai/database`. **Deploy note:** additive RBAC seed (idempotent upsert, no DELETE/DROP/TRUNCATE) — requires a policy/role reseed on existing environments; flagged for your approval before running against any DB.

### Step 5 — SDK (recommended) (`packages/agentic-sdk-v2`)
- RED: constants test for `PROMPT_TEMPLATE_ENDPOINTS.AVAILABLE === '/prompt-templates/available'`; `usePrompts().listAvailable()` hits it.
- GREEN: add the endpoint + read-only hook method.
- Verify: `pnpm --filter @arcaai/vox test`.

### Step 6 — UI rewire (`apps/ui-playground`)
- RED: `pre-summary` + `summary` tests assert the template list is fetched from the **end-user** endpoint (not `/admin/prompt-templates`), and a doctor without admin ability renders the page (mock 200) with **no `/403`** navigation.
- GREEN: add `features/summarization/api/prompts.ts` (`usePromptTemplatesAvailable(params)` via `smrClient` or the new SDK hook); switch `pre-summary/index.tsx` + `summary/index.tsx` off `@/features/admin/api/prompts`. Keep a shared `PromptTemplate` type (type-only).
- Verify: `pnpm --filter @arcaai/ui-playground test`.

---

## 5. Verification criteria (Phase-5 gate)
- `@arcaai/{applications,api,vox,database,ui-playground}` unit tests green (paste output).
- `turbo run build` for the api + ui-playground closures clean.
- `ReadLints` clean on every modified file.
- Manual: impersonate a doctor → Pre-Summary + Summary load, selector populated, generate works, no `/403`. Admin console prompt management still works.

## 6. Out of scope / follow-ups
- Doctor **create/manage** of personal templates UI (`createPersonal` exists in the service; no UI here).
- Removing now-orphaned admin imports from summarization once rewired.
- Broader audit of other end-user screens importing from `@/features/admin/api/*`.

---

## 7. Implementation Summary (2026-06-05)

Implemented TDD (RED→GREEN per step), layer chain Service → API → Seed → SDK → UI. All RED tests were observed failing for the right reason before the fix.

### Files changed
| Layer | File | Change |
|---|---|---|
| Service | `packages/applications/src/services/prompt-management/IPromptManagementService.ts` | + abstract `listAvailableForCaller(filters?: { category? })`. |
| Service | `packages/applications/src/services/prompt-management/prompt-management.service.ts` | + `listAvailableForCaller` — tenant + ENABLED + `(TENANT_DEFAULT OR DEPARTMENT_DEFAULT OR (USER_PERSONAL AND ownerUserId=caller))`, optional `category`. Reuses the `$()` query-builder; `WhereOr` OR-group is AND-combined with the base `Where` (verified). |
| Service (test) | `…/__tests__/prompt-management.service.test.ts` | +5 tests (scoping, category, peer-personal exclusion, BadRequest on missing tenant/user). |
| API | `apps/api/src/modules/prompt-management/prompt-template.controller.ts` | **New** end-user `@Controller('prompt-templates')`, `GET available` `@Authorize(['read','PromptTemplate'])`. |
| API | `apps/api/src/modules/prompt-management/prompt-management.controller.ts` | **D1** — class-level `@Authorize(['read'…])` → `['manage'…]` (keeps inherited read GETs on the admin plane). Method-level tuples unchanged (guard uses `getAllAndOverride`). |
| API | `apps/api/src/modules/prompt-management/prompt-management.module.ts` | Registered `PromptTemplateController`. |
| API | `apps/api/src/modules/streaming/smr-proxy.controller.ts` | **S3** — `prompt_template_id` guard: cross-tenant → `NotFound`; non-owner `USER_PERSONAL` → `Forbidden` (mirrors the DNA guard). |
| API (tests) | `…/__tests__/prompt-template.controller.test.ts` (new), `prompt-management.controller.test.ts` (D1 metadata bump), `streaming/__tests__/smr-proxy.controller.test.ts` (+4 scope tests). |
| Seed | `packages/database/src/prisma/db_main/seed/01-policy.ts` | + `prompt-template-read` policy (`read`+`list` PromptTemplate, tenant-scoped, id `…053`). |
| Seed | `packages/database/src/prisma/db_main/seed/03-role.ts` | DOCTOR + `prompt-template-read` (DEPARTMENT_HEAD inherits). |
| Seed (test) | `packages/database/src/__tests__/seed.test.ts` | policy count 17→18; +policy-shape + DOCTOR-grant (and NOT `manage`) tests. |
| SDK | `packages/agentic-sdk-v2/src/core/constants.ts` | + `PROMPT_TEMPLATE_ENDPOINTS.AVAILABLE = '/prompt-templates/available'`. |
| SDK | `packages/agentic-sdk-v2/src/hooks/usePrompts.ts` | + read-only `listAvailable(filters?)`. |
| SDK (tests) | `constants.task210.test.ts`, `constants.ws4.test.ts` (12→13 keys), `usePrompts.test.ts` (+3 tests). |
| UI | `apps/ui-playground/src/features/summarization/api/prompts.ts` | **New** `usePromptTemplatesAvailable(tenantId, params?, options?)` via `smrClient` (impersonation-aware); type-only re-export of `PromptTemplate`. |
| UI | `…/summarization/api/index.ts` | Barrel exports for the new hook + types. |
| UI | `…/summarization/{pre-summary,summary}/index.tsx` | Swapped admin `usePromptTemplates` → `usePromptTemplatesAvailable`; dropped `@/features/admin/api/prompts` imports. |
| UI (test) | `…/summarization/api/__tests__/prompts-available.test.tsx` | **New** — asserts end-user route (never `/admin/`), category param, plain-array return, disabled-gate no-fetch. |

### Deviations from the plan
- **D2 (department resolution).** Did **not** add a `UserDepartmentRepository` dependency / server-side primary-department lookup (and did not trust a client `departmentId`). Instead `listAvailableForCaller` returns **all** tenant + department defaults plus the caller's OWN personal templates; the existing **client-side** department prioritization in both pages is preserved. Rationale (simplicity + no security loss): tenant scoping and personal-owner scoping are both enforced server-side; `DEPARTMENT_DEFAULT` templates are shared, non-PHI tenant configuration. No new dependency, DB round-trip, or mock surface.
- **S3 (SMR guard) strengthened.** Beyond the planned tenant-scope check (acceptance #4), also added a `USER_PERSONAL` **owner** check (Forbidden) to mirror the DNA guard and close the within-tenant peer-personal leak. Backward-compatible: existing fixtures omit `tenantId`/`scope`, so the null-safe guard does not regress them.

### Verification evidence
- Unit tests (each `--run` invocation executed the full package suite):
  - `@arcaai/applications` — **4698 passed**, 4 skipped.
  - `@arcaai/api` — **1582 passed**, 4 skipped (incl. new end-user controller + D1 + SMR scope tests).
  - `@arcaai/database` — **737 passed**.
  - `@arcaai/vox` — **3304 passed**.
  - `@arcaai/ui-playground` — **922 passed** (incl. new `prompts-available` test).
- Builds (typecheck): `pnpm build:api` (database/domains/applications/api), `pnpm build:sdk` (vox), `pnpm --filter @arcaai/ui-playground build` — all **exit 0**.
- `ReadLints` clean on every modified file.
- Boot-time admin-route audit (F6) is generic (requires a concrete permission on `/admin/*`); the `manage` bump satisfies it and the new `prompt-templates/*` route is off the admin prefix.

### Deploy note (owner action)
Additive RBAC seed (idempotent upsert — **no** DELETE/DROP/TRUNCATE). Existing environments need a **policy + role reseed** (`pnpm db:seed`) for clinicians to gain `prompt-template-read`. Per your instruction, the reseed is **left for you to run**. Until reseeded, an existing DOCTOR row still lacks the new ability and the selector will 403 → ensure the reseed runs before validating.

## 8. Change History
| Date | Change |
|---|---|
| 2026-06-05 | Created plan (root cause + Option A, new `prompt-template-read` policy). Awaiting approval before implementation. |
| 2026-06-05 | Implemented full plan (S1–S6) TDD: end-user `listAvailableForCaller` + `PromptTemplateController`, D1 admin `read`→`manage` plane bump, SMR `prompt_template_id` tenant+owner guard, `prompt-template-read` policy + DOCTOR grant, SDK `AVAILABLE` endpoint + `listAvailable`, UI rewired to the end-user hook. All affected package suites + builds green; lints clean. RBAC reseed deferred to owner. |
