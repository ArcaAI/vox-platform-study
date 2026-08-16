# TASK-712 — Consent & ABAC

| | |
|---|---|
| **Status** | Partial — Pass 4 (2026-08-16): Phase 5's Task 2 (`casl-blast-radius.md`, a real live-query survey) and Task 14 (CASL condition-evaluation SHADOW mode — instrumented, unit-tested, wired to zero production routes) are now built, on top of Pass 3's Phase 4/WORM-writer/Phase-6-seed work and Pass 2's HTTP enforcement (ON BY DEFAULT). Phases 0–4 and 6 done; Phase 5 is now SHADOW-only (Task 15 — enforce + `getAccessibleBy` wiring — is explicitly NOT started, per the owner's R1 shadow→measure→enforce directive). See §7 Pass 4. |
| **Wave** | 1 · **Size** | XL |
| **Epic slug** | `consent-abac` |
| **Depends on** | — (independent; TASK-711 supplies the `PRIMED` state this gate naturally attaches to, but neither blocks the other) |
| **Design refs** | D3 (server-side validator is the safety boundary, never UI lockouts), D7 (async contract), [design.md](../../architecture/agentic-workflow-platform/design.md) §Plane 2 Wave 1 ("keyed on `(tenantId, externalPatientId)`; guard after `UnifiedAuthGuard` + non-HTTP `assertConsent` choke point for workers/activities/tools"), §Data flow ("Consent-gate node → `assertConsent` (fail → abort + audit)"), §Error handling ("Mid-session consent revocation → re-checked at every gated stage; new tool calls stop; audited") |
| **Findings closed** | A-01 · F-03, F-08's CASL half (`03-compliance-posture.md`) · unblocks A-10 (`retention-erasure`) and the erasure cascade, neither of which is delivered here |

---

## 1. Requirement Analysis

**What this delivers.** The consent and ABAC domain that does not exist anywhere in the codebase
today, plus the enforcement points that make it real:

1. A **`ConsentGrant`** model keyed on `(tenantId, externalPatientId, purpose)` — HOPE stores no
   patients, so the grant hangs off the external identifier the platform already carries.
2. **`assertConsent(...)`** — one non-HTTP choke point in `packages/applications`, callable from
   BullMQ workers, Temporal activities, tool layers, and the HTTP guard alike.
3. **`@RequiresConsent(purpose)` + `PatientConsentGuard`**, registered as `APP_GUARD` **after**
   `UnifiedAuthGuard` (it needs the authenticated principal and the resolved tenant) and before
   `RequiresIfMatchGuard`.
4. **Consent enforcement at the four gated stages** the reference names: prior-history retrieval,
   capture start, every MCP/tool call, and RAG retrieval.
5. **Revocation that blocks new calls mid-session**, propagated by invalidation rather than by TTL
   expiry, and audited on the WORM ledger using the two `HarnessAuditAction` members that already
   exist with zero writers.
6. **A separate, independently-gated sub-phase** that fixes CASL condition evaluation — today the
   guard compares a *type name*, so no seeded rule's `conditions` ever runs and `getAccessibleBy`
   has no callers. This changes authorization semantics platform-wide and therefore ships behind
   its own shadow-then-enforce rollout with its own tests.

**Invariants satisfied.** The `consent-abac` category holds 40 invariants
([02-conformance-matrix.md](../../architecture/consultation-session-workflow/assessment/02-conformance-matrix.md)
§5: 4 directly evidenced, 33 cluster-resolved, 3 unaudited). Mapping mechanism → invariant:

| Mechanism | Invariants |
|---|---|
| Consent gate evaluated before any priming or capture | INV-003, INV-004, INV-201 |
| Grant authorizes only within scope; restricted data omitted otherwise | INV-006, INV-009, INV-195 |
| Tool calls exceeding scope denied **and logged** (not best-effort) | INV-007, INV-067, INV-232, INV-338, INV-341, INV-371 |
| Revocation blocks new calls from `t_revoke`; gateway blocks scoped MCP calls | INV-010, INV-340, INV-437, INV-438 |
| Minimum-necessary default retrieval scope, audited | INV-015, INV-192, INV-193 |
| Scope widening is an explicit, new, audited retrieval — never silent | INV-016, INV-197 |
| Drug-interaction / medication tooling gated on consent | INV-058, INV-097, INV-101, INV-398 |
| Authorized prior history available at open, still identity- and minimum-necessary-bound | INV-198, INV-199, INV-200, INV-191 |
| Consent/identity re-validated after a policy-exceeding connectivity drop | INV-275 |
| Identity re-check before the candidate note is offered | INV-138 |
| Consent/ABAC failure ⇒ immutable audit event + session abort | INV-005, INV-008 (`audit` category, satisfied by the same mechanism) |
| Patient may grant, view, revoke, time-limit per purpose | INV-342, INV-344 — **partly**; the patient-facing surface is A-45 and explicitly out of scope (see §1 OUT) |
| Metrics tenant-isolated; patient drill-down authorization-gated | INV-309, INV-329 |

**Explicitly OUT of scope.**

- **The PHI sanitizer** (INV-026, INV-136, A-02) — categorized under `consent-abac` in the register
  but delivered by TASK-710 `phi-redactor`. This ticket must not build a redactor.
- **The patient-facing consent surface** (A-45, INV-342/344's UI half). No patient app exists in
  `apps/`. This ticket delivers the *record and the enforcement*; a clinician or tenant admin
  records the grant. Whether that satisfies the regulation is a compliance judgement, not an
  engineering one — see §6 Q1.
- **The erasure / revocation cascade** (A-10, INV-170, INV-335, INV-439-441). Revocation here
  **blocks future access** and is audited. Scrubbing scratch, caches, style exemplars, episodic
  memory and Qdrant is `retention-erasure`, which this ticket unblocks and does not deliver.
- **A general ABAC policy engine.** ABAC here is exactly two attributes evaluated against a grant —
  *purpose-of-use* and *minimum-necessary scope*. RBAC already exists and works.
- **The API-key `buildAbility` gap** (F-08: `handleApiKeyAuth` returns without building an ability,
  `unified-auth.guard.ts:164-213`). Adjacent and real, but it belongs to TASK-708
  `apikey-scope-verification`. This ticket must make the consent guard work on the API-key path
  *independently* of CASL, precisely because CASL is inert there — see §3 Pitfalls.
- **Removing the dead `CONSENT_*` enum members.** F-03's "smallest honest step" is superseded:
  this ticket gives them writers.

---

## 2. Current State Evaluation

Re-derived against the working tree on branch `feat/loop` (2026-08-16). Searches excluded
`.claude/worktrees/**`, `**/dist/**`, `**/node_modules/**`, `**/.venv/**`, `**/__pycache__/**`,
and `packages/database/src/generated/core-prisma-client/**`.

### 2.1 The four verified absences

**(a) No `Consent` model. No `Patient` model.** `packages/database/src/prisma/db_main/` contains
**38** `.prisma` files (the assessment cited 39 and 41 in different lanes; 38 is the live count).
`grep -rn "^model .*Consent\|^model Patient"` over that directory returns nothing. `Consultation`
carries `patientId String` with no FK and an explicit comment
(`consultation.prisma:13-14`): *"// Patient (external system - no FK)"*. Confirmed.

**(b) Two dead enum literals.** `HarnessAuditAction.CONSENT_GIVEN` and `CONSENT_WITHDRAWN` are
declared at `packages/database/src/prisma/db_main/harness.prisma:24-25`, inside the enum block at
`:19-37`. A repo-wide sweep finds exactly four non-declaration references, all of them passive:

| Reference | Nature |
|---|---|
| `packages/domains/src/enums/generated/HarnessAuditAction.ts:10-11` | generated mirror |
| `apps/admin-console/src/features/harness-ops/api/types.ts:16-17` | a filter dropdown offering a filter for rows that cannot exist |

Zero writers. Confirmed A-01's evidence and F-03's refinement.

**(c) The authorization guard compares a type name, so conditions never evaluate.**
`packages/applications/src/authorization/unified-auth.guard.ts:287`:

```ts
allowed: ability.can(permission.action, permission.subject),
```

`permission.subject` is a plain string carried by the decorator
(`packages/applications/src/authorization/decorators.ts:25-35`, `SetPermissions`). The *conditions
machinery is fully built and functioning* right up to this line: `PolicyEngine.buildAbility`
(`policy.engine.ts:119`) resolves template variables (`resolveConditions`, `:399-402`;
`resolveRuleConditions`, `:387-393`) and folds them into the CASL ability. But CASL can only
evaluate `conditions` against a **subject instance**; against a bare type string it matches the
type and stops. So every seeded `conditions` object is inert.

Blast-radius sizing: `packages/database/src/prisma/db_main/seed/01-policy.ts` contains **84**
occurrences of `conditions`, overwhelmingly `{ tenantId: '${context.tenantId}' }` on `manage`
rules (e.g. `:118` `Consultation`, `:119` `ContextItem`, `:154` `AuditLog`), plus a few
identity-shaped ones (`:152-153` `{ id: '${context.tenantId}' }` on `Tenant`). The `Policy.rules`
JSONB shape is documented at `rbac.prisma:71-87`.

**(d) `getAccessibleBy` has zero production call sites.** Defined at
`packages/applications/src/authorization/policy.engine.ts:203`. A repo-wide sweep returns only:
its own docblocks (`:83`, `:197`), its own unit test (`__tests__/policy.engine.test.ts:501,521`),
and a `vi.fn()` mock in `apps/api/src/modules/consultation/__tests__/consultation.controller.test.ts:108`.
Row scoping is `tenantId` injection alone (the Prisma `tenant-scope` extension). Confirmed.

### 2.2 What exists that this ticket MUST reuse

| Asset | Path (verified) | Reuse |
|---|---|---|
| Guard pipeline | `apps/api/src/app.module.ts` — `TieredThrottlerGuard` `:159-160`, `ClsGuard` `:163-164`, **`UnifiedAuthGuard` `:167-168`**, `TenantOwnedResourceSseGuard` `:176-177`, `OriginTenantBindingGuard` `:191-192`, **`RequiresIfMatchGuard` `:195-196`** | `PatientConsentGuard` registers between `:168` and `:195`. NestJS `APP_GUARD`s execute in registration order — insert the provider literally between those two entries |
| Boot-time route audit exemplar | `apps/api/src/bootstrap/admin-route-permission-audit.ts:18-20` (contract), `:61,99,108` (offender collection), `:117-121` (refusal) — refuses to start when a route lacks both `@Public()` and `REQUIRED_PERMISSIONS_KEY` | Copy the shape for the consent-coverage audit |
| Decorator family | `packages/applications/src/authorization/decorators.ts:17` `Public`, `:25` `SetPermissions`, `:59` `Authorize`, `:124` `RequiredScopes` | `@RequiresConsent(purpose)` follows `SetPermissions`' metadata-key pattern exactly |
| WORM ledger | `packages/applications/src/services/harness-audit/harness-audit.service.ts:76` `append(AppendHarnessAuditInput)`; input interface `:37-53` | Consent grant / revoke / denial events |
| WORM hash chain | `packages/domains/src/utils/harnessAuditHash.ts:17-42` `HarnessAuditHashInput` — note `consultationId: string` at `:19` is **non-nullable** | See §3 Pitfall 1 |
| Tenant guards | `packages/applications/src/common/tenant-guards.ts:56` `isSuperAdmin`, `:87` `assertEqualTenants`, `:165` `assertUserBelongsToTenant`, `:230` `assertParentInScope` | 404-over-403 posture |
| Settings-registry `failMode` | `packages/applications/src/services/settings-registry/registry.types.ts:121` (`failMode` is REQUIRED, documented `:114-120`); enforcement at `settings-registry.ts:28-32` | Consent tuning knobs declare `failMode`; the assertion itself is `closed` by construction, not by config |
| Hand-authored domain trio exemplar | `packages/domains/src/{entities,factories,mappers,models,repositories}/generated/core/AiProviderConnection*.ts` | The `ConsentGrant` trio |
| Treating-relationship logic | `packages/applications/src/services/consultation/consultation/consultation.service.ts:631-637` `doctorHasPatientRelationship`; controller wrappers `apps/api/src/modules/consultation/consultation.controller.ts:275`, `:324-331` `verifyPatientAccess`, `:296-317` `verifyConsultationOwnership` | The only per-patient check in the repo; the consent guard composes with it, does not replace it |
| Internal service-token surface | `apps/api/src/modules/consultation/harness-internal.controller.ts` (X-Service-Token, `.claude/rules/06-python-services.md` §Gateway Integration) | The precedent for a gateway-internal consent-assert endpoint |
| Cross-tenant e2e fixtures | `apps/api/tests/e2e/ai-provider-connections-cross-tenant.spec.ts`, `…/consultation-job-cross-tenant.spec.ts`, `tests/cross-tenant/fixtures.ts` | The 404 specs |

### 2.3 The four non-HTTP gated stages, located precisely

| Stage | Call site (verified) |
|---|---|
| Prior-history retrieval | `apps/api/src/modules/consultation/consultation.controller.ts:376-388` `GET consultations/patient/:patientId/history`; `:391-401` `getByPatientAndDate`; `:404-413` `GET :id/chain`. Service: `consultation.service.ts` `getPatientHistoryPaginated` / `getByPatientAndDate` / `getConsultationChain` |
| Capture start | `consultation.controller.ts:465-493` `POST :id/recording/start`; and the SDK's audio path terminates at `apps/api/src/modules/streaming/stt-ws.gateway.ts:195` (`@WebSocketGateway({ path: '/ws/stt/stream' })`), `handleConnection` at `:425` |
| MCP / tool calls | `apps/harness/src/harness/temporal/activities.py:802` `async def call_mcp_tool(...)`; the existing deny path is the allowlist at `:845` (`_effective_mcp_allowlist`, defined `:556`) raising `McpToolNotAllowed` at `:855-859` after recording a `STEP_TOOL_CALL` trajectory row |
| RAG retrieval | `apps/harness/src/harness/temporal/activities.py:1230` `async def retrieve_context(...)` → `apps/harness/src/harness/guides/retrieval/retriever.py:122` `retrieve(...)` → `qdrant_store.py:112` `hybrid_query(...)` |

`call_mcp_tool` is the ideal insertion point: it already has an ordered deny-before-network
sequence — (0) server-enabled, (1) allowlist, (2) PHI egress guard — each recording a trajectory
row before raising. Consent becomes step (0.5), *before* the allowlist, because a consent failure
is not a configuration problem and must be distinguishable in the audit.

---

## 3. Knowledge & Best Practices

### 3.1 Repo law that binds this work

| Rule | Section | Binding effect |
|---|---|---|
| `.claude/rules/02-database-prisma.md` | §Standard Model Field Template | `ConsentGrant` follows the exact section order: meta → multi-tenant → core → resource-status → audit → indexes → `@@schema("core")`. `id String @id @default(uuid(7))`, `version Int @default(1) @map("_version")`, `tenantId` NOT NULL with no default and no FK |
| `.claude/rules/02-database-prisma.md` | §Migration Workflow | Shadow-DB recipe; `-n` on the **package-level** script; review every statement |
| `.claude/rules/02-database-prisma.md` | §Migration Workflow (`@@unique` trap) | **`name:` on `@@unique` is the client-facing compound key, not the DB index name — the DB name comes from `map:`.** Getting this wrong drifted the ledger permanently in a prior ticket. Use `@@unique([tenantId, externalPatientId, purpose], map: "ConsentGrant_tenant_patient_purpose_key")` |
| `.claude/rules/02-database-prisma.md` | §Client Access Tiers | Add `ConsentGrant` to `TENANT_SCOPED_MODELS` in `packages/database/src/extensions/tenant-scope.ts` (`Consultation` sits at `:54`). It **does** carry soft delete, so it does **not** go in `MODELS_WITHOUT_SOFT_DELETE` (`packages/database/src/client.ts:95`) |
| `.claude/rules/03-domain-layer.md` | §Generated Code Discipline | `pnpm gen:model` scaffolds. `gen:entity`/`gen:factory` reconcile + check, never create. `gen:repository` is broken. **`pnpm gen:mapper` is destructive — never run it.** Hand-author entity/factory/mapper/repository following `AiProviderConnection*` |
| `.claude/rules/03-domain-layer.md` | §Adding a New Domain Model, step 4 | `ConsentGrant` emits sys-events, so `ResourceType` must gain the member in **both** `packages/database/src/prisma/db_main/audit.prisma` (+ `ALTER TYPE … ADD VALUE`) **and** `packages/domains/src/enums/generated/ResourceType.ts`. Skipping it makes every AuditLog INSERT throw and rolls the mutation into a 500. `packages/domains/src/enums/__tests__/resourceType.enum-parity.test.ts` is the guard |
| `.claude/rules/03-domain-layer.md` | §Adding a New Domain Model, step 5 | Register `ConsentGrantRepository` in `CoreDatabaseModule` — **providers AND exports** |
| `.claude/rules/04-application-services.md` | §Service Folder Pattern | `services/consent/` with `IConsentGrantService.ts` (symbol token + interface), `consent-grant.service.ts`, `.service.module.ts`, `.dto.mapper.ts`, `dto/`, `__tests__/`, `index.ts` — exemplar `services/department/` |
| `.claude/rules/04-application-services.md` | §Strict Rules | No `databaseService.client` in the service; no `new ConsentGrantEntity()`; DTOs on every accepted field (the global pipe runs `whitelist + forbidNonWhitelisted + forbidUnknownValues`); `broadcastSysEvent` after every mutation; cross-tenant → `NotFoundException` |
| `.claude/rules/05-nestjs-api.md` | §Global Request Pipeline | Order matters and is the registration order in `app.module.ts`. The consent guard needs the authenticated principal, so it is strictly after `UnifiedAuthGuard` |
| `.claude/rules/05-nestjs-api.md` | §Imperative Privilege Checks | Where the consent decorator understates the real gate, the route carries a standardized `// AUTH-NOTE:` marker. Denial **inside the caller's own tenant is a 403** (a privilege boundary); a **cross-tenant id is still 404** |
| `.claude/rules/06-python-services.md` | §Per-tenant config in a Python service | The default is gateway-resolved injection; `apps/guardrail/core/tenant_config.py` is the sanctioned exception because guardrail's callers are peer services. **Harness is not that case** — it already calls back into `apps/api` over `X-Service-Token`, so a gateway-internal endpoint is the idiomatic transport here, not a new pattern |
| `.claude/rules/06-python-services.md` | §Per-tenant config | Cache key **must** include the tenant: guardrail's `f"{task_key}::{tenant_id}"` is the pattern. Provider/model *selection* is fail-closed (503); consent is likewise fail-closed |
| `.claude/rules/09-infrastructure-devops.md` | §Config caches | (1) `tenantId` in every cache key. (2) **Invalidation is the propagation path; TTL is a bounded-staleness safety net.** Revocation publishes on an invalidate channel (`arca:secrets:invalidate` and `app-settings:invalidate` are the precedents); the TTL is the backstop, never the mechanism |
| `.claude/rules/01-development-workflow.md` | §Layer Dependency Chain | Database → Domain → Services → API, gates green in order |

### 3.2 Base practices this implementation follows

| Practice | Why here |
|---|---|
| **One choke point, two front doors** | `assertConsent` in `packages/applications` is the only place the decision is made. The HTTP guard and the internal endpoint are both thin callers. A second implementation is how the two `metadata.status` trackers happened |
| **Fail-closed by construction, not by configuration** | The assertion raises when a grant is absent, expired, or revoked. There is no `consent.enabled` kill-switch that turns the gate off — a kill-switch must default OFF (`settings-registry.ts`), which would default the gate *open*. The rollout lever is *coverage* (which routes carry the decorator), not *enforcement* |
| **Snapshot for latency + re-assert for revocation** | Injecting a resolved consent snapshot at workflow start is fast but structurally cannot honour mid-session revocation (INV-010/340/438). Re-asserting at every gated stage honours it but adds a hop. Do both: snapshot the fast path, re-assert at every *gated* stage, with invalidation-driven cache flush so the re-assert is usually a memory read |
| **Boot-time coverage audit over reviewer discipline** | The reason `@Public()` cannot be forgotten is `admin-route-permission-audit.ts`. The same mechanism is the only thing that keeps a new consultation route from silently shipping ungated |
| **Denial is a first-class audited event** | INV-007/338 require a *logged denial*, not a silent failure. A denial writes a WORM row before the exception propagates — the same ordering `approveSummary` uses for `ATTEST` |
| **CASL fix ships shadow-first** | Enabling condition evaluation converts 84 inert seeded rules into live predicates in one commit. Shadow mode (evaluate, log divergence, allow) turns an unbounded outage risk into a measured list |

### 3.3 Pitfalls specific to THIS ticket

1. **`HarnessAuditEvent.consultationId` is NOT NULL, and it is a hash input.** A consent grant
   recorded outside a consultation has no consultation id. Making the column nullable also changes
   `HarnessAuditHashInput` (`packages/domains/src/utils/harnessAuditHash.ts:19`), and the hash is
   computed over canonical fields — so a naive change **breaks chain verification for every
   existing row**. Required approach: keep the hash function's treatment of an absent
   `consultationId` byte-identical to today's for rows that have one (normalize `null`/`undefined`
   to the same serialization the current code produces for a present string only when present),
   and prove it with a test that re-verifies a chain of pre-existing seeded rows *unchanged*.
   Design this in Task 1; do not improvise it in Task 3. The alternative — a second consent-only
   ledger — is on the table and must be argued against explicitly, not skipped.
2. **Never run `pnpm gen:mapper`.** It rewrites mappers it has already processed and drops
   `FIELDS_NOT_WRITABLE = ['version']` before crashing. `ConsentGrant` is OCC-written (revoke is a
   versioned write), so its mapper **must** carry the strip. Recovery is
   `git checkout -- packages/domains/src/mappers/generated/core/`.
3. **The API-key path has no CASL ability at all** (F-08, `unified-auth.guard.ts:164-213`).
   `PatientConsentGuard` must therefore derive tenant and patient from the request and CLS —
   never from `request.ability`. If the guard needs an ability it will be a silent no-op on every
   API-key call, which is exactly the class of failure this ticket exists to remove.
4. **404-over-403 is not negotiable and cuts both ways.** A consent denial for a patient *in the
   caller's own tenant* is a **403** — it is a privilege boundary and hiding it would hide the
   very control being added. A cross-tenant `externalPatientId` is a **404**. Get these backwards
   and either the control is invisible or the tenancy posture leaks. Encode both as separate e2e
   assertions.
5. **`externalPatientId` is caller-supplied and unvalidated.** `Consultation.patientId` is a bare
   `String` (`consultation.prisma:13-14`). A consent lookup keyed on it will happily miss on a
   whitespace or case variant and fail closed — which is safe but produces a support nightmare.
   Normalize on write and on read through **one** shared function, and say in the design doc what
   normalization is applied (trim; case policy is HUMAN-GATED, see §6 Q3).
6. **Historical consultations have no grant.** Every consultation created before this lands fails
   a fail-closed check (04-target-architecture §Risks 7). That is a compliance decision, not an
   engineering one — §6 Q2 is HUMAN-GATED and Task 16's seed posture cannot be chosen without it.
7. **Do not let the guard live only in `apps/api`.** The gate must cover BullMQ workers, Temporal
   activities, and tool layers (design.md §Plane 2). A guard-only implementation looks complete and
   leaves the highest-risk callers ungated — exactly the shape of `harnessEnabled` governing only
   one of four generation entry points.
8. **Guardrail's tenant-config exception is precedent for *caching*, not for *DB access*.**
   `apps/guardrail/core/tenant_config.py` opens its own DB connection because it has no gateway.
   Harness does have one. Do **not** copy the DB-access half; copy the tenant-keyed cache key
   (`f"{task_key}::{tenant_id}"`) and the fail-closed posture.
9. **`SettingsRegistry` refuses to boot if a `secret`-sensitivity descriptor is not
   `failMode: 'closed'`** (`settings-registry.ts:28-32`). Any consent-related descriptor added here
   must declare `failMode` — it is a required field with no default by deliberate design
   (`registry.types.ts:114-121`).

---

## 4. Implementation Plan

Phase 0 is a **T4 design gate**: Phase 1 does not begin until both design documents are
owner-approved. Phases 1–4 are the consent domain. Phase 5 is the CASL sub-phase and is
independently revertible.

---

### Phase 0 — Design (T4)

#### Task 1 — Consent domain design document
- **Agent:** T4 · opus-5 · xhigh
- **Files:** create `docs/implementation/TASK-712-Consent-Abac/consent-design.md`
- **Approach:** decide and write down, with rationale:
  1. **Model shape.** Proposed `ConsentGrant`, in the field template's exact section order:

     ```prisma
     model ConsentGrant {
       // meta fields
       metaData Json?  @map("_metadata") @db.JsonB
       version  Int    @default(1) @map("_version")
       id       String @id @default(uuid(7))

       // multi tenant fields
       tenantId String

       // core (business) fields
       externalPatientId String
       purpose           ConsentPurpose
       scope             Json?          @db.JsonB   // minimum-necessary attributes
       grantedAt         DateTime
       grantedBy         String                      // recording user id
       grantMethod       ConsentGrantMethod
       evidenceRef       String?                     // object-store pointer to the signed artifact
       expiresAt         DateTime?
       revokedAt         DateTime?
       revokedBy         String?
       revocationReason  String?

       // resource status fields … audit fields …  (per template)

       @@unique([tenantId, externalPatientId, purpose], map: "ConsentGrant_tenant_patient_purpose_key")
       @@index([tenantId], name: "ConsentGrant_tenantId_idx")
       @@index([tenantId, externalPatientId], name: "ConsentGrant_tenant_patient_idx")
       @@schema("core")
     }
     ```

     Note this is **one row per purpose**, which differs from
     [04-target-architecture.md](../../architecture/consultation-session-workflow/assessment/04-target-architecture.md)
     §5's `PatientConsent` with `purposes String[]` and `@@unique([tenantId, externalPatientId])`.
     State the trade-off explicitly — per-purpose rows give per-purpose expiry and revocation
     (which INV-342 requires: *"grant, view, revoke, and time-limit consent per purpose"*), at the
     cost of more rows. **Granularity is HUMAN-GATED (§6 Q4)** — write both options and mark the
     recommendation.
  2. **Purpose vocabulary.** Propose `ConsentPurpose` and justify each member against an invariant:
     `AI_DOCUMENTATION` (INV-201, INV-004), `HISTORY_RETRIEVAL` (INV-015, INV-198),
     `EXTERNAL_TOOL_LOOKUP` (INV-007, INV-058, INV-371), `STYLE_LEARNING` (INV-017 — the DNA
     opt-in becomes a consent purpose rather than a boolean), `QUALITY_REVIEW` (INV-309).
     Also `ConsentGrantMethod` (`VERBAL_ATTESTED | WRITTEN | PORTAL | IMPORTED`). **HUMAN-GATED**.
  3. **Scope semantics.** What `scope` JSONB holds and how "minimum-necessary" is evaluated —
     concretely, a date-range bound and a source-system list for `HISTORY_RETRIEVAL`, matching
     INV-015/016/197 (*"widening retrieval scope must be an explicit clinician action, not an
     agent decision"*). Widening writes a **new** grant version and a new audit row; it never
     mutates in place.
  4. **Choke-point transport — the analysis the ticket must produce.** Compare, with the repo's own
     precedents cited:
     - **(A) Gateway-internal endpoint** (`POST /api/v1/internal/consent/assert`, X-Service-Token,
       following `harness-internal.controller.ts`). Pro: one implementation, live revocation,
       idiomatic — the harness already calls back this way. Con: an HTTP hop on the safety-critical
       path; puts the gateway on the harness's dependency chain for tool calls.
     - **(B) Injected assertion** (the TTS pattern from `.claude/rules/06-python-services.md`):
       the gateway resolves consent and passes a short-TTL signed snapshot into the workflow start
       payload. Pro: no hop, no new dependency. Con: **structurally cannot honour mid-session
       revocation**, which INV-010/340/438 require by name.
     - **(C) Peer-service DB read** (the guardrail exception). Con: guardrail's justification is
       that it has *no gateway caller*; harness does. Copying it here would create a second consent
       implementation in a second language — the precise failure the assessment names for legacy
       assurance.
     - **Recommended: A + B hybrid.** Snapshot at workflow start for the fast path; re-assert over
       (A) at every gated stage, backed by a tenant-keyed cache with a short TTL and a Redis
       invalidation channel `arca:consent:invalidate` published on revoke, per
       `.claude/rules/09-infrastructure-devops.md` §Config caches rule 2. Write the failure
       semantics: assert-endpoint unreachable ⇒ **deny** (fail-closed), degraded flag set,
       trajectory row recorded.
  5. **Revocation semantics.** Effective at `t_revoke` for **new** calls. Whether an already-running
     capture is torn down or allowed to finish is **HUMAN-GATED (§6 Q5)**; write both behaviours
     and the audit each produces.
  6. **WORM ledger decision.** Resolve Pitfall 1: nullable `consultationId` + hash-compatibility
     proof, or a separate ledger. Include the exact hash-input change and the compatibility test
     it demands.
  7. **Boot-audit rule.** State the exact predicate: every route under the consultation module and
     every route accepting a `patientId` parameter must declare `@RequiresConsent(...)` or an
     explicit `@ConsentExempt(reason)`. Enumerate the initial exemption list with a reason each.
- **Verify:** document exists; every one of the 40 `consent-abac` invariants appears at least once
  in a mechanism→invariant table (the 3 unaudited ones — INV-309, INV-329, INV-344 — are listed
  with an explicit "not closed here" where that is the honest answer); all HUMAN-GATED items are
  listed in one place; owner sign-off recorded before Task 3 starts.

#### Task 2 — CASL condition-evaluation blast-radius survey
- **Agent:** T4 · opus-5 · high
- **Files:** create `docs/implementation/TASK-712-Consent-Abac/casl-blast-radius.md`
- **Approach:**
  1. Enumerate every seeded rule carrying `conditions` from
     `packages/database/src/prisma/db_main/seed/01-policy.ts` (84 occurrences) and every
     `Policy.rules` row in a live environment:
     ```sql
     SELECT p.id, p.name, p.scope, r->>'action' AS action, r->>'subject' AS subject, r->'conditions' AS conditions
       FROM core."Policy" p, LATERAL jsonb_array_elements(p."rules") r
      WHERE r ? 'conditions'
      ORDER BY subject, action;
     ```
     Paste the output with environment and date.
  2. For each `(action, subject)` pair, list the routes that would begin evaluating conditions
     (cross-reference the `@Authorize`/`@CanXxx` decorators across `apps/api/src/modules/**`).
  3. Identify the **specific hazard**: most conditions are `{ tenantId: '${context.tenantId}' }`,
     which the Prisma `tenant-scope` extension already enforces — so evaluation is mostly
     *redundant*. The danger is the opposite of a security gap: a subject instance whose
     `tenantId` is not loaded (a partial projection, a DTO, a freshly-constructed entity) evaluates
     to **deny**. Enumerate every call site that would pass such an instance.
  4. Specify the rollout: **shadow** (evaluate against the instance, log every divergence from the
     current type-only verdict, return the current verdict) → **measure** (a named metric +
     structured log event) → **enforce** (instance verdict wins) → **`getAccessibleBy` wired into
     list queries**, one resource at a time. Name the metric and the log event.
- **Verify:** document exists with pasted query output; every affected `(action, subject)` pair
  mapped to at least one route or explicitly marked unreachable; owner sign-off before Task 14.

---

### Phase 1 — Database & domain

#### Task 3 — `ConsentGrant` schema, enums, and migration
- **Agent:** T3 · sonnet-5 · high
- **Files:**
  - create `packages/database/src/prisma/db_main/consent.prisma`
  - modify `packages/database/src/prisma/db_main/enums.prisma` (`ConsentPurpose`, `ConsentGrantMethod`)
  - modify `packages/database/src/prisma/db_main/audit.prisma` (`ResourceType` += `ConsentGrant`)
  - modify `packages/database/src/prisma/db_main/harness.prisma` (only if Task 1 chose the nullable-`consultationId` route)
  - modify `packages/database/src/extensions/tenant-scope.ts` (`TENANT_SCOPED_MODELS`)
  - create `packages/database/src/prisma/db_main/migrations/<timestamp>_task_712_consent_grant/migration.sql`
- **Approach:** implement Task 1's model exactly. Enums are PascalCase names with SCREAMING_CASE
  members in `enums.prisma`, `@@schema("core")`. `ResourceType` gains `ConsentGrant` in
  `audit.prisma` **and** an `ALTER TYPE … ADD VALUE` in the migration. Author with the shadow-DB
  recipe from `.claude/rules/02-database-prisma.md` §Migration Workflow; use `map:` (not `name:`)
  for the `@@unique` DB index name. Review every statement.
- **Verify:** `npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script`
  prints `-- This is an empty migration.`; `pnpm db:generate`;
  `pnpm --filter @arcaai/database test`.

#### Task 4 — Domain trio (hand-authored) + registration
- **Agent:** T3 · sonnet-5 · high
- **Files:**
  - `packages/domains/src/models/generated/core/ConsentGrantModel.ts` (generated)
  - `packages/domains/src/entities/generated/core/ConsentGrantEntity.ts` (hand)
  - `packages/domains/src/factories/generated/core/ConsentGrantFactory.ts` (hand)
  - `packages/domains/src/mappers/generated/core/ConsentGrantEntityMapper.ts` (hand)
  - `packages/domains/src/repositories/generated/core/ConsentGrantRepository.ts` (hand)
  - `packages/domains/src/enums/generated/{ConsentPurpose,ConsentGrantMethod,ResourceType}.ts`
  - `packages/domains/src/common/databaseServices/core/core.database.module.ts`
  - barrel `index.ts` at each level
- **Approach:** `pnpm gen:model` first — it is the only scaffolder. Then **hand-author** the other
  four, following `AiProviderConnection*` verbatim as the exemplar. The mapper **must** carry
  `FIELDS_NOT_WRITABLE = ['version']` + `stripNonWritableFields` (the model is OCC-written).
  The entity carries domain methods `isActive(now)` (granted, not expired, not revoked),
  `revoke(by, reason)` (through `setProperty`), and `coversScope(requested)`.
  Register `ConsentGrantRepository` in `CoreDatabaseModule` — **providers AND exports**.
  Add the mapper and repository barrel lines **by hand** (`gen:entity`/`gen:factory` only
  reconcile the entity/factory barrels). **Never run `pnpm gen:mapper` or `pnpm gen:repository`.**
- **Verify:** `pnpm gen:model:check`, `pnpm gen:entity:check`, `pnpm gen:factory:check` — no drift
  and schema coverage OK; `pnpm --filter @arcaai/domains build test`;
  `packages/domains/src/enums/__tests__/resourceType.enum-parity.test.ts` green (this is the gate
  that would otherwise turn every ConsentGrant AuditLog INSERT into a 500).

---

### Phase 2 — Application service & choke point (TDD)

#### Task 5 — RED: consent service and assertion tests
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `packages/applications/src/services/consent/__tests__/consent-grant.service.test.ts`
  and `…/__tests__/consent-assert.test.ts`
- **Approach:** mock repositories, `EventEmitter2`, `ClsService` per
  `.claude/rules/04-application-services.md` §Testing Requirements. Assert:
  - grant creation uses `ConsentGrantFactory` (never `new`), broadcasts `ResourceCreated`,
    appends WORM `CONSENT_GIVEN`;
  - revoke uses `updateWithVersion`, broadcasts `ResourceUpdated`, appends `CONSENT_WITHDRAWN`,
    and publishes on the invalidate channel;
  - `assertConsent` throws on: absent grant, expired (`expiresAt < now`), revoked
    (`revokedAt <= now`), purpose mismatch, scope narrower than requested;
  - a **denial writes its audit row before the exception propagates**;
  - cross-tenant lookup → `NotFoundException`, never `ForbiddenException`
    (reuse `tests/cross-tenant/fixtures.ts`);
  - the cache key contains the tenant id, and an invalidate message evicts it.
- **Verify:** `pnpm --filter @arcaai/applications test` — new suites FAIL. Paste it.

#### Task 6 — GREEN: `ConsentGrantService` + DTOs + mapper + module
- **Agent:** T3 · sonnet-5 · high
- **Files:** create `packages/applications/src/services/consent/` — `IConsentGrantService.ts`,
  `consent-grant.service.ts`, `consent-grant.service.module.ts`, `consent-grant.dto.mapper.ts`,
  `dto/{create-consent-grant.request,revoke-consent-grant.request,consent-grant.response,paginated-consent-grant.response}.ts`,
  `index.ts`; export from `packages/applications/src/index.ts`
- **Approach:** copy the folder shape of `packages/applications/src/services/department/` exactly —
  symbol-token DI (`export const IConsentGrantService = Symbol(...)`), `extends BaseService`,
  module imports `CommonServiceModule` + `CoreDatabaseModule`. Request DTOs carry
  `class-validator` decorators **and** `@ApiProperty`/`@ApiPropertyOptional` on every field
  (`forbidNonWhitelisted` rejects anything undeclared). Response DTOs render timestamps as ISO
  strings. Canonical CRUD flow per `.claude/rules/04-application-services.md`: factory → repository
  → `broadcastSysEvent` → DTO mapper.
- **Verify:** `pnpm --filter @arcaai/applications build test`.

#### Task 7 — The `assertConsent` choke point
- **Agent:** T3 · opus-4-8 · high
- **Files:** create `packages/applications/src/services/consent/IConsultationConsentService.ts`
  and `consultation-consent.service.ts`; modify `consent-grant.service.module.ts`
- **Approach:**
  ```ts
  assertConsent(input: {
    tenantId: string;
    externalPatientId: string;
    purpose: ConsentPurpose;
    scope?: ConsentScope;
    actor: { userId?: string; kind: 'user' | 'service' | 'workflow' };
    context?: { consultationId?: string; toolName?: string };
  }): Promise<void>;   // resolves on grant; throws ConsentDeniedException otherwise
  ```
  Plus `checkConsent(...): Promise<ConsentDecision>` for callers that must branch (the harness
  records a trajectory row rather than raising).
  - Fail-closed with **no** enable/disable switch (§3.2).
  - Cache keyed `` `${tenantId}::${externalPatientId}::${purpose}` `` — tenant-leading and
    mandatory (`.claude/rules/09-infrastructure-devops.md` §Config caches rule 1). Short TTL as a
    **backstop**; a Redis subscription on `arca:consent:invalidate` is the propagation mechanism
    (rule 2), mirroring `app-settings:invalidate` / `arca:secrets:invalidate`.
  - Every denial appends a WORM row before throwing (INV-007, INV-338).
  - Add `ConsentDeniedException` to `@arcaai/exceptions` and map it in `apps/api/src/filters/` to
    **403** — a privilege boundary, distinct from the 404 tenancy posture.
- **Verify:** `pnpm --filter @arcaai/applications test`; `pnpm --filter @arcaai/exceptions build`.

---

### Phase 3 — HTTP enforcement

#### Task 8 — RED: guard tests
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `apps/api/src/guards/__tests__/patient-consent.guard.test.ts`
- **Approach:** assert the guard resolves tenant + patient from CLS/route params (**never** from
  `request.ability` — Pitfall 3), calls `assertConsent`, converts a denial to 403 in-tenant and
  404 cross-tenant, and is a no-op on `@Public()` and `@ConsentExempt()` routes.
- **Verify:** `pnpm test:unit` — FAILS.

#### Task 9 — GREEN: `@RequiresConsent` + `PatientConsentGuard`, correctly positioned
- **Agent:** T3 · sonnet-5 · high
- **Files:** modify `packages/applications/src/authorization/decorators.ts` (+ its barrel and the
  `apps/api/src/decorators/index.ts` re-export); create
  `apps/api/src/guards/patient-consent.guard.ts`; modify `apps/api/src/app.module.ts`
- **Approach:** `@RequiresConsent(purpose, opts?)` and `@ConsentExempt(reason)` follow
  `SetPermissions`' metadata-key pattern (`decorators.ts:25-35`). Register the guard as `APP_GUARD`
  **between** the `UnifiedAuthGuard` entry (`app.module.ts:167-168`) and the
  `RequiresIfMatchGuard` entry (`:195-196`) — `APP_GUARD`s execute in registration order, so
  physical position in the providers array is the contract. Patient id resolution order:
  explicit `opts.patientIdParam` → `:patientId` route param → the loaded consultation's
  `patientId`. Prefer the decorator to declare it; never guess silently.
- **Verify:** `pnpm api:build`; `pnpm test:unit`; `pnpm lint` (hard errors in `apps/api`).

#### Task 10 — Wire the HTTP call sites + admin CRUD surface
- **Agent:** T3 · sonnet-5 · high
- **Files:** modify `apps/api/src/modules/consultation/consultation.controller.ts`;
  create `apps/api/src/modules/consent/{consent.controller.ts,consent.module.ts,__tests__/}`;
  modify `apps/api/src/app.module.ts`
- **Approach:**
  1. `@RequiresConsent(HISTORY_RETRIEVAL)` on `GET consultations/patient/:patientId/history`
     (`:376-388`), `getByPatientAndDate` (`:391-401`), and `GET :id/chain` (`:404-413`).
  2. `@RequiresConsent(AI_DOCUMENTATION)` on `POST :id/recording/start` (`:465-493`) and on
     `POST :id/prime` if TASK-711 has landed it.
  3. Admin CRUD at `@Controller('admin/consent-grants')` with class-level `@CanManage('ConsentGrant')`,
     following the admin-controller convention in `.claude/rules/05-nestjs-api.md` §Controllers.
     Revoke is a versioned write: `@RequiresIfMatch()` + `@ExpectedVersion()` copying
     `apps/api/src/modules/webhook/webhook.controller.ts:86,107`.
  4. Where the decorator understates the gate, add the standardized `// AUTH-NOTE:` marker.
  Note the consultation controller declares routes through `@ApiEndpoint()`, not `@Get`/`@Post` —
  verify the new guard actually fires on those routes rather than assuming it does.
- **Verify:** `pnpm api:build`; `pnpm test:unit`.

#### Task 11 — Boot-time consent-coverage audit
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `apps/api/src/bootstrap/consent-route-coverage-audit.ts`; modify
  `apps/api/src/main.ts`; create `apps/api/src/bootstrap/__tests__/consent-route-coverage-audit.test.ts`
- **Approach:** copy `apps/api/src/bootstrap/admin-route-permission-audit.ts` (contract at
  `:18-20`, offender collection at `:61,99,108`, refusal at `:117-121`). Predicate from Task 1 §7: every route
  in the consultation module and every route with a `patientId` parameter must declare
  `@RequiresConsent` or `@ConsentExempt(reason)`. The refusal message lists offenders with their
  controller and handler, exactly as the existing audit does.
- **Verify:** `pnpm test:unit`; and prove the audit *bites* — temporarily strip a decorator, boot,
  observe the refusal, restore. Paste both.

---

### Phase 4 — Non-HTTP enforcement

#### Task 12 — Gateway-internal assert endpoint + Python client
- **Agent:** T3 · sonnet-5 · high
- **Files:** modify `apps/api/src/modules/consultation/harness-internal.controller.ts` (or a sibling
  internal controller); create `apps/harness/src/harness/core/consent_client.py`; modify
  `apps/harness/src/harness/core/config.py`
- **Approach:** `POST /api/v1/internal/consent/assert`, behind the existing `X-Service-Token`
  middleware, taking `{tenantId, externalPatientId, purpose, scope?, context?}` and returning
  `{allowed, reason?, grantId?, expiresAt?}` — never PHI. The Python client follows the shape of
  the per-service `core/effective_config.py` clients described in
  `.claude/rules/06-python-services.md` (TTL + negative cache + single-flight), with:
  - cache key `f"{tenant_id}::{external_patient_id}::{purpose}"` — tenant-keyed, mandatory;
  - **fail-closed**: an unreachable endpoint denies and marks the run degraded;
  - settings on the existing `HARNESS_` prefix; `SecretStr` for the service token.
  Do **not** add a DB connection to the harness for this (§3.3 Pitfall 8).
- **Verify:** `pnpm api:build`; `pnpm test:unit`; `pnpm harness:test`, `pnpm harness:lint`,
  `pnpm harness:typecheck`; `uv lock` re-run at the repo root if dependencies changed.

#### Task 13 — Gate the tool and retrieval activities
- **Agent:** T3 · sonnet-5 · high
- **Files:** modify `apps/harness/src/harness/temporal/activities.py`,
  `apps/harness/src/harness/temporal/models.py`; modify the harness test suite
  (`apps/harness/src/harness/tests/`)
- **Approach:**
  1. `call_mcp_tool` (`:802`): insert the consent check as **step (0.5)** — after the
     server-enabled check (`:830-842`) and **before** the allowlist (`:845`), so a consent denial
     is distinguishable from a configuration denial in the trajectory. Record a `STEP_TOOL_CALL`
     row with `status=STATUS_ERROR`, `error_code="consent_denied"`, then raise a non-retryable
     `ApplicationError(type="ConsentDenied")` — mirroring the `McpToolNotAllowed` shape at
     `:855-859`. Satisfies INV-007, INV-067, INV-232, INV-338, INV-371, INV-438.
  2. `retrieve_context` (`:1230`): assert `HISTORY_RETRIEVAL` (or the purpose Task 1 assigns)
     before `retriever.retrieve(...)` (`guides/retrieval/retriever.py:122`). Satisfies INV-058,
     INV-097, INV-101, INV-398.
  3. Thread `external_patient_id` into `CallMcpToolInput` / `RetrieveContextInput` in
     `models.py`. **Workflows are deterministic** — every consent call is an *activity*, never
     inline workflow code (`.claude/rules/06-python-services.md` §Temporal).
  4. Any change to `workflows.py` must keep replay compatibility.
- **Verify:** `pnpm harness:test` including `test_replay_compat`; `pnpm harness:lint`;
  `pnpm harness:typecheck`. The harness CI suite is hermetic — stub the consent endpoint, do not
  reach a live gateway.

---

### Phase 5 — CASL condition evaluation (separate sub-phase, independently revertible)

> This sub-phase changes authorization semantics **platform-wide**. It has its own tests, its own
> rollout, and its own revert. Do not merge it in the same commit as Phase 1–4.

#### Task 14 — Shadow mode: evaluate conditions, log divergence, allow
- **Agent:** T4 · opus-5 · high
- **Files:** modify `packages/applications/src/authorization/unified-auth.guard.ts`; modify
  `packages/applications/src/authorization/policy.engine.ts`; create
  `packages/applications/src/authorization/__tests__/casl-conditions.shadow.test.ts`
- **Approach:** at `unified-auth.guard.ts:287`, keep `ability.can(action, subject)` as the
  **returned** verdict, and additionally compute the instance verdict where a subject instance is
  resolvable (CASL's `subject(type, instance)` helper). Log every divergence with the metric and
  structured event named in Task 2. Add the resolution hook — how the guard obtains an instance —
  as an explicit, opt-in per-route mechanism; do **not** load rows implicitly on every request.
  Tests must cover the Task 2 hazard directly: a subject instance missing `tenantId` must be
  recorded as a divergence, not silently denied.
- **Verify:** `pnpm --filter @arcaai/applications test`; `pnpm test:unit`; `pnpm test:e2e` — the
  **existing** `apps/api/tests/e2e/authorization.spec.ts` and `auth-guard-behavior.spec.ts` pass
  **unchanged**, proving shadow mode changed no verdict.

#### Task 15 — Enforce + wire `getAccessibleBy`
- **Agent:** T4 · opus-5 · high
- **Files:** modify `unified-auth.guard.ts`, `policy.engine.ts`; the list-query call sites named in
  Task 2; create `packages/applications/src/authorization/__tests__/casl-conditions.enforce.test.ts`
- **Approach:** flip the instance verdict to authoritative **only** for the `(action, subject)`
  pairs Task 2's shadow measurement showed zero divergence on. Pairs with divergence stay in
  shadow with an explicit list and an owner. Then wire `getAccessibleBy` (`policy.engine.ts:203`)
  into list queries **one resource at a time**, each with its own cross-tenant e2e assertion.
  A resource is not migrated until its shadow divergence is zero.
- **Verify:** `pnpm --filter @arcaai/applications test`; `pnpm test:unit`;
  `pnpm test:up:api` then `pnpm test:e2e`; the enforce-list and the remaining shadow-list are both
  recorded in `casl-blast-radius.md`.

---

### Phase 6 — Seeds and end-to-end

#### Task 16 — Seeds
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `packages/database/src/prisma/db_main/seed/21-consent-grant.ts`; modify
  `packages/database/src/prisma/db_main/seed/index.ts`; modify
  `packages/database/src/prisma/db_main/seed/01-policy.ts` (a `ConsentGrant` subject on the
  tenant-admin policy)
- **Approach:** phased and FK-ordered per `.claude/rules/02-database-prisma.md` §Seeds; reuse the
  constants in `seed/00-constants.ts`. Seed grants for the demo consultations in `09-consultation.ts`
  so the seeded environment is usable. **The legacy-grant posture for pre-existing production rows
  is HUMAN-GATED (§6 Q2) — the seed covers seeded data only and must not imply a production
  backfill.**
- **Verify:** `pnpm db:seed` then `pnpm --filter @arcaai/database test`; `pnpm test:db:seed`.

#### Task 17 — E2E specs
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `apps/api/tests/e2e/consent-abac.spec.ts`
- **Approach:** follow `apps/api/tests/e2e/ai-provider-connections-cross-tenant.spec.ts` for the
  tenant-fixture shape. Cover:
  1. `POST :id/recording/start` with **no** active grant → **403**, and a WORM denial row exists
     (INV-201, INV-005).
  2. `GET consultations/patient/:patientId/history` with no `HISTORY_RETRIEVAL` grant → 403; with
     one → 200 (INV-015, INV-198).
  3. **Revocation mid-session**: grant → start capture → revoke → the next gated call is **denied
     and audited**; the audit row is `CONSENT_WITHDRAWN` (INV-010, INV-340, INV-438).
  4. An **expired** grant (`expiresAt` in the past) denies (INV-342's time-limit).
  5. **Cross-tenant** `externalPatientId` on every consent route → **404**, never 403
     (`.claude/rules/05-nestjs-api.md`; P-10).
  6. Admin revoke without `If-Match` → 428; with a stale ETag → 412.
  7. Scope widening produces a **new** audited grant rather than mutating the existing one
     (INV-016, INV-197).
  8. The boot audit refuses to start when a consultation route declares neither decorator
     (asserted in Task 11's unit test; referenced here).
- **Verify:** `pnpm test:up:api` then `pnpm test:e2e`; paste output.

---

## 5. Acceptance Criteria

Evidence rule: **paste actual command output** for every box. "Done" without output is not accepted
(`.claude/rules/01-development-workflow.md` §Anti-Patterns).

- [ ] `consent-design.md` and `casl-blast-radius.md` exist, carry pasted live query output with
      environment + date, and are owner-approved. Every HUMAN-GATED item in §6 is answered in
      writing before the phase that depends on it starts — **Pass 4: `casl-blast-radius.md` now
      EXISTS with a live query pasted (environment `hope` dev Postgres, 2026-08-16) and a full
      `(action, subject)` → route reachability table; NOT yet owner-approved (that sign-off is a
      Task-15 precondition, not sought this pass). `consent-design.md` remains as Pass 3 left it —
      exists, updated, still not formally owner-approved**
- [ ] All 40 `consent-abac` register invariants appear in the design doc's mechanism table, with
      the ones not closed here explicitly marked — unchanged from Pass 1, still not done
- [x] Migration: `npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script`
      prints `-- This is an empty migration.`; `pnpm db:generate` — **Pass 3: verified for the new
      `20260816100536_task_712_consent_grant_worm_writer` migration** (see §7 Verification)
- [x] `pnpm gen:model:check`, `pnpm gen:entity:check`, `pnpm gen:factory:check` — no drift **and**
      schema coverage OK — **Pass 3: all three re-run, pasted below**
- [ ] `git diff --stat packages/domains/src/mappers/generated/core/` touches only
      `ConsentGrantEntityMapper.ts`, and that file contains `FIELDS_NOT_WRITABLE = ['version']`
      (proof `gen:mapper` was not run) — not re-verified this pass (Pass 3 touched no mapper file)
- [x] `packages/domains/src/enums/__tests__/resourceType.enum-parity.test.ts` green with
      `ConsentGrant` present in **both** `audit.prisma` and the domain enum — **Pass 3: re-run, 10/10 passed**
- [ ] `ConsentGrantRepository` registered in `CoreDatabaseModule` — providers **and** exports;
      mapper + repository barrel lines added by hand — unchanged from Pass 1, not re-verified this pass
- [x] `pnpm --filter @arcaai/database test` — **Pass 3: 52 files / 1255 tests passed**
- [x] `pnpm --filter @arcaai/domains build` · `pnpm --filter @arcaai/domains test` — **Pass 3: build
      clean; 144 files / 1744 tests passed, 2 skipped, 9 todo**
- [x] `pnpm --filter @arcaai/applications build` · `pnpm --filter @arcaai/applications test` —
      **Pass 3: build clean; 493 files / 9183 tests passed, 1 skipped**
- [x] Phase 5 Task 14 — CASL SHADOW mode built, unit-tested, and proven to alter zero requests —
      **Pass 4 (new criterion, this pass): `PolicyEngine.evaluateShadowVerdict`/
      `recordShadowDivergence` + `UnifiedAuthGuard.runCaslShadowChecks` +
      `@ResolveSubjectInstance(...)` (opt-in per route, zero routes opted in yet) built;
      `casl-conditions.shadow.test.ts` 12/12 passing, including the two hazard-proof tests named
      in Task 14's own verify step (an instance missing `tenantId` records a divergence, not a
      silent deny) and two "shadow changes nothing" proofs (allow side and deny side). Full
      `@arcaai/applications` suite re-run after landing this: 496 files / 9237 tests passed, 1
      skipped — no regression. `pnpm --filter @arcaai/applications build` clean; `pnpm api:build`
      12/12 tasks succeeded; `apps/api` unit suite re-run: 212 files / 3007 tests passed, no
      regression. Task 15 (enforce, `getAccessibleBy` wiring) explicitly NOT started**
- [x] `casl-blast-radius.md` (Task 2) produced from a real live query against the local `Policy`
      table — **Pass 4: `hope` dev Postgres, 2026-08-16 — 82 rule entries carrying `conditions`
      across 21 policies (65 distinct `(subject, action)` pairs), 16 identity-shaped (the real
      hazard set) cross-referenced against every `@Authorize`/`@CanXxx` decorator in
      `apps/api/src/modules/**`, with one confirmed fully-orphaned policy rule found
      (`UserSettings` — the route exists but is gated with a bare `@Authorize()` that never reaches
      CASL at all) and several subjects found undecorated by any route (Media, UserMedia,
      UserProfile, AiModel, ContextItem, PromptUsageRecord, PromptVersion, Tag). No enforcement
      pair recommended for this pass — the document proposes a Task-15 rollout ORDER, not a
      go-ahead**
- [x] `pnpm api:build` · `pnpm test:unit` — **Pass 3: `api:build` all 11 tasks succeeded;
      `NODE_ENV=test vitest run --exclude '**/integration/**' --exclude '**/e2e/**'` (the same
      command `test:unit` runs for the TS suite) → 209 files / 2962 tests passed. The literal root
      `pnpm test:unit` (which also runs `@arcaai/ui`/`@arcaai/vox`/`@arcaai/compat-playground`/
      `@arcaai/admin-console` — packages this pass also touched, for the
      `chain-integrity-card.tsx` null-safety fix) was NOT run as one aggregate command; each of
      those four was run individually instead (`@arcaai/admin-console`: typecheck clean, 7 files /
      59 tests passed) — same package-scoped-over-aggregate evidence posture Pass 2 used**
- [x] `pnpm harness:test` (incl. `test_replay_compat`) · `pnpm harness:lint` · `pnpm harness:typecheck` —
      **Pass 3: 1301 passed (incl. `test_replay_compat.py`); ruff clean; mypy clean, 109 files**
- [x] `pnpm db:seed` clean; `pnpm test:db:seed` clean — **Pass 3: `RUN_SEED=all` against a live
      `hope_test` database — 24 `ConsentGrant` rows created on the first run, 0 on a second
      (idempotency proven); `pnpm db:push` applied the nullable-column migration to `hope` (dev)
      non-destructively**
- [ ] `pnpm test:up:api` then `pnpm test:e2e` — all eight `consent-abac.spec.ts` cases — **NOT run
      this pass**: port 8968 (the TEST-env API port) was already bound by another process (PID
      28894, `apps/api/dist/main`, ~6h uptime — not started by this session) when `pnpm test:up:api`
      was attempted. Left untouched rather than killing a process this session did not start (the
      program's own shared-tree-instability guidance). The existing `consent-abac.spec.ts` (7 cases
      from Pass 2, none of which exercise Phase 4/the WORM writer/the seed) was therefore not
      re-run live this pass; unit-test + live-DB evidence (above, and the raw-SQL WORM-row proof in
      §7) stands in its place
- [ ] Existing `apps/api/tests/e2e/authorization.spec.ts` and `auth-guard-behavior.spec.ts` pass
      **unchanged** after Task 14 (proof shadow mode altered no verdict) — **Pass 4: Task 14 landed
      (shadow mode only, zero routes opted in via `@ResolveSubjectInstance`), but these two e2e
      files were NOT run this pass — `pnpm test:e2e`'s `globalSetup` runs `prisma db push
      --force-reset`, which this environment's guidance says not to fight (see the program-level
      note at the top of this ticket's task brief). Unit-level proof stands in its place instead:
      `casl-conditions.shadow.test.ts` (12/12) asserts the guard's `canActivate` return/throw is
      byte-identical with and without a divergence, in both the allow and the deny direction — the
      same property those e2e specs would exercise, at the unit layer**
- [x] `pnpm lint` — zero new errors in `apps/api`; zero new `only-warn` warnings in `packages/*` —
      **Pass 3: `apps/api` 0 errors / 65 warnings (the pre-existing Pass-2 baseline, unchanged);
      `@arcaai/domains` 0 errors / 13 warnings (pre-existing baseline, unchanged); `@arcaai/applications`
      0 errors / 202 warnings — 20 MORE than Pass 2's 182, but every one of the extra warnings is in
      `packages/applications/src/services/workflow-definition/**`, an UNCOMMITTED sibling ticket's
      files this session did not touch (confirmed by filename, not by assumption)**
- [ ] `pnpm typecheck:all` · `pnpm lint:all` — **run, both FAIL, but not on anything this ticket
      touched**: `typecheck:all` fails on `apps/stt/src/stt/transcription/preprocessing.py:278`
      (a pre-existing mypy `redundant-cast`); `lint:all` fails on
      `packages/py-env/src/hope_env/build_info.py:10` (a pre-existing ruff `E501` line-length). Every
      TS typecheck (42/42 turbo tasks) and TS lint (37/37 turbo tasks) task in both aggregates
      succeeded; `pnpm harness:lint`/`harness:typecheck` (this ticket's Python surface) are
      independently green above. Left unchecked because the literal aggregate command does not exit 0
- [ ] The boot audit demonstrably refuses to start on an undecorated consultation route (pasted
      refusal, then restored) — unchanged from Pass 2 (that evidence still stands there), not
      re-demonstrated this pass
- [x] `HarnessAuditAction.CONSENT_GIVEN` / `CONSENT_WITHDRAWN` have real writers; the admin-console
      filter at `apps/admin-console/src/features/harness-ops/api/types.ts` now returns rows —
      **Pass 3: `ConsentGrantService.create()`/`revoke()` append real WORM rows (unit-tested +
      wired to `HarnessAuditService` via DI); a raw-SQL INSERT of exactly that row shape
      (`consultationId=NULL, action='CONSENT_GIVEN'`) against the live `hope_test` database
      succeeded and was cleaned up afterward — proving the schema/entity change is real, not just
      mocked. The admin-console `HarnessAuditEvent.consultationId` type was widened to
      `string | null` and its two consumers (search-match, table-cell render) made null-safe
      (typecheck-verified) so the now-real rows render instead of crashing the panel**
- [x] The WORM hash-compatibility test proves a pre-existing seeded chain verifies **unchanged**
      after the `consultationId` change (or Task 1 chose a separate ledger and the reasoning is
      recorded) — **Pass 3: a fixed golden-hash literal
      (`packages/domains/src/utils/harnessAuditHash.test.ts`,
      `describe('computeHarnessAuditHash — nullable consultationId (TASK-712)')`) proves the digest
      for a row that HAS a `consultationId` is byte-identical to what the pre-nullable algorithm
      produced — the strongest form of this proof without a second historical database snapshot**
- [x] Ticket README §7 filled with the Implementation Summary and the files changed — this update

---

## 6. Risks & Open Questions

| # | Risk / question | Impact | Mitigation / owner | Answer |
|---|---|---|---|---|
| **Q1** | **HUMAN-GATED — is a clinician- or admin-recorded grant sufficient, or does regulation require the patient to act directly?** INV-342/344 say the patient must be able to grant/view/revoke/time-limit, *"without requiring the clinician to act as a proxy, where regulation requires it"* | Determines whether a patient-facing surface (A-45) is a prerequisite or a roadmap item | Compliance owner. Default assumption for this ticket: clinician/admin-recorded with `grantMethod` + `evidenceRef` capturing provenance. **This ticket is not compliance advice** | The clinician grant sufficient |
| **Q2** | **HUMAN-GATED — what is the posture for consultations that pre-date consent?** A fail-closed check denies every historical record (04-target-architecture §Risks 7) | Without an answer, this ticket bricks access to existing charts on the day it ships | Compliance owner. Options: (a) a dated legacy grant per existing `(tenant, patient)` pair, audited as `IMPORTED`; (b) a read-only exemption for consultations created before a cutover timestamp; (c) block and require re-consent. **Task 16 cannot be written without this** | Option (a)|
| **Q3** | **HUMAN-GATED — `externalPatientId` normalization.** Trim is obvious; case-folding is not — two EHRs may disagree on case for the same patient | A miss fails closed: legitimate access denied, hard to diagnose | Decide in Task 1 and implement in exactly one shared function. Default: trim only, exact-case match, with the mismatch surfaced in the denial reason so support can see it | Trim only, exact-case match |
| **Q4** | **HUMAN-GATED — consent granularity: one row per purpose, or one row with a `purposes[]` array?** Per-purpose rows are required for per-purpose expiry/revocation (INV-342); 04-target-architecture proposed the array form | Changes the unique constraint and every query | Task 1 writes both with a recommendation (per-purpose). Product/compliance decides. Changing it later is a migration, not a refactor | Per-purpose rows |
| **Q5** | **HUMAN-GATED — grace behaviour for an already-running session at revocation.** design.md is unambiguous that **new** calls stop. Whether an in-flight capture is torn down mid-encounter is a clinical-safety trade-off, not an engineering one | Tearing down mid-encounter loses documentation for a visit in progress; not tearing down continues capturing after revocation | Compliance + clinical owner. Default for this ticket: new gated calls denied, in-flight capture allowed to reach `DRAINING`, the whole sequence audited, the record marked. Do not implement teardown without an explicit decision | New gated calls denied, in-flight capture allowed to reach `DRAINING`, the whole sequence audited, the record marked |
| R1 | **The CASL fix could break authorization platform-wide** — 84 seeded rules with conditions become live predicates | An over-broad enforce turns legitimate calls into 403s across every module | Phase 5's shadow→measure→enforce, per-`(action, subject)` pair. The sub-phase is independently revertible and must not share a commit with Phases 1–4 | Phase 5's shadow→measure→enforce, per-`(action, subject)` pair |
| R2 | **`HarnessAuditEvent.consultationId` is a hash input** (`harnessAuditHash.ts:18`) | A naive nullable change invalidates every existing chain | §3.3 Pitfall 1; Task 1 decides, Task 3 implements, the compatibility test is an acceptance criterion |  |
| R3 | **`HarnessAuditService.append` is a documented unlocked read-then-write** (`harness-audit.service.ts:31-37`) | Consent denials on a hot tool path could fork the chain; the `hash` unique constraint catches only exact duplicates | Out of scope to fix. Measure append frequency after Task 13; if denials are frequent, route routine denials to `AgentTrajectoryStep` and keep only grant/revoke on the WORM ledger — but note F-11 already criticises tool calls living in prunable telemetry, so this is a real trade-off, not a free move | |
| R4 | **Consent adds an HTTP hop to the tool path**, and the harness's Temporal substrate is already the program's named availability risk | A gateway hiccup denies tool calls | Fail-closed is correct for consent, but the *degraded* signal must be distinguishable from a genuine denial in the trajectory and in the clinician-visible state. Task 12 must not conflate `consent_denied` with `consent_unavailable` | |
| R5 | **API-key callers have no CASL ability at all** (F-08) | A consent guard that reads `request.ability` is a silent no-op on every API-key route | §3.3 Pitfall 3 — the guard reads CLS and route params only. TASK-708 owns the underlying gap | |
| R6 | **`@ApiEndpoint()`-declared routes have unverified guard interaction** (`.claude/rules/05-nestjs-api.md`) | The consent guard could silently not fire on the consultation controller — the single most important surface | Task 10 verifies it explicitly with a failing-then-passing e2e assertion, not by inspection | |
| R7 | **This is the single largest new domain in the program** (04-target-architecture §5) and Wave 4's `palette-consultation` (TASK-731) depends on it | Slippage propagates to the flagship wave | Phase 0's design gate is the schedule risk. Keep it a real gate; do not start Phase 1 on a draft | |

---

## 7. Implementation Summary

### Pass 4 (2026-08-16) — Phase 5 SHADOW mode + `casl-blast-radius.md`

Orchestrator instruction for this pass: **ONLY** Phase 5 (the CASL condition-evaluation fix) and
Task 2's `casl-blast-radius.md`. Everything else in this ticket (guard, decorator, routes, model,
services, WORM ledger, Phase 4) was explicitly out of scope and NOT touched. The owner's R1 answer
is binding: shadow → measure → enforce, per `(action, subject)` pair, independently revertible —
so this pass lands the **SHADOW stage only**. No pair was enabled for enforcement.

**Built:**

1. **`casl-blast-radius.md`** (Task 2) — a real survey against the live `hope` dev Postgres
   database (`inet_server_addr` `192.168.97.6:5432`, 2026-08-16). Query and full results pasted
   into the document. Headline numbers: 21 `Policy` rows, 105 total rule entries, **82** carrying
   `conditions` across **65** distinct `(subject, action)` groupings, of which **16** are
   "identity-shaped" (reference something other than `${context.tenantId}` alone — `doctorId`,
   `userId`, `targetUserId`, `createdBy`, `isSystemRole`, or a `Tenant`/`User` row's own `id`) —
   these 16 are the ones enforcement would actually change behavior for; the other 66 condition on
   `tenantId` alone, already redundant with the Prisma tenant-scope extension for the overwhelming
   majority of requests. Every one of the 16 hazard rows was cross-referenced against
   `apps/api/src/modules/**`'s permission decorators by grep, and the document names, per pair,
   which controller file(s) actually reach it or explicitly marks it unreachable — with one
   concrete finding worth flagging on its own: **`UserSettings`'s seeded policy rule is fully
   orphaned** — `user-settings.controller.ts` exists at `/user/me/settings` but is gated with a
   bare `@Authorize()` (auth-only, zero permission tuples), so `handleJwtPostAuth`'s
   `required.length === 0` short-circuit means `ability.can()` is never even called for that route;
   authorization there is enforced entirely by the handler's own `resolveUserId()`, outside CASL.
   The document also names two existing production call sites that ALREADY do instance-aware
   `ability.can()` (`consultation.controller.ts`'s `verifyConsultationAccess`/
   `verifyConsultationOwnership`, and the self-service `POST /rbac/check` diagnostic endpoint) —
   useful context since they show the "hazard" pattern this ticket worries about is not
   hypothetical, just not yet wired through the guard.
2. **Phase 5 Task 14 — CASL shadow mode**, TDD (RED confirmed: the new test file failed with
   `TypeError: ResolveSubjectInstance is not a function` / missing exports before implementation;
   GREEN after). Two files touched, both listed in the ticket's own Task 14 file list, plus the
   barrel:
   - `packages/applications/src/authorization/policy.engine.ts` — `PolicyEngine.evaluateShadowVerdict(ability, action, subject, instance)`
     (pure comparison: computes both the type-only verdict `ability.can(action, subject)` and the
     instance-aware verdict `ability.can(action, subject, instance)`, reports `diverged`) and
     `PolicyEngine.recordShadowDivergence(action, subject, verdict, meta?)` (no-op unless
     `diverged`; otherwise increments `casl_shadow_divergence_total` — a `prom-client` `Counter`
     registered on the shared `register`, so it is automatically scraped at `GET /metrics` the same
     way `optimistic_lock_conflict_total` already is — and logs `casl.shadow.divergence`, the
     dotted-event-name convention this codebase's other shadow-mode reconciler,
     `shadow-metering.service.ts`, already uses).
   - `packages/applications/src/authorization/unified-auth.guard.ts` — `@ResolveSubjectInstance(resolver)`,
     a new, **explicitly opt-in, per-route** decorator (`SUBJECT_INSTANCE_RESOLVER_KEY` metadata);
     `UnifiedAuthGuard.runCaslShadowChecks(...)`, called from `handleJwtPostAuth` right after
     `request.ability`/CLS `userAbility` are set and BEFORE the type-only `results`/`allowed`
     computation. For each required permission whose route carries a resolver: resolves an
     instance, computes the shadow verdict, records it if diverged. **Zero routes were decorated
     with `@ResolveSubjectInstance` this pass** — the mechanism exists and is unit-tested, but is
     not wired to any real endpoint, so it changes nothing about current production behavior and
     `casl_shadow_divergence_total` will read zero until a follow-up opts routes in (the blast-radius
     doc's §7 proposes an order).
   - `packages/applications/src/authorization/index.ts` — additive barrel exports for the above
     (`CASL_SHADOW_DIVERGENCE_METRIC`, `CASL_SHADOW_DIVERGENCE_EVENT`, `ShadowVerdict`,
     `SUBJECT_INSTANCE_RESOLVER_KEY`, `ResolveSubjectInstance`, `SubjectInstanceResolver`).
   - New test file: `packages/applications/src/authorization/__tests__/casl-conditions.shadow.test.ts`
     (12 tests, all passing) — covers the pure `PolicyEngine` comparison (including the Task-2-named
     hazard: an instance missing `tenantId` produces `diverged: true`, `instanceVerdict: false`,
     never a thrown exception), the guard's opt-in wiring (no resolver → zero calls into
     `evaluateShadowVerdict`; a throwing resolver → swallowed, logged at DEBUG, zero effect on the
     real outcome; an async resolver works), and — the property that matters most for R1 — TWO
     end-to-end proofs (`THE HAZARD, end to end` and `THE FULL PROOF, denied side`) that
     `guard.canActivate()`'s return value / thrown exception is **byte-identical** whether or not a
     divergence is recorded, in both the allow direction and the deny direction.
3. **Guardrails kept deliberately narrow, matching the "shadow only" instruction:**
   - The guard's `allowed` computation (the thing that actually decides a request's fate) was not
     touched — it is still the bare 2-arg `ability.can(permission.action, permission.subject)` it
     was before this pass, unconditionally, for every route.
   - `getAccessibleBy` (`policy.engine.ts:203`) still has zero production call sites — untouched.
   - No `casl-conditions.enforce.test.ts` was created — that file name belongs to Task 15, not
     started.
   - No route anywhere in `apps/api/src/modules` carries `@ResolveSubjectInstance` yet — the shadow
     mechanism is proven correct in isolation, not yet exercised by real traffic.

**Deliberately NOT built this pass (disclosed):** anything from Task 15 (enforce, `getAccessibleBy`
wiring, `casl-conditions.enforce.test.ts`); wiring `@ResolveSubjectInstance` onto any real route
(so the new Prometheus counter has no production signal yet — by design, since wiring it is a
per-`(action, subject)`-pair decision `casl-blast-radius.md` explicitly defers to a future pass);
formal owner approval of `casl-blast-radius.md` (produced, not yet signed off — Task 15's own
precondition, not this pass's).

**Verification (commands actually run this session):**

- `NODE_ENV=test npx vitest run packages/applications/src/authorization/__tests__/casl-conditions.shadow.test.ts` —
  confirmed RED first (`TypeError: ResolveSubjectInstance is not a function`, 8/12 failing on
  missing exports/wrong verdicts), then GREEN after implementation: **12/12 passed**.
- `NODE_ENV=test npx vitest run packages/applications/src/authorization/` (the full authorization
  suite, all 10 files including the new one) — **148/148 passed**, no regression in the pre-existing
  guard/policy-engine/decorator tests.
- `pnpm --filter @arcaai/applications build` — clean.
- `pnpm --filter @arcaai/applications typecheck` — clean (`tsc --noEmit`).
- `NODE_ENV=test pnpm --filter @arcaai/applications test` (full package suite) — **496 files / 9237
  tests passed, 1 skipped** — up from Pass 3's 493/9183 (the 12 new shadow tests plus sibling
  work already in the shared tree; no test this pass's diff touches went from pass to fail).
- `pnpm --filter @arcaai/applications lint` — 0 errors; 204 warnings, all pre-existing (verified by
  diffing which line numbers actually carry the two files' warnings against a pre-edit `git show
  HEAD:<file>` count — `unified-auth.guard.ts` had 5 undescribed `eslint-disable` comments before
  this pass and still has exactly 5 after; the 2 new ones this pass added both carry descriptions,
  so they contribute 0 new warnings; `policy.engine.ts` had 1 before and has 1 after, unmoved).
- `pnpm api:build` — all 12 turbo tasks succeeded (Database → Domains → Applications → API chain,
  proving the applications-package change builds cleanly through to the API app that consumes its
  dist output).
- `cd apps/api && NODE_ENV=test npx vitest run --exclude '**/integration/**' --exclude '**/e2e/**'` —
  **212 files / 3007 tests passed** — no regression from the guard change reaching a real,
  type-only-verdict-only route (as expected: zero routes opted into the new decorator).
- Live SQL queries pasted in `casl-blast-radius.md` §2 — run via the `postgres` MCP connection
  against `hope` (confirmed `current_database() = 'hope'`, `current_user = 'postgres'`), 2026-08-16.

**NOT run this pass:** `pnpm test:up:api` + `pnpm test:e2e` (this session's standing guidance: the
Playwright `globalSetup` runs `prisma db push --force-reset`, which this environment's AI-agent
safety guard refuses, and the guidance is not to fight it) — not needed for this pass's actual
change anyway, since zero HTTP routes were modified or newly decorated; `pnpm harness:*` /
`pnpm --filter @arcaai/domains test` / `pnpm --filter @arcaai/database test` (no files in those
packages touched this pass — scope was strictly `packages/applications/src/authorization/**` plus
the two new docs); `pnpm typecheck:all` / `pnpm lint:all` aggregates (package-scoped commands used
instead, consistent with Pass 3's own evidence posture — every number above is a real,
individually-run command).

### Pass 3 (2026-08-16) — Phase 4 non-HTTP enforcement, WORM ledger writer, Phase 6 seed

Orchestrator instruction for this pass: finish Phase 4 (non-HTTP/harness tool-path enforcement), the
WORM ledger writer, and Phase 6's dedicated seed file. Phase 5 (CASL) stays untouched. Full reasoning
and design decisions: `consent-design.md` §8 (new).

**Built:**

1. **WORM ledger writer (Pitfall 1 / R2, resolved).** `HarnessAuditEvent.consultationId` widened
   `String` → `String?` (migration `20260816100536_task_712_consent_grant_worm_writer`, proven
   empty-diff on a throwaway `hope_shadow` DB). `HarnessAuditEventEntity.validate()`'s required-check
   is waived only for `CONSENT_GIVEN`/`CONSENT_WITHDRAWN`. `ConsentGrantService.create()`/`revoke()`
   now append a real WORM row (optional + trailing `HarnessAuditService` DI, mirroring
   `SummaryService`'s existing `ATTEST` wiring; fail-closed — an append failure propagates out of
   `create()`/`revoke()`, same trade-off `ATTEST` already accepts). A fixed golden-hash test proves
   the digest is byte-identical for every row that HAS a `consultationId` (every row that predates
   this change) — the hash-compatibility proof the ticket's Pitfall 1 requires.
2. **Phase 4 — non-HTTP enforcement.** `POST /internal/consent/assert`
   (`ConsentInternalController`, reusing the existing `HarnessServiceTokenGuard` — no new auth
   mechanism), wrapping `checkConsent` (non-throwing). `harness/core/consent_client.py`'s
   `ConsentClient` (TTL + negative cache, `EffectiveConfigClient`-shaped, keyed per
   `(tenantId, externalPatientId, purpose)`, a process-lifetime singleton in `activities.py` — unlike
   the other per-call client factories there, because the cache must survive across activity
   invocations). `call_mcp_tool` gates as step (0.5) (raises `ConsentDenied`/`ConsentUnavailable`,
   non-retryable, before the allowlist); `retrieve_context` gates before the retriever runs but
   degrades (never raises), matching that activity's own pre-existing contract. `external_patient_id`
   threaded end-to-end for the first time: TS `HarnessGatewayService`/`NoteGenerationService`
   (best-effort `Consultation.patientId` lookup) → Python `StartDocumentRequest` →
   `HarnessDocWorkflowInput` (additive-optional) → `CallMcpToolInput`/`RetrieveContextInput` inside
   `HarnessDocWorkflow.run`.
3. **Phase 6 — dedicated seed file.** `22-consent-grant.ts` (21 was already claimed by a sibling
   ticket) seeds `EXTERNAL_TOOL_LOOKUP`/`STYLE_LEARNING`/`QUALITY_REVIEW` grants for every demo
   patient in `09-consultation.ts` — the three purposes the Pass-2 legacy backfill did NOT cover.
   Verified against a live `hope_test` database: 24 rows created, then 0 on a re-run (idempotency
   proven).

**Deliberately NOT built this pass (disclosed, not silently skipped — full reasoning in
`consent-design.md` §8.4):** a WORM row for a consent DENIAL (only grant/revoke — denials stay on
the pre-existing trajectory-step surface for the two Phase-4 activities, and on structured logs for
the HTTP guard, unchanged); `ConsultationLoopWorkflow`'s finalize-child path threading
`external_patient_id` (a third, un-named entry point — its `call_mcp_tool`/`retrieve_context` calls
degrade to `consent_unavailable`, fail-closed but distinguishable, until a follow-up); a cross-process
consent-cache invalidation channel for the harness worker (TTL-only this pass, 30s, matching the
TS-side cache — the design's own stated backstop, not the propagation mechanism); CASL (Phase 5,
per explicit instruction); `casl-blast-radius.md`.

**A downstream consequence found and fixed, disclosed:** widening
`HarnessAuditEventResponse.consultationId` to `string | null` also required widening the
admin-console's own hand-maintained mirror type (`apps/admin-console/.../harness-ops/api/types.ts`)
and null-guarding its two consumers in `chain-integrity-card.tsx` (the search-match haystack and the
table-cell renderer) — otherwise the now-real `CONSENT_GIVEN`/`CONSENT_WITHDRAWN` rows the acceptance
criteria ask the admin filter to return would crash that panel. Verified by `tsc --noEmit` (clean)
and the existing `harness-ops` component test suite (59/59 passed, unchanged).

**Verification (commands actually run this session against live infra — Postgres, Redis, Temporal,
Vault, MinIO, Qdrant, conda `arcaenv`):**

- Migration: shadow-DB proof twice (once before, once after a concurrent sibling session (TASK-711)
  landed its own unrelated migration in the same schema file) — both `npx prisma migrate diff
  --from-config-datasource --to-schema src/prisma/db_main --script` runs printed
  `-- This is an empty migration.`.
- `pnpm gen:model:check` → "no drift — 166 generated file(s) match the committed files."
- `pnpm gen:entity:check` → "no drift — 96 generated file(s) match"; "Schema coverage OK: 94 entity
  artifact(s) cover every persisted column of 98 Prisma model(s)."
- `pnpm gen:factory:check` → "no drift — 96 generated file(s) match"; "Schema coverage OK: 94 factory
  artifact(s)…"
- `packages/domains/src/utils/harnessAuditHash.test.ts` → 25/25 passed (4 new golden-hash cases).
- `resourceType.enum-parity.test.ts` → 10/10 passed.
- `pnpm --filter @arcaai/domains build` clean; `vitest run` → **144 files / 1744 tests passed, 2
  skipped, 9 todo** (unchanged count from Pass 2 — no regression).
- `pnpm --filter @arcaai/applications build` clean; `vitest run` → **493 files / 9183 tests passed,
  1 skipped** (up from Pass 2's 492/9153 — the new consent-grant WORM tests + note-generation tests).
- `pnpm api:build` → all 11 turbo tasks succeeded. `NODE_ENV=test vitest run --exclude
  '**/integration/**' --exclude '**/e2e/**'` → **209 files / 2962 tests passed** (up from Pass 2's
  207/2937 — the new `consent-internal.controller.test.ts` + updated tests).
- `pnpm harness:test` → **1301 passed** (incl. `test_replay_compat.py`, the full integration suite,
  and every new/updated unit file). `pnpm harness:lint` → "All checks passed!". `pnpm harness:typecheck`
  → "Success: no issues found in 109 source files."
- `pnpm --filter @arcaai/database build`/`typecheck` clean; `vitest run` → **52 files / 1255 tests
  passed**.
- `pnpm --filter @arcaai/admin-console typecheck` clean; `vitest run src/features/harness-ops` →
  **7 files / 59 tests passed**.
- Seed, live `hope_test`: `RUN_SEED=all` → "Seeded 24 ConsentGrant row(s), 0 already present"; re-run
  → "Seeded 0 ConsentGrant row(s), 24 already present (left untouched)" (idempotency proven).
  `pnpm db:push` applied the nullable-column change to `hope` (dev) non-destructively (confirmed via
  `\d core."HarnessAuditEvent"` — `consultationId` shows nullable).
- Raw-SQL proof (then deleted): `INSERT INTO core."HarnessAuditEvent" (..., "consultationId", action,
  ...) VALUES (..., NULL, 'CONSENT_GIVEN', ...)` against live `hope_test` — succeeded, proving the
  schema accepts the exact row shape `ConsentGrantService`'s new WORM writer produces.
- Lint: `apps/api` 0 errors / 65 warnings (Pass-2 baseline, unchanged — 1 real prettier error found
  and fixed in `consultation.module.ts` during this pass); `@arcaai/domains` 0 errors / 13 warnings
  (unchanged baseline); `@arcaai/applications` 0 errors / 202 warnings (1 real prettier error found
  and fixed in `note-generation.service.ts`; the 20-warning increase over Pass 2's 182 is entirely in
  `services/workflow-definition/**`, an uncommitted sibling ticket's files, confirmed by path, not
  touched this pass).
- `pnpm typecheck:all` / `pnpm lint:all`: both FAIL, but only on pre-existing, unrelated issues —
  `apps/stt/.../preprocessing.py:278` (mypy `redundant-cast`) and
  `packages/py-env/.../build_info.py:10` (ruff `E501`). Every TS task in both aggregates (42/42
  typecheck, 37/37 lint) succeeded.

**NOT run this pass:** `pnpm test:up:api` + `pnpm test:e2e` — port 8968 was already bound by a
`node .../apps/api/dist/main` process (PID 28894, ~6h uptime) this session did not start. Rather than
kill a process this session has no evidence of owning (the program's shared-tree-instability
guidance), the attempt was abandoned; `consent-abac.spec.ts` (Pass 2's 7 cases) was not re-run live.
Phase 4/the WORM writer/the seed have no dedicated e2e coverage of their own this pass — the unit
tests above plus the live-DB seed/raw-SQL proofs are the evidence in its place. `casl-blast-radius.md`
and the CASL blast-radius live-DB query — not produced, Phase 5 untouched per instruction.

### Pass 2 (2026-08-16) — HTTP consent enforcement is now ON BY DEFAULT

Owner directive for this pass: turn enforcement on — build the guard, the decorator, route
decoration — and implement Q2 (legacy-grant backfill). Full narrative, file-by-file table, and the
"what's still deferred" table: `consent-design.md`'s **Pass 2 Addendum**. Summary here:

**Built:** the partial-unique-active-grant index fix (Pass 1 shipped a broken plain `@@unique` that
would have permanently blocked revoke-then-regrant); the legacy-grant backfill (Q2 option (a)),
shipped INSIDE the schema migration transaction so it can never be applied separately from the code
that depends on it; a `findByTenantPatientPurpose` correctness fix (a revoked-with-no-regrant lookup
must report `reason: 'revoked'`, not the less useful `'no_grant'`); `ConsentUnavailableException`
(R4 — 503, distinct from `ConsentDeniedException`'s 403); `@RequiresConsent`/`@ConsentExempt` +
`PatientConsentGuard`, registered as an unconditional `APP_GUARD`; `ConsentExceptionFilter` (a real
bug found and fixed during verification — see below); route decoration on the four gated HTTP
routes; a narrowed boot-time coverage audit; the `/admin/consent-grants` CRUD controller; and
`apps/api/tests/e2e/consent-abac.spec.ts` (7 cases, all passing against a live API + DB).

**Real bug found and fixed during verification (disclosed, not hidden):** the first e2e run against
a live server returned `500` instead of `403` for every denial. Root cause: `assertConsent` is
called from `PatientConsentGuard.canActivate()` — NestJS runs Guards strictly BEFORE Interceptors,
so an exception thrown inside a guard never reaches `ExceptionInterceptor`'s `catchError` at all.
`ConsentDeniedException` isn't a NestJS `HttpException`, so it fell through to Nest's default
handling as a bare 500. Fixed with `ConsentExceptionFilter`, a `@Catch()` `APP_FILTER` (the same
mechanism `DataNotFoundExceptionFilter` already uses for exactly this reason) — filters, unlike
interceptors, catch exceptions from anywhere in the request lifecycle including guards. Full
before/after evidence in the Verification section below.

**Deliberately NOT built this pass** (all disclosed, none silently skipped — see
`consent-design.md`'s Addendum for the reasoning behind each): non-HTTP enforcement (Phase 4 —
gateway-internal assert endpoint, harness Python client, `call_mcp_tool`/`retrieve_context` gating —
**the single largest remaining gap**, per R7); the WORM `CONSENT_GIVEN`/`CONSENT_WITHDRAWN` writers
(unchanged Pitfall-1 reasoning); the CASL condition-evaluation fix (Phase 5 — kept on its own switch
per explicit instruction, untouched); a dedicated `21-consent-grant.ts` seed file (the backfill
already covers every pre-existing consultation, seeded or not); widening the boot-coverage audit to
the ticket's full "every consultation-module route" predicate (narrowed to ":patientId routes only",
disclosed in the audit's own doc comment).

**Secondary open questions, unchanged from Pass 1** (`consent-design.md`): Q1 (patient-facing
surface — not built, no patient app exists), Q3 (`externalPatientId` normalization — trim-only,
implemented), Q4 (per-purpose rows — implemented, not formally ratified), Q5 (in-flight teardown on
revocation — no capture-teardown code exists yet to answer it; the owner's default, "new calls
denied, in-flight allowed to drain," is unaffected since nothing tears down captures in this pass).

### Pass 1 (2026-08-16) — original scope note, kept for history

**Scope actually executed** (explicit orchestrator instruction reduced this XL ticket to: build the
Consent model, the ABAC evaluation path, and the tests; do NOT choose or seed a legacy posture; do
NOT enable enforcement anywhere): Phase 0 (reduced), Phase 1 (database + domain trio) in full, and
Phase 2 (application service + `assertConsent` choke point) in full except the WORM ledger writer.
Phases 3, 4, 6 and the independent Phase 5 (CASL) were not started. Full rationale: `consent-design.md`.

**TDD note (honesty, both passes):** neither pass followed strict RED-then-GREEN for every file —
Pass 1's domain trio and application services were authored with their tests together once the
codebase's existing patterns were understood; Pass 2's `ConsentExceptionFilter` was written test-first
(3 unit tests, all initially exercising the real `catch()` method — not literally watched fail first
either, since the class didn't exist to fail against). This is a disclosed deviation from the
ticket's stated TDD requirement in both passes.

### What was built (cumulative — Pass 1 + Pass 2)

| Layer | What | Files |
|---|---|---|
| Database | `ConsentGrant` model, `ConsentPurpose`/`ConsentGrantMethod` enums, `ResourceType += ConsentGrant`, partial-unique-active-grant index + legacy-grant backfill (Pass 2 migration rewrite) | `consent.prisma`, `enums.prisma`, `audit.prisma`, `extensions/tenant-scope.ts`, `migrations/20260816030000_task_712_consent_grant/migration.sql` |
| Domain | Hand-authored entity/factory/mapper/repository trio; Pass 2 fixed `findByTenantPatientPurpose`'s ordering | `entities/`, `factories/`, `mappers/`, `repositories/generated/core/ConsentGrant*.ts`, `models/generated/core/ConsentGrantModel.ts`, `enums/generated/{ConsentPurpose,ConsentGrantMethod}.ts` |
| Application | `ConsentGrantService`, `ConsultationConsentService` (`assertConsent`/`checkConsent`); Pass 2 added `ConsentUnavailableException` handling | `packages/applications/src/services/consent/` (whole dir) |
| Exceptions | `ConsentDeniedException` (403), `ConsentUnavailableException` (503, Pass 2, R4) | `packages/exceptions/src/domain/{consentDenied,consentUnavailable}.exception.ts` + `common/exception.codes.ts` |
| API — HTTP enforcement (Pass 2, new) | `@RequiresConsent`/`@ConsentExempt` decorators; `PatientConsentGuard` (`APP_GUARD`); `ConsentExceptionFilter` (`APP_FILTER`); route decoration; boot audit; admin CRUD controller | `packages/applications/src/authorization/decorators.ts`; `apps/api/src/guards/patient-consent.guard.ts`; `apps/api/src/filters/consent.filter.ts`; `apps/api/src/modules/consultation/consultation.controller.ts`; `apps/api/src/bootstrap/consent-route-coverage-audit.ts`; `apps/api/src/modules/consent/` |
| Seed | `ConsentGrant` subject added to the tenant-admin policy (Pass 2) | `packages/database/src/prisma/db_main/seed/01-policy.ts` |
| E2E | `consent-abac.spec.ts` (Pass 2, new); `task-635-live-agent-lineage.spec.ts` updated to grant consent before `recording/start` | `apps/api/tests/e2e/` |
| Design | Consent domain design record | `docs/implementation/TASK-712-Consent-Abac/consent-design.md` |

### Verification (all commands actually run against LIVE infra this session — Postgres, Redis, Temporal, Vault, MinIO, Qdrant were up; both `hope` (dev) and `hope_test` databases used)

**Migration proof (shadow DB):**
- `docker exec hope-postgres psql .../postgres -c 'DROP DATABASE IF EXISTS hope_shadow' -c 'CREATE DATABASE hope_shadow'` then `pnpm --filter @arcaai/database db:migrate:deploy` against it — **all 42 migrations applied cleanly**, including the rewritten `20260816030000_task_712_consent_grant`.
- `npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script` against `hope_shadow` — printed exactly ONE statement, a `RenameIndex` on `TenantNlpTaskInstructions_tenant_task_unique` — **pre-existing drift from a sibling ticket's migration (TASK-729), confirmed unrelated to `ConsentGrant` by inspection; the `ConsentGrant` table/indexes are byte-identical between migration and schema.**
- Manually proved the partial-unique-index fix on `hope_shadow`: inserted a User + two Consultation rows (same trimmed `patientId`, one with whitespace) for a fresh tenant, ran the backfill INSERT — exactly 2 rows created (one per purpose), re-ran it — 0 additional rows (idempotent). Revoked one grant, inserted a fresh one for the SAME `(tenant, patient, purpose)` — **succeeded** (the bug the plain `@@unique` would have caused). Inserted a SECOND active grant for the same triple — **correctly failed** with `duplicate key value violates unique constraint "ConsentGrant_tenant_patient_purpose_active_key"`.
- `hope_shadow` dropped after the proof.

**Dev DB (`hope`, port 5432) — schema + backfill applied for real, non-destructively:**
- `pnpm db:push` (non-force) — schema in sync.
- Manually applied the migration's partial-unique-index + backfill INSERT via `psql` (documented in the migration file's own header as the required step on a db-push-managed database) — **14 `ConsentGrant` rows created** (7 distinct `(tenant, patient)` pairs × 2 purposes) covering the 11 pre-existing `Consultation` rows.

**Test DB (`hope_test`, port 5433) — same treatment, plus live e2e:**
- `pnpm test:db:seed` initially failed with a Prisma foreign-key error (`Consultation_doctorId_fkey`) because `RUN_SEED` was unset in this shell (the seed script's own message: "Skipping database seeding: RUN_SEED is unset"). Re-ran with `RUN_SEED=all pnpm test:db:seed` — succeeded (9 consultations + 2 customer-tenant, full seed tree). **Note on a blocked destructive command:** `pnpm test:db:reset` (which `RESET_DB`-unset `pnpm test:e2e` runs by default) invokes `prisma db push --force-reset --accept-data-loss`; Prisma's own AI-agent safety guard refused it outright ("You are attempting a highly dangerous action... forbidden from performing this action without explicit consent"). This session's own hard rule already forbids `db push --force-reset`, so the refusal was accepted and NOT bypassed — Playwright's own globalSetup HAD already run this once automatically before the guard engaged consistently on manual retries, which is what actually emptied `hope_test` the first time; all subsequent runs used `RESET_DB=false` and the DB was reseeded via the non-destructive `test:db:seed` path.
- Applied the partial-unique-index + backfill to `hope_test` the same way as dev — **16 rows** (8 pairs × 2 purposes).
- `pnpm test:up:api` — API boots clean; boot-time audits (including the new `auditConsentRouteCoverage`) all pass (a REAL positive: had they failed, the process would refuse to start).
- **`apps/api/tests/e2e/consent-abac.spec.ts` — 7/7 PASSED** (`RESET_DB=false pnpm exec dotenv -e .env.test -- playwright test apps/api/tests/e2e/consent-abac.spec.ts`):
  ```
  ✓ POST :id/recording/start with no active AI_DOCUMENTATION grant → 403 DOMAIN.CONSENT_DENIED
  ✓ after recording an AI_DOCUMENTATION grant, POST :id/recording/start succeeds
  ✓ GET patient/:patientId/history with no HISTORY_RETRIEVAL grant → 403; with one → 200
  ✓ an EXPIRED grant denies (INV-342 time-limit)
  ✓ revocation blocks the NEXT gated call — mid-session semantics (INV-010/340/438)
  ✓ admin revoke without If-Match → 428; with a stale If-Match → 412
  ✓ the legacy-grant backfill covers a pre-existing seeded patient (PAT-20250101-001)
  7 passed (1.8s)
  ```
  Getting to green required three real fixes, all disclosed: (1) every request path needed an
  explicit `/api/v1` prefix — `.env.test`'s `API_URL` omits it, unlike the config's fallback
  default; (2) the `ConsentExceptionFilter` bug above; (3) the legacy-backfill case needed the
  `doctor` persona, not `tenant_admin` — the pre-existing, unrelated `verifyPatientAccess`
  doctor-patient-relationship check (not a consent concern) denies a tenant admin reading a patient
  they never personally treated.
- **`apps/api/tests/e2e/task-635-live-agent-lineage.spec.ts` re-run to confirm the update didn't
  regress it** — test 1 (R-N1, which calls the now-gated `POST :id/recording/start`) **PASSED**
  (2.5 min — a real local generation); tests 2–3 skipped, exactly as the file's own docs describe
  when SMR/NLP aren't reachable (unrelated to consent).

**Full-suite regression checks (post-fix, this session):**
- `pnpm --filter @arcaai/domains build && test` — **142 test files passed, 2 skipped (144); 1720
  tests passed, 2 skipped, 9 todo** — unchanged from Pass 1's count (no regression from the
  repository ordering fix).
- `pnpm --filter @arcaai/applications test` — **492 test files passed, 1 skipped (493); 9153 tests
  passed, 4 skipped (9157)** — includes the updated `consent-assert.test.ts` (now 14 tests, +4 for
  the R4 `unavailable` distinction).
- `NODE_ENV=test pnpm --filter @arcaai/api exec vitest run --exclude '**/integration/**' --exclude
  '**/e2e/**'` — **207 test files passed (207); 2937 tests passed (2937)** — includes the new
  `patient-consent.guard.test.ts` (10), `consent-route-coverage-audit.test.ts` (5),
  `consent.filter.test.ts` (3), and the `exception.interceptor.test.ts` additions (2).
- `pnpm --filter @arcaai/exceptions build && test` — clean.
- `pnpm api:build` — all 10 Turbo tasks succeeded.
- Lint, zero new errors: `pnpm --filter @arcaai/domains lint` (13 pre-existing warnings, none
  touched), `pnpm --filter @arcaai/applications lint` (182 pre-existing warnings, none touched),
  `pnpm --filter @arcaai/exceptions lint` (clean), `pnpm --filter @arcaai/api lint` (found and fixed
  one real prettier error in `consent.controller.ts`, now 0 errors / 65 pre-existing warnings).

**NOT run:** `pnpm harness:*` (no harness changes this pass — Phase 4 deferred); `casl-blast-radius.md`
still not produced (Phase 5 deferred); the full root `pnpm test:unit`/`pnpm lint`/`pnpm typecheck:all`
aggregates (package-scoped commands used instead, per this session's evidence rule — every number
above is a real, individually-run command, not an aggregate).

**A note on shared-tree instability encountered mid-verification:** the test API crashed twice with
an unrelated error from a sibling ticket's (TASK-708) in-flight edit to
`apikey-scopes.registry.ts`/`stt-internal.controller.ts` (a transient snapshot where a scope string
was referenced before its registry entry landed). Not touched, not fixed — waited it out and
restarted; the file was internally consistent again within seconds.

### Files changed

**Pass 4 (this update) — new:**
- `docs/implementation/TASK-712-Consent-Abac/casl-blast-radius.md`
- `packages/applications/src/authorization/__tests__/casl-conditions.shadow.test.ts`

**Pass 4 — modified:**
- `packages/applications/src/authorization/policy.engine.ts` (`CASL_SHADOW_DIVERGENCE_METRIC`/`_EVENT`, `ShadowVerdict`, `evaluateShadowVerdict`, `recordShadowDivergence`)
- `packages/applications/src/authorization/unified-auth.guard.ts` (`SUBJECT_INSTANCE_RESOLVER_KEY`, `SubjectInstanceResolver`, `ResolveSubjectInstance`, `runCaslShadowChecks`, wired into `handleJwtPostAuth`)
- `packages/applications/src/authorization/index.ts` (additive barrel exports for the above)

**Pass 3 (previous update) — new:**
- `apps/api/src/modules/consultation/consent-internal.controller.ts` + `__tests__/consent-internal.controller.test.ts`
- `apps/harness/src/harness/core/consent_client.py` + `tests/unit/test_consent_client.py`
- `packages/database/src/prisma/db_main/migrations/20260816100536_task_712_consent_grant_worm_writer/migration.sql`
- `packages/database/src/prisma/db_main/seed/22-consent-grant.ts`

**Pass 3 — modified:**
- `packages/database/src/prisma/db_main/harness.prisma` (`HarnessAuditEvent.consultationId` nullable)
- `packages/database/src/prisma/db_main/seed/{00-constants.ts,09-consultation.ts,index.ts}` (`SEED_CONSENT_GRANT_IDS`, exported `PATIENT_IDS`, wired `seedConsentGrant`)
- `packages/domains/src/entities/generated/core/HarnessAuditEventEntity.ts` (conditional `consultationId` requirement)
- `packages/domains/src/factories/generated/core/HarnessAuditEventFactory.ts` (`?? null`)
- `packages/domains/src/models/generated/core/HarnessAuditEventModel.ts` (regenerated via `gen:model`)
- `packages/domains/src/utils/harnessAuditHash.ts` + `harnessAuditHash.test.ts` (nullable `consultationId`, golden-hash compatibility test)
- `packages/applications/src/services/harness-audit/harness-audit.service.ts` (`AppendHarnessAuditInput.consultationId: string | null`)
- `packages/applications/src/services/harness-observability/{harness-observability.service.ts,dto/harness-audit.response.ts}` (null-safe map key, widened DTO)
- `packages/applications/src/services/consent/{consent-grant.service.ts,consent-grant.service.module.ts,__tests__/consent-grant.service.test.ts}` (WORM writer)
- `packages/applications/src/services/consultation/harness/{harness-gateway.service.ts,__tests__/harness-gateway.service.test.ts}` (`externalPatientId` on `HarnessStartContext`)
- `packages/applications/src/services/consultation/note-generation/{note-generation.service.ts,__tests__/note-generation.service.test.ts}` (patientId lookup + threading)
- `apps/api/src/modules/consultation/consultation.module.ts` (`ConsentInternalController` + `ConsentServiceModule` registration)
- `apps/harness/src/harness/core/config.py` (`consent_internal_prefix`, `consent_cache_ttl_seconds`)
- `apps/harness/src/harness/api/endpoints/internal.py` + `tests/unit/api/test_internal_endpoints.py` (`externalPatientId` on `StartDocumentRequest`)
- `apps/harness/src/harness/temporal/{models.py,activities.py,workflows.py}` (`external_patient_id`/`tenant_id`/`consultation_id` on `CallMcpToolInput`/`RetrieveContextInput`; consent gating in `call_mcp_tool`/`retrieve_context`)
- `apps/harness/src/harness/tests/unit/temporal/{test_mcp_tool_activity.py,test_activities.py}` (consent-gate test coverage)
- `apps/admin-console/src/features/harness-ops/api/types.ts` + `components/chain-integrity-card.tsx` (null-safe `consultationId`, downstream consequence)
- `docs/implementation/TASK-712-Consent-Abac/consent-design.md` (§8 Pass 3 addendum)

**Pass 2 (previous update) — new:**
- `apps/api/src/guards/patient-consent.guard.ts` + `__tests__/patient-consent.guard.test.ts`
- `apps/api/src/bootstrap/consent-route-coverage-audit.ts` + `__tests__/consent-route-coverage-audit.test.ts`
- `apps/api/src/filters/consent.filter.ts` + `__tests__/consent.filter.test.ts`
- `apps/api/src/modules/consent/consent.controller.ts`, `consent.module.ts`
- `apps/api/tests/e2e/consent-abac.spec.ts`
- `packages/exceptions/src/domain/consentUnavailable.exception.ts`

**Pass 2 — modified:**
- `packages/database/src/prisma/db_main/consent.prisma` (dropped the broken `@@unique`, documented the partial index)
- `packages/database/src/prisma/db_main/migrations/20260816030000_task_712_consent_grant/migration.sql` (partial unique index + legacy-grant backfill)
- `packages/database/src/prisma/db_main/seed/01-policy.ts` (`ConsentGrant` subject on `tenant-full-access`)
- `packages/domains/src/repositories/generated/core/ConsentGrantRepository.ts` (`findByTenantPatientPurpose` ordering fix)
- `packages/applications/src/authorization/decorators.ts` + `authorization/index.ts` (`RequiresConsent`/`ConsentExempt`)
- `packages/applications/src/services/consent/{IConsultationConsentService.ts,consultation-consent.service.ts,consent-grant.service.ts}` (R4 + doc fixes)
- `packages/applications/src/services/consent/__tests__/consent-assert.test.ts` (R4 test)
- `packages/exceptions/src/common/exception.codes.ts`, `packages/exceptions/src/domain/{index.ts,consentDenied.exception.ts}`
- `apps/api/src/app.module.ts` (guard + filter + module registration), `apps/api/src/main.ts` (boot audit call)
- `apps/api/src/decorators/index.ts`, `apps/api/src/guards/index.ts`, `apps/api/src/filters/index.ts` (barrels)
- `apps/api/src/interceptors/exception.interceptor.ts` + `__tests__/exception.interceptor.test.ts` (`ConsentUnavailableException` → 503)
- `apps/api/src/modules/consultation/consultation.controller.ts` (route decoration)
- `apps/api/tests/e2e/task-635-live-agent-lineage.spec.ts` (grant consent before `recording/start`)
- `docs/implementation/TASK-712-Consent-Abac/consent-design.md` (Pass 2 Addendum)

**Pass 1 files** — unchanged from the prior entry below (database/domain trio, application services, `ConsentDeniedException`).

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | ticket-writer agent (Wave-1 clinical architecture) |
| 2026-08-16 | Pass 1 — reduced-scope execution: `ConsentGrant` model + domain trio and the `assertConsent`/`checkConsent` ABAC choke point built and tested; no enforcement wired; legacy-consent posture (Q2) left undecided and unseeded. | execution agent (orchestrator-scoped subagent) |
| 2026-08-16 | Pass 2 — HTTP consent enforcement turned ON BY DEFAULT: fixed the partial-unique-active-grant index (Pass 1's was a plain `@@unique` that would have permanently blocked revoke-then-regrant); implemented the Q2 legacy-grant backfill inside the migration transaction; built `@RequiresConsent`/`@ConsentExempt` + `PatientConsentGuard` (unconditional `APP_GUARD`) + `ConsentExceptionFilter` (found and fixed a real 500-instead-of-403 bug — guards run before interceptors); decorated the four gated HTTP routes; added a narrowed boot-time coverage audit; built the `/admin/consent-grants` CRUD controller; added `ConsentUnavailableException` (R4); wrote and ran `consent-abac.spec.ts` (7/7 passing against a live API + DB, with the migration/backfill proven on a throwaway `hope_shadow` DB first); confirmed no regression in the pre-existing `task-635-live-agent-lineage.spec.ts`. CASL (Phase 5), non-HTTP/harness enforcement (Phase 4), and the WORM ledger writer remain explicitly deferred. See §7 for full verification evidence. | execution agent (orchestrator-scoped subagent) |
| 2026-08-16 | Pass 4 — Phase 5 SCOPE ONLY: `casl-blast-radius.md` produced from a real live query against `hope` dev Postgres (82 conditioned rule entries / 65 `(subject, action)` pairs / 16 identity-shaped hazard pairs, each cross-referenced against `apps/api/src/modules/**`'s decorators — including finding `UserSettings`'s seeded rule fully orphaned by a bare `@Authorize()` route); Task 14 CASL SHADOW mode built and unit-tested (`PolicyEngine.evaluateShadowVerdict`/`recordShadowDivergence`, `UnifiedAuthGuard.runCaslShadowChecks` + the new opt-in `@ResolveSubjectInstance` decorator, `casl_shadow_divergence_total` metric + `casl.shadow.divergence` log event) — wired to ZERO production routes, so it changes no request's outcome. Task 15 (enforce, `getAccessibleBy`) explicitly not started, per the owner's R1 shadow→measure→enforce directive. Guard, decorator, routes, model, services, WORM ledger, and Phase 4 (all complete from prior passes) were not touched. See §7 Pass 4. | execution agent (orchestrator-scoped subagent) |
| 2026-08-16 | Pass 3 — Phase 4 non-HTTP enforcement, the WORM ledger writer, and Phase 6's dedicated seed built: `HarnessAuditEvent.consultationId` made nullable (migration proven empty-diff on a shadow DB, hash-compatibility proven with a fixed golden-hash test) so `ConsentGrantService.create()`/`revoke()` could append real `CONSENT_GIVEN`/`CONSENT_WITHDRAWN` WORM rows; built the gateway-internal `POST /internal/consent/assert` endpoint + the harness's `ConsentClient` (TTL-cached, fail-closed) + consent gating in `call_mcp_tool` (raises, step 0.5) and `retrieve_context` (degrades, matching its own existing contract); threaded `external_patient_id` end-to-end from `NoteGenerationService` through the harness workflow input for the first time; built `22-consent-grant.ts` (Phase 6) seeding the three purposes the Pass-2 legacy backfill did not cover, verified idempotent against a live `hope_test` database; fixed a downstream null-safety consequence in the admin-console's harness-audit types/components. CASL (Phase 5) untouched, per instruction. See §7 Pass 3 for full verification evidence, including what remains disclosed-and-deferred (the `ConsultationLoopWorkflow` finalize-child identity gap, cross-process cache invalidation, and `casl-blast-radius.md`). | execution agent (orchestrator-scoped subagent) |
