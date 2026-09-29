/**
 * The model publisher's staging directory (TASK-1019 D-3).
 *
 * Every file of a publish is streamed to local disk first — the flat layout's
 * version is derived from `SHA256SUMS` of ALL files, so the bucket prefix is
 * only known once everything is hashed — then uploaded from disk. On the
 * cluster the directory is a bounded emptyDir; locally it defaults to the OS
 * temp dir.
 *
 * `MODEL_PUBLISHER_STAGING_DIR` is a path on the worker's own filesystem, and
 * `MODEL_PUBLISHER_STAGING_MAX_BYTES` the size of the volume behind it — both
 * topology values, which is exactly what the env tier is for.
 */
import { lstat, mkdir, mkdtemp, readdir, rm, statfs } from 'node:fs/promises';
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

/** Every job's staging dir is `<base>/model-publish-<random>`. */
const STAGING_DIR_PREFIX = 'model-publish-';

/** A fresh, job-private staging directory under `baseDir`. */
export async function createStagingDir(baseDir: string = resolveStagingBaseDir()): Promise<string> {
  await mkdir(baseDir, { recursive: true });
  return mkdtemp(join(baseDir, STAGING_DIR_PREFIX));
}

/**
 * `MODEL_PUBLISHER_STAGING_MAX_BYTES` — the staging volume's size (on the
 * cluster the emptyDir `sizeLimit`, set by the Deployment). `null` when unset.
 * A malformed value throws: a deploy typo must not silently remove the budget.
 */
export function resolveStagingMaxBytes(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.MODEL_PUBLISHER_STAGING_MAX_BYTES?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`MODEL_PUBLISHER_STAGING_MAX_BYTES must be a positive whole number of bytes, got '${raw}'`);
  }
  return Number(raw);
}

/** Bytes of every regular file under `dir`, recursively (symlinks are not followed). `0` when absent. */
export async function directorySize(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else if (entry.isFile()) total += (await lstat(path)).size;
  }
  return total;
}

/**
 * The pre-flight's free-space probe (I8). `statfs` measures the NODE's disk;
 * on the cluster the staging dir is an emptyDir whose `sizeLimit` is smaller,
 * so with a budget the answer is min(filesystem free, budget − bytes already
 * under the staging base), never below zero.
 */
export function createStagingFreeSpaceProbe(opts: { baseDir: string; budgetBytes: number | null; fsProbe?: FreeSpaceProbe }): FreeSpaceProbe {
  const fsProbe = opts.fsProbe ?? statfsFreeSpace;
  if (opts.budgetBytes === null) return fsProbe;
  const budget = opts.budgetBytes;
  return async (dir) => {
    const [free, used] = await Promise.all([fsProbe(dir), directorySize(opts.baseDir)]);
    return Math.max(0, Math.min(free, budget - used));
  };
}

/**
 * Remove `model-publish-*` dirs under `baseDir` last modified before
 * `olderThanMs` — the leftovers of a container that died mid-job (an emptyDir
 * outlives a container restart). Dirs this process creates are newer than its
 * start, so a sweep keyed on the start time never races a running job.
 */
export async function sweepStaleStagingDirs(baseDir: string, olderThanMs: number): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(STAGING_DIR_PREFIX)) continue;
    const path = join(baseDir, entry.name);
    const { mtimeMs } = await lstat(path);
    if (mtimeMs >= olderThanMs) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
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
