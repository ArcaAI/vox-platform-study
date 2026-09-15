# eslint-plugin-arcaai-internal — repo-internal custom lint rules

Repo-internal ESLint plugin hosting HOPE's custom lint rules. `@arcaai/config-eslint` registers it
as a plain flat-config plugin object under the `arcaai-internal` namespace (`flat/core.js`), so
rule IDs are `arcaai-internal/<rule>`. The rules encode HOPE's layering guarantees: controllers and
modules in `apps/api` must go through services/repositories and the typed config service rather
than reaching into Prisma or `process.env` directly, and internal service calls must carry a tenant
channel.

## Layout

| Path | What it holds |
|---|---|
| `index.js` | Plugin entry — registers the four rules below under the `arcaai-internal` namespace |
| `rules/no-controller-direct-prisma.js` | Bans direct Prisma access in controller files |
| `rules/no-direct-downstream-url-env.js` | Bans `process.env` reads of downstream service URL keys |
| `rules/require-internal-tenant-header.js` | Requires a tenant channel on internal service-to-service calls |
| `rules/require-api-key-justification.js` | Requires a reason comment on business-plane `@ForbidApiKey()` |
| `__tests__/` | One RuleTester test file per rule, run as plain Node scripts |

## Commands

```bash
node packages/eslint-plugin-arcaai-internal/__tests__/no-controller-direct-prisma.test.js
node packages/eslint-plugin-arcaai-internal/__tests__/no-direct-downstream-url-env.test.js
node packages/eslint-plugin-arcaai-internal/__tests__/require-internal-tenant-header.test.js
node packages/eslint-plugin-arcaai-internal/__tests__/require-api-key-justification.test.js
```

Each rule has RuleTester pins covering violations, benign chains, and the escape hatches. The test
files are plain Node scripts (no test-runner integration; the root Vitest config only picks up
`*.test.ts`); `RuleTester.run` throws on failure.

## How it works

### `arcaai-internal/no-controller-direct-prisma`

Forbids the `<receiver>.databaseService.client` member chain (e.g.
`this.databaseService.client.user.findMany(...)`, or aliasing
`const prisma = this.databaseService.client`) inside controller files.

Controllers must route data access through a service or repository — direct Prisma access in
controllers bypasses the service layer where tenant scoping, soft delete, and events are enforced.
The rule fires only when the chain ends at `.client`, so a single violation produces one
diagnostic; service- and repository-layer Prisma access is unaffected because the rule is scoped to
controller files.

Escape hatch — a TSDoc comment within 3 lines above the offending line (or on the enclosing
statement/method):

```typescript
/** @allowedDirectPrisma TASK-XXX: one-sentence justification */
const row = await this.databaseService.client.foo.findFirst(...);
```

The allow-list is intended to stay empty; every use is a deliberate, reviewable exception.

### `arcaai-internal/no-direct-downstream-url-env`

Forbids reading the downstream Python service URL keys from `process.env`, in both dot and bracket
form. Banned keys (tight denylist): `TEXT_URL`, `TEXT_SERVICE_URL`, `STT_URL`, `STT_V2_URL`
(dual-read window), `NLP_URL`, `GUARDRAIL_URL`, `HARNESS_URL`. All other env reads (`NODE_ENV`,
`npm_package_version`, ...) stay legal.

Downstream URLs must be resolved through the typed `IConfigService.getConfigValue(...)` accessor so
env loading and validation happen once at bootstrap instead of ad hoc per request.

```typescript
const url = process.env.TEXT_URL || 'http://localhost:8862'; // ERROR
const url = process.env['STT_URL']; // ERROR
const url = process.env['STT_V2_URL']; // ERROR (dual-read window)
const url = this.configService.getConfigValue('TEXT_URL'); // OK
```

### `arcaai-internal/require-internal-tenant-header`

`X-Tenant-Id` is mandatory on every internal service-to-service request that carries tenant-scoped
work (owner directive, `.claude/rules/00-project-context.md` "Tenant identity is mandatory on
internal service calls"). An absent header is a defect in the CALLER — never something the callee
papers over with a default, because tenants may only tighten relative to SYSTEM, so resolving
SYSTEM on a dropped header silently downgrades a tenant that chose a stricter posture, with nothing
raised or logged anywhere. A propagation audit found nine `apps/api` -> `apps/text` call sites that
never even attempted to send it, several with a `tenantId` local in scope one line above the HTTP
call; code review caught none of them. This rule is the backstop.

What it flags: an outbound HTTP request-options object whose `headers` carry `X-Service-Token`
(making this an internal service hop, not a third-party call) but no tenant channel:

```typescript
await http.post(url, body, {
  headers: { 'Content-Type': 'application/json', 'X-Service-Token': token }, // ERROR
});
```

How to satisfy it:

- `headers: internalServiceHeaders({ serviceToken, tenantId, tenantlessReason })` — the sanctioned
  builder (`@arcaai/applications` `common/internal-service-headers`). Preferred: its
  `tenantlessReason` argument is REQUIRED, so there is no code path that omits the header.
- An explicit `'X-Tenant-Id'` / `[TENANT_ID_HEADER]` key, or a `tenantHeaderValue(...)` call, for
  sites that must merge into an existing map.
- `'X-Internal-Tenant-Id'` — the deliberate STT-to-gateway channel, which exists because a literal
  `X-Tenant-Id` from the single-credential STT worker would trip `ContextInterceptor`'s divergence
  400.

Genuinely tenant-less work declares itself with `tenantless:<reason>` rather than omitting the
header — that is what keeps "absent" unambiguously a bug.

### `arcaai-internal/require-api-key-justification`

Requires an `// API-KEY-NOTE` carrying a written reason on every business-plane `@ForbidApiKey()`
(class- or method-level) in a controller file.

A non-`admin` route is JWT + API key by default, so `@ForbidApiKey()` on the business plane is a
REASONED EXEMPTION rather than a default. Boot audits already pin the mechanical halves — one pins
that every route declares *something*, another pins that the exemption is NAMED — but a *reason* is
a comment, and `tsc` strips comments long before any Nest metadata exists, so no `Reflector` can
ever read one. That is why this half is lint and not a boot audit.

Only the business plane is judged. `admin/*` is JWT-only by blanket policy (roughly 70 controllers,
one structural reason, already enforced elsewhere), and `internal/*` is off the API-key surface
entirely — demanding 70 copies of one sentence would teach pasting, not thinking. A `@Controller(...)`
whose path argument is not a string literal fails closed: an unprovable plane is not an exempt one.

```typescript
@Controller('voice-profile')
@ForbidApiKey()                      // ERROR — missingApiKeyNote
export class VoiceProfileController {}

@Controller('voice-profile')
// API-KEY-NOTE
@ForbidApiKey()                      // ERROR — emptyApiKeyNote (a marker is not a reason)
export class VoiceProfileController {}

@Controller('voice-profile')
// API-KEY-NOTE — enrolment audio IS a biometric identifier, and a tenant API
// key has no MFA, no session expiry and no revocation-on-logout. JWT only.
@ForbidApiKey()                      // OK
export class VoiceProfileController {}

@Controller('admin/tenants')
@ForbidApiKey()                      // OK — blanket admin policy, not a per-controller judgement
export class TenantController {}
```

`// AUTH-NOTE` does NOT satisfy this rule. The two markers stay distinct: `API-KEY-NOTE` classifies
the API-key posture of a surface, `AUTH-NOTE` is the `.claude/rules/05-nestjs-api.md` marker for
"the permission decorator understates the real gate". Accepting either would let an explanation of
a CASL gate stand in as an explanation of an API-key decision.

### How it is wired

`@arcaai/config-eslint` depends on this package (`workspace:*`) and its `flat/core.js` enables the
rules via scoped config entries:

- `no-controller-direct-prisma`: error for `**/modules/**/*.controller.ts` — in practice only `apps/api` matches this path shape.
- `no-direct-downstream-url-env`: error for `**/modules/**/*.ts`.
- `require-internal-tenant-header`: error for `**/src/**/*.ts` (tests excluded).
- `require-api-key-justification`: error for `**/modules/**/*.controller.ts` (tests excluded).

In `packages/*` these surface as warnings (`flat/library.js` loads `eslint-plugin-only-warn`); in
`apps/api` (`flat/nestjs.js`) they are hard errors. `apps/api` also declares the plugin directly in
its devDependencies.

### Adding a rule
1. Create the rule in `rules/<rule-name>.js` (CommonJS, standard ESLint rule shape with `meta` + `create`).
2. Register it in the `rules` map of `index.js`.
3. Add RuleTester coverage in `__tests__/<rule-name>.test.js`.
4. Enable it in `packages/config-eslint/flat/core.js` (typically via a scoped `files:` config entry) and document it here and in the config-eslint README.

## Related

- [`../config-eslint/README.md`](../config-eslint/README.md) — the shared-config picture these rules plug into
- [`00-project-context.md`](../../.claude/rules/00-project-context.md) — the mandatory `X-Tenant-Id` directive `require-internal-tenant-header` enforces
- [`05-nestjs-api.md`](../../.claude/rules/05-nestjs-api.md) — the `AUTH-NOTE` marker distinct from `API-KEY-NOTE`
