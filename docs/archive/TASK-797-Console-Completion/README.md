# TASK-797 — Console Completion: workflow testing (R2), and the clinician surfaces (R3/R4)

| | |
|---|---|
| **Status** | Review |
| **Type** | feature |
| **Branch** | `feat/task-797-console-completion` (from `dev-2.2` @ `cbd21e14b`) |
| **Owned surfaces** | `apps/admin-console/**`, `packages/agentic-sdk-v2/**` |
| **Not merged** | worktree `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-task-797` left in place |

---

## 1. Requirement Analysis

Three work items from the brief:

- **W1 / R2** — "the tenant admin MUST be able to manage, control, test using playground."
- **W2 / R3-R4** — surface interim summaries, intelligent suggestions, and spelling /
  medical-term / drug-name correction proposals.
- **W3** — "highlight detected details/entities/important information."

---

## 2. Current State Evaluation — what the code actually said

The brief instructed me to verify its own claims. Three of them needed correcting.

### 2.1 R2 was NOT "flatly unmet". The sandbox plane already exists end to end.

The brief said a tenant admin cannot test a workflow. What is actually true:

| Capability | Where it already lives |
|---|---|
| Start / status / cancel a sandbox run | `features/workbench/api/client.ts` → `POST admin/workflow-definitions/:id/sandbox-runs` |
| Ticket-authenticated live progress | `components/run-panel.tsx` via `@/shared/streams` `useEventStream` |
| Pick or create a `WorkflowTestFixture` | `components/fixture-picker.tsx` → `admin/workflow-test-fixtures` |
| Per-node outcome inspection | `components/node-run-inspector.tsx` → `admin/workflow-runs/:id/trace` |
| Sandbox visibly distinct | `SandboxBanner` + `SandboxBadge`; `WorkflowRun.isSandbox` on the row |
| Reachable by a tenant admin | `/playground/workbench`, nav-gated on `manage:WorkflowDefinition` OR `manage:WorkflowRun` — both seeded for tenant admins (`seed/01-policy.ts`) |
| Deep-linkable | `WorkbenchScreen` reads `?definitionId=` as nuqs URL state |

The genuine gap was **reachability from the Studio editor**. `studio-toolbar.tsx` offered only
Undo/Redo/Validate/Publish, and `features/workflow-studio/api/client.ts` contains no sandbox call
at all (`grep -rn "sandbox\|fixture" api/` → no matches).

### 2.2 There is no per-node `DEGRADED` status anywhere in this system

The brief asked to show "a `SKIPPED`/`DEGRADED` node". `AgentStepStatus` is
`STARTED | OK | ERROR | SKIPPED | TIMEOUT`, and `RunNodeRollupResponse`'s own docstring records
that a degraded node and a critically-failed one **both persist as `ERROR`**. Degradation exists
only as the run-level `WorkflowRun.degradedNodeCount`.

That count *was* on the wire (`RunTraceResponse.run` is the full `WorkflowRunResponse`) and the
Workbench's local type narrowed `run` to `{ id, status, isSandbox }`, discarding it. So the single
most useful diagnostic the system produces was being dropped by the client. Fixed in W1.

### 2.3 Two W3 capabilities were built and unused

- `LiveSummaryEntityDto` has carried `start`/`end` offsets into `runningSummary` since it was
  written; the console's mirror omitted both, so entities could only be chips, never marks.
- `useNamedEntities` (`GET :id/named-entities`) existed in this feature with **zero callers**.
  After recording stopped the live snapshot's entities vanished and nothing replaced them.

---

## 3. Implementation Summary

### W1 — R2 (`DONE`)

1. `StudioToolbar` gains a **"Test in Workbench"** deep link to
   `/playground/workbench?definitionId=<id>`. A plain href, per rule 13's "one authoritative
   editor per backend resource" — the Workbench owns executing a definition, so the Studio grows
   no second sandbox client and features stay un-imported by one another.
   Withheld while autosave is `saving` / `conflict` / `error`, with a stated reason: a sandbox run
   executes the **server's stored graph**, so testing mid-save would run a graph the admin is not
   looking at. Offered on read-only PUBLISHED versions too — running is a read-side action.
2. `NodeRunInspector` leads with a **run outcome summary** naming failed and degraded node counts
   and the first error code. Absent counts render nothing rather than `0` — a fabricated zero
   reads as "nothing went wrong".

### W2 — R3/R4 (`PARTIAL` — built and unit-tested; **no transport yet**)

Rebuilt against TASK-796's brokered contract, transcribed from the executable source
(`apps/harness/src/harness/tests/unit/services/test_live_delivery_client.py` on
`feat/task-796-realtime-summary-text`), not from prose. Types live in one module,
`api/live-assist.ts`.

796's four rules are implemented as safety properties, each with its own test:

| Rule | Implementation |
|---|---|
| 1. Never auto-apply | One explicit click per proposal. No "accept all" anywhere. |
| 2. SHA-256 gate | Before applying, the panel hashes the **current** text and compares to `corrections.textSha256`. On mismatch it refuses, shows why, calls `onStale` to re-request, and withdraws **every** Accept in the set — a stale digest invalidates all of them. Reject survives, so a judged proposal can still be cleared. |
| 3. Identity | Keyed by `proposalId` / `suggestionId`, never array index. Pinned by a test that re-renders the list reversed and asserts a rejected proposal stays rejected. |
| 4. Provenance | `detectedBy` and `proposedBy` both rendered. |

Rule 2 is the one that matters: the proposals index byte offsets into one exact revision, so
applying one to moved text splices the replacement over the wrong characters. On a drug name or a
dose that is a patient-safety defect.

**Interim summaries** needed no new consumer surface, as 796 stated — they arrive on the
live-summary plane the console already consumes. What was missing was provenance: `source`,
`nodeType`, `ordinal`/`total` and `metadata.stats.task_key` are now on both the console mirror and
the SDK's, and the note header distinguishes `Interim summary · 2 of 3` from an ordinary flush.
The section renderer is deliberately **not** taxonomy-driven — the four SOAP titles are hardcoded
server-side and per-tenant titles are deferred.

**SOAP autofill** fills what the clinician actually edits, because there is no SOAP *form*:
`SummaryResult.content` is one prose string server-side. `composeAutofill` **appends** to a
non-empty buffer and only fills an empty one, so no code path here can destroy typed text.

**R5 is preserved, not re-derived.** Accepted corrections and autofills both go through
`editor.change` — the clinician's own buffer — so they are clinician edits, never machine writes,
and `use-note-editor.ts`'s two-writer contract never has to arbitrate one.

Also corrected a now-stale note on the loop-activity feed: that feed is still progress-only by
design (`EmitLoopEventInput` is `extra="forbid"`, ids and labels only), but interim text now
arrives on the plane above, so the note names which is which.

### W3 — entity highlighting (`DONE`)

`lib/entity-highlights.ts` holds the part that can hurt someone. Every span is **verified**
against the source — `text.slice(start, end)` must equal the entity's own `text` — and anything
failing is **dropped**, never re-anchored by searching (the second `5mg` is not the one the model
meant). Overlaps are dropped too: nested `<mark>` is invalid, and an overlap means an offset is
wrong. Pure, so the property is tested without React, including that segments always reassemble to
the source character-for-character.

Same posture the harness already takes toward its own proposals (`_verified_proposals`).

Two limits, stated rather than papered over:
- **SOAP sections are not marked** — the offsets index `runningSummary`.
- **The persisted aggregate has no offsets** into the draft, so it renders as grouped chips.

---

## 4. Evidence

### 4.1 RED before green (representative)

W1 toolbar link:
```
 Test Files  1 failed (1)
      Tests  4 failed | 3 passed (7)
TestingLibraryElementError: Unable to find an accessible element with the role "link" and name `/test in workbench/i`
```

W1 degraded-node summary:
```
      Tests  4 failed | 2 passed (6)
TestingLibraryElementError: Unable to find an element with the text: /2 degraded/i
```

W3 entity highlighting:
```
      Tests  2 failed | 3 passed (5)
AssertionError: expected [] to deeply equal [ 'chest pain', 'metformin' ]
```

W2 contract rules — all ten RED:
```
     × applies when the local text hashes to `textSha256`
     × REFUSES to apply when the digest does not match, and does not touch the text
     × re-requests the proposals on a digest mismatch
     × withdraws every accept affordance once the set is known stale — not just the one clicked
     × keeps two byte-identical proposals distinct by id
     × a rejected proposal stays rejected when the envelope is re-delivered after a retry
     × a dismissed suggestion stays dismissed across a re-delivery
     × never presents a proposal as applied
     × shows BOTH provenance halves
     × shows the suggestion proposer
```

**One RED was my own test's fault, and the implementation was right.** Three entity-offset
fixtures were off by one; `verifiedEntitySpans` rejected them. That is the safety property doing
its job, so the fixtures were corrected against `String.indexOf` rather than the check being
loosened.

### 4.2 Gates

```
$ pnpm --filter @arcaai/admin-console lint
> eslint src --max-warnings 0
(exit 0)

$ pnpm --filter @arcaai/admin-console test
 Test Files  234 passed (234)
      Tests  1899 passed (1899)
   Duration  38.52s

$ pnpm --filter @arcaai/admin-console build
   (succeeded; route list includes /workflow-studio/[definitionId],
    /playground/consultation, /playground/workbench)

$ pnpm --filter @arcaai/vox typecheck
> tsc --noEmit
(exit 0)
```

Touched-feature suites:
```
$ npx vitest run --project client --project server src/features/playground-consultation/
 Test Files  24 passed (24)
      Tests  206 passed (206)

$ npx vitest run --project client src/features/workflow-studio/
 Test Files  16 passed (16)
      Tests  100 passed (100)

$ npx vitest run --project client src/features/workbench/
 Test Files   2 passed (2)
      Tests  10 passed (10)
```

**axe: 0 violations** on every surface added or touched — `StudioToolbar`, `NodeRunInspector`,
`HighlightedNoteText`, `CaseNoteColumn` (entity highlighting, persisted entities, all three W2
surfaces, interim summaries), `CorrectionProposalsPanel`, `ClinicalSuggestionsPanel`.

### 4.3 Runtime verification — and its honest limit

Verified live:
```
$ npx next dev -p 5176
  ▲ Next.js 16.3.1 (Turbopack)
  ✓ Ready in 203ms
(no compile errors)

$ curl -o /dev/null -w "%{http_code} %{redirect_url}" http://localhost:5176/workflow-studio/def-1
307 http://localhost:5176/login?from=%2Fworkflow-studio%2Fdef-1
  (same for /playground/consultation and /playground/workbench)
```
Real browser at `http://localhost:5176/login` → `Sign in | HOPE Admin Console` renders, **zero
console errors**.

E2E spec added (`tests/e2e/workflow-studio.spec.ts`) asserting the link, its href, that following
it lands on a Workbench with that definition preselected, and that the sandbox marking is visible.
It **skips** with the stack down, as designed:
```
$ npx playwright test workflow-studio.spec.ts -g "Workbench sandbox link"
  -  2 [chromium] › offers a Workbench sandbox link ... and it preselects that definition
  1 skipped
```

**NOT verified live, and why.** The API gateway cannot start in this worktree: the Prisma client
under `packages/database/src/generated/` is absent, and generating it needs a `pnpm db:*` command
the ownership map forbids me (§Non-negotiables 5). The Python services (8861-8866) are also down.
So `proxy.ts` short-circuits every authenticated route to `/login` and no screen renders with real
data. Component behaviour is verified in happy-dom against real React 19 and real `@arcaai/ui`
components, and every route compiles in the production build — but **no end-to-end pass was
observed and none is claimed.**

For W2 specifically, even a live gateway would not have produced data: the routes carrying the
contract do not exist yet (see §5).

---

## 5. Requested contracts / blockers

| # | Needed | Owner | Effect |
|---|---|---|---|
| C-1 | `POST /internal/harness/consultations/:id/live-summary` | TASK-795 | Interim summaries reach the live-summary plane. Provenance rendering is built and idle until then. |
| C-2 | `POST /internal/harness/consultations/:id/live-assist` | TASK-795 | Suggestions/corrections have a producer. |
| C-3 | `GET /api/v1/consultations/:id/live-assist/stream` (SSE) + stream-ticket scope `consultation_live_assist:<id>` registered in `assertKnownScopeNamespace` | TASK-795 | The console can subscribe. Path and scope are declared in `api/live-assist.ts` but deliberately **not** subscribed — a hook against a route that 404s is noise, not readiness. |

Until C-1..C-3 land, W2 is **built and unit-tested, with no transport**.

---

## 6. Boundary notes

- No file outside `apps/admin-console/**` and `packages/agentic-sdk-v2/**` was modified.
- `packages/ui` and `packages/agentic-sdk-v2` were **built** (not edited) because a fresh worktree
  has no `dist/` and the console's tests import `@arcaai/ui`'s root barrel.
- `lib/entity-highlights.ts` and the two W2 panels duplicate patterns that exist in other features
  (`features/workflow-runs`, `features/consultation-review`). That is the standing convention —
  "features never import one another" (rule 13) — and each is flagged in-file as a promotion
  candidate for `packages/ui`, which this ticket does not own.
- Pre-existing, unrelated lint error in `tests/e2e/prompt-templates.spec.ts:169` (`emptyState`
  assigned but never used). Not mine, not touched; the package `lint` script scopes to `src`, so it
  does not gate.

---

## 7. Change History

| Date | Change |
|---|---|
| 2026-08-23 | W1 (R2): Workbench deep link from Studio + run-level degraded/failed summary. `c0a41bae4` |
| 2026-08-23 | W3: verified inline entity marking; wired the unused `useNamedEntities`. `a014c79df` |
| 2026-08-23 | W2: surfaces against locally-declared shapes (pre-contract). `8ba24c80d` |
| 2026-08-23 | W2: rebuilt on TASK-796's brokered contract; SHA-256 gate, id-keying, interim provenance. `7529fe3e5` |
