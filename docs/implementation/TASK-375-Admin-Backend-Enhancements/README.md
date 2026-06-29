# TASK-375 — Admin Backend Enhancements

| | |
|---|---|
| **Ticket** | TASK-375 |
| **Name** | Admin Backend Enhancements (Users query · media URLs · D8 solidification) |
| **Created** | 2026-06-27 |
| **Updated** | 2026-06-27 |
| **Status** | Completed |

Backend support for the new Admin app (`apps/admin`). Three independent backend
items, all query-/DTO-level (no schema migration). Mirrors the audit-log offset
pagination pattern (TASK-373) and the existing blob-storage serving mechanism.

---

## 1. Requirement Analysis

### 1.1 Users list: sort / filter / search (item 3 backend)

The Admin Users grid (`@arcaai/vox` `useUsers().listPaginated`, extended in
parallel) must be able to **sort, filter and free-text search** the
`GET /admin/users` list, server-side, via the shared `PaginatedQuery` contract
(CSV `filters` + `sort` + `search`/`searchFields`) — consistent with the
audit-log offset list (tenant scoping, soft-delete, RBAC/CASL, 404-over-403).

**Acceptance criteria**

- `GET /admin/users` accepts `filters`, `sort`, `search`, `searchFields` and
  applies them through the repository.
- The existing tenant-scoping invariants (TASK-326 X2 / TASK-331 #2) are
  preserved: a non-super-admin is confined to their CLS tenant; a super-admin
  may read cross-tenant or scope to an elevated `X-Tenant-Id`.
- Offset paging is **deterministic** (stable ordering across pages).

### 1.2 Storage-resolved media URLs (item 4)

Consultation **context items** carry a `mediaId` but no accessible URL, so the
admin timeline cannot render image / pdf / audio / file attachments. The
context-item Response DTO must expose a resolved, accessible `url` (+ `mimeType`,
+ optional `thumbnailUrl`) per attachment, using the existing serving mechanism.

**Acceptance criteria**

- `GET /consultations/:id/context` items with a `mediaId` carry a resolved
  `url` (presigned), `mimeType`, and `thumbnailUrl` (images).
- Resolution is best-effort and never breaks the read when storage/media is
  unavailable or the `mediaId` does not resolve.

### 1.3 Solidify D8 (item 1 backend)

The `ui.data-grid` user-settings namespace (per-user grid layout) was given
namespace recognition + a 16 KiB JSON cap (TASK-372 D8). The validation must be
robust: enforced by the **service** so it applies to every entry point — both
the self-service `PATCH /user/me/settings/:ns/:key` and the admin
`PATCH /admin/users/:id/settings/:ns/:key` path.

**Acceptance criteria**

- `IUserSettingsService.upsertByUserKeyNamespace` rejects a non-JSON or
  oversized `ui.data-grid` value (`BadRequestException`) and accepts a valid
  small JSON layout round-trip.
- The self-service controller keeps its early validation (defense-in-depth),
  delegating to the same shared validator (no duplicated logic).

---

## 2. Current State Evaluation

### 2.1 Users list — already wired, one gap

| Concern | Status (pre-TASK-375) |
|---|---|
| `PaginatedQuery` accepted on `GET /admin/users` | ✅ `UserController.fetchAll(@Query() q: PaginatedQuery)` |
| `filters` / `sort` applied | ✅ `UserService.fetchAll`/`fetchAllByTenantId` → `withFormattedPaginatedProps` → `Repository.findAll` (`formatFindAllProps`) |
| `search` over default fields | ✅ `UserRepository` ctor sets default search fields `['username','externalId']` |
| Tenant scope / soft-delete / RBAC / 404-over-403 | ✅ TASK-326 X2 / TASK-331 #2 / `@CanManage('User')` |
| **Deterministic default ordering** | ❌ no default `sort` → offset paging is non-deterministic |

**Finding:** the filter/sort/search plumbing is already present (identical to the
audit-log offset path). The only genuine gap is the missing **default sort** that
the audit-log list has, which makes server-side offset paging stable.

### 2.2 Media storage / serving — mechanism found

- **Storage:** S3/MinIO or Azure behind the provider-agnostic
  `IBlobStorageService` (TASK-318). `@Global` (`BlobStorageModule`).
- **Media metadata:** `Media` rows (`MediaEntity`) created on upload
  (`StorageController.uploadFile`) with `uri = s3://{bucket}/{key}`, plus
  `mimeType`, `name`, `extension`, `size`.
- **Serving:** presigned GET URLs via `IBlobStorageService.presignGet({ bucket,
  key, expiresInSeconds })` — exactly what `StorageController.getFileInfo`
  returns. **No new serving mechanism is required.**
- **Gap:** `ContextDtoMapper.toResponse` maps `mediaId` only; no resolved URL.

### 2.3 D8 — validation only at one entry point

- `userSettings.namespaces.ts` defines `USER_SETTINGS_NAMESPACES.UI_DATA_GRID`
  + `UI_DATA_GRID_MAX_BYTES` (16 KiB).
- Validation (JSON parse + byte cap) lives **only** in
  `UserSettingsController.validateDataGridValue` (self-service path).
- **Gap:** the admin path (`UserController.updateUserSetting` →
  `userSettingsService.upsertByUserKeyNamespace`) bypasses the cap/JSON check;
  the service itself does not validate.

---

## 3. Implementation Plan (TDD)

Layer order respected; no Domain change required for any item.

### Item 1 — Users default sort (API)

- **RED:** `user.controller.test.ts` — `fetchAll`/`fetchByTenant` forward a
  default `sort: 'createdAt:desc'` when none supplied, and preserve an explicit
  `sort`; `filters`/`search` are forwarded untouched.
- **GREEN:** in `UserController`, default `sort ??= 'createdAt:desc'` before
  delegating (all `fetchAll` branches + `fetchByTenant`), mirroring
  `AuditLogController`.
- **Regression-lock:** `user.service.test.ts` — `fetchAll`/`fetchAllByTenantId`
  forward `filters`/`sort`/`search` into `Repository.findAll`/`count` and
  compose with the tenant `where`.

### Item 2 — Context-item media URLs (Application)

- **DTO:** add `url?`, `mimeType?`, `thumbnailUrl?` to `ContextItemResponse`.
- **Mapper:** add `ContextDtoMapper.applyMediaUrl(response, resolved)` (pure,
  sync) that assigns the resolved fields.
- **Service:** `ContextService` gains two `@Optional()` deps (`MediaRepository`,
  `IBlobStorageService`; both already injectable — no module change). New
  private `resolveMediaUrls(mediaIds)` batches `MediaRepository.findAll({ id:
  { in } })`, parses `s3://bucket/key`, calls `presignGet`, returns a
  `Map<mediaId, ResolvedMedia>`. `getContextItems` enriches each response.
- **RED:** mapper test (applyMediaUrl) + service test (`getContextItems`
  presigns and attaches `url`/`mimeType`/`thumbnailUrl`; degrades to no-op
  without deps / on unresolved id).

### Item 3 — D8 service-level validation (Application + API)

- **Namespaces:** add `validateUiDataGridValue(value)` to
  `userSettings.namespaces.ts` (throws `BadRequestException`; identical
  messages to the controller).
- **Service:** `upsertByUserKeyNamespace` calls it when `namespace ===
  UI_DATA_GRID`.
- **Controller:** `validateDataGridValue` delegates to the shared validator
  (drops the duplicated body + now-unused `UI_DATA_GRID_MAX_BYTES` import).
- **RED:** `userSettings.namespaces.test.ts` (validator) + service test
  (`upsertByUserKeyNamespace` accept/reject JSON/size).

### Migration decision

**No Prisma migration.** All three items are query-level (Users sort) or
DTO-/validation-level (media URLs, D8). No schema change. No
DELETE/DROP/TRUNCATE or reset run.

---

## 4. Implementation Summary

All three items shipped query-/DTO-/validation-level only — **no Prisma
migration, no Domain-layer change**, and **no destructive SQL** (no
DELETE/DROP/TRUNCATE/reset).

### 4.1 Users list: sort / filter / search

The filter/sort/search plumbing was already present and identical to the
audit-log offset path (`UserService.fetchAll`/`fetchAllByTenantId` →
`withFormattedPaginatedProps` → `Repository.findAll`/`count`; `UserRepository`
default search fields `['username','externalId']`). The only real gap was
**non-deterministic offset paging**, so the change is surgical:

- `UserController` now applies a default `sort` of **`createdAt:desc`** via a
  private `withDefaultSort(query)` helper (constant `DEFAULT_USERS_SORT`),
  applied on **every** read branch — super-admin `fetchAll`, the non-super-admin
  tenant-scoped branch, the elevated `X-Tenant-Id` branch, and `fetchByTenant` —
  before delegating. An explicit caller `sort` is always preserved; `filters` /
  `search` / `searchFields` pass through untouched. Mirrors `AuditLogController`.
- Tenant scoping, soft-delete, RBAC/CASL (`@CanManage('User')`) and the
  404-over-403 invariants are unchanged.

**Endpoints:** `GET /admin/users` (list, optional `X-Tenant-Id` elevation) and
`GET /admin/users/tenant/:tenantId` (explicit tenant). Contract:
`?page&limit&search&searchFields&filters&sort` (shared `PaginatedQuery`, CSV
`filters`/`sort`).

### 4.2 Storage-resolved media URLs

**Storage mechanism found (reused as-is, nothing new built):** media is stored
behind the provider-agnostic `IBlobStorageService` (TASK-318, S3/MinIO **or**
Azure; `@Global BlobStorageModule.forRoot()`). On upload, `StorageController`
creates a `Media` row with `uri = s3://{bucket}/{key}` + `mimeType`, and serving
is via `IBlobStorageService.presignGet({ bucket, key, expiresInSeconds })` —
exactly what `StorageController.getFileInfo` returns.

- **DTO** (`ContextItemResponse`): added optional `url`, `mimeType`,
  `thumbnailUrl`.
- **Mapper** (`ContextDtoMapper`): added the pure/sync
  `applyMediaUrl(response, resolved)` + the `ResolvedMediaUrl` type; the
  entity→DTO `toResponse` stays synchronous and storage-free.
- **Service** (`ContextService`): two new `@Optional() @Inject(...)` deps —
  `MediaRepository` (from `CoreDatabaseModule`, already imported) and
  `IBlobStorageService` (from the `@Global` storage module). `getContextItems`
  maps as before, then `attachMediaUrls()` batches the lookup
  (`MediaRepository.findAll({ where: { id: { in: distinctMediaIds } } })`),
  parses `s3://bucket/key` (`parseStorageUri`), and `presignGet`s each (1 h TTL,
  mirrors `StorageController`). Images additionally get a `thumbnailUrl` — a real
  downscaled WebP derivative when one exists, else the full-size URL (see the
  2026-06-27 Change History entry). One findAll + N presigns per timeline.
- **Resilience / wiring:** both deps are confirmed wired at the API root, so the
  feature is **live in production** (not merely degraded). Resolution is
  nonetheless best-effort: a media row whose `uri` isn't `s3://…`, or whose
  presign throws, is warn-logged and skipped so one bad attachment never fails
  the whole timeline read. When the deps are absent (legacy direct construction)
  it is a clean no-op.

**Endpoint enriched:** `GET /consultations/:id/context` (admin timeline).

### 4.3 Solidify D8 (`ui.data-grid` validation)

Validation was promoted from the self-service controller down into the
**service** so every write path is covered:

- **Namespaces** (`userSettings.namespaces.ts`): added the canonical
  `validateUiDataGridValue(value)` — byte-cap check first (`UI_DATA_GRID_MAX_BYTES`
  = 16 KiB), then `JSON.parse`; throws `BadRequestException` on violation.
- **Service** (`UserSettingsService.upsertByUserKeyNamespace`): calls the shared
  validator when `namespace === UI_DATA_GRID`, **before** touching the
  repository. The open registry is preserved — all other namespaces pass through
  unvalidated.
- **Controller** (`UserSettingsController`): the old private
  `validateDataGridValue` body was removed; it now delegates to the same shared
  validator (defense-in-depth early 400; no duplicated logic; dropped the
  now-unused `UI_DATA_GRID_MAX_BYTES` import).

**Endpoints covered:** self-service `PATCH /user/me/settings/:namespace/:key`
**and** the admin path `UserController.updateUserSetting` →
`upsertByUserKeyNamespace`.

## 5. Files Changed

### Application layer (`packages/applications`)

| File | Change |
|---|---|
| `services/consultation/context/dto/context-item.response.ts` | +`url?`, `mimeType?`, `thumbnailUrl?` on `ContextItemResponse` |
| `services/consultation/context/context.dto.mapper.ts` | +`ResolvedMediaUrl` type, +`applyMediaUrl()` |
| `services/consultation/context/context.service.ts` | +2 `@Optional` deps, +`parseStorageUri`, +`CONTEXT_MEDIA_URL_TTL_SECONDS`, +`attachMediaUrls`/`resolveMediaUrls`, enrich `getContextItems` |
| `services/consultation/context/__tests__/context.service.test.ts` | +5 media-URL resolution tests |
| `services/consultation/context/__tests__/context.dto.mapper.test.ts` | +2 `applyMediaUrl` tests |
| `services/user/userSettings/userSettings.namespaces.ts` | +`validateUiDataGridValue()` (imports `@nestjs/common`) |
| `services/user/userSettings/userSettings.service.ts` | validate `ui.data-grid` in `upsertByUserKeyNamespace` |
| `services/user/userSettings/__tests__/userSettings.namespaces.test.ts` | +3 validator tests |
| `services/user/userSettings/__tests__/userSettings.service.test.ts` | +`findByUserKeyNamespace` mock, +4 service-validation tests |
| `services/user/user/__tests__/user.service.test.ts` | +2 filter/sort/tenant-composition regression-lock tests |

### API layer (`apps/api`)

| File | Change |
|---|---|
| `modules/user/user.controller.ts` | +`DEFAULT_USERS_SORT`, +`withDefaultSort()`, applied on all list branches |
| `modules/user/controllers/user-settings.controller.ts` | delegate to shared `validateUiDataGridValue`; drop duplicated body + unused import |
| `modules/user/__tests__/user.controller.test.ts` | +4 sort/filter/search forwarding + default-sort tests |

> No Domain (`packages/domains`) or Database (`packages/database`) files changed.

## 6. Verification Evidence

### 6.1 TDD RED → GREEN

| Item | RED | GREEN |
|---|---|---|
| D8 (namespaces + service) | `5 failed \| 32 passed` | `37 passed (2 files)` |
| Media URLs (service + mapper) | `2 failed \| 3 passed` | `217 passed (2 files)` |
| Users default sort (API) | (prior session) `3 failed` | covered in API run below |

### 6.2 Builds (layer gates)

```text
pnpm --filter @arcaai/domains build       → exit 0 (tsc)
pnpm --filter @arcaai/applications build   → exit 0 (rimraf dist && tsc)
pnpm build:api                             → Tasks: 8 successful, 8 total (database, domains, applications, api …)
```

### 6.3 Unit tests — changed-layer targeted

```text
@arcaai/api   (user-settings.controller + user.controller)   → 73 passed (2 files)
@arcaai/applications (userSettings.namespaces + userSettings.service
                      + user.service + context.service + context.dto.mapper)
                                                              → 294 passed (5 files)
```

### 6.4 Full suites (regression — constructor/import changes)

```text
@arcaai/applications  → Test Files 239 passed | 1 skipped (240)
                        Tests      5368 passed | 4 skipped (5372)
@arcaai/api           → Test Files 102 passed | 2 skipped (104)
                        Tests      1819 passed | 4 skipped (1823)
```

(The WARN/ERROR lines in suite output — “vault down”, “db-down”, fail-closed
guards — are expected assertions from negative-path tests, not failures.)

### 6.5 Lint

`ReadLints` over all 13 changed files → **No linter errors found.**

### 6.6 Migration / destructive-op statement

No Prisma migration was required or run. **No** DELETE/DROP/TRUNCATE/reset or any
destructive DB operation was executed.

## 7. Follow-ups

- `getContextItemsPaginated` (paginated variant of the same endpoint) was left
  untouched to stay surgical; if the admin timeline ever uses the paginated
  route it should call the same `attachMediaUrls` enrichment.
- ~~`thumbnailUrl` currently returns the full-size presigned image URL. A true
  downscaled thumbnail would need a derivative-generation step.~~ **Done
  (2026-06-27 — see Change History):** image attachments now resolve to a real
  downscaled WebP derivative generated on upload, with a full-size fallback for
  pre-existing media. Remaining: a backfill job for images uploaded before this
  change (they correctly fall back until re-uploaded).

## 8. Change History

- 2026-06-27 — Ticket created; requirement analysis, current-state evaluation,
  and TDD plan recorded.
- 2026-06-27 — Implemented all three items (Users default sort, context-item
  media URLs, D8 service-level validation) TDD RED→GREEN; builds + full
  applications/api suites + lint green; status → Completed.
- 2026-06-27 — **Real downscaled image thumbnails** (follow-up to §4.2 / §7).
  `thumbnailUrl` for image attachments now resolves to a genuinely smaller WebP
  derivative instead of the full-size image (the previously-flagged gap).
  - **Approach — generate-on-upload, deterministic derived key, NO migration:**
    on image upload (`StorageController.uploadFile`; `image/*` except SVG) a
    downscaled WebP (`sharp`, `fit: inside` 320 px, never enlarged, EXIF
    auto-rotated, quality 70) is generated and stored at the deterministic
    derived key `<key>.thumb.webp` in the SAME bucket. No new `Media` row and no
    DB column — the read path recomputes the same key by convention. Generation
    is best-effort: a failure is warn-logged and never fails the upload, and
    non-images are skipped entirely.
  - **Read path (`ContextService.resolveMediaUrls` → new `resolveThumbnailUrl`):**
    for image media it confirms the derivative exists (a 1-key `listObjects`
    prefix check on `<key>.thumb.webp`, reusing the existing storage interface —
    no new provider method) and presigns it. Media with no derivative (older
    uploads) — or any storage error — falls back to the full-size presigned URL,
    so current behavior never regresses and no 404 thumbnail is ever surfaced.
    Non-images keep `thumbnailUrl: undefined`.
  - **New dependency:** `sharp@^0.35.2`, added via pnpm to `@arcaai/applications`
    (the package that already owns the S3/Azure storage providers). Loaded
    lazily inside `ImageThumbnailService.generateWebpThumbnail` so importing the
    storage barrel never pulls in the native binary unless a thumbnail is
    produced. Image processing stays in-process (Node) — no Python service and
    no PHI egress.
  - **No migration / no destructive ops:** the existing `Media` schema is
    untouched. **No** Prisma migration was generated or run, and **no**
    DELETE/DROP/TRUNCATE/reset (or any destructive DB op) was executed. (A
    `Media.metaData` JSONB marker was considered but rejected in favour of the
    pure by-convention key, per the ticket's stated preference.)
  - **Files changed:**
    - `packages/applications/.../baseServices/storage/image-thumbnail.service.ts`
      *(new)* — `ImageThumbnailService` + pure `deriveThumbnailKey()` /
      `isThumbnailableImageMimeType()` + `THUMBNAIL_*` constants; storage barrel
      `index.ts` export.
    - `packages/applications/.../consultation/context/context.service.ts` —
      thumbnail-aware `resolveMediaUrls` + `resolveThumbnailUrl`.
    - `packages/applications/.../consultation/context/dto/context-item.response.ts`
      — `thumbnailUrl` Swagger description updated (real derivative + fallback).
    - `apps/api/.../storage/storage.controller.ts` — generate + store the
      derivative on image upload (best-effort); `storage.module.ts` — provide
      `ImageThumbnailService`.
    - `packages/applications/package.json` — `sharp` dependency.
  - **Verification (real output):**
    - TDD RED→GREEN. `image-thumbnail.service.test.ts` (real `sharp` round-trip:
      800×600 PNG → **320×240 WebP**, no-upscale 100×80 → 100×80, throws on
      non-image) **7 passed**; context-service media-URL block (+derivative-exists,
      +no-derivative fallback) **6 passed**; `context.dto.mapper` +
      `context.service` + `image-thumbnail` together **225 passed (3 files)**.
    - `storage.controller.task375-thumbnails.test.ts` (generate+store at derived
      key · non-image skip · best-effort failure) + TASK-318 controller suite →
      **25 passed (3 files)**.
    - Builds: `pnpm --filter @arcaai/applications build` exit 0; `pnpm build:api`
      → **Tasks: 8 successful, 8 total**. `ReadLints` over all changed files →
      **No linter errors found.**
  - **Follow-up:** backfill thumbnails for images uploaded before this change
    (list image `Media`, generate + store `<key>.thumb.webp`); they fall back to
    the full-size URL until then. The paginated `getContextItemsPaginated`
    variant still does not enrich media URLs (pre-existing gap, see above).
- 2026-06-27 — **DEFECT-F1 FIXED — boolean-column filter coercion in the shared
  `PaginatedQuery` deserializer (backend).** A filter such as
  `GET /admin/users?filters=isServiceAccount[equals]:true` returned **HTTP 400**
  because the `field[op]:value` CSV contract is stringly-typed: the deserializer
  passed `"true"` (a string) into the Prisma `where`, and Prisma rejects a string
  for a `Bool` column. (Found during the TASK-374 live admin E2E — DEFECT-F1.)
  - **Approach — targeted, opt-in coercion (no column-type registry exists):**
    `deserializeFilterString(filtersString, booleanFields?)` gained an optional
    **allow-list** of field names whose values are coerced string → boolean;
    `withFormattedPaginatedProps` / `withFormattedCountProps` thread it through.
    Only the **exact** tokens `'true'`/`'false'` are coerced, and only for
    declared fields — every other value (and every call without the list) stays
    a byte-for-byte string, so existing string filters (audit-log, tenant, media,
    …) are unaffected. The Users service declares
    `USER_BOOLEAN_FILTER_FIELDS = ['isServiceAccount']` and passes it on `fetchAll`
    / `fetchAllByTenantId` / `fetchAllCreatedByUser`. Chosen over blindly coercing
    every `'true'`/`'false'`, which would corrupt genuine string filters.
  - **✅ GENERIC GAP — RESOLVED** (see the **§8 model-aware coercion** entry dated
    2026-06-27 below). The boolean-only, per-column opt-in was generalised to a
    model-aware scheme: a resource passes its model NAME and every
    boolean/number/date column of that model coerces automatically. The original
    flag read: *“this covers booleans only, and only for fields a resource names;
    numeric/date columns are still not coerced, and each resource must opt in
    per-column. The proper fix is a metadata-driven, model-aware filter-type map.”*
  - **No migration / no destructive ops:** code-only; no schema change, and **no**
    DELETE/DROP/TRUNCATE/reset (or any destructive DB op) was executed.
  - **Files changed:**
    - `packages/applications/src/common/paginatedQueryParamConverters.ts` — opt-in
      `booleanFields` + `coerceBooleanFilterValue`; threaded through
      `withFormatted{Paginated,Count}Props`.
    - `packages/applications/src/services/user/user/user.service.ts` —
      `USER_BOOLEAN_FILTER_FIELDS` declared + passed on the three list/count paths.
    - test: `…/common/paginatedQueryParamConverters.test.ts`,
      `…/services/user/user/__tests__/user.service.test.ts`.
    - regression: `apps/api/tests/e2e/task-375-admin-features.spec.ts` (new F1 case).
  - **Verification (real output):** TDD RED→GREEN — converter + user-service
    **51 passed (2 files)** (RED without coercion → **4 fail** showing `"true"`/
    `"false"` vs `true`/`false`); Turbo build **16/16** (applications + admin + api);
    `ReadLints` clean; live Playwright *“F1: boolean column filter
    `isServiceAccount[equals]:true|false` returns 200 and narrows”* ✅ (true + false
    counts **partition** the full set), full spec **9 passed / 1 skipped** vs `:8868`.
- 2026-06-27 — **§8 GENERIC model-aware filter coercion (resolves the DEFECT-F1
  flagged gap).** Generalised the boolean-only, per-column opt-in into a
  model-aware scheme so `field[op]:value` CSV filter values are coerced to each
  column's real scalar type — boolean (`'true'`/`'false'` → bool), number
  (numeric strings → number), date/datetime (ISO strings → Date) — for ANY
  resource, with no per-column opt-in. String/enum/JSON columns and unknown
  fields stay strings.
  - **Metadata source — generated Prisma TYPES, not DMMF.** Prisma 7's
    `prisma-client` generator does **not** expose a runtime DMMF (verified:
    `Prisma.dmmf === undefined`), so the column types are read from the generated
    model types at **compile time**. A new `modelFilterTypes.ts` declares a
    type-driven registry: `MODEL_FILTER_FIELD_TYPES[modelName] → { column: type }`,
    where each model's map is checked with
    `satisfies ModelFilterFieldTypes<PrismaModelType>`. That mapped type is
    *derived* from the generated model (`User`, `AuditLog`) — it forces every
    boolean/number/date column to be listed with the correct type, and rejects
    String/enum/JSON columns and typos. A schema change to a covered model
    therefore **fails the `@arcaai/applications` build** until the registry is
    updated (the drift guard the old hand-list lacked). The model types are a
    **type-only** import from `@arcaai/database` (erased at runtime; ESLint's
    `no-restricted-imports` only guards the unscoped-client symbol, not types).
  - **How coercion works + back-compat:** `deserializeFilterString(filters,
    fieldTypes?)` and `withFormatted{Paginated,Count}Props(props, fieldTypes?)`
    now accept a **model name** (string, resolved against the registry), the
    **legacy boolean allow-list** (`readonly string[]`, DEFECT-F1 — still works),
    or an explicit `{ column: type }` map. Coercion is conservative — only
    recognizable tokens convert; anything malformed (or an unknown model / unknown
    field / no argument) returns the **byte-identical string**, so existing
    string filters (tenant, media, role, …) are unaffected and never blindly
    coerced. Operator semantics are unchanged: the value is coerced by column
    type for every op (`equals`/`in`/`gt`/`lt`/…) and recursively inside
    `AND`/`OR` groups, exactly as the prior builder assigned `[op] = value`.
  - **Models / resources covered now:** **User** (admin Users grid — the
    `USER_BOOLEAN_FILTER_FIELDS = ['isServiceAccount']` opt-in was replaced by
    the model name `'User'`, so `isServiceAccount` still coerces **and**
    `version`/`createdAt`/`lastLoginAt`/… now do) and **AuditLog** (admin
    audit-log grid — `success`/`version`/`createdAt`/… now coerce). Any other
    list resource adopts by passing its model name (one argument) once added to
    the registry — no per-column work.
  - **No migration / no destructive ops:** code-only; no schema change, and **no**
    DELETE/DROP/TRUNCATE/reset (or any destructive DB op) was executed.
  - **Files changed:**
    - `packages/applications/src/common/modelFilterTypes.ts` *(new)* — type-driven
      registry (`FilterFieldType`, `ModelFilterFieldTypes<T>`,
      `USER_FILTER_FIELD_TYPES`, `AUDIT_LOG_FILTER_FIELD_TYPES`,
      `MODEL_FILTER_FIELD_TYPES`, `resolveFilterFieldTypes`).
    - `packages/applications/src/common/paginatedQueryParamConverters.ts` —
      generalised `deserializeFilterString` + `withFormatted{Paginated,Count}Props`
      to a `FilterFieldTypeSource`; replaced boolean-only `coerceBooleanFilterValue`
      with type-aware `coerceFilterValue` (boolean/number/date, conservative).
    - `packages/applications/src/common/index.ts` — barrel-export `modelFilterTypes`.
    - `packages/applications/src/services/user/user/user.service.ts` —
      `USER_BOOLEAN_FILTER_FIELDS` → `USER_FILTER_MODEL = 'User'` on all three
      list/count paths.
    - `packages/applications/src/services/auditLog/auditLog.service.ts` —
      `AUDIT_LOG_FILTER_MODEL = 'AuditLog'` passed on all four list/count paths.
    - test: `…/common/paginatedQueryParamConverters.test.ts` (+13 model-aware
      cases: boolean incl. `isServiceAccount`, numeric, date, String/enum
      passthrough, unknown field, unknown model, malformed-token passthrough,
      AuditLog, AND-group, legacy array, explicit map, no-arg back-compat,
      `withFormatted{Paginated,Count}Props` model-name).
  - **Verification (real output):** TDD RED→GREEN — converter file **24 passed**
    (RED first: **7 failed | 17 passed** — strings uncoerced + object-map crash).
    Changed-layer suites (converter ×2 + user.service + auditLog) **224 passed
    (9 files)**. Full `@arcaai/applications` suite **5395 passed | 4 skipped (241
    files)**. `pnpm --filter @arcaai/applications build` tsc **exit 0** (validates
    the `satisfies` type guards against the generated Prisma types); `pnpm
    build:api` **Tasks: 8 successful, 8 total**. ESLint on changed files **0
    errors**; `ReadLints` clean.
  - **Follow-ups:** (1) ~~**enum / JSON columns** are intentionally left as
    strings~~ **✅ RESOLVED** — enum/JSON columns are now first-class recognized
    types (see the **§8 enum / JSON recognition + cursor-path coercion** entry
    dated 2026-06-27 below). (2) Other list resources (tenant, media, role,
    permission, tag, webhook, notification, …) coerce only their common
    date/number columns once their model name is added to the registry + passed —
    trivial, deferred to stay surgical. (3) ~~The audit-log **cursor (keyset)**
    path … was not wired here~~ **✅ RESOLVED** — the cursor path now threads CSV
    `filters` through the same `'AuditLog'` map (same 2026-06-27 entry below).
- 2026-06-27 — **§8 enum / JSON column recognition + cursor-path filter coercion
  (resolves §8 follow-ups (1) and (3)).** Two surgical, back-compatible
  follow-ups to the model-aware coercion above.
  - **Enum columns — now first-class & drift-guarded.** `FilterFieldType` gained
    `'enum'`; the type-driven `CoercibleFilterType<V>` mapped type now classifies
    a Prisma enum (a string-LITERAL union — assignable to `string`, but `string`
    is NOT assignable back to it) as `'enum'`. The `satisfies
    ModelFilterFieldTypes<T>` completeness guard therefore now FORCES every enum
    column to be listed: `User.resourceStatus`; `AuditLog.resourceType` / `action`
    / `resourceStatus`. **Runtime behavior is a conservative pass-through**
    (`coerceFilterValue` returns the original string): Prisma accepts an enum's
    string value directly, and an invalid member is NOT mangled — it passes
    through and Prisma validates/rejects it server-side exactly as before. (No
    runtime member allow-list is kept here, to stay decoupled from the generated
    enum objects; member validation is deferred to Prisma. **Flagged deferral.**)
  - **JSON columns — explicitly recognized, safe pass-through.** `FilterFieldType`
    gained `'json'`; `CoercibleFilterType<V>` classifies a Prisma `Json` column
    (`JsonValue` = a union that CONTAINS `string` but is not assignable to
    `string`) as `'json'`, so the guard forces every JSON column to be listed:
    `User.metaData`; `AuditLog.metaData` / `data` / `previousData` / `metadata`.
    Their value is left a **string** (no coercion) because JSON filtering needs
    Prisma path operators (`path`, `string_contains`, …) the flat
    `field[op]:value` CSV grammar cannot express — so a JSON filter is never
    silently mis-coerced. **Structured JSON-path filtering is a deferred
    follow-up (FLAGGED).**
  - **Why this is safe / byte-identical at runtime:** before, enum/JSON columns
    fell through to the "unknown" bucket and `coerceFilterValue(value, undefined)`
    returned the string; now they hit explicit `case 'enum'`/`case 'json'` arms
    that also return the string. The ONLY change is that they are now
    *recognized* (drift-guarded + self-documented), not silently bucketed — a
    schema change adding an enum/JSON column to a covered model fails the
    `@arcaai/applications` build until acknowledged.
  - **Cursor-path coercion parity (TASK-373).** `CursorQuery` gained an optional
    `filters?: string` field (symmetric with `PaginatedQuery.filters`), and
    `AuditLogService.fetchPageByCursor` now threads it through
    `deserializeFilterString(props.filters, 'AuditLog')`, passing the coerced map
    as the `filters` prop — SEPARATE from the keyset/tenant `where` — so
    `Repository.findAll`'s `formatFindAllProps` AND-composes it with the keyset
    predicate, **exactly** as the offset path threads
    `withFormattedPaginatedProps`. The cursor list now coerces
    boolean/number/date/enum identically to the offset list. (See
    [TASK-373 README §6](../TASK-373-Cursor-Pagination-DTO/README.md#6-change-history).)
  - **No migration / no destructive ops:** code-only; no schema change, and **no**
    DELETE/DROP/TRUNCATE/reset (or any destructive DB op) was executed.
  - **Files changed:**
    - `packages/applications/src/common/modelFilterTypes.ts` — `'enum'`/`'json'`
      added to `FilterFieldType`; enum/JSON detection in `CoercibleFilterType<V>`;
      enum/JSON columns added to `USER_FILTER_FIELD_TYPES` /
      `AUDIT_LOG_FILTER_FIELD_TYPES`.
    - `packages/applications/src/common/paginatedQueryParamConverters.ts` —
      `coerceFilterValue` `case 'enum'`/`case 'json'` (documented pass-through).
    - `packages/applications/src/common/dto/cursor.query.ts` — `filters?: string`.
    - `packages/applications/src/services/auditLog/auditLog.service.ts` —
      `fetchPageByCursor` deserializes CSV `filters` against `'AuditLog'`.
    - tests: `…/common/paginatedQueryParamConverters.test.ts` (+6 enum/JSON
      cases incl. registry recognition + pass-through),
      `…/services/auditLog/__tests__/auditLog.service.cursor.test.ts` (+4
      cursor-coercion parity/back-compat cases).
  - **Verification (real output):** TDD RED→GREEN — changed-layer suites (the two
    converter files + cursor engine + audit-log cursor service) **72 passed (4
    files)** (RED first: **6 failed** — registry values `undefined` + cursor
    `filters` prop `undefined`). `pnpm --filter @arcaai/applications build` tsc
    **exit 0** (the `satisfies` guards validate the enum/JSON detection AND
    completeness against the generated Prisma types). Full `@arcaai/applications`
    suite **5406 passed | 4 skipped (241 files)**; `pnpm build:api` **Tasks: 8
    successful, 8 total**. `ReadLints` over all changed files → **No linter
    errors found.**
