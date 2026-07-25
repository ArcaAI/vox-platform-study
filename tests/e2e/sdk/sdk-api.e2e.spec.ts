/**
 * SDK E2E Tests
 *
 * End-to-end tests for the Agentic SDK API integration.
 * These tests verify the SDK works correctly with the API gateway.
 */

import { test, expect, APIRequestContext, APIResponse } from '@playwright/test';

// Test configuration
const API_BASE_URL = process.env.API_URL || 'http://localhost:8968';
const TEST_API_KEY = process.env.TEST_API_KEY || 'test-api-key';
const TEST_TENANT_ID = process.env.TEST_TENANT_ID || 'test-tenant';

/**
 * SDK API E2E Tests
 *
 * Tests the SDK's expected API endpoints to ensure they work correctly.
 */
test.describe('SDK API Integration', () => {
    let request: APIRequestContext;

    test.beforeAll(async ({ playwright }) => {
        request = await playwright.request.newContext({
            baseURL: API_BASE_URL,
            extraHTTPHeaders: {
                'x-api-key': TEST_API_KEY,
                'x-tenant-id': TEST_TENANT_ID,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
        });
    });

    test.afterAll(async () => {
        await request.dispose();
    });

    test.describe('Health Check', () => {
        test('should return healthy status', async () => {
            const response = await request.get('/health');

            expect(response.ok()).toBeTruthy();
            const data = await response.json();
            expect(data.status).toBe('ok');
        });
    });

    test.describe('Consultation Endpoints', () => {
        let consultationId: string;

        test('should create a new consultation', async () => {
            const response = await request.post('/api/v1/consultations', {
                data: {
                    patientId: 'test-patient-001',
                    type: 'initial',
                    context: {
                        department: 'General',
                        notes: 'E2E test consultation',
                    },
                },
            });

            expect(response.ok(), `POST /consultations failed with ${response.status()}`).toBeTruthy();
            const data = await response.json();
            expect(data.id).toBeDefined();
            expect(data.patientId).toBe('test-patient-001');
            consultationId = data.id;
        });

        test('should get consultation by ID', async () => {
            expect(consultationId, 'consultationId not set — prior create test must have failed').toBeTruthy();

            const response = await request.get(`/api/v1/consultations/${consultationId}`);

            expect(response.ok()).toBeTruthy();
            const data = await response.json();
            expect(data.id).toBe(consultationId);
        });

        test('should end consultation', async () => {
            expect(consultationId, 'consultationId not set — prior create test must have failed').toBeTruthy();

            const response = await request.post(`/api/v1/consultations/${consultationId}/end`);

            expect(response.ok()).toBeTruthy();
        });
    });

    test.describe('Models Endpoints', () => {
        test('should list available models', async () => {
            const response = await request.get('/api/v1/models');

            expect(response.ok(), `GET /models failed with ${response.status()}`).toBeTruthy();
            const data = await response.json();
            expect(Array.isArray(data)).toBeTruthy();
        });

        test('should get model by ID', async () => {
            const response = await request.get('/api/v1/models/whisper-tiny');

            expect(response.ok(), `GET /models/whisper-tiny failed with ${response.status()}`).toBeTruthy();
            const data = await response.json();
            expect(data.id).toBe('whisper-tiny');
        });
    });

    test.describe('User Preferences Endpoints', () => {
        test('should get user preferences', async () => {
            const response = await request.get('/api/v1/users/me/preferences');

            expect(response.ok(), `GET /users/me/preferences failed with ${response.status()}`).toBeTruthy();
            const data = await response.json();
            expect(typeof data).toBe('object');
        });

        test('should update user preferences', async () => {
            const response = await request.patch('/api/v1/users/me/preferences', {
                data: {
                    language: 'en',
                    theme: 'light',
                },
            });

            expect(response.ok(), `PATCH /users/me/preferences failed with ${response.status()}`).toBeTruthy();
        });
    });

    test.describe('Context Endpoints', () => {
        test('should add context item', async () => {
            const response = await request.post('/api/v1/context', {
                data: {
                    type: 'transcription',
                    content: 'Test transcription content',
                    timestamp: new Date().toISOString(),
                    metadata: { source: 'e2e-test' },
                },
            });

            expect(response.ok(), `POST /context failed with ${response.status()}`).toBeTruthy();
            const data = await response.json();
            expect(data.id).toBeDefined();
        });

        test('should get context items', async () => {
            const response = await request.get('/api/v1/context');

            expect(response.ok(), `GET /context failed with ${response.status()}`).toBeTruthy();
            const data = await response.json();
            expect(Array.isArray(data)).toBeTruthy();
        });
    });

    test.describe('Summary Endpoints', () => {
        test('should request summary generation', async () => {
            const response = await request.post('/api/v1/summaries/generate', {
                data: {
                    consultationId: 'test-consultation-001',
                    type: 'pre-summary',
                    context: ['Test context 1', 'Test context 2'],
                },
            });

            expect(response.ok(), `POST /summaries/generate failed with ${response.status()}`).toBeTruthy();
        });

        test('should get summaries', async () => {
            const response = await request.get('/api/v1/summaries');

            expect(response.ok(), `GET /summaries failed with ${response.status()}`).toBeTruthy();
            const data = await response.json();
            expect(Array.isArray(data)).toBeTruthy();
        });
    });
});

/**
 * SDK WebSocket Integration Tests
 *
 * Tests WebSocket connections used by the SDK for real-time features.
 */
test.describe('SDK WebSocket Integration', () => {
    test('should connect to STT websocket', async () => {
        test.fail(true, 'WebSocket E2E tests not yet implemented — needs Playwright WebSocket helpers');
    });

    test('should connect to NLP websocket', async () => {
        test.fail(true, 'WebSocket E2E tests not yet implemented — needs Playwright WebSocket helpers');
    });
});

/**
 * SDK Authentication Tests
 *
 * Tests the SDK's authentication flow.
 */
test.describe('SDK Authentication', () => {
    test('should reject requests without API key', async ({ request }) => {
        const response = await request.get(`${API_BASE_URL}/api/v1/users/me`, {
            headers: {
                'Content-Type': 'application/json',
            },
        });

        // Should be 401 Unauthorized
        expect(response.status()).toBe(401);
    });

    test('should reject requests with invalid API key', async ({ request }) => {
        const response = await request.get(`${API_BASE_URL}/api/v1/users/me`, {
            headers: {
                'x-api-key': 'invalid-key',
                'Content-Type': 'application/json',
            },
        });

        // Should be 401 or 403
        expect([401, 403]).toContain(response.status());
    });
});

/**
 * SDK Rate Limiting Tests
 *
 * Tests the SDK handles rate limiting correctly.
 */
test.describe('SDK Rate Limiting', () => {
    test('should handle rate limiting gracefully', async ({ request }) => {
        // Send many requests quickly
        const promises = Array(100).fill(null).map(() =>
            request.get(`${API_BASE_URL}/api/v1/health`, {
                headers: {
                    'x-api-key': TEST_API_KEY,
                },
            })
        );

        const responses = await Promise.all(promises);

        // At least one should be rate limited (429)
        const rateLimited = responses.filter(r => r.status() === 429);
        expect(rateLimited.length).toBeGreaterThan(0);
    });
});

/**
 * SDK Error Handling Tests
 *
 * Tests the SDK's expected error responses.
 */
test.describe('SDK Error Handling', () => {
    let request: APIRequestContext;

    test.beforeAll(async ({ playwright }) => {
        request = await playwright.request.newContext({
            baseURL: API_BASE_URL,
            extraHTTPHeaders: {
                'x-api-key': TEST_API_KEY,
                'x-tenant-id': TEST_TENANT_ID,
                'Content-Type': 'application/json',
            },
        });
    });

    test.afterAll(async () => {
        await request.dispose();
    });

    test('should return 404 for non-existent resources', async () => {
        const response = await request.get('/api/v1/consultations/non-existent-id');

        // May be 404 or 403 depending on implementation
        expect([400, 404]).toContain(response.status());
    });

    test('should return 400 for invalid request body', async () => {
        const response = await request.post('/api/v1/consultations', {
            data: {
                // Missing required fields
                invalid: true,
            },
        });

        // Should be 400 Bad Request
        expect(response.status()).toBe(400);
    });

    test('should return proper error format', async () => {
        const response = await request.post('/api/v1/consultations', {
            data: {
                invalid: true,
            },
        });

        expect(response.status(), 'POST /consultations with invalid body should return 400').toBe(400);

        const data = await response.json();
        // Error response should have message
        expect(data.message || data.error).toBeDefined();
    });
});
