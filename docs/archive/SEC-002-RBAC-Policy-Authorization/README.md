# SEC-002: Full RBAC Policy-Based Authorization System

| Field | Value |
|-------|-------|
| **Ticket Number** | SEC-002 |
| **Feature Name** | Role-Based Access Control with Policy Strategy |
| **Created Date** | 2026-01-25 |
| **Last Updated** | 2026-01-25 |
| **Status** | Implemented |

---

## 1. Executive Summary

This document outlines the implementation plan for a comprehensive Role-Based Access Control (RBAC) system using a **policy-based strategy** with CASL (Isomorphic Authorization Library). The system is designed for multi-tenant environments with support for:

- **Role Hierarchy** - Roles can inherit permissions from parent roles
- **Policy-Based Rules** - Fine-grained permissions stored as JSON rules in the database
- **Attribute-Based Conditions** - Dynamic conditions based on user attributes, resource ownership, and tenant context
- **Database-Level Filtering** - Automatic query filtering using CASL + Prisma integration
- **Caching** - Redis-based caching for performance optimization
- **Audit Trail** - Complete logging of authorization decisions

---

## 2. Current State Analysis

### 2.1 Existing Implementation

The HOPE platform now uses a **policy-based RBAC implementation**:

#### Database Schema (Policy-Based)
- `Role` - Roles with hierarchy support (`parentRoleId`)
- `Policy` - CASL-compatible rules stored as JSON
- `RolePolicy` - Role-Policy junction table
- `UserRoleAssignment` - User-Role assignments with tenant scope (1:1 with Role)
- `UserGroupRoleAssignment` - User Group-Role assignments for group-based permissions
- `UserGroup` - User groups with role assignments via `UserGroupRoleAssignment`

#### Deprecated Models (Backward Compatibility)
- ~~`Permission`~~ - Replaced by Policy rules
- ~~`RolePermission`~~ - Replaced by RolePolicy
- ~~`UserGroupAssignment`~~ - Replaced by UserGroupRoleAssignment

#### Authorization Components (Partially Implemented)
- `PolicyEngine` - Builds CASL abilities from database policies
- `AuthorizationGuard` - NestJS guard for route-level authorization
- `Authorize` decorator - Route decorator for permission requirements
- Seed data for default roles and policies

### 2.2 Gaps Identified

| Gap | Description | Impact |
|-----|-------------|--------|
| **No Redis Caching** | PolicyEngine has TODO for Redis caching | Performance degradation |
| **No Database Filtering** | No `accessibleBy` integration with Prisma | Data leakage risk |
| **No Field-Level Access** | Cannot restrict specific fields | Over-exposure of data |
| **Legacy Decorators** | `@UseAuthorized` uses hardcoded roles | Inconsistent authorization |
| **No OR Logic** | `CanAny` decorator is placeholder | Limited flexibility |
| **No Audit Logging** | Authorization decisions not logged | Compliance issues |
| **No Permission Management API** | No CRUD for roles/policies | Admin limitations |
| **No Resource-Level Checks** | Only route-level authorization | Insufficient granularity |

---

## 3. Proposed Architecture

### 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API Gateway (NestJS)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐    ┌─────────────────┐    ┌─────────────────────────────┐  │
│  │   Request   │───▶│  JwtAuthGuard   │───▶│   AuthorizationGuard        │  │
│  └─────────────┘    └─────────────────┘    │   (Policy Evaluation)       │  │
│                                             └──────────────┬──────────────┘  │
│                                                            │                 │
│                                                            ▼                 │
│                              ┌─────────────────────────────────────────┐    │
│                              │           PolicyEngine                   │    │
│                              │  ┌─────────────────────────────────┐    │    │
│                              │  │  1. Check Redis Cache           │    │    │
│                              │  │  2. Load Policies from DB       │    │    │
│                              │  │  3. Resolve Dynamic Variables   │    │    │
│                              │  │  4. Build CASL Ability          │    │    │
│                              │  │  5. Cache in Redis              │    │    │
│                              │  └─────────────────────────────────┘    │    │
│                              └──────────────┬──────────────────────────┘    │
│                                             │                                │
│                     ┌───────────────────────┼───────────────────────┐       │
│                     ▼                       ▼                       ▼       │
│              ┌─────────────┐        ┌─────────────┐        ┌─────────────┐  │
│              │  Route-Level│        │Resource-Level│       │ Field-Level │  │
│              │    Check    │        │    Check    │        │    Check    │  │
│              │ can(action, │        │can(action,  │        │ permitted   │  │
│              │  subject)   │        │subject,     │        │   Fields()  │  │
│              │             │        │resource)    │        │             │  │
│              └─────────────┘        └─────────────┘        └─────────────┘  │
│                                             │                                │
│                                             ▼                                │
│                              ┌─────────────────────────────────────────┐    │
│                              │         Prisma + accessibleBy           │    │
│                              │   (Automatic Query Filtering)           │    │
│                              └─────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Database (PostgreSQL)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌────────────┐  ┌────────┐  ┌──────────────────────────────┐  │
│  │  User   │  │ UserRole   │  │  Role  │  │  Policy (CASL Rules JSON)    │  │
│  │         │──│ Assignment │──│        │──│                              │  │
│  └─────────┘  └────────────┘  └────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Authorization Flow

```
1. Request arrives at protected endpoint
2. JwtAuthGuard validates JWT token
3. AuthorizationGuard extracts required permissions from @Authorize decorator
4. PolicyEngine builds CASL ability:
   a. Check Redis cache for user's ability
   b. If cache miss, load policies from database
   c. Resolve dynamic variables (${user.id}, ${context.tenantId})
   d. Build CASL ability using createPrismaAbility
   e. Cache ability in Redis (TTL: 5 minutes)
5. Guard checks ability.can(action, subject)
6. If allowed, request proceeds to controller
7. Service layer uses ability for:
   a. Resource-level checks: ability.can(action, subject, resource)
   b. Query filtering: accessibleBy(ability, action).Subject
   c. Field filtering: ability.relevantRuleFor(action, subject).fields
8. Audit log records authorization decision
```

---

## 4. Implementation Plan

### Phase 1: Core Infrastructure Enhancement

#### 4.1 Redis Integration for PolicyEngine

**Files to Create/Modify:**
- `packages/applications/src/authorization/policy.engine.ts`
- `packages/applications/src/authorization/authorization.module.ts`

**Implementation:**

```typescript
// policy.engine.ts - Enhanced with Redis caching
import { Injectable, Logger, Inject } from '@nestjs/common';
import { createPrismaAbility, PrismaQuery, accessibleBy } from '@casl/prisma';
import { PureAbility, RawRuleOf } from '@casl/ability';
import { Redis } from 'ioredis';
import { CoreDatabaseService, ResourceStatusType } from '@arcaai/domains';

export type AppAbility = PureAbility<[string, string], PrismaQuery>;

export interface PolicyRule {
    action: string;
    subject: string;
    conditions?: Record<string, unknown>;
    fields?: string[];
    inverted?: boolean;
    reason?: string;
}

export interface PolicyContext {
    userId: string;
    tenantId?: string;
    params?: Record<string, unknown>;
}

@Injectable()
export class PolicyEngine {
    private readonly logger = new Logger(PolicyEngine.name);
    private readonly CACHE_TTL = 300; // 5 minutes
    private readonly CACHE_PREFIX = 'policy:ability:';

    constructor(
        private readonly databaseService: CoreDatabaseService,
        @Inject('REDIS_CLIENT') private readonly redis: Redis,
    ) {}

    async buildAbility(context: PolicyContext): Promise<AppAbility> {
        const cacheKey = this.getCacheKey(context);

        // Try cache first
        const cached = await this.redis.get(cacheKey);
        if (cached) {
            this.logger.debug(`Cache hit for user ${context.userId}`);
            return createPrismaAbility(JSON.parse(cached));
        }

        // Load from database
        const rules = await this.loadUserPolicies(context);

        // Build ability
        const ability = createPrismaAbility(rules);

        // Cache the rules
        await this.redis.setex(cacheKey, this.CACHE_TTL, JSON.stringify(rules));

        this.logger.debug(`Built ability for user ${context.userId} with ${rules.length} rules`);

        return ability;
    }

    /**
     * Get accessible query filter for Prisma
     */
    getAccessibleBy(ability: AppAbility, action: string = 'read') {
        return accessibleBy(ability, action);
    }

    /**
     * Get permitted fields for a subject
     */
    getPermittedFields(ability: AppAbility, action: string, subject: string): string[] | undefined {
        const rule = ability.relevantRuleFor(action, subject);
        return rule?.fields;
    }

    // ... rest of implementation
}
```

#### 4.2 Enhanced Authorization Guard

**Files to Create/Modify:**
- `packages/applications/src/authorization/authorization.guard.ts`

**Implementation:**

```typescript
// authorization.guard.ts - Enhanced with resource-level checks
@Injectable()
export class AuthorizationGuard implements CanActivate {
    private readonly logger = new Logger(AuthorizationGuard.name);

    constructor(
        private readonly reflector: Reflector,
        private readonly policyEngine: PolicyEngine,
        private readonly cls: ClsService<IActiveUserContext>,
        @Inject('AUDIT_SERVICE') private readonly auditService: IAuditService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        // ... existing logic ...

        // Build ability
        const ability = await this.policyEngine.buildAbility({
            userId: user.id,
            tenantId: user.tenantId || undefined,
            params: request.params,
        });

        // Store ability in context for service layer use
        this.cls.set('userAbility', ability);

        // Check all required permissions
        for (const permission of required) {
            const allowed = ability.can(permission.action, permission.subject);
            
            // Audit log
            await this.auditService.logAuthorizationDecision({
                userId: user.id,
                action: permission.action,
                subject: permission.subject,
                allowed,
                endpoint: request.path,
                method: request.method,
            });

            if (!allowed) {
                this.logger.warn(
                    `Access denied: User ${user.id} cannot ${permission.action} ${permission.subject}`
                );
                throw new ForbiddenException(
                    `You don't have permission to ${permission.action} ${permission.subject}`
                );
            }
        }

        return true;
    }
}
```

### Phase 2: Database-Level Query Filtering

#### 4.3 Base Service with Authorization

**Files to Create:**
- `packages/applications/src/common/authorized-base.service.ts`

**Implementation:**

```typescript
// authorized-base.service.ts
import { Injectable, ForbiddenException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PolicyEngine, AppAbility } from '../authorization';
import { IActiveUserContext } from '../interfaces';
import { accessibleBy } from '@casl/prisma';

@Injectable()
export abstract class AuthorizedBaseService {
    constructor(
        protected readonly cls: ClsService<IActiveUserContext>,
        protected readonly policyEngine: PolicyEngine,
    ) {}

    /**
     * Get the current user's ability from context
     */
    protected getAbility(): AppAbility {
        const ability = this.cls.get('userAbility');
        if (!ability) {
            throw new ForbiddenException('No authorization context available');
        }
        return ability;
    }

    /**
     * Get accessible filter for Prisma queries
     * @param action - The action to check (read, update, delete)
     * @param subject - The subject/model name
     */
    protected getAccessibleFilter<T extends string>(
        action: string,
        subject: T
    ): Record<string, unknown> {
        const ability = this.getAbility();
        return accessibleBy(ability, action)[subject] || {};
    }

    /**
     * Check if user can perform action on specific resource
     */
    protected canAccess(action: string, subject: string, resource?: unknown): boolean {
        const ability = this.getAbility();
        return ability.can(action, subject, resource);
    }

    /**
     * Assert user can perform action, throw if not
     */
    protected assertCanAccess(action: string, subject: string, resource?: unknown): void {
        if (!this.canAccess(action, subject, resource)) {
            throw new ForbiddenException(
                `You don't have permission to ${action} this ${subject}`
            );
        }
    }

    /**
     * Get permitted fields for a subject
     */
    protected getPermittedFields(action: string, subject: string): string[] | undefined {
        const ability = this.getAbility();
        return this.policyEngine.getPermittedFields(ability, action, subject);
    }

    /**
     * Filter response to only include permitted fields
     */
    protected filterFields<T extends Record<string, unknown>>(
        data: T,
        action: string,
        subject: string
    ): Partial<T> {
        const fields = this.getPermittedFields(action, subject);
        if (!fields) return data; // No field restrictions

        const filtered: Partial<T> = {};
        for (const field of fields) {
            if (field in data) {
                filtered[field as keyof T] = data[field as keyof T];
            }
        }
        return filtered;
    }
}
```

#### 4.4 Example Service Implementation

```typescript
// user.service.ts - Example using AuthorizedBaseService
@Injectable()
export class UserService extends AuthorizedBaseService {
    constructor(
        cls: ClsService<IActiveUserContext>,
        policyEngine: PolicyEngine,
        private readonly prisma: PrismaClient,
    ) {
        super(cls, policyEngine);
    }

    async findAll(query: PaginatedQuery): Promise<PaginatedResult<User>> {
        // Automatic filtering based on user's permissions
        const accessibleFilter = this.getAccessibleFilter('read', 'User');

        const [data, total] = await Promise.all([
            this.prisma.user.findMany({
                where: {
                    AND: [
                        accessibleFilter,
                        // Additional query filters
                        query.filter ? JSON.parse(query.filter) : {},
                    ],
                },
                skip: query.skip,
                take: query.take,
            }),
            this.prisma.user.count({
                where: accessibleFilter,
            }),
        ]);

        return { data, total, ...query };
    }

    async findOne(id: string): Promise<User> {
        const user = await this.prisma.user.findUnique({
            where: { id },
        });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        // Resource-level check
        this.assertCanAccess('read', 'User', user);

        // Filter fields based on permissions
        return this.filterFields(user, 'read', 'User') as User;
    }

    async update(id: string, data: UpdateUserDto): Promise<User> {
        const user = await this.prisma.user.findUnique({
            where: { id },
        });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        // Resource-level check
        this.assertCanAccess('update', 'User', user);

        return this.prisma.user.update({
            where: { id },
            data,
        });
    }
}
```

### Phase 3: Advanced Decorators and Guards

#### 4.5 Enhanced Decorators

**Files to Create/Modify:**
- `apps/api/src/decorators/authorize.decorator.ts`

```typescript
// authorize.decorator.ts - Enhanced with OR logic and resource checks
import { SetMetadata, UseGuards, applyDecorators, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards';
import {
    AuthorizationGuard,
    REQUIRED_PERMISSIONS_KEY,
    SKIP_AUTH_KEY,
    RequiredPermission,
} from '@arcaai/applications';

// Metadata keys
export const PERMISSION_MODE_KEY = 'permission_mode';
export const RESOURCE_CHECK_KEY = 'resource_check';

export type PermissionMode = 'AND' | 'OR';

export interface ResourceCheckConfig {
    paramName: string;
    subject: string;
}

/**
 * Require specific permissions for a route
 * @param permissions - Array of [action, subject] tuples
 */
export function Authorize(...permissions: [string, string][]) {
    const required: RequiredPermission[] = permissions.map(([action, subject]) => ({
        action,
        subject,
    }));

    return applyDecorators(
        SetMetadata(REQUIRED_PERMISSIONS_KEY, required),
        SetMetadata(PERMISSION_MODE_KEY, 'AND'),
        UseGuards(JwtAuthGuard, AuthorizationGuard),
        ApiBearerAuth(),
    );
}

/**
 * Require ANY of the specified permissions (OR logic)
 * At least one permission must be satisfied
 */
export function AuthorizeAny(...permissions: [string, string][]) {
    const required: RequiredPermission[] = permissions.map(([action, subject]) => ({
        action,
        subject,
    }));

    return applyDecorators(
        SetMetadata(REQUIRED_PERMISSIONS_KEY, required),
        SetMetadata(PERMISSION_MODE_KEY, 'OR'),
        UseGuards(JwtAuthGuard, AuthorizationGuard),
        ApiBearerAuth(),
    );
}

/**
 * Check permission against a specific resource from route params
 * @param paramName - Route parameter name containing resource ID
 * @param subject - Resource type
 */
export function AuthorizeResource(paramName: string, subject: string) {
    return applyDecorators(
        SetMetadata(RESOURCE_CHECK_KEY, { paramName, subject }),
        UseGuards(JwtAuthGuard, AuthorizationGuard),
        ApiBearerAuth(),
    );
}

/**
 * Decorator to inject the user's CASL ability into controller method
 */
export const UserAbility = createParamDecorator(
    (data: unknown, ctx: ExecutionContext) => {
        const request = ctx.switchToHttp().getRequest();
        return request.ability;
    },
);

// Shorthand decorators
export const CanRead = (subject: string) => Authorize(['read', subject]);
export const CanList = (subject: string) => Authorize(['list', subject]);
export const CanCreate = (subject: string) => Authorize(['create', subject]);
export const CanUpdate = (subject: string) => Authorize(['update', subject]);
export const CanDelete = (subject: string) => Authorize(['delete', subject]);
export const CanManage = (subject: string) => Authorize(['manage', subject]);
export const RequireAll = (...permissions: [string, string][]) => Authorize(...permissions);
export const RequireAny = (...permissions: [string, string][]) => AuthorizeAny(...permissions);
```

#### 4.6 Updated Authorization Guard with OR Logic

```typescript
// authorization.guard.ts - With OR logic support
async canActivate(context: ExecutionContext): Promise<boolean> {
    // ... existing setup ...

    // Get permission mode (AND or OR)
    const mode = this.reflector.getAllAndOverride<PermissionMode>(
        PERMISSION_MODE_KEY,
        [context.getHandler(), context.getClass()]
    ) || 'AND';

    // Check permissions based on mode
    if (mode === 'AND') {
        // All permissions required
        for (const permission of required) {
            if (!ability.can(permission.action, permission.subject)) {
                throw new ForbiddenException(
                    `You don't have permission to ${permission.action} ${permission.subject}`
                );
            }
        }
    } else {
        // At least one permission required
        const hasAny = required.some(permission => 
            ability.can(permission.action, permission.subject)
        );
        if (!hasAny) {
            throw new ForbiddenException(
                `You don't have any of the required permissions`
            );
        }
    }

    return true;
}
```

### Phase 4: Permission Management API

#### 4.7 RBAC Management Controllers

**Files to Create:**
- `apps/api/src/controllers/rbac/roles.controller.ts`
- `apps/api/src/controllers/rbac/policies.controller.ts`
- `apps/api/src/controllers/rbac/permissions.controller.ts`

```typescript
// roles.controller.ts
@ApiTags('rbac')
@Controller('rbac/roles')
export class RolesController {
    constructor(
        @Inject(IRoleService) private readonly roleService: IRoleService,
        private readonly policyEngine: PolicyEngine,
    ) {}

    @Get()
    @CanList('Role')
    async findAll(@Query() query: PaginatedQuery): Promise<PaginatedRoleResponse> {
        return this.roleService.findAll(query);
    }

    @Get(':id')
    @CanRead('Role')
    async findOne(@Param('id') id: string): Promise<RoleResponse> {
        return this.roleService.findOne(id);
    }

    @Post()
    @CanCreate('Role')
    async create(@Body() dto: CreateRoleDto): Promise<RoleResponse> {
        return this.roleService.create(dto);
    }

    @Put(':id')
    @CanUpdate('Role')
    async update(
        @Param('id') id: string,
        @Body() dto: UpdateRoleDto
    ): Promise<RoleResponse> {
        const result = await this.roleService.update(id, dto);
        // Invalidate cache for all users with this role
        await this.policyEngine.invalidateRole(id);
        return result;
    }

    @Delete(':id')
    @CanDelete('Role')
    async remove(@Param('id') id: string): Promise<void> {
        await this.roleService.remove(id);
        await this.policyEngine.invalidateRole(id);
    }

    @Post(':roleId/policies/:policyId')
    @CanManage('RolePolicy')
    async assignPolicy(
        @Param('roleId') roleId: string,
        @Param('policyId') policyId: string,
        @Body() dto: AssignPolicyDto
    ): Promise<void> {
        await this.roleService.assignPolicy(roleId, policyId, dto.priority);
        await this.policyEngine.invalidateRole(roleId);
    }

    @Delete(':roleId/policies/:policyId')
    @CanManage('RolePolicy')
    async removePolicy(
        @Param('roleId') roleId: string,
        @Param('policyId') policyId: string
    ): Promise<void> {
        await this.roleService.removePolicy(roleId, policyId);
        await this.policyEngine.invalidateRole(roleId);
    }
}
```

### Phase 5: Audit Logging

#### 4.8 Authorization Audit Service

**Files to Create:**
- `packages/applications/src/services/audit/authorization-audit.service.ts`

```typescript
// authorization-audit.service.ts
export interface AuthorizationAuditEntry {
    userId: string;
    action: string;
    subject: string;
    resourceId?: string;
    allowed: boolean;
    endpoint: string;
    method: string;
    reason?: string;
    timestamp: Date;
    tenantId?: string;
    ipAddress?: string;
}

@Injectable()
export class AuthorizationAuditService implements IAuditService {
    private readonly logger = new Logger(AuthorizationAuditService.name);

    constructor(
        private readonly databaseService: CoreDatabaseService,
        @Inject('REDIS_CLIENT') private readonly redis: Redis,
    ) {}

    async logAuthorizationDecision(entry: Omit<AuthorizationAuditEntry, 'timestamp'>): Promise<void> {
        const auditEntry: AuthorizationAuditEntry = {
            ...entry,
            timestamp: new Date(),
        };

        // Log to database asynchronously
        this.databaseService.client.auditLog.create({
            data: {
                eventType: 'AUTHORIZATION',
                userId: entry.userId,
                action: entry.action,
                resourceType: entry.subject,
                resourceId: entry.resourceId,
                success: entry.allowed,
                metadata: {
                    endpoint: entry.endpoint,
                    method: entry.method,
                    reason: entry.reason,
                },
            },
        }).catch(err => {
            this.logger.error('Failed to log authorization decision', err);
        });

        // Also publish to Redis for real-time monitoring
        await this.redis.publish('authorization:audit', JSON.stringify(auditEntry));
    }

    async getAuthorizationHistory(
        userId: string,
        options: { limit?: number; since?: Date }
    ): Promise<AuthorizationAuditEntry[]> {
        const logs = await this.databaseService.client.auditLog.findMany({
            where: {
                userId,
                eventType: 'AUTHORIZATION',
                createdAt: options.since ? { gte: options.since } : undefined,
            },
            orderBy: { createdAt: 'desc' },
            take: options.limit || 100,
        });

        return logs.map(log => ({
            userId: log.userId,
            action: log.action,
            subject: log.resourceType,
            resourceId: log.resourceId,
            allowed: log.success,
            endpoint: (log.metadata as any)?.endpoint,
            method: (log.metadata as any)?.method,
            reason: (log.metadata as any)?.reason,
            timestamp: log.createdAt,
            tenantId: log.tenantId,
        }));
    }
}
```

### Phase 6: Migration and Deprecation

#### 4.9 Deprecate Legacy Decorators

**Files to Modify:**
- `apps/api/src/decorators/useAuthorized.decorator.ts`

```typescript
// useAuthorized.decorator.ts - Mark as deprecated
/**
 * @deprecated Use @Authorize() decorator instead for policy-based authorization.
 * This decorator will be removed in v3.0.
 * 
 * Migration guide:
 * - @UseAuthorized({ roles: ['ADMIN'] }) → @Authorize(['manage', 'Resource'])
 * - @UseAuthorized({ roles: ['USER'] }) → @Authorize(['read', 'Resource'])
 */
export function UseAuthorized({
    groups = [],
    roles = [],
}: UseAuthorizedProps): MethodDecorator & ClassDecorator {
    console.warn(
        'DEPRECATION WARNING: @UseAuthorized is deprecated. Use @Authorize() instead.'
    );
    // ... existing implementation
}
```

---

## 5. Database Schema Updates

### 5.1 New Models Required

```prisma
// AuditLog model for authorization decisions
model AuditLog {
    id           String   @id @default(uuid(7))
    eventType    String   // 'AUTHORIZATION', 'LOGIN', 'LOGOUT', etc.
    userId       String
    tenantId     String?
    action       String
    resourceType String
    resourceId   String?
    success      Boolean
    metadata     Json?    @db.JsonB
    ipAddress    String?
    userAgent    String?
    createdAt    DateTime @default(now())

    @@index([userId])
    @@index([eventType])
    @@index([createdAt])
    @@index([tenantId])
    @@schema("core")
}
```

### 5.2 Schema Enhancements

```prisma
// Add to Permission model
model Permission {
    // ... existing fields ...
    
    // NEW: Field-level permissions
    allowedFields String[] @default([])
    deniedFields  String[] @default([])
}
```

---

## 6. Testing Strategy

### 6.1 Unit Tests

```typescript
// policy.engine.spec.ts
describe('PolicyEngine', () => {
    describe('buildAbility', () => {
        it('should build ability from database policies', async () => {
            // Test policy loading and ability building
        });

        it('should cache abilities in Redis', async () => {
            // Test caching behavior
        });

        it('should resolve dynamic variables', async () => {
            // Test ${user.id}, ${context.tenantId} resolution
        });

        it('should handle role hierarchy', async () => {
            // Test parent role policy inheritance
        });
    });

    describe('invalidation', () => {
        it('should invalidate user cache', async () => {});
        it('should invalidate role cache for all users', async () => {});
        it('should invalidate policy cache', async () => {});
    });
});
```

### 6.2 Integration Tests

```typescript
// authorization.e2e-spec.ts
describe('Authorization (e2e)', () => {
    describe('Route-level authorization', () => {
        it('should allow access with correct permissions', async () => {});
        it('should deny access without permissions', async () => {});
        it('should handle OR logic correctly', async () => {});
    });

    describe('Resource-level authorization', () => {
        it('should allow access to owned resources', async () => {});
        it('should deny access to other users resources', async () => {});
    });

    describe('Multi-tenant authorization', () => {
        it('should isolate data between tenants', async () => {});
        it('should allow cross-tenant access for super admins', async () => {});
    });
});
```

---

## 7. Migration Guide

### 7.1 For Existing Controllers

**Before (Legacy):**
```typescript
@Controller('users')
@UseAuthorized({ roles: ['SUPER_ADMIN', 'ADMIN'] })
export class UsersController {
    @Get()
    findAll() { ... }
}
```

**After (Policy-Based):**
```typescript
@Controller('users')
export class UsersController {
    @Get()
    @CanList('User')
    findAll() { ... }

    @Get(':id')
    @CanRead('User')
    findOne(@Param('id') id: string) { ... }

    @Post()
    @CanCreate('User')
    create(@Body() dto: CreateUserDto) { ... }

    @Put(':id')
    @CanUpdate('User')
    update(@Param('id') id: string, @Body() dto: UpdateUserDto) { ... }

    @Delete(':id')
    @CanDelete('User')
    remove(@Param('id') id: string) { ... }
}
```

### 7.2 For Services

**Before:**
```typescript
@Injectable()
export class UserService {
    async findAll() {
        return this.prisma.user.findMany();
    }
}
```

**After:**
```typescript
@Injectable()
export class UserService extends AuthorizedBaseService {
    async findAll() {
        const filter = this.getAccessibleFilter('read', 'User');
        return this.prisma.user.findMany({
            where: filter,
        });
    }
}
```

---

## 8. Performance Considerations

### 8.1 Caching Strategy

| Cache Type | TTL | Invalidation Trigger |
|------------|-----|---------------------|
| User Ability | 5 minutes | Role change, Policy change, Logout |
| Policy Rules | 10 minutes | Policy update |
| Role Hierarchy | 30 minutes | Role update |

### 8.2 Database Optimization

- Index on `UserRoleAssignment.userId`
- Index on `RolePolicy.roleId`
- Composite index on `Policy.name, Policy.scope`

### 8.3 Benchmarks

| Operation | Target Latency | Notes |
|-----------|---------------|-------|
| Cache hit | < 5ms | Redis lookup |
| Cache miss | < 50ms | Database query + build |
| Route authorization | < 10ms | With cached ability |
| Query filtering | < 5ms | accessibleBy generation |

---

## 9. Security Considerations

### 9.1 Defense in Depth

1. **Route Level** - Guards prevent unauthorized route access
2. **Service Level** - `assertCanAccess` validates resource ownership
3. **Database Level** - `accessibleBy` filters queries automatically
4. **Field Level** - `filterFields` removes sensitive data

### 9.2 Audit Trail

All authorization decisions are logged with:
- User ID
- Action attempted
- Resource type and ID
- Decision (allowed/denied)
- Timestamp
- IP address
- Endpoint and method

### 9.3 Cache Security

- Cache keys include tenant ID for isolation
- Cache invalidation on permission changes
- Short TTL to limit exposure window

---

## 10. Implementation Timeline

| Phase | Description | Dependencies |
|-------|-------------|--------------|
| **Phase 1** | Core Infrastructure (Redis, PolicyEngine) | Redis service available |
| **Phase 2** | Database-Level Filtering | Phase 1 |
| **Phase 3** | Advanced Decorators | Phase 1 |
| **Phase 4** | Permission Management API | Phase 1, 2 |
| **Phase 5** | Audit Logging | Phase 1 |
| **Phase 6** | Migration & Deprecation | Phase 1-5 |

---

## 11. Files to Create/Modify Summary

### New Files

| File | Description |
|------|-------------|
| `packages/applications/src/common/authorized-base.service.ts` | Base service with authorization |
| `packages/applications/src/services/audit/authorization-audit.service.ts` | Audit logging service |
| `apps/api/src/controllers/rbac/roles.controller.ts` | Role management API |
| `apps/api/src/controllers/rbac/policies.controller.ts` | Policy management API |
| `apps/api/src/controllers/rbac/permissions.controller.ts` | Permission management API |
| `packages/database/src/prisma/db_main/audit.prisma` | AuditLog model |

### Modified Files

| File | Changes |
|------|---------|
| `packages/applications/src/authorization/policy.engine.ts` | Add Redis caching, accessibleBy |
| `packages/applications/src/authorization/authorization.guard.ts` | Add OR logic, audit logging |
| `packages/applications/src/authorization/authorization.module.ts` | Add Redis provider |
| `apps/api/src/decorators/authorize.decorator.ts` | Add AuthorizeAny, AuthorizeResource |
| `apps/api/src/decorators/useAuthorized.decorator.ts` | Mark deprecated |
| All existing controllers | Migrate to new decorators |
| All existing services | Extend AuthorizedBaseService |

---

## 12. Implementation Summary

### Completed Implementation (2026-01-25)

All core RBAC components have been implemented:

#### Phase 1: Core Infrastructure
- [x] **Redis Cache Service** (`packages/applications/src/services/baseServices/redis/redis-cache.service.ts`)
  - New `RedisCacheService` for caching operations
  - Graceful fallback when Redis is unavailable
  - Auto-reconnection and error handling

- [x] **PolicyEngine with Redis** (`packages/applications/src/authorization/policy.engine.ts`)
  - Redis caching integration (5-minute TTL)
  - `getAccessibleBy()` for Prisma query filtering
  - `getPermittedFields()` for field-level access
  - Cache invalidation methods: `invalidateUser()`, `invalidateRole()`, `invalidatePolicy()`, `invalidateTenant()`, `invalidateAll()`

- [x] **Enhanced Authorization Guard** (`packages/applications/src/authorization/authorization.guard.ts`)
  - AND/OR permission mode support
  - Stores ability in request and CLS context
  - Improved error messages

#### Phase 2: Database-Level Filtering
- [x] **AuthorizedBaseService** (`packages/applications/src/common/authorized-base.service.ts`)
  - `getAccessibleFilter()` for Prisma queries
  - `canAccess()` / `canAccessResource()` for permission checks
  - `assertCanAccess()` / `assertCanAccessResource()` for throwing errors
  - `filterFields()` / `filterFieldsArray()` for field-level filtering
  - `buildAuthorizedFilter()` for combining filters
  - `isSuperAdmin()` / `isTenantAdmin()` helper methods

#### Phase 3: Enhanced Decorators
- [x] **New Decorators** (`apps/api/src/decorators/authorize.decorator.ts`)
  - `@Authorize()` - AND logic (all permissions required)
  - `@AuthorizeAny()` - OR logic (any permission required)
  - `@UserAbility()` - Parameter decorator for ability injection
  - `@RequireAny()` - Shorthand for OR logic
  - Updated `@CanRead`, `@CanCreate`, `@CanUpdate`, `@CanDelete`, `@CanManage`

#### Phase 4: RBAC Management API
- [x] **Roles Controller** (`apps/api/src/controllers/rbac/roles.controller.ts`)
  - CRUD operations for roles
  - Policy assignment/removal
  - Cache invalidation on changes

- [x] **Policies Controller** (`apps/api/src/controllers/rbac/policies.controller.ts`)
  - CRUD operations for policies
  - Policy validation endpoint
  - Cache invalidation on changes

- [x] **Permission Check Controller** (`apps/api/src/controllers/rbac/permission-check.controller.ts`)
  - Single permission check
  - Bulk permission check
  - Get current user's effective permissions

#### Phase 5: Audit Logging
- [x] **Authorization Audit Service** (`packages/applications/src/services/audit/authorization-audit.service.ts`)
  - Async logging to database
  - Real-time Redis pub/sub for monitoring
  - Denial tracking
  - Query history methods

#### Phase 6: Migration
- [x] **Deprecated @UseAuthorized** (`apps/api/src/decorators/useAuthorized.decorator.ts`)
  - Added deprecation warning
  - Migration guide in JSDoc

### Files Created

| File | Description |
|------|-------------|
| `packages/applications/src/services/baseServices/redis/redis-cache.service.ts` | Redis cache service |
| `packages/applications/src/services/baseServices/redis/redis-cache.module.ts` | Redis cache module |
| `packages/applications/src/common/authorized-base.service.ts` | Base service with authorization |
| `packages/applications/src/services/audit/authorization-audit.service.ts` | Audit logging service |
| `packages/applications/src/services/audit/index.ts` | Audit service exports |
| `apps/api/src/controllers/rbac/roles.controller.ts` | Roles management API |
| `apps/api/src/controllers/rbac/policies.controller.ts` | Policies management API |
| `apps/api/src/controllers/rbac/permission-check.controller.ts` | Permission check API |
| `apps/api/src/controllers/rbac/rbac.module.ts` | RBAC module |
| `apps/api/src/controllers/rbac/index.ts` | RBAC exports |
| `apps/api/src/controllers/rbac/dto/*.ts` | DTOs for RBAC APIs |

### Files Modified

| File | Changes |
|------|---------|
| `packages/applications/src/authorization/policy.engine.ts` | Redis caching, accessibleBy, cache invalidation |
| `packages/applications/src/authorization/authorization.guard.ts` | OR logic, improved error messages |
| `packages/applications/src/authorization/authorization.module.ts` | Redis cache module import |
| `packages/applications/src/authorization/decorators.ts` | AuthorizeAny, UserAbility, SetPermissionMode |
| `packages/applications/src/authorization/index.ts` | New exports |
| `packages/applications/src/common/index.ts` | AuthorizedBaseService export |
| `packages/applications/src/services/index.ts` | Audit service export |
| `packages/applications/src/services/baseServices/redis/index.ts` | Cache service exports |
| `apps/api/src/decorators/authorize.decorator.ts` | AuthorizeAny, UserAbility, RequireAny |
| `apps/api/src/decorators/useAuthorized.decorator.ts` | Deprecation warning |

---

## 13. Acceptance Criteria

- [x] Redis caching implemented in PolicyEngine
- [x] Cache invalidation working correctly
- [x] `accessibleBy` integration with Prisma queries
- [x] Field-level permission filtering
- [x] OR logic support in decorators
- [x] Resource-level authorization checks
- [x] Audit logging for all authorization decisions
- [x] RBAC management API endpoints
- [x] Legacy `@UseAuthorized` deprecated with warnings
- [ ] All existing controllers migrated (in progress)
- [ ] Unit tests with >80% coverage (pending)
- [ ] Integration tests for all authorization scenarios (pending)
- [ ] Performance benchmarks met (pending)
- [x] Documentation updated

---

## 15. References

- [CASL Documentation](https://casl.js.org/v6/en/)
- [CASL Prisma Integration](https://casl.js.org/v6/en/package/casl-prisma)
- [NestJS Authorization](https://docs.nestjs.com/security/authorization)
- [OWASP Access Control Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Access_Control_Cheat_Sheet.html)
- [NIST RBAC Model](https://csrc.nist.gov/projects/role-based-access-control)

---

## 16. Change History

| Date | Update | Author |
|------|--------|--------|
| 2026-01-25 | Initial implementation plan created | AI Assistant |
| 2026-01-25 | Full implementation completed (Phases 1-6) | AI Assistant |
| 2026-01-25 | Schema revised: Removed Permission/RolePermission, added UserGroupRoleAssignment | AI Assistant |
