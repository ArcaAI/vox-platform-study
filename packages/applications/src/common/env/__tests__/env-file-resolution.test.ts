/**
 * (lane B) — the ONE place the env-file precedence contract is pinned.
 *
 * Contract under test (D4 / D7):
 *   host env  >  env file selected by NODE_ENV  >  schema default
 * and: NO env file is read when `CI=true` or `NODE_ENV=production`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENV_FILE_MAP, ENV_FILE_OVERRIDES_HOST_ENV, getNodeEnv, isCI, planEnvFileLoad, shouldLoadEnvFile } from '../env-file-resolution';

/** Build a throwaway "monorepo root" containing the given env files. */
function makeRoot(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hope-env-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'hope-monorepo' }));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

describe('env-file-resolution', () => {
  const roots: string[] = [];
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
    while (roots.length > 0) {
      const dir = roots.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const root = (files: Record<string, string>): string => {
    const dir = makeRoot(files);
    roots.push(dir);
    return dir;
  };

  describe('the NODE_ENV -> file map is declared exactly once', () => {
    it('maps every supported environment', () => {
      expect(ENV_FILE_MAP).toEqual({
        development: '.env.dev',
        test: '.env.test',
        production: '.env.production',
        staging: '.env.staging',
      });
    });

    it.each([
      ['development', '.env.dev'],
      ['test', '.env.test'],
      ['staging', '.env.staging'],
    ])('NODE_ENV=%s selects %s', (nodeEnv, expected) => {
      const dir = root({ [expected]: 'X=1\n' });
      const plan = planEnvFileLoad({ rootDir: dir, env: { NODE_ENV: nodeEnv } });
      expect(plan.envFilePath).toBe(path.join(dir, expected));
    });

    it('falls back to development for an unrecognised NODE_ENV', () => {
      const dir = root({ '.env.dev': 'X=1\n' });
      const plan = planEnvFileLoad({ rootDir: dir, env: { NODE_ENV: 'qa' } });
      expect(plan.nodeEnv).toBe('development');
      expect(plan.envFilePath).toBe(path.join(dir, '.env.dev'));
    });

    it('treats an unset NODE_ENV as development', () => {
      expect(getNodeEnv({})).toBe('development');
    });
  });

  describe('precedence: host env > env file (D4)', () => {
    it('never overrides host environment variables', () => {
      expect(ENV_FILE_OVERRIDES_HOST_ENV).toBe(false);
    });

    it('reports override=false for every environment', () => {
      const dir = root({ '.env.dev': 'X=1\n', '.env.test': 'X=1\n' });
      for (const nodeEnv of ['development', 'test', 'staging']) {
        expect(planEnvFileLoad({ rootDir: dir, env: { NODE_ENV: nodeEnv } }).override).toBe(false);
      }
    });
  });

  describe('no file loading in CI or production (D7)', () => {
    it.each([['true'], ['1']])('CI=%s disables file loading', (ci) => {
      const dir = root({ '.env.dev': 'X=1\n' });
      const plan = planEnvFileLoad({ rootDir: dir, env: { NODE_ENV: 'development', CI: ci } });
      expect(plan.shouldLoad).toBe(false);
      expect(plan.envFilePath).toBeNull();
      expect(plan.isCI).toBe(true);
    });

    it('NODE_ENV=production disables file loading', () => {
      const dir = root({ '.env.production': 'X=1\n' });
      const plan = planEnvFileLoad({ rootDir: dir, env: { NODE_ENV: 'production' } });
      expect(plan.shouldLoad).toBe(false);
      expect(plan.envFilePath).toBeNull();
    });

    it('exposes the same rule through shouldLoadEnvFile()/isCI()', () => {
      expect(shouldLoadEnvFile({ NODE_ENV: 'development' })).toBe(true);
      expect(shouldLoadEnvFile({ NODE_ENV: 'production' })).toBe(false);
      expect(shouldLoadEnvFile({ NODE_ENV: 'development', CI: 'true' })).toBe(false);
      expect(isCI({ CI: 'false' })).toBe(false);
      expect(isCI({})).toBe(false);
    });
  });

  describe('the root `.env` is no longer an application-config file (D6)', () => {
    it('does NOT fall back to .env when .env.dev is missing', () => {
      const dir = root({ '.env': 'X=1\n' });
      const plan = planEnvFileLoad({ rootDir: dir, env: { NODE_ENV: 'development' } });
      expect(plan.envFilePath).toBeNull();
      expect(plan.reason).toContain('.env.dev');
    });
  });

  it('honours an explicit envFilePath', () => {
    const dir = root({ '.env.custom': 'X=1\n' });
    const explicit = path.join(dir, '.env.custom');
    const plan = planEnvFileLoad({ envFilePath: explicit, env: { NODE_ENV: 'development' } });
    expect(plan.envFilePath).toBe(explicit);
  });

  it('reports a missing monorepo root instead of guessing', () => {
    const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'hope-orphan-'));
    roots.push(orphan);
    const plan = planEnvFileLoad({ rootDir: orphan, env: { NODE_ENV: 'development' } });
    expect(plan.envFilePath).toBeNull();
  });
});
