/**
 * TASK-666 — types for `ConsultationContextSchema` administration
 * (`/admin/consultation-context-schemas`, TASK-658). Mirrors the response/
 * request DTOs in `packages/applications/src/services/consultation-context-schema/dto/`
 * and the definition-document shape in `context-schema-definition.ts` — kept
 * hand-written (not imported) because `apps/admin-console` does not depend on
 * `@arcaai/applications` (a server-side package).
 */

export type ConsultationContextSchemaScope = 'TENANT' | 'DEPARTMENT';
export type ConsultationContextSchemaStatus = 'DRAFT' | 'PUBLISHED' | 'APPROVED';

export interface ConsultationContextSchema {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  scope: ConsultationContextSchemaScope;
  departmentId: string | null;
  status: ConsultationContextSchemaStatus;
  /** The version discovery serves. Null until the first publish. */
  pinnedVersionNumber: number | null;
  isDefault: boolean;
  sourceTemplateSlug: string | null;
  templateLocked: boolean;
  /** Optimistic-concurrency counter; rendered as the strong `ETag` by the global interceptor. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** TASK-661's compatibility judgement, reused by TASK-674 for the version list. */
export type ContextSchemaVersionSkew = 'IDENTICAL' | 'ADDITIVE' | 'BREAKING';

export interface ConsultationContextSchemaVersion {
  id: string;
  schemaId: string;
  versionNumber: number;
  definition: ContextSchemaDefinition;
  /** sha256 over the canonical JSON of `definition`. */
  checksum: string;
  changeReason: string | null;
  createdBy: string | null;
  createdAt: string;
  /**
   * TASK-674 — drift between this version and the schema's CURRENT pin,
   * classified by the same rules `publish` uses to decide whether a change
   * needs `allowBreakingChange`. Absent for the pinned version itself (and
   * for a schema with no pin yet).
   */
  versionSkew?: ContextSchemaVersionSkew;
}

// ---------------------------------------------------------------------------
// The `definition` document (TASK-658 §3.1) — a tenant declares its OWN
// vocabulary, but every kind must declare exactly one of five PLATFORM
// PRIMITIVES. The primitive set below is CLOSED; extending it is a platform
// change, never a tenant one — the admin console must never let an author
// type a sixth value.
// ---------------------------------------------------------------------------

export const CONTEXT_PRIMITIVES = ['STREAM_AUDIO', 'TEXT', 'DOCUMENT', 'IMAGE', 'STRUCTURED'] as const;
export type ContextPrimitive = (typeof CONTEXT_PRIMITIVES)[number];

export const CONTEXT_PHI_CLASSES = ['PHI', 'NON_PHI'] as const;
export type ContextPhiClass = (typeof CONTEXT_PHI_CLASSES)[number];

export const CONTEXT_CARDINALITIES = ['ONE', 'MANY'] as const;
export type ContextCardinality = (typeof CONTEXT_CARDINALITIES)[number];

export const CONTEXT_LIFECYCLES = ['PRE', 'DURING', 'POST', 'ANY'] as const;
export type ContextLifecycle = (typeof CONTEXT_LIFECYCLES)[number];

export const CONTEXT_PRODUCERS = ['CLIENT', 'AGENT', 'SYSTEM'] as const;
export type ContextProducer = (typeof CONTEXT_PRODUCERS)[number];

/** The only `schemaVersion` the platform understands. */
export const CONTEXT_SCHEMA_DEFINITION_VERSION = '1.0';

/** Grammar for `kinds[].key`, `outputs[].key` and the schema `slug`. */
export const CONTEXT_KIND_KEY_PATTERN = /^[a-z0-9_]{2,48}$/;

export interface KindDeprecation {
  /** ISO date (`YYYY-MM-DD`) the kind was deprecated. */
  since: string;
  /** ISO date after which clients should have migrated. Open-ended when absent. */
  migrateBy?: string;
  /** Free-text guidance surfaced to a client reading the discovery bundle. */
  message?: string;
}

export interface ContextKindConstraints {
  mimeTypes?: string[];
  maxBytes?: number;
}

export interface ContextKindDeclaration {
  key: string;
  label: string;
  primitive: ContextPrimitive;
  phiClass: ContextPhiClass;
  cardinality: ContextCardinality;
  lifecycle: ContextLifecycle;
  producedBy: ContextProducer[];
  required?: boolean;
  description?: string;
  /** JSON Schema draft 2020-12 subset — required for STRUCTURED. */
  fields?: Record<string, unknown>;
  constraints?: ContextKindConstraints;
  deprecated?: KindDeprecation;
}

export interface ContextOutputDeclaration {
  key: string;
  label?: string;
  description?: string;
  primitive: ContextPrimitive;
  fields?: Record<string, unknown>;
}

export interface ContextSchemaDefinition {
  schemaVersion: string;
  kinds: ContextKindDeclaration[];
  outputs?: ContextOutputDeclaration[];
}

/** A fresh, unpublished draft — the Definition tab's starting point for a brand-new schema. */
export function emptyDefinition(): ContextSchemaDefinition {
  return { schemaVersion: CONTEXT_SCHEMA_DEFINITION_VERSION, kinds: [], outputs: [] };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface CreateConsultationContextSchemaRequest {
  slug: string;
  name: string;
  description?: string;
  scope?: ConsultationContextSchemaScope;
  departmentId?: string;
  isDefault?: boolean;
  sourceTemplateSlug?: string;
  templateLocked?: boolean;
}

export interface UpdateConsultationContextSchemaRequest {
  name?: string;
  description?: string;
  isDefault?: boolean;
  status?: ConsultationContextSchemaStatus;
  expectedVersion?: number;
  templateLocked?: boolean;
}

export interface PublishConsultationContextSchemaRequest {
  definition: ContextSchemaDefinition;
  changeReason?: string;
  /** Acknowledges a breaking change; without it a breaking publish is refused with 400. */
  allowBreakingChange?: boolean;
}

export interface PinConsultationContextSchemaVersionRequest {
  versionNumber: number;
}

/** Minimal department-directory shape for the scope/department pickers. */
export interface Department {
  id: string;
  code?: string;
  name?: string;
}
