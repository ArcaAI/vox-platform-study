# TASK-798 — Bootstrap the tenant-authored consultation workflow

| | |
|---|---|
| **Status** | `Review` |
| **Type** | `feature` (seed data) |
| **Branch** | `feat/task-798-demo-workflow-seed` (from `dev-2.2` @ `cbd21e14b`) |
| **Owned surface** | `packages/database/**` only |
| **Blocked on** | TASK-795's Substrate-A exclusivity gate — for the `WorkflowAssignment` rows ONLY |

---

## 1. Requirement Analysis

The requirement is *"the harness agentic loop workflows are defined by tenant admin"* (R1).

The machinery is complete end to end: a tenant admin authors a `consultation`-palette graph in
Workflow Studio, `WorkflowDefinitionService` validates and compiles it at publish,
`WorkflowAssignment` binds it to a scope, and `ConsultationWorkflowDispatchService` resolves the
cascade at consultation open and stamps `trigger: 'consultation open'`.

The **data** was not there:

```
paletteKey      | status     | count
summarization   | PUBLISHED  | 1
summarization   | DRAFT      | 152
test            | DRAFT      | 1
WorkflowAssignment rows: 0
```

Every consultation therefore resolved `platform-default` and the default engine ran. R1 was true in
code and false in practice. This ticket supplies the rows that close that gap.

Scope is W1–W4 of the brief (workflow definitions, the gated assignment, per-department behaviour,
fixtures). The full consultation trace and feedback corpus of `TASK-789/seed-spec.md` §3.3–§3.4
(Areas 3 and 4) are **not** in scope here.

## 2. Current State Evaluation

Verified against source, not against the design note.

| Claim checked | Verdict |
|---|---|
| Zero `consultation`-palette definitions, zero assignments | **Confirmed** — the gap is real |
| Per-department `PromptTemplate` + approved v3 `PromptVersion` already seeded | **Confirmed** (`07b`, ids `71000000-…-0001-0000000000{12..15}`, `ARCAAI_CLINICAL_APPROVED_VERSION = 3`) |
| Per-doctor `DnaWritingStyleReport` already seeded | **Confirmed** (`08`, GEN `73000000-…-0001-000000000001`, RHEUM `…-000000000003`) |
| Per-department `DepartmentAgent` already seeded | **Confirmed** (`07a`, GEN `78000000-…-0001-000000000001`, RHEUM `…-000000000003`; index derivation traced through `ARCAAI_CLINICAL_DEPARTMENTS`) |
| Only ONE tenant-scoped `ConsultationContextSchema` per tenant | **Confirmed** — this was the missing fourth axis for R4 |
| The SYSTEM row's `registryChecksum` is stale | **Confirmed, and worse than documented** (see §5) |
| `dnaStylePolicy` is a gate, not a selector | **Confirmed** — `INHERIT \| DISABLED` only |

### The exclusivity hazard (the reason W2 ships disabled)

`LoopContextSignalService.loopAllowedFor()` — the chokepoint for all three Substrate-A signals —
consults exactly two things: the `harness.loop.emergencyStop` platform veto and the tenant's
`agenticLoop` entitlement. **Neither knows whether a tenant-authored graph is already governing the
consultation.** Substrate B's `consultation.persistDraft` calls the *same* `persist_draft` activity
Substrate A uses.

So an assignment row today means **two writers on one clinical `ContextItem`**. That is a
clinical-safety defect, not a race to be tuned.

### Three corrections to the design note (`TASK-789/seed-spec.md`)

The spec was a good map and wrong in three places. Each was caught by running the real code.

1. **`registryChecksum` is `40c1424a…`, not the spec's `9635b9a9…`.** The registry moved again
   after the spec was written. Regenerated, not copied.
2. **`fields` on a STRUCTURED context kind is an authorable JSON Schema, not a flat
   `name -> type` map.** The spec's `{ bp: 'string', hr: 'number' }` would have produced a
   definition the service rejects at publish. Caught by running the real
   `contextSchemaDefinitionProblems()`.
3. **The spec's 14-node graph omits `consultation.realtimeSummary`**, which the requirement's
   capability chain names explicitly. The palette registers 16 consultation nodes, not 13. The
   graphs here use the full chain.

## 3. Implementation Summary

### W1 — a real tenant-authored consultation workflow · **DONE**

`packages/database/src/prisma/db_main/seed/23-arcaai-workflow-authoring.ts`

Two `PUBLISHED`, `isActive` definitions owned by the ArcaAI customer tenant
(`50000000-0000-0000-0000-000000000001`) and attributed to its admin
(`70000000-0000-0000-0000-000000000003`) — **not** the SYSTEM user, since the entire claim of the
row is that a tenant admin authored it.

| | `arcaai-consultation-soap` | `arcaai-rheum-consultation-soap` |
|---|---|---|
| id | `99000000-0000-0000-0001-000000000001` | `…-000000000002` |
| nodes | 17 | 18 |
| compiled | 16 stages, 1 gate | 17 stages, 1 gate |

The chain is the one the requirement names, and every node is a registered `implemented: true`
palette entry with a real interpreter activity behind it:

```
core.start → consentGate → captureBinding → extractEntities → realtimeSummary
 → bindTerminology → phiHop → retrieveEvidence → assemblePrompt → synthesize
 → suggestions → proposeCorrections → sensors [→ inferentialSensors] → persistDraft
 → finalizeAssurance → hitlGate → core.end
```

Rheumatology differs in two ways a reader can point at: it adds `consultation.inferentialSensors`
(the LLM-as-judge pass), and its `assemblePrompt` pins `dnaStyleId` to the department clinician's
DNA report — the **only** place in the platform where a specific writing style can be selected.

Compare to the SYSTEM platform default: 4 nodes, `summarization` palette, and a validation report
deliberately **scoped** to `WF-SUMM-*` because the full catalogue produces ERRORs against it. These
two rows validate clean against the **full** rule set.

### W2 — the assignment, behind a safety guard · **DONE (rows authored, deliberately NOT written)**

`packages/database/src/prisma/db_main/seed/substrate-exclusivity-guard.ts`

`CONSULTATION_ASSIGNMENT_ENABLED` is **derived, never hand-set**:

```ts
export const CONSULTATION_ASSIGNMENT_ENABLED = detectSubstrateExclusivityGate().present;
```

The probe strips comments from `loop-context-signal.service.ts` and looks for a `workflow`
reference in the executable remainder. Comment-stripping is load-bearing: that file's docstring
already says *"signals the `ConsultationLoopWorkflow`"*, so a raw text match would report the gate
present today — exactly backwards. A test pins that distinction.

Current probe result:

```
present : false
evidence: []
probed  : packages/applications/src/services/consultation/loop/loop-context-signal.service.ts
CONSULTATION_ASSIGNMENT_ENABLED = false
```

Both failure directions are safe:

| Direction | Consequence |
|---|---|
| False negative (gate lands somewhere the probe doesn't look) | Assignment stays off. Recoverable by widening the probe. |
| False positive (a `workflow` mention that isn't a gate) | The flag/probe parity test goes **RED**, forcing a human to read the gate. The assignment stays off until someone does. |

Neither ends in a silent enable. The seed also refuses to skip quietly — it prints a boxed warning
naming TASK-795, the two-writer hazard, and the probed path.

### W3 — two departments, two behaviours · **DONE**

`packages/database/src/prisma/db_main/seed/07f-arcaai-department-context-schemas.ts`

Two DEPARTMENT-scoped `ConsultationContextSchema` rows + version-1 snapshots, supplying the one
axis that was missing:

| | General Medicine | Rheumatology |
|---|---|---|
| schema id | `79000000-0000-0000-0001-000000000010` | `…-000000000011` |
| slug | `consultation_gen_arcaai` | `consultation_rheum_arcaai` |
| distinctive kinds | `vitals` | `joint_count`, `inflammatory_markers` |
| outputs | `soap_note`, `problem_list` | `soap_note`, `disease_activity` |

`isDefault: true` on both is correct — the constraint is per `(tenantId, scope, departmentId)`, so
a DEPARTMENT default *shadows* the tenant default for that department without colliding with it.

### W4 — fixtures · **DONE**

Two `WorkflowTestFixture` rows (one definition-scoped, one tenant-wide), keyed exactly as the
consultation nodes read `run_payload` — `consultationId` / `externalPatientId` / `userId` /
`sessionId` / `transcriptText`. `WorkflowTestFixture` is registered in `SEED_PHI_MODELS`, so `input`
is written as Vault-Transit ciphertext (the plaintext column was dropped).

Synthetic is a contract: `SYNTH-00N` patient ids, transcripts naming no seeded patient, asserted by
test.

### Decision taken: both phases are excluded from `safe` mode

Not in the design note, and worth flagging as reversible. `safe` is documented as *"suitable for a
production day-1 bootstrap"*. Both new phases carry `createdBy: <the ArcaAI tenant admin>` — which
is the point in a demo database and a **fabricated governance act** in a real one: a published
clinical workflow attributed to a human who never authored it. That is the same objection the design
note uses to exclude a seeded `AgentPromotion` outright.

`21-workflow-definition` stays in `safe` by contrast: SYSTEM-owned, `createdBy: SYSTEM_USER_ID`,
claiming no human author.

This tripped `seed-mode.test.ts`'s deliberate-act guard, as designed; that expectation was updated
with the reasoning recorded inline.

### Files

| File | Change |
|---|---|
| `seed/23-arcaai-workflow-authoring.ts` | **new** — definitions, assignments, change log, fixtures, the gated seeder |
| `seed/23-arcaai-workflow-authoring.generated.ts` | **new, GENERATED** — checksums, compiled configs, validation reports |
| `seed/07f-arcaai-department-context-schemas.ts` | **new** — the two department vocabularies |
| `seed/substrate-exclusivity-guard.ts` | **new** — the W2 probe |
| `scripts/regen-arcaai-consultation-workflow-seed.ts` | **new** — regenerates every derived blob from the real engine |
| `seed/__tests__/task-798-arcaai-workflow-authoring.test.ts` | **new** — 29 tests |
| `seed/__tests__/task-798-arcaai-department-context-schemas.test.ts` | **new** — 10 tests |
| `seed/index.ts` | wired both phases, each behind `isPhaseEnabled` |
| `seed/seed-mode.ts` | both phases added to `SEED_PHASES_EXCLUDED_FROM_SAFE`, with reasoning |
| `seed/__tests__/seed-mode.test.ts` | deliberate-act expectation updated |
| `seed/phi-encryption.ts` | `WorkflowTestFixture` registered in `SEED_PHI_MODELS` |
| `seed/00-constants.ts` | `9A`/`9B` id blocks documented (comment only) |

**No schema change and no migration.** Every table used already exists.

## 4. Provenance — how each derived blob was produced

Nothing was hand-typed. `graph` is authored; `graphChecksum`, `compiledConfig`,
`compiledConfigChecksum`, `registryChecksum` and `validationReport` are engine output.

```
$ pnpm --filter @arcaai/workflow-contract build
$ pnpm --filter @arcaai/database exec tsx scripts/regen-arcaai-consultation-workflow-seed.ts

=== REGISTRY_CHECKSUM ===
40c1424a0bc325129866f2aa2dcb64262a2fab083249d452d0bb63483b05aeb3

######## GEN — arcaai-consultation-soap ########
=== GEN_GRAPH_CHECKSUM ===
4bf333e993636d6ccfca08a681312fc399ff621f1f6fea314594c6e6f5eb7629
=== GEN: validate() ok=true, 0 finding(s) · compile() 16 stage(s), 1 gate(s) ===

######## RHEUM — arcaai-rheum-consultation-soap ########
=== RHEUM_GRAPH_CHECKSUM ===
39da99853c45c5b8b2520079d8ed148366de5713f8dfb23199e433700fc2cde9
=== RHEUM: validate() ok=true, 0 finding(s) · compile() 17 stage(s), 1 gate(s) ===

Wrote …/seed/23-arcaai-workflow-authoring.generated.ts
```

**The pasted output is not the guarantee — the test is.** The suite re-runs the real
`validate()` / `compile()` / `registryChecksum()` and asserts byte-equality with the seeded
literals, so a hand-edited or stale blob fails CI rather than shipping. When the node registry
moves, those tests go red and the script must be re-run.

Two deliberate departures from the Summarization sibling script, both recorded in its docstring:
it **writes** a generated module rather than printing literals for a human to paste (two ~450-line
`compiledConfig` blobs are a transcription-error surface with no upside — the review still happens
via the committed diff), and it refuses to write anything if either graph fails to validate or
compile.

### On the SYSTEM row's stale checksum

Not refreshed by this ticket. It is SYSTEM-owned and outside the ticket's surface, and refreshing it
would change `compiledConfig.checksum` on a row other tickets may be reasoning about. These two rows
carry the **current** value, and a test asserts they never carry the stale one.

## 5. Verification Evidence

### `pnpm --filter @arcaai/database test`

```
 RUN  v4.1.10 /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-task-798/packages/database

 Test Files  64 passed (64)
      Tests  1629 passed (1629)
   Duration  1.32s
```

### TASK-798 suites, verbose

```
 Test Files  2 passed (2)
      Tests  39 passed (39)
```

Including the load-bearing ones:

```
✓ W1 — derived blobs are real compiler output > arcaai-consultation-soap: validate() returns ok with ZERO findings against the FULL rule set
✓ W1 — derived blobs are real compiler output > arcaai-consultation-soap: the seeded compiledConfig is byte-identical to what compile() produces now
✓ W1 — derived blobs are real compiler output > carries the CURRENT registry checksum — never the stale one on the SYSTEM row
✓ W2 — the flag tracks the real presence of the gate, in both directions
✓ W2 — writes NO assignment row while the gate is absent
✓ W2 — says so LOUDLY rather than skipping in silence
✓ W2 — writes both assignment rows and their WORM change rows once enabled
✓ W2 — the gate detector itself > reports absent when the probed source has the concept only in comments
✓ W3 — 70000000-…-0001-000000000001: passes the REAL contextSchemaDefinitionProblems() with zero problems
✓ W3 — re-seed safety > is CREATE-ONLY: an existing default for that (tenant, scope, department) is never overwritten
```

Seeder output observed under test (both branches exercised):

```
  ✓ Workflow definitions: 2 created, 0 skipped · fixtures: 2 · assignments: 0 (GATED — see warning above)
  ✓ Workflow definitions: 2 created, 0 skipped · fixtures: 2 · assignments: 2
  ✓ Department context schemas: 2 created, 0 skipped
  ✓ Department context schemas: 0 created, 2 skipped
```

### `build` / `typecheck`

```
> @arcaai/database@0.1.0 build     > tsc          (clean)
> @arcaai/database@0.1.0 typecheck > tsc --noEmit (clean)
```

### Lint — stated honestly

`packages/database` has **no `lint` script and no ESLint config**:

```
$ pnpm --filter @arcaai/database lint
 ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT  None of the selected packages has a "lint" script

$ pnpm turbo lint --filter=@arcaai/database
 WARNING  No tasks were executed as part of this run.
 Tasks:    0 successful, 0 total
```

So "lint green" is not a claim that can be made for this package. Pre-existing, not introduced here.

### TDD — RED observed before each implementation

| Item | RED |
|---|---|
| W1/W2/W4 | `Error: Cannot find module '../23-arcaai-workflow-authoring'` |
| W3 | `Error: Cannot find module '../07f-arcaai-department-context-schemas'` |
| Safe-mode exclusion | `AssertionError: expected [ '02-apikey', …(4) ] to include '23-arcaai-workflow-authoring'` |

## 6. Open items for the orchestrator

1. **The assignment stays OFF until TASK-795's gate lands.** Confirm it, then re-run the seed —
   the flag re-derives itself; no code edit should be needed. If 795 implements the gate somewhere
   other than `loop-context-signal.service.ts`, the probe needs widening (a one-line change here).
2. **`@arcaai/database`'s test suite never runs in CI.** `.gitlab/ci/test.yml`'s `test-packages`
   job builds the package and runs `db:generate`, but its `pnpm turbo test --filter=…` list does
   not include it. So the provenance gate and the assignment guard built here — and the package's
   other 1629 tests — do not execute in CI today. `.gitlab/**` is outside this ticket's surface;
   requested, not edited.
3. **`@arcaai/json-schema-subset` must be built** for the W3 suite (it backs the real context-schema
   validator). The test fails with an explicit instruction rather than a resolver error.
4. **Owner decision available for revisit:** excluding both phases from `safe` mode (§3). Reversible
   in one line if a seeded, pre-attributed tenant workflow is wanted in a production bootstrap.

## 7. Change History

| Date | Change |
|---|---|
| 2026-08-23 | Initial implementation — W1–W4. Assignment rows authored and gated OFF pending TASK-795. |
