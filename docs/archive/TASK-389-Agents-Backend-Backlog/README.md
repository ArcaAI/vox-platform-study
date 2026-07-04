# TASK-389 — Agents Backend Backlog (§3a Group D)

| | |
|---|---|
| **Ticket** | TASK-389 |
| **Title** | Prompt `compareVersions` **server-side** diff · test sub-metrics on the SDK `PromptTestResult` |
| **Type** | `feature` (backend + SDK) |
| **Created** | 2026-07-01 |
| **Updated** | 2026-07-01 |
| **Status** | Completed (backend + SDK + tests; FE wiring is a documented follow-up) |
| **Owner** | Backend / Agents |
| **Source review** | `docs/admin-console-open-items-review.md` §3a items **#14, #15** (read-only reference) |
| **Depends on** | TASK-386/387/388 (uncommitted in the working tree — built **on top**, nothing reverted) |
| **Unblocks** | TASK-382 (Agent Management) — server-authoritative version diff (AG8/A3) + playground per-metric breakdown (AG12/A5) |

> **Ticket-number check:** `docs/implementation/` highest existing is **TASK-388**; **TASK-389** is the next free number (confirmed by directory listing 2026-07-01, alongside TASK-390).

---

## 1. Requirement Analysis

Implements **§3a backlog Group D** (the "agents" cluster) — the two Agent-surface items that today are drawn client-side / TARGET in the Admin Console.

| # | Item | Review ref | Layer surface |
|---|---|---|---|
| 14 | Prompt `compareVersions` **server diff** endpoint (today the SDK GETs both versions and diffs client-side) | A3 / AG8 | applications service + DTO + API + SDK |
| 15 | Test sub-metrics on the SDK `PromptTestResult` (map backend `PromptTestMetrics` → the admin display shape) | A5 / AG12 | SDK-only (backend DTO already carries `metrics`) |

### Acceptance criteria

- **#14** — A server endpoint returns a **structured field-level diff** between two versions of a prompt template (per-field `content` / `variables` diffs + a combined line-diff), tenant-scoped + CASL-gated on the existing admin prompt surface. The SDK `compareVersions` calls it (one request) instead of GET-both-then-diff-locally, and still returns the existing `DiffResult` shape (no SDK consumer break).
- **#15** — The SDK `PromptTestResult` carries the per-dimension test metrics. The backend `PromptTestResultResponse.metrics` (a `PromptTestMetrics` object) is mapped into the flat `Record<string, number>` **display shape** the admin Test Playground already consumes (`apps/admin/.../agents/playground-format.ts` → `normalizeMetrics(result.metrics)`), so the per-metric meter bars render real values instead of the TARGET placeholder.

**Net: zero database / domain / migration changes.** Both items are read-only enrichments on existing data.

---

## 2. Current State Evaluation

- **#14** — No server diff endpoint. `packages/agentic-sdk-v2/src/hooks/usePrompts.ts` `compareVersions(id, v1, v2)` does two `GET /admin/prompt-templates/:id/versions/:n`, then serialises `content + variables` and runs `computePromptDiff` (jsdiff `diffLines`) **client-side** (`utils/diffUtils.ts`). The backend already exposes `getVersion(templateId, versionNumber)` (`PromptManagementService`) and per-version GET routes; the diff itself is the only missing piece. `diff@^8.0.4` is a dependency of the SDK but **not** of `packages/applications`.
- **#15** — The backend already computes and returns the breakdown: `PromptManagementService.scoreOutput()` produces `PromptTestMetrics { wordCount, nonEmpty, lengthScore, jsonExpected, jsonValid, variablesDeclared, variableCoverage }`, surfaced on `PromptTestResultResponse.metrics?` (`prompt-management/dto/prompt-test-result.response.ts`). The **SDK** `PromptTestResult` type (`types/prompt.ts`) omits `metrics`, so `usePrompts.test()` never threads it through. The admin reads `(result as { metrics?: Record<string, number> }).metrics` and renders each entry as a `[0,1]` meter — i.e. it expects a **flat numeric display map**, not the raw mixed-type `PromptTestMetrics`.

---

## 3. Product decisions (made + FLAGGED)

1. **#14 endpoint shape = structured field-level diff, superset of `DiffResult`.** `GET /admin/prompt-templates/:id/versions/:from/diff/:to` returns:
   - `promptTemplateId`, `fromVersion`, `toVersion`,
   - `fields[]` — one entry per compared field (`content`, `variables`) with `{ field, changed, before, after, changes: DiffChange[], stats }`,
   - top-level `changes` / `patch` / `stats` — the **combined** serialised line-diff (content + variables), byte-identical to today's client `serializeVersionForDiff` + `computePromptDiff`, so the SDK can keep returning the existing `DiffResult` type with **no consumer break**.
   The server reuses the same `diff` library (jsdiff) as the SDK for parity — added `diff@^8.0.4` to `packages/applications`. **FLAG:** the richer per-field `fields[]` breakdown is available for a future diff UI but is not consumed yet (the SDK maps only the combined `DiffResult`).
2. **#14 route placement + auth.** Added to the existing `PromptManagementController` (`@Controller('admin/prompt-templates')`), inheriting the class-level `@Authorize(['manage','PromptTemplate'])` (same admin surface as the sibling `getVersions`/`getVersion` GET routes — an admin read, not opened to the clinician `read:PromptTemplate` plane). The `/versions/:from/diff/:to` path has a static `diff` segment so it never collides with `:id/versions/:versionNumber` or `.../activate`. Tenant-scoping is enforced by the service (`assertOwnedByTenant`). **FLAG:** if the version diff should also be reachable by the clinician read plane, that's an additive `@CanAny` change.
3. **#15 SDK `metrics` = normalised `[0,1]` display map (primary) + raw typed breakdown (secondary).** `PromptTestResult` gains:
   - `metrics?: Record<string, number>` — the **display map** the admin consumes. Mapping from `PromptTestMetrics` (only the genuinely `[0,1]` dimensions, since the admin renders every entry as a percent meter — raw counts would overflow the bar):
     - `length` = `lengthScore`
     - `nonEmpty` = `nonEmpty ? 1 : 0`
     - `jsonValidity` = `jsonValid ? 1 : 0` — **only when** `jsonExpected` (else omitted)
     - `variableCoverage` = `variableCoverage` — **only when** not `null` (i.e. the template declares variables)
   - `metricDetail?: PromptTestMetrics` — the raw, typed breakdown (word count, declared-variable count, booleans) preserved without loss.
   **FLAG:** the count dimensions (`wordCount`, `variablesDeclared`) are intentionally **excluded** from the `[0,1]` display map (they are informational, not proxy scores) and live only on `metricDetail`. The composite `score` remains the authoritative headline (unchanged, backend-computed).

---

## 4. Implementation Plan (STRICT layer chain + TDD)

**Applications → API → SDK**, RED test first per behaviour. No DB / Domain / migration.

- **#14** — `packages/applications`: add `diff` dep; new DTO `prompt-management/dto/prompt-version-diff.response.ts` (`@ApiProperty`); `PromptManagementService.diffVersions(id, from, to)` (+ `IPromptManagementService` abstract) — loads both versions, builds the field-level + combined diff; barrel export. `apps/api`: `PromptManagementController` `GET :id/versions/:from/diff/:to`. SDK: `PROMPT_TEMPLATE_ENDPOINTS.DIFF(id, from, to)`; repoint `usePrompts.compareVersions` at it (map server `{changes,patch,stats}` → `DiffResult`). Tests: applications unit (`__tests__/prompt-version-diff.test.ts`), API controller unit, SDK hook unit.
- **#15** — SDK-only: extend `types/prompt.ts` `PromptTestResult` (`metrics`, `metricDetail`); add a pure mapper `utils/promptMetrics.ts` (`toPromptTestMetricScores(raw)`); `usePrompts.test()` threads `data.metrics` → mapped display map. Tests: SDK unit for the mapper + hook.
- **E2E** — `apps/api/tests/e2e/task-389-agents-backend-backlog.spec.ts`: `AG-DIFF` (super_admin creates a template, edits it to mint v2, GETs the diff endpoint → structured field-level + combined diff; cross-tenant/404 guard) and `AG-TEST` (run `POST :id/test` → response carries `metrics` breakdown; validates the mapping dimensions). All against throwaway templates (soft-deleted in the block).

---

## 5. Implementation Summary

Both items shipped **backend + SDK + tests**, exactly as planned — **zero DB / Domain / migration changes** (confirmed: no `prisma migrate`, no seed edits).

- **#14 — server-side version diff.** New `GET /admin/prompt-templates/:id/versions/:from/diff/:to` returning `PromptVersionDiffResponse` (per-field `content`/`variables` breakdown **plus** the combined `changes`/`patch`/`stats` line diff). `PromptManagementService.diffVersions()` loads both versions tenant-scoped (reusing `getVersion` + `assertOwnedByTenant`) and diffs with jsdiff (`diff@^8.0.4`, added to `packages/applications` for server/SDK parity). The SDK `compareVersions` now makes **one** request to that route and maps the combined segment back into the existing `DiffResult` — no consumer break, client-side GET-both-then-diff removed.
- **#15 — test sub-metrics on the SDK.** `PromptTestResult` gains `metrics?: Record<string, number>` (the normalized `[0,1]` display map the admin playground consumes) + `metricDetail?: PromptTestMetrics` (the raw typed breakdown). Pure mapper `toPromptTestMetricScores()` folds `PromptTestMetrics` → the display map (length, nonEmpty, conditional jsonValidity/variableCoverage); `usePrompts.test()` threads `data.metrics` through it. Backend DTO already carried `metrics`, so this is SDK-only.

### Auth / product decisions (as flagged in §3)
- #14 lives on the **admin** prompt plane (inherits the controller's `manage:PromptTemplate`); the richer `fields[]` breakdown ships but is not consumed by the SDK yet (combined `DiffResult` only). Opening the diff to the clinician `read` plane would be an additive `@CanAny`.
- #15 excludes count dimensions (`wordCount`, `variablesDeclared`) from the `[0,1]` map (kept on `metricDetail`); the backend-computed composite `score` stays the headline.

---

## 6. Files by layer

**Applications** (`packages/applications`)
- `package.json` — **M**: added `diff@^8.0.4`.
- `src/services/prompt-management/dto/prompt-version-diff.response.ts` — **NEW**: `PromptDiffChangeDto`, `PromptDiffStatsDto`, `PromptFieldDiffDto`, `PromptVersionDiffResponse`.
- `src/services/prompt-management/dto/index.ts` — **M**: barrel export of the new DTO.
- `src/services/prompt-management/IPromptManagementService.ts` — **M**: `diffVersions()` on the abstract.
- `src/services/prompt-management/prompt-management.service.ts` — **M**: `diffVersions()` impl (per-field + combined jsdiff, tenant-scoped).
- `src/services/prompt-management/__tests__/prompt-management.service.test.ts` — **M**: RED→GREEN diff unit tests.

**API** (`apps/api`)
- `src/modules/prompt-management/prompt-management.controller.ts` — **M**: `GET :id/versions/:from/diff/:to` (static `diff` segment; inherits class CASL).
- `src/modules/prompt-management/__tests__/prompt-management.controller.test.ts` — **M**: diff-route unit test.

**SDK** (`packages/agentic-sdk-v2` — `@arcaai/vox`)
- `src/core/constants.ts` — **M**: `PROMPT_TEMPLATE_ENDPOINTS.DIFF(id, from, to)`.
- `src/hooks/usePrompts.ts` — **M**: `compareVersions` → server diff; `test()` threads `metrics`.
- `src/types/prompt.ts` — **M**: `PromptTestResult.metrics` + `metricDetail`.
- `src/utils/promptMetrics.ts` — **NEW**: `toPromptTestMetricScores()`.
- Tests — **M/NEW**: `hooks/__tests__/usePrompts.test.ts`, `types/__tests__/prompt.types.test.ts`, `utils/__tests__/promptMetrics.test.ts`, `core/__tests__/constants.ws4.test.ts` (PROMPT_TEMPLATE count 13→14 for `DIFF`).

**E2E**
- `apps/api/tests/e2e/task-389-agents-backend.spec.ts` — **NEW**: #14 diff round-trip (structured + combined), unknown-id 404, doctor 403. #15 is SDK-only (covered by the mapper/hook units).

> Not owned / not touched: `apps/admin/src/features/agents/*` (diff-model, version-diff, routes) is the FE follow-up (separate effort, out of scope here).

## 7. Verification evidence

- **Unit — applications** (`pnpm --filter @arcaai/applications test:unit`): **Test Files 248 passed | 1 skipped; Tests 5498 passed | 4 skipped** (whole package green, incl. `diffVersions`).
- **Unit — API** (`pnpm --filter @arcaai/api test`): **Test Files 107 passed | 2 skipped; Tests 1867 passed | 4 skipped** (incl. the diff controller route).
- **Unit — SDK (this ticket's files)** (`vitest run usePrompts.test useApiKeys.test useAuditLog.test promptMetrics prompt.types`): **Test Files 5 passed; Tests 123 passed**.
- **Build**: `pnpm build:api` + `pnpm db:generate` + SDK build — clean (run with `dev:api:test` stopped, then restarted).
- **E2E (live, `:8868` seeded TEST DB)** — `SKIP_DB_PRECHECK=true pnpm test:e2e task-389-agents-backend task-390-super-admin-backend`: **19 passed** (task-389 = 3: diff round-trip, 404, doctor-403).
- **Pre-existing ambient SDK failures (NOT this ticket):** the full SDK suite still shows 3 red count-assertions in `constants.ws4.test.ts` — `DNA_STYLE_ENDPOINTS` (14), `DEPARTMENT_ENDPOINTS` (9), `TENANT_ENDPOINTS` (9) — from uncommitted TASK-387/388 endpoint additions whose count tests weren't reconciled. Out of this ticket's ownership (tenant/department/DNA); not touched.

## 8. Change History

| Date | Change | Files |
|---|---|---|
| 2026-07-01 | Ticket created; requirement analysis, current-state, product decisions, plan (§1–§4). | this README |
| 2026-07-01 | Implemented #14 (applications `diffVersions` + DTO + API route + SDK repoint) and #15 (SDK `metrics`/`metricDetail` + mapper). Added E2E `task-389-agents-backend.spec.ts`. Updated `constants.ws4` PROMPT_TEMPLATE count for `DIFF`. Unit/build/E2E green (§7). | §6 files |
