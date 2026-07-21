import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DepartmentRepository,
  ResourceStatusType,
  ResourceType,
  SysEventType,
  TenantPlan,
  UserDepartmentFactory,
  UserDepartmentRepository,
} from '@arcaai/domains';
import { ArgumentInvalidException, InternalServerErrorException } from '@arcaai/exceptions';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { UserSession } from '../../auth/dto/user.session';
import { ITenantService } from '../ITenantService';
import { IUserService } from '../../user/user/IUserService';
import { IUserRoleAssignmentService } from '../../user/userRoleAssignment/IUserRoleAssignmentService';
import { GLOBAL_ADMIN_ROLE, TENANT_ADMIN_ROLE_ID } from '../constants';
import { DEFAULT_GEN_DEPARTMENT } from '../departmentDefaults';
import { ITenantOnboardingService } from './ITenantOnboardingService';
import { OnboardingActor, ProvisionTenantWithAdminInput } from './dto';
import { TenantProvisionResult } from './tenantOnboarding.dto.mapper';

/**
 * See `ITenantOnboardingService` for the contract summary.
 *
 * CLS strategy: the whole method runs inside a fresh `clsService.run()`
 * so it never depends on (or leaks into) an ambient request context — correct
 * for both the SYSTEM-bootstrap registration caller (no CLS at all) and the
 * real-caller admin-create path. The synthetic session is built with the
 * `GLOBAL_ADMIN` role: this is an internal, already-authorized orchestration
 * (the SYSTEM bootstrap is inherently trusted; admin-create is already gated
 * by `@CanManage('Tenant')` upstream), and `UserRoleAssignmentService`'s
 * cross-tenant guard would otherwise reject re-assigning an EXISTING admin
 * who already holds a role in some other tenant — exactly the global-admin
 * "pick an existing user" case this method supports.
 *
 * Atomicity (guardrail: never adminless): `TenantService.create` is not
 * itself transactional (its own provisioning steps are independently
 * best-effort). Rather than thread a `tx` through every collaborator's public
 * interface, admin provisioning failures trigger a compensating soft-delete
 * of the just-created tenant, then re-throw — a tenant is never left without
 * an admin, even though the DB writes aren't inside one SQL transaction.
 */
@Injectable()
export class TenantOnboardingService extends BaseService implements ITenantOnboardingService {
  private readonly logger = new Logger(TenantOnboardingService.name);

  constructor(
    @Inject(ITenantService) private readonly tenantService: ITenantService,
    @Inject(IUserService) private readonly userService: IUserService,
    @Inject(IUserRoleAssignmentService) private readonly userRoleAssignmentService: IUserRoleAssignmentService,
    private readonly departmentRepository: DepartmentRepository,
    private readonly userDepartmentRepository: UserDepartmentRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Tenant);
  }

  async provisionTenantWithAdmin(input: ProvisionTenantWithAdminInput): Promise<TenantProvisionResult> {
    return this.clsService.run(async () => {
      if (input.admin.kind === 'existing') {
        const existingAdmin = await this.userService.fetchById(input.admin.userId);
        if (existingAdmin.resourceStatus !== ResourceStatusType.ENABLED) {
          throw new ArgumentInvalidException('Admin user is not active');
        }
      }

      this.clsService.set('user', this.buildOnboardingSession(input.actor));
      const tenant = await this.tenantService.create({
        name: input.tenantName,
        key: input.tenantKey,
        plan: input.plan ?? TenantPlan.STARTER,
      });

      try {
        this.clsService.set('tenantId', tenant.id);
        this.clsService.set('user', this.buildOnboardingSession(input.actor));

        const genDepartment = await this.departmentRepository.findByCode(tenant.id, DEFAULT_GEN_DEPARTMENT.code);
        if (!genDepartment) {
          throw new InternalServerErrorException('Default department was not provisioned for the new tenant');
        }

        const adminUserId =
          input.admin.kind === 'existing'
            ? await this.assignExistingAdmin(tenant.id, input.admin.userId, genDepartment.id, input.actor)
            : await this.createLocalAdmin(input.admin, genDepartment.id);

        return { tenant, adminUserId, tenantKey: tenant.key as string };
      } catch (error) {
        await this.rollbackTenant(tenant.id, error);
        throw error;
      }
    });
  }

  /** Existing user: assign TENANT_ADMIN + attach GEN department (two writes). */
  private async assignExistingAdmin(tenantId: string, userId: string, genDepartmentId: string, actor: OnboardingActor): Promise<string> {
    await this.userRoleAssignmentService.create({ userId, roleId: TENANT_ADMIN_ROLE_ID });

    const membership = UserDepartmentFactory.CreateUserDepartment({
      tenantId,
      userId,
      departmentId: genDepartmentId,
      isPrimary: true,
      createdBy: actor.userId,
    });
    const saved = await this.userDepartmentRepository.create(membership);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      resourceType: ResourceType.UserDepartment,
      data: { tenantId, userId, departmentId: genDepartmentId },
    });

    return userId;
  }

  /** New local account: UserService.create does role + department atomically. */
  private async createLocalAdmin(
    admin: Extract<ProvisionTenantWithAdminInput['admin'], { kind: 'new-local' }>,
    genDepartmentId: string,
  ): Promise<string> {
    const created = await this.userService.create({
      username: admin.username ?? admin.email,
      email: admin.email,
      password: admin.password,
      roleId: TENANT_ADMIN_ROLE_ID,
      departmentId: genDepartmentId,
      isPrimaryDepartment: true,
    });

    return created.id;
  }

  /** Compensating action — never leave a partially-provisioned tenant behind. */
  private async rollbackTenant(tenantId: string, cause: unknown): Promise<void> {
    try {
      await this.tenantService.deleteById(tenantId);
      this.logger.warn({
        message: 'Rolled back (soft-deleted) a tenant after admin provisioning failed',
        tenantId,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    } catch (rollbackError) {
      this.logger.error({
        message: 'Failed to roll back a partially-provisioned tenant after admin provisioning failure',
        tenantId,
        cause: cause instanceof Error ? cause.message : String(cause),
        rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
  }

  private buildOnboardingSession(actor: OnboardingActor): UserSession {
    return new UserSession({
      id: actor.userId,
      email: 'tenant-onboarding@system.local',
      tenantId: actor.tenantId,
      roles: [GLOBAL_ADMIN_ROLE],
      permissions: [],
    });
  }
}
