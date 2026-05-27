import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { IResourceSubscriptionService } from './IResourceSubscriptionService';
import { CreateResourceSubscriptionRequest, UpdateResourceSubscriptionRequest } from './dto';
import {
  EntityId,
  ResourceSubscriptionEntity,
  ResourceType,
  ResourceSubscriptionFactory,
  ResourceSubscriptionType,
  SysEventType,
  ResourceStatusType,
  ResourceSubscriptionRepository,
} from '@arcaai/domains';
import { assertEqualTenants, BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { InternalServerErrorException, ArgumentInvalidException, ArgumentNotProvidedException, UnauthorizedException } from '@arcaai/exceptions';
import { BadRequestException } from '@nestjs/common';
import { SUPER_ADMIN_ROLE } from '../tenant/constants';

@Injectable()
export class ResourceSubscriptionService extends BaseService implements IResourceSubscriptionService {
  constructor(
    private readonly resourceSubscriptionRepository: ResourceSubscriptionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.ResourceSubscription);
  }

  async create(request: CreateResourceSubscriptionRequest): Promise<ResourceSubscriptionEntity> {
    if (!this.tenantId) {
      throw new BadRequestException('Tenant context required to create a resource subscription');
    }
    const newResourceSubscription = ResourceSubscriptionFactory.CreateResourceSubscription({
      resourceId: request.resourceId,
      resourceTypeName: request.resourceTypeName as ResourceType,
      subscriptionType: request.subscriptionType as ResourceSubscriptionType,
      resourceStatus: request.resourceStatus,
      targetUserId: request.targetUserId,
      createdBy: this.requestUser?.id,
      tenantId: this.tenantId,
    });

    const resourceSubscription = await this.resourceSubscriptionRepository.create(newResourceSubscription);

    if (!resourceSubscription) {
      throw new InternalServerErrorException(`Failed to create resource subscription: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: resourceSubscription.id,
      createdAt: resourceSubscription.createdAt,
      data: resourceSubscription.toObject() as object,
    });
    return resourceSubscription;
  }

  /**
   * TASK-306 P2.4 (audit M-3 / AC-6) — list endpoint scoped to the
   * caller's tenant. Non-SUPER_ADMIN callers see only their own tenant's
   * subscriptions; SUPER_ADMIN bypasses the filter so cross-tenant
   * administration tooling can list every subscription in the platform.
   * Mirrors the W3.2 NotificationService.fetchAll posture.
   */
  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<ResourceSubscriptionEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search } = props;
    const baseWhere = this.isSuperAdmin() ? {} : { tenantId: this.tenantId };
    const paginatedProps = withFormattedPaginatedProps(props);
    const countProps = withFormattedCountProps(props);
    const resourceSubscriptions = await this.resourceSubscriptionRepository.findAll({
      ...paginatedProps,
      where: { ...paginatedProps.where, ...baseWhere },
    });
    const count = await this.resourceSubscriptionRepository.count({
      ...countProps,
      where: { ...countProps.where, ...baseWhere },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: resourceSubscriptions.map((resourceSubscription: ResourceSubscriptionEntity) => resourceSubscription.id),
      },
    });
    return new FetchResponse<ResourceSubscriptionEntity>({
      data: resourceSubscriptions,
      count,
      limit,
      page,
    });
  }

  /**
   * True when the active request user carries the `SUPER_ADMIN` role.
   * Falls back to `false` whenever the role list is missing so the most
   * restrictive policy applies. Mirrors the strict-default helper used
   * by `NotificationService`, `WebhookService`, and `TenantService`.
   */
  private isSuperAdmin(): boolean {
    const roles = this.requestUser?.roles;
    return Array.isArray(roles) && roles.includes(SUPER_ADMIN_ROLE);
  }

  /**
   * TASK-306 P2.4 (audit M-3 / AC-6) — resource-scoped list endpoint
   * with tenant injection. Non-SUPER_ADMIN callers see only their own
   * tenant's subscriptions to the resource; SUPER_ADMIN bypasses the
   * tenant filter so admin tooling can list every subscription on a
   * cross-tenant resource. The resource scoping itself is enforced for
   * everyone (no SUPER_ADMIN bypass for the resource predicate).
   */
  async fetchAllByResource(
    props: PaginatedQuery & { resourceTypeName: string; resourceId: string },
  ): Promise<FetchResponse<ResourceSubscriptionEntity>> {
    const { resourceTypeName, resourceId, limit, page, search } = props;

    if (!resourceId || !resourceTypeName) {
      throw new ArgumentNotProvidedException(`Invalid arguments: resourceId: ${resourceId}, resourceTypeName: ${resourceTypeName}`);
    }

    const baseWhere = this.isSuperAdmin() ? {} : { tenantId: this.tenantId };

    const resourceSubscriptions = await this.resourceSubscriptionRepository.findAll({
      page,
      limit,
      search,
      where: {
        ...baseWhere,
        resourceId,
        resourceTypeName: resourceTypeName as ResourceType,
      },
    });

    const count = await this.resourceSubscriptionRepository.count({
      ...withFormattedCountProps(props),
      where: {
        ...baseWhere,
        resourceId,
        resourceTypeName: resourceTypeName as ResourceType,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        resourceId,
        resourceTypeName,
        items: resourceSubscriptions.map((resourceSubscription: ResourceSubscriptionEntity) => resourceSubscription.id),
      },
    });

    return new FetchResponse<ResourceSubscriptionEntity>({
      data: resourceSubscriptions,
      count,
      limit,
      page,
    });
  }

  async fetchByResource(resourceTypeName: ResourceType, resourceId: EntityId): Promise<ResourceSubscriptionEntity | null> {
    const resourceSubscription = await this.resourceSubscriptionRepository.findByResource(resourceTypeName, resourceId).catch(() => null);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: resourceSubscription ? resourceSubscription.id : resourceId,
      data: resourceSubscription ? resourceSubscription.toObject() : { message: 'Resource not found' },
    });
    return resourceSubscription;
  }

  /**
   * TASK-306 P2.4 (audit M-3 / AC-6) — single-entity read with the
   * DEF-C3 "no existence leak" guard. Non-SUPER_ADMIN callers see a
   * `NotFoundException` (404) when the row exists but belongs to
   * another tenant — the same response shape the repository returns
   * for a row that genuinely does not exist. SUPER_ADMIN bypasses
   * the assertion so admin tooling can inspect any subscription.
   */
  async fetchById(id: EntityId): Promise<ResourceSubscriptionEntity> {
    const resourceSubscription = await this.resourceSubscriptionRepository.findById(id);

    if (!this.isSuperAdmin()) {
      assertEqualTenants(resourceSubscription, { tenantId: this.tenantId });
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: resourceSubscription.id,
      data: resourceSubscription.toObject() as object,
    });
    return resourceSubscription;
  }

  /**
   * TASK-306 P2.4 (audit M-3 / AC-6) — mutation gated by tenant
   * ownership. We load the row first, then assert the tenant scope
   * BEFORE applying any change, so cross-tenant `update` calls cannot
   * mutate state and cannot be used as a probe (the response is a
   * generic 404, identical to the missing-row case). SUPER_ADMIN
   * bypasses the assertion for platform tooling.
   */
  async update(id: EntityId, request: UpdateResourceSubscriptionRequest): Promise<ResourceSubscriptionEntity> {
    const resourceSubscription = await this.resourceSubscriptionRepository.findById(id);

    if (!this.isSuperAdmin()) {
      assertEqualTenants(resourceSubscription, { tenantId: this.tenantId });
    }

    const previousData = resourceSubscription.toObject();
    await this.updateEntity(resourceSubscription, request, {
      $apply: ({ entity, changes }) =>
        changes.resourceStatus && changes.resourceStatus === ResourceStatusType.ENABLED ? entity.disable() : entity.enable(),
    });

    if (!resourceSubscription.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }
    const updatedResourceSubscription = await this.resourceSubscriptionRepository.update(id, resourceSubscription);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedResourceSubscription.id,
      data: resourceSubscription.changes,
      previousData,
    });
    return updatedResourceSubscription;
  }

  async toggleSubscriptionByResource(resourceTypeName: ResourceType, resourceId: EntityId): Promise<ResourceSubscriptionEntity> {
    const resourceSubscription = await this.resourceSubscriptionRepository.findByResource(resourceTypeName, resourceId).catch(() => null);

    if (!resourceSubscription) {
      if (!this.requestUserId) {
        throw new UnauthorizedException('Unauthorized');
      }
      return await this.create({
        resourceTypeName,
        resourceId,
        subscriptionType: ResourceSubscriptionType.SUBSCRIBER,
        resourceStatus: ResourceStatusType.ENABLED,
        targetUserId: this.requestUserId,
      });
    }

    const updatedResourceSubscription = await this.update(resourceSubscription.id, {
      resourceStatus: resourceSubscription.resourceStatus === ResourceStatusType.ENABLED ? ResourceStatusType.DISABLED : ResourceStatusType.ENABLED,
    });

    return updatedResourceSubscription;
  }

  async toggleSubscriptionById(id: EntityId): Promise<ResourceSubscriptionEntity> {
    const resourceSubscription = await this.resourceSubscriptionRepository.findById(id);

    const updatedResourceSubscription = await this.update(resourceSubscription.id, {
      resourceStatus: resourceSubscription.resourceStatus === ResourceStatusType.ENABLED ? ResourceStatusType.DISABLED : ResourceStatusType.ENABLED,
    });

    return updatedResourceSubscription;
  }

  async deleteById(id: EntityId): Promise<ResourceSubscriptionEntity> {
    const resourceSubscription = await this.resourceSubscriptionRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: resourceSubscription.id,
      data: resourceSubscription.toObject() as object,
    });
    return resourceSubscription;
  }
}
