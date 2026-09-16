/**
 * Minimal local mirror of the discovery bundle served by
 * `GET /tenants/me/context-schema` and re-declared client-side
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
  /**
   * Names the ONE property of `fields.properties` that carries the tenant's
   * staff identifier for the clinician (TASK-950) — present on at most one
   * `STRUCTURED`, `cardinality: 'ONE'` kind per definition. `generate.ts`
   * renders this as an `@identity` JSDoc annotation on that property.
   */
  userIdentity?: { field: string };
  /**
   * Names the ONE property carrying the DEPARTMENT this consultation
   * belongs to (TASK-951), resolved by the tenant's own `code` (the
   * default) or `name`. `generate.ts` renders this as a `@role department`
   * JSDoc annotation on that property.
   */
  department?: { field: string; by: 'code' | 'name' };
  /**
   * Names the ONE property carrying the VISIT TYPE (TASK-951). `generate.ts`
   * renders this as a `@role visitType` JSDoc annotation on that property.
   */
  visitType?: { field: string };
  /**
   * Names the ONE property carrying an EXTERNAL system's own identifier for
   * this encounter (TASK-951). `generate.ts` renders this as a
   * `@role externalRef` JSDoc annotation on that property.
   */
  externalRef?: { field: string };
  /**
   * Marks this kind's payload for materialization as `CASE_NOTE` context
   * items at `open()` (TASK-951). `generate.ts` renders this as a
   * type-level `@materializeAs CASE_NOTE` JSDoc annotation.
   */
  materializeAs?: 'CASE_NOTE';
  /**
   * Marks this kind as the stream-identity payload of an STT session
   * `context` (TASK-951). `generate.ts` renders this as a type-level
   * `@streamContext` JSDoc annotation.
   */
  streamContext?: true;
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

// =============================================================================
// The BUSINESS plane (TASK-931) — what a tenant PUBLISHES
// =============================================================================
//
// A local mirror again, for the reason in this file's header: this package has zero workspace
// dependencies, and importing `@arcaai/vox-node`'s types would pull it into that package's
// build graph for a handful of interfaces. Only the fields the generator READS are declared —
// a build-time tool has no business asserting the whole wire contract.

/** One published, active Agent — `GET /agents` + `GET /agents/{slug}`. */
export interface PublishedAgent {
  slug: string;
  name: string;
  description: string | null;
  /** `TEXT_GENERATION` | `TEXT_TO_SPEECH` | `SPEECH_TO_TEXT` | `NAMED_ENTITY_RECOGNITION`, as a string: a NEW task value must not break a build-time tool. */
  task: string | null;
  versionNumber: number | null;
  /** JSON Schema (the authorable subset) of the invocation body. `null` when the agent declares none. */
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
}

/** One published workflow definition — `GET /workflows` + `GET /workflows/{slug}/schema`. */
export interface PublishedWorkflow {
  slug: string;
  name: string;
  description: string | null;
  versionNumber: number | null;
  triggerKinds: string[];
  protocols: string[];
  /**
   * From the schema route's `components.Workflow_<slug>_Input`.
   *
   * `null` is a real answer, not a gap: a definition whose Trigger declares no context schema
   * has no input contract, and generating an open `object` from that would produce code that
   * compiles and then 400s.
   */
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  /**
   * The consultation context schema this definition's trigger is bound to — `null` for a
   * definition with no consultation trigger. `followsLatest` says whether `versionNumber` tracks
   * the tenant's current pin or is frozen to the version the workflow was published against.
   */
  contextSchema: { schemaId: string; slug: string; versionNumber: number; followsLatest: boolean } | null;
  /** Every `core.humanReview` node in the graph, in graph order. */
  reviewNodes: Array<{ nodeId: string; label: string }>;
}

/** What one business-plane run of the generator read. */
export interface PublishedCatalogue {
  agents: PublishedAgent[];
  workflows: PublishedWorkflow[];
}
