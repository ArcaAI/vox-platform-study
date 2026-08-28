# TASK-813 — SDK Workflow Selection & Discovery

| Field | Value |
|---|---|
| **Status** | **`Completed`** 2026-08-29 — merged to `dev-2.2` (`56f98622f`). Declared scope delivered; one follow-on in §8 needs an owner decision (selectable-set discovery). |
| **Type** | `feature` |
| **Branch** | `dev-2.2` |
| **Architecture** | <https://claude.ai/code/artifact/b6b68b73-3cb9-4cec-89f3-8afd1553c13b> |
| **Master** | [TASK-806](../TASK-806-Consultation-Workflow-Substrate-Unification/README.md) |
| **Depends on** | TASK-811 |
| **Blocks** | — |
| **Agent** | `api-designer` · `opus` · effort `medium` · **worktree** |
| **Review lens** | + `security-auditor` (a selector that trusts client input is a cross-tenant hazard) |

## 1. Requirement Analysis & Scope

### In scope
- **OD-1**: workflow selection at session-open, authorized against the assignment cascade.
- Workflow discovery: which workflow governs a consultation, and its declared input schema (D-20).
- `useConsultationWorkflow()` in `@arcaai/vox`, mirroring `useConsultationSchema()`.
- **OD-14** documentation: the credential split, honestly stated.
- vox-node regeneration.

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


## 2. The six-point change (OD-1)

1. `OpenSessionInput` (`packages/agentic-sdk-v2/src/types/consultation.ts:100-126`) — add the selector.
2. `OpenConsultationRequest` (`open-consultation.request.ts:13-40`) — declare it, or the global
   `forbidNonWhitelisted` pipe **400s the open** (exactly as it does `department` today).
3. `ConsultationController.open` → `ConsultationService.getOrCreate` — thread it through.
4. `DispatchForConsultationInput` — add the optional override.
5. `ConsultationWorkflowDispatchService.dispatchForConsultation` — today it *always* trusts
   `assignments.resolve(...)`; honour the override instead.
6. **Authorize the override** against the tenant's published, assignable definitions.


## 2a. Findings this ticket closes

| # | Finding | Evidence |
|---|---|---|
| **D-19** | `OpenSessionInput` carries only `patientId`/`appointmentDate`/`departmentId`/`metadata` — no workflow selector | `packages/agentic-sdk-v2/src/types/consultation.ts:100-126` |
| **D-20** | No per-definition input schema exists on the exposure plane — the controller says so in its own summary | `workflows.controller.ts:47` |
| Absent | Nothing exposes **which workflow governs a consultation**. `Consultation.metadata.governingEngine` is written (`governing-engine.ts:58-104`) but never returned; `ConsultationResponse` carries no workflow field | verified |
| Today's behaviour | `ConsultationService.getOrCreate` → `dispatchForConsultation` resolves **only** via `assignments.resolve(tenantId, CONSULTATION_PALETTE_KEY, departmentId ?? null)`; `DispatchForConsultationInput` has no override field | `consultation.service.ts:128,227`, `consultation-workflow-dispatch.service.ts:55-69` |

## 2b. Credential reality (verified — OD-14 rests on this)

`AgenticClient` supports `accessToken` (JWT) **and** `apiKey` simultaneously and sends both
independently (`AgenticClient.ts:68-76,202-208`; `resolveAuthToken` at `:1289-1295`). But
`config.ts:207-217` documents `apiKey` as *"for system/third-party keys"*, the README quick-start
leads with a JWT from a login flow, and **admin hooks require the JWT**.

Session open is business-plane, so an API key **can** open consultations — OD-5 is achievable. OD-14
keeps the JWT as the documented primary path for user-facing frontends anyway, because a
browser-delivered API key is static, long-lived and shared, while a JWT is per-user, expiring,
revocable, and carries the identity abilities compose against (scopes bind the credential,
abilities bind the human, composed as AND).

`@ForbidApiKey()` is defined at `decorators.ts:157` and enforced in `UnifiedAuthGuard` **before**
the scope check; a boot audit (`admin-scope-audit.ts:232`) refuses startup if an `/admin/*`
controller lacks it. `workingTenantId` binds at service-token **exchange**
(`service-account-token.ts:12-24,32-34`), so `X-Tenant-Id` is never sent alongside it — the
`HopeClient` constructor throws if you try (`client.ts:122-134`).

## 3. Design constraints

**Authorization is the whole ticket.** A developer may choose among workflows the tenant is
entitled to — never an arbitrary slug. An unauthorized selection is a **404** (cross-tenant posture),
a disallowed-but-existing one a **403** (privilege).

**Discovery is genuinely absent.** `Consultation.metadata.governingEngine` is written
(`governing-engine.ts:58-104`) but never returned; `workflows.controller.ts:47` states in its own
summary that no per-definition input schema exists.

**OD-14 — `@arcaai/vox` stays JWT-first.** Both credentials remain supported; the documented primary
path for a user-facing frontend is the JWT. An API key in a browser is static, long-lived and
shared; a JWT is per-user, expiring, revocable, and carries the identity abilities compose against
(scopes bind the credential, abilities bind the human, composed as AND). API keys remain the
server-side/integration credential — business plane only, since `/admin/*` carries `@ForbidApiKey()`.

## 4. Implementation Plan (TDD)

| # | Task | Test first |
|---|---|---|
| 1 | Selector on `OpenSessionInput` + `OpenConsultationRequest` | test: undeclared field 400s; declared one accepted |
| 2 | Thread through `getOrCreate` → `DispatchForConsultationInput` → dispatch | dispatch test |
| 3 | Override honoured over the cascade | test |
| 4 | **Authorization**: unentitled slug → 404; cross-tenant → 404; disallowed → 403 | authz tests, all four credential classes |
| 5 | Discovery route: governing workflow + declared input schema | controller test |
| 6 | `useConsultationWorkflow()` hook, fail-open like the schema bundle | hook test |
| 7 | Route manifest + authz matrix coverage | `task-776-route-authz-matrix.spec.ts` |
| 8 | vox-node regeneration | `gen:admin:check` |
| 9 | OD-14 docs in `packages/vox-node/README.md` + `@arcaai/vox` README; audit business-plane scope coverage | docs review |

## 5. Verification
```bash
pnpm --filter @arcaai/applications build test
pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal
pnpm --filter @arcaai/vox-node gen:admin && pnpm --filter @arcaai/vox-node gen:admin:check
pnpm sdk:build && pnpm --filter @arcaai/vox test
pnpm test:up:api && pnpm test:e2e
```

## 6. Definition of Done
- [ ] Selection works and is authorized; 404/403 split correct
- [ ] Discovery returns governing workflow + input schema
- [ ] Hook ships with fail-open posture
- [ ] Credential split documented in both SDK READMEs
- [ ] `OpenSessionInput.department` untouched

## Best Practices — apply to every task here

- **Cross-tenant miss is 404, privilege failure is 403.** Never 403 a cross-tenant id — it reveals
  existence. Assert both halves so the distinction stays locked.
- **A selector that trusts client input is a cross-tenant hazard.** Authorize the override against
  the tenant's published, assignable definitions — never accept an arbitrary slug.
- **`forbidNonWhitelisted` is global.** An undeclared field 400s the request; the DTO must declare
  the selector or the open fails (exactly as `department` does today).
- **Four credential classes** reach every route: super-admin JWT, tenant-admin JWT, API key,
  service-account token. Cover each that can reach the new surface.
- **`@ForbidApiKey()` is checked FIRST** in the API-key branch — before rate limit, scopes and
  abilities. The 403 is unconditional; never assert it "only when the key lacks the scope".
- **Scopes bind the credential; abilities bind the bound human; they compose as AND.** A credential
  can never exceed its human.
- **Never put a JWT in an SSE/WS URL** — use single-use stream tickets.
- **`route-manifest.json` is the authorization oracle:** `null` = no metadata, `[]` = a bare
  `@Authorize()`. They are not the same thing.

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

**Ticket:** TASK-813 · **Branch:** `dev-2.2` · **Tree:** worktree `../hope-v2-task-813` off `dev-2.2`
**Agent:** `api-designer` · **Model:** `opus` · **Effort:** `medium`
**Review lens:** + `security-auditor` — the authorization of the selector is the whole ticket.

**Per-task tiers:** the SDK type/hook plumbing is `sonnet`-grade; the **authorization design** is
the stage whose verdict you act on — keep it at `opus`.

**You own:** `OpenSessionInput`, `OpenConsultationRequest`, the dispatch override,
the discovery route, `useConsultationWorkflow()`, and both SDK READMEs.
**You must not touch:** the compat fence — in particular **`consultation.ts:117-122`**, the
`@deprecated department` field. Adding a new field is additive; leave those lines alone.
**Return contract:** `CONTRACT` (six-point change, file:line each), `AUTHZ` (404/403 matrix, all
four credential classes, tests pasted), `DISCOVERY` (route + hook), `DOCS` (credential split),
`ARTIFACTS`.

**Rules to read before starting:** `.claude/rules/` files 00, 01, 04, 05, 08. A subagent inherits NONE of the orchestrator's context — read them.

## 7. Implementation Summary

Branch `lane-813-sdk` (worktree, off `dev-2.2` @ `55555d988`). **Merge pending — the orchestrator
merges from the primary checkout.**

### The six-point change (OD-1)

| # | Change | File:line |
|---|---|---|
| 1 | `OpenSessionInput.workflowDefinitionSlug?: string` — additive; the `@deprecated department` field is byte-identical | `packages/agentic-sdk-v2/src/types/consultation.ts:123-144` |
| 2 | `OpenConsultationRequest.workflowDefinitionSlug` — `@IsOptional() @IsString() @Matches(WORKFLOW_NODE_ID_PATTERN)` | `packages/applications/src/services/consultation/consultation/dto/open-consultation.request.ts:38-72` |
| 3 | `ConsultationController.open` → `ConsultationService.getOrCreate` — the DTO is passed whole, so threading happens inside `getOrCreate` | `apps/api/.../consultation.controller.ts:365`, `consultation.service.ts:210-297` |
| 4 | `DispatchForConsultationInput.workflowDefinitionSlug?: string \| null` | `.../workflow-dispatch/IConsultationWorkflowDispatchService.ts:96-107` |
| 5 | `dispatchForConsultation` honours the override; the consultation-palette cascade is not consulted at all when it is present | `.../consultation-workflow-dispatch.service.ts:96-102` |
| 6 | `assertSelectableForConsultation(tenantId, slug)` — the gate | `.../consultation-workflow-dispatch.service.ts:56-83` |

### Authorization model (the whole ticket)

The gate runs in `ConsultationService.getOrCreate`, **before the get-or-create branch and before
any write** (`consultation.service.ts:216-227`). Order is the security property, twice:

- **Before the write**, because `dispatchForConsultation` is best-effort by contract and swallows
  its own failures. A gate inside it would turn a refused request into a `201` for a consultation
  quietly governed by something else.
- **Before the existing-consultation lookup**, so the answer to "may I select this workflow?" does
  not depend on whether a row for `(patient, doctor, date)` happens to exist — otherwise the status
  code itself reports that.

`tenantId` is `BaseService.tenantId` (CLS), never a request field, so the gate is identical for all
four credential classes. The predicate is one tenant-scoped read plus one palette comparison:

| Case | Result | Why |
|---|---|---|
| Another tenant's slug | **404** | `findPublishedBySlug` is tenant-scoped; a foreign slug simply misses |
| Unknown slug | **404** | indistinguishable from the above, deliberately |
| Own-tenant DRAFT / inactive / soft-deleted | **404** | the repository filters `PUBLISHED + isActive + ENABLED`; existence is not disclosed |
| Own-tenant PUBLISHED, wrong palette | **403** | already listed by `GET /workflows`; hiding it would be theatre |
| Not a well-formed slug | **400** | `@Matches` at the edge — it could never name a real row |
| Dispatcher not wired + a selection made | **503** | the one non-degrading absent-dependency path: something was *asked for* |

Defense in depth, unchanged from the pre-existing design: `dispatchForConsultation` still
re-verifies publication AND palette on whatever slug it receives, so the gate is not a single point
of trust. The tenant-scope Prisma extension is a third, independent layer.

### Discovery (D-20)

`GET /api/v1/consultations/:id/workflow` → `ConsultationWorkflowResponse`. Reads the durable
`Consultation.metadata.governingEngine` marker through the **same** well-formedness rule
`LoopContextSignalService` gates on — `tenantWorkflowGoverns` is now defined in terms of the new
`readGoverningEngineMarker`, so discovery can never disagree with the engine actually writing the
document. Same access posture as `getById` (`verifyConsultationAccess` first ⇒ 404 for unknown /
cross-tenant), same manifest shape as `getById` (verified).

Two naming decisions made to avoid lying:

- **`activeVersionNumber`, not `versionNumber`.** The active published version is a movable
  pointer, and `WorkflowRun` carries no consultation linkage to recover the version that actually
  ran. The field name says which version it is.
- **`inputSchema` is declared and permanently `null`.** D-20 is a real absence, not an oversight:
  `WorkflowDefinition` has no input column, `CompiledWorkflowConfig` has no input section, and a
  consultation-governing graph takes no caller input at all (the interpreter payload is
  server-built). The field exists so declaring one later is additive rather than a new field to
  discover. Nothing was invented.

### SDK

`useConsultationWorkflow(consultationId?)` — owns its fetch (the governing workflow is
per-consultation and only exists after open, so there is nothing for the provider to pin, unlike the
session-pinned schema bundle). **Fails open**: a failed read resolves to `null` and reports on
`error`, never rejects. `null` ("unknown") stays distinct from `governed: false` ("the default
engine governs"). Proven by mutation check, not just by a passing test.

### Known non-goals, recorded rather than hidden

- A selector supplied to an **already-open** consultation, or to a **re-visit**, is authorized but
  cannot take effect (consultation-open dispatch fires on CREATE only). Both are logged, and the DTO
  documents that `open` is the only route that honours the field. Rejecting instead would have added
  a route-specific error contract this ticket does not own.
- **There is no clinician-facing route that lists SELECTABLE workflows.** `GET /workflows` exists
  but is gated `CanList('WorkflowDefinition')` + scope `workflow:definition:read`, which a clinician
  need not hold, and it lists every palette rather than the selectable subset. A developer must
  currently learn slugs out of band. The authorized set and the discoverable set should be one
  predicate with two consumers; that is a follow-on, filed here rather than built outside scope.

### Gates (all run in the worktree, output pasted in the agent report)

`applications build` · `applications test` **603 files / 10489 passed** · `api test` **262 files /
4034 passed** · `vox build` · `vox test` **271 files / 4235 passed** · `gen:admin:check` no drift ·
`api:portal:check` no drift · `api:openapi:check` OK (the `missing description` ratchet *improved*
411 → 410) · `pnpm lint` 40/40.

Five artifacts regenerated. `packages/vox-node/src/resources/admin/**` is unchanged, correctly — the
new route is business plane, not `/admin/*`.

**Not run:** `pnpm test:e2e` (needs live infra the orchestrator owns). The new route is covered
automatically by `task-776-route-authz-matrix.spec.ts`, which is manifest-driven; its one hardcoded
inventory (27 `@Public() /internal/*` routes) is unaffected.

## 8. Change History
| Date | Change |
|---|---|
| 2026-08-25 | Opened from TASK-806 §7. Carries OD-1 and OD-14. |
| 2026-08-29 | Implemented on `lane-813-sdk`: six-point change, the 404/403 selector gate, the discovery route + `useConsultationWorkflow()`, OD-14 credential split in both SDK READMEs, five artifacts regenerated. Status → `Review`; merge pending with the orchestrator. |

## 8. Recorded gap — selection shipped without in-band discovery of the SELECTABLE set

Raised by the implementing agent, verified by the orchestrator, **not built here.**

A developer can now pass `workflowDefinitionSlug` at session-open, and the gate
(`assertSelectableForConsultation`) decides whether it is allowed. But there is **no route that
returns the set of slugs that would pass that gate.** `GET /workflows` is not it: it is gated
`CanList('WorkflowDefinition')` + scope `workflow:definition:read` — which a clinician-facing
integration need not hold — and it lists every palette rather than the consultation-selectable
subset.

So the API is currently "guess a slug, get a 404/403". That is a usable contract but a poor one,
and it is the missing half of this ticket's own name.

**The design that fixes it, and why that shape specifically:** the authorized set and the
discoverable set must be **one predicate with two consumers** — the gate answers it for a single
slug, a discovery route answers it for the whole tenant. Implemented that way they are incapable
of drifting apart. Implemented as two independent queries they will drift, and the failure is
silent: a slug the list advertises but the gate refuses, or worse, one the gate allows but the
list hides.

Deliberately deferred rather than bolted on — a discovery route is a new authorization surface
(who may enumerate a tenant's consultation workflows?) and deserves its own decision, not a
by-product of this ticket. **Owner decision needed** on whether it belongs to a follow-on ticket
or to TASK-816.

### Also recorded (behaviour, documented not changed)

A selector sent to an ALREADY-OPEN consultation, or on a re-visit, is authorized but cannot take
effect — dispatch is create-only. Both cases are logged and the DTO documents it. The agent chose
not to add a route-specific rejection this ticket does not own; that is the right call, but it
means a caller can send a selector, receive `200`, and be governed by something else. If that
matters to an integrator it needs a deliberate 409, not a silent no-op.

| 2026-08-29 | Merged and closed. Gates on merged `dev-2.2`: applications 10489, api 4034, vox 4235, gen:admin no drift (53 areas/414 routes/379 schemas), portal no drift (admin 618 / business 181 ops), lint 40/40. Authorization gate verified by the orchestrator to run before both the existence lookup and the write; 404 hides existence, 403 only where `GET /workflows` already discloses. `inputSchema` absence independently confirmed against the `WorkflowDefinition` columns. |
