# TASK-641 — Tenant-managed allowed origins (Vox SDK CORS self-service)

| Field | Value |
|---|---|
| **Status** | `Review` — code-complete, all unit/component gates green, **uncommitted**. Two owner actions outstanding (§6). |
| **Classification** | `feature` (governance change) + `bugfix` (stale UI copy, seed defects) |
| **Created** | 2026-08-08 |
| **Branch** | `dev-2.1` |
| **Supersedes** | TASK-610 §1 Non-goals (tenant self-service deferred), **§4A.3** (Global `*` row), **§4C** (enforcement off by default) |
| **Related** | TASK-610 (the CORS control plane), TASK-616 (`RUN_SEED` opt-in gating — see H-2), TASK-417 (SUPER_ADMIN → GLOBAL_ADMIN) |
| **Ticket-number note** | `docs/implementation/` max 640, `docs/archive/` max 507 (both enumerated 2026-08-08). |

---

## 1. Requirement Analysis

**Requirement.** A tenant administrator integrating the Vox SDK must be able to register the browser
origins their own application is served from, without filing a request to a platform operator — and
the platform must actually *enforce* that list, out of the box, in every environment including local
development.

### 1.1 Functional requirements

| # | Requirement |
|---|---|
| **FR-1** | A `TENANT_ADMIN` may list / create / update / soft-delete allowed-origin rows **for their own tenant only**. |
| **FR-2** | A `TENANT_ADMIN` may register only **exact** origins. Any value containing `*` stays `GLOBAL_ADMIN`-only — on create **and** on update. |
| **FR-3** | **SYSTEM**-tenant rows stay `GLOBAL_ADMIN`-only regardless of role — a SYSTEM row is valid for *every* tenant. |
| **FR-4** | The screen states, from server-reported state, whether origin enforcement is on. |
| **FR-5** | `GLOBAL_ADMIN` retains today's full capability. No regression. |
| **FR-6** | **Enforcement is ON by default.** `origin.enforcementEnabled` defaults `true` — in every environment, for every tenant, with no row present and no opt-in step. *(Owner directive: "no default is off".)* |
| **FR-7** | **The seed is correct for all three tenants** and is what makes FR-6 safe. Local development works immediately after a standard bootstrap with no manual origin registration. |
| **FR-8** | **No env var participates in any CORS decision** — not as an allow-list, and not as a behavioural branch. *(Owner directive.)* |
| **FR-9** | **No CORS configuration lives in Vault.** Origins and the enforcement switch are tenant/platform *config*, not secrets. |

### 1.2 Non-goals

- **Domain-ownership verification** (DNS TXT / `.well-known`). Not required — §2.3 shows the binding
  guard already confines a grant to the granting tenant's own data.
- Replacing the hand-maintained public-suffix heuristic with a real PSL library. Still owed by
  TASK-610 §4A.2; FR-2 is what contains it meanwhile.

---

## 2. Current State Evaluation

### 2.1 What already works — do not rebuild

| Piece | Location | State |
|---|---|---|
| Model — one row per `(origin, tenant)` grant | `TenantAllowedOrigin`, `@@unique([origin, tenantId])` | Shipped (TASK-610 §4B) |
| Union resolution | `OriginRegistryService.tenantsFor()` / `.allows()` | Shipped |
| Admin CRUD API (OCC via If-Match) | [`tenant-allowed-origin.controller.ts`](../../../apps/api/src/modules/tenant-allowed-origin/tenant-allowed-origin.controller.ts) | Shipped |
| Console screen | [`allowed-origins-screen.tsx`](../../../apps/admin-console/src/features/allowed-origins/components/allowed-origins-screen.tsx) | Shipped, already `WorkingTenantGate`-wrapped |
| Pattern predicate | `isOriginPattern()` — [`origin-pattern.ts:163`](../../../packages/applications/src/services/origin-registry/origin-pattern.ts) | Shipped — **FR-2's hook point** |

### 2.2 Blockers

| # | Blocker | Evidence |
|---|---|---|
| **B-1** | `assertGlobalAdmin()` runs at the top of **every** controller handler. | `tenant-allowed-origin.controller.ts:150` |
| **B-2** | No role grants `manage:TenantAllowedOrigin`; only GLOBAL_ADMIN's `manage:all` reaches it. | `seed/01-policy.ts:54`; absent from `tenant-full-access` `:86-191` |
| **B-3** | Page is in the `(global)` route group; nav tier `10-19`, `required: [['manage','all']]`. | `(global)/allowed-origins/page.tsx`; `nav-config.ts:188` |
| **B-4** | Nothing surfaces `origin.enforcementEnabled`. | zero hits under `features/allowed-origins/**` |
| **B-5** | *(bug)* Empty state cites `CORS_ALLOWED_ORIGINS`, a variable TASK-610 §4A.1 **deleted**. Copy is false. | `allowed-origins-screen.tsx:225` |
| **B-6** | *(bug)* Descriptor default is `false`; no `GlobalSetting` row exists → enforcement is **off**. | `platform-ops.descriptors.ts:232-250`; DB query returns `[]` |
| **B-7** | *(bug)* `NODE_ENV === 'development'` gates a loopback allowance — **an env var branching a CORS decision**, contra FR-8. | `cors.config.ts:269` (`development_loopback`) |
| **B-8** | *(bug)* Seed has no `http://127.0.0.1:*` row. `http://localhost:*` has a **concrete** host pattern and does **not** match `127.0.0.1`. | `seed/11b-tenant-allowed-origins.ts:106`; `parseHostPattern` |

### 2.3 Why tenant self-service is safe (and was not when TASK-610 froze the decision)

TASK-610 chose global-admin-only under a model **that no longer exists**: `origin` then carried a
*global* unique index, so a tenant registering `localhost:5173` would have *taken it from* another
tenant. §4B replaced that with per-`(origin, tenant)` grants and **monotone union** resolution —
adding a grant can never remove another tenant's access. The rule outlived its reason.

Three layers already force a row's tenant, verified in code — FR-1 rests on this:

1. `tenantId` is read from **CLS**, never a DTO — `tenant-allowed-origin.service.ts:91,243,321`.
2. **Neither** request DTO declares `tenantId`, and the global pipe runs `forbidNonWhitelisted`.
3. `TenantAllowedOrigin` ∈ `TENANT_SCOPED_MODELS` — the Prisma extension filters reads and writes.

**A tenant admin therefore cannot forge, read, or steal another tenant's row today.** Relaxing the
controller gate exposes an already-correctly-scoped surface.

**Residual risk.** A tenant admin can register a hostile origin *for their own tenant*. Bounded by
`credentials: false` (a hostile page gets no cookies and must present a Bearer token it cannot read)
and by `OriginTenantBindingGuard`. The exposure is the tenant's own — the right blast radius for a
tenant-admin action. **Wildcards are the exception, and are why FR-2 exists**: TASK-610 §4A.2's own
mitigation for the incomplete public-suffix check reads *"a global admin approving a wildcard row
must check the suffix by hand."* A tenant admin cannot be that check.

### 2.4 The four directives, checked against the code

| Directive | Verdict |
|---|---|
| **Seed correct for all tenants** | ✗ Two defects — H-1 and B-8 below. |
| **Enforcement on by default, incl. local dev** | ✗ Default is `false` (B-6). Reverses TASK-610 §4C. |
| **No CORS config in Vault** | ✅ **Already true, no work.** Grep over `settings-registry/descriptors/**` returns zero vault/secret-tier entries touching origins. `TenantAllowedOrigin` is a plain `core` table (`db-config` tier); `origin.enforcementEnabled` is `global-kv` → `GlobalSetting`. Add a regression test so it stays that way. |
| **No env vars for any CORS config** | ◐ Mostly true — §4A.1 already deleted `CORS_ALLOWED_ORIGINS`. **One violation remains: B-7**, the `NODE_ENV`-gated loopback branch. |

### 2.5 Hazards these directives create — each needs a decision

> **H-1 — The Global `*` row makes CORS admission a no-op, and Global is NOT scratch data.**
>
> `has(origin)` is `tenantsFor(origin).size > 0`. The Global-owned `*` row matches everything, so
> `tenantsFor()` is never empty → **CORS admits every origin no matter what enforcement says**.
> Turning FR-6 on while that row exists buys nothing at the CORS layer; only
> `OriginTenantBindingGuard` would still be working, and Global itself stays wide open.
>
> TASK-610 §4A.3 left this open: *"does the Global tenant hold real patient data, or is it
> demo/scratch?"* **Answered empirically today: Global holds 21 users, 9 consultations, 18
> departments — more than ArcaAI.** It is a real tenant. The `*` row should be removed from the seed.
> **This reverses an explicit §4A.3 owner decision, so it needs your confirmation, not my assumption.**

> **H-2 — Enforcement-on by default + `RUN_SEED` opt-in = an unseeded environment locks out every
> browser origin, with no escape hatch.**
>
> TASK-616 made seeding opt-in (`RUN_SEED`, default `none`). Combine FR-6 (on by default), FR-8 (no
> env fallback), §4A.1 (no `CORS_ALLOWED_ORIGINS`), and removing B-7's dev branch, and an environment
> that skips the seed refuses **every** browser origin — recoverable only by direct DB access.
> **Mitigation (required, not optional): the origin rows must become bootstrap data that always runs,
> not opt-in demo seed** — same class as the SYSTEM tenant itself. This is what makes FR-7 the
> load-bearing requirement rather than a nicety.

> **H-3 — `failMode: 'open-to-default'` inverts meaning when the default flips.**
>
> The descriptor comment (`platform-ops.descriptors.ts:239-242`) argues open-to-default *because*
> "an unreadable control plane must NEVER fail into enforcement — that would turn a settings outage
> into a platform-wide browser outage." With the default `true`, that same `failMode` now fails
> **into** enforcement — precisely the scenario the comment warns about. The comment must be
> rewritten to state the new, deliberate trade rather than left contradicting the value beside it.

> **H-4 — `credentials` stays `false`.** No change, and worth stating so nobody "restores" it as a
> tidy-up. TASK-610 §4C.2 verified nothing needs cross-origin cookies (no `req.session` reader, SDK
> uses Bearer, SSO `state` is a signed JWT in the URL). Enforcement-on does not create a need for
> credentials; turning both on would re-open the cross-origin read primitive for any origin that *is*
> registered.

---

## 3. Implementation Plan

### 3.0 The one design decision worth arguing

**The wildcard gate belongs in the service, not the controller.** The controller cannot see the
*shape* of the value without parsing it, and the escalation path is `update`, not `create` — a tenant
admin with an exact row could otherwise `PATCH` its `origin` into `https://*.example.com:*`. Both
methods already funnel through `normalizeIncomingOrigin()`
(`tenant-allowed-origin.service.ts:34-47`), which is where the exact-vs-pattern branch is already
made. That is the seam.

This **changes TASK-610's stated contract** — `ITenantAllowedOriginService.ts:3-15` says the service
"does not itself enforce that boundary — the admin controller does." That doc gets rewritten in the
same commit, not left contradicting the code. Both the relaxed route and the new service check carry
a `// AUTH-NOTE:` marker per `05-nestjs-api.md`.

| Actor | Exact origin, own tenant | Wildcard | SYSTEM row |
|---|---|---|---|
| `TENANT_ADMIN` | ✅ CRUD | ❌ 403 | ❌ unreachable (tenant-scoped) |
| `GLOBAL_ADMIN` | ✅ | ✅ | ✅ |

### 3.1 Work by layer

No migration. No new model. No `ResourceType` addition (already at `ResourceType.ts:76`).

| # | Layer | Change | Drives |
|---|---|---|---|
| **1** | `packages/database` seed | Add `{ action:'manage', subject:'TenantAllowedOrigin', conditions:{ tenantId:'${context.tenantId}' } }` to `tenant-full-access`, copying the `TenantIdentityProvider` shape (`01-policy.ts:189`). | FR-1 |
| **2** | `packages/database` seed | **Remove the Global `*` row** (H-1, pending confirmation); **add `http://127.0.0.1:*`** as a SYSTEM row (B-8); confirm each tenant's rows against expectation; make `11b` **unconditional bootstrap data**, not `RUN_SEED`-gated (H-2). | FR-7 |
| **3** | `packages/applications` | Descriptor default `false` → **`true`**; rewrite the `failMode` rationale comment (H-3) and the now-inverted `description`. | FR-6 |
| **4** | `packages/applications` | Service: gate `isOriginPattern(raw)` → require `isSuperAdmin(this.requestUser)` on **both** create and update; refuse SYSTEM-tenant writes from non-global callers. Rewrite the `ITenantAllowedOriginService` doc. | FR-2, FR-3 |
| **5** | `apps/api` | Delete the `NODE_ENV === 'development'` loopback branch and its helper (B-7). Local dev now works via the seeded loopback rows from step 2 — that is the point of FR-7. | FR-8 |
| **6** | `apps/api` | Drop the blanket `assertGlobalAdmin()` from the five handlers; keep class-level `@CanManage('TenantAllowedOrigin')`, which now actually gates via step 1. Replace the class AUTH-NOTE. | FR-1 |
| **7** | `apps/api` | Expose enforcement posture read-only — see §3.2 decision. | FR-4 |
| **8** | `apps/admin-console` | Move `page.tsx` `(global)/` → `(tenant)/` (**URL unchanged** — route groups aren't in the path, so no `redirect()` shim owed). Retier nav to `30-49`, `required: [['read','TenantAllowedOrigin'],['manage','TenantAllowedOrigin']]`. Drop the `isElevated` early-return. | FR-1 |
| **9** | `apps/admin-console` | Enforcement banner (FR-4); suppress wildcard entry for non-elevated users with a stated reason (FR-2); fix B-5's stale copy. | FR-2, FR-4 |

**Why retiering is correct, not drift.** The screen already wraps `WorkingTenantGate` — it has always
been per-tenant data. Under `13-nextjs-apps.md` that made it the sanctioned "global-admin-only screen
over per-tenant data" sub-pattern *while it was global-only*. Once tenant admins reach it, tier
`30-49` is simply its correct home, and the `(tenant)` guard (`isElevated || TENANT_ADMIN`) admits
both audiences. One authoritative editor, as the rule requires.

### 3.2 Open decision — FR-4 read path

`origin.enforcementEnabled` is `global-kv` and **`globalOnly`**, so a tenant admin almost certainly
cannot read it via `admin/settings` (`settings-catalog.controller.ts:24`).

- **(A) Recommended** — add a computed `enforcementEnabled: boolean` to the allowed-origins list
  response, from `isOriginEnforcementEnabled()`. Leaks exactly the one fact needed, nothing else. No
  governance change.
- **(B)** Relax the descriptor to tenant-readable. Wider blast radius, touches settings governance.

### 3.3 TDD test list (RED first, in this order)

| # | Test | Asserts |
|---|---|---|
| T-1 | service · create | `TENANT_ADMIN` + exact origin → created, `tenantId` = CLS tenant |
| T-2 | service · create | `TENANT_ADMIN` + `https://*.x.org:*` → **403**; same as `GLOBAL_ADMIN` → created |
| T-3 | service · create | `TENANT_ADMIN` + bare `*` → **403** |
| T-4 | service · **update** | `TENANT_ADMIN` PATCHes an exact row's `origin` → pattern → **403** *(escalation path)* |
| T-5 | service · update | `TENANT_ADMIN` PATCHes only `label` on a pattern row → allowed |
| T-6 | service | SYSTEM-tenant write by non-global caller → refused (FR-3) |
| T-7 | controller | All five routes reachable by `TENANT_ADMIN`; cross-tenant id still **404** |
| T-8 | policy seed | New rule present; `tenant-ability.regression.test.ts` green *(uses `arrayContaining` — additive-safe)* |
| T-9 | **descriptor** | `origin.enforcementEnabled` default is `true` (FR-6) — pins the posture against a silent revert |
| T-10 | **cors.config** | **No `NODE_ENV` read anywhere in the CORS decision path** (FR-8) — source-level assertion, same style as TASK-610's `main.ts` bootstrap-log guard |
| T-11 | **governance** | No origin-related descriptor has a `vault`/secret tier (FR-9) — cheap, and locks the property in |
| T-12 | **seed** | `*` absent; `http://localhost:*` **and** `http://127.0.0.1:*` present as SYSTEM rows; idempotent re-run |
| T-13 | **registry** | With the seeded set and enforcement ON: `127.0.0.1:5173` admitted; an unregistered origin **denied** (proves H-1 is closed — impossible while `*` exists) |
| T-14 | screen | Tenant-admin session renders the grid; wildcard input suppressed with a reason |
| T-15 | screen | Enforcement banner from server state; stale `CORS_ALLOWED_ORIGINS` copy gone (B-5) |
| T-16 | **e2e cross-tenant** | New `apps/api/tests/e2e/task-641-allowed-origins-cross-tenant.spec.ts` — tenant A cannot read/update/delete tenant B's row (404). **None exists today**; model on `ai-task-defaults-cross-tenant.spec.ts` |

### 3.4 Verification criteria

- `pnpm --filter @arcaai/applications build test`, `pnpm --filter @arcaai/database test`,
  `pnpm api:build`, `pnpm test:unit`, `pnpm test:e2e`,
  `pnpm --filter @arcaai/admin-console build lint test`, `pnpm lint` — green, output in §5.
- **Runtime proof on a freshly bootstrapped local stack** (this is the FR-6 + FR-7 gate, and the one
  that would have caught H-2): `pnpm setup:dev` → API boots with enforcement **on** → admin console
  and playground both work from `localhost` **and** `127.0.0.1` with no manual registration → an
  unregistered origin is refused with `origin_registry_miss`.
- Real `TENANT_ADMIN` login: registers an exact origin; refused a wildcard with a legible message;
  cannot see another tenant's rows; sees the enforcement banner.
- Both themes + axe pass on the retiered screen (`11-ux-ui-principles.md` §11).

### 3.5 Risks

| Risk | Mitigation |
|---|---|
| **Unseeded environment locks out all browser origins** (H-2) | Origin rows become unconditional bootstrap data (step 2); §3.4's fresh-stack run is the gate |
| Enforcement-on ships while the Global `*` row survives → FR-6 is cosmetic | T-13 fails while `*` exists — it cannot pass by accident |
| Settings-read failure now fails *into* enforcement (H-3) | Explicit owner acceptance + rewritten descriptor comment; DB-down already means app-down |
| Relaxing `assertGlobalAdmin()` over-widens a route | T-7 pins all five; the service gate (§3.0) is the backstop the controller no longer provides |
| A `TENANT_ADMIN` of **SYSTEM** gains platform-wide reach | FR-3 + T-6. None exists today — `tenant_admin` is scoped to *Global* |
| Deleting the dev-loopback branch breaks a workflow nobody enumerated | Seeded loopback rows cover it; `origin_registry_miss` makes any gap one grep away |

### 3.6 Sequencing guard (inherited from TASK-610 §4.8, and now sharper)

**Seed before enforce.** Steps 2 must land and run in a target environment *before* step 3 takes
effect there. In a single release the seed must be ordered ahead of the gateway rollout. Flipping the
default first is a self-inflicted outage.

---

## 4. Implementation Summary

Status: **code-complete, one gate outstanding** (the e2e run — §4.4). Delivered by 10 parallel lanes
across three waves. 46 files changed.

### 4.1 Two plan corrections made during execution

1. **§3.1 said "no migration". That was wrong**, and the plan was written before H-2's mechanism was
   understood. Lane A proposed a `SEED_PHASES_ALWAYS_ON` flag but flagged honestly that it breaks the
   "no DB connection when `RUN_SEED` is unset" invariant and makes `RUN_SEED=none` not mean none.
   Its own investigation found the right precedent: **the SYSTEM tenant row is guaranteed by a
   migration** (`20260527000000_task_305_*` inserts it in SQL), not by the seed. Bootstrap-critical
   rows belong there. Delivered as `20260808160000_task_641_bootstrap_loopback_origins`; the seed
   keeps its idempotent upserts so the two reconcile. Verified mechanically (not by eye) that all six
   rows agree exactly across both files.
2. **Six loopback rows, not two.** Lane D refused to paper over a gap: the deleted
   `development_loopback` branch used `isLoopbackHost`, covering `localhost ∪ 127.0.0.0/8 ∪ ::1` on
   **either scheme**, while the seeded rows covered two exact hosts, http only. Added
   `https://localhost:*`, `https://127.0.0.1:*`, `http://[::1]:*`, `https://[::1]:*` — each verified
   against the real `normalizeOriginPattern` to confirm its canonical form is unchanged.
   **Residual gap:** `127.0.0.2`–`127.0.0.255` are uncovered and *cannot* be expressed — the grammar
   requires `*` as the leftmost label with a ≥2-label non-IP suffix. Pinned as a KNOWN-GAP test so it
   cannot be silently "fixed" by loosening the grammar; the remedy is registering the exact origin.

### 4.2 The security defect this ticket found — a live wildcard-injection bypass

Lane E, trying to defeat its own gate, found that **`normalizeOrigin()` could return an origin
containing `*`** — violating the one invariant its whole contract rests on. The raw guard
`raw.includes('*')` runs at line ~46; `new URL(raw)` is not called until ~52, and it percent-decodes
`%2A` and NFKC-folds fullwidth `＊` (U+FF0A):

```
normalizeOrigin('https://%2A.evil.com').origin === 'https://*.evil.com'
normalizeOrigin('https://＊.evil.com').origin  === 'https://*.evil.com'
```

`origin-registry.service.ts:447` dispatches a **stored** row to wildcard matching via
`isOriginPattern(storedOrigin)` — so a value admitted as "exact" would be matched at CORS admission
as a genuine wildcard, admitting every subdomain of the attacker's domain. **This predates TASK-641**
and affected `GLOBAL_ADMIN` writes and the seed path too, not just the new tenant-admin surface.

Fixed at source (Lane J) with a canonical re-check after parsing, plus Lane E's independent
service-level check retained as defence in depth. Lane J then cleared the adjacent vectors by
reasoning and test rather than assumption: `normalizeOriginPattern` is safe for two independent
reasons (`%` is in `FORBIDDEN_AUTHORITY_CHARS` checked pre-parse; and `canonicalizeHost` validates
LDH labels on the *canonicalized* output, where `*` is not a legal DNS label) — and critically its
ordering is already right, deciding `wildcard` on the raw host while running the ≥2-label floor,
IP-shape check and `isLikelyPublicSuffix` on the canonicalized suffix, so dot-folding cannot evade
them. Ruled out and pinned: `%2F`/`%3A`/`%40`/`%25` (throw), Unicode dot-folding (cannot introduce
`*`), tab-stripping against the loopback exemption, trailing-root-dot apex.

### 4.3 Second silent defect — a guard that had stopped guarding

`seed-origin-canonicalization.task610.test.ts` hand-mirrored the seed's origin list and round-tripped
only its own hardcoded array, so it **passed while three drifts accumulated** (the deleted `*`, the
missing `127.0.0.1`, the four new loopback patterns). No gate caught it. It now imports the seed's
real exported array, so it cannot drift again.

### 4.4 Verification — actual output

| Gate | Result |
|---|---|
| `vitest run apps/api/src` | **186 files / 2709 tests passed** |
| `pnpm --filter @arcaai/applications test` | **446 passed, 1 skipped / 8441 passed, 4 skipped** |
| `pnpm --filter @arcaai/database test` | **44 files / 1084 tests passed** |
| `pnpm --filter @arcaai/admin-console test` | **168 files / 1311 tests passed** |
| admin-console `lint` + `typecheck` + `next build` | clean; `/allowed-origins` still routes at the same URL |
| `tsc -p apps/api` / `lint` | 8 errors + 2 lint errors, **all pre-existing** — baseline-confirmed via `git stash --include-untracked`; none in a file this ticket touched |

**Outstanding — the e2e spec has NOT been executed.** `task-641-allowed-origins-cross-tenant.spec.ts`
(16 tests) is written, parses under `playwright test --list`, and is lint-clean, but was never run:
`pnpm setup:test` reached `prisma db push --force-reset`, which Prisma's own agent-safety gate
refuses without `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` carrying the user's literal consent.
The lane stopped rather than route around it — correctly. **This is an owner action** (§6).
Structural cross-check against the live controller/service/DTO source was done instead, but that is
not a substitute for a run, and this ticket does not claim it is.

Also not yet run: `migrate deploy` against a clean database. This dev DB is `db push`-managed —
`prisma migrate status` reports 80 migrations found, **all 80 unapplied**, `_prisma_migrations` empty
— so the new migration's SQL has never been executed anywhere. Quoting was verified mechanically
(84 single quotes = 42 literals = 6 rows × 7; 28 double quotes balanced) but that proves parsing,
not execution.

### 4.5 Per-lane delivery

| Wave | Lane | Tier | Scope |
|---|---|---|---|
| 1 | A | sonnet | Seed: `*` removed, `127.0.0.1` added, H-2 mechanism investigated |
| 1 | B | sonnet | RBAC grant on `tenant-full-access` |
| 1 | C | sonnet | Descriptor default → `true`; rewrote the now-inverted `failMode` rationale |
| 1 | D | opus | Deleted the `NODE_ENV` CORS branch; T-10 anti-regression guard; found the loopback parity gap |
| 2 | E | opus | Wildcard + SYSTEM gates on create/update/**delete**; **found the injection bypass** |
| 2 | F | sonnet | Controller relaxed; `GET /admin/allowed-origins/posture`; route-audit test |
| 2 | G | opus | Bootstrap migration; 4 more loopback rows; 20 stale-prose fixes; full gates |
| 3 | H | sonnet | Screen retiered to `(tenant)`/30-49; enforcement banner; wildcard affordance; B-5 fix |
| 3 | I | sonnet | e2e spec (16 tests) + T-11 Vault-governance test with planted-descriptor RED proof |
| 3 | J | opus | Normalizer bypass fixed at source; stale seed guard re-armed |

### 4.6 Judgement calls made by lanes, accepted

- **Lane E gated `deleteById` too**, beyond the plan's create/update. Correct — revoking a
  platform-wide SYSTEM grant is as much a platform action as adding one.
- **Lane E edited one file outside its ownership**: the TASK-610 suite's CLS fixture had no roles,
  which under the old controller-level gate made it *implicitly* global-admin. Made explicit
  (`roles: ['GLOBAL_ADMIN']`) with a comment. One line; leaving 9 tests red for another lane was worse.
- **Lane D kept the `NODE_ENV` read at `cors.config.ts:197`** — it gates log verbosity only, both
  branches `return allowed` unchanged, so it cannot move an origin between admitted and refused. T-10
  excises exactly that function by name and asserts over everything else, so a second env read
  anywhere still fails the guard. Verified by mutation, not argument: re-planting B-7's branch turned
  4 assertions red while the anti-vacuity self-test stayed green.
- **A tenant admin re-submitting a wildcard equal to the row's current value gets 403, not a no-op.**
  The gate runs before the same-value short-circuit. Conservative and correct.

---

## 6. Owner actions outstanding

1. **Run the e2e spec.** Needs your consent to Prisma's agent-safety gate for
   `db push --force-reset` on the *isolated test* database (port 5433, throwaway — not dev):
   `pnpm setup:test`, then `pnpm test:up:api` in one terminal and
   `pnpm test:e2e task-641-allowed-origins-cross-tenant.spec.ts` in another. The isolated test
   containers are already up and empty.
2. **Run `migrate deploy` against a clean database** before shipping — the bootstrap migration's SQL
   has never executed anywhere (§4.4). This is the row that prevents the lockout, so it is the one
   piece that most needs a real run.
3. **Commit.** Everything is uncommitted on `dev-2.1` (46 files). This repo has had uncommitted work
   destroyed by a concurrent session before.
4. **Decide on `127.0.0.2`–`127.0.0.255`** (§4.1) — currently uncovered and inexpressible as a
   pattern. Register exact rows only if you actually use them.

## 5. Change History

| Date | Change |
|---|---|
| 2026-08-08 | Ticket created. Traced the request to TASK-610's expired single-owner justification (§2.3); confirmed CLS-forced tenancy makes self-service safe. Scoped a service-level wildcard gate, an RBAC grant, a tier 10-19 → 30-49 move, and enforcement disclosure. Found B-5 and the absence of any allowed-origins e2e spec. |
| 2026-08-08 | **Implemented — 10 lanes, 3 waves, 46 files, status → `Review`.** All unit/component gates green (2709 + 8441 + 1084 + 1311). Two plan corrections: a bootstrap **migration** replaces the rejected `SEED_PHASES_ALWAYS_ON` approach (§4.1), and **six** loopback rows ship, not two. **Found and fixed a pre-existing security defect**: `normalizeOrigin()` could return an origin containing `*` because its raw guard runs before `new URL()` percent-decodes `%2A` / NFKC-folds `＊`, and stored rows are dispatched to wildcard matching by `isOriginPattern()` — so an "exact" origin could admit every subdomain of an attacker's domain (§4.2). Also re-armed `seed-origin-canonicalization.task610.test.ts`, which had silently stopped guarding the seed (§4.3). E2E spec written but **not executed** — blocked on Prisma's agent-safety consent gate (§6). |
| 2026-08-08 | **Owner directives folded in — FR-6…FR-9.** Enforcement default flips `false` → `true` (reverses §4C); seed must be correct for all tenants; no env var in any CORS decision; no CORS config in Vault. Verified: Vault is **already** clean (no work); env is clean **except** B-7's `NODE_ENV` loopback branch. Found B-8 (`http://localhost:*` does not match `127.0.0.1`). Raised four hazards: **H-1** the Global `*` row makes CORS admission a no-op **and Global is a real tenant** (21 users / 9 consultations / 18 departments — answers §4A.3's open question, reverses that decision); **H-2** enforcement-on + `RUN_SEED` opt-in = lockout with no escape hatch, so origin rows must become unconditional bootstrap data; **H-3** `failMode: open-to-default` inverts meaning under the new default; **H-4** `credentials` stays `false`. |
