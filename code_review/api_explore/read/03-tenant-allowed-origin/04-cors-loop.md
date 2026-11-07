# 04 — Why it exists: the CORS loop

> Part of the [tenant-allowed-origin walkthrough](../03-TENANT-ALLOWED-ORIGIN-WALKTHROUGH.md).
> **Previous:** [03 — Data layer](./03-data-layer.md) · **Next:** [05 — Tests and trace](./05-tests-and-trace.md)

## 8. Part 5 — Why it exists: the CORS loop

The admin CRUD is only half the feature. The rows are consumed by the CORS gate on
every browser request.

### 8.1 `main.ts` enables CORS

`apps/api/src/main.ts:291`:

```ts
app.enableCors(buildCorsOptions(nodeEnv));
```

`buildCorsOptions` lives in `cors.config.ts:407`. Its `origin` callback delegates to
`isOriginAllowed(origin, nodeEnv)`.

### 8.2 `isOriginAllowed` decides

`cors.config.ts:307–331`:

```ts
if (!isOriginEnforcementEnabled()) return true;   // switch off
if (!origin) return true;                          // no Origin header (curl, server-to-server)
const registered = queryRegistry(origin);
if (registered === true) return true;              // registered
if (registered === false) return false;            // definitely not registered
return false;                                      // null = registry unavailable → fail closed
```

Three things to notice:

1. **The switch is checked first.** With enforcement off, the registry is not even
   consulted. That is a deliberate operator escape hatch, not a default.
2. **Missing `Origin` is allowed.** Browsers always send it for cross-origin calls;
   non-browser clients do not, and CORS does not apply to them.
3. **Unavailable registry = deny.** There is no environment-variable fallback and no
   hardcoded hostname list. The file's header explains the vulnerability this
   replaced.

### 8.3 The registry

`OriginRegistryService` (`packages/applications/src/services/origin-registry/origin-registry.service.ts`)
keeps an in-memory reverse index:

```
Map<origin, Set<tenantId>>      exact origins
PatternEntry[]                   patterns (values containing '*')
```

- `tenantsFor(origin)` (line 123) returns the union of exact matches and matching
  patterns.
- `has(origin)` (line 151) is `tenantsFor(origin).size > 0`.
- `allows(origin, tenantId)` (line 158) is the **only** place the SYSTEM rule lives:

```ts
return tenants.has(tenantId) || tenants.has(SYSTEM_TENANT_ID);
```

That one line is why a SYSTEM grant is valid for every tenant. The CORS gate and the
`OriginTenantBindingGuard` both call `allows()`, so the rule cannot drift between them.

The resolver is installed lazily by `PlatformKnobsBinder`
(`apps/api/src/modules/platform-knobs/platform-knobs.binder.ts:105`):

```ts
setOriginRegistryResolver(() => (registry.size() > 0 ? registry : null));
```

A `null` resolver (no rows loaded yet, or no registry wired) makes CORS fail closed.

### 8.4 Invalidation event → refresh

The service emits `origin-registry.invalidate` after every successful mutation.
`OriginRegistryService` listens (`origin-registry.service.ts:285–300`) and calls
`onInvalidationEvent()`, which wraps `refresh()` in `cls.exit(...)`.

Why the wrapper? `@nestjs/event-emitter` dispatches listeners **synchronously on the
same call stack** as `.emit()`. A listener that called `refresh()` directly would run
inside the writing request's CLS. The tenant-scope extension would then inject the
caller's `tenantId` into `findAll({})`, and the registry would rebuild with only that
tenant's rows. Every other tenant's origins would silently vanish from CORS. `cls.exit`
detaches the store for the callback and everything it schedules.

`refresh()` (line 367) reads `repository.findAll({})` — no filter — and swaps in a
fresh index. On failure it keeps the previous index and logs staleness; an empty
registry would deny every browser origin platform-wide.

### 8.5 The backstop

There is a cron backstop every 30 seconds (`@Cron(CronExpression.EVERY_30_SECONDS)`,
line 231) plus the settings-cache refresh (nominally ~45s, actually once per minute at
`:45`). The event path makes changes immediate on the writing node; the timers cover
other nodes and missed events.

### 8.6 The full loop

```
admin PATCH
   │
   ▼
TenantAllowedOriginService.update()
   │
   ├─ writes the row (version 3 → 4)
   └─ emits 'origin-registry.invalidate'
             │
             ▼
OriginRegistryService.onInvalidationEvent()
   │  cls.exit(...)  ← detach request tenant
   ▼
refresh() → repository.findAll({})  ← every tenant's rows
   │
   ▼
swaps Map<origin, Set<tenantId>>
   │
   ▼
next browser request
   │  Origin: https://app.example.com
   ▼
cors.config.isOriginAllowed()
   │
   ▼
registry.tenantsFor(origin)        → Set of tenants
registry.allows(origin, tenantId)  → tenant OR SYSTEM
   │
   ├─ true  → Access-Control-Allow-Origin: <origin>
   └─ false → browser blocks the response
```

### 8.7 Why the feature is more than CRUD

| If you only read the controller | The whole feature |
|---|---|
| "It stores a string." | The string is normalized, gated by shape, unique per tenant, and OCC-protected. |
| "It returns a list." | The list is tenant-scoped by CLS + Prisma extension + an explicit filter. |
| "It deletes a row." | It soft-deletes, which changes how re-create works. |
| "It saves to the DB." | It also invalidates an in-memory index that the CORS gate reads on every request. |

---

