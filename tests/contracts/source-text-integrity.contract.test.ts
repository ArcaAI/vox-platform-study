import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A raw NUL byte (0x00) in a text source file trips git's binary heuristic, so
 * `git diff`/`git show` render the whole file as "Binary files differ" and the
 * change becomes invisible to review. NUL as a composite-key or hash-field
 * delimiter is a legitimate idiom here — write it as the `\0` escape so the
 * value is identical and the file stays diffable.
 */
describe('source text integrity', () => {
  it('has no raw NUL bytes in tracked text sources', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();

    const files = execFileSync(
      'git',
      ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs', '*.py', '*.json'],
      { cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
    )
      .toString('utf8')
      .split('\0')
      .filter(Boolean);

    const offenders = files.filter((file) => readFileSync(`${repoRoot}/${file}`).includes(0x00));

    expect(offenders).toEqual([]);
  });
});
