# TASK-239: Tenant-Scoped Blob Storage

| Field | Value |
|-------|-------|
| **Ticket** | TASK-239 |
| **Created** | 2026-03-08 |
| **Updated** | 2026-03-08 |
| **Status** | In Progress |
| **Type** | Feature |

---

## 1. Requirement Analysis

### Description

Implement tenant-scoped blob storage management to replace the current shared-bucket architecture. Each tenant gets isolated storage buckets with system defaults provisioned on creation, plus the ability to create custom buckets.

### Business Context

- **Security**: Shared buckets expose data across tenants — a critical isolation gap
- **Compliance**: Healthcare data requires strict tenant boundaries (HIPAA/GDPR)
- **Scalability**: Per-tenant buckets enable independent storage policies and quotas

### Acceptance Criteria

1. System buckets (`audio_recordings`, `uploaded_recordings`) are auto-provisioned when a new tenant is created
2. Tenant admins can create additional custom buckets for their business needs
3. Tenant admins can only manage their own tenant's buckets
4. Global/super admins can view all buckets and tenant data
5. Storage access keys provide scoped, per-tenant credentials
6. `Media` records track which `TenantBucket` they belong to via `bucketId`
7. Files are organized by `{yyyy}/{MM}/{dd}/{user_name}` path pattern within buckets

---

## 2. Current State Evaluation

### Issues Identified

1. **Shared S3 credentials**: Single global `S3_ACCESS_KEY`/`S3_SECRET_KEY` for all tenants
2. **No bucket ownership**: Buckets are global, not tenant-scoped
3. **No tenant isolation**: Any tenant can access any bucket via the StorageController
4. **No automatic provisioning**: No storage setup when creating a new tenant
5. **Media lacks bucket reference**: `Media.uri` stores the full path but no bucket association

---

## 3. Implementation Plan

### Database Layer

- New `TenantBucket` model with `tenantId`, `name`, `slug`, `bucketType` (SYSTEM/CUSTOM), `pathPattern`
- New `StorageAccessKey` model with `tenantId`, `accessKeyId`, `secretAccessKey`, `permissions`, `bucketIds`
- New `TenantBucketType` enum (SYSTEM, CUSTOM)
- Added `bucketId` field to `Media` model with FK to `TenantBucket`

### Domain Layer (DDD)

- `TenantBucketEntity` with `isSystemBucket` computed property
- `StorageAccessKeyEntity` with `isExpired`, `hasPermission()`, `hasBucketAccess()` methods
- `TenantBucketFactory` with `CreateSystemBucket()`, `CreateCustomBucket()`, `CreateDefaultSystemBuckets()`
- `StorageAccessKeyFactory` with `CreateKey()` generating cryptographic credentials
- Corresponding mappers, models, and repositories for both entities

### Application Layer

- `TenantBucketService`: `listBuckets()`, `getBucketById()`, `getBucketBySlug()`, `createCustomBucket()`, `deleteBucket()`, `provisionSystemBuckets()`
- `StorageAccessKeyService`: `listKeys()`, `generateKey()`, `revokeKey()`, `validateKey()`
- `TenantService.create()` hooked to auto-provision system buckets on tenant creation

### API Layer

- `TenantBucketController` at `admin/tenants/storage/buckets` with RBAC decorators
- `StorageAccessKeyController` at `admin/tenants/storage/keys` with RBAC decorators

### Security Design

- Bucket naming: `{tenant_key}-{bucket_slug}` (e.g., `arcaai-audio-recordings`)
- File paths: `{yyyy}/{MM}/{dd}/{user_name}/{filename}`
- Per-tenant access keys with scoped permissions (`read`, `write`, `delete`, `list`)
- Keys can be scoped to specific buckets or all tenant buckets
- System buckets cannot be deleted (enforced at service layer)

---

## 4. Implementation Summary

### Files Created

| File | Purpose |
|------|---------|
| `packages/database/src/prisma/db_main/tenant-bucket.prisma` | Prisma schema for TenantBucket and StorageAccessKey models |
| `packages/domains/src/enums/generated/TenantBucketType.ts` | TypeScript enum for bucket types |
| `packages/domains/src/entities/generated/core/TenantBucketEntity.ts` | Domain entity with `isSystemBucket` |
| `packages/domains/src/entities/generated/core/StorageAccessKeyEntity.ts` | Domain entity with `isExpired`, `hasPermission()`, `hasBucketAccess()` |
| `packages/domains/src/factories/generated/core/TenantBucketFactory.ts` | Factory with `CreateSystemBucket`, `CreateCustomBucket`, `CreateDefaultSystemBuckets` |
| `packages/domains/src/factories/generated/core/StorageAccessKeyFactory.ts` | Factory with `CreateKey` (generates crypto credentials) |
| `packages/domains/src/models/generated/core/TenantBucketModel.ts` | Data model for TenantBucket |
| `packages/domains/src/models/generated/core/StorageAccessKeyModel.ts` | Data model for StorageAccessKey |
| `packages/domains/src/mappers/generated/core/TenantBucketEntityMapper.ts` | Entity-to-model mapper |
| `packages/domains/src/mappers/generated/core/StorageAccessKeyEntityMapper.ts` | Entity-to-model mapper |
| `packages/domains/src/repositories/generated/core/TenantBucketRepository.ts` | Repository with `findBySlug`, `findSystemBuckets`, `findCustomBuckets` |
| `packages/domains/src/repositories/generated/core/StorageAccessKeyRepository.ts` | Repository with `findByAccessKeyId`, `findActiveByTenant` |
| `packages/applications/src/services/tenant-bucket/` | Full service module (service, DTOs, mapper, interface, module) |
| `packages/applications/src/services/storage-access-key/` | Full service module (service, DTOs, mapper, interface, module) |
| `apps/api/src/modules/tenant-bucket/` | API controller + module |
| `apps/api/src/modules/storage-access-key/` | API controller + module |

### Files Modified

| File | Change |
|------|--------|
| `packages/database/src/prisma/db_main/enums.prisma` | Added `TenantBucketType` enum |
| `packages/database/src/prisma/db_main/media.prisma` | Added `bucketId` field + FK to TenantBucket |
| `packages/domains/src/enums/generated/index.ts` | Export `TenantBucketType` |
| `packages/domains/src/enums/generated/ResourceType.ts` | Added `TenantBucket`, `StorageAccessKey` |
| `packages/domains/src/entities/generated/core/MediaEntity.ts` | Added `bucketId` property |
| `packages/domains/src/models/generated/core/MediaModel.ts` | Added `bucketId` field |
| `packages/domains/src/common/databaseServices/core/core.database.module.ts` | Registered new repositories |
| All barrel `index.ts` files in entities/factories/mappers/models/repositories | Added new exports |
| `packages/applications/src/services/tenant/tenant.service.ts` | Hooked `provisionSystemBuckets()` into `create()` |
| `packages/applications/src/services/tenant/tenant.service.module.ts` | Imported `TenantBucketServiceModule` |
| `packages/applications/src/services/index.ts` | Added new service exports |
| `apps/api/src/app.module.ts` | Registered `TenantBucketModule`, `StorageAccessKeyModule` |

### Test Files

| File | Tests |
|------|-------|
| `packages/domains/src/__tests__/tenant-bucket.test.ts` | 8 tests (entity, factory, model) |
| `packages/domains/src/__tests__/storage-access-key.test.ts` | 7 tests (entity, factory) |
| `packages/applications/src/services/tenant-bucket/__tests__/tenant-bucket.service.test.ts` | 14 tests (CRUD, provisioning, validation) |
| `packages/applications/src/services/storage-access-key/__tests__/storage-access-key.service.test.ts` | 10 tests (CRUD, validation, expiry) |
| `apps/api/src/modules/tenant-bucket/__tests__/tenant-bucket.controller.test.ts` | 5 tests (controller endpoints) |

**Total: 44 tests, all passing**

### API Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/admin/tenants/storage/buckets` | List tenant buckets | CanRead('Storage') |
| GET | `/admin/tenants/storage/buckets/:id` | Get bucket by ID | CanRead('Storage') |
| POST | `/admin/tenants/storage/buckets` | Create custom bucket | CanCreate('Storage') |
| DELETE | `/admin/tenants/storage/buckets/:id` | Delete custom bucket | CanDelete('Storage') |
| POST | `/admin/tenants/storage/buckets/provision/:tenantId` | Provision system buckets | CanManage('Tenant') |
| GET | `/admin/tenants/storage/keys` | List access keys | CanRead('Storage') |
| POST | `/admin/tenants/storage/keys` | Generate new key | CanCreate('Storage') |
| DELETE | `/admin/tenants/storage/keys/:id` | Revoke key | CanDelete('Storage') |

---

## 5. Remaining Work

- [ ] Run Prisma migration (`pnpm db:migrate`) to create DB tables
- [ ] Add `Storage` to CASL permission subjects for RBAC
- [ ] Implement MinIO policy enforcement per-tenant (bucket-level IAM)
- [ ] Update existing `StorageController` file upload to set `bucketId` on `Media` records
- [ ] Add presigned URL generation scoped to tenant buckets
- [ ] Update STT Python service to use tenant-scoped bucket names
- [ ] E2E tests for full tenant lifecycle (create tenant -> buckets provisioned -> upload file -> verify isolation)

---

## 6. Change History

| Date | Description | Files |
|------|-------------|-------|
| 2026-03-08 | Initial implementation: database schema, domain layer, application services, API controllers | See Implementation Summary |
