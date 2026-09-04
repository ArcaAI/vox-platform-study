/**
 * TEXT proxy — tenant BYO credential injection.
 *
 * Sibling of `text-proxy-runtime-profile.controller.test.ts`, kept separate so
 * the credential-injection contract reads as one unit.
 *
 * The contract:
 *   1. Injected when the resolver returns an entry for the RESOLVED provider.
 * this is NO LONGER gated on the provider being cloud-BYO. That
 *      predicate answers "may a TENANT OWN a row?" and was being used to answer
 *      "may the PLATFORM SERVE it?" — so a super-admin-keyed self-host engine
 *      (vLLM, openai-compat, the TEI reranker) could never reach any tenant,
 *      which is why `TEXT_OPENAI_COMPAT_API_KEY` had no migration target. The
 *      guard that actually prevents a `baseUrl` becoming a credential is that a
 *      KEYLESS row injects on neither tier, enforced in the resolver.
 *   2. Only the MATCHING provider's entry is forwarded — a tenant with both
 *      azure and bedrock credentials does not leak the unused one to TEXT.
 *   3. FAIL OPEN: a throwing resolver forwards the request WITHOUT overrides
 *      (platform/env credentials serve it) and logs a warn — while the
 *      model-IDENTITY path stays FAIL CLOSED and still rethrows.
 *   4. With no credentials the forwarded body is byte-identical to today's.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderCredentialVetoedException, QuotaExceededException } from '@arcaai/exceptions';
import { TextProxyController } from '../text-proxy.controller';

function build(
  opts: {
    overrides?: Record<string, unknown>;
    platformDefault?: { entitlementSuppressed: boolean; vetoed: string[] };
    resolverThrows?: boolean;
    selectionThrows?: boolean;
  } = {},
) {
  const http = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { content: 'ok' } }), get: vi.fn() } };
  const cls = { get: vi.fn((k: string) => (k === 'tenantId' ? 'tenant-abc' : undefined)), getId: vi.fn(() => 'req-1') };
  const config = { getConfigValue: vi.fn(() => 'http://localhost:8862') };
  const selection = {
    resolveTextSelection: vi.fn(async () => {
      if (opts.selectionThrows) throw new Error('no default model configured');
      return { provider: 'azure', model: 'gpt-4o-mini' };
    }),
  };
  const connections = {
    resolveTenantCloudOverrides: vi.fn(async () => {
      if (opts.resolverThrows) throw new Error('vault unreachable');
      // The resolver returns the two-tier result, not a bare map.
      return { overrides: opts.overrides ?? {}, ...(opts.platformDefault ? { platformDefault: opts.platformDefault } : {}) };
    }),
  };

  const ctrl = new TextProxyController(
    http as any,
    { fetchByCodeName: vi.fn() } as any,
    cls as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { findById: vi.fn() } as any,
    { getObject: vi.fn() } as any,
    config as any,
    undefined, // secretsService (@Optional)
    selection as any, // HarnessPolicyService
    undefined, // aiModelService (@Optional)
    undefined, // aiTaskDefaultService (@Optional)
    connections as any, // aiProviderConnectionService (@Optional)
  );

  return { ctrl, http, selection, connections };
}

const forwardedBody = (http: ReturnType<typeof build>['http']) => http.axiosRef.post.mock.calls[0][1] as Record<string, unknown>;

beforeEach(() => vi.clearAllMocks());

describe('TEXT proxy — tenant BYO credential injection', () => {
  it('folds the tenant azure credential into the forwarded body', async () => {
    const { ctrl, http } = build({
      overrides: {
        azure: {
          api_key: 'tenant-secret',
          base_url: 'https://acme.openai.azure.com',
          api_version: '2024-10-21',
          deployment_name: 'gpt-4o-mini',
        },
      },
    });

    await ctrl.generate({ prompt: 'p', stream: false } as any);

    expect(forwardedBody(http).provider_overrides).toEqual({
      azure: {
        api_key: 'tenant-secret',
        base_url: 'https://acme.openai.azure.com',
        api_version: '2024-10-21',
        deployment_name: 'gpt-4o-mini',
      },
    });
  });

  it('forwards ONLY the resolved provider entry, never the unused one', async () => {
    const { ctrl, http } = build({
      overrides: {
        azure: { api_key: 'azure-secret' },
        bedrock: { api_key: 'bedrock-secret', region: 'us-east-1' },
      },
    });

    await ctrl.generate({ prompt: 'p', stream: false } as any);

    const overrides = forwardedBody(http).provider_overrides as Record<string, unknown>;
    expect(Object.keys(overrides)).toEqual(['azure']);
    expect(JSON.stringify(forwardedBody(http))).not.toContain('bedrock-secret');
  });

  it('CONSULTS the resolver for a self-host provider, and injects a keyed platform row', async () => {
    // inverted, not deleted. This previously asserted the resolver
    // was SKIPPED for a self-host provider; that short-circuit is the defect
    // that made a keyed SYSTEM row for vLLM/openai-compat undeliverable.
    const { ctrl, http, connections } = build({ overrides: { ollama: { api_key: 'not-needed', funding: 'platform' } } });

    await ctrl.generate({ prompt: 'p', provider: 'ollama', model: 'gemma-4', stream: false } as any);

    expect(connections.resolveTenantCloudOverrides).toHaveBeenCalled();
    expect(forwardedBody(http)).toHaveProperty('provider_overrides');
    expect((forwardedBody(http) as any).provider_overrides).toHaveProperty('ollama');
  });

  it('omits provider_overrides for a self-host provider with NO resolving row', async () => {
    // The keyless/absent case still yields nothing to inject — that, not the
    // provider list, is what stops a `baseUrl` being mistaken for a credential.
    const { ctrl, http, connections } = build({ overrides: {} });

    await ctrl.generate({ prompt: 'p', provider: 'ollama', model: 'gemma-4', stream: false } as any);

    expect(connections.resolveTenantCloudOverrides).toHaveBeenCalled();
    expect(forwardedBody(http)).not.toHaveProperty('provider_overrides');
  });

  it('omits provider_overrides when the tenant has no credential (byte-identical body)', async () => {
    const { ctrl, http } = build({ overrides: {} });

    await ctrl.generate({ prompt: 'p', stream: false } as any);

    expect(forwardedBody(http)).not.toHaveProperty('provider_overrides');
  });

  it('FAILS OPEN when the resolver throws — the request still goes out', async () => {
    const { ctrl, http } = build({ resolverThrows: true });

    await expect(ctrl.generate({ prompt: 'p', stream: false } as any)).resolves.toBeDefined();

    expect(http.axiosRef.post).toHaveBeenCalledTimes(1);
    expect(forwardedBody(http)).not.toHaveProperty('provider_overrides');
  });

  // A SUPPRESSED platform tier is REPORTED, not degraded into TEXT's
  // generic missing-credential 503. Both errors are raised before dispatch, so
  // no vendor request and no usage event is produced.
  it('raises the 409 veto instead of dispatching, when the tenant disabled this provider', async () => {
    const { ctrl, http } = build({ overrides: {}, platformDefault: { entitlementSuppressed: false, vetoed: ['azure'] } });

    await expect(ctrl.generate({ prompt: 'p', stream: false } as any)).rejects.toBeInstanceOf(ProviderCredentialVetoedException);
    expect(http.axiosRef.post).not.toHaveBeenCalled();
  });

  it('raises the 403 entitlement denial instead of dispatching, when the tenant holds no grant', async () => {
    const { ctrl, http } = build({ overrides: {}, platformDefault: { entitlementSuppressed: true, vetoed: [] } });

    await expect(ctrl.generate({ prompt: 'p', stream: false } as any)).rejects.toBeInstanceOf(QuotaExceededException);
    expect(http.axiosRef.post).not.toHaveBeenCalled();
  });

  it('does NOT convert an unconfigured provider into a policy error — that stays the downstream 503', async () => {
    // Nothing suppressed: the body is byte-identical to today's and TEXT decides.
    const { ctrl, http } = build({ overrides: {} });
    await expect(ctrl.generate({ prompt: 'p', stream: false } as any)).resolves.toBeDefined();
    expect(forwardedBody(http)).not.toHaveProperty('provider_overrides');
  });

  it('keeps model SELECTION fail-closed — a selection error still rethrows', async () => {
    const { ctrl, http } = build({ selectionThrows: true });

    await expect(ctrl.generate({ prompt: 'p', stream: false } as any)).rejects.toThrow();
    expect(http.axiosRef.post).not.toHaveBeenCalled();
  });
});
