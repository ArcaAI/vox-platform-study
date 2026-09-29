/**
 * The model publisher's staging directory (TASK-1019 D-3).
 *
 * Every file of a publish is streamed to local disk first — the flat layout's
 * version is derived from `SHA256SUMS` of ALL files, so the bucket prefix is
 * only known once everything is hashed — then uploaded from disk. On the
 * cluster the directory is a bounded emptyDir; locally it defaults to the OS
 * temp dir.
 *
 * `MODEL_PUBLISHER_STAGING_DIR` is a path on the worker's own filesystem — a
 * topology value, which is exactly what the env tier is for.
 */
import { mkdir, mkdtemp, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ModelPublisherError, STAGING_SPACE_INSUFFICIENT } from './model-publisher.errors';

/** Free bytes available to an unprivileged writer at `dir`. Injectable so the pre-flight is testable. */
export type FreeSpaceProbe = (dir: string) => Promise<number>;
export const MODEL_STAGING_FREE_SPACE = Symbol('MODEL_STAGING_FREE_SPACE');

export const statfsFreeSpace: FreeSpaceProbe = async (dir) => {
  const stats = await statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
};

/** The base directory each job's staging dir is created under. */
export function resolveStagingBaseDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.MODEL_PUBLISHER_STAGING_DIR?.trim();
  return configured ? configured : tmpdir();
}

/** A fresh, job-private staging directory under `baseDir`. */
export async function createStagingDir(baseDir: string = resolveStagingBaseDir()): Promise<string> {
  await mkdir(baseDir, { recursive: true });
  return mkdtemp(join(baseDir, 'model-publish-'));
}

/** Remove a job's staging directory; never throws (cleanup must not mask the job's own outcome). */
export async function removeStagingDir(dir: string | null | undefined): Promise<void> {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** Refuse, before anything is downloaded, a publish that cannot fit the staging directory. */
export async function assertStagingSpace(dir: string, requiredBytes: number, probe: FreeSpaceProbe): Promise<void> {
  const free = await probe(dir);
  if (requiredBytes > free) {
    throw new ModelPublisherError(STAGING_SPACE_INSUFFICIENT, `the model needs ${requiredBytes} bytes of staging space but only ${free} are free at '${dir}'`);
  }
}

/**
 * `stagingDir/<relativePath>`, refusing any path that would resolve outside
 * the staging directory (a source-controlled file name is not trusted to stay
 * inside it).
 */
export function stagingPathFor(stagingDir: string, relativePath: string): string {
  const target = resolve(stagingDir, relativePath);
  const rel = relative(stagingDir, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Source file path '${relativePath}' would escape the staging directory`);
  }
  return join(stagingDir, relativePath);
}
