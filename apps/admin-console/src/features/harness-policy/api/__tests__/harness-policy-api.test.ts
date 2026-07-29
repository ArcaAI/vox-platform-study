/**
 * TDD client tests for the harness policy & live config API module (frame 36):
 * exact proxied URLs, the If-Match OCC round-trip on the policy PATCHes
 * (including the first-edit placeholder validator when no row exists yet) and
 * the plain, non-OCC live-config kill-switch PATCH.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getGlobalHarnessPolicy,
  getHarnessPolicy,
  getLiveDocConfig,
  updateGlobalHarnessPolicy,
  updateHarnessPolicy,
  updateLiveDocConfig,
} from '../client';
import { harnessPolicyKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function installFetchMock(response: () => Response = () => Response.json({ ok: true })): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return response();
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('harnessPolicyKeys', () => {
  it('is stable and separates the tenant policy, global default and live config', () => {
    expect(harnessPolicyKeys.policy()).toEqual(harnessPolicyKeys.policy());
    expect(harnessPolicyKeys.policy()).not.toEqual(harnessPolicyKeys.globalPolicy());
    expect(harnessPolicyKeys.policy()).not.toEqual(harnessPolicyKeys.liveConfig());
    expect(harnessPolicyKeys.globalPolicy()[0]).toBe('harness-policy');
    expect(harnessPolicyKeys.liveConfig()[0]).toBe('harness-policy');
  });
});

describe('harness policy client', () => {
  it('reads the tenant policy and the global default, keeping the ETag', async () => {
    const calls = installFetchMock(() => Response.json({ version: 7 }, { headers: { etag: '"7"' } }));
    const policy = await getHarnessPolicy();
    const globalDefault = await getGlobalHarnessPolicy();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/harness/policy',
      'GET /api/hope/admin/harness/policy/global',
    ]);
    expect(policy.etag).toBe('"7"');
    expect(globalDefault.etag).toBe('"7"');
  });

  it('PATCHes the tenant policy with If-Match and expectedVersion from the read ETag', async () => {
    const calls = installFetchMock();
    await updateHarnessPolicy({ maxRegen: 3, reason: 'raise regen budget' }, '"7"');
    expect(calls).toHaveLength(1);
    expect(`${calls[0].method} ${calls[0].url}`).toBe('PATCH /api/hope/admin/harness/policy');
    expect(calls[0].headers.get('if-match')).toBe('"7"');
    expect(calls[0].body).toEqual({ maxRegen: 3, reason: 'raise regen budget', expectedVersion: 7 });
  });

  it('sends the placeholder validator "1" (no expectedVersion) on a first edit without a row', async () => {
    const calls = installFetchMock();
    await updateHarnessPolicy({ safetyEnabled: false }, null);
    expect(calls[0].headers.get('if-match')).toBe('"1"');
    expect(calls[0].body).toEqual({ safetyEnabled: false });
  });

  it('PATCHes the global default on its own route with the same OCC contract', async () => {
    const calls = installFetchMock();
    await updateGlobalHarnessPolicy({ gateSlaSeconds: 43200 }, '"3"');
    expect(`${calls[0].method} ${calls[0].url}`).toBe('PATCH /api/hope/admin/harness/policy/global');
    expect(calls[0].headers.get('if-match')).toBe('"3"');
    expect(calls[0].body).toEqual({ gateSlaSeconds: 43200, expectedVersion: 3 });
  });

  it('reads and toggles the live-doc engine kill-switch without If-Match (not versioned)', async () => {
    const calls = installFetchMock();
    await getLiveDocConfig();
    await updateLiveDocConfig({ enabled: false, reason: 'incident drain' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/harness/live/config',
      'PATCH /api/hope/admin/harness/live/config',
    ]);
    expect(calls[1].headers.get('if-match')).toBeNull();
    expect(calls[1].body).toEqual({ enabled: false, reason: 'incident drain' });
  });
});
