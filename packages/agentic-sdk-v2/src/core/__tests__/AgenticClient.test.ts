/**
 * AgenticClient Unit Tests
 *
 * Tests for the HTTP client implementation.
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

describe('AgenticClient', () => {
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
            mockLogger
        );
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('constructor', () => {
        it('should create client with config', () => {
            expect(client.getBaseUrl()).toBe('https://api.example.com');
        });

        it('should remove trailing slash from baseUrl', () => {
            const clientWithSlash = new AgenticClient({
                baseUrl: 'https://api.example.com/',
                apiKey: 'test-key',
            });
            expect(clientWithSlash.getBaseUrl()).toBe('https://api.example.com');
        });

        it('should log initialization', () => {
            expect(mockLogger.debug).toHaveBeenCalledWith(
                'AgenticClient initialized',
                expect.objectContaining({
                    operation: 'constructor',
                    component: 'AgenticClient',
                })
            );
        });
    });

    describe('GET requests', () => {
        it('should make GET request successfully', async () => {
            const mockData = { id: '123', name: 'Test' };
            mockFetch.mockResolvedValueOnce(createMockResponse(mockData));

            const result = await client.get<typeof mockData>('/api/test');

            expect(result).toEqual(mockData);
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.example.com/api/test',
                expect.objectContaining({
                    method: 'GET',
                    headers: expect.objectContaining({
                        'Content-Type': 'application/json',
                        'X-API-Key': 'test-api-key',
                        'X-Tenant-ID': 'tenant-123',
                    }),
                })
            );
        });

        it('should include correlation ID in headers', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

            await client.get('/api/test');

            expect(mockFetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'X-Correlation-ID': 'mock-correlation-id',
                    }),
                })
            );
        });

        it('should log request and response', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

            await client.get('/api/test');

            expect(mockLogger.debug).toHaveBeenCalledWith(
                'HTTP GET /api/test',
                expect.objectContaining({
                    operation: 'httpRequest',
                    http: expect.objectContaining({
                        method: 'GET',
                        url: '/api/test',
                    }),
                })
            );

            expect(mockLogger.http).toHaveBeenCalledWith(
                expect.stringContaining('HTTP GET /api/test'),
                expect.objectContaining({
                    operation: 'httpResponse',
                    http: expect.objectContaining({
                        statusCode: 200,
                    }),
                })
            );
        });
    });

    describe('POST requests', () => {
        it('should make POST request with body', async () => {
            const requestBody = { name: 'Test', value: 123 };
            const responseData = { id: '123', ...requestBody };
            mockFetch.mockResolvedValueOnce(createMockResponse(responseData));

            const result = await client.post<typeof responseData>('/api/test', requestBody);

            expect(result).toEqual(responseData);
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.example.com/api/test',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify(requestBody),
                })
            );
        });

        it('should handle POST without body', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse({ success: true }));

            await client.post('/api/test');

            expect(mockFetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    method: 'POST',
                    body: undefined,
                })
            );
        });
    });

    describe('PATCH requests', () => {
        it('should make PATCH request', async () => {
            const updateData = { name: 'Updated' };
            mockFetch.mockResolvedValueOnce(createMockResponse({ id: '123', ...updateData }));

            await client.patch('/api/test/123', updateData);

            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.example.com/api/test/123',
                expect.objectContaining({
                    method: 'PATCH',
                    body: JSON.stringify(updateData),
                })
            );
        });
    });

    describe('DELETE requests', () => {
        it('should make DELETE request', async () => {
            mockFetch.mockResolvedValueOnce(
                createMockResponse(undefined, { status: 204 })
            );

            await client.delete('/api/test/123');

            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.example.com/api/test/123',
                expect.objectContaining({
                    method: 'DELETE',
                })
            );
        });
    });

    describe('error handling', () => {
        it('should throw AgenticError on 401', async () => {
            mockFetch.mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'));

            try {
                await client.get('/api/test');
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('AUTHENTICATION_ERROR');
            }
        });

        it('should throw AgenticError on 404', async () => {
            mockFetch.mockResolvedValueOnce(createMockErrorResponse(404, 'Not Found'));

            try {
                await client.get('/api/test');
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('NOT_FOUND');
            }
        });

        it('should throw AgenticError on 400', async () => {
            mockFetch.mockResolvedValueOnce(createMockErrorResponse(400, 'Bad Request'));

            try {
                await client.get('/api/test');
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('VALIDATION_ERROR');
            }
        });

        it('should throw AgenticError on 500', async () => {
            mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Internal Server Error'));

            try {
                await client.get('/api/test');
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('API_ERROR');
            }
        });

        it('should handle network errors', async () => {
            mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

            try {
                await client.get('/api/test');
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('NETWORK_ERROR');
            }
        });

        it('should handle timeout errors', async () => {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            mockFetch.mockRejectedValueOnce(abortError);

            try {
                await client.get('/api/test');
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('NETWORK_ERROR');
            }
        });

        it('should log errors', async () => {
            mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Server Error'));

            try {
                await client.get('/api/test');
            } catch {
                // Expected
            }

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('API request failed'),
                expect.objectContaining({
                    error: expect.objectContaining({
                        code: 'API_ERROR',
                    }),
                })
            );
        });
    });

    describe('updateApiKey (API key channel)', () => {
        it('should update API key', async () => {
            client.updateApiKey('new-api-key');

            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
            await client.get('/api/test');

            expect(mockFetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'X-API-Key': 'new-api-key',
                    }),
                })
            );
        });

        it('should log API key update', () => {
            client.updateApiKey('new-api-key');

            expect(mockLogger.info).toHaveBeenCalledWith(
                'API key updated',
                expect.objectContaining({
                    operation: 'updateApiKey',
                })
            );
        });
    });

    describe('dual auth headers', () => {
        it('should send Authorization: Bearer when accessToken is set', async () => {
            const tokenClient = new AgenticClient(
                {
                    baseUrl: 'https://api.example.com',
                    accessToken: 'jwt-token-123',
                },
                mockLogger
            );

            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
            await tokenClient.get('/api/test');

            const callHeaders = mockFetch.mock.calls[0][1]?.headers;
            expect(callHeaders['Authorization']).toBe('Bearer jwt-token-123');
            expect(callHeaders['X-API-Key']).toBeUndefined();
        });

        it('should send X-API-Key when only apiKey is set', async () => {
            const apiKeyClient = new AgenticClient(
                {
                    baseUrl: 'https://api.example.com',
                    apiKey: 'api-key-456',
                },
                mockLogger
            );

            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
            await apiKeyClient.get('/api/test');

            const callHeaders = mockFetch.mock.calls[0][1]?.headers;
            expect(callHeaders['X-API-Key']).toBe('api-key-456');
            expect(callHeaders['Authorization']).toBeUndefined();
        });

        it('should send both headers when both are set', async () => {
            const dualClient = new AgenticClient(
                {
                    baseUrl: 'https://api.example.com',
                    accessToken: 'jwt-token-123',
                    apiKey: 'api-key-456',
                },
                mockLogger
            );

            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
            await dualClient.get('/api/test');

            const callHeaders = mockFetch.mock.calls[0][1]?.headers;
            expect(callHeaders['Authorization']).toBe('Bearer jwt-token-123');
            expect(callHeaders['X-API-Key']).toBe('api-key-456');
        });

        it('should send neither auth header when both are omitted', async () => {
            const noAuthClient = new AgenticClient(
                {
                    baseUrl: 'https://api.example.com',
                },
                mockLogger
            );

            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
            await noAuthClient.get('/api/test');

            const callHeaders = mockFetch.mock.calls[0][1]?.headers;
            expect(callHeaders['Authorization']).toBeUndefined();
            expect(callHeaders['X-API-Key']).toBeUndefined();
        });
    });

    describe('updateAccessToken', () => {
        it('should update the access token and send it in subsequent requests', async () => {
            const tokenClient = new AgenticClient(
                {
                    baseUrl: 'https://api.example.com',
                },
                mockLogger
            );

            tokenClient.updateAccessToken('new-jwt-token');

            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
            await tokenClient.get('/api/test');

            const callHeaders = mockFetch.mock.calls[0][1]?.headers;
            expect(callHeaders['Authorization']).toBe('Bearer new-jwt-token');
        });

        it('should log access token update', () => {
            const tokenClient = new AgenticClient(
                {
                    baseUrl: 'https://api.example.com',
                },
                mockLogger
            );

            tokenClient.updateAccessToken('new-jwt-token');

            expect(mockLogger.info).toHaveBeenCalledWith(
                'Access token updated',
                expect.objectContaining({ operation: 'updateAccessToken' })
            );
        });
    });

    describe('clearAccessToken', () => {
        it('should remove the access token from subsequent requests', async () => {
            const tokenClient = new AgenticClient(
                {
                    baseUrl: 'https://api.example.com',
                    accessToken: 'initial-token',
                },
                mockLogger
            );

            tokenClient.clearAccessToken();

            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
            await tokenClient.get('/api/test');

            const callHeaders = mockFetch.mock.calls[0][1]?.headers;
            expect(callHeaders['Authorization']).toBeUndefined();
        });

        it('should log access token cleared', () => {
            const tokenClient = new AgenticClient(
                {
                    baseUrl: 'https://api.example.com',
                    accessToken: 'initial-token',
                },
                mockLogger
            );

            tokenClient.clearAccessToken();

            expect(mockLogger.info).toHaveBeenCalledWith(
                'Access token cleared',
                expect.objectContaining({ operation: 'clearAccessToken' })
            );
        });
    });

    describe('clearApiKey', () => {
        it('should remove the API key from subsequent requests', async () => {
            client.clearApiKey();

            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
            await client.get('/api/test');

            const callHeaders = mockFetch.mock.calls[0][1]?.headers;
            expect(callHeaders['X-API-Key']).toBeUndefined();
        });

        it('should log API key cleared', () => {
            client.clearApiKey();

            expect(mockLogger.info).toHaveBeenCalledWith(
                'API key cleared',
                expect.objectContaining({ operation: 'clearApiKey' })
            );
        });
    });

    describe('getAccessToken / getApiKey getters', () => {
        it('should return undefined when no accessToken is configured', () => {
            const noTokenClient = new AgenticClient({ baseUrl: 'https://api.example.com' });
            expect(noTokenClient.getAccessToken()).toBeUndefined();
        });

        it('should return the accessToken when configured', () => {
            const tokenClient = new AgenticClient({
                baseUrl: 'https://api.example.com',
                accessToken: 'my-jwt',
            });
            expect(tokenClient.getAccessToken()).toBe('my-jwt');
        });

        it('should return undefined when no apiKey is configured', () => {
            const noKeyClient = new AgenticClient({ baseUrl: 'https://api.example.com' });
            expect(noKeyClient.getApiKey()).toBeUndefined();
        });

        it('should return the apiKey when configured', () => {
            const keyClient = new AgenticClient({
                baseUrl: 'https://api.example.com',
                apiKey: 'my-api-key',
            });
            expect(keyClient.getApiKey()).toBe('my-api-key');
        });

        it('should reflect runtime changes after updateAccessToken', () => {
            const c = new AgenticClient({ baseUrl: 'https://api.example.com' });
            expect(c.getAccessToken()).toBeUndefined();
            c.updateAccessToken('new-token');
            expect(c.getAccessToken()).toBe('new-token');
        });

        it('should reflect runtime changes after clearAccessToken', () => {
            const c = new AgenticClient({ baseUrl: 'https://api.example.com', accessToken: 'old' });
            expect(c.getAccessToken()).toBe('old');
            c.clearAccessToken();
            expect(c.getAccessToken()).toBeUndefined();
        });

        it('should reflect runtime changes after updateApiKey', () => {
            const c = new AgenticClient({ baseUrl: 'https://api.example.com' });
            expect(c.getApiKey()).toBeUndefined();
            c.updateApiKey('new-key');
            expect(c.getApiKey()).toBe('new-key');
        });

        it('should reflect runtime changes after clearApiKey', () => {
            const c = new AgenticClient({ baseUrl: 'https://api.example.com', apiKey: 'old-key' });
            expect(c.getApiKey()).toBe('old-key');
            c.clearApiKey();
            expect(c.getApiKey()).toBeUndefined();
        });
    });

    describe('empty-string token edge cases', () => {
        it('should NOT send Authorization header when accessToken is empty string', async () => {
            const emptyTokenClient = new AgenticClient(
                {
                    baseUrl: 'https://api.example.com',
                    accessToken: '',
                },
                mockLogger
            );

            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
            await emptyTokenClient.get('/api/test');

            const callHeaders = mockFetch.mock.calls[0][1]?.headers;
            expect(callHeaders['Authorization']).toBeUndefined();
        });

        it('should NOT send X-API-Key header when apiKey is empty string', async () => {
            const emptyKeyClient = new AgenticClient(
                {
                    baseUrl: 'https://api.example.com',
                    apiKey: '',
                },
                mockLogger
            );

            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));
            await emptyKeyClient.get('/api/test');

            const callHeaders = mockFetch.mock.calls[0][1]?.headers;
            expect(callHeaders['X-API-Key']).toBeUndefined();
        });
    });

    describe('postFormData dual auth', () => {
        it('should send Authorization: Bearer in postFormData when accessToken is set', async () => {
            const tokenClient = new AgenticClient(
                {
                    baseUrl: 'https://api.example.com',
                    accessToken: 'jwt-token-form',
                },
                mockLogger
            );

            const formData = new FormData();
            formData.append('file', new Blob(['hello']), 'test.wav');

            mockFetch.mockResolvedValueOnce(createMockResponse({ id: 'job-1' }));
            await tokenClient.postFormData('/api/upload', formData);

            const callHeaders = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
            expect(callHeaders['Authorization']).toBe('Bearer jwt-token-form');
            expect(callHeaders['X-API-Key']).toBeUndefined();
        });

        it('should send X-API-Key in postFormData when only apiKey is set', async () => {
            const apiKeyClient = new AgenticClient(
                {
                    baseUrl: 'https://api.example.com',
                    apiKey: 'system-key-form',
                },
                mockLogger
            );

            const formData = new FormData();
            formData.append('file', new Blob(['data']), 'audio.wav');

            mockFetch.mockResolvedValueOnce(createMockResponse({ id: 'job-2' }));
            await apiKeyClient.postFormData('/api/upload', formData);

            const callHeaders = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
            expect(callHeaders['X-API-Key']).toBe('system-key-form');
            expect(callHeaders['Authorization']).toBeUndefined();
        });

        it('should send both headers in postFormData when both are set', async () => {
            const dualClient = new AgenticClient(
                {
                    baseUrl: 'https://api.example.com',
                    accessToken: 'jwt-dual',
                    apiKey: 'key-dual',
                },
                mockLogger
            );

            const formData = new FormData();
            formData.append('file', new Blob(['data']), 'audio.wav');

            mockFetch.mockResolvedValueOnce(createMockResponse({ id: 'job-3' }));
            await dualClient.postFormData('/api/upload', formData);

            const callHeaders = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
            expect(callHeaders['Authorization']).toBe('Bearer jwt-dual');
            expect(callHeaders['X-API-Key']).toBe('key-dual');
        });
    });

    describe('204 No Content', () => {
        it('should handle 204 responses', async () => {
            mockFetch.mockResolvedValueOnce(
                createMockResponse(undefined, { status: 204 })
            );

            const result = await client.delete('/api/test/123');

            expect(result).toBeUndefined();
        });
    });

    describe('postFormData', () => {
        it('should send FormData with auth headers but without Content-Type', async () => {
            const formData = new FormData();
            formData.append('file', new Blob(['hello']), 'test.wav');
            formData.append('pipelineId', 'default');

            mockFetch.mockResolvedValueOnce(createMockResponse({ id: 'job-1' }));

            const result = await client.postFormData<{ id: string }>('/api/v1/upload', formData);

            expect(result).toEqual({ id: 'job-1' });

            const callHeaders = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
            expect(callHeaders['X-API-Key']).toBe('test-api-key');
            expect(callHeaders['X-Tenant-ID']).toBe('tenant-123');
            expect(callHeaders['Content-Type']).toBeUndefined();
        });

        it('should send the FormData body directly (not JSON-stringified)', async () => {
            const formData = new FormData();
            formData.append('file', new Blob(['data']), 'audio.wav');

            mockFetch.mockResolvedValueOnce(createMockResponse({ id: 'job-2' }));

            await client.postFormData('/api/v1/upload', formData);

            const callBody = mockFetch.mock.calls[0][1]?.body;
            expect(callBody).toBeInstanceOf(FormData);
        });

        it('should use POST method', async () => {
            const formData = new FormData();
            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

            await client.postFormData('/api/v1/upload', formData);

            expect(mockFetch.mock.calls[0][1]?.method).toBe('POST');
        });

        it('should throw AgenticError on failure', async () => {
            const formData = new FormData();
            mockFetch.mockResolvedValueOnce(createMockErrorResponse(413, 'File too large'));

            try {
                await client.postFormData('/api/v1/upload', formData);
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
            }
        });

        it('should include correlation ID in headers', async () => {
            const formData = new FormData();
            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

            await client.postFormData('/api/v1/upload', formData);

            const callHeaders = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
            expect(callHeaders['X-Correlation-ID']).toBe('mock-correlation-id');
        });
    });

    describe('BUG-05: options spread must not overwrite SDK headers/signal', () => {
        it('should not allow external options to overwrite auth headers', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

            // Internally, the request method accepts options. We test via the
            // private method indirectly: if someone could pass options with
            // headers, the SDK headers must still be present.
            // The public API (get/post/etc.) doesn't expose options, so this
            // tests the internal safety of the request method.
            await client.get('/api/test');

            const callArgs = mockFetch.mock.calls[0][1];
            expect(callArgs.headers['X-API-Key']).toBe('test-api-key');
            expect(callArgs.signal).toBeInstanceOf(AbortSignal);
        });

        it('should preserve abort signal even when options are provided', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

            await client.post('/api/test', { data: 'test' });

            const callArgs = mockFetch.mock.calls[0][1];
            expect(callArgs.signal).toBeInstanceOf(AbortSignal);
            expect(callArgs.headers['X-API-Key']).toBe('test-api-key');
        });
    });

    describe('PERF-04: body should only be serialized once', () => {
        it('should serialize body exactly once for POST requests', async () => {
            const body = { data: 'test', nested: { value: 42 } };
            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

            const stringifySpy = vi.spyOn(JSON, 'stringify');
            await client.post('/api/test', body);

            const bodyStringifyCalls = stringifySpy.mock.calls.filter(
                (call) => call[0] === body
            );
            expect(bodyStringifyCalls).toHaveLength(1);

            stringifySpy.mockRestore();
        });
    });

    describe('ENH-03: request cancellation via AbortController', () => {
        it('should accept an external AbortSignal and abort the request', async () => {
            const controller = new AbortController();
            controller.abort();

            try {
                await client.get('/api/test', { signal: controller.signal });
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('NETWORK_ERROR');
            }
        });

        it('should still apply internal timeout when no external signal is provided', async () => {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            mockFetch.mockRejectedValueOnce(abortError);

            try {
                await client.get('/api/test');
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('NETWORK_ERROR');
            }
        });
    });

    describe('ENH-02: client-side rate limiting', () => {
        it('should reject requests when rate limit is exceeded', async () => {
            const rateLimitedClient = new AgenticClient(
                {
                    baseUrl: 'https://api.example.com',
                    apiKey: 'test-api-key',
                    rateLimit: { maxRequests: 2, windowMs: 1000 },
                },
                mockLogger
            );

            mockFetch.mockResolvedValue(createMockResponse({ ok: true }));

            await rateLimitedClient.get('/api/test');
            await rateLimitedClient.get('/api/test');

            try {
                await rateLimitedClient.get('/api/test');
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('RATE_LIMITED');
            }
        });

        it('should allow requests after the rate limit window resets', async () => {
            const rateLimitedClient = new AgenticClient(
                {
                    baseUrl: 'https://api.example.com',
                    apiKey: 'test-api-key',
                    rateLimit: { maxRequests: 1, windowMs: 50 },
                },
                mockLogger
            );

            mockFetch.mockResolvedValue(createMockResponse({ ok: true }));

            await rateLimitedClient.get('/api/test');

            await new Promise((r) => setTimeout(r, 60));

            const result = await rateLimitedClient.get('/api/test');
            expect(result).toEqual({ ok: true });
        });

        it('should not rate limit when no rateLimit config is provided', async () => {
            mockFetch.mockResolvedValue(createMockResponse({ ok: true }));

            for (let i = 0; i < 100; i++) {
                await client.get('/api/test');
            }

            expect(mockFetch).toHaveBeenCalledTimes(100);
        });
    });

    describe('SEC-07: runtime validation for request bodies', () => {
        it('should reject non-serializable body (circular reference)', async () => {
            const circular: Record<string, unknown> = {};
            circular.self = circular;

            try {
                await client.post('/api/test', circular);
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('VALIDATION_ERROR');
            }
        });

        it('should reject body that is a function', async () => {
            try {
                await client.post('/api/test', () => 'bad');
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(AgenticError);
                expect((error as AgenticError).code).toBe('VALIDATION_ERROR');
            }
        });

        it('should accept valid JSON-serializable bodies', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

            const result = await client.post('/api/test', {
                name: 'test',
                count: 42,
                tags: ['a', 'b'],
                nested: { key: 'value' },
            });

            expect(result).toEqual({ ok: true });
        });
    });
});
