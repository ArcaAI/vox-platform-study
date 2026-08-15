# TASK-701 — Displayed-SIGNED Status Forgery Containment

| | |
|---|---|
| **Status** | Completed |
| **Wave** | 0 · **Size** | S |
| **Epic slug** | `signed-status-forgery` |
| **Depends on** | — |
| **Design refs** | D5 (Plane 2 containment proceeds regardless of the substrate program) from [design.md](../../architecture/agentic-workflow-platform/design.md) |
| **Findings closed** | §3.1 (assessment `README.md` headline finding — no dedicated `A-`id was assigned to it in `02-conformance-matrix.md`) · A-13 (CRITICAL/HIGH matrix, same root cause: an unvalidated `metadata` write reaching the lifecycle-status precedence logic) |

## 1. Requirement Analysis

`PATCH /consultations/:id` with `{"metadata": {"status": "SIGNED"}}` bypasses the typed `status`
field's `@IsIn(['OPEN','CLOSED'])` guard, because `metadata` is validated only as `@IsObject()`
(any shape) and is shallow-merged into the entity's `metadata` JSON column. The response DTO
mapper then **prefers `metadata.status` whenever the typed `status` column reads `OPEN`**, so all
17 call sites of `ConsultationDtoMapper.toResponse`/`toResponseWithContext` return `status:
'SIGNED'` for a consultation that was never attested. No `SIGNED_NOTE` version is written, no
attestation hash exists, and the typed column is untouched — **the stored record is intact and
the act is auditable** (the header §2 non-negotiable, "the system never signs for the clinician,"
is upheld at the record of truth). What breaks is presentation: nothing in the API response
distinguishes a forged display value from a real signature, and every one of the 17 read paths —
UI included — trusts it.

This is reachable by the assigned doctor or **any tenant admin holding `manage:Consultation`**
(`apps/api/src/modules/consultation/consultation.controller.ts:296-317`,
`verifyConsultationOwnership`), which is a materially larger blast radius than "the clinician
tricking themselves."

Register invariants (`01-invariant-register.md`) this ticket satisfies:

| INV | Statement |
|---|---|
| INV-159 / INV-259 | The system must never sign on behalf of the clinician |
| INV-186 | The clock itself must never sign; only explicit clinician approval can commit |
| INV-148 / INV-182 / INV-256 | An unsigned draft, if retained, must remain visibly unsigned and cannot be treated as a signed record |
| INV-174 | "Closed" (T23) must only occur if "Closed Approved" (T21) has already occurred |

Category `hitl-authority` and `partial-vs-final` from the register both bear directly on this
finding: the keystone safety property (`ConsultationStatus.SIGNED` has exactly one write site,
`SummaryService.approveSummary`) is a property of the **column**. This ticket does not touch that
column or `approveSummary` — it closes the separate legacy `metadata.status` presentation channel
that can be made to say the same word without the same guarantee.

**Explicitly OUT of scope:**

- Replacing the legacy `metadata.status` (`OPEN`/`CLOSED`) mechanism with the real
  `ConsultationStatus` enum's `transitionTo()` state machine — that is `TASK-711
  session-state-machine` (Wave 1), which deletes `metadata.status` entirely. This ticket makes the
  existing mechanism safe under its current design; it does not replace the design.
  `closeConsultation()`/`reopenConsultation()` (`transitionStatus`, lines 664-705) keep writing
  `metadata.status` exactly as today.
  design.md's Deprecations list already names `metadata.status` for eventual removal — this
  ticket is the containment step, not that removal.
- A-13's full fix (two independent "closed" trackers, `ConsultationStatus.CLOSED` never written by
  any code path) is **not** closed by this ticket beyond removing the forgery vector on the
  `SIGNED` value specifically; A-13's broader "two trackers" architecture is `TASK-711`'s scope.
- Any change to `approveSummary`, the WORM `HarnessAuditEvent` ledger, or attestation.

## 2. Current State Evaluation

Re-derived against the live tree (branch `feat/loop`) on 2026-08-16; the assessment's cited lines
(`consultation.service.ts:757-758`, `consultation.dto.mapper.ts:23-26`) are confirmed accurate —
no drift.

### 2.1 The unvalidated `metadata` field

`packages/applications/src/services/consultation/consultation/dto/update-consultation.request.ts:41-52`:

```ts
export class UpdateConsultationRequest {
  ...
  @ApiPropertyOptional({ description: 'Lifecycle status. Stored in metadata.status.', enum: CONSULTATION_STATUS_VALUES })
  @IsOptional()
  @IsIn(CONSULTATION_STATUS_VALUES)   // ['OPEN', 'CLOSED'] — validated
  status?: ConsultationLifecycleStatus;

  @ApiPropertyOptional({ description: 'Additional metadata (shallow-merged with existing metadata)' })
  @IsOptional()
  @IsObject()                          // any shape — NOT validated
  metadata?: Record<string, unknown>;
}
```

The top-level `status` field is correctly restricted to `OPEN`/`CLOSED`. `metadata` accepts any
object, including one whose own `status` key holds `'SIGNED'` — a value that is not even in
`CONSULTATION_STATUS_VALUES` (this DTO's legacy enum) and is certainly not a real
`ConsultationStatus` column value written through any legitimate path.

### 2.2 The shallow merge

`packages/applications/src/services/consultation/consultation/consultation.service.ts:730-777`
(`updateConsultation`):

```ts
const currentMeta = (consultation.metadata as Record<string, unknown> | null) ?? {};
let nextMeta: Record<string, unknown> = { ...currentMeta };
if (request.metadata !== undefined) {
  nextMeta = { ...nextMeta, ...request.metadata };   // :757-758 — any caller-supplied key wins
}
if (request.status !== undefined) {
  nextMeta.status = request.status;                   // validated OPEN|CLOSED — legitimate
}
consultation.metadata = nextMeta as Parameters<typeof ConsultationFactory.CreateNewVisit>[0]['metadata'];
```

Lines 757-758 merge the caller's entire `metadata` object over the current one with no key
allow/deny list, so `request.metadata = { status: 'SIGNED' }` writes `nextMeta.status = 'SIGNED'`
via the SAME code path the legitimate `request.status` field uses two lines later — except with no
`@IsIn` validation upstream.

**The one legitimate writer of `metadata.status` is `transitionStatus`**
(lines 664-705, backing `closeConsultation`/`reopenConsultation`), which hardcodes
`target` to `CONSULTATION_STATUS.CLOSED` or `.OPEN` — never caller-supplied. This ticket's fix
must not touch that path.

### 2.3 The route and its guard

`apps/api/src/modules/consultation/consultation.controller.ts:418-429`:

```ts
@ApiEndpoint({ returnedModel: ConsultationResponse, method: HttpMethod.PATCH, path: ':id', by: ['id'] })
async update(@Param('id') id: string, @Body() request: UpdateConsultationRequest): Promise<ConsultationResponse> {
  await this.verifyConsultationOwnership(id);
  return this.consultationService.updateConsultation(id, request);
}
```

`verifyConsultationOwnership` (lines 296-317) allows the assigned doctor OR any caller whose CASL
ability grants `manage`/`Consultation` for that tenant — confirmed: this includes tenant admins,
not just the treating clinician.

### 2.4 The mapper's precedence

`packages/applications/src/services/consultation/consultation/consultation.dto.mapper.ts:14-43`
(`ConsultationDtoMapper.toResponse`):

```ts
const columnStatus = entity.status as string | undefined;         // real ConsultationStatus enum column
const metaStatus = metadata?.status as string | undefined;        // legacy JSON — UNVALIDATED shape
const status =
  columnStatus && columnStatus !== CONSULTATION_STATUS.OPEN ? columnStatus : (metaStatus ?? columnStatus ?? CONSULTATION_STATUS.OPEN);
```

When the typed `status` column is `OPEN` (the default, pre-attestation state for any consultation
that hasn't yet gone through the harness gate or manual close/reopen), `metaStatus` wins
unconditionally — no check that it is even a recognized string.

Confirmed 17 call sites of `ConsultationDtoMapper.toResponse`/`toResponseWithContext` across
`packages/applications/src/services/consultation/consultation/*.ts` and
`apps/api/src/modules/consultation*/*.ts` (`grep -c` re-run against the live tree), matching the
assessment's count exactly — every one of them inherits this precedence.

### 2.5 What already exists and must be REUSED

- The service already uses `BadRequestException` (NestJS built-in) for input-validation failures
  elsewhere in this file (11 occurrences) — follow that convention, not `ArgumentInvalidException`,
  for consistency within this specific service.
- `CONSULTATION_STATUS_VALUES` (`update-consultation.request.ts:18`) is the existing allow-list to
  reuse for hardening the mapper (§4 Task 3).

## 3. Knowledge & Best Practices

- **`.claude/rules/05-nestjs-api.md`** — "Global `ValidationPipe`: `transform + whitelist +
  forbidNonWhitelisted + forbidUnknownValues`" protects against *undeclared top-level fields*, not
  against an under-validated *nested* field's internal shape — `@IsObject()` on `metadata` is
  exactly the gap that pipe cannot close, which is why this needs an explicit fix rather than a
  pipe configuration change.
- **`.claude/rules/04-application-services.md`** — "Request DTOs: `class-validator` decorators...
  on EVERY field" — `metadata`'s decorator exists but is too permissive for a field that is
  shallow-merged into a column another code path treats as authoritative for consultation
  lifecycle. The fix keeps `metadata` genuinely open for non-reserved keys (it is documented as
  "additional metadata") while closing the one key that collides with a security-relevant
  precedence rule.
- **`.claude/rules/01-development-workflow.md`** TDD ordering: RED test first (Task 1), then the
  DTO fix (Task 2), then the mapper hardening (Task 3) — each independently testable and each
  closing a different half of the vulnerability (input-side and read-side), per Karpathy guideline
  #4 (goal-driven execution: "Fix the bug" → "Write a test that reproduces it, then make it pass").
- **Anti-pattern avoided**: `01-development-workflow.md`'s "Claim done without evidence" —
  Acceptance Criteria below require pasted test output.
- **Pitfall specific to this fix**: do not "fix" this by making the mapper prefer `columnStatus`
  unconditionally — that would silently stop `closeConsultation`/`reopenConsultation` (which
  legitimately never touch the typed column) from ever reporting `CLOSED`. The fix must
  distinguish "an unrecognized/forged value in `metadata.status`" from "the legitimate `OPEN`/
  `CLOSED` values `transitionStatus` writes," not eliminate the legacy channel outright (that's
  `TASK-711`'s job).

## 4. Implementation Plan

### Task 1 — RED: failing tests reproducing the forgery
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/applications/src/services/consultation/consultation/__tests__/consultation.service.test.ts` (extend), `packages/applications/src/services/consultation/consultation/__tests__/consultation.dto.mapper.test.ts` (extend)
- **Approach:** Add two failing tests against current behavior:
  1. Service-level: call `updateConsultation(id, { metadata: { status: 'SIGNED' } })` against a
     fixture consultation whose typed `status` column is `OPEN`; assert the resulting entity's
     `metadata.status` is NOT `'SIGNED'` (post-fix — currently it is, so this is RED first) — either
     the call should reject (400) or the merge should have stripped the reserved key, per whichever
     Task 2 design is chosen (see Task 2's approach note).
  2. Mapper-level: call `ConsultationDtoMapper.toResponse` on an entity fixture with
     `entity.status = 'OPEN'` and `entity.metadata = { status: 'SIGNED' }`; assert the returned
     `status` is NOT `'SIGNED'` post-fix (it currently is — RED first). Also add a companion test
     that `entity.metadata = { status: 'CLOSED' }` (the legitimate value `transitionStatus` writes)
     still maps to `status: 'CLOSED'` — this is the non-regression guard for `closeConsultation`.
- **Verify:** `pnpm --filter @arcaai/applications test -- consultation.service consultation.dto.mapper` —
  both new tests fail (RED) against current code, existing tests unaffected.

### Task 2 — Deny the reserved `status` key inside `metadata`
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/applications/src/services/consultation/consultation/consultation.service.ts`
- **Approach:** In `updateConsultation` (lines 730-777), before the shallow merge at line 757-758,
  reject the request with `BadRequestException` if `request.metadata` contains a `status` key —
  explicit rejection (not silent stripping), consistent with this repo's general "no silent
  success/failure" posture and because a caller who genuinely meant to set lifecycle status should
  use the dedicated, validated `request.status` field instead:

  ```ts
  if (request.metadata !== undefined && 'status' in request.metadata) {
    throw new BadRequestException(
      "metadata.status is reserved for internal lifecycle tracking; use the top-level 'status' field to change lifecycle state.",
    );
  }
  ```

  Place this check immediately after the `tenantId`/`consultation` existence checks, before any
  mutation. Do not touch `transitionStatus` (lines 664-705) — it never reads `request.metadata`, so
  it is unaffected by this change.
- **Verify:** `pnpm --filter @arcaai/applications test -- consultation.service` — Task 1's service
  test now passes (GREEN, via the reject path — update the test's assertion to expect a thrown
  `BadRequestException` if that's the chosen design).

### Task 3 — Harden the mapper against any other write path that reaches `metadata.status`
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/applications/src/services/consultation/consultation/consultation.dto.mapper.ts`
- **Approach:** Defense-in-depth for the read side, independent of Task 2: in `toResponse` (lines
  14-43), validate `metaStatus` against `CONSULTATION_STATUS_VALUES`
  (`import { CONSULTATION_STATUS_VALUES } from './dto'` — already exported, see
  `update-consultation.request.ts:18`) before trusting it:

  ```ts
  const metaStatus = metadata?.status as string | undefined;
  const validMetaStatus = metaStatus && (CONSULTATION_STATUS_VALUES as string[]).includes(metaStatus) ? metaStatus : undefined;
  const status =
    columnStatus && columnStatus !== CONSULTATION_STATUS.OPEN ? columnStatus : (validMetaStatus ?? columnStatus ?? CONSULTATION_STATUS.OPEN);
  ```

  This closes the forgery even if a future code path writes `metadata.status` directly without
  going through `updateConsultation` (e.g. a migration script, a different service method added
  later) — the mapper itself can now never surface a value outside `OPEN`/`CLOSED`, so `'SIGNED'`
  specifically (and anything else) cannot reach a response regardless of source.
- **Verify:** `pnpm --filter @arcaai/applications test -- consultation.dto.mapper` — Task 1's mapper
  tests now pass (GREEN), including the `CLOSED`-still-works non-regression test.

### Task 4 — Audit other `metadata.*` trust points
- **Agent:** T1 · haiku-4-5 · default
- **Files:** none (investigation task; produces findings for the Implementation Summary, and a
  follow-up fix task only if something is found)
- **Approach:** Grep `packages/applications/src/services/consultation/consultation/*.ts` and
  `apps/api/src/modules/consultation*/*.ts` for every read of `.metadata?.` / `entity.metadata` /
  `consultation.metadata` other than the two already fixed above (`readStatus` at
  `consultation.service.ts:651-656`, used only by `transitionStatus`'s idempotency check — reads a
  value ONLY `transitionStatus` itself writes, so it's already safe by construction, not a new
  finding). Confirm no other `metadata.*` key is read as a trusted signal (permission, state,
  identity) anywhere in this module. Record the result in the Implementation Summary: either "no
  other trust points found" or a list of file:line findings for a human to triage (do not
  自主-fix anything found here without confirming scope with the user first — this task is
  reconnaissance, not remediation, if it surfaces something outside this ticket's two known
  vectors).
- **Verify:** N/A (investigation task) — its output is the audit note in §7.

### Task 5 — Regression tests
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/applications/src/services/consultation/consultation/__tests__/consultation.service.test.ts`, `.../consultation.dto.mapper.test.ts`
- **Approach:** Confirm and extend:
  1. `PATCH` with `metadata.status = 'SIGNED'` → rejected (400), consultation entity unchanged.
  2. `PATCH` with a legitimate non-reserved `metadata` key (e.g. `{ metadata: { note: 'hello' } }`)
     → still succeeds and shallow-merges as before (non-regression on the documented "additional
     metadata" use case).
  3. `GET`/read paths after a real `closeConsultation()` call still return `status: 'CLOSED'`
     (non-regression on the legitimate lifecycle path).
  4. Mapper: an entity with a forged `metadata.status` value that somehow bypassed the service
     layer (simulating Task 4 finding a second write path, or a pre-existing dirty row) still
     cannot surface through `toResponse` — the read-side guard from Task 3 holds independent of the
     write-side guard from Task 2.
- **Verify:** `pnpm --filter @arcaai/applications test -- consultation` — full consultation suite
  green. Paste actual output in the Implementation Summary.

## 5. Acceptance Criteria

- [ ] Task 1's two tests exist and were RED before Tasks 2-3 (paste the RED run's output as
      evidence)
- [ ] `PATCH /consultations/:id` with `{"metadata": {"status": "SIGNED"}}` is rejected (400) —
      verified by Task 5's regression test
- [ ] Every response DTO built via `ConsultationDtoMapper.toResponse`/`toResponseWithContext` can
      never surface a `status` value outside `CONSULTATION_STATUS_VALUES` regardless of what
      `metadata.status` contains — verified by Task 3/5's tests
- [ ] `closeConsultation()`/`reopenConsultation()` still work exactly as before (non-regression) —
      verified by Task 5's test
- [ ] `pnpm --filter @arcaai/applications test` — full package suite green, output pasted
- [ ] `pnpm --filter @arcaai/applications build` succeeds
- [ ] `pnpm api:build` succeeds (controller/DTO consumers unaffected)
- [ ] `pnpm test:unit` (root aggregate) green
- [ ] `pnpm lint` — no new errors/warnings
- [ ] `pnpm typecheck` clean
- [ ] Task 4's audit note is recorded in §7 Implementation Summary, with any additional findings
      flagged (not auto-fixed) for the user

## 6. Risks & Open Questions

- **Design choice in Task 2 (reject vs. strip)**: this plan specifies explicit rejection
  (`BadRequestException`) over silent stripping of the reserved key, on the grounds that a caller
  who supplied `metadata.status` almost certainly meant something by it and deserves an explicit
  error rather than a request that "succeeds" with different data than requested. If the user
  prefers silent stripping instead (to avoid breaking any existing integration that happens to
  send a no-op `metadata.status` key), that is a one-line change to Task 2 — flag this choice for
  confirmation if any existing client is found sending `metadata.status` today (Task 4's audit is
  the place to check for that, by extension, if time allows).
  This is a design decision the executing agent can make and does not require a human gate to
  START implementation — the note above ensures reversibility is understood.
- This ticket does not close A-13's full "two closed-trackers" architecture — `POST :id/close`
  will still write only to `metadata.status`, never to the typed `ConsultationStatus` column,
  until `TASK-711 session-state-machine` lands and deletes `metadata.status` outright.
- If Task 4 finds an additional untrusted `metadata.*` read, scope it out of this ticket (S-sized,
  single-defect) and either spawn a follow-up ticket or flag it to the user for triage rather than
  silently expanding this ticket's diff.

## 7. Implementation Summary

Executed 2026-08-16 against `feat/loop`. All 5 tasks from §4 completed as planned; the "reject vs.
strip" design choice (§6) resolved to **reject** (`BadRequestException`), the plan's default.

### Files changed

- `packages/applications/src/services/consultation/consultation/consultation.service.ts` — Task 2:
  in `updateConsultation`, immediately after the tenant-ownership check and before any mutation,
  reject the request with `BadRequestException` when `request.metadata` contains a `status` key.
  `transitionStatus` (backing `closeConsultation`/`reopenConsultation`) is untouched — it never
  reads `request.metadata`.
- `packages/applications/src/services/consultation/consultation/consultation.dto.mapper.ts` —
  Task 3: in `ConsultationDtoMapper.toResponse`, `metadata.status` is now validated against
  `CONSULTATION_STATUS_VALUES` (`['OPEN','CLOSED']`) before being trusted; an unrecognized value
  (e.g. a forged `'SIGNED'`) falls through to `columnStatus ?? CONSULTATION_STATUS.OPEN` instead of
  being surfaced. `columnStatus` (the typed `ConsultationStatus` enum column — `PENDING_REVIEW`,
  `SIGNED`, `RECORDING`, etc., written only by the harness attestation gate) is untouched, so
  legitimate non-OPEN column values still take precedence exactly as before.
- `packages/applications/src/services/consultation/consultation/__tests__/consultation.service.test.ts` —
  Task 1 (RED) + Task 5: added `rejects PATCH with a reserved status key inside metadata (forgery
  attempt)` under `updateConsultation`, asserting `BadRequestException`, no repository `update`
  call, no `ResourceUpdated` event. Task 5's other three regression scenarios (legitimate
  non-reserved `metadata` key still merges; `closeConsultation`/`reopenConsultation` still report
  `CLOSED`/`OPEN`; a forged-but-persisted row is still blocked read-side) were already covered by
  pre-existing tests in this file (`updates departmentId ... and shallow-merges metadata`,
  `closeConsultation`/`reopenConsultation` describe blocks) — no additional test needed there.
- `packages/applications/src/services/consultation/consultation/__tests__/consultation.dto.mapper.test.ts` —
  Task 1 (RED) + Task 5: added `should NOT surface a forged metadata.status value outside
  CONSULTATION_STATUS_VALUES` (entity fixture with `status: 'OPEN'`, `metadata: { status: 'SIGNED'
  }`, simulating a row that bypassed the service-layer guard — Task 5 scenario 4) and a companion
  non-regression test that the legitimate `CLOSED` value still surfaces.

### TDD evidence

**RED** (`npx vitest run` on the two extended test files, before Tasks 2-3 landed):

```
FAIL  .../consultation.dto.mapper.test.ts > ConsultationDtoMapper > toResponse > should NOT surface a forged metadata.status value outside CONSULTATION_STATUS_VALUES
AssertionError: expected 'SIGNED' not to be 'SIGNED' // Object.is equality

FAIL  .../consultation.service.test.ts > ConsultationService > lifecycle (close / reopen / update) > updateConsultation > rejects PATCH with a reserved status key inside metadata (forgery attempt)
AssertionError: promise resolved "{ id: 'c-1', …(12) }" instead of rejecting
- Error { "message": "rejected promise" }
+ { ..., "metadata": { "existing": "keep", "status": "SIGNED" }, "status": "SIGNED", ... }
```

(Two additional failures observed in that same run, `live-documentation.service.test.ts` /
`smrFailed degradation marker (TASK-703)`, belong to a concurrently-running sibling ticket editing
that file in the same working tree — unrelated to this ticket, not touched here, and green again by
the next run once that sibling agent's change landed.)

**GREEN** (after Tasks 2-3, isolated run of only the two touched test files — avoids picking up
transient failures from other agents' concurrent edits elsewhere in the tree):

```
$ npx vitest run "src/services/consultation/consultation/__tests__/consultation.service.test.ts" "src/services/consultation/consultation/__tests__/consultation.dto.mapper.test.ts"
 Test Files  2 passed (2)
      Tests  121 passed (121)
   Duration  15.62s
```

Full `consultation`-scoped suite (all files matching `*consultation*`), also green:

```
$ pnpm --filter @arcaai/applications test -- consultation
 Test Files  477 passed | 1 skipped (478)
      Tests  8984 passed | 4 skipped (8988)
```

### Task 4 — audit of other `metadata.*` trust points (investigation only, per plan)

Grepped `packages/applications/src/services/consultation/consultation/*.ts` and
`apps/api/src/modules/consultation*/*.ts` for every read of `metadata`. Findings:

- `readStatus` (`consultation.service.ts:654-656`), used only by `transitionStatus`'s idempotency
  check — reads a value ONLY `transitionStatus` itself writes. Already safe by construction, not a
  new finding (matches the plan's expectation).
- `ConsultationDtoMapper.toResponse`/`toResponseWithContext` — the two already-hardened read sites
  (Task 3).
- `consultation.service.ts:757-758` (`updateConsultation`'s shallow merge) — the already-hardened
  write site (Task 2).
- **New finding, flagged per Task 4's "reconnaissance, not remediation" instruction, NOT
  auto-fixed**: `getOrCreate` (`consultation.service.ts:133-141`) and `createRevisit`
  (`consultation.service.ts:187-196`) — both backing `OpenConsultationRequest`
  (`dto/open-consultation.request.ts`) — also accept an unvalidated `metadata: Record<string,
  unknown>` (`@IsObject()` only, same gap as `UpdateConsultationRequest` had) and write it verbatim
  into the newly-created entity's `metadata` column via `ConsultationFactory.CreateNewVisit`/
  `CreateRevisit`. In principle a caller could pass `metadata: { status: 'SIGNED' }` at consultation
  **creation** time through this second, unguarded write path. Practical impact: **already
  neutralized by Task 3's read-side fix** — the mapper's `CONSULTATION_STATUS_VALUES` validation
  applies regardless of which write path produced the value, so this cannot currently forge a
  displayed `SIGNED` status. It remains an inconsistency (the write-side guard from Task 2 only
  covers `updateConsultation`, not `getOrCreate`/`createRevisit`) worth closing for defense-in-depth
  symmetry, but is out of this ticket's diff per the "flag, don't auto-fix" instruction. Flagging
  for the user: consider extending Task 2's reserved-key check to `getOrCreate`/`createRevisit` in a
  follow-up (S-sized), or defer to `TASK-711` if it's expected to fold in with the broader
  `metadata.status` removal.

### Acceptance criteria (§5) — status

- [x] Task 1's two tests exist and were RED before Tasks 2-3 (evidence above)
- [x] `PATCH /consultations/:id` with `{"metadata": {"status": "SIGNED"}}` is rejected (400) —
      verified by the service test
- [x] Every response DTO built via `ConsultationDtoMapper.toResponse`/`toResponseWithContext` can
      never surface a `status` value outside `CONSULTATION_STATUS_VALUES` from `metadata.status`
      regardless of content — verified by the mapper tests
- [x] `closeConsultation()`/`reopenConsultation()` still work exactly as before (non-regression) —
      verified by the pre-existing lifecycle tests, still green
- [x] `pnpm --filter @arcaai/applications test` (consultation-scoped) — full suite green, output
      pasted above
- [x] `pnpm --filter @arcaai/applications build` succeeds (`tsc`, no errors)
- [x] `pnpm --filter @arcaai/applications typecheck` clean (`tsc --noEmit`, no errors)
- [ ] `pnpm api:build` — **not independently confirmed clean**: a run during execution failed on
      unrelated errors in `note-generation.service` and `dna-writing-style.processor`, both files
      under active edit by other concurrent sibling agents in this shared working tree (confirmed
      via `git status` — untracked/modified by files I never touched), not caused by this ticket's
      diff. `@arcaai/applications#build` in isolation (above) is clean. Re-verify `pnpm api:build`
      once the other in-flight tickets land; not re-run here per the instruction to touch only this
      ticket's files and avoid relying on a moving cross-package aggregate mid-sprint.
- [ ] `pnpm test:unit` (root aggregate) — **not run**, per this execution's explicit instruction to
      use only package-scoped commands (a separate final verification agent runs repo-root
      aggregates after all sibling tickets land).
- [ ] `pnpm lint` (root aggregate) — **not run** for the same reason;
      `pnpm --filter @arcaai/applications lint` was run instead and confirmed 0 new
      warnings/errors on the 4 files this ticket touched (existing warnings at untouched lines
      unaffected).
- [x] `pnpm --filter @arcaai/applications lint` — 0 new errors/warnings introduced by this diff
      (verified line-by-line against `git diff`)
- [x] Task 4's audit note is recorded above, with the one additional finding flagged (not
      auto-fixed) for the user

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | T3/T4 authoring agent (Claude, sonnet-5) |
| 2026-08-16 | Implemented Tasks 1-5: RED tests, service-layer reserved-key rejection (Task 2), mapper read-side validation against `CONSULTATION_STATUS_VALUES` (Task 3), Task 4 audit (one new finding flagged, not auto-fixed), GREEN confirmed. Status → Completed. | T2 execution agent (Claude, sonnet-5) |
