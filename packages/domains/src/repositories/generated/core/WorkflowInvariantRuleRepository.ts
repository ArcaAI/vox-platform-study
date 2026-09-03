import { Injectable } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/database';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { WorkflowInvariantRuleEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { WorkflowInvariantRuleEntityMapper } from '../../../mappers';
import { WorkflowInvariantRule } from '../../../models';

/**
 * The validator's rule rows (b) — the DATA half of the
 * "code-owned predicate types, data-owned rule instances" split.
 *
 * `WorkflowInvariantRule` is BOTH tenant-scoped and a SYSTEM-shared read model
 * (`packages/database/src/extensions/tenant-scope.ts`), which is what makes the
 * two-tier read below legal: a tenant reads its OWN rows AND the SYSTEM
 * platform rule set, but the widening covers READS only — a tenant can never
 * mutate a SYSTEM-owned row. That one-way-strictness rule is enforced in the
 * application service, not here (the repository is deliberately not a policy
 * layer).
 */
@Injectable()
export class WorkflowInvariantRuleRepository extends Repository<WorkflowInvariantRuleEntity, WorkflowInvariantRule> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'workflowInvariantRule', WorkflowInvariantRuleEntityMapper.getInstance());
  }

  /**
   * Every ENABLED rule that applies to `(tenantId, paletteKey)`: the tenant's own
   * rows UNION the SYSTEM platform register, with palette-agnostic rows
   * (`paletteKey: null`, the structural class) always included.
   *
   * Two explicit-`tenantId` reads rather than one `OR`, mirroring
   * `PipelinePolicyRepository.findCascadeRows` / `findSystemDefault`: the
   * tenant-scope extension asserts an explicit `where.tenantId` equals the
   * caller's own context tenant unless the model is SYSTEM-shared, and the
   * SYSTEM rows live under a DIFFERENT tenant id. Keeping the two reads
   * separate makes the union visible in code instead of implied by the
   * extension.
   *
   * The caller (`WorkflowValidatorService`) merges the two lists and applies
   * the one-way-strictness rule — a tenant row with the same `ruleId` as a
   * SYSTEM row may only RAISE severity, never lower it.
   */
  async findApplicable(tenantId: string, paletteKey: string | null): Promise<WorkflowInvariantRuleEntity[]> {
    // `paletteKey: null` rows apply to every palette, so they are always in scope.
    const paletteFilter = paletteKey === null ? { paletteKey: null } : { OR: [{ paletteKey }, { paletteKey: null }] };

    const own = await this.findAll({
      filters: { tenantId, resourceStatus: ResourceStatusType.ENABLED },
      where: paletteFilter,
    });

    if (tenantId === SYSTEM_TENANT_ID) return own;

    const system = await this.findAll({
      filters: { tenantId: SYSTEM_TENANT_ID, resourceStatus: ResourceStatusType.ENABLED },
      where: paletteFilter,
    });

    return [...system, ...own];
  }

  /**
   * The highest `ruleVersion` among the rules that apply to
   * `(tenantId, paletteKey)` — the value stamped onto a `ValidationReport` as
   * `ruleSetVersion`, and the trigger the re-validation sweep compares against
   * to decide a published definition `NEEDS_REVIEW`.
   *
   * `0` when no rule applies, so an empty rule set is distinguishable from
   * version 1 (`ruleVersion` is a positive integer by entity invariant).
   */
  async findMaxRuleVersion(tenantId: string, paletteKey: string | null): Promise<number> {
    const rules = await this.findApplicable(tenantId, paletteKey);
    return rules.reduce((max, rule) => (rule.ruleVersion > max ? rule.ruleVersion : max), 0);
  }
}
