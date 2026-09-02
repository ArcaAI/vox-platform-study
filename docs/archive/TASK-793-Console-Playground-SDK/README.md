# TASK-793 — Console, Playground & SDK: make the clinician path real (R2, R3, R4, R5)

| | |
|---|---|
| **Status** | Review |
| **Type** | `feature` / `bugfix` |
| **Parent** | TASK-789 |
| **Branch** | `feat/task-793-console-playground` off `dev-2.2` |
| **Owns** | `apps/admin-console/**`, `packages/agentic-sdk-v2/**`, `packages/vox-node/**` |

## Context

TASK-789's sharpest finding is that the backend for the clinician experience is largely **built and
never called**. This ticket is mostly wiring, not construction — check what exists before building.

## Work items

### W1 — The clinician cannot edit the SOAP note (C-3) — HIGHEST PRIORITY, unblocks R5 and R7
`case-note-column.tsx:280` renders the draft as `<article aria-label="Personalized draft note">` —
inert text. The playground's only `PATCH` is job-cancel.

The backend is **complete**: `PATCH :id/summary/:summaryId` with mandatory `If-Match`
(`consultation.controller.ts:1073-1109`), OCC via `updateWithVersion` (`context.service.ts:522`),
append-only `ContextItemVersion` with diffs, and a passing `summary.service.edit-capture.test.ts`.

Build the editing surface. R5 specifically requires the clinician to edit **while the system keeps
transcribing and generating** — so you must handle the concurrent-writer case explicitly:
- What happens to in-progress clinician text when a machine write lands? Merge, or hold the machine
  write, or surface a conflict — pick one, justify it in the README, and TEST it.
- Use the ETag/`If-Match` flow; a 412 must be handled visibly, never swallowed.
- Do not silently discard clinician input under any code path. That is the one unacceptable outcome.

### W2 — R4's inputs are never supplied
`consultation-demo-screen.tsx:300` calls `sdkSession.open({ patientId })`. `departmentId` exists on
the request DTO and on the SDK's `OpenSessionInput`, and the backend resolver reads it
(`summary.service.ts:367,606`) — but it is never sent, so `consultation.departmentId` is null for
every playground consultation and department scoping can never fire. Same for
`GenerateSummaryRequest.dnaStyleId`.

Send them. Add the pickers. Note `DepartmentAgent.dnaStylePolicy` is only `INHERIT|DISABLED` (a
gate, not a selector) — if selecting a specific DNA style needs a schema change, request it from 790.

**This also activates TASK-789's C-1 fix**: `ConsultationWorkflowDispatchService` resolves the
assignment cascade using `departmentId`. Without W2, the department tier can never be consulted.

### W3 — No way to test a workflow (R2)
Workflow Studio's toolbar has only Undo/Redo/Validate/Publish (`studio-toolbar.tsx:62-91`), and
`workflow-runs/api/client.ts` has no POST that starts a run. A sandbox plane DOES exist
(`admin/workflow-definitions/:id/sandbox-runs`) — surface it in Studio so a tenant admin can
actually test the graph they authored. `WorkflowTestFixture` rows are the saved-input mechanism.

### W4 — Surface the R3 capabilities 791 is building
Realtime short summaries, intelligent suggestions, and spelling/medical-term/drug-name corrections
need clinician-facing surfaces. **Coordinate via the orchestrator** — do not invent an event shape;
791 owns the emitting side. Write your expected contract into `## Requested contracts` below and
build against what is brokered. A correction must be *proposed* and clinician-accepted, never
silently applied.

### W5 — Cleanups found in passing
- **M-6**: `DocumentationReviewPanel` is dead code — no route, no importer outside its own test. It
  duplicates half of `CaseNoteColumn`. Delete it or route it; do not leave it.
- **M-7**: the whole async summary path (`generateSummaryAsync`, `getConsultationJob`,
  `cancelConsultationJob`, `consultationJobStreamPath`, and 91 lines of merge logic in
  `useSummaryJobProgress`) has zero call sites. Use it or delete it — decide and say why.
- **M-5**: two parallel client-side SSE stacks solve the identical ticket-mint → EventSource →
  reconnect problem — the SDK's `SSEClient` and the console's `use-event-stream.ts`. Converge them.

## Non-negotiables
- WCAG 2.2 AA, both themes, axe 0 violations per screen (`11-ux-ui-principles.md` §11).
- `@arcaai/ui` + semantic tokens only. Never hardcode colors. `<Skeleton />` for loading.
- Verify in a RUNNING app — the `next-dev-loop` skill is the preferred runtime verification.
  Compiling is not working.
- The console is dynamic-by-default: do NOT enable Cache Components.
- Another session has been active in `apps/admin-console` — rebase before you finish.

## Implementation Summary

| Item | Status | Proving test |
|---|---|---|
| W1 SOAP editing surface (C-3, R5, R7) | **DONE** | `use-note-editor.test.tsx` (10), `case-note-editing.test.tsx` (5), `consultation-scribe-editing.spec.ts` (real browser) |
| W2 departmentId + dnaStyleId (H-4, R4) | **DONE** | `sessionUtils.test.ts`, `consultations-column.test.tsx`, `client.test.ts`, e2e wire assertion against the LIVE gateway |
| W3 test a workflow from Studio (R2) | **NOT STARTED** | — |
| W4 realtime activity (R3) | **PARTIAL** | `use-loop-activity.test.tsx` (5), `case-note-column.test.tsx` |
| W5 dead-code decisions | **DONE** | full suite green after each |

### W1 — the edit path

The backend was complete and the UI never called it. Wired
`PATCH :id/summary/:summaryId` end to end. The console's HTTP core already had
`getWithEtag`/`patchWithEtag`/`versionFromEtag`, and `hope-proxy.ts` already
forwards `if-match`/`etag` (verified in source, not assumed) — so this was
wiring, exactly as the ticket predicted.

The precondition is derived from `SummaryResponse.version`, which is what the
gateway's `ETagInterceptor` renders the ETag from, and is sent as BOTH the
`If-Match` header and the DTO's required `expectedVersion` body field.

Sign & save is disabled while an edit is open: signing mid-edit would attest
the server's text rather than the clinician's.

### The R5 concurrency decision

**A machine write may reach the VIEW. It may never reach the BUFFER while that
buffer holds unsaved clinician text.** Nothing is auto-merged; nothing is ever
discarded without an explicit clinician action.

*Why not merge?* Two prose SOAP notes have no field structure to merge on — the
server stores whole-document `content`. A three-way text merge of clinical prose
can silently interleave a negation ("no chest pain" / "chest pain") and is not
safe to automate.

*Why not hold the machine write?* The client does not control generation. The
harness drafts on its own schedule; there is nothing to hold.

*Why is surfacing a conflict the right answer?* It mirrors what the server
already does. `SummaryService.updateSummary` forwards a mid-assurance edit to
the harness (`signalEdit`), and `HarnessDocWorkflow` re-runs assurance against
the EDITED content. The platform already treats the clinician's edit as
authoritative; the UI now agrees with it.

Two collisions exist and they are **not** the same event:

1. **Supersede.** A regeneration CREATES a new summary row
   (`summary.service.ts:409,659`), so `summary/latest` begins serving a
   different `id`. Saving to the row being edited would return 200 and then be
   invisible, because the newer row is what `latest` serves. So "Keep my
   version" re-bases the buffer onto the incoming row — the clinician's text is
   kept AND lands on the row that is actually current.
2. **Version drift.** The same row moved → 412. The buffer is untouched, the
   server's side is re-read off the wire (not the cache — the cache is the stale
   thing) and shown for comparison, and the clinician chooses "Overwrite with my
   version" or "Discard mine".

A stale refetch can also race a save; the fold refuses to walk the buffer
backwards onto an older version of the same row. That guard was mutation-tested
(removing it turns the test red).

### W5 decisions

- **M-6 `DocumentationReviewPanel` — DELETED.** Zero importers outside its own
  test, verified by grep across `apps/` and `packages/`.
- **M-7 async summary path — WIRED, not deleted.** It is now the manual Generate
  path. It earns its keep: the sync mutation it replaces held the button for the
  entire generation with no progress and no cancel, while this path already had
  an SSE progress stream, a poll fallback and a terminal-state merge guard.
  `useGenerateSummary` was orphaned by the switch and removed; the
  `generateSummary` CLIENT binding stays, since that layer is deliberately a
  complete typed map of the endpoint surface.
- **M-5 duplicate SSE stacks — KEPT BOTH.** They are not duplicates at the seam
  that matters. Verified in source: the console mints its ticket from the Next
  BFF route `/api/auth/stream-ticket` because the browser holds no token (it is
  in an httpOnly cookie); the SDK's `SSEClient` mints from the GATEWAY route
  through its own credentialed `AgenticClient`. Neither can adopt the other's
  credential model. The genuinely shared part is the reconnect/backoff/
  single-use-replay state machine; extracting it across two packages is not
  worth the coupling and is recorded as a follow-up.

## Corrections to this ticket's own brief

Both were found by reading the source rather than the description.

1. **`OpenSessionInput` did NOT carry `departmentId`.** This README and
   TASK-789 H-4 both state it did. It carried `department?: string` — a NAME
   field the gateway does not declare, which `forbidNonWhitelisted` rejects with
   400. `departmentId` was added; `department` was deprecated in place rather
   than deleted, because the v1-compat lane still passes it (below).
2. **`OWNERSHIP-MAP.md` did not exist** in the tree at this branch's base
   (`6b066dd0f` added four READMEs and no map), though TASK-790's README cites
   it. It was supplied mid-ticket by the orchestrator.

## Findings for other owners (outside TASK-793's boundary)

- **`packages/ui/src/components/shadcn/select.tsx:32` — WCAG 2.2 AA contrast
  failure in dark mode.** `data-[placeholder]:text-muted-foreground` over
  `dark:bg-input/30` is #a0a0a0 on #3b3a3a = **4.33:1**, below the 4.5:1 floor.
  It fires for EVERY unset Select in dark mode console-wide, found by a real
  browser on the footer's "Language" and "Note assistant" pickers (both predate
  this ticket). `packages/ui` has no owner in the ownership map and is not
  TASK-793's; excluded from the dark scan with the reason stated inline.
  TASK-793's own pickers dodge it by defaulting to a real sentinel option
  instead of a placeholder.
- **`useArcaSessionManager.ts:120` (v1-compat) sends `department` on open**, so
  any compat consumer that sets `providerInfo.department` gets a 400 from
  `forbidNonWhitelisted`. Left as-is deliberately — changing the compat lane's
  behaviour is beyond this ticket and needs its own verification.

## Requested contracts

Needed from **TASK-791** before W4 can be completed:

```ts
/** How a correction PROPOSAL reaches the client. No transport was brokered. */
interface CorrectionProposalEvent {
  kind: 'correction.proposed';
  data: {
    proposalId: string;
    /** Which artifact the proposal targets, and its OCC version. */
    contextItemId: string;
    expectedVersion: number;
    category: 'spelling' | 'medical_term' | 'drug_name';
    /** Byte-identical source span, and the offered replacement. */
    charStart: number;
    charEnd: number;
    original: string;
    proposed: string;
    confidence?: number;
    status: 'PROPOSED';
    applied: false;
  };
}
```

Plus the accept/reject route a clinician action would call (proposals must never
auto-apply), and the interim-summary **body** read-back (TASK-791 W5) so the
realtime-summary surface can show text instead of progress alone.

Needed from **TASK-790**: nothing blocking. If selecting a SPECIFIC DNA style
per department is wanted, `DepartmentAgent.dnaStylePolicy` needs to become a
selector rather than `INHERIT|DISABLED`; the current picker sends
`GenerateSummaryRequest.dnaStyleId` directly instead, which needs no schema
change.

## Change History
| Date | Change |
|---|---|
| 2026-08-22 | Ticket created from TASK-789 findings. |
| 2026-08-22 | W1, W2, W4 (partial), W5 implemented; R5 concurrency decision recorded; W3 not started. |
