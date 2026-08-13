/**
 * Minimal local mirror of the discovery bundle served by
 * `GET /tenant/me/context-schema` and re-declared client-side
 * in `@arcaai/vox`'s `src/types/consultationSchema.ts`.
 *
 * Hand-typed here rather than imported from `@arcaai/vox`, for the same
 * reason hand-ported the JSON-Schema-subset evaluator instead of
 * importing a shared package: `@arcaai/json-schema-subset` does not exist at
 * this baseline (dev-2.1 @ d5c43c033) — there is nothing to share against
 * yet, and importing `@arcaai/vox`'s TYPES ONLY would still pull this
 * package into `@arcaai/vox`'s build graph (its dist must exist first) for
 * a handful of interfaces. Keeping `@arcaai/vox-codegen` a standalone Node
 * package with zero workspace dependencies (matching `@arcaai/vox-node`'s
 * posture) is worth the small, well-contained duplication. If a shared types
 * package for the discovery bundle is ever extracted, this is the first
 * candidate to migrate onto it.
*/

/** The CLOSED set of platform primitives.*/
export const CONTEXT_PRIMITIVES = ['STREAM_AUDIO', 'TEXT', 'DOCUMENT', 'IMAGE', 'STRUCTURED'] as const;
export type ContextPrimitive = (typeof CONTEXT_PRIMITIVES)[number];

/** One `definition.kinds[]` entry. Widened with `| string` on enum-like fields for forward compatibility. */
export interface ContextKindDeclaration {
  key: string;
  label?: string;
  primitive: ContextPrimitive | string;
  phiClass?: string;
  cardinality?: string;
  lifecycle?: string;
  producedBy?: string[];
  required?: boolean;
  description?: string;
  /** JSON Schema (draft 2020-12 subset) — present for `STRUCTURED` kinds. */
  fields?: Record<string, unknown>;
  constraints?: { mimeTypes?: string[]; maxBytes?: number };
  deprecated?: { since: string; migrateBy?: string; message?: string };
  [key: string]: unknown;
}

/** One `definition.outputs[]` entry. */
export interface ContextOutputDeclaration {
  key: string;
  label?: string;
  description?: string;
  primitive: ContextPrimitive | string;
  fields?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ConsultationContextSchemaDefinition {
  schemaVersion: string;
  kinds: ContextKindDeclaration[];
  outputs?: ContextOutputDeclaration[];
  [key: string]: unknown;
}

/**
 * The DISCOVERY bundle — the resolved, PINNED declaration a client (or this
 * codegen tool) builds against. Every field is nullable: "this tenant has
 * not configured a context schema" is an ordinary 200 response with
 * `etag: "none"`, never a 404.
*/
export interface ConsultationSchemaBundle {
  schemaId: string | null;
  slug: string | null;
  name: string | null;
  /** The PINNED version number — never simply the latest published one. */
  versionNumber: number | null;
  /** The `ConsultationContextSchemaVersion` id. */
  contextSchemaVersionId: string | null;
  checksum: string | null;
  definition: ConsultationContextSchemaDefinition | null;
  /** Strong RFC 7232 validator over the served representation. `"none"` for an unconfigured tenant. */
  etag: string;
}

/** The safe "no schema configured" bundle — same shape the server returns for an unconfigured tenant. */
export const UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE: ConsultationSchemaBundle = {
  schemaId: null,
  slug: null,
  name: null,
  versionNumber: null,
  contextSchemaVersionId: null,
  checksum: null,
  definition: null,
  etag: 'none',
};
