import 'server-only';
import { readFileSync } from 'node:fs';

/**
 * Where CI bakes the build-info contract in every HOPE image
 * (docs/operations/build-info.schema.json), including this app's own —
 * `apps/admin-console/Dockerfile`'s last layer writes it here. Only `version`
 * of that contract is ever forwarded — see `readBuildVersion` below.
 */
export const BUILD_INFO_PATH = '/app/build-info.json';

const UNKNOWN_VERSION = 'unknown';

/** Injectable seam for tests — never anything but `readFileSync` in production. */
export type FileReader = (path: string) => string;

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function isVersionShaped(value: unknown): value is { version: string } {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).version === 'string';
}

/**
 * Reads ONLY the `version` field of the baked build-info contract.
 *
 * Deliberately narrower than `BuildInfoService` in `@arcaai/applications`
 * (not a dependency of this app, and its git-fallback identity is meaningless
 * inside a container that has no `.git`): this feeds a PUBLIC, unauthenticated
 * health route (`src/proxy.ts` PUBLIC_PATHS), so `gitBranch` / `gitCommitSha` /
 * `ciPipelineId` / `ciPipelineUrl` stay out of the response — that is operator
 * detail, not something to hand an unauthenticated caller through the
 * ingress. Mirrors `apps/api`'s own `/health`, which surfaces only `version`
 * for the same reason (see `ApiHealthController`).
 *
 * NEVER throws — this runs on an unauthenticated request path, and the file
 * is ABSENT in every local-dev run (it only exists inside a built image). A
 * missing, unreadable, or malformed file degrades to `"unknown"`.
 */
export function readBuildVersion(readFile: FileReader = defaultReadFile, path: string = BUILD_INFO_PATH): string {
  try {
    const raw = readFile(path);
    const parsed: unknown = JSON.parse(raw);
    if (isVersionShaped(parsed)) return parsed.version;
  } catch {
    // Absent (local dev), unreadable, or malformed — degrade below rather
    // than fail a request that has nothing to do with this file.
  }
  return UNKNOWN_VERSION;
}

let cached: string | undefined;

/** Cached production entry point — reads the real filesystem once per process. */
export function getBuildVersion(): string {
  cached ??= readBuildVersion();
  return cached;
}
