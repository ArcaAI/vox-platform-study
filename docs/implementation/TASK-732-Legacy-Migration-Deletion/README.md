# TASK-732 — Tenant Migration off Legacy + Legacy Generator Deletion

| | |
|---|---|
| **Status** | Review — Phases 1–4 executed. Phase 1 Task 3's verdict is a HUMAN-GATED **GO**, rendered by the owner as a pre-production call (NOT the data-driven R-1 verdict — 5/10 readiness rows were still unmet and no real traffic exists; recorded as such in `go-no-go-thresholds.md` §7). Phase 2 executed as a pre-production configuration change (no real tenant cohorts existed to migrate — SYSTEM default flip only, shadow-DB-proven data migration authored). Phase 3 deletion executed within the owner's R-2 boundary (signable generator only — `summary.processor.ts`/`ner.processor.ts`/TASK-714's floor deleted; pre-summary/comprehensive-summary/sync-summary kept). Phase 4 assertions (grep-gate incl. RED/GREEN proof, contract test, doc sync) landed. Full verification: `pnpm test:unit` 1052 files/17720 tests green, `typecheck` 43/43, `lint` 38/38 (0 errors), `harness:test` 1339 passed (unaffected). `pnpm test:integration`/`test:e2e` not run — gated on infra-reset consent the orchestrating session holds (isolated test DB has no schema loaded this pass; unrelated to this ticket's changes). Task 8 (pre-summary/comprehensive-summary/sync-summary fate) recorded as owner decision (b) for all three, WITH a correction found during verification: `ComprehensiveSummaryProcessor`'s output is NOT actually structurally non-signable — an open finding, not resolved this pass. See §7. |
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
- [x] `readiness-checklist.md` exists with a verdict and an owner per row (Task 1)
- [x] `go-no-go-thresholds.md` defines the missing-note rate and the unverified-note harm proxy as
      computable quantities with named data sources, states X/Y thresholds, the comparison rule, the
      inconclusive branch, and the inversion path — **written before the numbers were read** (Task 2)
- [x] **HUMAN-GATED:** a dated, signed GO / NO-GO / INVERT verdict is recorded, with the decider named
      (GO — pre-production, owner, 2026-08-16 — `go-no-go-thresholds.md` §7)
- [ ] If the verdict is NO-GO or INVERT: N/A — verdict was GO.

**Phases 2–4 (executed on the GO):**
- [x] `docs/operations/consultation/harness-migration-runbook.md` exists, structured like the vault
      runbook, and every command it names exists in root `package.json` or the admin API
- [ ] Every cohort has a dated §7 entry with monitored signal values and a clean/rollback verdict —
      **N/A this pass**: no real tenant cohorts exist (pre-production execution, §7A)
- [ ] The pre-flip override sweep ran per cohort — **N/A this pass**, same reason; documented as a
      required runbook step for the real future migration
- [x] `SYSTEM_PIPELINE_POLICY_DEFAULTS.harnessEnabled` is `true` in `seed/14-pipeline-policy.ts`,
      `seed.test.ts` updated in the same change, and an idempotent data migration ships for
      deployed SYSTEM rows (authored + shadow-DB-proven; not applied to the local dev DB — deploy-time)
- [x] `config-resolver.service.ts` `codeDefault` matches the seed
- [x] `deletion-manifest.md` accounts for every file in §2.1–§2.5 and every `JobQueue` member in §2.9
      with no TBD rows
- [x] **HUMAN-GATED:** the pre-summary / comprehensive-summary decision (Task 8) is recorded and dated
      (option (b) for all three, owner, 2026-08-16 — with a correction found during verification, see §7A)
- [x] `summary.processor.ts` and `ner.processor.ts` are deleted, with their barrel lines, module
      providers, queue registrations, and job-service methods deleted. `JobQueue` members
      **deliberately kept** pending a real drain confirmation (R-5) — no real traffic exists to drain.
- [x] `cross-tenant-coverage.test.ts`'s `PROCESSOR_COVERAGE` table was updated in the same change as
      the test-file deletions
- [x] TASK-714's floor and its dosage-check utility are deleted; `signedBeforeAssurance` survives
- [x] `PromptAssemblyService`, `PromptResolutionService` and `smr-generate` are **untouched**
      (verified by diff review — `git diff --stat` on all three shows no changes)
- [x] The grep-gate exists and **has been seen to fail** on a deliberate reintroduction (RED + GREEN
      pasted in §7A)
- [x] `tests/contracts/note-generation-assurance.contract.test.ts` passes
- [x] `design.md` §Deprecations contains nothing that still exists in the tree (greps pasted in §7A)
- [x] **Layer gates, with pasted output (§7A):** `pnpm --filter @arcaai/applications build`,
      `pnpm --filter @arcaai/domains build`, `pnpm --filter @arcaai/database build test`,
      `pnpm api:build`, `pnpm test:unit`, `pnpm lint`, `pnpm typecheck`, `pnpm harness:test` — all
      green. `pnpm test:integration` / `pnpm test:e2e` **not run** — gated on infra-reset consent
      this session does not hold (isolated test DB has no schema loaded; unrelated to this ticket).
- [x] **Evidence rule:** actual command output pasted for every gate that ran (§7A). Gates not run
      are stated as not run, not fabricated.

---

## 6. Risks & Open Questions

| # | Risk / question | Handling | Answer |
|---|---|---|---|
| R-1 | **HUMAN-GATED — the go/no-go itself.** The measurement could say invert, making permanent-legacy the correct end state and this ticket's Phases 2–4 wrong. | Phase 1 is separable and produces value either way. The thresholds are written before the data is read (Task 2) precisely so the decision cannot be fitted to the number. | **Answer (2026-08-16/17 pass)**: The owner rendered **GO** — explicitly a pre-production call, NOT the data-driven verdict this row originally envisaged (readiness rows 1/3/4/7/10 were still unmet; no real traffic exists to clear the §4 sample floor). Recorded verbatim in `go-no-go-thresholds.md` §7, including the explicit statement that this overrides Task 1's "any unmet row blocks Phase 2" rule for THIS pre-production execution — the unmet rows remain open operational risk for a real production rollout, not retroactively satisfied. |
| R-2 | **HUMAN-GATED — pre-summary / comprehensive summary (Task 8).** Three of the seven entry points have no harness equivalent (§2.6). Deleting them removes product capability; keeping them means "legacy deleted" is scoped to the *signable* generator. | Decided in writing before Task 11, with the four SDK/console consumers on the table. The design doc is updated to match whatever is decided (Task 15). | **Answer (2026-08-16/17 pass)**: The owner rendered the boundary — **KEEP the v1-compat pre-summary and summary surfaces** (option (b) for all of pre-summary, comprehensive-summary, and sync `SummaryService.generateSummary`); "legacy deleted" scoped to the signable generator only. Recorded in `go-no-go-thresholds.md` §7 and `deletion-manifest.md` §5. **Correction found while implementing Task 11's "not structurally non-signable by accident" requirement**: the owner's framing (mirroring the ticket's own §2.6 draft) assumed all three are equally non-signable "the same way pre-summary is" — verified FALSE for two of the three. Sync `generateSummary`'s output IS (correctly) signable — it produces the actual clinical note. `ComprehensiveSummaryProcessor`'s output ALSO currently satisfies `approveSummary`'s `isFinalSummary` gate — an OPEN FINDING this pass locks with an accurate, non-endorsing regression test (`kept-generators-signability.task732.test.ts`) rather than asserting a false "cannot sign" claim. Only `PreSummaryProcessor` is confirmed structurally non-signable. This is a new, unresolved question for the product owner, not decided here. |
| R-3 | **`PreSummaryProcessor` is not in `design.md` §Deprecations** and was not named by the assessment. A pattern-matching deletion would remove it silently. | Called out in §2.3, §3.3 pitfall 1, and forced into Task 8's decision. | **Answer**: Resolved this pass — `deletion-manifest.md` §3 restates it explicitly, and every DELETE row in the manifest table is scoped to `summary.processor.ts`/`ner.processor.ts`/TASK-714's floor utility only; `pre-summary.processor.ts` and its barrel/module/queue entries are explicitly marked "survive pending Task 8" in every row that touches an adjacent file, so a future executor cannot pattern-match it away by editing a shared file. |
| R-4 | **TASK-704 and TASK-714 may have landed differently than their tickets planned.** All of §2's deletion targets are pre-seam. | Task 7 re-derives the whole manifest against the real tree before anything is deleted. No deletion task runs on §2's line numbers directly. | **Answer**: Resolved this pass — `deletion-manifest.md` re-derives every path/line number in §2.1–§2.5 against the live tree (commit `e2e54c1f2` and after) and found real drift (module import/provider/registerQueue line numbers all shifted because TASK-704 and TASK-714 both landed ahead of the summary/ner entries) plus two structural findings §2's line-number re-derivation alone would not have caught (§0.1/§0.2 of the manifest — a fourth permanently-legacy entry point, and a controller rewrite the original Task 9 file list omitted). |
| R-5 | **In-flight BullMQ jobs at the moment of queue removal.** Removing a `JobQueue` member while jobs sit in Redis orphans them silently. | A drain step in Task 4's runbook, executed before Task 9's enum edit. Task 9 explicitly defers the enum change until the drain is confirmed. | **Answer (2026-08-16/17 pass)**: Resolved in the prior pass (drain procedure documented in `deletion-manifest.md` §2) and HONORED in this pass's execution — Task 9 deleted `summary.processor.ts`/`ner.processor.ts` and every runtime READER of the two queues (registrations, injections, enqueue call sites), but deliberately did **NOT** touch `JobQueue.GenerateSummary`/`ExtractNamedEntities` in `packages/domains/src/enums/JobQueue.enum.ts` — those two enum members stay, now inert (zero readers left, confirmed by the Task 13 grep-gate), pending the drain-confirmation script (still not built — belongs with a real Phase 2 cohort migration against live traffic, which this pre-production pass has none of). |
| R-6 | **Rollback disappears at Phase 3.** Once the legacy branch is deleted, a bad migration cannot be rolled back by a row write — only by a revert-and-deploy. | This is why Phase 3 runs only after every cohort's window closed clean, and why §3.3 pitfall 8 forbids combining the default flip and the deletion in one commit. | **Answer (2026-08-16/17 pass)**: Affirmed and HONORED — the SYSTEM-default flip (seed + config-resolver codeDefault + its shadow-DB-proven data migration) and the Phase 3 deletion are separate, independently reviewable file-sets in this pass (both are part of one working-tree diff since this session does not commit, but the change is structured so a reviewer/committer can split them into two commits — flip first, deletion second — exactly as R-6 requires); the runbook (`docs/operations/consultation/harness-migration-runbook.md`) states this explicitly. |
| R-7 | **The harm-rate proxy is a proxy.** None of the three measures in Task 2 is "clinical harm"; the strongest (judge-scored sample) measures note quality, not outcomes. | Task 2 is required to label it as a proxy and to state what it does not measure. A clinical reviewer, not this ticket, judges whether the proxy is adequate. | **Answer**: Resolved this pass — `go-no-go-thresholds.md` §2 opens with an explicit "labeled a PROXY" heading and states, per measure, what it does NOT measure (primary: not patient-harm outcomes, and the groundedness half isn't even implemented — Vault-Transit-encrypted; secondary: a timing annotation, not a content judgment; strongest/recommended-not-built: note quality, not outcomes). No proxy is presented as harm itself anywhere in that document. |
| R-8 | **CDN weak-ETag rewriting could have silently defeated TASK-709** (`04-target-architecture.md` Risks §5), which readiness row 9 depends on. | Readiness row 9 is satisfied only by TASK-709's own on-the-wire verification in a deployed environment, not by its local tests. State that in the checklist. | **Answer**: Resolved this pass — `readiness-checklist.md` row 9 states exactly this: TASK-709's own Task 7 (on-the-wire weak-ETag check) is itself HUMAN-GATED and marked open in TASK-709's README, and row 9 is marked VERIFIED (code) / on-the-wire proof still open, not fully verified, explicitly per R-8's instruction. |
| R-9 | **Deployed `PromptTemplate`-style drift applies to `PipelinePolicy` too** — a tenant may carry a row that the seed never wrote. | Phase 2 flips by explicit row write per tenant, never by seed; the SYSTEM default flip ships a data migration (Task 4). | **Answer**: Best practice — affirm the design as-is, no change recommended. Phase 2/4's own plan (explicit per-tenant `PipelinePolicy` row write through the admin surface, never a seed edit; a real, reviewed data migration for the deployed SYSTEM row, following `02-database-prisma.md`'s shadow-DB workflow) is the correct, established pattern for this repo (same shape TASK-702's data migration used, per the ticket's own citation). Nothing found this pass changes that recommendation. |
| R-10 | **Open question: does `ConsultationLoopWorkflow` still start `HarnessDocWorkflow` anywhere?** `04-target-architecture.md` names it as one of two start sites for `harness-doc-{consultationId}`. If the loop is live (TASK-705's finding), duplicate executions continue after migration. | Not this ticket's to fix, but its rate is one of Phase 2's monitored signals (duplicate-execution count). If it is non-zero, report it against TASK-705/TASK-709 rather than absorbing it here. | **Answer**: Affirmed, not resolved (correctly out of scope) — `scripts/harness-availability-report.py` (TASK-730, re-run this pass) already computes exactly this duplicate-execution count and its docstring/output already state a duplicate is "not automatically a bug" and names both legitimate start sites. This pass did not investigate whether `ConsultationLoopWorkflow` is live (that is TASK-705's ticket, not this one) — deferring is the correct call, not a gap. |

---

## 7. Implementation Summary

**Scope of this pass: Phase 1 only, per explicit executing instructions** (readiness checklist,
go/no-go thresholds + instrumentation, and Task 7's deletion manifest as a document). **No code
was deleted, no `JobQueue` member was removed, no default was flipped, and no queue-touching edit
was made** — verified by `git status` at the end of this pass (only new files under
`docs/implementation/TASK-732-Legacy-Migration-Deletion/`, `packages/database/scripts/`, and
`packages/database/scripts/__tests__/`; nothing under `packages/applications/src` or
`packages/domains/src` changed).

**Task 1 — `readiness-checklist.md`.** All 10 preconditions re-verified against the live tree
(not assumed from either dependency ticket's own claimed status). Result: rows 1, 3, 4, 7, 10 are
**NOT VERIFIED**; rows 2, 5, 6, 9 are verified with a named open item (config/tooling exists, a
deployed-environment or live-traffic observation is what remains); row 8 is fully verified (the
TASK-704 grep-gate exists and the full `@arcaai/applications` suite — 492 files / 9153 tests —
passes, re-run this pass). Row 7 required correcting mid-pass: the live `.gitlab/ci/test.yml` was
observed changing under a parallel session actively working on TASK-713; the final, re-confirmed
read shows `allow_failure` removed (real) but the job still gated behind
`RUN_INFRA_TESTS != "true"` (also real, and not what a first pass's grep found) — documented as a
tree-stability caveat in the checklist itself.

**Task 2 — `go-no-go-thresholds.md`.** Both rates defined as computable formulas with named,
schema-verified data sources, written and committed BEFORE any query was run against real data
(the one run pasted in the document's own §5 returns an honest empty result and could not have
informed the formulas even if read first). Corrected one input from the ticket's own proposal:
the `RECORDING → DRAINING` transition (TASK-711) has **zero non-test runtime readers** today
(grep-confirmed; TASK-711's own README §7 states only its DB/domain layers landed, not the
application-service wiring that would produce the transition) — the missing-note-rate numerator
therefore uses the ticket's own documented fallback (`stopRecording`'s `AuditLog` timestamp)
instead. Harm-proxy primary/secondary formulas were verified computable against the real schema
(`SummaryMeta.gateDecision` and `HarnessAuditEvent.action` are both plaintext; the groundedness
half of the primary proxy is Vault-Transit ciphertext only and is explicitly NOT computed, stated
as a gap rather than silently narrowed). X=1%/Y=10% thresholds proposed with reasoning, explicitly
the human's to accept or change (R-1 stays HUMAN-GATED). A minimum-sample-size rule (≥200
capture-stop events) and a 4-week re-measurement cadence were added for the "inconclusive" branch,
which TASK-730's acceptance criteria require but did not define a number for.

**Instrumentation — `packages/database/scripts/harness-migration-readiness-report.ts`.** New,
TDD'd (`packages/database/scripts/__tests__/harness-migration-readiness-report.test.ts`, 11 tests
against an in-memory fake client, all passing before the script was ever run against real data),
built as the Postgres-side sibling of TASK-730's `harness-availability-report.py`. Computes the
missing-note rate (via `AuditLog` `stopRecording` events cross-referenced against `RAW_SUMMARY`
`ContextItem` timing) and both harm-proxy halves. Run against the live dev Postgres this pass
(`--since-days 365`): every denominator is 0 — the dev DB carries seed-created consultations only,
never a live `stopRecording`/sign/generate flow — matching TASK-730's own "genuinely no traffic
yet" finding for its script. `pnpm --filter @arcaai/database build` clean; `pnpm --filter
@arcaai/database test` — 52 files / 1255 tests passed (includes the new suite).

**Task 7 — `deletion-manifest.md`.** Re-derived every path/line number in the ticket's §2.1–§2.5
against the live tree and found real drift (module import/provider/queue-registration line numbers
all shifted, because TASK-704 and TASK-714 both landed ahead of the summary/ner entries in
`consultation-job.service.module.ts`) plus **two structural findings the line-number
re-derivation alone would not have caught**: (1) a fourth entry point — sync
`SummaryService.generateSummary` — was PERMANENTLY excluded from ever routing to harness by
TASK-704's own explicit decision (`summary.service.ts:453-500`), which the ticket's §2.6 (written
before TASK-704 landed) did not know about; (2) the async `generateSummaryAsync` route's
harness-routing decision lives inside `SummaryProcessor.process()`, not the controller — deleting
`summary.processor.ts` per the ticket's original Task 9 plan would silently break that route unless
`apps/api/src/modules/consultation/consultation.controller.ts` is ALSO rewritten, a file the
ticket's original Task 9 file list never named. R-3 (`PreSummaryProcessor`) is restated explicitly
in the manifest's own §3, with every DELETE row scoped away from it by name. R-5's BullMQ drain
step is documented in the manifest's §2 (freeze enqueues → confirm zero `getJobCounts()` → drain
naturally → re-check → only then edit the enum), ahead of Phase 2's full runbook, so Task 9 has a
concrete procedure rather than inventing one at deletion time.

**R-1 through R-10** — all ten answered in §6 above. R-1/R-2 stay HUMAN-GATED (a verdict was
deliberately not rendered; R-2's scope was corrected to four entry points, not three, but the
decision itself remains the product owner's). R-3/R-4/R-5/R-7/R-8 are resolved by the artifacts
this pass produced. R-6/R-9 are affirmed as-designed (no change recommended — the ticket's own
phase-ordering and explicit-row-write patterns are already the established best practice). R-10 is
correctly deferred to TASK-705, not absorbed here.

**Verification run this pass (paste, not narrative):**

```
$ pnpm --filter @arcaai/applications test -- harness-enabled-single-reader   # ran full suite
 Test Files  492 passed | 1 skipped (493)
      Tests  9153 passed | 4 skipped (9157)

$ cd packages/database && npx vitest run scripts/__tests__/harness-migration-readiness-report.test.ts
 Test Files  1 passed (1)
      Tests  11 passed (11)

$ pnpm --filter @arcaai/database test   # full package suite, includes the new file
 Test Files  52 passed (52)
      Tests  1255 passed (1255)

$ pnpm --filter @arcaai/database build
> tsc            (clean, no output)

$ NODE_ENV=development pnpm --filter @arcaai/database exec tsx \
    scripts/harness-migration-readiness-report.ts --since-days 365
[real output, all-zero denominators — pasted in full in go-no-go-thresholds.md §5]

$ ~/miniconda3/envs/arcaenv/bin/python scripts/harness-availability-report.py --since-days 90
[real output, 0 executions — pasted in full in go-no-go-thresholds.md §5]
```

**Not run this pass (gated, stated plainly rather than fabricated):** `pnpm api:build`,
`pnpm test:e2e`, `pnpm lint`, `pnpm typecheck` — none of this pass's changes touch `apps/api` or
any lint/typecheck-covered TypeScript source outside `packages/database/scripts/**`, which its own
`build`/`test` above already cover; running the full-monorepo gates was judged unnecessary for a
docs+scripts-only, Phase-1-scoped pass and was not run. `pnpm --filter @arcaai/database` carries no
`lint` script (confirmed: `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`, and no `eslint.config.*` exists for
this package) — not something this pass introduced or could add within its stated scope.

**Files changed this pass:**
- New: `docs/implementation/TASK-732-Legacy-Migration-Deletion/readiness-checklist.md`
- New: `docs/implementation/TASK-732-Legacy-Migration-Deletion/go-no-go-thresholds.md`
- New: `docs/implementation/TASK-732-Legacy-Migration-Deletion/deletion-manifest.md`
- New: `packages/database/scripts/harness-migration-readiness-report.ts`
- New: `packages/database/scripts/__tests__/harness-migration-readiness-report.test.ts`
- Modified: `docs/implementation/TASK-732-Legacy-Migration-Deletion/README.md` (this file — Status,
  §6 Answers, §7, §8)

**What remained after the first pass, now resolved by this pass (2026-08-16/17):** Phase 1 Task 3's
verdict — the owner rendered **GO**, explicitly a pre-production call rather than the data-driven
verdict R-1 envisaged. Task 8 — the owner rendered the R-2 boundary (option (b) for all three:
keep pre-summary/comprehensive-summary/sync-summary). Phases 2–4 executed within that authorization.

---

### 7A. Implementation Summary — Phases 2–4 execution pass (2026-08-16/17)

**Scope of this pass.** Given the owner's GO + R-2 boundary, executed Phase 2 (SYSTEM-default flip
only — no real tenant cohorts exist to migrate through, per the pre-production basis recorded in
`go-no-go-thresholds.md` §7), Phase 3 (deletion within the boundary), and Phase 4 (grep-gate,
contract test, doc sync).

**Phase 2 — SYSTEM default flip.** `SYSTEM_PIPELINE_POLICY_DEFAULTS.harnessEnabled` flipped
`false → true` in `seed/14-pipeline-policy.ts`; `PIPELINE_SETTING_DESCRIPTORS.harnessEnabled.codeDefault`
flipped to match in `config-resolver.service.ts`; both tests updated in the same commit-worthy
change (`seed.test.ts`, `config-resolver.service.test.ts`, `settings-registry.test.ts`). An
idempotent data migration for deployed SYSTEM rows was authored and proven against a throwaway
`hope_shadow` database per `.claude/rules/02-database-prisma.md`'s shadow-DB workflow
(`npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script` →
`-- This is an empty migration.` after applying it) — **not applied to the local dev database**
this pass (explicitly off-limits to this session per its own operating instructions); it lands via
the deploy pipeline's `db-migrate` PreSync Job or an operator's own consented `migrate deploy`.
Runbook: `docs/operations/consultation/harness-migration-runbook.md` (models
`docs/operations/vault/README.md`'s shape), written in full for a real future migration even though
this pass had no real cohorts to walk.

**Phase 3 — deletion, within the R-2 boundary.** Deleted:
`consultation/jobs/processors/summary.processor.ts` (+ its `__tests__` files),
`consultation/jobs/processors/ner.processor.ts` (+ its `__tests__` files),
`consultation/jobs/processors/legacy-dosage-check.util.ts` (TASK-714's floor, + its test).
Edited: `processors/index.ts` (barrel), `consultation-job.service.module.ts` (imports/providers/
`registerQueue` — `HarnessAuditServiceModule`/`AiTaskDefaultServiceModule`/`PhiRedactionServiceModule`
also removed, verified unused by any surviving provider in that module),
`consultation-job.service.ts` (removed `createSummaryJob`/`createNerJob` + their queue injections +
the `cancelJob` switch arms), `consultation-event.handler.ts` (fork 1's legacy dispatch replaced
with a VISIBLE `PipelineStepFailed` emission on any non-harness seam decision — never a silent
no-op, per `design.md` §Error handling; fork 2's `harnessEnabled` conditional collapsed to an
unconditional skip, removing the seam's second reader),
`apps/api/.../consultation.controller.ts` (`generateSummaryAsync` rewritten to call
`noteGenerationService.generate(SUMMARY_REGENERATE, …)` directly — the file deletion-manifest.md
§0.2 found the ticket's original Task 9 plan omitted), `cross-tenant-coverage.test.ts`
(`PROCESSOR_COVERAGE` rows removed in the same change), `common.service.module.ts` (a THIRD queue
registration site the original manifest didn't name — `RedisServiceModule.register([...])` also
listed `GenerateSummary`/`ExtractNamedEntities`), and the pre-existing TASK-704 grep-gate
(`harness-enabled-single-reader.grep-gate.test.ts` — its now-stale `ALLOWED_SITE` allow-list for
fork 2 removed, hardening it to a zero-tolerance check). `JobQueue.GenerateSummary`/
`ExtractNamedEntities` enum members deliberately NOT removed (R-5 — pending a real drain
confirmation this pre-production pass has no live traffic to perform). Several comments elsewhere
in the tree that named the deleted classes for historical/explanatory reasons
(`harness-internal.service.ts`, `live-documentation.service.ts`, `comprehensive-summary.processor.ts`,
`consultation.events.ts`, `summary.service.ts`, `ingest-knowledge-document.processor.ts`) were
updated to describe the change without literal dead-identifier references, so the Phase 4 grep-gate
can assert TRUE zero live-code occurrences without also flagging legitimate prose.

**Task 11 — kept generators made structurally checked, not assumed.** Added
`kept-generators-signability.task732.test.ts` and class/method-level comments on
`PreSummaryProcessor`, `ComprehensiveSummaryProcessor`, and `SummaryService.generateSummary`.
**Finding, not a clean pass**: verifying the "non-signable" claim against the live
`ContextItemEntity.isFinalSummary` gate found it TRUE only for `PreSummaryProcessor`. Sync
`generateSummary`'s signability is correct-by-design (unaffected). `ComprehensiveSummaryProcessor`
producing a signable-shaped `RAW_SUMMARY` item is an OPEN finding — recorded in `deletion-manifest.md`
§5 and `go-no-go-thresholds.md` §7/R-2 as unresolved, not silently accepted or silently "fixed."

**Phase 4.** `legacy-generator-absent.grep-gate.test.ts` (5 assertions, comment-aware — strips `//`
and `/* */` before matching so explanatory comments don't self-trigger the gate) — **RED/GREEN
proof performed**: a scratch file reintroducing `createSummaryJob` made the gate fail with the
expected message, then was deleted and the gate re-confirmed green (both outputs below).
`tests/contracts/note-generation-assurance.contract.test.ts` — statically confirms every one of the
(currently 5) `ContextItemFactory.CreateRawSummary` call sites in `packages/applications/src` also
writes a `SummaryMeta`, the permanent form of what TASK-714 bought temporarily. `design.md`
§Deprecations and its D1 decision-log row updated to record what shipped (cross-checked against the
tree with greps — pasted below); `backlog.md`'s Wave 4 section annotated with TASK-732's shipped
status and the open finding.

**Verification (paste, not narrative):**

```
$ pnpm --filter @arcaai/applications build          # clean
$ pnpm --filter @arcaai/domains build                # clean
$ pnpm --filter @arcaai/database build                # clean
$ pnpm api:build                                       # 12/12 tasks successful

$ pnpm test:unit
 Test Files  1052 passed | 2 skipped (1054)
      Tests  17720 passed | 4 skipped | 9 todo (17733)

$ pnpm typecheck
 Tasks:    43 successful, 43 total

$ pnpm lint
 Tasks:    38 successful, 38 total
 (65 pre-existing eslint-comments/require-description warnings, 0 errors)

$ CI=true pnpm harness:test
 1339 passed, 1 warning in 48.06s      # harness suite UNAFFECTED — proves nothing leaked in

$ pnpm --filter @arcaai/database test
 Test Files  50 passed (50)
      Tests  1226 passed (1226)
```

**Grep-gate RED/GREEN proof:**

```
$ cat > .../jobs/processors/__scratch-reintroduction-test.ts <<'EOF'
export function createSummaryJob() { return 'this should never exist again'; }
EOF
$ npx vitest run src/services/consultation/__tests__/legacy-generator-absent.grep-gate.test.ts
 FAIL  ... > 2. zero live-code occurrences of SummaryProcessor / NerProcessor / createSummaryJob / createNerJob
 AssertionError: ... [{ "file": ".../__scratch-reintroduction-test.ts", "line": 3, ... }]
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)

$ rm .../jobs/processors/__scratch-reintroduction-test.ts
$ npx vitest run src/services/consultation/__tests__/legacy-generator-absent.grep-gate.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

**design.md §Deprecations cross-check greps (all as expected — empty for deleted, present for kept):**

```
$ find packages/applications/src/services/consultation/jobs/processors -iname "summary.processor.ts" -o -iname "ner.processor.ts"
(no output)
$ find packages/applications/src/services/consultation/jobs/processors -iname "legacy-dosage-check*"
(no output)
$ find packages/applications/src/services/consultation/jobs/processors -iname "pre-summary.processor.ts" -o -iname "comprehensive-summary.processor.ts"
packages/applications/src/services/consultation/jobs/processors/pre-summary.processor.ts
packages/applications/src/services/consultation/jobs/processors/comprehensive-summary.processor.ts
$ grep -n "async generateSummary(" packages/applications/src/services/consultation/summary/summary.service.ts
457:  async generateSummary(consultationId: string, request: GenerateSummaryRequest): Promise<SummaryResponse> {
```

**Not run this pass (gated, stated plainly rather than fabricated):** `pnpm test:integration` and
`pnpm test:e2e` — the isolated test Postgres (`hope_test`, :5433) has NO schema loaded at all
(`relation "core.Department" does not exist" — confirmed via a direct `psql \dt core.*`, unrelated
to any table this ticket touches); resetting/seeding it requires `prisma db push --force-reset`,
which per this session's own operating instructions requires consent the orchestrating session
holds, not this one. `apps/admin-console/tests/e2e/pipeline-policy.spec.ts` (needs a running stack)
likewise not run; the `cascade.ts` label change was verified unit-level only
(`apps/admin-console`'s `pipeline-policy` unit suite: 2 files / 20 tests passed) and by grepping for
any literal `'legacy'` string assertion in the admin-console tree (none found).

**Files changed this pass** (full list; the pre-existing Phase 1 artifacts from the prior pass are
unchanged except where noted):
- Deleted: `packages/applications/src/services/consultation/jobs/processors/{summary,ner}.processor.ts`,
  `.../legacy-dosage-check.util.ts`, and their `__tests__` files (7 files total)
- New: `packages/applications/src/services/consultation/__tests__/legacy-generator-absent.grep-gate.test.ts`,
  `packages/applications/src/services/consultation/jobs/processors/__tests__/kept-generators-signability.task732.test.ts`,
  `tests/contracts/note-generation-assurance.contract.test.ts`,
  `docs/operations/consultation/harness-migration-runbook.md`,
  `packages/database/src/prisma/db_main/migrations/20260817031425_task_732_flip_system_harness_enabled_default/`
- Modified (source): `consultation-job.service.{ts,module.ts}`, `processors/index.ts`,
  `processors/{pre-summary,comprehensive-summary}.processor.ts`, `events/consultation-event.handler.ts`,
  `events/consultation.events.ts`, `harness/harness-internal.service.ts`,
  `live-documentation/live-documentation.service.ts`, `summary/summary.service.ts`,
  `knowledge/ingest-knowledge-document.processor.ts`, `baseServices/common.service.module.ts`,
  `config-resolver/config-resolver.service.ts`, `apps/api/.../consultation.controller.ts`,
  `apps/admin-console/.../pipeline-policy/components/cascade.ts`,
  `packages/database/src/prisma/db_main/seed/14-pipeline-policy.ts`
- Modified (tests): `cross-tenant-coverage.test.ts`, `consultation-job.service.test.ts`,
  `jobs/__tests__/integration/job-queue.integration.test.ts`,
  `events/__tests__/consultation-event.handler.test.ts` (substantially rewritten — the legacy-path
  behavior it tested no longer exists), `note-generation/__tests__/harness-enabled-single-reader.grep-gate.test.ts`,
  `summary/__tests__/text-service-token-migration.test.ts`, `settings-registry/__tests__/settings-registry.test.ts`,
  `config-resolver/__tests__/config-resolver.service.test.ts`, `packages/database/src/__tests__/seed.test.ts`,
  `apps/api/src/modules/consultation/__tests__/consultation.controller{,.highlights}.test.ts`,
  `apps/api/tests/integration/summary-provenance.spec.ts` (constructor-arg fixups for the new
  `noteGenerationService` parameter — not this ticket's behavior, but a mechanical consequence of it)
- Modified (docs): `docs/architecture/agentic-workflow-platform/design.md`,
  `docs/architecture/agentic-workflow-platform/backlog.md`,
  `docs/implementation/TASK-732-Legacy-Migration-Deletion/{README,go-no-go-thresholds,deletion-manifest}.md`

**A git-index note, not a code change:** the deleted files were `git add`-ed (staged, never
committed) so `git ls-files`-based tooling (`scripts/env-sync.test.ts`'s source scan) would see the
deletion — a raw filesystem `rm` alone left them "deleted in the working tree, present in the
index," which `git status` shows correctly but `git ls-files` does not.

**What remains, correctly incomplete rather than abandoned:** a REAL Phase 2 cohort migration
(monitoring windows, per-cohort verdicts) — there is no real tenant traffic yet; the runbook is
ready for when there is. The `ComprehensiveSummaryProcessor` signability open finding (R-2) — a
product decision, not this ticket's to make unilaterally. `pnpm test:integration`/`test:e2e` —
gated on infra-reset consent this session does not hold.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Claude (Wave-4 ticket-authoring agent) |
| 2026-08-16 | Phase 1 executed: `readiness-checklist.md`, `go-no-go-thresholds.md` (formulas/thresholds/comparison-rule/inconclusive-branch/inversion-path, written before any real data was read), `scripts/harness-migration-readiness-report.ts` (+ unit tests, run against live dev Postgres — all-zero, honest, matching TASK-730's own no-traffic finding), and `deletion-manifest.md` (Task 7 re-derivation against the real tree — surfaced two structural findings the ticket's own §2 could not have known about: a fourth permanently-legacy entry point, and a controller-rewrite requirement Task 9's original file list omitted). R-1–R-10 answered in §6; R-1/R-2 remain HUMAN-GATED by design. No code deleted, no `JobQueue` member touched, no default flipped, per the pass's explicit scope. Status → Blocked (on Task 3's human verdict + real traffic). | Claude (T3/T4 execution session) |
| 2026-08-17 | Owner rendered Task 3's verdict (GO, pre-production) and Task 8's R-2 boundary (keep pre-summary/summary, scope to signable generator). Phases 2–4 executed within that authorization: SYSTEM-default flip (seed + config-resolver codeDefault + shadow-DB-proven data migration, not applied to dev DB); Phase 3 deletion of `summary.processor.ts`/`ner.processor.ts`/TASK-714's floor + every runtime reader across 3 registration sites (one — `common.service.module.ts` — not named by the original manifest); `consultation.controller.ts` rewritten per deletion-manifest.md §0.2; Task 11's "not incidentally non-signable" check found `ComprehensiveSummaryProcessor` is NOT actually structurally non-signable (open finding, not resolved); Phase 4 grep-gate (RED/GREEN proven) + contract test + design.md/backlog.md sync. Full verification: `test:unit` 1052/17720 green, `typecheck` 43/43, `lint` 38/38, `harness:test` 1339 unaffected. `test:integration`/`test:e2e` not run (infra-reset consent gated). Status → Review. | Claude (T3 execution session) |
