import {
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
  TenantGuardrailPolicyEntity,
  TenantGuardrailPolicyFactory,
  TenantGuardrailPolicyRepository,
} from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { forbiddenGuardrailPolicyChanges, guardrailPolicyEditableFields, type GuardrailCheckDefaults } from '@arcaai/types';
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService, isSuperAdmin } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import type { TenantGuardrailPolicyResponse, UpdateTenantGuardrailPolicyRequest } from './dto';
import { GuardrailAvailabilityDtoMapper } from './guardrail-availability.dto.mapper';
import { GuardrailPolicyChangePublisher } from './guardrail-policy-change.publisher';
import type { IGuardrailTenantPolicyService } from './IGuardrailTenantPolicyService';
import { GUARDRAIL_CHECK_DEFAULTS, GuardrailPolicySelectionError, guardrailPolicy } from './policy-catalogue';
import {
  GUARDRAIL_CHECK_LOCKED,
  GUARDRAIL_FIELD_PLATFORM_ONLY,
  applyGuardrailPolicyChanges,
  assertGuardrailPolicyCoversBothDirections,
  diffGuardrailPolicyAgainstEffective,
  effectiveGuardrailPolicy,
  isEmptyStoredGuardrailPolicy,
  parseTenantGuardrailPolicyWrite,
  toStoredGuardrailPolicyV2,
  withGuardrailPlatformLocks,
  type GuardrailPolicyViewer,
  type SubmittedGuardrailPolicy,
} from './policy-v2';

const DEFAULTS = GUARDRAIL_CHECK_DEFAULTS as unknown as GuardrailCheckDefaults;

/**
 * `GET/PUT admin/guardrail/policy` — the CALLER tenant's guardrail rules (README §11.1).
 *
 * ─── AUTH-NOTE: a FIELD-LEVEL split gate ─────────────────────────────────────
 *
 * The decorators (`read`/`manage:TenantGuardrailPolicy`, granted to the seeded tenant admin) say who may
 * reach the route. They cannot say WHICH FIELDS a caller may change, so this service decides, in this
 * order:
 *
 *   1. EXISTENCE (404-over-403). The target is the CLS working tenant. A non-super-admin whose own tenant
 *      is not that tenant gets 404 — another tenant's row is never acknowledged. No working tenant is 400.
 *   2. TIER (403, row-independent). The SYSTEM row is the platform default every tenant inherits; it is
 *      written only through the platform route (`admin/guardrail/availability/:tenantId`).
 *   3. FIELDS (403). Only fields whose submitted value DIFFERS from the policy in force count. A TENANT
 *      ADMIN may change `directions.<dir>.enabled` and `checks.<id>.enabled` of a check no lock holds —
 *      `guardrailPolicyEditableFields('tenant_admin', …)` from the frozen contract, judged on the tenant
 *      row with the SYSTEM row's platform locks folded in. Anything else is 403
 *      `GUARDRAIL_FIELD_PLATFORM_ONLY` naming the fields; the catalogue-locked medical check is 403
 *      `GUARDRAIL_CHECK_LOCKED` for everyone. A SUPER ADMIN on this route is a platform admin (it acts on
 *      its working tenant with the platform caller class), never weaker than its own route.
 *
 * Then the two write rules every guardrail write keeps: at least one check per direction stays on (OD-8;
 * a direction OFF is monitor only, not ungated, so it is allowed), and an OCC precondition
 * (`If-Match: "0"` creates the row, a stale version is 412).
 */
@Injectable()
export class GuardrailTenantPolicyService extends BaseService implements IGuardrailTenantPolicyService {
  constructor(
    private readonly repository: TenantGuardrailPolicyRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(GuardrailPolicyChangePublisher) private readonly changes?: GuardrailPolicyChangePublisher,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantGuardrailPolicy);
  }

  async getOwn(): Promise<TenantGuardrailPolicyResponse> {
    const tenantId = this.targetTenant();
    const [row, systemRow] = await Promise.all([this.repository.findByTenantId(tenantId), this.repository.findByTenantId(SYSTEM_TENANT_ID)]);
    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: row?.id, data: { targetTenantId: tenantId } });
    return GuardrailAvailabilityDtoMapper.toTenantPolicyResponse(tenantId, row, systemRow, this.viewer());
  }

  async putOwn(request: UpdateTenantGuardrailPolicyRequest): Promise<TenantGuardrailPolicyResponse> {
    const tenantId = this.targetTenant();
    this.assertNotSystemTier(tenantId);

    const submitted = this.parse(request);
    const [existing, systemRow] = await Promise.all([this.repository.findByTenantId(tenantId), this.repository.findByTenantId(SYSTEM_TENANT_ID)]);
    this.assertPrecondition(tenantId, existing, request.expectedVersion);

    const viewer = this.viewer();
    const stored = toStoredGuardrailPolicyV2(existing?.policies ?? null);
    const system = toStoredGuardrailPolicyV2(systemRow?.policies ?? null);
    const changed = diffGuardrailPolicyAgainstEffective(submitted, effectiveGuardrailPolicy(systemRow?.policies ?? null, existing?.policies ?? null, viewer));

    const guardBefore = withGuardrailPlatformLocks(stored, system);
    const editable = new Set(guardrailPolicyEditableFields(viewer, guardBefore, DEFAULTS));
    this.refuseIfForbidden(changed.filter((field) => !editable.has(field)));

    const next = applyGuardrailPolicyChanges(stored, submitted, changed, viewer);
    // The frozen contract's own field guard, as the last word on the row that would be stored.
    this.refuseIfForbidden(forbiddenGuardrailPolicyChanges(viewer, guardBefore, withGuardrailPlatformLocks(next, system), DEFAULTS));

    if (changed.length === 0 && existing) {
      // PUT is idempotent: re-sending what is in force yields the same representation, no bump, no event.
      return GuardrailAvailabilityDtoMapper.toTenantPolicyResponse(tenantId, existing, systemRow, viewer);
    }
    this.assertCoverage(systemRow?.policies ?? null, next);

    if (!existing) {
      if (changed.length === 0 && isEmptyStoredGuardrailPolicy(next)) {
        return GuardrailAvailabilityDtoMapper.toTenantPolicyResponse(tenantId, null, systemRow, viewer);
      }
      const created = await this.repository.create(
        TenantGuardrailPolicyFactory.CreateTenantGuardrailPolicy({
          tenantId,
          policies: next as unknown as Record<string, unknown>,
          reason: null,
          createdBy: this.requestUserId ?? undefined,
        }),
      );
      this.broadcastSysEvent(SysEventType.ResourceCreated, { resourceId: created.id, data: { targetTenantId: tenantId, changed, plane: 'tenant' } });
      await this.changes?.policyChanged(tenantId);
      return GuardrailAvailabilityDtoMapper.toTenantPolicyResponse(tenantId, created, systemRow, viewer);
    }

    const previousVersion = existing.version;
    existing.policies = next as unknown as Record<string, unknown>;
    existing.updatedBy = this.requestUserId ?? undefined;
    const saved = await this.repository.updateWithVersion(existing.id, existing, request.expectedVersion as number);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: existing.id,
      data: { targetTenantId: tenantId, changed, plane: 'tenant', previousVersion, newVersion: saved.version },
    });
    await this.changes?.policyChanged(tenantId);
    return GuardrailAvailabilityDtoMapper.toTenantPolicyResponse(tenantId, saved, systemRow, viewer);
  }

  // -- internals ------------------------------------------------------------

  /** AUTH-NOTE step 1: existence first. */
  private targetTenant(): string {
    const tenantId = this.clsService.get('tenantId');
    if (!tenantId) throw new BadRequestException({ message: 'Select a working tenant to read or change its guardrail rules.', code: 'WORKING_TENANT_REQUIRED' });
    const user = this.requestUser;
    if (!isSuperAdmin(user) && user?.tenantId && user.tenantId !== tenantId) {
      throw new NotFoundException('Guardrail policy not found');
    }
    return tenantId;
  }

  /** AUTH-NOTE step 2: the platform tier is not a tenant's to write (row-independent, 403). */
  private assertNotSystemTier(tenantId: string): void {
    if (tenantId === SYSTEM_TENANT_ID) {
      throw new ForbiddenException({
        message: 'The platform default guardrail rules are written through admin/guardrail/availability/:tenantId, by a super administrator.',
        code: GUARDRAIL_FIELD_PLATFORM_ONLY,
        fields: [],
      });
    }
  }

  private viewer(): GuardrailPolicyViewer {
    return isSuperAdmin(this.requestUser) ? 'platform_admin' : 'tenant_admin';
  }

  private parse(request: UpdateTenantGuardrailPolicyRequest): SubmittedGuardrailPolicy {
    try {
      const body: Record<string, unknown> = {};
      if (request.directions !== undefined) body.directions = request.directions;
      body.checks = request.checks ?? {};
      return parseTenantGuardrailPolicyWrite(body);
    } catch (error) {
      if (error instanceof GuardrailPolicySelectionError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /** OCC before the field gate: a stale client gets 412 whatever it sent (RFC 9110 preconditions). */
  private assertPrecondition(tenantId: string, existing: TenantGuardrailPolicyEntity | null, expectedVersion: number | undefined): void {
    if (existing) {
      this.assertExpectedVersion(existing, expectedVersion);
      return;
    }
    if (expectedVersion !== 0) {
      throw new OptimisticConcurrencyException('TenantGuardrailPolicy', tenantId, { expectedVersion, currentVersion: 0 });
    }
  }

  /** AUTH-NOTE step 3. */
  private refuseIfForbidden(fields: readonly string[]): void {
    if (fields.length === 0) return;
    const lockedByCatalogue = fields.some((field) => {
      const [section, id] = field.split('.');
      return section === 'checks' && guardrailPolicy(id ?? '')?.locked === true;
    });
    throw new ForbiddenException({
      message: lockedByCatalogue
        ? 'Medical-domain validation is locked by the platform: always on, always block. Nobody can change it.'
        : 'Only a platform administrator may change these guardrail fields. A tenant administrator turns unlocked checks and screening directions on or off.',
      code: lockedByCatalogue ? GUARDRAIL_CHECK_LOCKED : GUARDRAIL_FIELD_PLATFORM_ONLY,
      fields: [...fields],
    });
  }

  private assertCoverage(systemPolicies: unknown, next: unknown): void {
    try {
      assertGuardrailPolicyCoversBothDirections(systemPolicies, next);
    } catch (error) {
      if (error instanceof GuardrailPolicySelectionError) throw new BadRequestException(error.message);
      throw error;
    }
  }
}
