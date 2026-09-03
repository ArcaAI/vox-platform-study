import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { createPrismaAbility, accessibleBy, type PrismaQueryOf, type PrismaTypeMap } from '@casl/prisma';
import { Ability, subject as tagSubjectType } from '@casl/ability';
import { Counter, register } from 'prom-client';
import { CoreDatabaseService, ResourceStatusType } from '@arcaai/domains';
import { IRedisCacheService } from '../services/baseServices/redis';

/**
 * Reserved system tenant for platform-wide rows.
 * Role assignments that used to be global (`tenantId = NULL`) now live under
 * this tenant; NULL is no longer a valid `UserRoleAssignment.tenantId`.
 */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * CASL condition-evaluation SHADOW mode.
 *
 * `unified-auth.guard.ts:319` evaluates `ability.can(action, subject)` — a
 * bare type-name check. CASL's `conditions` machinery is fully built
 * (`resolveConditions`/`resolveRuleConditions` below) but can only be
 * evaluated against a **subject instance**, so today it never runs — see
 * `casl-blast-radius.md` for the full inventory of seeded rules this
 * affects (82 rule entries carrying `conditions` across 21 live policies as
 * of that survey).
 *
 * This is the SHADOW half only: compute what an instance-aware verdict
 * WOULD be, compare it to the type-only verdict that is actually enforced,
 * and record every disagreement. The type-only verdict never stops being
 * authoritative here — flipping that is Task 15 (Enforce), explicitly not
 * started this pass (owner directive R1: shadow → measure → enforce, per
 * `(action, subject)` pair, independently revertible).
 */
export const CASL_SHADOW_DIVERGENCE_METRIC = 'casl_shadow_divergence_total';

/** Structured log event name for the same divergence (dotted, matching the `metering.shadow_report.*` convention already used for another shadow-mode reconciler in this codebase — `shadow-metering.service.ts`). */
export const CASL_SHADOW_DIVERGENCE_EVENT = 'casl.shadow.divergence';

/**
 * Result of comparing the type-only verdict (what `UnifiedAuthGuard` actually
 * enforces today) against the instance-aware verdict CASL's `conditions`
 * would produce once evaluated against a resolved subject instance.
 */
export interface ShadowVerdict {
  /** What is actually enforced today — a bare `ability.can(action, subject)`. */
  typeVerdict: boolean;
  /** What `conditions` would decide against the resolved instance. */
  instanceVerdict: boolean;
  /** `typeVerdict !== instanceVerdict`. */
  diverged: boolean;
}

const caslShadowDivergenceTotal: Counter<'action' | 'subject' | 'direction'> =
  (register.getSingleMetric(CASL_SHADOW_DIVERGENCE_METRIC) as Counter<'action' | 'subject' | 'direction'> | undefined) ??
  new Counter({
    name: CASL_SHADOW_DIVERGENCE_METRIC,
    help:
      'Number of requests where the CASL type-only authorization verdict ' +
      '(currently enforced) disagreed with the instance-aware verdict its ' +
      'seeded `conditions` would produce (Phase 5, shadow mode). ' +
      "Labeled by action, subject, and direction ('would_deny' | 'would_allow'). " +
      'See casl-blast-radius.md for the rollout this counter measures against.',
    labelNames: ['action', 'subject', 'direction'] as const,
    registers: [register],
  });

/**
 * ENFORCE. Corrected by.
 *
 * The explicit, per-`(action, subject)` enforce list. For a pair in this set,
 * AND ONLY for a route that opted into instance resolution via
 * `@ResolveSubjectInstance(...)`, the instance-aware verdict becomes
 * AUTHORITATIVE: a `false` instance verdict turns the request into a 403.
 * Every other pair keeps Task 14's shadow semantics exactly — computed,
 * recorded, never applied.
 *
 * **It ships EMPTY.** Not "empty until measured" — empty because every
 * candidate investigated so far is DISQUALIFIED for a structural reason, and
 * the three that were briefly listed turned out to be unreachable. Record the
 * findings here rather than re-deriving them:
 *
 * 1. **`read`/`manage:Consultation`** (`casl-blast-radius.md` step 1)
 *    `consultation.controller.ts`'s `verifyConsultationAccess` runs a
 *    post-guard, DB-backed shared-patient fallback (its Layer 2) that the
 *    guard cannot see. A guard-level instance denial would 403 before that
 *    fallback ever runs, turning a legitimate shared-patient read into an
 *    outage.
 * 2. **`update`/`delete:UserVoiceProfile`** ( step 2's strongest candidate)
 *    — the `userId = ${user.id}` boundary those routes need is ALREADY
 *    enforced, by `TenantOwnedResourceInterceptor.assertVoiceProfileOwnership`,
 *    which deliberately answers **404** so probing another user's profile id
 *    is indistinguishable from probing a non-existent one. Guards run BEFORE
 *    interceptors, so enforcing this pair would pre-empt that check and
 *    downgrade a deliberate 404 into an existence-leaking 403 — a security
 *    REGRESSION, not a tightening. (DEF-C3.)
 * 3. **`read`/`update`/`delete:ApiKey`** — listed by, REMOVED by
 * for BOTH of the reasons above at once:
 *
 *    - *Unreachable.* `ApiKeyController.resolveApiKeyInstance` loads the row
 *      through `IApiKeyService.fetchById`, which runs `assertKeyAccess` and
 *      throws 404 for a key the caller does not own. On exactly the request
 *      the pair existed to deny, the resolver threw, `runCaslInstanceChecks`
 *      swallowed it on its fail-open path, and the service's 404 answered.
 *      Where the resolver succeeded, `assertKeyAccess` had already passed, so
 * the instance verdict was necessarily `true`. proved this by
 *      e2e: `casl_enforce_denial_total` could not increment, which made any
 *      future "measure then enforce" reading of that counter vacuously zero.
 *    - *And unfixable at this layer.* Making it fire requires the resolver to
 *      read the row WITHOUT the ownership assertion — at which point the
 *      guard's denial pre-empts `assertKeyAccess`'s deliberate 404 with a 403.
 *      Same regression as (2).
 *
 * Findings 2 and 3 generalise into the rule that governs every future entry —
 * and note that stated only the first half of it, which is how
 * `ApiKey` slipped through:
 *
 * > **A subject whose ownership boundary is already enforced downstream with
 * > a deliberate 404 must not be enforced here** — whether that downstream
 * > enforcement lives in an INTERCEPTOR (`@TenantOwnedResource`) or in the
 * > SERVICE (`assertKeyAccess`). The guard precedes both, so it can only
 * > replace their 404-over-403 posture with a 403.
 *
 * Two mechanical gates back this up, so the class of defect cannot return
 * silently:
 *
 * - `assertCaslEnforcePairReachability` (`enforce-reachability.ts`), run at
 *   gateway boot by `auditCaslEnforcePairReachability`: a listed pair must be
 *   declared on an AND-mode route carrying an ENFORCE-GRADE resolver, or the
 *   gateway refuses to start.
 * - `casl-conditions.enforce.test.ts` pins this set, so adding an entry fails
 *   a test until the ticket records the evidence that justifies it.
 */
export const CASL_ENFORCED_PAIRS: ReadonlySet<string> = new Set<string>([
  // EMPTY — and the emptiness is the honest state, not a gap.
  //
  // listed `read`/`update`/`delete:ApiKey` here. e2e
  // proved by observation that none of them could ever fire, and
  // removed them. Both halves of that finding are recorded above; the short
  // version is that the boundary those pairs described is already enforced by
  // `ApiKeyService.assertKeyAccess`, one layer down, with the SAFER status.
  //
  // Adding an entry is an authorization-semantics change and now costs three
  // things, not one: evidence , an enforce-grade resolver
  // on the declaring route, and a green `auditCaslEnforcePairReachability` —
  // which refuses to boot the gateway if the pair cannot actually fire.
]);

/** Prometheus counter name for an authorization denied by the ENFORCED instance verdict. */
export const CASL_ENFORCE_DENIAL_METRIC = 'casl_enforce_denial_total';

/** Structured log event name for the same denial. */
export const CASL_ENFORCE_DENIAL_EVENT = 'casl.enforce.denial';

const caslEnforceDenialTotal: Counter<'action' | 'subject'> =
  (register.getSingleMetric(CASL_ENFORCE_DENIAL_METRIC) as Counter<'action' | 'subject'> | undefined) ??
  new Counter({
    name: CASL_ENFORCE_DENIAL_METRIC,
    help:
      'Number of requests denied (403) because an ENFORCED CASL ' +
      '(action, subject) pair evaluated its seeded `conditions` against a ' +
      'resolved subject instance and refused (Phase 5, enforce mode). ' +
      'A non-zero rate on a newly enforced pair is the signal to revert it.',
    labelNames: ['action', 'subject'] as const,
    registers: [register],
  });

/**
 * CASL Ability type for the application.
 *
 * casl 7 / casl-prisma 2: `PureAbility` was renamed to `Ability`,
 * and `PrismaQuery` is now derived from `@prisma/client`'s generated
 * `Prisma.TypeMap`. This repo generates its client into
 * `packages/database/src/generated` (the bare `@prisma/client` TypeMap is a
 * stub), so we build the query type from a loose string-keyed TypeMap —
 * the same permissive `[string, string]` + JSON-conditions semantics the
 * engine has always had (rules are DB-stored JSON).
 */
export type AppAbility = Ability<[string, string], PrismaQueryOf<PrismaTypeMap<string>>>;

/**
 * Policy rule structure (stored in database as JSON)
 */
export interface PolicyRule {
  /**
   * CASL raw rules accept a single value or an array (an array fans the rule
   * across every combination). Rules are DB-stored JSON and are passed to
   * `createPrismaAbility` verbatim, so both shapes reach CASL unchanged.
   */
  action: string | string[];
  subject: string | string[];
  conditions?: Record<string, unknown>;
  fields?: string[];
  inverted?: boolean;
  reason?: string;
}

/**
 * Context for building abilities
 */
export interface PolicyContext {
  userId: string;
  tenantId?: string;
  params?: Record<string, unknown>;
}

/**
 * Scope overrides that can be applied per user-role assignment
 */
interface ScopeOverrides {
  additionalRules?: PolicyRule[];
  excludedPolicies?: string[];
}

/**
 * PolicyEngine - Core authorization engine
 *
 * Responsibilities:
 * - Load policies from database for a user
 * - Build CASL abilities from policy rules
 * - Cache abilities in Redis for performance
 * - Resolve dynamic variables in conditions
 * - Provide accessibleBy filters for Prisma queries
 *
 * @example
 * ```typescript
 * const ability = await policyEngine.buildAbility({
 *   userId: 'user-123',
 *   tenantId: 'tenant-456',
 * });
 *
 * if (ability.can('read', 'User')) {
 *   // User has permission
 * }
 *
 * // Get Prisma filter for accessible records (casl-prisma 2: .ofType())
 * const filter = policyEngine.getAccessibleBy(ability, 'read');
 * const users = await prisma.user.findMany({
 *   where: filter.ofType('User'),
 * });
 * ```
 */
@Injectable()
export class PolicyEngine {
  private readonly logger = new Logger(PolicyEngine.name);
  private readonly CACHE_TTL = 300; // 5 minutes
  private readonly CACHE_PREFIX = 'policy:ability:';

  constructor(
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    @Optional() @Inject(IRedisCacheService) private readonly cache?: IRedisCacheService,
  ) {
    if (this.cache) {
      this.logger.log({
        message: 'PolicyEngine initialized',
        caching: 'enabled',
      });
    } else {
      this.logger.warn({
        message: 'PolicyEngine initialized',
        caching: 'disabled',
        impact: 'performance',
      });
    }
  }

  /**
   * Build CASL ability for a user
   *
   * @param context - Policy context with user info
   * @returns CASL ability instance
   */
  /**
   * Build an ability from EXPLICIT rules, with no user, no tenant and no
   * database read.
   *
   * The service-account path needs a CASL ability for the ACCOUNT ITSELF, not
   * for a bound human — that is the whole point of the credential class: a
   * machine's authority must be independently grantable and revocable. Its
   * rules come from the `svc:*` scopes the account was issued with, so there is
   * nothing to load and nothing to cache (a per-request scope list is already
   * in hand, and caching it under a user key would be wrong twice over).
   */
  buildAbilityFromRules(rules: PolicyRule[]): AppAbility {
    return createPrismaAbility(rules);
  }

  async buildAbility(context: PolicyContext): Promise<AppAbility> {
    const cacheKey = this.getCacheKey(context);

    // Try cache first (if Redis is available)
    if (this.cache?.isConnected()) {
      try {
        const cached = await this.cache.get(cacheKey);
        if (cached) {
          this.logger.debug({
            message: 'Cache hit',
            userId: context.userId,
            tenantId: context.tenantId,
          });
          const rules = JSON.parse(cached) as PolicyRule[];
          return createPrismaAbility(rules);
        }
      } catch (error) {
        this.logger.warn({
          message: 'Cache read failed',
          userId: context.userId,
          fallback: 'database',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Load policies from database
    const rules = await this.loadUserPolicies(context);

    // Build ability
    const ability = createPrismaAbility(rules);

    // Cache the rules (if Redis is available)
    if (this.cache?.isConnected()) {
      try {
        await this.cache.setex(cacheKey, this.CACHE_TTL, JSON.stringify(rules));
        this.logger.debug({
          message: 'Cache set',
          userId: context.userId,
          tenantId: context.tenantId,
          ttl: this.CACHE_TTL,
        });
      } catch (error) {
        this.logger.warn({
          message: 'Cache write failed',
          userId: context.userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.debug({
      message: 'Ability built',
      userId: context.userId,
      tenantId: context.tenantId,
      rulesCount: rules.length,
    });

    return ability;
  }

  /**
   * Get cache key for a policy context
   */
  private getCacheKey(context: PolicyContext): string {
    return `${this.CACHE_PREFIX}${context.userId}:${context.tenantId || 'global'}`;
  }

  /**
   * Get accessible filter for Prisma queries
   *
   * @param ability - CASL ability instance
   * @param action - Action to check (default: 'read')
   * @returns AccessibleRecords — call `.ofType('Model')` for a WhereInput
   *   (casl-prisma 2 replaced the proxy shape `filter.Model`)
   *
   * @example
   * ```typescript
   * const filter = policyEngine.getAccessibleBy(ability, 'read');
   * const users = await prisma.user.findMany({
   *   where: filter.ofType('User'),
   * });
   * ```
   */
  getAccessibleBy(ability: AppAbility, action: string = 'read') {
    return accessibleBy(ability, action);
  }

  /**
   * Get permitted fields for a subject
   *
   * @param ability - CASL ability instance
   * @param action - Action to check
   * @param subject - Subject/model name
   * @returns Array of permitted field names, or undefined if no field restrictions
   */
  getPermittedFields(ability: AppAbility, action: string, subject: string): string[] | undefined {
    const rule = ability.relevantRuleFor(action, subject);
    return rule?.fields;
  }

  /**
   * Check if user can perform action on subject
   * Convenience method that wraps ability.can()
   */
  can(ability: AppAbility, action: string, subject: string, resource?: Record<string, unknown>): boolean {
    if (resource) {
      // c — BUG FIX. CASL's 3-argument `can(action,
      // subject, field)` treats its THIRD parameter as a FIELD NAME and
      // throws `The 3rd, \`field\` parameter is expected to be a string` for
      // anything else — so this branch had never once returned a verdict. It
      // threw on every call, at all four production call sites
      // (`permission-check.controller.ts`, `consultation.controller.ts`) and
      // inside `evaluateShadowVerdict`, where the guard's fail-open catch
      // swallowed it. That is the deeper reason
      // `casl_shadow_divergence_total` could never move: even a wired route
      // would have produced no signal.
      //
      // The supported way to evaluate `conditions` against a PLAIN object is
      // to tag it with its subject type first (`subject(type, obj)`), because
      // a detached object carries no type CASL can infer.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- rules are DB-stored JSON; `subject()` erases the literal subject type this loose AppAbility cannot express.
      return ability.can(action, tagSubjectType(subject, resource as any) as any);
    }
    return ability.can(action, subject);
  }

  /**
   * Check if user cannot perform action on subject
   * Convenience method that wraps ability.cannot()
   */
  cannot(ability: AppAbility, action: string, subject: string, resource?: Record<string, unknown>): boolean {
    return !this.can(ability, action, subject, resource);
  }

  /**
   * (shadow mode) — pure comparison, no I/O, no
   * side effects. Computes BOTH the type-only verdict (what
   * `UnifiedAuthGuard` actually enforces) and the instance-aware verdict
   * `conditions` would produce against `instance`, and reports whether they
   * agree. Never decides a request outcome by itself.
   *
   * `instance` is caller-resolved (see `ResolveSubjectInstance` in
   * `unified-auth.guard.ts`) and MAY be missing fields a rule's
   * `conditions` reference — e.g. a partial projection without `tenantId`.
   * That is exactly the hazard `casl-blast-radius.md` names, and it
   * surfaces here as `diverged: true`, never as a thrown exception.
   */
  evaluateShadowVerdict(ability: AppAbility, action: string, subject: string, instance: Record<string, unknown>): ShadowVerdict {
    const typeVerdict = ability.can(action, subject);
    const instanceVerdict = this.can(ability, action, subject, instance);
    return { typeVerdict, instanceVerdict, diverged: typeVerdict !== instanceVerdict };
  }

  /**
   * Records a divergence found by {@link evaluateShadowVerdict}: increments
   * `casl_shadow_divergence_total` and logs `casl.shadow.divergence`. A
   * no-op when `verdict.diverged` is false — shadow mode should be silent
   * on the (expected) common case.
   *
   * `direction` distinguishes the two risk shapes an eventual enforce would
   * introduce: `would_deny` (type allows, instance would deny — the R1 risk,
   * a legitimate call turning into a 403) vs `would_allow` (type denies,
   * instance would allow — a widening, lower operational risk but still
   * worth measuring before `getAccessibleBy` is wired to any list query).
   */
  recordShadowDivergence(action: string, subject: string, verdict: ShadowVerdict, meta?: Record<string, unknown>): void {
    if (!verdict.diverged) return;

    const direction = verdict.typeVerdict && !verdict.instanceVerdict ? 'would_deny' : 'would_allow';
    caslShadowDivergenceTotal.inc({ action, subject, direction });
    this.logger.warn({
      message: CASL_SHADOW_DIVERGENCE_EVENT,
      action,
      subject,
      direction,
      typeVerdict: verdict.typeVerdict,
      instanceVerdict: verdict.instanceVerdict,
      ...meta,
    });
  }

  /**
   * is this `(action, subject)` pair one whose
   * instance-aware verdict is AUTHORITATIVE (enforce), or still shadow-only?
   * The single decision point; see {@link CASL_ENFORCED_PAIRS} for why each
   * listed pair is listed.
   */
  isEnforcedPair(action: string, subject: string): boolean {
    return CASL_ENFORCED_PAIRS.has(`${action}:${subject}`);
  }

  /**
   * Records a 403 produced by the ENFORCED instance verdict: increments
   * `casl_enforce_denial_total` and logs `casl.enforce.denial`. Unlike
   * {@link recordShadowDivergence} this is unconditional — the caller only
   * reaches it when a denial actually happened, and every such denial is a
   * request outcome that would NOT have occurred before Task 15, so it is
   * always worth a line.
   */
  recordEnforceDenial(action: string, subject: string, meta?: Record<string, unknown>): void {
    caslEnforceDenialTotal.inc({ action, subject });
    this.logger.warn({
      message: CASL_ENFORCE_DENIAL_EVENT,
      action,
      subject,
      ...meta,
    });
  }

  /**
   * Load all policies for a user from database
   *
   * This method loads policies from:
   * 1. Direct user role assignments (UserRoleAssignment)
   * 2. Parent role inheritance
   */
  private async loadUserPolicies(context: PolicyContext): Promise<PolicyRule[]> {
    // Use the UNSCOPED platform-admin client for the RBAC control-plane read.
    //
    // Resolving a user's effective policies is an authorization-bootstrap step
    // that must span BOTH the SYSTEM tenant (platform-wide assignments such as
    // SUPER_ADMIN) and the request tenant — see the `tenantId: { in: [...] }`
    // filter below. The tenant-scope `$extends` is designed for
    // tenant *data* and rejects any non-scalar `where.tenantId` (it throws
    // "TenantScope: tenantId mismatch" on an `in` list), which would make every
    // permissioned request fail with 403 once a tenant context is present.
    // The RBAC control plane is precisely the "cross-tenant maintenance" path
    // `baseClient` is sanctioned for; both queries already pin
    // `resourceStatus: ENABLED`, so bypassing the soft-delete filter is a no-op.
    const prisma = this.databaseService.baseClient;

    // 1. Get user's direct role assignments with policies.
    //
    // Tenant scope: `UserRoleAssignment.tenantId` is a
    // required, non-nullable column. Platform-wide assignments (e.g.
    // SUPER_ADMIN) live under SYSTEM_TENANT_ID, not NULL. We always include
    // the system tenant and add the request tenant only when present. A bare
    // `undefined` must never reach the filter — Prisma 7 rejects
    // `{ tenantId: undefined }` ("Argument `tenantId` is missing"), so an
    // `in` list (built without undefined) keeps the tenant-less path safe.
    const tenantScopes = [SYSTEM_TENANT_ID];
    if (context.tenantId && context.tenantId !== SYSTEM_TENANT_ID) {
      tenantScopes.push(context.tenantId);
    }

    const directAssignments = await prisma.userRoleAssignment.findMany({
      where: {
        userId: context.userId,
        resourceStatus: ResourceStatusType.ENABLED,
        tenantId: { in: tenantScopes },
      },
    });

    // Collect all role IDs
    const roleIds = new Set<string>();
    for (const assignment of directAssignments) {
      roleIds.add(assignment.roleId);
    }

    // 2. Load all roles with their policies
    const roles = await prisma.role.findMany({
      where: {
        id: { in: Array.from(roleIds) },
        resourceStatus: ResourceStatusType.ENABLED,
      },
      include: {
        RolePolicies: {
          where: { resourceStatus: ResourceStatusType.ENABLED },
          include: {
            Policy: true,
          },
          orderBy: { priority: 'asc' },
        },
        ParentRole: {
          include: {
            RolePolicies: {
              where: { resourceStatus: ResourceStatusType.ENABLED },
              include: {
                Policy: true,
              },
              orderBy: { priority: 'asc' },
            },
          },
        },
      },
    });

    // Create role map for quick lookup
    const roleMap = new Map(roles.map((r) => [r.id, r]));

    // 3. Collect all rules from all policies
    const allRules: PolicyRule[] = [];
    const processedPolicies = new Set<string>();

    // Process direct role assignments
    for (const assignment of directAssignments) {
      const scopeOverrides = assignment.scopeOverrides as ScopeOverrides | null;
      const excludedPolicies = new Set(scopeOverrides?.excludedPolicies || []);
      const role = roleMap.get(assignment.roleId);

      if (role) {
        // Process role's policies
        this.collectPoliciesFromRole(role, allRules, processedPolicies, excludedPolicies, context);

        // Process inherited policies from parent role
        if (role.ParentRole) {
          this.collectPoliciesFromRole(role.ParentRole, allRules, processedPolicies, excludedPolicies, context);
        }
      }

      // Apply scope overrides (additional rules)
      if (scopeOverrides?.additionalRules) {
        for (const rule of scopeOverrides.additionalRules) {
          allRules.push(this.resolveRule(rule, context));
        }
      }
    }

    return allRules;
  }

  /**
   * Collect policies from a role
   */
  private collectPoliciesFromRole(
    role: {
      RolePolicies?: Array<{
        Policy?: { id: string; rules: unknown; resourceStatus: string } | null;
      }>;
    },
    allRules: PolicyRule[],
    processedPolicies: Set<string>,
    excludedPolicies: Set<string>,
    context: PolicyContext,
  ): void {
    for (const rolePolicy of role.RolePolicies || []) {
      const policy = rolePolicy.Policy;

      // Skip if no policy or already processed
      if (!policy) continue;
      if (processedPolicies.has(policy.id)) continue;
      if (excludedPolicies.has(policy.id)) continue;

      processedPolicies.add(policy.id);

      // Process each rule in the policy
      const rules = policy.rules as PolicyRule[];
      if (Array.isArray(rules)) {
        for (const rule of rules) {
          allRules.push(this.resolveRule(rule, context));
        }
      }
    }
  }

  /**
   * Resolve dynamic variables in rule conditions
   */
  private resolveRule(rule: PolicyRule, context: PolicyContext): PolicyRule {
    if (!rule.conditions) return rule;

    const resolvedConditions = this.resolveConditions(rule.conditions, context);
    return { ...rule, conditions: resolvedConditions };
  }

  /**
   * Resolve template variables in conditions recursively
   */
  private resolveConditions(conditions: Record<string, unknown>, context: PolicyContext): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(conditions)) {
      if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
        resolved[key] = this.resolveVariable(value, context);
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        resolved[key] = this.resolveConditions(value as Record<string, unknown>, context);
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  /**
   * Resolve a single template variable
   *
   * Supported variables:
   * - ${user.id} - Current user's ID
   * - ${user.tenantId} - Current user's tenant ID
   * - ${context.tenantId} - Request tenant context
   * - ${params.xxx} - Route parameters
   */
  private resolveVariable(template: string, context: PolicyContext): unknown {
    const varName = template.slice(2, -1); // Remove ${ and }

    const variables: Record<string, unknown> = {
      'user.id': context.userId,
      'user.tenantId': context.tenantId,
      'context.tenantId': context.tenantId,
    };

    // Add params to variables
    if (context.params) {
      for (const [key, value] of Object.entries(context.params)) {
        variables[`params.${key}`] = value;
      }
    }

    const resolved = variables[varName];
    if (resolved === undefined) {
      this.logger.warn({
        message: 'Unknown variable in policy rule',
        template,
        varName,
        availableVars: Object.keys(variables),
      });
      return null;
    }

    return resolved;
  }

  /**
   * Invalidate cache for a user
   *
   * @param userId - User ID to invalidate cache for
   */
  async invalidateUser(userId: string): Promise<void> {
    if (!this.cache?.isConnected()) {
      this.logger.debug({
        message: 'Cache invalidation skipped',
        userId,
        reason: 'no_cache',
      });
      return;
    }

    try {
      const pattern = `${this.CACHE_PREFIX}${userId}:*`;
      const keys = await this.cache.keys(pattern);

      if (keys.length > 0) {
        await this.cache.delMany(keys);
        this.logger.debug({
          message: 'Cache invalidated',
          userId,
          keysCount: keys.length,
        });
      }
    } catch (error) {
      this.logger.error({
        message: 'Cache invalidation failed',
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Invalidate cache for all users with a specific role
   *
   * @param roleId - Role ID to invalidate cache for
   */
  async invalidateRole(roleId: string): Promise<void> {
    const prisma = this.databaseService.client;

    // Get all users with this role via direct assignment
    const directAssignments = await prisma.userRoleAssignment.findMany({
      where: { roleId },
      select: { userId: true },
    });

    // Collect all unique user IDs
    const userIds = new Set<string>();

    for (const { userId } of directAssignments) {
      userIds.add(userId);
    }

    // Invalidate each user's cache in parallel
    await Promise.all(Array.from(userIds).map((userId) => this.invalidateUser(userId)));

    this.logger.debug({
      message: 'Cache invalidated for role',
      roleId,
      usersAffected: userIds.size,
    });
  }

  /**
   * Invalidate cache for all users with a specific policy
   *
   * @param policyId - Policy ID to invalidate cache for
   */
  async invalidatePolicy(policyId: string): Promise<void> {
    const prisma = this.databaseService.client;

    // Get all roles with this policy
    const rolePolicies = await prisma.rolePolicy.findMany({
      where: { policyId },
      select: { roleId: true },
    });

    // Invalidate each role in parallel
    await Promise.all(rolePolicies.map(({ roleId }) => this.invalidateRole(roleId)));

    this.logger.debug({
      message: 'Cache invalidated for policy',
      policyId,
      rolesAffected: rolePolicies.length,
    });
  }

  /**
   * Invalidate cache for all users in a tenant
   *
   * @param tenantId - Tenant ID to invalidate cache for
   */
  async invalidateTenant(tenantId: string): Promise<void> {
    if (!this.cache?.isConnected()) {
      this.logger.debug({
        message: 'Cache invalidation skipped',
        tenantId,
        reason: 'no_cache',
      });
      return;
    }

    try {
      const pattern = `${this.CACHE_PREFIX}*:${tenantId}`;
      const keys = await this.cache.keys(pattern);

      if (keys.length > 0) {
        await this.cache.delMany(keys);
        this.logger.debug({
          message: 'Cache invalidated for tenant',
          tenantId,
          keysCount: keys.length,
        });
      }
    } catch (error) {
      this.logger.error({
        message: 'Cache invalidation failed',
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Invalidate all cached abilities
   * Use with caution - this clears all authorization cache
   */
  async invalidateAll(): Promise<void> {
    if (!this.cache?.isConnected()) {
      this.logger.debug({
        message: 'Cache invalidation skipped',
        scope: 'all',
        reason: 'no_cache',
      });
      return;
    }

    try {
      const pattern = `${this.CACHE_PREFIX}*`;
      const keys = await this.cache.keys(pattern);

      if (keys.length > 0) {
        await this.cache.delMany(keys);
        this.logger.warn({
          message: 'Cache invalidated',
          scope: 'all',
          keysCount: keys.length,
        });
      }
    } catch (error) {
      this.logger.error({
        message: 'Cache invalidation failed',
        scope: 'all',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
