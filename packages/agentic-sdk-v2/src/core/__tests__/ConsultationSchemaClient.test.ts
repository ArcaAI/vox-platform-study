/**
 * `fetchConsultationSchema` fail-open behaviour.
 *
 * Mirrors `ModelRegistry.loadTenantConfig`'s test posture: a network/HTTP
 * failure resolves to the safe fallback bundle rather than rejecting, so a
 * schema-plane outage can never block `AgenticProvider.configReady`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgenticClient } from '../AgenticClient';
import { fetchConsultationSchema } from '../ConsultationSchemaClient';
import { UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE } from '../../types/consultationSchema';
import { createMockLogger, mockFetch, createMockResponse, createMockErrorResponse } from '../../__tests__/setup';

describe('fetchConsultationSchema', () => {
  let apiClient: AgenticClient;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    apiClient = new AgenticClient({ baseUrl: 'http://test', apiKey: 'key' }, logger);
  });

  it('parses a configured tenant bundle from GET /tenant/me/context-schema', async () => {
    const raw = {
      schemaId: 'schema-1',
      slug: 'default',
      name: 'Default',
      versionNumber: 2,
      contextSchemaVersionId: 'version-2',
      checksum: 'abc123',
      definition: { schemaVersion: '1.0', kinds: [{ key: 'referral_letter', label: 'Referral', primitive: 'TEXT' }] },
      etag: '"2"',
    };
    mockFetch.mockResolvedValueOnce(createMockResponse(raw));

    const bundle = await fetchConsultationSchema(apiClient, logger);

    expect(bundle.schemaId).toBe('schema-1');
    expect(bundle.contextSchemaVersionId).toBe('version-2');
    expect(bundle.etag).toBe('"2"');
    expect(mockFetch).toHaveBeenCalledWith('http://test/tenant/me/context-schema', expect.anything());
  });

  it('resolves to the unconfigured bundle (never throws) on a 500', async () => {
    mockFetch
      .mockResolvedValueOnce(createMockErrorResponse(500, 'Internal Server Error'))
      .mockResolvedValueOnce(createMockErrorResponse(500, 'Internal Server Error'))
      .mockResolvedValueOnce(createMockErrorResponse(500, 'Internal Server Error'));

    const bundle = await fetchConsultationSchema(apiClient, logger);

    expect(bundle).toEqual(UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE);
  });

  it('resolves to the unconfigured bundle (never throws) on a network failure', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));

    const bundle = await fetchConsultationSchema(apiClient, logger);

    expect(bundle).toEqual(UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE);
  });

  it('resolves to the unconfigured bundle for an unconfigured tenant (server 200, etag "none")', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({ schemaId: null, slug: null, name: null, versionNumber: null, contextSchemaVersionId: null, checksum: null, definition: null, etag: 'none' }),
    );

    const bundle = await fetchConsultationSchema(apiClient, logger);

    expect(bundle).toEqual(UNCONFIGURED_CONSULTATION_SCHEMA_BUNDLE);
  });

  it('appends departmentId as a query param when supplied', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse({ etag: 'none' }));

    await fetchConsultationSchema(apiClient, logger, { departmentId: 'dept-1' });

    expect(mockFetch).toHaveBeenCalledWith('http://test/tenant/me/context-schema?departmentId=dept-1', expect.anything());
  });
});
