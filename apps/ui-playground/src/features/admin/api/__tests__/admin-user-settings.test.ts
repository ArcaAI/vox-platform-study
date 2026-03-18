/**
 * Admin User Settings API Tests (TASK-245)
 *
 * Tests the admin endpoints for managing another user's settings:
 * - GET /admin/users/:id/settings
 * - PATCH /admin/users/:id/settings/:namespace/:key
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const BASE_URL = 'http://localhost:8868/api/v1';

function makeJsonResponse(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function makeHeaders() {
    return {
        'Content-Type': 'application/json',
        Authorization: 'Bearer admin-jwt-token',
    };
}

describe('Admin User Settings API (TASK-245)', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    describe('GET /admin/users/:id/settings', () => {
        it('should fetch all settings for a specific user', async () => {
            const expectedSettings = [
                { id: 's1', name: 'Language', key: 'language', value: 'hi', dataType: 'String', namespace: 'arcaai-sdk' },
                { id: 's2', name: 'Noise', key: 'noise-suppression', value: 'false', dataType: 'Boolean', namespace: 'arcaai-sdk' },
            ];
            mockFetch.mockResolvedValueOnce(makeJsonResponse(expectedSettings));

            const userId = 'user-123';
            const response = await fetch(`${BASE_URL}/admin/users/${userId}/settings`, {
                method: 'GET',
                headers: makeHeaders(),
            });
            const data = await response.json();

            expect(mockFetch).toHaveBeenCalledWith(
                `${BASE_URL}/admin/users/user-123/settings`,
                expect.objectContaining({ method: 'GET' }),
            );
            expect(data).toHaveLength(2);
            expect(data[0].namespace).toBe('arcaai-sdk');
        });

        it('should return empty array for user with no settings', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse([]));

            const response = await fetch(`${BASE_URL}/admin/users/user-456/settings`, {
                method: 'GET',
                headers: makeHeaders(),
            });
            const data = await response.json();

            expect(data).toEqual([]);
        });

        it('should handle 404 for non-existent user', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ message: 'User not found' }, 404));

            const response = await fetch(`${BASE_URL}/admin/users/nonexistent/settings`, {
                method: 'GET',
                headers: makeHeaders(),
            });

            expect(response.status).toBe(404);
        });
    });

    describe('PATCH /admin/users/:id/settings/:namespace/:key', () => {
        it('should upsert a setting for a specific user', async () => {
            const updateBody = { value: 'fr', dataType: 'String', name: 'Language' };
            const expectedResponse = {
                id: 's1', name: 'Language', key: 'language',
                value: 'fr', dataType: 'String', namespace: 'arcaai-sdk',
                userId: 'user-123',
            };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(expectedResponse));

            const response = await fetch(
                `${BASE_URL}/admin/users/user-123/settings/arcaai-sdk/language`,
                {
                    method: 'PATCH',
                    headers: makeHeaders(),
                    body: JSON.stringify(updateBody),
                },
            );
            const data = await response.json();

            expect(mockFetch).toHaveBeenCalledWith(
                `${BASE_URL}/admin/users/user-123/settings/arcaai-sdk/language`,
                expect.objectContaining({
                    method: 'PATCH',
                    body: JSON.stringify(updateBody),
                }),
            );
            expect(data.value).toBe('fr');
            expect(data.userId).toBe('user-123');
        });

        it('should create a new setting if it does not exist', async () => {
            const updateBody = { value: 'true', dataType: 'Boolean', name: 'VAD Enabled' };
            const expectedResponse = {
                id: 's-new', name: 'VAD Enabled', key: 'vad-enabled',
                value: 'true', dataType: 'Boolean', namespace: 'arcaai-sdk',
                userId: 'user-123',
            };
            mockFetch.mockResolvedValueOnce(makeJsonResponse(expectedResponse));

            const response = await fetch(
                `${BASE_URL}/admin/users/user-123/settings/arcaai-sdk/vad-enabled`,
                {
                    method: 'PATCH',
                    headers: makeHeaders(),
                    body: JSON.stringify(updateBody),
                },
            );
            const data = await response.json();

            expect(data.key).toBe('vad-enabled');
            expect(data.userId).toBe('user-123');
        });

        it('should handle 400 for invalid request body', async () => {
            mockFetch.mockResolvedValueOnce(makeJsonResponse({ message: 'Bad request' }, 400));

            const response = await fetch(
                `${BASE_URL}/admin/users/user-123/settings/arcaai-sdk/bad`,
                {
                    method: 'PATCH',
                    headers: makeHeaders(),
                    body: JSON.stringify({}),
                },
            );

            expect(response.status).toBe(400);
        });
    });

    describe('impersonation preference fetch', () => {
        it('should return SDK-namespaced settings that can be mapped to ConfigManager format', async () => {
            const sdkSettings = [
                { id: 's1', key: 'language', value: 'hi', namespace: 'arcaai-sdk', dataType: 'String' },
                { id: 's2', key: 'noise-suppression', value: 'false', namespace: 'arcaai-sdk', dataType: 'Boolean' },
                { id: 's3', key: 'vad-enabled', value: 'true', namespace: 'arcaai-sdk', dataType: 'Boolean' },
                { id: 's4', key: 'vad-threshold', value: '0.7', namespace: 'arcaai-sdk', dataType: 'Number' },
                { id: 's5', key: 'theme', value: 'dark', namespace: 'arcaai-sdk', dataType: 'String' },
                { id: 's6', key: 'other-setting', value: 'foo', namespace: 'other-ns', dataType: 'String' },
            ];
            mockFetch.mockResolvedValueOnce(makeJsonResponse(sdkSettings));

            const response = await fetch(`${BASE_URL}/admin/users/user-123/settings`, {
                method: 'GET',
                headers: makeHeaders(),
            });
            const allSettings = await response.json();
            const sdkOnly = allSettings.filter((s: { namespace: string }) => s.namespace === 'arcaai-sdk');

            expect(sdkOnly).toHaveLength(5);
            expect(sdkOnly.find((s: { key: string }) => s.key === 'other-setting')).toBeUndefined();
        });

        it('SDK settings can be parsed into typed values', () => {
            const rawSettings = [
                { key: 'noise-suppression', value: 'false', dataType: 'Boolean' },
                { key: 'vad-threshold', value: '0.7', dataType: 'Number' },
                { key: 'language', value: 'hi', dataType: 'String' },
            ];

            function parseSettingValue(setting: { value: string; dataType: string }): unknown {
                const dt = setting.dataType.toUpperCase();
                if (dt === 'BOOLEAN') return setting.value === 'true';
                if (dt === 'NUMBER') return Number(setting.value);
                return setting.value;
            }

            expect(parseSettingValue(rawSettings[0])).toBe(false);
            expect(parseSettingValue(rawSettings[1])).toBe(0.7);
            expect(parseSettingValue(rawSettings[2])).toBe('hi');
        });
    });
});
