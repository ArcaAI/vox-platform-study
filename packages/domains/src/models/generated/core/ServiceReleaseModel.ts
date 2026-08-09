/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ServiceRelease extends BaseTenantDataModel {
  public serviceName: string;
  public releaseVersion: string;
  public releaseTag: string | null;
  public gitBranch: string;
  public gitCommitSha: string;
  public buildAt: Date;
  public imageRepository: string | null;
  public imageDigest: string | null;
  public ciPipelineId: string | null;
  public ciPipelineUrl: string | null;
  public changelog: JsonValue | null;
  public firstSeenAt: Date;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public instances: Models.ServiceInstance[] | undefined;

  constructor(data: ServiceRelease & BaseTenantDataModel) {
    super(data);
    this.serviceName = data.serviceName;
    this.releaseVersion = data.releaseVersion;
    this.releaseTag = data.releaseTag;
    this.gitBranch = data.gitBranch;
    this.gitCommitSha = data.gitCommitSha;
    this.buildAt = data.buildAt;
    this.imageRepository = data.imageRepository;
    this.imageDigest = data.imageDigest;
    this.ciPipelineId = data.ciPipelineId;
    this.ciPipelineUrl = data.ciPipelineUrl;
    this.changelog = data.changelog;
    this.firstSeenAt = data.firstSeenAt;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.instances = data.instances;
  }
}
