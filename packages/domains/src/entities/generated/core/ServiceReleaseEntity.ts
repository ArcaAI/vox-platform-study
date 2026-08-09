/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// Immutable build facts (TASK-648) — one row per (serviceName, gitCommitSha,
// releaseTag). Written once by the internal self-registration endpoint,
// never updated (machine-written, non-OCC), always platform-wide under the
// SYSTEM tenant. `releaseVersion` (NOT `version` — the standard template's
// OCC counter already owns that name) carries the git-tag-derived SemVer, or
// the `0.0.0-<branch>.<sha8>` untagged shape (see the ticket README §3.1).
export interface IServiceReleaseEntity extends IBaseTenantEntity {
  serviceName: string;
  releaseVersion: string;
  releaseTag?: string | null;
  gitBranch: string;
  gitCommitSha: string;
  buildAt: Date;
  imageRepository?: string | null;
  imageDigest?: string | null;
  ciPipelineId?: string | null;
  ciPipelineUrl?: string | null;
  changelog?: Record<string, unknown>[] | null;
  firstSeenAt: Date;
}

export class ServiceReleaseEntity extends BaseTenantEntity {
  private _serviceName: IServiceReleaseEntity['serviceName'];
  private _releaseVersion: IServiceReleaseEntity['releaseVersion'];
  private _releaseTag?: IServiceReleaseEntity['releaseTag'];
  private _gitBranch: IServiceReleaseEntity['gitBranch'];
  private _gitCommitSha: IServiceReleaseEntity['gitCommitSha'];
  private _buildAt: IServiceReleaseEntity['buildAt'];
  private _imageRepository?: IServiceReleaseEntity['imageRepository'];
  private _imageDigest?: IServiceReleaseEntity['imageDigest'];
  private _ciPipelineId?: IServiceReleaseEntity['ciPipelineId'];
  private _ciPipelineUrl?: IServiceReleaseEntity['ciPipelineUrl'];
  private _changelog?: IServiceReleaseEntity['changelog'];
  private _firstSeenAt: IServiceReleaseEntity['firstSeenAt'];

  constructor(init: IServiceReleaseEntity) {
    super(init);
    this._serviceName = init.serviceName;
    this._releaseVersion = init.releaseVersion;
    this._releaseTag = init.releaseTag;
    this._gitBranch = init.gitBranch;
    this._gitCommitSha = init.gitCommitSha;
    this._buildAt = init.buildAt;
    this._imageRepository = init.imageRepository;
    this._imageDigest = init.imageDigest;
    this._ciPipelineId = init.ciPipelineId;
    this._ciPipelineUrl = init.ciPipelineUrl;
    this._changelog = init.changelog;
    this._firstSeenAt = init.firstSeenAt;
  }

  get serviceName(): IServiceReleaseEntity['serviceName'] {
    return this._serviceName;
  }

  set serviceName(value: IServiceReleaseEntity['serviceName']) {
    this.setProperty('serviceName', value);
  }

  get releaseVersion(): IServiceReleaseEntity['releaseVersion'] {
    return this._releaseVersion;
  }

  set releaseVersion(value: IServiceReleaseEntity['releaseVersion']) {
    this.setProperty('releaseVersion', value);
  }

  get releaseTag(): IServiceReleaseEntity['releaseTag'] {
    return this._releaseTag;
  }

  set releaseTag(value: IServiceReleaseEntity['releaseTag']) {
    this.setProperty('releaseTag', value);
  }

  get gitBranch(): IServiceReleaseEntity['gitBranch'] {
    return this._gitBranch;
  }

  set gitBranch(value: IServiceReleaseEntity['gitBranch']) {
    this.setProperty('gitBranch', value);
  }

  get gitCommitSha(): IServiceReleaseEntity['gitCommitSha'] {
    return this._gitCommitSha;
  }

  set gitCommitSha(value: IServiceReleaseEntity['gitCommitSha']) {
    this.setProperty('gitCommitSha', value);
  }

  get buildAt(): IServiceReleaseEntity['buildAt'] {
    return this._buildAt;
  }

  set buildAt(value: IServiceReleaseEntity['buildAt']) {
    this.setProperty('buildAt', value);
  }

  get imageRepository(): IServiceReleaseEntity['imageRepository'] {
    return this._imageRepository;
  }

  set imageRepository(value: IServiceReleaseEntity['imageRepository']) {
    this.setProperty('imageRepository', value);
  }

  get imageDigest(): IServiceReleaseEntity['imageDigest'] {
    return this._imageDigest;
  }

  set imageDigest(value: IServiceReleaseEntity['imageDigest']) {
    this.setProperty('imageDigest', value);
  }

  get ciPipelineId(): IServiceReleaseEntity['ciPipelineId'] {
    return this._ciPipelineId;
  }

  set ciPipelineId(value: IServiceReleaseEntity['ciPipelineId']) {
    this.setProperty('ciPipelineId', value);
  }

  get ciPipelineUrl(): IServiceReleaseEntity['ciPipelineUrl'] {
    return this._ciPipelineUrl;
  }

  set ciPipelineUrl(value: IServiceReleaseEntity['ciPipelineUrl']) {
    this.setProperty('ciPipelineUrl', value);
  }

  get changelog(): IServiceReleaseEntity['changelog'] {
    return this._changelog;
  }

  set changelog(value: IServiceReleaseEntity['changelog']) {
    this.setProperty('changelog', value);
  }

  get firstSeenAt(): IServiceReleaseEntity['firstSeenAt'] {
    return this._firstSeenAt;
  }

  set firstSeenAt(value: IServiceReleaseEntity['firstSeenAt']) {
    this.setProperty('firstSeenAt', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._serviceName || this._serviceName.trim().length === 0) {
      throw new BusinessException('Service name is required');
    }
    if (!this._releaseVersion || this._releaseVersion.trim().length === 0) {
      throw new BusinessException('Release version is required');
    }
    if (!this._gitBranch || this._gitBranch.trim().length === 0) {
      throw new BusinessException('Git branch is required');
    }
    if (!this._gitCommitSha || this._gitCommitSha.trim().length === 0) {
      throw new BusinessException('Git commit SHA is required');
    }
  }
}
