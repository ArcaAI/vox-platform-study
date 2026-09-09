/**
 * TASK-933 lane H2 — `vox-codegen --tenant` in SERVICE-ACCOUNT mode.
 *
 * Hermetic: `fetch` is a double throughout. The exchange and the discovery read
 * are asserted separately, because getting either header wrong is a 401 an
 * operator cannot debug from the CLI output.
 */

import { describe, expect, it, vi } from 'vitest';

import { exchangeServiceAccountToken } from '../exchange-service-token';
import { fetchConsultationSchemaBundle } from '../fetch-schema';
import { CodegenError } from '../errors';
import { main } from '../cli';

const EMPTY_BUNDLE = {
  schemaId: null,
  slug: null,
  name: null,
  versionNumber: null,
  contextSchemaVersionId: null,
  checksum: null,
  definition: null,
  etag: 'none',
};

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('exchangeServiceAccountToken', () => {
  it('POSTs auth/service-token and returns the opaque token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ accessToken: 'opaque-token', tokenType: 'Bearer', expiresIn: 900, scopes: ['svc:tenant:context-schema:read'], tenantId: 't-1' }),
    );

    const result = await exchangeServiceAccountToken({
      baseUrl: 'http://localhost:8868',
      clientId: 'hope_svc_1',
      clientSecret: 'shh',
      workingTenantId: 't-1',
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8868/api/v1/auth/service-token');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ clientId: 'hope_svc_1', clientSecret: 'shh', workingTenantId: 't-1' });
    expect(result.accessToken).toBe('opaque-token');
  });

  it('raises CodegenError with no secret in the message when the exchange is refused', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: 'nope' }, { ok: false, status: 401, statusText: 'Unauthorized' }));

    const failing = exchangeServiceAccountToken({
      baseUrl: 'http://localhost:8868',
      clientId: 'hope_svc_1',
      clientSecret: 'super-secret-value',
      fetchImpl,
    });

    await expect(failing).rejects.toBeInstanceOf(CodegenError);
    await expect(failing).rejects.toThrow(/401/);
    await expect(failing).rejects.not.toThrow(/super-secret-value/);
  });
});

describe('fetchConsultationSchemaBundle — service-account credential', () => {
  it('sends X-Service-Account-Token and NO X-Tenant-Id (the working tenant binds at exchange)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(EMPTY_BUNDLE));

    await fetchConsultationSchemaBundle({
      baseUrl: 'http://localhost:8868',
      tenantId: 'tenant-1',
      serviceAccountToken: 'opaque-token',
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8868/api/v1/tenants/me/context-schema');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Service-Account-Token']).toBe('opaque-token');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-Tenant-Id']).toBeUndefined();
  });

  it('refuses both credential classes on one read', async () => {
    const fetchImpl = vi.fn();

    await expect(
      fetchConsultationSchemaBundle({
        baseUrl: 'http://localhost:8868',
        tenantId: 'tenant-1',
        token: 'jwt',
        serviceAccountToken: 'opaque',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(CodegenError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a read with no credential at all', async () => {
    const fetchImpl = vi.fn();
    await expect(fetchConsultationSchemaBundle({ baseUrl: 'http://localhost:8868', tenantId: 'tenant-1', fetchImpl })).rejects.toBeInstanceOf(
      CodegenError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('cli — service-account mode', () => {
  it('rejects a client id with no secret', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = await main(['--tenant', 't-1', '--client-id', 'hope_svc_1']);
    expect(code).toBe(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/client-secret/);
    stderr.mockRestore();
  });

  it('rejects a JWT and a service account on the same run', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = await main(['--tenant', 't-1', '--token', 'jwt', '--client-id', 'a', '--client-secret', 'b']);
    expect(code).toBe(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/mutually exclusive|one credential/i);
    stderr.mockRestore();
  });

  it('reads HOPE_SVC_CLIENT_ID / HOPE_SVC_CLIENT_SECRET when the flags are absent', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.env.HOPE_SVC_CLIENT_ID = 'hope_svc_env';
    process.env.HOPE_SVC_CLIENT_SECRET = 'env-secret';
    try {
      // No `--token`, no `--client-id`: the env pair alone must satisfy the credential check,
      // so the run gets past argument validation and fails on the EXCHANGE against a port
      // nothing listens on — which is what proves the env fallback was read.
      const code = await main(['--tenant', 't-1', '--base-url', 'http://127.0.0.1:1']);
      expect(code).toBe(1);
      const message = String(stderr.mock.calls[0]?.[0]);
      expect(message).toMatch(/auth\/service-token/);
      expect(message).not.toMatch(/a credential is required/);
      expect(message).not.toContain('env-secret');
    } finally {
      delete process.env.HOPE_SVC_CLIENT_ID;
      delete process.env.HOPE_SVC_CLIENT_SECRET;
      stderr.mockRestore();
    }
  });
});
