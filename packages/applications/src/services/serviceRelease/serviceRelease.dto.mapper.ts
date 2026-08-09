import { ServiceReleaseEntity } from '@arcaai/domains';
import { PaginatedServiceReleaseResponse, ServiceReleaseResponse } from './dto';

export class ServiceReleaseDtoMapper {
  /**
   * `releaseVersion` → `version` on the wire. The entity cannot call the field
   * `version` (that name is the OCC counter on every model), but the frozen
   * API contract surfaces it as `version`; this is the one place the two
   * names meet.
   */
  static toResponse(entity: ServiceReleaseEntity): ServiceReleaseResponse {
    return {
      id: entity.id,
      serviceName: entity.serviceName,
      version: entity.releaseVersion,
      releaseTag: entity.releaseTag ?? null,
      gitBranch: entity.gitBranch,
      gitCommitSha: entity.gitCommitSha,
      buildAt: entity.buildAt.toISOString(),
      imageRepository: entity.imageRepository ?? null,
      imageDigest: entity.imageDigest ?? null,
      ciPipelineUrl: entity.ciPipelineUrl ?? null,
      changelog: entity.changelog ?? null,
    };
  }

  static ToPaginatedResponse({
    page,
    limit,
    count,
    data,
  }: {
    page: number;
    limit: number;
    count: number;
    data: ServiceReleaseEntity[];
  }): PaginatedServiceReleaseResponse {
    return new PaginatedServiceReleaseResponse({
      page,
      limit,
      count,
      data: data.map(ServiceReleaseDtoMapper.toResponse),
    });
  }
}
