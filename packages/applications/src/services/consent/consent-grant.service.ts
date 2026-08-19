import { Inject, Injectable, InternalServerErrorException, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConsentGrantEntity, ConsentGrantFactory, ConsentGrantRepository, HarnessAuditAction, ResourceType, SysEventType } from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { IConsentGrantService } from './IConsentGrantService';
import { CreateConsentGrantRequest, RevokeConsentGrantRequest, ConsentGrantResponse } from './dto';
import { ConsentGrantDtoMapper } from './consent-grant.dto.mapper';
import { assertEqualTenants, BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { CONSENT_INVALIDATE_EVENT, normalizeExternalPatientId } from './consent.constants';
import { HarnessAuditService } from '../harness-audit/harness-audit.service';

/**
 * Admin CRUD for `ConsentGrant` (TASK-712, consent-abac).
 *
 * This service does NOT evaluate consent for a caller — that is
 * `ConsultationConsentService.assertConsent`/`checkConsent`, the ABAC choke
 * point. This service only creates and revokes grant rows.
 *
 * WORM ledger (Phase 4 follow-up): create/revoke broadcast the standard
 * `AuditLog` sys-event (`ResourceCreated`/`ResourceUpdated`) like every other
 * application service, AND append a `CONSENT_GIVEN`/`CONSENT_WITHDRAWN` row
 * to the hash-chained `HarnessAuditEvent` ledger — giving those two
 * previously-dead enum members real writers (README acceptance criterion).
 * `consultationId` is `null` on these rows: a grant/revoke is keyed on
 * `(tenantId, externalPatientId, purpose)`, not a consultation — see
 * `harness.prisma`'s field comment and `consent-design.md` §6 for the
 * hash-compatibility reasoning that makes the column nullable in the first
 * place. `modelName`/`modelVersion`/`sensorScores`/`citations` carry the same
 * sentinel shape `SummaryService.approveSummary` already uses for the
 * clinician-attestation `ATTEST` event (a human action, not a model run).
 */
@Injectable()
export class ConsentGrantService extends BaseService implements IConsentGrantService {
  private readonly logger = new Logger(ConsentGrantService.name);

  constructor(
    private readonly consentGrantRepository: ConsentGrantRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional + trailing (mirrors SummaryService's ATTEST wiring): existing
    // positional test fixtures keep compiling; production DI
    // (ConsentGrantServiceModule) always supplies it, which is what makes the
    // WORM append fail-closed in production (see create()/revoke() below).
    @Optional() @Inject(HarnessAuditService) private readonly harnessAuditService?: HarnessAuditService,
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

    // WORM ledger write — fail-closed, same posture as `SummaryService`'s
    // ATTEST append: an audit-append failure propagates and the caller sees
    // create() reject (never a success-shaped response for an ungranted
    // audit trail). See the class docblock for why consultationId is null.
    await this.appendWormEvent(HarnessAuditAction.CONSENT_GIVEN, saved, tenantId);

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

    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(entity, request.expectedVersion);
    if (!entity.hasChanges) {
      throw new ArgumentInvalidException('Grant is already revoked.');
    }

    const previousVersion = entity.version;
    const updated = await this.consentGrantRepository.updateWithVersion(id, entity, request.expectedVersion);

    // WORM ledger write — see create()'s comment for the fail-closed posture
    // and the null-consultationId reasoning.
    await this.appendWormEvent(HarnessAuditAction.CONSENT_WITHDRAWN, updated, updated.tenantId);

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

  /**
   * Append one CONSENT_GIVEN/CONSENT_WITHDRAWN row to the WORM ledger.
   * `consultationId: null` — a grant/revoke has no consultation (see class
   * docblock). `modelName`/`modelVersion`/`sensorScores`/`citations` are the
   * same sentinel shape `SummaryService.approveSummary` uses for ATTEST (a
   * human action, not a model run) — this is the established precedent for a
   * clinical WORM row with no model/generation to describe, not a new
   * convention invented here.
   *
   * `@Optional()` in the constructor means this is a genuine no-op (not a
   * throw) when `harnessAuditService` is unset — production DI
   * (`ConsentServiceModule`) always supplies it, so the no-op path is
   * exercised only by unit fixtures that construct this service directly.
   */
  private async appendWormEvent(action: HarnessAuditAction, grant: ConsentGrantEntity, tenantId: string): Promise<void> {
    if (!this.harnessAuditService) {
      return;
    }
    try {
      await this.harnessAuditService.append({
        tenantId,
        consultationId: null,
        action,
        modelName: 'consent-administration',
        modelVersion: 'v1',
        sensorScores: {},
        citations: [],
        clinicianId: action === HarnessAuditAction.CONSENT_GIVEN ? grant.grantedBy : (grant.revokedBy ?? grant.grantedBy),
        createdBy: action === HarnessAuditAction.CONSENT_GIVEN ? grant.grantedBy : (grant.revokedBy ?? grant.grantedBy),
      });
    } catch (error) {
      this.logger.error({
        message: 'ConsentGrantService: WORM audit append failed — the mutation already committed but is NOT reflected on the ledger',
        action,
        grantId: grant.id,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error instanceof Error ? error : new InternalServerErrorException('Failed to append ConsentGrant WORM audit event');
    }
  }
}
