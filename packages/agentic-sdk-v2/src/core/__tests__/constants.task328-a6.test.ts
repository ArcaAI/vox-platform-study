/**
 * @arcaai/vox - TASK-328 A6 endpoint constants
 *
 * Guards the SDK endpoint paths for the A6 audio-pipeline-config slice:
 *   • PIPELINE_ENDPOINTS additions: SET_DEFAULT / TOGGLE / VERSIONS / VERSION
 *   • TENANT_FRONTEND_CONFIG_ENDPOINTS: GET / UPSERT
 * Paths must match the backend controllers exactly.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { PIPELINE_ENDPOINTS, TENANT_FRONTEND_CONFIG_ENDPOINTS } from '../constants';

describe('TASK-328 A6 — PIPELINE_ENDPOINTS additions', () => {
  it('SET_DEFAULT targets /admin/audio/pipelines/:id/set-default', () => {
    expect(PIPELINE_ENDPOINTS.SET_DEFAULT('p-1')).toBe('/admin/audio/pipelines/p-1/set-default');
  });

  it('TOGGLE targets /admin/audio/pipelines/:id/toggle', () => {
    expect(PIPELINE_ENDPOINTS.TOGGLE('p-1')).toBe('/admin/audio/pipelines/p-1/toggle');
  });

  it('VERSIONS targets /admin/audio/pipelines/:id/versions', () => {
    expect(PIPELINE_ENDPOINTS.VERSIONS('p-1')).toBe('/admin/audio/pipelines/p-1/versions');
  });

  it('VERSION targets /admin/audio/pipelines/:id/versions/:n', () => {
    expect(PIPELINE_ENDPOINTS.VERSION('p-1', 3)).toBe('/admin/audio/pipelines/p-1/versions/3');
  });

  it('encodes ids and keeps every path under /admin/audio/pipelines', () => {
    expect(PIPELINE_ENDPOINTS.SET_DEFAULT('a/b')).toBe('/admin/audio/pipelines/a%2Fb/set-default');
    [
      PIPELINE_ENDPOINTS.SET_DEFAULT('x'),
      PIPELINE_ENDPOINTS.TOGGLE('x'),
      PIPELINE_ENDPOINTS.VERSIONS('x'),
      PIPELINE_ENDPOINTS.VERSION('x', 1),
    ].forEach((p) => expect(p).toMatch(/^\/admin\/audio\/pipelines\//));
  });
});

describe('TASK-328 A6 — TENANT_FRONTEND_CONFIG_ENDPOINTS', () => {
  it('GET and UPSERT share the /admin/tenant-frontend-config path', () => {
    expect(TENANT_FRONTEND_CONFIG_ENDPOINTS.GET).toBe('/admin/tenant-frontend-config');
    expect(TENANT_FRONTEND_CONFIG_ENDPOINTS.UPSERT).toBe('/admin/tenant-frontend-config');
  });

  it('has exactly the expected keys', () => {
    expect(Object.keys(TENANT_FRONTEND_CONFIG_ENDPOINTS).sort()).toEqual(['GET', 'UPSERT']);
  });
});
