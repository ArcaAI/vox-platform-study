import type { CompiledDocumentTemplate } from './document-template-compiler';
import type {
  CreateDocumentTemplateRequest,
  DocumentTemplateBundleResponse,
  DocumentTemplateResponse,
  DocumentTemplateVersionResponse,
  PinDocumentTemplateVersionRequest,
  PublishDocumentTemplateRequest,
  UpdateDocumentTemplateRequest,
} from './dto';

/** A resolved template, ready for a generation call. */
export interface ResolvedDocumentTemplate {
  /** Null when nothing was configured and the PLATFORM shape was compiled instead. */
  templateId: string | null;
  slug: string;
  versionNumber: number | null;
  /**
   * The immutable version id to STAMP on anything generated against this
   * template — the `ContextItem.contextSchemaVersionId` precedent. Null for the
   * platform fallback, which has no row to point at.
   */
  documentTemplateVersionId: string | null;
  compiled: CompiledDocumentTemplate;
}

/**
 * The tenant's clinical-document SHAPE catalog (TASK-810).
 *
 * ## The three surfaces, and who calls them
 *
 * | Surface | Caller | Gate |
 * |---|---|---|
 * | CRUD + `publish` + `pin` | admin console / tenant admin | `manage:DocumentTemplate` |
 * | `getEffectiveBundle` | any authenticated client, at session open | authenticated |
 * | `resolveForGeneration` | the live loop and generation nodes | — (internal) |
 *
 * ## Three rules that are easy to get wrong
 *
 * 1. **Generation resolves the PINNED version, never the latest.** A tenant
 *    publishing version N+1 mid-consultation must not silently change the shape
 *    of the document already being produced. The version id is stamped on the
 *    produced document for exactly this reason.
 * 2. **Cross-tenant ids answer 404, not 403.** Every by-id path goes through
 *    the same owned-or-throw helper.
 * 3. **`resolveForGeneration` never throws for an unconfigured tenant.** It
 *    falls back to the compiled PLATFORM shape. A running consultation must not
 *    die because nobody has authored a template yet — the same fail-open
 *    posture the live prompt chain already takes.
 */
export const IDocumentTemplateService = Symbol('IDocumentTemplateService');

export interface IDocumentTemplateService {
  /** Every template owned by the caller's tenant. */
  list(): Promise<DocumentTemplateResponse[]>;

  /** One template. 404 when missing OR cross-tenant. */
  getById(id: string): Promise<DocumentTemplateResponse>;

  /** A new DRAFT head row. Never born with a pin — `publish` is the only way to get one. */
  create(dto: CreateDocumentTemplateRequest): Promise<DocumentTemplateResponse>;

  /** Compare-and-set update of the head row's metadata. Never touches the shape. */
  update(id: string, dto: UpdateDocumentTemplateRequest): Promise<DocumentTemplateResponse>;

  /**
   * Validate a shape, COMPILE it, publish both as a new immutable version, and
   * move the pin to it.
   *
   * @throws NotFoundException — missing or cross-tenant id (checked first)
   * @throws BadRequestException — the shape is not publishable (every problem
   *   listed at once), or the change is BREAKING and `allowBreakingChange` was
   *   not set
   */
  publish(id: string, dto: PublishDocumentTemplateRequest): Promise<DocumentTemplateResponse>;

  /** Move the pin to an already-published version (the rollback path). */
  pin(id: string, dto: PinDocumentTemplateVersionRequest): Promise<DocumentTemplateResponse>;

  /** Soft-delete the head row. Published versions are never deleted. */
  deleteById(id: string): Promise<DocumentTemplateResponse>;

  /** Immutable version history, newest first. */
  listVersions(id: string): Promise<DocumentTemplateVersionResponse[]>;

  /**
   * DISCOVERY. The resolved, pinned bundle for the caller's tenant. Never
   * throws for an unconfigured tenant — see the response docstring.
   */
  getEffectiveBundle(slug?: string): Promise<DocumentTemplateBundleResponse>;

  /**
   * The seam the live loop and generation nodes call. Resolves by slug when one
   * is named, otherwise the tenant default, otherwise the compiled PLATFORM
   * shape. Never throws.
   */
  resolveForGeneration(tenantId: string, slug?: string): Promise<ResolvedDocumentTemplate>;
}
