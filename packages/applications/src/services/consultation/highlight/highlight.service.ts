import { ConsultationRepository, HighlightEntity, HighlightFactory, HighlightRepository, ResourceType, SysEventType } from '@arcaai/domains';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService, assertParentInScope, encryptPhiFields } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { IHighlightService } from './IHighlightService';
import { HighlightDtoMapper } from './highlight.dto.mapper';
import { CreateHighlightRequest, HighlightResponse } from './dto';

/**
 * Durable manual-doctor highlighting.
 *
 * Highlights are a SEPARATE aggregate from NamedEntity so doctor-authored marks
 * never pollute the AI NER taxonomy / aggregation. Each operation is tenant
 * scoped through `assertParentInScope` (throws NotFound — never Forbidden — on a
 * cross-tenant / missing parent so the response cannot leak the existence of a
 * foreign-tenant resource), mirroring `ContextService`.
 */
@Injectable()
export class HighlightService extends BaseService implements IHighlightService {
  constructor(
    private readonly highlightRepository: HighlightRepository,
    private readonly consultationRepository: ConsultationRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Vault-Transit field encryption for the highlight's
    // doctor-authored free text (exact / prefix / suffix / note). Optional +
    // @Inject so legacy/direct-construction tests still work; when absent these
    // PHI fields are left unpersisted (there are no plaintext columns).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super(eventEmitter, clsService, ResourceType.Highlight);
  }

  private readonly logger = new Logger(HighlightService.name);

  /**
   * Encrypt the highlight's plaintext free-text fields (exact /
   * prefix / suffix / note) into their `encrypted*` / `keyVersion` columns
   * through the shared env-gated guard: a soft no-op in dev/test, FAIL-CLOSED
   * (throws) in staging/prod (SECRETS_PROVIDER=vault) instead of plaintext-only.
   */
  private async encryptHighlight(entity: HighlightEntity): Promise<void> {
    await encryptPhiFields(
      this.secretsService,
      'Highlight',
      () => this.highlightRepository.encryptFieldsIntoEntity(entity, this.secretsService!),
      this.logger,
    );
  }

  /**
   * Create a manual highlight anchored to one of the consultation's persisted
   * surfaces. Verifies the parent consultation lives in the caller's tenant,
   * persists via the factory, then broadcasts `ResourceCreated`.
   */
  async createHighlight(consultationId: string, request: CreateHighlightRequest): Promise<HighlightResponse> {
    const tenantId = this.tenantId;
    const userId = this.requestUserId;

    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    await assertParentInScope(this.consultationRepository, consultationId, tenantId);

    const highlight = HighlightFactory.CreateHighlight({
      tenantId,
      consultationId,
      targetKind: request.targetKind,
      exact: request.exact,
      startOffset: request.startOffset,
      endOffset: request.endOffset,
      sourceContextItemId: request.sourceContextItemId,
      prefix: request.prefix,
      suffix: request.suffix,
      color: request.color,
      label: request.label,
      note: request.note,
      createdBy: userId ?? undefined,
    });

    // Defense-in-depth: the cross-field span invariant (endOffset >= startOffset,
    // non-empty exact) cannot be expressed with per-field class-validator rules.
    highlight.validate();

    // Encrypt free-text fields into the ciphertext columns
    // before the first persist (dual-write; plaintext is retained for the soak).
    await this.encryptHighlight(highlight);

    const saved = await this.highlightRepository.create(highlight);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      responsibleEntityId: userId ?? undefined,
      createdAt: saved.createdAt,
      data: { consultationId, targetKind: request.targetKind },
    });

    return HighlightDtoMapper.toResponse(saved);
  }

  /**
   * List all (non-deleted) highlights for a consultation, tenant-scoped. The
   * parent-in-scope check ensures a foreign-tenant consultationId returns
   * NotFound rather than another tenant's marks.
   */
  async getHighlights(consultationId: string): Promise<HighlightResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    await assertParentInScope(this.consultationRepository, consultationId, tenantId);

    const highlights = await this.highlightRepository.findByConsultation(consultationId);
    return highlights.map(HighlightDtoMapper.toResponse);
  }

  /**
   * Soft-delete a highlight via `Repository.softDelete` (sets resourceStatus =
   * DELETED). The highlight is asserted to live in the caller's tenant AND to be
   * anchored to the consultation in the route, so a cross-tenant or
   * cross-consultation id surfaces as NotFound. Broadcasts `ResourceDeleted`.
   */
  async deleteHighlight(consultationId: string, highlightId: string): Promise<void> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    const highlight = await assertParentInScope(this.highlightRepository, highlightId, tenantId);
    if (highlight.consultationId !== consultationId) {
      throw new NotFoundException('Resource not found');
    }

    const userId = this.requestUserId ?? 'system';
    await this.highlightRepository.softDelete(highlightId, userId);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: highlightId,
      responsibleEntityId: this.requestUserId ?? undefined,
      data: { consultationId, targetKind: highlight.targetKind },
    });
  }
}
