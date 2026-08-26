import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { createHash } from 'node:crypto';
import {
  DocumentTemplateEntity,
  DocumentTemplateFactory,
  DocumentTemplateRepository,
  DocumentTemplateStatus,
  DocumentTemplateVersionEntity,
  DocumentTemplateVersionFactory,
  DocumentTemplateVersionRepository,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { canonicalJson } from '../consultation-context-schema/context-schema-definition';
import { IDocumentTemplateService, ResolvedDocumentTemplate } from './IDocumentTemplateService';
import {
  CreateDocumentTemplateRequest,
  DocumentTemplateBundleResponse,
  DocumentTemplateResponse,
  DocumentTemplateVersionResponse,
  PinDocumentTemplateVersionRequest,
  PublishDocumentTemplateRequest,
  UpdateDocumentTemplateRequest,
} from './dto';
import { DocumentTemplateDtoMapper } from './document-template.dto.mapper';
import { documentTemplateShapeProblems, DocumentTemplateShape } from './document-template-shape';
import { CompiledDocumentTemplate, compileDocumentTemplate, DOCUMENT_TEMPLATE_COMPILER_VERSION } from './document-template-compiler';
import { classifyShapeChange, computeShapeChecksum, type ShapeChangeClassification } from './document-shape-diff';
import { SOAP_NOTE_SHAPE, SOAP_NOTE_SLUG } from './platform-document-shapes';

/** ETag served for a tenant that has configured no document template. */
const UNCONFIGURED_ETAG = '"none"';

/**
 * The PLATFORM fallback, compiled once at module load.
 *
 * Compilation is a pure function of a frozen shape, so hoisting it is safe and
 * keeps the fail-open path off the hot path of every flush.
 */
const PLATFORM_FALLBACK: ResolvedDocumentTemplate = Object.freeze({
  templateId: null,
  slug: SOAP_NOTE_SLUG,
  versionNumber: null,
  documentTemplateVersionId: null,
  compiled: compileDocumentTemplate(SOAP_NOTE_SHAPE),
});

/**
 * Tenant-declared clinical-document SHAPES.
 *
 * See `IDocumentTemplateService` for the surface contract and the three rules
 * that are easy to get wrong (pinned-not-latest; 404-over-403; resolution never
 * throws).
 *
 * The publish flow is copied from `ConsultationContextSchemaService.publish`
 * step for step — ownership 404 first, shape validation, idempotent republish,
 * breaking-change gate, mint, move pin — with ONE deliberate addition: the
 * shape is COMPILED before the version row is written, and the artifacts are
 * frozen onto the row alongside it. Compiling at publish rather than at
 * generation is what makes the decoding constraint a property of the pinned
 * version rather than of whatever compiler happens to be deployed when a
 * consultation runs.
 */
@Injectable()
export class DocumentTemplateService extends BaseService implements IDocumentTemplateService {
  private readonly logger = new Logger(DocumentTemplateService.name);

  constructor(
    private readonly templateRepository: DocumentTemplateRepository,
    private readonly versionRepository: DocumentTemplateVersionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.DocumentTemplate);
  }

  // ============================================================
  // CRUD
  // ============================================================

  async list(): Promise<DocumentTemplateResponse[]> {
    const tenantId = this.requireTenantId();
    const rows = await this.templateRepository.findAll({ where: { tenantId } });

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { count: rows.length } });

    return rows.map(DocumentTemplateDtoMapper.toResponse);
  }

  async getById(id: string): Promise<DocumentTemplateResponse> {
    const tenantId = this.requireTenantId();
    const entity = await this.findOwnedOrThrow(id, tenantId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: entity.id });

    return DocumentTemplateDtoMapper.toResponse(entity);
  }

  async create(dto: CreateDocumentTemplateRequest): Promise<DocumentTemplateResponse> {
    const tenantId = this.requireTenantId();

    const existing = await this.templateRepository.findByTenantAndSlug(tenantId, dto.slug);
    if (existing) {
      throw new ConflictException(`A document template with slug '${dto.slug}' already exists for this tenant.`);
    }

    const entity = DocumentTemplateFactory.CreateDocumentTemplate({
      tenantId,
      slug: dto.slug,
      name: dto.name,
      description: dto.description,
      isDefault: dto.isDefault ?? false,
      sourceTemplateSlug: dto.sourceTemplateSlug,
      templateLocked: dto.templateLocked ?? false,
      createdBy: this.requestUserId ?? undefined,
    });

    if (entity.isDefault) {
      await this.demoteExistingDefault(tenantId, null);
    }

    const saved = await this.templateRepository.create(entity);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { slug: saved.slug },
    });

    return DocumentTemplateDtoMapper.toResponse(saved);
  }

  async update(id: string, dto: UpdateDocumentTemplateRequest): Promise<DocumentTemplateResponse> {
    const tenantId = this.requireTenantId();
    const entity = await this.findOwnedOrThrow(id, tenantId);

    const { expectedVersion, ...changes } = dto;

    if (changes.isDefault === true && !entity.isDefault) {
      await this.demoteExistingDefault(tenantId, entity.id);
    }

    await this.updateEntity(entity, changes);

    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(entity, expectedVersion);
    if (!entity.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    const previousVersion = entity.version;
    const updated = await this.templateRepository.updateWithVersion(id, entity, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { ...entity.changes, previousVersion, newVersion: updated.version },
    });

    return DocumentTemplateDtoMapper.toResponse(updated);
  }

  async deleteById(id: string): Promise<DocumentTemplateResponse> {
    const tenantId = this.requireTenantId();
    await this.findOwnedOrThrow(id, tenantId);

    // Soft delete only. The published versions are NOT removed: a document
    // generated against one must be able to resolve it forever — and the DB
    // trigger would refuse the hard delete anyway (OD-13).
    const deleted = await this.templateRepository.softDelete(id, this.requestUserId ?? undefined);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, { resourceId: deleted.id, data: { slug: deleted.slug } });

    return DocumentTemplateDtoMapper.toResponse(deleted);
  }

  async listVersions(id: string): Promise<DocumentTemplateVersionResponse[]> {
    const tenantId = this.requireTenantId();
    const entity = await this.findOwnedOrThrow(id, tenantId);

    const versions = await this.versionRepository.findAllForTemplate(id);

    const pinned = entity.pinnedVersionNumber != null ? versions.find((version) => version.versionNumber === entity.pinnedVersionNumber) : undefined;

    return versions.map((version) => {
      const versionSkew: ShapeChangeClassification | undefined =
        pinned && pinned.id !== version.id ? classifyShapeChange(version.shape, pinned.shape).classification : undefined;
      return DocumentTemplateDtoMapper.toVersionResponse(version, versionSkew);
    });
  }

  // ============================================================
  // Publish / pin
  // ============================================================

  async publish(id: string, dto: PublishDocumentTemplateRequest): Promise<DocumentTemplateResponse> {
    const tenantId = this.requireTenantId();

    // Ownership FIRST: a cross-tenant id must 404 before the caller learns
    // anything about whether its shape would have been accepted.
    const entity = await this.findOwnedOrThrow(id, tenantId);

    const problems = documentTemplateShapeProblems(dto.shape);
    if (problems.length > 0) {
      throw new BadRequestException({
        message: 'The document template shape is not publishable.',
        problems,
      });
    }

    const latest = await this.versionRepository.findLatestForTemplate(id);
    const checksum = computeShapeChecksum(dto.shape);

    // Idempotent republish: identical canonical bytes compiled by the SAME
    // compiler write nothing and move nothing.
    //
    // `compilerVersion` is half of this predicate deliberately. On checksum
    // alone, an unchanged shape re-published after a compiler upgrade would be
    // a no-op — leaving the pin serving artifacts the current compiler would no
    // longer produce, with nothing in the row to say so. The version row is
    // supposed to be the whole truth about what a generation was constrained by.
    if (latest && latest.checksum === checksum && latest.compilerVersion === DOCUMENT_TEMPLATE_COMPILER_VERSION) {
      return DocumentTemplateDtoMapper.toResponse(entity);
    }

    const change = classifyShapeChange(latest ? latest.shape : null, dto.shape);
    if (change.classification === 'BREAKING' && dto.allowBreakingChange !== true) {
      // The breaks are named IN the message, not only in a sibling field: a
      // client that surfaces `error.message` (which is most of them) must
      // still tell the admin WHAT broke, or the acknowledgement checkbox is a
      // blind one.
      throw new BadRequestException({
        message:
          'This shape breaks readers built against the current version — ' +
          `${change.breakingChanges.join('; ')}. ` +
          'Re-submit with `allowBreakingChange: true` to publish it anyway.',
        breakingChanges: change.breakingChanges,
      });
    }

    const compiled = compileDocumentTemplate(dto.shape as unknown as DocumentTemplateShape);

    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    const version = DocumentTemplateVersionFactory.CreateDocumentTemplateVersion({
      tenantId,
      templateId: id,
      versionNumber,
      shape: dto.shape as never,
      compiled: compiled as never,
      compilerVersion: compiled.compilerVersion,
      checksum,
      changeReason: dto.changeReason,
      createdBy: this.requestUserId ?? undefined,
    });
    const savedVersion = await this.versionRepository.create(version);

    entity.pinnedVersionNumber = versionNumber;
    // A publish is what makes a template servable. An APPROVED template stays
    // APPROVED — re-publishing must not silently drop a clinical sign-off back
    // to PUBLISHED.
    if (entity.status !== DocumentTemplateStatus.APPROVED) {
      entity.status = DocumentTemplateStatus.PUBLISHED;
    }
    entity.updatedBy = this.requestUserId ?? undefined;

    // Non-versioned update: publishing is not a compare-and-set on the head
    // row (the caller is not editing metadata it read), so it must not fail on
    // an unrelated concurrent metadata edit. Same choice
    // `ConsultationContextSchemaService.publish` makes.
    const updated = await this.templateRepository.update(id, entity);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: {
        action: 'publish',
        versionNumber,
        documentTemplateVersionId: savedVersion.id,
        checksum,
        compilerVersion: compiled.compilerVersion,
        classification: change.classification,
        breakingChanges: change.breakingChanges,
      },
    });

    return DocumentTemplateDtoMapper.toResponse(updated);
  }

  async pin(id: string, dto: PinDocumentTemplateVersionRequest): Promise<DocumentTemplateResponse> {
    const tenantId = this.requireTenantId();
    const entity = await this.findOwnedOrThrow(id, tenantId);

    const version = await this.versionRepository.findByTemplateAndVersionNumber(id, dto.versionNumber);
    if (!version) {
      throw new NotFoundException(`Document template ${id} has no version ${dto.versionNumber}`);
    }

    const previousVersionNumber = entity.pinnedVersionNumber ?? null;
    entity.pinnedVersionNumber = dto.versionNumber;
    entity.updatedBy = this.requestUserId ?? undefined;

    const updated = await this.templateRepository.update(id, entity);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'pin', previousVersionNumber, versionNumber: dto.versionNumber },
    });

    return DocumentTemplateDtoMapper.toResponse(updated);
  }

  // ============================================================
  // Discovery / resolution
  // ============================================================

  async getEffectiveBundle(slug?: string): Promise<DocumentTemplateBundleResponse> {
    const tenantId = this.requireTenantId();
    const resolved = await this.resolveServableVersion(tenantId, slug);

    if (!resolved) {
      return {
        templateId: null,
        slug: null,
        name: null,
        versionNumber: null,
        documentTemplateVersionId: null,
        checksum: null,
        shape: null,
        compiled: null,
        etag: UNCONFIGURED_ETAG,
      };
    }

    const { template, version } = resolved;
    return {
      templateId: template.id,
      slug: template.slug,
      name: template.name,
      versionNumber: version.versionNumber,
      documentTemplateVersionId: version.id,
      checksum: version.checksum,
      shape: (version.shape ?? {}) as Record<string, unknown>,
      compiled: (version.compiled ?? {}) as Record<string, unknown>,
      etag: bundleEtag(template.id, version.id, version.versionNumber, version.shape),
    };
  }

  async resolveForGeneration(tenantId: string, slug?: string): Promise<ResolvedDocumentTemplate> {
    try {
      const resolved = await this.resolveServableVersion(tenantId, slug);
      if (!resolved) return PLATFORM_FALLBACK;

      const compiled = resolved.version.compiled as unknown as CompiledDocumentTemplate | null;
      // A version row whose compiled artifacts are unusable is a data defect,
      // not a client error. Degrading to the platform shape keeps a live
      // consultation alive; failing here would end it.
      if (!compiled?.responseFormat || !Array.isArray(compiled.sectionKeys)) {
        this.logger.error({
          message: 'Document template version has no usable compiled artifacts',
          reason: 'document_template_compiled_missing',
          templateId: resolved.template.id,
          versionNumber: resolved.version.versionNumber,
          tenantId,
        });
        return PLATFORM_FALLBACK;
      }

      return {
        templateId: resolved.template.id,
        slug: resolved.template.slug,
        versionNumber: resolved.version.versionNumber,
        documentTemplateVersionId: resolved.version.id,
        compiled,
      };
    } catch (error) {
      // Fail OPEN, loudly. This runs inside a live consultation; the platform
      // shape is a worse document than the tenant's own, but no document at all
      // is a lost clinical encounter.
      this.logger.error({
        message: 'Document template resolution failed; falling back to the platform shape',
        reason: 'document_template_resolution_failed',
        tenantId,
        slug,
        error: error instanceof Error ? error.message : String(error),
      });
      return PLATFORM_FALLBACK;
    }
  }

  // ============================================================
  // Internals
  // ============================================================

  private requireTenantId(): string {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    return tenantId;
  }

  /**
   * Load by id and enforce tenant ownership. Mismatch (or missing) throws
   * `NotFoundException` — never `ForbiddenException` — so a cross-tenant
   * caller cannot infer the row exists (04-application-services.md).
   */
  private async findOwnedOrThrow(id: string, tenantId: string): Promise<DocumentTemplateEntity> {
    const entity = await this.templateRepository.findById(id).catch(() => null);
    if (!entity || entity.tenantId !== tenantId) {
      throw new NotFoundException(`Document template ${id} not found`);
    }
    return entity;
  }

  /**
   * Resolution cascade: the named slug (when a generation node binds one) →
   * the tenant default → nothing. A template only participates when it is
   * SERVABLE — published/approved AND carrying a pin.
   *
   * A slug that names a template which exists but is NOT servable resolves to
   * NOTHING rather than falling through to the default. The bind was explicit;
   * quietly generating a different document than the one the workflow named
   * would be worse than falling back to the platform shape, which at least the
   * caller can detect from `templateId: null`.
   */
  private async resolveServableVersion(
    tenantId: string,
    slug?: string,
  ): Promise<{ template: DocumentTemplateEntity; version: DocumentTemplateVersionEntity } | null> {
    const template = slug
      ? await this.templateRepository.findByTenantAndSlug(tenantId, slug)
      : await this.templateRepository.findDefaultForTenant(tenantId);

    if (!template || !isServable(template)) return null;

    const version = await this.versionRepository.findByTemplateAndVersionNumber(template.id, template.pinnedVersionNumber as number);
    if (version) return { template, version };

    // A pin naming a version that does not exist is a data defect, not a
    // client error: log it rather than failing a live consultation.
    this.logger.error({
      message: 'Document template pin names a version that does not exist',
      reason: 'document_template_dangling_pin',
      templateId: template.id,
      pinnedVersionNumber: template.pinnedVersionNumber,
      tenantId,
    });
    return null;
  }

  /**
   * At most one default per tenant. Enforced here rather than by a partial
   * unique index, mirroring `ConsultationContextSchema.isDefault`.
   */
  private async demoteExistingDefault(tenantId: string, exceptId: string | null): Promise<void> {
    const current = await this.templateRepository.findDefaultForTenant(tenantId);
    if (!current || current.id === exceptId) return;
    current.isDefault = false;
    current.updatedBy = this.requestUserId ?? undefined;
    await this.templateRepository.update(current.id, current);
  }
}

/** A template is servable only when it is published/approved AND carries a pin. */
function isServable(template: DocumentTemplateEntity): boolean {
  return (
    template.pinnedVersionNumber != null &&
    (template.status === DocumentTemplateStatus.PUBLISHED || template.status === DocumentTemplateStatus.APPROVED)
  );
}

/**
 * Strong RFC 7232 validator over the SERVED representation only — template
 * identity, the pinned version, and the shape bytes.
 *
 * Deliberately NOT the template's `_version` column (which the global
 * `ETagInterceptor` would use): that counter moves on every head-row metadata
 * edit, so renaming a template would invalidate every cached bundle even though
 * the served bytes are identical.
 */
function bundleEtag(templateId: string, versionId: string, versionNumber: number, shape: unknown): string {
  const digest = createHash('sha256').update(canonicalJson({ templateId, versionId, versionNumber, shape })).digest('hex').slice(0, 32);
  return `"${digest}"`;
}
