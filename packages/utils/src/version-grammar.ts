/**
 * TASK-648 — the release version grammar (ticket README §3.1).
 *
 * ONE definition of what a version is, shared by the CI tag gate, the
 * build-info readers, the release registry and the console badges. The git tag
 * IS the version: nothing here reads `package.json` or `npm_package_version`
 * (the latter is unset in every container, which is why the API gateway
 * reported `0.1.0` in production for as long as it has been deployed).
 *
 *   <SVC>-<MAJOR>.<MINOR>.<PATCH>[-<prerelease>]   e.g. SMR-2.1.0, STT-3.0.0-rc.1
 *   ALL-<MAJOR>.<MINOR>.<PATCH>                    the platform release train
 */

/**
 * Service prefixes that trigger an image build. Kept in lockstep with the
 * `$CI_COMMIT_TAG =~ /^(...)-/` rules in `.gitlab/ci/build.yml`; a prefix that
 * builds an image but is absent here yields a release the console cannot name.
 */
export const SERVICE_TAG_PREFIXES = ['ALL', 'API', 'ADMIN', 'COMPAT', 'GUARD', 'HARNESS', 'NLP', 'SMR', 'STT', 'TTS'] as const;

export type ServiceTagPrefix = (typeof SERVICE_TAG_PREFIXES)[number];

/** The prefix denoting a platform-wide release train rather than one service. */
export const PLATFORM_TRAIN_PREFIX: ServiceTagPrefix = 'ALL';

/**
 * Numeric identifiers reject leading zeros, per the SemVer spec. The
 * pre-release part is the dot-separated identifier list SemVer allows; build
 * metadata (`+...`) is deliberately NOT accepted — an image is identified by
 * its digest, so a `+build` suffix would be a second, weaker identity.
 */
const SEMVER_CORE = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)';
const SEMVER_PRERELEASE = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*';

/**
 * Anchored pattern for a valid release tag. Exported so the CI gate and the
 * parser cannot drift apart. Stateless (no `g` flag) — `.test()` is safe to
 * call repeatedly.
 */
export const RELEASE_TAG_PATTERN = new RegExp(`^(${SERVICE_TAG_PREFIXES.join('|')})-${SEMVER_CORE}(?:-(${SEMVER_PRERELEASE}))?$`);

export interface ParsedReleaseTag {
  /** Service prefix, e.g. `SMR`. `ALL` denotes the platform train. */
  service: ServiceTagPrefix;
  /** The SemVer portion, e.g. `2.1.0` or `3.0.0-rc.1`. */
  version: string;
  major: number;
  minor: number;
  patch: number;
  /** e.g. `rc.1`, or null for a final release. */
  prerelease: string | null;
  isPlatformTrain: boolean;
}

/**
 * Parse a git tag into its release identity, or return null when the tag is not
 * a release tag. Returning null rather than throwing is deliberate: most
 * pipeline runs are untagged, and "not a release" is an ordinary outcome.
 */
export function parseReleaseTag(tag: string): ParsedReleaseTag | null {
  const match = RELEASE_TAG_PATTERN.exec(tag);
  if (!match) return null;

  const [, service, major, minor, patch, prerelease] = match;
  const core = `${major}.${minor}.${patch}`;

  return {
    service: service as ServiceTagPrefix,
    version: prerelease ? `${core}-${prerelease}` : core,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
    isPlatformTrain: service === PLATFORM_TRAIN_PREFIX,
  };
}

/** True only for a well-formed `ALL-<semver>` platform train tag. */
export function isPlatformTrainTag(tag: string): boolean {
  return parseReleaseTag(tag)?.isPlatformTrain ?? false;
}

/**
 * Identity for an UNTAGGED build: `0.0.0-<branch-slug>.<sha8>`.
 *
 * `0.0.0` sorts below every real release and reads as obviously-not-a-release
 * in the console, so a dev image can never be mistaken for a shipped version.
 * The branch slug matches the image-tag slug produced by `.build-template`
 * (`[^a-zA-Z0-9]` → `-`), so the version string and the image tag name agree.
 *
 * Never throws: a build-info reader runs on the boot path of PHI-serving
 * services, so missing git data degrades to `unknown` rather than crashing.
 */
export function formatUntaggedVersion(branch: string, commitSha: string): string {
  const slug = branch.replace(/[^a-zA-Z0-9]/g, '-') || 'unknown';
  const shortSha = commitSha.slice(0, 8).toLowerCase() || 'unknown';
  return `0.0.0-${slug}.${shortSha}`;
}
