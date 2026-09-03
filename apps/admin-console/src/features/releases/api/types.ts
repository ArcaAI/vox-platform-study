/**
 * Wire types for the Service Release & Changelog registry, backed by
 * `admin/service-releases/*`. Re-declared locally (rule 13) from the FROZEN
 * contract at
 * contracts/service-release.api.yaml` — coded against that fragment only; a
 * field not described there is not invented here.
 */

export type Environment = 'dev' | 'staging' | 'prod';

/** `live` when the instance's `lastSeenAt` is within 15 minutes — computed server-side. */
export type InstanceLiveness = 'live' | 'stale';

/** Conventional Commit type bucket. `other` is where non-parsing commits land, never dropped. */
export type ChangelogItemType = 'feat' | 'fix' | 'perf' | 'refactor' | 'docs' | 'test' | 'build' | 'ci' | 'chore' | 'revert' | 'other';

/** One entry of the generated TECHNICAL changelog (changelog-entry.schema.json). */
export interface TechnicalChangelogItem {
  type: ChangelogItemType;
  scope: string | null;
  ticket: string | null;
  subject: string;
  sha: string;
  breaking: boolean;
}

/** `ServiceReleaseResponse` — immutable build facts for one (service, build). */
export interface ServiceRelease {
  id: string;
  serviceName: string;
  /** SemVer from the release tag, or `0.0.0-<branch>.<sha8>` on an untagged build. */
  version: string;
  /** `TEXT-2.1.0`; null on an untagged build — never render a fabricated version instead. */
  releaseTag: string | null;
  gitBranch: string;
  gitCommitSha: string;
  buildAt: string;
  imageRepository: string | null;
  /** Attached by the CI publish/promote step — absent until the image is pushed. */
  imageDigest: string | null;
  ciPipelineUrl: string | null;
  changelog: TechnicalChangelogItem[] | null;
}

/** `CurrentServiceResponse` — the latest live instance per (service, environment). */
export interface CurrentService {
  serviceName: string;
  environment: Environment;
  release: ServiceRelease;
  instanceCount: number;
  liveness: InstanceLiveness;
  startedAt: string;
  lastSeenAt: string;
}

export interface ServiceReleaseListParams {
  serviceName?: string;
  environment?: Environment;
  page?: number;
  limit?: number;
  [key: string]: string | number | boolean | undefined | null;
}
