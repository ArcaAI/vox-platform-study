import { Injectable, Inject, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  PolicyFactory,
  PolicyRepository,
  ResourceStatusType,
  ResourceType,
  RolePolicyRepository,
  SysEventType,
  SYSTEM_TENANT_ID,
  UserRepository,
} from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { PolicyEngine, type PolicyRule } from '../../../authorization/policy.engine';
import { ICryptoService } from '../../crypto/ICryptoService';
import { BreakGlassCredentials, BreakGlassOutcome, checkBreakGlass, RBAC_BREAK_GLASS_AUDIT_ACTION } from '../breakGlass';
import {
  CreatePolicyRequest,
  IPolicyService,
  PolicyListQuery,
  PolicyListResult,
  PolicyRecord,
  PolicyValidationResult,
  UpdatePolicyRequest,
} from './IPolicyService';

/** Minimal row shape the TASK-390/409 guards need from `findById`. */
interface PolicyGuardRow {
  id: string;
  name: string;
  isProtected?: boolean;
  rules?: unknown;
}

/** TASK-409 — operations that can produce a break-glass audit row. */
type BreakGlassOperation = 'policy-delete' | 'policy-edit' | 'policy-rule-edit';

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

  /**
   * TASK-390 #22 (R3) — AUTH-SENSITIVE. The seeded system-critical GLOBAL
   * policies that back super-admin / RBAC administration platform-wide.
   * Deleting, disabling, re-scoping, or stripping the load-bearing rule from
   * any of these would lock every super-admin out — so the service refuses
   * those mutations regardless of caller (even SUPER_ADMIN). Everything else
   * (all TENANT policies + any non-protected GLOBAL policy) stays fully
   * editable. Protected by NAME (stable, matches `01-policy.ts`); the required
   * rule tuples are the minimum grant each policy must retain.
   *
   * TASK-409 — the name match is now the LEGACY fallback: the primary marker
   * is the `Policy.isProtected` column (rename-proof, seeded true for the two
   * system policies, read-only through the API). A policy is protected when
   * `isProtected === true` OR its name matches this map (defense in depth for
   * databases that have not re-run the seed).
   */
  private static readonly PROTECTED_SYSTEM_POLICIES: Record<string, ReadonlyArray<{ action: string; subject: string }>> = {
    'system-full-access': [{ action: 'manage', subject: 'all' }],
    'rbac-system-manage': [
      { action: 'manage', subject: 'Role' },
      { action: 'manage', subject: 'Policy' },
      { action: 'manage', subject: 'RolePolicy' },
      { action: 'manage', subject: 'UserRoleAssignment' },
    ],
  };

  /**
   * TASK-409 — the universe of system-critical grants. For a protected policy
   * whose name is NOT in the legacy map (i.e. it was renamed and only the
   * `isProtected` marker identifies it), a rules edit must retain whichever
   * of these grants the policy currently carries.
   */
  private static readonly SYSTEM_CRITICAL_RULES: ReadonlyArray<{ action: string; subject: string }> = [
    { action: 'manage', subject: 'all' },
    { action: 'manage', subject: 'Role' },
    { action: 'manage', subject: 'Policy' },
    { action: 'manage', subject: 'RolePolicy' },
    { action: 'manage', subject: 'UserRoleAssignment' },
  ];

  constructor(
    private readonly policyRepository: PolicyRepository,
    private readonly policyEngine: PolicyEngine,
    private readonly rolePolicyRepository: RolePolicyRepository,
    private readonly userRepository: UserRepository,
    @Inject(ICryptoService) private readonly cryptoService: ICryptoService,
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
    // TASK-409 — `isProtected` is read-only through the API.
    this.rejectExplicitIsProtectedWrite(request);

    // TASK-390 #22 — refuse mutations that would neutralise a system-critical
    // policy. `update` (unlike `patch`) did not previously read the row; the
    // guard fetches it (skips silently when the row is absent/non-protected).
    const existingForGuard = (await this.policyRepository.findById(id)) as PolicyGuardRow | null;
    if (existingForGuard) this.assertProtectedMutationAllowed(existingForGuard, request);

    if (request.rules) {
      const validation = this.validateRules(request.rules);
      if (!validation.valid) {
        throw new BadRequestException(`Invalid policy rules: ${validation.errors?.join(', ')}`);
      }
    }

    // TASK-409 — rule-edits with a multi-role blast radius need break-glass.
    const breakGlassUsed = existingForGuard ? await this.requireRuleEditBreakGlass(existingForGuard, request) : false;

    const user = this.requestUser;
    const data = PolicyFactory.buildUpdateInput(request, user?.id);
    const policy = (await this.policyRepository.update(id, data)) as PolicyRecord;

    if (breakGlassUsed && existingForGuard) {
      this.emitBreakGlassAudit('policy-rule-edit', 'confirmed', { policyId: id, policyName: existingForGuard.name });
    }

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
    // TASK-409 — `isProtected` is read-only through the API.
    this.rejectExplicitIsProtectedWrite(request);

    const existing = await this.policyRepository.findById(id);
    if (!existing) {
      throw new NotFoundException('Policy not found');
    }

    // TASK-390 #22 — protect system-critical policies from destructive edits.
    this.assertProtectedMutationAllowed(existing as PolicyGuardRow, request);

    if (request.rules) {
      const validation = this.validateRules(request.rules);
      if (!validation.valid) {
        throw new BadRequestException(`Invalid policy rules: ${validation.errors?.join(', ')}`);
      }
    }

    // TASK-409 — rule-edits with a multi-role blast radius need break-glass.
    const breakGlassUsed = await this.requireRuleEditBreakGlass(existing as PolicyGuardRow, request);

    const user = this.requestUser;
    const data = PolicyFactory.buildUpdateInput(request, user?.id);
    const policy = (await this.policyRepository.update(id, data)) as PolicyRecord;

    if (breakGlassUsed) {
      this.emitBreakGlassAudit('policy-rule-edit', 'confirmed', { policyId: id, policyName: (existing as PolicyGuardRow).name });
    }

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

  async softDelete(id: string, breakGlass?: BreakGlassCredentials): Promise<{ id: string; name: string }> {
    const existing = (await this.policyRepository.findById(id)) as PolicyGuardRow | null;

    if (!existing) {
      throw new NotFoundException('Policy not found');
    }

    // TASK-390 #22 — a protected system policy can never be deleted (would
    // lock out super-admins / RBAC administration platform-wide). TASK-409:
    // break-glass does NOT override this — the check precedes it.
    this.assertProtectedDeletionAllowed(existing);

    // TASK-409 — deleting any policy is a dangerous-but-allowed mutation:
    // require the step-up confirmation (current password + exact name).
    await this.requireBreakGlass('policy-delete', existing, breakGlass, `Deleting policy '${existing.name}'`);

    const user = this.requestUser;
    await this.policyRepository.softDelete(id, user?.id);

    this.emitBreakGlassAudit('policy-delete', 'confirmed', { policyId: id, policyName: existing.name });

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

  /**
   * TASK-409 — a policy is protected when the server-authoritative
   * `isProtected` marker is set OR the legacy seeded name matches
   * (defense in depth; the name fallback covers databases that have not
   * re-run the seed since the column landed).
   */
  private isProtectedPolicy(existing: PolicyGuardRow): boolean {
    return existing.isProtected === true || existing.name in PolicyService.PROTECTED_SYSTEM_POLICIES;
  }

  /**
   * TASK-409 — the rule tuples a protected policy must retain. Known seeded
   * names use the pinned TASK-390 map; a RENAMED protected policy (marker
   * only) must retain whichever system-critical grants it currently carries.
   */
  private requiredRulesFor(existing: PolicyGuardRow): ReadonlyArray<{ action: string; subject: string }> {
    const byName = PolicyService.PROTECTED_SYSTEM_POLICIES[existing.name];
    if (byName) return byName;

    const currentRules = Array.isArray(existing.rules) ? (existing.rules as Array<{ action?: string; subject?: string; inverted?: boolean }>) : [];
    return PolicyService.SYSTEM_CRITICAL_RULES.filter((required) =>
      currentRules.some((r) => r.action === required.action && r.subject === required.subject && r.inverted !== true),
    );
  }

  /**
   * TASK-390 #22 / TASK-409 — refuse to delete a protected system policy
   * (marker OR name). The rejection is force-audited.
   */
  private assertProtectedDeletionAllowed(existing: PolicyGuardRow): void {
    if (this.isProtectedPolicy(existing)) {
      this.emitBreakGlassAudit('policy-delete', 'rejected-protected', { policyId: existing.id, policyName: existing.name });
      throw new ForbiddenException(
        `Policy '${existing.name}' is a protected system policy and cannot be deleted (it grants super-admin / RBAC access platform-wide).`,
      );
    }
  }

  /**
   * TASK-390 #22 — refuse mutations that would neutralise a protected system
   * policy: re-scoping away from GLOBAL, disabling it, or removing/denying a
   * load-bearing rule. Non-destructive edits (name, description, adding rules)
   * are allowed; non-protected policies are unaffected.
   *
   * TASK-409 — protection now keys off `isProtected` OR the legacy name, and
   * every rejection is force-audited.
   */
  private assertProtectedMutationAllowed(existing: PolicyGuardRow, request: UpdatePolicyRequest): void {
    if (!this.isProtectedPolicy(existing)) return;

    const reject = (message: string): never => {
      this.emitBreakGlassAudit('policy-edit', 'rejected-protected', { policyId: existing.id, policyName: existing.name });
      throw new ForbiddenException(message);
    };

    if (request.scope !== undefined && request.scope !== 'GLOBAL') {
      reject(`Policy '${existing.name}' is a protected system policy; its scope cannot be changed from GLOBAL.`);
    }

    if (request.resourceStatus !== undefined && String(request.resourceStatus) !== String(ResourceStatusType.ENABLED)) {
      reject(`Policy '${existing.name}' is a protected system policy and cannot be disabled.`);
    }

    if (request.rules !== undefined) {
      for (const required of this.requiredRulesFor(existing)) {
        const retained = request.rules.some((r) => r.action === required.action && r.subject === required.subject && r.inverted !== true);
        if (!retained) {
          reject(
            `Policy '${existing.name}' is a protected system policy; the '${required.action}:${required.subject}' rule cannot be removed or denied.`,
          );
        }
      }
    }
  }

  /**
   * TASK-409 — `isProtected` is server-managed (seed only). The API layer's
   * `forbidNonWhitelisted` ValidationPipe already 400s unknown body fields;
   * this is the service-level defense in depth for non-HTTP callers.
   */
  private rejectExplicitIsProtectedWrite(request: UpdatePolicyRequest): void {
    if ((request as Record<string, unknown>).isProtected !== undefined) {
      throw new BadRequestException(`'isProtected' is read-only: the protected marker is managed by the platform seed and cannot be changed via the API.`);
    }
  }

  /**
   * TASK-409 — rule-edits of a policy attached to MORE THAN ONE enabled role
   * change authorization for several roles at once, so they require the
   * break-glass confirmation. Returns whether break-glass was enforced (the
   * caller emits the 'confirmed' audit only after the mutation succeeds).
   */
  private async requireRuleEditBreakGlass(existing: PolicyGuardRow, request: UpdatePolicyRequest): Promise<boolean> {
    if (request.rules === undefined) return false;

    const enabledRoleCount = await this.rolePolicyRepository.countEnabledByPolicy(existing.id);
    if (enabledRoleCount <= 1) return false;

    await this.requireBreakGlass(
      'policy-rule-edit',
      existing,
      request.breakGlass,
      `Editing the rules of policy '${existing.name}' (attached to ${enabledRoleCount} roles)`,
    );
    return true;
  }

  /**
   * TASK-409 — run the step-up verification; on failure, force-audit the
   * rejection and surface the mapped HTTP error (428/401/400).
   */
  private async requireBreakGlass(
    operation: BreakGlassOperation,
    target: PolicyGuardRow,
    credentials: BreakGlassCredentials | undefined,
    operationLabel: string,
  ): Promise<void> {
    const result = await checkBreakGlass({
      operation: operationLabel,
      expectedName: target.name,
      userId: this.requestUserId,
      credentials,
      loadPasswordHash: async () => {
        const user = await this.userRepository.findById(this.requestUserId as string);
        return (user as { password: string }).password;
      },
      verifyPassword: (password, hash) => this.cryptoService.verify(password, hash),
    });

    if (!result.ok) {
      this.emitBreakGlassAudit(operation, result.outcome, { policyId: target.id, policyName: target.name });
      throw result.error;
    }
  }

  /**
   * TASK-409 — forced audit row for break-glass outcomes (TASK-396 pattern):
   * direct emit (not `broadcastSysEvent`) because (1) `forceAuditLog: true`
   * is required for the READ-typed event to persist an AuditLog row and
   * (2) super-admins carry a NULL CLS tenant, and `AuditLogProcessor`
   * fail-closes on a null tenant — policies are platform-global resources, so
   * the row is attributed to the reserved system tenant. NEVER the password.
   */
  private emitBreakGlassAudit(operation: BreakGlassOperation, outcome: BreakGlassOutcome, target: { policyId: string; policyName: string }): void {
    this.eventEmitter.emit(SysEventType.ResourceViewed, {
      responsibleEntityId: this.requestUser?.id,
      responsibleIp: this.requestIp,
      resourceType: this.resourceType,
      correlationId: this.correlationId,
      resourceId: target.policyId,
      tenantId: this.tenantId ?? SYSTEM_TENANT_ID,
      forceAuditLog: true,
      data: {
        action: RBAC_BREAK_GLASS_AUDIT_ACTION,
        operation,
        outcome,
        targetType: 'Policy',
        targetId: target.policyId,
        targetName: target.policyName,
        actorId: this.requestUser?.id,
        at: new Date().toISOString(),
      },
    });
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
