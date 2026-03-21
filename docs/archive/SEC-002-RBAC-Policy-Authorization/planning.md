# SEC-002: RBAC Policy Authorization - Execution Checklist

## Quick Reference

### Priority Order

Execute tasks in this order to minimize risk and maximize value:

```
Phase 1 (Core Infrastructure):
├── 1.1: Redis Integration for PolicyEngine
├── 1.2: Cache Invalidation Mechanisms
└── 1.3: Enhanced Authorization Guard

Phase 2 (Database-Level Filtering):
├── 2.1: AuthorizedBaseService Implementation
├── 2.2: accessibleBy Integration
└── 2.3: Field-Level Filtering

Phase 3 (Advanced Decorators):
├── 3.1: OR Logic Support (AuthorizeAny)
├── 3.2: Resource-Level Checks (AuthorizeResource)
└── 3.3: UserAbility Parameter Decorator

Phase 4 (Permission Management API):
├── 4.1: Roles Controller
├── 4.2: Policies Controller
├── 4.3: User Role Assignment Controller
└── 4.4: Permission Validation Endpoints

Phase 5 (Audit & Monitoring):
├── 5.1: Authorization Audit Service
├── 5.2: AuditLog Database Model
└── 5.3: Real-time Monitoring (Redis Pub/Sub)

Phase 6 (Migration & Cleanup):
├── 6.1: Deprecate @UseAuthorized
├── 6.2: Migrate Existing Controllers
├── 6.3: Update Services to AuthorizedBaseService
└── 6.4: Documentation Updates
```

---

## Pre-Implementation Checklist

- [ ] Create feature branch: `git checkout -b feature/SEC-002-rbac-policy-authorization`
- [ ] Ensure all tests pass on current branch: `pnpm test`
- [ ] Verify Redis is available in development environment
- [ ] Review existing RBAC seed data
- [ ] Backup database (if modifying schema)
- [ ] Notify team of authorization changes in progress

---

## Phase 1: Core Infrastructure Enhancement

### Task 1.1: Redis Integration for PolicyEngine

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Pre-checks**:
- [ ] Redis service is running and accessible
- [ ] Redis client is configured in the application
- [ ] Verify `REDIS_URL` environment variable is set

**Files to Modify**:
- `packages/applications/src/authorization/policy.engine.ts`
- `packages/applications/src/authorization/authorization.module.ts`

**Implementation Steps**:

1. [ ] Add Redis client injection to PolicyEngine constructor
2. [ ] Implement `getCacheKey()` method for consistent key generation
3. [ ] Add cache lookup in `buildAbility()` method
4. [ ] Add cache storage after building ability
5. [ ] Add error handling for Redis failures (fallback to DB)

**Code Template**:

```typescript
// policy.engine.ts
import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class PolicyEngine {
    private readonly CACHE_TTL = 300; // 5 minutes
    private readonly CACHE_PREFIX = 'policy:ability:';

    constructor(
        private readonly databaseService: CoreDatabaseService,
        @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
    ) {}

    private getCacheKey(context: PolicyContext): string {
        return `${this.CACHE_PREFIX}${context.userId}:${context.tenantId || 'global'}`;
    }

    async buildAbility(context: PolicyContext): Promise<AppAbility> {
        const cacheKey = this.getCacheKey(context);

        // Try cache first (if Redis available)
        if (this.redis) {
            try {
                const cached = await this.redis.get(cacheKey);
                if (cached) {
                    this.logger.debug(`Cache hit for user ${context.userId}`);
                    return createPrismaAbility(JSON.parse(cached));
                }
            } catch (error) {
                this.logger.warn('Redis cache read failed, falling back to DB', error);
            }
        }

        // Load from database
        const rules = await this.loadUserPolicies(context);
        const ability = createPrismaAbility(rules);

        // Cache the rules (if Redis available)
        if (this.redis) {
            try {
                await this.redis.setex(cacheKey, this.CACHE_TTL, JSON.stringify(rules));
            } catch (error) {
                this.logger.warn('Redis cache write failed', error);
            }
        }

        return ability;
    }
}
```

**Verification**:
- [ ] Unit test: Cache hit returns cached ability
- [ ] Unit test: Cache miss loads from database
- [ ] Unit test: Redis failure falls back gracefully
- [ ] Integration test: End-to-end authorization with caching

---

### Task 1.2: Cache Invalidation Mechanisms

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Modify**:
- `packages/applications/src/authorization/policy.engine.ts`

**Implementation Steps**:

1. [ ] Implement `invalidateUser(userId)` method
2. [ ] Implement `invalidateRole(roleId)` method
3. [ ] Implement `invalidateTenant(tenantId)` method
4. [ ] Implement `invalidateAll()` method for emergency use

**Code Template**:

```typescript
// policy.engine.ts - Add invalidation methods

/**
 * Invalidate cache for a specific user
 */
async invalidateUser(userId: string): Promise<void> {
    if (!this.redis) return;

    const pattern = `${this.CACHE_PREFIX}${userId}:*`;
    const keys = await this.redis.keys(pattern);
    
    if (keys.length > 0) {
        await this.redis.del(...keys);
        this.logger.debug(`Invalidated ${keys.length} cache entries for user ${userId}`);
    }
}

/**
 * Invalidate cache for all users with a specific role
 */
async invalidateRole(roleId: string): Promise<void> {
    const prisma = this.databaseService.client;

    // Get all users with this role
    const assignments = await prisma.userRoleAssignment.findMany({
        where: {
            Roles: { some: { id: roleId } },
        },
        select: { userId: true },
    });

    // Invalidate each user's cache
    await Promise.all(
        assignments.map(({ userId }) => this.invalidateUser(userId))
    );

    this.logger.debug(`Invalidated cache for role ${roleId} (${assignments.length} users)`);
}

/**
 * Invalidate cache for all users in a tenant
 */
async invalidateTenant(tenantId: string): Promise<void> {
    if (!this.redis) return;

    const pattern = `${this.CACHE_PREFIX}*:${tenantId}`;
    const keys = await this.redis.keys(pattern);
    
    if (keys.length > 0) {
        await this.redis.del(...keys);
        this.logger.debug(`Invalidated ${keys.length} cache entries for tenant ${tenantId}`);
    }
}

/**
 * Invalidate all cached abilities (emergency use only)
 */
async invalidateAll(): Promise<void> {
    if (!this.redis) return;

    const pattern = `${this.CACHE_PREFIX}*`;
    const keys = await this.redis.keys(pattern);
    
    if (keys.length > 0) {
        await this.redis.del(...keys);
        this.logger.warn(`Invalidated ALL ${keys.length} cache entries`);
    }
}
```

**Verification**:
- [ ] Unit test: `invalidateUser` removes correct keys
- [ ] Unit test: `invalidateRole` finds and invalidates all affected users
- [ ] Unit test: `invalidateTenant` removes tenant-scoped entries
- [ ] Integration test: Role update triggers cache invalidation

---

### Task 1.3: Enhanced Authorization Guard

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Modify**:
- `packages/applications/src/authorization/authorization.guard.ts`

**Implementation Steps**:

1. [ ] Add permission mode support (AND/OR)
2. [ ] Store ability in request for service layer access
3. [ ] Add audit logging hook
4. [ ] Improve error messages with specific permission info

**Code Template**:

```typescript
// authorization.guard.ts
export const PERMISSION_MODE_KEY = 'permission_mode';
export type PermissionMode = 'AND' | 'OR';

@Injectable()
export class AuthorizationGuard implements CanActivate {
    async canActivate(context: ExecutionContext): Promise<boolean> {
        // Check if auth is skipped
        const skipAuth = this.reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (skipAuth) return true;

        // Get required permissions
        const required = this.reflector.getAllAndOverride<RequiredPermission[]>(
            REQUIRED_PERMISSIONS_KEY,
            [context.getHandler(), context.getClass()]
        );
        if (!required || required.length === 0) return true;

        // Get permission mode
        const mode = this.reflector.getAllAndOverride<PermissionMode>(
            PERMISSION_MODE_KEY,
            [context.getHandler(), context.getClass()]
        ) || 'AND';

        // Get user from context
        const user = this.cls.get('user');
        if (!user) {
            throw new ForbiddenException('Authentication required');
        }

        // Get request for params and ability storage
        const request = context.switchToHttp().getRequest();

        // Build ability
        const ability = await this.policyEngine.buildAbility({
            userId: user.id,
            tenantId: user.tenantId || undefined,
            params: request.params,
        });

        // Store ability in request and CLS for service layer
        request.ability = ability;
        this.cls.set('userAbility', ability);

        // Check permissions based on mode
        const results = required.map(p => ({
            permission: p,
            allowed: ability.can(p.action, p.subject),
        }));

        const allowed = mode === 'AND'
            ? results.every(r => r.allowed)
            : results.some(r => r.allowed);

        if (!allowed) {
            const denied = results.filter(r => !r.allowed);
            const message = mode === 'AND'
                ? `Missing permissions: ${denied.map(d => `${d.permission.action}:${d.permission.subject}`).join(', ')}`
                : `Requires at least one of: ${required.map(p => `${p.action}:${p.subject}`).join(', ')}`;
            
            this.logger.warn(`Access denied for user ${user.id}: ${message}`);
            throw new ForbiddenException(message);
        }

        return true;
    }
}
```

**Verification**:
- [ ] Unit test: AND mode requires all permissions
- [ ] Unit test: OR mode requires at least one permission
- [ ] Unit test: Ability is stored in request and CLS
- [ ] Integration test: Full authorization flow

---

## Phase 2: Database-Level Query Filtering

### Task 2.1: AuthorizedBaseService Implementation

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Create**:
- `packages/applications/src/common/authorized-base.service.ts`

**Implementation Steps**:

1. [ ] Create abstract base service class
2. [ ] Implement `getAbility()` method
3. [ ] Implement `getAccessibleFilter()` method
4. [ ] Implement `canAccess()` and `assertCanAccess()` methods
5. [ ] Implement `getPermittedFields()` and `filterFields()` methods

**Verification**:
- [ ] Unit test: `getAbility` throws when no context
- [ ] Unit test: `getAccessibleFilter` returns correct Prisma filter
- [ ] Unit test: `assertCanAccess` throws ForbiddenException
- [ ] Unit test: `filterFields` removes unpermitted fields

---

### Task 2.2: accessibleBy Integration

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Modify**:
- `packages/applications/src/authorization/policy.engine.ts`

**Implementation Steps**:

1. [ ] Export `accessibleBy` from policy engine
2. [ ] Create helper method `getAccessibleBy(ability, action)`
3. [ ] Add TypeScript types for Prisma model subjects

**Code Template**:

```typescript
// policy.engine.ts
import { accessibleBy } from '@casl/prisma';

/**
 * Get accessible query filter for Prisma
 * @param ability - CASL ability instance
 * @param action - Action to check (default: 'read')
 */
getAccessibleBy(ability: AppAbility, action: string = 'read') {
    return accessibleBy(ability, action);
}
```

**Verification**:
- [ ] Unit test: Returns correct filter for read action
- [ ] Unit test: Returns correct filter for update action
- [ ] Integration test: Prisma query with filter returns only accessible records

---

### Task 2.3: Field-Level Filtering

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Modify**:
- `packages/applications/src/common/authorized-base.service.ts`

**Implementation Steps**:

1. [ ] Implement `getPermittedFields(action, subject)` method
2. [ ] Implement `filterFields(data, action, subject)` method
3. [ ] Handle array responses in `filterFields`

**Verification**:
- [ ] Unit test: Returns undefined when no field restrictions
- [ ] Unit test: Returns correct fields when restricted
- [ ] Unit test: Filters object correctly
- [ ] Unit test: Filters array of objects correctly

---

## Phase 3: Advanced Decorators

### Task 3.1: OR Logic Support (AuthorizeAny)

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Modify**:
- `apps/api/src/decorators/authorize.decorator.ts`

**Implementation Steps**:

1. [ ] Create `AuthorizeAny` decorator
2. [ ] Set `PERMISSION_MODE_KEY` to 'OR'
3. [ ] Export `RequireAny` shorthand

**Verification**:
- [ ] Unit test: Decorator sets correct metadata
- [ ] Integration test: OR logic works correctly

---

### Task 3.2: Resource-Level Checks (AuthorizeResource)

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Modify**:
- `apps/api/src/decorators/authorize.decorator.ts`
- `packages/applications/src/authorization/authorization.guard.ts`

**Implementation Steps**:

1. [ ] Create `AuthorizeResource` decorator
2. [ ] Add `RESOURCE_CHECK_KEY` metadata key
3. [ ] Update guard to handle resource-level checks
4. [ ] Load resource from database for permission check

**Verification**:
- [ ] Unit test: Decorator sets correct metadata
- [ ] Integration test: Resource check loads and validates correctly

---

### Task 3.3: UserAbility Parameter Decorator

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Modify**:
- `apps/api/src/decorators/authorize.decorator.ts`

**Implementation Steps**:

1. [ ] Create `UserAbility` parameter decorator
2. [ ] Extract ability from request context

**Code Template**:

```typescript
export const UserAbility = createParamDecorator(
    (data: unknown, ctx: ExecutionContext) => {
        const request = ctx.switchToHttp().getRequest();
        return request.ability;
    },
);
```

**Verification**:
- [ ] Unit test: Decorator extracts ability from request
- [ ] Integration test: Ability available in controller method

---

## Phase 4: Permission Management API

### Task 4.1: Roles Controller

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Create**:
- `apps/api/src/controllers/rbac/roles.controller.ts`
- `packages/applications/src/services/rbac/role.service.ts`
- `packages/applications/src/services/rbac/role.service.interface.ts`

**Endpoints**:
- `GET /rbac/roles` - List all roles
- `GET /rbac/roles/:id` - Get role by ID
- `POST /rbac/roles` - Create new role
- `PUT /rbac/roles/:id` - Update role
- `DELETE /rbac/roles/:id` - Delete role
- `POST /rbac/roles/:roleId/policies/:policyId` - Assign policy to role
- `DELETE /rbac/roles/:roleId/policies/:policyId` - Remove policy from role

**Verification**:
- [ ] Integration test: CRUD operations work correctly
- [ ] Integration test: Policy assignment works
- [ ] Integration test: Cache invalidation triggered on changes

---

### Task 4.2: Policies Controller

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Create**:
- `apps/api/src/controllers/rbac/policies.controller.ts`
- `packages/applications/src/services/rbac/policy.service.ts`
- `packages/applications/src/services/rbac/policy.service.interface.ts`

**Endpoints**:
- `GET /rbac/policies` - List all policies
- `GET /rbac/policies/:id` - Get policy by ID
- `POST /rbac/policies` - Create new policy
- `PUT /rbac/policies/:id` - Update policy
- `DELETE /rbac/policies/:id` - Delete policy
- `POST /rbac/policies/:id/validate` - Validate policy rules

**Verification**:
- [ ] Integration test: CRUD operations work correctly
- [ ] Integration test: Policy validation works
- [ ] Integration test: Cache invalidation triggered on changes

---

### Task 4.3: User Role Assignment Controller

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Create**:
- `apps/api/src/controllers/rbac/user-roles.controller.ts`

**Endpoints**:
- `GET /rbac/users/:userId/roles` - Get user's roles
- `POST /rbac/users/:userId/roles/:roleId` - Assign role to user
- `DELETE /rbac/users/:userId/roles/:roleId` - Remove role from user
- `GET /rbac/users/:userId/permissions` - Get user's effective permissions

**Verification**:
- [ ] Integration test: Role assignment works
- [ ] Integration test: Effective permissions calculated correctly
- [ ] Integration test: Cache invalidation triggered on changes

---

### Task 4.4: Permission Validation Endpoints

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Modify**:
- `apps/api/src/controllers/rbac/policies.controller.ts`

**Endpoints**:
- `POST /rbac/check` - Check if user has permission
- `POST /rbac/check-bulk` - Check multiple permissions at once

**Verification**:
- [ ] Integration test: Single permission check works
- [ ] Integration test: Bulk permission check works

---

## Phase 5: Audit & Monitoring

### Task 5.1: Authorization Audit Service

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Create**:
- `packages/applications/src/services/audit/authorization-audit.service.ts`
- `packages/applications/src/services/audit/authorization-audit.interface.ts`

**Implementation Steps**:

1. [ ] Create `AuthorizationAuditService` class
2. [ ] Implement `logAuthorizationDecision()` method
3. [ ] Implement `getAuthorizationHistory()` method
4. [ ] Add Redis pub/sub for real-time monitoring

**Verification**:
- [ ] Unit test: Audit entries created correctly
- [ ] Unit test: History retrieval works
- [ ] Integration test: Redis pub/sub works

---

### Task 5.2: AuditLog Database Model

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Create/Modify**:
- `packages/database/src/prisma/db_main/audit.prisma`

**Implementation Steps**:

1. [ ] Create AuditLog model
2. [ ] Add indexes for common queries
3. [ ] Generate Prisma client
4. [ ] Create migration

**Verification**:
- [ ] Migration runs successfully
- [ ] Model accessible via Prisma client

---

### Task 5.3: Real-time Monitoring

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Modify**:
- `packages/applications/src/services/audit/authorization-audit.service.ts`

**Implementation Steps**:

1. [ ] Publish audit events to Redis channel
2. [ ] Create subscriber for monitoring dashboard

**Verification**:
- [ ] Integration test: Events published to Redis
- [ ] Integration test: Subscriber receives events

---

## Phase 6: Migration & Cleanup

### Task 6.1: Deprecate @UseAuthorized

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Files to Modify**:
- `apps/api/src/decorators/useAuthorized.decorator.ts`

**Implementation Steps**:

1. [ ] Add `@deprecated` JSDoc tag
2. [ ] Add console.warn for deprecation notice
3. [ ] Update documentation with migration guide

**Verification**:
- [ ] Deprecation warning appears in console
- [ ] Documentation updated

---

### Task 6.2: Migrate Existing Controllers

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Controllers to Migrate**:
- [ ] `mlflow.controller.ts`
- [ ] `user-settings.controller.ts`
- [ ] `global-settings.controller.ts`
- [ ] Other controllers using `@UseAuthorized`

**Migration Pattern**:
```typescript
// Before
@UseAuthorized({ roles: ['SUPER_ADMIN', 'ADMIN'] })

// After
@CanManage('Resource')  // or appropriate permission
```

**Verification**:
- [ ] All controllers migrated
- [ ] No `@UseAuthorized` usage remains (except deprecated file)
- [ ] All tests pass

---

### Task 6.3: Update Services to AuthorizedBaseService

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Services to Update**:
- [ ] Identify services that need authorization
- [ ] Extend `AuthorizedBaseService`
- [ ] Add `getAccessibleFilter` to queries
- [ ] Add `assertCanAccess` for resource operations

**Verification**:
- [ ] Services extend AuthorizedBaseService
- [ ] Queries use accessible filters
- [ ] Resource operations check permissions

---

### Task 6.4: Documentation Updates

**Status**: [ ] Not Started / [ ] In Progress / [ ] Completed / [ ] Verified

**Documentation to Update**:
- [ ] API documentation (Swagger)
- [ ] Developer guide
- [ ] Migration guide
- [ ] Security documentation

**Verification**:
- [ ] All documentation updated
- [ ] Examples are accurate

---

## Post-Implementation Checklist

- [ ] All tests pass: `pnpm test`
- [ ] Build succeeds: `pnpm build`
- [ ] Lint passes: `pnpm lint`
- [ ] Security scan: `pnpm audit`
- [ ] Manual testing of authorization flows
- [ ] Performance benchmarks met
- [ ] Documentation complete
- [ ] Create PR with detailed description
- [ ] Request security review

---

## Rollback Plan

If issues arise after deployment:

1. **Cache Issues**:
   ```bash
   # Clear all authorization cache
   redis-cli KEYS "policy:ability:*" | xargs redis-cli DEL
   ```

2. **Performance Issues**:
   ```bash
   # Increase cache TTL
   # Set env var: POLICY_CACHE_TTL=600
   ```

3. **Authorization Failures**:
   ```bash
   # Disable policy-based auth temporarily
   # Set env var: USE_LEGACY_AUTH=true
   ```

4. **Full Rollback**:
   ```bash
   git revert <commit-hash>
   pnpm install
   pnpm build
   # Redeploy
   ```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | (required) | Redis connection URL |
| `POLICY_CACHE_TTL` | `300` | Cache TTL in seconds |
| `USE_LEGACY_AUTH` | `false` | Fall back to legacy auth |
| `AUDIT_AUTHORIZATION` | `true` | Enable authorization audit logging |

---

## Sign-off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Developer | | | |
| Security Reviewer | | | |
| Tech Lead | | | |
