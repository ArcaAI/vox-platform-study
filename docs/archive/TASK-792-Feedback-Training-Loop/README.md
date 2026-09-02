# TASK-792 — Close the Feedback & Training Loop (R7)

| | |
|---|---|
| **Status** | Review |
| **Type** | `bugfix` / `feature` |
| **Parent** | TASK-789 |
| **Branch** | `feat/task-792-feedback-loop` off `dev-2.2` |
| **Owns** | `packages/applications/src/services/{gate-edit-mining,eval,agent-trajectory}/**`, `.../consultation/summary/**`, `.../consultation/prompt/**`, `apps/api/src/modules/harness-admin/**`, `apps/harness/src/harness/eval/**` |

## Context

The owner's R7: *"the system MUST be able to capture my updates on the summary as feedback, AND the
original summary. Those will be used for fine-tuning and training models."*

**The capture half is real and good** — do not rebuild it. `ContextItemVersion` is append-only with
a genuine authorship discriminator (`changeReason`/`changeSource`/`changedBy`), an immutable
`ai_draft_v1` baseline, `contentDiff`/`fieldChanges`, Vault-Transit encryption and attestation.
`approveSummary` additionally diffs the AI baseline against the final signed content.

**Everything downstream is dead code.** That is your ticket.

## Work items

### W1 — `GateEditExemplar` has no live writer (C-4) — HIGHEST PRIORITY
`GateEditMiningQueue` is the **only `@Processor` class in `packages/applications` registered in no
module**. Orchestrator-verified against all nine processors. `.enqueue()` has zero call sites;
neither `approveSummary` nor `recordGateDecision` calls it.

- Register `GateEditMiningProcessor` + `GateEditMiningQueue` in
  `gate-edit-mining.service.module.ts` `providers:` (every sibling processor does this).
- Enqueue from the sign-off path in `approveSummary` — you own `summary.service.ts`.
- Test: signing a consultation with a clinician edit produces a `GateEditExemplar` carrying BOTH
  `redactedBefore` and `redactedAfter`.

### W2 — The retrieval half is separately dead (C-4, second half)
`PromptAssemblyService` injects `IGateEditExemplarRetriever` with `@Optional()`
(`prompt-assembly.service.ts:355`), but only `harness-admin.module.ts` and the mining module itself
import `GateEditMiningServiceModule`. None of the four modules constructing `PromptAssemblyService`
for live generation do — so even with W1 fixed, generation sees `undefined` and silently degrades to
zero-shot. Wire it, and test that an `APPROVED_CLEAN` exemplar actually reaches an assembled prompt.

### W3 — `GoldenCase` has no automated producer (C-5)
The only write path is a manual admin POST. Nothing connects a signed, clinician-edited consultation
— or a curated `GateEditExemplar` — into a `GoldenCase`. Curation only advances `curationStatus`.
Build the promotion path: curated exemplar → golden case.

Read `apps/harness/src/harness/eval/golden/sources.py:8-32` first — it declares the shipped fixture
synthetic and the real clinician-authored set an outstanding prerequisite. **Do not present
synthetic eval results as clinical evidence**; keep that honesty in whatever you build.

### W4 — No fine-tuning export path exists (C-6)
Nothing assembles `(original, edited, context)` triples into a dataset artifact. The nearest thing
is a 500-row JSON admin read of an always-empty table. Build a real export (JSONL is the expected
shape), PHI-redacted, curation-gated, with an explicit tenant scope. Without this, R7's second
clause is unmet no matter what is captured.

### W5 — Hardcoded training-label thresholds (M-9)
`APPROVED_CLEAN_MAX_RATIO = 0.05` and `HEAVILY_EDITED_MIN_RATIO = 0.3`
(`gate-edit-mining.service.ts:32-33`) decide the quality-signal taxonomy. Per rule 00 these are
`db-config` with a tenant → SYSTEM cascade, not TS literals. Moot while the pipeline is dead;
a violation the moment W1 lands — so fix it in the same ticket.

### W6 — `Fedl*` is schema-only (H-6)
`FedlClient`/`FedlRound`/`FedlUpdate`/`FedlModelVersion` have no entity, repository, service or
controller. Do NOT build federated learning. Report to the orchestrator whether these tables should
be dropped or documented as a roadmap placeholder — an owner decision, not yours.

## Guardrails
- **Do not weaken R6.** Exactly one site transitions to SIGNED (`summary.service.ts:1184`), gated on
  a human user id + ownership + `If-Match`, and the harness callback structurally cannot flip
  status. That property is correct and load-bearing. Your changes must not create a second path.
- **PHI**: a training corpus of raw PHI is a compliance defect. Redaction is fail-closed
  (`IPhiRedactor`); keep it that way.
- Schema changes belong to 790 — request, do not add.

## Implementation Summary

Branch `feat/task-792-feedback-loop` off `dev-2.2`. Six commits.

| Item | Status | What changed | Proving test |
|---|---|---|---|
| W1 write half | **DONE** | `GateEditMiningQueue` + `GateEditMiningProcessor` + the `MineGateEditExemplar` BullMQ queue registered in `gate-edit-mining.service.module.ts`; `approveSummary` enqueues best-effort after commit | `gate-edit-mining.di-wiring.test.ts`, `summary.service.gate-edit-mining.test.ts` |
| W2 read half | **PARTIAL** (boundary) | `SummaryServiceModule` + `ChainSummaryServiceModule` import the mining module. `ConsultationJobServiceModule` + `HarnessInternalServiceModule` are NOT this ticket's files — gap pinned by test | `gate-edit-mining.di-wiring.test.ts` |
| W3 golden case | **DONE** | `GoldenCasePromotionService` + `POST admin/harness/gate-edit-exemplars/:id/promote-to-golden-set` | `golden-case-promotion.service.test.ts` (11) |
| W4 fine-tuning export | **DONE** | `exportFineTuningDataset()` + `toJsonl()` + `GET .../fine-tuning-export` (`application/x-ndjson`) | `gate-edit-mining.finetune-export.test.ts` (8) |
| W5 thresholds | **DONE** | Literals replaced by governed settings in `gate-edit-mining.settings.ts`; registry registration is a requested contract | `gate-edit-mining.thresholds.test.ts` (9) |
| W6 `Fedl*` | **RECOMMENDATION ONLY** | See below — an owner decision, not acted on | n/a |
| TASK-791 W7 unblock | **DONE** | `harness/eval/safety_selection.py`; both eval consumers resolve `guardrail.safety` tenant → SYSTEM, fail-closed | `test_safety_selection.py` (7) |

### The loop, end to end

`gate-edit-loop.e2e.test.ts` mocks only the edges and runs the real
`SummaryService` → `GateEditMiningProcessor` → `GateEditMiningService` →
`PromptAssemblyService` against each other. It proves both DoD clauses: the mined
row carries BOTH `redactedBefore` and `redactedAfter`, and an `APPROVED_CLEAN`
exemplar reaches an assembled prompt.

**Live end to end:** clinician edit → signed → mined exemplar (both halves,
PHI-redacted) → curated → **golden case** and → **JSONL fine-tuning export**.
Few-shot retrieval reaches live generation on the sync and chain paths only.

**Still broken:** generation via `ConsultationJobServiceModule` (async jobs) and
`HarnessInternalServiceModule` (harness) still resolves the retriever to
`undefined` and silently degrades to zero-shot. One import line each — see
Requested contracts.

### Guardrails held

- **R6 untouched.** The enqueue is the last step of `approveSummary`, after the
  sign-off has committed, wrapped in try/catch, and cannot reach consultation
  status. Still exactly one site transitions to SIGNED.
- **PHI.** Redaction stays fail-closed everywhere. The export reads only the
  redacted columns; the golden-case promotion redacts the transcript before
  persistence and refuses on an unverifiable or no-op redactor.
- **Honesty (W3).** Promoted cases are stamped `CLINICIAN_DERIVED_PENDING_SME`
  in-band. They are real clinician behaviour but NOT the SME-authored multi-rater
  `clinical_v1` set the harness declares an outstanding prerequisite, so they can
  never be presented as satisfying the Phase-0 exit gate.

## Requested contracts

1. **`ConsultationJobServiceModule`** (`consultation/jobs/**`, unassigned) and
   **`HarnessInternalServiceModule`** (`consultation/harness/**`, TASK-790): add
   `GateEditMiningServiceModule` to `imports`. Without it those two generation
   paths stay silently zero-shot. Pinned by a failing-when-fixed test.
2. **`settings-registry/registry.ts`** (unassigned): register
   `GATE_EDIT_QUALITY_THRESHOLD_SETTINGS` from
   `gate-edit-mining/gate-edit-mining.settings.ts`. Until then the keys are
   unknown to `resolveEffective`, the service degrades to the code defaults, and
   the taxonomy is not retunable without a redeploy. Safe, not broken.
3. **`GateEditExemplarRepository.findForCorpusExport`** (TASK-790 owns
   `packages/domains/**`): add an optional `curationStatus?: ExemplarCurationStatus`
   predicate, mirroring `findTopForRetrieval`. The fine-tuning export filters
   APPROVED in-memory today — correct, but a wider read than necessary and not
   index-backed.
4. **`GoldenCase.provenance`** (TASK-790, schema): a first-class column instead of
   encoding provenance in `label`. `metaData` is declared on `IBaseEntity` but has
   no accessor on `BaseEntity`, so it is unusable from the entity layer.

   ```prisma
   /// How this case entered the corpus: SME_AUTHORED | CLINICIAN_DERIVED | SYNTHETIC.
   provenance String? @db.VarChar(32)
   ```
5. **`apps/api/route-manifest.json` / `openapi.json` / portal**: two new routes were
   added and these repo-wide generated artifacts were NOT regenerated — doing so
   rewrites entries for routes other parallel tickets own. Orchestrator should
   regenerate once after the merges (`pnpm api:route-manifest && pnpm api:openapi
   && pnpm api:portal`).

## W6 — `Fedl*` recommendation: DROP

Recommendation only; the owner decides. Evidence gathered:

- **Zero writers, zero readers.** No entity, factory, mapper, repository, service
  or controller. Only: 4 Prisma models, `FedlRoundStatus`, 4 generated model
  classes, one GLOBAL RBAC seed policy, and a documented exclusion in
  `packages/tools/src/utils/schemaCoverage.ts` (`OMITTED_MODELS`).
- **They are not a usable head start.** All four models have **no `tenantId`**, and
  none appear in `TENANT_SCOPED_MODELS`. Rule 02 makes `tenantId` mandatory
  (NOT NULL, no default) and bans "NULL = global". Any real federated-learning
  work on a multi-tenant PHI platform would have to redesign these tables, not
  extend them.
- **They squat generic namespace.** The physical tables are `core."clients"`,
  `core."rounds"`, `core."updates"`, `core."model_versions"` — prime collision
  candidates in the shared `core` schema.
- **The RBAC policy is a misleading privilege surface.** `federated-learning-access`
  grants `create`/`update` on four subjects no controller serves. Inert today,
  but it widens the apparent permission surface of any service account holding it.
- Pre-production, so there is no data-loss risk in dropping.

Dropping means a TASK-790 migration plus removal of the seed policy, the
`OMITTED_MODELS` entries, and the generated model classes. If the owner prefers
to keep them as a roadmap placeholder, they should at minimum gain `tenantId` and
lose the generic `@@map` names, or the placeholder is actively misleading.

## Verification evidence (pasted output)

```
$ npx turbo run build --filter=@arcaai/applications
 Tasks:    10 successful, 10 total
  Time:    23.322s

$ cd packages/applications && npx vitest run
 Test Files  545 passed | 1 skipped (546)
      Tests  9846 passed | 4 skipped (9850)

$ npx eslint src/services/{gate-edit-mining,eval,consultation/summary,consultation/prompt}
  prompt-assembly.service.ts
    790:0  warning  Unexpected undescribed directive comment ... eslint-comments/require-description
  1 problem (0 errors, 1 warning)
  # PRE-EXISTING: same directive at line 785 on the base commit 6b066dd0f. No new warnings from this ticket.

$ cd apps/api && npx tsc --noEmit -p tsconfig.json
  # clean, exit 0

$ npx vitest run src/modules/harness-admin
 Test Files  4 passed (4)
      Tests  66 passed (66)

$ npx eslint src/modules/harness-admin
  # clean, exit 0

$ cd apps/harness && python -m pytest src/harness/tests -q --no-cov
 1492 passed, 1 warning in 69.07s

$ python -m ruff check src/harness/eval/
 All checks passed!
```

### RED-first evidence

Each work item's failing run was observed before implementing:

- **W1+W2** `gate-edit-mining.di-wiring.test.ts` — `Tests 10 failed | 1 passed (11)`;
  e.g. `AssertionError: expected [ Array(9) ] to include [Function GateEditMiningServiceModule]`.
- **W5** `gate-edit-mining.thresholds.test.ts` — `Tests 5 failed | 4 passed (9)`.
- **W4** `gate-edit-mining.finetune-export.test.ts` — `Tests 8 failed (8)`.
- **W3** `golden-case-promotion.service.test.ts` — collection error: module did not exist.
- **W7** `test_safety_selection.py` — `ImportError: cannot import name 'safety_selection'`.
- **e2e** `gate-edit-loop.e2e.test.ts` — first run `expected [] to have a length of 1`
  (the fixture's edit ratio landed in the ambiguous band; fixture corrected, not the assertion).

### Environment notes

- Python tests were run from `apps/harness` so `harness` resolves to THIS worktree
  (`hope-v2-task-792/...`), not the primary checkout the conda `arcaenv` editable
  install points at. Verified explicitly before relying on any Python result.
- `pnpm --filter @arcaai/database db:generate` was run once: a fresh worktree has no
  generated Prisma client, so nothing builds without it. It is pure codegen
  (`prisma generate` + barrel index) writing only inside this worktree; it opens no
  database connection.

## Change History

| Date | Change |
|---|---|
| 2026-08-22 | Ticket created from TASK-789 findings. |
| 2026-08-22 | W1/W2 wiring; W5 governed thresholds; W4 JSONL export; W3 golden-case promotion; TASK-791 W7 unblock; end-to-end loop test. Three out-of-boundary edits reverted after `OWNERSHIP-MAP.md` arrived mid-ticket. Status → Review. |
