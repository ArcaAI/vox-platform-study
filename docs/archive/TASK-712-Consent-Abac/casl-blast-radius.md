# CASL condition-evaluation blast-radius survey (TASK-712 Phase 5, Task 2)

| | |
|---|---|
| **Status** | Complete for the SHADOW decision this ticket is scoped to. Enforce-phase (Task 15) sign-off is explicitly NOT sought here. |
| **Scope** | Phase 5 only — the CASL fix that makes `conditions` on seeded policy rules actually evaluate. Does not touch consent/ABAC (Phases 0–4, 6), which are complete and out of scope for this document. |
| **Owner directive (R1, binding)** | shadow → measure → enforce, per `(action, subject)` pair, independently revertible. This document is the "shadow" input and the "measure" plan; it does not authorize enforce for any pair. |
| **Live query run against** | Postgres `hope` (local dev; container `hope-postgres`, PostgreSQL 18.4), 2026-08-16, via the `postgres` MCP connection (`inet_server_addr` `192.168.97.6`, port 5432). |

---

## 1. The problem, restated precisely

`packages/applications/src/authorization/unified-auth.guard.ts` (`handleJwtPostAuth`) evaluates:

```ts
allowed: ability.can(permission.action, permission.subject),
```

This is a **type-only** CASL call — two arguments, a bare subject *string*. CASL can only apply a
rule's `conditions` when given a **subject instance** (a third argument, or `subject(type, obj)`).
Passed a string, it matches the rule by type alone and never looks at `conditions`. The resolution
machinery (`PolicyEngine.resolveConditions`/`resolveRuleConditions`) is fully built and runs on
every `buildAbility()` call — the bug is purely that nothing downstream of it ever supplies an
instance to evaluate against.

`PolicyEngine.can(ability, action, subject, resource?)` (added earlier, `policy.engine.ts:274-282`)
**does** support the 3-argument instance form, and two call sites already use it manually:

- `apps/api/src/modules/consultation/consultation.controller.ts:263,312` — `verifyConsultationAccess`
  / `verifyConsultationOwnership` build `{ tenantId, doctorId }` by hand and call
  `this.policyEngine.can(ability, 'read'|'manage', 'Consultation', {...})` as a fallback AFTER the
  guard's type-only check already ran. This is the only production code that evaluates a seeded
  `conditions` object today, and it duplicates logic the guard should own.
- `apps/api/src/modules/rbac/permission-check.controller.ts:64,125` — a **self-service diagnostic**
  endpoint (`POST /rbac/check`) that lets a caller supply an arbitrary `resource` and get an
  instance-aware verdict back. It answers "would I be allowed", it does not
  gate anything itself — but it means a caller can *already* observe a divergence between "what
  this endpoint says" and "what the guard actually enforces", which is worth knowing going in: the
  divergence this document measures is not entirely latent, a sufficiently curious caller can
  already see it.

---

## 2. Live query (pasted verbatim)

```sql
SELECT p.id, p.name, p.scope, r->>'action' AS action, r->>'subject' AS subject, r->'conditions' AS conditions
  FROM core."Policy" p, LATERAL jsonb_array_elements(p."rules") r
 WHERE jsonb_exists(r, 'conditions')
 ORDER BY subject, action;
```

Environment: `hope` (local dev Postgres), 2026-08-16. Totals:

| Metric | Value |
|---|---|
| `Policy` rows | 21 |
| Total rule entries across all policies | 105 |
| Rule entries carrying `conditions` | **82** |
| Distinct `(subject, action)` groupings carrying `conditions` | **65** |
| Groupings whose `conditions` reference something OTHER than `${context.tenantId}` alone (the real hazard set — see §4) | **16** |

(The ticket's own §2.1(c) cites "84 occurrences of `conditions`" from a grep of
`seed/01-policy.ts` — that is a textual grep of the source file, not a count of live rule objects.
The live-DB figure, 82, is the one that matters for blast-radius sizing: it is what
`createPrismaAbility` actually receives per request, after `resolveRule`/`resolveConditions` have
run. The 2-row gap is not a bug; the seed file's structure does not map 1:1 onto rule-object counts
in every case and re-deriving that mapping is out of scope here — the live figure is authoritative.)

### 2.1 All 65 `(subject, action)` groupings, with row counts

<details>
<summary>Full table (grouped by subject) — click to expand</summary>

| Subject | Action(s) | Rows | Condition shape |
|---|---|---|---|
| AgentTrajectory | read | 2 | `tenantId` only |
| AiModel | manage | 1 | `tenantId` only |
| AiTaskDefault | [read, manage] | 1 | `tenantId` only |
| ApiKey | [read, update, delete, list] | 1 | **`userId` + `tenantId`** |
| ApiKey | create | 1 | `tenantId` only |
| ApiKey | manage | 1 | `tenantId` only |
| AsrPipeline | manage | 1 | `tenantId` only |
| AuditLog | [read, list] | 1 | `tenantId` only |
| AuditLog | read | 1 | `tenantId` only |
| Consultation | [read, create, list] | 1 | `tenantId` only |
| Consultation | [read, list] | 2 | `tenantId` only |
| Consultation | [read, update, delete, list] | 1 | **`doctorId` + `tenantId`** |
| Consultation | create | 1 | `tenantId` only |
| Consultation | manage | 1 | `tenantId` only |
| Consultation | read | 1 | `tenantId` only |
| ConsultationContextSchema | manage | 1 | `tenantId` only |
| ContextItem | [read, create, list] | 1 | `tenantId` only |
| ContextItem | manage | 2 | `tenantId` only |
| ContextItem | read | 3 | `tenantId` only |
| Department | manage | 1 | `tenantId` only |
| DepartmentAgent | manage | 1 | `tenantId` only |
| DnaWritingStyleReport | manage | 1 | `tenantId` only |
| GlobalSetting | manage | 2 | `tenantId` only |
| HarnessAudit | read | 2 | `tenantId` only |
| HarnessEval | manage | 2 | `tenantId` only |
| HarnessPolicy | manage | 2 | `tenantId` only |
| HarnessWorkflow | manage | 2 | `tenantId` only |
| McpServer | manage | 2 | `tenantId` only |
| Media | [read, create, list] | 1 | `tenantId` only |
| Media | create | 1 | `tenantId` only |
| Media | manage | 2 (one is `tenantId`-only, one is **`tenantId` + `createdBy`**) | mixed |
| Media | read | 1 | `tenantId` only |
| Notification | [read, update] | 1 | **`targetUserId` only** |
| Notification | manage | 1 | `tenantId` only |
| PipelinePolicy | manage | 2 | `tenantId` only |
| PromptTemplate | [read, list] | 1 | `tenantId` only |
| PromptTemplate | manage | 1 | `tenantId` only |
| PromptUsageRecord | [read, list] | 1 | `tenantId` only |
| PromptVersion | manage | 1 | `tenantId` only |
| ResourceSubscription | manage | 2 (one `tenantId`, one **`targetUserId`**) | mixed |
| Role | [read, update, delete, list] | 1 | **`isSystemRole: false`** |
| Role | create | 1 | **`isSystemRole: false`** |
| Role | read | 1 | **`isSystemRole: true`** |
| Storage | create | 1 | `tenantId` only |
| Storage | manage | 1 | `tenantId` only |
| Tag | [read, create, list] | 1 | `tenantId` only |
| Tag | manage | 1 | `tenantId` only |
| Tenant | read | 2 | **`id` (= context.tenantId)** |
| Tenant | update | 1 | **`id` (= context.tenantId)** |
| TenantAllowedOrigin | manage | 1 | `tenantId` only |
| TenantIdentityProvider | manage | 1 | `tenantId` only |
| TenantNlpTaskInstructions | manage | 1 | `tenantId` only |
| TenantSttConfig | manage | 1 | `tenantId` only |
| TenantTelemetry | read | 1 | `tenantId` only |
| TenantTtsConfig | manage | 1 | `tenantId` only |
| User | [read, list] | 1 | `tenantId` only |
| User | [read, update] | 1 | **`id` (= user.id)** |
| User | manage | 1 | `tenantId` only |
| UserMedia | [read, list] | 1 | **`userId` only** |
| UserMedia | manage | 1 | `tenantId` only |
| UserProfile | [read, update] | 1 | **`userId` only** |
| UserRoleAssignment | manage | 2 | `tenantId` only |
| UserSettings | manage | 1 | **`userId` only** |
| UserVoiceProfile | manage | 1 | **`userId` only** |
| Webhook | manage | 1 | `tenantId` only |
| WebhookRunHistory | read | 1 | `tenantId` only |

</details>

---

## 3. The `tenantId`-only majority is (mostly) redundant, not dangerous

66 of the 82 rows condition on `{ tenantId: '${context.tenantId}' }` alone. The Prisma
`tenant-scope` `$extends` (`packages/database/src/extensions/tenant-scope.ts`) already injects
`tenantId` into every query for models in `TENANT_SCOPED_MODELS`, and every one of the subjects
above with a `tenantId`-only condition maps to a tenant-scoped model. Turning condition evaluation
on for these pairs would, in the *overwhelming majority of requests*, produce the same verdict the
guard already returns today — because the row could not have been read cross-tenant in the first
place.

**The danger this survey exists to name is the opposite of a security gap** (§3.3 of the ticket
plan): a *subject instance whose `tenantId` field is absent* — a partial Prisma `select`, a DTO
built by hand, a freshly-constructed (not-yet-persisted) entity — evaluates the condition to
**deny**, because `undefined !== '<tenantId>'`. Enabling instance evaluation naively would convert
every such call site into a new 403 for a legitimately-scoped request. This is exactly what R1
warns about, and it is why this ticket ships shadow-only.

Call sites that construct partial objects and pass them toward an ability check are the ones this
survey most needs to catch, and today there are exactly two production call sites doing
instance-aware `can()` at all (§1) — both hand-build the instance with `tenantId` present. No
call site was found that would pass a `tenantId`-less instance into `ability.can()` **today**,
because no call site does instance-aware evaluation outside those two. The hazard is therefore not
yet live; it becomes live the moment Task 15 (or an ad-hoc future PR) wires a *new* instance-aware
call site without checking this document first. That is precisely why Task 14 ships a resolver
mechanism that is **opt-in per route** rather than a blanket "resolve every subject automatically" —
see §6.

---

## 4. The 16 real hazard rows — identity-shaped conditions

These are the rows whose `conditions` reference something a bare tenant-scope filter does **not**
already enforce — `doctorId`, `userId`, `targetUserId`, `createdBy`, `isSystemRole`, or a
`Tenant`/`User` row's own `id`. These are the rules that, if evaluated, would actually **change**
who can do what — narrower than "any tenant member with `manage`", not just "same tenant".

| Policy | Subject | Action | Condition | What it WOULD restrict, if enforced |
|---|---|---|---|---|
| `api-key-own-manage` | ApiKey | read/update/delete/list | `userId = ${user.id}` (+ tenantId) | A user's own API keys only — currently anyone with the type-level grant sees every tenant key |
| `consultation-own-manage` | Consultation | read/update/delete/list | `doctorId = ${user.id}` (+ tenantId) | Own consultations only — **already partially enforced imperatively** by `verifyConsultationAccess`/`verifyConsultationOwnership` (§1); this is the one subject where the guard flip would converge with, not diverge from, existing behavior |
| `consultation-own-manage` | Media | manage | `createdBy = ${user.id}` (+ tenantId) | Own uploaded media only |
| `user-profile-own` | Notification | read/update | `targetUserId = ${user.id}` | Own notifications only |
| `user-profile-own` | ResourceSubscription | manage | `targetUserId = ${user.id}` | Own subscriptions only |
| `rbac-tenant-manage` | Role | read/update/delete/list/create | `isSystemRole = false` | Tenant admins may only touch tenant-defined roles, never system roles |
| `rbac-tenant-manage` | Role | read | `isSystemRole = true` | ...but MAY read system roles (view-only) |
| `tenant-full-access` / `user-profile-own` | Tenant | read/update | `id = ${context.tenantId}` | Caller's own tenant row only — functionally close to tenant-scope but on a model whose PK IS the tenant id, so there's no separate `tenantId` column to lean on |
| `user-profile-own` | User | read/update | `id = ${user.id}` | Own user row only |
| `user-profile-own` | UserMedia | read/list | `userId = ${user.id}` | Own media only |
| `user-profile-own` | UserProfile | read/update | `userId = ${user.id}` | Own profile only |
| `user-profile-own` | UserSettings | manage | `userId = ${user.id}` | Own settings only |
| `user-profile-own` | UserVoiceProfile | manage | `userId = ${user.id}` | Own voice profile only |

### 4.1 Route reachability for the 16 hazard rows (and their subjects generally)

Cross-referenced by grepping every `@Authorize`/`@CanRead`/`@CanList`/`@CanCreate`/`@CanUpdate`/
`@CanDelete`/`@CanManage`/`@CanAny`/`@CanAll` decorator in `apps/api/src/modules/**` (excluding
tests) for each subject string:

| Subject | Decorator-gated routes found | Reachable today? |
|---|---|---|
| ApiKey | `apps/api/src/modules/api-key/api-key.controller.ts` (10 decorated handlers) | **Yes** — every action in the table is decorator-gated |
| Consultation | `admin-consultation.controller.ts` (class `@CanManage`), `consultation.controller.ts` (`@Authorize(['create','Consultation'])` + the two imperative `policyEngine.can` fallbacks) | **Yes**, and partially already instance-aware (§1) |
| Media | **none** — zero occurrences of the literal `'Media'` anywhere in `apps/api/src` outside `packages/database`/`packages/domains` generated code and a media-service filter constant | **No route decorator reaches it.** `MediaService`'s own filter constant (`MEDIA_FILTER_MODEL`) is a query-builder concern, not an authorization check |
| Notification | `notification.controller.ts` (class `@CanManage('Notification')`) | **Partially** — the class grant is `manage`, and the hazard row is `[read, update]`; `manage` implies both in CASL's default rule expansion, so the SAME handlers are in scope, but no route separately requires `read`/`update` — worth Task-15-time verification that `manage` really does subsume them for this ability shape |
| ResourceSubscription | `resource-subscription.controller.ts` (class `@CanManage`) | **Yes** |
| Role | `roles.controller.ts` (9 decorated declarations naming `'Role'` — 1 class-level `@CanManage`, 8 handler-level, incl. `@CanAny(['read','Role'],['manage','Role'])`; two further handlers in the same file gate `'RolePolicy'`, a different subject) | **Yes** |
| Tenant | 13 files actually decorate `'Tenant'` (`tenant.controller.ts`, `my-tenant.controller.ts`, `my-usage.controller.ts`, `my-billing.controller.ts`, `my-entitlements.controller.ts`, several admin resync controllers). A 14th match, `admin-route-permission-audit.ts`, is a docblock EXAMPLE of `@CanManage('Tenant')`, not a real decorated route — excluded from the count | **Yes, heavily** — `Tenant` is the single most-decorated hazard subject; any enforce here needs the widest regression net of the 16 |
| User | `user-departments.controller.ts` and `user.controller.ts` (class-level `@CanManage('User')`); `user-departments-me.controller.ts` relies on the SAME class-level grant per its own doc comment rather than repeating it. `permission-check.controller.ts` is NOT decorator-gated on `'User'` — it is itself bare `@Authorize()` (auth-only) and does an IMPERATIVE, type-only `adminAbility.can('manage','User')` check inside the handler to decide whether the caller may query someone else's permissions — a third pattern, neither declarative-gate nor instance-aware | **Yes** (`user.controller.ts` / `user-departments.controller.ts`) |
| UserMedia | **none** | **No route decorator reaches it** |
| UserProfile | **none** in `apps/api/src/modules` — `apps/api/tests/e2e/authorization.spec.ts:489-509` asserts `[read,'UserProfile']`/`[update,'UserProfile']` permission *tuples* exist and behave, but that is the CASL ability layer, not a controller route; no controller currently declares `@Authorize([..., 'UserProfile'])` | **No production route decorator; covered only by an ability-level e2e assertion** |
| UserSettings | `user-settings.controller.ts` exists at `/user/me/settings`, but is gated with a **bare `@Authorize()`** (zero permission tuples) — `handleJwtPostAuth` short-circuits (`required.length === 0 → return true`) before `ability.can()` is ever invoked. Authorization for "own settings only" is enforced by the handler's own `resolveUserId()`, entirely OUTSIDE CASL | **The route exists, but the SEEDED POLICY RULE IS ORPHANED — CASL never runs for this controller at all today.** Enabling instance evaluation changes nothing here unless this controller is separately migrated onto `@Authorize(['manage','UserSettings'])` |
| UserVoiceProfile | `voice-profile.controller.ts` (5 decorated handlers, `@Authorize([...,'UserVoiceProfile'])`) | **Yes** |

Two subjects outside the 16-row hazard set are ALSO unreachable by any decorator in
`apps/api/src/modules` and are noted here for Task-15 planning completeness rather than re-listed
above: **AiModel** and **ContextItem** — the latter is heavily conditioned (6 rows across 3
policies) but every one of its rules is `tenantId`-only, so its unreachability is a lower-priority
finding than Media/UserMedia/UserProfile (also unreachable, and identity-shaped). **PromptUsageRecord**
and **PromptVersion** and **Tag** are likewise undecorated anywhere in `apps/api/src/modules`
(`tenantId`-only conditions, so — per §3 — low incremental risk even so).

**Reading this table honestly:** "unreachable" here means *no controller in `apps/api/src/modules`
carries a permission decorator naming that exact subject string* — it does not prove the resource
is unmanaged; `Media`/`UserMedia`/`UserProfile` etc. may well be reached through a differently-named
subject, a parent resource's `manage` grant, or a non-HTTP path this survey did not trace. Each
"no route decorator reaches it" line is a "not found by this grep", not a certified absence — the
one row traced to full certainty is **UserSettings**, where the mechanism (bare `@Authorize()`)
was read directly, not inferred.

---

## 5. Other `ability.can()` call sites (context, not gated by this ticket's guard change)

A handful of application-service methods call `ability.can()` directly, all type-only (2-arg), all
unaffected by Task 14's guard-level shadow wiring since they don't go through the guard:

- `packages/applications/src/services/apiKey/apikey.service.ts:1127` — `ability.can('manage', 'ApiKey')`
- `packages/applications/src/services/agentPromotion/agentPromotion.service.ts:344` — `ability.can('manage', 'DepartmentAgent')`
- `packages/applications/src/services/prompt-management/prompt-management.service.ts:1471` — `ability.can('manage', 'PromptTemplate')`

None of these pass a resource instance, so none of them are part of the divergence this survey
measures — they would need their own, separate migration if Task 15 ever wants them instance-aware.
Listed for completeness so a future reader doesn't have to re-discover them.

---

## 6. What Task 14 (this pass) actually built — SHADOW ONLY

Built, tested, merged into this pass (files: `packages/applications/src/authorization/unified-auth.guard.ts`,
`packages/applications/src/authorization/policy.engine.ts`, plus the barrel `authorization/index.ts`;
tests: `packages/applications/src/authorization/__tests__/casl-conditions.shadow.test.ts`, 12/12
passing):

1. **`PolicyEngine.evaluateShadowVerdict(ability, action, subject, instance)`** — pure comparison,
   no I/O. Computes the type-only verdict (`ability.can(action, subject)`, 2-arg — what
   `UnifiedAuthGuard` actually enforces) and the instance-aware verdict (`ability.can(action,
   subject, instance)`, 3-arg — what `conditions` would decide), and reports `diverged`.
2. **`PolicyEngine.recordShadowDivergence(action, subject, verdict, meta?)`** — a no-op when
   `!verdict.diverged`; otherwise increments the metric and logs the event named below.
3. **`@ResolveSubjectInstance(resolver)`** (`unified-auth.guard.ts`) — a new, **opt-in, per-route**
   decorator. `UnifiedAuthGuard` reads `SUBJECT_INSTANCE_RESOLVER_KEY` metadata via the reflector;
   if a route did not set it, **no resolver runs, no row is loaded, no shadow check happens** — the
   guard's behavior on every currently-shipped route is unchanged, because zero routes use the new
   decorator yet. This satisfies the ticket's explicit instruction: *"do not load rows implicitly
   on every request."*
4. **`UnifiedAuthGuard.runCaslShadowChecks(...)`**, invoked from `handleJwtPostAuth` right after
   `request.ability`/`userAbility` are set and BEFORE the type-only `results`/`allowed` computation.
   For each required permission with an opted-in resolver: resolves the instance, computes the
   shadow verdict, records it if diverged. **Never throws, never touches `allowed`** — proven by a
   dedicated test (`THE FULL PROOF, denied side`) that asserts the guard's thrown/returned outcome
   is byte-identical whether or not a divergence was recorded, in both the allow and the deny
   direction, and by a resolver-throws test proving a broken resolver cannot fail a real request.
5. **Metric**: `casl_shadow_divergence_total` (Prometheus `Counter`, labels `action`, `subject`,
   `direction` ∈ `{would_deny, would_allow}`), registered on the shared `prom-client` `register` —
   automatically scraped at `GET /metrics` the same way `optimistic_lock_conflict_total`
   (`apps/api/src/observability/metrics.ts`) already is.
6. **Structured log event**: `casl.shadow.divergence` (dotted, matching the existing
   `metering.shadow_report.*` convention from `shadow-metering.service.ts` — this codebase's other
   shadow-mode reconciler), logged via the guard's own `Logger.warn` with `{ action, subject,
   direction, typeVerdict, instanceVerdict, method, path }`.

**Deliberately NOT built this pass** (Task 15, untouched, per instruction):

- No route in `apps/api/src/modules` was decorated with `@ResolveSubjectInstance(...)`. The
  mechanism exists and is unit-tested; it is not yet wired to a single real endpoint, so
  `casl_shadow_divergence_total` will read **zero** in production until a follow-up ticket opts
  routes in one at a time (starting with the highest-value, lowest-risk pairs — see §7).
- No change to the guard's `allowed` computation. The type-only verdict is still the only thing
  that decides a request's outcome, for every route, unconditionally.
- `getAccessibleBy` (`policy.engine.ts`) still has zero production call sites — wiring it into list
  queries is explicitly Task 15's job, gated on a pair showing zero shadow divergence first.
- No `casl-conditions.enforce.test.ts` (that file name belongs to Task 15).

---

## 7. Recommended rollout order for Task 15 (measure → enforce), when it is scheduled

Not an instruction to start Task 15 — a plan for whoever does, informed by §3/§4:

1. **Wire `@ResolveSubjectInstance` onto the `Consultation` `read`/`manage` routes first.** It is
   the one hazard subject with an EXISTING imperative instance check
   (`verifyConsultationAccess`/`verifyConsultationOwnership`) to cross-validate against — any
   divergence here is either a bug in this survey or a bug in that imperative check, either way
   worth finding before touching anything else.
2. **Then the single-purpose "own resource" subjects with narrow blast radius and an
   uncontested owner semantic**: ApiKey, UserVoiceProfile, User (`id = user.id`),
   ResourceSubscription, Notification. These have a decorator-gated route today (§4.1) and a
   condition that should, by construction, never fire for a legitimate same-user request — so
   `would_deny` divergence here is a strong signal of a real bug (e.g. a route serving another
   user's row without the caller's own id in scope).
3. **`Role` (`isSystemRole`) and `Tenant` (`id = context.tenantId`) next** — both heavily decorated
   (§4.1), both worth the wider regression net BEFORE moving them off shadow.
4. **`UserSettings`/`UserProfile`/`UserMedia`/`Media` need their own reachability audit before
   shadow is even worth wiring** — §4.1 found `UserSettings`'s policy rule to be provably orphaned
   (bare `@Authorize()` never reaches CASL) and the other three to have no decorator-gated route in
   `apps/api/src/modules` at all. Wiring a resolver onto a route that never calls `ability.can()`
   produces no signal. Confirm reachability (or the intentional non-CASL mechanism, as with
   `UserSettings`) before spending effort here.
5. **`getAccessibleBy`** is wired into a list query only after its target resource's `read` pair has
   shown zero divergence for a measured period — never as part of the same change that first enables
   shadow for that pair.

Per R1, each pair above is its own decision, its own PR, and its own revert boundary — this
ordering is a suggestion for sequencing, not a batch to land together.
