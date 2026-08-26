# TASK-810 — Template / Shape Catalog

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `feature` |
| **Branch** | `dev-2.2` |
| **Architecture** | <https://claude.ai/code/artifact/b6b68b73-3cb9-4cec-89f3-8afd1553c13b> |
| **Master** | [TASK-806](../TASK-806-Consultation-Workflow-Substrate-Unification/README.md) |
| **Depends on** | TASK-809 |
| **Blocks** | 811 |
| **Agent** | `database-admin` → `general-purpose` · `opus` · effort `high` · **worktree** |

## 1. Requirement Analysis & Scope

### In scope
- `DocumentTemplate` (head) + `DocumentTemplateVersion` (immutable) with movable pin.
- Template compiler: shape → strict JSON schema + frozen checklist + section state machine.
- Entrypoint pins the template catalog alongside the context schema.
- **DD-11 prompt binding + two-path versioning.**
- Authoring UI; vox-node regeneration.

### Out of scope — the compat fence (owner: "Do NOT touch the compat things")

Reproduced in full so this ticket is self-contained. **Do not read, edit, refactor, rename, or
"tidy" anything below.** If a change appears to require touching one of these, make it **additively**
instead and report the constraint rather than editing.

```
apps/compat-playground/**                        apps/quick-compat-app/**
apps/api/src/modules/text-compat/**              apps/api/src/modules/stt-compat/**          (OD-8)
apps/api/src/global-prefix.config.ts             apps/api/src/main.ts:109-111
packages/vox-node/src/resources/summarization.ts packages/vox-node/src/types/summarization.ts
packages/vox-node/src/core/url.ts                (PREFIX_EXEMPT_PATHS)
packages/agentic-sdk-v2/src/compat.ts            packages/agentic-sdk-v2/src/compat/**
packages/agentic-sdk-v2/src/types/consultation.ts:117-122   (the @deprecated `department` field ONLY)
packages/agentic-sdk-v2/src/types/context.ts:172-179        (AddContextInput.structuredData ONLY)
```


## 2. Current State Evaluation

`SOAP_SECTION_TITLES` is a hardcoded `as const`; `LIVE_SOAP_RESPONSE_FORMAT` hardcodes the four
sections with `strict: true` + all `required`; `parseSoapJson` demands a SOAP key;
`buildRunningSummary` maps the fixed titles. Custom templates are not unwired — they are
**structurally excluded in five places**.

**D-21 (fix here):** `strict: true` + all-`required` forces the model to emit every heading even
when nothing was discussed, so it confabulates. Mild at four sections; serious at ten.


## 2a. Findings this ticket closes

| # | Finding | Evidence |
|---|---|---|
| **D-7** | `DEFAULT_POLICY_BINDINGS.contextSchemaVersionId` is hardcoded `null` (as are `promptTemplateRefs`, `entitlementKeys`) and passed at every compile — a published graph **never pins** the tenant's context schema | `workflow-definition.service.ts:56-62` |
| **D-8** | The graph entrypoint inlines a **literal** schema with no `schemaId`, over only `TEXT`/`STRUCTURED` — vs the admin schema's five primitives | `node-config-schemas.ts` |
| **D-21** | `strict: true` with all four sections `required` forces the model to emit every heading even when nothing was discussed → confabulation. Mild at 4 sections, serious at 10 | `soap-parser.ts:98-113` |
| Structural | Custom shapes are excluded in **five** places: `SOAP_SECTION_TITLES` (`soap-parser.ts:13`), `LIVE_SOAP_RESPONSE_FORMAT` (`:98`), `parseSoapJson` (`:127`), `parseSoapSections` (`:60`), `buildRunningSummary` (`:158`) | verified |
| Constraint | `LIVE_SOAP_SYSTEM_PROMPT` (`live-documentation.service.ts:120`) is pinned by **sha256 checksum tests**. They WILL fail — that is them working. Re-pin deliberately | `live-soap-prompt-checksum.test.ts`, `system-live-soap-default-checksum.test.ts` |

## 2b. The versioning recipe to replicate (verified path:line)

Copy **`ConsultationContextSchema`**, not `WorkflowDefinition`.

| Element | Reference |
|---|---|
| Head row + movable pin `pinnedVersionNumber Int?` | `consultation-context-schema.prisma:19-83`, pin at `:47` |
| Immutable version row (`versionNumber`, `definition Json`, `checksum`, `changeReason`; **no `updatedAt`/`updatedBy`**) | `:89-129`, unique `@@unique([schemaId, versionNumber])` at `:125` |
| Pin captured at consumption time | `ContextItem.contextSchemaVersionId` (`consultation.prisma:49`), indexed `:100` |
| Publish guard (ownership 404 → shape validation → idempotent-republish on identical checksum → breaking-change gate → mint version → move pin) | `consultation-context-schema.service.ts:205-278` |
| `pin()` moves only to an existing version | `:280-300` |
| Immutability by **absence of a write method** — the version repo is only ever `.create()`/`.find*()` | verified across the service |
| Checksum = sha256 over key-sorted canonical JSON, one implementation driving both idempotency and the ETag | `context-schema-definition.ts:346-368` |
| DTO whitelist — server-stamped columns absent from the request DTO, so `forbidNonWhitelisted` makes them unsubmittable | `consultation-context-schema.request.ts:98-124` |

**OD-13 — the precedent does NOT include a DB trigger.** Only `WorkflowDefinition` has one
(`workflow_definition_immutability_guard`, migration `20260817000100_task_734_…`).
`ConsultationContextSchemaVersion` has no trigger and no `REVOKE`. **Add the trigger here.**

## 2c. Design decisions this ticket implements

| # | Decision | How it lands here |
|---|---|---|
| **DD-1** | **Templates are shapes.** SOAP, discharge summary and patient background are rows in one catalog; none is privileged | `SOAP` leaves every type name. The four hardcoded titles and the hardcoded `json_schema` are replaced by artifacts compiled per shape. |
| **DD-2** | **No runtime shape switching.** A generation node binds one shape statically in its config | There is no selector node, no runtime classification, no eligibility set and no switch-locking. Each generation node compiles its bound shape once, at publish, frozen for the session. |
| **DD-11** | Prompt binding with two update paths | §2d below. |

## 2d. DD-11 — prompt binding, two update paths

A text-generation agent node **MUST** reference a prompt/prompt template. Two distinct semantics:

| Path | Behaviour |
|---|---|
| Edit the prompt **from within the node** | Create a new `PromptVersion` **and move that node's pin immediately** — one atomic transaction |
| Edit the same template from the **Prompt/Instruction management screen** | Create a new `PromptVersion`; **move no node's pin.** Each referencing node is re-pinned separately, surfaced by a "new version available" affordance |

This is what stops a shared template silently changing every workflow that references it. It maps
onto the existing `PromptTemplate` → `PromptVersion` head/version/pin triple — no new mechanism.

## 3. Design constraints

**Copy `ConsultationContextSchema`, not `WorkflowDefinition`.** Head → immutable version → movable
pin. Head carries `pinnedVersionNumber Int?`; version carries `versionNumber`, payload, `checksum`
(sha256 over canonical JSON) and has **no update path**. Consumers stamp the validated-against
version id at write time.

**OD-13 — add the DB immutability trigger.** The `ConsultationContextSchemaVersion` precedent has
**no** trigger (only `WorkflowDefinition` does, from TASK-734). Convention-only is one careless
`update()` away from rewriting published clinical templates.

**DD-11 — prompt binding, two update paths:**
- A text-generation node **MUST** reference a prompt/prompt template.
- Edit **in-node** → create a new `PromptVersion` **and move the node's pin immediately** (atomic).
- Edit via the **Prompt/Instruction management screen** → create a new version, **pin does not
  move**; each node is re-pinned separately, with a "new version available" affordance.

This is what stops a shared template silently changing every workflow that references it.

## 4. Implementation Plan (TDD)

| # | Task | Test first |
|---|---|---|
| 1 | Prisma: `DocumentTemplate` + `DocumentTemplateVersion`; `gen:model` only | schema shape test |
| 2 | Hand-author both trios. Mapper needs `FIELDS_NOT_WRITABLE=['version']` — **copy `AiTaskDefaultEntityMapper.ts:9`, NOT the Harness/Pipeline mappers (D-23)** | mapper strip test |
| 3 | `ResourceType` in **both** `audit.prisma` (+`ADD VALUE`) and `ResourceType.ts` (version table deliberately absent, per the ContextSchema precedent) | `resourceType.enum-parity.test.ts` |
| 4 | `TENANT_SCOPED_MODELS`; version row in `MODELS_WITHOUT_SOFT_DELETE` | allow-list tests (note: `tenant-scope.test.ts` asserts an exact size) |
| 5 | Register repositories in `CoreDatabaseModule`; barrels by hand | module test |
| 6 | Service: publish (checksum idempotency, breaking-change gate, mint version, move pin), pin | service tests |
| 7 | **DB immutability trigger** on the version table (OD-13) | migration test attempting UPDATE |
| 8 | Compiler: shape → strict JSON schema + checklist + state machine | golden compile test |
| 9 | **D-21**: sections nullable or "not discussed" sentinel | test that an undiscussed section is not confabulated |
| 10 | Entrypoint pins template catalog; publish validation | publish/repin tests |
| 11 | **DD-11** in-node edit → create version + move pin atomically | transaction test |
| 12 | **DD-11** out-of-band edit → version created, pin unmoved | regression test |
| 13 | Re-pin the prompt checksum tests **deliberately** (they will fail — that is them working) | — |
| 14 | Authoring UI (`/context-schemas` is the closest analogue) + "new version available" affordance | component + axe |
| 15 | Regenerate the five artifacts | `gen:admin:check` |

## 5. Verification
```bash
# migration authored against a throwaway shadow DB — 02-database-prisma.md
# NEVER run pnpm gen:mapper (destructive: strips the _version OCC guard)
pnpm --filter @arcaai/database test
pnpm --filter @arcaai/domains build test
pnpm --filter @arcaai/applications build test
pnpm --filter @arcaai/admin-console build lint test
pnpm --filter @arcaai/vox-node gen:admin:check
```

## 6. Definition of Done
- [ ] Head/version/pin triple with checksum + DB trigger
- [ ] Compiler emits schema + checklist + state machine; D-21 closed
- [ ] DD-11 both paths proven by test
- [ ] Enum parity green; allow-lists updated; repositories registered
- [ ] Five artifacts regenerated

## Best Practices — apply to every task here

- **The template IS the schema, not the prompt.** Compile the shape into a strict JSON schema so
  the model *cannot* violate it. "Please follow this template" is a request a model can ignore.
- **Copy `ConsultationContextSchema`, not `WorkflowDefinition`.** Head → immutable version →
  movable pin. The version row has **no update path** — immutability by absence of a write method.
- **Add the DB trigger anyway (OD-13).** The ContextSchema precedent has none; convention-only is
  one careless `update()` away from rewriting published clinical templates.
- **Sections must be nullable or carry a "not discussed" sentinel (D-21).** `strict: true` with all
  sections `required` forces the model to fill headings that were never discussed.
- **Separate form / per-section instruction / global instruction.** A single prompt blob is
  unversionable, untestable and un-diffable.
- **Checksum over canonical JSON** (key-sorted) drives both idempotent republish and the ETag —
  one implementation, not two.
- **D-23 — mapper template choice matters:** copy `AiTaskDefaultEntityMapper.ts:9` or
  `ContextItemEntityMapper.ts:14`. Do **not** copy `HarnessPolicyEntityMapper` or
  `PipelinePolicyEntityMapper` — both are missing the `FIELDS_NOT_WRITABLE` guard.
- **Server-stamped columns never appear on a request DTO** (`checksum`, `versionNumber`,
  `pinnedVersionNumber`); `forbidNonWhitelisted` then makes them unsubmittable.

## Standing instructions (every task in this ticket)

- **Evidence, not assertion.** "Tests pass" with nothing pasted is not a result. Paste actual
  command output (`01-development-workflow.md` §Phase 5).
- **TDD:** failing test first, and you must *see it fail*. A test that never failed verifies nothing.
- **Branch is `dev-2.2`**, never `dev`.
- **Never `git stash` in a worktree** — the stash stack is shared repo-wide. Commit, then
  `git checkout HEAD~1 -- <path>` for a baseline.
- **Orchestrator owns shared surfaces:** merges, `pnpm install`, `db:push`/`db:migrate`/
  `test:db:reset`, Docker/infra, and every `gen:*` invocation. Do not run them.
- **Lint warnings in `packages/*` are errors.** `eslint-plugin-only-warn` downgrades them; treat
  them as hard failures anyway.
- **Do not run** the test suites of `apps/compat-playground`, `apps/quick-compat-app`, or
  `packages/ui` unless your change lands inside that package (owner directive).

### Destructive-tooling warnings (this ticket touches Prisma)

- **NEVER run `pnpm gen:mapper`.** It rewrites mappers as it goes and **drops the
  `FIELDS_NOT_WRITABLE = ['version']` OCC guard** before crashing. One run clobbered 24 mappers and
  stripped the guard from 18. Recovery is `git checkout -- packages/domains/src/mappers/generated/core/`.
- `gen:entity` / `gen:factory` **reconcile barrels and check coverage — they never create files.**
  Entity, factory, mapper and repository are **hand-authored**.
- `gen:repository` is broken (bad argument); harmless but useless.
- Migrations are authored against a **throwaway shadow DB**, never the dev DB — recipe in
  `02-database-prisma.md`. The dev DB is `db push`-managed and has no migrations ledger.
- On `@@unique`, `name:` is the **client-facing** compound key; the DB index name comes from `map:`.

### The five-artifact rule (this ticket changes an admin route)

`.claude/rules/05-nestjs-api.md:155` still says **four** artifacts and omits the fifth. That
omission turned TASK-805's pipeline #990 red. The real rule:

```bash
pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal \
  && pnpm --filter @arcaai/vox-node gen:admin
```
Verify with `pnpm api:openapi:check`, `pnpm api:portal:check`, `pnpm --filter @arcaai/vox-node gen:admin:check`.
**`packages/vox-node/src/resources/admin/**` is GENERATED — never hand-edit.** Only
`admin-resource.ts` is hand-authored.

### Finishing protocol — land it on `dev-2.2`, leave no worktree behind (owner directive, 2026-08-25)

**No work is "done" while it sits in a worktree.** When your gates are green, you MUST complete
this sequence. It is not optional and its order is not negotiable.

1. **Bring the target in first.** `git merge dev-2.2` INTO your branch and resolve any conflicts
   **in your own worktree**, never in the primary checkout.
2. **Re-run every gate AFTER that merge.** A clean merge is not a passing build. Paste the output.
3. **Merge your branch into `dev-2.2`** — the target is always `dev-2.2`, never `dev`.
4. **Only once step 3 is committed:** remove your worktree (`git worktree remove <path>`) and delete
   your branch.

**Before step 4, prove there is nothing left to lose:**
```bash
git log <your-branch> --not dev-2.2 --oneline   # MUST be empty
```
If it is not empty, stop — you have unmerged commits. Never use `git worktree remove --force`,
never `git worktree prune` "to tidy up", and never delete the directory by hand. An abandoned
worktree is recoverable; a removed one is not.

**If you cannot complete the merge** — conflicts you cannot resolve, a failing gate, an ambiguous
call — **LEAVE THE WORKTREE IN PLACE** and report it at the TOP of your final message with its path
and branch. Never bury an un-merged worktree in the body of a report.

**Concurrency note:** when several lanes run at once, the orchestrator may tell you to stop after
step 2 and hand off, so the final merges are serialized and lanes do not race each other into
`dev-2.2`. Follow that instruction if you receive it; otherwise complete all four steps yourself.

## Close-out protocol — MANDATORY (owner directive 2026-08-26, amended by measurement)

**Which path applies depends on where you work. Read the right one.**

### If you work in a WORKTREE

You **cannot** merge into `dev-2.2` yourself, and you must not try. `dev-2.2` is checked out in the
primary checkout, so git refuses every route into it — `git push . HEAD:dev-2.2` returns
*"refusing to update checked out branch"*, and it is right to: the primary's index and work tree
would desync from HEAD. This was measured, not assumed.

1. **Verify your base FIRST — before any other work.** Worktrees have been created off **`dev`**,
   where `packages/workflow-contract` does not exist at all; two of two agents hit this.
   Run `git merge-base --is-ancestor $(git rev-parse dev-2.2) HEAD`. Non-zero ⇒ confirm your tree
   is clean, then `git reset --hard dev-2.2`. Report which you found.
2. Gates green on your branch, with output pasted.
3. Commit everything. Leave the worktree and branch **intact**.
4. Report your branch name, commit SHA, and that the merge is pending. The orchestrator merges from
   the primary checkout, re-runs the gates there, and only then destroys the worktree and branch.

### If you work in the MAIN CHECKOUT

1. Gates green on your branch, output pasted.
2. **Merge into `dev-2.2`.** Never `dev`.
3. **Re-run the affected gates AFTER the merge** — a clean merge is not a passing build; a sibling
   lane may have moved the base underneath you.
4. **Delete your branch**, only after confirming the merge is on `dev-2.2`
   (`git log dev-2.2 --oneline | grep <your-sha>`).

### Stop conditions — never force past these

- A merge that conflicts in a way you cannot resolve with confidence ⇒ **STOP and report**, leaving
  the branch intact. An abandoned branch is recoverable; a bad merge or a deleted branch is not.
- Gates failing after a merge ⇒ **STOP and report**. Delete nothing.
- Never `git worktree remove --force`, never `git worktree prune`, never delete a branch holding
  commits absent from `dev-2.2`.
- Never `git stash` — the stash stack is shared repo-wide across every worktree.

## Agent Brief (self-contained — copy verbatim when dispatching)

**Ticket:** TASK-810 · **Branch:** `dev-2.2` · **Tree:** worktree `../hope-v2-task-810` off `dev-2.2`
**Agent:** `database-admin` → `general-purpose` · **Model:** `opus` · **Effort:** `high`
**Review lens:** + `database-admin` on the migration.

**Per-task tiers:** the migration and the head/version/pin replication are the deciding stages
(`opus`). The authoring UI and DTO plumbing are `sonnet`-grade once the model is fixed.

**You own:** the new `DocumentTemplate`/`DocumentTemplateVersion` models and their trios, the
template compiler, the entrypoint pin, DD-11 prompt binding, and the authoring screen.
**You must not touch:** the compat fence; runtime execution (TASK-811 owns the executor).
**Ask the orchestrator** to run every `gen:*`, `db:migrate` and `pnpm install` — do not run them yourself.
**Return contract:** `SCHEMA` (models + allow-list edits), `MIGRATION` (SQL reviewed + shadow-DB
drift proof showing "empty migration"), `COMPILER` (golden compile output), `DD11` (both update
paths, tests pasted), `ARTIFACTS`.

**Rules to read before starting:** `.claude/rules/` files 00, 01, 02, 03, 04, 05, 13. A subagent inherits NONE of the orchestrator's context — read them.

## 7. Implementation Summary
_Not started._

## 8. Change History
| Date | Change |
|---|---|
| 2026-08-25 | Opened from TASK-806 §7. Carries OD-13 and DD-11. |
