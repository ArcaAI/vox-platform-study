# TASK-978 — Saving a prompt template no longer mints a version when content did not change

| | |
|---|---|
| **Status** | Review |
| **Type** | bugfix |
| **Branch** | `dev-2.2` |
| **Base** | `5d0d84b1f` |

## Requirement Analysis

Found in a live browser run on 2026-09-16 (ArcaAI tenant): every save of a prompt template in the admin
console minted a new `PromptVersion`, even when only `status` changed.

- "e2e977 A - approved path" went v2 → v3 on a status-only Draft → Published save. v3's content and
  variables match v2 exactly and it has no change reason; the Governance diff v2 ⇄ v3 shows `+0 −0`.
- "e2e977 B - published only" went v1 → v2 on the same kind of save.

Acceptance:

1. A save where only `status` changes mints no version.
2. Resubmitting identical fields mints no version.
3. A real `content` or `variables` change mints exactly one version.
4. `wasApprovedLiveEdit` is set only when an APPROVED template's content or variables actually change.
   Renaming or disabling it does not set the flag.

## Current State Evaluation

`PromptManagementService.updatePromptTemplate` treated a field being present as a change:

```ts
const hasContentChanges = dto.name !== undefined || dto.description !== undefined || dto.content !== undefined
  || dto.variables !== undefined || dto.tags !== undefined;
const wasApprovedLiveEdit = template.status === 'APPROVED' && dto.content !== undefined;
```

`EditTemplateForm` (`apps/admin-console/src/features/prompt-templates/components/template-form-dialog.tsx`)
always sends `name`, `content`, `variables` and `tags`, and leaves out `status` only when it is unchanged.
As a result, every console save called `incrementVersion()` and inserted a `PromptVersion`. Every console
save of an APPROVED template was also audited as a live content edit. API clients use the same service
method, so they hit the same problem.

## Implementation Plan

TDD in `packages/applications/src/services/prompt-management/__tests__/prompt-management.service.test.ts`,
under the new `describe('change detection (value comparison)')` block (10 cases). Then change the service
to compare values instead of checking whether a field is present.

### Decisions taken (owner may override)

| # | Decision | Why |
|---|---|---|
| D-1 | **Only a `content` or `variables` difference mints a version.** A name, description or tags change is still written to the row (OCC `_version` bump, `ResourceUpdated` event), but it creates no `PromptVersion` and leaves `currentVersionNumber` alone. | A `PromptVersion` stores only `content` + `variables`. A version made for a rename would be identical to the one before it: the same `+0 −0` noise this ticket removes. |
| D-2 | `variables`: `null`, absent and `[]` all mean "none declared". Comparison ignores object key order. | v1 of a console-created template stores `null`, while later saves send `[]`. JSONB does not keep key order. |
| D-3 | `description`: `''` and `null` are equal. | The console sends a trimmed empty string for a description that is stored as `null`. |
| D-4 | `tags`: compared as an ordered array. | Postgres `text[]` keeps order. Reordering tags is a real row write, but it never mints a version (D-1). |
| D-5 | A `status` equal to the stored status is not a change. A PATCH whose values all match the stored row gets the existing `No changes to write to.` 400 (`ArgumentInvalidException`). | This is the house `hasChanges` contract (`04-application-services.md`). Before this fix, the same request silently created an empty version. |
| D-6 | The console still sends every field, but **Save is disabled until the form is dirty** (owner, 2026-09-16). Next to the disabled button, the form shows "No changes to save". Dirty means name or description (trimmed), content, status, variables or tags differ from the loaded row. A change reason on its own does not make the form dirty. | Without this, D-5 would turn a pristine Save click into an error toast. The service fix still covers API clients. |

## Implementation Summary

`packages/applications/src/services/prompt-management/prompt-management.service.ts`:

- New module helpers `canonicalJson` (key-sorted JSON) and `sameVariables` (D-2).
- `updatePromptTemplate` now works out `nameChanged`, `descriptionChanged`, `contentChanged`,
  `variablesChanged` and `tagsChanged` by comparing values, and assigns only the fields that differ. This
  keeps entity change tracking (`hasChanges`) accurate. `hasContentChanges = contentChanged || variablesChanged`
  controls `incrementVersion()` and the `PromptVersion` insert. `wasApprovedLiveEdit` now requires
  `hasContentChanges`.
- `status` is assigned only when it differs (D-5).

Tests added (all under `updatePromptTemplate › change detection (value comparison)`):

| Test | Before fix |
|---|---|
| status-only console save does not mint a version | RED |
| identical resubmit → 400, no version | RED |
| stored `null` variables ≡ submitted `[]` | RED |
| variables compared independent of key order | RED |
| empty description ≡ stored `null` | RED |
| real content change mints exactly one version | green (control) |
| real variables change mints a version | green (control) |
| rename/description/tags write the row, no version | RED |
| renaming an APPROVED template is not `wasApprovedLiveEdit` | RED |
| variables-only change to APPROVED IS `wasApprovedLiveEdit` | green (control) |

No migration and no API shape change (the console change is D-6). Existing data is not rewritten: the empty v3 / v2
rows above stay in the history.

### Evidence

```
# RED (before the service change)
× a status-only console save (every other field resubmitted unchanged) does not mint a version
× an identical resubmit with no status change is rejected as "no changes" and mints no version
× treats stored null variables and a submitted empty list as equal (console-created v1)
× compares variables independent of object key order (JSONB reorders keys)
× treats an empty submitted description as equal to a stored null description
× a rename / description / tags change writes the row but does not mint a version
× renaming an APPROVED template (content resubmitted unchanged) is not flagged wasApprovedLiveEdit
Tests  7 failed | 3 passed | 193 skipped (203)

# GREEN — prompt-management suite
Test Files  8 passed (8)
     Tests  263 passed (263)

# pnpm --filter @arcaai/applications test
FAIL  src/services/agentPromotion/__tests__/integration/membership-bounded-sync.integration.test.ts  (needs test DB on :5433 — environmental, known)
Test Files  1 failed | 875 passed | 2 skipped (878)
     Tests  14119 passed | 10 skipped (14129)

# pnpm --filter @arcaai/applications build
rimraf dist tsconfig.tsbuildinfo && tsc   → exit clean

# eslint (touched files): 0 errors; one prettier warning at service line 1518 was already there before this change
```

**Not verified at runtime.** The local gateway was running as another session's `nest start --watch`
process, with the old `@arcaai/applications` code loaded in memory. It was not restarted. To check live:
restart the API, then save a template with only a status change and confirm `currentVersionNumber` and the
Governance version list do not change.

## Change History

| Date | Change |
|---|---|
| 2026-09-16 | Ticket opened from the live-run defect; value-based change detection landed with 10 unit tests (`c86cae87f`). Status Review. |
| 2026-09-16 | Console: `EditTemplateForm` disables Save until the form is dirty, with a visible reason. New `edit-template-form.test.tsx` (5 cases, 4 RED before the change). `prompt-templates-screen.test.tsx` "saves an APPROVED template…" now edits content before saving, since it used to save an unedited form. Gates: `pnpm --filter @arcaai/admin-console test` 341 files / 3279 tests passed; `typecheck` clean; `lint` (`--max-warnings 0`) clean. Not checked in a browser: another chat's `next dev` holds this checkout, and the running API still has the pre-fix service loaded. |
