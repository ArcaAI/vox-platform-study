import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PolicyEngine, AppAbility } from '../authorization';
import { IActiveUserContext } from '../interfaces';

/**
 * AuthorizedBaseService - Base service class with built-in authorization
 *
 * This abstract class provides authorization utilities for service layer:
 * - Access to user's CASL ability from request context
 * - Automatic query filtering using accessibleBy
 * - Resource-level permission checks
 * - Field-level filtering
 *
 * @example
 * ```typescript
 * @Injectable()
 * export class UserService extends AuthorizedBaseService {
 *   constructor(
 *     cls: ClsService<IActiveUserContext>,
 *     policyEngine: PolicyEngine,
 *     private readonly prisma: PrismaClient,
 *   ) {
 *     super(cls, policyEngine);
 *   }
 *
 *   async findAll(query: PaginatedQuery) {
 *     // Automatic filtering based on user's permissions
 *     const filter = this.getAccessibleFilter('read', 'User');
 *
 *     return this.prisma.user.findMany({
 *       where: {
 *         AND: [filter, query.filter],
 *       },
 *     });
 *   }
 *
 *   async findOne(id: string) {
 *     const user = await this.prisma.user.findUnique({ where: { id } });
 *
 *     // Resource-level check
 *     this.assertCanAccess('read', 'User', user);
 *
 *     // Filter fields based on permissions
 *     return this.filterFields(user, 'read', 'User');
 *   }
 * }
 * ```
 */
@Injectable()
export abstract class AuthorizedBaseService {
    protected readonly logger = new Logger(this.constructor.name);

    constructor(
        protected readonly cls: ClsService<IActiveUserContext>,
        protected readonly policyEngine: PolicyEngine,
    ) {}

    /**
     * Get the current user's CASL ability from request context
     *
     * @throws ForbiddenException if no ability is available (user not authenticated)
     * @returns CASL ability instance
     */
    protected getAbility(): AppAbility {
        const ability = this.cls.get('userAbility');
        if (!ability) {
            throw new ForbiddenException('No authorization context available');
        }
        return ability;
    }

    /**
     * Get the current user from request context
     *
     * @throws ForbiddenException if no user is available
     * @returns User session object
     */
    protected getCurrentUser() {
        const user = this.cls.get('user');
        if (!user) {
            throw new ForbiddenException('No user context available');
        }
        return user;
    }

    /**
     * Get the current tenant ID from request context
     *
     * @returns Tenant ID or undefined if not in tenant context
     */
    protected getCurrentTenantId(): string | undefined {
        const user = this.cls.get('user');
        return user?.tenantId;
    }

    /**
     * Get accessible filter for Prisma queries
     *
     * This method returns a Prisma-compatible where clause that automatically
     * filters results based on the user's permissions.
     *
     * @param action - Action to check (e.g., 'read', 'update', 'delete')
     * @param subject - Subject/model name (e.g., 'User', 'Consultation')
     * @returns Prisma where clause for filtering
     *
     * @example
     * ```typescript
     * const filter = this.getAccessibleFilter('read', 'User');
     * const users = await this.prisma.user.findMany({
     *   where: filter,
     * });
     * ```
     */
    protected getAccessibleFilter<T extends string>(
        action: string,
        subject: T
    ): Record<string, unknown> {
        try {
            const ability = this.getAbility();
            const accessibleBy = this.policyEngine.getAccessibleBy(ability, action);
            const filter = (accessibleBy as Record<string, Record<string, unknown>>)[subject];
            return filter || {};
        } catch (error) {
            this.logger.warn({
                message: 'Failed to get accessible filter',
                action,
                subject,
                error: error instanceof Error ? error.message : String(error),
            });
            // Return empty filter (will match nothing) for safety
            return { id: { equals: 'FORBIDDEN' } };
        }
    }

    /**
     * Check if user can perform action on subject (route-level check)
     *
     * @param action - Action to check
     * @param subject - Subject/model name
     * @returns true if user has permission
     */
    protected canAccess(action: string, subject: string): boolean {
        try {
            const ability = this.getAbility();
            return ability.can(action, subject);
        } catch {
            return false;
        }
    }

    /**
     * Check if user can perform action on a specific resource (resource-level check)
     *
     * @param action - Action to check
     * @param subject - Subject/model name
     * @param resource - The actual resource object to check against
     * @returns true if user has permission on this specific resource
     */
    protected canAccessResource(action: string, subject: string, resource: Record<string, unknown>): boolean {
        try {
            const ability = this.getAbility();
            return this.policyEngine.can(ability, action, subject, resource);
        } catch {
            return false;
        }
    }

    /**
     * Assert user can perform action on subject
     * Throws ForbiddenException if not allowed
     *
     * @param action - Action to check
     * @param subject - Subject/model name
     * @throws ForbiddenException if user doesn't have permission
     */
    protected assertCanAccess(action: string, subject: string): void {
        if (!this.canAccess(action, subject)) {
            throw new ForbiddenException(
                `You don't have permission to ${action} ${subject}`
            );
        }
    }

    /**
     * Assert user can perform action on a specific resource
     * Throws ForbiddenException if not allowed
     *
     * @param action - Action to check
     * @param subject - Subject/model name
     * @param resource - The actual resource object to check against
     * @throws ForbiddenException if user doesn't have permission
     */
    protected assertCanAccessResource(action: string, subject: string, resource: Record<string, unknown>): void {
        if (!this.canAccessResource(action, subject, resource)) {
            throw new ForbiddenException(
                `You don't have permission to ${action} this ${subject}`
            );
        }
    }

    /**
     * Get permitted fields for a subject
     *
     * @param action - Action to check
     * @param subject - Subject/model name
     * @returns Array of permitted field names, or undefined if no field restrictions
     */
    protected getPermittedFields(action: string, subject: string): string[] | undefined {
        try {
            const ability = this.getAbility();
            return this.policyEngine.getPermittedFields(ability, action, subject);
        } catch {
            return undefined;
        }
    }

    /**
     * Filter object to only include permitted fields
     *
     * @param data - Object to filter
     * @param action - Action to check
     * @param subject - Subject/model name
     * @returns Filtered object with only permitted fields
     *
     * @example
     * ```typescript
     * const user = await this.prisma.user.findUnique({ where: { id } });
     * return this.filterFields(user, 'read', 'User');
     * // Returns user with only fields the user is allowed to see
     * ```
     */
    protected filterFields<T extends Record<string, unknown>>(
        data: T,
        action: string,
        subject: string
    ): Partial<T> {
        const fields = this.getPermittedFields(action, subject);

        // No field restrictions = return all fields
        if (!fields || fields.length === 0) {
            return data;
        }

        const filtered: Partial<T> = {};
        for (const field of fields) {
            if (field in data) {
                filtered[field as keyof T] = data[field as keyof T];
            }
        }
        return filtered;
    }

    /**
     * Filter array of objects to only include permitted fields
     *
     * @param data - Array of objects to filter
     * @param action - Action to check
     * @param subject - Subject/model name
     * @returns Array of filtered objects
     */
    protected filterFieldsArray<T extends Record<string, unknown>>(
        data: T[],
        action: string,
        subject: string
    ): Partial<T>[] {
        return data.map(item => this.filterFields(item, action, subject));
    }

    /**
     * Build a combined filter for Prisma queries
     * Combines accessible filter with additional conditions
     *
     * @param action - Action to check
     * @param subject - Subject/model name
     * @param additionalFilter - Additional Prisma where conditions
     * @returns Combined Prisma where clause
     *
     * @example
     * ```typescript
     * const where = this.buildAuthorizedFilter('read', 'User', {
     *   resourceStatus: 'ENABLED',
     *   email: { contains: '@example.com' },
     * });
     * ```
     */
    protected buildAuthorizedFilter<T extends Record<string, unknown>>(
        action: string,
        subject: string,
        additionalFilter?: T
    ): { AND: unknown[] } {
        const accessibleFilter = this.getAccessibleFilter(action, subject);

        const conditions: unknown[] = [accessibleFilter];

        if (additionalFilter && Object.keys(additionalFilter).length > 0) {
            conditions.push(additionalFilter);
        }

        return { AND: conditions };
    }

    /**
     * Check if user is a super admin (has 'manage' on 'all')
     *
     * @returns true if user is super admin
     */
    protected isSuperAdmin(): boolean {
        try {
            const ability = this.getAbility();
            return ability.can('manage', 'all');
        } catch {
            return false;
        }
    }

    /**
     * Check if user is a tenant admin
     *
     * @returns true if user can manage tenant resources
     */
    protected isTenantAdmin(): boolean {
        try {
            const ability = this.getAbility();
            return ability.can('manage', 'User') && ability.can('manage', 'Role');
        } catch {
            return false;
        }
    }
}
