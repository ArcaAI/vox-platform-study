# TASK-950 — Context-schema user identity → `UserProfile.staffId` → find-or-provision tenant user

| Field | Value |
|---|---|
| **Status** | Review — shipped on `dev-2.2` (`e1418982f` + this doc); every automated gate green or attributed; the owner's console click-through is the one open gate |
| **Type** | feature (full-stack: database → domains → applications → api → SDKs → admin console) |
| **Branch** | `dev-2.2` |
| **Surface** | `packages/database` (migration), `packages/domains` (UserProfile trio), `packages/applications` (context-schema definition, new identity service, consultation open, agent invocations, workflow runs, settings descriptors), `packages/workflow-contract` (compiler freeze), `apps/api` (DTO + e2e + five regenerated artifacts), `packages/vox-node` + `packages/vox-codegen` (types), `apps/admin-console` (schema editor + user profile) |
| **Opened** | 2026-09-11 |
| **Ticket number** | TASK-950 — the highest ticket under `docs/implementation/` is TASK-949; `docs/archive/` is not readable from this session, so the number is provisional until the owner confirms (OD-0) |

## Requirement Analysis

Owner ask (2026-09-11, verbatim):

> given the parties can integrate their application with our `hope` platform using service
> account, their tenant admins can define the consultation context schemas for agents and
> workflows. there is a requirement: a specific field in the consultation context schema will be
> defined and used as user identity, it will be automatically mapped to `staff_id` in the
> UserProfile. when there is a request to consultation workflow or agent, the workflow or agent
> uses the schema contains a user identity field, the `hope` then will check in the tenant users
> to see if there is any tenant user with the appropriate profile existed, if not then it will
> create a user (randomize `username`, with other related user entity created)

Restated as five verifiable behaviours:

| # | Behaviour |
|---|---|
| **R1** | A tenant admin can mark exactly ONE field of a `ConsultationContextSchema` version as the **user identity** field. The marker is content, versioned with the schema, and survives the SYSTEM → tenant reference-set clone. |
| **R2** | That field's value is the tenant's **staff identifier**; it is persisted on `UserProfile.staffId` and is unique per tenant. |
| **R3** | When a **service-account** request reaches a plane whose schema carries the marker (consultation open, agent invocation, workflow run) and the payload carries the field, HOPE resolves it to a tenant user: an existing user whose profile carries that `staffId` in the request tenant wins. |
| **R4** | When no such user exists, HOPE **provisions** one in one transaction: `User` (random username, non-loginable), `UserProfile` (`staffId`), `UserRoleAssignment` (tenant role), `UserDepartment` (tenant department) — the same four-row shape the existing federated-auth JIT path writes, so the user satisfies the login invariant (`assertUserBelongsToTenant`) and can own a consultation. |
| **R5** | The resolved user is the **acting clinician** of the request: `Consultation.doctorId` at open, `subject.userId` on a dispatched workflow run, attribution on an agent invocation. |

Classification: **feature**. Layer order: Database → Domain → Applications → API → SDKs → Console.

### Why this is a documented reversal, not a bug

TASK-933 §2.3 reviewed exactly this terrain (owner OD-4/5/6, 2026-09-09) and concluded *"identity
is a request contract on `open` that lands on the row; the schema is unchanged"* — because the
schema is a content vocabulary validated per case-note write, never at open, and declaring
`user_id` there would neither authorize a caller nor populate the row columns consumers read.

This ticket keeps every one of those facts true and changes ONE thing: the schema may now **name
which field carries the clinician's staff identifier**, and the gateway resolves that value to a
`User` BEFORE the row is written. Authorization is still the service account's scopes; the row
column (`doctorId`) is still what every consumer reads; the schema still never authorizes anyone.
The marker is a mapping declaration, not an identity contract. OD-1 asks the owner to confirm the
reversal explicitly so the TASK-933 README can be cross-referenced rather than silently
contradicted.

## Current State Evaluation

Verified against `dev-2.2` at `c56b54e99` (2026-09-11). Discovery ran as three read-only
Explore lanes (schema, user creation, service-account planes); every path below was re-read in
the primary checkout.

### Context schema — what a "field" is today

- Storage: `ConsultationContextSchema` (head, `scope` TENANT|DEPARTMENT, `isDefault`,
  `pinnedVersionNumber`) + `ConsultationContextSchemaVersion.definition` (immutable JSON,
  `checksum`), `packages/database/src/prisma/db_main/consultation-context-schema.prisma`.
- Definition grammar: `packages/applications/src/services/consultation-context-schema/context-schema-definition.ts`.
  A definition is `{ schemaVersion, kinds[], outputs[] }`; each kind is a `ContextKindDeclaration`
  on one of the FIVE closed primitives (`STREAM_AUDIO | TEXT | DOCUMENT | IMAGE | STRUCTURED`),
  with `key, label, primitive, phiClass, cardinality, lifecycle, producedBy, required?, fields?,
  constraints?, description?, deprecated?`. `KIND_KEYS` (line 68) is a closed allow-list — an
  unknown key is rejected at publish (`kindProblems`, line 188). **There is no semantic-role /
  "maps to" concept.** A STRUCTURED kind's `fields` is a JSON-Schema subset
  (`packages/json-schema-subset`), so "a specific field" in the owner's sense is one property of
  one STRUCTURED kind (the seeded ArcaAI schemas carry one `context` STRUCTURED kind with
  `visit_type`, `current_department`, `language`, … as properties — `seed/07e`, `seed/07f`).
- Derivation: `payloadSchemaFromDefinition(definition)` (line 382) → one property per kind key,
  `additionalProperties: false`; frozen at **agent publish**
  (`AgentService.resolveContextSchema` → `compiledConfig.contextSchema.payloadSchema`,
  `agent.service.ts:1663`) and at **workflow compile**
  (`packages/workflow-contract/src/compiler.ts:313` → `core.trigger.contextSchema.resolved`).
- Runtime validators: case-note writes go through
  `ConsultationContextSchemaService.validateContextPayload({ kindKey, payload, contextSchemaVersionId, departmentId })`
  (service line 443; caller `context.service.ts:215`), which resolves the DEPARTMENT default →
  TENANT default live and returns the matched kind. Agent invocations validate `body.context`
  against the frozen payload schema (`agent-invocation.service.ts:110`). Workflow runs validate the
  authored input in the harness (`interpreter/nodes/core.py:177`) after stripping the five
  `RESERVED_RUN_IDENTITY_KEYS` (`consultationId, externalPatientId, userId, jobId, sessionId`).
- Change classification (`definition-diff.ts`): `IDENTICAL | ADDITIVE | BREAKING`; only removed /
  narrowed kinds and fields are BREAKING.
- Type mirrors of `ContextKindDeclaration` that must learn the new key:
  `apps/admin-console/src/features/context-schemas/api/types.ts:106`,
  `packages/vox-node/src/types/consultation-context-schema.ts:65`,
  `packages/vox-codegen/src/types.ts:32`. The browser SDK's
  `contextPayloadValidation.ts` validates payloads, not definitions — no change.
- Console: `features/context-schemas/components/definition-editor.tsx` (244 lines) edits kinds
  and renders a `Required` badge; `payload-tester.tsx` validates a payload against a version.

### Users — what exists and what does not

- `User` is platform-global (`user.prisma:57`): `username @unique`, `password String` **NOT
  NULL**, `externalId? @unique` (deprecated global stub), `isServiceAccount`, `tags[]`. Tenant
  membership is TWO tenant-scoped join rows: `UserRoleAssignment` and `UserDepartment`;
  `assertUserBelongsToTenant` (`common/tenant-guards.ts:164`) requires BOTH to be ENABLED.
- `UserProfile` (`user.prisma:154`) is 1:1 with `User` and has **no `staffId`** and no tenant
  column; its only unique is `userId`.
- Roles are SYSTEM-owned shared-read rows (`SYSTEM_SHARED_READ_MODELS` includes `Role`);
  the seeded clinical role is `DOCTOR` = `00000000-0000-0000-0000-000000000010`
  (`seed/00-constants.ts:192`) carrying `consultation-own-manage` — the ability
  `assertNamedClinicianMayOwnConsultation` requires (`create:Consultation`).
- **JIT precedent**: `FederatedAuthService.provisionUser` (`federated-auth.service.ts:396`)
  creates `User { username: '<protocol>:<providerId>:<subject>', password: '' }`,
  `UserRoleAssignment`, `UserDepartment (isPrimary: true)` and a `FederatedIdentity` link in ONE
  `$transaction`, then upserts the profile email and emits four `ResourceCreated` sys-events.
  `password: ''` is the house "no local credential" sentinel (`user.service.ts:131`);
  `UserService.create` enforces the `maxUsers` seat quota through
  `IEntitlementsService.assertQuantityQuota`. There is no username generator and no
  per-tenant "is taken" helper anywhere.
- Admin surface: `POST/PATCH admin/users`, `UserProfileService.upsertByUserId`
  (`userProfile.service.ts:130`), console `features/users/components/user-profile-tab.tsx`
  (first name / last name / email / phone).

### The three machine planes and who "acts"

| Plane | Route | Payload carrying context | Acting user today |
|---|---|---|---|
| Consultation open | `POST consultations/open` (`consultation.controller.ts:480`) | `OpenConsultationRequest` has `metadata` but **no `context`** | `resolveActingClinicianId` (`:271`): a service account MUST send `clinicianUserId` (400 `CLINICIAN_REQUIRED`), a human must not; `assertNamedClinicianMayOwnConsultation` (404-over-403) → `doctorId`; dispatch threads `userId: userId ?? doctorId` into `subject.userId` (`consultation.service.ts:484`) |
| Agent invocation | `POST agents/:slug/invocations` (`agent.controller.ts:200`) | `context` (validated vs the agent's frozen schema) | **none** — the service never reads `requestUser`; no actor column on `AgentTrajectory` |
| Workflow run | `POST workflows/:slug/runs` and `POST consultations/:id/workflows/:slug/runs` (`workflows.controller.ts:111`) | `input` only (validated in the harness against the trigger's frozen schema); a caller-supplied reserved key is a 400 | `subject.userId = this.requestUserId ?? undefined` → **undefined for a service account** (`workflow-exposure.service.ts:620`); `WorkflowRun` has no actor column |

CLS shape: a service account lives on `cls.serviceAccount` and NEVER on `cls.user`
(`unified-auth.guard.ts:555`), so `requestUserId` is null for a machine; `broadcastSysEvent`
records `responsibleServiceAccountId` XOR `responsibleEntityId` (`base.service.ts:99`) and
`AuditLog` has no `onBehalfOf`. API keys DO populate `cls.user` with the key's bound human.

### Downstream consumer this unblocks

The ALaaS broker (`audio-stream-svc`) currently maps its consultant ids to HOPE usernames with a
hand-maintained JSON file. With this ticket it sends the consultant id inside the schema-typed
context payload and HOPE resolves or provisions the clinician. No ALaaS change is in scope here;
the contract it will adopt is D-5 below.

## Implementation Plan

### Decisions taken (owner may override)

| # | Decision | Rationale |
|---|---|---|
| **D-1** | The identity field is declared by a **kind-level marker**, `userIdentity: { field: '<property key>' }`, on a `STRUCTURED` kind with `cardinality: 'ONE'`; the named property must exist in `fields.properties` with `type: 'string'`; at most one marker per definition. Publish gate in `kindProblems` + a new definition-level check. Adding, moving or removing the marker classifies **ADDITIVE** (the payload contract does not change). | A sixth primitive would touch the closed `CONTEXT_PRIMITIVES` set in five copies plus codegen; a custom JSON-schema keyword would touch the subset grammar in three copies. A kind key touches one allow-list and three passive type mirrors. |
| **D-2** | **Presence is governed by the schema's own `required` flags** (kind `required`, property `required`), never by the marker. The marker says what to do with a value when it is present. | Keeps one validator (`payloadSchemaFromDefinition` / `validateContextPayload`) authoritative for "must be sent"; an integrator that wants identity mandatory marks the property required, as with any other field. |
| **D-3** | One derivation, `userIdentityBindingFromDefinition(definition) → { kindKey, field } \| null`, beside `payloadSchemaFromDefinition`; **frozen** into `compiledConfig.contextSchema.userIdentity` at agent publish and into `core.trigger.contextSchema.userIdentity` by the workflow compiler; read **live** from the matched kind on the consultation plane (the plane whose validator is already live). | Mirrors how the payload schema itself reaches each plane today — no runtime schema read on the invocation planes (TASK-890 invariant 4), live department → tenant resolution on the consultation plane. |
| **D-4** | Storage is **`UserProfile.staffId String?` + `@@index([staffId])`** (the owner's wording). Per-tenant uniqueness is enforced in the application: the resolver runs its find-or-create under `pg_advisory_xact_lock(hashtext(tenantId \|\| ':' \|\| staffId))` and re-checks inside the transaction; the admin profile write path rejects a duplicate in the same tenant with **409 `STAFF_ID_TAKEN`**. No DB unique (the profile has no tenant column; a user's tenant is its role assignment). | Honours "mapped to `staff_id` in the UserProfile" and shows the value on the user's profile in the console. The alternative — a tenant-scoped link table with a DB unique — is OD-2. |
| **D-5** | **Only service-account callers trigger resolution and provisioning.** For JWT and API-key callers the field is validated as ordinary content and otherwise ignored (the caller — or the key's bound human — IS the clinician). | TASK-933's credential-class line: "a human caller already IS the clinician, and naming a different one would be an impersonation". An API key is bound to a human and can never reach `/admin/*`; it must not be able to mint users either. |
| **D-6** | Per-plane wiring (details in §Lanes): **open** — new optional `context?: Record<string, unknown>` on `OpenConsultationRequest` (same `{ [kindKey]: payload }` shape as agent `context` and the codegen types), validated per kind with `validateContextPayload(…, departmentId)` (the department-effective bundle — the contract `hope.tenants.contextSchema()` advertises and `vox-codegen --tenant` types), resolved user → `doctorId`; **agent invocations** — after the existing `contextProblems` gate, resolve `context[kindKey][field]` → provision + attribution (`actingUserId` on the trajectory `_metadata` and the invocation sys-event); **workflow runs** — resolve `input[kindKey][field]` → provision + `subject.userId` (today `undefined` for a machine). Case-note writes (`POST :id/context`) validate the field as content only; identity is fixed at open. | The consultation plane already validates context live against the effective bundle and threads `doctorId` into the run subject; the invocation planes already carry a frozen schema and a `subject` channel. Each plane gets the smallest insertion that reuses its existing gate. |
| **D-7** | `clinicianUserId` and the identity field may both be sent; when both are present they **must agree** (400 `CLINICIAN_MISMATCH`). `CLINICIAN_REQUIRED` now fires only when a machine sends **neither**. | Backward compatible for TASK-933 integrators; no silent precedence. |
| **D-8** | Provisioning writes, in ONE transaction: `User { username: 'auto_' + 16 hex (crypto), password: '', isServiceAccount: false, tags: ['auto-provisioned'], _metadata.provisioning: { source: 'context-schema', kindKey, field, serviceAccountId, at } }`, `UserProfile { userId, staffId }`, `UserRoleAssignment { roleId, tenantId }`, `UserDepartment { departmentId, isPrimary: true }`. Username collision → regenerate (≤ 3 attempts). `SUPER_ADMIN` is never assignable here (JIT guard mirrored). The `maxUsers` seat quota applies (`QuotaExceededException` → 409). Sys-events via `broadcastSysEvent(ResourceCreated)` for all four rows, actor = the service account. | Same four-row shape and same sentinels as `FederatedAuthService.provisionUser`, so "how a HOPE user gets created" still has one answer. The staff id never appears in the username (it may be PII). |
| **D-9** | Role and department for provisioning are **configuration**, not schema content: three `db-config` descriptors, tenant → SYSTEM cascade — `identity.autoProvision.enabled` (boolean, `open-to-default`), `identity.autoProvision.roleId` (string, `closed`; SYSTEM row seeded to the `DOCTOR` id — a seed row, not a code literal), `identity.autoProvision.departmentId` (string, `closed`, tenant-scoped only). Department resolution order: request `departmentId` → tenant setting → **fail closed** 400 `USER_IDENTITY_DEPARTMENT_UNRESOLVED`. | A schema version is cloned from SYSTEM into every tenant (content); a tenant's department id cannot ride in it. Selection is `failMode: closed` per the configuration rules; a user without a department would be an unloggable account that later 404s at open — the seed treats that as fatal, so the resolver does too. |
| **D-10** | Resolution outcomes: exactly one ENABLED match → reuse; a match whose user is not ENABLED → **404 `USER_IDENTITY_NOT_USABLE`** (never re-provision a duplicate); more than one match → **409 `USER_IDENTITY_AMBIGUOUS`** (a data defect is surfaced, not hidden); no match and provisioning disabled → **404 `USER_IDENTITY_UNKNOWN`**. Value normalisation: trim; empty, > 128 chars or control characters → 400 `USER_IDENTITY_INVALID`. | 404-over-403 for anything about the user id space (`assertNamedClinicianMayOwnConsultation` precedent). |
| **D-11** | Audit attribution is unchanged: `responsibleServiceAccountId` names the actor; the resolved user is business data (`Consultation.doctorId`, `subject.userId`, sys-event `actingUserId`, `_metadata.provisioning` on the new `User`). `createdBy` on rows written by a machine keeps today's behaviour. | `AuditLog`'s "exactly one of two actors" contract (`audit.prisma:10`) is deliberate; stamping the clinician as the writer would attribute a machine action to a person. OD-6 lets the owner choose otherwise. |
| **D-12** | Console scope: (a) schema editor — on a STRUCTURED kind, a "User identity field" select over that kind's string properties (one per schema; `Identity` badge beside `Required`); (b) user profile tab — a `Staff ID` field (read/edit, 409 → toast); (c) users list — `Auto-provisioned` badge from `tags`. `payload-tester` unchanged. | The smallest surface that lets a tenant admin declare R1 and see R2. |
| **D-13** | SDK scope: `@arcaai/vox-node` `OpenConsultationRequest.context?` (body passthrough); the three `ContextKindDeclaration` mirrors gain `userIdentity?`; `vox-codegen` emits a `/** @identity */` JSDoc on the marked property. No browser-SDK change (`session.open` is a human plane). | Type-only; the marker rides through the discovery bundle untouched. |

### Open decisions for the owner (OD)

| # | Question | Options | Recommendation |
|---|---|---|---|
| **OD-0** | Ticket number | TASK-950 / other | TASK-950 (archive not readable here) |
| **OD-1** | Confirm the reversal of TASK-933 §2.3 for this ONE field: the schema may name the clinician-identity field and the gateway resolves it to `doctorId` before the row is written | yes / no | **yes** — recorded here and cross-linked from the TASK-933 README |
| **OD-2** | Where the staff id lives | **A** `UserProfile.staffId` (owner's wording; app-enforced per-tenant uniqueness under an advisory lock) / **B** tenant-scoped `TenantStaffIdentity { tenantId, userId, staffId, @@unique([tenantId, staffId]) }` mirroring `FederatedIdentity` (DB-guaranteed uniqueness; not visible as a profile field) | **A** |
| **OD-3** | Platform default of `identity.autoProvision.enabled` | ON at SYSTEM with tenant opt-out / OFF until a tenant opts in | **ON** — the ask says HOPE "will create a user" |
| **OD-4** | Which schema decides at consultation open | **department-effective bundle** (what `tenants/me/context-schema` advertises, what codegen types, what case-note writes already validate against) / the governing workflow's frozen trigger binding | **effective bundle** — the invocation planes keep their frozen bindings |
| **OD-5** | Identity field present on a consultation-bound run or a case-note write after open | ignore (content only; identity fixed at open) / 400 on mismatch with the row's `doctorId` | **ignore** |
| **OD-6** | `createdBy` on rows a machine writes for a resolved clinician | keep the sentinel / stamp the resolved user | **keep** (D-11) |
| **OD-7** | Username shape for provisioned users | `auto_<16 hex>` + tag `auto-provisioned` / `<tenantKey>_<hex>` | `auto_<16 hex>` |
| **OD-8** | Department when the request has none (agent / workflow planes) | tenant setting → fail closed 400 / create the user without a department | **fail closed** (D-9) |
| **OD-9** | Seat quota (`maxUsers`) on auto-provisioning | applies (409 surfaces to the integrator) / bypass | **applies** |
| **OD-10** | Role for provisioned users | SYSTEM `DOCTOR` via `identity.autoProvision.roleId` (tenant may point at its own cloned role) / a fixed role | **setting, DOCTOR default** (D-9) |

### Lanes and waves (on **go**)

Tiering per `14-multi-agent-worktrees.md` §1: mechanical lanes on `sonnet`, deciding lanes on
`opus`, the orchestrator verifies every gate itself. Shared surfaces (migration, `db:push`,
`pnpm install`, merges, artifact regeneration) stay with the orchestrator.

**Wave 0 — orchestrator, primary checkout, sequential (everything else branches from it)**

| Step | Work | Gate |
|---|---|---|
| W0-a | Migration `task_950_user_profile_staff_id` (authored on a shadow DB per `02-database-prisma.md`): `ALTER TABLE core."UserProfile" ADD COLUMN "staffId" TEXT; CREATE INDEX "UserProfile_staffId_idx" …`. `pnpm gen:model`; hand-edit `UserProfileEntity` / `UserProfileEntityMapper` / factory; `gen:entity` + `gen:factory` coverage green; `pnpm db:push` on dev. | `pnpm --filter @arcaai/domains build test`; `gen:*:check` no drift |
| W0-b | `context-schema-definition.ts`: `userIdentity` in `KIND_KEYS`, `ContextKindDeclaration.userIdentity?`, `kindProblems` + definition-level single-marker gate, `userIdentityBindingFromDefinition`; `definition-diff.ts` unchanged but pinned by a test (marker edits are ADDITIVE). | `pnpm --filter @arcaai/applications test -- context-schema-definition` |
| W0-c | `settings-registry/descriptors/user-identity.descriptors.ts` (three descriptors, D-9) + SYSTEM seed rows in `seed/11-global-setting.ts` (`enabled: true` per OD-3, `roleId: DOCTOR`). | registry parity tests; `pnpm db:seed` on dev |
| W0-d | Commit; record the confirmed ticket number and OD answers in this README. | — |

**Wave 1 — four worktrees in parallel**

| Lane | Tier | Owns | Deliverable |
|---|---|---|---|
| **L1 identity service** | opus | `packages/applications/src/services/user/identity/**` (new: `IContextUserIdentityService.ts`, `context-user-identity.service.ts`, module, DTOs), `userProfile/**` (staffId on request/response DTOs + 409 duplicate check) | `resolveOrProvision({ tenantId, staffId, departmentId?, provenance }) → { userId, provisioned }` per D-8/D-9/D-10; advisory lock; quota; sys-events; unit tests with mocked repos |
| **L2 freeze the marker** | opus | `services/agent/agent.service.ts` (`resolveContextSchema`), `packages/workflow-contract/src/compiler.ts` (`ResolvedTriggerContextSchema.userIdentity`), harness `test_compiled_config.py` (assert the extra key is tolerated) | `compiledConfig.contextSchema.userIdentity` on agents; `core.trigger.contextSchema.userIdentity` on compiled workflows; parity fixture updated if it pins the trigger shape |
| **L3 console** | sonnet | `apps/admin-console/src/features/context-schemas/**`, `features/users/**` | D-12 (a)(b)(c); Vitest + axe on both screens |
| **L4 SDKs** | sonnet | `packages/vox-node/src/types/**`, `resources/consultations.ts` docs, `packages/vox-codegen/src/{types,generate}.ts` | D-13; unit tests; `sdk-node:check:exports` |

**Wave 2 — two worktrees after L1 + L2 merge**

| Lane | Tier | Owns | Deliverable |
|---|---|---|---|
| **L5 consultation open** | opus | `services/consultation/consultation/{dto,consultation.service.ts}`, `apps/api/src/modules/consultation/consultation.controller.ts` (`resolveActingClinicianId`), new e2e `apps/api/tests/e2e/task-950-context-identity.spec.ts` | `OpenConsultationRequest.context`; per-kind `validateContextPayload(…, departmentId)`; identity → `doctorId`; D-7 agreement rule; e2e (below) |
| **L6 invocation planes** | opus | `services/agent/agent-invocation.service.ts`, `services/workflow-exposure/workflow-exposure.service.ts`, `apps/api/src/modules/{agent,workflows}/**` | resolve after the existing context gate; `subject.userId`; `actingUserId` in sys-events / trajectory metadata; unit tests + e2e cases in the same spec |

**Wave 3 — orchestrator**

Merge L5/L6 into `dev-2.2`; regenerate the five artifacts
(`pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin`);
run the full gate list below; live proof against the running dev stack; update this README with
pasted evidence; set status `Review`.

### TDD test list (RED first, per lane)

**W0-b `context-schema-definition.test.ts`**
1. `userIdentity` on a STRUCTURED / ONE kind whose `fields.properties[field]` is a string → no problems.
2. `userIdentity` on a `TEXT` kind → `must be STRUCTURED`; on `cardinality: 'MANY'` → problem.
3. `field` not in `fields.properties`, or not `type: 'string'` → problem naming the property.
4. Two kinds carrying `userIdentity` → one definition-level problem.
5. `userIdentityBindingFromDefinition` returns `{ kindKey, field }` / `null`; `payloadSchemaFromDefinition` output is byte-identical with and without the marker.
6. `classifyDefinitionChange`: add / move / remove the marker → `ADDITIVE`.

**L1 `context-user-identity.service.test.ts`**
7. Existing ENABLED user with `staffId` in the tenant → `{ userId, provisioned: false }`, no writes.
8. Same `staffId` in ANOTHER tenant → not matched → provisions a new user (cross-tenant isolation).
9. Match on a DISABLED user → 404 `USER_IDENTITY_NOT_USABLE`; two matches → 409 `USER_IDENTITY_AMBIGUOUS`.
10. No match, `enabled: false` → 404 `USER_IDENTITY_UNKNOWN`; no writes.
11. No match, enabled → one `$transaction` creating User (`username` matches `/^auto_[0-9a-f]{16}$/`, `password: ''`, tag, `_metadata.provisioning`), UserProfile (`staffId`), UserRoleAssignment (setting role), UserDepartment (request department, `isPrimary: true`); four `ResourceCreated` broadcasts.
12. Department: request → setting → 400 `USER_IDENTITY_DEPARTMENT_UNRESOLVED`; role resolving to `SUPER_ADMIN` → 403.
13. Quota: `assertQuantityQuota('maxUsers')` called; `QuotaExceededException` propagates.
14. Normalisation: `'  DR-1 '` → `'DR-1'`; `''`, 129 chars, `'a b'` → 400 `USER_IDENTITY_INVALID`.
15. Username collision on the unique index → regenerated once; three collisions → error.
16. `UserProfileService.upsertByUserId({ staffId })` with a duplicate in the same tenant → 409 `STAFF_ID_TAKEN`; same value in another tenant → allowed.

**L2**
17. `AgentService.resolveContextSchema` freezes `userIdentity` beside `payloadSchema`; absent marker → key absent (not `null`).
18. Compiler: `core.trigger` with a referenced schema carrying the marker → `contextSchema.userIdentity` frozen; inline schema → derived the same way.
19. Harness `test_compiled_config.py`: a trigger config carrying `userIdentity` still validates / runs (`_authored_context` unaffected).

**L5 unit + e2e (`task-950-context-identity.spec.ts`, service account `hope_svc_a4ca1a11ad3141b0c0de0001`, ArcaAI)**
20. `open` with `context` violating the effective schema → 400 `CONTEXT_SCHEMA_VIOLATION` (per-kind problems listed).
21. Machine `open` with `context.<kind>.<field> = 'DR-950-<run>'` and no `clinicianUserId` → 201; `doctorId` is a NEW user; `GET admin/users/:id` shows `profile.staffId`, `tags: ['auto-provisioned']`, DOCTOR role, `GEN_ARCAAI` department.
22. Second machine `open` with the same value → same `doctorId`, no new user.
23. `clinicianUserId` + identity that disagree → 400 `CLINICIAN_MISMATCH`; that agree → 201.
24. Machine `open` with neither → 400 `CLINICIAN_REQUIRED` (unchanged).
25. Human (tenant-admin JWT) `open` with the identity field → 201, `doctorId` = the caller, no user created.
26. `identity.autoProvision.enabled = false` written for ArcaAI → unknown staff id → 404 `USER_IDENTITY_UNKNOWN`; restored afterwards.
27. TASK-933 and TASK-658 specs stay green (regression).

**L6**
28. Agent invocation by a machine with the field → user provisioned; response unchanged; sys-event / trajectory carries `actingUserId`; human caller → no provisioning.
29. `POST workflows/:slug/runs` by a machine with `input.<kind>.<field>` → `startWorkflowRun` called with `subject.userId = resolved`; reserved-key rejection unchanged.
30. Consultation-bound run with the field → validated, ignored (OD-5), `subject.userId` unchanged.

### Files — creation / modification order

1. `packages/database/src/prisma/db_main/user.prisma` (+ migration folder `…_task_950_user_profile_staff_id/migration.sql`)
2. `packages/domains/src/{models,entities,factories,mappers}/generated/core/UserProfile*.ts`
3. `packages/applications/src/services/consultation-context-schema/context-schema-definition.ts` (+ tests)
4. `packages/applications/src/services/settings-registry/descriptors/user-identity.descriptors.ts`; `packages/database/src/prisma/db_main/seed/11-global-setting.ts`
5. `packages/applications/src/services/user/identity/**` (new); `services/user/userProfile/{dto,userProfile.service.ts}`; `services/user/index.ts` barrels; service module registration
6. `packages/applications/src/services/agent/agent.service.ts`; `packages/workflow-contract/src/compiler.ts`; `apps/harness/src/harness/tests/unit/temporal/interpreter/test_compiled_config.py`
7. `packages/applications/src/services/consultation/consultation/dto/open-consultation.request.ts`, `consultation.service.ts`; `apps/api/src/modules/consultation/consultation.controller.ts`
8. `packages/applications/src/services/agent/agent-invocation.service.ts`; `services/workflow-exposure/workflow-exposure.service.ts`
9. `packages/vox-node/src/types/{consultation-realtime,consultation-context-schema}.ts`; `packages/vox-codegen/src/{types,generate}.ts`
10. `apps/admin-console/src/features/context-schemas/{api/types.ts,components/definition-editor.tsx}`; `features/users/{api/types.ts,components/user-profile-tab.tsx,components/users-list*.tsx}`
11. `apps/api/tests/e2e/task-950-context-identity.spec.ts`; five regenerated artifacts (`route-manifest.json`, `openapi.json`, portal, `vox-node/src/resources/admin/**`)
12. `docs/implementation/TASK-933-…/README.md` — one Change History line cross-referencing OD-1

### Verification criteria (definition of done)

- [ ] `pnpm --filter @arcaai/domains build test`; `gen:model:check` / `gen:entity:check` / `gen:factory:check` no drift, schema coverage OK
- [ ] `pnpm --filter @arcaai/applications build test` (tests 1–19 green, RED output captured first)
- [ ] `pnpm --filter @arcaai/workflow-contract test`; `pnpm harness:test` (`test_compiled_config`, parity fixture)
- [ ] `pnpm api:build`, `pnpm test:unit`, `pnpm lint` (hard errors in `apps/api`)
- [ ] e2e: `npx dotenv -e .env.test -- npx playwright test task-950 task-933 task-658` green against a live test gateway
- [ ] `pnpm --filter @arcaai/admin-console build lint test`; axe 0 violations on `/context-schemas` and `/users/:id`; both themes
- [ ] `pnpm sdk-node:build test check:exports`; `pnpm --filter @arcaai/vox-codegen test`
- [ ] Five artifacts regenerated and committed together; `api:openapi:check`, `api:portal:check`, `gen:admin:check` green; `task-776-route-authz-matrix` green
- [ ] Live proof on the dev stack: a machine `open` with `context.context.consultant_id` creates the user (screenshot of the user's profile with Staff ID), second `open` reuses it, evidence pasted below
- [ ] New env vars: none (all three knobs are `db-config` descriptors)

## Implementation Summary

### Execution model (owner directive, 2026-09-11)

> "lets align and manage agents for maximizing working parallel without overlapping tasks or
> works, using appropriate model-effort tiers. agent wont run any gated tests, you are the one
> who review, finalize, perform gated tests, after all changes merged to `dev-2.2`"

Executed as ONE wave of seven lanes, each in its own git worktree with a disjoint file boundary
and a self-contained brief carrying the pinned contracts (C1 marker + derivation, C2 identity
service, C3 `UserProfile.staffId`, C4 open, C5 invocation planes). No lane ran any test, build,
lint, install, DB or infra command; the orchestrator reviewed every diff, merged into `dev-2.2`,
and ran every gate. Recommended OD answers were applied (the owner did not override any).

| Lane | Tier | Scope | Commit | Merge |
|---|---|---|---|---|
| A | sonnet | Prisma + migration + domain trio + SYSTEM seed rows | `78f850688` | `e709a7096` |
| B | opus | marker grammar, `userIdentityBindingFromDefinition`, freeze into agents + compiled triggers | `db5c03dd2` | `47d1aca5d` |
| C | opus | `ContextUserIdentityService`, `UserProfile.staffId` DTOs/409, `identity.autoProvision.*` descriptors | `487587b0e` | `85401eeee` |
| D | opus | `POST consultations/open` `context` + identity → `doctorId`, e2e | `edbe1293d` | (merge after C) |
| E | opus | agent invocations + workflow runs, e2e | `e3c5ff831` | (merge after D) |
| F | sonnet | `@arcaai/vox-node` `open().context`, codegen `@identity` | `0add646ea` | `298989210` |
| G | sonnet | console editor picker, Staff ID on the profile, badge | `2df72e992` | `f2884a472` |

Orchestrator fixups on `dev-2.2`: `f2c7ac587` (seed reset value = descriptor default),
`ca0d836fd` (single `UserIdentityBinding` export; three lane E test premises), plus the domains
insert-path test correction.

### Accepted deviations from the plan (recorded, not silently absorbed)

| # | Plan said | Shipped | Why |
|---|---|---|---|
| 1 | D-9: descriptors on the `db-config` tier | **`global-kv`**, `maxScope: 'tenant'` | `EffectiveSettingsService.resolveEffective` has no resolver for `db-config` keys outside storage, and `SettingsRegistryWriteService` refuses every tier but `global-kv` — as `db-config` the flag could neither resolve nor be set by a tenant. `GlobalSetting` IS the `global-kv` store, so the cascade is exactly D-9's. |
| 2 | D-6: workflow runs stamp `subject.userId` | Standalone runs **provision + record `actingUserId`** on the run's `ResourceCreated` event; `subject` stays absent | `StartWorkflowRunSubject.consultationId` is required (`harness-gateway.service.ts`) and the harness `RunSubject` forbids a consultation-less subject (`interpreter/models.py`, `extra="forbid"`) — a subject with only `userId` is a 422. Widening both is an owner decision. Pinned by a unit test naming both files. |
| 3 | D-6: agent-plane attribution on trajectory metadata | Structured log `agent.invocation.identity_resolved` + the resolver's own `ResourceCreated` provenance (`plane: 'agent-invocation'`) | `AgentInvocationService` broadcasts no sys-event and writes no trajectory row; durable per-invocation attribution needs a new channel — follow-up. |
| 4 | D-8: `_metadata.provisioning` via the factory | `tx.user.update` inside the same transaction | `UserEntity` surfaces no `metaData` prop. |
| 5 | e2e test 21: `GET admin/users/:id` shows `profile.staffId` | `GET admin/users/:id/profile` | `UserResponse` has no profile embed; `tags` is not exposed over HTTP either, so provenance is asserted via the `auto_<16 hex>` username + profile + department. |
| 6 | Controller passes `{ clinicianUserId, serviceAccountId }` | `getOrCreate(request, doctorId \| null)`; the service reads `requestServiceAccount` itself | Existing TASK-933 controller tests assert the two-argument call. |
| 7 | Lane E `subject.userId` fix on open | Dispatch subject now `saved.doctorId` (was `userId ?? doctorId`) | The parameter is `null` on the identity path. |
| 8 | Lane B boundary | Also edited `IConsultationContextSchemaService.ts`, `consultation-context-schema.service.ts` (the one derivation in `resolveReference`), `workflow-definition.service.ts` (4 lines) | Without them the freeze sites had a type and no producer; no other lane owned those files. |
| 9 | Lane C boundary | No change to `@arcaai/logger` usage — NestJS `Logger` | 175 files in `packages/applications` use the NestJS logger; none import `@arcaai/logger`. |

### Gate evidence (orchestrator, primary checkout unless noted)

| Gate | Result |
|---|---|
| Baseline before any merge | domains 1910 passed; applications 12866 passed (one DB-bound integration file failed only because the test DB was down) |
| Migration | shadow DB replay: `Applying migration 20260911120000_task_950_user_profile_staff_id` … `-- This is an empty migration.`; `\d core."UserProfile"` shows `staffId text` + `UserProfile_staffId_idx`; dev DB `db:push` in sync |
| `gen:model:check` / `gen:entity:check` / `gen:factory:check` | no drift (181 / 103 / 103 files); schema coverage OK (101 artifacts / 105 models) |
| `@arcaai/domains` build + test | build OK; 1925 tests green after the insert-path assertion fix |
| `RUN_SEED=safe` on dev | exit 0; rows `identity.autoProvision.enabled = true/true`, `identity.autoProvision.roleId = …0010`, both `locked` |
| Lane B targeted vitest | 47 passed (definition ×2, diff, agent freeze, repaired task890 reference test, workflow-definition ref) |
| `@arcaai/workflow-contract` build + test | OK; 937 passed |
| `pnpm harness:test:unit` | 2412 passed; new `test_compiled_config_user_identity_task950.py` at 100 % |
| `@arcaai/vox-node` build / test / check:exports / lint / typecheck | all exit 0; 34 test files |
| `@arcaai/vox-codegen` build / test / lint | exit 0; 67 tests |
| `@arcaai/admin-console` test / lint / build | 2883 tests, lint clean, build exit 0 (Turbopack `instrumentation.ts` Edge warnings pre-exist) |
| Lane C targeted vitest | 477 passed (identity, userProfile, settings-registry) |
| Lane D targeted vitest | consultation service 203, API consultation controller 255 |
| Lane E targeted vitest | agent + workflow-exposure 440 + 70 after the three test-premise fixes; API agent/workflows controllers 117 |
| Verification worktree (`dev-2.2`): `turbo build --filter='@arcaai/api^...'`, `api:build`, `route-manifest`, `api:openapi`, `api:portal`, `gen:admin` | all exit 0; `api:openapi:check` OK, `api:portal:check` no drift (admin 662 / business 200 ops), `gen:admin:check` no drift (49 areas, 422 routes, 428 schemas); artifacts committed `20e9b3f86` |
| `@arcaai/applications` FULL suite | 12987 passed / 6 skipped; the one failed FILE is `agentPromotion/__tests__/integration/membership-bounded-sync.integration.test.ts` (needs the live TEST DB on 5433, held by ALaaS — same as the pre-merge baseline) |
| `@arcaai/api` FULL vitest | 4358 passed / 4 skipped; the one failure is `tests/integration/summary-provenance.spec.ts` expecting no `redactionApplied` key — the mapper gained it in TASK-932 (`f369003fc`, 2026-09-09), the spec was last touched 2026-09-04: pre-existing on the base, not TASK-950 |
| Lint | `apps/api` clean after prettier on lane E's two controllers + spec (`432e54f22`); `@arcaai/applications`, `@arcaai/workflow-contract`, `@arcaai/domains` exit 0 (`packages/database` has no lint script) |
| API e2e — `task-950-consultation-identity.spec.ts` | **13/13 passed** against the worktree gateway (8869): provision on first `open`, reuse on second, `CONTEXT_SCHEMA_VIOLATION`, unknown kind, agree/mismatch (`CLINICIAN_MISMATCH`), `CLINICIAN_REQUIRED`, `clinicianUserId`-only unchanged, human caller opens as self, opt-out → `USER_IDENTITY_UNKNOWN`, known id still resolves, override removal restores. Made re-runnable on a persistent DB (`e1418982f`) |
| API e2e — `task-950-invocation-identity.spec.ts` | **7/7 passed**: marked schema publish, agent bound to it, machine invoke provisions, second invoke reuses, human provisions nobody, blank id mints nobody, probe tenant = ArcaAI (workflow half pinned by unit tests — see deviation 2) |
| API e2e — regressions `task-933`, `task-658` | 2 failures, BOTH environmental and reproduced on the peer's own gateway: `task-933` "recording/start must record the governing run" — dispatch logged `connect ECONNREFUSED :8866` (no harness running here); `task-658` "context write … 201" got 404 because the dev-mode Vault restarted at 16:49Z after the seeded context items were encrypted at 07:01Z, so `ConsultationRepository.findWithContext` swallows the decrypt error and answers `null` (a `db:all` reseed fixes it; nothing in TASK-950 touches that path) |
| Live evidence (dev DB, after the e2e runs) | `select username, staffId, tags, role, department …` → five `auto_<16 hex>` users, `staffId` = the sent value, `tags {auto-provisioned}`, tenant ArcaAI, role DOCTOR, department `GEN_ARCAAI`; 10 consultations with `doctorId` = one of them |
| Console runtime pass | NOT done by the orchestrator: the browser-safety policy forbids typing a password into the login form. Automated console gates are green (2883 tests incl. axe on both themes for the new picker and the Staff ID field). For the owner: console `http://localhost:5178` (worktree, `NEXT_PUBLIC_API_HOST=http://localhost:8869`) → Users → any `auto_…` user → Profile tab shows Staff ID; Context schemas → `consultation_gen_arcaai` → the `vitals` kind shows the "User identity field" picker |

Environment note: a peer session holds uncommitted edits to `live-documentation.service.ts`,
`realtime-node-registry.ts`, `agent-schemas.ts` (+ a test) in the primary checkout, so compile
gates and artifact regeneration run in a dedicated worktree `../hope-v2-task-950-verify`
(branch `task-950/verify`, fast-forwarded to `dev-2.2`). The isolated test infra cannot start
(the ALaaS stack holds ports 5433/6380), so API e2e runs against the worktree gateway with
`RESET_DB=false`, as the TASK-933 spec documents.

## Owner decisions 2 and 3 — options (requested 2026-09-11, owner decides)

Facts these rest on (verified in code): `StartWorkflowRunSubject.consultationId` is required and the
harness `RunSubject` mirrors it with `extra="forbid"`; every one of the 17 `run_identity(...)`
readers in the harness already guards on a missing `consultation_id`; `WorkflowRun` has no actor
column but a `_metadata` JSONB; `AgentInvocationService` writes no row and broadcasts no event,
while every LLM call already lands an `AiUsageEvent` row whose `doctorId` the agent controller
leaves `null`; `AuditLog.data` persists arbitrary JSON verbatim (the run's `ResourceCreated`
event already carries `actingUserId`), and every existing "second actor" (impersonation,
TASK-950 provenance) lives in a JSONB bag, never in an actor column.

### Decision 2 — standalone workflow runs and the acting user

| | Fast win (minimum change) | Best fit with the new implementation |
|---|---|---|
| What | Stamp `actingUserId` into `WorkflowRun._metadata` at `recordRunStarted` (new optional `metaData` on `RecordRunStartedInput`, set by the exposure plane) and surface it on `WorkflowRunStatusResponse`. The run's audit event already carries it. | Make the subject consultation-optional on BOTH sides: `StartWorkflowRunSubject.consultationId?` and harness `RunSubject.consultation_id: str \| None` (+ the same `is not None` guard in `as_run_payload_identity` the other two fields have). The exposure plane then sends `subject: { userId }` for a standalone machine run, so `run_identity(...).user_id` is available to every node on the same non-composable channel consultation runs use. Add a real `WorkflowRun.actingUserId` column for queryability. |
| Touches | `record-run.input.ts`, `workflow-run.service.ts`, `workflow-exposure.service.ts`, one DTO mapper + unit tests | the two subject types, `workflow-exposure.service.ts`, harness `models.py` + `test_compiled_config`/parity fixture, a migration + `WorkflowRun` trio, DTO mapper, e2e |
| Risk | none to the harness contract | the harness change is additive; the 17 readers already tolerate absence; parity fixture must be regenerated |
| Recommendation | Do this now regardless — it is the durable, queryable half either way. | Do this when a node needs the acting user for BEHAVIOUR (not only attribution); until then the fast win covers the audit need. |

### Decision 3 — agent invocations and the acting user

| | Fast win (minimum change) | Best fit with the new implementation |
|---|---|---|
| What | Return the resolved `actingUserId` from `invokeText`/stream to the agent controller and pass it as `doctorId` to the existing usage collector (`collector.take({ …, doctorId })`). Every invocation then has a durable, indexed, billing-grade row (`AiUsageEvent.doctorId`) — the same channel consultation calls use, and the one BYOK/CLOUD funding derivation already reads. | Fast win PLUS a per-invocation audit event: give `AgentInvocationService` an event channel (inject `EventEmitter2`, or extend `BaseService`) and broadcast `ResourceCreated` on `Agent` with `{ action: 'invoke', agentSlug, agentVersionId, principalType, serviceAccountId, actingUserId, provisioned }` — the exposure plane's exact shape. Cost: one `AuditLog` row per invocation (a deliberate compliance choice). |
| Touches | `agent-invocation.service.ts` (return value), `agent.controller.ts` (collector call), unit tests | + `agent.service.module.ts` providers, the sys-event fan-out, an e2e asserting the audit row |
| Recommendation | Do now. | Do if an attributable per-call audit trail is a compliance requirement; otherwise the usage row is the record. |

## Change History

| Date | Entry |
|---|---|
| 2026-09-11 | Ticket opened from the owner's requirement. Discovery (three read-only lanes) and plan written; status Pending, awaiting OD-0…OD-10 and an explicit go. |
| 2026-09-11 | Owner directive: maximise parallel lanes, tiered models, no lane runs gates. Seven worktree lanes spawned against pinned contracts; A, B, C, D, E, F, G merged into `dev-2.2` with per-lane gates (table above). Deviations 1–9 accepted on evidence. |
| 2026-09-11 | Mid-run a peer session ran `git checkout -b asr-transcript-timing-metadata` in the primary checkout, so the G/C/D/E merges landed on that branch; `dev-2.2` was fast-forwarded to `ca0d836fd` (every commit on the peer's branch was this ticket's) and all later work moved to the `../hope-v2-task-950-verify` worktree, which now checks out `dev-2.2`. Artifacts regenerated (`20e9b3f86`), full suites + lints run, e2e green for both TASK-950 specs, two environmental regressions attributed. Lane worktrees removed after `merge-base --is-ancestor` confirmed each merge. Status → **Review**; the owner's console click-through is the one open gate. |
| 2026-09-11 | Owner verified the console (auto_* users and the identity field picker) — the last gate is closed; dev DB reseeded by the owner. Options for decisions 2 and 3 written (fast win vs best fit); owner to decide. TASK-951 opened for the ArcaAI two-schema consolidation and the ALaaS realtime contract. |
