import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { DataNotFoundException } from '@arcaai/exceptions';
import {
  ResourceType,
  ServiceInstanceEntity,
  ServiceInstanceFactory,
  ServiceInstanceRepository,
  ServiceReleaseEntity,
  ServiceReleaseFactory,
  ServiceReleaseRepository,
  SysEventType,
} from '@arcaai/domains';
import { BaseService, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IServiceReleaseService } from './IServiceReleaseService';
import {
  AttachDigestRequest,
  CurrentServiceResponse,
  InstanceLiveness,
  ListReleasesQuery,
  PaginatedServiceReleaseResponse,
  RegisterInstanceRequest,
  ServiceReleaseResponse,
} from './dto';
import { ServiceReleaseDtoMapper } from './serviceRelease.dto.mapper';

/**
 * An instance is LIVE while its `lastSeenAt` is within this window — three
 * missed 5-minute heartbeats. Anything older reports `stale`.
 */
export const INSTANCE_LIVENESS_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Release/instance rows are platform-wide, so they live under the reserved
 * SYSTEM tenant (`NULL = global` is banned house-wide).
 */
export const SERVICE_REGISTRY_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Service Version & Release Registry (TASK-648 W7).
 *
 * The one behaviour to preserve above all others: a HEARTBEAT IS SILENT. Every
 * pod boot and every 5-minute heartbeat broadcasting a sys-event would write
 * ~4,300 AuditLog rows/day of pure noise across ~15 processes and drown the
 * real audit trail. Only a first-seen `ServiceRelease` — a genuine version
 * change — broadcasts `ResourceCreated`.
 */
@Injectable()
export class ServiceReleaseService extends BaseService implements IServiceReleaseService {
  constructor(
    private readonly serviceReleaseRepository: ServiceReleaseRepository,
    private readonly serviceInstanceRepository: ServiceInstanceRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.ServiceRelease);
  }

  /**
   * Self-registration on boot, and the 5-minute heartbeat thereafter.
   *
   * Idempotent in both halves and safe when replicas boot simultaneously: a
   * lost unique-constraint race is recovered by re-reading the row the winner
   * wrote (and the loser broadcasts nothing, because it created nothing).
   */
  async registerInstance(input: RegisterInstanceRequest): Promise<ServiceReleaseResponse> {
    const releaseTag = input.releaseTag ?? null;

    let release = await this.findRelease({ serviceName: input.service, gitCommitSha: input.gitCommitSha, releaseTag });

    if (!release) {
      const candidate = ServiceReleaseFactory.CreateServiceRelease({
        tenantId: SERVICE_REGISTRY_TENANT_ID,
        serviceName: input.service,
        releaseVersion: input.version,
        releaseTag,
        gitBranch: input.gitBranch,
        gitCommitSha: input.gitCommitSha,
        buildAt: new Date(input.buildAt),
        ciPipelineId: input.ciPipelineId ?? null,
        ciPipelineUrl: input.ciPipelineUrl ?? null,
      });

      try {
        release = await this.serviceReleaseRepository.create(candidate);

        // A FIRST-SEEN release is the only sys-event on this write path.
        this.broadcastSysEvent(SysEventType.ResourceCreated, {
          resourceId: release.id,
          createdAt: release.createdAt,
          data: {
            serviceName: release.serviceName,
            releaseVersion: release.releaseVersion,
            releaseTag: release.releaseTag ?? null,
            gitCommitSha: release.gitCommitSha,
          },
        });
      } catch (error) {
        // Concurrent boot lost the unique-constraint race — adopt the winner's
        // row. No event: this process did not create anything.
        const winner = await this.findRelease({ serviceName: input.service, gitCommitSha: input.gitCommitSha, releaseTag });
        if (!winner) throw error;
        release = winner;
      }
    }

    await this.upsertInstance(release, input);

    return ServiceReleaseDtoMapper.toResponse(release);
  }

  /**
   * Attach the resolved manifest digest to an EXISTING release. Never creates
   * a row: a digest without a build is a contradiction, so an unmatched
   * (service, sha) is a 404. Re-attaching the same digest writes nothing.
   */
  async attachDigest(input: AttachDigestRequest): Promise<ServiceReleaseResponse> {
    // Keyed on (service, sha) only — the tag is deliberately not part of the
    // key. Newest build wins if a SHA somehow carries several tagged rows.
    const [release] = await this.serviceReleaseRepository.findAll({
      where: { serviceName: input.service, gitCommitSha: input.gitCommitSha },
      sort: [{ buildAt: 'desc' }],
      limit: 1,
      page: 1,
    });

    if (!release) {
      throw new DataNotFoundException('serviceRelease', `${input.service}@${input.gitCommitSha}`);
    }

    const repositoryChanged = input.imageRepository !== undefined && (release.imageRepository ?? null) !== (input.imageRepository ?? null);
    const digestChanged = (release.imageDigest ?? null) !== input.imageDigest;

    if (!repositoryChanged && !digestChanged) {
      return ServiceReleaseDtoMapper.toResponse(release);
    }

    if (digestChanged) release.imageDigest = input.imageDigest;
    if (repositoryChanged) release.imageRepository = input.imageRepository ?? null;

    const updated = await this.serviceReleaseRepository.update(release.id, release);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { imageDigest: input.imageDigest, imageRepository: input.imageRepository ?? null },
    });

    return ServiceReleaseDtoMapper.toResponse(updated);
  }

  /** Release history across services, newest build first. */
  async listReleases(query: ListReleasesQuery): Promise<PaginatedServiceReleaseResponse> {
    const where: Record<string, unknown> = { tenantId: SERVICE_REGISTRY_TENANT_ID };
    if (query.serviceName) where.serviceName = query.serviceName;

    if (query.environment) {
      // "Observed running in <environment>" is an instance-side fact, so
      // narrow by the release ids seen there.
      const instances = await this.serviceInstanceRepository.findAll({ where: { environment: query.environment } });
      const releaseIds = [...new Set(instances.map((instance) => instance.releaseId))];
      where.id = { in: releaseIds };
    }

    const paginatedQuery: PaginatedQuery = { page: query.page, limit: query.limit, search: query.search, sort: query.sort };

    const releases = await this.serviceReleaseRepository.findAll({
      ...withFormattedPaginatedProps(paginatedQuery),
      sort: [{ buildAt: 'desc' }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-built Prisma filter, not expressible as DbFilters here
      where: where as any,
    });

    const count = await this.serviceReleaseRepository.count({
      ...withFormattedCountProps(paginatedQuery),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same reason as above
      where: where as any,
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { count } });

    return ServiceReleaseDtoMapper.ToPaginatedResponse({
      page: query.page ?? 0,
      limit: query.limit ?? 0,
      count,
      data: releases,
    });
  }

  /**
   * What is running right now — the newest instance per (serviceName,
   * environment), with its liveness and a count of its LIVE siblings.
   */
  async listCurrent(environment: string): Promise<CurrentServiceResponse[]> {
    const instances = await this.serviceInstanceRepository.findAll({
      where: { environment },
      sort: [{ lastSeenAt: 'desc' }],
    });

    if (instances.length === 0) return [];

    const newestByService = new Map<string, ServiceInstanceEntity>();
    const liveCountByService = new Map<string, number>();
    const now = Date.now();

    for (const instance of instances) {
      const current = newestByService.get(instance.serviceName);
      if (!current || instance.lastSeenAt.getTime() > current.lastSeenAt.getTime()) {
        newestByService.set(instance.serviceName, instance);
      }
      if (this.isLive(instance.lastSeenAt, now)) {
        liveCountByService.set(instance.serviceName, (liveCountByService.get(instance.serviceName) ?? 0) + 1);
      }
    }

    const releaseIds = [...new Set([...newestByService.values()].map((instance) => instance.releaseId))];
    const releases = await this.serviceReleaseRepository.findAll({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `in` filter, not expressible as DbFilters here
      where: { id: { in: releaseIds } } as any,
    });
    const releaseById = new Map(releases.map((release) => [release.id, release]));

    const rows: CurrentServiceResponse[] = [];
    for (const [serviceName, instance] of newestByService) {
      const release = releaseById.get(instance.releaseId);
      if (!release) continue; // orphaned observation — nothing truthful to report
      rows.push({
        serviceName,
        environment,
        release: ServiceReleaseDtoMapper.toResponse(release),
        instanceCount: liveCountByService.get(serviceName) ?? 0,
        liveness: this.isLive(instance.lastSeenAt, now) ? 'live' : ('stale' as InstanceLiveness),
        startedAt: instance.startedAt.toISOString(),
        lastSeenAt: instance.lastSeenAt.toISOString(),
      });
    }

    return rows.sort((a, b) => a.serviceName.localeCompare(b.serviceName));
  }

  /** Release timeline for one service, newest first. */
  async getHistory(serviceName: string): Promise<ServiceReleaseResponse[]> {
    const releases = await this.serviceReleaseRepository.findAll({
      where: { serviceName },
      sort: [{ buildAt: 'desc' }],
    });

    if (releases.length === 0) {
      throw new DataNotFoundException('serviceRelease', serviceName);
    }

    return releases.map(ServiceReleaseDtoMapper.toResponse);
  }

  private isLive(lastSeenAt: Date, now: number): boolean {
    return now - lastSeenAt.getTime() <= INSTANCE_LIVENESS_THRESHOLD_MS;
  }

  private async findRelease(key: { serviceName: string; gitCommitSha: string; releaseTag: string | null }): Promise<ServiceReleaseEntity | null> {
    const [found] = await this.serviceReleaseRepository.findAll({
      where: { serviceName: key.serviceName, gitCommitSha: key.gitCommitSha, releaseTag: key.releaseTag },
      limit: 1,
      page: 1,
    });
    return found ?? null;
  }

  /**
   * Upsert the runtime observation.
   *
   * A repeat call for the SAME release is a HEARTBEAT: it stamps `lastSeenAt`
   * and nothing else.
   *
   * A repeat call carrying a DIFFERENT release is a new deployment reusing an
   * instance identity — which is the normal case for a StatefulSet, whose pod
   * names (`stt-0`, `stt-1`) are stable across rollouts, and possible for the
   * `hostname:pid` fallback outside Kubernetes. The row is re-pointed at the
   * new release and `startedAt` is reset, otherwise a StatefulSet rollout
   * would report the OLD version forever — exactly the failure this registry
   * exists to prevent.
   *
   * Neither branch broadcasts a sys-event: the instance row is a runtime
   * observation. A genuinely new release is what earns the one
   * `ResourceCreated`, and that already fired upstream in `registerInstance`.
   */
  private async upsertInstance(release: ServiceReleaseEntity, input: RegisterInstanceRequest): Promise<void> {
    const [existing] = await this.serviceInstanceRepository.findAll({
      where: { serviceName: input.service, environment: input.environment, instanceId: input.instanceId },
      limit: 1,
      page: 1,
    });

    if (existing) {
      const now = new Date();
      if (existing.releaseId !== release.id) {
        existing.releaseId = release.id;
        existing.startedAt = now;
      }
      existing.lastSeenAt = now;
      await this.serviceInstanceRepository.update(existing.id, existing);
      return;
    }

    const instance = ServiceInstanceFactory.CreateServiceInstance({
      tenantId: SERVICE_REGISTRY_TENANT_ID,
      releaseId: release.id,
      serviceName: input.service,
      environment: input.environment,
      instanceId: input.instanceId,
      startedAt: new Date(),
    });

    try {
      await this.serviceInstanceRepository.create(instance);
    } catch (error) {
      // Two heartbeats racing the first insert — the row now exists; stamp it.
      const [winner] = await this.serviceInstanceRepository.findAll({
        where: { serviceName: input.service, environment: input.environment, instanceId: input.instanceId },
        limit: 1,
        page: 1,
      });
      if (!winner) throw error;
      winner.lastSeenAt = new Date();
      await this.serviceInstanceRepository.update(winner.id, winner);
    }
  }
}
