# TASK-813 — SDK Workflow Selection & Discovery

| Field | Value |
|---|---|
| **Status** | **`Review`** 2026-08-29 — §1–§7 merged to `dev-2.2` (`56f98622f`). §8 (selectable-set discovery) BUILT on `lane-813-discovery`; merge pending with the orchestrator. |
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
by-product of this ticket. ~~**Owner decision needed** on whether it belongs to a follow-on ticket
or to TASK-816.~~ **Owner decision, 2026-08-29: built here, inside TASK-813.** Implemented on
`lane-813-discovery` — see §8a.

## 8a. Selectable-set discovery — BUILT (2026-08-29, branch `lane-813-discovery`)

### The route

`GET /api/v1/consultations/workflows` → `SelectableConsultationWorkflowListResponse`
(`{ data: [{ slug, name, description, isTenantDefault }] }`).

On the CONSULTATION controller, not the workflows one, because it answers "what may I pass to
`open`", not "what workflow products exist". Declaration order is load-bearing and is pinned by a
test: the route is a single static segment competing with `getById`'s `:id`, and Express matches
in registration order.

`GET /workflows` was never a candidate, and the §8 statement above understated why: it is not
merely broader, it **structurally excludes this palette** — `EXPOSURE_ALLOWED_PALETTES` is
`{summarization}` (`workflow-exposure/exposure-palette-policy.ts:61`), so it lists ZERO
consultation definitions. There was no wider route to narrow; there was no route at all.

### The authorization decision (the deferred one)

**The route's authorization declaration is byte-identical to `POST /consultations/open`.** That is
the decision, and everything else follows from it: the set is defined as "what `open` will accept",
so the callers who may ask are exactly the callers who can act on the answer.

| Gate | Value | Why |
|---|---|---|
| Ability | `@Authorize(['create','Consultation'])` | The ability `open` requires. A clinician-facing integration holding NO `WorkflowDefinition` ability can now discover its options — which is the entire point; requiring `workflow:definition:read` would leave the gap open. |
| Class default | **overridden, deliberately** | `ConsultationController` carries a class-level bare `@Authorize()`. Inheriting it would let ANY authenticated tenant user enumerate the tenant's authored workflows — configuration disclosure with no matching capability. Unlike its sibling `:id/workflow`, a tenant-wide list has no per-row `verifyConsultationAccess` to lean on, so the ability IS the boundary. |
| API key | `@RequiredScopes('consultation:session:write')` | The scope `open` carries. NOT `…:read`: a read-only key cannot open a consultation, so the set is useless to it; a key that CAN open would be unable to discover. A `:write` scope on a GET is the mirror of the sanctioned rule-05 pattern (personal prompt-template writes declared with `read`) — the decorator states the ability the caller HOLDS, not the verb. Carries an `AUTH-NOTE:`. |
| Service account | no `@RequiredSvcScopes` ⇒ 403 | Deny-by-default, exactly as on `open` (`svcScopes: []`). |
| Cross-tenant | does not arise | `tenantId` is CLS-resolved; the route takes no tenant, department or id parameter, so there is no foreign identifier to answer 404 for. Privilege failure inside one's own tenant is 403. |

Proof, from the regenerated manifest — the two rows are identical apart from method and path:

```
{"handler":"open",                    "method":"POST","routePath":"/consultations/open",
 "svcScopes":[],"apiKeyForbidden":false,"apiKeyScopes":["consultation:session:write"],
 "requiredPermissions":[["create","Consultation"]],"isPublic":false,"permissionMode":"AND"}
{"handler":"listSelectableWorkflows", "method":"GET", "routePath":"/consultations/workflows",
 "svcScopes":[],"apiKeyForbidden":false,"apiKeyScopes":["consultation:session:write"],
 "requiredPermissions":[["create","Consultation"]],"isPublic":false,"permissionMode":"AND"}
```

Route-level authz conformance is therefore GENERATED — the route is covered by
`task-776-route-authz-matrix.spec.ts` the moment it appears in the manifest, and no per-route
"403 for an API key" test was hand-written. What WAS hand-written is the depth the matrix cannot
express: the matrix reads the manifest as its own oracle, so deleting the method-level
`@Authorize` would silently downgrade `[["create","Consultation"]]` to `[]` (the class default,
"any authenticated user") and the matrix would accept both. Four metadata assertions in
`consultation.controller.workflow-discovery.task813.test.ts` pin it, plus the declaration-order
guard. Both were verified by mutation, not by passing.

### One predicate, two consumers — named

`consultationSelectionViolation` in
`packages/applications/src/services/consultation/workflow-dispatch/consultation-selection-policy.ts`.
Shape copied from `exposureBoundaryViolation`, which solves the identical list/invoke problem on
the exposure plane: a violation-reason-or-`null` function, so the reason is available to the 403
message and to the dispatcher's `skippedReason` without either re-deriving it.

Three call sites, zero restatements: `assertSelectableForConsultation` (→ 403),
`listSelectableForConsultation` (→ omission), and `dispatchForConsultation`'s re-verification
(→ `skippedReason`). The gate's palette `if` is GONE — this is a refactor of the gate, not an
addition beside it.

The VISIBILITY half is single-sourced one layer down:
`WorkflowDefinitionRepository.PUBLISHED_AND_ACTIVE` is now the one filter object that both
`findPublishedBySlug` (the gate's read) and `findActivePublishedByTenant` (the list's read)
spread. Between the two, "authorized" and "discoverable" are the same predicate by construction.

Pinned by an anti-drift test that asserts the two ANSWERS against each other rather than each
against a fixture: every slug the list advertises passes the gate, and every published slug it
omits is refused by it. Mutating the list to a copy-pasted laxer rule fails that test (verified).

**Palette is the whole predicate, deliberately.** The dispatcher additionally SKIPS a definition
with no `compiledConfig` — but skips it, degrading to the default engine, rather than refusing.
Folding that into the predicate would make the list hide a slug the gate still accepts, which is
the exact drift this design forbids. A selectable definition can therefore still degrade at
dispatch; `GET /consultations/:id/workflow` is where "what actually governs" is answered.

### `isTenantDefault`, and what it does not claim

Resolved with `departmentId: null`, so it is the TENANT tier. The real cascade is
`department → tenant → platform-default`, and this route takes no `departmentId` — that would be a
caller-supplied cross-aggregate reference on a read that otherwise needs none. The field name says
which tier it answers. It is matched against the SELECTABLE set, never asserted from the
assignment alone, so a tenant default that has since been unpublished adds no phantom entry.

The cascade read is best-effort: an unreadable assignment store costs the caller the marker, never
the list.

### 503 over `{ data: [] }` when the dispatcher is unwired

Same posture as the selection gate, and for the same reason. `[]` would be a claim about what the
tenant has authored, when the truth is that this deployment cannot tell — and a caller that
believed it would stop selecting rather than retry.

### SDK

`useSelectableConsultationWorkflows()` in `@arcaai/vox` — no consultation id, because the set is
tenant-wide and is needed BEFORE a consultation exists. Fails open like `useConsultationWorkflow`,
with the same "never fail-inventive" rule: `null` ("we could not ask") stays distinct from `[]`
("the tenant has published none"). Collapsing them would tell a clinician their tenant has no
workflows because a request blipped. A malformed payload resolves to `null`, not to an empty
picker. `tenantDefault` is exposed for preselection.

**No `@arcaai/vox-node` change, deliberately.** That SDK has no consultation-open surface at all
(`ConsultationsResource` is `get` + `addContext` + `.summaries`), so a selectable-workflows read
there would describe a choice it cannot make. The route is business plane, so
`src/resources/admin/**` is correctly untouched and `gen:admin:check` reports no drift.

### Contradiction found while building this

The shipped 403 rationale — "already listed by `GET /workflows`, so hiding it would be theatre" —
holds for a `summarization` definition but NOT for an `stt` one: the exposure list refuses `stt`
too, so a 403 there discloses to a consultation-opener that an `stt`-palette slug exists. It is
SAME-tenant disclosure of a slug the caller already had to name, so it is minor and was left
alone rather than changed under a discovery ticket — recorded here rather than silently
inherited.

### Files

| File | Change |
|---|---|
| `packages/applications/.../workflow-dispatch/consultation-selection-policy.ts` | NEW — the shared predicate |
| `packages/applications/.../workflow-dispatch/dto/selectable-consultation-workflow.response.ts` | NEW — the four-field response |
| `packages/applications/.../workflow-dispatch/consultation-workflow-dispatch.service.ts` | gate + dispatch re-verify now call the predicate; `listSelectableForConsultation` added |
| `packages/applications/.../workflow-dispatch/IConsultationWorkflowDispatchService.ts` | declares the list |
| `packages/applications/.../consultation/consultation.service.ts` | `listSelectableWorkflows()` — CLS tenant, 400 without one, 503 unwired |
| `packages/applications/.../consultation/IConsultationService.ts` | declares it |
| `packages/domains/src/repositories/generated/core/WorkflowDefinitionRepository.ts` | `PUBLISHED_AND_ACTIVE` single-sourced |
| `apps/api/src/modules/consultation/consultation.controller.ts` | the route + `AUTH-NOTE` |
| `packages/agentic-sdk-v2/src/hooks/useSelectableConsultationWorkflows.ts` | NEW hook |
| `packages/agentic-sdk-v2/src/{types/consultationWorkflow.ts,core/constants.ts,core.ts,hooks/index.ts,types/index.ts,README.md}` | type, endpoint, exports, docs |

Tests: `consultation-workflow-discovery.task813.test.ts` (NEW, 11), additions to
`consultation.service.workflow-selection.task813.test.ts` (4) and
`consultation.controller.workflow-discovery.task813.test.ts` (6), and
`useSelectableConsultationWorkflows.task813.test.ts` (NEW, 6).

### Gates (worktree `lane-813-discovery`)

`domains build/test` 1848 passed · `applications build` · `applications test` 10318 passed ·
`api build` · `api test` 4025 passed · `vox build` · `vox typecheck` · `vox test` 4241 passed ·
`vox-node test` 244 passed · five artifacts regenerated ·
`gen:admin:check` no drift (52 areas / 404 routes / 371 schemas) ·
`api:portal:check` no drift (admin 609 / business 182) · `api:openapi:check` OK — both ratchets
IMPROVED (missing description 405→404, missing 4xx 289→288) · `pnpm lint` 40/40.

`pnpm test:e2e` NOT run (live infra is owned by the orchestrator and in use by a sibling lane).
The new route needs no matrix edit — `task-776-route-authz-matrix.spec.ts` is manifest-driven and
picks it up automatically.

### Also recorded (behaviour, documented not changed)

A selector sent to an ALREADY-OPEN consultation, or on a re-visit, is authorized but cannot take
effect — dispatch is create-only. Both cases are logged and the DTO documents it. The agent chose
not to add a route-specific rejection this ticket does not own; that is the right call, but it
means a caller can send a selector, receive `200`, and be governed by something else. If that
matters to an integrator it needs a deliberate 409, not a silent no-op.

| 2026-08-29 | Merged and closed. Gates on merged `dev-2.2`: applications 10489, api 4034, vox 4235, gen:admin no drift (53 areas/414 routes/379 schemas), portal no drift (admin 618 / business 181 ops), lint 40/40. Authorization gate verified by the orchestrator to run before both the existence lookup and the write; 404 hides existence, 403 only where `GET /workflows` already discloses. `inputSchema` absence independently confirmed against the `WorkflowDefinition` columns. |
| 2026-08-29 | §8 CLOSED — selectable-set discovery built on `lane-813-discovery` (owner decision: inside TASK-813, not a follow-on). `GET /consultations/workflows`, authorization declaration byte-identical to `POST /consultations/open`; gate, list and dispatch re-verification refactored onto one predicate (`consultationSelectionViolation`) with the visibility filter single-sourced in the repository; `useSelectableConsultationWorkflows()` in `@arcaai/vox`. Merge pending with the orchestrator. |
