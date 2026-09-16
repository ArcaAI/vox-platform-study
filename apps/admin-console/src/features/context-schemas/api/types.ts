/**
 * Types for `ConsultationContextSchema` administration
 * (`/admin/consultation-context-schemas`). Mirrors the response/
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

/** Compatibility judgement, reused for the version list. */
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
   * drift between this version and the schema's CURRENT pin,
   * classified by the same rules `publish` uses to decide whether a change
   * needs `allowBreakingChange`. Absent for the pinned version itself (and
   * for a schema with no pin yet).
   */
  versionSkew?: ContextSchemaVersionSkew;
}

// ---------------------------------------------------------------------------
// The `definition` document — a tenant declares its OWN
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
  /**
   * Marks `field` — a property of this kind's `fields.properties` whose
   * `type` is `'string'` — as the tenant's clinician **staff identifier**
   * (TASK-950). Allowed only on a `STRUCTURED` kind with `cardinality:
   * 'ONE'`; at most one kind per definition may carry it. When a
   * service-account request (consultation open, agent invocation, workflow
   * run) supplies this field, HOPE resolves it to a tenant user via
   * `UserProfile.staffId` — provisioning one when none exists — and that
   * user becomes the request's acting clinician. Presence/absence of the
   * value is still governed by the ordinary `required` flags; this marker
   * only says what to do with the value when it is sent.
   */
  userIdentity?: { field: string };
  /**
   * Marks `field` — a string property of this kind's `fields.properties` —
   * as the tenant's department selector (TASK-951 D-1/D-2). Allowed only on
   * a `STRUCTURED` kind with `cardinality: 'ONE'`; at most one kind per
   * definition may carry it. `by` selects how HOPE resolves the value at
   * `open`: `'code'` (default, unique per tenant) or `'name'`
   * (case-insensitive; ambiguous matches are refused).
   */
  department?: { field: string; by: 'code' | 'name' };
  /**
   * Marks `field` as the tenant's visit-type selector (TASK-951 D-1/D-3).
   * Allowed only on a `STRUCTURED` kind with `cardinality: 'ONE'`, and only
   * when `field`'s declared JSON Schema is a string whose `enum` is a
   * subset of `['new-visit', 'revisit']`. At most one kind per definition
   * may carry it. The stated value is matched through the visit-type
   * catalogue (aliases honoured) and wins over the parent-link derivation.
   */
  visitType?: { field: string };
  /**
   * Marks `field` as the tenant's external (encounter/event) reference id
   * (TASK-951 D-1/D-4). Allowed only on a `STRUCTURED` kind with
   * `cardinality: 'ONE'`; at most one kind per definition may carry it.
   * Persisted on `Consultation.metadata.externalRef` — never part of the
   * re-open idempotency key.
   */
  externalRef?: { field: string };
  /**
   * Marks this kind's payload as the client-owned identity of an audio
   * stream (TASK-951 D-1/D-8) — echoed verbatim on every transcript
   * segment of the STT session it accompanies. Allowed only on a
   * `STRUCTURED` kind with `cardinality: 'ONE'`; at most one kind per
   * definition may carry it. Informational only — it does not change
   * validation.
   */
  streamContext?: true;
  /**
   * Additionally persists each entry of this kind's `notes` array as a
   * `CASE_NOTE` context item (TASK-951 D-1/D-5). Allowed only on a
   * `STRUCTURED` kind with `cardinality: 'ONE'` whose
   * `fields.properties.notes` is a JSON Schema array of objects each
   * declaring a string `text` property. Several kinds in one definition
   * may carry it.
   */
  materializeAs?: 'CASE_NOTE';
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
  /**
   * Acknowledges that a bound consumer would REFUSE the version being published.
   * Client compatibility (`allowBreakingChange`) and consumer compatibility are
   * two different facts, so they are two different gates: without this the
   * publish is refused with 400 `SCHEMA_IMPACT_UNACKNOWLEDGED`, carrying the
   * same `impact` a successful publish returns.
   */
  acknowledgeImpact?: boolean;
}

export interface PinConsultationContextSchemaVersionRequest {
  versionNumber: number;
}

// ---------------------------------------------------------------------------
// Who depends on this schema — `GET :id/usages?againstVersion=<n>`, and the
// `impact` block `publish` / `pin` answer with.
//
// A consumer BINDS to a schema either by following the tenant's pin (`latest`)
// or by freezing a version at its own publish (`pinned`). Only the second can
// refuse: a frozen trigger validates against the version it was compiled with,
// so a kind added afterwards is simply not declared there. `unknown` is honest
// — the consumer's compiled config could not be read — and is never rendered as
// "accepts".
// ---------------------------------------------------------------------------

export type ContextSchemaBinding = 'latest' | 'pinned';
export type ContextSchemaVerdict = 'accepts' | 'refuses' | 'unknown';

interface ContextSchemaUsageBase {
  slug: string;
  name: string;
  versionNumber: number;
  status: string;
  /** Only ACTIVE published consumers count toward the acknowledgement gate. */
  isActive: boolean;
  binding: ContextSchemaBinding;
  boundVersion: number | null;
  verdict: ContextSchemaVerdict;
  problems: string[];
}

export interface ContextSchemaWorkflowUsage extends ContextSchemaUsageBase {
  definitionId: string;
}

export interface ContextSchemaAgentUsage extends ContextSchemaUsageBase {
  agentId: string;
}

export interface ContextSchemaUsagesResponse {
  schemaId: string;
  againstVersion: number | null;
  workflows: ContextSchemaWorkflowUsage[];
  agents: ContextSchemaAgentUsage[];
}

/** `publish` and `pin` answer the schema PLUS the impact of the version they wrote. */
export interface ConsultationContextSchemaWithImpact extends ConsultationContextSchema {
  impact?: ContextSchemaUsagesResponse;
}

/** Minimal department-directory shape for the scope/department pickers. */
export interface Department {
  id: string;
  code?: string;
  name?: string;
}
