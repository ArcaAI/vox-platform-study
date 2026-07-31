# TASK-592 — Compat SMR Integration: Playground UI + Department-Aware Template Rewire + Tenant Text-Gen Provider Consolidation

**Status:** Review
**Type:** feature
**Branch:** dev-2.1
**Builds on:** TASK-562 (compat SMR summary endpoints), TASK-588 (tenant-configurable SMR selection), TASK-546 (department default agents), TASK-575 (unified BYO providers)

## Requirement Analysis

Let an end-user drive **pre-summarization → summarization** through the v1-compat SMR API from the compat playground, providing **visit type + department**, with the department mapped to HOPE v2 core business logic (real tenant `Department` + governed instruction templates). The compat APIs must read the request body, start summarization using the **correct department instruction template**, and have a **primary provider** and a **default fallback LLM provider** available. Additionally, consolidate a best-practice tenant-admin UX to set the LLM provider for summarization and a **default LLM provider for the tenant-editable text-generation tasks** (built-in or BYO key).

Decisions (product owner, this session):
- Full scope: playground + admin + gateway fixes.
- Department mapping: **rewire to real tenant `Department` entities** (not the v1-ported static table).
- Text-gen default: **tenant default over the allowed (tenant-editable) tasks**; platform-locked tasks surfaced read-only.

## Current State Evaluation

- **SDK** `@arcaai/vox/compat` (`useSMR`): already builds exact v1 bodies for `presummary` + `summary/sync` and supports the presummary→summary chain. No change needed.
- **Gateway shim** `apps/api/src/modules/smr-compat/`: read the body correctly, but mapped `department` via a hand-ported static table (`dept-templates.ts`) disconnected from real tenant departments (Medicine/General silently got no steering); pre-summary did raw-string passthrough with **no provider fallback** (asymmetric with summary).
- **Playground** `apps/compat-playground`: had **no** SMR UI, no department/visit-type inputs.
- **Admin** `apps/admin-console`: summarization provider selection existed (`/ai-configuration` SMR tab); no "default text-gen provider"; BYO credentials duplicated across `/ai-configuration` and `/ai-providers`.
- **Reusable resolver found:** `PromptResolutionService.resolve({ departmentId, promptType })` (`packages/applications/src/services/consultation/prompt/prompt-resolution.service.ts:149`) — the canonical, tenant-safe, APPROVED-gated resolver used by the non-compat summary/pre-summary processors. Returns the governed, version-pinned prompt `content`.

## Implementation Plan

**A. Gateway (done):** bridge the compat department NAME → real tenant `Department` UUID, resolve the governed instruction template via `PromptResolutionService`, feed its content into the prompt builders (fall back to the static table when unmatched), and add pre-summary provider-fallback parity.

**B. Playground:** `SummaryCard` — department picker (live-fetch tenant departments, free-text fallback), visit-type + clinical inputs, `useSMR` presummary→summary chain, rendered results.

**C. Admin:** a "Default text-generation provider" control writing the tenant-editable `smr.*` keys in one action; read-only deep-links for platform-locked tasks; dedup BYO credential UIs to `/ai-providers`.

## Implementation Summary

### Workstream A — Gateway department-aware template rewire ✅ (code-complete, unit-verified)

New files (`apps/api/src/modules/smr-compat/`):
- `department-match.ts` — pure `matchTenantDepartment(departments, needle)`: matches a free-form department string to a tenant `Department` row by exact code, exact name, then v1 synonym-canonical key (reuses `resolveDepartmentKey`). Returns `null` → caller uses the static backstop.
- `smr-compat-template.service.ts` — `SmrCompatTemplateService`: injects `DepartmentRepository` + `PromptResolutionService`; `resolveGovernedInstruction(tenantId, department, promptType)` loads the tenant's departments, matches, resolves the governed template `content`, and returns it — or `undefined` (static fallback) when unmatched / SYSTEM-default / on any error (never throws). `toSummaryPromptType` maps visit type → `new-patient` | `revisit`.

Modified:
- `summary-prompt.builder.ts` — both builders accept an optional `governedInstruction`; when present it becomes the authoritative clinical steering (superseding the static dept×visit field set) while the v1 wire-schema directive is still appended so the response shape is unchanged.
- `smr-compat.controller.ts` — injects `SmrCompatTemplateService`; `computeSummary`/`streamSummary` resolve governed steering before building the prompt; **pre-summary now has provider-fallback parity** (one retry on the tenant fallback for provider-side failures; start-fallback for the stream).
- `smr-compat.module.ts` — imports `PromptResolutionServiceModule` + `CoreDatabaseModule`, provides `SmrCompatTemplateService`.

Tests: new `department-match.test.ts`, `smr-compat-template.service.test.ts`; extended `smr-compat.controller.test.ts` (governed steering + pre-summary fallback parity + cross-tenant scoping) and `summary-prompt.builder.test.ts`. **95 tests pass** across the module; `pnpm --filter @arcaai/api typecheck` and eslint on the module are clean.

### Workstream B — Playground SMR UI ✅ (typecheck + component tests green)

`apps/compat-playground/`:
- New `src/components/SummaryCard.tsx` — department picker (fetches tenant departments, `<Skeleton>` while loading, free-text fallback on 401/403/empty), visit-type select (New Patient / Revisit / Referral + custom), clinical-context inputs (age/dob/gender/vitals/test-results/previous-visits), transcript source (live lines prop or paste-in), Pre-summarize + Summarize buttons chaining `preSummarize` → `summarizeSync` (`preSummaryText` + `includePreSummaryInContext`), Enhanced/Simplified/SOAP renderers, `@arcaai/ui` + semantic tokens + `sonner` toasts.
- New `src/lib/departments.ts` — `fetchDepartments(apiEndpoint, apiKey)` → `GET {apiEndpoint}/api/v1/admin/departments` with `x-api-key`, defensive mapping (array or `data`/`items`/`results`; `code ?? name` submit value).
- Modified `SessionWorkspace.tsx` (renders `SummaryCard` in column 3 with `transcriptLines`), `src/lib/config-store.ts` (persist department/visitType defaults), `README.md`.
- Test infra added (`vitest.config.ts`, `src/test/setup.ts`, test devDeps) + `__tests__/SummaryCard.test.tsx` (presummary result feeds `preSummaryText`; department free-text fallback on fetch failure). Typecheck clean, 2 tests pass.
- Note: `/admin/departments` is `@CanManage('Department')` — a playground key without that ability always falls back to free-text (handled gracefully).

### Workstream C — Admin text-gen provider consolidation ✅ (build + typecheck + lint + 1269 tests green)

`apps/admin-console/` (client-only, no backend change):
- New `smr-default-provider-control.tsx` (top of the SMR tab) — one provider/model choice fans out to `smr.live` + `smr.finalize` (+ optional matching fallback), a convenience writer over the existing per-key `PUT admin/ai-task-defaults/row?taskKey=` (reuses `usePutTaskDefaultRow`, per-key OCC/If-Match, CLS-pinned). No new task key/descriptor/migration. Per-key cards remain for override.
- New `platform-managed-textgen-summary.tsx` — read-only effective model for the platform-locked keys (guardrail.*/nlp.*/harness.judge) with a "global admin" badge + deep link to the Effective view. No writes.
- BYO dedup — new `byo-credential-summary.tsx` (masked Configured/None + deep link to `/ai-providers`, the one authoritative editor); deleted the duplicate editable `byo-credential-card.tsx`; removed the Cloud-credentials tab from `MUTATING_TABS`; trimmed the now-orphaned write client/hooks (read lane retained).
- Deferred: unifying the two mirrored BYO type modules (cross-feature; would need `src/shared` relocation) — recommend a scoped follow-up.
- Colocated tests + axe scans; `pnpm build`/`typecheck`/`lint` clean, 1269 tests pass.

## Verification

- A: `cd apps/api && npx vitest run src/modules/smr-compat` → 6 files / 95 tests pass. `pnpm --filter @arcaai/api typecheck` clean; `eslint src/modules/smr-compat/**/*.ts` clean.
- B/C: see each workstream's gate commands (typecheck/test/lint for `@arcaai/compat-playground` and `@arcaai/admin-console`).
- **Owner tails (live E2E):** stand up `pnpm stack:dev -- api smr` with a tenant that has an APPROVED department PromptTemplate + a configured `smr.finalize` provider; from the playground (`pnpm compat:dev`, :5177) pick the department and run pre-summary → summary; confirm the governed template steered the SMR request and the fallback engaged on a forced primary failure. Reproduce the two provided v1 curls (`summary/sync`, `presummary`) against `:8868` for parity.

## Change History

- **2026-07-31** — Ticket created. All three workstreams implemented and gate-verified: A (gateway, 95 tests + typecheck + lint), B (playground, typecheck + 2 component tests), C (admin, build + typecheck + lint + 1269 tests). Status → Review. Staged/uncommitted; owner tails below.

## Owner Tails

- **Commit** the change set (concurrent same-tree sessions can revert uncommitted work — stage early).
- **`pnpm install`** — Workstream B added test devDeps + `vitest.config.ts` to `apps/compat-playground`; refresh the lockfile.
- **Live E2E** (see Verification): seed a tenant with an APPROVED department PromptTemplate (authored via `/agents` governance) + a configured `smr.finalize` provider so the governed template actually steers; without an approved template the shim correctly falls back to static v1 steering. Reproduce the two v1 curls for parity; force a primary-provider failure to confirm the pre-summary fallback.
- **Figma design gate (rule 12)** for the new playground `SummaryCard` and the admin default-provider control — waive-or-approve consistent with prior compat tickets (586/588 waived it).
- **Deferred follow-up:** unify the two mirrored BYO provider type modules in the admin console (relocate to `src/shared`).
- **env:sync** if any new runtime env var is introduced (none added by this ticket).
