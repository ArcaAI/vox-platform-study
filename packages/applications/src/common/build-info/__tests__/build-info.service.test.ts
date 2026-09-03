/**
 * TypeScript build-info reader.
 *
 * Contract:.
 * Mirrors `test_build_info.py` on the Python side — same behavior, same shape.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BuildInfoService } from '../build-info.service';

const VALID_BUILD_INFO = {
  service: 'text',
  version: '2.1.0',
  releaseTag: 'TEXT-2.1.0',
  gitBranch: 'dev-2.1',
  gitCommitSha: '0ab258f9c1d2e3f4a5b6c7d8e9f0011223344557',
  buildAt: '2026-08-09T11:22:33Z',
  ciPipelineId: '12345',
  ciPipelineUrl: 'https://gitlab.example.com/pipelines/12345',
};

describe('BuildInfoService', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'build-info-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reads a valid baked build-info.json', () => {
    const path = join(dir, 'build-info.json');
    writeFileSync(path, JSON.stringify(VALID_BUILD_INFO));

    const service = new BuildInfoService(path);
    const info = service.getBuildInfo();

    expect(info).toMatchObject(VALID_BUILD_INFO);
  });

  it('reads the file only once and caches the result', () => {
    const path = join(dir, 'build-info.json');
    writeFileSync(path, JSON.stringify(VALID_BUILD_INFO));

    const service = new BuildInfoService(path);
    const first = service.getBuildInfo();
    // Mutate the file on disk — a cached reader must not observe this.
    writeFileSync(path, JSON.stringify({ ...VALID_BUILD_INFO, service: 'other' }));
    const second = service.getBuildInfo();

    expect(second).toBe(first);
    expect(second.service).toBe('text');
  });

  it('never throws and returns a degraded object when the file is absent', () => {
    const path = join(dir, 'does-not-exist.json');
    // No git repo in an empty tmpdir — git fallback also has nothing to find.
    const service = new BuildInfoService(path, { runGit: () => null });

    expect(() => service.getBuildInfo()).not.toThrow();
    const info = service.getBuildInfo();
    expect(info.service).toBe('unknown');
    expect(info.gitCommitSha).toBe('unknown');
    expect(info.version).toContain('0.0.0-');
    expect(info.releaseTag).toBeNull();
  });

  it('never throws and returns a degraded object on malformed JSON', () => {
    const path = join(dir, 'build-info.json');
    writeFileSync(path, '{ this is not json');

    const service = new BuildInfoService(path, { runGit: () => null });

    expect(() => service.getBuildInfo()).not.toThrow();
    expect(service.getBuildInfo().service).toBe('unknown');
  });

  it('never throws and returns a degraded object on well-formed but wrong-shape JSON', () => {
    const path = join(dir, 'build-info.json');
    writeFileSync(path, JSON.stringify({ foo: 'bar' }));

    const service = new BuildInfoService(path, { runGit: () => null });

    expect(() => service.getBuildInfo()).not.toThrow();
    expect(service.getBuildInfo().service).toBe('unknown');
  });

  it('falls back to git identity when the file is absent but git is available', () => {
    const path = join(dir, 'does-not-exist.json');
    const service = new BuildInfoService(path, {
      runGit: (args: string[]) => {
        if (args.includes('HEAD') && args.includes('rev-parse') && !args.includes('--abbrev-ref')) {
          return '0ab258f9c1d2e3f4a5b6c7d8e9f0011223344557';
        }
        if (args.includes('--abbrev-ref')) {
          return 'dev-2.1';
        }
        return null;
      },
    });

    const info = service.getBuildInfo();
    expect(info.gitBranch).toBe('dev-2.1');
    expect(info.gitCommitSha).toBe('0ab258f9c1d2e3f4a5b6c7d8e9f0011223344557');
    expect(info.version).toBe('0.0.0-dev-2-1.0ab258f9');
    expect(info.releaseTag).toBeNull();
    expect(info.service).toBe('unknown');
  });

  it('never throws even when the git shell-out itself throws', () => {
    const path = join(dir, 'does-not-exist.json');
    const service = new BuildInfoService(path, {
      runGit: () => {
        throw new Error('boom');
      },
    });

    expect(() => service.getBuildInfo()).not.toThrow();
    expect(service.getBuildInfo().gitCommitSha).toBe('unknown');
  });

  it('defaults the path to /app/build-info.json', () => {
    expect(existsSync('/app/build-info.json')).toBe(false);
    const service = new BuildInfoService(undefined, { runGit: () => null });
    expect(() => service.getBuildInfo()).not.toThrow();
  });
});
