# @arcaai/vox-node-codegen — admin-surface generator

`packages/vox-node-codegen`, npm package `@arcaai/vox-node-codegen` (version 3.3.0). **Private**
(`"private": true`) — never published, never a runtime dependency of `@arcaai/vox-node`, and never
imported by application code. It is a `devDependency` of `@arcaai/vox-node` only, wired in
because a generator that reads the filesystem, parses OpenAPI and calls prettier does not belong
in a package that ships zero runtime dependencies. It generates
`packages/vox-node/src/resources/admin/**` — currently 49 areas, 425 machine-reachable routes.

Beside `@arcaai/vox-node`, not inside it, following `packages/vox-codegen`'s precedent for a
Node-only build-time CLI attached to a published SDK.

## Layout

| Path | What it holds |
|---|---|
| `src/cli.ts` | CLI entry (`vox-node-codegen`, `--check` for the drift gate) |
| `src/run.ts` | One-shot generation/comparison orchestration |
| `src/surface.ts` | Joins the route manifest and OpenAPI doc into areas/methods; `MACHINE_CLOSED_CONTROLLERS` |
| `src/naming.ts` | Every derived name (area, property, class, file, method, iterator) |
| `src/schema-to-ts.ts` | OpenAPI schema -> TypeScript renderer |
| `src/emit.ts` | Writes the generated files, applies prettier, deletes stale ones |
| `src/types.ts` | Shapes for the route manifest and OpenAPI document inputs |

## Commands

| Command | Effect |
|---|---|
| `pnpm --filter @arcaai/vox-node gen:admin` | Write the admin surface into `packages/vox-node/src/resources/admin/` |
| `pnpm --filter @arcaai/vox-node gen:admin:check` | Drift gate — regenerates and compares rather than hashing (CI: `generate-vox-node-admin-check`) |
| `pnpm --filter @arcaai/vox-node-codegen build` / `test` / `lint` / `typecheck` | Standard package scripts |

## How it works

### Why the surface is generated, not hand-written

`@arcaai/vox-node`'s hand-authored resources carry dense doc comments explaining wire contracts;
the admin plane is roughly twenty times larger. The house rule: derive, don't transcribe — every
path, verb, required scope, method name, parameter and payload type is derived from artifacts the
gateway itself produces.

### Two inputs, cross-checked

| Artifact | Produced by | Authoritative for |
|---|---|---|
| `apps/api/route-manifest.json` | `pnpm api:route-manifest` | Route existence, HTTP verb, path, `@RequiredSvcScopes`, `@ForbidServiceAccount`, `@RequiresIfMatch`, `@ApiExclude*` |
| `apps/api/openapi.json` | `pnpm api:openapi` | Request/response types from the class-validator/`@ApiProperty` DTOs |

Both are committed, so generation and its CI drift gate run offline with no gateway boot, no
database, and no Prisma client. The two sources are joined on the OpenAPI `operationId`
(`<ControllerClass>_<handler>`, the same pair the Nest `ModulesContainer` walk records).
**Generation fails when they disagree** about which admin routes exist, in either direction — a
live route missing from the OpenAPI document is a route missing its Swagger decorators, and that
is a real finding, not noise. The one sanctioned exemption is `@ApiExcludeEndpoint()`/
`@ApiExcludeController()`, which the manifest records so a deliberate absence is distinguishable
from an accidental one.

### Naming rules — nothing is configurable

| Thing | Rule | Example |
|---|---|---|
| Area | The `svc:` scope minus its `svc:`/`admin:` prefixes and trailing action | `svc:admin:tenant-tts-config:manage` -> `tenant-tts-config` |
| Property | camelCase of the area | `hope.admin.tenantTtsConfig` |
| Class / file | `Admin<Pascal>Resource` / `<area>.ts` | `AdminTenantTtsConfigResource` |
| Method | The controller's handler name | `TenantController.fetchAll` -> `fetchAll` |
| Method (collision) | Controller-qualified, for every member of the collision | `AiProviderCatalogController.list` -> `aiProviderCatalogList` |
| Paginated iterator | Method name + `Iterate` | `fetchAllIterate` |

Grouping by scope rather than by URL is deliberate: the scope is what an integrator must actually
hold, so `hope.admin.tenantTtsConfig` and `svc:admin:tenant-tts-config:manage` are one
substitution apart. Several controllers sharing one scope share one resource.

### What is generated, and what is not

Generated into `packages/vox-node/src/resources/admin/`: `<area>.ts` (one per area), `schemas.ts`
(only the component schemas the surface transitively reaches), `admin-namespace.ts` (the
`hope.admin` object), and `index.ts`. Generation also deletes generated modules that no longer
correspond to an area. Hand-authored and never touched: `admin-resource.ts` (pagination iterator,
`If-Match` plumbing, scope-aware error mapping) and `__tests__/`.

`MACHINE_CLOSED_CONTROLLERS` in `src/surface.ts` names five controllers that owner decisions D-3
and O-1 keep machine-closed: `ServiceAccountController`, `AdminImpersonationController`,
`ConsentGrantController`, `MonitoringController`, `AdminHealthServicesController`. They already
fall out of the surface by derivation (no `svc:*` scope), so this list does not exclude them — it
ASSERTS they stay closed, and generation fails if one of them is ever given a `svc:*` scope
without an owner decision to re-open it. The generated `admin-namespace.ts` docblock lists every
controller currently absent from the surface, which can be a longer list than this assertion set
(any controller that simply declares no `svc:*` scope today also falls out).

### Idempotency

Re-running produces a byte-identical tree: no timestamps, no versions, no environment values,
total ordering everywhere (areas by key, methods by path and verb, schemas by name, object
members by property name), and prettier applied with the repo config so a diff is always a
semantic change rather than a line-wrapping difference. `--check` regenerates and compares rather
than hashing, which catches a stale generated file as well as a hand-edited one.

## Gotchas

- Never hand-edit anything under `packages/vox-node/src/resources/admin/` except
  `admin-resource.ts` — `gen:admin:check` fails CI on any drift.
- A generation failure from a route/OpenAPI disagreement is a signal to fix the gateway's Swagger
  decorators, not to work around the generator.

## Related

- [`@arcaai/vox-node`](../vox-node/README.md) — the package this generates into.
- [`@arcaai/vox-codegen`](../vox-codegen/README.md) — the sibling generator for tenant-facing
  types (context schema, published agents/workflows).
- `.claude/rules/05-nestjs-api.md` — the route manifest and OpenAPI regeneration contract.
