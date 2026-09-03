/**
 * npm publish policy.
 *
 * Owner decision, 2026-08-13: every `@arcaai/*` package publishes PRIVATE, to
 * GitHub Packages, under the `ArcaAI` org.
 *
 * These are the three ways that decision gets silently violated:
 *
 *   P-1 `publishConfig.access: "public"`. Every package carried it before this
 *        ticket. A public publish cannot be un-published — npm unpublish is
 *        time-boxed and GitHub Packages is stricter still. This is the only
 *        assertion here that guards an IRREVERSIBLE mistake.
 *
 *   P-2 `repository.url` drift. GitHub Packages binds a package to a repo, and
 *        `GITHUB_TOKEN` from repo X cannot publish a package bound to repo Y —
 *        it 403s at the LAST step of a release, after the version bumps, the
 *        tags and the merged Version PR. docs/operations/vox-sdk-release
 *        records this value having been wrong twice in one release cycle.
 *
 *   Lockstep. The vox family ships as a set — `@arcaai/vox` cannot resolve
 *        against a `@arcaai/room` that was not bumped with it. The manual
 *        runbook's for-loop is what kept these aligned; nothing enforced it.
 *
 * Registry auth, package visibility settings, and org membership are NOT
 * assertable from the repo. They are lane D's runtime checks (the
 * consume-from-clean smoke test,
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');

/** The org is settled (owner, 2026-08-13). The repo NAME is Q1 — deliberately unpinned. */
const EXPECTED_REPOSITORY_URL = /^git\+https:\/\/github\.com\/ArcaAI\/[A-Za-z0-9._-]+\.git$/;

const GITHUB_PACKAGES_REGISTRY = 'https://npm.pkg.github.com';

/**
 * The vox family versions in lockstep, mirroring the `linked` group that
 * Changesets will own
 *
 * `@arcaai/pipeline` is deliberately EXCLUDED: it is not a `vox` dependency and
 * the release runbook publishes it separately, which is why it legitimately
 * trails at a different version.
 */
const VOX_LOCKSTEP_FAMILY = [
  '@arcaai/vox',
  '@arcaai/vox-node',
  '@arcaai/room',
  '@arcaai/stt',
  '@arcaai/vad',
  '@arcaai/noise-filter',
  '@arcaai/med-ner',
];

interface PackageManifest {
  path: string;
  name: string;
  version?: string;
  private?: boolean;
  publishConfig?: { access?: string; registry?: string };
  repository?: { url?: string } | string;
}

function discoverPackages(): PackageManifest[] {
  const found: PackageManifest[] = [];

  for (const workspace of ['packages', 'apps']) {
    const root = resolve(REPO_ROOT, workspace);
    if (!existsSync(root)) continue;

    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const manifestPath = join(root, dir.name, 'package.json');
      if (!existsSync(manifestPath)) continue;

      found.push({
        ...(JSON.parse(readFileSync(manifestPath, 'utf-8')) as Omit<PackageManifest, 'path'>),
        path: `${workspace}/${dir.name}/package.json`,
      });
    }
  }

  return found;
}

const allPackages = discoverPackages();

/** Anything that actually reaches a registry: has publishConfig and is not private. */
const publishable = allPackages.filter((p) => p.publishConfig && p.private !== true);

describe('npm publish policy — P-1: nothing publishes public', () => {
  it('discovers the workspace packages (guards against a broken walk)', () => {
    expect(allPackages.length).toBeGreaterThan(20);
    expect(publishable.length).toBeGreaterThan(0);
  });

  it('NO package.json anywhere declares publishConfig.access "public"', () => {
    // Deliberately spans EVERY package, not just the publishable ones. A
    // `private: true` package carrying `access: "public"` is a contradiction
    // waiting for someone to flip `private` — which is exactly the state
    // @arcaai/config-ts was in before.
    const offenders = allPackages.filter((p) => p.publishConfig?.access === 'public').map((p) => p.path);
    expect(offenders, `these would publish PUBLIC under a private-only policy: ${offenders.join(', ')}`).toEqual([]);
  });

  it('every package declaring publishConfig.access sets it to "restricted"', () => {
    for (const pkg of allPackages.filter((p) => p.publishConfig?.access !== undefined)) {
      expect(pkg.publishConfig!.access, `${pkg.path}`).toBe('restricted');
    }
  });
});

describe('npm publish policy — registry target', () => {
  it('every publishable package targets GitHub Packages', () => {
    for (const pkg of publishable) {
      expect(pkg.publishConfig!.registry, `${pkg.path} (${pkg.name})`).toBe(GITHUB_PACKAGES_REGISTRY);
    }
  });

  it('every publishable package is @arcaai-scoped', () => {
    // GitHub Packages resolves publish permission by scope ↔ org owner.
    for (const pkg of publishable) {
      expect(pkg.name, `${pkg.path}`).toMatch(/^@arcaai\//);
    }
  });
});

describe('npm publish policy — P-2: repository binding', () => {
  it('every publishable package declares a repository.url under the ArcaAI org', () => {
    for (const pkg of publishable) {
      const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
      expect(url, `${pkg.path} has no repository.url — GitHub Packages cannot bind it`).toBeDefined();
      expect(url, `${pkg.path}: repository.url is not an ArcaAI GitHub URL`).toMatch(EXPECTED_REPOSITORY_URL);
    }
  });

  it('all publishable packages agree on ONE repository.url', () => {
    // The failure this catches is a partial edit: some packages moved to the
    // new repo, some not. Half the family then 403s on publish.
    const urls = new Set(
      publishable.map((p) => (typeof p.repository === 'string' ? p.repository : p.repository?.url)),
    );
    expect([...urls], `packages disagree on the target repo: ${[...urls].join(' vs ')}`).toHaveLength(1);
  });
});

describe('npm publish policy — vox family lockstep', () => {
  it('every lockstep member exists in the workspace', () => {
    const names = new Set(allPackages.map((p) => p.name));
    for (const member of VOX_LOCKSTEP_FAMILY) {
      expect(names, `${member} is in the lockstep list but not in the workspace`).toContain(member);
    }
  });

  it('all vox family packages share one version', () => {
    const byVersion = new Map<string, string[]>();
    for (const pkg of allPackages.filter((p) => VOX_LOCKSTEP_FAMILY.includes(p.name))) {
      const bucket = byVersion.get(pkg.version!) ?? [];
      bucket.push(pkg.name);
      byVersion.set(pkg.version!, bucket);
    }

    const summary = [...byVersion.entries()].map(([v, names]) => `${v}: ${names.join(', ')}`).join(' | ');
    expect([...byVersion.keys()], `vox family versions have drifted — ${summary}`).toHaveLength(1);
  });
});
