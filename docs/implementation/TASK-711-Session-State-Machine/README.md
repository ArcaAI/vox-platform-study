# TASK-711 — Session State Machine

| | |
|---|---|
| **Status** | In Progress |
| **Wave** | 1 · **Size** | L |
| **Epic slug** | `session-state-machine` |
| **Depends on** | TASK-701 (`signed-status-forgery`), TASK-704 (`generator-entry-point-seam`) |
| **Design refs** | D1 (staged generator migration — the seam this ticket transitions through), D5/Plane 2 Wave 1, [design.md](../../architecture/agentic-workflow-platform/design.md) §Plane 2, §Error handling ("Timeout force-stops that node only; 'Degraded' is health flags, not a state" · "HITL timeout → `Timed Out`, visibly unsigned, notification — the clock never signs") |
| **Findings closed** | A-13, A-33, A-41, A-46 · A-36 (consultation half only; the `ContextItem` half belongs to `context-lifecycle`) · [ADDED-1] from `evidence/orchestration.md` |

---

## 1. Requirement Analysis

**What this delivers.** One authoritative, guarded clinical lifecycle for a consultation.
Today the platform has *two* lifecycle trackers that cannot see each other — the typed
`Consultation.status` column and a legacy `metadata.status` JSON key — and the typed one
carries two enum members (`CLOSED`, `REOPENED`) that no code writes. This ticket:

1. Establishes the **real state enum** (each reference state adopted / renamed / rejected, with
   rationale), replacing the reference's `Degraded` state with health flags.
2. Adds **`ConsultationEntity.transitionTo(next, actor, reason)`** carrying an explicit legality
   matrix, and makes it the only way `status` is written.
3. **Deletes `metadata.status`** — the second tracker — and backfills the rows it produced.
4. **Emits an event per transition**: `SysEventType.ResourceUpdated` for routine transitions,
   plus a `HarnessAuditEvent` WORM row for the clinically-significant ones.
5. Adds `Consultation.degradedReasons String[]` so "degraded" is a filterable projection on the
   active phase rather than a state that erases the phase.

**Invariants satisfied.** From [01-invariant-register.md](../../architecture/consultation-session-workflow/assessment/01-invariant-register.md):

| Mechanism | Invariants |
|---|---|
| `CLOSED` reachable only from `SIGNED` / `TIMED_OUT` | INV-174, INV-175 (`timeout-approval`) |
| A distinct, persisted, visibly-unsigned `TIMED_OUT` + clinician notification | INV-177, INV-181, INV-182, INV-183, INV-413, INV-255, INV-147 (`timeout-approval`) |
| `TIMED_OUT → SIGNED` remains legal (a later explicit approval still commits; the clock never signs) | INV-413, INV-161, INV-162 |
| `RECORDING` unreachable before `PRIMED` | INV-003, INV-004, INV-201 (`consent-abac` — the *gate content* is TASK-712; this ticket supplies the state it hangs on) |
| `DRAINING` as a persisted phase; stop-capture is not approval | INV-121, INV-122, INV-124, INV-125, INV-130, INV-357 (`drain-shutdown`) |
| `degradedReasons` flags ORed onto the active phase | INV-072, INV-073 (`degradation`) |
| Single-sourced terminal representation | [ADDED-1] (`evidence/orchestration.md` §[ADDED] invariants) |

**Explicitly OUT of scope.**

- **The `SIGNED` write site.** `summary.service.ts:978` keeps its single writer, its single caller,
  and its authenticated-human gate. This ticket adds a legality *assertion* around it that can
  only ever narrow the set of legal predecessors — never widen it. See §3 Pitfalls.
- **`PAUSED`.** The reference's `Paused` state has no server-side writer anywhere (A-20: the only
  pause is `packages/agentic-sdk-v2/src/compat/useArcaSessionManager.ts:192-199`, which sets local
  React state). Adding an enum member with no writer is *exactly* the A-46 defect this ticket
  closes. `PAUSED` is designed in the state chart (Task 1) and deferred to the `checkpoint-resume`
  epic, which will append it in one line.
- **Per-section HITL / `PENDING_REVIEW → DRAFT_PENDING_SENSORS` return-for-regen** — the transition
  is reserved in the matrix but disabled; it belongs to `note-sections`.
- **`ContextItem.lifecycleState`** (the other half of A-36) — `context-lifecycle` epic.
- **Consent evaluation itself** — TASK-712. This ticket only makes `PRIMED` exist and makes
  `RECORDING` require it.
- **Optimistic-concurrency on note *content*** — TASK-709 (`note-occ`). Status writes in this
  ticket do take `updateWithVersion`; note content does not change here.

---

## 2. Current State Evaluation

All evidence below was re-derived against the working tree on branch `feat/loop` (2026-08-16).
Searches excluded `.claude/worktrees/**`, `**/dist/**`, `**/node_modules/**`, `**/.venv/**`,
`**/__pycache__/**`, and `packages/database/src/generated/core-prisma-client/**`.

### 2.1 The enum, and which members are dead

`packages/database/src/prisma/db_main/enums.prisma:278-288` declares seven members:

```
278: enum ConsultationStatus {
279:   OPEN                   // Active consultation, not yet under review
280:   RECORDING              // Audio capture in progress
281:   DRAFT_PENDING_SENSORS  // Draft delivered early …
282:   PENDING_REVIEW         // … awaiting clinician review/attestation
283:   SIGNED                 // Clinician-attested (immutable signed note committed)
284:   CLOSED                 // Consultation closed
285:   REOPENED               // Reopened after being closed
```

A repo-wide sweep of `ConsultationStatus.<MEMBER>` over `git ls-files -- '*.ts'`, excluding
`src/generated/` and test files, returns **zero** `CLOSED` and **zero** `REOPENED` references.
Confirmed A-46. The complete live write-site inventory is:

| Site | Writes |
|---|---|
| `packages/applications/src/services/consultation/consultation/consultation.service.ts:795` | `RECORDING` (via `setRecordingStatus`, `startRecording`) |
| `…/consultation.service.ts:803` | `OPEN` (via `setRecordingStatus`, `stopRecording`) |
| `…/consultation/harness/harness-internal.service.ts:893` | `DRAFT_PENDING_SENSORS` \| `PENDING_REVIEW` (`persistDraft`) |
| `…/harness/harness-internal.service.ts:1035` | `PENDING_REVIEW` (`finalizeAssurance`) |
| `…/consultation/summary/summary.service.ts:978` | `SIGNED` (`approveSummary`) |

Reads: `harness-internal.service.ts:1017` (`alreadySigned`), `summary.service.ts:784`,
`ConsultationEntity.ts:176` (`isSigned`), `ConsultationRepository.ts:372`
(`findPendingReviewForTenant`, the harness gate queue), `agentPromotion.service.ts:479`.

**A second finding, not in the assessment and load-bearing for this design:** `stopRecording`
writes `OPEN`, not a post-recording state (`consultation.service.ts:802-804`, with the service's
own comment at `:799` — *"Revert the consultation's `status` column to OPEN when recording
stops"*). So the column **erases the fact that capture ever happened**. "Was this consultation
recorded?" is unanswerable from `status`, which is precisely why A-13's `POST :id/close` on a
never-recorded consultation is indistinguishable from a legitimate close in the column.

### 2.2 The second tracker

`metadata.status` is the real close/reopen mechanism (`consultation.service.ts:640-719`), and the
service documents it in its own header at `:641-648`:

> *"The Consultation model has no dedicated open/closed column, so the lifecycle status lives in
> `metadata.status` (OPEN | CLOSED; absent ⇒ OPEN)…"*

That comment is now **stale** — the typed column exists (`consultation.prisma:36`, with its own
comment *"Lifecycle state — typed promotion of the legacy free-form `metadata.status` JSON"*).
Both trackers survived the promotion.

- `readStatus` — `consultation.service.ts:654-656`
- `transitionStatus` (private, the shared close/reopen path) — `:664-707`; writes
  `consultation.metadata = { …currentMeta, status: target, [closedAt|reopenedAt]: ISO }` at
  `:687-691`, persists with a plain `this.consultationRepository.update(id, consultation)` at
  `:698`, broadcasts `SysEventType.ResourceUpdated` at `:700-703`.
- `closeConsultation` — `:710-712`; `reopenConsultation` — `:717-719`.
- Vocabulary: `CONSULTATION_STATUS = { OPEN, CLOSED }` and `ConsultationLifecycleStatus` at
  `packages/applications/src/services/consultation/consultation/dto/update-consultation.request.ts:11-18`.
- `UpdateConsultationRequest.status` (`…/update-consultation.request.ts:41-47`) is
  `@IsIn(CONSULTATION_STATUS_VALUES)` — i.e. `OPEN | CLOSED` — and `updateConsultation` writes it
  straight into `nextMeta.status` (`consultation.service.ts:760-762`), a **third** writer of the
  legacy field.
- Controller: `POST :id/close` at `apps/api/src/modules/consultation/consultation.controller.ts:434-442`
  and `POST :id/reopen` at `:447-454`, both guarded by `verifyConsultationOwnership` **only**
  (`:296-317`), which admits the assigned doctor *or* any caller holding `manage:Consultation`.

`transitionStatus` never reads the typed column. **`closeConsultation` therefore has zero
dependency on `SIGNED`** — confirming A-13 / `evidence/orchestration.md` F-02 verbatim.

### 2.3 The DTO mapper's preference

`packages/applications/src/services/consultation/consultation/consultation.dto.mapper.ts:22-25`:

```ts
const columnStatus = entity.status as string | undefined;
const metaStatus = metadata?.status as string | undefined;
const status =
  columnStatus && columnStatus !== CONSULTATION_STATUS.OPEN ? columnStatus : (metaStatus ?? columnStatus ?? CONSULTATION_STATUS.OPEN);
```

(The assessment cited `:23-26`; the live lines are `:22-25`.) **TASK-701 owns removing this
preference and validating `metadata`.** This ticket must land *after* it, because deleting
`metadata.status` while the mapper still prefers it would change every read response mid-flight.
Sequencing is a hard constraint, not a courtesy.

### 2.4 No transition legality anywhere

`packages/domains/src/entities/generated/core/ConsultationEntity.ts`:

- `:105-111` — `get status()` / `set status(value)`; the setter is a bare
  `this.setProperty('status', value)`.
- `:179-190` — `validate()` checks only `patientId`, `doctorId`, `appointmentDate`.
- `:174-177` — `get isSigned()` is the only status-derived domain method.

So every guard that exists today is bespoke prose at an individual call site. There are exactly
two: `harness-internal.service.ts:1034` (`if (consultation.status === DRAFT_PENDING_SENSORS)`) and
`approveSummary`'s identity/business checks. Nothing a future write path inherits. Confirms A-36's
consultation half.

### 2.5 What already exists that this ticket MUST reuse

| Asset | Path | Reuse |
|---|---|---|
| OCC primitive | `packages/domains/src/common/repository.ts:208` `updateWithVersion(id, entity, expectedVersion)` | Every status write |
| Change tracking | `BaseEntity.setProperty` (`packages/domains/src/common/baseEntity/base.entity.ts`) | `transitionTo` writes through it — never assign `_status` directly |
| WORM ledger | `packages/applications/src/services/harness-audit/harness-audit.service.ts:76` `append(AppendHarnessAuditInput)` (interface at `:37-53`) | Clinically-significant transitions |
| WORM enum | `HarnessAuditAction` (`packages/database/src/prisma/db_main/harness.prisma:19-36`) | Needs three new members (§4 Task 2) |
| Enum-parity discipline | `packages/domains/src/enums/__tests__/resourceType.enum-parity.test.ts` | The pattern for the new "no unwired enum member" gate |
| Escalation seam | `harness-internal.service.ts:1259` `recordEscalation(...)` — today appends `GATE_ESCALATED`/`GATE_ABANDONED` and **never touches status** | The `TIMED_OUT` writer |
| Gate queue read | `packages/domains/src/repositories/generated/core/ConsultationRepository.ts:368-378` `findPendingReviewForTenant` | Must keep working; add a `TIMED_OUT` sibling |
| Notification domain | `packages/applications/src/services/notification/notification.service.ts` (+ `INotificationService.ts`, `packages/domains/src/enums/generated/NotificationType.ts`) | The `TIMED_OUT` clinician notification — A-33's "no notification pathway found" is wrong about *existence*; it is right that nothing wires it |
| ETag/If-Match exemplar | `apps/api/src/modules/webhook/webhook.controller.ts:86,107` (`@RequiresIfMatch()` + `@ExpectedVersion()`) | Transition routes |
| Tenant guards | `packages/applications/src/common/tenant-guards.ts:87` `assertEqualTenants` | Already used on every path touched here |
| Admin-console contract | `apps/admin-console/src/features/consultations/api/types.ts:7` `CONSULTATION_STATUSES` | Must be extended in lockstep — it is validated server-side (`?status`) |

---

## 3. Knowledge & Best Practices

### 3.1 Repo law that binds this work

| Rule | Section | Binding effect |
|---|---|---|
| `.claude/rules/02-database-prisma.md` | §Migration Workflow | The local dev DB is `db push`-managed with **no** `_prisma_migrations` ledger. Author the migration against a throwaway `hope_shadow` database using the documented recipe; prove no drift with `npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script` printing `-- This is an empty migration.` |
| `.claude/rules/02-database-prisma.md` | §Migration Workflow (arg traps) | `-n` must go to the **package-level** script: `pnpm --filter @arcaai/database db:migrate:create -n task_711_…`. The root alias swallows it and Prisma hangs on the interactive prompt |
| `.claude/rules/02-database-prisma.md` | §Migration Workflow (`@@unique` trap) | Only relevant if an index is added: `name:` on `@@unique` is the *client-facing* compound key; the DB index name comes from `map:` |
| `.claude/rules/02-database-prisma.md` | §Standard Model Field Template | `degradedReasons` goes in the **core (business) fields** block — after multi-tenant, before resource-status |
| `.claude/rules/03-domain-layer.md` | §Generated Code Discipline | `pnpm gen:model` is the only scaffolder. `gen:entity` / `gen:factory` reconcile + check coverage and **never create files**. `pnpm gen:repository` is broken. **`pnpm gen:mapper` is destructive — never run it**; it drops `FIELDS_NOT_WRITABLE = ['version']` before crashing |
| `.claude/rules/03-domain-layer.md` | §Strict Rules | Never assign entity fields directly — route through `setProperty()`; `repository.update` persists only `entity.changes` |
| `.claude/rules/03-domain-layer.md` | §Adding a New Domain Model, step 4 | A new `HarnessAuditAction` member is a Prisma enum change needing an `ALTER TYPE … ADD VALUE` migration. No new `ResourceType` member is needed — `Consultation` already exists at `packages/domains/src/enums/generated/ResourceType.ts:27` |
| `.claude/rules/04-application-services.md` | §Strict Rules / §Canonical CRUD Flows | Extend `BaseService`; `broadcastSysEvent` after every mutation; cross-tenant → `NotFoundException`, never `ForbiddenException`; no `databaseService.client` in a service |
| `.claude/rules/05-nestjs-api.md` | §Optimistic Concurrency | `_version` → strong ETag → `@RequiresIfMatch()` (missing → 428) + `@ExpectedVersion()` → `updateWithVersion` → drift → 412 |
| `.claude/rules/05-nestjs-api.md` | §Controllers | The consultation controller declares routes through the custom `@ApiEndpoint()` decorator rather than `@Patch`/`@Post` — **verify guard interaction explicitly**, do not assume |
| `.claude/rules/01-development-workflow.md` | §Layer Dependency Chain | Database → Domain → Services → API, each gate green before the next |

### 3.2 Base practices this implementation follows

| Practice | Why here |
|---|---|
| **State machine as an entity method, not a service helper** | The entity is the only object every write path already holds. A service-level helper is opt-in; `transitionTo` on the entity plus a private setter is opt-out-proof |
| **Append-only enum evolution** | Postgres `ALTER TYPE … ADD VALUE` is non-destructive and needs no table rewrite. Never renumber or rename an existing member — `REOPENED`/`CLOSED` are resurrected in place, not replaced |
| **Health flags as an array column, not a state** | `degradedReasons String[]` composes with every phase and is directly filterable (`array_position`), which a mutually-exclusive state cannot be. This is the assessment's own §8 reference-defect finding and design.md's §Error handling position |
| **Backfill derived from an observed-distribution query, not from assumptions** | The assessment's own §8 warns that "defaults to X" claims proved unreliable twice. Task 1 runs the query first and the migration halts on any unenumerated combination |
| **Two-mode rollout for the one breaking precondition** | Only `RECORDING requires PRIMED` breaks existing clients. It ships behind a `killSwitch` descriptor (`.claude/rules/09-infrastructure-devops.md` §Configuration Tiers — `redis-flag` tier, must default OFF) so enforcement is a flip, not a deploy |

### 3.3 Pitfalls specific to THIS ticket

1. **Never run `pnpm gen:mapper`.** `ConsultationEntityMapper` is OCC-written; the generator drops
   the `_version` strip. Recovery is `git checkout -- packages/domains/src/mappers/generated/core/`.
2. **Do not touch `summary.service.ts:978`'s write itself.** A legality assertion goes *before* it
   and may only ever throw. If the matrix would ever make a currently-legal sign illegal, the
   matrix is wrong — `SIGNED` is reachable today from `DRAFT_PENDING_SENSORS` (the deliberate
   optimistic-delivery Q2a path, `summary.service.ts:784`) **and** from `PENDING_REVIEW`, and both
   must stay legal. Encode both, then re-read `approveSummary` to confirm nothing else reaches it.
3. **The backfill must never write `SIGNED`.** Rows with `metadata.status = CLOSED` but no
   `SIGNED_NOTE` version are *administratively archived unsigned records*, not signed ones. They
   go to `resourceStatus = ARCHIVED` with `status` untouched. Writing `SIGNED` from a migration
   would be the exact forgery the whole program exists to prevent, and it would be worse than
   §3.1's because it lands in the column rather than in presentation.
4. **`stopRecording` currently returns to `OPEN`.** Changing it to `DRAINING` changes what
   `RecordingStateResponse.status` reports (`consultation.controller.ts:485-493` returns
   `consultation.status ?? 'RECORDING'`) and what the admin console renders. Update
   `apps/admin-console/src/features/consultations/api/types.ts:7` in the same change or the grid's
   `?status` filter 400s on the new values.
5. **`ConsultationRepository.findPendingReviewForTenant` backs the harness gate queue.** If
   `TIMED_OUT` rows silently drop out of it, the escalation UI loses the very records the new
   state exists to surface. Add an explicit `findTimedOutForTenant` rather than widening the
   existing filter.
6. **`HarnessAuditService.append` is a documented unlocked read-then-write** (`harness-audit.service.ts:31-37`)
   — concurrent appends for the same tenant can compute the same `prevHash`. Adding per-transition
   audit rows raises append frequency. Do not fix the lock here (out of scope), but keep the
   append **outside** any transaction that would lengthen the window, and treat an append failure
   on a *routine* transition as non-fatal while an append failure on `SIGNED` stays fail-closed
   (that ordering already exists in `approveSummary` and must not be disturbed).
7. **Idempotency is existing behaviour.** `transitionStatus` short-circuits with no write and no
   sys-event when already in the target state (`consultation.service.ts:682-685`), *"avoids version
   churn and audit noise on UI double-clicks / retries"*. `transitionTo` must preserve that: a
   self-transition returns without writing.
8. **`metadata` is more than `status`.** It also carries `closedAt` / `reopenedAt`
   (`consultation.service.ts:686-691`) and arbitrary caller keys. The deletion strips exactly
   `status`, `closedAt`, `reopenedAt` and leaves everything else intact.

---

## 4. Implementation Plan

TDD-ordered. Phase gates are cumulative — a phase does not start until the previous phase's
`Verify` commands are green.

---

### Phase 0 — Design

#### Task 1 — Author the state chart, legality matrix, and backfill mapping
- **Agent:** T4 · opus-5 · high
- **Files:**
  - create `docs/implementation/TASK-711-Session-State-Machine/state-machine.md`
  - create `docs/implementation/TASK-711-Session-State-Machine/backfill-mapping.md`
- **Approach:**
  1. **State chart.** Write the adopted enum as a table with one row per *reference* state
     (`dataset.xml` Times 0–24: Open, Primed, Streaming, Degraded, Paused, Draining, Drafting,
     Awaiting Review, Closed Approved, Closed, Timed Out, plus `REOPENED` which appears only in
     `user-stories-and-use-cases.md` UC-12) and a verdict of **adopted / renamed / rejected /
     deferred** with one sentence of rationale each. The adopted set is fixed by
     [04-target-architecture.md](../../architecture/consultation-session-workflow/assessment/04-target-architecture.md)
     §1 and design.md §Error handling — reproduce it, do not re-litigate it:

     | # | Adopted member | Reference state | Verdict | Rationale |
     |---|---|---|---|---|
     | 1 | `OPEN` | Open | adopted, exists | — |
     | 2 | `PRIMED` | Primed | **adopted, NEW** | Zero `Primed` hits repo-wide; the state consent/ABAC hangs on (TASK-712) |
     | 3 | `RECORDING` | Streaming | adopted, **renamed** | Code name wins; `Streaming` is the reference's word for the same phase |
     | 4 | `DRAINING` | Draining | **adopted, NEW** | Also fixes `stopRecording`'s revert-to-`OPEN` erasure (§2.1) |
     | 5 | `DRAFT_PENDING_SENSORS` | Drafting | adopted, **renamed** | — |
     | 6 | `PENDING_REVIEW` | Awaiting Review | adopted, **renamed** | — |
     | 7 | `SIGNED` | Closed Approved | adopted, **renamed** | The keystone. Write site untouched |
     | 8 | `TIMED_OUT` | Timed Out | **adopted, NEW** | Terminal *absent explicit reopening*, not terminal |
     | 9 | `CLOSED` | Closed | adopted, **resurrected** | Housekeeping follow-on; guarded so it presupposes `SIGNED`/`TIMED_OUT` — which is what red-team §6's "merge T21+T23" is actually asking for |
     | 10 | `REOPENED` | *(stories only, UC-12)* | adopted, **resurrected** | The reference's own inconsistency; the member already exists |
     | — | *(none)* | **Degraded** | **REJECTED as a state** | → `Consultation.degradedReasons String[]`. Reference models it as a one-row transient while every other row is durable (red-team §2) |
     | — | *(none)* | **Paused** | **DEFERRED** | No server-side writer exists (A-20). Shipping it now recreates A-46. Transitions are specified here; the member is appended by `checkpoint-resume` |

  2. **Legality matrix.** One row per legal transition; every unlisted pair throws. Columns:
     `from`, `to`, `guard` (the precondition), `trigger` (who may cause it), `enforcement`
     (`guarded` = a precondition is checked, `recorded` = unconditional but still routed through
     `transitionTo`), `events`.

     | from | to | guard | trigger | events |
     |---|---|---|---|---|
     | `OPEN` | `PRIMED` | consent asserted (TASK-712 wires the assertion; a no-op stub here) | clinician (owner), `POST :id/prime` | `ResourceUpdated` + WORM `SESSION_PRIMED` |
     | `PRIMED` | `RECORDING` | **flagged precondition** — see rollout below | clinician (owner), `POST :id/recording/start` | `ResourceUpdated` |
     | `RECORDING` | `DRAINING` | — | clinician (owner), `POST :id/recording/stop` | `ResourceUpdated` |
     | `DRAINING` | `RECORDING` | — | clinician (owner), re-arm capture in the same visit | `ResourceUpdated` |
     | `DRAINING` | `DRAFT_PENDING_SENSORS` | — | system (`persistDraft`, early) | `ResourceUpdated` |
     | `DRAINING` | `PENDING_REVIEW` | — | system (`persistDraft`, legacy) | `ResourceUpdated` |
     | `DRAFT_PENDING_SENSORS` | `PENDING_REVIEW` | — | system (`finalizeAssurance`) | `ResourceUpdated` |
     | `DRAFT_PENDING_SENSORS` | `SIGNED` | authenticated human; existing `approveSummary` business gates | clinician, `POST :id/summary/:ctxId/approve` | existing `ATTEST` (+ `SIGNED_BEFORE_ASSURANCE`) |
     | `PENDING_REVIEW` | `SIGNED` | as above | clinician | existing `ATTEST` |
     | `PENDING_REVIEW` | `TIMED_OUT` | gate SLA exhausted | system (`recordEscalation`, terminal abandon) | `ResourceUpdated` + WORM `SESSION_TIMED_OUT` + notification |
     | `TIMED_OUT` | `SIGNED` | as above — **legal by design** | clinician | existing `ATTEST` |
     | `TIMED_OUT` | `REOPENED` | — | owner or `manage:Consultation` | `ResourceUpdated` + WORM `SESSION_REOPENED` |
     | `SIGNED` | `REOPENED` | — | owner or `manage:Consultation` | as above |
     | `CLOSED` | `REOPENED` | — | owner or `manage:Consultation` | as above |
     | `REOPENED` | `PENDING_REVIEW` | — | system, on resumed HITL | `ResourceUpdated` |
     | `SIGNED` | `CLOSED` | — | owner or `manage:Consultation`, `POST :id/close` | `ResourceUpdated` |
     | `TIMED_OUT` | `CLOSED` | — | as above | `ResourceUpdated` |
     | *any* | *itself* | — | any | **none** — idempotent no-op, no write |

     Reserved but **disabled** (throws until its epic lands, with the epic named in the error):
     `PENDING_REVIEW → DRAFT_PENDING_SENSORS` (return-for-regen, `note-sections`); every
     `PAUSED` edge (`checkpoint-resume`).

     State the two answers this matrix forces, explicitly:
     - **"How do I abandon an `OPEN` consultation?"** — `repository.softDelete(id)`. `resourceStatus`
       is the *record* lifecycle; `status` is the *clinical* lifecycle. Conflating them is what
       produced A-13.
     - **"How do I close an unsigned consultation?"** — you cannot. That is INV-174/175.

  3. **Health flags.** Enumerate the `degradedReasons` vocabulary, sourced from the per-run booleans
     that already exist (`degraded`, `reduced_assurance`, `mcp_degraded`, `policy_degraded` — see
     `apps/harness/src/harness/temporal/workflows.py` and `models.py`; verify the exact names
     before writing them down). Append-only within a session; cleared on `SIGNED`.
  4. **Backfill mapping.** Run the observed-distribution query against a real environment
     (dev at minimum; ask an owner for staging) and paste the actual output:

     ```sql
     SELECT c."status"                                     AS column_status,
            c."metadata"->>'status'                        AS meta_status,
            (c."metadata" ? 'closedAt')                    AS has_closed_at,
            (c."metadata" ? 'reopenedAt')                  AS has_reopened_at,
            c."resourceStatus",
            EXISTS (SELECT 1
                      FROM core."ContextItemVersion" v
                      JOIN core."ContextItem" i ON i.id = v."contextItemId"
                     WHERE i."consultationId" = c.id
                       AND v."changeReason" = 'approved')  AS has_signed_note,
            count(*)                                       AS rows
       FROM core."Consultation" c
      GROUP BY 1,2,3,4,5,6
      ORDER BY rows DESC;
     ```

     Then write one mapping row per observed combination. The starting rules (extend, do not
     replace, from the observed output):

     | Observed | Target `status` | Other writes |
     |---|---|---|
     | column ∈ {`RECORDING`,`DRAFT_PENDING_SENSORS`,`PENDING_REVIEW`,`SIGNED`} | unchanged | strip `metadata.status`/`closedAt`/`reopenedAt` |
     | column = `SIGNED`, meta = `CLOSED` | `CLOSED` | strip meta keys |
     | column = `OPEN`, meta = `CLOSED`, `has_signed_note = false` | **unchanged (`OPEN`)** | `resourceStatus = ARCHIVED`, `resourceStatusUpdatedAt = metadata.closedAt`, then strip |
     | column = `OPEN`, meta ∈ {`OPEN`, null} | unchanged | strip |
     | **anything else** | — | **halt the migration with the offending tuple** |

- **Verify:** both documents exist and are self-consistent; every reference state from
  `dataset.xml` appears exactly once in the state chart with a verdict; every enum member in the
  adopted set appears as a `to` in at least one matrix row (this is the property that makes a dead
  member impossible); the backfill table covers 100% of the query's observed combinations.
  Reviewed and approved by the ticket owner before Task 2 starts.

---

### Phase 1 — Database

#### Task 2 — Schema change + migration
- **Agent:** T3 · sonnet-5 · high
- **Files:**
  - modify `packages/database/src/prisma/db_main/enums.prisma` (`ConsultationStatus`)
  - modify `packages/database/src/prisma/db_main/harness.prisma` (`HarnessAuditAction`)
  - modify `packages/database/src/prisma/db_main/consultation.prisma` (`Consultation.degradedReasons`)
  - create `packages/database/src/prisma/db_main/migrations/<timestamp>_task_711_session_state_machine/migration.sql`
- **Approach:**
  1. `ConsultationStatus`: append `PRIMED`, `DRAINING`, `TIMED_OUT` after the existing seven.
     Order in the Prisma file is cosmetic; the SQL must be `ALTER TYPE … ADD VALUE`.
     **Do not** add `PAUSED`.
  2. `HarnessAuditAction`: append `SESSION_PRIMED`, `SESSION_TIMED_OUT`, `SESSION_REOPENED`.
     `SIGNED` is already covered by `ATTEST` — do not add a fourth.
  3. `Consultation`: add `degradedReasons String[] @default([])` in the **core business fields**
     block (after `status`, before `resourceStatus`), per the field template in
     `.claude/rules/02-database-prisma.md`.
  4. Author the migration with the shadow-DB recipe from that rule, verbatim:
     ```bash
     ADMIN=postgresql://postgres:<pw>@localhost:5432
     docker exec hope-postgres psql "$ADMIN/postgres" -c 'DROP DATABASE IF EXISTS hope_shadow' -c 'CREATE DATABASE hope_shadow'
     export DATABASE_URL="$ADMIN/hope_shadow" DIRECT_URL="$ADMIN/hope_shadow"
     pnpm --filter @arcaai/database db:migrate:deploy
     pnpm --filter @arcaai/database db:migrate:create -n task_711_session_state_machine
     pnpm --filter @arcaai/database db:migrate:deploy
     cd packages/database && npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script
     unset DATABASE_URL DIRECT_URL && pnpm db:push
     docker exec hope-postgres psql "$ADMIN/postgres" -c 'DROP DATABASE hope_shadow'
     ```
     Note: Postgres forbids using a newly-added enum value in the *same* transaction that adds it.
     Keep the `ALTER TYPE … ADD VALUE` statements in this migration and **all** data movement in
     Task 11's separate migration.
  5. Review every generated statement by hand before committing.
- **Verify:** the `migrate diff` in step 4 prints `-- This is an empty migration.`;
  `pnpm db:generate`; `pnpm --filter @arcaai/database test`.

#### Task 3 — Regenerate the model layer and reconcile the domain barrels
- **Agent:** T2 · sonnet-5 · low
- **Files:** `packages/domains/src/models/generated/core/ConsultationModel.ts` (regenerated);
  `packages/domains/src/entities/generated/core/ConsultationEntity.ts`,
  `packages/domains/src/factories/generated/core/ConsultationFactory.ts`,
  `packages/domains/src/mappers/generated/core/ConsultationEntityMapper.ts` (hand-edited for
  `degradedReasons`); `packages/domains/src/enums/generated/{ConsultationStatus,HarnessAuditAction}.ts`
- **Approach:** run `pnpm gen:model`. Then **hand-author** the `degradedReasons` field on the
  entity (private backing field + getter + `setProperty` setter), the factory default (`[]`), and
  the mapper's `toPersistence`/`toDomain` — following `AiProviderConnection*` as the hand-authored
  exemplar. **Never run `pnpm gen:mapper`.** Finish with `pnpm gen:entity` + `pnpm gen:factory` to
  reconcile barrels and prove schema coverage.
- **Verify:** `pnpm gen:model:check`, `pnpm gen:entity:check`, `pnpm gen:factory:check` all report
  no drift **and** schema coverage OK; `git status` shows no changes under
  `packages/domains/src/mappers/generated/core/` other than `ConsultationEntityMapper.ts`, and that
  file still contains `FIELDS_NOT_WRITABLE` with `'version'`.

---

### Phase 2 — Domain layer (TDD)

#### Task 4 — RED: the legality matrix as an executable test
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `packages/domains/src/entities/__tests__/ConsultationEntity.transitions.test.ts`
- **Approach:** table-driven from Task 1's matrix. Assert, over the **full Cartesian product** of
  the 10 members (100 pairs):
  - every legal pair transitions and records the change in `entity.changes`;
  - every illegal pair throws `BusinessException` naming both states;
  - every self-pair is a no-op (`entity.hasChanges === false` after the call);
  - reserved-but-disabled pairs throw an error naming the epic that will enable them;
  - `degradedReasons` appends without duplicates and clears on `SIGNED`;
  - `transitionTo` records `actor` and `reason` for the caller to forward to the event/WORM layer.
  Also assert the *count* of legal transitions equals the matrix's row count, so adding an edge
  silently is impossible.
- **Verify:** `pnpm --filter @arcaai/domains test` — the new suite FAILS (the method does not
  exist). Paste the failure.

#### Task 5 — GREEN: `ConsultationEntity.transitionTo`
- **Agent:** T3 · sonnet-5 · medium
- **Files:** modify `packages/domains/src/entities/generated/core/ConsultationEntity.ts`
- **Approach:** add, under the existing `// Custom Domain Methods` block (after `isSigned`, `:174-177`):
  - a module-level `const CONSULTATION_TRANSITIONS: ReadonlyMap<ConsultationStatus, ReadonlySet<ConsultationStatus>>`;
  - `transitionTo(next, actor, reason)` — self-transition returns `false` without writing; illegal
    throws `BusinessException`; legal calls `this.setProperty('status', next)` and returns `true`;
  - `addDegradedReason(reason)` / `clearDegradedReasons()` on the same `setProperty` path;
  - `canTransitionTo(next): boolean` for callers that need to branch rather than throw.
  Change `set status(value)` to `private set status(value)` **if TypeScript permits it against the
  generated interface**; if not (a getter/setter pair typed by `IConsultationEntity`), keep the
  setter public but mark it `@deprecated` and add the lint gate in Task 11 instead — say which one
  you did and why in the Implementation Summary.
- **Verify:** `pnpm --filter @arcaai/domains test` green; `pnpm --filter @arcaai/domains build`;
  `pnpm --filter @arcaai/domains lint` (treat `only-warn` warnings as errors).

---

### Phase 3 — Application services (TDD)

#### Task 6 — RED+GREEN: route every consultation-service status write through the machine
- **Agent:** T3 · sonnet-5 · high
- **Files:**
  - modify `packages/applications/src/services/consultation/consultation/consultation.service.ts`
  - modify `packages/applications/src/services/consultation/consultation/IConsultationService.ts`
  - modify `packages/applications/src/services/consultation/consultation/dto/update-consultation.request.ts`
  - create/modify `packages/applications/src/services/consultation/consultation/__tests__/consultation.service.lifecycle.test.ts`
- **Approach:** tests first, then implementation.
  1. `primeConsultation(id)` — new. `OPEN → PRIMED`, idempotent, `updateWithVersion`,
     `ResourceUpdated` sys-event + `SESSION_PRIMED` WORM append. Consent assertion is a
     **named injection point** here (an optional `IConsultationConsentService`, absent for now)
     so TASK-712 wires it without touching this method's shape.
  2. `setRecordingStatus` (`:810-838`) → `startRecording` becomes `PRIMED → RECORDING`
     (precondition behind the kill-switch, Task 9) and `stopRecording` becomes
     `RECORDING → DRAINING` — **no longer `OPEN`**.
  3. `closeConsultation` / `reopenConsultation` (`:710-719`) drop `transitionStatus` entirely and
     call `entity.transitionTo(CLOSED | REOPENED, …)` on the **typed column**, with
     `updateWithVersion`. Delete `readStatus` (`:654-656`) and private `transitionStatus` (`:664-707`).
  4. `updateConsultation` (`:730-777`): delete the `nextMeta.status = request.status` write
     (`:760-762`) and remove `status` from `UpdateConsultationRequest` (`update-consultation.request.ts:41-47`).
     Keep `CONSULTATION_STATUS` exported only if TASK-701 still needs it; otherwise delete it and
     `ConsultationLifecycleStatus` with it.
  5. Swap `this.consultationRepository.update(...)` for `updateWithVersion(id, entity, expectedVersion)`
     on every lifecycle path, following `.claude/rules/03-domain-layer.md` §Repository Contract.
  Follow `packages/applications/src/services/department/` for folder/DI shape; per
  `.claude/rules/04-application-services.md`, cross-tenant stays `NotFoundException`.
- **Verify:** `pnpm --filter @arcaai/applications test`; `pnpm --filter @arcaai/applications build`.

#### Task 7 — Wire the harness lifecycle writers and `TIMED_OUT`
- **Agent:** T3 · sonnet-5 · high
- **Files:**
  - modify `packages/applications/src/services/consultation/harness/harness-internal.service.ts`
  - modify `packages/applications/src/services/consultation/harness/__tests__/harness-internal.service.test.ts`
  - modify `packages/domains/src/repositories/generated/core/ConsultationRepository.ts` (add `findTimedOutForTenant`)
- **Approach:**
  1. `persistDraft` (`:892-896`) — replace the bare assignment with
     `entity.transitionTo(isEarly ? DRAFT_PENDING_SENSORS : PENDING_REVIEW, 'system', 'persistDraft')`.
     Its legal predecessor is now `DRAINING`; a draft arriving while the consultation is still
     `RECORDING` is a real ordering bug and must surface as a thrown transition, not be papered over.
  2. `finalizeAssurance` (`:1034-1038`) — the existing `if (status === DRAFT_PENDING_SENSORS)`
     guard becomes `if (entity.canTransitionTo(PENDING_REVIEW))`, preserving the idempotent no-op.
  3. `recordEscalation` (`:1259`) — on the **terminal** abandon (`GATE_ABANDONED`), additionally
     `transitionTo(TIMED_OUT)`, append WORM `SESSION_TIMED_OUT`, and raise a clinician notification
     through `INotificationService`. Non-terminal `GATE_ESCALATED` writes no status, as today.
  4. Add `findTimedOutForTenant(tenantId)` mirroring `findPendingReviewForTenant`
     (`ConsultationRepository.ts:368-378`) so the gate-queue surface can show timed-out records.
  **Do not** make the notification fail-closed: a notification outage must not roll back the
  state transition. The WORM append is the record; the notification is the courtesy.
- **Verify:** `pnpm --filter @arcaai/applications test`; `pnpm --filter @arcaai/domains test`.

#### Task 8 — Add the sign legality assertion without touching the sign gate
- **Agent:** T4 · opus-5 · medium
- **Files:**
  - modify `packages/applications/src/services/consultation/summary/summary.service.ts`
  - modify `packages/applications/src/services/consultation/summary/__tests__/summary.service.test.ts`
- **Approach:** at `summary.service.ts:975-981`, replace `consultation.status = ConsultationStatus.SIGNED`
  with `consultation.transitionTo(ConsultationStatus.SIGNED, approvedBy, 'approveSummary')`.
  Everything above it — the authenticated-`requestUserId` gate (`:875-878`), the tenant assertion,
  the idempotency read (`:841-850`), the safety-FLAG hard block (`:869-873`), and the
  fail-closed-ordered `ATTEST` WORM append — is **unchanged**. Before writing the change, re-read
  `approveSummary` end to end and enumerate every status a consultation can hold when it reaches
  `:978` today; the matrix must already contain each one as a legal predecessor of `SIGNED`. If it
  does not, fix the matrix (Task 1) — never relax the assertion.
  Add a test that a consultation in each currently-reachable predecessor state still signs, and one
  that a consultation in `OPEN` throws.
- **Verify:** `pnpm --filter @arcaai/applications test`; specifically re-run the existing
  `summary.service.test.ts` suite unchanged and paste that it is still green.

---

### Phase 4 — API surface

#### Task 9 — Controller routes, guards, and the one flagged precondition
- **Agent:** T3 · sonnet-5 · high
- **Files:**
  - modify `apps/api/src/modules/consultation/consultation.controller.ts`
  - modify `apps/api/src/modules/consultation/__tests__/consultation.controller.test.ts`
  - modify `packages/applications/src/services/settings-registry/descriptors/consultation-gates.descriptors.ts`
- **Approach:**
  1. Add `POST :id/prime` next to the lifecycle block (`consultation.controller.ts:415-454`),
     `verifyConsultationOwnership`-guarded, returning `ConsultationResponse`. Declared through
     `@ApiEndpoint()` like its siblings.
  2. `POST :id/close` (`:434-442`) and `POST :id/reopen` (`:447-454`) keep their existing guard but
     now surface `409` when the transition is illegal — map `BusinessException` through the
     existing filters in `apps/api/src/filters/`; verify which HTTP code that mapping produces and
     make it 409 explicitly if it is not.
  3. Add `@RequiresIfMatch()` + `@ExpectedVersion()` to `close`, `reopen`, and `prime`, copying
     `apps/api/src/modules/webhook/webhook.controller.ts:86,107` verbatim. **Verify the guard
     actually fires** on `@ApiEndpoint()`-declared routes — `.claude/rules/05-nestjs-api.md` calls
     this out as an unverified interaction. If it does not fire, that is a finding: record it and
     fall back to plain `@Post()` for these three routes rather than shipping a decorator that
     silently does nothing.
  4. Register a `killSwitch` descriptor `consultation.state.requirePrimedBeforeRecording`,
     **default OFF** (the registry refuses boot if a kill-switch defaults ON —
     `packages/applications/src/services/settings-registry/settings-registry.ts`). `startRecording`
     consults it; OFF logs the would-be violation and proceeds, ON enforces. Every *other*
     transition in the matrix is enforced unconditionally from day one — only this one breaks
     existing clients.
  5. Update `apps/admin-console/src/features/consultations/api/types.ts:7` `CONSULTATION_STATUSES`
     to the 10 members (its own comment says the gateway 400s on anything else).
- **Verify:** `pnpm api:build`; `pnpm test:unit`; `pnpm lint` (hard errors in `apps/api`).

---

### Phase 5 — Delete the second tracker

#### Task 10 — Remove every `metadata.status` reader and writer
- **Agent:** T2 · sonnet-5 · medium
- **Files:** whatever the sweep finds. Known starting set:
  `packages/applications/src/services/consultation/consultation/consultation.service.ts`,
  `…/consultation.dto.mapper.ts`, `…/dto/update-consultation.request.ts`,
  `apps/admin-console/src/features/consultations/**`
- **Approach:** run `git ls-files -- '*.ts' '*.tsx' | xargs grep -n "metadata\.status\|metadata?\.status\|readStatus\|ConsultationLifecycleStatus\|CONSULTATION_STATUS\b"` with the standard
  exclusions and remove every hit. TASK-701 has already removed the mapper's *preference*; this
  task removes the field's *existence* from the code. Update the two stale doc comments that
  assert the model has no status column (`consultation.service.ts:641-648` and
  `update-consultation.request.ts:4-10`).
- **Verify:** the sweep above returns zero hits outside the new gate test;
  `pnpm --filter @arcaai/applications test`; `pnpm --filter @arcaai/admin-console build lint test`.

#### Task 11 — Static gates: no second tracker, no unwired enum member
- **Agent:** T2 · sonnet-5 · low
- **Files:**
  - create `packages/applications/src/services/consultation/consultation/__tests__/consultation.status-single-source.test.ts`
  - create `packages/domains/src/enums/__tests__/consultationStatus.wired.test.ts`
- **Approach:**
  1. Source-scanning test (model it on `packages/domains/src/enums/__tests__/resourceType.enum-parity.test.ts`):
     read the repo's TS files and assert zero writes to `metadata.status`, and zero direct
     `\.status\s*=` assignments to a `ConsultationEntity` outside `transitionTo`.
  2. Wiring test: assert every `ConsultationStatus` member appears as a `to` in
     `CONSULTATION_TRANSITIONS` **and** that the union of the enum equals the union of the matrix's
     states. This is the gate that makes another `CLOSED`/`REOPENED` structurally impossible; call
     that out in the test's docblock so nobody deletes it as redundant.
- **Verify:** `pnpm --filter @arcaai/domains test`; `pnpm --filter @arcaai/applications test`.

---

### Phase 6 — Backfill

#### Task 12 — Backfill migration for in-flight consultations
- **Agent:** T3 · opus-4-8 · high
- **Files:** create `packages/database/src/prisma/db_main/migrations/<timestamp>_task_711_consultation_status_backfill/migration.sql`
- **Approach:** implement Task 1's `backfill-mapping.md` as idempotent SQL, in its own migration
  (Postgres will not let the new enum values be *used* in the transaction that added them —
  Task 2 adds, Task 12 uses).
  1. A guard `DO $$ … RAISE EXCEPTION … $$` block that counts rows matching **no** mapping row and
     aborts with the offending tuple. Fail loudly; an unenumerated combination means Task 1's
     query was stale.
  2. `UPDATE` statements per mapping row, each with a `WHERE` narrow enough to be a no-op on a
     second run.
  3. Strip the three legacy keys last: `SET "metadata" = "metadata" - 'status' - 'closedAt' - 'reopenedAt'`
     (guard `WHERE "metadata" IS NOT NULL`), preserving every other key.
  4. **No statement in this migration may write `'SIGNED'`.** Add a comment saying so and a final
     assertion block that counts `SIGNED` rows before and after and raises if the number moved.
  5. Report rows touched per bucket via `RAISE NOTICE`.
- **Verify:** apply twice to the shadow DB seeded with a fixture covering every observed
  combination — the second run reports zero rows changed;
  `npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script` prints
  `-- This is an empty migration.`; `pnpm db:seed` then `pnpm --filter @arcaai/database test`.

---

### Phase 7 — End-to-end verification

#### Task 13 — E2E specs
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `apps/api/tests/e2e/consultation-state-machine.spec.ts`
- **Approach:** Playwright against a running API (`pnpm test:up:api` in terminal 1). Follow
  `apps/api/tests/e2e/consultation-job-cross-tenant.spec.ts` for the tenant-fixture shape. Cover:
  1. `POST :id/close` on a never-recorded consultation → **rejected** (the A-13 repro, now a
     regression test).
  2. `open → prime → recording/start → recording/stop → (harness draft) → approve` walks
     `OPEN → PRIMED → RECORDING → DRAINING → PENDING_REVIEW → SIGNED`, asserted through
     `GET :id` after each step.
  3. `recording/start` without `prime`, with the kill-switch ON → 409; with it OFF → 200 plus a
     logged violation.
  4. `close` after `SIGNED` → 200 and `status: CLOSED`; `reopen` → `REOPENED`.
  5. Gate-SLA abandonment drives `TIMED_OUT`, the record reads **visibly unsigned**
     (`status: TIMED_OUT`, no `SIGNED_NOTE`), and a notification row exists.
  6. `TIMED_OUT → SIGNED` still commits (the clock never signs, but a clinician later still can).
  7. `PATCH :id` with `{"metadata":{"status":"SIGNED"}}` → the response `status` is **unchanged**
     (this is TASK-701's fix; re-asserted here because Task 10 removes the field it exploited).
  8. Cross-tenant `POST :id/close` / `POST :id/prime` → **404**, never 403
     (`.claude/rules/05-nestjs-api.md` §Errors).
  9. `PATCH`/`POST` on a transition route without `If-Match` → 428; with a stale ETag → 412.
- **Verify:** `pnpm test:up:api` then `pnpm test:e2e`; paste output.

---

## 5. Acceptance Criteria

Evidence rule: **paste actual command output** for every box below. A claim of "done" without
pasted output is not accepted (`.claude/rules/01-development-workflow.md` §Anti-Patterns).

- [ ] `docs/implementation/TASK-711-Session-State-Machine/state-machine.md` and `backfill-mapping.md`
      exist, are owner-approved, and every `dataset.xml` reference state carries a verdict
- [ ] The observed-combination query output is pasted into `backfill-mapping.md`, with an
      environment and a date
- [ ] `pnpm db:generate` clean; the migration's `npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script` prints `-- This is an empty migration.`
- [ ] `pnpm gen:model:check`, `pnpm gen:entity:check`, `pnpm gen:factory:check` — no drift **and**
      schema coverage OK
- [ ] `git diff --stat packages/domains/src/mappers/generated/core/` touches only
      `ConsultationEntityMapper.ts`, and that file still contains `FIELDS_NOT_WRITABLE = ['version']`
      (proof `gen:mapper` was not run)
- [ ] `pnpm --filter @arcaai/database test`
- [ ] `pnpm --filter @arcaai/domains build` · `pnpm --filter @arcaai/domains test`
- [ ] `pnpm --filter @arcaai/applications build` · `pnpm --filter @arcaai/applications test`
- [ ] `pnpm api:build` · `pnpm test:unit`
- [ ] `pnpm --filter @arcaai/admin-console build lint test`
- [ ] `pnpm test:up:api` then `pnpm test:e2e` — including all nine `consultation-state-machine.spec.ts` cases
- [ ] `pnpm lint` — zero new errors in `apps/api`; zero new `only-warn` warnings in `packages/*`
- [ ] `pnpm typecheck`
- [ ] The single-source gate test passes and the sweep
      `git ls-files -- '*.ts' '*.tsx' | xargs grep -n "metadata\.status"` returns zero hits outside
      that test
- [ ] The enum-wiring gate test passes: every `ConsultationStatus` member is a `to` in the matrix
- [ ] The backfill migration is proven idempotent (second run: zero rows changed) and the
      `SIGNED`-count assertion holds
- [ ] `apps/admin-console/src/features/consultations/api/types.ts` `CONSULTATION_STATUSES` lists
      exactly the 10 adopted members
- [ ] Ticket README §7 filled with the Implementation Summary and the files changed

---

## 6. Risks & Open Questions

| # | Risk / question | Impact | Mitigation / owner |
|---|---|---|---|
| R1 | **`RECORDING` requires `PRIMED` breaks every existing client** — no caller calls `prime` today | Recording stops working for SDK and admin-console consumers | The kill-switch in Task 9 (default OFF). Ship SDK + console `prime` calls, bake, then flip. The flag is deleted by TASK-712, which makes `prime` the consent checkpoint |
| R2 | **`stopRecording` no longer returns `OPEN`** | Any consumer branching on `status === 'OPEN'` to mean "idle" changes behaviour | Task 9 updates the admin console; sweep the SDK (`packages/agentic-sdk-v2/src/**`) for status comparisons as part of Task 10 |
| R3 | **`@RequiresIfMatch()` interaction with `@ApiEndpoint()` is unverified** (`.claude/rules/05-nestjs-api.md` names this) | OCC on transition routes could be a silent no-op | Task 9 step 3 verifies it explicitly and falls back to plain decorators rather than shipping a placebo |
| R4 | **The backfill's `OPEN` + `meta=CLOSED` + no signed note bucket may be large** | Those consultations become `resourceStatus = ARCHIVED` and vanish from default (non-deleted) reads | The Task 1 query sizes it *before* the migration is written. If the count is material, escalate — this is a product decision about historical records, not an engineering one |
| R5 | **`HarnessAuditService.append` is an unlocked read-then-write** (`harness-audit.service.ts:31-37`) | More per-transition appends → higher chance of a forked chain caught only by the `hash` unique constraint | Out of scope to fix; measure the append rate after Task 7 and raise a follow-up if it becomes non-trivial. Routine-transition append failures are non-fatal by design |
| R6 | **TASK-704 changes where `persistDraft` is reached from** | Task 7's `DRAINING → DRAFT_PENDING_SENSORS` legality assumes the seam's ordering | Read `NoteGenerationService` as it actually lands before writing Task 7; if a generation entry point can fire while `RECORDING`, either the seam or the matrix is wrong — resolve it, do not add an edge to make the error go away |
| Q1 | **HUMAN-GATED — what happens to consultations archived by the backfill?** Are historically "closed but never signed" records acceptable as `ARCHIVED`/`OPEN`, or does the business need a distinct `ABANDONED` state? | Adds an 11th member if yes | Decide after R4's count is known. Do not invent a state speculatively |
| Q2 | **HUMAN-GATED — may a tenant admin (`manage:Consultation`, not a clinician) close or reopen a signed record?** That is today's behaviour via `verifyConsultationOwnership` (`consultation.controller.ts:296-317`) | Preserving it keeps a non-clinician in the clinical lifecycle | Preserved as-is by default (this ticket changes *legality*, not *authority*). Flag for the compliance owner |
| Q3 | Does the `degradedReasons` vocabulary need to be tenant-extensible? | A closed vocabulary is simpler and filterable | Default: closed enum-like string union, platform-owned. Revisit only if the Studio's runs tab needs tenant reasons |

---

## 7. Implementation Summary

**Scope of this execution pass: Phase 0 (Task 1) + Phase 1 (Tasks 2-3) + Phase 2 (Tasks 4-5)
only** — `packages/database` and `packages/domains`. Phases 3-7 (Tasks 6-13: application
services, API surface, `metadata.status` removal, static gates, backfill migration, E2E) are
**NOT done** — out of ownership for this pass and left for the next phase.

### Task 1 — State chart, legality matrix, backfill mapping (Phase 0)

Authored [state-machine.md](./state-machine.md) and [backfill-mapping.md](./backfill-mapping.md).
Both reproduce README.md §4 Task 1's own tables (the design was fixed by
`04-target-architecture.md` §1 / design.md §Error handling and this ticket says "reproduce it, do
not re-litigate it") as standalone, cross-referenced documents. The `degradedReasons` vocabulary
(§3 of state-machine.md) was verified against the actual source, not assumed: `mcp_degraded`
(`apps/harness/src/harness/temporal/workflows.py:642,663,667`), `policy_degraded` (`:440,459`),
`retrieval_degraded` (`RetrievedContext.degraded`, `models.py:644`), `reduced_assurance`
(`models.py:802,857,894`), `sensor_degraded` (`InferentialRunOutput.degraded`, `models.py:768`).

**Gated — not run:** the observed-distribution SQL query in backfill-mapping.md §2. Local infra
(Postgres) is down this session; the query, the mapping table's completeness against real data,
and owner sign-off on both documents are left for whoever picks up Task 12. This also means the
Task 1 "Verify" gate ("reviewed and approved by the ticket owner before Task 2 starts") was not
satisfied before this pass proceeded to Task 2 — Tasks 2-5 were executed against the design
already fixed upstream in the assessment/design docs per this ticket's own explicit instruction,
not against a fresh approval. Flagging this rather than silently treating the gate as satisfied.

### Task 2 — Schema change + migration (Phase 1)

- `packages/database/src/prisma/db_main/enums.prisma`: `ConsultationStatus` gained `PRIMED`,
  `DRAINING`, `TIMED_OUT` (appended after the existing seven; `PAUSED` deliberately not added).
- `packages/database/src/prisma/db_main/harness.prisma`: `HarnessAuditAction` gained
  `SESSION_PRIMED`, `SESSION_TIMED_OUT`, `SESSION_REOPENED`.
- `packages/database/src/prisma/db_main/consultation.prisma`: `Consultation.degradedReasons
  String[] @default([])` added in the core-business-fields block, before `resourceStatus`.
- Migration authored by hand: `packages/database/src/prisma/db_main/migrations/20260816010000_task_711_session_state_machine/migration.sql`
  — three `ALTER TYPE … ADD VALUE IF NOT EXISTS` statements + one `ALTER TABLE … ADD COLUMN`.
  Formatting/style matched against the most recent precedent migrations in the same folder
  (`20260728000000_task_567_…` for `ADD VALUE`, `20260811010000_task_659_…` for `ADD COLUMN`).

**Gated — not run (hard rule: no `db:migrate*`/`db push`/`prisma migrate diff`):** the shadow-DB
proof from `.claude/rules/02-database-prisma.md` §Migration Workflow — creating `hope_shadow`,
replaying the ledger, running `db:migrate:create`, and confirming
`npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script`
prints `-- This is an empty migration.` Local Postgres is unreachable this session. The migration
SQL was instead hand-verified against the schema diff and the repo's own precedent migrations for
the same two statement shapes.

**Run and green:**
- `pnpm --filter @arcaai/database db:generate` — succeeded without a live DB connection (`prisma
  generate` only reads the schema; verified the new enum members and column landed in
  `packages/database/src/generated/core-prisma-client/enums.ts`).
- `pnpm --filter @arcaai/database test` — **51 test files passed (51), 1237 tests passed (1237)**.
- `pnpm --filter @arcaai/database build` — clean (`tsc`).
- `pnpm --filter @arcaai/database typecheck` — clean (`tsc --noEmit`).

### Task 3 — Regenerate model layer, hand-author domain trio (Phase 1)

- `pnpm gen:model` run — regenerated `ConsultationModel.ts` (new `degradedReasons: string[]`
  field) plus the two enum files; `git status` showed only those three files actually changed
  despite the generator rewriting every model file (the rest were byte-identical).
- Hand-authored (never generated) per `.claude/rules/03-domain-layer.md`:
  - `ConsultationEntity.ts` — `degradedReasons` private field + `IConsultationEntity` prop +
    constructor default `[]` + getter/setter (this part of Task 3; the `transitionTo` state
    machine itself is Task 5, below).
  - `ConsultationFactory.ts` — `degradedReasons` prop on `CreateConsultationProps`, defaulted to
    `[]` in `CreateConsultation`.
  - `ConsultationEntityMapper.ts` — added the `FIELDS_NOT_WRITABLE = ['version']` +
    `stripNonWritableFields` guard (this model did **not** carry it before; TASK-711 is the ticket
    that puts Consultation's lifecycle writes onto `updateWithVersion` for the first time, so the
    guard is added now, mirroring `AiTaskDefaultEntityMapper`/`AiProviderConnectionEntityMapper`).
    `degradedReasons` itself needed no explicit `$toPersistence`/`$toDomain` handler — it maps by
    name through the existing `AutoClassMapper`/`AutoEntityChangeMapper`, same as `metadata`.
- `pnpm gen:entity` / `pnpm gen:factory` run to reconcile barrels — `git status` showed no changes
  beyond the hand-authored files (i.e. the reconciler reproduced every other committed file
  byte-for-byte). **`pnpm gen:mapper` was never run** (per the hard rule — it is destructive).
- `pnpm gen:model:check` — "no drift — 157 generated file(s) match the committed files."
- `pnpm gen:entity:check` — "no drift — 91 generated file(s) match the committed files" +
  "Schema coverage OK: 89 entity artifact(s) cover every persisted column of 93 Prisma model(s)."
- `pnpm gen:factory:check` — "no drift — 91 generated file(s) match the committed files" +
  "Schema coverage OK: 89 factory artifact(s) cover every persisted column of 93 Prisma model(s)."
- `git diff --stat packages/domains/src/mappers/generated/core/` — touches only
  `ConsultationEntityMapper.ts`; that file contains `FIELDS_NOT_WRITABLE = ['version']` (grep
  verified). Proves `gen:mapper` was not run.

### Phase 2 (Tasks 4-5) — `ConsultationEntity.transitionTo`, TDD

**RED (Task 4):** created
`packages/domains/src/entities/__tests__/ConsultationEntity.transitions.test.ts`, table-driven
over the full Cartesian product of the 10 adopted `ConsultationStatus` members (100 pairs), with
the legal-transition table and the one reserved-disabled pair
(`PENDING_REVIEW → DRAFT_PENDING_SENSORS`, epic `note-sections`) reproduced as literal test data
independent of the implementation. Ran `pnpm --filter @arcaai/domains test -- ConsultationEntity.transitions`
before writing any implementation: **109 tests failed** with `TypeError:
entity.transitionTo/canTransitionTo/addDegradedReason/clearDegradedReasons is not a function` —
confirmed RED. Also surfaced one **pre-existing** stale test
(`src/__tests__/clinical-harness-phase1-domain.test.ts`, "ConsultationStatus has exactly the 7
lifecycle states") that asserted the old 7-member enum; updated it to the new 10-member set
(in-scope, `packages/domains`, and directly caused by this ticket's own schema change).

**GREEN (Task 5):** added to `ConsultationEntity.ts`:
- Module-level `CONSULTATION_TRANSITIONS: ReadonlyMap<ConsultationStatus, ReadonlySet<ConsultationStatus>>`
  (17 legal non-reflexive edges) and `RESERVED_DISABLED_TRANSITIONS` (the one
  `PENDING_REVIEW → DRAFT_PENDING_SENSORS` edge, naming `note-sections`).
- `transitionTo(next, actor, reason): boolean` — self-transition returns `false`, no write;
  reserved-disabled throws `BusinessException` naming the epic; illegal throws `BusinessException`
  naming both states; legal writes through `setProperty('status', next)`, records
  `lastTransition = { from, to, actor, reason }`, and clears `degradedReasons` when `next ===
  SIGNED`.
- `canTransitionTo(next): boolean` — non-throwing check, `true` for self and legal pairs.
- `addDegradedReason(reason)` / `clearDegradedReasons()` — dedup-append / clear, both through
  `setProperty` for change tracking.
- `get lastTransition()` — exposes the last transition's `actor`/`reason` for the calling service
  to forward to the sys-event/WORM layer in Task 6-8 (not persisted).

**The `private set status` question (Task 5's explicit either/or):** kept `status`'s setter
**public**, marked `@deprecated` with a comment explaining why, per the ticket's own documented
fallback. Verified TypeScript **does** permit an asymmetric `private set` / public `get` in this
codebase (`BaseTenantEntity.tenantId` already does this with `protected`) — the blocker was not a
language restriction but that `packages/applications` has five live call sites still assigning
`consultation.status = …` directly (`consultation.service.ts:836`,
`harness-internal.service.ts:893,1035`, `summary.processor.ts:185`, `summary.service.ts:1053`),
none of which are in this pass's scope (`applications` is Phase 3, Tasks 6-8). Making the setter
private now would break `pnpm --filter @arcaai/applications build` today; the lint gate that makes
this hard is Task 11's job. Confirmed by checking `pnpm --filter @arcaai/applications typecheck`
after this change — still clean (see Verification below).

**Run and green:**
- `pnpm --filter @arcaai/domains test -- ConsultationEntity` — **all Cartesian-product cases,
  actor/reason recording, `canTransitionTo`, and `degradedReasons` tests pass** (140 files passed
  before this suite existed → 142 files passed / 1720 tests passed after, +2 test files: the new
  suite and the reserved-disabled/degraded assertions folded into it).
- `pnpm --filter @arcaai/domains build` — clean. (One TS overload-inference issue on the `Map`
  literals surfaced and was fixed by adding explicit generic type parameters to `new Map<K,
  V>([...])`.)
- `pnpm --filter @arcaai/domains lint` — 0 errors, 13 pre-existing `only-warn` warnings, all in
  files untouched by this ticket (`eslint-comments/require-description` on unrelated files); zero
  new warnings.
- `pnpm --filter @arcaai/domains typecheck` — clean.

### Not done (out of scope this pass)

Tasks 6-13 (Phases 3-7): routing every consultation-service status write through `transitionTo`,
wiring the harness lifecycle writers and `TIMED_OUT`, the sign legality assertion, controller
routes + kill-switch, deleting `metadata.status`, the static single-source/wiring gates, the
backfill migration, and the E2E specs. None of `packages/applications`, `apps/api`, or
`apps/admin-console` were touched.

### Human-gated items — flagged, not resolved (per instruction)

- **Q1 (ABANDONED state / backfill archival semantics):** unresolved — depends on R4's row count,
  which depends on the backfill query (gated, not run this session). Not invented speculatively.
- **Q2 (tenant-admin close/reopen authority on a signed record):** unresolved — this pass
  preserves current authority as-is (this ticket changes legality, not authority) exactly as
  README.md §6 specifies as the default; the compliance-owner flag itself is not something this
  database/domain-layer pass can resolve.

### Observed but not caused by this ticket

`pnpm --filter api typecheck` currently fails with 9 errors, all about `expectedVersion` /
`UpdateContextRequest` / `UpdateSummaryRequest` / `SummaryApprovalRequest` in
`apps/api/src/modules/consultation/`. These files are mid-edit by another sibling agent in this
shared tree (untouched by this pass — see `git status` for `packages/applications/src/services/consultation/{context,summary}/**`)
and are unrelated to `ConsultationStatus`/`degradedReasons`. Noted for the record, not fixed here.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | ticket-writer agent (Wave-1 clinical architecture) |
| 2026-08-16 | Phase 0 (Task 1 docs) + Phase 1 (Tasks 2-3, schema/migration/domain-model regen) + Phase 2 (Tasks 4-5, `ConsultationEntity.transitionTo` TDD) executed. `packages/database`/`packages/domains` only — see §7. Migration authored by hand; shadow-DB proof and the backfill query are gated (local infra down). Status set to In Progress (Phases 3-7 remain). | execution agent |
