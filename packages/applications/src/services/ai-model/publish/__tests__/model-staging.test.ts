/**
 * TASK-1019 I8 — the staging pre-flight measures the POD's budget, not the
 * node's disk. On the cluster the staging dir is an emptyDir with a
 * `sizeLimit`; `statfs` reports the node's free space, so a publish that fits
 * the node but not the emptyDir used to pass the pre-flight and then get the
 * pod evicted mid-download. `MODEL_PUBLISHER_STAGING_MAX_BYTES` (the
 * emptyDir's size) bounds it: free = min(statfs free, budget − bytes already
 * under the staging base). Staging dirs survive a container restart inside
 * the pod, so the worker sweeps stale ones at start.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStagingFreeSpaceProbe, resolveStagingMaxBytes, sweepStaleStagingDirs } from '../model-staging';

describe('model staging budget (I8)', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'staging-budget-test-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  describe('resolveStagingMaxBytes', () => {
    it('unset or blank ⇒ no budget', () => {
      expect(resolveStagingMaxBytes({})).toBeNull();
      expect(resolveStagingMaxBytes({ MODEL_PUBLISHER_STAGING_MAX_BYTES: '  ' })).toBeNull();
    });

    it('reads a whole number of bytes', () => {
      expect(resolveStagingMaxBytes({ MODEL_PUBLISHER_STAGING_MAX_BYTES: '53687091200' })).toBe(53_687_091_200);
    });

    it('refuses a malformed value loudly (a deploy typo must not silently disable the budget)', () => {
      expect(() => resolveStagingMaxBytes({ MODEL_PUBLISHER_STAGING_MAX_BYTES: '50Gi' })).toThrow(/MODEL_PUBLISHER_STAGING_MAX_BYTES/);
      expect(() => resolveStagingMaxBytes({ MODEL_PUBLISHER_STAGING_MAX_BYTES: '0' })).toThrow(/MODEL_PUBLISHER_STAGING_MAX_BYTES/);
    });
  });

  describe('createStagingFreeSpaceProbe', () => {
    it('with no budget, is the filesystem probe alone', async () => {
      const probe = createStagingFreeSpaceProbe({ baseDir: base, budgetBytes: null, fsProbe: async () => 1_000 });
      expect(await probe(join(base, 'model-publish-x'))).toBe(1_000);
    });

    it('is min(node free, budget − bytes already under the staging base)', async () => {
      await mkdir(join(base, 'model-publish-a', 'nested'), { recursive: true });
      await writeFile(join(base, 'model-publish-a', 'nested', 'w.bin'), Buffer.alloc(300));
      await writeFile(join(base, 'loose.bin'), Buffer.alloc(100));

      const roomy = createStagingFreeSpaceProbe({ baseDir: base, budgetBytes: 1_000, fsProbe: async () => 10_000_000 });
      expect(await roomy(base)).toBe(600);

      const tightNode = createStagingFreeSpaceProbe({ baseDir: base, budgetBytes: 1_000, fsProbe: async () => 50 });
      expect(await tightNode(base)).toBe(50);
    });

    it('never reports negative space when the base is already over budget', async () => {
      await writeFile(join(base, 'big.bin'), Buffer.alloc(2_000));
      const probe = createStagingFreeSpaceProbe({ baseDir: base, budgetBytes: 1_000, fsProbe: async () => 10_000_000 });
      expect(await probe(base)).toBe(0);
    });
  });

  describe('sweepStaleStagingDirs', () => {
    it('removes model-publish-* dirs older than the cutoff, and nothing else', async () => {
      const cutoff = Date.now();
      const old = join(base, 'model-publish-old');
      const fresh = join(base, 'model-publish-fresh');
      const other = join(base, 'not-ours');
      for (const dir of [old, fresh, other]) {
        await mkdir(dir);
        await writeFile(join(dir, 'f'), 'x');
      }
      const past = new Date(cutoff - 60_000);
      await utimes(old, past, past);
      await utimes(other, past, past);
      const future = new Date(cutoff + 60_000);
      await utimes(fresh, future, future);

      const removed = await sweepStaleStagingDirs(base, cutoff);

      expect(removed).toEqual([old]);
      expect((await readdir(base)).sort()).toEqual(['model-publish-fresh', 'not-ours']);
    });

    it('a missing base dir is not an error', async () => {
      await expect(sweepStaleStagingDirs(join(base, 'absent'), Date.now())).resolves.toEqual([]);
    });
  });
});
