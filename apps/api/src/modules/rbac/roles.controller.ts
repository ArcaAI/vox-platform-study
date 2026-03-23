import {
    BadRequestException,
    Controller,
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Body,
    Param,
    Query,
    HttpCode,
    HttpStatus,
    Logger,
    Inject,
    NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { PolicyEngine, PolicyContext } from '@arcaai/applications';
import { CoreDatabaseService, ResourceStatusType, SysEventType, ResourceType } from '@arcaai/domains';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { IActiveUserContext } from '@arcaai/applications';
import { Authorize, CanManage } from '../../decorators';
import {
    CreateRoleDto,
    UpdateRoleDto,
    AssignPolicyToRoleDto,
    RoleResponse,
    PaginatedRoleResponse,
    AssignPolicyResponse,
} from './dto';

/**
 * RBAC Roles Controller
 *
 * Manages roles in the RBAC system.
 * All endpoints require 'manage' permission on 'Role' subject.
 */
@ApiTags('RBAC - Roles')
@ApiBearerAuth()
@Controller('admin/rbac/roles')
export class RolesController {
    private readonly logger = new Logger(RolesController.name);

    constructor(
        @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
        private readonly policyEngine: PolicyEngine,
        private readonly cls: ClsService<IActiveUserContext>,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    /**
     * List all roles
     */
    @Get()
    @CanManage('Role')
    @ApiOperation({ summary: 'List all roles' })
    @ApiResponse({ status: 200, description: 'List of roles', type: PaginatedRoleResponse })
    async findAll(
        @Query('page') page: number = 1,
        @Query('pageSize') pageSize: number = 20,
        @Query('search') search?: string,
    ): Promise<PaginatedRoleResponse> {
        const prisma = this.databaseService.client;
        const skip = (page - 1) * pageSize;

        const where = {
            resourceStatus: ResourceStatusType.ENABLED,
            ...(search && {
                OR: [
                    { name: { contains: search, mode: 'insensitive' as const } },
                    { description: { contains: search, mode: 'insensitive' as const } },
                ],
            }),
        };

        const [data, total] = await Promise.all([
            prisma.role.findMany({
                where,
                skip,
                take: pageSize,
                include: {
                    RolePolicies: {
                        where: { resourceStatus: ResourceStatusType.ENABLED },
                        include: {
                            Policy: {
                                select: { id: true, name: true },
                            },
                        },
                        orderBy: { priority: 'asc' },
                    },
                },
                orderBy: { name: 'asc' },
            }),
            prisma.role.count({ where }),
        ]);

        return {
            data: data.map(role => ({
                id: role.id,
                name: role.name,
                description: role.description || undefined,
                externalName: role.externalName || undefined,
                externalId: role.externalId || undefined,
                isSystemRole: role.isSystemRole,
                parentRoleId: role.parentRoleId || undefined,
                resourceStatus: role.resourceStatus,
                createdAt: role.createdAt,
                updatedAt: role.updatedAt,
                policies: role.RolePolicies.map(rp => ({
                    id: rp.Policy?.id || '',
                    name: rp.Policy?.name || '',
                    priority: rp.priority,
                })),
            })),
            total,
            page,
            pageSize,
        };
    }

    /**
     * Get a role by ID
     */
    @Get(':id')
    @CanManage('Role')
    @ApiOperation({ summary: 'Get role by ID' })
    @ApiResponse({ status: 200, description: 'Role details', type: RoleResponse })
    @ApiResponse({ status: 404, description: 'Role not found' })
    async findOne(@Param('id') id: string): Promise<RoleResponse> {
        const prisma = this.databaseService.client;

        const role = await prisma.role.findUnique({
            where: { id },
            include: {
                RolePolicies: {
                    where: { resourceStatus: ResourceStatusType.ENABLED },
                    include: {
                        Policy: {
                            select: { id: true, name: true },
                        },
                    },
                    orderBy: { priority: 'asc' },
                },
            },
        });

        if (!role) {
            throw new NotFoundException('Role not found');
        }

        return {
            id: role.id,
            name: role.name,
            description: role.description || undefined,
            externalName: role.externalName || undefined,
            externalId: role.externalId || undefined,
            isSystemRole: role.isSystemRole,
            parentRoleId: role.parentRoleId || undefined,
            resourceStatus: role.resourceStatus,
            createdAt: role.createdAt,
            updatedAt: role.updatedAt,
            policies: role.RolePolicies.map(rp => ({
                id: rp.Policy?.id || '',
                name: rp.Policy?.name || '',
                priority: rp.priority,
            })),
        };
    }

    /**
     * Create a new role
     */
    @Post()
    @CanManage('Role')
    @ApiOperation({ summary: 'Create a new role' })
    @ApiResponse({ status: 201, description: 'Role created', type: RoleResponse })
    @ApiResponse({ status: 400, description: 'Invalid input' })
    async create(@Body() dto: CreateRoleDto): Promise<RoleResponse> {
        const prisma = this.databaseService.client;
        const user = this.cls.get('user');

        if (dto.parentRoleId) {
            await this.validateParentRole(prisma, dto.parentRoleId);
        }

        const role = await prisma.role.create({
            data: {
                name: dto.name,
                description: dto.description,
                externalName: dto.externalName,
                externalId: dto.externalId,
                parentRoleId: dto.parentRoleId,
                isSystemRole: false,
                resourceStatus: ResourceStatusType.ENABLED,
                createdBy: user?.id,
            },
        });

        this.emitAuditEvent(SysEventType.ResourceCreated, role.id, user?.id, role);

        this.logger.log({
            message: 'Role created',
            roleId: role.id,
            roleName: role.name,
            createdBy: user?.id,
        });

        return {
            id: role.id,
            name: role.name,
            description: role.description || undefined,
            externalName: role.externalName || undefined,
            externalId: role.externalId || undefined,
            isSystemRole: role.isSystemRole,
            parentRoleId: role.parentRoleId || undefined,
            resourceStatus: role.resourceStatus,
            createdAt: role.createdAt,
            updatedAt: role.updatedAt,
            policies: [],
        };
    }

    /**
     * Update a role
     */
    @Put(':id')
    @CanManage('Role')
    @ApiOperation({ summary: 'Update a role' })
    @ApiResponse({ status: 200, description: 'Role updated', type: RoleResponse })
    @ApiResponse({ status: 404, description: 'Role not found' })
    async update(
        @Param('id') id: string,
        @Body() dto: UpdateRoleDto,
    ): Promise<RoleResponse> {
        const prisma = this.databaseService.client;
        const user = this.cls.get('user');

        const existing = await prisma.role.findUnique({
            where: { id },
            select: { isSystemRole: true, name: true },
        });

        if (!existing) {
            throw new NotFoundException('Role not found');
        }

        if (existing.isSystemRole) {
            throw new BadRequestException(
                `Cannot modify system role '${existing.name}'. System roles are protected from modification.`,
            );
        }

        if (dto.parentRoleId !== undefined && dto.parentRoleId !== null) {
            await this.validateParentRole(prisma, dto.parentRoleId, id);
        }

        const role = await prisma.role.update({
            where: { id },
            data: {
                ...(dto.name && { name: dto.name }),
                ...(dto.description !== undefined && { description: dto.description }),
                ...(dto.externalName !== undefined && { externalName: dto.externalName }),
                ...(dto.externalId !== undefined && { externalId: dto.externalId }),
                ...(dto.parentRoleId !== undefined && { parentRoleId: dto.parentRoleId }),
                updatedBy: user?.id,
            },
            include: {
                RolePolicies: {
                    where: { resourceStatus: ResourceStatusType.ENABLED },
                    include: {
                        Policy: {
                            select: { id: true, name: true },
                        },
                    },
                    orderBy: { priority: 'asc' },
                },
            },
        });

        await this.policyEngine.invalidateRole(id);
        this.emitAuditEvent(SysEventType.ResourceUpdated, id, user?.id, role, existing);

        this.logger.log({
            message: 'Role updated',
            roleId: role.id,
            roleName: role.name,
            updatedBy: user?.id,
        });

        return {
            id: role.id,
            name: role.name,
            description: role.description || undefined,
            externalName: role.externalName || undefined,
            externalId: role.externalId || undefined,
            isSystemRole: role.isSystemRole,
            parentRoleId: role.parentRoleId || undefined,
            resourceStatus: role.resourceStatus,
            createdAt: role.createdAt,
            updatedAt: role.updatedAt,
            policies: role.RolePolicies.map(rp => ({
                id: rp.Policy?.id || '',
                name: rp.Policy?.name || '',
                priority: rp.priority,
            })),
        };
    }

    /**
     * Partially update a role
     */
    @Patch(':id')
    @CanManage('Role')
    @ApiOperation({ summary: 'Partially update a role' })
    @ApiResponse({ status: 200, description: 'Role updated', type: RoleResponse })
    @ApiResponse({ status: 404, description: 'Role not found' })
    async patch(
        @Param('id') id: string,
        @Body() dto: UpdateRoleDto,
    ): Promise<RoleResponse> {
        const prisma = this.databaseService.client;
        const user = this.cls.get('user');

        const existing = await prisma.role.findUnique({
            where: { id },
            select: { isSystemRole: true, name: true },
        });

        if (!existing) {
            throw new NotFoundException('Role not found');
        }

        if (existing.isSystemRole) {
            throw new BadRequestException(
                `Cannot modify system role '${existing.name}'. System roles are protected from modification.`,
            );
        }

        if (dto.parentRoleId !== undefined && dto.parentRoleId !== null) {
            await this.validateParentRole(prisma, dto.parentRoleId, id);
        }

        const role = await prisma.role.update({
            where: { id },
            data: {
                ...(dto.name && { name: dto.name }),
                ...(dto.description !== undefined && { description: dto.description }),
                ...(dto.externalName !== undefined && { externalName: dto.externalName }),
                ...(dto.externalId !== undefined && { externalId: dto.externalId }),
                ...(dto.parentRoleId !== undefined && { parentRoleId: dto.parentRoleId }),
                ...(dto.resourceStatus && {
                    resourceStatus: dto.resourceStatus as ResourceStatusType,
                    resourceStatusUpdatedAt: new Date(),
                    resourceStatusUpdatedBy: user?.id,
                }),
                updatedBy: user?.id,
            },
            include: {
                RolePolicies: {
                    where: { resourceStatus: ResourceStatusType.ENABLED },
                    include: {
                        Policy: {
                            select: { id: true, name: true },
                        },
                    },
                    orderBy: { priority: 'asc' },
                },
            },
        });

        await this.policyEngine.invalidateRole(id);
        this.emitAuditEvent(SysEventType.ResourceUpdated, id, user?.id, role, existing);

        this.logger.log({
            message: 'Role updated',
            roleId: role.id,
            roleName: role.name,
            updatedBy: user?.id,
        });

        return {
            id: role.id,
            name: role.name,
            description: role.description || undefined,
            externalName: role.externalName || undefined,
            externalId: role.externalId || undefined,
            isSystemRole: role.isSystemRole,
            parentRoleId: role.parentRoleId || undefined,
            resourceStatus: role.resourceStatus,
            createdAt: role.createdAt,
            updatedAt: role.updatedAt,
            policies: role.RolePolicies.map(rp => ({
                id: rp.Policy?.id || '',
                name: rp.Policy?.name || '',
                priority: rp.priority,
            })),
        };
    }

    /**
     * Delete a role (soft delete)
     */
    @Delete(':id')
    @CanManage('Role')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Delete a role' })
    @ApiResponse({ status: 204, description: 'Role deleted' })
    @ApiResponse({ status: 400, description: 'Cannot delete system role' })
    @ApiResponse({ status: 404, description: 'Role not found' })
    async remove(@Param('id') id: string): Promise<void> {
        const prisma = this.databaseService.client;
        const user = this.cls.get('user');

        // Check if it's a system role
        const role = await prisma.role.findUnique({
            where: { id },
            select: { isSystemRole: true, name: true },
        });

        if (!role) {
            throw new NotFoundException('Role not found');
        }

        if (role.isSystemRole) {
            throw new BadRequestException('Cannot delete system role');
        }

        // Soft delete
        await prisma.role.update({
            where: { id },
            data: {
                resourceStatus: ResourceStatusType.DELETED,
                resourceStatusUpdatedAt: new Date(),
                resourceStatusUpdatedBy: user?.id,
            },
        });

        await this.policyEngine.invalidateRole(id);
        this.emitAuditEvent(SysEventType.ResourceDeleted, id, user?.id, { name: role.name });

        this.logger.log({
            message: 'Role deleted',
            roleId: id,
            roleName: role.name,
            deletedBy: user?.id,
        });
    }

    /**
     * Assign a policy to a role
     */
    @Post(':roleId/policies/:policyId')
    @CanManage('RolePolicy')
    @ApiOperation({ summary: 'Assign a policy to a role' })
    @ApiResponse({ status: 201, description: 'Policy assigned to role', type: AssignPolicyResponse })
    @ApiResponse({ status: 404, description: 'Role or policy not found' })
    async assignPolicy(
        @Param('roleId') roleId: string,
        @Param('policyId') policyId: string,
        @Body() dto: AssignPolicyToRoleDto,
    ): Promise<AssignPolicyResponse> {
        const prisma = this.databaseService.client;
        const user = this.cls.get('user');

        // Check if assignment already exists
        const existing = await prisma.rolePolicy.findFirst({
            where: {
                roleId: roleId,
                policyId: policyId,
            },
        });

        if (existing) {
            // Update priority if it changed
            await prisma.rolePolicy.update({
                where: { id: existing.id },
                data: {
                    priority: dto.priority ?? existing.priority,
                    resourceStatus: ResourceStatusType.ENABLED,
                    updatedBy: user?.id,
                },
            });
        } else {
            await prisma.rolePolicy.create({
                data: {
                    roleId,
                    policyId,
                    priority: dto.priority ?? 0,
                    resourceStatus: ResourceStatusType.ENABLED,
                    createdBy: user?.id,
                },
            });
        }

        await this.policyEngine.invalidateRole(roleId);
        this.eventEmitter.emit(SysEventType.ResourceCreated, {
            resourceId: `${roleId}:${policyId}`,
            resourceType: ResourceType.RolePermission,
            responsibleEntityId: user?.id,
            data: { roleId, policyId, priority: dto.priority ?? 0 },
        });

        this.logger.log({
            message: 'Policy assigned to role',
            policyId,
            roleId,
            priority: dto.priority ?? 0,
            assignedBy: user?.id,
        });

        return { message: 'Policy assigned to role successfully' };
    }

    /**
     * Remove a policy from a role
     */
    @Delete(':roleId/policies/:policyId')
    @CanManage('RolePolicy')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Remove a policy from a role' })
    @ApiResponse({ status: 204, description: 'Policy removed from role' })
    @ApiResponse({ status: 404, description: 'Assignment not found' })
    async removePolicy(
        @Param('roleId') roleId: string,
        @Param('policyId') policyId: string,
    ): Promise<void> {
        const prisma = this.databaseService.client;
        const user = this.cls.get('user');

        // Soft delete the assignment
        await prisma.rolePolicy.updateMany({
            where: { roleId, policyId },
            data: {
                resourceStatus: ResourceStatusType.DELETED,
                resourceStatusUpdatedAt: new Date(),
                resourceStatusUpdatedBy: user?.id,
            },
        });

        await this.policyEngine.invalidateRole(roleId);
        this.eventEmitter.emit(SysEventType.ResourceDeleted, {
            resourceId: `${roleId}:${policyId}`,
            resourceType: ResourceType.RolePermission,
            responsibleEntityId: user?.id,
            data: { roleId, policyId },
        });

        this.logger.log({
            message: 'Policy removed from role',
            policyId,
            roleId,
            removedBy: user?.id,
        });
    }

    private emitAuditEvent(
        eventType: SysEventType,
        resourceId: string,
        userId: string | undefined,
        data?: unknown,
        previousData?: unknown,
    ): void {
        this.eventEmitter.emit(eventType, {
            resourceId,
            resourceType: ResourceType.Role,
            responsibleEntityId: userId,
            data: data ?? {},
            ...(previousData !== undefined && { previousData }),
        });
    }

    /**
     * Validates parentRoleId: ensures the parent exists and there are no circular references.
     * @param currentRoleId - The ID of the role being updated (for cycle detection). Omit for create operations.
     */
    private async validateParentRole(
        prisma: CoreDatabaseService['client'],
        parentRoleId: string,
        currentRoleId?: string,
    ): Promise<void> {
        if (currentRoleId && parentRoleId === currentRoleId) {
            throw new BadRequestException('A role cannot be its own parent');
        }

        const parent = await prisma.role.findUnique({
            where: { id: parentRoleId },
            select: { id: true, parentRoleId: true },
        });

        if (!parent) {
            throw new NotFoundException(`Parent role '${parentRoleId}' not found`);
        }

        if (currentRoleId) {
            let ancestorId: string | null = parent.parentRoleId;
            const visited = new Set<string>([parentRoleId]);
            while (ancestorId) {
                if (ancestorId === currentRoleId) {
                    throw new BadRequestException(
                        'Circular reference detected in role hierarchy',
                    );
                }
                if (visited.has(ancestorId)) break;
                visited.add(ancestorId);
                const ancestor = await prisma.role.findUnique({
                    where: { id: ancestorId },
                    select: { parentRoleId: true },
                });
                ancestorId = ancestor?.parentRoleId ?? null;
            }
        }
    }
}
