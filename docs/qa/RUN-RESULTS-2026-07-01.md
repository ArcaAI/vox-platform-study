# Admin Console Redesign — E2E Run Results (2026-07-01)

**Scope:** Execute all authored E2E suites for the Admin Console Redesign tickets
**372, 379, 380, 381, 382, 383, 384** against a seeded, dockerized **TEST** stack, and
convert "authored-but-unrun" debt into concrete pass/fail signal.

**Worker:** verification/test-execution. **Stack:** ephemeral test infra only
(`.env.test`, Postgres :5433 / Redis :6380 / MinIO :9002 / Qdrant :6335). No dev/prod touched.
No `git push`, no commits, no raw `DELETE`/`DROP`/`TRUNCATE`.

---

## 1. Stack bring-up log (summary)

| Step | Result |
|---|---|
| Docker daemon | Running (Docker 29.4.0) |
| `docker:test:*` infra | Already up & **healthy** (postgres/redis/minio/qdrant test containers, up ~3h) |
| DB seed (`pnpm test:db:reset`) | **OK** after one fix (see below). Personas + 9 consultations + audit logs + media buckets (`hope-attachments-global`, `hope-audio-global`) seeded |
| API (`pnpm dev:api:test`, :8868) | **Healthy** — `GET /api/v1/health` → `200 {"status":"healthy"}` |
| `npx playwright install chromium` | Installed (Chrome for Testing 149.0.7827.55) |
| Admin dev server (:5174) | Auto-started by Playwright `webServer` for the FE run; torn down after |
| SMR (:8862), STT (:8861), NLP (:8864) | **Down** (not started; only the API + infra were required) |

**Fix applied during bring-up:**
- `pnpm test:db:reset` (→ `prisma db push --force-reset`) was blocked by **Prisma 7's
  AI-agent safety guard**. The user pre-authorized this exact command against the
  ephemeral test DB, and the target was verified as `postgresql://test:test@localhost:5433/hope_test`,
  so it was re-run with `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` set to the user's
  consent text. Seed then completed cleanly. (Re-seeded a second time for a clean FE
  baseline after the backend suite mutated data.)

**Pre-existing process note:** a stale `pnpm dev:api:test` background run (started by a
prior session, output swallowed by `| tail`) had already exited ~1h40m earlier; ports
:8868/:5174 were clear. A fresh API was started for this run.

**Authored-spec compile gate (`--list`, no stack needed):**
- Backend (root `playwright.config.ts`): **379 tests / 35 files** total compile clean
  (the 6 task specs 372/379/380/381/382/383 included).
- Frontend (`apps/admin/playwright.config.ts`): **105 tests / 8 files** compile clean
  (7 task specs + `_smoke`, × desktop/tablet/mobile = 35 each).
- **TASK-384 has no backend spec** — it is frontend-only (responsive).

---

## 2. Per-ticket pass/fail matrix

### 2a. Backend E2E (root config, `.env.test`, fully parallel) — **85 passed / 1 failed**

Command: `pnpm exec dotenv -e .env.test -- playwright test 'task-3(72|79|80|81|82|83)'`

| Ticket | File | Passed | Failed | Notes |
|---|---|---|---|---|
| 372 | `task-372-shared-components.spec.ts` | 7 | 0 | — |
| 379 | `task-379-tenant-detail.spec.ts` | 24 | 0 | OCC / If-Match / isolation all green |
| 380 | `task-380-tenant-dashboard.spec.ts` | 14 | **1** | **TD3** fails (see DEF-1) |
| 381 | `task-381-users-management.spec.ts` | 18 | 0 | full user lifecycle green |
| 382 | `task-382-agent-management.spec.ts` | 15 | 0 | AG10 tolerated SMR-down (see §4) |
| 383 | `task-383-platform-dashboard.spec.ts` | 7 | 0 | cross-tenant data sources green |
| **Total** | | **85** | **1** | runtime ~18s |

**Only backend failure:**
- `TASK-380 › TD3: super_admin reads the admin consultations list (paginated)`
  `apps/api/tests/e2e/task-380-tenant-dashboard.spec.ts:185` — expected `200`, received `400`. **(DEF-1, confirmed-known.)**

### 2b. Frontend E2E (admin config, real UI→API) — **49 passed / 44 failed / 12 skipped**

Command: `pnpm exec playwright test --config apps/admin/playwright.config.ts` (runtime ~1.3m)
The 12 skipped are TASK-372's by-design viewport-conditional cases (mobile-only tests skip
on desktop/tablet and vice-versa) — **not failures**.

Pass / Fail per ticket × viewport:

| Ticket | desktop (P/F) | tablet (P/F) | mobile (P/F) | Dominant cause |
|---|---|---|---|---|
| `_smoke` | 1 / 0 | 1 / 0 | 1 / 0 | — |
| 372 | 4 / 2 | 4 / 2 | 3 / 0 | DEF-6, DEF-7 (test) |
| 379 | 1 / 4 | 1 / 4 | 1 / 4 | DEF-3, DEF-4, DEF-8 (test) |
| 380 | 3 / 2 | 3 / 2 | 3 / 2 | DEF-2 (fixture) + DEF-4 (test) |
| 381 | 3 / 1 | 3 / 1 | 0 / 4 | DEF-5 (test) + DEF-3 (test) |
| 382 | 0 / 2 | 0 / 2 | 0 / 2 | DEF-4 (test) |
| 383 | 2 / 3 | 2 / 3 | 2 / 3 | **DEF-1 (PRODUCT)** |
| 384 | 4 / 0 | 4 / 0 | 3 / 1 | DEF-4 (test) |
| **Totals** | **18 / 14** | **18 / 14** | **13 / 16** | |

**Headline:** every one of the 44 FE failures maps to **8 root causes**. **Only DEF-1 is a real
product defect** (and it is the FE manifestation of the known backend TD3). The other 43 are a
**test-fixture bug (DEF-2)** and **test-selector/timing issues (DEF-3…DEF-8)** — the underlying
pages render correctly (verified via the failure screenshots).

Full failed-test inventory is in §3 (grouped by defect). Raw logs: `/tmp/be-e2e.log`,
`/tmp/fe-e2e.log`; FE screenshots under `apps/admin/test-results/**/test-failed-1.png`.

---

## 3. Consolidated defect list

> Legend: **PRODUCT** = real app defect · **FIXTURE** = E2E harness bug · **TEST** = spec
> selector/timing issue (app behaves correctly). "Do not fix" — diagnosis only.

### DEF-1 — **PRODUCT** (confirmed-known, highest impact) · TASK-380 TD3 + TASK-383 platform dashboard
- **Tickets/tests:** backend `TASK-380 TD3` (1 fail); frontend `TASK-383` frame-10 dashboard
  `:38` (KPIs), `:55` (tenant-scope filter), `:62` (KPI reflow) × 3 viewports (**9 FE fails**).
- **Observed:** `GET /api/v1/admin/consultations?page=1&limit=50` as **super_admin with no
  working tenant** → **HTTP 400** `{"message":"Tenant ID is required","error":"Bad Request","statusCode":400}`
  (reproduced verbatim via curl). The FE Platform Dashboard ("All tenants / cross-tenant view")
  then renders an error card: *"Couldn't load platform metrics … Tenant ID is required"* instead
  of the KPI tiles / consultation chart.
- **Expected:** super_admin in cross-tenant mode can read a (cross-tenant) consultations list →
  `200`; platform dashboard renders KPIs/chart.
- **Error excerpt (backend):** `expect(received).toBe(expected) … Expected: 200 Received: 400` at `task-380…:187`.
- **Root-cause hypothesis:** `AdminConsultationController.list` (`apps/api/src/modules/consultation/admin-consultation.controller.ts:52`)
  delegates to `IConsultationService.listConsultationsForTenant(...)`, which **mandates a tenant
  id** (the `tenantScopeFilter` extension has no tenant in CLS for an unscoped super_admin → throws
  `BadRequest("Tenant ID is required")`). Unlike `/admin/tenants` (which fans out cross-tenant and
  returns `200` for the same token), this endpoint has **no super_admin cross-tenant path**. The
  platform dashboard's metrics fan-out calls a tenant-scoped source while in "All tenants" mode, so
  the whole aggregation fails. Fix direction (not applied): give the admin-consultations list a
  super_admin cross-tenant branch, **or** stop the platform dashboard from calling tenant-scoped
  sources when no working tenant is selected. *(383 monitoring frame-11 tests `:94`/`:113` pass — the
  breakage is isolated to the cross-tenant platform-metrics path.)*

### DEF-2 — **FIXTURE** · admin E2E `tenantAdmin` persona missing `tenantKey`
- **Tickets/tests:** `TASK-380 :115` "tenant-admin: read-only scope" × 3 viewports (**3 fails**).
- **Observed:** `page.waitForURL('**/tenants')` times out (15s) inside `loginAs` for the
  `tenantAdmin` persona.
- **Error excerpt:** `TimeoutError: page.waitForURL: Timeout 15000ms exceeded … waiting for navigation to "**/tenants"` at `fixtures/auth.ts:44`.
- **Root-cause hypothesis:** `apps/admin/e2e/fixtures/auth.ts` defines
  `PERSONAS.tenantAdmin = { username: 'tenant_admin', password: 'password123' }` **with no
  `tenantKey`**, but `tenant_admin` is scoped to `__GLOBAL__` and the backend login helper always
  supplies `tenantKey: '__GLOBAL__'` for it. Without the key the UI login never lands on `/tenants`.
  Fix direction: add `tenantKey: '__GLOBAL__'` to the `tenantAdmin` persona.

### DEF-3 — **TEST** (+ minor product a11y-naming smell) · "Tenant section" vs "Tenant sections" collision
- **Tickets/tests:** `TASK-379 :43`, `:54` (×3); `TASK-381` mobile `:75/:98/:106/:116` (4) — **~10 fails**.
- **Observed:** strict-mode violation — `getByLabel('Tenant section')` / `tabNav.or(sectionSelect)`
  resolves to **2 elements**.
- **Error excerpt:** `strict mode violation: getByLabel('Tenant section') resolved to 2 elements:
  1) <button role="combobox" aria-label="Tenant section"> 2) <nav aria-label="Tenant sections" class="hidden … md:flex">`.
- **Root-cause hypothesis:** the mobile Select uses `aria-label="Tenant section"` (singular) and the
  desktop nav uses `aria-label="Tenant sections"` (plural). A **non-exact** `getByLabel` does a
  case-insensitive substring match, so "Tenant section" matches **both**. The shared
  `openFirstNonSystemTenantUsers` helper (`task-381…:61`) and `task-379` lines 51/60 then explode.
  Fix direction: use `{ exact: true }` in the specs (and/or disambiguate the two accessible names).

### DEF-4 — **TEST** · non-exact `getByText` matches multiple nodes
- **Tickets/tests:** `TASK-382 :55` ("No backing column yet" ×3), `:76` ("Prompt body" ×2) — 6;
  `TASK-380 :67` ("Departments") — 3; `TASK-379 :106` & `TASK-384 :130` ("Create tenant") — 4. **~13 fails**.
- **Observed:** strict-mode violations where a substring matches a descriptive paragraph + the exact
  label, or a title + a submit button, or a nav link + a KPI label.
- **Error excerpts:** `getByText('No backing column yet') resolved to 3 elements`;
  `getByText('Prompt body') resolved to 2`; `getByText('Departments', {exact:true}) resolved to 2`
  (nav `<a>` + KPI `<span>`); `getByRole('dialog').getByText('Create tenant') resolved to 2`
  (`<h2>` title + `<button>` submit).
- **Root-cause hypothesis:** locators are not scoped to a single region/role. **Screenshots confirm
  the pages render correctly** — e.g. the Cardiology department page shows all four agent slots +
  the 2-template instruction library; the mobile Create-tenant dialog renders full-screen.
  Fix direction: scope to `getByRole('heading'/'link'/region)` or use `.first()`/region containers.

### DEF-5 — **TEST** · TASK-381 grid "View" button name mismatch
- **Tickets/tests:** `TASK-381 :75` desktop + tablet (**2 fails**).
- **Observed:** `getByRole('button', { name: 'Toggle columns' })` → element(s) not found.
- **Root-cause hypothesis:** the shipped Users-grid toolbar button has accessible name **"View"**
  (verified in screenshot), not "Toggle columns". Fix direction: query `name: 'View'` (or add an
  `aria-label="Toggle columns"` to the control if that name is desired).

### DEF-6 — **TEST** (+ minor product a11y dup) · TASK-372 duplicate density-toggle aria-label
- **Tickets/tests:** `TASK-372 :103` desktop + tablet (**2 fails**).
- **Observed:** `getByRole('button', { name: 'Switch to compact density' })` resolves to **2** —
  the grid-toolbar density button (`title="Density: comfortable"`) **and** an app-shell density
  toggle (`title="Toggle density"`), both sharing that aria-label.
- **Root-cause hypothesis:** two distinct controls expose the same accessible name. Fix direction:
  scope the test to the grid toolbar; optionally give the two density controls distinct names.

### DEF-7 — **TEST** (timing) · TASK-372 column-count baseline captured too early
- **Tickets/tests:** `TASK-372 :90` desktop + tablet (**2 fails**).
- **Observed:** `expect(getByRole('columnheader')).toHaveCount(before - 1)` → **Expected: -1**,
  Received: 5 (desktop) / 3 (tablet) — i.e. `before` was captured as **0**.
- **Root-cause hypothesis:** the initial `headers.count()` ran before the grid hydrated its
  column headers (later it consistently resolves to 5/3). Product renders the columns fine
  (see Tenants-grid screenshot). Fix direction: await a stable header count before capturing `before`.

### DEF-8 — **TEST** · TASK-379 working-tenant switcher locator mismatch
- **Tickets/tests:** `TASK-379 :79` × 3 viewports (**3 fails**).
- **Observed:** test times out (30s) clicking `getByRole('button', { name: 'Open navigation' })`.
- **Root-cause hypothesis:** the `switcher` locator doesn't match the **visible** bottom-left
  "All tenants / Cross-tenant view" control (confirmed visible on desktop in the screenshot), so
  `switcher.isVisible()` is false and the test wrongly enters the mobile-drawer branch and waits for
  an "Open navigation" button that doesn't exist on desktop. Fix direction: correct the `switcher`
  locator to match the shipped switcher control.

**Defect → failure tally (reconciles to 44 FE + 1 BE):**
DEF-1 = 1 BE + 9 FE · DEF-2 = 3 · DEF-3 = 10 · DEF-4 = 13 · DEF-5 = 2 · DEF-6 = 2 · DEF-7 = 2 · DEF-8 = 3 → **44 FE**.

---

## 4. What was NOT run (and why)

- **SMR-dependent live scoring — TASK-382 AG10 (`POST …/test` with If-Match):** SMR (:8862) was
  **not running** (conda `arcaenv` service not started). The backend AG10 spec is written to
  tolerate this — it verified the OCC gate and accepted the `400` from the down SMR
  (logged `prompt test run returned 400 — SMR likely unavailable; OCC gate verified`) and
  **passed**. True end-to-end SMR scoring is **env-blocked**, not a defect. To exercise it,
  start SMR via `conda run -n arcaenv` (port 8862) and re-run.
- **Manual QA suites (`docs/qa/manual-tests/0X-*.md`, suites 01–09):** treated as SECONDARY per
  brief; **not hand-executed step-by-step**. Instead, the highest-value flows were exercised by the
  automated FE E2E **and** visually verified via the captured screenshots. Coverage mapping:

  | Manual suite | Ticket | Automated coverage executed this run |
  |---|---|---|
  | 01 multi-tenancy-management | 379 | BE 379 (24/24) tenant CRUD/OCC/isolation; FE tenant list/detail (screenshots) |
  | 02 user-access-control | 381 | BE 381 RBAC/default-deny/isolation (X1/X7) green |
  | 03 shared-components | 372 | BE 372 (7/7); FE grid render/search/sort (partial — DEF-6/7 test noise) |
  | 04 tenant-detail | 379 | BE 379 green; FE detail tabs (DEF-3 test noise; page renders) |
  | 05 tenant-dashboard | 380 | BE 380 14/15 (DEF-1); FE super-admin dashboard renders (DEF-2 fixture, DEF-4 selector) |
  | 06 users-management | 381 | BE 381 (18/18) full lifecycle; FE users grid renders (screenshot) |
  | 07 agent-management | 382 | BE 382 (15/15); FE department/agents page renders fully (screenshot) |
  | 08 platform-dashboard-monitoring | 383 | BE 383 (7/7); **FE reveals DEF-1 product defect** |
  | 09 responsive | 384 | FE 384 11/12 (only DEF-4 selector noise; full-screen mobile dialog verified) |

- **Backend TASK-384:** no backend spec exists (responsive is frontend-only) — nothing to run.
- **Other tenant/consultation specs** in the root config (task-258/307/326/330/348/375 etc.) were
  out of scope and not executed.

---

## 5. Bottom line

- **Stack:** healthy test stack stood up (infra + seed + API :8868). Reproducible.
- **Backend:** **85/86 pass.** The lone failure is the **known TD3** 400 (`Tenant ID is required`).
- **Frontend:** **49 pass / 44 fail / 12 skip.** **Exactly one product defect (DEF-1)**, which is
  the FE blast-radius of TD3 (the cross-tenant Platform Dashboard can't load metrics → 9 fails).
  One **fixture bug (DEF-2)** and six **test-selector/timing classes (DEF-3…DEF-8)** account for the
  remaining 34 — the underlying UI renders correctly in all cases (verified via screenshots).
- **Top priority to fix:** **DEF-1** — give `/admin/consultations` (and the platform-metrics
  fan-out) a super_admin cross-tenant path, or stop the "All tenants" dashboard from calling
  tenant-scoped sources. After that, **DEF-2** (one-line fixture fix) unblocks 3 tenant-admin FE
  tests, and **DEF-3** (`exact: true`) unblocks ~10.

---

## 6. Re-run after test-debt fixes (2026-07-01)

Test-side defects DEF-2…DEF-8 were fixed (admin `e2e/**` only) and the suites re-run against
the **same** seeded TEST stack (API :8868 healthy, no re-seed/restart, no commits/pushes).
**DEF-1 is untouched** (PRODUCT, handled under TASK-386) — its 9 frame-10 cases are now marked
`test.describe.fixme` so the green/red signal is unambiguous.

**New counts**

| Suite | Before | After |
|---|---|---|
| Admin FE (`apps/admin/playwright.config.ts`, all 3 viewports) | 49 pass / 44 fail / 12 skip | **84 pass / 0 fail / 21 skip** |
| Backend `task-382-agent-management` | 15/15 | **15/15** (still green after comment/assertion edit) |

`21 skip = 12 pre-existing viewport-conditional skips (372 grid-only vs mobile-only) + 9 DEF-1
fixme (383 frame-10 platform dashboard)`. **No FE reds remain.** The only non-passing FE cases
are the 9 DEF-1 / TASK-386-blocked `fixme`s:
`TASK-383 :45/:62/:69` (platform dashboard frame 10) × {desktop, tablet, mobile}. The
`monitoring (frame 11)` block (`:101/:120`) still runs and **passes**.

**Per-defect change (before → after)**

- **DEF-2 (FIXTURE)** — `apps/admin/e2e/fixtures/auth.ts`: `tenantAdmin` persona
  `{ username:'tenant_admin', password:'password123' }` → added **`tenantKey:'__GLOBAL__'`**
  (matches the seed + the other workspace-scoped personas). Clears the 3 tenant-admin login timeouts.
- **DEF-3** — `task-379` & `task-381`: `page.getByLabel('Tenant section')` / `'User section'` →
  `page.getByRole('combobox', { name: 'Tenant section' })` / `'User section'` (the mobile section
  `Select`; avoids matching the hidden desktop tab-nav `navigation "Tenant sections"`).
- **DEF-4** (non-`exact` `getByText` collisions):
  - `task-380`: KPI labels scoped to `page.locator('[data-slot="stat-card"]').getByText(label, { exact:true })` (label "Departments" was also the sidebar nav link).
  - `task-379`: dialog title `dialog.getByText('Create tenant')` → `dialog.getByRole('heading', { name:'Create tenant' })` (collided with the submit button).
  - `task-382`: `getByText('No backing column yet').first()` and `getByText('Prompt body', { exact:true })`.
- **DEF-5** — `task-381`: the "View" control is a `role=combobox` (`aria-label="Toggle columns"`),
  not a button → `getByRole('button', { name:'Toggle columns' })` → `getByRole('combobox', { name:'Toggle columns' })`.
- **DEF-6** — `task-372`: density toggle scoped to the grid toolbar
  `page.locator('[data-slot="virtualized-data-grid"]').getByRole('button', { name:'Switch to compact density' })`
  (the app-shell header has a duplicate-aria-label density control).
- **DEF-7** — `task-372`: before capturing the baseline column count, await
  `expect(headers.first()).toBeVisible()` + `expect.poll(() => headers.count()).toBeGreaterThan(0)`
  (the early `headers.count()` read 0 before hydration).
- **DEF-8** — `task-379`: open the switcher correctly — `mobile` opens the drawer first, then
  `getByRole('button', { name:/Switch working tenant/i }).filter({ visible:true })`. This surfaced a
  **second masked locator bug** on the same test: "Manage tenants" is a cmdk `CommandItem`
  (`role="option"`, the `asChild` `<Link>` inherits it), so `getByRole('link', { name:'Manage tenants' })`
  → `getByRole('option', { name:'Manage tenants' })`.
- **Stale 382 backend** — `apps/api/tests/e2e/task-382-agent-management.spec.ts`: the SDK
  (`usePrompts.assignToDepartment`) now maps its ergonomic input to the whitelisted body (AG-W
  resolved), so the old "shipped SDK posts the raw shape → end-to-end break" narrative is stale.
  Retitled to **"assign-department rejects a raw `{ promptTemplateId, field }` body (400) — strict
  DTO contract"** and rewrote the comment; the negative assertion is **kept** as a meaningful
  backend input-validation (`forbidNonWhitelisted`) contract.

**Reclassified during the re-run (still test-side, not product):**

- **`task-380 :118` tenant-admin (NEW flake after DEF-2 unblocked login).** Passed **9/9** in
  isolation (`-g … --repeat-each=3`) but flaked under full-suite parallel load. Root cause is the
  **test helper**, not product: `resolveTenantId` did a redundant `page.goto('/tenants')` **hard
  reload** right after `loginAs` already landed there; under contention an early request can fire
  before the bearer is re-wired → 401 → `auth-refresh` → `logout()` → bounce to `/login` (failure
  snapshot = login page). Fixed test-side by reading the persisted bearer
  (`sessionStorage['hope.admin.auth'].state.accessToken`) and fetching `/api/v1/admin/tenants`
  directly via `page.request` (no reload, viewport-independent). Super-admin paths use the same
  helper and stay green.
- **`task-381 :75` tablet "Type" facet.** Not a product bug — the responsive grid **condenses the
  Department/Type columns (and their facets) away on tablet by design** (`condensedColumnIds =
  ['username','roleId','resourceStatus','actions']`). The test over-asserted a tablet "Type" facet.
  Now asserts the **tier-stable Role + Status facets with `{ exact:true }`** (exactness also fixes
  the desktop strict-mode 3-match where "Status" matched the grid's "Status column options" /
  "Reorder resourceStatus column" header buttons).

**Constraints honored:** edits limited to `apps/admin/e2e/**`, the one backend spec
`apps/api/tests/e2e/task-382-agent-management.spec.ts`, and this doc. **No product source**
(`apps/*/src`, `packages/*`) and **no** `docs/qa/traceability|manual-tests` / `docs/implementation`
edits. No re-seed/restart, no destructive SQL, no commits, no pushes.

---

## 7. Consolidated live verification (2026-07-01)

**Worker:** fix-and-verify (SDK OCC + full live FE E2E). **Stack:** the *same* running TEST
stack — API `dev:api:test` on **:8868** (`GET /api/v1/health` → `200`), seeded TEST DB
(`.env.test`, Postgres :5433). **No re-seed, no restart, no commits, no pushes, no destructive SQL.**

Closes the two follow-ups left open above: (1) the SDK **`If-Match`** caveat flagged in
`TASK-387 §5`, and (2) the deferred **live** full-stack FE E2E pass.

### 7.1 Task 1 — SDK `If-Match` (OCC) gap: diagnosed → fixed

**Diagnosis confirmed.** Both routes are `@RequiresIfMatch()`, and both SDK writes used the
plain `patch` (no `If-Match` header) → they would `428 Precondition Required` live:

| Route | Decorator | SDK caller (was plain `patch`) |
|---|---|---|
| `PATCH /admin/tenants/:id` — `tenant.controller.ts` `update()` | `@RequiresIfMatch()` | `useTenants().update` (tenant edit incl. `plan`) |
| `PATCH /admin/departments/:id/prompt-config` — `department.controller.ts` `updatePromptConfig()` | `@RequiresIfMatch()` | `useDepartments().updatePromptConfig` (per-dept DNA slot) |

**Fix (surgical — OCC hooks only).** Adopted the SDK's canonical ETag-echo OCC flow already
used by `useGlobalSettings` / `useUserDepartments` (TASK-379). `useTenants().update` reads the
row ETag then replays it as `If-Match` (`getWithEtag`→`patchWithIfMatch`); `updatePromptConfig`
replays the caller-supplied `expectedVersion` (already passed by the DNA-slot flow) as the
validator. Both keep a plain-`patch` fallback so non-versioned resources don't hard-fail.

Exact diff (the two OCC hunks — everything else in these two files is **pre-existing TASK-387
wiring**, not this change):

```diff
   const update = useCallback(
     (id: string, input: UpdateTenantInput) =>
       execute<Tenant>('update', async (client) => {
-        const updated = await client.patch<Tenant>(TENANT_ENDPOINTS.UPDATE(id), input);
+        // OCC: `PATCH admin/tenants/:id` is `@RequiresIfMatch()`, so a plain PATCH is
+        // rejected `428`. Read the row's current `ETag` and replay it as the strong
+        // `If-Match` validator (canonical getWithEtag→patchWithIfMatch OCC flow); the
+        // server CAS-checks it (`412` on drift). Fall back to a plain PATCH only if the
+        // response carries no `ETag` (non-versioned resource).
+        const { etag } = await client.getWithEtag<Tenant>(TENANT_ENDPOINTS.GET(id));
+        const updated = etag
+          ? await client.patchWithIfMatch<Tenant>(TENANT_ENDPOINTS.UPDATE(id), input, etag)
+          : await client.patch<Tenant>(TENANT_ENDPOINTS.UPDATE(id), input);
         setCurrentTenant(updated);
         setTenants((prev) => prev.map((t) => (t.id === id ? updated : t)));
         return updated;
       }),
```

```diff
   const updatePromptConfig = useCallback(
     (id: string, data: Record<string, unknown>) =>
-      execute<Department>('updatePromptConfig', (client) => client.patch<Department>(DEPARTMENT_ENDPOINTS.PROMPT_CONFIG(id), data)),
+      execute<Department>('updatePromptConfig', (client) => {
+        // OCC: `PATCH admin/departments/:id/prompt-config` is `@RequiresIfMatch()`, so a
+        // plain PATCH is rejected `428`. The caller passes the version it read
+        // (`expectedVersion`); replay it as the strong `If-Match` validator so the server
+        // CAS-checks it (`412` on drift). Fall back to a plain PATCH only when no version
+        // was supplied.
+        const expectedVersion = data?.expectedVersion;
+        return typeof expectedVersion === 'number'
+          ? client.patchWithIfMatch<Department>(DEPARTMENT_ENDPOINTS.PROMPT_CONFIG(id), data, `"${expectedVersion}"`)
+          : client.patch<Department>(DEPARTMENT_ENDPOINTS.PROMPT_CONFIG(id), data);
+      }),
```

**Evidence.** SDK OCC unit tests green — **2 files / 66 tests passed** (`useTenants.test.ts`:
read-ETag→If-Match + no-ETag fallback; `useDepartments.test.ts`: If-Match-when-`expectedVersion`).
SDK **rebuilt** (`pnpm build:sdk`) so the admin dev server serves the fix — admin consumes
`@arcaai/vox` as a built `workspace:*` package; `dist` is gitignored (rebuild invisible to git).
Server-side corroboration in §7.3: the live OCC round-trips pass with `If-Match`.

### 7.2 Task 2 — full live admin FE E2E (all viewports)

`pnpm exec playwright test --config apps/admin/playwright.config.ts` against the live API on
:8868 (Playwright `webServer` auto-started the admin dev server on :5174).

**Result: 96 passed / 12 skipped / 0 failed** (~30s). The 12 skips are the by-design
viewport-conditional cases (mobile-only vs desktop/tablet-only) — not failures.

| Viewport | Passed | Failed | Skipped |
|---|---|---|---|
| desktop | 33 | 0 | 3 |
| tablet | 33 | 0 | 3 |
| mobile | 30 | 0 | 6 |
| **Total** | **96** | **0** | **12** |

> A first parallel run (8 workers, `retries=0`) showed **one** desktop flake —
> `task-380-tenant-dashboard.spec.ts:135 tenant-admin: read-only scope` — the documented
> auth-rehydration race under parallel load. It passed on **tablet + mobile** in that same run,
> **3/3** in isolation (`--repeat-each=3 --workers=1`), and on **all 3 viewports** in the clean
> re-run tabulated above. Pre-existing test-helper race, **unrelated to the SDK change**, not a
> product defect → no spec edit made.

**Newly-wired TASK-387 fields — all green:**
- **Plan (create/edit)** — `task-379` plan `<Select>` in the create-tenant dialog + plan meta on the detail header.
- **Tags** — tenant tags meta rendered on the detail header.
- **Lifecycle (SUSPENDED / ARCHIVED / restore)** — `task-379` lifecycle actions present on normal tenants and **hidden on the system tenant**.
- **Dept members list** — department detail members grid (server-backed `getUsers`).
- **DNA writing-style slot** — `task-382` the 4th default-agent slot is a real wireable slot (no longer a TARGET placeholder).

**DEF-1 platform-dashboard (previously `test.describe.fixme`'d) — now green:** `task-383`
frame-10 platform dashboard (headline + secondary KPIs + consultation chart; Week/Month/Year
presets + super-admin tenant-scope filter; KPI reflow 1→2→4) passes on all 3 viewports now that
**TASK-386** shipped the cross-tenant platform-metrics path (the DEF-1 root cause). The frame-11
monitoring block remains green.

### 7.3 Optional backend re-run (final consolidated green)

`RESET_DB=false … dotenv -e .env.test -- playwright test task-386/387/388` against the live
:8868 (reused the seeded stack, **no reset**). **38 passed / 0 failed** (~4.4s). Directly
corroborates Task 1's fix at the HTTP layer:
- `task-387 #3` — plan fetch + `PATCH` with **If-Match OCC** → round-trips.
- `task-387 #7 D3` — prompt-config `dnaWritingStylePromptId` **OCC** → round-trips.

### 7.4 Product defects found

**None new.** DEF-1 — the only prior product defect — is resolved by TASK-386 and verified green
here (§7.2). No product code was changed beyond the Task-1 SDK OCC hooks.

### 7.5 Constraints honored

Edits limited to the **OCC hooks + their unit tests** in `packages/agentic-sdk-v2`
(`src/hooks/{useTenants,useDepartments}.ts` + `src/hooks/__tests__/{useTenants,useDepartments}.test.ts`),
this doc (§7), and a one-line Change-History note in `docs/implementation/TASK-387-…/README.md`.
**No** other product source, **no** TASK-386/388 source, **no** `docs/qa/traceability|manual-tests`,
Python, or `infrastructure/**` edits. **No** re-seed/restart, **no**
`DELETE`/`DROP`/`TRUNCATE`/destructive SQL, **no** commits, **no** pushes. SDK `dist` rebuilt via
`pnpm build:sdk` (gitignored).
