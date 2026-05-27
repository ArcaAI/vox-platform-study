# DDD Layers — Multi-Tenancy Code Review

> **Status update (2026-05-27)**: see [06-implementation-summary.md](./06-implementation-summary.md) for what was closed by TASK-305.

> **TASK-306 closure (2026-05-27):** Closed finding codes — C-1 (reads),
> C-3 (arrays), C-7 (finale), H-1, H-3 (= NEW-6), H-8 (= NEW-1), M-2 (= NEW-2),
> M-3, M-5, M-6, M-8, L-4 + NEW-1..NEW-4, NEW-6, NEW-7. Deferred to follow-up
> tickets: NEW-5 (F-2 — DnaWritingStyle GLOBAL_ADMIN bypass), F-1 (RLS),
> F-3 (SUPER_ADMIN posture consistency), F-5..F-8 (housekeeping +
> minor observability nits — see `docs/implementation/TASK-306-DDD-Layers-Followup/README.md` §8).
> Wave merges: W5.1 `78e7b354`, W5.2 `66b1d579`, W5.3 `60d9d798`,
> W5.4 `969e49df`, W5.5 `ec67a0d4`. Canonical closure record:
> [`07-ddd-layers-followup-closure.md`](./07-ddd-layers-followup-closure.md).
> In-line closure markers `[CLOSED W5.x <sha>]` appear next to each
> closed code in §A / §B inventory tables and the §C / §D / §E
> finding detail blocks below — finding descriptions are preserved
> for historical lineage.

**Reviewer**: `code-reviewer` subagent
**Date**: 2026-05-25
**Scope**: `packages/domains/` + `packages/applications/` (read-only)
**Files Reviewed**: ~60
**Overall Assessment**: **Request Changes — tenant-isolation enforcement is NOT reliable today.** The system relies almost exclusively on a single line of defense (the CASL `AuthorizationGuard` at the API layer). Domain entities, factories, repositories, application services, BullMQ processors, and `OnEvent` handlers all permit cross-tenant access by ID. Any bypass of the guard (internal call, BullMQ job, event handler, mis-decorated route) results in cross-tenant PHI leakage.

---

## Executive Summary

| Layer | Tenant scoping mechanism | Reliable? |
| --- | --- | --- |
| Database (PostgreSQL) | Application filter only — **NO RLS** is enabled on any table (see [research](./01-research-best-practices.md) §1.2 for the missing standard). PgBouncer `SET LOCAL` tests exist but RLS itself is not in production. | **No** |
| Domain entity | `BaseTenantEntity.tenantId` is `string \| null \| undefined`, public setter, no `validate()` requirement. | **No** |
| Factory | Every tenant-scoped factory accepts `tenantId?` optional, falling back to **empty-string `''`** (16 factories). | **No** |
| Repository (generic `Repository<T>`) | `findById`, `findFirst`, `findAll`, `update`, `delete`, `softDelete`, `restore` accept arbitrary `where`/`id` with NO tenant filter. | **No** |
| Repository (entity-specific) | Most pass `tenantId` in *some* methods but expose `findById`-style methods that don't. `ContextItemRepository` and `ConsultationRepository.findConsultationChain/findWithRelations/findWithContext` have NO tenant arg at all. | **Partial** |
| Application service (CRUD via `BaseService`) | Reads `this.tenantId` from CLS but rarely verifies entity ownership after `findById`. | **Inconsistent** |
| `OnEvent` handler / BullMQ processor | No CLS context; trust the job payload `tenantId` blindly, never compare to entity. | **No** |
| Cache keys (Redis) | A few JWT/idempotency keys are not tenant-prefixed; HIPAA-relevant data keys (idempotency, prompt cache) inherit tenant only by consultation/template id which is not tenant-prefixed. | **Partial** |

The pattern is correct in **5 services** (`department`, `prompt-management`, `stt/pipeline`, `tenant-bucket`, `storage-access-key`) which explicitly verify `entity.tenantId !== this.tenantId` → throw `NotFoundException` (DEF-C3 “no existence leak” pattern). Everywhere else this defense is missing.

Counts by severity:

- **BLOCKER**: 6
- **HIGH**: 9
- **MEDIUM**: 8
- **LOW / Hygiene**: 7

---

## A. Domain layer inventory

| Entity | `tenantId` required at ctor? | Factory enforces tenant? | Repo interface tenant-scoped? | Issues |
| --- | --- | --- | --- | --- |
| `ConsultationEntity` (PHI) | No — optional via `BaseTenantEntity` | **No** — `tenantId?` falls back to `''` | **No** — `findById`, `findConsultationChain`, `findWithRelations`, `findWithContext` take no tenant arg | BLOCKER C-1 [CLOSED W5.2 `66b1d579` — read-paths], C-2, C-4 |
| `ContextItemEntity` (PHI: transcripts, summaries) | No | No — `tenantId?` → `''` | **No** — every method takes `consultationId` or `id`, never `tenantId`; `findSharedContext(ids[])` and `findCaseNotesFromChain(ids[])` accept arbitrary id lists | BLOCKER C-3 [CLOSED W5.4 `969e49df` — arrays] |
| `AuditLogEntity` (HIPAA artifact) | No | No — `tenantId?` → `''` | **No** — `AuditLogRepository` is just `Repository<AuditLogEntity>` with no custom tenant-scoped methods | BLOCKER C-5 |
| `TenantEntity` | n/a (this *is* the tenant) | n/a | `findById` open to any caller | HIGH H-3 [CLOSED W5.1 `78e7b354`] |
| `UserEntity` | No (multi-tenant via `UserRoleAssignment`) | No | `findById` open | HIGH H-4 |
| `UserRoleAssignmentEntity` | No, optional | No | Open via `findById` | BLOCKER C-6 (privilege escalation) |
| `MediaEntity` (PHI files) | No | No | Open via `findById` | HIGH H-5 |
| `NamedEntityEntity` (PHI extractions) | No | No | Open | HIGH H-6 |
| `AudioRecordingEntity` (raw PHI audio) | No | No | Open | HIGH H-5 |
| `DepartmentEntity` | No (in entity) | No (in factory) | **Yes — verified in service** (`department.service.ts:175`) | OK |
| `NotificationEntity` | No | No | Open | MEDIUM M-1 |
| `TagEntity` | No | No | Open | MEDIUM M-2 |
| `WebhookEntity` | No | No | Open | MEDIUM M-2 [CLOSED W5.1 `78e7b354` + W5.3 `60d9d798`] |
| `PromptTemplateEntity` | No | No | **Yes — verified in service** (`prompt-management.service.ts:220, 326`) | OK |
| `GlobalSettingEntity` (per-tenant config + locked secrets) | No | No | Partially — `updateTenantConfigs` checks `existingConfig.tenantId !== tenant.id` but not vs caller’s CLS tenant | HIGH H-1 [CLOSED W5.3 `60d9d798`] |
| `AsrPipelineEntity` | No | No | **Yes — verified in service** (`stt/pipeline/pipeline.service.ts:148`) | OK |
| `TenantBucketEntity` | No | No | **Yes — verified in service** (`tenant-bucket.service.ts:64,110,252`) | OK |
| `ResourceSubscriptionEntity` | No | No | Open | MEDIUM M-3 [CLOSED W5.3 `60d9d798`] |
| All other generated entities (Tag, Webhook, ApiKey, SummaryMeta, …) | No | No | Open via `findById` | MEDIUM M-1..M-4 |

### Cross-cutting domain-layer findings

- `BaseTenantEntity` exposes a **public setter** for `tenantId` (`base.tenantEntity.ts:22`) and overrides `validate()` as a no-op (`base.tenantEntity.ts:35`). Per DDD, `tenantId` should be an immutable value-object set only in the constructor.
- `BaseTaggedEntity` inherits the same issue and *also* doesn’t require `tenantId`.
- The generic `Repository<DomainEntity, DatabaseModel>` (`common/repository.ts`) provides:
  - `findById(id)` → `where: { id }` only — **no tenant predicate**.
  - `findAll/findFirst/count` → accept raw `where` filters; callers may forget `tenantId`.
  - `update(id, entity)` / `delete(id)` / `softDelete(id)` / `restore(id)` / `updateWithVersion(id, entity, v)` → match by `id` only — any caller with a foreign id mutates that row.
  - `rawQueryUnsafe(query)` — an unfiltered SQL escape hatch, unreferenced but exported.
  - `$bulk(txns)` — no tenant tagging on bulk transactions.
- Mappers (`*EntityMapper.ts`) are pure `AutoClassMapper` shims; they preserve `tenantId` because Prisma carries the column, but they never **assert** that the mapped row’s `tenantId` matches an expected value. There is no “strip-on-output” or “stamp-on-input” logic.
- Domain events: `DomainEvent` base in `common/domainEvent.ts` has no tenant field; consultation pipeline events (`ConsultationPipelineEvent.*`) carry `tenantId` in the payload but no schema-level enforcement.

---

## B. Application services inventory

| Service | Tenant context source | Enforces scope? | Issues |
| --- | --- | --- | --- |
| `ConsultationService` | CLS (`this.tenantId`) | Partial — checks `if (!tenantId) throw` in `getOrCreate` / `createRevisit` / `getPatientHistory` / `listConsultations`, but `getById`, `getByIdWithRelations`, `getConsultationChain` skip the check entirely. | BLOCKER C-1 [CLOSED W5.2 `66b1d579` — read-paths], HIGH H-7 |
| `ContextService` | CLS | Partial — verifies CLS present, but never verifies `consultation.tenantId === this.tenantId` after `findById`. | BLOCKER C-3 [CLOSED W5.4 `969e49df` — arrays] |
| `AuditLogService` | CLS but unused for scoping | **No** — `fetchAll`, `fetchAllByResource`, `fetchAllCreatedByUser`, `fetchById`, `deleteById` are tenant-blind. | BLOCKER C-5 |
| `AuthorizationAuditService` | injected `tenantId` from caller param | **No** — bypasses repository via raw Prisma cast, `getAuthorizationHistory`/`getRecentDenials` query across tenants. | BLOCKER C-7 [CLOSED W5.1 `78e7b354` — finale] + HIGH H-8 [CLOSED W5.1 `78e7b354`] |
| `UserService` | CLS | **No** for `fetchById`, `update`, `deleteById`; explicit-tenant for `fetchAllByTenantId`. | BLOCKER C-6 |
| `UserRoleAssignmentService` | CLS | **No** — `fetchAll`, `fetchById`, `update`, `deleteById` are open; `create` accepts `request.tenantId` without comparing to `this.tenantId`. | BLOCKER C-6 (privilege escalation) |
| `TenantService` | CLS + super-admin check | Partial — `fetchTenantConfigs` resolves *any* tenant id without comparing to caller; only super-admin check + locked-field masking. `update`/`deleteById` rely on guard. | HIGH H-1 [CLOSED W5.3 `60d9d798`] |
| `DepartmentService` | CLS | **Yes** — explicit `if (department.tenantId !== tenantId) throw NotFound` (lines 175, 253, 295). ✅ |
| `PromptManagementService` | CLS | **Yes** — explicit comparisons (lines 220, 326). ✅ |
| `Stt PipelineService` | CLS | **Yes** — line 148. ✅ |
| `TenantBucketService` | CLS | **Yes** — lines 64, 110, 252. ✅ |
| `StorageAccessKeyService` | CLS | **Yes** — line 50. ✅ |
| `SysEventService` | none (event-driven) | Trusts `event.tenantId` from `BaseService.broadcastSysEvent`; never validates the event came from inside the right tenant. | MEDIUM M-5 |
| `AuditLogProcessor` (BullMQ) | none | Trusts `job.data.tenantId`, no entity comparison. | MEDIUM M-5 |
| `SummaryProcessor` (BullMQ) | none | Calls `consultationRepository.findById(consultationId)` then writes `ContextItemFactory.CreateRawSummary(tenantId, …)` using **job-payload** tenantId — no comparison to the loaded consultation. | HIGH H-7 (jobs) |
| `NerProcessor` / `PreSummaryProcessor` / `ComprehensiveSummaryProcessor` | none | Same pattern — `findById` no tenant check. | HIGH H-7 |
| `ConsultationEventHandler` (OnEvent) | none | `findById(consultationId)` no tenant check; emits next-step events with whatever `tenantId` came in the payload. | HIGH H-7 |
| `TimelineService` / `ChainSummaryService` | CLS | Uses `consultation.tenantId` from blind `findById` to scope downstream queries — propagates the foreign tenant. | HIGH H-2 |
| `NotificationService` / `WebhookService` / `ApiKeyService` | CLS | Standard `findById` pattern, no comparison after fetch. | MEDIUM M-1, M-4 — `Notification.fetchAllByTenantId` + `ApiKey.fetchAllByTenantId` + `Webhook` full sweep [CLOSED W5.1 `78e7b354` + W5.3 `60d9d798` — see NEW-2..NEW-4] |
| `JwtRevocationService` | none | Redis key `jwt-revoked:<jti>` — not tenant-prefixed (acceptable because `jti` is globally unique, but worth noting). | LOW L-3 |
| `CoreUnitOfWorkService` | n/a | **Non-functional**: `startTransaction()` runs `$transaction(async (tx) => tx)` which commits immediately. Confirmed by tenant.service.ts comment lines 521-526. | MEDIUM M-6 [CLOSED W5.5 `ec67a0d4` — silent in-place fix + canonical `runInTransaction(callback)`] |

---

## C. Critical Findings (BLOCKER)

### C-1. `ConsultationRepository` and `ConsultationService` allow cross-tenant PHI fetch by ID [CLOSED W5.2 `66b1d579` — read-paths]

**Files**:
- `packages/domains/src/repositories/generated/core/ConsultationRepository.ts:76-117, 152-173`
- `packages/applications/src/services/consultation/consultation/consultation.service.ts:127-152, 197-205`

**Evidence**:

```76:92:packages/domains/src/repositories/generated/core/ConsultationRepository.ts
async findWithContext(consultationId: string): Promise<ConsultationEntity | null> {
  try {
    const model = await (this as any).db.findFirst({
      where: {
        id: consultationId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      include: {
        ContextItems: true,
      },
    });
    if (!model) return null;
    return (this as any)._mapper.toDomainEntity(model);
```

```152:173:packages/domains/src/repositories/generated/core/ConsultationRepository.ts
async findConsultationChain(consultationId: string): Promise<ConsultationEntity[]> {
  try {
    const consultation = await this.findById(consultationId);
    if (!consultation) return [];
    const rootId = consultation.parentConsultationId || consultation.id;
    const models = await (this as any).db.findMany({
      where: {
        OR: [{ id: rootId }, { parentConsultationId: rootId }],
        resourceStatus: ResourceStatusType.ENABLED,
      },
```

```127:152:packages/applications/src/services/consultation/consultation/consultation.service.ts
async getById(id: string): Promise<ConsultationResponse | null> {
  const consultation = await this.consultationRepository.findWithContext(id);
  if (!consultation) return null;
  …
}
async getByIdWithRelations(id: string): Promise<ConsultationResponse | null> {
  const consultation = await this.consultationRepository.findWithRelations(id);
```

**Attack scenario**: A doctor authenticated to Tenant A discovers (or guesses, or is given by a stale link) a `consultationId` belonging to Tenant B. They call `GET /consultations/:id`. The `AuthorizationGuard` decision must rely on entity attributes for `tenantId: ${context.tenantId}` predicates — but in CASL the decision happens **before** the entity is loaded. The service returns the full Tenant B PHI payload (transcripts, summaries, NER) to the Tenant A user. HIPAA breach.

**Fix recommendation**:
- *Bare-minimum*: In `ConsultationService.getById/getByIdWithRelations/getConsultationChain`, immediately after `findById/findWithContext/findWithRelations`, throw `NotFoundException` when `entity.tenantId !== this.tenantId`. Mirror the existing `DepartmentService.getById` pattern (returns 404 to avoid existence-leak).
- *Full*: Add `findByIdInTenant(id, tenantId)` to the repository and remove the unscoped `findWithContext/findWithRelations` from the public interface. Then enable PostgreSQL RLS so the DB rejects the query regardless.

**Effort**: Bare-minimum ≈ 4 hours (10 callsites in `consultation`, `context`, `timeline`, `chain-summary` services). Full repo refactor + RLS ≈ 1–2 weeks.

---

### C-2. `ConsultationFactory` (and 15 other factories) default `tenantId` to empty string `''`

**Files**: `packages/domains/src/factories/generated/core/{Consultation,AuditLog,ContextItem,ContextItemVersion,AudioRecording,Department,Media,NamedEntity,Notification,ResourceSubscription,SummaryMeta,Tag,Webhook,AiModel,AsrPipeline,GlobalSetting}Factory.ts`

**Evidence**:

```44:50:packages/domains/src/factories/generated/core/ConsultationFactory.ts
return new ConsultationEntity({
  id,
  …
  patientId: props.patientId,
  appointmentDate: props.appointmentDate,
  doctorId: props.doctorId,
  …
  tenantId: props.tenantId ?? '',
});
```

```46:60:packages/domains/src/factories/generated/core/AuditLogFactory.ts
return new AuditLogEntity({
  id,
  …
  responsibleUserId: props.responsibleUserId ?? '',
  …
  tenantId: props.tenantId ?? '',
  Tenant: props.Tenant ?? null,
});
```

**Attack scenario**: A code-path (esp. background job, event handler, or unit-test fixture) that forgets to pass `tenantId` creates an entity stamped with `tenantId = ''`. Any downstream `findAll({ filters: { tenantId: '' } })` returns these orphan rows; any tenant whose code accidentally queries with empty string sees them; future RLS deployment would silently include `''` as a “tenant” and undermine isolation. This is exactly the pattern HIPAA auditors flag.

**Fix recommendation**:
- *Bare-minimum*: change the codegen template so every tenant-scoped factory **requires** `tenantId: string` (drop `?`) and throws when falsy. Regenerate.
- *Full*: introduce a `TenantId` value-object that refuses construction without a non-empty UUID; consume it in `BaseTenantEntity`.

**Effort**: Bare-minimum ≈ 1 day to edit codegen + audit ~30 call sites that omit `tenantId`. Full VO ≈ 2 days plus tests.

---

### C-3. `ContextItemRepository` accepts arbitrary `consultationId` / `id` arrays — cross-tenant PHI leakage [CLOSED W5.4 `969e49df` — array-input via `ContextService.resolveLinkedConsultationIds`]

**File**: `packages/domains/src/repositories/generated/core/ContextItemRepository.ts:23-435`

**Evidence**:

```165:175:packages/domains/src/repositories/generated/core/ContextItemRepository.ts
async findSharedContext(consultationIds: string[]): Promise<ContextItemEntity[]> {
  const models = await (this as any).db.findMany({
    where: {
      consultationId: { in: consultationIds },
      resourceStatus: ResourceStatusType.ENABLED,
    },
    orderBy: { createdAt: 'asc' },
  });
  return models.map((model: ContextItem) => (this as any)._mapper.toDomainEntity(model));
}
```

```400:419:packages/domains/src/repositories/generated/core/ContextItemRepository.ts
async findWithAllRelations(id: string): Promise<ContextItemEntity | null> {
  …
  const model = await (this as any).db.findFirst({
    where: {
      id,
      resourceStatus: ResourceStatusType.ENABLED,
    },
    include: {
      AudioRecordings: { … },
      SummaryMeta: true,
      NamedEntities: { orderBy: { startOffset: 'asc' } },
      Versions: { orderBy: { versionNumber: 'desc' } },
    },
  });
```

**Attack scenario**: `ContextService.getSharedContext(consultationId)` (line 598) resolves linked consultations via `findConsultationChain` (C-1, no tenant filter) and pipes the resulting IDs into `findSharedContext`. If any of the linked IDs cross a tenant boundary (because a doctor’s consultation has a `parentConsultationId` that — through bug or attack — points to another tenant’s row), the returned PHI mixes tenants. The aggregated NER endpoint (`getAggregateNamedEntities`) compounds the bug: it groups entities by class, so a single Tenant B transcript appears alongside Tenant A entities in the response.

**Fix recommendation**:
- *Bare-minimum*: In `ContextService`, after every `consultationRepository.findById(consultationId)`, throw `NotFoundException` if `consultation.tenantId !== this.tenantId`. For `findSharedContext`/`findCaseNotesFromChain`, pass `tenantId` explicitly and add it to the `where`.
- *Full*: Add `findByConsultationInTenant(consultationId, tenantId)` and remove the open variants.

**Effort**: Bare-minimum ≈ 6 hours. Full repo signature change ≈ 3 days.

---

### C-4. `ConsultationService.createRevisit` allows linking a child consultation to a parent in another tenant

**File**: `packages/applications/src/services/consultation/consultation/consultation.service.ts:86-122`

**Evidence**:

```95:111:packages/applications/src/services/consultation/consultation/consultation.service.ts
const parent = await this.consultationRepository.findById(parentConsultationId);
if (!parent) {
  throw new BadRequestException(`Parent consultation ${parentConsultationId} not found`);
}
…
const consultation = ConsultationFactory.CreateRevisit({
  tenantId,                       // <-- caller's tenant
  patientId: request.patientId,
  …
  parentConsultationId,           // <-- accepted unconditionally
```

**Attack scenario**: A doctor in Tenant A passes `parentConsultationId` belonging to Tenant B. The new consultation is created in Tenant A but `parentConsultationId` points across tenants. Subsequent `findConsultationChain`/`findSharedContext` queries on this new consultation now return both tenants' data (because chain queries don’t filter by tenant). PHI commingled.

**Fix recommendation**: After `findById(parentConsultationId)`, assert `parent.tenantId === this.tenantId`; otherwise throw `NotFoundException`.

**Effort**: Bare-minimum ≈ 15 minutes.

---

### C-5. `AuditLogService` and `AuthorizationAuditService` query audit logs across all tenants

**Files**:
- `packages/applications/src/services/auditLog/auditLog.service.ts:58-191`
- `packages/applications/src/services/audit/authorization-audit.service.ts:117-329`

**Evidence**:

```58:79:packages/applications/src/services/auditLog/auditLog.service.ts
async fetchAll(props: PaginatedQuery): Promise<FetchResponse<AuditLogEntity>> {
  const { limit, page, search } = props;
  const [auditLogs, count] = await Promise.all([
    this.auditLogRepository.findAll(withFormattedPaginatedProps(props)),
    this.auditLogRepository.count(withFormattedCountProps(props)),
  ]);
  …
}
```

```272:316:packages/applications/src/services/audit/authorization-audit.service.ts
async getRecentDenials(options: AuditHistoryOptions = {}): Promise<AuthorizationAuditEntry[]> {
  …
  const logs = await (prisma as any).auditLog?.findMany({
    where: {
      eventType: 'AUTHORIZATION',
      success: false,
      …
    },
```

**Attack scenario**: A tenant admin calls `GET /audit-logs` — sees every tenant's audit log including authentication, impersonation, and resource access events. HIPAA requires per-tenant audit immutability and isolation; this directly violates §164.312(b).

**Fix recommendation**:
- *Bare-minimum*: Inject `this.tenantId` into the default `where` clause in `AuditLogService.fetchAll/fetchAllByResource/fetchAllCreatedByUser/fetchById/deleteById`. Skip injection only when CLS context carries `SUPER_ADMIN` role.
- *Full*: Remove `AuthorizationAuditService`’s raw Prisma escape hatch; route through `AuditLogRepository`. Add tenant-prefixed Redis keys for denial-tracking.

**Effort**: Bare-minimum ≈ 2 hours. Full ≈ 1 day.

---

### C-6. `UserRoleAssignmentService.create` accepts arbitrary `request.tenantId` — privilege escalation

**File**: `packages/applications/src/services/user/userRoleAssignment/userRoleAssignment.service.ts:31-83`

**Evidence**:

```42:71:packages/applications/src/services/user/userRoleAssignment/userRoleAssignment.service.ts
const lookupTenantId = request.tenantId ?? this.tenantId ?? null;

try {
  const existing = await this.userRoleAssignmentRepository.findFirst({
    where: {
      userId: request.userId,
      roleId: request.roleId,
      tenantId: lookupTenantId,
      resourceStatus: ResourceStatusType.DELETED,
    },
  });
  const restored = await this.userRoleAssignmentRepository.restore(existing.id, this.requestUser?.id);
  …
}

const newUserRoleAssignment = UserRoleAssignmentFactory.CreateUserRoleAssignment({
  ...request,        // <-- carries request.tenantId unchecked
  userId: request.userId,
  roleId: request.roleId,
  createdBy: this.requestUser?.id,
});
```

**Attack scenario**: A tenant admin in Tenant A submits `POST /user-role-assignments` with `{ userId: <victim-user-in-tenant-B>, roleId: 'SUPER_ADMIN', tenantId: 'tenant-B' }`. If the CASL policy allows `create User` only with `tenantId: ${context.tenantId}` (it does for `UserRoleAssignment` only in some bundles), the assignment may slip through and grant SUPER_ADMIN access. Even where CASL blocks it, the service does not provide a second line of defense.

**Fix recommendation**:
- *Bare-minimum*: In `create`, force `request.tenantId = this.tenantId` (or assert equality) before passing to the factory.
- *Full*: Add a domain invariant in `UserRoleAssignmentEntity.validate()` that requires a non-null `tenantId`, and tighten the CASL rule to compare entity ⇄ context.

**Effort**: 30 minutes.

---

### C-7. `BaseTenantEntity.tenantId` has a public setter and validate() is a no-op [CLOSED W5.1 `78e7b354` — finale: `set Tenant(...)` → `protected`]

**File**: `packages/domains/src/common/baseEntity/base.tenantEntity.ts:9-36`

**Evidence**:

```9:36:packages/domains/src/common/baseEntity/base.tenantEntity.ts
export abstract class BaseTenantEntity extends BaseAggregate {
  private _tenantId?: EntityId | null;
  private _Tenant?: TenantEntity | null;

  constructor(init: IBaseTenantEntity) {
    super(init);
    this._tenantId = init.tenantId;
  }

  get tenantId(): EntityId | null | undefined {
    return this._tenantId;
  }

  set tenantId(tenantId: EntityId | null) {
    this.setProperty('tenantId', tenantId);
  }

  get Tenant(): TenantEntity | null | undefined {
    return this._Tenant;
  }

  set Tenant(tenant: TenantEntity | null) {
    this.setProperty('Tenant', tenant);
    this.setProperty('tenantId', tenant?.id);
  }

  public override validate(): void {}
}
```

**Attack scenario**: Any caller can mutate an existing entity’s tenant via `entity.tenantId = otherTenantId`, then `repository.update(id, entity)` writes the change to the database, transferring PHI ownership. The `Tenant` setter (line 30) makes this even easier — setting the `Tenant` relation auto-rewrites `tenantId`. With no `validate()` enforcement, malformed entities pass straight through.

**Fix recommendation**:
- *Bare-minimum*: remove the public setters for `tenantId` and `Tenant` (make protected). Add `validate()` body that throws if `tenantId` is null/empty.
- *Full*: replace `_tenantId: string | null` with a `TenantId` value-object class instantiated only in the constructor; remove from `changes` set on `BaseEntity`.

**Effort**: Bare-minimum ≈ 1 hour + downstream compile fixes. Full ≈ 2 days.

---

## D. Medium Findings

### M-1. `NotificationService`, `WebhookService`, `ApiKeyService`, `TagService` follow the `UserService` anti-pattern

`findById(id)` → mutate → `softDelete(id)` without verifying `entity.tenantId === this.tenantId`. Same root cause as C-5. Per-service patch ≈ 20 minutes each.

### M-2. `TagService` / `WebhookService` accept tag-id and webhook-id at create time without ownership check [CLOSED W5.1 `78e7b354` + W5.3 `60d9d798` — Webhook only; Tag deferred]

Where the request includes `tagId` or `webhookId` (for tag-assignments and webhook-subscriptions), the service does not verify the linked tag/webhook belongs to the caller’s tenant before linking. (Same pattern as C-4.)

### M-3. `ResourceSubscriptionService` lacks tenant scoping on fetch-by-id [CLOSED W5.3 `60d9d798` — full 5-method DEF-C3 sweep]

`findById(id)` with no follow-up tenant check. A user in Tenant A can read another tenant's subscription preferences (which include user emails and resource types).

### M-4. `AsrPipelineService` exposes `findById(id)` without tenant comparison in some methods

While `stt/pipeline/pipeline.service.ts:148` enforces the check on update, sibling methods (lookup-by-id, audit-list-by-id) do not. Inconsistent enforcement.

### M-5. `SysEventService` / `AuditLogProcessor` trust event payload `tenantId` blindly [CLOSED W5.5 `ec67a0d4` — `BaseService.broadcastSysEvent` merge order: CLS wins]

`broadcastSysEvent` spreads caller data **after** CLS defaults (`base.service.ts:46`) which means the caller can intentionally override `tenantId`. The downstream BullMQ processor never reconciles the payload's `tenantId` against the entity it loads. For HIPAA, audit-log tenantId should be derived from the entity, not the event payload.

### M-6. `CoreUnitOfWorkService` is non-functional [CLOSED W5.5 `ec67a0d4` — silent in-place fix; canonical `runInTransaction(callback)` added; legacy methods `@deprecated`]

`startTransaction()` issues `$transaction(async (tx) => tx)` which **commits before returning**. Every service that calls `unitOfWork.startTransaction()` and then runs multi-write operations is silently non-transactional. Multi-row writes that should atomically succeed/fail (e.g. cross-tenant transfer rollbacks) won’t roll back. `TenantService.updateTenantConfigs` works around it with `databaseService.baseClient.$transaction(callback)` directly, but most callers do not. Combined with C-7, partial writes across tenants are possible.

### M-7. `SummaryProcessor` / `NerProcessor` / `ConsultationEventHandler` propagate `tenantId` from job payload only

```55:55:packages/applications/src/services/consultation/jobs/processors/summary.processor.ts
const consultation = await this.consultationRepository.findById(consultationId);
```

The processor never asserts `consultation.tenantId === job.data.tenantId`. A poisoned job whose `consultationId` and `tenantId` don't match writes the resulting summary's `tenantId` to the wrong tenant.

### M-8. `findById` throws `DataNotFoundException` carrying the tenant model name + raw id [CLOSED W5.5 `ec67a0d4` — HTTP filter scoped to `DataNotFoundException` → 404 generic in production]

`packages/domains/src/common/repository.ts:86,97` includes `this._modelName` and `id` (or stringified props) in the exception. If exception messages leak to clients (HTTP 500 with stack trace), this is a minor information disclosure.

---

## E. Low / Hygiene Findings

### L-1. Generic `Repository<T>` exposes `rawQueryUnsafe(query)`
Unfiltered SQL injection escape hatch (`common/repository.ts:303`). Not currently called, but exported — risky.

### L-2. `$bulk(txns)` in generic repo
Tenant-agnostic bulk transaction primitive. No callers in `packages/applications`, but available.

### L-3. JWT revocation Redis key not tenant-prefixed
`jwt-revoked:<jti>` — `jti` is globally unique, so no collision risk in practice. For OpenTelemetry baggage / cross-tenant analytics, prefer `jwt-revoked:<tenantId>:<jti>`.

### L-4. `BaseEntity.equals()` only compares `id` [CLOSED W5.5 `ec67a0d4` — tenant-aware via duck-typing on `BaseTenantEntity` subclasses]
Two entities with the same `id` from different tenants would compare equal. Compare on `(tenantId, id)` for `BaseTenantEntity` subclasses.

### L-5. Soft-delete is not tenant-aware
`Repository.softDelete(id)` matches by `id` only. A foreign-tenant id passed in will soft-delete the row across tenants (cross-tenant *deletion of evidence*, HIPAA risk). Same applies to `restore(id)`.

### L-6. Test coverage for cross-tenant leak is essentially zero
Grep finds **0 tests** named `cross-tenant`, `tenant.*leak`, `different tenant`, or similar in `packages/applications/src/services/**`. The `tenant.service.test.ts` covers super-admin/locked paths but not "Tenant A trying to access Tenant B by id". One isolated example exists in `department-prompt-config.service.test.ts:98` ("throws NotFoundException when department.tenantId !== caller tenantId").

### L-7. No `OnEvent` handler enforces tenant rebinding
Background `OnEvent` listeners (consultation pipeline, audit log) operate without CLS context. Any future async work that reads `this.tenantId` will return `null`. Best practice (per [research](./01-research-best-practices.md) §3) is to seed CLS from the job payload via a small middleware (`cls.set('tenantId', payload.tenantId)`).

---

## F. Anti-patterns observed

| Anti-pattern | Where | Notes |
| --- | --- | --- |
| `new Entity()` instead of `Factory.Create()` | None found — `new` is used only inside factories (good). | ✅ Pattern OK |
| Service imports from `@arcaai/database` directly | `authorization-audit.service.ts:1-3` imports `CoreDatabaseService` and calls `(prisma as any).auditLog?.create/findMany`. | Violates rule `04-application-services.mdc` |
| `tenantId` optional in signatures where required | All 16 factories listed in C-2. | Systemic |
| Default tenantId / fallback to `''` | C-2 (16 factories). | Systemic |
| Tenant inferred from `user.tenantId` without re-validation | `BaseService.broadcastSysEvent` (line 44) defaults `tenantId` from CLS but allows caller override (line 46). Acceptable but worth a comment. | Mild |
| Cross-tenant joins for “admin” features in regular services | `UserService.fetchAllByTenantId` and `TenantService.fetchAll` exist on regular services rather than super-admin sub-services. | Inconsistent module boundary |
| Cache keys without tenant prefix | `JwtRevocationService` (L-3); idempotency / summary-cache keys in `consultation-job.service` rely on consultation IDs but those aren’t tenant-prefixed. | Mostly safe (UUIDs unique) but advisable to prefix |
| Event handlers loop over all tenants without batching | None — no system-wide tenant fan-out handler observed; this is good. | ✅ |
| Public setter on `tenantId` | `BaseTenantEntity.set tenantId` and `set Tenant`. | C-7 |
| Repository returns raw `Prisma.*` types | `AuthorizationAuditService` uses `prisma as any`. | Violation |

---

## G. Bare-minimum quick wins (5–10 items)

1. **Stop `BaseTenantEntity.tenantId` from being publicly mutable** — change setter to `protected`, throw in `validate()` when null. (C-7) — *1 hour.*
2. **Tighten the 16 factories: make `tenantId: string` (required, non-empty)** — codegen template change + regenerate + fix call sites. (C-2) — *4–6 hours.*
3. **Add `if (entity.tenantId !== this.tenantId) throw new NotFoundException(...)` after every `findById` in `ConsultationService`, `ContextService`, `UserService`, `UserRoleAssignmentService`, `AuditLogService`, `NotificationService`, `WebhookService`, `ApiKeyService`, `ResourceSubscriptionService`** — mirror `DepartmentService` pattern. (C-1, C-3, C-5, M-1..M-3) — *~6 hours.*
4. **Inject `this.tenantId` into the default `where` of `AuditLogService.fetchAll/fetchAllByResource/fetchAllCreatedByUser` and `AuthorizationAuditService.getAuthorizationHistory/getRecentDenials/getDenialCount`** — gated by SUPER_ADMIN escape. (C-5, C-7) — *2 hours.*
5. **Force `request.tenantId = this.tenantId` in `UserRoleAssignmentService.create`** (or assert equality + throw `ForbiddenException`). (C-6) — *15 min.*
6. **In `ConsultationService.createRevisit`, verify parent's `tenantId` matches CLS before linking.** (C-4) — *15 min.*
7. **In `SummaryProcessor`/`NerProcessor`/`PreSummaryProcessor`/`ComprehensiveSummaryProcessor`/`ConsultationEventHandler`, after `findById`, assert `entity.tenantId === job.data.tenantId`** — throw to dead-letter queue otherwise. (M-7) — *2 hours.*
8. **Remove `Repository.rawQueryUnsafe()` and `$bulk` from the public surface** (L-1, L-2). — *30 min.*
9. **Add a one-line CLS rebind to BullMQ processors**: `await this.cls.run({ tenantId: job.data.tenantId, … }, () => process())` so downstream `BaseService` calls see the right tenant. (L-7) — *2 hours.*
10. **Replace the broken `CoreUnitOfWorkService.startTransaction()` with `databaseService.baseClient.$transaction(callback)`** — pattern already pioneered in `TenantService.updateTenantConfigs`. (M-6) — *1 day.*

---

## H. Strategic improvements

1. **Enable PostgreSQL RLS (Pool model) with `FORCE ROW LEVEL SECURITY`**, `app.tenant_id` GUC set via `SET LOCAL` at the start of every transaction. PgBouncer txn-mode validation tests are already in place ([packages/database/tests/pgbouncer-validation/__tests__/02-rls-guc-leak.test.ts](../../packages/database/tests/pgbouncer-validation/__tests__/02-rls-guc-leak.test.ts)) — the missing piece is the RLS policies themselves. Reference: [01-research-best-practices.md §1.2](./01-research-best-practices.md).
2. **Introduce a `TenantId` value object** (`packages/domains/src/common/valueObjects/TenantId.ts`) and make `BaseTenantEntity` require it in the constructor. Eliminates C-2/C-7 by design.
3. **Refactor repositories around `findInTenant`/`updateInTenant` signatures**. Migrate the generic `Repository<T>` to a `TenantScopedRepository<T extends BaseTenantEntity>` that auto-injects `tenantId` into every Prisma `where`. Reserve the unscoped repository for `BaseEntity` (Permission, Role) only.
4. **Use a Prisma 7 `$extends` client extension** to enforce tenant scoping for all tenant-bearing models. The extension reads the current `tenantId` from CLS and short-circuits queries missing it. This is the 2026 industry standard (research §1.3, §3).
5. **Adopt `nestjs-cls` AsyncLocalStorage for BullMQ processors / OnEvent handlers** rather than passing `tenantId` in payloads. Lifts L-7, M-5, M-7 in one stroke.
6. **Add cross-tenant negative tests** for every service: "Tenant A user requests Tenant B entity by id → expect `NotFoundException`". One test per service × method gives ~150 tests, but the pattern can be templated to ~10–15 fixtures. (L-6).
7. **Restrict the generic repository surface** — move `rawQuery`, `rawQueryUnsafe`, `$bulk`, `query`, `runQuery` to a `SystemRepository` base class used only by background jobs that legitimately need cross-tenant access; do not expose to standard CRUD services.
8. **Per-tenant Redis key prefixing for caches** — wrap `IRedisCacheService` with a `TenantAwareCacheService` decorator that always prepends `t:<tenantId>:`. Also enables crypto-shredding per research §H-3 (2026 GDPR Right-to-Erasure pattern).
9. **Replace `BaseEntity.equals(other)` with `(tenantId, id)` comparison** for tenant-scoped entities so collection-membership checks across tenants don’t falsely return true. (L-4)

---

## I. Positive observations

- `DepartmentService` / `PromptManagementService` / `Stt PipelineService` / `TenantBucketService` / `StorageAccessKeyService` consistently use the **DEF-C3 "no existence leak" pattern**: `if (entity.tenantId !== this.tenantId) throw NotFoundException(...)`. This is exactly the correct defense-in-depth contract; it is just not applied uniformly.
- `TenantService.updateTenantConfigs` (line 503) demonstrates a strong pattern: per-row tenant check, super-admin gate for the `__GLOBAL__` tenant, locked-row scrubbing via `scrubLockedForAudit`, and proper Prisma `$transaction(callback)` for atomicity. This should be the template for other batch operations.
- `AuditLogFactory.tenantId ?? ''` is wrong (C-2), but the surrounding pipeline (`SysEventService` → BullMQ → `AuditLogProcessor`) does propagate `tenantId` end-to-end via the job payload — the wiring is correct, only the entity-level validation is missing.
- Test for audit-scrub of encrypted/locked rows ([tenant.service.audit-scrub-encrypted.test.ts](../../packages/applications/src/services/tenant/__tests__/tenant.service.audit-scrub-encrypted.test.ts)) is thorough and shows the team understands defense-in-depth in *that* area.
- `TASK-302 Stream D` introduced **optimistic-concurrency control (`_version` column + `updateWithVersion`)** which is great for race-prevention even though it doesn’t directly enforce tenant scope.
- The PgBouncer transaction-mode RLS leak test suite is already drafted ([02-rls-guc-leak.test.ts](../../packages/database/tests/pgbouncer-validation/__tests__/02-rls-guc-leak.test.ts), [07-concurrent-rls.test.ts](../../packages/database/tests/pgbouncer-validation/__tests__/07-concurrent-rls.test.ts)) — this is the right scaffolding for the future RLS rollout.
- Module/folder structure (`services/<feature>/<sub-feature>/{service.ts, dto.mapper.ts, service.module.ts}`) is clean and discoverable.

---

## Summary

The codebase shows mature DDD organisation (factories, mappers, repositories, base classes, system events, OCC versioning) but **tenant isolation is implemented at one layer only**: the API-gateway CASL guard. The domain entity allows `tenantId` to be unset and mutated, the factories default it to empty string, the generic repository has no tenant predicate, and the application services trust ids passed in. There is no PostgreSQL RLS in production despite test scaffolding for it.

For HIPAA-graded healthcare PHI (consultations, transcripts, summaries, audit logs), this is a **single point of failure**. A misconfigured CASL rule, a missing `@RequirePermission` decorator on one route, a poisoned BullMQ job, or an internal service-to-service call will leak PHI cross-tenant with no second line of defense.

The good news is that all 10 quick-win fixes above can be landed in ≈ 2–3 engineer-days and would restore credible defense-in-depth before the strategic RLS rollout (≈ 2 weeks).
