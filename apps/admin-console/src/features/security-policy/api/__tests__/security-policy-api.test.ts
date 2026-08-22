import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSecurityPolicy, updateSecurityPolicy } from '../client';
import { securityPolicyKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

const POLICY = {
  password: {
    minLength: 12,
    maxLength: 128,
    requireUppercase: true,
    requireLowercase: true,
    requireDigit: true,
    requireSpecial: true,
    maxAgeDays: 0,
  },
  secret: { byteLength: 32, encoding: 'hex' },
  bounds: { minByteLength: 16, maxByteLength: 64, pinnedEncodings: {}, governedSurfaces: [] },
};

function installFetchMock(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return Response.json(POLICY);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('securityPolicyKeys', () => {
  it('exposes a single stable policy key', () => {
    expect(securityPolicyKeys.policy()).toEqual(securityPolicyKeys.policy());
    expect(securityPolicyKeys.policy()[0]).toBe('security-policy');
  });
});

describe('security-policy client', () => {
  it('reads and writes the policy through the BFF proxy', async () => {
    const calls = installFetchMock();
    await getSecurityPolicy();
    await updateSecurityPolicy({ secretByteLength: 48 });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/admin/security/policy', 'PUT /api/hope/admin/security/policy']);
  });

  it('sends the partial body verbatim — an unsent field must not be written', async () => {
    const calls = installFetchMock();
    await updateSecurityPolicy({ passwordRequireSpecial: false });
    expect(calls[0].body).toEqual({ passwordRequireSpecial: false });
  });
});
