import { describe, expect, it } from 'vitest';
import { getBuildVersion, readBuildVersion } from '../build-info';

describe('readBuildVersion', () => {
  it('returns the version field from a well-formed build-info.json', () => {
    const version = readBuildVersion(() =>
      JSON.stringify({
        service: 'admin-console',
        version: '2.4.0',
        releaseTag: 'ADMIN-2.4.0',
        gitBranch: 'dev-2.2',
        gitCommitSha: 'a'.repeat(40),
        buildAt: '2026-09-18T00:00:00Z',
        ciPipelineId: '12345',
        ciPipelineUrl: 'https://gitlab.example.com/pipelines/12345',
      }),
    );
    expect(version).toBe('2.4.0');
  });

  it('degrades to "unknown" when the file cannot be read (local dev — no image, no file)', () => {
    const version = readBuildVersion(() => {
      throw new Error('ENOENT: no such file or directory');
    });
    expect(version).toBe('unknown');
  });

  it('degrades to "unknown" on malformed JSON rather than throwing', () => {
    const version = readBuildVersion(() => '{not valid json');
    expect(version).toBe('unknown');
  });

  it('degrades to "unknown" when the parsed value has no string version field', () => {
    const version = readBuildVersion(() => JSON.stringify({ service: 'admin-console' }));
    expect(version).toBe('unknown');
  });

  it('degrades to "unknown" when the file parses to a non-object', () => {
    const version = readBuildVersion(() => JSON.stringify('2.4.0'));
    expect(version).toBe('unknown');
  });
});

describe('getBuildVersion', () => {
  it('reads the real filesystem without throwing when /app/build-info.json is absent (local dev)', () => {
    expect(() => getBuildVersion()).not.toThrow();
    expect(typeof getBuildVersion()).toBe('string');
  });
});
