# eslint-plugin-arcaai-internal

Repo-internal ESLint plugin hosting ARCAAI's custom lint rules. `@arcaai/config-eslint` registers it as a plain flat-config plugin object under the `arcaai-internal` namespace (`flat/core.js`, TASK-418), so rule IDs are `arcaai-internal/<rule>`. The rules encode HOPE's layering guarantees: controllers and modules in `apps/api` must go through services/repositories and the typed config service rather than reaching into Prisma or `process.env` directly.

Last updated: 2026-07-05

## Rules

### arcaai-internal/no-controller-direct-prisma

Forbids the `<receiver>.databaseService.client` member chain (e.g. `this.databaseService.client.user.findMany(...)`, or aliasing `const prisma = this.databaseService.client`) inside controller files.

Why: controllers must route data access through a service or repository (TASK-307 W6.4, audit findings C-10 / F-1 / H-9). Direct Prisma access in controllers bypasses the service layer where tenant scoping, soft delete, and events are enforced. The rule fires only when the chain ends at `.client`, so a single violation produces one diagnostic; service- and repository-layer Prisma access is unaffected because the rule is scoped to controller files.

Escape hatch — a TSDoc comment within 3 lines above the offending line (or on the enclosing statement/method):

```typescript
/** @allowedDirectPrisma TASK-XXX: one-sentence justification */
const row = await this.databaseService.client.foo.findFirst(...);
```

The allow-list is intended to stay empty; every use is a deliberate, reviewable exception.

### arcaai-internal/no-direct-downstream-url-env

Forbids reading the downstream Python service URL keys from `process.env`, in both dot and bracket form. Banned keys (tight denylist): `SMR_URL`, `SMR_SERVICE_URL`, `STT_V2_URL`, `NLP_URL`, `GUARDRAIL_URL`, `HARNESS_URL`. All other env reads (`NODE_ENV`, `npm_package_version`, ...) stay legal.

Why: downstream URLs must be resolved through the typed `IConfigService.getConfigValue(...)` accessor so env loading and validation happen once at bootstrap instead of ad hoc per request (TASK-310 E-5 / AC-5).

```typescript
const url = process.env.SMR_URL || 'http://localhost:8862';        // ERROR
const url = process.env['STT_V2_URL'];                             // ERROR
const url = this.configService.getConfigValue('SMR_URL');          // OK
```

## How It Is Wired (verified)

`@arcaai/config-eslint` depends on this package (`workspace:*`) and its `flat/core.js` enables the rules via scoped config entries:

- `arcaai-internal/no-controller-direct-prisma`: `error` for `**/modules/**/*.controller.ts` — in practice only `apps/api` matches this path shape.
- `arcaai-internal/no-direct-downstream-url-env`: `error` for `**/modules/**/*.ts`.

In `packages/*` these surface as warnings (`flat/library.js` loads `eslint-plugin-only-warn`); in `apps/api` (`flat/nestjs.js`) they are hard errors.

`apps/api` also declares the plugin directly in its devDependencies. See [../config-eslint/README.md](../config-eslint/README.md) for the full shared-config picture.

## Tests

Each rule has RuleTester pins in [`__tests__/`](./__tests__/) covering violations, benign chains, and the escape hatches. The test files are plain Node scripts (no test-runner integration; the root Vitest config only picks up `*.test.ts`); `RuleTester.run` throws on failure:

```bash
node packages/eslint-plugin-arcaai-internal/__tests__/no-controller-direct-prisma.test.js
node packages/eslint-plugin-arcaai-internal/__tests__/no-direct-downstream-url-env.test.js
```

## Adding a Rule

1. Create the rule in `rules/<rule-name>.js` (CommonJS, standard ESLint rule shape with `meta` + `create`).
2. Register it in the `rules` map of [index.js](./index.js).
3. Add RuleTester coverage in `__tests__/<rule-name>.test.js`.
4. Enable it in `packages/config-eslint/flat/core.js` (typically via a scoped `files:` config entry) and document it here and in the config-eslint README.
