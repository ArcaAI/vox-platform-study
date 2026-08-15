# TASK-703 — Empty Live-Note Degradation Marker

| | |
|---|---|
| **Status** | Review |
| **Wave** | 0 · **Size** | S |
| **Epic slug** | `empty-note-marker` |
| **Depends on** | — |
| **Design refs** | D5 (Plane 2 containment proceeds regardless of the substrate program) from [design.md](../../architecture/agentic-workflow-platform/design.md) |
| **Findings closed** | A-11 (conformance matrix, CRITICAL) · F12 (`evidence/ai-pipeline.md`) |

## 1. Requirement Analysis

`LiveDocumentationService`'s flush loop already computes `smrFailed` internally when SMR fails to
produce a running-SOAP update, but never includes it in the published wire payload
(`LiveSummaryEventDto`). On a session's FIRST flush (`session.lastPayload` is `undefined`), a
failing SMR call publishes `runningSummary: ''`, `sections: []` to the browser over SSE, with a
**fresh `updatedAt` timestamp** — visually and structurally indistinguishable from "the visit just
started, nothing has been said yet." On a LATER flush, the same failure freezes the note at its
last-good content but still stamps a fresh timestamp, so a stale note looks like it's actively
updating. The durable/final-note path (`SummaryService`'s `callSmrService`) does the right thing
already — it retries a tenant fallback and, on total failure, throws rather than substituting
content — so this ticket brings the live/ephemeral path's failure contract in line with the
pattern the durable path already establishes, rather than inventing a new one.

Register invariants (`01-invariant-register.md`, category `degradation`) this ticket satisfies:

| INV | Statement |
|---|---|
| INV-126 | Incomplete sections must be marked incomplete, not guessed or filled with placeholder text |
| INV-131 | A safe but incomplete draft must stay unsigned after drain completes |
| INV-132 | Degraded sections must remain labeled |
| INV-143 | Unsupported statements remaining after retrieval abstention must stay flagged or be removed |

`[ADDED]` invariant from `evidence/ai-pipeline.md` (worth restating here since it names this
exact gap): *"Live/ephemeral note payloads need their own degradation marker, not just the final
drafting/drain stage — the reference names degradation markers explicitly for T10.1 (terminology)
and T16 (drain), but the live streaming work note (T8, 'Streaming' state) has the identical failure
mode today and should carry the same requirement."*

**Explicitly OUT of scope:**

- Promoting "Degraded" to a `Consultation`-level state — the assessment's own §6 correction states
  this is architecturally wrong (`Degraded` is not a session state; it should stay a health flag
  ORed onto the active phase, which is exactly the shape this ticket's fix takes: a per-payload
  flag, not a state transition).
- Any change to the durable/final-note path (`SummaryService.callSmrService`) — it is already
  correct (throws, never substitutes) and is not touched by this ticket.
- Any change to the NLP-failure (`nlpFailed`) or groundedness-gate-failure paths — this ticket is
  scoped to the SMR-failure marker specifically, per the assessment's F12 finding. If the executing
  agent notices `nlpFailed` has the identical never-surfaced problem, flag it rather than silently
  expanding scope (see §6).

## 2. Current State Evaluation

Re-derived against the live tree (branch `feat/loop`) on 2026-08-16. Line numbers match the
assessment's citations closely (minor drift, corrected below).

### 2.1 The flush function — `smrFailed` computed but never attached

`packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts:1079-1249`
(the per-flush generation function):

```ts
const priorNote = session.lastPayload?.runningSummary ?? '';   // :1079
...
let sections = session.lastPayload?.sections ?? [];             // :1090
let runningSummary = priorNote;                                 // :1091
let smrFailed = false;                                          // :1092
...
try {
  ...
  if (parsed.length > 0) {
    sections = parsed;
    runningSummary = buildRunningSummary(parsed);
    ...
  }
} catch (error) {                                                // :1145
  if (isStale()) return this.dropStale(session);
  smrFailed = true;                                              // :1147
  this.logger.warn({ message: 'SMR running-summary call failed', ... });
}
...
const payload: LiveSummaryEventDto = {                           // :1230
  consultationId,
  runningSummary,
  sections,
  entities,
  lastSegmentId: session.lastSegmentId,
  ...(groundedness ? { groundedness } : {}),
  ...(smrStats || agentMetadata ? { metadata: { ... } } : {}),
  ...(vitals ? { vitals } : {}),
  updatedAt: new Date().toISOString(),                            // :1249 — fresh, even on failure
};
```

`smrFailed` is a local variable, referenced later ONLY for internal telemetry (agent-trajectory
step status, `:1356` — `status: ctx.smrFailed ? AgentStepStatus.ERROR : AgentStepStatus.OK`) and
job-metrics logging — **never included in the `payload` object that gets published.** On the first
flush of a session (`session.lastPayload` is `undefined`), `priorNote = ''`, so a failing SMR call
leaves `runningSummary = ''`, `sections = []` — published as-is, with the fresh `:1249` timestamp,
over SSE (`safePublish`, `:1253`).

### 2.2 The wire contract has no field for it

`packages/applications/src/services/consultation/live-documentation/dto/live-summary.dto.ts:254-296`
(`LiveSummaryEventDto`): `consultationId`, `runningSummary`, `sections`, `entities`,
`lastSegmentId?`, `groundedness?`, `metadata?`, `vitals?`, `updatedAt`, `closed?` — confirmed no
`smrFailed`/`degraded`/`stale` field exists. The optional-field pattern used for `groundedness`/
`metadata`/`vitals` (spread-conditionally, only present when meaningful) is the one this ticket's
new field follows.

### 2.3 Three consumer surfaces mirror this DTO independently — all three need the field

Verified by direct trace of `live={live.snapshot}` (`consultation-demo-screen.tsx:450`) into
`CaseNoteColumn` (`case-note-column.tsx`), confirming the SDK hook is the actual live data source
for the admin-console playground's case-note panel (not a separate SSE client):

| Layer | File | Type |
|---|---|---|
| Gateway DTO (source of truth) | `packages/applications/src/services/consultation/live-documentation/dto/live-summary.dto.ts:254-296` | `LiveSummaryEventDto` |
| SDK type | `packages/agentic-sdk-v2/src/types/liveSummary.ts:49-61` | `LiveSummarySnapshot` |
| SDK hook (pure passthrough) | `packages/agentic-sdk-v2/src/hooks/useArcaLiveSummary.ts:71-87` | `JSON.parse(data) as LiveSummarySnapshot` — no logic change needed here, only the type |
| admin-console local mirror | `apps/admin-console/src/features/playground-consultation/api/types.ts:173-186` | `LiveSummarySnapshot` (hand-duplicated interface, structurally matched against the SDK's return by TypeScript, not a runtime import) |
| admin-console UI consumer | `apps/admin-console/src/features/playground-consultation/components/scribe/case-note-column.tsx` | Renders `live.runningSummary` / `live.sections` directly (lines ~226, 292-294) with no degradation branch |

### 2.4 What already exists and must be REUSED

- **The optional-field-when-meaningful spread pattern** already used for `groundedness`/`metadata`/
  `vitals` in the `payload` construction (§2.1) — the new field follows the identical style:
  `...(smrFailed ? { smrFailed: true } : {})`.
- **`Skeleton`/`Empty` component families** (`.claude/rules/10-skeleton-loading.md`,
  `11-ux-ui-principles.md`) for the UI-side degradation indicator — `case-note-column.tsx` already
  imports `Skeleton` (for the pre-first-flush waiting state, lines ~292+) and `Badge`
  (`@arcaai/ui/components/shadcn/badge`) — reuse `Badge` with a `variant="destructive"` or
  `variant="secondary"` (per `11-ux-ui-principles.md`'s badge-variant convention) for the degraded
  indicator rather than introducing a new component.
- **`emptyPayload()`** (`live-documentation.service.ts:2183-2185`) is a DIFFERENT, legitimate
  code path (no snapshot exists yet at all, e.g. a fresh GET before any flush has run) — do not
  conflate it with the SMR-failure path this ticket fixes; see §6.

## 3. Knowledge & Best Practices

- **`.claude/rules/10-skeleton-loading.md`** — "Skeleton over spinners... never spinner icons or
  blank space for a loading/degraded state" governs the UI task (Task 5): the fix must not silently
  show blank text where a marker belongs.
- **`.claude/rules/11-ux-ui-principles.md`** §5 "Feedback & Interactivity" — "Every action produces
  visible feedback... never silently succeed or fail" is the exact principle this ticket enforces
  on the backend-to-frontend contract; §10 "Badge variants: `destructive` = error/danger" is the
  concrete component choice for Task 5.
- **`.claude/rules/08-vox-sdk.md`** — SDK entry points: `useArcaLiveSummary` lives in
  `packages/agentic-sdk-v2/src/hooks/`, exported via `core.ts`/`hooks/index.ts` — Task 3 only
  widens an existing exported type, no new export surface needed.
- **`.claude/rules/01-development-workflow.md`** TDD ordering — RED test (Task 1) before the DTO
  field is added (Task 2).
- **Anti-pattern avoided**: per `11-ux-ui-principles.md`'s anti-pattern table, "Spinner as page
  loader" → `<Skeleton />` matching content — the fix for a MID-session degradation is neither a
  spinner nor a skeleton (content already exists and should stay visible per the assessment's own
  finding — "frozen/stale note" is the correct fallback content, not a re-loading skeleton); it
  needs a small persistent indicator alongside the frozen content, which is why `Badge` (not
  `Skeleton`) is the right primitive for Task 5.

## 4. Implementation Plan

### Task 1 — RED: failing tests for the missing marker
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.service.test.ts` (extend)
- **Approach:** Add two failing tests against current behavior:
  1. First-flush SMR failure (`session.lastPayload` undefined, mock the SMR call to reject): assert
     the PUBLISHED payload (inspect the argument to whatever publish mechanism the test harness
     already mocks — follow the existing pattern other tests in this file use to assert on
     `safePublish`'s call arguments) includes `smrFailed: true`, not just that `runningSummary` is
     empty. Currently the field is absent — RED.
  2. Later-flush SMR failure with existing prior content (`session.lastPayload.runningSummary` set
     to non-empty content, mock SMR to reject): assert the published payload retains the frozen
     prior content AND includes `smrFailed: true`. Currently `smrFailed` is absent — RED.
  Check `live-documentation.repoint-grounding.test.ts` and `live-documentation.repair.test.ts` in
  the same `__tests__/` directory first for the established mocking pattern (SMR client mock,
  session fixture shape) before writing new fixtures from scratch.
- **Verify:** `pnpm --filter @arcaai/applications test -- live-documentation.service` — both new
  tests fail (RED).

### Task 2 — Add the field to the wire DTO
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/applications/src/services/consultation/live-documentation/dto/live-summary.dto.ts`
- **Approach:** Add to `LiveSummaryEventDto` (after `vitals`, before `updatedAt`, matching the
  existing field-declaration order which roughly tracks construction order in the service):

  ```ts
  @ApiPropertyOptional({
    description:
      'True when the most recent SMR generation call failed. `runningSummary`/`sections` reflect the last successfully generated content (or are empty on a first-flush failure) — never fabricated. Clients should render a visible degraded/stale indicator rather than treating the payload as fresh.',
  })
  smrFailed?: boolean;
  ```

  Follow the `@ApiPropertyOptional` + `?` style already used for `groundedness`/`metadata`/`vitals`
  immediately above it in the same class.
- **Verify:** `pnpm --filter @arcaai/applications build` — type-checks; no test change yet (Task 3
  wires it up).

### Task 3 — Attach `smrFailed` to the published payload
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts`
- **Approach:** In the `payload` construction (lines 1230-1249), add
  `...(smrFailed ? { smrFailed: true } : {})` following the exact conditional-spread style already
  used for `groundedness`/`metadata`/`vitals` two lines above it. Do not add the field when `false`
  (matches the "absent when not meaningful" convention already established for this DTO — a
  present-but-`false` field would be a behavior change for every OTHER consumer diffing payloads,
  however unlikely that is; the optional-and-absent-by-default convention is safer and consistent).
- **Verify:** `pnpm --filter @arcaai/applications test -- live-documentation.service` — Task 1's
  two tests now pass (GREEN).

### Task 4 — SDK type + hook
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/agentic-sdk-v2/src/types/liveSummary.ts`
- **Approach:** Add `smrFailed?: boolean;` to `LiveSummarySnapshot` (after `vitals`, before
  `updatedAt`, mirroring the gateway DTO's field order per this file's own header comment "Mirrors
  the gateway `LiveSummaryEventDto`"). No change needed in `useArcaLiveSummary.ts` itself — it is a
  pure `JSON.parse(data) as LiveSummarySnapshot` passthrough (verified, §2.3), so the new field
  flows through automatically once the type declares it.
- **Verify:** `pnpm --filter @arcaai/vox build` — type-checks; `pnpm --filter @arcaai/vox test`
  (no behavior change to test at this layer beyond a type-compiles check, since the hook has no
  new logic — if an existing `useArcaLiveSummary` test asserts on the full snapshot shape, extend
  it to include the new optional field for completeness).

### Task 5 — admin-console: local type mirror + UI degraded indicator
- **Agent:** T2 · sonnet-5 · low
- **Files:** `apps/admin-console/src/features/playground-consultation/api/types.ts`,
  `apps/admin-console/src/features/playground-consultation/components/scribe/case-note-column.tsx`
- **Approach:**
  1. Add `smrFailed?: boolean;` to the local `LiveSummarySnapshot` interface (`api/types.ts:173-186`),
     mirroring the SDK type exactly (same field, same optionality).
  2. In `case-note-column.tsx`'s rendering branch for `showLive` content (the `liveSections.length >
     0` / `live?.runningSummary` branches, ~lines 275-300), render a `Badge` (already imported,
     `variant="destructive"` per `11-ux-ui-principles.md` §7 "AI-generated content gets an `AI`
     badge" convention extended to a degradation state — do not invent a new visual language) with
     text like "Note assistant unavailable — showing last update" whenever `live?.smrFailed` is
     true, positioned near the existing "Note assistant drafting" `Spinner` badge (~lines 246-251)
     so the two states are visually consistent siblings (drafting vs. degraded), not competing UI
     patterns. Ensure the badge has appropriate `aria-live` or is announced (per
     `11-ux-ui-principles.md` §11 accessibility — live-region updates for status changes) — check
     how the existing "drafting" badge handles this, if at all, and match or improve it, not
     regress it.
  3. Grep the rest of `apps/admin-console/src` for any OTHER consumer of `LiveSummarySnapshot`/
     `runningSummary` this task's Current State Evaluation (§2.3) did not find, to confirm full
     coverage — none expected beyond the two files above, but confirm before closing.
- **Verify:** `pnpm --filter @arcaai/admin-console build lint test` — component test coverage for
  the new badge (extend or add a test in
  `apps/admin-console/src/features/playground-consultation/components/scribe/__tests__/` if one
  exists for this component, following its existing pattern — check first). Manual/runtime
  verification via the `next-dev-loop` skill is preferred per `13-nextjs-apps.md`'s quality gates
  ("Runtime behavior verified in a running app... compiling ≠ working") if a dev server is
  available in the execution environment; otherwise component-test coverage is the floor.

### Task 6 — Full-suite regression
- **Agent:** T1 · haiku-4-5 · default
- **Files:** none (verification-only)
- **Approach:** Re-run every affected package's test suite to confirm no unrelated live-documentation
  test broke (there are ~13 other test files in the same `__tests__/` directory covering
  groundedness, repair, tool-dispatch, trajectory, etc. — none should be affected by an additive
  optional field, but confirm).
- **Verify:** `pnpm --filter @arcaai/applications test`, `pnpm --filter @arcaai/vox test`,
  `pnpm --filter @arcaai/admin-console test` — all green, output pasted.

## 5. Acceptance Criteria

- [ ] Task 1's two tests exist and were RED before Task 3 (paste the RED run's output as evidence)
- [ ] A first-flush SMR failure now publishes `smrFailed: true` alongside the (still legitimately
      empty) `runningSummary`/`sections` — verified by Task 1/3's test
- [ ] A later-flush SMR failure now publishes `smrFailed: true` alongside the frozen prior content
      — verified by Task 1/3's test
- [ ] `smrFailed` is present in the gateway DTO, the SDK type, and the admin-console local type
      mirror, all three consistent — verified by Tasks 2/4/5
- [ ] The admin-console case-note panel renders a visible degraded indicator (not silent
      blank/frozen text) when `smrFailed` is true — verified by Task 5
- [ ] `pnpm --filter @arcaai/applications test` — full package suite green, output pasted
- [ ] `pnpm --filter @arcaai/vox build test` — green
- [ ] `pnpm --filter @arcaai/admin-console build lint test` — green
- [ ] `pnpm test:unit` (root aggregate) green
- [ ] `pnpm lint` — no new errors/warnings
- [ ] `pnpm typecheck` clean

## 6. Risks & Open Questions

- **Scope boundary**: `nlpFailed` (the entity-extraction failure flag, computed alongside
  `smrFailed` at `live-documentation.service.ts:1172-1188`) has the same "computed but never
  surfaced" shape. This ticket does NOT fix it (§1 explicitly scopes to SMR) — flag it as a
  follow-up rather than silently expanding this ticket's diff, since the assessment's F12 finding
  and the register's degradation-category invariants are both scoped to the note-generation
  failure specifically, and NLP entity extraction failing is a materially different (lower-stakes)
  degradation the user has not asked this ticket to close.
- **`emptyPayload()` (`:2183-2185`) is a distinct, legitimate code path** — a fresh GET of the live
  summary before any flush has ever run. It is intentionally empty (there is genuinely nothing
  yet) and is NOT part of this ticket's fix; do not add `smrFailed` there — doing so would be
  inaccurate (nothing failed; nothing has happened yet). If the executing agent judges that this
  case ALSO needs its own "not started yet" marker for UI clarity, that is a separate, smaller
  follow-up, not silently folded into this ticket.
- **UI copy/placement (Task 5)** is a design judgment call within the existing `Badge`/`Spinner`
  vocabulary already used in `case-note-column.tsx` — no new design review gate is required per
  `12-design-workflow.md` since this is a small addition to an EXISTING, already-approved playground
  screen (tier 50-59, shipped per that rule's §3 table), not a new screen.

## 7. Implementation Summary

Implemented exactly as planned, Tasks 1-6, with no scope changes.

### Files changed

- `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.service.test.ts` — Task 1: two new tests in a `smrFailed degradation marker (TASK-703)` describe block (first-flush and later-flush SMR failure).
- `packages/applications/src/services/consultation/live-documentation/dto/live-summary.dto.ts` — Task 2: `smrFailed?: boolean` added to `LiveSummaryEventDto`, `@ApiPropertyOptional`, placed after `vitals`, before `updatedAt`.
- `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts` — Task 3: `...(smrFailed ? { smrFailed: true } : {})` added to the `payload` construction, following the existing conditional-spread style.
- `packages/agentic-sdk-v2/src/types/liveSummary.ts` — Task 4: `smrFailed?: boolean` added to `LiveSummarySnapshot`, mirroring the gateway DTO. No change to `useArcaLiveSummary.ts` (pure passthrough, verified) or its test (the existing `snapshot()` factory takes `Partial<LiveSummarySnapshot>`, so no full-shape assertion needed extending).
- `apps/admin-console/src/features/playground-consultation/api/types.ts` — Task 5.1: `smrFailed?: boolean` added to the local `LiveSummarySnapshot` mirror.
- `apps/admin-console/src/features/playground-consultation/components/scribe/case-note-column.tsx` — Task 5.2: the top-right status slot now shows a `Badge variant="destructive"` ("Note assistant unavailable — showing last update", `aria-live="polite"`) when `live?.smrFailed` is true, in place of (not alongside) the existing "Note assistant drafting" `Spinner` badge — the two are mutually exclusive states of the same slot. Added `aria-live="polite"` to the existing drafting badge too (it previously had none), per the ticket's "match or improve, not regress" instruction. Frozen note content (sections/runningSummary) keeps rendering underneath, unaffected.
- `apps/admin-console/src/features/playground-consultation/components/scribe/__tests__/case-note-column.test.tsx` — Task 5: new test asserting the degraded badge renders, the drafting badge does not, and the frozen prior content stays visible.
- `docs/implementation/TASK-703-Empty-Note-Marker/README.md` — this file (Status, Implementation Summary, Change History).

Grep confirmed (Task 5.3) no other `apps/admin-console/src` consumer of `LiveSummarySnapshot`/`runningSummary` beyond `case-note-column.tsx` and the metrics-only `use-live-metrics.ts` hook (which only forwards the whole snapshot to a metrics ingester — no rendering, no change needed).

`emptyPayload()` and `nlpFailed` were deliberately left untouched per §1/§6 scope boundaries.

### Verification (Task 1 — RED, captured before Task 3)

```
pnpm --filter @arcaai/applications test -- live-documentation.service -t "smrFailed"
...
 FAIL  .../live-documentation.service.test.ts > ... > marks a first-flush SMR failure with smrFailed: true (no prior content to freeze)
AssertionError: expected undefined to be true
 FAIL  .../live-documentation.service.test.ts > ... > marks a later-flush SMR failure with smrFailed: true while freezing the prior content
AssertionError: expected undefined to be true
 Test Files  2 failed | ...
```
Both new tests failed against pre-fix behavior — confirmed RED.

### Verification (Task 3 — GREEN, after wiring the field)

```
npx vitest run --passWithNoTests live-documentation.service --root packages/applications
 Test Files  1 passed (1)
      Tests  62 passed (62)
   Duration  3.65s
```

```
npx vitest run --passWithNoTests live-documentation --root packages/applications
 Test Files  14 passed (14)
      Tests  161 passed (161)
   Duration  5.64s
```
All 14 `live-documentation/__tests__/*` files (including the two RED tests, now GREEN, and the pre-existing repair/repoint-grounding/groundedness/trajectory/tool-dispatch/windowed/soap-parser suites) pass, run in isolation via `vitest run` directly against `packages/applications` (bypassing the `pnpm test` → `pnpm test:unit` nested-script arg-forwarding, which silently drops trailing CLI args and runs the whole package suite instead of the intended file filter).

### Verification (Task 2/4/5 — build/typecheck)

```
pnpm --filter @arcaai/applications build   # tsc — clean, no errors
pnpm --filter @arcaai/vox build            # tsup + tsc --emitDeclarationOnly — clean
pnpm --filter @arcaai/vox typecheck        # tsc --noEmit — clean
pnpm --filter @arcaai/admin-console build  # next build — all routes compiled, no errors
pnpm --filter @arcaai/admin-console typecheck  # tsc --noEmit — clean
```

### Verification (Task 4 — vox test)

```
pnpm --filter @arcaai/vox test
 Test Files  265 passed (265)
      Tests  4173 passed (4173)
```

### Verification (Task 5 — admin-console test/lint)

```
pnpm --filter @arcaai/admin-console test
 Test Files  178 passed (178)
      Tests  1419 passed (1419)

pnpm --filter @arcaai/admin-console lint
> eslint src --max-warnings 0
(clean, no output — 0 warnings/errors)
```

### Verification (Task 6 — full-suite regression) — honest report on a shared, actively-edited tree

`pnpm --filter @arcaai/applications test` (the full package suite, run three times during this
session) was **not** consistently green, but the failures are demonstrably unrelated to this
ticket's diff:

- Run 1 (mid-session): 200 test files failed with a shared root cause — a parse error importing
  `src/services/consultation/index.ts` — because `note-generation.service.ts`/`.module.ts`/`types.ts`
  in the same barrel's `note-generation/` subfolder had file mtimes of 01:48-01:54, i.e. were being
  actively rewritten by a concurrent sibling agent while this test run was importing them (per this
  ticket's own instructions: "six sibling agents are editing this same working tree right now").
- Run 2 (retry): stabilized to 2 failing tests, both inside
  `note-generation/__tests__/note-generation.service.test.ts` (`TypeError: Cannot read properties of
  undefined (reading 'start')` on `this.harnessGatewayService`) — again the same concurrently-edited
  file, now mid-edit in a different, further-along state.
- Run 3 (retry, via the `-- live-documentation` filter, which — discovered here — does NOT reach
  vitest through the `test` → `test:unit` nested pnpm scripts and so silently ran the FULL suite
  again): 52 failures, this time in `src/services/consultation/events/__tests__/consultation-event.handler.test.ts`
  (`mockHarnessGateway.start` call-count assertions) — a THIRD different file, consistent with the
  same explanation (a different area of the tree being edited by a sibling agent at that moment).

None of the three runs' failures touch `live-documentation/**`, `dto/live-summary.dto.ts`, or any
file this ticket lists. To get a clean signal isolated from the concurrently-edited files, the
`live-documentation/__tests__/` directory was run directly via `vitest run` (bypassing the pnpm
nested-script arg-forwarding bug noted above): **14 files / 161 tests, all passing** (pasted above).
`pnpm --filter @arcaai/applications build` (full `tsc` compile of the whole package, including
`note-generation` and `events`) was also clean, which further corroborates that the failures are
transient test-time state collisions on files mid-edit by another agent, not a real break.

**Recommendation**: re-run `pnpm --filter @arcaai/applications test` once this ticket and any
concurrently-running sibling tickets have all finished editing the shared tree, as part of final
cross-ticket integration verification — this is flagged for the run coordinating all six agents,
not a gap in this ticket's own change.

### Acceptance criteria — status

- [x] Task 1's two tests exist and were RED before Task 3 (pasted above)
- [x] First-flush SMR failure publishes `smrFailed: true` alongside empty `runningSummary`/`sections`
- [x] Later-flush SMR failure publishes `smrFailed: true` alongside frozen prior content
- [x] `smrFailed` present and consistent across the gateway DTO, SDK type, and admin-console local mirror
- [x] Admin-console case-note panel renders a visible degraded indicator (not silent) when `smrFailed` is true
- [~] `pnpm --filter @arcaai/applications test` — not clean end-to-end due to concurrent sibling-agent
      edits to unrelated files (see above); this ticket's own tests (`live-documentation/**`, 161
      tests) are 100% green in isolation, and the full package `build` is clean
- [x] `pnpm --filter @arcaai/vox build test` — green
- [x] `pnpm --filter @arcaai/admin-console build lint test` — green
- [ ] `pnpm test:unit` (root aggregate) — NOT run (ticket instructions: no repo-root aggregates from
      this agent; a final verification agent runs it)
- [ ] `pnpm lint` (root) — NOT run for the same reason; `@arcaai/admin-console`'s own `lint` was run
      and is clean
- [ ] `pnpm typecheck` (root) — NOT run for the same reason; the three affected packages'
      package-level `build`/`typecheck` were run and are clean

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | T3/T4 authoring agent (Claude, sonnet-5) |
| 2026-08-16 | Implemented Tasks 1-6: RED tests, `smrFailed` added to `LiveSummaryEventDto`/`LiveSummarySnapshot` (SDK + admin-console mirror), attached to the published payload, admin-console degraded `Badge` indicator + test. All GREEN in isolation (live-documentation 161/161, vox 4173/4173, admin-console 1419/1419); package-level `build`/`typecheck`/`lint` clean for all three touched packages. Full `@arcaai/applications` package suite showed unrelated flakiness from concurrent sibling-agent edits to `note-generation`/`events` files outside this ticket's scope — flagged for a final cross-ticket verification pass rather than silently claimed green. Status set to Review pending that re-run. | Execution agent (Claude, sonnet-5) |
