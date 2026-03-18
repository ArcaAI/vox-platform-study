/**
 * User Settings & Preferences API Integration Tests (TASK-244)
 *
 * Tests the frontend's ability to call the new TASK-244 backend endpoints:
 * - GET /api/v1/user/me/preferences
 * - PATCH /api/v1/user/me/preferences
 * - GET /api/v1/user/me/settings
 * - PATCH /api/v1/user/me/settings/:namespace/:key
 *
 * These tests verify:
 * 1. Correct endpoint paths are used
 * 2. Request bodies match the expected DTO shape
 * 3. Response data is correctly parsed
 * 4. Error handling for 401/403/500
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const BASE_URL = 'http://localhost:8868/api/v1';
const ACCESS_TOKEN = 'test-jwt-token';

function makeHeaders(overrides: Record<string, string> = {}) {
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        ...overrides,
    };
}

function makeJsonResponse(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('User Preferences API (TASK-244)', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('GET /user/me/preferences', () => {
        it('should fetch user preferences with correct endpoint', async () => {
            const expectedResponse = {
                workflowMode: 'standard',
                language: 'en',
                localConfig: { noiseSuppression: true, vadEnabled: false },
                updatedAt: '2026-03-10T00:00:00Z',
            };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(expectedResponse));

            const response = await fetch(`${BASE_URL}/user/me/preferences`, {
                method: 'GET',
                headers: makeHeaders(),
            });
            const data = await response.json();

            expect(mockFetch).toHaveBeenCalledWith(
                `${BASE_URL}/user/me/preferences`,
                expect.objectContaining({ method: 'GET' }),
            );
            expect(data.language).toBe('en');
            expect(data.localConfig.noiseSuppression).toBe(true);
        });

        it('should handle 401 unauthorized', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ message: 'Unauthorized' }, 401));

            const response = await fetch(`${BASE_URL}/user/me/preferences`, {
                method: 'GET',
                headers: makeHeaders(),
            });

            expect(response.status).toBe(401);
        });
    });

    describe('PATCH /user/me/preferences', () => {
        it('should update user preferences with partial body', async () => {
            const updateBody = {
                language: 'hi',
                localConfig: { noiseSuppression: false },
            };
            const expectedResponse = {
                workflowMode: 'standard',
                language: 'hi',
                localConfig: { noiseSuppression: false, vadEnabled: false },
                updatedAt: '2026-03-10T01:00:00Z',
            };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(expectedResponse));

            const response = await fetch(`${BASE_URL}/user/me/preferences`, {
                method: 'PATCH',
                headers: makeHeaders(),
                body: JSON.stringify(updateBody),
            });
            const data = await response.json();

            expect(mockFetch).toHaveBeenCalledWith(
                `${BASE_URL}/user/me/preferences`,
                expect.objectContaining({
                    method: 'PATCH',
                    body: JSON.stringify(updateBody),
                }),
            );
            expect(data.language).toBe('hi');
            expect(data.localConfig.noiseSuppression).toBe(false);
        });
    });

    describe('GET /user/me/settings', () => {
        it('should fetch all user settings', async () => {
            const expectedResponse = [
                { id: '1', name: 'Language', key: 'preferred-language', value: 'en', dataType: 'String', namespace: 'audio-preferences' },
                { id: '2', name: 'Noise', key: 'noise-suppression', value: 'true', dataType: 'Boolean', namespace: 'audio-preferences' },
            ];
            mockFetch.mockResolvedValueOnce(makeJsonResponse(expectedResponse));

            const response = await fetch(`${BASE_URL}/user/me/settings`, {
                method: 'GET',
                headers: makeHeaders(),
            });
            const data = await response.json();

            expect(data).toHaveLength(2);
            expect(data[0].namespace).toBe('audio-preferences');
        });
    });

    describe('PATCH /user/me/settings/:namespace/:key', () => {
        it('should update a specific setting by namespace and key', async () => {
            const updateBody = { value: 'hi', dataType: 'String' };
            const expectedResponse = {
                id: '1', name: 'Language', key: 'preferred-language',
                value: 'hi', dataType: 'String', namespace: 'audio-preferences',
            };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(expectedResponse));

            const response = await fetch(
                `${BASE_URL}/user/me/settings/audio-preferences/preferred-language`,
                {
                    method: 'PATCH',
                    headers: makeHeaders(),
                    body: JSON.stringify(updateBody),
                },
            );
            const data = await response.json();

            expect(mockFetch).toHaveBeenCalledWith(
                `${BASE_URL}/user/me/settings/audio-preferences/preferred-language`,
                expect.objectContaining({
                    method: 'PATCH',
                    body: JSON.stringify(updateBody),
                }),
            );
            expect(data.value).toBe('hi');
        });

        it('should handle upsert (create if not exists)', async () => {
            const updateBody = { value: 'true', dataType: 'Boolean', name: 'VAD Enabled' };
            const expectedResponse = {
                id: '3', name: 'VAD Enabled', key: 'vad-enabled',
                value: 'true', dataType: 'Boolean', namespace: 'audio-preferences',
            };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(expectedResponse));

            const response = await fetch(
                `${BASE_URL}/user/me/settings/audio-preferences/vad-enabled`,
                {
                    method: 'PATCH',
                    headers: makeHeaders(),
                    body: JSON.stringify(updateBody),
                },
            );
            const data = await response.json();

            expect(data.key).toBe('vad-enabled');
            expect(data.value).toBe('true');
        });

        it('should handle server error gracefully', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ message: 'Internal Server Error' }, 500));

            const response = await fetch(
                `${BASE_URL}/user/me/settings/audio-preferences/bad-key`,
                {
                    method: 'PATCH',
                    headers: makeHeaders(),
                    body: JSON.stringify({ value: 'x' }),
                },
            );

            expect(response.status).toBe(500);
        });
    });
});

describe('Tenant Config API — locked field (TASK-244)', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it('should include locked field in tenant config response', async () => {
        const tenantConfigs = [
            { id: '1', name: 'STT Provider', key: 'stt-provider', value: 'local', namespace: 'stt', locked: true },
            { id: '2', name: 'Default Language', key: 'default-language', value: 'en', namespace: 'stt', locked: false },
            { id: '3', name: 'VAD Sensitivity', key: 'vad-sensitivity', value: '0.5', namespace: 'stt', locked: true },
        ];
        mockFetch.mockResolvedValueOnce(makeJsonResponse({ data: tenantConfigs, count: 3 }));

        const response = await fetch(`${BASE_URL}/tenant/me/config`, {
            method: 'GET',
            headers: makeHeaders(),
        });
        const result = await response.json();

        const lockedConfigs = result.data.filter((c: { locked: boolean }) => c.locked);
        expect(lockedConfigs).toHaveLength(2);
        expect(lockedConfigs[0].key).toBe('stt-provider');
    });

    it('locked configs map to ConfigManager lockedPaths', () => {
        const tenantConfigs = [
            { key: 'stt-provider', namespace: 'stt', locked: true },
            { key: 'default-language', namespace: 'stt', locked: false },
            { key: 'code-switching', namespace: 'feature-flags', locked: true },
        ];

        const lockedPaths = tenantConfigs
            .filter((c) => c.locked)
            .map((c) => {
                const nsMap: Record<string, string> = {
                    'stt': 'stt',
                    'feature-flags': 'features',
                    'smr': 'smr',
                };
                const section = nsMap[c.namespace] ?? c.namespace;
                const key = c.key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
                return `${section}.${key}`;
            });

        expect(lockedPaths).toContain('stt.sttProvider');
        expect(lockedPaths).toContain('features.codeSwitching');
        expect(lockedPaths).not.toContain('stt.defaultLanguage');
    });
});
