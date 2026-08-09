import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { formatUntaggedVersion } from '@arcaai/utils';

import { BuildInfo } from './build-info.types';

/** Where CI bakes the contract in every image (TASK-648 §3.2). */
export const DEFAULT_BUILD_INFO_PATH = '/app/build-info.json';

/** Placeholder identity when neither the baked file nor git produce anything real. */
const UNKNOWN_SHA = 'unknown';
const UNKNOWN_SERVICE = 'unknown';

/** Injectable seam for tests — never anything but `git` in production. */
export type GitRunner = (args: string[]) => string | null;

export interface BuildInfoServiceOptions {
  runGit?: GitRunner;
}

function defaultRunGit(args: string[]): string | null {
  try {
    // Bounded timeout: this must never hang process boot.
    return execFileSync('git', args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .slice(0, 4096) || null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Structural check — deliberately looser than the JSON Schema (no enum/pattern checks); malformed values degrade rather than throw. */
function isBuildInfoShaped(value: unknown): value is BuildInfo {
  if (!isRecord(value)) return false;
  const requiredStrings: (keyof BuildInfo)[] = ['service', 'version', 'gitBranch', 'gitCommitSha', 'buildAt'];
  return requiredStrings.every((key) => typeof value[key] === 'string');
}

function degradedBuildInfo(runGit: GitRunner): BuildInfo {
  let gitCommitSha = UNKNOWN_SHA;
  let gitBranch = '';

  try {
    const sha = runGit(['rev-parse', 'HEAD']);
    if (sha && /^[0-9a-f]{40}$/i.test(sha)) {
      gitCommitSha = sha.toLowerCase();
    }
  } catch {
    // fall through — stays unknown
  }

  try {
    const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch) {
      gitBranch = branch;
    }
  } catch {
    // fall through — stays empty
  }

  return {
    service: UNKNOWN_SERVICE,
    version: formatUntaggedVersion(gitBranch || 'unknown', gitCommitSha),
    releaseTag: null,
    gitBranch,
    gitCommitSha,
    buildAt: new Date(0).toISOString(),
    ciPipelineId: null,
    ciPipelineUrl: null,
  };
}

/**
 * Reads `/app/build-info.json` once at process boot and caches the result.
 *
 * NEVER throws — this runs on the boot path of PHI-serving services
 * (TASK-648 §3.7). A missing, unreadable, or malformed file logs a warning
 * and degrades to a best-effort identity (git, when available; otherwise the
 * `unknown` placeholder), never an exception that could block startup.
 */
export class BuildInfoService {
  private readonly path: string;
  private readonly runGit: GitRunner;
  private cached: BuildInfo | undefined;

  constructor(path: string = DEFAULT_BUILD_INFO_PATH, options: BuildInfoServiceOptions = {}) {
    this.path = path;
    this.runGit = options.runGit ?? defaultRunGit;
  }

  getBuildInfo(): BuildInfo {
    if (this.cached) return this.cached;
    this.cached = this.readOnce();
    return this.cached;
  }

  private readOnce(): BuildInfo {
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isBuildInfoShaped(parsed)) {
        return {
          service: parsed.service,
          version: parsed.version,
          releaseTag: parsed.releaseTag ?? null,
          gitBranch: parsed.gitBranch,
          gitCommitSha: parsed.gitCommitSha,
          buildAt: parsed.buildAt,
          ciPipelineId: parsed.ciPipelineId ?? null,
          ciPipelineUrl: parsed.ciPipelineUrl ?? null,
        };
      }
      // eslint-disable-next-line no-console
      console.warn(`[build-info] ${this.path} does not match the build-info contract; falling back`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[build-info] could not read ${this.path}; falling back:`, (error as Error)?.message ?? error);
    }
    return degradedBuildInfo(this.runGit);
  }
}
