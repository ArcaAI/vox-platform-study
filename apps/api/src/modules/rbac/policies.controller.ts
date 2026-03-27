import {
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
import { PolicyEngine } from '@arcaai/applications';
import { CoreDatabaseService, ResourceStatusType, SysEventType, ResourceType } from '@arcaai/domains';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { IActiveUserContext } from '@arcaai/applications';
import { CanManage } from '../../decorators';
import {
  CreatePolicyDto,
  UpdatePolicyDto,
  PolicyResponse,
  PaginatedPolicyResponse,
  ValidatePolicyDto,
  PolicyValidationResponse,
  PolicyScopeDto,
} from './dto';

/**
 * RBAC Policies Controller
 *
 * Manages policies in the RBAC system.
 * All endpoints require 'manage' permission on 'Policy' subject.
 */
@ApiTags('RBAC - Policies')
@ApiBearerAuth()
@Controller('admin/rbac/policies')
export class PoliciesController {
  private readonly logger = new Logger(PoliciesController.name);

  constructor(
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    private readonly policyEngine: PolicyEngine,
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * List all policies
   */
  @Get()
  @CanManage('Policy')
  @ApiOperation({ summary: 'List all policies' })
  @ApiResponse({ status: 200, description: 'List of policies', type: PaginatedPolicyResponse })
  async findAll(
    @Query('page') page: number = 1,
    @Query('pageSize') pageSize: number = 20,
    @Query('search') search?: string,
    @Query('scope') scope?: PolicyScopeDto,
  ): Promise<PaginatedPolicyResponse> {
    const prisma = this.databaseService.client;
    const skip = (page - 1) * pageSize;

    const where = {
      resourceStatus: ResourceStatusType.ENABLED,
      ...(search && {
        OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { description: { contains: search, mode: 'insensitive' as const } }],
      }),
      ...(scope && { scope }),
    };

    const [data, total] = await Promise.all([
      prisma.policy.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { name: 'asc' },
      }),
      prisma.policy.count({ where }),
    ]);

    return {
      data: data.map((policy) => ({
        id: policy.id,
        name: policy.name,
        description: policy.description || undefined,
        scope: policy.scope as PolicyScopeDto,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rules: policy.rules as any[],
        resourceStatus: policy.resourceStatus,
        createdAt: policy.createdAt,
        updatedAt: policy.updatedAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Get a policy by ID
   */
  @Get(':id')
  @CanManage('Policy')
  @ApiOperation({ summary: 'Get policy by ID' })
  @ApiResponse({ status: 200, description: 'Policy details', type: PolicyResponse })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async findOne(@Param('id') id: string): Promise<PolicyResponse> {
    const prisma = this.databaseService.client;

    const policy = await prisma.policy.findUnique({
      where: { id },
    });

    if (!policy) {
      throw new Error('Policy not found');
    }

    return {
      id: policy.id,
      name: policy.name,
      description: policy.description || undefined,
      scope: policy.scope as PolicyScopeDto,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rules: policy.rules as any[],
      resourceStatus: policy.resourceStatus,
      createdAt: policy.createdAt,
      updatedAt: policy.updatedAt,
    };
  }

  /**
   * Create a new policy
   */
  @Post()
  @CanManage('Policy')
  @ApiOperation({ summary: 'Create a new policy' })
  @ApiResponse({ status: 201, description: 'Policy created', type: PolicyResponse })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  async create(@Body() dto: CreatePolicyDto): Promise<PolicyResponse> {
    const prisma = this.databaseService.client;
    const user = this.cls.get('user');

    // Validate rules
    const validation = this.validateRules(dto.rules);
    if (!validation.valid) {
      throw new Error(`Invalid policy rules: ${validation.errors?.join(', ')}`);
    }

    const policy = await prisma.policy.create({
      data: {
        name: dto.name,
        description: dto.description,
        scope: dto.scope,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rules: dto.rules as any,
        resourceStatus: ResourceStatusType.ENABLED,
        createdBy: user?.id,
      },
    });

    this.emitPolicyAuditEvent(SysEventType.ResourceCreated, policy.id, user?.id, policy);

    this.logger.log({
      message: 'Policy created',
      policyId: policy.id,
      policyName: policy.name,
      scope: dto.scope,
      rulesCount: dto.rules.length,
      createdBy: user?.id,
    });

    return {
      id: policy.id,
      name: policy.name,
      description: policy.description || undefined,
      scope: policy.scope as PolicyScopeDto,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rules: policy.rules as any[],
      resourceStatus: policy.resourceStatus,
      createdAt: policy.createdAt,
      updatedAt: policy.updatedAt,
    };
  }

  /**
   * Update a policy
   */
  @Put(':id')
  @CanManage('Policy')
  @ApiOperation({ summary: 'Update a policy' })
  @ApiResponse({ status: 200, description: 'Policy updated', type: PolicyResponse })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async update(@Param('id') id: string, @Body() dto: UpdatePolicyDto): Promise<PolicyResponse> {
    const prisma = this.databaseService.client;
    const user = this.cls.get('user');

    // Validate rules if provided
    if (dto.rules) {
      const validation = this.validateRules(dto.rules);
      if (!validation.valid) {
        throw new Error(`Invalid policy rules: ${validation.errors?.join(', ')}`);
      }
    }

    const policy = await prisma.policy.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.scope && { scope: dto.scope }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(dto.rules && { rules: dto.rules as any }),
        updatedBy: user?.id,
      },
    });

    await this.policyEngine.invalidatePolicy(id);
    this.emitPolicyAuditEvent(SysEventType.ResourceUpdated, id, user?.id, policy);

    this.logger.log({
      message: 'Policy updated',
      policyId: policy.id,
      policyName: policy.name,
      updatedBy: user?.id,
    });

    return {
      id: policy.id,
      name: policy.name,
      description: policy.description || undefined,
      scope: policy.scope as PolicyScopeDto,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rules: policy.rules as any[],
      resourceStatus: policy.resourceStatus,
      createdAt: policy.createdAt,
      updatedAt: policy.updatedAt,
    };
  }

  /**
   * Partially update a policy
   */
  @Patch(':id')
  @CanManage('Policy')
  @ApiOperation({ summary: 'Partially update a policy' })
  @ApiResponse({ status: 200, description: 'Policy updated', type: PolicyResponse })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async patch(@Param('id') id: string, @Body() dto: UpdatePolicyDto): Promise<PolicyResponse> {
    const prisma = this.databaseService.client;
    const user = this.cls.get('user');

    const existing = await prisma.policy.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException('Policy not found');
    }

    // Validate rules if provided
    if (dto.rules) {
      const validation = this.validateRules(dto.rules);
      if (!validation.valid) {
        throw new Error(`Invalid policy rules: ${validation.errors?.join(', ')}`);
      }
    }

    const policy = await prisma.policy.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.scope && { scope: dto.scope }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(dto.rules && { rules: dto.rules as any }),
        ...(dto.resourceStatus && {
          resourceStatus: dto.resourceStatus as ResourceStatusType,
          resourceStatusUpdatedAt: new Date(),
          resourceStatusUpdatedBy: user?.id,
        }),
        updatedBy: user?.id,
      },
    });

    await this.policyEngine.invalidatePolicy(id);
    this.emitPolicyAuditEvent(SysEventType.ResourceUpdated, id, user?.id, policy, existing);

    this.logger.log({
      message: 'Policy updated',
      policyId: policy.id,
      policyName: policy.name,
      updatedBy: user?.id,
    });

    return {
      id: policy.id,
      name: policy.name,
      description: policy.description || undefined,
      scope: policy.scope as PolicyScopeDto,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rules: policy.rules as any[],
      resourceStatus: policy.resourceStatus,
      createdAt: policy.createdAt,
      updatedAt: policy.updatedAt,
    };
  }

  /**
   * Delete a policy (soft delete)
   */
  @Delete(':id')
  @CanManage('Policy')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a policy' })
  @ApiResponse({ status: 204, description: 'Policy deleted' })
  @ApiResponse({ status: 404, description: 'Policy not found' })
  async remove(@Param('id') id: string): Promise<void> {
    const prisma = this.databaseService.client;
    const user = this.cls.get('user');

    const policy = await prisma.policy.findUnique({
      where: { id },
      select: { name: true },
    });

    if (!policy) {
      throw new Error('Policy not found');
    }

    // Soft delete
    await prisma.policy.update({
      where: { id },
      data: {
        resourceStatus: ResourceStatusType.DELETED,
        resourceStatusUpdatedAt: new Date(),
        resourceStatusUpdatedBy: user?.id,
      },
    });

    await this.policyEngine.invalidatePolicy(id);
    this.emitPolicyAuditEvent(SysEventType.ResourceDeleted, id, user?.id, { name: policy.name });

    this.logger.log({
      message: 'Policy deleted',
      policyId: id,
      policyName: policy.name,
      deletedBy: user?.id,
    });
  }

  /**
   * Validate policy rules
   */
  @Post('validate')
  @CanManage('Policy')
  @ApiOperation({ summary: 'Validate policy rules' })
  @ApiResponse({ status: 200, description: 'Validation result', type: PolicyValidationResponse })
  async validate(@Body() dto: ValidatePolicyDto): Promise<PolicyValidationResponse> {
    return this.validateRules(dto.rules);
  }

  /**
   * Validate policy rules
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private validateRules(rules: any[]): PolicyValidationResponse {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!Array.isArray(rules)) {
      return { valid: false, errors: ['Rules must be an array'] };
    }

    if (rules.length === 0) {
      warnings.push('Policy has no rules');
    }

    const validActions = ['manage', 'create', 'read', 'list', 'update', 'delete', 'archive', 'export'];

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];

      if (!rule.action) {
        errors.push(`Rule ${i + 1}: 'action' is required`);
      } else if (!validActions.includes(rule.action)) {
        warnings.push(`Rule ${i + 1}: Unknown action '${rule.action}'`);
      }

      if (!rule.subject) {
        errors.push(`Rule ${i + 1}: 'subject' is required`);
      }

      if (rule.conditions && typeof rule.conditions !== 'object') {
        errors.push(`Rule ${i + 1}: 'conditions' must be an object`);
      }

      if (rule.fields && !Array.isArray(rule.fields)) {
        errors.push(`Rule ${i + 1}: 'fields' must be an array`);
      }

      if (rule.inverted !== undefined && typeof rule.inverted !== 'boolean') {
        errors.push(`Rule ${i + 1}: 'inverted' must be a boolean`);
      }

      // Check for template variables in conditions
      if (rule.conditions) {
        this.checkConditionsForVariables(rule.conditions, i + 1, warnings);
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Check conditions for template variables
   */
  private checkConditionsForVariables(conditions: Record<string, unknown>, ruleIndex: number, warnings: string[]): void {
    const validVariables = ['user.id', 'user.tenantId', 'context.tenantId'];

    const checkValue = (value: unknown, path: string) => {
      if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
        const varName = value.slice(2, -1);
        if (!validVariables.includes(varName) && !varName.startsWith('params.')) {
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

  private emitPolicyAuditEvent(
    eventType: SysEventType,
    resourceId: string,
    userId: string | undefined,
    data?: unknown,
    previousData?: unknown,
  ): void {
    this.eventEmitter.emit(eventType, {
      resourceId,
      resourceType: ResourceType.Permission,
      responsibleEntityId: userId,
      data: data ?? {},
      ...(previousData !== undefined && { previousData }),
    });
  }
}
