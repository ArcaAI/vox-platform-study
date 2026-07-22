/**
 * AgenticClient — 401 auto-refresh interceptor
 *
 * Tests that the AgenticClient can be configured with an onUnauthorized
 * callback and automatically retries failed 401 requests after the callback
 * resolves with a new token.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgenticClient } from '../AgenticClient';
import { AgenticError } from '../../types';
import {
    mockFetch,
    createMockResponse,
    createMockErrorResponse,
    createMockLogger,
} from '../../__tests__/setup';

describe('AgenticClient — 401 auto-refresh', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;

    beforeEach(() => {
        mockLogger = createMockLogger();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    // =========================================================================
    // onUnauthorized callback configuration
    // =========================================================================

    describe('onUnauthorized configuration', () => {
        it('should accept an onUnauthorized callback via setOnUnauthorized', () => {
            const client = new AgenticClient(
                { baseUrl: 'https://api.example.com', accessToken: 'old-token' },
                mockLogger,
            );

            const handler = vi.fn();
            client.setOnUnauthorized(handler);

            expect(typeof client.setOnUnauthorized).toBe('function');
        });
    });

    // =========================================================================
    // 401 retry behavior
    // =========================================================================

    describe('401 retry with onUnauthorized', () => {
        it('should call onUnauthorized when a 401 is received', async () => {
            const onUnauthorized = vi.fn().mockResolvedValue(false);

            const client = new AgenticClient(
                { baseUrl: 'https://api.example.com', accessToken: 'expired-token' },
                mockLogger,
            );
            client.setOnUnauthorized(onUnauthorized);

            mockFetch.mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'));

            try {
                await client.get('/api/test');
            } catch {
                // expected
            }

            expect(onUnauthorized).toHaveBeenCalled();
        });

        it('should retry the original request with new token when onUnauthorized returns true', async () => {
            const onUnauthorized = vi.fn().mockImplementation(async () => {
                client.updateAccessToken('refreshed-token');
                return true;
            });

            const client = new AgenticClient(
                { baseUrl: 'https://api.example.com', accessToken: 'expired-token' },
                mockLogger,
            );
            client.setOnUnauthorized(onUnauthorized);

            mockFetch
                .mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'))
                .mockResolvedValueOnce(createMockResponse({ data: 'success' }));

            const result = await client.get<{ data: string }>('/api/test');

            expect(result).toEqual({ data: 'success' });
            expect(mockFetch).toHaveBeenCalledTimes(2);

            const retryHeaders = mockFetch.mock.calls[1][1]?.headers;
            expect(retryHeaders['Authorization']).toBe('Bearer refreshed-token');
        });

        it('should throw AUTHENTICATION_ERROR when onUnauthorized returns false', async () => {
            const onUnauthorized = vi.fn().mockResolvedValue(false);

            const client = new AgenticClient(
                { baseUrl: 'https://api.example.com', accessToken: 'expired-token' },
                mockLogger,
            );
            client.setOnUnauthorized(onUnauthorized);

            mockFetch.mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'));

            try {
                await client.get('/api/test');
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('AUTHENTICATION_ERROR');
            }
        });

        it('should throw AUTHENTICATION_ERROR when onUnauthorized rejects', async () => {
            const onUnauthorized = vi.fn().mockRejectedValue(new Error('Refresh failed'));

            const client = new AgenticClient(
                { baseUrl: 'https://api.example.com', accessToken: 'expired-token' },
                mockLogger,
            );
            client.setOnUnauthorized(onUnauthorized);

            mockFetch.mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'));

            try {
                await client.get('/api/test');
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('AUTHENTICATION_ERROR');
            }
        });

        it('should NOT retry when there is no onUnauthorized handler', async () => {
            const client = new AgenticClient(
                { baseUrl: 'https://api.example.com', accessToken: 'expired-token' },
                mockLogger,
            );

            mockFetch.mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'));

            try {
                await client.get('/api/test');
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('AUTHENTICATION_ERROR');
            }

            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should NOT retry 401s on the refresh endpoint itself to avoid loops', async () => {
            const onUnauthorized = vi.fn().mockResolvedValue(true);

            const client = new AgenticClient(
                { baseUrl: 'https://api.example.com', accessToken: 'expired-token' },
                mockLogger,
            );
            client.setOnUnauthorized(onUnauthorized);

            mockFetch.mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'));

            try {
                await client.post('/auth/refresh', { refreshToken: 'old' });
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('AUTHENTICATION_ERROR');
            }

            expect(onUnauthorized).not.toHaveBeenCalled();
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should only retry once even if the retry also returns 401', async () => {
            const onUnauthorized = vi.fn().mockResolvedValue(true);

            const client = new AgenticClient(
                { baseUrl: 'https://api.example.com', accessToken: 'expired-token' },
                mockLogger,
            );
            client.setOnUnauthorized(onUnauthorized);

            mockFetch
                .mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'))
                .mockResolvedValueOnce(createMockErrorResponse(401, 'Still Unauthorized'));

            try {
                await client.get('/api/test');
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('AUTHENTICATION_ERROR');
            }

            expect(onUnauthorized).toHaveBeenCalledTimes(1);
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });
    });

    // =========================================================================
    // POST with body retry
    // =========================================================================

    describe('retry preserves request parameters', () => {
        it('should retry POST requests with the same body', async () => {
            const onUnauthorized = vi.fn().mockImplementation(async () => {
                client.updateAccessToken('new-token');
                return true;
            });

            const client = new AgenticClient(
                { baseUrl: 'https://api.example.com', accessToken: 'expired' },
                mockLogger,
            );
            client.setOnUnauthorized(onUnauthorized);

            const body = { key: 'value', nested: { a: 1 } };

            mockFetch
                .mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'))
                .mockResolvedValueOnce(createMockResponse({ id: 'created' }));

            const result = await client.post<{ id: string }>('/api/items', body);

            expect(result).toEqual({ id: 'created' });
            expect(mockFetch.mock.calls[1][1]?.body).toBe(JSON.stringify(body));
        });

        it('should retry PATCH requests with the same body', async () => {
            const onUnauthorized = vi.fn().mockImplementation(async () => {
                client.updateAccessToken('new-token');
                return true;
            });

            const client = new AgenticClient(
                { baseUrl: 'https://api.example.com', accessToken: 'expired' },
                mockLogger,
            );
            client.setOnUnauthorized(onUnauthorized);

            mockFetch
                .mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'))
                .mockResolvedValueOnce(createMockResponse({ updated: true }));

            await client.patch('/api/items/1', { name: 'updated' });

            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(mockFetch.mock.calls[1][1]?.method).toBe('PATCH');
        });
    });

    // =========================================================================
    // Non-401 errors should NOT trigger onUnauthorized
    // =========================================================================

    describe('non-401 errors bypass onUnauthorized', () => {
        it('should NOT call onUnauthorized for 403 errors', async () => {
            const onUnauthorized = vi.fn();

            const client = new AgenticClient(
                { baseUrl: 'https://api.example.com', accessToken: 'token' },
                mockLogger,
            );
            client.setOnUnauthorized(onUnauthorized);

            mockFetch.mockResolvedValueOnce(createMockErrorResponse(403, 'Forbidden'));

            try {
                await client.get('/api/test');
            } catch {
                // expected
            }

            expect(onUnauthorized).not.toHaveBeenCalled();
        });

        it('should NOT call onUnauthorized for 500 errors', async () => {
            const onUnauthorized = vi.fn();

            const client = new AgenticClient(
                { baseUrl: 'https://api.example.com', accessToken: 'token' },
                mockLogger,
            );
            client.setOnUnauthorized(onUnauthorized);

            mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Internal Server Error'));

            try {
                await client.get('/api/test');
            } catch {
                // expected
            }

            expect(onUnauthorized).not.toHaveBeenCalled();
        });
    });
});
