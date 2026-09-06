import type { ContextPrimitive } from './context-schema-definition';
import type { DefinitionChangeClassification } from './definition-diff';
import type {
  ConsultationContextSchemaBundleResponse,
  ConsultationContextSchemaResponse,
  ConsultationContextSchemaVersionResponse,
  CreateConsultationContextSchemaRequest,
  PinConsultationContextSchemaVersionRequest,
  PublishConsultationContextSchemaRequest,
  UpdateConsultationContextSchemaRequest,
} from './dto';

/** Everything `ContextService` needs to know about a context write that names a kind. */
export interface ValidateContextPayloadInput {
  /** The tenant-declared kind key. */
  kindKey: string;
  /** Structured payload, for a STRUCTURED kind. */
  payload?: Record<string, unknown>;
  /** Free text, for a TEXT-ish kind. */
  content?: string;
  /**
   * A version the CALLER already pinned (a session that opened against
   * version N). When present it wins over the schema's current pin — that is
   * what keeps an in-flight consultation valid across a publish.
   */
  contextSchemaVersionId?: string;
  /** Narrows discovery to a DEPARTMENT-scoped schema when the consultation has one. */
  departmentId?: string;
}

export interface ValidatedContextPayload {
  kindKey: string;
  primitive: ContextPrimitive;
  /** The immutable version the write was validated against — stamped onto the ContextItem. */
  contextSchemaVersionId: string;
  /**
   * The text to persist. For a STRUCTURED kind this is the canonical JSON of
   * the validated payload, so it rides the EXISTING Vault-Transit encryption
   * path on `ContextItem.content` — no new plaintext PHI column exists or is
   * needed.
   */
  content?: string;
  /**
   * Set ONLY when the caller pinned an explicit
   * `contextSchemaVersionId` that differs from the tenant's CURRENT servable
   * pin. Classifies the drift between the version the write was validated
   * against and the current one, using the SAME classifier `publish` uses
   * (`classifyDefinitionChange` in `definition-diff.ts`) — never a second,
   * divergent notion of compatibility.
   *
   * This is purely a signal for the caller (e.g. to warn a client it is
   * falling behind); it never changes what got validated — that is always
   * `contextSchemaVersionId`, the version the caller pinned.
   */
  versionSkew?: DefinitionChangeClassification;
}

/**
 * Tenant-declared consultation context schemas.
 *
 * ## The three surfaces, and who calls them
 *
 * | Surface | Caller | Gate |
 * |---|---|---|
 * | CRUD + `publish` + `pin` | admin console / tenant admin | `manage:ConsultationContextSchema` |
 * | `getEffectiveBundle` | any authenticated client, at session open | authenticated |
 * | `validateContextPayload` | `ContextService`, on every context write naming a kind | — (internal) |
 *
 * ## Two rules that are easy to get wrong
 *
 * 1. **Validation resolves the PINNED version, never the latest.** A tenant
 *    publishing version N+1 mid-consultation must not retroactively
 *    invalidate a write the client made against version N. The pin is
 *    captured on the `ContextItem` at write time for exactly this reason.
 * 2. **Cross-tenant ids answer 404, not 403.** Every by-id path goes through
 *    the same owned-or-throw helper.
 */
/**
 * TASK-890 §3.4 — what a context-schema REFERENCE resolved to.
 *
 * A discriminated result rather than a throw, because the CALLER decides what an
 * unresolvable reference means: for the workflow publish gate it is a finding whose CODE
 * has to distinguish "no such schema in this tenant" from "that version does not exist"
 * (`CONTEXT_SCHEMA_NOT_FOUND` / `CONTEXT_SCHEMA_VERSION_NOT_FOUND`); for the console it is
 * an empty variable picker. Throwing would collapse both into one 404 the gate could not
 * name.
 */
export type ContextSchemaReferenceResolution =
  | {
      ok: true;
      schemaId: string;
      versionNumber: number;
      /** The immutable version row — what gets frozen into a compiled artifact. */
      versionId: string;
      /** The DERIVED payload schema (`payloadSchemaFromDefinition`) — the `context.*` namespace. */
      payloadSchema: Record<string, unknown>;
    }
  | { ok: false; failure: 'CONTEXT_SCHEMA_NOT_FOUND' | 'CONTEXT_SCHEMA_VERSION_NOT_FOUND' };

export const IConsultationContextSchemaService = Symbol('IConsultationContextSchemaService');

export interface IConsultationContextSchemaService {
  /** Every schema owned by the caller's tenant. */
  list(): Promise<ConsultationContextSchemaResponse[]>;

  /** One schema. 404 when missing OR cross-tenant. */
  getById(id: string): Promise<ConsultationContextSchemaResponse>;

  /** A new DRAFT head row. Never born with a pin — `publish` is the only way to get one. */
  create(dto: CreateConsultationContextSchemaRequest): Promise<ConsultationContextSchemaResponse>;

  /** Compare-and-set update of the head row's metadata. Never touches the definition. */
  update(id: string, dto: UpdateConsultationContextSchemaRequest): Promise<ConsultationContextSchemaResponse>;

  /**
   * Validate and publish a definition as a new immutable version, then move
   * the pin to it.
   *
   * @throws NotFoundException — missing or cross-tenant id (checked first)
   * @throws BadRequestException — the definition is not authorable (every
   *   problem listed at once), or the change is BREAKING and
   *   `allowBreakingChange` was not set
   */
  publish(id: string, dto: PublishConsultationContextSchemaRequest): Promise<ConsultationContextSchemaResponse>;

  /** Move the pin to an already-published version (the rollback path). */
  pin(id: string, dto: PinConsultationContextSchemaVersionRequest): Promise<ConsultationContextSchemaResponse>;

  /** Soft-delete the head row. Published versions are never deleted. */
  deleteById(id: string): Promise<ConsultationContextSchemaResponse>;

  /** Immutable version history, newest first. */
  listVersions(id: string): Promise<ConsultationContextSchemaVersionResponse[]>;

  /**
   * DISCOVERY. The resolved, pinned bundle for the caller's tenant:
   * DEPARTMENT-scoped default → TENANT-scoped default → unconfigured. Never
   * throws for an unconfigured tenant — see the response docstring.
   */
  getEffectiveBundle(departmentId?: string): Promise<ConsultationContextSchemaBundleResponse>;

  /**
   * The validation seam `ContextService` calls on every write that names a
   * kind.
   *
   * @throws BadRequestException — no servable schema, unknown kind, or a
   *   payload that does not conform to the pinned declaration
   */
  validateContextPayload(input: ValidateContextPayloadInput): Promise<ValidatedContextPayload>;

  /**
   * TASK-890 §3.4 — resolve a context-schema REFERENCE (an `Agent.contextSchemaId` pin, a
   * `core.trigger`'s `contextSchema.contextSchemaId`) inside the CALLER's tenant.
   *
   * TENANT-only: a SYSTEM id resolves to nothing, exactly like another tenant's, because a
   * schema is CLONED into a tenant and never shared from SYSTEM (OD-H). `versionNumber`
   * defaults to the schema's own pin.
   */
  resolveReference(schemaId: string, versionNumber?: number | null): Promise<ContextSchemaReferenceResolution>;

  /**
   * TASK-890 §3.4 — copy one SYSTEM reference schema into a tenant, PUBLISHED and pinned,
   * stamped `sourceTemplateSlug` + `templateLocked: true`.
   *
   * Missing-only: a tenant that already carries the slug is returned unchanged. Refuses
   * (404) when SYSTEM has no such schema or the source carries no pinned version — an
   * unservable clone is worse than a named failure at provisioning time.
   */
  cloneFromSystem(slug: string, tenantId: string): Promise<ConsultationContextSchemaResponse>;
}
