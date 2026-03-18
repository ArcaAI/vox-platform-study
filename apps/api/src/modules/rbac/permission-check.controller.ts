import {
    Controller,
    Post,
    Body,
    Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { PolicyEngine, AppAbility } from '@arcaai/applications';
import { ClsService } from 'nestjs-cls';
import { IActiveUserContext } from '@arcaai/applications';
import { Authorize } from '../../decorators';
import {
    CheckPermissionDto,
    CheckPermissionsBulkDto,
    CheckPermissionResponse,
    CheckPermissionsBulkResponse,
} from './dto';

/**
 * Permission Check Controller
 *
 * Provides endpoints for checking permissions programmatically.
 * Useful for frontend applications to determine UI visibility.
 */
@ApiTags('RBAC - Permission Check')
@ApiBearerAuth()
@Controller('rbac/check')
export class PermissionCheckController {
    private readonly logger = new Logger(PermissionCheckController.name);

    constructor(
        private readonly policyEngine: PolicyEngine,
        private readonly cls: ClsService<IActiveUserContext>,
    ) {}

    /**
     * Check a single permission
     */
    @Post()
    @Authorize()
    @ApiOperation({ summary: 'Check if user has a specific permission' })
    @ApiResponse({ status: 200, description: 'Permission check result', type: CheckPermissionResponse })
    async checkPermission(@Body() dto: CheckPermissionDto): Promise<CheckPermissionResponse> {
        const currentUser = this.cls.get('user');

        // Determine which user to check
        // Only admins can check permissions for other users
        let targetUserId = currentUser?.id;
        let targetTenantId = dto.tenantId || currentUser?.tenantId;

        if (dto.userId && dto.userId !== currentUser?.id) {
            // Check if current user can check others' permissions
            const adminAbility = await this.policyEngine.buildAbility({
                userId: currentUser?.id || '',
                tenantId: currentUser?.tenantId,
            });

            if (!adminAbility.can('manage', 'User')) {
                throw new Error('You can only check your own permissions');
            }

            targetUserId = dto.userId;
        }

        // Build ability for target user
        const ability = await this.policyEngine.buildAbility({
            userId: targetUserId || '',
            tenantId: targetTenantId,
        });

        // Check permission
        let allowed: boolean;
        if (dto.resource) {
            allowed = this.policyEngine.can(ability, dto.action, dto.subject, dto.resource);
        } else {
            allowed = ability.can(dto.action, dto.subject);
        }

        this.logger.debug({
            message: 'Permission check',
            userId: targetUserId,
            action: dto.action,
            subject: dto.subject,
            hasResource: !!dto.resource,
            allowed,
        });

        return {
            allowed,
            action: dto.action,
            subject: dto.subject,
            userId: targetUserId,
            tenantId: targetTenantId,
        };
    }

    /**
     * Check multiple permissions at once
     */
    @Post('bulk')
    @Authorize()
    @ApiOperation({ summary: 'Check multiple permissions at once' })
    @ApiResponse({ status: 200, description: 'Bulk permission check results', type: CheckPermissionsBulkResponse })
    async checkPermissionsBulk(@Body() dto: CheckPermissionsBulkDto): Promise<CheckPermissionsBulkResponse> {
        const currentUser = this.cls.get('user');

        // Determine which user to check
        let targetUserId = currentUser?.id;
        let targetTenantId = dto.tenantId || currentUser?.tenantId;

        if (dto.userId && dto.userId !== currentUser?.id) {
            // Check if current user can check others' permissions
            const adminAbility = await this.policyEngine.buildAbility({
                userId: currentUser?.id || '',
                tenantId: currentUser?.tenantId,
            });

            if (!adminAbility.can('manage', 'User')) {
                throw new Error('You can only check your own permissions');
            }

            targetUserId = dto.userId;
        }

        // Build ability for target user
        const ability = await this.policyEngine.buildAbility({
            userId: targetUserId || '',
            tenantId: targetTenantId,
        });

        // Check all permissions
        const results = dto.permissions.map(permission => {
            let allowed: boolean;
            if (permission.resource) {
                allowed = this.policyEngine.can(ability, permission.action, permission.subject, permission.resource);
            } else {
                allowed = ability.can(permission.action, permission.subject);
            }

            return {
                action: permission.action,
                subject: permission.subject,
                allowed,
            };
        });

        const allAllowed = results.every(r => r.allowed);
        const anyAllowed = results.some(r => r.allowed);

        this.logger.debug({
            message: 'Bulk permission check',
            userId: targetUserId,
            totalChecks: results.length,
            allowedCount: results.filter(r => r.allowed).length,
            deniedCount: results.filter(r => !r.allowed).length,
        });

        return {
            userId: targetUserId || '',
            tenantId: targetTenantId,
            results,
            allAllowed,
            anyAllowed,
        };
    }

    /**
     * Get current user's effective permissions
     */
    @Post('my-permissions')
    @Authorize()
    @ApiOperation({ summary: 'Get current user\'s effective permissions' })
    @ApiResponse({ status: 200, description: 'User\'s effective permissions' })
    async getMyPermissions(): Promise<{
        userId: string;
        tenantId?: string;
        permissions: Array<{ action: string; subject: string; conditions?: unknown }>;
    }> {
        const currentUser = this.cls.get('user');

        if (!currentUser) {
            throw new Error('User not authenticated');
        }

        // Build ability
        const ability = await this.policyEngine.buildAbility({
            userId: currentUser.id,
            tenantId: currentUser.tenantId,
        });

        // Extract rules from ability
        const permissions = ability.rules.map(rule => ({
            // Handle both string and string[] action types
            action: Array.isArray(rule.action) ? rule.action.join(',') : rule.action,
            subject: rule.subject as string,
            conditions: rule.conditions,
        }));

        return {
            userId: currentUser.id,
            tenantId: currentUser.tenantId,
            permissions,
        };
    }
}
