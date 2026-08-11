import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { createHash } from 'node:crypto';
import {
  ConsultationContextSchemaEntity,
  ConsultationContextSchemaFactory,
  ConsultationContextSchemaRepository,
  ConsultationContextSchemaScope,
  ConsultationContextSchemaStatus,
  ConsultationContextSchemaVersionEntity,
  ConsultationContextSchemaVersionFactory,
  ConsultationContextSchemaVersionRepository,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IConsultationContextSchemaService, ValidateContextPayloadInput, ValidatedContextPayload } from './IConsultationContextSchemaService';
import {
  ConsultationContextSchemaBundleResponse,
  ConsultationContextSchemaResponse,
  ConsultationContextSchemaVersionResponse,
  CreateConsultationContextSchemaRequest,
  PinConsultationContextSchemaVersionRequest,
  PublishConsultationContextSchemaRequest,
  UpdateConsultationContextSchemaRequest,
} from './dto';
import { ConsultationContextSchemaDtoMapper } from './consultation-context-schema.dto.mapper';
import {
  canonicalJson,
  computeDefinitionChecksum,
  contextSchemaDefinitionProblems,
  findKind,
  type ContextPrimitive,
} from './context-schema-definition';
import { classifyDefinitionChange, type DefinitionChangeClassification } from './definition-diff';
import { jsonSchemaValueProblems } from './json-schema-subset';

/** ETag served for a tenant that has not configured a context schema. */
const UNCONFIGURED_ETAG = '"none"';

/** Cap on a single structured payload, mirroring the spirit of CONTEXT_CONTENT_MAX_LENGTH. */
const MAX_STRUCTURED_PAYLOAD_BYTES = 200_000;

/**
 * TASK-658 — tenant-declared consultation context schemas.
 *
 * See `IConsultationContextSchemaService` for the surface contract and the two
 * rules that are easy to get wrong (pinned-not-latest; 404-over-403).
 */
@Injectable()
export class ConsultationContextSchemaService extends BaseService implements IConsultationContextSchemaService {
  private readonly logger = new Logger(ConsultationContextSchemaService.name);

  constructor(
    private readonly schemaRepository: ConsultationContextSchemaRepository,
    private readonly versionRepository: ConsultationContextSchemaVersionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.ConsultationContextSchema);
  }

  // ============================================================
  // CRUD
  // ============================================================

  async list(): Promise<ConsultationContextSchemaResponse[]> {
    const tenantId = this.requireTenantId();
    const rows = await this.schemaRepository.findAll({ where: { tenantId } });

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { count: rows.length } });

    return rows.map(ConsultationContextSchemaDtoMapper.toResponse);
  }

  async getById(id: string): Promise<ConsultationContextSchemaResponse> {
    const tenantId = this.requireTenantId();
    const entity = await this.findOwnedOrThrow(id, tenantId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: entity.id });

    return ConsultationContextSchemaDtoMapper.toResponse(entity);
  }

  async create(dto: CreateConsultationContextSchemaRequest): Promise<ConsultationContextSchemaResponse> {
    const tenantId = this.requireTenantId();

    const existing = await this.schemaRepository.findByTenantAndSlug(tenantId, dto.slug);
    if (existing) {
      throw new ConflictException(`A context schema with slug '${dto.slug}' already exists for this tenant.`);
    }

    const scope = dto.scope ?? ConsultationContextSchemaScope.TENANT;
    // Structural invariants also live on the entity, but checking here turns a
    // 500 (BusinessException escaping a factory) into the 400 it actually is.
    if (scope === ConsultationContextSchemaScope.DEPARTMENT && !dto.departmentId) {
      throw new BadRequestException('A DEPARTMENT-scoped context schema requires a departmentId.');
    }
    if (scope === ConsultationContextSchemaScope.TENANT && dto.departmentId) {
      throw new BadRequestException('A TENANT-scoped context schema must not carry a departmentId.');
    }

    const entity = ConsultationContextSchemaFactory.CreateConsultationContextSchema({
      tenantId,
      slug: dto.slug,
      name: dto.name,
      description: dto.description,
      scope,
      departmentId: scope === ConsultationContextSchemaScope.DEPARTMENT ? dto.departmentId : null,
      isDefault: dto.isDefault ?? false,
      sourceTemplateSlug: dto.sourceTemplateSlug,
      templateLocked: dto.templateLocked ?? false,
      createdBy: this.requestUserId ?? undefined,
    });

    if (entity.isDefault) {
      await this.demoteExistingDefault(tenantId, scope, entity.departmentId ?? null, null);
    }

    const saved = await this.schemaRepository.create(entity);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { slug: saved.slug, scope: saved.scope, departmentId: saved.departmentId },
    });

    return ConsultationContextSchemaDtoMapper.toResponse(saved);
  }

  async update(id: string, dto: UpdateConsultationContextSchemaRequest): Promise<ConsultationContextSchemaResponse> {
    const tenantId = this.requireTenantId();
    const entity = await this.findOwnedOrThrow(id, tenantId);

    const { expectedVersion, ...changes } = dto;

    if (changes.isDefault === true && !entity.isDefault) {
      await this.demoteExistingDefault(tenantId, entity.scope, entity.departmentId ?? null, entity.id);
    }

    await this.updateEntity(entity, changes);

    if (!entity.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    const previousVersion = entity.version;
    const updated = await this.schemaRepository.updateWithVersion(id, entity, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { ...entity.changes, previousVersion, newVersion: updated.version },
    });

    return ConsultationContextSchemaDtoMapper.toResponse(updated);
  }

  async deleteById(id: string): Promise<ConsultationContextSchemaResponse> {
    const tenantId = this.requireTenantId();
    await this.findOwnedOrThrow(id, tenantId);

    // Soft delete only. The published versions are NOT removed: a ContextItem
    // stamped with one of them must be able to resolve it forever.
    const deleted = await this.schemaRepository.softDelete(id, this.requestUserId ?? undefined);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, { resourceId: deleted.id, data: { slug: deleted.slug } });

    return ConsultationContextSchemaDtoMapper.toResponse(deleted);
  }

  async listVersions(id: string): Promise<ConsultationContextSchemaVersionResponse[]> {
    const tenantId = this.requireTenantId();
    await this.findOwnedOrThrow(id, tenantId);

    const versions = await this.versionRepository.findAllForSchema(id);
    return versions.map(ConsultationContextSchemaDtoMapper.toVersionResponse);
  }

  // ============================================================
  // Publish / pin
  // ============================================================

  async publish(id: string, dto: PublishConsultationContextSchemaRequest): Promise<ConsultationContextSchemaResponse> {
    const tenantId = this.requireTenantId();

    // Ownership FIRST: a cross-tenant id must 404 before the caller learns
    // anything about whether its definition would have been accepted.
    const entity = await this.findOwnedOrThrow(id, tenantId);

    const problems = contextSchemaDefinitionProblems(dto.definition);
    if (problems.length > 0) {
      throw new BadRequestException({
        message: 'The context schema definition is not publishable.',
        problems,
      });
    }

    const latest = await this.versionRepository.findLatestForSchema(id);
    const checksum = computeDefinitionChecksum(dto.definition);

    // Idempotent republish: identical canonical bytes write nothing and move
    // nothing, so the discovery ETag does not change either (AC-7).
    if (latest && latest.checksum === checksum) {
      return ConsultationContextSchemaDtoMapper.toResponse(entity);
    }

    const change = classifyDefinitionChange(latest ? latest.definition : null, dto.definition);
    if (change.classification === 'BREAKING' && dto.allowBreakingChange !== true) {
      // The breaks are named IN the message, not only in a sibling field: a
      // client that surfaces `error.message` (which is most of them) must
      // still tell the admin WHAT broke, or the acknowledgement checkbox is a
      // blind one.
      throw new BadRequestException({
        message:
          'This definition breaks clients built against the current version — ' +
          `${change.breakingChanges.join('; ')}. ` +
          'Re-submit with `allowBreakingChange: true` to publish it anyway.',
        breakingChanges: change.breakingChanges,
      });
    }

    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    const version = ConsultationContextSchemaVersionFactory.CreateConsultationContextSchemaVersion({
      tenantId,
      schemaId: id,
      versionNumber,
      definition: dto.definition as never,
      checksum,
      changeReason: dto.changeReason,
      createdBy: this.requestUserId ?? undefined,
    });
    const savedVersion = await this.versionRepository.create(version);

    entity.pinnedVersionNumber = versionNumber;
    // A publish is what makes a schema servable. An APPROVED schema stays
    // APPROVED — re-publishing must not silently drop a governance sign-off
    // back to PUBLISHED.
    if (entity.status !== ConsultationContextSchemaStatus.APPROVED) {
      entity.status = ConsultationContextSchemaStatus.PUBLISHED;
    }
    entity.updatedBy = this.requestUserId ?? undefined;

    // Non-versioned update: publishing is not a compare-and-set on the head
    // row (the caller is not editing metadata it read), so it must not fail on
    // an unrelated concurrent metadata edit.
    const updated = await this.schemaRepository.update(id, entity);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: {
        action: 'publish',
        versionNumber,
        contextSchemaVersionId: savedVersion.id,
        checksum,
        classification: change.classification,
        breakingChanges: change.breakingChanges,
      },
    });

    return ConsultationContextSchemaDtoMapper.toResponse(updated);
  }

  async pin(id: string, dto: PinConsultationContextSchemaVersionRequest): Promise<ConsultationContextSchemaResponse> {
    const tenantId = this.requireTenantId();
    const entity = await this.findOwnedOrThrow(id, tenantId);

    const version = await this.versionRepository.findBySchemaAndVersionNumber(id, dto.versionNumber);
    if (!version) {
      throw new NotFoundException(`Context schema ${id} has no version ${dto.versionNumber}`);
    }

    const previousVersionNumber = entity.pinnedVersionNumber ?? null;
    entity.pinnedVersionNumber = dto.versionNumber;
    entity.updatedBy = this.requestUserId ?? undefined;

    const updated = await this.schemaRepository.update(id, entity);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { action: 'pin', previousVersionNumber, versionNumber: dto.versionNumber },
    });

    return ConsultationContextSchemaDtoMapper.toResponse(updated);
  }

  // ============================================================
  // Discovery
  // ============================================================

  async getEffectiveBundle(departmentId?: string): Promise<ConsultationContextSchemaBundleResponse> {
    const tenantId = this.requireTenantId();
    const resolved = await this.resolveServableVersion(tenantId, departmentId);

    if (!resolved) {
      return {
        schemaId: null,
        slug: null,
        name: null,
        versionNumber: null,
        contextSchemaVersionId: null,
        checksum: null,
        definition: null,
        etag: UNCONFIGURED_ETAG,
      };
    }

    const { schema, version } = resolved;
    return {
      schemaId: schema.id,
      slug: schema.slug,
      name: schema.name,
      versionNumber: version.versionNumber,
      contextSchemaVersionId: version.id,
      checksum: version.checksum,
      definition: (version.definition ?? {}) as Record<string, unknown>,
      etag: bundleEtag(schema.id, version.id, version.versionNumber, version.definition),
    };
  }

  // ============================================================
  // The validation seam ContextService calls
  // ============================================================

  async validateContextPayload(input: ValidateContextPayloadInput): Promise<ValidatedContextPayload> {
    const tenantId = this.requireTenantId();

    // TASK-661 — an EXPLICITLY pinned version (a client built against schema
    // vN talking to a tenant now on vM) is what gets validated against,
    // FULL STOP — never silently upgraded to the current pin. That is what
    // makes an old client safe rather than merely detectable as stale.
    const explicitVersion = input.contextSchemaVersionId ? await this.loadVersionByIdOwned(input.contextSchemaVersionId, tenantId) : undefined;
    const version = explicitVersion ?? (await this.resolveServableVersion(tenantId, input.departmentId))?.version;

    if (!version) {
      throw new BadRequestException(
        `Context item declares kindKey '${input.kindKey}' but this tenant has no published context schema to validate it against.`,
      );
    }

    // TASK-661 — a compatibility SIGNAL only: reuses the exact classifier
    // `publish` uses (`classifyDefinitionChange`) to judge the drift between
    // the version just validated against and the tenant's CURRENT pin, so a
    // caller pinned to an old version can be told it is falling behind. It
    // never changes `version` above — the write already validated safely.
    let versionSkew: DefinitionChangeClassification | undefined;
    if (explicitVersion) {
      const servable = await this.resolveServableVersion(tenantId, input.departmentId);
      if (servable && servable.version.id !== explicitVersion.id) {
        versionSkew = classifyDefinitionChange(explicitVersion.definition, servable.version.definition).classification;
      }
    }

    const kind = findKind(version.definition, input.kindKey);
    if (!kind) {
      throw new BadRequestException(`Context schema version ${version.versionNumber} does not declare a kind '${input.kindKey}'.`);
    }

    const primitive = kind.primitive as ContextPrimitive;

    if (primitive === 'STRUCTURED') {
      if (input.payload === undefined) {
        throw new BadRequestException(`Kind '${input.kindKey}' is STRUCTURED and requires a \`payload\`.`);
      }
      const problems = jsonSchemaValueProblems(kind.fields ?? {}, input.payload, '');
      if (problems.length > 0) {
        throw new BadRequestException({
          message: `Payload does not conform to kind '${input.kindKey}' of context schema version ${version.versionNumber}.`,
          problems,
        });
      }

      // Persist the CANONICAL form so two byte-different-but-equal payloads
      // are stored identically, and so it rides the existing encrypted
      // `content` column rather than needing a plaintext JSON column.
      const content = canonicalJson(input.payload);
      if (Buffer.byteLength(content, 'utf8') > MAX_STRUCTURED_PAYLOAD_BYTES) {
        throw new BadRequestException(`Structured payload exceeds ${MAX_STRUCTURED_PAYLOAD_BYTES} bytes.`);
      }
      return { kindKey: input.kindKey, primitive, contextSchemaVersionId: version.id, content, versionSkew };
    }

    // Non-STRUCTURED kinds carry no `fields` contract in this ticket — the
    // primitive alone decides the substrate (TASK-654 §4.1) and the per-
    // primitive constraint checks (mimeTypes/maxBytes on DOCUMENT/IMAGE) land
    // with the loop that actually fetches the media, in TASK-660/662. A
    // `payload` on such a kind is a caller error and is refused rather than
    // silently dropped.
    if (input.payload !== undefined) {
      throw new BadRequestException(`Kind '${input.kindKey}' has primitive ${primitive} and does not accept a \`payload\`.`);
    }

    return { kindKey: input.kindKey, primitive, contextSchemaVersionId: version.id, content: input.content, versionSkew };
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
  private async findOwnedOrThrow(id: string, tenantId: string): Promise<ConsultationContextSchemaEntity> {
    const entity = await this.schemaRepository.findById(id).catch(() => null);
    if (!entity || entity.tenantId !== tenantId) {
      throw new NotFoundException(`Context schema ${id} not found`);
    }
    return entity;
  }

  private async loadVersionByIdOwned(versionId: string, tenantId: string): Promise<ConsultationContextSchemaVersionEntity | undefined> {
    const version = await this.versionRepository.findById(versionId).catch(() => null);
    if (!version || version.tenantId !== tenantId) {
      // A pin naming a foreign or non-existent version is a bad REQUEST, not a
      // missing route — the caller supplied it.
      throw new BadRequestException(`Unknown context schema version '${versionId}'.`);
    }
    return version;
  }

  /**
   * Discovery cascade: DEPARTMENT-scoped default (when a department is in
   * play) → TENANT-scoped default → nothing. A schema only participates when
   * it is SERVABLE — published/approved AND carrying a pin.
   */
  private async resolveServableVersion(
    tenantId: string,
    departmentId?: string,
  ): Promise<{ schema: ConsultationContextSchemaEntity; version: ConsultationContextSchemaVersionEntity } | null> {
    const candidates: (ConsultationContextSchemaEntity | null)[] = [];
    if (departmentId) {
      candidates.push(await this.schemaRepository.findDefaultForScope(tenantId, ConsultationContextSchemaScope.DEPARTMENT, departmentId));
    }
    candidates.push(await this.schemaRepository.findDefaultForScope(tenantId, ConsultationContextSchemaScope.TENANT, null));

    for (const schema of candidates) {
      if (!schema || !isServable(schema)) continue;
      const version = await this.versionRepository.findBySchemaAndVersionNumber(schema.id, schema.pinnedVersionNumber as number);
      if (version) {
        return { schema, version };
      }
      // A pin naming a version that does not exist is a data defect, not a
      // client error: log it and fall through to the next tier rather than
      // failing a live consultation.
      this.logger.error({
        message: 'Context schema pin names a version that does not exist',
        reason: 'context_schema_dangling_pin',
        schemaId: schema.id,
        pinnedVersionNumber: schema.pinnedVersionNumber,
        tenantId,
      });
    }

    return null;
  }

  /**
   * At most one default per (tenant, scope, departmentId). Enforced here
   * rather than by a partial unique index, mirroring `DepartmentAgent.isDefault`.
   */
  private async demoteExistingDefault(
    tenantId: string,
    scope: ConsultationContextSchemaScope,
    departmentId: string | null,
    exceptId: string | null,
  ): Promise<void> {
    const current = await this.schemaRepository.findDefaultForScope(tenantId, scope, departmentId);
    if (!current || current.id === exceptId) return;
    current.isDefault = false;
    current.updatedBy = this.requestUserId ?? undefined;
    await this.schemaRepository.update(current.id, current);
  }
}

/** A schema is servable only when it is published/approved AND carries a pin. */
function isServable(schema: ConsultationContextSchemaEntity): boolean {
  return (
    schema.pinnedVersionNumber != null &&
    (schema.status === ConsultationContextSchemaStatus.PUBLISHED || schema.status === ConsultationContextSchemaStatus.APPROVED)
  );
}

/**
 * Strong RFC 7232 validator over the SERVED representation only — schema
 * identity, the pinned version, and the definition bytes.
 *
 * Deliberately NOT the schema's `_version` column (which the global
 * `ETagInterceptor` would use): that counter moves on every head-row metadata
 * edit, so renaming a schema would invalidate every client's cached bundle
 * even though the served bytes are identical. It is also deliberately not the
 * definition checksum alone: two schemas can hold the same declaration, and
 * the bundle names which schema it came from.
 */
function bundleEtag(schemaId: string, versionId: string, versionNumber: number, definition: unknown): string {
  const digest = createHash('sha256').update(canonicalJson({ schemaId, versionId, versionNumber, definition })).digest('hex').slice(0, 32);
  return `"${digest}"`;
}
