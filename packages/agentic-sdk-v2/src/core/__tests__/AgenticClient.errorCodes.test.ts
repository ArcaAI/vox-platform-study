/**
 * AgenticClient HTTP status → AgenticError code mapping
 *
 * Adds 403 → FORBIDDEN and 429 → RATE_LIMITED mapping. Tested across all
 * three HTTP code paths (request, postFormData, uploadFormData).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgenticClient } from '../AgenticClient';
import { AgenticError } from '../../types';
import { mockFetch, createMockErrorResponse, createMockLogger } from '../../__tests__/setup';

describe('AgenticClient error code mapping', () => {
  let client: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    client = new AgenticClient(
      { baseUrl: 'https://api.example.com', apiKey: 'k', tenantId: 't' },
      mockLogger,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('request() — JSON requests', () => {
    it('should map HTTP 403 → FORBIDDEN', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(403, 'Forbidden'));
      await expect(client.get('/api/test')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('should map HTTP 429 → RATE_LIMITED', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(429, 'Too Many Requests'));
      await expect(client.get('/api/test')).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
    });

    it('should still map HTTP 401 → AUTHENTICATION_ERROR', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'));
      await expect(client.get('/api/test')).rejects.toMatchObject({
        code: 'AUTHENTICATION_ERROR',
      });
    });

    it('should still map HTTP 404 → NOT_FOUND', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(404, 'Not Found'));
      await expect(client.get('/api/test')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('should still map other 4xx (e.g. 422) → VALIDATION_ERROR', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(422, 'Unprocessable'));
      await expect(client.get('/api/test')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('should still map 5xx → API_ERROR', async () => {
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Server'));
      await expect(client.get('/api/test')).rejects.toMatchObject({
        code: 'API_ERROR',
      });
    });
  });

  describe('postFormData() — multipart uploads', () => {
    it('should map HTTP 403 → FORBIDDEN', async () => {
      const fd = new FormData();
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(403, 'Forbidden'));
      await expect(client.postFormData('/api/upload', fd)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('should map HTTP 429 → RATE_LIMITED', async () => {
      const fd = new FormData();
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(429, 'Too Many Requests'));
      await expect(client.postFormData('/api/upload', fd)).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
    });
  });

  describe('uploadFormData() — XHR multipart with progress', () => {
    it('should map HTTP 403 → FORBIDDEN', async () => {
      const fd = new FormData();
      const mockXHR = createMockXhr(403);
      const XhrCtor = function (this: unknown) {
        return mockXHR as unknown as XMLHttpRequest;
      } as unknown as typeof XMLHttpRequest;
      vi.stubGlobal('XMLHttpRequest', XhrCtor);

      try {
        const promise = client.uploadFormData('/api/upload', fd);
        await Promise.resolve();
        mockXHR.triggerOnload();
        await expect(promise).rejects.toBeInstanceOf(AgenticError);
        await expect(promise).rejects.toMatchObject({ code: 'FORBIDDEN' });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('should map HTTP 429 → RATE_LIMITED', async () => {
      const fd = new FormData();
      const mockXHR = createMockXhr(429);
      const XhrCtor = function (this: unknown) {
        return mockXHR as unknown as XMLHttpRequest;
      } as unknown as typeof XMLHttpRequest;
      vi.stubGlobal('XMLHttpRequest', XhrCtor);

      try {
        const promise = client.uploadFormData('/api/upload', fd);
        await Promise.resolve();
        mockXHR.triggerOnload();
        await expect(promise).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockXhr(status: number) {
  const handlers: Record<string, ((ev?: unknown) => void) | null> = {
    onload: null,
    onerror: null,
    ontimeout: null,
    onabort: null,
  };
  const xhr = {
    open: vi.fn(),
    send: vi.fn(),
    setRequestHeader: vi.fn(),
    abort: vi.fn(),
    upload: { onprogress: null as ((ev: ProgressEvent) => void) | null },
    status,
    statusText: status === 403 ? 'Forbidden' : status === 429 ? 'Too Many Requests' : 'Error',
    responseText: JSON.stringify({ message: 'rejected' }),
    timeout: 0,
    set onload(cb: () => void) {
      handlers.onload = cb;
    },
    set onerror(cb: () => void) {
      handlers.onerror = cb;
    },
    set ontimeout(cb: () => void) {
      handlers.ontimeout = cb;
    },
    set onabort(cb: () => void) {
      handlers.onabort = cb;
    },
    triggerOnload() {
      handlers.onload?.();
    },
  };
  return xhr;
}
