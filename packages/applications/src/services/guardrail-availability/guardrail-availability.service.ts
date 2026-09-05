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
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService, isSuperAdmin } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import type { GuardrailAvailabilityResponse, GuardrailPolicyCatalogueEntryResponse, UpdateGuardrailAvailabilityRequest } from './dto';
import { GuardrailAvailabilityDtoMapper } from './guardrail-availability.dto.mapper';
import type { IGuardrailAvailabilityService } from './IGuardrailAvailabilityService';
import {
  GuardrailPolicySelectionError,
  assertBothDirectionsCovered,
  assertSelectionTightensOnly,
  normalizeSelection,
  resolveAvailability,
  type GuardrailPolicySelectionSet,
} from './policy-catalogue';

/**
 * Per-tenant guardrail AVAILABILITY — WHICH safety policies apply to a tenant.
 *
 * ─── The owner's decision (TASK-870 target model #5, decision #3) ────────────
 *
 * "Guardrail is built-in and platform-only … No tenant admin manages any
 * guardrail setting." Availability is POLICY SELECTION, never gate removal:
 * every request is still screened before send and every response after receive.
 * The three places that guarantee it:
 *
 *   1. `resolveAvailability` widens to the SYSTEM set on ABSENCE — and an empty
 *      or all-disabled selection COUNTS as absence, so "off" is not expressible;
 *   2. even an unseeded SYSTEM row resolves to the built-in
 *      `PLATFORM_DEFAULT_GUARDRAIL_POLICIES`, so a cold database still screens;
 *   3. `apps/guardrail`'s screener records a de-selected check as `skipped` on
 *      the decision rather than dropping it, and always composes a verdict.
 *
 * ─── AUTH-NOTE: SUPER_ADMIN-only, imperatively ──────────────────────────────
 *
 * Every method here calls {@link assertSuperAdmin}. The permission decorators
 * express `action + subject` and cannot express "super admins only", and a
 * tenant admin legitimately holds `manage:Tenant` for its own tenant — so the
 * controller's decorators UNDERSTATE the real gate (rule 05 §Imperative
 * Privilege Checks). This is a 403 PRIVILEGE boundary, deliberately NOT the
 * 404-over-403 cross-tenant posture: the caller is being told it may not
 * administer guardrail at all, including for its own tenant, and hiding that
 * behind a 404 would misdescribe it as "no such tenant".
 *
 * Because the gate is privilege-first, there is no tenant-ownership branch to
 * order after an existence lookup — the split-gate ordering rule (resolve
 * existence, then privilege) does not apply: no caller ever gets past
 * `assertSuperAdmin`, so no id-space oracle exists.
 *
 * ─── Tighten-only ───────────────────────────────────────────────────────────
 *
 * A tenant's set may NARROW which policies run — that is the surface's purpose,
 * and only a platform admin can do it. What may never loosen is a policy's
 * STRICTNESS: a threshold weaker than the SYSTEM row's is REFUSED with 403,
 * never silently clamped, through the settings registry's own
 * `assertTightenOnlyFloor`.
 */
@Injectable()
export class GuardrailAvailabilityService extends BaseService implements IGuardrailAvailabilityService {
  private readonly logger = new Logger(GuardrailAvailabilityService.name);

  constructor(
    private readonly repository: TenantGuardrailPolicyRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
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
    const systemPolicies = GuardrailAvailabilityDtoMapper.asSelectionSet(rows.find((row) => row.tenantId === SYSTEM_TENANT_ID) ?? null);

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { count: rows.length } });

    return rows
      // SYSTEM first: it is the tier every other row is read against.
      .sort((a, b) => (a.tenantId === SYSTEM_TENANT_ID ? -1 : b.tenantId === SYSTEM_TENANT_ID ? 1 : a.tenantId.localeCompare(b.tenantId)))
      .map((row) =>
        GuardrailAvailabilityDtoMapper.toResponse(
          row.tenantId,
          row,
          resolveAvailability(GuardrailAvailabilityDtoMapper.asSelectionSet(row), systemPolicies, row.tenantId),
        ),
      );
  }

  async getForTenant(tenantId: string): Promise<GuardrailAvailabilityResponse> {
    this.assertSuperAdmin('read guardrail availability');
    const { row, effective } = await this.load(tenantId);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: row?.id,
      data: { targetTenantId: tenantId, effectiveSourceTenantId: effective.sourceTenantId },
    });

    return GuardrailAvailabilityDtoMapper.toResponse(tenantId, row, effective);
  }

  async putForTenant(tenantId: string, request: UpdateGuardrailAvailabilityRequest): Promise<GuardrailAvailabilityResponse> {
    this.assertSuperAdmin('change guardrail availability');

    let policies: GuardrailPolicySelectionSet;
    try {
      policies = normalizeSelection(request.policies);
      assertBothDirectionsCovered(policies);
    } catch (error) {
      if (error instanceof GuardrailPolicySelectionError) throw new BadRequestException(error.message);
      throw error;
    }

    const systemRow = tenantId === SYSTEM_TENANT_ID ? null : await this.repository.findByTenantId(SYSTEM_TENANT_ID);
    if (systemRow) {
      // The SYSTEM row is the floor for every OTHER tenant; it is not its own
      // floor, so writing SYSTEM skips this entirely (a platform admin editing
      // the platform default is the act that MOVES the floor).
      assertSelectionTightensOnly(policies, GuardrailAvailabilityDtoMapper.asSelectionSet(systemRow) ?? {});
    }

    const existing = tenantId === SYSTEM_TENANT_ID ? systemRow ?? (await this.repository.findByTenantId(SYSTEM_TENANT_ID)) : await this.repository.findByTenantId(tenantId);

    if (!existing) {
      if (request.expectedVersion !== 0) {
        // No row yet — a create. `If-Match: "0"` declares that intent, exactly
        // as the platform storage-default path does.
        throw new OptimisticConcurrencyException('TenantGuardrailPolicy', tenantId, {
          expectedVersion: request.expectedVersion,
          currentVersion: 0,
        });
      }
      const created = await this.repository.create(
        TenantGuardrailPolicyFactory.CreateTenantGuardrailPolicy({
          tenantId,
          policies: policies as unknown as Record<string, unknown>,
          reason: request.reason ?? null,
          createdBy: this.requestUserId ?? undefined,
        }),
      );
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: created.id,
        data: { targetTenantId: tenantId, policies, reason: request.reason ?? null },
      });
      return GuardrailAvailabilityDtoMapper.toResponse(tenantId, created, await this.effectiveFor(tenantId, created));
    }

    // OCC precondition BEFORE the no-changes short-circuit: a stale client gets
    // 412 even when the payload would change nothing (RFC 7232 evaluates
    // preconditions independently of the payload).
    this.assertExpectedVersion(existing, request.expectedVersion);

    const previousVersion = existing.version;
    existing.policies = policies as unknown as Record<string, unknown>;
    if (request.reason !== undefined) existing.reason = request.reason;

    if (!existing.hasChanges) {
      // PUT is idempotent (RFC 9110 §9.2.2): re-sending the stored value yields
      // the same representation, with no version bump and no phantom event.
      return GuardrailAvailabilityDtoMapper.toResponse(tenantId, existing, await this.effectiveFor(tenantId, existing));
    }

    existing.updatedBy = this.requestUserId ?? undefined;
    const saved = await this.repository.updateWithVersion(existing.id, existing, request.expectedVersion as number);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: existing.id,
      data: { targetTenantId: tenantId, policies, reason: request.reason ?? existing.reason ?? null, previousVersion, newVersion: saved.version },
    });

    return GuardrailAvailabilityDtoMapper.toResponse(tenantId, saved, await this.effectiveFor(tenantId, saved));
  }

  // -- internals ------------------------------------------------------------

  private async load(tenantId: string): Promise<{ row: TenantGuardrailPolicyEntity | null; effective: ReturnType<typeof resolveAvailability> }> {
    const row = await this.repository.findByTenantId(tenantId);
    return { row, effective: await this.effectiveFor(tenantId, row) };
  }

  private async effectiveFor(tenantId: string, row: TenantGuardrailPolicyEntity | null): Promise<ReturnType<typeof resolveAvailability>> {
    const systemRow = tenantId === SYSTEM_TENANT_ID ? row : await this.repository.findByTenantId(SYSTEM_TENANT_ID);
    return resolveAvailability(
      GuardrailAvailabilityDtoMapper.asSelectionSet(row),
      GuardrailAvailabilityDtoMapper.asSelectionSet(systemRow),
      tenantId,
    );
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
