# TASK-781 — CASL Instance-Enforcement Reachability

**Status:** Completed
**Type:** bugfix (security boundary / observability honesty)
**Base:** `feat/loop` @ `87d783b4f`
**Related:** TASK-712 (Consent/ABAC — shadow + enforce mode), TASK-779 finding F-1

---

## 1. Requirement Analysis

TASK-712 Phase 5 Task 15 shipped an ENFORCE plane for CASL instance conditions and listed
three pairs as enforced:

```ts
CASL_ENFORCED_PAIRS = { 'read:ApiKey', 'update:ApiKey', 'delete:ApiKey' }
```

TASK-779's e2e (`apps/api/tests/e2e/task-779-policy-boundaries.spec.ts`) proved by
observation that those three pairs are **structurally unreachable**:

- `ApiKeyController.resolveApiKeyInstance` loads the row through
  `IApiKeyService.fetchById`, which runs `assertKeyAccess` and throws **404** for a key the
  caller does not own.
- On exactly the request the enforce pair exists to deny, the resolver therefore THROWS,
  `UnifiedAuthGuard.runCaslInstanceChecks` swallows it on its documented fail-open path, no
  denial is produced, and the service's 404 is the answer.
- Where the resolver SUCCEEDS, the caller has already passed `assertKeyAccess`, so the
  instance verdict is necessarily `true`.

Net: the pair can never 403 and `casl_enforce_denial_total` can never increment.

The dangerous part is not the missing 403 (404 hides existence and is strictly stronger).
It is the **metric lying by construction**: a counter that reads zero because it *cannot*
fire is indistinguishable from one that reads zero because nothing diverged. Any future
"measure, then enforce" decision taken by reading that counter is vacuous.

### Requirements

| # | Requirement |
|---|---|
| R1 | No existence leak. Cross-tenant and non-owned reads MUST stay **404**. A fix that turns a 404 into a 403 is wrong (this is DEF-C3, already recorded for `UserVoiceProfile`). |
| R2 | Decide, with stated tradeoffs, what the enforcement plane should be for this subject class. |
| R3 | The metric must not lie. A pair that cannot fire must not be listed. A listed pair must be provably able to fire. A guard (test and/or boot audit) must fail when a listed pair is structurally unreachable. |
| R4 | Close the TASK-712 disclosed limitation: `runCaslInstanceChecks` applies ONE route-level resolver to EVERY required permission, so an OR-mode (`@CanAny`) route with an enforced pair could deny on one alternative while the other allows. Fix it or make it structurally impossible — not prose. |

---

## 2. Current State Evaluation

| Element | Location | State on base commit |
|---|---|---|
| Enforce list | `packages/applications/src/authorization/policy.engine.ts:113` | Three `ApiKey` pairs, all unreachable |
| Enforce metric | same file, `casl_enforce_denial_total` | Defined; cannot increment |
| Guard enforce path | `packages/applications/src/authorization/unified-auth.guard.ts:958` (`runCaslInstanceChecks`) | Correct mechanism; one route-level resolver applied to every required permission; `mode` never consulted |
| Resolver | `apps/api/src/modules/api-key/api-key.controller.ts:70` | Delegates to a 404-throwing accessor → fail-open on the deny case |
| Service-layer boundary | `ApiKeyService.assertKeyAccess` (`packages/applications/src/services/apiKey/apiKey.service.ts:1273`) | Enforces the SAME `{tenantId, userId}` boundary the seeded `api-key-own-manage` rule expresses, answering **404** |
| Boot audits | `apps/api/src/bootstrap/*`, wired in `main.ts`, pinned by `apps/api/src/__tests__/bootstrap-audit-wiring.test.ts` | Mature pattern to extend |

Key observation: for `ApiKey` the guard-level CASL rule and the service-level
`assertKeyAccess` express **the same boundary**. The service one is already shipped,
already tested, and answers with the safer status.

---

## 3. Decision — what the enforcement plane should be

### Option (a) — remove the `ApiKey` pairs; record the subject class as unsuitable  ✅ CHOSEN

`assertKeyAccess` already enforces `{tenantId, userId}` and deliberately answers 404. The
guard runs BEFORE both interceptors and services, so anything the guard denies pre-empts
that 404 with a 403. This is exactly DEF-C3 — the rule TASK-712 wrote for
`UserVoiceProfile` — and it generalises one step further than TASK-712 stated it:

> A subject whose ownership boundary is already enforced downstream with a deliberate
> 404 must not be enforced at the guard, whether that downstream enforcement lives in an
> INTERCEPTOR (`@TenantOwnedResource`) or in the SERVICE (`assertKeyAccess`). TASK-712
> checked only the interceptor half and concluded `ApiKey` was "safe to enforce at the
> guard specifically because `admin/api-keys/:id` carries no `@TenantOwnedResource`". The
> service-level assertion was the half it missed.

Cost: no guard-level 403 for `ApiKey`. That cost is zero in practice — the boundary is
enforced, just at a different layer and with a better status.

### Option (b) — raw repository read in the resolver (no ownership assertion)

Rejected. Three concrete costs, no benefit:

1. It opens a **second, unscoped data path into API keys inside the guard**, on the auth
   hot path, purely to compute a verdict. To see a row the caller may not see, the read
   must bypass the tenant-scoped client — i.e. the resolver becomes a genuine cross-tenant
   read living in `apps/api`.
2. If the verdict then surfaces as the guard's 403, it violates R1 (existence leak).
3. If instead the denial must surface as 404 (as the option itself concedes: "CASL narrows
   the SET but the interceptor/service owns the STATUS"), the guard verdict has **no
   observable effect at all** — the service already answers 404 on precisely that request.
   The counter would move, but it would be counting a decision that changed nothing. That
   is a differently-shaped dishonest metric, not a fix.

A guard cannot honestly own this boundary, because the correct answer (404) is a statement
about *existence*, and a guard that throws `NotFound` for a row that does exist and IS the
caller's own would be catastrophic whenever the verdict is wrong.

### Option (c) — what we add on top of (a)

Removing the pairs alone leaves the defect class open: the next pair added can be
unreachable in exactly the same way, and nothing catches it. So (a) is paired with two
structural changes:

1. **Reachability is declared, not assumed.** `@ResolveSubjectInstance` gains options:
   `{ subject, enforceGrade }`. A pair may only be enforced on a route whose resolver
   declares `enforceGrade: true` — an explicit attestation that the resolver returns an
   instance for rows the caller does NOT own (i.e. it does not delegate to an
   access-asserting accessor). A resolver that fails open on the deny case is, by
   definition, not enforce-grade.
2. **A boot audit** (`auditCaslEnforcePairReachability`) walks the real route table and
   refuses to start when a listed pair is structurally unreachable: no route declares it,
   or a declaring route has no resolver, or the resolver is not enforce-grade, or the
   declaring route is OR-mode.

With the list empty, that audit passes vacuously — so its own behaviour is pinned by unit
tests over synthetic route tables, which is where the "would this have caught F-1?" proof
lives.

---

## 4. R4 — the OR-mode / one-resolver-many-permissions gap

The base implementation reads the resolver once per route and applies it to **every**
required permission, and never consults `PERMISSION_MODE_KEY`. Two failure shapes:

| Shape | Consequence |
|---|---|
| OR-mode (`@CanAny`) route with an enforced pair | The guard's type-only verdict allows via alternative B, then the enforced denial from alternative A throws 403 — the route's own OR semantics silently become AND |
| AND-mode route with two subjects, one resolver | The single instance (shaped for subject X) is evaluated against subject Y's conditions and can produce a spurious `false` → wrongful 403 |

Closed at three levels (defense in depth):

1. **Guard, mode:** `runCaslInstanceChecks` now receives `mode`. In `'OR'` mode enforced
   denials are never produced (shadow recording continues); a debug event
   `casl.enforce.skipped_or_mode` records it.
2. **Guard, subject:** when the resolver declares a `subject`, its instance is only ever
   compared against permissions for that subject. An enforced pair whose subject the
   route's resolver does not declare produces no denial.
3. **Boot audit:** a route that declares an enforced pair in OR mode is a boot failure, so
   the combination cannot be shipped in the first place.

---

## 5. Implementation Plan (TDD — RED first)

| # | Step | Verify |
|---|---|---|
| 1 | RED: unit test asserting `CASL_ENFORCED_PAIRS` is empty and `isEnforcedPair('read','ApiKey')` is false | fails on base |
| 2 | RED: unit tests for `assertCaslEnforcePairReachability` over synthetic route tables — including the exact F-1 shape (listed pair, route present, resolver present, NOT enforce-grade) | fails (function absent) |
| 3 | RED: guard tests — OR-mode enforced pair produces no denial; subject-mismatched resolver produces no denial; `casl_enforce_denial_total` actually increments when a denial IS applied | fails on base |
| 4 | GREEN: `ResolveSubjectInstance(resolver, options)`, resolver-descriptor metadata, guard mode/subject handling | |
| 5 | GREEN: remove the three `ApiKey` pairs; rewrite the block comment with the generalised DEF-C3 rule | |
| 6 | GREEN: `assertCaslEnforcePairReachability` + `auditCaslEnforcePairReachability` boot audit, wired in `main.ts` and added to `WIRED_AUDITS` | |
| 7 | Update `api-key.controller.ts` resolver docs (now shadow-only), TASK-712 + TASK-779 READMEs | |
| 8 | Run gates + the TASK-779 e2e (it asserts 404s and a still-flat counter — both remain true) | |

---

## 6. Implementation Summary

### Files changed

| File | Change |
|---|---|
| `packages/applications/src/authorization/policy.engine.ts` | `CASL_ENFORCED_PAIRS` emptied (three `ApiKey` pairs removed); the block comment rewritten to record finding 3 (unreachable AND unfixable at the guard) and the WIDENED DEF-C3 rule (interceptor **or service** 404 posture) |
| `packages/applications/src/authorization/enforce-reachability.ts` | NEW — `assertCaslEnforcePairReachability(pairs, routes)`, a pure function; rejects a pair no route declares, a pair with no enforce-grade resolver for its subject, and any pair on an OR-mode route |
| `packages/applications/src/authorization/unified-auth.guard.ts` | `ResolveSubjectInstance(resolver, { subject?, enforceGrade? })` now stores a DESCRIPTOR (bare functions still accepted); `runCaslInstanceChecks` takes `mode` — never enforces in OR mode — and applies a subject-declaring resolver only to that subject's permissions |
| `packages/applications/src/authorization/index.ts` | Exports `CASL_ENFORCED_PAIRS`, the enforce metric/event names, `assertCaslEnforcePairReachability`, `EnforceRouteDescriptor`, and the two new resolver types |
| `apps/api/src/bootstrap/casl-enforce-reachability-audit.ts` | NEW — `collectEnforceRouteDescriptors` (walks the live controller table via `ModulesContainer` + `Reflector`) + `auditCaslEnforcePairReachability` |
| `apps/api/src/main.ts` | Wires the audit after `auditWebSocketGatewayOwnerBinding` |
| `apps/api/src/__tests__/bootstrap-audit-wiring.test.ts` | `auditCaslEnforcePairReachability` added to `WIRED_AUDITS` |
| `apps/api/src/modules/api-key/api-key.controller.ts` | Resolver re-documented as SHADOW-ONLY and explicitly NOT enforce-grade; six routes declare `{ subject: 'ApiKey' }` |
| `apps/api/src/modules/rbac/roles.controller.ts` | Four routes declare `{ subject: 'Role' }` (several are `@CanAny`, i.e. OR mode) |
| Tests | NEW `casl-enforce-reachability.test.ts` (9), NEW `casl-conditions.enforce-mode.test.ts` (7), NEW `casl-enforce-reachability-audit.test.ts` (7); pins flipped in `casl-conditions.enforce.test.ts`, `casl-conditions.enforce-apikey.test.ts`, `casl-conditions.shadow.test.ts` |
| Docs | TASK-712 §7 Pass 6 §4 corrected + Change History appended; TASK-779 F-1 annotated RESOLVED |

### Evidence

```
pnpm --filter @arcaai/applications test      Test Files 521 passed | 1 skipped (522)   Tests 9580 passed | 4 skipped (9584)
pnpm --filter @arcaai/applications build     tsc — clean
pnpm --filter @arcaai/applications typecheck tsc --noEmit — clean
pnpm --filter @arcaai/api test               Test Files 251 passed | 2 skipped (253)   Tests 3889 passed | 10 skipped (3899)
pnpm --filter @arcaai/api lint               63 problems (0 errors, 63 warnings) — all pre-existing eslint-comments/require-description
pnpm --filter @arcaai/api typecheck          tsc --noEmit — clean
e2e task-779-policy-boundaries.spec.ts       6 passed (1.3m)
```

**E2E caveat, stated rather than glossed:** the gateway on :8968 was already running and was NOT
started by this ticket, so it was not rebuilt or restarted — the e2e therefore exercises the
PRE-change binary. That still proves what it needs to (the 404 posture and a flat
`casl_enforce_denial_total` are unchanged by this ticket, since the removed pairs never fired), but
it is not a runtime observation of the new boot audit. The audit is covered by
`casl-enforce-reachability-audit.test.ts` (built from the real controller metadata via the same
`Reflector` lookup the guard uses) plus the wiring test that asserts `main.ts` actually calls it.

---

## 7. Verification Criteria

- [x] `pnpm --filter @arcaai/applications test build typecheck`
- [x] `pnpm --filter @arcaai/api test lint typecheck`
- [x] `apps/api/tests/e2e/task-779-policy-boundaries.spec.ts` green
- [x] No 404→403 change anywhere (R1) — the change REMOVES the only path that could have produced one

---

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-20 | Ticket created; option (a)+(c) chosen; RED tests first (8 failures observed before any implementation). |
| 2026-08-20 | GREEN: pairs removed, reachability function + boot audit added, OR-mode and subject-scoping closed in the guard. All gates green; TASK-712/779 READMEs corrected. Status → Completed. |
