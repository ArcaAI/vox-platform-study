/**
 * Library surface of `@arcaai/vox-node-codegen` — the build-time generator for
 * `@arcaai/vox-node`'s `/api/v1/admin/**` resources.
 *
 * ## Placement (following `packages/vox-codegen`)
 *
 * `@arcaai/vox-node` ships ZERO runtime dependencies and is published to
 * consumers; a generator that reads the filesystem, parses OpenAPI and calls
 * prettier has no business inside it. `packages/vox-codegen` already
 * established the repo's answer for exactly this shape — "same brand,
 * different job": a sibling workspace package, Node-only tsup config, never a
 * dependency of the published SDK. This package follows that template.
 *
 * ## Why it consumes an emitted manifest rather than walking Nest itself
 *
 * The route shape must come from the API's own Nest metadata — it is what
 * `UnifiedAuthGuard` reads at request time. Walking `ModulesContainer` from
 * HERE would mean constructing the entire gateway (`NestFactory.create`), so
 * this build-time package would depend on `@arcaai/api`, on Prisma/Redis/JWT
 * bootstrap env, and on the compiled `nest build` output. The ticket names the
 * fallback taken instead: `apps/api/src/scripts/emit-route-manifest.ts` does
 * the walk in the app that owns it and writes `apps/api/route-manifest.json`,
 * which this package consumes alongside the already-checked-in
 * `apps/api/openapi.json`. Both artifacts are committed, so generation and its
 * CI drift gate run OFFLINE with no gateway boot.
 */

export { main } from './cli';
export { emitSurface } from './emit';
export type { EmittedFile } from './emit';
export { areaKeyFromScope, controllerSlug, toCamelCase, toIdentifier, toPascalCase } from './naming';
export { generate, HAND_AUTHORED } from './run';
export type { GenerateOptions, GenerateResult } from './run';
export { SchemaRenderer } from './schema-to-ts';
export { buildAdminSurface, CrossCheckError, MACHINE_CLOSED_CONTROLLERS } from './surface';
export type { AdminArea, AdminMethod, AdminSurface, OpenApiDocument, RouteManifest, RouteManifestEntry } from './types';
