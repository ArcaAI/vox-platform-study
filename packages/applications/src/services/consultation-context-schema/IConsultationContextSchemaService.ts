import type { ContextPrimitive, OpenBindings, UserIdentityBinding } from './context-schema-definition';
import type { DefinitionChangeClassification } from './definition-diff';
import type {
  ConsultationContextSchemaBundleResponse,
  ConsultationContextSchemaResponse,
  ConsultationContextSchemaVersionResponse,
  ContextSchemaUsagesResponse,
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
 *
 * The discriminant is a STRING, not an `ok: boolean`: this package compiles without
 * `strictNullChecks`, and TypeScript does not narrow a union on a boolean-literal discriminant
 * in that mode — every consumer would have to cast. A string discriminant narrows either way.
 */
export type ContextSchemaReferenceResolution =
  | {
      outcome: 'resolved';
      schemaId: string;
      versionNumber: number;
      /** The immutable version row — what gets frozen into a compiled artifact. */
      versionId: string;
      /** The DERIVED payload schema (`payloadSchemaFromDefinition`) — the `context.*` namespace. */
      payloadSchema: Record<string, unknown>;
      /**
       * TASK-950 D-3 — the DERIVED user-identity binding
       * (`userIdentityBindingFromDefinition`), or `null` when this version declares none.
       *
       * It rides beside `payloadSchema` because both are derived from the SAME version
       * `definition` the resolver already has in hand, and both are frozen by the same two
       * callers (agent publish, workflow compile). Deriving it a second time at each freeze
       * site would need the raw definition there, which is precisely what this result exists
       * to keep out of them.
       *
       * ADDITIVE-OPTIONAL: a producer written before this field existed supplies none, and
       * absent reads exactly as `null` at every consumer — "this version declares no identity
       * field", never "unknown".
       */
      userIdentity?: UserIdentityBinding | null;
      /**
       * TASK-951 D-1 — EVERY open-time mapping the version declares
       * (`openBindingsFromDefinition`), derived from the same definition in the same pass,
       * and frozen by the same two callers.
       *
       * `userIdentity` above is the TASK-950 accessor's answer and stays for the consumers
       * written against it; this object restates it beside the four markers TASK-951 added,
       * so an open-time caller reads ONE thing.
       *
       * OMITTED when the version declares no mappings at all — never `{}`. The freeze sites
       * stamp this key only when it is present, so an artifact whose schema declares nothing
       * is byte-identical to the one it was before this ticket.
       */
      openBindings?: OpenBindings;
    }
  | { outcome: 'failed'; failure: 'CONTEXT_SCHEMA_NOT_FOUND' | 'CONTEXT_SCHEMA_VERSION_NOT_FOUND' };

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
   * The response carries `impact`: what this publish did to every workflow and agent bound to
   * the schema.
   *
   * @throws NotFoundException — missing or cross-tenant id (checked first)
   * @throws BadRequestException — the definition is not authorable (every
   *   problem listed at once), the change is BREAKING and `allowBreakingChange` was not set, or
   *   an ACTIVE pinned consumer would refuse the new version and `acknowledgeImpact` was not set
   *   (`code: 'SCHEMA_IMPACT_UNACKNOWLEDGED'`, with the impact document in the body)
   */
  publish(id: string, dto: PublishConsultationContextSchemaRequest): Promise<ConsultationContextSchemaResponse>;

  /**
   * Move the pin to an already-published version (the rollback path). The response carries
   * `impact` for the version being pinned — reported, never gated: a pin is the escape hatch a
   * bad publish needs.
   */
  pin(id: string, dto: PinConsultationContextSchemaVersionRequest): Promise<ConsultationContextSchemaResponse>;

  /**
   * Every workflow and agent bound to this schema, with a verdict per consumer against
   * `againstVersion` (default: the schema's own pin).
   *
   * The question an admin asks BEFORE publishing — "what does this change break?" — and the same
   * document `publish`/`pin` embed as `impact`, so a preview and the write that follows it can
   * never disagree.
   *
   * @throws NotFoundException — missing or cross-tenant schema id, or an `againstVersion` this
   *   schema does not have
   */
  usages(schemaId: string, againstVersion?: number): Promise<ContextSchemaUsagesResponse>;

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
