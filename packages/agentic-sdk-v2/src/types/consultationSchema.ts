/**
 * @arcaai/vox - Consultation Context Schema Types
 *
 * Client-side mirror of the discovery bundle served by
 * `GET /tenant/me/context-schema`. The server resolves the
 * tenant's (optionally department-scoped) PINNED `ConsultationContextSchema`
 * declaration — never simply the latest published version — and returns it
 * as a flat envelope plus the raw `definition` JSON document.
 *
 * ## Why the envelope is validated but `definition` is not
 *
 * The envelope (`schemaId`, `slug`, `name`, `versionNumber`,
 * `contextSchemaVersionId`, `checksum`, `etag`) has a FIXED shape the SDK can
 * commit to at compile time, so it is parsed with `valibot` (already a
 * bundled dependency — see `ConfigSchema.ts`/`ModelRegistry.ts`) exactly like
 * `parseTenantConfig` guards `GET /tenant/me/config`.
 *
 * `definition.kinds[]` is TENANT-AUTHORED and open-ended by design: a tenant can
 * declare new kinds, new optional fields, or a `deprecated` block at any time
 * without an SDK release. Typing it as anything other than
 * `Record<string, unknown>` plus permissive runtime guards would mean this
 * SDK breaks (or silently drops data) the moment a tenant publishes a schema
 * shape one release ahead of it — the opposite of additive-only
 * compatibility contract. `ContextKindDeclaration` below is therefore a
 * best-effort VIEW for callers who want typed access to well-known fields,
 * not a strict parser: `findConsultationContextKind` returns `undefined`
 * (never throws) for anything that doesn't look like a kind, which is what
 * makes "unknown kind is ignored, not fatal" true both for a genuinely
 * unrecognized `kindKey` AND for a structurally unexpected definition.
 */

import * as v from 'valibot';

/** The CLOSED set of platform primitives, mirrored read-only.*/
export const CONTEXT_PRIMITIVES = ['STREAM_AUDIO', 'TEXT', 'DOCUMENT', 'IMAGE', 'STRUCTURED'] as const;
export type ContextPrimitive = (typeof CONTEXT_PRIMITIVES)[number];

/**
 * Deprecation signal a tenant may author on a kind. Purely
 * informational — the server still accepts a deprecated kind for the length
 * of its stated migration window; the SDK never enforces the window.
 */
export interface ContextKindDeprecation {
  /** ISO date (`YYYY-MM-DD`) the kind was deprecated. */
  since: string;
  /** ISO date after which clients should have migrated. Open-ended when absent. */
  migrateBy?: string;
  /** Free-text guidance surfaced to a client reading the discovery bundle. */
  message?: string;
}

/**
 * A best-effort typed VIEW of one `kinds[]` entry. Enum-like fields are
 * widened with `| string` so a future primitive/phiClass/etc. value the
 * server accepts before this SDK is rebuilt still type-checks — forward
 * compatibility, not just runtime tolerance.
 */
export interface ContextKindDeclaration {
  key: string;
  label?: string;
  primitive: ContextPrimitive | string;
  phiClass?: 'PHI' | 'NON_PHI' | string;
  cardinality?: 'ONE' | 'MANY' | string;
  lifecycle?: 'PRE' | 'DURING' | 'POST' | 'ANY' | string;
  producedBy?: string[];
  required?: boolean;
  description?: string;
  /** JSON Schema (draft 2020-12 subset) fields — present for `STRUCTURED` kinds. */
  fields?: Record<string, unknown>;
  constraints?: { mimeTypes?: string[]; maxBytes?: number };
  deprecated?: ContextKindDeprecation;
  /** Fields the SDK doesn't recognize yet ride along unmodified. */
  [key: string]: unknown;
}

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
 * The DISCOVERY bundle — the resolved, PINNED declaration a
 * client builds its workflow from. Every field is nullable: "this tenant has
 * not configured a context schema" is an ordinary, expected state (server
 * returns 200, never 404 — see), and a fetch failure is
 * treated identically on the client (see `ConsultationSchemaClient.ts`) so a
 * consumer never has to distinguish "not configured" from "couldn't reach
 * the server" to decide whether to fall back to its built-in flow.
 */
export interface ConsultationSchemaBundle {
  schemaId: string | null;
  slug: string | null;
  name: string | null;
  /** The PINNED version number — never simply the latest published one. */
  versionNumber: number | null;
  /** The `ConsultationContextSchemaVersion` id — pin this for the session and send it as `X-Context-Schema-Version`. */
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
// Envelope validation (valibot — guards against a malformed/poisoned response)
// =============================================================================

const CONSULTATION_SCHEMA_BUNDLE_SCHEMA = v.object({
  schemaId: v.nullish(v.string(), null),
  slug: v.nullish(v.string(), null),
  name: v.nullish(v.string(), null),
  versionNumber: v.nullish(v.number(), null),
  contextSchemaVersionId: v.nullish(v.string(), null),
  checksum: v.nullish(v.string(), null),
  // The definition document is tenant-authored and open-ended — validated
  // structurally as "a JSON object" only; its contents are read defensively
  // by `findConsultationContextKind` below, never assumed.
  definition: v.nullish(v.record(v.string(), v.unknown()), null),
  etag: v.optional(v.string(), 'none'),
});

/**
 * Parse a raw `GET /tenant/me/context-schema` response into a
 * `ConsultationSchemaBundle`. Never throws: a response that doesn't match
 * the envelope shape is treated exactly like "no schema configured" — the
 * SAME fallback `ConsultationSchemaClient.fetchConsultationSchema` uses for a
 * network/HTTP failure, so callers have exactly one "no schema" case to
 * handle, not two.
 */
export function parseConsultationSchemaBundle(raw: unknown): ConsultationSchemaBundle {
  const result = v.safeParse(CONSULTATION_SCHEMA_BUNDLE_SCHEMA, raw);
  if (!result.success) {
    return UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE;
  }
  return result.output as ConsultationSchemaBundle;
}

// =============================================================================
// Lookup helpers (mirror the server's `findKind` — applications-layer
// `context-schema-definition.ts` — read-only, never throws)
// =============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The declared kind with this key, or `undefined` — for an unconfigured
 * tenant, a definition that fails to parse, or a `kindKey` the tenant hasn't
 * declared (yet, or ever). Callers MUST treat `undefined` as "nothing to
 * validate against, let the server decide" (forward compatibility), never as
 * an error.
 */
export function findConsultationContextKind(
  definition: ConsultationContextSchemaDefinition | null | undefined,
  kindKey: string,
): ContextKindDeclaration | undefined {
  if (!isPlainObject(definition) || !Array.isArray(definition.kinds)) return undefined;
  return definition.kinds.find((kind) => isPlainObject(kind) && kind.key === kindKey) as ContextKindDeclaration | undefined;
}

/** Whether a resolved kind carries a `deprecated` block.*/
export function isConsultationContextKindDeprecated(kind: ContextKindDeclaration | undefined): boolean {
  return isPlainObject(kind?.deprecated);
}
