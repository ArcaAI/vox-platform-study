# GlobalSetting Service — the `GlobalSetting` table CRUD + secret handling

Application-layer service for the `GlobalSetting` model: platform-tier rows (`tenantId` = the
reserved SYSTEM tenant, `00000000-0000-0000-0000-000000000000`) and per-tenant override rows.
Platform-tier writes AND reads are SUPER_ADMIN-only (`assertPlatformTierWrite` /
`assertPlatformTierRead`); a tenant's own rows stay ability-gated (`manage:GlobalSetting`). This is
the CRUD + secret-reveal/rotate service underneath the descriptor-driven settings registry — see
`settings-registry/` for the tenant-first resolution cascade and `TenantService.updateTenantConfigs`
for the bulk per-tenant write path.

The HTTP surface is `apps/api/src/modules/global-setting/global-setting.controller.ts`
(`@Controller('admin/settings')`): `POST /`, `GET /`, `GET /tenant/:tenantId`, `GET /:id`,
`PATCH /:id`, `DELETE /:id`, `POST /:id/reveal`, `POST /:id/rotate`.

## Layout

| Path | What it holds |
|---|---|
| `globalSetting.service.ts` | `GlobalSettingService extends BaseService` — CRUD, `assertPlatformTierWrite`/`assertPlatformTierRead`, secret reveal/rotate |
| `IGlobalSettingService.ts` | Interface + `Symbol` token: `create`, `fetchAll`, `fetchAllByTenantId`, `fetchAllCreatedByUser`, `fetchById`, `update`, `deleteById`, `revealSecret`, `rotateSecret` |
| `globalSetting.dto.mapper.ts` | Entity to Response DTO mapping |
| `dto/` | `createGlobalSetting.request.ts`, `updateGlobalSetting.request.ts`, `listGlobalSetting.query.ts`, `revealGlobalSetting.request/response.ts`, `rotateGlobalSetting.request.ts`, `globalSetting.response.ts`, `paginatedGlobalSetting.response.ts` |
| `__tests__/` | Vitest unit tests |

## How it works

### Platform-tier split

`assertPlatformTierWrite(targetTenantId)` and `assertPlatformTierRead(targetTenantId)` both throw
unless the caller is a super admin OR the target row's `tenantId` is not the SYSTEM tenant. This is
the one place in the codebase where the 404-over-403 cross-tenant posture does NOT apply: the
platform tier has no per-tenant existence to hide, so a non-super-admin caller gets 403, not 404.
See [`05-nestjs-api.md`](../../../../../.claude/rules/05-nestjs-api.md)'s platform-tier settings row for the exact routes this governs.

### Concurrency model

Writes go through `updateWithVersion(id, entity, expectedVersion)` on the repository, issuing a
Postgres CAS (`prisma.globalSetting.updateMany({ where: { id, version: expectedVersion }, ... })`).
Clients send `If-Match: "<n>"` on PATCH (RFC 7232); missing `If-Match` is 428, a drifted version is
412 with `{ currentVersion }`. Service-to-service callers pass `expectedVersion` in
`UpdateGlobalSettingRequest` instead and should re-fetch and retry with backoff — never
auto-retry a human-initiated write.

### Secrets

`revealSecret(id, password)` and `rotateSecret(id, request)` are separate, audited operations from
plain `update` — a secret-typed `GlobalSetting` value is never returned by the normal read path.

## Gotchas

- `apps/api/src/modules/pstudio/` is an UNRELATED Prisma Studio admin-database proxy — it does not
  read or write `GlobalSetting` rows. Do not confuse it with this service's admin surface.
- Every successful CAS broadcasts `SysEvent.ResourceUpdated` with `previousVersion`/`newVersion` in
  the payload — that is the audit trail for a settings change, not a separate history table.

## Related

- [`@arcaai/applications` README](../../../README.md) — `BaseService`, sys-event fan-out
- [`05-nestjs-api.md`](../../../../../.claude/rules/05-nestjs-api.md) — platform-tier read/write gate
- [`09-infrastructure-devops.md`](../../../../../.claude/rules/09-infrastructure-devops.md) — Configuration Tiers, tenant-first resolution
- [Tenant service README](../tenant/README.md) — `updateTenantConfigs` bulk per-tenant write path
