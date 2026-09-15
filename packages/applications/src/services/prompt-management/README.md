# Prompt Management Service — `PromptTemplate` + `PromptVersion`

Application-layer service for `PromptTemplate` and its versioning chain (`PromptVersion`) — a
separate, application-domain concept from the database-owned `_version` OCC token (see below).
Public surface is split across two controllers in `apps/api/src/modules/prompt-management/`:

- `prompt-template.controller.ts` (`@Controller('prompt-templates')`) — `PATCH /api/v1/prompt-templates/:id`
  edits template metadata / latest draft.
- `prompt-management.controller.ts` (`@Controller('admin/prompt-templates')`) — version history,
  diff, approval and `POST /api/v1/admin/prompt-templates/:id/versions/:versionNumber/activate`
  (promotes a historical version to `currentVersionNumber`).

> **Two "version" concepts.** `PromptTemplate.currentVersionNumber` is a _domain_ notion: which
> historical `PromptVersion` row is currently published. The database-owned `_version` exposed on
> the response as `version: number` is the OCC token. The two are independent and update on
> different events.

## Layout

| Path | What it holds |
|---|---|
| `prompt-management.service.ts` | Service implementation — CRUD, versioning, approval, testing |
| `IPromptManagementService.ts` | Interface + `Symbol` token |
| `prompt-management.dto.mapper.ts` | Entity to Response DTO mapping |
| `dto/` | 16 request/response DTOs: create/update/approve templates, version diff, prompt testing, usage analytics, department assignment |
| `__tests__/` | Vitest unit tests |

## How it works

### Concurrency model

Writes go through `updateWithVersion(id, entity, expectedVersion)` on the repository, issuing a
Postgres CAS (`prisma.promptTemplate.updateMany({ where: { id, version: expectedVersion }, ... })`).

- **`PATCH .../prompt-templates/:id`**: clients send `If-Match: "<n>"` (RFC 7232); missing
  `If-Match` is 428, a drifted version is 412 with `{ currentVersion }`.
- **`activateVersion` (server-driven OCC)**: the controller fetches the current template, reads its
  `_version`, and feeds it to the service's update path. Callers do NOT pass `expectedVersion` for
  this endpoint — the read-modify-write happens server-side.
- **Service-to-service / Bull jobs**: pass `expectedVersion` in the request body and wrap in
  `pRetry({ retries: 3, factor: 2 })` with a re-fetch between attempts. Never auto-retry a
  human-initiated write.

### SYSTEM-vs-tenant-owned approval split

`POST admin/prompt-templates/:id/approve` gates differently depending on which row is targeted: a
SYSTEM/library template (`tenantId` = the reserved SYSTEM tenant) stays SUPER_ADMIN-only, while a
tenant-owned template devolves to any caller holding `manage:PromptTemplate` for that tenant. See
[`05-nestjs-api.md`](../../../../../.claude/rules/05-nestjs-api.md)'s imperative-privilege-checks table (`assertCanApprove`) for the
full rule and why a single `@Authorize` decorator cannot express it.

## Gotchas

- Do not confuse `PromptTemplate.currentVersionNumber` (which `PromptVersion` is published) with
  the response's `version` field (the OCC token) — they change independently.
- `PromptTemplate` and `PromptVersion` are CONTENT: cloned into a tenant from the SYSTEM reference
  set at tenant creation, never read cross-tenant at runtime. See
  [`00-project-context.md`](../../../../../.claude/rules/00-project-context.md) "Content is cloned; configuration cascades".

## Related

- [`@arcaai/applications` README](../../../README.md) — `BaseService`, sys-event fan-out
- [`05-nestjs-api.md`](../../../../../.claude/rules/05-nestjs-api.md) — OCC pattern, the SYSTEM-vs-tenant-owned split-gate table
- [`00-project-context.md`](../../../../../.claude/rules/00-project-context.md) — content-is-cloned rule for `PromptTemplate`/`PromptVersion`
