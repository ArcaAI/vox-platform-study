# TASK-979 — Agents console: honour the `?task=` deep link, and show schema defaults in enum controls

**Status:** Completed

## Requirement Analysis

Two independent defects in `apps/admin-console/src/features/agents/**`:

1. **`?task=` deep link does not filter.** The Agents grid keeps its filter state in the `f`
   URL param (`grid-url-state.ts`'s positional-tuple codec) and never reads a bare `task` param.
   Four call sites link with `?task=SPEECH_TO_TEXT` expecting the grid to filter to that task:
   - `apps/admin-console/src/features/playground-voice-profiles/components/enrollment-blocked-card.tsx`
   - `apps/admin-console/src/app/(console)/(tenant)/audio/pipelines/page.tsx` (redirect)
   - `apps/admin-console/src/app/(console)/(tenant)/ai-model-defaults/page.tsx` (redirect)
   - `apps/admin-console/src/app/(console)/(tenant)/ai-configuration/page.tsx` (redirect)

   All four land on the unfiltered list today (verified live 2026-09-16: "30 of 30 shown", zero
   Speech-to-text rows visible on the first page).

2. **Enum controls hide the schema's declared default.** `ScalarField`'s enum branch
   (`parameters-form.tsx`) renders a bare `<Select>` with `placeholder="Default"` whenever the
   stored value is `undefined`, even when the JSON Schema declares a real `default` the gateway
   resolver actually applies (e.g. `audioFrontEnd.diarization.backend` defaults to `'embedding'`,
   `TEXT_GENERATION.responseFormat` to `'text'`, `TEXT_GENERATION.memory` to `'none'`). The
   boolean branch of the same component was fixed for this exact class of bug under TASK-977
   (`effectiveValue = value ?? schema.default ?? false`); the enum branch never got the
   equivalent fix.

## Current State Evaluation

- `agents-screen.tsx`'s `AgentsBody` derives `task`/`status`/`owner`/`tags` filter arrays from
  `query.queryState.filters` (the `f` param, via `useAdminGridParams`/`selectValues`). Nothing in
  the component reads a `task` search param.
- `ScalarField`'s enum branch (`parameters-form.tsx:112-135`) computes
  `value={value === undefined ? '' : String(value)}` — a bare presence check, no `schema.default`
  fallback. The boolean branch three lines below it already carries the TASK-977 fix
  (`effectiveValue = value === undefined ? schema.default === true : value === true`).
- `AGENT_TASKS` (`apps/admin-console/src/features/agents/api/types.ts`) is the console's own copy
  of `@arcaai/workflow-contract`'s `AGENT_TASKS` (`SPEECH_TO_TEXT`, `TEXT_GENERATION`,
  `TEXT_TO_SPEECH`, `NAMED_ENTITY_RECOGNITION`) — verified byte-identical; it is already imported
  and used by `agents-screen.tsx` for the Task filter's facet options, so it is the natural
  validation list for the deep-link value (no new cross-package import needed).
- Enum fields carrying a declared `default` today: `TEXT_GENERATION.responseFormat` (`'text'`),
  `TEXT_GENERATION.memory` (`'none'`), `SPEECH_TO_TEXT.audioFrontEnd.diarization.backend`
  (`'embedding'`). `TEXT_TO_SPEECH.format` and `.../denoise.level` are enums with NO declared
  default — their "Default" placeholder must stay unchanged.

## Implementation Plan

1. **`agents-screen.tsx`** — read `task` via a plain `useQueryState('task', parseAsString.withDefault(''))`,
   and in a **mount-only** `useEffect` (empty deps — the deep link is a fresh navigation, consumed
   exactly once): if the value is a real `AgentTask` (checked against `AGENT_TASKS`), translate it
   into an `f` filter rule (`{ id: 'task', operator: 'inArray', variant: 'multiSelect', value: [task] }`,
   the exact shape the grid's own multiSelect Task column facet already produces) and drop `task`
   from the URL in the same effect. This keeps `f` the SINGLE source of truth for "what is the
   active filter" — reading `task` reactively (rather than consuming it once) would make the
   filter un-clearable, since a lingering `task=` param would re-seed the rule the instant the
   admin cleared it. An unrecognised `task` value is silently ignored (still cleared from the URL,
   never applied).
2. **`parameters-form.tsx`** — mirror the TASK-977 boolean-branch fix in the enum branch of
   `ScalarField`: `effectiveValue = value === undefined ? schema.default : value`, rendered as the
   Select's controlled value (`String(effectiveValue)` when defined, else `''` so the existing
   "Default" placeholder shows). `onValueChange` is unchanged — picking a value always writes it
   explicitly, exactly as it does today.
3. TDD: failing tests first in both features' `__tests__`, covering the acceptance criteria below.

### TDD test list

- `agents-screen.task979.test.tsx`:
  - `?task=SPEECH_TO_TEXT` seeds the Task filter and narrows the grid to that task's agents.
  - the consumed `task` param is dropped from the URL and translated into the `f` param.
  - an unrecognised `task` value is ignored (no crash, unfiltered list).
  - clearing the filter afterwards (via the grid's own "Clear filters" control) actually clears
    it — the consumed `task` param does not linger to re-seed it.
- `parameters-form.task979.test.tsx`:
  - `TEXT_GENERATION.responseFormat`/`memory` render their schema defaults (`'text'`/`'none'`)
    when unset.
  - `SPEECH_TO_TEXT.audioFrontEnd.diarization.backend` renders its schema default (`'embedding'`)
    when unset.
  - an explicit stored value wins over the schema default.
  - an enum with no schema default (`TEXT_TO_SPEECH.format`) still shows the "Default" placeholder.
  - picking a value writes it explicitly.

### Verification criteria

- `pnpm --filter @arcaai/admin-console test`
- `pnpm --filter @arcaai/admin-console typecheck`
- `pnpm --filter @arcaai/admin-console lint`
- `pnpm --filter @arcaai/admin-console build`

## Implementation Summary

Both fixes shipped exactly as planned, no scope creep:

- `apps/admin-console/src/features/agents/components/agents-screen.tsx` — added the mount-only
  `?task=` consumption effect (11 new lines + a `useQueryState('task', ...)`).
- `apps/admin-console/src/features/agents/components/parameters-form.tsx` — the enum branch now
  computes `effectiveValue` the same way the boolean branch already does (2 lines changed).
- No change was needed to the four link sources (`enrollment-blocked-card.tsx`, the three retired
  redirect pages) — they already link with `?task=SPEECH_TO_TEXT`, which now works.

### Files changed

- `apps/admin-console/src/features/agents/components/agents-screen.tsx`
- `apps/admin-console/src/features/agents/components/parameters-form.tsx`
- `apps/admin-console/src/features/agents/components/__tests__/agents-screen.task979.test.tsx` (new)
- `apps/admin-console/src/features/agents/components/__tests__/parameters-form.task979.test.tsx` (new)

### Evidence

```
$ pnpm --filter @arcaai/admin-console test
 Test Files  342 passed (342)
      Tests  3283 passed (3283)
   Start at  21:50:06
   Duration  71.32s
[exited with code 0]
```

```
$ pnpm --filter @arcaai/admin-console typecheck
> tsc --noEmit
[exited with code 0]
```

```
$ pnpm --filter @arcaai/admin-console lint
> eslint src --max-warnings 0
[exited with code 0]
```

```
$ pnpm --filter @arcaai/admin-console build
✓ Compiled successfully
[... every route, including /audio/pipelines, /ai-model-defaults, /ai-configuration, /agents ...]
[exited with code 0]
```

A handful of `AggregateError: connect ECONNREFUSED :3000` lines appear in the `test` run's
stderr — these are pre-existing noise from an unrelated test's teardown elsewhere in the 342-file
suite (present before this change, confirmed by an isolated run of only the two new test files),
not a failure: the run's own summary and exit code are both green.

### A test-harness finding worth recording (not a product defect)

Writing the `?task=` deep-link tests surfaced a genuine quirk of `NuqsTestingAdapter`
(`nuqs/adapters/testing`) used by `renderWithProviders` (`@/test/render`): with its default
`hasMemory: false`, a state write made by the app (via a mount effect, in this case) is reported
through `onUrlUpdate` but is NOT fed back into a live re-render once an unrelated async update
(here, `useAgents()`'s fetch resolving) forces nuqs to resync — the resync reads from the
adapter's own un-mutated store and the optimistic local value is lost. Flipping `hasMemory: true`
does not fix it either: `NuqsTestingAdapter` also runs its own mount-time "sync to initial
searchParams" effect, which (child effects firing before parent effects) runs AFTER the screen's
own effect and overwrites it right back to the initial URL. Both of these are properties of the
test double, not of real browsers/Next.js routing (where `router.replace` persists). The existing
test suite already works around this by asserting exclusively through `onUrlUpdate` for this class
of self-triggered update (see `users-list-screen.test.tsx`'s sort-header test) and never checks a
live re-render driven purely by an internal nuqs round-trip; `agents-screen.task979.test.tsx`
follows the same convention, and separately proves the grid actually filters by mounting with the
exact `f` encoding the translation produces.

## Change History

- 2026-09-16 — Initial implementation (this ticket). Both defects fixed under TDD, all four
  success-criteria commands green (see Evidence above). Commits `fix(task-979): …` on branch
  `worktree-agent-a4b944de8fb3d991c`.
- 2026-09-16 — Merged into `dev-2.2`. Post-merge gates in the primary checkout (now also carrying TASK-978's
  console change): `admin-console` 343 files / 3288 tests, typecheck and lint clean. Verified in a signed-in
  browser against the live console as `arcaai_admin`:
  `/agents?task=SPEECH_TO_TEXT` → "2 of 30 shown", both `realtime-transcription` versions, URL settled to
  `?f=[["task","inArray","multiSelect",["SPEECH_TO_TEXT"]]]` with no `task=`; **Clear filters** → "30 of 30
  shown", URL clean, no snap-back; `/audio/pipelines` → redirected into the same filtered "2 of 30" view.
  New-agent wizard, TEXT_GENERATION Parameters step with nothing set: **Response Format** shows `text` and
  **Memory** shows `none` (were "Default"); **Reasoning effort** still reads "Engine default" (no schema
  default). The SPEECH_TO_TEXT `diarization.backend` display was not re-checked in the browser: TASK-980 is
  narrowing that enum to `['embedding']` in parallel.
