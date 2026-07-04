# TASK-261: Entity validate() Rollout — Remaining Generated Entities

| Field | Value |
|-------|-------|
| **Ticket** | TASK-261 |
| **Created** | 2026-05-17 |
| **Updated** | 2026-05-17 |
| **Status** | Completed |
| **Type** | Refactor + Test Coverage |
| **Packages** | `packages/domains` |
| **Parent / Related** | TASK-259 (Tenant Domain Cleanup), TASK-258 |

---

## Requirement Analysis

### Description

TASK-259 implemented `validate()` for `TenantEntity` and `GlobalSettingEntity`, replacing their `BusinessException('Method not implemented.')` stubs with real invariant checks. An audit identified **15 other generated entities** under `packages/domains/src/entities/generated/core/` carrying the same stub. This ticket completes the rollout for those 15 entities.

### Business Context

`Entity.validate()` is the contract for asserting domain invariants before persistence. While no caller currently invokes it, any future refactor that adopts factory-level or service-level validation will hard-fail on every stubbed entity. Replacing the throwing stubs with real checks (or pass-through where invariants are trivial) eliminates a latent crash and lets future code adopt validation safely.

### Acceptance Criteria

- [ ] Each of the 15 listed entities has a `validate()` implementation that does NOT throw `'Method not implemented.'`.
- [ ] Each entity has at least one happy-path test and per-rule rejection tests under `packages/domains/src/entities/__tests__/`.
- [ ] All affected packages build clean and pass lint.
- [ ] No factory, mapper, model, repository, or service signature changes — this ticket is invariant-checks-only.

---

## Scope — 15 Entities

Partitioned into 3 tiers for parallel work. Each tier is owned by exactly one agent.

### Tier 1 — Auth/Security (Agent J, 5 entities)

- `PermissionEntity`
- `RoleEntity`
- `RolePermissionEntity`
- `UserEntity`
- `UserRoleAssignmentEntity`

### Tier 2 — User & Communication (Agent K, 5 entities)

- `UserProfileEntity`
- `UserSettingsEntity`
- `UserMediaEntity`
- `NotificationEntity`
- `ResourceSubscriptionEntity`

### Tier 3 — Media/Webhooks/Audit (Agent L, 5 entities)

- `MediaEntity`
- `TagEntity`
- `WebhookEntity`
- `WebhookRunHistoryEntity`
- `AuditLogEntity`

---

## Implementation Plan

Each agent:
1. Reads the corresponding Prisma schema file (`packages/database/src/prisma/db_main/<table>.prisma`) for invariants.
2. Reads existing entities with real `validate()` (e.g., `ApiKeyEntity`, `TenantEntity`, `GlobalSettingEntity`) for style conventions.
3. Implements `validate()` with `BusinessException` throws on each violation.
4. Writes unit tests (happy path + per-rule rejection).
5. Runs build + tests + lint for `@arcaai/domains` and pastes verbatim output.
6. Fills in its own tier subsection below.

### Conservative Defaults

- Required string fields: non-empty after trim, length within Prisma column cap (or 255 if unspecified).
- Optional fields: skip the existence check; validate format/length only when present.
- Boolean fields: type-check.
- Enum fields: must be a member of the corresponding `Enums.*Type`.
- JSON fields (`metaData`): no structural validation in this ticket — track-only.
- DateTime fields: no future-only / past-only constraints in this ticket — track-only.

When in doubt, mirror `TenantEntity.validate()` — it sets the precedent.

---

## Implementation Summary

### Tier 1 — Auth/Security (Agent J)

All 5 stubs replaced with real invariant checks. Style mirrors `TenantEntity.validate()` / `ApiKeyEntity.validate()`: ordered field checks, `BusinessException` per violation, no async work, no JSON-shape validation. Note: the `Permission` and `RolePermission` Prisma models have been superseded by `Policy` / `RolePolicy`, so those two entities are validated against their `I*Entity` interface surface rather than a live Prisma model. `UserRoleAssignmentEntity.tenantId` is treated as OPTIONAL to preserve the global-assignment pattern (`{ tenantId: null }`) used by `policy.engine.ts:236`.

| Entity | Invariants enforced | Tests added |
|---|---|---|
| `PermissionEntity` | `name` non-empty trim ≤ 255; `resourceTypeName` non-empty trim ≤ 255; `permissionAction` required + member of `Enums.PermissionAction`; `description` ≤ 1000 when present | 19 |
| `RoleEntity` | `name` non-empty trim ≤ 255; `description` ≤ 1000 when present; `externalName` ≤ 255 when present; `externalId` ≤ 255 when present | 12 |
| `RolePermissionEntity` | `roleId` non-empty trim; `permissionId` non-empty trim (join entity — both FKs required) | 6 |
| `UserEntity` | `username` non-empty trim ≤ 255; `password` non-empty trim (opaque hash); `isServiceAccount` typeof boolean; `externalId` ≤ 255 when present; `secret1` / `secret2` ≤ 255 when present | 15 |
| `UserRoleAssignmentEntity` | `userId` non-empty trim; `roleId` non-empty trim; `tenantId` left optional (null = global assignment) | 8 |

**Total: 60 unit tests across 5 files, all passing.**

#### Verification (verbatim)

`pnpm build --filter @arcaai/domains`
```
@arcaai/domains:build: cache bypass, force executing 71aa45dd08c16d3c
@arcaai/domains:build:
@arcaai/domains:build: > @arcaai/domains@0.0.1 build /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/domains
@arcaai/domains:build: > tsc
@arcaai/domains:build:

 Tasks:    4 successful, 4 total
Cached:    0 cached, 4 total
  Time:    6.459s
```

`pnpm test:unit packages/domains/src/entities/__tests__/PermissionEntity.test.ts`
```
 Test Files  1 passed (1)
      Tests  19 passed (19)
   Duration  809ms
```

`pnpm test:unit packages/domains/src/entities/__tests__/RoleEntity.test.ts`
```
 Test Files  1 passed (1)
      Tests  12 passed (12)
   Duration  688ms
```

`pnpm test:unit packages/domains/src/entities/__tests__/RolePermissionEntity.test.ts`
```
 Test Files  1 passed (1)
      Tests  6 passed (6)
   Duration  722ms
```

`pnpm test:unit packages/domains/src/entities/__tests__/UserEntity.test.ts`
```
 Test Files  1 passed (1)
      Tests  15 passed (15)
   Duration  729ms
```

`pnpm test:unit packages/domains/src/entities/__tests__/UserRoleAssignmentEntity.test.ts`
```
 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  686ms
```

`pnpm lint --filter @arcaai/domains`
```
@arcaai/domains:lint: > @arcaai/domains@0.0.1 lint /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/domains
@arcaai/domains:lint: > ESLINT_USE_FLAT_CONFIG=false eslint .
@arcaai/domains:lint:
@arcaai/domains:lint: /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/domains/src/interfaces/queueAdminTypes.ts
@arcaai/domains:lint:   18:29  warning  Replace ... with ...  prettier/prettier
@arcaai/domains:lint:
@arcaai/domains:lint: ✖ 1 problem (0 errors, 1 warning)

 Tasks:    4 successful, 4 total
```

The single prettier warning in `queueAdminTypes.ts` is pre-existing and unrelated to this ticket (outside Tier 1 ownership).

#### Deviations

- `PermissionEntity` and `RolePermissionEntity` no longer have backing Prisma models (replaced by `Policy` / `RolePolicy`). The entities remain in the generated layer with their original TypeScript shape, so invariants were derived from `IPermissionEntity` / `IRolePermissionEntity` rather than from a live `*.prisma` file.
- `RoleEntity` interface exposes `userRoleAssignmentId` (legacy field) but no `parentRoleId`, while the `Role` Prisma model has `parentRoleId` instead. Validated only what the entity surface exposes; the schema/entity drift is out of scope for this ticket.
- No factory, mapper, model, or repository signatures were touched.

### Tier 2 — User & Communication (Agent K)

Replaced the `BusinessException('Method not implemented.')` stub on five
entities with `validate()` implementations that enforce the invariants
spelled out in the corresponding Prisma models (`user.prisma`,
`notification.prisma`). Style mirrors `TenantEntity` / `GlobalSettingEntity`
— terse, BusinessException with a field-prefixed message, conservative
defaults applied where the Prisma column carries no explicit cap.

| Entity | Invariants enforced | Tests added |
|---|---|---|
| `UserProfileEntity` | `userId` required (non-empty trim); `firstName` / `lastName` / `email` / `phone` / `avatarId` ≤ 255 chars when present (no Prisma cap → conservative default). | 11 |
| `UserSettingsEntity` | `name` required ≤ 255; `key` required ≤ 100; `value` must be `string` (empty allowed); `dataType` required + member of `Enums.ValueType`; `namespace` ≤ 100 when present; `userId` required. JSON `value` parseability deliberately omitted per Conservative Defaults (track-only). | 34 |
| `UserMediaEntity` | `userId` and `mediaId` FK strings both required (non-empty trim); `sharedAt` is track-only DateTime. | 7 |
| `NotificationEntity` | `title` required ≤ 255; `type` required + member of `Enums.NotificationType`; `read` typeof boolean; `targetUserId` required; `resourceSubscriptionId` non-empty when provided. `messageText` / `messageRichText` / `messageContent` are track-only (unbounded TEXT / JSON). | 18 |
| `ResourceSubscriptionEntity` | `subscriptionType` required + member of `Enums.ResourceSubscriptionType`; `targetUserId` required; `resourceId` non-empty when provided; `resourceTypeName` ≤ 255 when present; `subscriptionMetadata` track-only JSON. | 13 |

**Total tests added:** 83 (across 5 new files under `packages/domains/src/entities/__tests__/`).

#### Deviations from defaults

- For optional unbounded TEXT columns (`Notification.messageText` /
  `messageRichText`) no length cap is enforced — the columns are intentionally
  unbounded in Postgres and a 255-char cap would be wrong for body content.
  Length validation skipped per the Conservative Defaults' "format/length only
  when present" allowance, which is discretionary for unbounded fields.
- `UserSettings.value` parseability against `dataType` was NOT replicated from
  `GlobalSettingEntity`. The README's Conservative Defaults explicitly mark
  JSON / DateTime as track-only; per-`ValueType` parseability is a richer
  format check that belongs in a follow-up. The basic typeof-string check is
  retained, and `''` is tolerated to match the masking pattern already used
  by `tenant.service.fetchTenantConfigs`.
- `UserProfile.email` is bounded only by length (≤ 255). No format / regex
  check was added — the README does not call for one and email-format
  validation is policy that belongs in the service layer (TenantEntity sets
  precedent: `description` is length-bounded only).

#### Verification — verbatim output

`pnpm build --filter @arcaai/domains`:

```
@arcaai/domains:build: cache bypass, force executing aae82059de8fb135
@arcaai/domains:build:
@arcaai/domains:build: > @arcaai/domains@0.0.1 build /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/domains
@arcaai/domains:build: > tsc

 Tasks:    4 successful, 4 total
Cached:    0 cached, 4 total
  Time:    13.569s
```

`pnpm test:unit packages/domains/src/entities/__tests__/UserProfileEntity.test.ts`:

```
 RUN  v4.1.1 /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2

 ✓ packages/domains/src/entities/__tests__/UserProfileEntity.test.ts > UserProfileEntity.validate() > valid entity > should not throw for a fully valid entity 13ms
 ✓ packages/domains/src/entities/__tests__/UserProfileEntity.test.ts > UserProfileEntity.validate() > valid entity > should not throw the legacy "Method not implemented." sentinel 0ms
 ✓ packages/domains/src/entities/__tests__/UserProfileEntity.test.ts > UserProfileEntity.validate() > valid entity > should accept null/undefined optional fields 0ms
 ✓ packages/domains/src/entities/__tests__/UserProfileEntity.test.ts > UserProfileEntity.validate() > userId > should throw when userId is empty 7ms
 ✓ packages/domains/src/entities/__tests__/UserProfileEntity.test.ts > UserProfileEntity.validate() > userId > should throw when userId is whitespace only 1ms
 ✓ packages/domains/src/entities/__tests__/UserProfileEntity.test.ts > UserProfileEntity.validate() > firstName > should throw when firstName exceeds 255 characters 0ms
 ✓ packages/domains/src/entities/__tests__/UserProfileEntity.test.ts > UserProfileEntity.validate() > firstName > should accept firstName exactly 255 characters 1ms
 ✓ packages/domains/src/entities/__tests__/UserProfileEntity.test.ts > UserProfileEntity.validate() > lastName > should throw when lastName exceeds 255 characters 1ms
 ✓ packages/domains/src/entities/__tests__/UserProfileEntity.test.ts > UserProfileEntity.validate() > email > should throw when email exceeds 255 characters 0ms
 ✓ packages/domains/src/entities/__tests__/UserProfileEntity.test.ts > UserProfileEntity.validate() > phone > should throw when phone exceeds 255 characters 1ms
 ✓ packages/domains/src/entities/__tests__/UserProfileEntity.test.ts > UserProfileEntity.validate() > avatarId > should throw when avatarId exceeds 255 characters 1ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
```

`pnpm test:unit packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts`:

```
 RUN  v4.1.1 /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2

 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should not throw for a fully valid entity 1ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should not throw the legacy "Method not implemented." sentinel 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType String (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType Integer (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType Float (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType Double (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType Decimal (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType Boolean (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType Json (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType Date (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType DateTime (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType Array (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType Uuid (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType Binary (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType Enum (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType Hstore (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType Inet (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType Citext (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > valid entity > should accept dataType Interval (track-only on value) 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > name > should throw when name is empty 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > name > should throw when name is whitespace only 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > name > should throw when name exceeds 255 characters 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > key > should throw when key is empty 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > key > should throw when key is whitespace only 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > key > should throw when key exceeds 100 characters 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > value > should throw when value is undefined 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > value > should throw when value is null 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > value > should accept empty string value 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > dataType > should throw when dataType is undefined 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > dataType > should throw when dataType is not a member of ValueType 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > namespace > should accept null namespace 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > namespace > should throw when namespace exceeds 100 characters 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > userId > should throw when userId is empty 0ms
 ✓ packages/domains/src/entities/__tests__/UserSettingsEntity.test.ts > UserSettingsEntity.validate() > userId > should throw when userId is whitespace only 0ms

 Test Files  1 passed (1)
      Tests  34 passed (34)
```

`pnpm test:unit packages/domains/src/entities/__tests__/UserMediaEntity.test.ts`:

```
 RUN  v4.1.1 /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2

 ✓ packages/domains/src/entities/__tests__/UserMediaEntity.test.ts > UserMediaEntity.validate() > valid entity > should not throw for a fully valid entity 1ms
 ✓ packages/domains/src/entities/__tests__/UserMediaEntity.test.ts > UserMediaEntity.validate() > valid entity > should not throw the legacy "Method not implemented." sentinel 0ms
 ✓ packages/domains/src/entities/__tests__/UserMediaEntity.test.ts > UserMediaEntity.validate() > valid entity > should accept a populated sharedAt (track-only) 0ms
 ✓ packages/domains/src/entities/__tests__/UserMediaEntity.test.ts > UserMediaEntity.validate() > userId > should throw when userId is empty 0ms
 ✓ packages/domains/src/entities/__tests__/UserMediaEntity.test.ts > UserMediaEntity.validate() > userId > should throw when userId is whitespace only 0ms
 ✓ packages/domains/src/entities/__tests__/UserMediaEntity.test.ts > UserMediaEntity.validate() > mediaId > should throw when mediaId is empty 0ms
 ✓ packages/domains/src/entities/__tests__/UserMediaEntity.test.ts > UserMediaEntity.validate() > mediaId > should throw when mediaId is whitespace only 0ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
```

`pnpm test:unit packages/domains/src/entities/__tests__/NotificationEntity.test.ts`:

```
 RUN  v4.1.1 /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2

 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > valid entity > should not throw for a fully valid entity 1ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > valid entity > should not throw the legacy "Method not implemented." sentinel 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > valid entity > should accept type STANDARD 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > valid entity > should accept type LINK 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > valid entity > should accept type ACTION 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > valid entity > should accept null/undefined optional message fields 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > title > should throw when title is empty 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > title > should throw when title is whitespace only 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > title > should throw when title exceeds 255 characters 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > title > should accept title exactly 255 characters 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > type > should throw when type is undefined 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > type > should throw when type is not a member of NotificationType 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > read > should throw when read is not a boolean 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > read > should accept read=true 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > targetUserId > should throw when targetUserId is empty 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > targetUserId > should throw when targetUserId is whitespace only 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > resourceSubscriptionId > should accept null resourceSubscriptionId 0ms
 ✓ packages/domains/src/entities/__tests__/NotificationEntity.test.ts > NotificationEntity.validate() > resourceSubscriptionId > should throw when resourceSubscriptionId is an empty string 0ms

 Test Files  1 passed (1)
      Tests  18 passed (18)
```

`pnpm test:unit packages/domains/src/entities/__tests__/ResourceSubscriptionEntity.test.ts`:

```
 RUN  v4.1.1 /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2

 ✓ packages/domains/src/entities/__tests__/ResourceSubscriptionEntity.test.ts > ResourceSubscriptionEntity.validate() > valid entity > should not throw for a fully valid entity 1ms
 ✓ packages/domains/src/entities/__tests__/ResourceSubscriptionEntity.test.ts > ResourceSubscriptionEntity.validate() > valid entity > should not throw the legacy "Method not implemented." sentinel 0ms
 ✓ packages/domains/src/entities/__tests__/ResourceSubscriptionEntity.test.ts > ResourceSubscriptionEntity.validate() > valid entity > should accept subscriptionType CREATOR 0ms
 ✓ packages/domains/src/entities/__tests__/ResourceSubscriptionEntity.test.ts > ResourceSubscriptionEntity.validate() > valid entity > should accept subscriptionType SUBSCRIBER 0ms
 ✓ packages/domains/src/entities/__tests__/ResourceSubscriptionEntity.test.ts > ResourceSubscriptionEntity.validate() > valid entity > should accept subscriptionType MENTIONED 0ms
 ✓ packages/domains/src/entities/__tests__/ResourceSubscriptionEntity.test.ts > ResourceSubscriptionEntity.validate() > valid entity > should accept null/undefined optional resourceId, resourceTypeName, subscriptionMetadata 0ms
 ✓ packages/domains/src/entities/__tests__/ResourceSubscriptionEntity.test.ts > ResourceSubscriptionEntity.validate() > subscriptionType > should throw when subscriptionType is undefined 0ms
 ✓ packages/domains/src/entities/__tests__/ResourceSubscriptionEntity.test.ts > ResourceSubscriptionEntity.validate() > subscriptionType > should throw when subscriptionType is not a member of ResourceSubscriptionType 0ms
 ✓ packages/domains/src/entities/__tests__/ResourceSubscriptionEntity.test.ts > ResourceSubscriptionEntity.validate() > targetUserId > should throw when targetUserId is empty 0ms
 ✓ packages/domains/src/entities/__tests__/ResourceSubscriptionEntity.test.ts > ResourceSubscriptionEntity.validate() > targetUserId > should throw when targetUserId is whitespace only 0ms
 ✓ packages/domains/src/entities/__tests__/ResourceSubscriptionEntity.test.ts > ResourceSubscriptionEntity.validate() > resourceId > should throw when resourceId is whitespace only 0ms
 ✓ packages/domains/src/entities/__tests__/ResourceSubscriptionEntity.test.ts > ResourceSubscriptionEntity.validate() > resourceTypeName > should throw when resourceTypeName exceeds 255 characters 0ms
 ✓ packages/domains/src/entities/__tests__/ResourceSubscriptionEntity.test.ts > ResourceSubscriptionEntity.validate() > resourceTypeName > should accept resourceTypeName exactly 255 characters 0ms

 Test Files  1 passed (1)
      Tests  13 passed (13)
```

`pnpm lint --filter @arcaai/domains`:

```
@arcaai/domains:lint: > @arcaai/domains@0.0.1 lint /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/domains
@arcaai/domains:lint: > ESLINT_USE_FLAT_CONFIG=false eslint .

@arcaai/domains:lint: /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/domains/src/interfaces/queueAdminTypes.ts
@arcaai/domains:lint:   18:29  warning  Replace `⏎··|·'job:completed'⏎··|·'job:failed'⏎··|·'job:stalled'⏎··|·'job:active'⏎··|·'job:waiting'⏎·` with `·'job:completed'·|·'job:failed'·|·'job:stalled'·|·'job:active'·|·'job:waiting'`  prettier/prettier
@arcaai/domains:lint:
@arcaai/domains:lint: ✖ 1 problem (0 errors, 1 warning)

 Tasks:    4 successful, 4 total
Cached:    1 cached, 4 total
  Time:    3.775s
```

**Note on lint warning**: the single `prettier/prettier` warning in
`packages/domains/src/interfaces/queueAdminTypes.ts` is pre-existing and
unrelated to the Tier 2 file ownership zone — left untouched per Karpathy
guideline #3 ("clean up only your own mess").

### Tier 3 — Media/Webhooks/Audit (Agent L)

All five Tier 3 entities replaced their `BusinessException('Method not implemented.')` stubs with real
invariant checks following the precedent set by `TenantEntity` / `GlobalSettingEntity` (TASK-259) and
`ApiKeyEntity`. Tests were written RED-first, watched fail with the legacy sentinel, then turned GREEN.
The Conservative Defaults from this README's "Implementation Plan" section were honoured throughout —
required strings non-empty + length-capped, enums verified against `Object.values(Enums.X)`, FKs
non-empty trimmed, JSON / DateTime fields left as track-only.

| Entity | Invariants enforced | Tests added |
|---|---|---|
| `MediaEntity` | `name` (req, ≤255) · `uri` (req, ≤2048) · `extension` (req, ≤32) · `mimeType` (req, ≤255) · `size` (non-negative finite integer) · `hash` (req, ≤255) · `bucketId` (non-blank-when-present) | 21 |
| `TagEntity` | `tagValue` (req, ≤255) · `tagKey` (≤100 when present) · `resourceTypeName` (≤100 when present) · `resourceId` (non-blank-when-present) · `description` (≤1000) · `color` (≤32) · `icon` (≤255) | 13 |
| `WebhookEntity` | `name` (req, ≤255) · `url` (req, ≤2048, parseable via `new URL(...)`) · `resourceTypeName` (req, ≤100) · `hashedSecret` (≤255) · `resourceId` (non-blank-when-present) · `subscriptionMetadata` track-only | 20 |
| `WebhookRunHistoryEntity` | `status` (required member of `Enums.WebhookRunStatus`) · `webhookId` (required FK, non-empty trimmed) · `responeStatusCode` (HTTP 100–599 integer when present) · `response` track-only | 12 |
| `AuditLogEntity` | `action` (required member of `Enums.AuditAction`) · `resourceType` (required member of `Enums.ResourceType`) · `responsibleUserId` (non-blank-when-present) · `responsibleIp` (≤45) · `resourceId` (non-blank-when-present) · `eventType` (≤100) · `tenantId` nullable allowed (global-scope policy events) · `data` / `previousData` / `metadata` track-only | 22 |

**Files written**

- `packages/domains/src/entities/generated/core/MediaEntity.ts` — `validate()` implemented.
- `packages/domains/src/entities/generated/core/TagEntity.ts` — `validate()` implemented.
- `packages/domains/src/entities/generated/core/WebhookEntity.ts` — `validate()` implemented.
- `packages/domains/src/entities/generated/core/WebhookRunHistoryEntity.ts` — `validate()` implemented.
- `packages/domains/src/entities/generated/core/AuditLogEntity.ts` — `validate()` implemented.
- `packages/domains/src/entities/__tests__/MediaEntity.test.ts` — 21 tests (new).
- `packages/domains/src/entities/__tests__/TagEntity.test.ts` — 13 tests (new).
- `packages/domains/src/entities/__tests__/WebhookEntity.test.ts` — 20 tests (new).
- `packages/domains/src/entities/__tests__/WebhookRunHistoryEntity.test.ts` — 12 tests (new).
- `packages/domains/src/entities/__tests__/AuditLogEntity.test.ts` — 22 tests (new).

**Deviations from the plan**: none. No factory/mapper/model/repository/service signatures were touched.
The `ResourceType` TypeScript enum is currently a superset of the Prisma `ResourceType` enum (it omits
`Session*`, `AudioRecording`, `SummaryMeta`, `NamedEntity` and includes `UserVoiceProfile`); validation
uses `Object.values(Enums.ResourceType)` so the TS source-of-truth wins, matching the precedent set by
`GlobalSettingEntity.validate()` against `Enums.ValueType`.

**Verification — verbatim output**

```text
$ pnpm build --filter @arcaai/domains
@arcaai/exceptions:build: cache bypass, force executing 5caa1485cfb526b8
@arcaai/database:db:generate:
@arcaai/database:db:generate: > @arcaai/database@0.1.0 db:generate /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/database
@arcaai/database:db:generate: > prisma generate && pnpm --filter @arcaai/tools generate-prisma-index
@arcaai/database:db:generate: ✔ Generated Prisma Client (7.5.0) to ./src/generated/core-prisma-client in 457ms
@arcaai/database:db:generate: ✅ Index file generated successfully!
@arcaai/database:build: cache bypass, force executing 9458334ddf9774b1
@arcaai/database:build: > @arcaai/database@0.1.0 build /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/database
@arcaai/database:build: > tsc
@arcaai/domains:build: cache bypass, force executing aae82059de8fb135
@arcaai/domains:build: > @arcaai/domains@0.0.1 build /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/domains
@arcaai/domains:build: > tsc

 Tasks:    4 successful, 4 total
Cached:    0 cached, 4 total
  Time:    11.635s
```

```text
$ pnpm test:unit packages/domains/src/entities/__tests__/MediaEntity.test.ts \
                 packages/domains/src/entities/__tests__/TagEntity.test.ts \
                 packages/domains/src/entities/__tests__/WebhookEntity.test.ts \
                 packages/domains/src/entities/__tests__/WebhookRunHistoryEntity.test.ts \
                 packages/domains/src/entities/__tests__/AuditLogEntity.test.ts

 RUN  v4.1.1 /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2

 ✓ packages/domains/src/entities/__tests__/MediaEntity.test.ts             (21 tests)
 ✓ packages/domains/src/entities/__tests__/TagEntity.test.ts               (13 tests)
 ✓ packages/domains/src/entities/__tests__/WebhookEntity.test.ts           (20 tests)
 ✓ packages/domains/src/entities/__tests__/WebhookRunHistoryEntity.test.ts (12 tests)
 ✓ packages/domains/src/entities/__tests__/AuditLogEntity.test.ts          (22 tests)

 Test Files  5 passed (5)
      Tests  88 passed (88)
   Start at  00:06:15
   Duration  719ms (transform 1.82s, setup 89ms, import 3.14s, tests 22ms, environment 0ms)
```

```text
$ pnpm lint --filter @arcaai/domains
@arcaai/domains:lint: > @arcaai/domains@0.0.1 lint /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/domains
@arcaai/domains:lint: > ESLINT_USE_FLAT_CONFIG=false eslint .
@arcaai/domains:lint:
@arcaai/domains:lint: /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/domains/src/interfaces/queueAdminTypes.ts
@arcaai/domains:lint:   18:29  warning  Replace `⏎··|·'job:completed'⏎··|·'job:failed'⏎··|·'job:stalled'⏎··|·'job:active'⏎··|·'job:waiting'⏎·` with `·'job:completed'·|·'job:failed'·|·'job:stalled'·|·'job:active'·|·'job:waiting'`  prettier/prettier
@arcaai/domains:lint:
@arcaai/domains:lint: ✖ 1 problem (0 errors, 1 warning)

 Tasks:    4 successful, 4 total
Cached:    0 cached, 4 total
  Time:    6.309s
```

The single lint warning in `packages/domains/src/interfaces/queueAdminTypes.ts` is **pre-existing** and
unrelated to the Tier 3 entity files; it was not introduced by this work.

---

## Verification (consolidated)

Run from the repo root after all three tier agents completed:

```text
$ pnpm build --filter @arcaai/domains
@arcaai/domains:build: > tsc
 Tasks:    4 successful, 4 total
 Time:     5.574s

$ pnpm lint --filter @arcaai/domains
@arcaai/domains:lint: ✖ 1 problem (0 errors, 1 warning)
   /packages/domains/src/interfaces/queueAdminTypes.ts:18:29 — pre-existing prettier
   warning, outside any agent's ownership zone
 Tasks:    4 successful, 4 total

$ pnpm test:unit packages/domains/src/entities/__tests__/
 Test Files  17 passed (17)
      Tests  294 passed (294)
   Duration  1.75s
```

### Test count breakdown (294 total)

| Source | Files | Tests |
|---|---|---|
| TASK-259 (Agent H — Tenant + GlobalSetting) | 2 | 63 (22 + 41) |
| TASK-261 Tier 1 (Agent J — auth/security) | 5 | 60 (19 + 12 + 6 + 15 + 8) |
| TASK-261 Tier 2 (Agent K — user/comms) | 5 | 83 (11 + 34 + 7 + 18 + 13) |
| TASK-261 Tier 3 (Agent L — media/webhooks/audit) | 5 | 88 (21 + 13 + 20 + 12 + 22) |
| **Total** | **17** | **294** |

### Cross-cutting consistency

All three tiers stayed within the README's "Conservative Defaults":
- Required strings: non-empty trim + length cap ≤ Prisma `@db.VarChar(N)` (or 255 default).
- Optional fields: validated only when present.
- Enum fields: `Object.values(Enums.X).includes(...)` membership.
- FK strings: non-empty when required; explicitly tolerated as `null` for global-scope rows (`UserRoleAssignment.tenantId`, `AuditLog.tenantId`).
- JSON / DateTime / async checks: track-only, no structural validation.
- All `BusinessException` messages follow the `<EntityName>.<field> must …` format established by `TenantEntity.validate()`.

### Sentinel coverage

Every test file asserts that the legacy `'Method not implemented.'` sentinel is no longer thrown. A future regression that re-introduces the stub in any of the 17 entities will fail its corresponding sentinel test immediately.

---

## Change History

| Date | Author | Summary | Files |
|------|--------|---------|-------|
| 2026-05-17 | Orchestrator | Created TASK-261 with 3-tier partition | `docs/implementation/TASK-261-Entity-Validate-Rollout/README.md` |
| 2026-05-17 | Agent J | Tier 1 — Auth/Security (5 entities, 60 tests) | 5 entities + 5 tests in `packages/domains/src/entities/{generated/core,__tests__}/` |
| 2026-05-17 | Agent K | Tier 2 — User & Communication (5 entities, 83 tests) | 5 entities + 5 tests in `packages/domains/src/entities/{generated/core,__tests__}/` |
| 2026-05-17 | Agent L | Tier 3 — Media/Webhooks/Audit (5 entities, 88 tests) | 5 entities + 5 tests in `packages/domains/src/entities/{generated/core,__tests__}/` |
| 2026-05-17 | Orchestrator | Consolidated verification (294 tests, 0 lint errors); status → Completed | `docs/implementation/TASK-261-Entity-Validate-Rollout/README.md` |
