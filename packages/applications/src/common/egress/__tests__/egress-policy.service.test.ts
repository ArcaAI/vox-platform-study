// TASK-846 D-3 — the injectable that binds the pure guard to the governed config tier.
//
// `EgressPolicyService` is deliberately thin: read `mcp.egress.allowedHosts` from the
// `global-kv` registry tier, resolve the host, delegate the VERDICT to `evaluateEgress`,
// and turn a denial into a 400 an admin can act on. What this file pins is the wiring —
// that the allow-list really comes from the control plane, that an unreadable one denies,
// and that a rejection is logged with tenant attribution but WITHOUT the full URL.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { EgressPolicyService, MCP_EGRESS_ALLOWED_HOSTS_KEY } from '../egress-policy.service';

const TENANT = 'tenant-abc';

function makeService(opts: { allowList?: unknown; resolve?: (h: string) => Promise<string[]> } = {}) {
  const appSettings = {
    getValueFromCache: vi.fn((key: string) => (key === MCP_EGRESS_ALLOWED_HOSTS_KEY ? (opts.allowList ?? null) : null)),
  };
  const resolver = vi.fn(opts.resolve ?? (async () => ['203.0.113.10']));
  const svc = new EgressPolicyService(appSettings as any);
  (svc as any).resolveHost = resolver;
  return { svc, appSettings, resolver };
}

describe('EgressPolicyService — reads the allow-list from the governed tier', () => {
  it('reads exactly `mcp.egress.allowedHosts` from AppSettings', async () => {
    const { svc, appSettings } = makeService({ allowList: ['mcp.partner.example.com'] });
    await svc.assertUrlAllowed('https://mcp.partner.example.com/mcp', { tenantId: TENANT });
    expect(appSettings.getValueFromCache).toHaveBeenCalledWith(MCP_EGRESS_ALLOWED_HOSTS_KEY);
  });

  it('allows a host on the list that resolves to a public address', async () => {
    const { svc } = makeService({ allowList: ['mcp.partner.example.com'] });
    await expect(svc.assertUrlAllowed('https://mcp.partner.example.com/mcp', { tenantId: TENANT })).resolves.toBeUndefined();
  });

  it('refuses a host that is NOT on the list', async () => {
    const { svc } = makeService({ allowList: ['mcp.partner.example.com'] });
    await expect(svc.assertUrlAllowed('https://elsewhere.example.net/mcp', { tenantId: TENANT })).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('refuses an allow-listed host that RESOLVES to a private address', async () => {
    // The headline case — a string-only check passes this.
    const { svc } = makeService({ allowList: ['mcp.partner.example.com'], resolve: async () => ['10.0.0.5'] });
    await expect(svc.assertUrlAllowed('https://mcp.partner.example.com/mcp', { tenantId: TENANT })).rejects.toThrow(/restricted range/i);
  });
});

describe('EgressPolicyService — FAIL CLOSED', () => {
  it('refuses everything when the setting is absent (control plane has no opinion)', async () => {
    const { svc } = makeService({ allowList: null });
    await expect(svc.assertUrlAllowed('https://mcp.partner.example.com/mcp', { tenantId: TENANT })).rejects.toThrow(/allow-list/i);
  });

  it('refuses everything when the stored value is malformed', async () => {
    for (const malformed of ['a-string', 42, {}, [1]]) {
      const { svc } = makeService({ allowList: malformed });
      await expect(svc.assertUrlAllowed('https://mcp.partner.example.com/mcp', { tenantId: TENANT })).rejects.toBeInstanceOf(ArgumentInvalidException);
    }
  });

  it('refuses everything when the list is empty — an empty allow-list is a real "deny all"', async () => {
    const { svc } = makeService({ allowList: [] });
    await expect(svc.assertUrlAllowed('https://mcp.partner.example.com/mcp', { tenantId: TENANT })).rejects.toThrow();
  });

  it('refuses when the AppSettings read itself throws — a control-plane outage is never an allow', async () => {
    const appSettings = {
      getValueFromCache: vi.fn(() => {
        throw new Error('cache not initialised');
      }),
    };
    const svc = new EgressPolicyService(appSettings as any);
    await expect(svc.assertUrlAllowed('https://mcp.partner.example.com/mcp', { tenantId: TENANT })).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('refuses when DNS resolution fails', async () => {
    const { svc } = makeService({
      allowList: ['mcp.partner.example.com'],
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    await expect(svc.assertUrlAllowed('https://mcp.partner.example.com/mcp', { tenantId: TENANT })).rejects.toThrow(/resolve/i);
  });
});

describe('EgressPolicyService — rejection logging is attributable but not leaky', () => {
  it('logs the tenant and the host, and NEVER the full URL', async () => {
    // A connector URL can carry a token in its query string. Abuse must be
    // attributable without the log becoming the leak.
    const { svc } = makeService({ allowList: [] });
    const logged: any[] = [];
    (svc as any).logger = { warn: (msg: string, meta: unknown) => logged.push({ msg, meta }) };

    await expect(svc.assertUrlAllowed('https://secret.example.net/mcp?token=SUPERSECRET', { tenantId: TENANT })).rejects.toThrow();

    expect(logged).toHaveLength(1);
    const serialized = JSON.stringify(logged[0]);
    expect(serialized).toContain(TENANT);
    expect(serialized).not.toContain('SUPERSECRET');
    expect(serialized).not.toContain('token=');
  });
});
