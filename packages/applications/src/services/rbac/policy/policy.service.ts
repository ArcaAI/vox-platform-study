import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PolicyFactory, PolicyRepository, ResourceStatusType, ResourceType, SysEventType } from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { PolicyEngine, type PolicyRule } from '../../../authorization/policy.engine';
import {
  CreatePolicyRequest,
  IPolicyService,
  PolicyListQuery,
  PolicyListResult,
  PolicyRecord,
  PolicyValidationResult,
  UpdatePolicyRequest,
} from './IPolicyService';

/**
 * TASK-307 W6.2 — Service that absorbs the direct-Prisma access that
 * `PoliciesController` used to perform (C-10 / F-1 / H-9).
 *
 * TASK-311 (closes the §H-9 deferral W7.A.15) — the direct
 * `CoreDatabaseService` access that W6 deliberately left behind has
 * been routed through `PolicyRepository` + `PolicyFactory`. Behaviour
 * is unchanged: every audit-event payload, every cache invalidation,
 * every log message matches the W6 wiring; the repository internally
 * issues the same Prisma calls (see
 * `packages/domains/src/repositories/policy/PolicyRepository.ts`).
 * See `docs/implementation/TASK-311-Policy-Role-Repository-Extraction/README.md`
 * for the inventory + design decisions.
 */
@Injectable()
export class PolicyService extends BaseService implements IPolicyService {
  private readonly logger = new Logger(PolicyService.name);

  private static readonly VALID_ACTIONS = ['manage', 'create', 'read', 'list', 'update', 'delete', 'archive', 'export'];

  private static readonly VALID_TEMPLATE_VARIABLES = ['user.id', 'user.tenantId', 'context.tenantId'];

  constructor(
    private readonly policyRepository: PolicyRepository,
    private readonly policyEngine: PolicyEngine,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    // TASK-307 W7.A.16 — `BaseService` is initialised with
    // `ResourceType.Permission`, NOT `ResourceType.Policy`. The
    // pre-W6 `PoliciesController` emitted SysEvents with
    // `resourceType: 'Permission'`; downstream audit-log readers
    // and notification subscribers are wired against that literal
    // string. TASK-311 AC-5 explicitly pins this. Migrating the wire
    // format to `Policy` requires a coordinated event-schema change
    // (see TASK-307 §10 deferrals).
    super(eventEmitter, clsService, ResourceType.Permission);
  }

  validateRules(rules: PolicyRule[]): PolicyValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!Array.isArray(rules)) {
      return { valid: false, errors: ['Rules must be an array'] };
    }

    if (rules.length === 0) {
      warnings.push('Policy has no rules');
    }

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const idx = i + 1;

      if (!rule.action) {
        errors.push(`Rule ${idx}: 'action' is required`);
      } else if (!PolicyService.VALID_ACTIONS.includes(rule.action)) {
        warnings.push(`Rule ${idx}: Unknown action '${rule.action}'`);
      }

      if (!rule.subject) {
        errors.push(`Rule ${idx}: 'subject' is required`);
      }

      if (rule.conditions && typeof rule.conditions !== 'object') {
        errors.push(`Rule ${idx}: 'conditions' must be an object`);
      }

      if (rule.fields && !Array.isArray(rule.fields)) {
        errors.push(`Rule ${idx}: 'fields' must be an array`);
      }

      if (rule.inverted !== undefined && typeof rule.inverted !== 'boolean') {
        errors.push(`Rule ${idx}: 'inverted' must be a boolean`);
      }

      if (rule.conditions) {
        this.checkConditionsForVariables(rule.conditions, idx, warnings);
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  async findAll(query: PolicyListQuery): Promise<PolicyListResult> {
    const { page, pageSize, search, scope } = query;
    const skip = (page - 1) * pageSize;

    const where = {
      resourceStatus: ResourceStatusType.ENABLED,
      ...(search && {
        OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { description: { contains: search, mode: 'insensitive' as const } }],
      }),
      ...(scope && { scope }),
    };

    const [data, total] = await Promise.all([
      this.policyRepository.findMany({ where, skip, take: pageSize, orderBy: { name: 'asc' } }),
      this.policyRepository.count({ where }),
    ]);

    return { data: data as unknown as PolicyRecord[], total };
  }

  async findOne(id: string): Promise<PolicyRecord | null> {
    const policy = await this.policyRepository.findById(id);
    return (policy as PolicyRecord | null) ?? null;
  }

  async create(request: CreatePolicyRequest): Promise<PolicyRecord> {
    const validation = this.validateRules(request.rules);
    if (!validation.valid) {
      throw new BadRequestException(`Invalid policy rules: ${validation.errors?.join(', ')}`);
    }

    const user = this.requestUser;
    const data = PolicyFactory.buildCreateInput({
      name: request.name,
      description: request.description,
      scope: request.scope,
      rules: request.rules,
      createdBy: user?.id,
    });
    const policy = (await this.policyRepository.create(data)) as PolicyRecord;

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: policy.id,
      data: policy as unknown as object,
    });

    this.logger.log({
      message: 'Policy created',
      policyId: policy.id,
      policyName: policy.name,
      scope: request.scope,
      rulesCount: request.rules.length,
      createdBy: user?.id,
    });

    return policy;
  }

  async update(id: string, request: UpdatePolicyRequest): Promise<PolicyRecord> {
    if (request.rules) {
      const validation = this.validateRules(request.rules);
      if (!validation.valid) {
        throw new BadRequestException(`Invalid policy rules: ${validation.errors?.join(', ')}`);
      }
    }

    const user = this.requestUser;
    const data = PolicyFactory.buildUpdateInput(request, user?.id);
    const policy = (await this.policyRepository.update(id, data)) as PolicyRecord;

    await this.policyEngine.invalidatePolicy(id);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: policy as unknown as object,
    });

    this.logger.log({
      message: 'Policy updated',
      policyId: policy.id,
      policyName: policy.name,
      updatedBy: user?.id,
    });

    return policy;
  }

  async patch(id: string, request: UpdatePolicyRequest): Promise<PolicyRecord> {
    const existing = await this.policyRepository.findById(id);
    if (!existing) {
      throw new NotFoundException('Policy not found');
    }

    if (request.rules) {
      const validation = this.validateRules(request.rules);
      if (!validation.valid) {
        throw new BadRequestException(`Invalid policy rules: ${validation.errors?.join(', ')}`);
      }
    }

    const user = this.requestUser;
    const data = PolicyFactory.buildUpdateInput(request, user?.id);
    const policy = (await this.policyRepository.update(id, data)) as PolicyRecord;

    await this.policyEngine.invalidatePolicy(id);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: policy as unknown as object,
      previousData: existing as unknown as object,
    });

    this.logger.log({
      message: 'Policy updated',
      policyId: policy.id,
      policyName: policy.name,
      updatedBy: user?.id,
    });

    return policy;
  }

  async softDelete(id: string): Promise<{ id: string; name: string }> {
    const existing = (await this.policyRepository.findById(id)) as { name: string } | null;

    if (!existing) {
      throw new NotFoundException('Policy not found');
    }

    const user = this.requestUser;
    await this.policyRepository.softDelete(id, user?.id);

    await this.policyEngine.invalidatePolicy(id);
    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: id,
      data: { name: existing.name },
    });

    this.logger.log({
      message: 'Policy deleted',
      policyId: id,
      policyName: existing.name,
      deletedBy: user?.id,
    });

    return { id, name: existing.name };
  }

  private checkConditionsForVariables(conditions: Record<string, unknown>, ruleIndex: number, warnings: string[]): void {
    const checkValue = (value: unknown, path: string) => {
      if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
        const varName = value.slice(2, -1);
        if (!PolicyService.VALID_TEMPLATE_VARIABLES.includes(varName) && !varName.startsWith('params.')) {
          warnings.push(`Rule ${ruleIndex}: Unknown variable '${varName}' at ${path}`);
        }
      } else if (typeof value === 'object' && value !== null) {
        for (const [key, val] of Object.entries(value)) {
          checkValue(val, `${path}.${key}`);
        }
      }
    };

    for (const [key, value] of Object.entries(conditions)) {
      checkValue(value, `conditions.${key}`);
    }
  }
}
