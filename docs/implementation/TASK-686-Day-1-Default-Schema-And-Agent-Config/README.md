# TASK-686 — Day-1 default context schema and agent loop configuration

- **Status:** Blocked — code complete and green, **held on an owner decision** (§6.1)
- **Type:** feature (seed)
- **Wave:** follows [TASK-684](../TASK-684-Enable-Consultation-Loop-Day-1/README.md); depends on
  [TASK-658](../TASK-658-Consultation-Context-Schema/README.md) and
  [TASK-659](../TASK-659-Agent-Config-Extension/README.md)
- **Baseline:** `dev-2.1` @ `40c935cb6`
- **Branch:** `worktree-agent-a981cafa834886ea9` (worktree; spawned from `dev`, `git reset --hard dev-2.1` performed)
- **Commits:** `1174c7b51` (seed + tests), this document

---

## 1. Requirement Analysis

**Objective.** Make `LoopConfigService.resolveForConsultation` return `enabled: true` on a
freshly-seeded install, by creating the two rows its `enabled` is DERIVED from — a servable
default context schema, and loop configuration on the department's default agent — together and
coherently.

TASK-684 turned the SIGNALLING gate on: a real `context.added` now starts
`ConsultationLoopWorkflow`, and `recording/stop` delivers `consultation-ending`. But the workflow
completes `phase: "DISABLED"`, because its pinned config's `enabled` is computed, never stored
(`packages/applications/src/services/consultation/loop/loop-config.service.ts:156`):

```ts
const enabled = agentConfigVersionId !== null || contextSchemaVersionId !== null;
```

Neither source existed on a fresh install. That is what this ticket creates.

| # | Acceptance criterion |
|---|---|
| AC-1 | A seeded `ConsultationContextSchema` + `Version` satisfies the *servable* predicate exactly as `resolveServableContextSchemaVersion` checks it |
| AC-2 | The seeded `definition` is publishable by the REAL TASK-658 publish validator |
| AC-3 | Every seeded default agent carries TASK-659 loop configuration whose `subscribedKinds` / `writeScope` keys resolve against that definition |
| AC-4 | At most one `PRIMARY` agent per `(tenant, department)` (TASK-659 AC-7) |
| AC-5 | `LoopConfigService` resolves `enabled: true` for a seeded tenant |
| AC-6 | **K7 regression** — removing the schema again returns the loop to `enabled: false` cleanly |
| AC-7 | Re-seeding never clobbers an operator's edits, and an already-seeded database still adopts the defaults |

### 1.1 The taxonomy was specified, not invented

The owner's worked example **E1** — *"a tenant admin defines a consultation schema that: audio
stream, work note, case note, attachment, etc."* — mapped onto the five platform primitives of
TASK-654 §4.1.

---

## 2. Current State Evaluation

Verified against `dev-2.1` @ `40c935cb6`.

| Area | Finding |
|---|---|
| `enabled` | Derived at `loop-config.service.ts:156` from `agentConfigVersionId \|\| contextSchemaVersionId`. Either alone flips it true. |
| Servable predicate | `resolveServableContextSchemaVersion` (`:239`): `findDefaultForScope(tenant, DEPARTMENT, deptId)` then `(tenant, TENANT, null)`; the repository filters `isDefault: true` **and** `resourceStatus: ENABLED`; the service then requires `pinnedVersionNumber != null` **and** `status ∈ {PUBLISHED, APPROVED}`; then `findBySchemaAndVersionNumber` must hit. All five, or nothing. |
| `AgentSeedRow` | `07a-agent-golden-library.ts:223` carried none of TASK-659's seven fields, so `writeLoopConfigVersionIfNeeded` had never written a version row for a seeded agent. |
| Seeded tenants | Three: SYSTEM (`00000000-…`, the golden library), Global (`50000000-…-0000`), ArcaAI (`50000000-…-0001`). `ConsultationContextSchema` is in `TENANT_SCOPED_MODELS` and **not** in `SYSTEM_SHARED_READ_MODELS`, so a SYSTEM-owned schema is invisible to a customer tenant — each tenant needs its own row. |
| Agents per department | Exactly one seeded default agent per `(tenant, department)` across all three sets, so `role: PRIMARY` on all of them cannot contest. |
| Repo-wide idempotency guard | `seed/__tests__/seed-idempotency.test.ts` only covers models with a column literally called `value` (`GlobalSetting`, `UserSettings`). It does **not** cover anything this ticket writes — see §5. |
| LiveDoc lifecycle | Already owned by `consultation.controller.ts`: `recording/start:479` → `liveDocumentationService.start`, `recording/stop:505` → `.stop`. This is what makes subscribing a `STREAM_AUDIO` kind unsafe day-1 (§3.2). |
| Legacy harness start | `ConsultationEventHandler.handleTranscriptionCreated` → `HarnessGatewayService.start`, gated on `pipelineConfig.harnessEnabled`. Seeded **true** for Global and ArcaAI (`14-pipeline-policy.ts`), **false** for the SYSTEM default every other tenant inherits. |

---

## 3. Implementation

### 3.1 The seeded taxonomy — and why each kind is there

| kind | primitive | Why it is in the day-1 default |
|---|---|---|
| `audio_stream` | `STREAM_AUDIO` | E1. The consultation recording — the STT session + `AudioRecording`, the substrate TASK-654 §4.1 names for this primitive. |
| `work_note` | `TEXT` | E1. Exactly today's `ContextItemType.WORKNOTE`; a real producer exists and it already reaches `ContextAdded`. |
| `case_note` | `TEXT` | E1. Exactly today's `CASE_NOTE`; same. |
| `attachment` | `DOCUMENT` | E1. Today's `ATTACHMENT` (Media + object storage, text via OCR); the OCR gate was seeded ON by TASK-684. |

**Outputs — one:** `soap_note`, primitive `TEXT`.

- It is the note `harness.finalize` actually produces, and it is what the agent's `writeScope`
  must name for the write scope to mean anything.
- `TEXT`, **not** `STRUCTURED` (TASK-658 §3.1 sketches it as `STRUCTURED`): the note the harness
  writes is markdown. `STRUCTURED` would promise a field schema the platform does not have, and a
  `STRUCTURED` declaration with no `fields` is vacuous.

**Deliberately NOT declared** — argued here rather than added quietly, because every kind in this
document becomes the platform's default clinical vocabulary for every tenant:

| Candidate | Why it is absent |
|---|---|
| `key_finding`, `gate_status` (sketched in TASK-654 §4.1) | No code path produces either. Unbacked vocabulary in a day-1 default is a promise the platform cannot keep, and every tenant would inherit it. |
| `transcript` | `sttInternal.service.ts` emits only `TranscriptionCreated`, never `ContextAdded` (TASK-684 §6.2, TASK-676). Declaring a transcript kind would read as "the loop reacts to transcripts". It does not. See §6.2. |
| `constraints` (`mimeTypes` / `maxBytes`) on `attachment` | Nothing in the loop enforces them today, and inventing limits that do not match the real upload path would be a lie in a document clients discover at runtime. |

### 3.2 The agent configuration — and the one subscription deliberately omitted

```jsonc
role:            "PRIMARY"
subscribedKinds: { version: 1, kinds: [ work_note, case_note, attachment ] }
writeScope:      { version: 1, outputs: [ "soap_note" ] }
goal:            { version: 1, objective: "Maintain an accurate, grounded clinical note …", successCriteria: [ … ] }
guardrailProfile:"STANDARD"
alwaysActions:   null      // the compliance envelope stays empty — nothing is forced,
neverActions:    null      // and nothing is forbidden, on day 1
```

How the subscriptions resolve (`buildSubscriptions` → `PRIMITIVE_DEFAULT_ACTIONS`):

| kindKey | primitive | resolved actions |
|---|---|---|
| `work_note` | `TEXT` | `client.emit` |
| `case_note` | `TEXT` | `client.emit` |
| `attachment` | `DOCUMENT` | `document.extract_text`, `client.emit` |

and `startActions: []`, `endingActions: ['harness.finalize']`, `reasoningEnabled: false`
(one PRIMARY, no SPECIALIST — TASK-664's deliberative lane stays off, which is exactly
TASK-662's behaviour).

**`audio_stream` is declared but NOT subscribed.** This is the one place the seed departs from
"subscribe to everything you declare", and it is deliberate:
`deriveStartAndEndingActions` adds `livedoc.start` / `livedoc.stop` as soon as *any* subscribed
kind resolves to `STREAM_AUDIO`. The LiveDoc lifecycle is already owned end-to-end by
`consultation.controller.ts` (`recording/start` → `.start`, `recording/stop` → `.stop`, the latter
*before* the ending signal is sent). Subscribing it would issue a second start and a second stop
per consultation, in every fresh install, on a path nobody asked to change. The kind belongs in
the schema — it is the tenant's vocabulary — but arming the action is a tenant decision the
console (TASK-667) exists to make.

### 3.3 Files

| File | Change |
|---|---|
| `packages/database/src/prisma/db_main/seed/07e-consultation-loop-defaults.ts` | **New.** The definition, the agent loop-config, the three schema + version rows, and the create-only seed phase. |
| `packages/database/src/prisma/db_main/seed/07a-agent-golden-library.ts` | `AgentSeedRow` gains the seven loop-config columns; all 43 seeded agents carry them; fill-if-absent write + the `DepartmentAgentVersion` snapshot. |
| `packages/database/src/prisma/db_main/seed/index.ts` | Registers `seedConsultationLoopDefaults` in Phase 3, after the golden library. |
| `packages/database/src/prisma/db_main/seed/00-constants.ts` | Registers the `79000000` / `89000000` / `D0000000` id blocks. |
| `packages/applications/src/services/consultation/loop/__tests__/day1-loop-defaults.task686.test.ts` | **New.** 21 tests — validator parity, servable predicate, subscription resolution, one-PRIMARY, `enabled: true`, K7. |
| `packages/database/src/prisma/db_main/seed/__tests__/task-686-loop-defaults-idempotency.test.ts` | **New.** 7 behavioural idempotency tests against an in-memory fake Prisma client. |

**No migration.** A seed is not a schema change: `ConsultationContextSchema`,
`ConsultationContextSchemaVersion` and the seven `DepartmentAgent` columns all already exist
(TASK-658 `20260811000000`, TASK-659 `20260811010000`). No env var was introduced — this plane is
`global-kv`/DB-tier per TASK-679. No kill-switch default was touched.

### 3.4 Why the seed carries its own canonicalisers

`packages/database` must not import `@arcaai/applications` — that closes a cycle
(applications → domains → database). So `canonicalJson`, `computeDefinitionChecksum`,
`buildLoopConfigSnapshot` and `hasLoopConfig` are verbatim copies in `07e`. The parity is not left
to inspection: `day1-loop-defaults.task686.test.ts` imports the REAL functions and asserts both
checksums match the seed's, so the copies cannot drift silently. This is the same "the seed mirrors
it by hand; this test stops the two drifting" posture TASK-684 used for the gate labels.

---

## 4. TDD — RED first

The applications suite was written against a seed file that did not exist, and run:

```
Error: Cannot find module '../../../../../../database/src/prisma/db_main/seed/07e-consultation-loop-defaults'
 Test Files  1 failed (1)
      Tests  no tests
```

After the seed landed: **21 passed**.

---

## 5. Idempotency — proven by breaking the guard

**The repo-wide guard does not cover this ticket.** `seed/__tests__/seed-idempotency.test.ts`
scans for a `value` key in `update:` payloads of `globalSetting` / `userSettings` upserts. Nothing
this ticket writes has a `value` column, so that guard is silent here — it neither passes nor
protects. (Confirmed by reading it, not assumed.) This ticket therefore ships its own guard,
behavioural rather than static: `task-686-loop-defaults-idempotency.test.ts` runs the two real seed
phases against an in-memory fake Prisma client (the `task-641-allowed-origins-seed-corrections.test.ts`
precedent) and asserts what a SECOND run does to rows a human has since edited.

The contract it pins:

| Surface | Rule |
|---|---|
| Context schema | **CREATE-ONLY.** Never re-created, never updated, never resurrected after a soft delete, and never created alongside a default the tenant already owns (the application-layer "at most one default per (tenant, scope, department)" rule the DB cannot express). |
| Agent loop-config columns | **FILL-IF-ABSENT.** Written only onto agents carrying no loop configuration at all. |
| `DepartmentAgentVersion` | **CREATE-ONLY**, and skipped entirely for a configured agent. |

Fill-if-absent rather than create-only is the load-bearing choice for the agent columns: pure
create-only would mean every *already-seeded* environment stays `enabled: false` forever, because
the upsert takes the update path. Reading the current rows first is what lets an existing database
adopt the defaults while a tenant admin's own configuration is never reverted.

**Proven by breaking it, twice, and watching it fail.**

Probe 1 — made the agent loop-config unconditional in `update:`:

```
× does not revert a tenant admin's loop-config edit, and writes no extra version row
AssertionError: expected { version: 1, kinds: [ …(3) ] } to deeply equal { version: 1, …(1) }
 Tests  1 failed | 6 passed (7)
```

Probe 2 — turned the context-schema create into an unconditional upsert and dropped the
existence check:

```
× a second seed creates nothing new
× does not revert an operator's edit to the seeded schema
× never resurrects a schema the tenant soft-deleted
× never creates a second default alongside a tenant's own
 Tests  4 failed | 3 passed (7)
```

Both probes reverted; the suite then passed **7/7**.

**Known consequence, stated rather than hidden:** because the columns are fill-if-absent, changing
`DAY1_AGENT_LOOP_CONFIG` in code later will NOT propagate to an already-seeded agent. That is the
deliberate trade-off — operator ownership beats code ownership for a value the console lets a
tenant edit — and it is the same posture `GlobalSetting.value` has.

---

## 6. ⚠ The live dedupe finding — read this before merging

### 6.1 The two finalize paths dedupe only while the first execution is OPEN

The owner's instruction was to *verify they dedupe, change nothing* — and, if they do not,
**stop and report rather than shipping the seed**. They do not, in two of three orderings.

This matters *because of this ticket*: before it, the loop dispatched nothing
(`phase: "DISABLED"`), so `HarnessDocWorkflow` had exactly one caller. After it,
`endingActions: ['harness.finalize']` fires on every `consultation-ending`, so there are two.

Both paths use the same deterministic id, and both catch `WorkflowAlreadyStartedError`:

| Path | Where | Id |
|---|---|---|
| Loop | `apps/harness/…/temporal/workflows.py:2371` (`start_child_workflow`) | `harness-doc-{consultation_id}` |
| Legacy | `apps/harness/…/api/endpoints/internal.py:234,276` (`start_workflow`) | `harness-doc-{consultation_id}` |

But `WorkflowAlreadyStartedError` is only raised while an execution is **open**. Temporal's default
`WorkflowIdReusePolicy` is `ALLOW_DUPLICATE`, and neither call site overrides it — so once the
first execution has closed, the same id starts a **second** execution.

**Measured live**, against a real `temporalio/temporal` dev server (isolated, port 7234, removed
afterwards), driving the same two start calls with the same id
(`scratchpad/dedupe_probe.py`):

```
CASE A (legacy still RUNNING):        loop finalize -> ALREADY_STARTED (deduped, no-op)
CASE A executions for harness-doc-consultation-A: ['019ff569 RUNNING']

CASE B (legacy already COMPLETED):    loop finalize -> STARTED_A_NEW_EXECUTION
CASE B executions for harness-doc-consultation-B: ['019ff569 COMPLETED', '019ff569 COMPLETED']

CASE C (loop finalized first, then legacy start): legacy -> STARTED_A_NEW_EXECUTION
CASE C executions for harness-doc-consultation-C: ['019ff569 COMPLETED', '019ff569 COMPLETED']
```

**Case A is the ordinary case and it is safe** — `HarnessDocWorkflow` generates the note and then
sits at a clinician gate with a 24-hour SLA, so at `recording/stop` it is almost always still
RUNNING and the loop's child start is correctly a no-op. That is what the code comment at
`workflows.py:2355` describes, and it is true as far as it goes.

**Cases B and C are the exposure.** Reachable when:

- the legacy `HarnessDocWorkflow` closed early (it failed — SMR down, sensors unavailable — or the
  clinician signed off before recording stopped), and then `recording/stop` fires the loop's
  finalize; or
- the loop finalizes first (the loop AWAITS its child, so the loop completes only after the note
  is done) and a LATE transcript then arrives — STT batch callbacks landing after the session ends
  is entirely ordinary — driving the legacy start against a now-closed id.

Case C's hazard is arguably pre-existing for the legacy path alone; Case B is not — it exists
only because this ticket gives the loop a second reason to start the same workflow.

**Blast radius, as far as I could establish without a live stack:** a second execution re-runs SMR
generation and the sensor pass (cost, latency, duplicate WORM/audit writes). Whether it produces a
second *note row* is not settled: `persist_draft` is documented as an UPSERT of the existing
`DRAFT_PENDING_SENSORS` draft (`workflows.py:1087`), which would merge rather than duplicate — but
the gateway's `persistDraft` dedupes on an `Idempotency-Key` that a second execution mints
differently, so I could not confirm the merge holds across executions. **I did not want to guess
about a clinical note, which is why this is reported rather than assumed benign.**

**Note also that the two callers coexist exactly where this seed acts:** `harnessEnabled` is seeded
`true` for both Global and ArcaAI (`14-pipeline-policy.ts`), the two tenants whose consultations
this schema enables. A tenant that inherits the SYSTEM default (`harnessEnabled: false`) has only
the loop, and is unaffected.

**Recommendation (not applied — `apps/harness/**` belongs to TASK-685, and the owner said change
nothing):** pass `id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE` (or
`ALLOW_DUPLICATE_FAILED_ONLY`) at both start sites. One line each, and it makes the dedupe the code
comments already claim actually true.

### 6.2 Real STT transcripts still never reach the loop

`sttInternal.service.ts` emits only `TranscriptionCreated`, never `ContextAdded`
(TASK-684 §6.2, TASK-676). So even fully seeded, the loop reacts to **work notes, case notes and
attachments — not to transcripts.** Nothing in this ticket changes that. Do not read "the loop is
enabled" as "E2 (audio → transcript) works"; it does not, and the schema's `audio_stream` kind is
vocabulary, not a working path.

### 6.3 What could NOT be verified live, and why

A full database-backed run (seed → gateway → `enabled: true` on the wire, the way TASK-684 §5 did
it) was **not performed**. `pnpm test:db:reset` runs `prisma db push --force-reset`, and Prisma 7
refuses to run Migrate under an AI agent without the user's explicit consent:

```
Error: Prisma Migrate detected that it was invoked by Claude Code.
… you are forbidden from performing this action without an explicit consent and review by the user.
```

I did not have that consent, and did not route around the guard. The isolated test infra brought
up for the attempt (`pnpm infra:test:up`) was torn down again. What that leaves unverified is the
*wire* confirmation (`GET` the loop config through a running gateway and see `enabled: true`); the
resolution logic itself is covered against the real `LoopConfigService` with the real seeded rows
in `day1-loop-defaults.task686.test.ts`. **If you want the wire evidence, it needs one message
consenting to a `--force-reset` of the throwaway test database on port 5433.**

---

## 7. Verification evidence

Measured baseline first, in this worktree, at `dev-2.1` @ `40c935cb6` before any change.

| Gate | Baseline (dev-2.1) | After |
|---|---|---|
| `pnpm --filter @arcaai/database build` | clean | clean |
| `pnpm --filter @arcaai/database test` | 47 files / 1177 tests | **48 / 1184** (+1 file, +7) |
| `pnpm --filter @arcaai/applications build` | clean | clean |
| `pnpm --filter @arcaai/applications test` | 476 files / 8936 | **477 / 8957** (+1 file, +21) |
| `pnpm api:build` | — | 10 successful, 10 total |
| `pnpm test:unit` | 1 failed (pre-existing, §7.1) | **1 failed / 16879 passed** — same single pre-existing failure |
| `pnpm lint` | applications 194 warnings, 0 errors | 34/34 tasks; applications **194 warnings, 0 errors** — identical |

```
$ pnpm --filter @arcaai/database test
 Test Files  48 passed (48)
      Tests  1184 passed (1184)

$ pnpm --filter @arcaai/applications test
 Test Files  477 passed | 1 skipped (478)
      Tests  8957 passed | 4 skipped (8961)

$ pnpm api:build
 Tasks:    10 successful, 10 total
  Time:    28.974s

$ pnpm test:unit
 Test Files  1 failed | 996 passed | 2 skipped (999)
      Tests  1 failed | 16879 passed | 4 skipped | 9 todo (16893)

$ pnpm lint
 Tasks:    34 successful, 34 total
  Time:    20.639s
```

Zero lint warnings on any file this ticket added or changed (verified with `--force`, because the
turbo cache in this worktree replays results from sibling worktrees).

### 7.1 The one `test:unit` failure is pre-existing

`scripts/__tests__/env-sync.test.ts > docs/…/env-surface.generated.md matches the generator` —
the committed doc says `turbo.json#globalEnv entries | 160`, the generator computes `158`. This
ticket touched neither `turbo.json` nor that document. Proven rather than asserted: checked out
clean `dev-2.1` (detached) and ran the same file —

```
× env:sync — no drift on disk > docs/…/env-surface.generated.md matches the generator
      Tests  1 failed | 24 passed (25)
```

Same failure, no local changes. Fix belongs to whoever owns the `env:sync` drift, not here.

### 7.2 AC → test map

| AC | Test |
|---|---|
| AC-1 | `the seeded schema rows are servable` (`day1-loop-defaults.task686.test.ts`) |
| AC-2 | `is accepted by the real publish validator with zero problems` |
| AC-3 | `subscribes ONLY to kinds the seeded definition declares`, `writes ONLY outputs the seeded definition declares`, `passes every TASK-659 structural validator` |
| AC-4 | `seeds at most one PRIMARY agent per (tenant, department)` |
| AC-5 | `resolves enabled: true from the seeded schema + agent` |
| AC-6 | `K7 — …` ×4 (schema removed / DRAFT / un-pinned / no default agent) |
| AC-7 | all 7 cases in `task-686-loop-defaults-idempotency.test.ts` |
| — | checksum parity against the real canonicalisers, ×2 |

---

## 8. Change History

- 2026-08-12 — Worktree reset from `dev` to `dev-2.1` @ `40c935cb6`. Baseline gates measured before
  any change (database 47/1177, applications 476/8936, `test:unit` already 1 red).
- 2026-08-12 — TDD: applications suite written first and run RED (module not found), then the seed;
  21 green. Idempotency guard added and proven by two revert-after-failure probes.
- 2026-08-12 — Commit `1174c7b51`: seed + both test files. All gates green against the measured
  baseline; the only `test:unit` failure is pre-existing on clean `dev-2.1`.
- 2026-08-12 — Live dedupe probe on a real Temporal server: **Case A dedupes, Cases B and C do
  not** (§6.1). Status set **Blocked** per the owner's stop condition — the work is complete and
  reviewable, but it should not merge until the duplicate-finalize exposure has an owner decision.
  Not merged, not pushed.
