# @arcaai/vox-node-codegen

Build-time generator for `@arcaai/vox-node`'s `/api/v1/admin/**` resource
surface (TASK-773 Phase D). **Private**: it is never published, never a runtime
dependency of the SDK, and never imported by application code.

```bash
pnpm --filter @arcaai/vox-node gen:admin         # write the surface
pnpm --filter @arcaai/vox-node gen:admin:check   # drift gate (CI: generate-vox-node-admin-check)
```

## Why the surface is generated

`@arcaai/vox-node`'s three original resources are hand-authored with dense doc
comments explaining wire contracts. The admin plane is roughly twenty times
larger — 52 areas, 384 machine-reachable routes — and this repo has twice
watched a hand-transcribed list of admin controllers silently go stale
(TASK-757's audit list policed 63 of 65; TASK-760's blast-radius table was
incomplete twice). The house rule that came out of it is **derive, don't
transcribe**, so every path, verb, required scope, method name, parameter and
payload type here is derived from artifacts the gateway itself produces.

## Placement

Beside `@arcaai/vox-node`, not inside it — following `packages/vox-codegen`,
the repo's existing precedent for a Node-only build-time CLI attached to a
published SDK. `@arcaai/vox-node` ships **zero runtime dependencies**; a
generator that reads the filesystem, parses OpenAPI and calls prettier does not
belong in that dependency graph. It is wired in as a `devDependency` only.

## Inputs: two artifacts, cross-checked

| Artifact | Produced by | Authoritative for |
|---|---|---|
| `apps/api/route-manifest.json` | `apps/api/src/scripts/emit-route-manifest.ts` (`pnpm api:route-manifest`) | route existence, HTTP verb, path, `@RequiredSvcScopes`, `@ForbidServiceAccount`, `@RequiresIfMatch`, `@ApiExclude*` |
| `apps/api/openapi.json` | `apps/api/src/scripts/emit-openapi.ts` (`pnpm api:openapi`) | request and response TYPES, from the class-validator/`@ApiProperty` DTOs |

Both are **committed**, so generation and its CI drift gate run offline with no
gateway boot, no database and no Prisma client.

The route manifest comes from a Nest `ModulesContainer` walk — the same walk
the boot audits perform (`apps/api/src/bootstrap/service-account-surface-audit.ts`),
reading metadata through the app's own `Reflector` so it sees exactly what
`UnifiedAuthGuard` sees at request time, class-level decorators included. The
ticket's preferred shape was for this package to do that walk itself; it cannot,
because walking `ModulesContainer` means constructing the whole gateway. The
ticket names the fallback taken instead: emit the manifest from `apps/api` and
consume it here.

The two sources are joined on the OpenAPI `operationId`, which `@nestjs/swagger`
derives as `<ControllerClass>_<handler>` — precisely the pair the Nest walk
records. **Generation FAILS when they disagree** about which admin routes exist,
in either direction. That is a real finding, not noise: a live route the document
does not describe is a route missing its Swagger decorators. The one sanctioned
exemption is `@ApiExcludeEndpoint()`/`@ApiExcludeController()`, which the manifest
records so a deliberate absence is distinguishable from an accidental one.

## Naming rules

Every name is derived; none is configurable. Full table in `src/naming.ts`.

| Thing | Rule | Example |
|---|---|---|
| area | the `svc:` scope minus its `svc:`/`admin:` prefixes and trailing action | `svc:admin:tenant-tts-config:manage` → `tenant-tts-config` |
| property | camelCase of the area | `hope.admin.tenantTtsConfig` |
| class / file | `Admin<Pascal>Resource` / `<area>.ts` | `AdminTenantTtsConfigResource` |
| method | the controller's handler name | `TenantController.fetchAll` → `fetchAll` |
| method (collision) | controller-qualified, for EVERY member of the collision | `AiProviderCatalogController.list` → `aiProviderCatalogList` |
| paginated iterator | method name + `Iterate` | `fetchAllIterate` |

Grouping by SCOPE rather than by URL is deliberate: the scope is what an
integrator must actually hold, so `hope.admin.tenantTtsConfig` and
`svc:admin:tenant-tts-config:manage` are one substitution apart. Several
controllers sharing one scope therefore share one resource — they are one
permission surface.

## What is generated, and what is not

Generated into `packages/vox-node/src/resources/admin/`: `<area>.ts` (one per
area), `schemas.ts` (only the component schemas the surface transitively
reaches), `admin-namespace.ts` (the `hope.admin` object), and `index.ts`.
Generation also DELETES generated modules that no longer correspond to an area,
so removing an admin area cannot leave a stale resource behind.

Hand-authored and never touched: `admin-resource.ts` (the base class — pagination
iterator, `If-Match` plumbing, scope-aware error mapping) and `__tests__/`.

Five admin controllers are **deliberately absent**, machine-closed by owner
decisions D-3 and O-1: `ServiceAccountController`, `AdminImpersonationController`,
`ConsentGrantController`, `MonitoringController`, `AdminHealthServicesController`.
They already fall out of the surface by derivation (no `svc:*` scope ⇒
deny-by-default), so `MACHINE_CLOSED_CONTROLLERS` in `src/surface.ts` does not
filter them — it ASSERTS they are still closed, and generation fails if one is
ever re-opened without an owner decision.

## Idempotency

Re-running produces a byte-identical tree: no timestamps, no versions, no
environment values, total ordering everywhere (areas by key, methods by path and
verb, schemas by name, object members by property name), and prettier applied
with the repo config so a diff is always a semantic change rather than a
line-wrapping difference. `--check` re-generates and compares rather than
hashing, which catches a stale generated file as well as a hand-edited one.
