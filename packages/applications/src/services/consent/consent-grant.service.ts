import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConsentGrantEntity, ConsentGrantFactory, ConsentGrantRepository, ResourceType, SysEventType } from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { IConsentGrantService } from './IConsentGrantService';
import { CreateConsentGrantRequest, RevokeConsentGrantRequest, ConsentGrantResponse } from './dto';
import { ConsentGrantDtoMapper } from './consent-grant.dto.mapper';
import { assertEqualTenants, BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { CONSENT_INVALIDATE_EVENT, normalizeExternalPatientId } from './consent.constants';

/**
 * Admin CRUD for `ConsentGrant` (TASK-712, consent-abac).
 *
 * This service does NOT evaluate consent for a caller — that is
 * `ConsultationConsentService.assertConsent`/`checkConsent`, the ABAC choke
 * point. This service only creates and revokes grant rows.
 *
 * WORM ledger: create/revoke broadcast the standard `AuditLog` sys-event
 * (`ResourceCreated`/`ResourceUpdated`) like every other application
 * service — they do NOT write to `HarnessAuditEvent`. See
 * docs/implementation/TASK-712-Consent-Abac/consent-design.md §6 for why.
 */
@Injectable()
export class ConsentGrantService extends BaseService implements IConsentGrantService {
  constructor(
    private readonly consentGrantRepository: ConsentGrantRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.ConsentGrant);
  }

  /**
   * One row per (tenant, externalPatientId, purpose) among ACTIVE
   * (non-revoked) grants — enforced by the partial unique index
   * `ConsentGrant_tenant_patient_purpose_active_key` (WHERE "revokedAt" IS
   * NULL). A second `create` for the same triple fails at the database ONLY
   * while an active grant already exists; `revoke` then `create` again (or
   * widening — consent-design.md §3) both work, because the revoked row no
   * longer occupies the active slot.
   */
  async create(request: CreateConsentGrantRequest): Promise<ConsentGrantResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new ArgumentInvalidException('Tenant context required');
    }
    const externalPatientId = normalizeExternalPatientId(request.externalPatientId);

    const entity = ConsentGrantFactory.CreateConsentGrant({
      tenantId,
      externalPatientId,
      purpose: request.purpose,
      scope: request.scope ?? null,
      grantedAt: request.grantedAt ? new Date(request.grantedAt) : undefined,
      grantedBy: this.requestUser?.id ?? 'system',
      grantMethod: request.grantMethod,
      evidenceRef: request.evidenceRef ?? null,
      expiresAt: request.expiresAt ? new Date(request.expiresAt) : null,
      createdBy: this.requestUser?.id,
    });

    const saved = await this.consentGrantRepository.create(entity);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { externalPatientId: saved.externalPatientId, purpose: saved.purpose, grantMethod: saved.grantMethod },
    });

    this.eventEmitter.emit(CONSENT_INVALIDATE_EVENT, { tenantId, externalPatientId, purpose: saved.purpose });

    return ConsentGrantDtoMapper.toResponse(saved);
  }

  /**
   * OCC-versioned revoke. Load-then-assert defense-in-depth: a cross-tenant
   * id 404s BEFORE the CAS write fires (never mutated), same posture as
   * `WebhookService.update`.
   */
  async revoke(id: string, request: RevokeConsentGrantRequest): Promise<ConsentGrantResponse> {
    const entity: ConsentGrantEntity = await this.consentGrantRepository.findById(id);
    assertEqualTenants(entity, { tenantId: this.tenantId });

    entity.revoke(this.requestUser?.id ?? 'system', request.reason ?? null);

    if (!entity.hasChanges) {
      throw new ArgumentInvalidException('Grant is already revoked.');
    }

    const previousVersion = entity.version;
    const updated = await this.consentGrantRepository.updateWithVersion(id, entity, request.expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { ...entity.changes, previousVersion, newVersion: updated.version },
    });

    this.eventEmitter.emit(CONSENT_INVALIDATE_EVENT, {
      tenantId: updated.tenantId,
      externalPatientId: updated.externalPatientId,
      purpose: updated.purpose,
    });

    return ConsentGrantDtoMapper.toResponse(updated);
  }

  async getByPatient(externalPatientId: string): Promise<ConsentGrantResponse[]> {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new ArgumentInvalidException('Tenant context required');
    }
    const normalized = normalizeExternalPatientId(externalPatientId);
    const grants = await this.consentGrantRepository.findByTenantAndPatient(tenantId, normalized);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { externalPatientId: normalized, items: grants.map((g) => g.id) },
    });

    return grants.map((g) => ConsentGrantDtoMapper.toResponse(g));
  }
}
