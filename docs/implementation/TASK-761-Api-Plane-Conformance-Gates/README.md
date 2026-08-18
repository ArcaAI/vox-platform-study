# TASK-761 — API Plane Conformance Gates

| | |
|---|---|
| **Status** | Pending |
| **Owner** | Platform / Architecture |
| **Date** | 2026-08-18 |
| **Type** | infrastructure (enforcement; no behavioural change to any route) |
| **Source** | `docs/architecture/api-design-conformance-review.md` §3.6 ("Enforce in CI, not review"), with the specific gates named in §3.1 step 2 and §3.4 item 7 |
| **Evidence base** | `docs/architecture/api-controller-inventory.md`, `api-controller-groupings.md`, and the four existing boot audits in `apps/api/src/bootstrap/` |
| **Related tickets** | TASK-754 (WS owner binding — **landed**, commit `e3f3713fb`), TASK-755 (TTS origin + `tts_session` ownership, review §3.4 items 5-6), TASK-757 (admin ⇒ JWT-only; **G1 ships with it, this ticket is the umbrella**), TASK-758 (A1 exemption list; G3's justification markers come from it), TASK-759 (`/internal/*` posture + `SttInternalController` carve-out; G2's carve-out record), TASK-760 (business-plane URI normalization). Prior art: TASK-307 (`admin-route-permission-audit.ts`), TASK-632 (`api-key-scope-audit.ts`), TASK-708 (`admin-scope-audit.ts` + `auditInternalRoutesOffApiKeySurface`), TASK-742 (`api-key-surface-audit.ts`), TASK-712 (`consent-route-coverage-audit.ts`), TASK-737 (`require-internal-tenant-header` lint rule). |

---

## 1. Requirement Analysis

### 1.1 The ask

Every plane/auth rule in the conformance review is mechanically checkable. Today they are
review-enforced: nothing fails if a new controller is mounted under `admin/` with an API-key scope,
or under `internal/` without a service-token guard, or on the business plane with a
`@ForbidApiKey()` nobody justified. The review's §3.6 asks for boot-time/lint gates, and notes
that "the deny-by-default route audit already proves this pattern works."

That claim is verified: `apps/api/src/bootstrap/api-key-surface-audit.ts` (TASK-742) throws at
boot and terminates the process when any route declares neither `@RequiredScopes(...)` nor
`@ForbidApiKey()` (`:114-117`), and `main.ts:318` calls it during bootstrap. Five audits already
run in that block (`main.ts:291-325`).

### 1.2 The four gates

| # | Gate | Verdict after reading the code |
|---|---|---|
| **G1** | An `admin/`-prefixed controller declaring `@RequiredScopes` ⇒ **FAIL BOOT** | **To build.** Ships with TASK-757 (it is meaningless before admin goes JWT-only); specified here as the umbrella. |
| **G2** | An `internal/`-prefixed controller not behind a service-token guard ⇒ **FAIL BOOT** | **ALREADY EXISTS** — `auditInternalRoutesOffApiKeySurface` (`api-key-scope-audit.ts:173-247`), wired at `main.ts:304`, including the `SttInternalController` carve-out. Delta is a *pinned record*, not a new gate. |
| **G3** | A business-prefixed route with neither `@RequiredScopes` nor a justified `@ForbidApiKey()` ⇒ **FAIL BOOT** | **HALF EXISTS.** The *presence* half is already platform-wide (`api-key-surface-audit.ts:84-109`). The *justification* half is a source comment, invisible to any runtime audit ⇒ lint. |
| **G4** | A WebSocket gateway performs an **owner** (not merely tenant) binding check | **To build, with an honest limit.** Behaviour cannot be proved by metadata; the gate can only pin a declaration + named regression tests. Ties to TASK-754 (landed) / TASK-755 (open). |

### 1.3 Boot audit vs. ESLint — the deciding criterion

Both mechanisms already exist in this repo, with a clean split:

- **A boot audit sees resolved Nest metadata** — class-level decorators merged onto handlers via
  `reflector.getAllAndOverride([methodRef, ControllerClass])`, the real registered path from
  `PATH_METADATA`, and the *actual* controller set in `ModulesContainer`. It sees exactly what
  `UnifiedAuthGuard` sees at request time (`api-key-surface-audit.ts:41-45` says so explicitly).
  It cannot see comments, formatting, or any file the runtime never loads.
- **ESLint sees source text** — comments, decorator call sites, string literals — one file at a
  time, with no knowledge of whether the class is registered anywhere or what a class-level
  decorator implies for a handler. Precedent: `no-controller-direct-prisma`,
  `no-direct-downstream-url-env`, `require-internal-tenant-header`
  (`packages/eslint-plugin-arcaai-internal/index.js:22-26`).

Rule of thumb this ticket applies: **if the property is a fact about the resolved application
graph, it is a boot audit; if the property is a fact about the text a human wrote, it is a lint
rule.** Per-gate reasoning is in §3.1.

### 1.4 Non-goals

- No change to any route's auth model. G1 is inert until TASK-757 flips admin to `@ForbidApiKey()`;
  G3's justification lint accepts what is already in the tree once the marker question (D-2) is
  settled.
- No new audit that duplicates an existing one. G2 is documentation + a pin, not a rewrite.
- No attempt to prove WS *behaviour* mechanically (§3.1 G4 states the limit explicitly rather than
  shipping a gate that looks stronger than it is).

---

## 2. Current State Evaluation

Everything below was read from source on 2026-08-18.

### 2.1 The existing enforcement layer (what to extend, not replace)

`apps/api/src/bootstrap/` — five audits, all called from `bootstrap()` in `apps/api/src/main.ts`:

| Audit | File | Wired at | What it pins | Shape |
|---|---|---|---|---|
| Deny-by-default route permissions (TASK-307) | `admin-route-permission-audit.ts` | `main.ts:291` | every HTTP route has `@Public()` or a permission decorator | `ModulesContainer` sweep |
| SDK day-1 scopes (TASK-632) | `api-key-scope-audit.ts:74-104` | `main.ts:297` | a **named list** (`SDK_DAY1_SCOPED_ROUTES`, `:44-72`) keeps `@RequiredScopes` | fixed list + plain `Reflector` |
| `/internal/*` off the API-key surface (TASK-708) | `api-key-scope-audit.ts:173-247` | `main.ts:304` | every `/internal/*` route is `@Public()` **and** carries a recognised service-token guard | `ModulesContainer` sweep |
| `/admin/*` scope closure (TASK-708) | `admin-scope-audit.ts:165-192` | `main.ts:309` | a **named list** (`ADMIN_SCOPED_CONTROLLERS`, `:98-163`, 65 entries) keeps its exact `@RequiredScopes` value or `@ForbidApiKey()` | fixed list + plain `Reflector` |
| Platform-wide API-key surface (TASK-742) | `api-key-surface-audit.ts:59-118` | `main.ts:318` | **every** non-`@Public()` route declares `@RequiredScopes` or `@ForbidApiKey()` | `ModulesContainer` sweep |
| Consent coverage (TASK-712) | `consent-route-coverage-audit.ts` | `main.ts:325` | every `:patientId` route declares consent posture | `ModulesContainer` sweep |

Two structural facts this ticket depends on:

1. **The `ModulesContainer` sweep is a copyable idiom.** `api-key-surface-audit.ts:59-118` is the
   cleanest instance: iterate `modulesContainer.values()` → `moduleRef.controllers.values()` →
   `metadataScanner.getAllMethodNames(proto)` → skip anything without `METHOD_METADATA` → read
   metadata via `reflector.getAllAndOverride([methodRef, ControllerClass])` → build the full path
   with `readControllerPath` / `readMethodPath` / `joinPath` (`:120-143`). The path-prefix regex
   idiom is `INTERNAL_ROUTE_RE = /^\/(api\/v\d+\/)?internal\//` (`api-key-scope-audit.ts:139`).
2. **The two hand-listed audits deliberately do NOT scale.** `api-key-surface-audit.ts:30-39`
   states the division of labour: the named lists "catch a scope silently changing VALUE"; the
   sweep catches "a brand-new controller nobody added to a list". G1 is a *sweep*, and it is the
   generalization that stops `ADMIN_SCOPED_CONTROLLERS` from being the only thing standing between
   a new admin controller and an API-key scope.

### 2.2 G1 — admin prefix ⇒ no `@RequiredScopes`

Verified prefix census (`grep -rho "@Controller('admin/[^']*'" apps/api/src/modules`): **67**
`admin/`-prefixed `@Controller` declarations across **59 distinct prefixes** (several controllers
share one — `admin/tenants` ×4, `admin/users` ×3, `admin/settings` ×3, `admin/ai-models` ×2,
`admin/department-agents` ×2, `admin/pstudio` ×2). The review's scorecard counts 65 *controllers*;
the discrepancy is a counting basis, not a finding — it excludes classes closed by other means
(e.g. `ConsentGrantController` at `admin/consent-grants`, already `@ForbidApiKey()`).

`ADMIN_SCOPED_CONTROLLERS` (`admin-scope-audit.ts:98-163`) enumerates **64 entries**, of which
**exactly one** — `AdminImpersonationController` (`:114`) — expects `'FORBID'`; the other 63 expect
a concrete `admin:*` (or `webhook:event:write`, `:158`) scope.

So today, the admin-plane audit asserts the **opposite** of G1: it fails boot if an admin
controller *loses* its scope. After TASK-757 flips the plane to `@ForbidApiKey()`, every `expect`
value becomes `'FORBID'` and the list degenerates into a 64-line restatement of "all admin
controllers forbid keys" — which is precisely what a sweep expresses in one predicate.

Note `admin-scope-audit.ts` uses a **plain `Reflector` with no app context** (`:166`), because its
targets are known statically. G1 needs the app (to discover controllers it was never told about),
so it needs the `INestApplicationContext` sweep signature, not `admin-scope-audit.ts`'s current one.

### 2.3 G2 — internal prefix ⇒ service-token guard (already enforced)

`auditInternalRoutesOffApiKeySurface` (`api-key-scope-audit.ts:173-247`) already fails boot when an
`/internal/*` route is not `@Public()` (`:218-226`) or is `@Public()` with no recognised guard
(`:228-236`). The recognised guard set is a **closed allow-list**:

```
150: const RECOGNISED_SERVICE_TOKEN_GUARD_NAMES: ReadonlySet<string> = new Set([
151:   'InternalServiceTokenGuard',
152:   'HarnessServiceTokenGuard',
153:   'ServiceReleaseTokenGuard',
154: ]);
```

The `SttInternalController` carve-out already exists **and is already policed**:

```
168: const RESERVED_INTERNAL_SCOPE_CONTROLLERS: ReadonlySet<string> = new Set(['SttInternalController']);
170: const RESERVED_INTERNAL_SCOPE_PREFIX = 'internal:';
```

with the enforcement branch at `:205-216`: an exempted controller must still carry
`@RequiredScopes` under the reserved `internal:` root, or it becomes an offender. The controller
side matches — `apps/api/src/modules/internal/stt-internal.controller.ts:51-52`:

```
51: @RequiredScopes('internal:stt:worker')
52: @Controller('internal/stt')
```

The rationale (BUG-013: the STT worker presents `X-Internal-Service-Key` carrying a raw
`SERVICE_ACCOUNT` `ApiKey` value, `apps/stt/src/stt/worker.py:209`) is documented inline at
`api-key-scope-audit.ts:156-167`.

**Verified inventory of the five internal surfaces:** `internal/stt`
(`modules/internal/stt-internal.controller.ts:52`), `internal/effective-config`
(`modules/internal/effective-config.controller.ts:29`), `internal/consent`
(`modules/consultation/consent-internal.controller.ts:91`), `internal/harness`
(`modules/consultation/harness-internal.controller.ts:207`), `internal/service-releases`
(`modules/service-release/service-release-internal.controller.ts:20`).

**Therefore G2's real deliverable is a pin, not a gate:** nothing today stops someone adding a
second name to `RESERVED_INTERNAL_SCOPE_CONTROLLERS` and quietly re-opening the API-key path under
`/internal/*`. See §3.2 G2.

### 2.4 G3 — business prefix ⇒ scope or justified `@ForbidApiKey()`

The *presence* half is already platform-wide, not business-specific:
`api-key-surface-audit.ts:84-109` accepts `@Public()`, `@ForbidApiKey()`, or a non-empty
`@RequiredScopes(...)`, and fails boot otherwise (`:114-117`). It deliberately treats an empty
`@RequiredScopes()` as *undeclared* (`:93-98`).

The *justification* half does not exist. Census of business-plane controllers (non-`admin/`,
non-`internal/`, non-compat) carrying a class-level `@ForbidApiKey()` — **17 files**:

`ai` (`ai-inference/ai-inference.controller.ts`), `tenant` (`tenant/my-tenant.controller.ts`),
`rbac/check` (`rbac/permission-check.controller.ts`), `audio/pipelines`
(`pipeline/audio-pipeline-public.controller.ts`), `changelog` (`changelog/changelog.controller.ts`),
`auth` (`auth/auth.controller.ts`), `health` (`health/health.controller.ts`), `usage`
(`admin-usage/my-usage.controller.ts`), `dna-writing-styles`
(`dna-writing-style/dna-writing-style.controller.ts`), `user/me/departments`
(`user/controllers/user-departments-me.controller.ts`), `users`
(`user/controllers/user-roles.controller.ts`), `user/me/settings`
(`user/controllers/user-settings.controller.ts`), `voice-profile`
(`voice-profile/voice-profile.controller.ts`), `entitlements`
(`entitlements/my-entitlements.controller.ts`), `monitoring` (`monitoring/monitoring.controller.ts`),
`prompt-templates` (`prompt-management/prompt-template.controller.ts`), `billing`
(`billing/my-billing.controller.ts`).

**Discrepancy against the review's §3.3 wording, verified:** the review says to "require the reason
inline as an `// AUTH-NOTE:` (the marker already exists)". In the tree there are **two** markers
doing different jobs:

- `// AUTH-NOTE:` — the *privilege*-check marker mandated by `.claude/rules/05-nestjs-api.md`
  §"Imperative Privilege Checks": it flags a route whose decorator understates the real gate.
  Present in 10 non-test files under `apps/api/src`, of which only **2** are on the business plane
  (`dna-writing-style/dna-writing-style.controller.ts`, `prompt-management/prompt-template.controller.ts`).
- `// TASK-742 API-KEY-NOTE` — the *API-key classification* marker introduced by the TASK-742
  sweep, present on **18** controllers, including 16 of the 17 business-plane `@ForbidApiKey()`
  files above. Exemplar, `pipeline/audio-pipeline-public.controller.ts:10-18`:
  `"CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION … Reversing it is a one-line change to
  @RequiredScopes('<scope>') once the owner confirms a real API-key use case"`.

So business-plane `@ForbidApiKey()` is **already justified in prose** — with a different marker
than the review names, and one whose text says the classification is *provisional*. Requiring
`// AUTH-NOTE:` verbatim would mass-rewrite 16 correct comments into the wrong marker family.
Decision **D-2** (§3.0) settles this before any lint rule is written.

### 2.5 G4 — WebSocket owner binding

Three gateways, all registered as **providers**, not controllers:

| Gateway | Path | Declaration | Module registration |
|---|---|---|---|
| `SttWsGateway` | `/ws/stt/stream` | `modules/streaming/stt-ws.gateway.ts:208` | `modules/streaming/streaming.module.ts:91` (`providers`) |
| `TtsWsGateway` | `/ws/tts/stream` | `modules/speech/tts-ws.gateway.ts:104` | `modules/speech/speech.module.ts:32` (`providers`) |
| `SttCompatGateway` | `/stt` | `modules/stt-compat/stt-compat.gateway.ts:31` | `modules/stt-compat/stt-compat.module.ts:11` (`providers`) — **compat, out of scope** |

**This is the single most important structural fact for G4:** every existing audit walks
`moduleRef.controllers` (`api-key-surface-audit.ts:67`), so **no current gate sees a gateway at
all**. A WS gate must walk `moduleRef.providers` and read the `@nestjs/websockets` gateway metadata.

**State of the enforcement itself (changed since the review was written):**

- **STT is done.** Commit `e3f3713fb` ("enhance StreamSessionTenantBindingService to track user
  ownership") landed the owner invariant. `StreamSessionBinding` now carries
  `{ tenantId, userId }` with `userId: null` meaning "owner unproven"
  (`apps/api/src/common/stream-session-tenant-binding.service.ts:71-79`), and `rebindSession`
  refuses on mismatch instead of overwriting:
  `apps/api/src/modules/streaming/stt-ws.gateway.ts:746-763` — *"OWNER INVARIANT: a live session is
  never adopted by a different user … This line used to be an unconditional
  `session.userId = stored.userId`"*, closing the new socket `AUTH_FAILED` and leaving the incumbent
  connected; `:775-790` closes a superseded socket explicitly on a legitimate owner resume. The
  review's §4 sequencing table now marks order 1 **DONE**.
- **TTS is not.** `grep -n "origin\|Origin\|lookupBinding\|userId" apps/api/src/modules/speech/tts-ws.gateway.ts`
  returns **nothing** — no origin/CSWSH check, no binding lookup, no owner concept. That is review
  §3.4 items 5-6, owned by TASK-755.

So G4 is a **regression gate over work that is landing elsewhere**, not the fix itself. Its value is
that nothing today would notice if `stt-ws.gateway.ts:757` were deleted: no boot audit sees
gateways, and the review records that the same-tenant/different-user case "has never been covered"
by the existing `stt-session-cross-tenant.spec.ts` (which pins the *tenant* boundary only).

### 2.6 The lint side — what exists to extend

`packages/eslint-plugin-arcaai-internal/index.js:22-26` registers three rules; each lives in its own
file under `./rules/` and is wired into `packages/config-eslint/flat/core.js`. `apps/api` lints via
`packages/config-eslint/flat/nestjs.js`, which is "exactly the shared core: NO `only-warn`, so the
arcaai-internal architecture rules … are HARD ERRORS here" (`flat/nestjs.js:1-16`). Rules ship with
a colocated test in `packages/eslint-plugin-arcaai-internal/__tests__/<rule>.test.js`.
`rules/require-internal-tenant-header.js:1-45` is the closest model for a marker/justification rule:
it inspects an object literal's keys and accepts a set of sanctioned identifiers as proof.

---

## 3. Implementation Plan

### 3.0 Phase 0 — decisions (blocking)

| # | Decision | Why it cannot be defaulted |
|---|---|---|
| **D-1** | Does G1 forbid `@RequiredScopes` on admin controllers outright, or only *newly added* ones? | TASK-757 must remove all 64 concrete scope declarations for G1 to pass at all. Outright is the right answer, but it means G1 cannot merge before TASK-757 — sequencing, not policy. |
| **D-2** | Which marker justifies a business-plane `@ForbidApiKey()`: `// AUTH-NOTE:`, `// API-KEY-NOTE`, or either? | §2.4: 16 of 17 business `@ForbidApiKey()` controllers already carry `API-KEY-NOTE`, and only 2 carry `AUTH-NOTE`. The two markers mean different things (privilege understatement vs. API-key classification). Recommendation: **accept `API-KEY-NOTE` for G3** and leave `AUTH-NOTE` to its rule-05 meaning; a rule that accepts either would make the distinction meaningless. |
| **D-3** | Is `RESERVED_INTERNAL_SCOPE_CONTROLLERS` frozen at exactly one member, or may it grow with owner sign-off? | §2.3: nothing currently stops it growing. Recommendation: **frozen at one**, pinned by test, expandable only by editing the pin — which forces the discussion into review. |
| **D-4** | For G4, is the declaration registry authoritative (a new gateway must be added or boot fails), or advisory? | Recommendation: **authoritative**, same posture as `RECOGNISED_SERVICE_TOKEN_GUARD_NAMES` — a closed allow-list, so a new gateway cannot ship un-triaged. |

### 3.1 Mechanism per gate — recommendation and reason

| Gate | Home | Reason |
|---|---|---|
| **G1** admin ⇒ no `@RequiredScopes` | **Boot audit** (new sweep in `admin-scope-audit.ts`) | The predicate is "the *resolved* metadata on a *registered* controller whose *registered path* starts with `admin/`". Two of those three facts are runtime-only: class-level `@RequiredScopes` is merged onto handlers by `getAllAndOverride`, which lint cannot model, and a controller's path can come from a constant or a re-export. Lint would also flag a class that is never registered in any module. |
| **G2** internal ⇒ service-token guard | **Boot audit — already built** (`api-key-scope-audit.ts:173-247`). Add a **unit test pinning the carve-out set** | Same reasoning as G1 (guards are `GUARDS_METADATA`, read at `:249-253`). The only gap is that the exemption list is mutable prose; a test is the cheapest possible pin and needs no new machinery. |
| **G3** business ⇒ scope or justified forbid | **Split: boot audit (already built) + a new lint rule** | The presence half is resolved metadata ⇒ audit, and `api-key-surface-audit.ts` already enforces it platform-wide. The justification half is a **comment**, which is erased before any metadata exists — a boot audit physically cannot see it. This is the textbook lint case, and `require-internal-tenant-header` is the precedent for "prove the author declared intent in source". |
| **G4** WS owner binding | **Boot audit for the *declaration* + named behavioural regression tests for the *behaviour*** | Neither mechanism can prove a gateway "performs an owner check" — that is a behavioural property. What a boot audit *can* prove is that every class carrying `@WebSocketGateway` metadata appears in a `WS_OWNER_BOUND_GATEWAYS` registry (closed allow-list), so a new gateway cannot ship un-triaged. What proves the behaviour is a test per enforcement point. **State this limit in the audit's docstring** rather than naming the gate something that overclaims. A lint rule is the wrong home here: "checks the owner" has no reliable syntactic signature. |

### 3.2 Build order

1. **G3 lint rule** (`require-api-key-justification`) — independent of every other ticket; can land
   first and immediately. Add to `packages/eslint-plugin-arcaai-internal/rules/`, register in
   `index.js` (alongside `:22-26`), wire in `packages/config-eslint/flat/core.js` next to
   `require-internal-tenant-header`. Rule: a class- or method-level `@ForbidApiKey()` in a file
   under `apps/api/src/modules/**` must be preceded (within the same decorator block) by a comment
   matching the D-2 marker with non-empty prose after it. Report on the decorator node.
2. **G2 carve-out pin** — a test asserting `RESERVED_INTERNAL_SCOPE_CONTROLLERS` has exactly one
   member and it is `SttInternalController`, plus one asserting the five known `/internal/*`
   controllers all pass the existing audit. No production code changes. Cross-reference TASK-759,
   which owns the *decision* to keep or converge the carve-out; this ticket owns the *pin*.
3. **G4 declaration registry + audit** — new `apps/api/src/bootstrap/ws-gateway-owner-audit.ts`.
   Walk `moduleRef.providers` (not `.controllers`), detect gateway classes via the
   `@nestjs/websockets` gateway metadata key, and require each to appear in
   `WS_OWNER_BOUND_GATEWAYS` with an `ownerCheck: 'enforced' | 'compat-exempt'` classification and a
   `regressionSpec` path naming the test that proves it. Seed it with `SttWsGateway` (`enforced`,
   citing `stt-ws.gateway.ts:746-763`), `TtsWsGateway` (**`pending` until TASK-755 lands** — the
   audit must FAIL on `pending` in CI/production and warn in dev, or TASK-755 will be deferred by
   nobody noticing), and `SttCompatGateway` (`compat-exempt`, per review A3). Wire into `main.ts`
   after `auditConsentRouteCoverage(app)` (`main.ts:325`).
4. **G1 admin sweep** — new exported function in `apps/api/src/bootstrap/admin-scope-audit.ts`
   (`auditAdminControllersDeclareNoApiKeyScopes(app)`), copying the `ModulesContainer` walk from
   `api-key-surface-audit.ts:59-118` and the prefix-regex idiom from `api-key-scope-audit.ts:139`
   (`/^\/(api\/v\d+\/)?admin\//`). Wire into `main.ts` immediately after
   `auditAdminScopedControllers()` (`main.ts:309`). **Merges with or after TASK-757** — before that,
   it fails boot on every scope-declaring admin controller by design.
   Once G1 is live, `ADMIN_SCOPED_CONTROLLERS` collapses to the `'FORBID'` form; keep the list (it
   still pins that a *named* controller keeps its gate) but let G1 own the coverage half, exactly as
   `api-key-surface-audit.ts:30-39` describes the existing division of labour.

### 3.3 TDD test list (RED first, in this order)

| # | Test file | RED assertion (must fail before the implementation) |
|---|---|---|
| **T-1** | `packages/eslint-plugin-arcaai-internal/__tests__/require-api-key-justification.test.js` (new) | `RuleTester`: **invalid** — a controller with a bare `@ForbidApiKey()` and no marker comment reports `missingJustification`; a marker comment with no prose after the colon also reports. **valid** — the D-2 marker with prose; a `@RequiredScopes('x')` route with no marker; a file outside `apps/api/src/modules/**`. RED because the rule module does not exist (the require throws). |
| **T-2** | `packages/eslint-plugin-arcaai-internal/__tests__/require-api-key-justification.test.js` (same file) | **Real-tree case:** run the rule over the source text of `apps/api/src/modules/auth/auth.controller.ts` (business plane, `@ForbidApiKey()`, per §2.4 currently carries no `AUTH-NOTE`) and assert exactly one report under the D-2 marker choice. This is the test that decides whether D-2 lands as "accept `API-KEY-NOTE`" or as a 16-file comment migration — write it before the rule, and let it price the decision. |
| **T-3** | `apps/api/src/bootstrap/__tests__/api-key-scope-audit.test.ts` (extend) | `expect(RESERVED_INTERNAL_SCOPE_CONTROLLERS.size).toBe(1)` and `expect([...RESERVED_INTERNAL_SCOPE_CONTROLLERS]).toEqual(['SttInternalController'])`. RED today only if the constant is not exported — **export it** as part of this step (it is currently module-private at `api-key-scope-audit.ts:168`). The test then goes green and stays as the pin. |
| **T-4** | `apps/api/src/bootstrap/__tests__/ws-gateway-owner-audit.test.ts` (new) | (a) a synthetic `@WebSocketGateway()` class **not** in `WS_OWNER_BOUND_GATEWAYS` ⇒ audit throws naming the class; (b) a registry entry marked `pending` ⇒ throws when `NODE_ENV !== 'development'`; (c) the three real gateway classes are all classified. All RED (module does not exist). Build the fake-app helper from `api-key-surface-audit.test.ts:47-66`, **changing `controllers` to `providers`** — the existing helper's `Map` is keyed `controllers` and will silently find nothing otherwise. |
| **T-5** | `apps/api/src/modules/streaming/__tests__/stt-ws.gateway.owner-rebind.test.ts` (new or extend the existing gateway suite) | Behavioural regression named by `WS_OWNER_BOUND_GATEWAYS['SttWsGateway'].regressionSpec`: a rebind whose stored binding `userId` differs from the incumbent `session.userId` must close the NEW socket with `AUTH_FAILED` and leave the incumbent's socket open and mapped. GREEN today (`stt-ws.gateway.ts:746-763`) — this is the regression pin that makes deleting that branch fail a test, which is the entire point of G4. |
| **T-6** | `apps/api/src/bootstrap/__tests__/admin-scope-audit.test.ts` (extend) | Synthetic `@Controller('admin/things')` + `@RequiredScopes('admin:tenant:read')` ⇒ `auditAdminControllersDeclareNoApiKeyScopes` throws, naming the controller and the offending scope; `@Controller('admin/things')` + `@ForbidApiKey()` ⇒ does not throw; `@Controller('things')` + `@RequiredScopes(...)` ⇒ does not throw (business plane is G3's job, not G1's); `@Controller('api/v1/admin/things')` ⇒ still detected (the regex must tolerate an explicit prefix, exactly as `INTERNAL_ROUTE_RE` does — `api-key-scope-audit.test.ts:257` proves that case matters). All RED (function does not exist). |
| **T-7** | `apps/api/src/bootstrap/__tests__/admin-scope-audit.test.ts` (same file) | **Real-tree case:** run G1 over the actual admin controllers. RED until TASK-757 lands — today every admin controller except `AdminImpersonationController` declares a scope (63 of the 64 `ADMIN_SCOPED_CONTROLLERS` entries, plus any admin controller not on that list) — this test *is* the sequencing gate, and it should be written now and marked with the TASK-757 dependency rather than deferred. |
| **T-8** | `apps/api/src/__tests__/bootstrap-audit-wiring.test.ts` (new) | Assert `main.ts` calls all audits, i.e. the new functions are actually wired. Cheapest form: read `apps/api/src/main.ts` as text and assert each audit identifier appears in the bootstrap call block (the same file-as-text technique `controller-route-renames.test.ts` uses). RED for the two new audits. A gate that is never called is the one failure mode none of the other tests catch. |

---

## 4. Verification Criteria

- [ ] D-1..D-4 answered and recorded in §"Change History".
- [ ] `pnpm --filter eslint-plugin-arcaai-internal test` (or the repo's runner for that package) green — T-1, T-2.
- [ ] `pnpm lint` clean across the monorepo with the new rule active; **`apps/api` produces zero errors** (rules are hard errors there per `flat/nestjs.js:1-16`). Any pre-existing violation is fixed in the same MR or the rule is not merged.
- [ ] `pnpm test:unit` green — T-3, T-4, T-5, T-6, T-8.
- [ ] `pnpm api:build` green and **the API actually boots** (`pnpm test:up:api`): the new audits must not throw on the real tree, except T-7's documented TASK-757 dependency.
- [ ] `pnpm test:e2e` green — no route behaviour changed by this ticket, so any e2e delta is a defect in the gate, not in the specs.
- [ ] Each new audit carries a docstring in the house style: what it pins, **why boot-failure and not a warning**, and how it differs from the audits beside it (`api-key-surface-audit.ts:20-39` is the model). G4's docstring additionally states the limit from §3.1 — it pins declaration and named tests, not behaviour.
- [ ] `TtsWsGateway` is registered `pending` and the audit fails outside development, so TASK-755 cannot be silently dropped.
- [ ] The review is updated: append to §3.6 that G2 was already enforced, and that G3 splits audit/lint with the `API-KEY-NOTE` marker correction from §2.4.

---

## 5. Implementation Summary

pending

---

## 6. Change History

| Date | Change |
|---|---|
| 2026-08-18 | Created. Specified four mechanical conformance gates from `api-design-conformance-review.md` §3.6, modelled on the existing `apps/api/src/bootstrap/` audits. Verified against source: **G2 already exists** (`api-key-scope-audit.ts:173-247`, including the policed `SttInternalController` carve-out at `:168`), **G3's presence half already exists** platform-wide (`api-key-surface-audit.ts:84-109`) so only the justification half is new, **G4's STT half already landed** (commit `e3f3713fb`, `stt-ws.gateway.ts:746-763`) while TTS has no origin or owner check at all, and **gateways are Nest *providers***, invisible to every existing `moduleRef.controllers` sweep. Recorded the boot-audit-vs-lint split with a per-gate reason, and four blocking decisions (D-1 G1 sequencing, D-2 `AUTH-NOTE` vs `API-KEY-NOTE` — 16 of 17 business controllers already carry the latter, D-3 freezing the internal carve-out set, D-4 authoritative WS registry). Status: Pending. |
| 2026-08-18 | **Owner decision recorded — D-2 resolved: KEEP BOTH MARKERS, distinct meanings.** `// API-KEY-NOTE` = API-key classification (accepted by gate G3); `// AUTH-NOTE` = the rule-05 "decorator understates the real gate" case. The G3 lint accepts `API-KEY-NOTE` with non-empty prose, so the 16 existing business-plane comments stand as-is — **no comment migration**. A rule accepting either marker is explicitly rejected: it would collapse a distinction that answers two different questions. T-2 should therefore assert the no-migration outcome. D-1, D-3, D-4 remain open. |
