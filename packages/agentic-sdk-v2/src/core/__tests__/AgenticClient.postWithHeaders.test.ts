/**
 * AgenticClient — `postWithHeaders<T>`
 *
 * A thin wrapper around the private `request`, exactly mirroring
 * `patchWithIfMatch`'s shape (see `AgenticClient.optimistic-locking.test.ts`).
 * Used by `useArcaSession.addContext` to send `X-Context-Schema-Version` on
 * a context write once the session has a pinned schema (header contract).
 * Only the new-method-specific behavior (header propagation) is
 * asserted here — auth/retry/rate-limit machinery is shared and already
 * covered by `AgenticClient.test.ts`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgenticClient } from '../AgenticClient';
import { mockFetch, createMockResponse, createMockLogger } from '../../__tests__/setup';

describe('AgenticClient — postWithHeaders<T>', () => {
  let client: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    client = new AgenticClient(
      {
        baseUrl: 'https://api.example.com',
        apiKey: 'test-api-key',
        tenantId: 'tenant-123',
        timeout: 5000,
      },
      mockLogger,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends caller-supplied headers alongside the body', async () => {
    const created = { id: 'ctx-1', type: 'STRUCTURED', kindKey: 'referral_letter' };
    mockFetch.mockResolvedValueOnce(createMockResponse(created));

    const result = await client.postWithHeaders<typeof created>(
      '/api/v1/consultations/consult-1/context',
      { type: 'STRUCTURED', kindKey: 'referral_letter', payload: { severity: 'mild' } },
      { 'X-Context-Schema-Version': 'version-3' },
    );

    expect(result).toEqual(created);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/consultations/consult-1/context',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Context-Schema-Version': 'version-3',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ type: 'STRUCTURED', kindKey: 'referral_letter', payload: { severity: 'mild' } }),
      }),
    );
  });

  it('still carries the standard auth headers alongside the custom one', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

    await client.postWithHeaders('/api/v1/consultations/consult-1/context', {}, { 'X-Context-Schema-Version': 'version-1' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-Key': 'test-api-key',
          'X-Tenant-ID': 'tenant-123',
          'X-Context-Schema-Version': 'version-1',
        }),
      }),
    );
  });
});
