import type { ChangelogItemType, CurrentService, ServiceRelease, TechnicalChangelogItem } from '../api/types';

/**
 * A build is "untagged" when the release tag is null (§3.1 rule 3). An
 * untagged version string is always shaped `0.0.0-<branch-slug>.<sha8>` —
 * never a real SemVer — so a released build and an untagged build can never
 * be mistaken for each other in the console.
 */
export function isUntagged(release: Pick<ServiceRelease, 'releaseTag'>): boolean {
  return release.releaseTag === null;
}

export function shortSha(gitCommitSha: string): string {
  return gitCommitSha.slice(0, 8);
}

/**
 * Badge label for a release. Untagged builds render `<branch> · <sha8>`
 * (never a fabricated version number, per §6) — tagged builds render the
 * real SemVer.
 */
export function releaseBadgeLabel(release: Pick<ServiceRelease, 'releaseTag' | 'gitBranch' | 'gitCommitSha' | 'version'>): string {
  if (isUntagged(release)) {
    const branch = release.gitBranch || 'unknown';
    return `${branch} · ${shortSha(release.gitCommitSha)}`;
  }
  return release.version;
}

const CHANGELOG_GROUP_ORDER: ChangelogItemType[] = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'revert', 'other'];

const CHANGELOG_GROUP_LABEL: Record<ChangelogItemType, string> = {
  feat: 'Added',
  fix: 'Fixed',
  perf: 'Performance',
  refactor: 'Internal',
  docs: 'Internal',
  test: 'Internal',
  build: 'Internal',
  ci: 'Internal',
  chore: 'Internal',
  revert: 'Internal',
  other: 'Other',
};

export interface ChangelogGroup {
  type: ChangelogItemType;
  label: string;
  items: TechnicalChangelogItem[];
}

/** Groups the technical changelog by Conventional Commit type (§3.5), in a fixed display order. */
export function groupChangelog(changelog: TechnicalChangelogItem[] | null): ChangelogGroup[] {
  if (!changelog || changelog.length === 0) return [];
  const byType = new Map<ChangelogItemType, TechnicalChangelogItem[]>();
  for (const item of changelog) {
    const bucket = byType.get(item.type) ?? [];
    bucket.push(item);
    byType.set(item.type, bucket);
  }
  return CHANGELOG_GROUP_ORDER.filter((type) => byType.has(type)).map((type) => ({
    type,
    label: CHANGELOG_GROUP_LABEL[type],
    items: byType.get(type) ?? [],
  }));
}

/**
 * Headline platform version: the newest `ALL-<ver>` train tag among the
 * currently-live services. The frozen contract (service-release.api.yaml)
 * has no dedicated "platform version" field — it is derived client-side from
 * whichever service last registered against an `ALL-` tag. Returns `null`
 * when no current service carries one (nothing to derive from).
 */
export function derivePlatformVersion(current: CurrentService[]): string | null {
  let best: CurrentService | null = null;
  for (const entry of current) {
    if (!entry.release.releaseTag?.startsWith('ALL-')) continue;
    if (!best || entry.release.buildAt > best.release.buildAt) best = entry;
  }
  return best?.release.version ?? null;
}

/**
 * "Drifted" services: those with no live instance right now (`liveness ===
 * 'stale'`). The README's stricter definition — running a version older than
 * the train's pinned digest — needs the promotion-repo digest pin, which the
 * frozen contract does not expose to the console; this is the closest signal
 * available from `CurrentServiceResponse` alone.
 */
export function driftedServices(current: CurrentService[]): CurrentService[] {
  return current.filter((entry) => entry.liveness === 'stale');
}

export function oldestBuildAt(current: CurrentService[]): string | null {
  if (current.length === 0) return null;
  return current.reduce<string>((oldest, entry) => (entry.release.buildAt < oldest ? entry.release.buildAt : oldest), current[0].release.buildAt);
}
