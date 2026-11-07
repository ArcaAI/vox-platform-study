# 03 — Tenant-allowed-origin: one request, end to end

**Goal:** follow one small feature through every layer of the stack, so the abstract
pieces from `02` become concrete.

**Audience:** you know basic JavaScript (objects, arrays, `async`/`await`, classes) and
have never used NestJS. Every framework concept is explained the first time it appears.

**Prerequisite:** [02 — Boot and request pipeline](./02-API-BOOT-AND-REQUEST-PIPELINE.md).
If words like *module*, *provider*, *guard*, or *decorator* are new, read
[02-main-ts/01-nestjs-in-10-minutes.md](./02-main-ts/01-nestjs-in-10-minutes.md) first.

**Source verified at:** `project-hope` branch `dev-2.2`, HEAD `8cb2e5e8e`.
Everything here is observation; no repository file is modified.

---

## How to read this walkthrough

This is one walkthrough split into five small chapters. Read this page first, then
follow the links in order.

| Pass | Read | Question it answers |
|---|---|---|
| 1 | this page | What is the feature, where does the code live, and what is the shape of a request? |
| 2 | [01 — HTTP request to the controller](./03-tenant-allowed-origin/01-http-to-controller.md) | How does the request get past guards and validation, and what does the controller do? |
| 3 | [02 — Service rules](./03-tenant-allowed-origin/02-service-rules.md) | Where do authorization, normalization, duplicates, OCC, and audit live? |
| 4 | [03 — Data layer](./03-tenant-allowed-origin/03-data-layer.md) | How is a row loaded, saved, versioned, and isolated by tenant? |
| 5 | [04 — CORS loop](./03-tenant-allowed-origin/04-cors-loop.md) | Why does this table exist, and how does a change reach the CORS gate? |
| 6 | [05 — Tests, trace, exercises](./03-tenant-allowed-origin/05-tests-and-trace.md) | What is pinned by tests, and can I trace one PATCH myself? |

---

## Chapters

| # | Chapter | File | Covers |
|---|---|---|---|
| — | **Overview** | this page | Feature, file map, mental model |
| 4–5 | HTTP request → controller | [01-http-to-controller.md](./03-tenant-allowed-origin/01-http-to-controller.md) | URL math, six routes, class decorators, guard pipeline, CLS, controller methods, `If-Match` / OCC header |
| 6 | Service rules | [02-service-rules.md](./03-tenant-allowed-origin/02-service-rules.md) | `BaseService`, four gates, `create`/`update`/`delete`, restore-on-create, audit + invalidation events, error map |
| 7 | Data layer | [03-data-layer.md](./03-tenant-allowed-origin/03-data-layer.md) | Repository, entity/factory/mapper, Prisma model, tenant-scope extension, compare-and-set |
| 8 | CORS loop | [04-cors-loop.md](./03-tenant-allowed-origin/04-cors-loop.md) | `main.ts`, `isOriginAllowed`, `OriginRegistryService`, invalidation + backstop |
| 9–11 | Tests, trace, exercises | [05-tests-and-trace.md](./03-tenant-allowed-origin/05-tests-and-trace.md) | Test map, 20-step PATCH trace, glossary, exercises |

---

## 1. What the feature does

The browser will not let JavaScript on `https://app.example.com` call
`https://api.example.com` unless the API explicitly allows that origin. That
permission mechanism is **CORS** (Cross-Origin Resource Sharing).

HOPE stores its allow-list in the database instead of in an environment variable.
Each row is a **grant**: *this tenant may call the API from this origin.*

The feature in this walkthrough is the admin API that manages those rows:

- list the caller's origins,
- read one,
- create,
- update (with optimistic concurrency),
- soft-delete,
- and report whether enforcement is switched on platform-wide.

It is the smallest feature that touches every layer, which is why it is the first
vertical slice.

Two words appear constantly:

| Term | Meaning here |
|---|---|
| **origin** | `scheme://host[:port]`, e.g. `https://arcaai-staging.bcmch.org`. Not a URL with a path. |
| **tenant** | A customer/organisation. Every row belongs to one tenant. The reserved **SYSTEM** tenant owns platform-wide origins. |

The reserved SYSTEM id is `00000000-0000-0000-0000-000000000000`. A SYSTEM grant is
valid for **every** tenant. That is not a database rule; it is applied by
`OriginRegistryService.allows()` described in
[Chapter 04 — the CORS loop](./03-tenant-allowed-origin/04-cors-loop.md).

---

## 2. The files that matter

The feature is spread across four packages. Read the table top to bottom: that is
also the direction the request flows.

| # | File | Layer | NestJS or project? | Key lines |
|---|---|---|---|---|
| 1 | `apps/api/src/modules/tenant-allowed-origin/tenant-allowed-origin.module.ts` | API wiring | NestJS structure, project contents | 1–9 |
| 2 | `apps/api/src/modules/tenant-allowed-origin/tenant-allowed-origin.controller.ts` | HTTP adapter | NestJS class + decorators | 64–168 |
| 3 | `packages/applications/src/services/tenant-allowed-origin/tenant-allowed-origin.service.module.ts` | DI wiring | NestJS structure | 7–23 |
| 4 | `packages/applications/src/services/tenant-allowed-origin/tenant-allowed-origin.service.ts` | Business rules | Project | 42–500 |
| 5 | `packages/domains/src/repositories/generated/core/TenantAllowedOriginRepository.ts` | Data access | Project | 30–61 |
| 6 | `packages/database/src/prisma/db_main/tenant-allowed-origin.prisma` | Schema | Project (Prisma DSL) | 32–85 |

Supporting files, in the order you will meet them:

| File | Why it matters |
|---|---|
| `packages/applications/src/services/tenant-allowed-origin/ITenantAllowedOriginService.ts` | The interface and the privilege-boundary contract (lines 44–85). |
| `packages/applications/src/services/tenant-allowed-origin/dto/` | Request and response shapes + `class-validator` rules. |
| `packages/applications/src/services/tenant-allowed-origin/tenant-allowed-origin.dto.mapper.ts` | Entity → response DTO. |
| `packages/applications/src/common/base.service.ts` | `tenantId`, `requestUser`, audit events, `updateEntity`, OCC helper. |
| `packages/applications/src/authorization/decorators.ts` | `@CanManage`, `@ForbidApiKey`, `@RequiredSvcScopes`. |
| `packages/applications/src/authorization/unified-auth.guard.ts` | Turns those decorators into an actual allow/deny decision. |
| `apps/api/src/decorators/requiresIfMatch.*` + `expectedVersion.decorator.ts` | `If-Match` / ETag handling. |
| `apps/api/src/cors.config.ts` | The consumer of the rows: the CORS gate. |
| `packages/applications/src/services/origin-registry/origin-registry.service.ts` | In-memory index of the rows, used by CORS. |

Nothing in this list is generated documentation — the comments in these files are
unusually detailed and are worth reading directly.

---

## 3. The 60-second mental model

```
Browser / admin UI
        │  PATCH /api/v1/admin/allowed-origins/<id>   If-Match: "3"
        ▼
apps/api  ── global prefix, validation pipe, guards ──► TenantAllowedOriginController
                                                          │  thin: parse, delegate
                                                          ▼
packages/applications  ── TenantAllowedOriginService ─────┤  rules: normalize, authorize,
                                                          │  duplicate check, OCC, audit
                                                          ▼
packages/domains  ── TenantAllowedOriginRepository ───────┤  load/save, map entity ↔ row
                                                          ▼
packages/database  ── Prisma model + tenant-scope ext. ───┘  SQL, _version, soft delete
                                                          │
                                                          ├─ emits ResourceUpdated (audit/webhooks)
                                                          └─ emits origin-registry.invalidate
                                                                     │
                                                                     ▼
                                                          OriginRegistryService refreshes
                                                          Map<origin, Set<tenantId>>
                                                                     │
                                                                     ▼
                                                          cors.config.ts admits/denies
                                                          the next browser request
```

The important shape: **the controller never contains the rules, and the CORS gate
never reads the database on the hot path.** The rules live in the service; the gate
reads an in-memory index that is refreshed when a row changes.

---

**Start reading:** [01 — HTTP request to the controller](./03-tenant-allowed-origin/01-http-to-controller.md).

Back to the index: [README.md](./README.md).
