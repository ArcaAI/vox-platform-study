import { BaseEntityFactoryCreateProps } from '../../../common';
import { IServiceReleaseEntity, ServiceReleaseEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateServiceReleaseProps extends BaseEntityFactoryCreateProps {
  tenantId: IServiceReleaseEntity['tenantId'];
  serviceName: IServiceReleaseEntity['serviceName'];
  releaseVersion: IServiceReleaseEntity['releaseVersion'];
  releaseTag?: IServiceReleaseEntity['releaseTag'];
  gitBranch: IServiceReleaseEntity['gitBranch'];
  gitCommitSha: IServiceReleaseEntity['gitCommitSha'];
  buildAt: IServiceReleaseEntity['buildAt'];
  imageRepository?: IServiceReleaseEntity['imageRepository'];
  imageDigest?: IServiceReleaseEntity['imageDigest'];
  ciPipelineId?: IServiceReleaseEntity['ciPipelineId'];
  ciPipelineUrl?: IServiceReleaseEntity['ciPipelineUrl'];
  changelog?: IServiceReleaseEntity['changelog'];
  firstSeenAt?: IServiceReleaseEntity['firstSeenAt'];

  createdAt?: IServiceReleaseEntity['createdAt'];
  updatedAt?: IServiceReleaseEntity['updatedAt'];
  createdBy?: IServiceReleaseEntity['createdBy'];
  updatedBy?: IServiceReleaseEntity['updatedBy'];
}

export class ServiceReleaseFactory {
  static CreateServiceRelease(props: CreateServiceReleaseProps): ServiceReleaseEntity {
    const id = generateId();
    const now = new Date();

    return new ServiceReleaseEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      serviceName: props.serviceName,
      releaseVersion: props.releaseVersion,
      releaseTag: props.releaseTag ?? null,
      gitBranch: props.gitBranch,
      gitCommitSha: props.gitCommitSha,
      buildAt: props.buildAt,
      imageRepository: props.imageRepository ?? null,
      imageDigest: props.imageDigest ?? null,
      ciPipelineId: props.ciPipelineId ?? null,
      ciPipelineUrl: props.ciPipelineUrl ?? null,
      changelog: props.changelog ?? null,
      firstSeenAt: props.firstSeenAt || now,
    });
  }
}
