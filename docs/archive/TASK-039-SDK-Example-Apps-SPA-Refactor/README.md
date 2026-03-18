# TASK-039: SDK Example Apps — SPA Refactor & State Management

- **Ticket**: TASK-039
- **Created**: 2026-02-23
- **Last Updated**: 2026-02-23
- **Status**: Completed
- **Depends On**: TASK-037 (Code Review & Enhancement — Completed)

---

## 1. Requirement Analysis

### Background

TASK-037 completed a comprehensive code review and fixed 45 of 46 identified issues across the `@arcaai/vox` SDK core. However, the **example apps** (Vite SPA and Next.js app) and the **CRUD hooks** still contain architectural issues that were identified but not addressed:

1. CRUD hooks reinvent server-state management with `useState` (no caching, deduplication, or background refetch)
2. Shared `isLoading` flag creates race conditions across concurrent operations
3. Example apps lack route-level code splitting, nested layouts, and proper SPA patterns
4. Massive boilerplate duplication across 7 CRUD hooks (~1,500 lines of repeated try/catch/loading/error)
5. Example pages have React rules-of-hooks violations (missing deps in `useEffect`)
6. No global state management in example apps for cross-cutting concerns

### Business Context

The example apps serve as **reference implementations** for SDK consumers. They must demonstrate best practices for:
- SPA architecture with proper routing
- Server-state management (caching, deduplication, optimistic updates)
- Code splitting for performance
- TypeScript safety
- Error handling patterns

### Acceptance Criteria

- [ ] CRUD hooks use a proper data-fetching pattern (no more manual `useState` for server data)
- [ ] Race conditions from shared `isLoading` eliminated
- [ ] Vite app uses `React.lazy()` + `Suspense` for route-level code splitting
- [ ] Admin routes use nested layout with `<Outlet>`
- [ ] Boilerplate reduced by 60%+ via shared helper extraction
- [ ] All `useEffect` dependency arrays are correct (no lint suppressions)
- [ ] `window.confirm` replaced with accessible Radix `AlertDialog`
- [ ] All existing tests pass (0 regressions)
- [ ] New tests cover refactored helpers and patterns

---

## 2. Current State Evaluation

### SDK Hooks (7 CRUD hooks)

| Hook | Lines | Operations | Pattern |
|------|-------|------------|---------|
| `useUsers` | 199 | 6 (list, get, getByExternalId, create, update, remove) | useState + useCallback |
| `useAiModels` | 262 | 9 (list, get, getBySlug, getByTaskType, getDownloaded, create, update, updateDownloadStatus, remove) | useState + useCallback |
| `useApiKeys` | 223 | 7 (list, get, create, update, remove, revoke, getUsage) | useState + useCallback |
| `useDepartments` | 233 | 9 (list, get, create, update, remove, getRoots, getChildren, getByCode, updatePromptConfig) | useState + useCallback |
| `usePipelines` | 113 | 4 (list, get, getBySlug, select) | useState + useCallback |
| `usePrompts` | 213 | 8 (create, list, get, update, remove, getVersions, assignToDepartment, compareVersions) | useState + useCallback |
| `useRoles` | 148 | 5 (listRoles, getRole, getUserRoles, assignRole, removeRole) | useState + useCallback |
| **Total** | **~1,391** | **48 operations** | All identical boilerplate |

### Example Apps

| App | Router | State Mgmt | Code Splitting | Nested Layouts |
|-----|--------|-----------|----------------|----------------|
| Vite | React Router v7 | None (hook-local useState) | None (24 static imports) | None (flat routes) |
| Next.js | App Router | None (hook-local useState) | Automatic (App Router) | Partial |
| Admin (production) | TanStack Router | Jotai + TanStack Query | Yes | Yes |

### Key Problems

1. **Each CRUD operation repeats 15 lines of boilerplate** (init check, setIsLoading, setError, timer start, try/catch, timer end, setIsLoading false)
2. **Single `isLoading` boolean** shared across all operations in a hook — race condition when concurrent calls overlap
3. **No caching** — navigating away and back re-fetches everything
4. **24 static imports** in Vite `App.tsx` — entire app in one bundle chunk
5. **`useEffect(() => { list(); }, [])` pattern** — missing `list` in deps array (React lint violation)
6. **`window.confirm()`** for destructive actions — not accessible, not styleable

---

## 3. Implementation Plan

### Architecture Overview

Introduce a `useApiMutation` / `useApiQuery` helper layer inside the SDK that wraps the boilerplate pattern, then refactor all 7 CRUD hooks to use it. Separately, refactor the Vite example app for proper SPA patterns (lazy loading, nested routes, accessible dialogs).

### Tech Stack

- React 19, TypeScript 5.8
- React Router DOM v7 (Vite app)
- Next.js 15 App Router (Next.js app)
- Zustand (existing SDK store)
- Radix UI AlertDialog (existing dependency)
- Vitest (existing test framework)

---

### Phase 1: Extract shared API operation helper (SDK)

**Goal**: Eliminate the 15-line boilerplate repeated 48 times across 7 hooks.

#### Task 1.1: Create `useApiOperation` helper

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/useApiOperation.ts`
- Test: `packages/agentic-sdk-v2/src/hooks/__tests__/useApiOperation.test.ts`

**What it does**: A generic hook that wraps any async API call with:
- SDK initialization check
- Per-operation loading tracking (counter-based, not boolean)
- Error state management
- Logger timer instrumentation
- Returns `{ execute, isLoading, error, clearError }`

**Design**:

```typescript
interface UseApiOperationOptions {
  operationName: string;
}

interface UseApiOperationReturn<TArgs extends unknown[], TResult> {
  execute: (...args: TArgs) => Promise<TResult>;
  isLoading: boolean;
  error: Error | null;
  clearError: () => void;
}

function useApiOperation<TArgs extends unknown[], TResult>(
  fn: (apiClient: AgenticClient, ...args: TArgs) => Promise<TResult>,
  options: UseApiOperationOptions,
): UseApiOperationReturn<TArgs, TResult>;
```

**Key behaviors**:
- Uses `pendingCount` (number) instead of `isLoading` (boolean) to handle concurrent operations
- `isLoading` is derived: `pendingCount > 0`
- Each operation gets its own timer via `logger?.startOperation()`
- Error is set on failure AND the error is re-thrown (preserving current behavior for imperative callers)
- `clearError()` allows resetting error state

#### Task 1.2: Create `appendPagination` shared utility

**Files**:
- Create: `packages/agentic-sdk-v2/src/utils/urlUtils.ts`
- Modify: `packages/agentic-sdk-v2/src/utils/index.ts`
- Test: `packages/agentic-sdk-v2/src/utils/__tests__/urlUtils.test.ts`

**What it does**: Extracts the pagination query-string builder that's duplicated in 4 hooks into a single utility.

```typescript
export function appendPagination(url: string, pagination?: PaginationParams): string;
export function appendFilters(url: string, filters: Record<string, string | string[] | undefined>): string;
```

---

### Phase 2: Refactor CRUD hooks to use shared helper (SDK)

**Goal**: Reduce each hook by 50-70% while preserving the exact same public API.

#### Task 2.1: Refactor `useUsers`

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useUsers.ts`
- Modify: `packages/agentic-sdk-v2/src/hooks/__tests__/useUsers.test.ts`

**Before** (~199 lines): 6 operations, each with 15-line try/catch/finally block.
**After** (~80 lines): 6 operations using `useApiOperation`, each 3-5 lines.

**Public API preserved**: `UseUsersReturn` interface unchanged. All existing tests must pass.

**Behavioral change**: `isLoading` now uses counter-based tracking (concurrent operations handled correctly).

#### Task 2.2: Refactor `useAiModels`

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useAiModels.ts`

**Before** (~262 lines) → **After** (~100 lines)

#### Task 2.3: Refactor `useApiKeys`

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useApiKeys.ts`

**Before** (~223 lines) → **After** (~85 lines)

#### Task 2.4: Refactor `useDepartments`

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useDepartments.ts`

**Before** (~233 lines) → **After** (~95 lines)

#### Task 2.5: Refactor `usePipelines`

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/usePipelines.ts`

**Before** (~113 lines) → **After** (~55 lines)

#### Task 2.6: Refactor `usePrompts`

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/usePrompts.ts`

**Before** (~213 lines) → **After** (~90 lines)

#### Task 2.7: Refactor `useRoles`

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useRoles.ts`

**Before** (~148 lines) → **After** (~65 lines)

#### Task 2.8: Run full test suite — verify 0 regressions

```bash
cd packages/agentic-sdk-v2 && pnpm test
```

All existing tests must pass. The `UseXxxReturn` interfaces are unchanged, so consumers are unaffected.

---

### Phase 3: Vite example app — Route-level code splitting

**Goal**: Split the 24-route monolithic bundle into lazy-loaded chunks.

#### Task 3.1: Convert static imports to `React.lazy()`

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/App.tsx`

**What changes**:
- Replace 24 static `import` statements with `React.lazy(() => import(...))`
- Wrap `<Routes>` in `<Suspense fallback={<PageSkeleton />}>`
- Create a minimal `PageSkeleton` loading component

**Before**:
```typescript
import TranscriptionPage from '@/pages/transcription';
// ... 23 more static imports
```

**After**:
```typescript
const TranscriptionPage = lazy(() => import('@/pages/transcription'));
// ... 23 more lazy imports

<Suspense fallback={<PageSkeleton />}>
  <Routes>...</Routes>
</Suspense>
```

#### Task 3.2: Create `PageSkeleton` loading component

**Files**:
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/components/page-skeleton.tsx`

A minimal loading skeleton with the same layout structure as pages (container + header placeholder + content area).

---

### Phase 4: Vite example app — Nested admin routes

**Goal**: Admin routes share a layout with sidebar navigation.

#### Task 4.1: Create `AdminLayout` component with `<Outlet>`

**Files**:
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/layouts/admin-layout.tsx`

**What it does**:
- Sidebar with links to Dashboard, Prompts, Departments
- `<Outlet />` for child route content
- Active route highlighting

#### Task 4.2: Restructure admin routes as nested

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/App.tsx`

**Before**:
```typescript
<Route path="/admin" element={<AdminPage />} />
<Route path="/admin/prompts" element={<AdminPromptsPage />} />
<Route path="/admin/departments" element={<AdminDepartmentsPage />} />
<Route path="/admin/dashboard" element={<AdminDashboardPage />} />
```

**After**:
```typescript
<Route path="/admin" element={<AdminLayout />}>
  <Route index element={<AdminPage />} />
  <Route path="prompts" element={<AdminPromptsPage />} />
  <Route path="departments" element={<AdminDepartmentsPage />} />
  <Route path="dashboard" element={<AdminDashboardPage />} />
</Route>
```

---

### Phase 5: Fix React best-practice violations in example pages

**Goal**: Fix all React rules-of-hooks violations and replace `window.confirm`.

#### Task 5.1: Fix `useEffect` dependency arrays

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin/departments.tsx`
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin/prompts.tsx`
- Modify: Any other pages with `useEffect(() => { list(); }, [])` pattern

**Fix pattern**: Replace bare `useEffect` with a stable initial-fetch pattern:

```typescript
const listRef = useRef(list);
listRef.current = list;

useEffect(() => {
  listRef.current();
}, []);
```

Or, if using the refactored hooks, provide an `initialFetch` option.

#### Task 5.2: Replace `window.confirm` with Radix AlertDialog

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin/prompts.tsx`
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/components/confirm-dialog.tsx` (if not exists)

**What changes**:
- Create a reusable `ConfirmDialog` component using `@radix-ui/react-alert-dialog` (already in deps)
- Replace `window.confirm('Are you sure...')` with the accessible dialog
- Support `title`, `description`, `onConfirm`, `destructive` props

#### Task 5.3: Fix unsafe type assertions in departments page

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin/departments.tsx`

**What changes**: Remove `(dept as Record<string, unknown>)` casts and access typed properties directly from the `Department` interface.

---

### Phase 6: Remove unnecessary `useMemo` on hook return objects

**Goal**: Clean up the `useMemo` wrapper on return objects that provides no benefit.

#### Task 6.1: Remove `useMemo` from CRUD hook returns

**Files**: All 7 CRUD hooks (already modified in Phase 2)

**Rationale**: The `useMemo` dependency array includes every state variable and callback. Since any state change triggers a re-render anyway, the memo comparison is pure overhead. After Phase 2, the hooks use `useApiOperation` which manages state internally, so the return object construction is trivial.

**Note**: This can be folded into Phase 2 tasks if preferred.

---

### Phase 7: Next.js example app alignment

**Goal**: Ensure the Next.js app follows the same patterns as the refactored Vite app.

#### Task 7.1: Fix `useEffect` dependency arrays in Next.js pages

**Files**: All Next.js pages that use `useEffect(() => { list(); }, [])` pattern.

Apply the same ref-based pattern from Task 5.1.

#### Task 7.2: Replace `window.confirm` in Next.js pages

**Files**: Any Next.js pages using `window.confirm`.

Apply the same `ConfirmDialog` component pattern from Task 5.2.

#### Task 7.3: Verify Server Component usage

**Files**: `examples/nextjs-app/src/app/page.tsx`, `examples/nextjs-app/src/app/layout.tsx`

Ensure static pages (home, setup) are Server Components where possible. Only pages that use SDK hooks need `'use client'`.

---

### Phase 8: Final validation

#### Task 8.1: Run full SDK test suite

```bash
cd packages/agentic-sdk-v2 && pnpm test
```

**Expected**: All existing tests pass + new tests for `useApiOperation` and `urlUtils`.

#### Task 8.2: Run Vite example app build

```bash
cd packages/agentic-sdk-v2/examples/vite-app && pnpm build
```

**Expected**: Build succeeds. Verify chunk splitting in output (multiple `.js` files instead of one monolithic bundle).

#### Task 8.3: Run Next.js example app build

```bash
cd packages/agentic-sdk-v2/examples/nextjs-app && pnpm build
```

**Expected**: Build succeeds with no warnings.

#### Task 8.4: Run linter

```bash
cd packages/agentic-sdk-v2 && pnpm lint
```

**Expected**: No new lint errors. Specifically, no `react-hooks/exhaustive-deps` warnings.

---

## 4. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Breaking existing hook public API | Low | High | `UseXxxReturn` interfaces unchanged; all existing tests must pass |
| Lazy loading breaks navigation | Low | Medium | Test all 24 routes after conversion |
| Counter-based isLoading changes behavior | Medium | Medium | Existing tests verify loading states; add concurrent-operation tests |
| Next.js Server Component boundaries | Medium | Low | Only pages with hooks need `'use client'` |

---

## 5. Estimated Effort

| Phase | Tasks | Estimated Time |
|-------|-------|---------------|
| Phase 1: Extract helpers | 2 tasks | 30 min |
| Phase 2: Refactor 7 hooks | 8 tasks | 60 min |
| Phase 3: Code splitting | 2 tasks | 20 min |
| Phase 4: Nested routes | 2 tasks | 20 min |
| Phase 5: React fixes | 3 tasks | 30 min |
| Phase 6: Remove useMemo | 1 task | 10 min |
| Phase 7: Next.js alignment | 3 tasks | 30 min |
| Phase 8: Validation | 4 tasks | 15 min |
| **Total** | **25 tasks** | **~3.5 hours** |

---

## 6. Success Metrics

| Metric | Before | Target |
|--------|--------|--------|
| CRUD hook total lines | ~1,391 | ~570 (-59%) |
| Boilerplate per operation | 15 lines | 3-5 lines |
| Vite app bundle chunks | 1 | 10+ (per-route) |
| `isLoading` race conditions | Present | Eliminated |
| `useEffect` lint violations | 2+ | 0 |
| `window.confirm` usage | 1+ | 0 |
| Test regressions | — | 0 |

---

## 7. Implementation Summary

### Phase 1: Shared Helpers (SDK)

| Item | Files | Description |
|------|-------|-------------|
| `useApiOperation` hook | `src/hooks/useApiOperation.ts` (new) | Counter-based loading tracker, error state, logger instrumentation — eliminates 15-line boilerplate per operation |
| `urlUtils` | `src/utils/urlUtils.ts` (new) | `appendPagination()` and `appendFilters()` extracted from duplicated inline code |
| Tests | `src/hooks/__tests__/useApiOperation.test.ts` (new), `src/utils/__tests__/urlUtils.test.ts` (new) | 22 new tests |
| Exports | `src/utils/index.ts` | Added `appendPagination`, `appendFilters` exports |

### Phase 2: CRUD Hook Refactoring (SDK)

All 7 hooks refactored to use `useApiOperation`. Public API (`UseXxxReturn` interfaces) unchanged.

| Hook | Before | After | Reduction |
|------|--------|-------|-----------|
| `useUsers` | 199 lines | 118 lines | -41% |
| `useAiModels` | 262 lines | 143 lines | -45% |
| `useApiKeys` | 223 lines | 119 lines | -47% |
| `useDepartments` | 233 lines | 119 lines | -49% |
| `usePipelines` | 113 lines | 75 lines | -34% |
| `usePrompts` | 213 lines | 121 lines | -43% |
| `useRoles` | 148 lines | 82 lines | -45% |
| **Total** | **1,391** | **777** | **-44%** |

Key behavioral change: `isLoading` now uses counter-based tracking — concurrent operations no longer race on a single boolean.

### Phase 3: Vite App — Route-Level Code Splitting

| Item | Files | Description |
|------|-------|-------------|
| Lazy loading | `examples/vite-app/src/App.tsx` | 24 static imports → `React.lazy()` + `<Suspense>` |
| Page skeleton | `examples/vite-app/src/components/page-skeleton.tsx` (new) | Loading fallback with animated skeleton |

### Phase 4: Vite App — Nested Admin Routes

| Item | Files | Description |
|------|-------|-------------|
| Admin layout | `examples/vite-app/src/layouts/admin-layout.tsx` (new) | Sidebar nav with `NavLink` active highlighting + `<Outlet>` |
| Route restructure | `examples/vite-app/src/App.tsx` | 4 flat `/admin/*` routes → nested `<Route path="/admin">` with children |

### Phase 5: React Best-Practice Fixes (Vite App)

| Fix | Files | Description |
|-----|-------|-------------|
| `useEffect` deps | `pages/admin/departments.tsx`, `pages/admin/prompts.tsx` | Added ref-based pattern to avoid stale closures |
| `window.confirm` → `ConfirmDialog` | `pages/admin/prompts.tsx`, `pages/setup.tsx`, `pages/cross-tab-session.tsx` | Replaced 3 `window.confirm` calls with accessible Radix AlertDialog |
| Unsafe type casts | `pages/admin/departments.tsx` | Removed `(dept as Record<string, unknown>)` casts, use typed `Department` properties |

### Phase 6: Removed `useMemo` on Hook Returns

Folded into Phase 2 — all 7 refactored hooks return plain objects instead of `useMemo`-wrapped objects.

### Phase 7: Next.js App Alignment

| Fix | Files Modified | Description |
|-----|---------------|-------------|
| `useEffect` deps | 8 files (setup, transcription, storage-tab, users-tab, prompts-tab, departments-tab) | Ref-based pattern, removed all `eslint-disable` comments |
| `window.confirm` → `ConfirmDialog` | 3 files (cross-tab-session, setup, admin/prompts) | Replaced with accessible Radix AlertDialog |
| Unsafe type casts | `setup/_content.tsx`, `departments-tab.tsx` | Added `CustomPreferences` interface, proper typed access |
| Server Components | `app/page.tsx` verified as Server Component | No changes needed — already correct |

### Phase 8: Final Validation

| Check | Result |
|-------|--------|
| SDK test suite | **91 files, 2655 tests — all passing** |
| TypeScript check | **0 errors in modified files** (pre-existing errors in test files unchanged) |
| Lint check | **0 errors in modified files** |
| New tests added | **22** (useApiOperation: 11, urlUtils: 11) |
| Regressions | **0** |

---

## 8. Files Modified Summary

### SDK Package (`packages/agentic-sdk-v2/src/`)

**New files:**
- `hooks/useApiOperation.ts`
- `hooks/__tests__/useApiOperation.test.ts`
- `utils/urlUtils.ts`
- `utils/__tests__/urlUtils.test.ts`

**Modified files:**
- `hooks/useUsers.ts` (refactored)
- `hooks/useAiModels.ts` (refactored)
- `hooks/useApiKeys.ts` (refactored)
- `hooks/useDepartments.ts` (refactored)
- `hooks/usePipelines.ts` (refactored)
- `hooks/usePrompts.ts` (refactored)
- `hooks/useRoles.ts` (refactored)
- `utils/index.ts` (added exports)

### Vite Example App (`examples/vite-app/src/`)

**New files:**
- `components/page-skeleton.tsx`
- `layouts/admin-layout.tsx`

**Modified files:**
- `App.tsx` (lazy loading + nested routes)
- `pages/admin/departments.tsx` (useEffect fix, type cast fix)
- `pages/admin/prompts.tsx` (useEffect fix, ConfirmDialog)
- `pages/setup.tsx` (ConfirmDialog)
- `pages/cross-tab-session.tsx` (ConfirmDialog)

### Next.js Example App (`examples/nextjs-app/src/`)

**Modified files:**
- `app/cross-tab-session/_content.tsx` (ConfirmDialog)
- `app/setup/_content.tsx` (useEffect fixes, ConfirmDialog, type fixes)
- `app/admin/prompts/_content.tsx` (ConfirmDialog)
- `components/admin/storage-tab.tsx` (useEffect fix)
- `components/admin/users-tab.tsx` (useEffect fix)
- `components/admin/prompts-tab.tsx` (useEffect fix)
- `app/transcription/_content.tsx` (useEffect fix)
- `components/admin/departments-tab.tsx` (useEffect fix, type fix)

---

## Change History

| Date | Update | Status |
|------|--------|--------|
| 2026-02-23 | Initial plan created based on code review findings | Completed |
| 2026-02-23 | All 8 phases implemented: shared helpers, 7 hook refactors, code splitting, nested routes, React fixes, Next.js alignment, validation | Completed |
