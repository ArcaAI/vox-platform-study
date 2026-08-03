# BUG-014 — Live-transcription playground never fires its data queries and renders an infinite skeleton

| Field | Value |
|---|---|
| **Status** | `Review` |
| **Type** | `bugfix` |
| **Branch** | `dev-2.1` |
| **Discovered** | 2026-08-03, live E2E of the live-transcription playground batch-upload tab |
| **Severity** | High — the screen is unusable and gives the operator no information at all |
| **Affected app** | `apps/admin-console` (Next.js 16 console) |
| **Affected surface** | `/playground/live-transcription` (both tabs), feature module `src/features/playground-live-transcription/**` |
| **Not at fault** | `packages/database` RBAC seed, `apps/api` audio routes, the BFF proxy |
| **Related** | BUG-011 (STT batch worker), BUG-012 (global-admin tenant context on the same screen), BUG-013 (internal STT callback tenant scope), TASK-603 (compat batch upload) |
| **Ticket number chosen** | `BUG-014` — `docs/implementation/` contains BUG-010, BUG-011, BUG-012 and BUG-013; 014 is the next free number |

---

## Requirement Analysis

`/playground/live-transcription` is a tier 50–59 playground screen that runs the END-USER audio plane
under the caller's own account (`.claude/rules/12-design-workflow.md` §3; nav entries
`shared/navigation/nav-config.ts:352-363`). Its audience is explicitly *"GLOBAL_ADMIN or
TENANT_ADMIN"* (same file, lines 346-351), and the tier guard
`src/app/(console)/(tenant)/layout.tsx:15` admits both.

A TENANT_ADMIN opening that screen must therefore get a working Pipeline picker and a working
"My jobs" strip, exactly as a GLOBAL_ADMIN does. Two further requirements come from the house rules
and are violated here independently of the trigger:

- `.claude/rules/10-skeleton-loading.md` — a `<Skeleton />` stands in for **data being fetched**. A
  skeleton that is displayed when nothing is being fetched, and that never resolves, is not a
  loading state; it is a dead end.
- `.claude/rules/11-ux-ui-principles.md` §4 (empty states use the `Empty` family, *"never a blank
  area"*) and §5 (*"every action produces visible feedback within 100ms"*, *"disabled buttons need a
  visible reason (tooltip or adjacent text)"*).

**In scope**: why the screen's queries never mount/fetch for the observed session, and the UI's
inability to represent that condition.
**Out of scope**: the gateway tenant-resolution defect (BUG-012), the STT batch worker (BUG-011),
the internal-callback tenant scope (BUG-013).

---

## Current State Evaluation

### 1. Observed evidence (supplied, CONFIRMED)

Session: `POST /api/auth/login {username:'arcaai_admin', password:… , tenantKey:'ARCAAI'}`.
Session projection: `roles ["TENANT_ADMIN"]`, `tenantId 50000000-0000-0000-0000-000000000001`,
`isElevated false`, `workingTenantId null`, `impersonatingUserId null`.
Fresh browser tab, cache-clean, `http://localhost:5176/playground/live-transcription?tab=batch`,
observed at 15 s / 30 s / 50 s:

| Probe | Result |
|---|---|
| `document.querySelector('#pipeline-picker')` | `null` — the `<select>` never mounts |
| `document.querySelectorAll('[data-slot="skeleton"]').length` | **17**, stable indefinitely |
| "Upload & transcribe" | `disabled === true` permanently |
| Page chrome | renders: h1 "Live Transcription", the "Batch upload" card, the drop zone, the "My jobs · owner-scoped · GET /audio/transcription-jobs" heading with 3 skeleton rows |
| Console errors | **zero** |
| Text "No pipelines available" | **absent** — so this is the pending branch, not the empty branch |
| Network, captured from first byte | the **only** BFF request is `POST /api/hope/rbac/check/my-permissions → 201` |
| Manual `GET /api/hope/audio/pipelines` from the same page | **200**, full ArcaAI pipeline list incl. `81000000-0000-0000-0001-000000000117` |
| Manual `GET /api/hope/audio/transcription-jobs` from the same page | **200** `{"data":[{…}],"total":1,…}` |

Contrast (same app, minutes earlier): `super_admin` (GLOBAL_ADMIN, `isElevated true`) with working
tenant ArcaAI — with and without impersonating `arcaai_doctor_bren` — rendered the screen correctly,
the picker populated with 14 pipelines defaulting to `…0117`, and the network log showed repeated
`GET /api/hope/audio/pipelines` and `GET /api/hope/audio/transcription-jobs`.

### 2. The leading hypothesis (an ability-derived `enabled:` gate) is **REFUTED** — CONFIRMED in code

Both queries are declared with **no `enabled` option at all**:

`apps/admin-console/src/features/playground-live-transcription/api/hooks.ts:21-23`

```ts
export function usePlaygroundPipelines() {
  return useQuery({ queryKey: liveTranscriptionKeys.pipelines(), queryFn: listPlaygroundPipelines });
}
```

`…/api/hooks.ts:25-32` — `useMyTranscriptionJobs` likewise declares only `queryKey`, `queryFn`,
`refetchInterval` and `placeholderData`. The only `enabled` in the whole feature is
`usePlaygroundJob` (`hooks.ts:43`, `enabled: !!id`), which is not on this path (no active job).

There is no ability plumbing anywhere between the page and those hooks:

- `POST /rbac/check/my-permissions` is consumed by `usePermissions`
  (`src/shared/auth/hooks.ts:36-45`), whose **only** non-test consumers are
  `src/shared/layout/app-sidebar.tsx:32`, `src/shared/layout/command-palette.tsx:21` and
  `src/shared/auth/require-permission.tsx:20` (verified by grep across `apps/admin-console/src`).
  None of those is on the live-transcription page — `<RequirePermission>` does not appear in the
  feature module or in the playground layouts.
- The QueryClient carries no global gate: `src/shared/providers.tsx:27-38` sets only `staleTime`,
  `retry` and `refetchOnWindowFocus: false`.
- The two genuinely `enabled`-gated queries in the console are elsewhere and are gated on
  *popover open*, not on ability: `src/shared/layout/tenant-switcher.tsx:47` (`enabled: open`) and
  `src/features/playground-shared/components/persona-control.tsx:71`
  (`enabled: open && session.isElevated`). Neither renders for a TENANT_ADMIN on this path
  (`site-header.tsx:18` gates `TenantSwitcher` on `session.isElevated`;
  `persona-control.tsx:78-92` returns the static "Acting as yourself" branch for a non-elevated
  session, and its query is popover-gated in any case).

**Every role gate this screen does have passes for TENANT_ADMIN — CONFIRMED:**

| Gate | File:line | TENANT_ADMIN outcome |
|---|---|---|
| Tier 30–49 route guard | `src/app/(console)/(tenant)/layout.tsx:15` | passes (`roles.includes('TENANT_ADMIN')`) |
| Working-tenant gate | `src/shared/tenant-scope/working-tenant-gate.tsx:47` — blocks only `effectiveIsElevated && !effectiveTenantId` | passes (`isElevated false`) |
| Nav visibility | `src/shared/navigation/nav-config.ts:353` (`required: []`) + `:367-369` `isAdminTier` | passes |

### 3. The RBAC/seed hypothesis is **REFUTED** — CONFIRMED

`packages/database/src/prisma/db_main/seed/01-policy.ts:113` grants the `tenant-full-access` policy
(*"for Tenant Admins"*, line 89) `{ action: 'manage', subject: 'AsrPipeline', conditions: { tenantId:
'${context.tenantId}' } }`. Independently, the runtime proof in §1 settles it: the very same session
cookie gets **200** from `GET /api/hope/audio/pipelines` and **200** from
`GET /api/hope/audio/transcription-jobs` when the request is issued manually. The permission is
present and the gateway grants it. This is not a seed gap.

### 4. What the evidence *does* establish — CONFIRMED

The single request that fired, `POST /api/hope/rbac/check/my-permissions`, originates in the
**persistent console shell** (`app-sidebar.tsx:32` / `command-palette.tsx:21`), which is mounted by
`src/app/(console)/layout.tsx:28,35`. No request originated in the **page segment**.
`useSession` is silent by design and proves nothing: `providers.tsx:46-48` seeds
`['auth','session']` from the server-decrypted projection, so that query never fetches on any run.

So the structural fact is: **the shell's client components ran their effects; the page segment's did
not.** A React Query `useQuery` with no `enabled` cannot stay `status:'pending'` with
`fetchStatus:'idle'` and issue no request if its component actually mounted on the client — mounting
subscribes the observer and triggers the initial fetch. The queries did not mount.

### 5. The skeleton arithmetic corroborates that — CONFIRMED (counting), INFERRED (interpretation)

17 is not a number this page can produce from its own pending branches. Counting every `<Skeleton />`
that can appear on this route:

| Source | File:line | Count |
|---|---|---|
| Console segment Suspense fallback | `src/app/(console)/loading.tsx:7,9,10,11,13` | 5 |
| Route segment Suspense fallback | `src/app/(console)/(tenant)/playground/live-transcription/loading.tsx:9,10,12,15,16,18,20,21` | 8 |
| Pipeline picker, pending branch | `…/components/live-transcription-screen.tsx:96` | 1 |
| "My jobs" strip, pending branch | `…/components/batch-tab.tsx:301-303` | 3 |
| **Total** | | **17** |

The fully-hydrated pending state would be **4**. `ActiveJobCard`'s three skeletons
(`batch-tab.tsx:239-241`) are correctly absent (no `activeJobId`), and `WorkingTenantGate`'s two
(`working-tenant-gate.tsx:37-38`) are correctly absent (the session is seeded) — both of which
confirm the count is being read accurately rather than coincidentally.

**Interpretation (INFERRED):** the DOM simultaneously holds *both* streamed Suspense fallbacks *and*
the page's server-rendered content. That is the signature of an SSR stream whose boundaries were
never completed on the client — the real content is present (which is why `getElementsByText`-style
probes find the "Batch upload" card and the "My jobs" heading) but it is inert server HTML, not a
mounted React tree. Consistent with `#pipeline-picker` being `null`: in that server HTML the picker
*is* the skeleton at `live-transcription-screen.tsx:96`.

### 6. Root cause — candidates, ranked (all INFERRED; §2/§3 refutations are CONFIRMED)

No role-conditional branch exists anywhere between the route and the two queries (§2). Therefore the
role framing of the report is, on the code evidence, **correlation rather than established
causation** — and the two runs differ in a second, uncontrolled variable: the failing run was in a
*freshly created, cache-clean tab* (a cold client-bundle load), the working run was not.

1. **(most likely) The page segment's client bundle never finished loading/compiling, so the segment
   never hydrated.** The route's client graph is unusually heavy for what the batch tab needs:
   `…/api/index.ts:5` re-exports `use-live-stt-session`, which statically imports `@arcaai/stt`
   (`use-live-stt-session.ts:15`) and `@arcaai/vox/core` (`:16`) — the audio-capture/ONNX SDK.
   `batch-tab.tsx:19-30` imports from that same `'../api'` barrel and therefore drags the entire
   audio SDK into a tab that uses none of it. Neither package is in `transpilePackages`
   (`next.config.ts:18`), so both resolve to prebuilt workspace `dist` (present:
   `packages/stt/dist/index.mjs`, `packages/agentic-sdk-v2/dist/core.mjs`) — a stale or
   partially-rebuilt dist is a known failure mode in this repo.
   *Discriminating evidence*: the Network tab filtered to `.js` — a pending or failed
   `/_next/static/chunks/*` request; the `next dev` terminal still compiling the route;
   `document.querySelector('div[hidden][id^="S:"]') !== null` (React's not-yet-swapped content
   holder, proving the `$RC` completion never ran); or simply reloading the same URL a second time
   in the same tab and seeing the screen work.
2. **A throw during hydration of the page subtree** (browser-only global touched at module scope by
   `@arcaai/stt`/`@arcaai/vox/core`, or a missing export in the built dist).
   *Discriminating evidence*: any entry from `read_console_messages({onlyErrors:true})` or the Next
   dev error overlay. The reported "zero console errors" argues against this, but the probe was
   taken after the fact and a hydration error can be swallowed by an error boundary; re-check with
   the console open from first paint.
3. **A genuine TENANT_ADMIN-specific difference.** Ranked last because no such branch exists in the
   console code (§2 table). Accepting it would require the difference to live outside
   `apps/admin-console`, which cannot explain a *client-side* failure to issue a request.
   *Discriminating evidence*: reproduce as `arcaai_admin` in a tab that has already loaded the route
   once. If it works, candidate 3 is dead and candidate 1 is confirmed.

**Reproduction protocol that settles it (owner, ~2 minutes, read-only):** in one browser, load
`/playground/live-transcription` as `arcaai_admin` twice — first in a fresh cache-clean tab, then a
plain reload of the same tab. Then repeat the *fresh cache-clean tab* run as `super_admin`. If the
fresh-tab run fails for both roles and the reload works for both, it is candidate 1 and the role is
irrelevant.

### 7. The infinite skeleton is a defect in its own right — CONFIRMED, independent of §6

Whatever wedges the queries, the screen has no way to say so. Both pending branches test
`isPending` **alone**:

- `live-transcription-screen.tsx:95-97` — `pipelinesQuery.isPending ? <Skeleton …/> : <NativeSelect …>`
- `batch-tab.tsx:298-305` — `if (jobsQuery.isPending) { …3 × <Skeleton/> }`, with the error branch at
  `:306` and the empty branch at `:308` only reachable *after* a fetch settles.

In TanStack Query v5 `status: 'pending'` means "no data yet" and covers three very different
conditions: fetching for the first time (`fetchStatus: 'fetching'`), disabled/never-started
(`fetchStatus: 'idle'`), and paused because the browser is offline (`fetchStatus: 'paused'`). The
screen collapses all three onto the same forever-skeleton. There is no timeout, no `fetchStatus`
check, and no terminal state.

Rule violations, cited:

| Rule | Violation |
|---|---|
| `.claude/rules/10-skeleton-loading.md` (opening paragraph, rule 1) | `<Skeleton />` is specified for *data being fetched*; here it is shown while nothing is being fetched, indefinitely |
| `.claude/rules/11-ux-ui-principles.md` §4 | Empty/terminal states must use the `Empty` component family — icon + title + description, *"never a blank area"*. The screen already has `EmptyState` wired for the zero-rows case (`batch-tab.tsx:308-311`) but nothing for "this never loaded" |
| `.claude/rules/11-ux-ui-principles.md` §5 | *"disabled buttons need a visible reason (tooltip or adjacent text)"* — `batch-tab.tsx:161` renders `disabled={!file || !pipelineId || upload.isPending}` with no reason surfaced. With `pipelineId === null` the control is permanently dead and silent |
| `.claude/rules/11-ux-ui-principles.md` §5 | *"Every action produces visible feedback within 100ms"* / *"never silently succeed or fail"* — a 50-second silent stall is the opposite |

This is the part of the report that is unambiguously a client-side bug and is fixable today.

### 8. Blast radius — CONFIRMED in code

The sibling playground screens declare their queries the same way — no `enabled`, no
never-fetching branch — so they are neither protected from the §6 trigger nor able to report it:

| Screen | Queries | Gate present? |
|---|---|---|
| `/playground/consultation` | `features/playground-consultation/api/hooks.ts:36,41,49,64,73,307` | none ability-derived |
| `/playground/voice-profiles` | `features/playground-voice-profiles/api/hooks.ts:9` | none |
| `/playground/llm` | `features/playground-llm/api/hooks.ts:10,14,26` | none |
| `/playground/dna-writing-style` | `features/playground-dna-style/**` | none found |

Consequence: **the `enabled`-gate pattern does not break these screens (there is no such gate), but
the infinite-skeleton pattern of §7 is repo-wide in the playground tier** — any of them will stall
silently under the same trigger. `/playground/live-transcription` is the worst affected because its
client graph is the heaviest (§6 candidate 1).

Only `/playground/live-transcription` was observed. The other four are **INFERRED** from code shape,
not reproduced.

---

## Implementation Plan

TDD per `.claude/rules/01-development-workflow.md` — the failing tests land first and must be seen
RED. **Primary fix = Step 2** (make "pending but not fetching" a first-class, explained state); it
is the only part backed by CONFIRMED evidence, and it converts a silent stall into a self-diagnosing
one, which is what makes Step 3 verifiable.

### Step 0 — settle §6 before writing code (no code change)

Run the reproduction protocol in §6. Record the outcome in this README's Change History. If it shows
the fresh-tab/cold-bundle signature, Step 3 becomes mandatory rather than recommended; if it shows a
genuine role dependency, reopen §2 — that would mean a gate exists outside the files listed there.

### Step 1 (RED) — regression tests

File: `apps/admin-console/src/features/playground-live-transcription/components/__tests__/live-transcription-screen.test.tsx`
(exists; extend it — do not add a parallel file).

1. **"a query that is pending but not fetching renders an explicit stalled state, not a skeleton"** —
   the ticket's headline assertion. Render `ScreenBody` with a `QueryClient` whose pipelines query is
   forced to `status:'pending' / fetchStatus:'idle'` (mount the hook with `enabled:false` in the test
   wrapper, or seed the query cache with a never-resolving `queryFn` and advance fake timers past the
   stall threshold). Assert:
   - `screen.queryAllByTestId(/skeleton/)` (or `[data-slot="skeleton"]`) is **empty** for the picker
     region after the threshold, and
   - an `EmptyState`-family node is present whose description names the condition, and
   - `getByRole('button', { name: /retry|reload/i })` exists.
2. **Same assertion for the "My jobs" strip** (`batch-tab.tsx` — extend
   `components/__tests__/…`, adding a `batch-tab.test.tsx` if none exists).
3. **"the upload button states its reason when no pipeline is selected"** — render `BatchTab` with
   `pipelineId={null}` and a valid file; assert the button is disabled **and** that an accessible
   reason is associated with it (`aria-describedby` target text, or adjacent text matching
   /pipeline/i). This directly encodes rule 11 §5.
4. **No regression on the happy path** — with a resolved pipelines query, `#pipeline-picker` exists
   and the stalled state is absent.
5. **Permission-denied shape** — with the pipelines query rejected as a `GatewayError` 403/404,
   assert the existing `ErrorState` renders (already wired at `batch-tab.tsx:306-307`) and that no
   skeleton remains. This is the "renders a permission-denied/empty state instead of a perpetual
   skeleton" requirement; note that per the 404-over-403 posture the console will see 404, so assert
   on the rendered copy, not the status.

Run `pnpm --filter @arcaai/admin-console test -- live-transcription` and capture the RED output.

### Step 2 (GREEN) — primary fix: represent "pending but not fetching"

Introduce one shared helper rather than four copies (the playground tier repeats this shape — §8).

New file: `apps/admin-console/src/shared/state/stalled-query.ts`

```ts
/**
 * TanStack v5 `status:'pending'` covers three conditions: fetching, never-started
 * (disabled/unmounted-effects) and offline-paused. A skeleton is only correct for
 * the first (rule 10). This narrows the other two so callers can render a real
 * terminal state instead of an endless placeholder (rule 11 §4).
 */
export function isStalled(query: { isPending: boolean; fetchStatus: 'fetching' | 'paused' | 'idle' }): boolean {
  return query.isPending && query.fetchStatus !== 'fetching';
}
```

Then:

- `…/components/live-transcription-screen.tsx:95-97` — replace the bare `pipelinesQuery.isPending`
  ternary with a three-way branch: `isStalled(pipelinesQuery)` → `EmptyState` (icon + "Pipelines did
  not load" + a description naming the endpoint `GET /audio/pipelines` + a Retry button calling
  `pipelinesQuery.refetch()`); `pipelinesQuery.isPending` → the existing `<Skeleton className="h-9
  w-64" />`; otherwise → the existing `<NativeSelect>`.
- `…/components/batch-tab.tsx:297-312` — insert the same `isStalled(jobsQuery)` branch **above** the
  existing `isPending` branch at `:298`, reusing `EmptyState` (already imported at `:16`) and
  `jobsQuery.refetch()` (already used at `:307`).
- `…/components/batch-tab.tsx:161` — give the disabled control its reason. Keep the `disabled`
  expression, add `aria-describedby="batch-upload-reason"` and render, immediately after the button,
  a `<p id="batch-upload-reason" className="text-muted-foreground text-xs">` whose text is
  `!pipelineId ? 'Select a pipeline first — the picker above has not loaded.' : !file ? 'Choose an
  audio file to enable upload.' : ''`. (Rule 11 §5; also satisfies the "visible reason" half of the
  WCAG-adjacent guidance in §7 of that rule.)

Note the deliberate ordering: `isStalled` must be checked **before** `isPending`, because a stalled
query satisfies both.

### Step 3 (recommended, same ticket — confirm with owner after Step 0) — shrink the page's client graph

`…/api/index.ts:5` re-exports `use-live-stt-session`, which is what pulls `@arcaai/stt` and
`@arcaai/vox/core` into every consumer of the barrel — including `batch-tab.tsx`, which needs
neither. Remove line 5 from the barrel and have `live-transcription-screen.tsx:15` import
`useLiveSttSession` from `'../api/use-live-stt-session'` directly, leaving `batch-tab.tsx:19-30` on
the light barrel. This is a surgical, behaviour-preserving change (rule `_karpathy` §3) that
materially reduces the route's client bundle and directly targets §6 candidate 1.

Verify with `pnpm --filter @arcaai/admin-console build` and compare the route's First Load JS before
and after.

### Step 4 — apply the same guard to the sibling playground screens (§8)

Once `isStalled` exists, add the same three-way branch to the pending skeletons in
`playground-consultation`, `playground-voice-profiles`, `playground-llm` and `playground-dna-style`.
Keep it mechanical; one test per screen asserting the stalled state renders.

### Step 5 — verification (`.claude/rules/13-nextjs-apps.md` §Quality Gates)

1. `pnpm --filter @arcaai/admin-console build lint test` green — paste output.
2. Runtime verification in a running `next dev` via the `next-dev-loop` skill (compiling ≠ working):
   as `arcaai_admin`, fresh cache-clean tab, `/playground/live-transcription?tab=batch` — the picker
   populates, `GET /api/hope/audio/pipelines` and `GET /api/hope/audio/transcription-jobs` appear in
   the network log, and `document.querySelectorAll('[data-slot="skeleton"]').length` settles to 0.
3. Negative check: with the pipelines request blocked (devtools request blocking), the screen must
   show the stalled `EmptyState` with a working Retry, and **no** skeleton, within the threshold.
4. Both themes; axe scan 0 violations on the new states (`.claude/rules/11-ux-ui-principles.md` §11).
5. Re-run the GLOBAL_ADMIN path to confirm no regression.

---

## Implementation Summary

**Step 2 implemented (the CONFIRMED §7 defect). Steps 3 and 4 deliberately NOT taken** — see
"Deliberate follow-ups" below. Step 0 was run and is recorded under "Step 0 result".

### Files changed

| File | Change |
|---|---|
| `apps/admin-console/src/features/playground-live-transcription/lib/stalled-query.ts` | **New.** `isStalledQuery({ isPending, fetchStatus })` → `isPending && fetchStatus !== 'fetching'`. Narrows the two never-resolving members of v5's `pending` status (never-started `'idle'`, offline `'paused'`) away from the one a `<Skeleton />` is specified for. Doc comment states the ordering rule: check it BEFORE `isPending`. |
| `…/components/live-transcription-screen.tsx` | Picker is now three-way. `pickerFailed = !pipelinesQuery.data && (pipelinesQuery.isError || isStalledQuery(pipelinesQuery))` renders an inline `role="status"` control — destructive-bordered, `IconAlertTriangle`, "Pipelines did not load · GET /audio/pipelines", and a `Retry` button (`aria-label="Retry loading pipelines"`) calling `pipelinesQuery.refetch()`. Otherwise `isPending` keeps the existing `<Skeleton className="h-9 w-64" />`, otherwise the existing `<NativeSelect>`. `<Label>` drops `htmlFor` while the fallback is up so it never points at a control that is not rendered. |
| `…/components/batch-tab.tsx` | `MyJobsStrip`: new `isStalledQuery(jobsQuery)` branch inserted **above** the `isPending` branch, rendering the `EmptyState` family (`IconPlugConnectedX` + "Jobs did not load" + a description naming the offline/never-loaded condition and `GET /audio/transcription-jobs`) with a `Retry` action (`aria-label="Retry loading jobs"`). `UploadCard`: new `disabledReason` (no pipeline → "Select a pipeline first…"; no file → "Choose an audio file to enable upload.") rendered as `<p id="batch-upload-reason">` under the button, with `aria-describedby` set on the button only while a reason exists. |
| `…/components/__tests__/live-transcription-screen.test.tsx` | Extended (not forked). New happy-path regression assertion (no skeleton, no stalled copy once both queries settle) and a new `describe` block that reproduces the never-fetching shape for real by seeding `['auth','session']` and flipping TanStack's `onlineManager` offline — no hook mocking. |
| `…/components/__tests__/batch-tab.test.tsx` | **New.** Three tests for the disabled-control reason (rule 11 §5): reason names the pipeline when `pipelineId` is null, names the file when none is chosen, and `aria-describedby` is dropped once the control is actionable. |

Two design decisions worth flagging for review:

1. **The picker fallback is a compact inline control, not the full `Empty` block** the plan sketched.
   `Empty` is a centred `p-6 md:p-12` panel; dropping one into the toolbar row next to the `Pipeline`
   label would dominate the screen. The jobs strip, which owns a card body, does use `EmptyState`.
2. **`pickerFailed` is gated on `!pipelinesQuery.data`.** Caught in runtime verification, not by the
   tests: with the plan's bare `isError ||` form, a *refetch* that 404s over already-cached options
   replaced a perfectly usable 14-entry picker with an error box. Stale options beat no control.
   `isStalledQuery` already implies no data, so the guard only affects the error arm.

### Step 0 result — the §6 reproduction protocol (RUN; verdict **INCONCLUSIVE**, but two candidates refuted)

Run against the live dev server on `:5176` as `arcaai_admin` (TENANT_ADMIN, tenant ARCAAI).

| Probe | Result |
|---|---|
| Fresh navigation to `/playground/live-transcription?tab=batch` | **FAILED** — 17 skeletons, `#pipeline-picker` null, only `POST /api/hope/rbac/check/my-permissions` in the resource log |
| Plain reload of the same, now-warm tab | **FAILED** identically — 17 skeletons, 2 hidden holders, still only `my-permissions` |
| `/account` (unrelated route, no audio SDK anywhere in its graph) | **FAILED** the same way — 1 hidden holder, 15 skeletons, only `my-permissions` |
| Later loads of the same live-transcription URL | **SUCCEEDED** — 0 hidden holders, 0 skeletons, picker populated with 14 pipelines defaulting to `81000000-0000-0000-0001-000000000117`, and both `GET /api/hope/audio/pipelines` and `GET /api/hope/audio/transcription-jobs` in the resource log |
| Console, at every stage | **zero** errors or warnings (only the React DevTools notice and `[HMR] connected`) |
| `/_next/static/chunks/*` | all 33 completed, none zero-byte; slowest 183 ms |

What that settles:

- **Candidate 1 as literally stated ("the client bundle never finished loading", aggravated by the
  heavy `api/index.ts` barrel) is REFUTED.** Every chunk loaded, and `/account` — which imports none
  of `@arcaai/stt` / `@arcaai/vox/core` — stalls the same way. The stall is app-wide, so §8's
  "`/playground/live-transcription` is the worst affected because its client graph is the heaviest"
  does not hold.
- **Candidate 3 (a genuine TENANT_ADMIN-specific difference) is effectively dead.** The *same*
  session both fails and succeeds on the same URL minutes apart. The failure is intermittent.
- **Candidate 2 (a hydration throw) has no direct evidence** — no console error, no dev-overlay error.

What replaces them, mechanically (this also **corrects §5's interpretation**): on a failing load the
page's real content *has* fully streamed to the browser. It sits inside React's not-yet-swapped
holders — `div[hidden][id="S:0"]` (console segment) and `div[hidden][id="S:1"]` (the page, whose text
begins "Live Transcription · Streaming session · runs under your own account · Start session ·
Pipeline · Ready — no active session"). `window.$RC` is *defined* but was never invoked for those
boundaries. So the 17 skeletons decompose as **5 visible** (`(console)/loading.tsx`) **+ 8 inside
hidden `S:0`** (route `loading.tsx`) **+ 4 inside hidden `S:1`** (the page's own pending branches) —
the page's own four were never actually on screen. The failure is the **Suspense-completion swap
never running**, not a missing chunk and not an observed throw.

**Declared confound — the reason this is INCONCLUSIVE rather than closed:** two
`pnpm --filter @arcaai/admin-console build` runs were executed against the same `.next` directory as
the running `next dev` during this session, and the observed stalls cluster around those runs and
around HMR recompiles (the hidden holders reappeared immediately after an HMR update mid-session).
That is a plausible dev-only trigger and it contaminates the measurements. A clean re-run — dev
server restarted, no concurrent `next build` — is needed before candidate 2 can be closed out.

**Corollary that governs the fix:** while a segment is un-hydrated, *no client-side branch can
rescue it* — no client code runs at all. During SSR, TanStack v5's optimistic result reports
`fetchStatus: 'fetching'`, so `isStalledQuery` is correctly `false` and a skeleton is the right
server output. Step 2 therefore fixes genuinely stalled **mounted** queries (offline-paused,
never-started, error-with-no-data) and the reasonless disabled button; it does not and cannot fix the
non-hydration trigger. Both were always separate defects (§7 says so) — this just makes the boundary
explicit.

### Verification evidence

- **RED** (before the fix): `5 failed | 25 passed` — `batch-tab.test.tsx` ×2 on
  `expected null to be truthy` (no `aria-describedby`), `live-transcription-screen.test.tsx` ×3 on
  `Unable to find an element with the text: /pipelines did not load/i` and `/jobs did not load/i`.
- **GREEN**: `Test Files 4 passed (4) · Tests 30 passed (30)` for the feature.
- `pnpm --filter @arcaai/admin-console lint` — clean (`eslint src --max-warnings 0`).
- `pnpm --filter @arcaai/admin-console build` — `✓ Compiled successfully in 14.0s`,
  `✓ Generating static pages (67/67)`.
- Full app suite: `Test Files 1 failed | 159 passed (160) · Tests 4 failed | 1234 passed (1238)`.
  The 4 failures are all in `src/features/playground-llm/components/__tests__/playground-llm-screen.test.tsx`,
  a file this ticket never touched (`git status` confirms); **pre-existing and unrelated**.
- **Runtime, dark theme**: the disabled `Upload & transcribe` renders its reason
  ("Select a pipeline first — the picker above has not produced one yet.") under the button, and with
  `GET /audio/pipelines` forced to 404 the picker region renders
  "⚠ Pipelines did not load · GET /audio/pipelines [Retry]" with **0 skeletons** and no misleading
  "No pipelines available".
- **Runtime, light theme**: the same terminal control and the same reason text
  ("Choose an audio file to enable upload." once a pipeline is selected) render correctly;
  destructive border and muted meta both legible.
- **Runtime, regression guard**: with options already cached and the refetch forced to 404, the
  picker keeps all 14 options and no terminal state appears — the `!pipelinesQuery.data` gate works.

### Deliberate follow-ups (not done here)

1. **Step 3 — splitting the feature `api` barrel.** Not done, and the Step 0 evidence now argues
   against its premise: `/account` stalls identically with none of the audio SDK in its graph. It may
   still be worth doing on bundle-size grounds, but it is no longer a candidate remedy for §6.
2. **Step 4 — rolling the guard across `playground-consultation`, `playground-voice-profiles`,
   `playground-llm` and `playground-dna-style`.** Not done. `isStalledQuery` currently lives inside
   the live-transcription feature, and features must not import each other
   (`.claude/rules/13-nextjs-apps.md` §Structure). Rolling it out means promoting the helper to
   `apps/admin-console/src/shared/state/`, which is outside this change's agreed surface. One ticket,
   one mechanical pass, one test per screen.
3. **The non-hydration trigger itself** — re-run Step 0 on a restarted dev server with no concurrent
   `next build`, and instrument whether the `$RC` completion scripts are emitted at all.
4. **Two adjacent observations, not investigated.** `/dashboard` renders the 404 "Page not found"
   screen for this TENANT_ADMIN; and on one stalled load the sidebar was empty and the ⌘K palette
   returned "No results found" for "live transcription", while later loads rendered the full nav.
   Both smell like the same non-hydration/permissions-timing family.

---

Original diagnosis findings, one line each:

- The report's leading hypothesis — an ability-derived `enabled:` gate — is **REFUTED**: neither
  query declares `enabled`, and `my-permissions` feeds only shell components (§2).
- The seed/RBAC hypothesis is **REFUTED**: `01-policy.ts:113` grants TENANT_ADMIN
  `manage:AsrPipeline`, and the same session gets 200 from both endpoints manually (§3).
- What *is* established: the shell hydrated and the page segment did not, so the queries never
  mounted (§4), corroborated by the 5 + 8 + 4 = 17 skeleton arithmetic (§5).
- The trigger is **not pinned**; three candidates are ranked with discriminating evidence, and the
  role framing is most likely confounded by the cold-tab variable (§6).
- The infinite skeleton and the reasonless disabled button are **CONFIRMED** defects regardless of
  the trigger, and violate rules 10 and 11 §§4–5 (§7). Fixing them is the recommended primary
  change.

Files read during the investigation (no writes):

- `apps/admin-console/src/app/(console)/layout.tsx`, `(console)/loading.tsx`
- `apps/admin-console/src/app/(console)/(tenant)/layout.tsx`
- `apps/admin-console/src/app/(console)/(tenant)/playground/layout.tsx`
- `apps/admin-console/src/app/(console)/(tenant)/playground/live-transcription/{page,loading}.tsx`
- `apps/admin-console/src/features/playground-live-transcription/api/{hooks,client,index,use-live-stt-session}.ts`
- `apps/admin-console/src/features/playground-live-transcription/components/{live-transcription-screen,batch-tab}.tsx`
- `apps/admin-console/src/features/playground-shared/components/{playground-persona-bar,persona-control}.tsx`
- `apps/admin-console/src/shared/{providers.tsx,api/http.ts}`
- `apps/admin-console/src/shared/auth/{hooks.ts,ability.ts,require-permission.tsx}`
- `apps/admin-console/src/shared/layout/{app-sidebar,site-header,tenant-switcher,sidebar-tier-sync}.tsx`
- `apps/admin-console/src/shared/navigation/nav-config.ts`
- `apps/admin-console/src/shared/tenant-scope/working-tenant-gate.tsx`
- `apps/admin-console/next.config.ts`
- `packages/database/src/prisma/db_main/seed/01-policy.ts`
- `docs/implementation/BUG-012-Batch-Upload-Global-Admin-Tenant-Context/README.md`

### Open questions for the owner

1. ~~Run the §6 reproduction protocol.~~ **Done** — see "Step 0 result". Candidates 1 and 3 refuted
   as stated; verdict inconclusive on the true trigger because of a declared `next build`/HMR
   confound. Needs one clean re-run on a restarted dev server.
2. Approve Step 3 (splitting the feature `api` barrel). Its stated justification is now gone
   (`/account` stalls identically without the audio SDK), so it should be judged purely as a
   bundle-size change — or dropped.
3. Approve Step 4 (rolling the stalled-state guard across the other four playground screens). Doing
   it requires promoting `isStalledQuery` from the feature to `src/shared/state/`, which was outside
   this change's agreed surface.

---

## Change History

| Date | Author | Change |
|---|---|---|
| 2026-08-03 | implementation agent | **Step 2 implemented (TDD, RED→GREEN).** New `features/playground-live-transcription/lib/stalled-query.ts` exporting `isStalledQuery` (`isPending && fetchStatus !== 'fetching'`); `live-transcription-screen.tsx` picker becomes a three-way branch with an inline retryable "Pipelines did not load · GET /audio/pipelines" control ahead of the skeleton; `batch-tab.tsx` `MyJobsStrip` gains an `EmptyState` "Jobs did not load" branch **above** its `isPending` branch, and `UploadCard` gains a visible `#batch-upload-reason` wired to the button via `aria-describedby` (rule 11 §5). RED was `5 failed | 25 passed`; GREEN `30 passed (30)`; lint clean; `next build` ✓ 67/67. Full app suite `4 failed | 1234 passed` — all 4 in the untouched `playground-llm` screen test, pre-existing. **Runtime-verified on `:5176` in BOTH themes** as `arcaai_admin`: the reason text renders under the disabled upload button, and a forced 404 on `GET /audio/pipelines` yields the terminal control + Retry with 0 skeletons. Runtime verification also caught a self-inflicted regression, fixed before landing: the plan's bare `isError ||` form replaced a working 14-option picker whenever a *refetch* failed over cached data, so the guard is now `!pipelinesQuery.data && (isError || isStalledQuery(...))`. **Step 0 protocol RUN — verdict INCONCLUSIVE, candidates 1 and 3 REFUTED as stated:** a warm reload fails just like a fresh tab, and `/account` (no audio SDK in its graph) fails identically, so it is neither cold-cache nor the heavy client graph; the same session later succeeds on the same URL, so it is not role-bound but intermittent. Mechanically, the page content *has* fully streamed and sits in `div[hidden][id="S:0"|"S:1"]` with `$RC` defined but never invoked — **corrects §5**: the 17 skeletons are 5 visible + 8 in hidden `S:0` + 4 in hidden `S:1`, so the page's own four were never on screen. Declared confound: two `next build` runs shared `.next` with the running `next dev` and the stalls cluster around them and around HMR recompiles — a clean re-run is needed before candidate 2 can be closed. **Corollary:** an un-hydrated segment runs no client code, and during SSR v5's optimistic result reports `fetchStatus:'fetching'`, so the skeleton is the correct server output — Step 2 fixes stalled *mounted* queries, not the non-hydration trigger. Steps 3 and 4 deliberately deferred (Step 3's premise is now refuted; Step 4 needs `isStalledQuery` promoted to `src/shared/state/`, outside this change's surface). Status `Pending` → `Review`. |
| 2026-08-03 | debugger agent | Ticket created; discovered during live-transcription batch-upload E2E testing on `dev-2.1`. Read-only root-cause analysis. **Refuted** the reported leading hypothesis (ability-derived `enabled:` gate) — `api/hooks.ts:21-32` declares no `enabled`, and `usePermissions` (`shared/auth/hooks.ts:36`) is consumed only by `app-sidebar.tsx:32`, `command-palette.tsx:21` and `require-permission.tsx:20`, none of which is on this route. **Refuted** the seed/RBAC hypothesis — `seed/01-policy.ts:113` grants TENANT_ADMIN `manage:AsrPipeline`, and the same session already gets 200 from both endpoints manually. **Established** that the console shell hydrated while the page segment did not (only the shell's `my-permissions` request fired), corroborated by the exact 17-skeleton count = `(console)/loading.tsx` 5 + route `loading.tsx` 8 + the page's own 4. Trigger not pinned: three ranked candidates with discriminating evidence, cold-bundle/fresh-tab confound called out as the most likely explanation and the role framing flagged as correlation. **Confirmed** an independent client defect: `live-transcription-screen.tsx:95` and `batch-tab.tsx:298` branch on `isPending` alone, so a never-fetching query renders a permanent skeleton (rule 10) with no empty/denied terminal state (rule 11 §4) and `batch-tab.tsx:161` disables the upload control with no stated reason (rule 11 §5); same shape found in all four sibling playground features. Status `Pending`; no code changed. |
