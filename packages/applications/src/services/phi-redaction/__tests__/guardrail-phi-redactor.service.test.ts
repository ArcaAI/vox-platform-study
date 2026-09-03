/**
 * GuardrailPhiRedactor — the IPhiRedactor implementation over the guardrail
 * POST /api/guardrail/redact endpoint.
 *
 * Mirrors GuardrailGroundednessTool's test shape (mock HttpService.axiosRef,
 * assert request wire shape + token header) plus IPhiRedactor's own contract:
 * throw (never fall back to raw text) on any transport error or malformed body.
 */

import { describe, expect, it, vi } from 'vitest';
import { GuardrailPhiRedactor } from '../guardrail-phi-redactor.service';

function makeService(opts?: {
  post?: ReturnType<typeof vi.fn>;
  useDefaultUrl?: boolean;
  secretsService?: { getSecretOptional: ReturnType<typeof vi.fn> };
  timeoutSetting?: number;
  /** the CLS tenant this hop must put on the wire. */
  clsTenantId?: string | null;
}) {
  const post = opts?.post ?? vi.fn().mockResolvedValue({ data: { sanitized_text: '[PERSON_1] has a cough.' } });
  const httpService = { axiosRef: { post } } as never;
  const configService = {
    get: vi.fn((key: string) => (key === 'GUARDRAIL_URL' && !opts?.useDefaultUrl ? 'http://guardrail.test:8863' : undefined)),
  } as never;
  const secretsService = opts?.secretsService ?? { getSecretOptional: vi.fn().mockResolvedValue('svc-token-abc') };
  const appSettingsService =
    opts?.timeoutSetting === undefined ? undefined : ({ getValueWithDefault: vi.fn().mockReturnValue(opts.timeoutSetting) } as never);
  // `clsTenantId: undefined` ⇒ no ClsService at all (the earlier fixture
  // arity), which must still produce a DECLARED marker rather than no header.
  const clsService =
    opts?.clsTenantId === undefined ? undefined : ({ get: vi.fn((key: string) => (key === 'tenantId' ? opts.clsTenantId : null)) } as never);
  const service = new GuardrailPhiRedactor(httpService, configService, secretsService as never, appSettingsService, clsService);
  return { service, post, secretsService, appSettingsService };
}

describe('GuardrailPhiRedactor', () => {
  it('posts {text, mode} to /api/guardrail/redact with the resolved URL and X-Service-Token header', async () => {
    const { service, post, secretsService } = makeService();

    const result = await service.redact('John Smith has a cough.', 'pseudonymize');

    expect(result).toBe('[PERSON_1] has a cough.');
    // D-D: the ONE shared `INTERNAL_ACCESS_TOKEN` is asked for FIRST;
    // `GUARDRAIL_SERVICE_TOKEN` is only the migration fallback, so with a shared
    // token configured it is never consulted.
    expect(secretsService.getSecretOptional).toHaveBeenCalledWith('INTERNAL_ACCESS_TOKEN');
    expect(post).toHaveBeenCalledWith(
      'http://guardrail.test:8863/api/guardrail/redact',
      { text: 'John Smith has a cough.', mode: 'pseudonymize' },
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Service-Token': 'svc-token-abc' }),
      }),
    );
  });

  it('sends mode="full" verbatim (the exemplar-bank / DNA-corpus posture)', async () => {
    const { service, post } = makeService();

    await service.redact('some corpus text', 'full');

    expect(post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ mode: 'full' }), expect.anything());
  });

  // ── Request timeout: admin-managed, generous by default ──
  //
  // Guardrail chunks long inputs and walks the chunks sequentially, so a full
  // DNA corpus is roughly linear rather than super-linear work — but it is still
  // real work, and the original fixed 30s budget could not cover it. The value
  // is a `global-kv` registry key so an operator can retune it per environment.

  it('uses the admin-managed timeout from the settings registry when one is set', async () => {
    const { service, post, appSettingsService } = makeService({ timeoutSetting: 45_000 });

    await service.redact('corpus', 'full');

    expect(appSettingsService!.getValueWithDefault).toHaveBeenCalledWith('phiRedaction.requestTimeoutMs', 120_000);
    expect(post).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.objectContaining({ timeout: 45_000 }));
  });

  it('falls back to the 120s code default when no settings service is wired', async () => {
    const { service, post } = makeService();

    await service.redact('corpus', 'full');

    expect(post).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.objectContaining({ timeout: 120_000 }));
  });

  it('falls back to the default guardrail URL when GUARDRAIL_URL is unset', async () => {
    const { service, post } = makeService({ useDefaultUrl: true });

    await service.redact('text', 'full');

    expect(post).toHaveBeenCalledWith('http://localhost:8863/api/guardrail/redact', expect.anything(), expect.anything());
  });

  it('sends an empty token when no SecretsService is wired', async () => {
    const post = vi.fn().mockResolvedValue({ data: { sanitized_text: 'x' } });
    const httpService = { axiosRef: { post } } as never;
    const configService = { get: vi.fn().mockReturnValue(undefined) } as never;
    const service = new GuardrailPhiRedactor(httpService, configService, undefined);

    await service.redact('text', 'full');

    expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Service-Token': '' }) }),
    );
  });

  // this hop carried NO tenant at all, so guardrail resolved SYSTEM.
  // Because tenants may only TIGHTEN relative to SYSTEM, that silently redacted a
  // stricter tenant's PHI at the platform FLOOR with nothing logged anywhere.
  describe('X-Tenant-Id ', () => {
    it('sends the CLS tenant on the redact hop', async () => {
      const { service, post } = makeService({ clsTenantId: 'tenant-alpha' });

      await service.redact('John Smith has a cough.', 'pseudonymize');

      expect(post).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        expect.objectContaining({ headers: expect.objectContaining({ 'X-Tenant-Id': 'tenant-alpha' }) }),
      );
    });

    it('DECLARES tenant-less rather than omitting the header when CLS has no tenant', async () => {
      const { service, post } = makeService({ clsTenantId: null });

      await service.redact('text', 'full');

      const headers = post.mock.calls[0][2].headers as Record<string, string>;
      // The distinction this ticket exists for: a declared marker, never absence.
      expect(headers['X-Tenant-Id']).toBe('tenantless:platform-operator');
      expect(headers['X-Tenant-Id']).not.toMatch(/^[0-9a-f-]{36}$/i);
    });

    it('still declares a marker when no ClsService is wired at all', async () => {
      const { service, post } = makeService();

      await service.redact('text', 'full');

      expect((post.mock.calls[0][2].headers as Record<string, string>)['X-Tenant-Id']).toBe('tenantless:platform-operator');
    });
  });

  it('FAIL-CLOSED: rethrows on a transport error — never falls back to the raw text', async () => {
    const post = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { service } = makeService({ post });

    await expect(service.redact('John Smith has a cough.', 'full')).rejects.toThrow('ECONNREFUSED');
  });

  it('FAIL-CLOSED: throws when the response body has no sanitized_text (never returns the raw input)', async () => {
    const post = vi.fn().mockResolvedValue({ data: { entities: [] } });
    const { service } = makeService({ post });

    await expect(service.redact('John Smith has a cough.', 'full')).rejects.toThrow(/sanitized_text/);
  });

  it('FAIL-CLOSED: throws when sanitized_text is not a string', async () => {
    const post = vi.fn().mockResolvedValue({ data: { sanitized_text: null } });
    const { service } = makeService({ post });

    await expect(service.redact('text', 'full')).rejects.toThrow(/sanitized_text/);
  });
});
