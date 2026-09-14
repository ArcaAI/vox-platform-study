# TASK-973 — Admin Console Filter & Search Repair

**Status:** In Progress
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

_(filled in as lanes merge)_

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-14 | Ticket opened. Root causes RC-1 / RC-2 identified and quantified; fix contract fixed; 5 lanes defined. |
