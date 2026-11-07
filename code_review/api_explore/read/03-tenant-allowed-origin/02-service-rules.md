# 02 — Service rules

> Part of the [tenant-allowed-origin walkthrough](../03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md).
> **Previous:** [01 — HTTP request to the controller](./01-http-to-controller.md) · **Next:** [03 — Data layer](./03-data-layer.md)

## 6. Part 3 — The service

`TenantAllowedOriginService` is where the feature actually lives. It extends
`BaseService` and implements `ITenantAllowedOriginService`.

### 6.1 `BaseService` gives you the request context

Constructor (`tenant-allowed-origin.service.ts:46–52`):

```ts
constructor(
  private readonly tenantAllowedOriginRepository: TenantAllowedOriginRepository,
  protected override readonly eventEmitter: EventEmitter2,
  protected override readonly clsService: ClsService<IActiveUserContext>,
) {
  super(eventEmitter, clsService, ResourceType.TenantAllowedOrigin);
}
```

`BaseService` (`packages/applications/src/common/base.service.ts`) provides:

| Member | Line | What it reads/does |
|---|---|---|
| `tenantId` | 190 | `clsService.get('tenantId')` — the tenant of this request |
| `requestUser` | 164 | the full user session object (id, roles, …) |
| `requestUserId` | 178 | just the user id (for audit stamps) |
| `requestServiceAccount` | 170 | machine principal, kept separate from the human |
| `broadcastSysEvent(type, data)` | 72 | emits an audit/webhook event; **tenantId always comes from CLS**, never from the payload |
| `updateEntity(entity, changes)` | 79 | stages changes on the entity and records `changes` / `hasChanges` |
| `assertExpectedVersion(entity, expected)` | 160 | throws `OptimisticConcurrencyException` (→ 412) on drift |

The most important line for security is `tenantId` at 190. Every method starts by
reading it. A missing tenant is a 400, not a query without a filter.

### 6.2 The four gates

The controller's `@CanManage` is only the first gate. Three more exist:

| # | Gate | Where | HTTP result | What it protects |
|---|---|---|---|---|
| 1 | `manage:TenantAllowedOrigin` | `@CanManage` → `UnifiedAuthGuard` | 403 | who may call the methods at all |
| 2 | CLS tenant + Prisma tenant-scope extension | `BaseService.tenantId` + `tenant-scope.ts` | invisible filter | **which** tenant's rows are read/written |
| 3 | wildcard gate | `normalizeIncomingOrigin` (`service.ts:103–117`) | 403 | a tenant admin cannot register `*` or a pattern |
| 4 | SYSTEM gate | `assertMayWriteInResolvedTenant` (`service.ts:133–137`) | 403 | only a super admin may write a platform-wide grant |
| — | cross-tenant by-id lookup | `findOwnedOrThrow` (`service.ts:438–444`) | **404** | does not leak that another tenant's row exists |

Why can't gates 3 and 4 be decorators? Because a decorator sees `action + subject`,
not the **shape of the value** or the **resolved tenant**. `@CanManage` knows you may
manage `TenantAllowedOrigin`; it cannot know you are trying to write `https://*.evil.com:*`.
So the service checks imperatively.

`isSuperAdmin` (`packages/applications/src/common/tenant-guards.ts:55`) is a pure
function: it returns true only when the user's roles include `SUPER_ADMIN` (the sole
member of `ELEVATED_ROLES`, line 37).

> **403 vs 404:** a privilege refusal is 403. A cross-tenant id is 404, even when the
> payload is also forbidden. The order matters: `update` loads the row and checks
> ownership **before** applying the wildcard gate, so a cross-tenant id never reveals
> that it exists.

### 6.3 `getAll` and `getById`

`getAll` (139–152):

1. read `tenantId` from CLS; missing → 400;
2. `findAll({ where: { tenantId } })`;
3. emit `ResourceViewed` with a count;
4. map each entity to a response DTO.

`getById` (154–167) is the same, but calls `findOwnedOrThrow(id, tenantId)` instead.
That helper does `findById(id)` and then checks `entity.tenantId === tenantId`:

```ts
if (!entity || entity.tenantId !== tenantId) {
  throw new NotFoundException(`Allowed origin ${id} not found`);
}
```

`findById` itself throws `DataNotFoundException` when the row is absent; the global
`DataNotFoundExceptionFilter` turns that into a 404. Both paths therefore look
identical to the caller.

### 6.4 `create` step by step

```
create(dto)
  │
  ├─ 1. tenantId = this.tenantId                ── missing ⇒ 400
  │
  ├─ 2. assertMayWriteInResolvedTenant(tenantId)
  │       tenantId === SYSTEM && !SUPER_ADMIN   ⇒ 403
  │
  ├─ 3. normalizeIncomingOrigin(dto.origin)
  │       raw contains '*' && !SUPER_ADMIN      ⇒ 403
  │       normalizeOrigin / normalizeOriginPattern (by shape)
  │       canonical contains '*' && !SUPER_ADMIN⇒ 403
  │       malformed                              ⇒ 400 (ArgumentInvalidException)
  │
  ├─ 4. findByOriginAndTenant(origin, tenantId)  ── live row ⇒ 409
  │
  ├─ 5. findDeletedByOriginAndTenant(...)
  │       soft-deleted row for THIS tenant       ⇒ restore path (§6.6)
  │
  ├─ 6. TenantAllowedOriginFactory.Create...({ tenantId, origin, label, ... })
  │
  ├─ 7. repository.create(entity)
  │       Prisma P2002 (unique race)             ⇒ retry deleted lookup ⇒ 409/restore
  │
  ├─ 8. warnIfAllowAllOrigin(...)                ── only if origin === '*'
  ├─ 9. broadcastSysEvent(ResourceCreated, ...)
  ├─10. emit('origin-registry.invalidate')
  └─11. return mapper.toResponse(saved)
```

Details that are easy to miss:

- **Normalization is not merely cosmetic.** It strips default ports, lowercases the
  host, and rejects paths/userinfo/non-loopback `http://`. The stored value is the
  canonical one, never the raw input.
- **Shape routing:** `isOriginPattern(raw)` is true iff the string contains `*`. A
  pattern goes through `normalizeOriginPattern`; everything else through
  `normalizeOrigin`. Both throw the same `ArgumentInvalidException` on bad input, so
  callers do not branch on error type.
- **The shape is checked twice** — raw first, then canonical. Normalization can
  *introduce* a `*` (`%2A`, fullwidth `＊`), so a raw-only check is insufficient.
  A SUPER_ADMIN sending an encoded wildcard still gets 400, because the value is
  malformed, not privileged.
- **The pair is `(origin, tenantId)`, not `origin`.** Two different tenants may
  legitimately register the same origin. Only a live row for *this* tenant is a
  conflict.

### 6.5 `update` step by step

```
update(id, dto)
  │
  ├─ 1. tenantId from CLS                       ── missing ⇒ 400
  ├─ 2. assertMayWriteInResolvedTenant          ── SYSTEM + non-super ⇒ 403
  ├─ 3. findOwnedOrThrow(id, tenantId)          ── missing/cross-tenant ⇒ 404
  │
  ├─ 4. if dto.origin present:
  │       normalizeIncomingOrigin (wildcard gate, §6.2)
  │       if canonical !== current origin:
  │         findByOriginAndTenant → another row ⇒ 409
  │
  ├─ 5. updateEntity(entity, { label, description, origin? })
  │
  ├─ 6. assertExpectedVersion(entity, expectedVersion)  ── drift ⇒ 412
  │       (BEFORE the no-change check, so a stale no-op still 412s)
  ├─ 7. !entity.hasChanges                      ── ⇒ 400 "No changes to write to."
  │
  ├─ 8. repository.updateWithVersion(id, entity, expectedVersion)
  │       CAS: WHERE id = ? AND version = ?
  │       count === 0 → read current version → OptimisticConcurrencyException (412)
  │       P2002 → 409
  │
  ├─ 9. maybe warn if this update made the row '*'
  ├─10. broadcastSysEvent(ResourceUpdated, { previousVersion, newVersion, ... })
  ├─11. emit('origin-registry.invalidate')
  └─12. return mapped row
```

Why the order in steps 3–4 matters: a cross-tenant id must 404 before the wildcard
gate can 403. The interface documents this explicitly
(`ITenantAllowedOriginService.ts:68–70`).

Why `assertExpectedVersion` comes before the no-change check: RFC 7232 evaluates
preconditions independently of the payload. A client with a stale ETag must be told
to refetch, even if its request would have changed nothing.

### 6.6 Delete → re-add restores the row

The unique index is on `(origin, tenantId)` and is **not partial**, so a soft-deleted
row still occupies the pair. If the same tenant deletes and re-adds the same origin,
a blind `INSERT` would violate the constraint. The service handles it:

1. `findDeletedByOriginAndTenant(origin, tenantId)` looks only at `DELETED` rows for
   this tenant;
2. if found, `restoreOnCreateCollision` (293–322) restores it, applies the **new**
   `label`/`description`, and emits `ResourceCreated` with `revivedFromDeleted: true`;
3. if the soft-deleted row belongs to another tenant, it is **not** restored — the
   create is refused with the same 409 "already registered" message, so the caller
   learns nothing about the other tenant's row.

There is also a defense-in-depth check `deletedEntity.tenantId !== callerTenantId`
inside the restore method. The comment (lines 268–291) says to keep it even though two
other layers already make it unreachable — a future refactor must not silently
reintroduce cross-tenant revival.

### 6.7 Audit events and the invalidation contract

Every successful mutation emits two kinds of events:

| Event | Mechanism | Consumer |
|---|---|---|
| `ResourceCreated` / `ResourceUpdated` / `ResourceDeleted` / `ResourceViewed` | `broadcastSysEvent` → `EventEmitter2` | audit log, activity feed, webhooks |
| `origin-registry.invalidate` | `eventEmitter.emit(...)` (line 471–473) | `OriginRegistryService` |

A **refused** mutation emits neither. The interface calls the invalidation event a
"frozen contract" (`ITenantAllowedOriginService.ts:36–42`).

### 6.8 Error map

| Situation | Thrown | HTTP |
|---|---|---|
| No tenant in CLS | `BadRequestException` | 400 |
| Malformed origin / pattern | `ArgumentInvalidException` | 400 |
| Unknown body field | `ValidationPipe` | 400 |
| Invalid `If-Match` syntax | `BadRequestException` | 400 |
| Missing `If-Match` on PATCH | `HttpException(428)` | 428 |
| No changes in PATCH | `ArgumentInvalidException` | 400 |
| Non-super wildcard / SYSTEM write | `ForbiddenException` | 403 |
| Live duplicate `(origin, tenantId)` | `ConflictException` | 409 |
| DB unique-constraint race | `ConflictException` | 409 |
| Version drift | `OptimisticConcurrencyException` | 412 |
| Missing / cross-tenant row | `NotFoundException` / `DataNotFoundException` | 404 |

---

