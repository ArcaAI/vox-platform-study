# TASK-732 — Tenant Migration off Legacy + Legacy Generator Deletion

| | |
|---|---|
| **Status** | Pending |
| **Wave** | 4 · **Size** | L |
| **Epic slug** | `legacy-migration-deletion` |
| **Depends on** | TASK-713 (`harness-eval-gate` — a real PASS/FAIL clinical-quality gate must exist before clinical documentation is migrated), TASK-730 (`harness-infra-productionization` — supplies the availability measurement this ticket's go/no-go consumes), TASK-731 (`palette-consultation` — the consultation palette must exist before legacy is the only fallback removed) |
| **Design refs** | **D1** (Generator end-state — "entry-point seam now → capped legacy floor during infra hardening → harness-only, legacy deleted"); Plane 2 §"Wave 2 migration"; §Deprecations (the literal deletion list); §Roadmap Wave 4; §Error handling ("Temporal unreachable → platform default config → (migration period only) capped legacy floor → visible queued failure") |
| **Findings closed** | Reaches A-09, A-19, A-22's built-but-unreachable safeguards for every tenant (`02-conformance-matrix.md` §1); retires the mechanism behind A-25's sign-before-assurance risk by deleting the path that produces `SummaryMeta`-less drafts. Does **not** by itself close A-02/A-06/A-07/A-08 — those are Wave 0/1 tickets and must already have landed. |

---

## 1. Requirement Analysis

This ticket executes D1's third phase and is the **end-state of the whole generator program**: every
tenant is migrated onto `HarnessDocWorkflow` as the sole signable note generator, and the legacy
BullMQ generator plus its sibling entry points and the deliberately-capped TASK-714 safety floor are
**deleted from the tree**.

It is deliberately structured as four phases, in this order, because reversing any two of them is
unsafe:

1. **Migration readiness** — a checklist, not code. It consumes TASK-730 Task 4's availability
   report and applies explicit, written go/no-go thresholds. **HUMAN-GATED.** This phase can
   legitimately conclude *"do not migrate"* — see §1.1.
2. **Tenant migration** — flip `harnessEnabled` per tenant through the TASK-704 seam, in cohorts,
   with a defined monitoring window and a per-cohort rollback that is a single row write.
3. **Deletion** — remove the legacy generator, the unforked entry points, the TASK-714 floor, and
   the dead queues/processors/config. Every deletion task names the tests that must still pass
   after removal.
4. **Post-deletion assertions** — grep-gates and contract tests that make the deletion permanent:
   after this ticket, `harnessEnabled` has **no reader at all except the seam**, and the seam's
   legacy branch is gone.

### 1.1 The inversion condition — this ticket may correctly decide not to proceed

`04-target-architecture.md` §"What would have to be true for me to be wrong" names one condition
that inverts D1's end-state:

> **Harness availability under a mandatory dependency is worse than legacy's.** If making Temporal
> non-optional produces more clinical harm through missing notes than legacy produces through
> unverified ones, the end state inverts and the answer is (a) permanently.

`assessment/README.md` §5 restates it: *"If the missing-note rate exceeds the harm rate of unverified
notes, the end state inverts to permanent-legacy."* Both documents state the condition; **neither
defines how either rate is measured.** Phase 1 Task 2 of this ticket defines both, because a
go/no-go gate whose inputs are undefined is not a gate.

If the measured comparison says invert, this ticket **stops after Phase 1**, records the finding, and
raises a design-change proposal against `design.md` D1. Phases 2–4 do not execute. That outcome is a
success of this ticket, not a failure of it — and it is why Phase 1 is separable and human-gated.

### Explicitly OUT of scope

- **Building any harness capability.** If a harness equivalent for pre-summary or comprehensive
  summary does not exist by execution time, those entry points are handled by the decision recorded
  in TASK-704 Task 5 (documented fallback / structured refusal), not by inventing new harness
  workflows here. See §2.6 — this is the single largest scope risk in the ticket.
- **The `SIGNED` write site.** Untouched. `summary.service.ts` `approveSummary` keeps its single
  writer, single caller and authenticated-human gate (`02-conformance-matrix.md` P-01).
- **`ConsultationLoopWorkflow`.** Not adopted, not deleted here. `design.md` §Deprecations lists it
  as deprecated; TASK-705 (`loop-status-discovery`) owns finding out whether it is running.
  Deleting it is a separate change with its own replay-fixture consequences.
- **Retiring `PromptAssemblyService` / `PromptResolutionService` / `smr-generate`.** Verified
  shared with the harness path (§2.5) — deleting them would break the harness.
- **The admin-console pipeline-policy screen.** Its `harnessEnabled` cascade row becomes a
  single-valued control; whether to remove the row is a Studio-consolidation question owned by
  TASK-719, not this ticket. Phase 4 only asserts the label is no longer misleading.
- **Any change to `apps/harness`.** This ticket deletes TypeScript legacy code; it adds nothing to
  the harness.

---

## 2. Current State Evaluation

Re-derived against the live tree on branch `feat/loop` (2026-08-16). Search exclusions applied:
`.claude/worktrees/**`, `**/dist/**`, `**/node_modules/**`, `**/.venv/**`, `**/__pycache__/**`,
`**/.next/**`, `docs/archive/**`.

> **Read this first.** Everything below is the tree as it stands **before** TASK-704 lands. TASK-704
> introduces `packages/applications/src/services/consultation/note-generation/` and routes all seven
> entry points through it. **Verified: that folder does not exist today** — zero hits for
> `NoteGenerationService` anywhere under `packages/**/src` or `apps/**/src`; the only occurrences are
> in `design.md:56`, `04-target-architecture.md:68,257`, `assessment/README.md:200` and
> TASK-704's own README. Phase 3 Task 1 re-derives the deletion set against the post-TASK-704 tree
> before any deletion happens.

### 2.1 The legacy generator — two processors, 626 LOC

| File | LOC | Class | Queue binding |
|---|---|---|---|
| `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts` | 389 | `SummaryProcessor extends WorkerHost` (`:25`) | `@Processor(JobQueue.GenerateSummary)` (`:24`) → `"GenerateSummary"` |
| `packages/applications/src/services/consultation/jobs/processors/ner.processor.ts` | 237 | `NerProcessor extends WorkerHost` (`:22`) | `@Processor(JobQueue.ExtractNamedEntities)` (`:21`) → `"ExtractNamedEntities"` |

Non-test references (imports/providers only — comment-only mentions excluded):
`jobs/consultation-job.service.module.ts:10,12` (imports), `:54,56` (providers), `:35,37` (module
comments naming them); `jobs/processors/index.ts:1,3`; `jobs/index.ts:4` (`export * from
'./processors'`).

**Deletion hazard — the processors are part of the package's public API.** `jobs/index.ts:4`
re-exports the processors barrel, so `SummaryProcessor`/`NerProcessor` leak out of
`@arcaai/applications`. The barrel line must go with them.

**Deletion hazard — the harness depends on the module that hosts them.**
`packages/applications/src/services/consultation/harness/harness-internal.service.module.ts:31`
imports `ConsultationJobServiceModule` (for SSE progress —
`harness-internal.service.ts:147` comments on it). The **module** survives; only the legacy
providers/queues inside it are removed.

### 2.2 `createSummaryJob` and the sibling entry points

- `ConsultationJobService.createSummaryJob` — interface `jobs/consultation-job.service.ts:31`,
  implementation `:161`, enqueue `this.summaryQueue.add('generate', payload, …)` at `:201`.
- Non-test callers: `apps/api/src/modules/consultation/consultation.controller.ts:1151` (inside
  `generateSummaryAsync`, declared `:1146`, route `POST :id/summary/async` at `:1141`, scope
  `consultation:report:write` at `:1145`) and
  `packages/applications/src/services/consultation/events/consultation-event.handler.ts:227` (the
  legacy branch of fork 1).
- `ConsultationJobService.createComprehensiveSummaryJob` — interface `:41`, implementation `:224`,
  queue injected `:86`; sole non-test caller `consultation.controller.ts:1257`.

**The third generator lives in `summary.service.ts` (1577 LOC) and does its own prompt assembly and
SMR call.** There is **no method named `generate`** — the assessment's shorthand. The real methods:

| Method | Declared | Prompt assembly | SMR call |
|---|---|---|---|
| `generateSummary(consultationId, request)` | `:402` | `:463` (`promptAssemblyService.assemble`) | `:482` (`callSmrService`) |
| `generatePreSummary(...)` | `:259` | `:303` | `:325` |

Private SMR plumbing in the same file: `callSmrService` `:1272`, `isSmrFallbackEligible` `:1329`,
`executeSmrGenerate` `:1342`.

**The vacuous assurance guard** — `summary.service.ts:867`:

```ts
const signedBeforeAssurance = !!draftMeta && !draftMeta.assuranceCompletedAt;
```

Consumed at `:959` → emits `HarnessAuditAction.SIGNED_BEFORE_ASSURANCE` (`:964`). TASK-714 makes this
non-vacuous on the legacy path; this ticket deletes the path and, with it, TASK-714's floor.

### 2.3 `ComprehensiveSummaryProcessor` and the fourth queue

`packages/applications/src/services/consultation/jobs/processors/comprehensive-summary.processor.ts`
— 485 LOC, class declared `:49`, `@Processor(JobQueue.GenerateComprehensiveSummary)` at `:48`. Its
own prompt assembly and SMR mapping at `:378` / `:401`; assembly service injected `:63`. Registered
at `consultation-job.service.module.ts:13` (import), `:43` (`registerQueue`), `:57` (provider),
`:31` (`ChainSummaryServiceModule, // Required for ComprehensiveSummaryProcessor`).

**A fifth processor the assessment never named:** `PreSummaryProcessor` (301 LOC,
`jobs/processors/pre-summary.processor.ts:21`, `@Processor(JobQueue.GeneratePreSummary)` at `:20`,
registered `consultation-job.service.module.ts:41`). It shares the same prompt-assembly + SMR pattern
and is the processor behind TASK-704 entry point #5. **This ticket must decide its fate explicitly**
(§2.6, Phase 3 Task 2) — it is not covered by `design.md` §Deprecations, which names only the summary
generator, `createSummaryJob`, the `summary.service` third generator and
`ComprehensiveSummaryProcessor`.

### 2.4 `harnessEnabled` — where it is read and what it defaults to

Runtime readers today (non-test, non-seed, excluding generated domain code and DTO/type
declarations):

| file:line | What it does |
|---|---|
| `consultation/events/consultation-event.handler.ts:146` | **Fork 1** — summary routing |
| `consultation/events/consultation-event.handler.ts:322` | **Fork 2** — auto-NER skip (the assessment counted one fork; there are two) |
| `consultation/events/consultation-event.handler.ts:501,503` | per-consultation `metadata.pipelineConfig` override merged over the cascade |
| `config-resolver/config-resolver.service.ts:316` | cascade code-default fallback |
| `pipeline-policy/pipeline-policy.service.ts:66,144,229,474,501` | row ⇄ snapshot ⇄ DTO mapping (write-side, not a routing read) |
| `apps/admin-console/src/features/pipeline-policy/components/cascade.ts:29,42,53` | UI cascade row; `:53` renders `'harness' | 'legacy'` |

Fork 1 (`:146`): TRUE branch mints `harness-doc-${randomUUID()}` (`:147`), loads the transcript
best-effort (`:154`), resolves redaction rules (`:170`), then
`await this.harnessGatewayService?.start(consultationId, {…})` at **`:172`** — the optional-chaining
silent-drop TASK-704 fixes — and returns at `:183`. FALSE branch resolves prompts (`:203`) then
`createSummaryJob` at **`:227`**.
Fork 2 (`:322`): TRUE branch logs and emits `pipelineCompleted` (`:330`); FALSE branch calls
`createNerJob` at **`:334`**.

Definitions and defaults:
- Settings-registry descriptor: `settings-registry/descriptors/pipeline.descriptors.ts:41`
  (`globalOnly: true`).
- Cascade descriptor: `config-resolver/config-resolver.service.ts:80` —
  `harnessEnabled: { codeDefault: false, maxScope: PipelinePolicyScope.DEPARTMENT }`.
- **SYSTEM cascade default is `false`**: `packages/database/src/prisma/db_main/seed/14-pipeline-policy.ts:56`
  (`SYSTEM_PIPELINE_POLICY_DEFAULTS`, declared `:53`). Both seeded real tenants override it to
  `true`: `:64` (demo) and `:78` (ArcaAI). A dev/e2e helper also seeds it true:
  `packages/database/scripts/harness-consultation-seed.ts:72`.
- The seed default is **asserted by a test**: `packages/database/src/__tests__/seed.test.ts:2961,2989`
  assert the SYSTEM row's `harnessEnabled === false`. Flipping the default is a seed change **and** a
  test change, in one commit.

### 2.5 What must NOT be deleted — verified shared with the harness

| Module | Path | Harness consumer (verified) |
|---|---|---|
| `PromptAssemblyService` (801 LOC) | `consultation/prompt/prompt-assembly.service.ts` | `consultation/harness/harness-internal.service.ts:41` (import), `:142` (injected), `:644` (`assemble(…)` inside `assemble()` declared `:554`); module wiring `harness-internal.service.module.ts:8,54` |
| `PromptResolutionService` (990 LOC, class `:320`) | `consultation/prompt/prompt-resolution.service.ts` | `harness-internal.service.module.ts:7,29`; also `live-agent-resolution.service.ts:36,44`, `agentic-instructions.service.ts:9,67`, `apps/api/src/modules/smr-compat/smr-compat-template.service.ts:1,50` |
| `smr-generate` (128 LOC) | `consultation/summary/smr-generate.ts` (`buildSmrGeneratePayload` `:88`, `mapSmrGenerateResponse` `:117`) | `live-documentation.service.ts:24,2079`; `chain-summary.service.ts:19,619,629` |

`smr-generate.ts:1` type-imports `AssembledPrompt` from `prompt-assembly.service` — the two are
coupled and both survive.

### 2.6 The honest scope problem: three of the seven entry points have no harness equivalent

TASK-704 §1 states it plainly: *"no such Temporal workflow exists today"* for pre-summary or
comprehensive-summary generation, and its Task 5 routes entry points #2, #3, #5, #6, #7 through the
seam's decision **with a documented fallback to legacy**, not through a harness path.

**Therefore "delete legacy" is not literally achievable for those five entry points unless one of
three things is true**, and Phase 3 Task 2 must pick one in writing:

| Option | Consequence |
|---|---|
| **(a) Delete the capability.** Retire `generatePreSummary`, `generateComprehensiveSummary` and their async siblings as product features. | Smallest code; requires a product decision — the SDK and admin console call them (§2.7). **HUMAN-GATED.** |
| **(b) Keep them, un-gated, as explicitly non-signable helper generators.** They already cannot sign: `approveSummary` gates on `contextItem.isFinalSummary`, and `PRE_SUMMARY` is excluded (`04-target-architecture.md` §The four paths, path 3). | Legacy generation code survives for non-signable artifacts. D1's promise ("legacy deleted") is then scoped to the **signable** generator, which is what D1 actually protects. Requires the ticket to say so out loud rather than quietly leaving files behind. |
| **(c) Build harness equivalents.** | Out of this ticket's size; a new ticket. |

The design's own words support (b) as the default reading — `design.md` D1 says *"harness-only,
legacy deleted"* in the context of *"the sole **signable** generator"*, and §Deprecations names
`ComprehensiveSummaryProcessor` but not `PreSummaryProcessor`. **This ticket's recommendation is (b)
for pre-summary and (a)-or-(b) for comprehensive summary**, decided in Phase 3 Task 2 with the
product owner. Nothing further is assumed here.

### 2.7 Consumers that break on route deletion

`POST :id/summary/async` is called from four places outside `apps/api`:
`packages/agentic-sdk-v2/src/hooks/useArca.ts:1116`,
`packages/agentic-sdk-v2/src/hooks/useArcaSummary.ts:206`,
`apps/admin-console/src/features/playground-consultation/api/client.ts:63`,
`apps/admin-console/src/features/playground-consultation/api/hooks.ts:103`.

The route itself is **not** deleted by this ticket — only its legacy *implementation*. After
TASK-704 the route calls the seam; after this ticket the seam has one branch. The SDK contract is
unchanged.

Two static registries reference the handler by name and break on any rename/removal:
- `apps/api/src/bootstrap/api-key-scope-audit.ts:45` —
  `{ controller: ConsultationController, method: 'generateSummaryAsync' }`, asserted by
  `apps/api/src/bootstrap/__tests__/api-key-scope-audit.test.ts:37`.
- `packages/applications/src/__tests__/cross-tenant-coverage.test.ts:266,272,278,284` — a
  `PROCESSOR_COVERAGE` table that hard-codes the four processor **test file paths** and asserts
  `minTests: 3` each. **Deleting the processors deletes their tests, which fails this gate.** The
  gate must be edited in the same commit as the deletion — it is a coverage ledger, not a bug.

### 2.8 Tests that exist today and must be accounted for

Direct legacy-processor suites (all under `packages/applications/src/services/consultation/jobs/`):
`__tests__/summary.processor.test.ts`, `__tests__/summary.processor.tenant-explicit.task635.test.ts`,
`__tests__/summary.processor.lineage.task635.test.ts`, `__tests__/ner.processor.test.ts`,
`processors/__tests__/ner.processor.encryption.test.ts`,
`__tests__/comprehensive-summary.processor.test.ts`,
`__tests__/comprehensive-summary.processor.tenant-explicit.task635.test.ts`,
`__tests__/comprehensive-summary.processor.usage-emission.task615.test.ts`,
`__tests__/pre-summary.processor.test.ts`,
`__tests__/pre-summary.processor.tenant-explicit.task635.test.ts`,
`processors/__tests__/pre-summary.processor.test.ts`.

Job service / handler / integration:
`jobs/__tests__/consultation-job.service.test.ts`,
`jobs/__tests__/integration/job-queue.integration.test.ts`,
`events/__tests__/consultation-event.handler.test.ts`,
`events/__tests__/consultation.events.test.ts`.

`harnessEnabled`-touching suites that must stay green through the default flip:
`config-resolver/__tests__/config-resolver.service.test.ts`,
`pipeline-policy/__tests__/pipeline-policy.service.test.ts` (+ `.encryption.test.ts`),
`settings-registry/__tests__/settings-registry.test.ts`,
`settings-registry/__tests__/effective-settings.service.test.ts`,
`packages/database/src/__tests__/seed.test.ts:2961,2989`,
`apps/api/src/modules/pipeline-policy-admin/__tests__/pipeline-policy-admin.controller.test.ts`,
`apps/api/src/modules/settings-catalog/__tests__/settings-catalog.controller.test.ts`,
`apps/api/tests/e2e/harness-gate.spec.ts:129`,
`apps/api/tests/e2e/settings-registry-write.spec.ts:66`,
`apps/admin-console/tests/e2e/pipeline-policy.spec.ts:133,198`.

### 2.9 The queue inventory

`JobQueue` enum: `packages/domains/src/enums/JobQueue.enum.ts:3-37`. Consultation-note queues and
their registrations, all in `consultation-job.service.module.ts`:

| Queue | Processor | `registerQueue` | Note-generation? |
|---|---|---|---|
| `GeneratePreSummary` (enum `:16`) | `pre-summary.processor.ts:20` | `:41` | YES (see §2.6) |
| `GenerateSummary` (enum `:17`) | `summary.processor.ts:24` | `:42` | YES — deleted |
| `GenerateComprehensiveSummary` (enum `:18`) | `comprehensive-summary.processor.ts:48` | `:43` | YES (see §2.6) |
| `ExtractNamedEntities` (enum `:19`) | `ner.processor.ts:21` | `:44` | YES — deleted |

Non-consultation queues (untouched): `GenerateDnaReport`, `MineGateEditExemplar`,
`IngestKnowledgeDocument`, `AuditLog`, `SyncTenantDirectoryUsers`, `AiUsageOutboxDrain`.

### 2.10 What TASK-730 hands this ticket

TASK-730 Task 4 produces "the availability-measurement report (5xx rate, latency percentiles,
duplicate-execution count for `harness-doc-{consultationId}`)" and its Acceptance Criteria require
its conclusion — *"does harness-mandatory hold, per D1?"* — recorded explicitly, "even if the answer
is 'inconclusive, re-measure after N more weeks of traffic.'" TASK-730's §6 states plainly that this
ticket, not that one, makes the call: *"that is a DESIGN-LEVEL decision this ticket's data feeds, not
one this ticket makes unilaterally."* Phase 1 is where the call is made.

---

## 3. Knowledge & Best Practices

### 3.1 Repo law that binds this work

| Rule + section | Binding constraint |
|---|---|
| `.claude/rules/01-development-workflow.md` §Layer Gates | Deletions still run the full gate set: `pnpm --filter @arcaai/applications build test`, `pnpm api:build`, `pnpm test:unit`, `pnpm test:e2e`, `pnpm lint`. Paste output. |
| `.claude/rules/01-development-workflow.md` §TDD | The deletion order is **test-first in reverse**: each deletion task first states the suite that must remain green, runs it, then deletes, then re-runs. A deletion whose "test" is "nothing failed" verifies nothing. |
| `.claude/rules/01-development-workflow.md` §Anti-Patterns | *"Claim 'done' without evidence"* — every phase pastes real output. |
| `.claude/rules/04-application-services.md` §NEVER | Nothing in this ticket may add a `databaseService.client` read or a `@arcaai/database` runtime import to a service. Deletion only. |
| `.claude/rules/02-database-prisma.md` §Seeds | The SYSTEM cascade default lives in `seed/14-pipeline-policy.ts`. **Deployed rows do not re-seed** (the same drift that forced TASK-702's data migration) — Phase 2 therefore flips tenants by an explicit `PipelinePolicy` write, never by relying on a seed edit. |
| `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers | `harnessEnabled` is a `PipelinePolicy` row (db-config tier), not env. A per-tenant flip is a DB write with no deploy — which is exactly what makes per-cohort rollback cheap. |
| `.claude/rules/05-nestjs-api.md` §Definition of Done | Every surviving route keeps `@Public()` or a permission decorator; the deny-by-default boot audit must still pass after controller edits. |
| `.claude/rules/06-python-services.md` §Pitfalls | The harness CI suite is hermetic. This ticket adds no harness tests; do not let a migration smoke test leak a live-Temporal dependency into `test-harness`. |

### 3.2 SOTA practice this plan follows, and why

- **Progressive rollout with a bounded blast radius per cohort.** Standard for a migration whose
  failure mode is clinical. Cohort size grows only after the previous cohort's monitoring window
  closes clean. The unit of rollback is one `PipelinePolicy` row.
- **Pre-declared, quantitative go/no-go thresholds.** Written *before* the data is looked at, so the
  decision is not fitted to the number that arrived. This is the whole point of Phase 1 Task 2.
- **Delete-with-a-ledger, not delete-and-hope.** Every removed file's tests are either deleted with
  it (and the coverage ledger at `cross-tenant-coverage.test.ts:266-287` updated in the same commit)
  or retargeted at the surviving path. Nothing is left orphaned.
- **Grep-gates as the permanence mechanism.** A deleted code path returns unless something asserts
  its absence. TASK-704 Task 6 established the pattern in this repo
  (`packages/applications/src/services/settings-registry/__tests__/consultation-gate-seed-parity.test.ts`
  reads source with `node:fs` rather than importing); Phase 4 extends it. `tests/contracts/*.contract.test.ts`
  is the repo's other source-scanning precedent.
- **Expand/contract on the flag, not big-bang.** The flag's readers shrink to zero *before* the flag
  itself is considered for removal — and this ticket deliberately **keeps** the `harnessEnabled` seam
  read (§4 Phase 4), because `design.md` §Error handling still needs a fallback edge during the
  migration period and because removing a settings-registry descriptor is a separate, wider change.

### 3.3 Pitfalls specific to THIS ticket

1. **`PreSummaryProcessor` is the fifth processor and is not in the design's deprecation list.** Do
   not delete it by pattern-matching on "processors in the jobs folder." §2.6.
2. **Deleting the processors breaks a coverage gate, not just their own tests.**
   `cross-tenant-coverage.test.ts:266-287` hard-codes their test file paths. Update it in the same
   commit or CI fails for a reason that looks unrelated.
3. **`jobs/index.ts:4` re-exports the processors** — they are public API of `@arcaai/applications`.
   Removing the files without removing the barrel line produces a build error, and removing both is
   a package-surface change worth naming in the commit message.
4. **`harness-internal.service.module.ts:31` imports `ConsultationJobServiceModule`.** The module
   survives the deletion; only its legacy providers and queue registrations go. Deleting the module
   breaks the harness.
5. **The seed test asserts `harnessEnabled === false`** (`seed.test.ts:2961,2989`). Flipping the
   SYSTEM default without editing that test produces a red suite that looks like a regression.
6. **TASK-714's floor must be deleted, not absorbed.** TASK-714 §3 and its Acceptance Criteria state
   the floor is throwaway, kept deliberately un-shared so *"the deletion diff is contained and
   obviously safe to review."* If the executing agent finds the floor has grown a shared abstraction
   the harness now depends on, that is a finding to report, not a reason to keep it.
7. **`generateSummaryAsync` is named in a static scope registry**
   (`api-key-scope-audit.ts:45`). The route survives; do not rename the method.
8. **Do not flip the default and delete in one commit.** The default flip must be revertible by
   itself for the whole monitoring window. Deletion is what makes it irreversible, and it comes last.
9. **A migrated tenant with a stale per-consultation override still runs legacy.**
   `consultation-event.handler.ts:501` merges `metadata.pipelineConfig.harnessEnabled` over the
   cascade with highest priority. Phase 2 must sweep for consultations carrying that override
   before declaring a cohort migrated.

---

## 4. Implementation Plan

> **Phase ordering is a safety property, not a preference.** Phase 2 does not start until Phase 1's
> gate is signed. Phase 3 does not start until every cohort in Phase 2 has closed its monitoring
> window clean. Phase 4 runs last and is what makes Phase 3 stick.

---

### Phase 1 — Migration readiness (HUMAN-GATED; may conclude "do not migrate")

#### Task 1 — Assemble the readiness checklist from TASK-730's outputs
- **Agent:** T3 · sonnet-5 · medium
- **Files:** create `docs/implementation/TASK-732-Legacy-Migration-Deletion/readiness-checklist.md`
- **Approach:** One table, one row per precondition, each with **verified / not verified** and the
  artifact that proves it. Rows, and where each is proven:

  | # | Precondition | Proof artifact | Source ticket |
  |---|---|---|---|
  | 1 | Temporal hosting decision made and signed | `TASK-730/temporal-hosting-decision.md` with a sign-off date | TASK-730 Task 1 |
  | 2 | `harness` + `harness-worker` Deployments exist in `arca/hope-v2-deployment` | linked PR/commit in TASK-730 §7 | TASK-730 Task 2 |
  | 3 | A real staging namespace exists and `promote-staging` has succeeded end-to-end | CI job log in TASK-730 §7 | TASK-730 Task 3 |
  | 4 | Availability measurement produced (5xx rate, latency percentiles, duplicate `harness-doc-{id}` count) | TASK-730 §7 report | TASK-730 Task 4 |
  | 5 | Temporal backlog + worker-health dashboards and alert rules exist | `infrastructure/grafana/dashboards/harness-temporal.json` + rules | TASK-730 Task 5 |
  | 6 | Temporal DR/backup runbook exists | `docs/operations/temporal/README.md` | TASK-730 Task 6 |
  | 7 | `harness-eval-gate` is blocking (no `allow_failure: true`) and produces real PASS/FAIL | pipeline log; `.gitlab/ci/test.yml` diff | TASK-713 Task 3 |
  | 8 | TASK-704's seam exists and `harnessEnabled` has exactly one runtime reader | the grep-gate test passes | TASK-704 Task 6 |
  | 9 | TASK-709 (`note-occ`) has landed | assessment §5: migrating before OCC *"would increase clinician-edit loss"* — a **hard sequencing constraint** | TASK-709 |
  | 10 | The consultation palette exists and its platform default definition is seeded | TASK-731 acceptance criteria | TASK-731 |

  Row 9 is quoted from `04-target-architecture.md` §"What would have to be true for me to be
  wrong": the harness's second-execution draft re-adoption is the mechanism, and migrating before
  the OCC fix lands makes it fire more often. Do not soften it.
  Any row that is **not verified** blocks Phase 2. Record which, and who owns closing it.
- **Verify:** the checklist file exists with an explicit verdict per row and a named owner for every
  unmet row. No commands (documentation task); `pnpm lint:all` unaffected.

#### Task 2 — Define both sides of the inversion condition, in writing, before looking at the data
- **Agent:** T4 · opus-5 · xhigh
- **Files:** create `docs/implementation/TASK-732-Legacy-Migration-Deletion/go-no-go-thresholds.md`
- **Approach:** The assessment names the inversion condition and defines neither rate. Define both,
  as computable quantities over a named window, **and commit the thresholds before reading TASK-730's
  numbers.** Required content:

  1. **Missing-note rate (harness side).** Proposed definition — the executing agent must confirm each
     input exists before adopting it:
     *numerator* = consultations that reached capture-stop (post-TASK-711 this is the
     `RECORDING → DRAINING` transition; pre-TASK-711, `stopRecording`) and had **no** `RAW_SUMMARY`
     `ContextItem` persisted within a stated SLA (propose 15 minutes, justify);
     *denominator* = all consultations that reached capture-stop in the window.
     Sub-counters that must be reported separately because they have different causes and different
     fixes: (a) Temporal unreachable at start; (b) workflow started but never completed;
     (c) the `harnessGatewayService?.start` silent-drop (should be **zero** after TASK-704 — a
     non-zero count means TASK-704 regressed);
     (d) SMR/model failure inside the workflow (a *shared* failure mode, present on both generators —
     it must be excluded from the comparison or it double-counts).
     Data sources: the `Consultation` + `ContextItem` tables, the Temporal list-executions query
     TASK-730 Task 4 already builds, and the `http_*` Prometheus series
     (`infrastructure/docker/configs/prometheus/prometheus.yml:114-124` — verify the scrape still
     exists at execution time).
  2. **Unverified-note harm rate (legacy side).** The honest problem: "harm" is not directly
     measurable from telemetry, so the definition must be an explicitly-labelled **proxy**, and the
     document must say so. Proposed proxy, strongest first:
     - **Primary (available only if TASK-714 landed):** the fraction of legacy-generated notes whose
       floor checks flag — `SummaryMeta.gateDecision === 'FLAG'` from TASK-714's dosage-parity check,
       plus a non-`grounded` groundedness verdict. TASK-714 §2 confirms both land in `SummaryMeta`
       and that legacy writes no `SummaryMeta` at all before it.
     - **Secondary:** count of `SIGNED_BEFORE_ASSURANCE` WORM annotations (`summary.service.ts:959`)
       over signed legacy notes in the window.
     - **Strongest, most expensive:** run TASK-713's judge over a random sample of already-signed
       legacy notes offline (`apps/harness/src/harness/eval/`) and report the fraction below the
       `EvalConfig` thresholds TASK-713 Task 3 fixes. This is the only measure that is about note
       *quality* rather than about missing metadata, and it is the one a clinician reviewer will ask
       for. Recommend it; state its cost.
  3. **The comparison rule.** These two rates are **not** in the same units and the document must
     refuse to pretend otherwise. State the decision rule as a *dominance* test with a stated
     exchange assumption, e.g.: *"proceed if the missing-note rate is below X% AND the legacy
     flag/below-threshold rate is above Y%; if the missing-note rate is above X%, do not migrate
     regardless of Y; if both are inside the band, the decision is a human clinical-risk judgement,
     not an arithmetic one."* Propose X and Y with reasoning; they are the human's to accept or
     change.
  4. **Inconclusive is a legal outcome.** TASK-730's own acceptance criteria allow *"inconclusive,
     re-measure after N more weeks."* Define N and the re-measurement trigger.
  5. **The inversion path.** If the rule says invert: this ticket stops, records the finding, and
     raises a change against `design.md` D1 and `04-target-architecture.md` §Recommendation. Name
     the artifact that change lands in.
- **Verify:** the document states both formulas with named data sources, the thresholds, the
  comparison rule, the inconclusive branch, and the inversion path — and a reviewer can compute both
  rates from it without asking a question. Reviewed by a second T4 agent before Task 3.

#### Task 3 — [HUMAN-GATED] Apply the thresholds and record the go/no-go
- **Agent:** T3 · opus-4-8 · high (analysis) — **the decision itself is the user's**
- **Files:** append the verdict section to `go-no-go-thresholds.md`
- **Approach:** Compute both rates over the agreed window using Task 2's definitions and TASK-730's
  report. Present: the two numbers, the sub-counters, the threshold comparison, and a
  recommendation. **Do not proceed to Phase 2 on the agent's own recommendation.** Record the
  human's decision, the decider, and the date.
  If any Task 1 checklist row is unmet, the verdict is automatically NO-GO regardless of the
  numbers — say which row.
- **Verify:** a dated, signed verdict exists in the document. Phase 2 is unblocked only by a GO.

---

### Phase 2 — Tenant migration (cohorted, per-cohort rollback)

#### Task 4 — Write the tenant migration runbook
- **Agent:** T3 · sonnet-5 · high
- **Files:** create `docs/operations/consultation/harness-migration-runbook.md`
- **Approach:** Model the structure on `docs/operations/vault/README.md` (the repo's established
  runbook shape — architecture / preconditions / privileged commands / daily ops / rollback), which
  TASK-730 Task 6 also uses as its template. Required content:

  - **The flip mechanism.** One `PipelinePolicy` row write at tenant scope, through the existing
    admin surface (`apps/api/src/modules/pipeline-policy-admin/`) — **not** a seed edit and **not**
    raw SQL. Deployed rows do not re-seed (§3.1). The write goes through
    `pipeline-policy.service.ts` so its existing sys-event/audit path fires.
  - **The pre-flip sweep.** Per §3.3 pitfall 9, list consultations in the tenant carrying
    `metadata.pipelineConfig.harnessEnabled === false` (the per-consultation override read at
    `consultation-event.handler.ts:501`) — those bypass the tenant flip. Decide per tenant whether to
    clear them; a stale override is the most likely reason a "migrated" tenant still produces legacy
    drafts.
  - **Cohorts.** Define them by risk, smallest first, and state the composition rule rather than a
    fixed list (tenant ids drift): cohort 0 = internal/demo tenants (`seed/14-pipeline-policy.ts:64`
    is the demo override — already `true`, so cohort 0 is a *verification* cohort, not a flip);
    cohort 1 = lowest-volume real tenants; cohort N = the rest. State the rule for promoting a
    cohort.
  - **The monitoring window.** Propose a duration and the exact signals watched, all of which exist
    by execution time: the missing-note rate from Phase 1 Task 2 recomputed per cohort; harness 5xx;
    Temporal workflow backlog (TASK-730 Task 5's dashboard); duplicate `harness-doc-{id}` executions;
    and `SIGNED_BEFORE_ASSURANCE` annotation count (which should trend to zero as tenants leave the
    legacy path).
  - **Rollback.** One row write back to `harnessEnabled: false` for the cohort's tenants. State the
    decision criteria that trigger it, who may pull it, and that it needs no deploy. **Rollback stays
    available until Phase 3 deletes the branch** — say that explicitly, because it is the reason
    Phase 3 comes last.
  - **The SYSTEM default flip.** Last step of Phase 2, after every cohort is clean: flip
    `SYSTEM_PIPELINE_POLICY_DEFAULTS.harnessEnabled` to `true` in `seed/14-pipeline-policy.ts:56`,
    update the assertions at `packages/database/src/__tests__/seed.test.ts:2961,2989` in the same
    commit, and ship a data migration for deployed SYSTEM rows (which do not re-seed) following
    `.claude/rules/02-database-prisma.md` §"Authoring a migration" and TASK-702 Task 4's
    idempotent-migration precedent.
- **Verify:** runbook reviewed against the vault README's section structure; every command it names
  exists (`pnpm db:migrate:create`, the admin route, the dashboards). Documentation-only task.

#### Task 5 — Migration smoke test: a migrated tenant produces an assured draft on every entry point
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `apps/api/tests/e2e/task-732-post-migration.spec.ts`
- **Approach:** Extend, do not duplicate, TASK-704's `task-704-generator-seam.spec.ts` (find it
  first; if TASK-704 shipped a different filename, imitate whatever landed). Against a
  harness-enabled seeded tenant, assert for each entry point that still routes to a harness path:
  the produced draft has a `SummaryMeta` row with `assuranceCompletedAt` set and a non-null
  `gateDecision`. For the entry points resolved as "no harness equivalent" by §2.6, assert the
  seam's **structured refusal or documented fallback** (whatever TASK-704 Task 5 shipped) rather
  than asserting a harness draft that cannot exist.
- **Verify:** `pnpm test:up:api` (terminal 1) then `pnpm test:e2e -- task-732-post-migration`. Paste
  output.

#### Task 6 — Execute the cohort migration
- **Agent:** T3 · sonnet-5 · medium (operator-assisted; each cohort promotion is a human decision)
- **Files:** none in the repo (DB writes via the admin surface); append a per-cohort log to §7
- **Approach:** Follow Task 4's runbook. One cohort at a time. For each: pre-flip sweep → flip →
  monitoring window → recorded verdict (clean / rollback). Do not begin the next cohort before the
  previous one's verdict is written down.
- **Verify:** §7 carries one dated entry per cohort with the monitored signal values, not a
  narrative. The final entry is the SYSTEM-default flip, with the seed test and migration diff
  linked.

---

### Phase 3 — Deletion

> Every task in this phase follows the same three-beat structure: **(1) name and run the suites that
> must remain green, (2) delete, (3) re-run and paste both outputs.** A deletion whose verification is
> "the build still compiles" is not verified.

#### Task 7 — Re-derive the deletion set against the post-TASK-704, post-TASK-714 tree
- **Agent:** T3 · sonnet-5 · high
- **Files:** create `docs/implementation/TASK-732-Legacy-Migration-Deletion/deletion-manifest.md`
- **Approach:** §2 above is the tree **before** TASK-704 and TASK-714 land. Re-derive every path,
  line number and reference in §2.1–§2.5 against the actual tree, and produce one manifest table:
  `path → action (delete / edit / keep) → reason → tests that must still pass after`.
  Specifically re-confirm: where TASK-704's seam put the legacy branch; where TASK-714 put the floor
  (its Task 1 explicitly allowed it to land either in the seam or directly in `summary.processor.ts`,
  and its §7 records which); whether TASK-714 introduced any shared helper (§3.3 pitfall 6 — if so,
  report it, do not silently keep it).
  Also settle §2.6 here in draft form so Task 8 has an answer to implement.
- **Verify:** the manifest accounts for every file named in §2.1–§2.5 and every `JobQueue` member in
  §2.9, with no "TBD" rows. Reviewed before any deletion.

#### Task 8 — [HUMAN-GATED] Decide the fate of pre-summary and comprehensive summary
- **Agent:** T4 · opus-4-8 · high (analysis) — **the product call is the user's**
- **Files:** append the decision to `deletion-manifest.md`
- **Approach:** Present §2.6's options (a)/(b)/(c) with their consequences, the four SDK/console
  consumers from §2.7, and the recommendation (b for pre-summary; a-or-b for comprehensive summary).
  Record the decision, decider and date. **This gates Task 11.**
- **Verify:** a dated decision exists; Task 11's scope is derived from it, not assumed.

#### Task 9 — Delete the legacy summary + NER generators
- **Agent:** T3 · sonnet-5 · high
- **Files:**
  - delete `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts`
  - delete `packages/applications/src/services/consultation/jobs/processors/ner.processor.ts`
  - delete their test files (§2.8, first group — the `summary.processor*` and `ner.processor*` entries)
  - modify `packages/applications/src/services/consultation/jobs/processors/index.ts` (drop `:1`, `:3`)
  - modify `packages/applications/src/services/consultation/jobs/consultation-job.service.module.ts`
    (drop the imports at `:10,12`, the providers at `:54,56`, the `registerQueue` entries at `:42,44`,
    and the now-stale comments at `:35,37`)
  - modify `packages/applications/src/services/consultation/jobs/consultation-job.service.ts`
    (remove `createSummaryJob` `:31,161` and `createNerJob` and their queue injections)
  - modify `packages/applications/src/__tests__/cross-tenant-coverage.test.ts:266-287`
    (`PROCESSOR_COVERAGE` — remove the rows for the deleted test files, in the SAME commit)
  - modify `packages/domains/src/enums/JobQueue.enum.ts` (remove `GenerateSummary` `:17`,
    `ExtractNamedEntities` `:19` — **only after** confirming zero remaining references, including
    Redis queue names in any running environment; a queue with in-flight jobs must be drained first,
    which is a runbook step in Task 4, not a code step)
  - modify `packages/applications/src/services/consultation/events/consultation-event.handler.ts`
    (delete the FALSE branches of fork 1 `:146` and fork 2 `:322` — after TASK-704 these live in the
    seam; re-derive per Task 7)
- **Approach:** Run the surviving suites first and record green. Then delete in the order above
  (leaf files → barrels → module wiring → enum), running `pnpm --filter @arcaai/applications build`
  after each step so a missed reference surfaces immediately rather than at the end. Do **not** touch
  `PromptAssemblyService`, `PromptResolutionService` or `smr-generate` (§2.5).
- **Verify:** `pnpm --filter @arcaai/applications build` and `pnpm --filter @arcaai/applications test`
  green; `pnpm api:build`; `pnpm test:unit`; `pnpm lint`. **Tests that must still pass after removal:**
  `consultation-job.service.test.ts`, `job-queue.integration.test.ts`,
  `consultation-event.handler.test.ts`, `consultation.events.test.ts`, `cross-tenant-coverage.test.ts`,
  and the whole `harness/` suite. Paste before-and-after output.

#### Task 10 — Delete the TASK-714 legacy safety floor
- **Agent:** T2 · sonnet-5 · medium
- **Files:** per Task 7's manifest — TASK-714's insertion points were
  `summary.processor.ts` (deleted by Task 9) plus
  `packages/applications/src/services/consultation/jobs/processors/legacy-dosage-check.util.ts`
  (TASK-714 Task 4) and its tests
- **Approach:** TASK-714 §1 states the floor is *"throwaway, sized to the exposure window, and deleted
  by the same epic that retires legacy"* and §3 required it be kept unshared so this diff is
  contained. Delete the floor and its dosage-check utility and tests. **Do not delete the
  `signedBeforeAssurance` guard itself** (`summary.service.ts:867,959`) — it is the harness path's
  guard too and becomes non-vacuous for every tenant once migration completes.
- **Verify:** `pnpm --filter @arcaai/applications test` green; a test asserts a harness-generated
  note still produces a `SummaryMeta` with `assuranceCompletedAt` and still triggers the
  `SIGNED_BEFORE_ASSURANCE` annotation when appropriate. Paste output.

#### Task 11 — Apply Task 8's decision to pre-summary and comprehensive summary
- **Agent:** T3 · sonnet-5 · high
- **Files:** determined by Task 8. If (a) delete: `comprehensive-summary.processor.ts`,
  `pre-summary.processor.ts`, their tests, the `GeneratePreSummary`/`GenerateComprehensiveSummary`
  `JobQueue` members and registrations, `createComprehensiveSummaryJob`
  (`consultation-job.service.ts:41,224`), the controller routes
  (`consultation.controller.ts:1175-1200`, `:1217-1230`, `:1250-`), and the four SDK/console consumers
  in §2.7. If (b) keep: no deletions — instead add the labelling and tests below.
- **Approach:** **Option (b) is not "do nothing."** If kept, these generators must be made
  *structurally* non-signable rather than incidentally so: add a test asserting that no artifact they
  produce can reach `approveSummary`'s `isFinalSummary` predicate, and a comment at each processor's
  class declaration naming this ticket's decision and the reason. Update
  `design.md` §Deprecations if the scope of "legacy deleted" changed — a design doc that no longer
  matches the code is the failure mode this whole program exists to fix.
  If (a), delete SDK/console consumers in the same change; `packages/agentic-sdk-v2` is versioned in
  lockstep with the SDK family (rule `08-vox-sdk.md`) so a surface removal is a coordinated release,
  not a quiet edit — flag it.
- **Verify:** `pnpm --filter @arcaai/applications build test`, `pnpm api:build`, `pnpm sdk:build`
  (if the SDK changed), `pnpm admin:build` (if the console changed), `pnpm test:unit`,
  `pnpm test:e2e`. Paste output.

#### Task 12 — Clean the dead configuration and UI labels
- **Agent:** T2 · sonnet-5 · low
- **Files:**
  - `apps/admin-console/src/features/pipeline-policy/components/cascade.ts:29,42,53`
  - `packages/applications/src/services/settings-registry/descriptors/pipeline.descriptors.ts:41`
  - `packages/applications/src/services/config-resolver/config-resolver.service.ts:80`
- **Approach:** The `'harness' | 'legacy'` label at `cascade.ts:53` is misleading once legacy does
  not exist. **Minimum change:** relabel so the off-state names what it actually now means (per
  `design.md` §Error handling, the remaining off-state edge is the platform-default/queued-failure
  path, not "legacy generator"). **Do not remove `harnessEnabled` itself** — §4 Phase 4 keeps the
  seam read; removing a settings-registry descriptor changes the governed-key surface and belongs to
  the Studio consolidation (TASK-719), not here. Flip `codeDefault` at
  `config-resolver.service.ts:80` to `true` to match the SYSTEM row flipped in Phase 2, and update
  `config-resolver.service.test.ts` in the same commit.
- **Verify:** `pnpm --filter @arcaai/applications test -- config-resolver`,
  `pnpm admin:test`, `pnpm admin:lint`, `pnpm --filter @arcaai/applications test -- settings-registry`.
  Paste output.

---

### Phase 4 — Post-deletion assertions

#### Task 13 — Grep-gate: no legacy generator remains
- **Agent:** T1 · haiku-4-5 · default
- **Files:** create
  `packages/applications/src/services/consultation/__tests__/legacy-generator-absent.grep-gate.test.ts`
- **Approach:** Follow TASK-704 Task 6's pattern exactly — read source with `node:fs`, do not import
  (the precedent it names is
  `packages/applications/src/services/settings-registry/__tests__/consultation-gate-seed-parity.test.ts`).
  Assert, over `packages/applications/src` and `apps/api/src` excluding `__tests__/**`:
  1. zero files named `summary.processor.ts` or `ner.processor.ts` under `consultation/jobs/processors/`;
  2. zero occurrences of the identifiers `SummaryProcessor`, `NerProcessor`, `createSummaryJob`,
     `createNerJob`;
  3. zero `JobQueue.GenerateSummary` / `JobQueue.ExtractNamedEntities` references;
  4. **the seam has exactly one `harnessEnabled` reader and that reader has exactly one branch** —
     i.e. TASK-704's single-reader gate still passes AND no `else` legacy dispatch remains in
     `note-generation.service.ts` (assert by absence of any `createSummaryJob`-shaped call in that
     file, per the manifest);
  5. zero references to TASK-714's floor utility.
  Each assertion carries a message naming this ticket, so a future reintroduction fails with an
  explanation rather than a bare diff.
- **Verify:** `pnpm --filter @arcaai/applications test -- legacy-generator-absent`. Then **deliberately
  re-add one deleted identifier in a scratch file, confirm the gate FAILS, and revert** — paste both
  outputs. Rule `01-development-workflow.md` §TDD: *"If the test never failed, it verifies nothing."*

#### Task 14 — Contract test: every note-generation path produces an assured draft
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `tests/contracts/note-generation-assurance.contract.test.ts`
- **Approach:** Follow the shape of the existing source-scanning contract tests in
  `tests/contracts/` (`services-manifest.contract.test.ts`, `npm-publish-policy.contract.test.ts` are
  the closest structural exemplars — read one before writing). Assert statically that every surviving
  code path which creates a `RAW_SUMMARY`-class `ContextItem` also writes a `SummaryMeta`. This is
  the permanent form of the property TASK-714 bought temporarily: *"no code path creates a
  `RAW_SUMMARY` without a `SummaryMeta`"* (TASK-714 Acceptance Criteria) — after this ticket it holds
  because there is only one generator, and this test is what keeps it holding.
- **Verify:** `pnpm test:unit -- note-generation-assurance`. Paste output.

#### Task 15 — Update the design and assessment docs to match the shipped end-state
- **Agent:** T1 · haiku-4-5 · default
- **Files:** `docs/architecture/agentic-workflow-platform/design.md` (§Deprecations, D1 row, Roadmap
  Wave 4), `docs/architecture/agentic-workflow-platform/backlog.md` (Wave 4 row status)
- **Approach:** Record what actually shipped, including any scope change from Task 8's decision. If
  Phase 1 concluded NO-GO or INVERT, that is what gets recorded instead — with D1's decision row
  amended and the reason. Do not edit `.claude/rules/*.md` (repo-wide config; propose a diff if one
  is needed, per TASK-713 Task 5's precedent).
- **Verify:** the design doc's §Deprecations list contains nothing that still exists in the tree —
  cross-check each entry with a grep. Paste the greps.

#### Task 16 — Full verification pass
- **Agent:** T2 · sonnet-5 · low
- **Files:** none
- **Approach:** Run every gate touched by this ticket end-to-end on a clean checkout.
- **Verify:** `pnpm --filter @arcaai/applications build`, `pnpm --filter @arcaai/applications test`,
  `pnpm --filter @arcaai/domains build test`, `pnpm --filter @arcaai/database test`, `pnpm api:build`,
  `pnpm test:unit`, `pnpm test:integration`, `pnpm test:up:api` + `pnpm test:e2e`, `pnpm lint`,
  `pnpm typecheck`, `pnpm harness:test` (must be unaffected — proves nothing leaked into the harness).
  Paste all output.

---

## 5. Acceptance Criteria

**Phase 1 (always required, even on a NO-GO outcome):**
- [ ] `readiness-checklist.md` exists with a verdict and an owner per row (Task 1)
- [ ] `go-no-go-thresholds.md` defines the missing-note rate and the unverified-note harm proxy as
      computable quantities with named data sources, states X/Y thresholds, the comparison rule, the
      inconclusive branch, and the inversion path — **written before the numbers were read** (Task 2)
- [ ] **HUMAN-GATED:** a dated, signed GO / NO-GO / INVERT verdict is recorded, with the decider named
- [ ] If the verdict is NO-GO or INVERT: Phases 2–4 are **not** executed, and Task 15 records the
      design-level consequence against D1. This is a complete, successful execution of the ticket.

**Phases 2–4 (only on a GO):**
- [ ] `docs/operations/consultation/harness-migration-runbook.md` exists, structured like the vault
      runbook, and every command it names exists in root `package.json` or the admin API
- [ ] Every cohort has a dated §7 entry with monitored signal values and a clean/rollback verdict
- [ ] The pre-flip override sweep ran per cohort (stale `metadata.pipelineConfig.harnessEnabled`)
- [ ] `SYSTEM_PIPELINE_POLICY_DEFAULTS.harnessEnabled` is `true` in `seed/14-pipeline-policy.ts`,
      `seed.test.ts:2961,2989` updated in the same commit, and an idempotent data migration ships for
      deployed SYSTEM rows
- [ ] `config-resolver.service.ts:80` `codeDefault` matches the seed
- [ ] `deletion-manifest.md` accounts for every file in §2.1–§2.5 and every `JobQueue` member in §2.9
      with no TBD rows
- [ ] **HUMAN-GATED:** the pre-summary / comprehensive-summary decision (Task 8) is recorded and dated
- [ ] `summary.processor.ts` and `ner.processor.ts` are deleted, with their barrel lines, module
      providers, queue registrations, `JobQueue` members and job-service methods
- [ ] `cross-tenant-coverage.test.ts`'s `PROCESSOR_COVERAGE` table was updated in the same commit as
      the test-file deletions
- [ ] TASK-714's floor and its dosage-check utility are deleted; `signedBeforeAssurance` survives
- [ ] `PromptAssemblyService`, `PromptResolutionService` and `smr-generate` are **untouched**
      (verified by diff review, not assertion)
- [ ] The grep-gate exists and **has been seen to fail** on a deliberate reintroduction (paste RED + GREEN)
- [ ] `tests/contracts/note-generation-assurance.contract.test.ts` passes
- [ ] `design.md` §Deprecations contains nothing that still exists in the tree (paste the greps)
- [ ] **Layer gates, with pasted output:** `pnpm --filter @arcaai/applications build test`,
      `pnpm --filter @arcaai/domains build test`, `pnpm --filter @arcaai/database test`,
      `pnpm api:build`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm lint`,
      `pnpm typecheck`, `pnpm harness:test`
- [ ] **Evidence rule:** paste actual command output for every gate above before claiming done. No
      deletion is "verified" by the build compiling.

---

## 6. Risks & Open Questions

| # | Risk / question | Handling |
|---|---|---|
| R-1 | **HUMAN-GATED — the go/no-go itself.** The measurement could say invert, making permanent-legacy the correct end state and this ticket's Phases 2–4 wrong. | Phase 1 is separable and produces value either way. The thresholds are written before the data is read (Task 2) precisely so the decision cannot be fitted to the number. |
| R-2 | **HUMAN-GATED — pre-summary / comprehensive summary (Task 8).** Three of the seven entry points have no harness equivalent (§2.6). Deleting them removes product capability; keeping them means "legacy deleted" is scoped to the *signable* generator. | Decided in writing before Task 11, with the four SDK/console consumers on the table. The design doc is updated to match whatever is decided (Task 15). |
| R-3 | **`PreSummaryProcessor` is not in `design.md` §Deprecations** and was not named by the assessment. A pattern-matching deletion would remove it silently. | Called out in §2.3, §3.3 pitfall 1, and forced into Task 8's decision. |
| R-4 | **TASK-704 and TASK-714 may have landed differently than their tickets planned.** All of §2's deletion targets are pre-seam. | Task 7 re-derives the whole manifest against the real tree before anything is deleted. No deletion task runs on §2's line numbers directly. |
| R-5 | **In-flight BullMQ jobs at the moment of queue removal.** Removing a `JobQueue` member while jobs sit in Redis orphans them silently. | A drain step in Task 4's runbook, executed before Task 9's enum edit. Task 9 explicitly defers the enum change until the drain is confirmed. |
| R-6 | **Rollback disappears at Phase 3.** Once the legacy branch is deleted, a bad migration cannot be rolled back by a row write — only by a revert-and-deploy. | This is why Phase 3 runs only after every cohort's window closed clean, and why §3.3 pitfall 8 forbids combining the default flip and the deletion in one commit. |
| R-7 | **The harm-rate proxy is a proxy.** None of the three measures in Task 2 is "clinical harm"; the strongest (judge-scored sample) measures note quality, not outcomes. | Task 2 is required to label it as a proxy and to state what it does not measure. A clinical reviewer, not this ticket, judges whether the proxy is adequate. |
| R-8 | **CDN weak-ETag rewriting could have silently defeated TASK-709** (`04-target-architecture.md` Risks §5), which readiness row 9 depends on. | Readiness row 9 is satisfied only by TASK-709's own on-the-wire verification in a deployed environment, not by its local tests. State that in the checklist. |
| R-9 | **Deployed `PromptTemplate`-style drift applies to `PipelinePolicy` too** — a tenant may carry a row that the seed never wrote. | Phase 2 flips by explicit row write per tenant, never by seed; the SYSTEM default flip ships a data migration (Task 4). |
| R-10 | **Open question: does `ConsultationLoopWorkflow` still start `HarnessDocWorkflow` anywhere?** `04-target-architecture.md` names it as one of two start sites for `harness-doc-{consultationId}`. If the loop is live (TASK-705's finding), duplicate executions continue after migration. | Not this ticket's to fix, but its rate is one of Phase 2's monitored signals (duplicate-execution count). If it is non-zero, report it against TASK-705/TASK-709 rather than absorbing it here. |

---

## 7. Implementation Summary

_(Empty at authoring — filled during execution.)_

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Claude (Wave-4 ticket-authoring agent) |
