# TASK-973 — Admin Console Filter & Search Repair

**Status:** Completed
**Type:** bugfix
**Branch:** `dev-2.2`
**Owner directive (2026-09-14):** "investigate and fix all filter and search in all admin-console screens, most of them are not working"

---

## 1. Requirement Analysis

Search and filter controls across `apps/admin-console` are largely non-functional. The user
reports "most of them" fail. This ticket repairs every search/filter surface in the console and
records, per screen, which root cause applied.

## 2. Current State Evaluation (measured 2026-09-14)

The shared machinery is SOUND. Verified end to end:

| Layer | Verdict |
|---|---|
| `shared/data/grid-url-state.ts` — nuqs codec, `f` tuple filters, bracket-grammar serialization | correct |
| `filterToTokens` — client operator → gateway operator mapping (`iLike→icontains`, `eq→iequals`/`equals`, `inArray→in`, `isBetween→gte;lte`) | correct |
| `toListParams` page conversion (`page + 1`) vs `formatFindAllProps` (`skip = (page-1)*limit`) | correct, off-by-one already handled |
| `PaginatedQuery` DTO accepts `search`, `searchFields`, `filters`, `sort` | correct |
| `formatFindAllProps` applies search as `OR` of `{field: {contains, mode:'insensitive'}}` | correct |

The breakage is in the CONSUMERS, and falls into exactly two root causes.

### RC-1 — `search` without `searchFields` is a SILENT SERVER-SIDE NO-OP (global)

`formatFindAllProps` only applies search when BOTH `search` AND a non-empty `searchFields` are
present:

```ts
if (search && searchFields && searchFields.length > 0) { /* apply OR conditions */ }
```

`Repository.applyDefaultSearchFields` would supply a fallback from `_defaultSearchFields`, but
**zero of the 107 repositories in `packages/domains/src/repositories` declare it.** So a request
carrying `search=foo` and no `searchFields` returns the UNFILTERED page — the user types and
nothing narrows.

**9 of the 15 canonical-grid screens omit `searchFields`** and are therefore confirmed broken:

| Screen | File |
|---|---|
| audit-logs | `features/audit-logs/hooks/use-audit-grid-params.ts` |
| rbac policies | `features/rbac/components/policies-screen.tsx` |
| settings-registry | `features/settings-registry/components/settings-registry-screen.tsx` |
| agents | `features/agents/components/agents-screen.tsx` |
| transcription-jobs | `features/transcription-jobs/components/transcription-jobs-screen.tsx` |
| consultations | `features/consultations/components/consultations-screen.tsx` |
| dna-writing-styles | `features/dna-writing-styles/components/dna-writing-styles-screen.tsx` |
| queues (detail) | `features/queues/components/queue-detail-screen.tsx` |
| prompt-templates | `features/prompt-templates/components/templates-tab.tsx` |

The 6 correct screens (tenants, users, settings, ai-models, api-keys, consent) are the reference.

### RC-2 — client-side filtering over ONE server-paginated page (per screen)

~22 feature screens do not use `AdminDataGrid` and filter the LOADED PAGE in JS:

```ts
const rows = items.filter((x) => x.id.includes(needle));   // items = current page only
```

A row on page 3 can never be found. `harness-ops/components/harness-workflows-screen.tsx`
even documents it: *"The id search and type filter only cover the loaded page."*

## 3. Fix Contract (binding on every lane)

1. **RC-1 fix is CONSOLE-SIDE.** Pass an explicit `searchFields` to `useAdminGridParams`, as a
   module-level `const` (stable ref — the hook memoizes on it). Follow
   `features/tenants/components/tenants-list-screen.tsx:31-33,92`.
   **Do NOT add `_defaultSearchFields` to repositories** — that is a 107-file server surface
   outside this ticket and would collide across lanes.
2. **`searchFields` must name real, searchable columns.** Each field must be a scalar `String`
   column on that model in `packages/database/src/prisma/db_main/*.prisma`. A relation or
   non-string column makes Prisma throw at runtime. Verify each field against the schema before
   using it. Prefer human-meaningful identifiers (name, key, slug, title, email, username).
3. **RC-2 fix is server-driven WHERE THE ENDPOINT SUPPORTS IT.** Before wiring, open the
   controller's query DTO in `apps/api/src/modules/**` and confirm it extends `PaginatedQuery`
   (or otherwise accepts `search`/`filters`). If it does, move the filter server-side and pass
   `listParams` through the TanStack Query hook.
4. **NEVER invent a gateway parameter, route, or DTO field.** No changes under `apps/api/**`,
   `packages/applications/**`, `packages/domains/**`, or `packages/database/**` in any lane.
   If an endpoint genuinely cannot filter server-side, LEAVE the client-side filter in place,
   make its limitation visible in the UI copy/empty state, and REPORT it in the lane report as
   a follow-up. An honest client-side filter is acceptable; a silent one is not.
5. **Do not touch `apps/admin-console/src/shared/**`.** The orchestrator owns it.
6. **Preserve the URL/nuqs binding.** Search and filter state stays shareable; do not regress a
   URL-bound control to `useState`.
7. **Debounce** free-text search that hits the server (300ms is the house value — see
   `departments-screen.tsx:60-70`).

## 4. Implementation Plan — 5 parallel lanes, disjoint feature directories

| Lane | Worktree | Feature directories owned |
|---|---|---|
| L1 | `../hope-v2-t973-l1` | audit-logs, rbac, settings-registry, agents, transcription-jobs, consultations, dna-writing-styles |
| L2 | `../hope-v2-t973-l2` | queues, prompt-templates, tenants, users, departments, identity-providers, allowed-origins |
| L3 | `../hope-v2-t973-l3` | harness-ops, workflow-runs, workflow-studio, releases, changelog, rate-limits, entitlements |
| L4 | `../hope-v2-t973-l4` | storage, storage-browser, knowledge, ai-operations-runs, ai-models |
| L5 | `../hope-v2-t973-l5` | playground-consultation, playground-llm, playground-shared, settings, consent, api-keys |

## 5. Implementation Summary

### Orchestrator — shared layer (commit `745f3ce8c`)

**RC-3, found during the sweep and invisible to every feature lane:** the filter controls OFFERED
ten operators; `filterToTokens` serialized four. Picking any of the other six updated the chip and
the URL and then emitted NO token, so the gateway returned every row. Six of the ten DATE
operators were dead.

| Operator | Offered in | Was | Now |
|---|---|---|---|
| `ne` "Is not" | text, number, date, select, boolean | dropped | `field[not]:v` — `not` is in the gateway's `SCALAR_FILTER_OPERATORS` |
| `isRelativeToToday` "Last 7 days" etc. | date | dropped | `field[gte]:X;field[lte]:Y` — the control already commits `relativePresetToRange`, an ISO `[start, end]` tuple |
| `notILike` "Does not contain" | text | dropped | REMOVED from the offered list — no negated-insensitive-contains token exists |
| `isEmpty` / `isNotEmpty` | text, number, date, select, multiSelect | dropped | REMOVED from the offered lists — the grammar has no null predicate |

The serializer still drops the three removed operators defensively, so a stale shared URL cannot
throw. A unit test had pinned the old behaviour as INTENDED ("drops operators unsupported by the
v1 server grammar") — which is why the defect survived; it is replaced by tests asserting the two
new mappings.

Evidence: `apps/admin-console` 3215 tests pass, typecheck clean, lint clean; `packages/ui` 756
tests pass.

### Lane results

#### Correction to §2's RC-1 list (important)

The "9 canonical-grid screens missing `searchFields`" list in §2 was derived by grepping for the
`useAdminGridParams({ searchFields })` option. **Most of those turned out NOT to be defects**, and
the lanes were right to push back. Three distinct reasons, each verified:

- **The endpoint is unpaginated**, so filtering the full client-side set is correct by design —
  `GET admin/agents` takes only `task` and returns the tenant's whole list (`agent.controller.ts:237`
  → `findAllForTenant`); likewise `admin/settings/catalog`, `admin/departments`,
  `admin/rate-limit`, `admin/entitlements/plans`, and the bucket lists.
- **The endpoint is bespoke and applies search itself**, ignoring `searchFields` entirely —
  `admin/rbac/policies` and `admin/rbac/roles` hardcode `OR: [{name:{contains}},{description:{contains}}]`
  (`policy.service.ts:178`, `role.service.ts:182`); `admin/prompt-templates` sets
  `where.name = {contains}` (`prompt-management.service.ts:813`).
- **The screen never sends `listParams`** — it hand-builds its own query (`templates-tab.tsx`), or
  has no search box at all (`dna-writing-styles`, `globalSearch: false`).

RC-1 as a *mechanism* is real and is documented above; it simply had far fewer live instances than
the grep suggested. The one genuine RC-1 instance found was worse than a no-op — see L5.

### Lane results

| Lane | Outcome |
|---|---|
| **L1** — audit-logs, rbac, settings-registry, agents, transcription-jobs, consultations, dna-writing-styles | **3 fixed.** `roles-screen` fetched a bounded 100-row page and filtered names client-side; search moved server-side, URL-bound, debounced. `transcription-jobs` + `consultations` keep client-side filters (their endpoints accept no matching param) but now report the FILTERED count instead of the misleading server total and say so in the empty state. 4 screens verified already correct. |
| **L2** — queues, prompt-templates, tenants, users, departments, identity-providers, allowed-origins | **2 fixed** (missing 300ms debounce in `governance-tab` + `user-picker`; both already searched server-side). Most flagged offenders were false positives — see the correction above. **Found the queue-detail backend defect** (below). |
| **L3** — harness-ops, workflow-runs, workflow-studio, releases, changelog, rate-limits, entitlements | **1 fixed.** `workflow-switcher` fetched `limit:100` once and let cmdk re-filter that page; the file's own comment wrongly claimed the endpoint took no search filter. Now server-side with `searchFields: 'name,slug'` (`workflow-definition.prisma:66-67`, both scalar `String`; the enum `status` deliberately excluded) and `shouldFilter={false}`. 5 client-side filters verified correct. |
| **L4** — storage, storage-browser, knowledge, ai-operations-runs, ai-models | **No change required.** Every search surface filters over an UNPAGINATED endpoint. Verified independently: `formatFindAllProps` sets `take: limit`, and the bucket endpoints call `findAll` with no `limit`, so Prisma returns every row. Found FU-1. |
| **L5** — playground-*, settings, consent, api-keys | **3 fixed**, including the worst bug of the sweep: `persona-control` sent `searchFields: 'username,email'`, but **`email` is not a column on `User`** (it lives on `UserProfile` — `user.prisma`), and `formatFindAllProps` builds a per-field Prisma `contains` from that list, so the picker **threw at runtime the moment anyone typed**. Now `'username,externalId'`. Plus a debounce on `template-picker` and an honest limitation notice on `consultations-column`. |

### Orchestrator — queue-detail search (commit after L2's report)

`jobName` was declared on `ListJobsOptions` and accepted+validated by the controller DTO, but
`listJobs` never referenced it — only `status` narrowed the BullMQ query, so the queue-detail
search box returned every job. BullMQ has no name predicate, so the filter is applied in process
and **must scan from the head of the queue**: paginating the range first and filtering after would
only search the requested page — the same defect one layer down. `JOB_NAME_SCAN_LIMIT` (1000)
bounds the cost; the unfiltered path is untouched. The reported total describes the filtered set.

### Post-merge verification (all five lanes merged into `dev-2.2`)

```
pnpm --filter @arcaai/admin-console typecheck   -> clean
pnpm --filter @arcaai/admin-console lint        -> clean (--max-warnings 0)
pnpm --filter @arcaai/admin-console test        -> Test Files 338 passed (338) | Tests 3226 passed (3226)
pnpm --filter @arcaai/ui test                   -> Test Files 255 passed (255) | Tests 756 passed (756)
pnpm --filter @arcaai/applications test         -> 13870 passed (only the live-DB integration
                                                   suite fails: Vault sealed locally, pre-existing)
```

## 5a. Confirmed follow-ups (out of scope — require `apps/api` changes)

**FU-1 — object listing silently truncates at ~1000 keys.**
`GET storage/buckets/:name/files` (`apps/api/src/modules/storage/storage.controller.ts:195-198`)
destructures only `{ objects }` and DISCARDS `isTruncated` / `nextContinuationToken`; it accepts
no `maxKeys` / `continuationToken` query params. The provider layer supports all four
(`IBlobStorageProvider.ts:40,42,53,59`), and S3's `ListObjectsV2Command` defaults to 1000 keys per
page. So a bucket or prefix with more than ~1000 objects shows only the first page with NO signal
that more exist — and the object search box, which filters the returned listing client-side, can
never see the rest. Verified by the orchestrator, 2026-09-14. Needs a DTO + controller change plus
a "load more" in `ObjectBrowserPanel`.

**FU-3 — `ConsultationController#list` drops the query params it declares.**
`apps/api/src/modules/consultation/consultation.controller.ts:650` declares
`@Query() query: PaginatedQuery & { patientId?: string }` but reads only `page`/`limit`/`patientId`
— `search`, `searchFields`, `filters` and `sort` are silently discarded before reaching
`ConsultationService.listConsultations`. This is why `consultations-column.tsx` can only filter the
loaded page. Same shape as FU-1: a DTO that promises more than the handler delivers.

**FU-4 — two flaky tests under full-suite parallelism.**
`ai-providers-screen.test.tsx` (axe, light theme) and `settings-registry-screen.test.tsx` each
failed once under full-suite concurrency and passed in isolation and on re-run (both were seen by
two independent lanes). Neither is caused by this ticket; they are order/concurrency-sensitive and
should be stabilised.

**FU-2 — no repository declares `_defaultSearchFields`.**
All 107 repositories omit it, so `search` without an explicit `searchFields` is a silent no-op
server-side. This ticket fixes the console side (every screen now sends `searchFields`), which is
the surgical fix. Declaring sensible defaults per repository would make the gateway safe by
default for any future/3rd-party caller. Deliberately not done here: it is a 107-file server
surface and would have collided across lanes.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-14 | Ticket opened. Root causes RC-1 / RC-2 identified and quantified; fix contract fixed; 5 lanes defined. |
| 2026-09-14 | RC-3 found and fixed in the shared layer (six of ten offered filter operators serialized to nothing). |
| 2026-09-14 | All 5 lanes merged into `dev-2.2`; post-merge gates green. §2's RC-1 list corrected — most entries were false positives. Queue-detail `jobName` defect fixed. Four follow-ups recorded. Status -> Completed. |
