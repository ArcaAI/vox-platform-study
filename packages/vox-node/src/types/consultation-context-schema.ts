/**
 * The tenant-declared consultation context schema, as served by the CLIENT
 * DISCOVERY route `GET /api/v1/tenants/me/context-schema`
 * (`apps/api/src/modules/consultation-context-schema/consultation-context-schema.controller.ts`).
 *
 * A tenant admin declares the KINDS of context a consultation carries; a client
 * discovers that declaration and builds its workflow from it; the server
 * validates every submitted payload against the PINNED version of it. These
 * types model what arrives on the wire — see
 * `docs/consultation-context-schema-integration-guide.md` for the whole model.
 *
 * ## Why the enum-ish fields are widened with `| string`
 *
 * The declaration is TENANT-AUTHORED and versioned independently of this SDK.
 * A tenant can publish a kind using a vocabulary — or, if the platform ever
 * extends the closed primitive set, a primitive — that a shipped build of this
 * package has never heard of. Narrowing those fields to today's unions would
 * make a client one release behind fail to even PARSE a bundle it could
 * otherwise have handled by ignoring the parts it does not recognise. The same
 * reasoning shapes `@arcaai/vox-codegen`'s local mirror of these types and the
 * browser SDK's permissive client-side validation.
 */

/**
 * The CLOSED set of platform primitives. Tenant vocabulary is free; the
 * substrate it maps onto is not, and publishing a kind with an unknown
 * primitive is rejected at authoring time — which is what keeps a tenant from
 * declaring a kind the consultation loop has no way to process.
 */
export const CONTEXT_PRIMITIVES = ['STREAM_AUDIO', 'TEXT', 'DOCUMENT', 'IMAGE', 'STRUCTURED'] as const;

/** One of {@link CONTEXT_PRIMITIVES}. */
export type ContextPrimitive = (typeof CONTEXT_PRIMITIVES)[number];

/** Informational deprecation block on a kind. Never enforced — a deprecated kind is still accepted. */
export interface ContextKindDeprecation {
  /** ISO date (`YYYY-MM-DD`) the kind was deprecated. */
  since: string;
  /** ISO date after which clients should have migrated. Open-ended when absent. */
  migrateBy?: string;
  /** Free-text guidance for a client reading the bundle. */
  message?: string;
  [key: string]: unknown;
}

/**
 * One `definition.kinds[]` entry — a tenant-invented context kind, mapped onto
 * exactly one platform primitive.
 */
export interface ContextKindDeclaration {
  /** Matches `^[a-z0-9_]{2,48}$`. This is what a write sends as `AddContextRequest.kindKey`. */
  key: string;
  label?: string;
  description?: string;
  /** See {@link ContextPrimitive} — widened for forward compatibility. */
  primitive: ContextPrimitive | string;
  /** `'PHI' | 'NON_PHI'`. */
  phiClass?: string;
  /** `'ONE' | 'MANY'`. */
  cardinality?: string;
  /** `'PRE' | 'DURING' | 'POST' | 'ANY'`. */
  lifecycle?: string;
  /** Any of `'CLIENT' | 'AGENT' | 'SYSTEM'`. */
  producedBy?: string[];
  required?: boolean;
  /**
   * JSON Schema (draft 2020-12 SUBSET — no `if`/`then`/`else`, `oneOf` only
   * with an explicit discriminator). Present for `STRUCTURED` kinds; this is
   * what a submitted `payload` is validated against server-side.
   */
  fields?: Record<string, unknown>;
  constraints?: { mimeTypes?: string[]; maxBytes?: number };
  deprecated?: ContextKindDeprecation;
  /**
   * Marks the ONE property of a `STRUCTURED`, `cardinality: 'ONE'` kind's
   * `fields.properties` that carries the tenant's STAFF IDENTIFIER for the
   * clinician (TASK-950). At most one kind in a definition carries this. When
   * a service-account caller's `open()` sends `context[key][field]`, HOPE
   * resolves it to a tenant user — creating one when none exists — and that
   * user becomes the consultation's clinician. Presence of the VALUE is still
   * governed by the kind/property's own `required` flags, not by this marker.
   */
  userIdentity?: { field: string };
  [key: string]: unknown;
}

/** One `definition.outputs[]` entry — something the consultation loop is expected to PRODUCE. */
export interface ContextOutputDeclaration {
  key: string;
  label?: string;
  description?: string;
  primitive: ContextPrimitive | string;
  fields?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The declaration document itself. `schemaVersion` is `'1.0'` — the only value the platform understands. */
export interface ConsultationContextSchemaDefinition {
  schemaVersion: string;
  kinds: ContextKindDeclaration[];
  outputs?: ContextOutputDeclaration[];
  [key: string]: unknown;
}

/**
 * Response body of `GET /api/v1/tenants/me/context-schema` — the RESOLVED,
 * PINNED declaration a client builds against. Mirrors
 * `ConsultationContextSchemaBundleResponse`.
 *
 * **Every field is nullable, and that is a normal state, not an error.** A
 * tenant with no configured schema gets a 200 whose fields are all `null` and
 * whose `etag` is `"none"` — deliberately not a 404, which a client cannot
 * tell apart from a routing mistake. Branch on `schemaId !== null` (or
 * `definition !== null`); never treat the unconfigured bundle as a failure.
 */
export interface ConsultationSchemaBundle {
  schemaId: string | null;
  slug: string | null;
  name: string | null;
  /** The PINNED version number — never simply the latest published one. */
  versionNumber: number | null;
  /**
   * The `ConsultationContextSchemaVersion` id. Thread this into
   * `hope.consultations.addContext(..., { contextSchemaVersionId })` so the
   * write validates against the version you actually read.
   */
  contextSchemaVersionId: string | null;
  /** sha256 over the canonical `definition`. */
  checksum: string | null;
  definition: ConsultationContextSchemaDefinition | null;
  /**
   * Strong RFC 7232 validator over the SERVED representation (schema identity +
   * pinned version + definition bytes) — `"none"` when unconfigured.
   *
   * Deliberately NOT the schema row's `_version`: renaming a schema does not
   * change what is served, so it does not invalidate a cached bundle.
   */
  etag: string;
}
