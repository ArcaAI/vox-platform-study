# 05 — Tests, a full trace, and exercises

> Part of the [tenant-allowed-origin walkthrough](../03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md).
> **Previous:** [04 — CORS loop](./04-cors-loop.md) · **Next:** [Overview](../03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md)

## 9. Part 6 — Tests

Tests are the executable version of the contract. The names alone tell you what the
authors considered important.

| Test file | What it pins |
|---|---|
| `apps/api/src/modules/tenant-allowed-origin/__tests__/tenant-allowed-origin.controller.test.ts` | The controller has **no** role gate of its own; every handler delegates; header wins over body; 404 propagates; posture is platform-wide |
| `.../tenant-allowed-origin.admin-route-audit.test.ts` | The boot-time deny-by-default audit passes for all six routes via the class-level `@CanManage` alone |
| `packages/applications/src/services/tenant-allowed-origin/__tests__/tenant-allowed-origin.service.task610.test.ts` | Normalization, duplicate/race handling, restore, many-to-many, OCC, audit events, allow-all warning |
| `.../tenant-allowed-origin.privilege.task641.test.ts` | Wildcard and SYSTEM gates (403), cross-tenant 404, label-only edits allowed, encoded-wildcard defense |
| `.../tenant-allowed-origin.dto.mapper.task610.test.ts` | Response shape, `isPlatform` derivation |
| `.../seed-origin-canonicalization.task610.test.ts` | Seed rows are canonical |

Two assertions worth reading in full:

1. **Controller test, lines 5–14 and 51–58** — the test constructs the controller with
   no CLS/user at all. If the controller still read roles, it could not be built this
   way. This is how the test proves the gate moved down a layer.
2. **Admin audit test, lines 8–40** — the audit walks every `/admin/*` route at boot
   and refuses to start if a route lacks a concrete permission decorator. The test
   runs the real controller and expects no throw, proving the class-level decorator
   covers all six.

The service test names are effectively a checklist. A few examples:

- `create -> delete -> create again with the same origin succeeds and yields a usable row`
- `does NOT restore a soft-deleted row owned by ANOTHER tenant`
- `keeps 404-over-403 for a CROSS-TENANT id even when the payload is a wildcard`
- `refuses a SUPER_ADMIN too — an encoded wildcard is malformed input, not a privileged write`
- `propagates OptimisticConcurrencyException on version drift and does NOT emit the invalidation event`

---

## 10. Trace one PATCH from start to finish

Concrete request:

```http
PATCH /api/v1/admin/allowed-origins/0192f0c4-... HTTP/1.1
Authorization: Bearer <jwt>
If-Match: "3"
Content-Type: application/json

{ "label": "BCMCH production" }
```

| # | Where | What happens |
|---|---|---|
| 1 | `main.ts:156–158` | `api/v1` prefix is applied. |
| 2 | `main.ts:291` | CORS middleware evaluates the `Origin` header; no `Origin` here, so it passes. |
| 3 | `UnifiedAuthGuard` | JWT validated; `user` and `tenantId` written to CLS. |
| 4 | `UnifiedAuthGuard` | `@ForbidApiKey` irrelevant (no API key); `@RequiredSvcScopes` irrelevant (human); `@CanManage` → builds ability → `manage:TenantAllowedOrigin` allowed. |
| 5 | `RequiresIfMatchGuard` | Sees `@RequiresIfMatch()` metadata, sets `req._requiresIfMatch = true`. |
| 6 | `ValidationPipe` | Body becomes `UpdateTenantAllowedOriginRequest`. `label` is valid. Unknown fields would 400. |
| 7 | `@ExpectedVersion()` | Parses `"3"` → `3`. Missing would be 428; malformed would be 400. |
| 8 | Controller line 155–157 | Header `3` overwrites body `expectedVersion`. |
| 9 | `TenantAllowedOriginService.update` line 324 | Reads `tenantId` from CLS. |
| 10 | line 330 | SYSTEM gate: only refuses if the resolved tenant is SYSTEM and the caller is not super admin. |
| 11 | line 332 | `findOwnedOrThrow(id, tenantId)`: missing → 404; another tenant's row → 404. |
| 12 | lines 334–359 | `origin` is absent, so no re-normalization and no duplicate check. |
| 13 | line 361 | `updateEntity` stages `label`; `hasChanges` becomes true. |
| 14 | line 370 | `assertExpectedVersion(entity, 3)`: entity's version is 3, so it passes. |
| 15 | line 380 | `updateWithVersion(id, entity, 3)` → `UPDATE ... WHERE id = ? AND version = 3` → count 1, version becomes 4. |
| 16 | line 397 | `ResourceUpdated` emitted with `previousVersion: 3`, `newVersion: 4`, and the changed fields. |
| 17 | line 406 | `origin-registry.invalidate` emitted. |
| 18 | line 408 | Mapper returns the row with `version: 4`. |
| 19 | `OriginRegistryService` | Listener runs outside CLS, reloads all rows, swaps the index. |
| 20 | Response | 200 with the updated DTO. The next PATCH must send `If-Match: "4"`. |

Now change one thing: send `If-Match: "2"` instead. Step 14 still passes the
in-memory check only if the entity version is 2; more importantly step 15's SQL
matches **zero** rows because the row is at 3, so the repository reads the current
version and throws `OptimisticConcurrencyException` → **412**. The invalidation event
is **not** emitted because the mutation failed.

---

## 11. Glossary and exercises

### Glossary

| Term | One-line meaning |
|---|---|
| **origin** | `scheme://host[:port]`; the unit CORS cares about |
| **CORS** | Browser rule that requires the server to opt in to cross-origin calls |
| **tenant** | A customer; every row is scoped to one |
| **SYSTEM tenant** | Reserved tenant whose grants apply to every tenant |
| **DTO** | Data Transfer Object — the validated shape of a request/response |
| **decorator** | A function that attaches metadata to a class/method/parameter |
| **guard** | Nest class that allows or denies a request before the handler |
| **pipe** | Nest class that transforms/validates an argument |
| **provider** | Anything Nest can inject (service, repository, factory) |
| **DI token** | The key used to look up a provider; can be a class or a `Symbol` |
| **CLS** | Per-request storage, read without passing arguments |
| **CASL** | Authorization library; an "ability" answers `.can(action, subject)` |
| **OCC** | Optimistic concurrency control; detect write conflicts with a version number |
| **ETag / `If-Match`** | HTTP mechanism for carrying that version |
| **soft delete** | Mark a row deleted instead of removing it |
| **normalization** | Convert input to one canonical stored form |
| **invalidation** | Tell a cache/index that its data is stale |

### Exercises

Answer by reading the cited file, not by guessing.

1. **Why does `getPosture` still carry `@CanManage` even though it never touches a
   tenant row?**
   *Look at `tenant-allowed-origin.controller.ts:64–69` and
   `unified-auth.guard.ts:656`.* The decorator is class-level, so it applies to every
   handler. The route has no row-level scoping, but it is not public.

2. **A `TENANT_ADMIN` PATCHes a row they own, changing only `label`. The row is
   already `*`. Is that allowed?**
   *Look at `tenant-allowed-origin.service.ts:348–359` and the privilege test
   "label-only edit on an existing pattern row".* Yes. No `origin` change means no
   trust change; the wildcard gate only runs when `origin` is present.

3. **Two tenants register the same exact origin. Does the second one get 409?**
   *Look at `tenant-allowed-origin.service.ts:184–194` and the Prisma `@@unique`.*
   No. The unique key is `(origin, tenantId)`. Only the same tenant re-registering the
   same origin conflicts.

4. **A client sends a PATCH without `If-Match` but with `expectedVersion: 3` in the
   body. What happens?**
   *Look at `requiresIfMatch.guard.ts` and `expectedVersion.decorator.ts:57–72`.*
   428. The route is annotated, so the missing header is fatal before the body is
   consulted. The body fallback only matters on non-annotated routes or direct
   service calls.

5. **Why can't the wildcard rule be a second decorator like
   `@RequireSuperAdminForWildcard()`?**
   *Look at `ITenantAllowedOriginService.ts:15–27` and the service comment at
   lines 54–66.* Decorators see `action + subject`; they do not see the **value**
   being written or the resolved CLS tenant. The rule depends on both, so it must run
   imperatively in the service.

6. **After a successful create, how quickly does CORS see the new origin on the same
   node? On another node?**
   *Look at `origin-registry.service.ts:231` and `:285`.* Same node: immediately, via
   the synchronous invalidation event. Other nodes: within the 30s cron backstop (or
   the settings-cache refresh).

### Where to go next

- The three application layers in depth: `04-APPLICATIONS-LAYER.md`,
  `05-DOMAINS-LAYER.md`, `06-DATABASE-LAYER.md` (planned — see the tracker).
- The full guard/CASL story: `07-AUTH-DEEP-DIVE.md` (planned).
- The largest feature: `08-CONSULTATION-WALKTHROUGH.md` (planned).
- Boot and pipeline refresher:
  [02 — Boot and request pipeline](../02-API-BOOT-AND-REQUEST-PIPELINE.md).
- The tracker and status of every document:
  [WALKTHROUGH-SEQUENCE.md](../WALKTHROUGH-SEQUENCE.md).

Back to the index: [README.md](../README.md).
