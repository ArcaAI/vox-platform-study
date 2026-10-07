import {
  ResourceStatusType,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
  TenantGuardrailPolicyEntity,
  TenantGuardrailPolicyFactory,
  TenantGuardrailPolicyRepository,
} from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { forbiddenGuardrailPolicyChanges, type GuardrailCheckDefaults } from '@arcaai/types';
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService, isSuperAdmin } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import type { GuardrailAvailabilityResponse, GuardrailPolicyCatalogueEntryResponse, UpdateGuardrailAvailabilityRequest } from './dto';
import { GuardrailAvailabilityDtoMapper } from './guardrail-availability.dto.mapper';
import { GuardrailPolicyChangePublisher } from './guardrail-policy-change.publisher';
import type { IGuardrailAvailabilityService } from './IGuardrailAvailabilityService';
import {
  GUARDRAIL_CHECK_DEFAULTS,
  GuardrailPolicySelectionError,
  assertSelectionTightensOnly,
  type GuardrailPolicySelectionSet,
  type ResolvedGuardrailAvailability,
} from './policy-catalogue';
import {
  GUARDRAIL_CHECK_LOCKED,
  assertGuardrailPolicyCoversBothDirections,
  effectiveGuardrailPolicy,
  guardrailFlatSelection,
  parsePlatformGuardrailPolicyWrite,
  stampPlatformGuardrailPolicyWrite,
  toStoredGuardrailPolicyV2,
  type StoredGuardrailPolicyV2,
} from './policy-v2';

const DEFAULTS = GUARDRAIL_CHECK_DEFAULTS as unknown as GuardrailCheckDefaults;

/**
 * Per-tenant guardrail AVAILABILITY — the PLATFORM plane of `TenantGuardrailPolicy` (README §11.1).
 *
 * ─── What this plane may set (TASK-1050) ─────────────────────────────────────
 *
 * A platform admin controls the DETAIL, per tenant and on the SYSTEM row: on/off, the action a violation
 * takes (`ignore` | `warn` | `block`), a LOCK (the tenant may then not change that check), the inbound
 * data-region action (OD-12) and thresholds. The tenant's own on/off flags live on the same row and are
 * written through `GuardrailTenantPolicyService` (`admin/guardrail/policy`). Rows are stored as v2 with
 * only the fields their writer stated, so the runtime cascades FIELD by field (platform default → SYSTEM
 * → tenant); a legacy flat row normalises on read and is rewritten as v2 on its first write.
 *
 * What is still never expressible: an unscreened direction. Every write keeps at least one check per
 * direction on (OD-8; a direction OFF is monitor only), and the catalogue-locked medical check is
 * editable by nobody (403 `GUARDRAIL_CHECK_LOCKED`).
 *
 * ─── AUTH-NOTE: SUPER_ADMIN-only, imperatively ──────────────────────────────
 *
 * Every method here calls {@link assertSuperAdmin}. The permission decorators express `action + subject`
 * and cannot express "super admins only", and a tenant admin legitimately holds `manage:Tenant` for its
 * own tenant — so the controller's decorators UNDERSTATE the real gate (rule 05 §Imperative Privilege
 * Checks). This is a 403 PRIVILEGE boundary, deliberately NOT the 404-over-403 cross-tenant posture.
 * The gate is row-independent, so it runs first: every non-platform-admin gets the same 403 for any id.
 *
 * ─── Tighten-only ───────────────────────────────────────────────────────────
 *
 * A threshold weaker than the SYSTEM row's is REFUSED with 403, never silently clamped, through the
 * settings registry's own `assertTightenOnlyFloor`.
 *
 * After every committed write `GuardrailPolicyChangePublisher` publishes `guardrail:config:invalidate`
 * and schedules the governed-prompt re-screen (fail-open).
 */
@Injectable()
export class GuardrailAvailabilityService extends BaseService implements IGuardrailAvailabilityService {
  private readonly logger = new Logger(GuardrailAvailabilityService.name);

  constructor(
    private readonly repository: TenantGuardrailPolicyRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // TASK-1050 OD-11 / TASK-1049 F2: invalidation + governed re-screen after a committed write.
    // @Optional and trailing so every positional fixture keeps its arity; unwired, a write still
    // converges on guardrail's TTL.
    @Optional() @Inject(GuardrailPolicyChangePublisher) private readonly changes?: GuardrailPolicyChangePublisher,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantGuardrailPolicy);
  }

  catalogue(): GuardrailPolicyCatalogueEntryResponse[] {
    this.assertSuperAdmin('read the guardrail policy catalogue');
    return GuardrailAvailabilityDtoMapper.toCatalogue();
  }

  async list(): Promise<GuardrailAvailabilityResponse[]> {
    this.assertSuperAdmin('list guardrail availability');

    const rows = (await this.repository.findAll({ filters: { resourceStatus: ResourceStatusType.ENABLED } })) as TenantGuardrailPolicyEntity[];
    const systemRow = rows.find((row) => row.tenantId === SYSTEM_TENANT_ID) ?? null;

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { count: rows.length } });

    return (
      rows
        // SYSTEM first: it is the tier every other row is read against.
        .sort((a, b) => (a.tenantId === SYSTEM_TENANT_ID ? -1 : b.tenantId === SYSTEM_TENANT_ID ? 1 : a.tenantId.localeCompare(b.tenantId)))
        .map((row) => this.toResponse(row.tenantId, row, systemRow))
    );
  }

  async getForTenant(tenantId: string): Promise<GuardrailAvailabilityResponse> {
    this.assertSuperAdmin('read guardrail availability');
    const row = await this.repository.findByTenantId(tenantId);
    const systemRow = tenantId === SYSTEM_TENANT_ID ? row : await this.repository.findByTenantId(SYSTEM_TENANT_ID);
    const response = this.toResponse(tenantId, row, systemRow);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: row?.id,
      data: { targetTenantId: tenantId, effectiveSourceTenantId: response.effectiveSourceTenantId },
    });

    return response;
  }

  async putForTenant(tenantId: string, request: UpdateGuardrailAvailabilityRequest): Promise<GuardrailAvailabilityResponse> {
    this.assertSuperAdmin('change guardrail availability');

    let requested: StoredGuardrailPolicyV2;
    try {
      requested = parsePlatformGuardrailPolicyWrite(request.policies);
    } catch (error) {
      if (error instanceof GuardrailPolicySelectionError) throw new BadRequestException(error.message);
      throw error;
    }

    const isSystem = tenantId === SYSTEM_TENANT_ID;
    const existing = await this.repository.findByTenantId(tenantId);
    const systemRow = isSystem ? existing : await this.repository.findByTenantId(SYSTEM_TENANT_ID);

    if (!existing && request.expectedVersion !== 0) {
      // No row yet — a create. `If-Match: "0"` declares that intent, exactly as the platform
      // storage-default path does.
      throw new OptimisticConcurrencyException('TenantGuardrailPolicy', tenantId, { expectedVersion: request.expectedVersion, currentVersion: 0 });
    }
    // OCC precondition BEFORE the content checks: a stale client gets 412 whatever it sent (RFC 9110
    // evaluates preconditions independently of the payload).
    if (existing) this.assertExpectedVersion(existing, request.expectedVersion);

    // AUTH-NOTE: the catalogue-locked check (medical validation, OD-9) is editable by NOBODY — this is the
    // frozen field guard at platform-admin strength, and the only thing it can refuse here.
    const stored = toStoredGuardrailPolicyV2(existing?.policies ?? null);
    const lockedChanges = forbiddenGuardrailPolicyChanges('platform_admin', stored, requested, DEFAULTS);
    if (lockedChanges.length > 0) {
      throw new ForbiddenException({
        message: 'Medical-domain validation is locked by the platform: always on, always block. Nobody can change it.',
        code: GUARDRAIL_CHECK_LOCKED,
        fields: lockedChanges,
      });
    }

    const next = stampPlatformGuardrailPolicyWrite(stored, requested);
    try {
      assertGuardrailPolicyCoversBothDirections(isSystem ? next : (systemRow?.policies ?? null), isSystem ? null : next);
    } catch (error) {
      if (error instanceof GuardrailPolicySelectionError) throw new BadRequestException(error.message);
      throw error;
    }
    if (!isSystem) {
      // The SYSTEM row is the floor for every OTHER tenant; it is not its own floor, so writing SYSTEM
      // skips this (a platform admin editing the platform default is the act that MOVES the floor).
      assertSelectionTightensOnly(statedThresholds(next), guardrailFlatSelection(effectiveGuardrailPolicy(systemRow?.policies ?? null, null)));
    }

    if (!existing) {
      const created = await this.repository.create(
        TenantGuardrailPolicyFactory.CreateTenantGuardrailPolicy({
          tenantId,
          policies: next as unknown as Record<string, unknown>,
          reason: request.reason ?? null,
          createdBy: this.requestUserId ?? undefined,
        }),
      );
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: created.id,
        data: { targetTenantId: tenantId, policies: next, reason: request.reason ?? null, plane: 'platform' },
      });
      await this.changes?.policyChanged(tenantId);
      return this.toResponse(tenantId, created, isSystem ? created : systemRow);
    }

    const previousVersion = existing.version;
    // A legacy row is rewritten as v2 on its first write, even when its meaning is unchanged.
    if (JSON.stringify(existing.policies ?? {}) !== JSON.stringify(next)) existing.policies = next as unknown as Record<string, unknown>;
    if (request.reason !== undefined) existing.reason = request.reason;

    if (!existing.hasChanges) {
      // PUT is idempotent (RFC 9110 §9.2.2): re-sending the stored value yields
      // the same representation, with no version bump and no phantom event.
      return this.toResponse(tenantId, existing, isSystem ? existing : systemRow);
    }

    existing.updatedBy = this.requestUserId ?? undefined;
    const saved = await this.repository.updateWithVersion(existing.id, existing, request.expectedVersion as number);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: existing.id,
      data: {
        targetTenantId: tenantId,
        policies: next,
        reason: request.reason ?? existing.reason ?? null,
        plane: 'platform',
        previousVersion,
        newVersion: saved.version,
      },
    });
    await this.changes?.policyChanged(tenantId);

    return this.toResponse(tenantId, saved, isSystem ? saved : systemRow);
  }

  // -- internals ------------------------------------------------------------

  /**
   * The response for one row: the raw stored blob, the v2 effective view (field by field, as guardrail
   * resolves it) and its legacy flat projection. The tier is attributed to the tenant when its row states
   * anything, otherwise to SYSTEM.
   */
  private toResponse(
    tenantId: string,
    row: TenantGuardrailPolicyEntity | null,
    systemRow: TenantGuardrailPolicyEntity | null,
  ): GuardrailAvailabilityResponse {
    const isSystem = tenantId === SYSTEM_TENANT_ID;
    const view = effectiveGuardrailPolicy(
      isSystem ? (row?.policies ?? null) : (systemRow?.policies ?? null),
      isSystem ? null : (row?.policies ?? null),
      'platform_admin',
    );
    const ownsOpinion =
      !isSystem &&
      Object.keys(toStoredGuardrailPolicyV2(row?.policies ?? null).checks).length +
        Object.keys(toStoredGuardrailPolicyV2(row?.policies ?? null).directions).length >
        0;
    const effective: ResolvedGuardrailAvailability = {
      policies: guardrailFlatSelection(view),
      sourceTenantId: ownsOpinion ? tenantId : SYSTEM_TENANT_ID,
    };
    return GuardrailAvailabilityDtoMapper.toResponse(tenantId, row, effective, view);
  }

  /**
   * AUTH-NOTE: the real gate. See the class doc — a 403 privilege boundary that
   * the controller's ability decorators deliberately understate.
   */
  private assertSuperAdmin(action: string): void {
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException(
        `Only a super administrator may ${action}. Guardrail is platform-managed: no tenant administrator configures it, including for their own tenant.`,
      );
    }
  }
}

/** The thresholds a row STATES, in the selection shape `assertSelectionTightensOnly` reads. */
function statedThresholds(policy: StoredGuardrailPolicyV2): GuardrailPolicySelectionSet {
  const out: Record<string, { enabled: boolean; minScore: number }> = {};
  for (const [id, entry] of Object.entries(policy.checks)) {
    if (typeof entry.minScore === 'number') out[id] = { enabled: entry.enabled ?? true, minScore: entry.minScore };
  }
  return out;
}
