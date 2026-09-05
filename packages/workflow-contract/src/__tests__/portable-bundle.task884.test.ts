import { describe, expect, it } from 'vitest';
import {
  PORTABLE_BUNDLE_SCHEMA_VERSION,
  buildPortableBundle,
  isPortableBundle,
  portableBundleProblems,
  type PortableBundle,
} from '../portable-bundle';

const VALID: PortableBundle<{ slug: string }> = {
  kind: 'agent',
  schemaVersion: PORTABLE_BUNDLE_SCHEMA_VERSION,
  exportedAt: '2026-09-06T10:00:00.000Z',
  source: { tenantKind: 'system', slug: 'platform-summarization', version: 3 },
  payload: { slug: 'platform-summarization' },
};

describe('TASK-884 portable bundle envelope', () => {
  it('accepts a well-formed agent bundle', () => {
    expect(portableBundleProblems(VALID)).toEqual([]);
    expect(isPortableBundle(VALID, { kind: 'agent' })).toBe(true);
  });

  it('refuses a bundle of the wrong kind rather than letting it reach the payload reader', () => {
    const problems = portableBundleProblems({ ...VALID, kind: 'workflow' }, { kind: 'agent' });
    expect(problems).toHaveLength(1);
    expect(problems[0].path).toBe('kind');
    expect(problems[0].message).toContain('accepts `agent` bundles');
  });

  it('refuses an unknown kind', () => {
    expect(portableBundleProblems({ ...VALID, kind: 'consultation' }).map((p) => p.path)).toEqual(['kind']);
  });

  it('REFUSES a newer envelope instead of importing it partially', () => {
    const problems = portableBundleProblems({ ...VALID, schemaVersion: PORTABLE_BUNDLE_SCHEMA_VERSION + 1 });
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('newer than this platform understands');
  });

  it('accepts an OLDER envelope (an export made before an envelope bump stays importable)', () => {
    expect(portableBundleProblems({ ...VALID, schemaVersion: 1 }, { maxSchemaVersion: 9 })).toEqual([]);
  });

  it('names every structural problem by path', () => {
    const problems = portableBundleProblems({ kind: 'agent', schemaVersion: 0, exportedAt: 'never', source: {}, payload: [] });
    expect(problems.map((p) => p.path).sort()).toEqual(['exportedAt', 'payload', 'schemaVersion', 'source.slug', 'source.tenantKind', 'source.version']);
  });

  it('refuses a non-object', () => {
    expect(portableBundleProblems('{}')[0].message).toContain('must be a JSON object');
    expect(portableBundleProblems(null)).toHaveLength(1);
  });

  it('builds an envelope stamped with the current version and the caller clock', () => {
    const bundle = buildPortableBundle('agent', { tenantKind: 'tenant', slug: 'clinic-notes', version: 2 }, { any: 'payload' }, new Date('2026-01-02T03:04:05Z'));
    expect(bundle.schemaVersion).toBe(PORTABLE_BUNDLE_SCHEMA_VERSION);
    expect(bundle.exportedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(portableBundleProblems(bundle, { kind: 'agent' })).toEqual([]);
  });

  it('never carries a tenant id — only a tenant KIND', () => {
    const bundle = buildPortableBundle('agent', { tenantKind: 'global', slug: 'example-tts', version: 1 }, {});
    expect(JSON.stringify(bundle)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(Object.keys(bundle.source).sort()).toEqual(['slug', 'tenantKind', 'version']);
  });
});
