# 01 — HTTP request to the controller

> Part of the [tenant-allowed-origin walkthrough](../03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md).
> **Previous:** [Overview](../03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md) · **Next:** [02 — Service rules](./02-service-rules.md)

## 4. Part 1 — HTTP request to controller

### 4.1 URL math

Two pieces are combined:

- `apps/api/src/global-prefix.config.ts:13` sets `API_GLOBAL_PREFIX = 'api/v1'`.
- `apps/api/src/main.ts:156–158` calls `app.setGlobalPrefix(...)`.
- The controller says `@Controller('admin/allowed-origins')` at line 68.

So the six routes are:

```
/api/v1/admin/allowed-origins
```

`/metrics` is excluded from the prefix; no route in this feature is excluded.

**NestJS concept — `@Controller(path)`:** a class decorator that registers the class
as the handler for a URL prefix. Nest scans it at boot and builds a routing table.
The file `tenant-allowed-origin.module.ts:5–9` is what puts the controller into the
application:

```ts
@Module({
  imports: [TenantAllowedOriginServiceModule],
  controllers: [TenantAllowedOriginController],
})
export class TenantAllowedOriginModule {}
```

`apps/api/src/app.module.ts:88` imports that module and line 497 adds it to the root
module's `imports`.

### 4.2 The six routes

Route order in the file matters. `GET posture` is declared **before** `GET :id`
(lines 76–80). Nest matches routes in declaration order, so reversing them would make
`/posture` match `:id` with `id === 'posture'`.

| Method | Path (after the prefix) | Handler | Line | What it does |
|---|---|---|---|---|
| GET | `/posture` | `getPosture` | 80–85 | Returns one platform-wide boolean. Does not touch the service or the DB. |
| GET | `/` | `getAll` | 87–92 | Lists rows for the caller's tenant. |
| GET | `/:id` | `getById` | 94–101 | One row; cross-tenant ids answer 404. |
| POST | `/` | `create` | 103–118 | Registers an origin after normalization + gates. |
| PATCH | `/:id` | `update` | 120–158 | Compare-and-set update; requires `If-Match`. |
| DELETE | `/:id` | `deleteById` | 160–167 | Soft-delete. |

### 4.3 The class-level decorators are the front door

Lines 64–69:

```ts
@ApiBearerAuth()
@ApiTags('admin-allowed-origins')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:allowed-origin:manage')
@Controller('admin/allowed-origins')
@CanManage('TenantAllowedOrigin')
```

A decorator is just a function that attaches metadata to a class or method. Something
else reads that metadata later. That "something else" is the key idea.

| Decorator | Who reads it | What it actually does | NestJS or project? |
|---|---|---|---|
| `@ApiBearerAuth()` | Swagger generator | Draws the padlock in the docs. **No runtime effect.** | NestJS (`@nestjs/swagger`) |
| `@ApiTags(...)` | Swagger generator | Groups endpoints in the docs. | NestJS |
| `@ForbidApiKey()` | `UnifiedAuthGuard` (`unified-auth.guard.ts:764`) | Rejects any request authenticated with an API key, however broadly scoped. | Project |
| `@RequiredSvcScopes('svc:admin:allowed-origin:manage')` | `UnifiedAuthGuard` (`unified-auth.guard.ts:629`) | A service account must hold this scope. | Project |
| `@Controller(...)` | Nest router | Registers the URL prefix. | NestJS |
| `@CanManage('TenantAllowedOrigin')` | `UnifiedAuthGuard` (`unified-auth.guard.ts:909–950`) | Requires the CASL ability `manage:TenantAllowedOrigin`. | Project |

`@CanManage(subject)` is literally one line — `decorators.ts:330`:

```ts
export const CanManage = (subject: string) => Authorize(['manage', subject]);
```

`Authorize(...)` stores the required permissions under the metadata key
`REQUIRED_PERMISSIONS_KEY` (`decorators.ts:78`). Nest's `Reflector` reads metadata
from both the method and the class; the guard asks for the method first and falls
back to the class (`unified-auth.guard.ts:656`). That is why one class-level
decorator covers all six routes.

CASL is the authorization library. An **ability** is a small object with a
`.can(action, subject)` method. The guard builds it from the caller's roles
(`policyEngine.buildAbility({ userId, tenantId, params })`, line 867) and asks:

```ts
ability.can('manage', 'TenantAllowedOrigin')
```

If the answer is no, the request is rejected before the handler runs. The seeded
role `tenant-full-access` grants this ability scoped to the caller's own tenant;
`SUPER_ADMIN` reaches it through `manage:all`.

> **Careful:** `@CanManage` decides *whether you may reach the methods*. It cannot
> see the *value* being written. The rule "only a super admin may create a wildcard
> origin" therefore cannot live in this decorator. It lives in the service, in
> [§6.2](./02-service-rules.md#62-the-four-gates).

### 4.4 The guard pipeline

This route passes through the global guard chain described in
[02-main-ts/08-visual-request-pipeline.md](../02-main-ts/08-visual-request-pipeline.md).
Only three stages matter here:

```
request
  │
  ├─ 1. ThrottlerGuard / helmet / CORS            (before Nest routing)
  │
  ├─ 2. UnifiedAuthGuard
  │      ├─ API key present?        → @ForbidApiKey ⇒ 403
  │      ├─ service account token?  → @RequiredSvcScopes ⇒ scope check
  │      │                            + CASL ability from svc:* scopes
  │      └─ JWT user?               → CASL ability from roles
  │                                   ⇒ manage:TenantAllowedOrigin
  │
  ├─ 3. RequiresIfMatchGuard
  │      └─ PATCH only: sets req._requiresIfMatch = true
  │
  ├─ 4. ValidationPipe
  │      └─ body → DTO class; unknown fields ⇒ 400
  │
  ▼
TenantAllowedOriginController
```

The order is not incidental. Authentication must happen before authorization, and
body validation must happen before the DTO reaches the service.

**NestJS concept — guard:** a class with `canActivate(context)` that returns `true`
(continue) or throws/returns `false` (stop). Guards run after middleware and before
pipes/interceptors/handlers.

**NestJS concept — pipe:** a class that transforms or validates an argument. The
global `ValidationPipe` in `main.ts:206` turns the raw JSON body into an instance of
`CreateTenantAllowedOriginRequest` and enforces its `class-validator` decorators.

### 4.5 Where `tenantId` comes from: CLS

Every request runs inside a **CLS** (continuation-local storage) context. Think of it
as a per-request box that any function can read without passing arguments through
every call. `nestjs-cls` implements it.

At authentication time the guard writes:

```ts
this.cls.set('user', user);
this.cls.set('tenantId', user.tenantId);
```

The service later reads `this.tenantId` from that box (see [§6.1](./02-service-rules.md#61-baseservice-gives-you-the-request-context)).
The request DTOs **do not contain a `tenantId` field**, and the global pipe runs
`forbidNonWhitelisted`, so a caller cannot inject one. That is the tenant-isolation
boundary.

> If you have seen `?tenantId=` in other APIs: it is deliberately absent here.
> Tenant identity is ambient, never a parameter.

### 4.6 NestJS defaults vs project code in this part

| Concern | NestJS default | Project addition |
|---|---|---|
| Routing | `@Controller`, `@Get`, `@Post`… | URL prefix `admin/allowed-origins` |
| DI | `@Module`, `providers`, `exports` | `TenantAllowedOriginServiceModule` |
| Validation | `ValidationPipe` class | `createGlobalValidationPipe()` config in `main.ts` |
| Auth | none | `UnifiedAuthGuard`, `@CanManage`, `@ForbidApiKey`, `@RequiredSvcScopes` |
| Request context | none | `nestjs-cls` + identity publication in the guard |
| Docs | `@nestjs/swagger` | `@ApiBearerAuth`, `@ApiTags`, `@ApiResponse` |

---

## 5. Part 2 — The controller

The controller is intentionally thin: parse, delegate, return. If you are tempted to
add a business rule here, the file's own comments explain why it belongs one layer
down (lines 43–57).

### 5.1 Constructor and the DI token

```ts
constructor(
  @Inject(ITenantAllowedOriginService)
  private readonly tenantAllowedOriginService: ITenantAllowedOriginService,
) {}
```

**NestJS concept — dependency injection (DI):** instead of `new Service()`, a class
declares what it needs in its constructor and Nest supplies it. Nest builds one
instance per provider by default (a singleton).

The odd part is `@Inject(ITenantAllowedOriginService)`. That name is not a class; it
is a `Symbol` (`ITenantAllowedOriginService.ts:44`). JavaScript interfaces disappear
at runtime, so a symbol is used as a lookup key. The module registers that key here
(`tenant-allowed-origin.service.module.ts:11–19`):

```ts
providers: [
  TenantAllowedOriginService,
  {
    provide: ITenantAllowedOriginService,
    useExisting: TenantAllowedOriginService,
  },
],
```

`useExisting` means "when someone asks for the symbol, give them the instance that
already exists under the class token". `useClass` would construct a **second**
instance. The comment in the file calls out exactly that trap.

Why use an interface token at all? It lets the controller depend on the contract,
not the implementation. Tests can provide a mock under the same symbol — see
`tenant-allowed-origin.admin-route-audit.test.ts:22`.

### 5.2 `getPosture` — the route that is different

```ts
@Get('posture')
getPosture(): AllowedOriginEnforcementPostureResponse {
  return { enforcementEnabled: isOriginEnforcementEnabled() };
}
```

It does not inject or call the service. It reports one platform-wide switch,
`origin.enforcementEnabled`, read through `isOriginEnforcementEnabled()` in
`cors.config.ts:198`. It is deliberately not per-tenant and not per-row.

It still carries the class-level `@CanManage` — the ability gate applies — but it has
no row-level tenancy because it returns no row.

### 5.3 List and read

```ts
@Get()
async getAll(): Promise<TenantAllowedOriginResponse[]> {
  return this.tenantAllowedOriginService.getAll();
}

@Get(':id')
async getById(@Param('id') id: string): Promise<TenantAllowedOriginResponse> {
  return this.tenantAllowedOriginService.getById(id);
}
```

**NestJS concept — `@Param('id')`:** extracts the `:id` segment from the URL. The
type annotation `string` is TypeScript only; runtime validation is the service's job
(it checks the row exists and belongs to the tenant).

Both methods are pure delegation. Notice there is no `tenantId` argument: the service
reads it from CLS.

### 5.4 Create

```ts
@Post()
async create(@Body() request: CreateTenantAllowedOriginRequest) {
  return this.tenantAllowedOriginService.create(request);
}
```

`@Body()` gives the validated DTO. The DTO (`dto/create-tenant-allowed-origin.request.ts`)
only enforces type and length:

| Field | Rule | Why |
|---|---|---|
| `origin` | string, non-empty, ≤ 2048 | grammar is checked later by the normalizer |
| `label` | string, non-empty, ≤ 200 | human-readable admin label |
| `description` | optional string, ≤ 1000 | operator note |

No `tenantId`, no `version`, no `resourceStatus`. The global pipe rejects unknown
fields with 400.

### 5.5 Update and optimistic concurrency (OCC)

This is the most interesting handler.

```ts
@Patch(':id')
@RequiresIfMatch()
async update(
  @Param('id') id: string,
  @Body() request: UpdateTenantAllowedOriginRequest,
  @ExpectedVersion() expectedFromHeader: number | undefined,
) {
  const effectiveRequest =
    expectedFromHeader !== undefined ? { ...request, expectedVersion: expectedFromHeader } : request;
  return this.tenantAllowedOriginService.update(id, effectiveRequest);
}
```

OCC is a way to stop two admins from silently overwriting each other. Every row has a
`version` number. The client reads the row, sees `version: 3`, and sends
`If-Match: "3"`. The database update includes `where: { id, version: 3 }`. If someone
else already bumped it to 4, the update matches zero rows and the service returns
**412 Precondition Failed**.

The pieces:

| Piece | File | What it does |
|---|---|---|
| `@RequiresIfMatch()` | `requiresIfMatch.decorator.ts` | Attaches metadata `requiresIfMatch: true`. |
| `RequiresIfMatchGuard` | `requiresIfMatch.guard.ts:30–41` | Runs globally; if the metadata is present, sets `req._requiresIfMatch = true`. Returns `true` unconditionally — it never throws. |
| `@ExpectedVersion()` | `expectedVersion.decorator.ts:105` | A parameter decorator that parses `If-Match` and injects a number. |
| `extractExpectedVersion` | same file, lines 53–86 | Missing header on an annotated route → **428**. Bad format → **400**. Valid → integer. |

Status table:

| `If-Match` | Route has `@RequiresIfMatch` | Result |
|---|---|---|
| `"7"` | either | `7` |
| `"0"` | either | `0` (first-edit/create-intent convention) |
| missing | yes | **428 Precondition Required** |
| missing | no | `undefined` (body `expectedVersion` is used) |
| `7` (no quotes) | either | **400** |
| `W/"7"` (weak) | either | **400** |
| `*` | either | **400** |
| `"-1"` / `"abc"` | either | **400** |

The handler then applies **header precedence**: if the header is present, it
overwrites the body's `expectedVersion` (line 156). This is deliberate house
precedence. On an annotated route the header is guaranteed at runtime; the fallback
exists for direct unit-test calls.

> **Beginner trap:** the header only carries the number. Whether the number is
> *current* is decided in the service/database, not in the decorator. The decorator
> answers "did you send a syntactically valid precondition?"; the CAS answers "is it
> still true?".

### 5.6 Delete

```ts
@Delete(':id')
async deleteById(@Param('id') id: string) {
  return this.tenantAllowedOriginService.deleteById(id);
}
```

"Delete" here is a **soft delete**: the row stays, `resourceStatus` becomes
`DELETED`, and `_version` is bumped. That is why a later create can *restore* the
same row instead of inserting a duplicate (see [§6.6](./02-service-rules.md#66-delete--re-add-restores-the-row)).

### 5.7 Response shape

Every handler returns `TenantAllowedOriginResponse`, built by
`TenantAllowedOriginDtoMapper.toResponse` (`tenant-allowed-origin.dto.mapper.ts:4–22`):

| Field | Source |
|---|---|
| `id`, `tenantId`, `origin`, `label`, `description` | entity |
| `isPlatform` | **derived**: `tenantId === SYSTEM_TENANT_ID` |
| `resourceStatus` | entity |
| `createdAt`, `updatedAt` | entity, converted with `.toISOString()` |
| `version` | entity `_version` (the client echoes it as `If-Match`) |

`isPlatform` is not stored. It is computed for display so an admin UI can label
platform-owned rows.

### 5.8 NestJS defaults vs project code in this part

| Concern | NestJS default | Project code |
|---|---|---|
| Handler binding | `@Get`, `@Post`, `@Body`, `@Param` | route paths and DTOs |
| DI | constructor injection | `Symbol` token + `useExisting` alias |
| OCC | nothing | `@RequiresIfMatch`, `@ExpectedVersion`, `If-Match` precedence |
| Error types | `BadRequestException`, `NotFoundException`, … | `ArgumentInvalidException`, `OptimisticConcurrencyException`, `DataNotFoundException` |
| Response mapping | plain object serialization | explicit DTO mapper |

---

