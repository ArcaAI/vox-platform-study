/**
 * `check.ts` — the shared `--check` primitives: normalize the `Generated:` timestamp line so two
 * honest runs a second apart still compare equal, diff two strings, and compare fresh content
 * against whatever is on disk.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAgainstDisk, normalizeGeneratedTimestamp, unifiedDiff } from '../check';

describe('normalizeGeneratedTimestamp', () => {
  it('replaces the Generated: line with a fixed placeholder', () => {
    const contents = ['/**', ' * AUTO-GENERATED', ' * Generated: 2026-09-17T00:00:00.000Z', ' */', 'export type X = 1;'].join('\n');

    expect(normalizeGeneratedTimestamp(contents)).toContain(' * Generated: <normalized>');
    expect(normalizeGeneratedTimestamp(contents)).not.toContain('2026-09-17');
  });

  it('makes two runs with different timestamps compare equal after normalizing', () => {
    const a = ' * Generated: 2026-09-17T00:00:00.000Z\nexport type X = 1;';
    const b = ' * Generated: 2026-09-17T00:00:05.000Z\nexport type X = 1;';

    expect(normalizeGeneratedTimestamp(a)).toBe(normalizeGeneratedTimestamp(b));
  });

  it('leaves content with no Generated: line untouched', () => {
    const contents = 'export type X = 1;';
    expect(normalizeGeneratedTimestamp(contents)).toBe(contents);
  });
});

describe('unifiedDiff', () => {
  it('returns only common lines (prefixed) when the two strings are identical', () => {
    const diff = unifiedDiff('a\nb\nc', 'a\nb\nc');
    expect(diff).toBe('  a\n  b\n  c');
  });

  it('marks a changed line as removed-then-added', () => {
    const diff = unifiedDiff('a\nb\nc', 'a\nX\nc');
    expect(diff).toContain('- b');
    expect(diff).toContain('+ X');
    expect(diff).toContain('  a');
    expect(diff).toContain('  c');
  });

  it('marks every line as added when expected is empty', () => {
    const diff = unifiedDiff('', 'a\nb');
    expect(diff.split('\n').every((line) => line.startsWith('+') || line === '+ ')).toBe(true);
  });
});

describe('checkAgainstDisk', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vox-codegen-check-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('matches when the on-disk file is identical ignoring the Generated: timestamp', async () => {
    const path = join(dir, 'out.ts');
    await writeFile(path, 'export type X = 1;\n * Generated: 2026-09-17T00:00:00.000Z\n', 'utf8');

    const result = await checkAgainstDisk(path, 'export type X = 1;\n * Generated: 2026-09-17T00:05:00.000Z\n');

    expect(result.matches).toBe(true);
    expect(result.diff).toBeUndefined();
  });

  it('does not match, and carries a diff, when the content differs', async () => {
    const path = join(dir, 'out.ts');
    await writeFile(path, 'export type X = 1;\n', 'utf8');

    const result = await checkAgainstDisk(path, 'export type X = 2;\n');

    expect(result.matches).toBe(false);
    expect(result.diff).toBeDefined();
    expect(result.diff).toContain('X = 1');
    expect(result.diff).toContain('X = 2');
  });

  it('treats a missing file as drift, not an error', async () => {
    const path = join(dir, 'does-not-exist.ts');

    const result = await checkAgainstDisk(path, 'export type X = 1;\n');

    expect(result.matches).toBe(false);
    expect(result.diff).toContain('X = 1');
  });

  it('rethrows a non-ENOENT read failure', async () => {
    // A directory where a file is expected produces EISDIR, not ENOENT — a real failure the
    // caller should see, not a false "drift" verdict.
    await expect(checkAgainstDisk(dir, 'export type X = 1;\n')).rejects.toThrow();
  });
});
