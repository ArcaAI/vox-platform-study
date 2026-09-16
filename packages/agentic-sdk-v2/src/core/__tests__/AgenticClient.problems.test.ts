/**
 * AgenticClient — `problems[]` lift into `AgenticError.context`
 *
 * @vitest-environment jsdom
 *
 * The house `{ message, code, problems? }` body shape carries one human-readable string per
 * validation failure — e.g. the unmet requirements of a 400 `WORKFLOW_CONTEXT_INCOMPATIBLE`
 * refusal on `open()`. This mirrors the existing `errorData.code` lift in `requestWithMeta`
 * (pinned by `AgenticClient.optimistic-locking.test.ts`'s `currentVersion` tests) so a caller
 * reads `error.context.problems` without re-parsing the response body.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgenticClient } from '../AgenticClient';
import { AgenticError } from '../../types';
import { mockFetch, createMockErrorResponse, createMockLogger } from '../../__tests__/setup';

function errorResponse(status: number, body: Record<string, unknown>): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(''),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as Response;
}

describe('AgenticClient — problems[] lift', () => {
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

  it('lifts problems[] into AgenticError.context on a 400 WORKFLOW_CONTEXT_INCOMPATIBLE refusal', async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(400, {
        code: 'WORKFLOW_CONTEXT_INCOMPATIBLE',
        message: 'The context does not match what the governing workflow accepts.',
        problems: ['/referral: not declared in the bound version v2'],
      }),
    );

    let thrown: unknown;
    try {
      await client.get('/api/v1/consultations/open');
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(AgenticError);
    const err = thrown as AgenticError;
    expect((err.context as Record<string, unknown>).code).toBe('WORKFLOW_CONTEXT_INCOMPATIBLE');
    expect((err.context as Record<string, unknown>).problems).toEqual(['/referral: not declared in the bound version v2']);
  });

  it('does not add a problems key when the body carries none', async () => {
    mockFetch.mockResolvedValueOnce(createMockErrorResponse(400, 'Bad Request'));

    let thrown: unknown;
    try {
      await client.get('/api/v1/consultations/open');
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(AgenticError);
    const err = thrown as AgenticError;
    expect((err.context as Record<string, unknown>).problems).toBeUndefined();
  });

  it('does not add a problems key when problems is present but empty', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(400, { message: 'boom', problems: [] }));

    let thrown: unknown;
    try {
      await client.get('/api/v1/consultations/open');
    } catch (e) {
      thrown = e;
    }

    const err = thrown as AgenticError;
    expect((err.context as Record<string, unknown>).problems).toBeUndefined();
  });

  it('drops non-string entries rather than throwing', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(400, { message: 'boom', problems: ['ok', 42, null, 'also ok'] }));

    let thrown: unknown;
    try {
      await client.get('/api/v1/consultations/open');
    } catch (e) {
      thrown = e;
    }

    const err = thrown as AgenticError;
    expect((err.context as Record<string, unknown>).problems).toEqual(['ok', 'also ok']);
  });

  it('lifts problems for every 4xx status, not only 400', async () => {
    for (const status of [401, 403, 404, 409, 412, 428, 429]) {
      mockFetch.mockResolvedValueOnce(errorResponse(status, { message: 'refused', problems: ['one problem'] }));

      let thrown: unknown;
      try {
        await client.get('/api/v1/consultations/open');
      } catch (e) {
        thrown = e;
      }

      const err = thrown as AgenticError;
      expect((err.context as Record<string, unknown>).problems, `status ${status} did not lift problems`).toEqual(['one problem']);
    }
  });
});
