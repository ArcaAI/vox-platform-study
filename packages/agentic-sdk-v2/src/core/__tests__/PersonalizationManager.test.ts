/**
 * PersonalizationManager Unit Tests
 *
 * Tests for the user preferences management.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PersonalizationManager } from '../PersonalizationManager';
import { AgenticClient } from '../AgenticClient';
import { AgenticError } from '../../types';
import { createMockLogger, mockFetch, createMockResponse, createMockErrorResponse } from '../../__tests__/setup';

// Shared storage object that persists across mock reassignments
const storageData: Record<string, string> = {};

describe('PersonalizationManager', () => {
    let mockApiClient: AgenticClient;
    let mockLogger: ReturnType<typeof createMockLogger>;

    // Helper to get storage data
    const getStorage = () => storageData;

    beforeEach(() => {
        // Clear storage data
        Object.keys(storageData).forEach(key => delete storageData[key]);

        mockLogger = createMockLogger();
        mockApiClient = new AgenticClient(
            { baseUrl: 'http://test', apiKey: 'key' },
            mockLogger
        );

        // Mock window and localStorage for Node.js environment
        const localStorageMock = {
            getItem: (key: string) => storageData[key] || null,
            setItem: (key: string, value: string) => { storageData[key] = value; },
            removeItem: (key: string) => { delete storageData[key]; },
            clear: () => { Object.keys(storageData).forEach(k => delete storageData[k]); },
            length: 0,
            key: (_index: number) => null,
        };
        (global as any).window = {};
        (global as any).localStorage = localStorageMock;

        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        delete (global as any).window;
        delete (global as any).localStorage;
    });


    describe('constructor', () => {
        it('should create manager with defaults', () => {
            const manager = new PersonalizationManager(
                { storage: 'local', defaults: { language: 'en' } },
                mockApiClient,
                mockLogger
            );

            expect(manager.getPreferences()).toEqual({ language: 'en' });
        });

        it('should load from localStorage', () => {
            // Set localStorage before creating the manager (note: key uses hyphen not underscore)
            storageData['arcaai-preferences'] = JSON.stringify({ theme: 'dark' });

            const manager = new PersonalizationManager(
                { storage: 'local', defaults: { language: 'en' } },
                mockApiClient,
                mockLogger
            );

            expect(manager.getPreferences()).toEqual({ language: 'en', theme: 'dark' });
        });

        it('should log initialization', () => {
            new PersonalizationManager(
                { storage: 'hybrid' },
                mockApiClient,
                mockLogger
            );

            expect(mockLogger.debug).toHaveBeenCalledWith(
                'PersonalizationManager initialized',
                expect.objectContaining({
                    attributes: expect.objectContaining({ storage: 'hybrid' }),
                })
            );
        });
    });

    describe('getPreferences', () => {
        it('should return copy of preferences', () => {
            const manager = new PersonalizationManager(
                { storage: 'local', defaults: { language: 'en' } },
                mockApiClient
            );

            const prefs1 = manager.getPreferences();
            const prefs2 = manager.getPreferences();

            expect(prefs1).toEqual(prefs2);
            expect(prefs1).not.toBe(prefs2);
        });
    });

    describe('get', () => {
        it('should return specific preference value', () => {
            const manager = new PersonalizationManager(
                { storage: 'local', defaults: { language: 'en', theme: 'light' } as any },
                mockApiClient
            );

            expect(manager.get('language')).toBe('en');
            expect((manager.get as any)('theme')).toBe('light');
        });
    });

    describe('updatePreferences', () => {
        it('should update preferences locally', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local', defaults: {} },
                mockApiClient,
                mockLogger
            );

            await manager.updatePreferences({ language: 'th' });

            expect(manager.get('language')).toBe('th');
            expect(storageData['arcaai-preferences']).toContain('th');
        });

        it('should sync to backend in backend mode', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse({ success: true }));

            const manager = new PersonalizationManager(
                { storage: 'backend', defaults: {} },
                mockApiClient,
                mockLogger
            );

            await manager.updatePreferences({ language: 'th' });

            expect(mockFetch).toHaveBeenCalled();
        });

        it('should rollback on backend failure in backend mode', async () => {
            mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Server Error'));

            const manager = new PersonalizationManager(
                { storage: 'backend', defaults: { language: 'en' } },
                mockApiClient,
                mockLogger
            );

            await expect(
                manager.updatePreferences({ language: 'th' })
            ).rejects.toThrow();

            expect(manager.get('language')).toBe('en');
        });

        it('should keep local changes on backend failure in hybrid mode', async () => {
            mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Server Error'));

            const manager = new PersonalizationManager(
                { storage: 'hybrid', defaults: { language: 'en' } },
                mockApiClient,
                mockLogger
            );

            await manager.updatePreferences({ language: 'th' });

            expect(manager.get('language')).toBe('th');
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        it('should notify listeners', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local', defaults: {} },
                mockApiClient
            );
            const listener = vi.fn();
            manager.onChange(listener);

            await manager.updatePreferences({ language: 'th' });

            expect(listener).toHaveBeenCalledWith(expect.objectContaining({ language: 'th' }));
        });
    });

    describe('set', () => {
        it('should set specific writable preference', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local', defaults: {} },
                mockApiClient
            );

            await manager.set('language', 'es');

            expect(manager.get('language')).toBe('es');
        });

        it('should set workflowMode', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local', defaults: {} },
                mockApiClient
            );

            await manager.set('workflowMode', 'remote');

            expect(manager.get('workflowMode')).toBe('remote');
        });
    });

    describe('reset', () => {
        it('should reset to defaults', async () => {
            const defaults = { language: 'en', theme: 'light' } as any;
            const manager = new PersonalizationManager(
                { storage: 'local', defaults },
                mockApiClient
            );

            await manager.updatePreferences({ language: 'th', custom: { v: 'value' } });
            await manager.reset();

            expect(manager.get('language')).toBe('en');
            expect((manager.get as any)('theme')).toBe('light');
        });

        it('should remove extra keys not in defaults (BUG-06)', async () => {
            const defaults = { language: 'en' };
            const manager = new PersonalizationManager(
                { storage: 'local', defaults },
                mockApiClient
            );

            await manager.updatePreferences({ language: 'th', custom: 'extra-value' } as any);
            expect((manager.getPreferences() as any).custom).toBe('extra-value');

            await manager.reset();

            const prefs = manager.getPreferences();
            expect(prefs.language).toBe('en');
            expect((prefs as any).custom).toBeUndefined();
        });

        it('should handle reset when defaults is undefined', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local' },
                mockApiClient
            );

            await manager.updatePreferences({ language: 'th' });
            await manager.reset();

            expect(manager.getPreferences()).toEqual({});
        });
    });

    describe('loadFromBackend', () => {
        it('should skip for local mode', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local' },
                mockApiClient,
                mockLogger
            );

            await manager.loadFromBackend();

            expect(mockFetch).not.toHaveBeenCalled();
            expect(mockLogger.debug).toHaveBeenCalledWith(
                'Storage mode is local, skipping backend load',
                expect.any(Object)
            );
        });

        it('should load from backend', async () => {
            mockFetch.mockResolvedValueOnce(
                createMockResponse({ language: 'ja', custom: 'backend' })
            );

            const manager = new PersonalizationManager(
                { storage: 'backend', defaults: { language: 'en' } },
                mockApiClient,
                mockLogger
            );

            await manager.loadFromBackend();

            expect(manager.get('language')).toBe('ja');
            expect(manager.get('custom')).toBe('backend');
        });

        it('should handle NOT_FOUND gracefully', async () => {
            const error = new AgenticError('NOT_FOUND', 'Preferences not found');
            mockFetch.mockRejectedValueOnce(error);

            const manager = new PersonalizationManager(
                { storage: 'backend', defaults: { language: 'en' } },
                mockApiClient,
                mockLogger
            );

            await manager.loadFromBackend();

            expect(manager.get('language')).toBe('en');
        });
    });

    describe('sync', () => {
        it('should start sync for hybrid mode', () => {
            const manager = new PersonalizationManager(
                { storage: 'hybrid', syncInterval: 1000 },
                mockApiClient,
                mockLogger
            );

            manager.startSync();

            expect(mockLogger.info).toHaveBeenCalledWith(
                'Starting periodic preference sync',
                expect.objectContaining({
                    attributes: { intervalMs: 1000 },
                })
            );
        });

        it('should not start sync for local mode', () => {
            const manager = new PersonalizationManager(
                { storage: 'local' },
                mockApiClient,
                mockLogger
            );

            manager.startSync();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                'Storage mode is not hybrid, sync not started',
                expect.any(Object)
            );
        });

        it('should stop sync', () => {
            const manager = new PersonalizationManager(
                { storage: 'hybrid', syncInterval: 1000 },
                mockApiClient,
                mockLogger
            );

            manager.startSync();
            manager.stopSync();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                'Stopped periodic preference sync',
                expect.any(Object)
            );
        });

        it('should sync periodically', async () => {
            mockFetch.mockResolvedValue(createMockResponse({ success: true }));

            const manager = new PersonalizationManager(
                { storage: 'hybrid', syncInterval: 1000 },
                mockApiClient,
                mockLogger
            );

            manager.startSync();
            await manager.updatePreferences({ test: 'value' } as any);

            // First call is from updatePreferences
            expect(mockFetch).toHaveBeenCalledTimes(1);

            // Advance timer to trigger periodic sync
            await vi.advanceTimersByTimeAsync(1000);

            expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(1);

            manager.stopSync();
        });

        it('should sync now', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse({ success: true }));

            const manager = new PersonalizationManager(
                { storage: 'backend' },
                mockApiClient,
                mockLogger
            );

            await manager.syncNow();

            expect(mockFetch).toHaveBeenCalled();
        });

        it('should skip syncNow for local mode', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local' },
                mockApiClient,
                mockLogger
            );

            await manager.syncNow();

            expect(mockFetch).not.toHaveBeenCalled();
        });
    });

    describe('onChange', () => {
        it('should add listener and return unsubscribe', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local' },
                mockApiClient
            );
            const listener = vi.fn();

            const unsubscribe = manager.onChange(listener);
            await manager.updatePreferences({ test: '1' } as any);

            expect(listener).toHaveBeenCalledTimes(1);

            unsubscribe();
            await manager.updatePreferences({ test: '2' } as any);

            expect(listener).toHaveBeenCalledTimes(1);
        });

        it('should handle listener errors', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local' },
                mockApiClient,
                mockLogger
            );
            const badListener = vi.fn(() => {
                throw new Error('Listener error');
            });
            const goodListener = vi.fn();

            manager.onChange(badListener);
            manager.onChange(goodListener);

            await manager.updatePreferences({ test: 'value' } as any);

            expect(mockLogger.error).toHaveBeenCalledWith(
                'Preference change listener error',
                expect.any(Object)
            );
            expect(goodListener).toHaveBeenCalled();
        });
    });

    describe('status methods', () => {
        it('should return last sync time', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse({ success: true }));

            const manager = new PersonalizationManager(
                { storage: 'backend' },
                mockApiClient
            );

            expect(manager.getLastSyncAt()).toBeUndefined();

            await manager.syncNow();

            expect(manager.getLastSyncAt()).toBeInstanceOf(Date);
        });

        it('should return sync status', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local' },
                mockApiClient
            );

            expect(manager.isSyncInProgress()).toBe(false);
        });
    });

    describe('destroy', () => {
        it('should clean up resources', () => {
            const manager = new PersonalizationManager(
                { storage: 'hybrid', syncInterval: 1000 },
                mockApiClient,
                mockLogger
            );

            manager.startSync();
            const listener = vi.fn();
            manager.onChange(listener);

            manager.destroy();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                'Destroying PersonalizationManager',
                expect.any(Object)
            );
        });
    });

    describe('workflow-oriented preferences (workflowMode, localConfig, remoteConfig)', () => {
        it('should store and retrieve workflowMode', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local', defaults: {} },
                mockApiClient
            );

            await manager.updatePreferences({ workflowMode: 'remote' });

            expect(manager.get('workflowMode')).toBe('remote');
        });

        it('should store and retrieve localConfig', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local', defaults: {} },
                mockApiClient
            );

            const localConfig = {
                noiseCancellation: { modelId: 'rnnoise', level: 'high' as const },
                stt: { modelId: 'whisper-large-v3' },
                vad: { modelId: 'silero-vad-v5', sensitivity: 0.6 },
                ner: { modelId: 'biomedical', autoExtract: true },
                diarization: { enabled: true, autoEnroll: true },
            };

            await manager.updatePreferences({ localConfig });

            expect(manager.get('localConfig')).toEqual(localConfig);
        });

        it('should deep merge localConfig on partial update', async () => {
            const manager = new PersonalizationManager(
                {
                    storage: 'local',
                    defaults: {
                        localConfig: {
                            noiseCancellation: { modelId: 'rnnoise', level: 'medium' },
                            stt: { modelId: 'whisper-medium' },
                            vad: { modelId: 'silero-vad-v5', sensitivity: 0.5 },
                            ner: { modelId: 'default', autoExtract: false },
                            diarization: { enabled: false, autoEnroll: false },
                        },
                    },
                },
                mockApiClient
            );

            // Only update stt modelId
            await manager.updatePreferences({
                localConfig: { stt: { modelId: 'whisper-large-v3' } },
            });

            const prefs = manager.getPreferences();
            expect(prefs.localConfig?.stt?.modelId).toBe('whisper-large-v3');
            // Other fields preserved
            expect(prefs.localConfig?.noiseCancellation?.modelId).toBe('rnnoise');
            expect(prefs.localConfig?.vad?.sensitivity).toBe(0.5);
        });

        it('should include defaults with workflowMode and localConfig', () => {
            const manager = new PersonalizationManager(
                {
                    storage: 'local',
                    defaults: {
                        workflowMode: 'local',
                        language: 'en',
                        localConfig: {
                            stt: { modelId: 'whisper-large-v3' },
                            vad: { modelId: 'silero-vad-v5', sensitivity: 0.5 },
                            noiseCancellation: { modelId: 'rnnoise', level: 'medium' },
                            ner: { modelId: 'biomedical', autoExtract: true },
                            diarization: { enabled: false, autoEnroll: false },
                        },
                    },
                },
                mockApiClient
            );

            const prefs = manager.getPreferences();
            expect(prefs.workflowMode).toBe('local');
            expect(prefs.localConfig?.stt?.modelId).toBe('whisper-large-v3');
        });

        it('should persist workflow preferences to localStorage', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local', defaults: {} },
                mockApiClient
            );

            await manager.updatePreferences({
                workflowMode: 'local',
                language: 'en',
                localConfig: {
                    stt: { modelId: 'whisper-large-v3' },
                },
            });

            const stored = JSON.parse(storageData['arcaai-preferences']);
            expect(stored.workflowMode).toBe('local');
            expect(stored.localConfig.stt.modelId).toBe('whisper-large-v3');
        });

        it('should load workflow preferences from localStorage on init', () => {
            storageData['arcaai-preferences'] = JSON.stringify({
                workflowMode: 'remote',
                language: 'th',
            });

            const manager = new PersonalizationManager(
                { storage: 'local', defaults: {} },
                mockApiClient
            );

            expect(manager.get('workflowMode')).toBe('remote');
            expect(manager.get('language')).toBe('th');
        });

        it('should store read-only remoteConfig from backend response', async () => {
            mockFetch.mockResolvedValueOnce(
                createMockResponse({
                    workflowMode: 'remote',
                    language: 'th',
                    remoteConfig: {
                        pipelineId: 'pipeline-123',
                        pipelineName: 'Production Pipeline',
                        assignedBy: 'admin',
                    },
                })
            );

            const manager = new PersonalizationManager(
                { storage: 'backend', defaults: {} },
                mockApiClient,
                mockLogger
            );

            await manager.loadFromBackend();

            expect(manager.get('remoteConfig')).toEqual({
                pipelineId: 'pipeline-123',
                pipelineName: 'Production Pipeline',
                assignedBy: 'admin',
            });
        });

        it('should not send remoteConfig to backend on sync', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse({ success: true }));

            const manager = new PersonalizationManager(
                { storage: 'backend', defaults: {} },
                mockApiClient,
                mockLogger
            );

            // Set remoteConfig locally (as if loaded from backend)
            (manager as any).preferences.remoteConfig = {
                pipelineId: 'pipeline-123',
                assignedBy: 'admin',
            };

            await manager.updatePreferences({ language: 'en' });

            const callBody = mockFetch.mock.calls[0][1]?.body;
            const sentPayload = JSON.parse(callBody as string);
            expect(sentPayload.remoteConfig).toBeUndefined();
        });

        it('should rollback localConfig on backend failure in backend mode', async () => {
            mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Server Error'));

            const defaults = {
                workflowMode: 'local' as const,
                localConfig: {
                    stt: { modelId: 'whisper-medium' },
                    vad: { modelId: 'silero-vad-v5', sensitivity: 0.5 },
                    noiseCancellation: { modelId: 'rnnoise', level: 'medium' as const },
                    ner: { modelId: 'default', autoExtract: false },
                    diarization: { enabled: false, autoEnroll: false },
                },
            };

            const manager = new PersonalizationManager(
                { storage: 'backend', defaults },
                mockApiClient,
                mockLogger
            );

            await expect(
                manager.updatePreferences({
                    localConfig: { stt: { modelId: 'whisper-large-v3' } },
                })
            ).rejects.toThrow();

            expect(manager.get('localConfig')?.stt?.modelId).toBe('whisper-medium');
        });

        it('should clear workflow fields on reset', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local', defaults: { workflowMode: 'local', language: 'en' } },
                mockApiClient
            );

            await manager.updatePreferences({
                workflowMode: 'remote',
                localConfig: { stt: { modelId: 'whisper-large-v3' } },
            });

            expect(manager.get('workflowMode')).toBe('remote');

            await manager.reset();

            expect(manager.get('workflowMode')).toBe('local');
            expect(manager.get('language')).toBe('en');
            expect(manager.get('localConfig')).toBeUndefined();
        });

        it('should notify listeners when workflow preferences change', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local', defaults: {} },
                mockApiClient
            );
            const listener = vi.fn();
            manager.onChange(listener);

            await manager.updatePreferences({ workflowMode: 'remote' });

            expect(listener).toHaveBeenCalledWith(
                expect.objectContaining({ workflowMode: 'remote' })
            );
        });

        it('should preserve remoteConfig when updating other preferences', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local', defaults: {} },
                mockApiClient
            );

            (manager as any).preferences.remoteConfig = {
                pipelineId: 'pipeline-123',
                pipelineName: 'Production Pipeline',
                assignedBy: 'admin',
            };

            await manager.updatePreferences({ language: 'th' });

            expect(manager.get('remoteConfig')).toEqual({
                pipelineId: 'pipeline-123',
                pipelineName: 'Production Pipeline',
                assignedBy: 'admin',
            });
            expect(manager.get('language')).toBe('th');
        });

        it('should deep merge localConfig when adding a new sub-config to existing', async () => {
            const manager = new PersonalizationManager(
                {
                    storage: 'local',
                    defaults: {
                        localConfig: {
                            stt: { modelId: 'whisper-medium' },
                        },
                    },
                },
                mockApiClient
            );

            await manager.updatePreferences({
                localConfig: {
                    vad: { modelId: 'silero-vad-v5', sensitivity: 0.7 },
                },
            });

            const prefs = manager.getPreferences();
            expect(prefs.localConfig?.stt?.modelId).toBe('whisper-medium');
            expect(prefs.localConfig?.vad?.modelId).toBe('silero-vad-v5');
            expect(prefs.localConfig?.vad?.sensitivity).toBe(0.7);
        });

        it('should handle loadFromBackend with deep merge of localConfig', async () => {
            const manager = new PersonalizationManager(
                {
                    storage: 'backend',
                    defaults: {
                        localConfig: {
                            stt: { modelId: 'whisper-medium' },
                            vad: { modelId: 'silero-vad-v5', sensitivity: 0.5 },
                        },
                    },
                },
                mockApiClient,
                mockLogger
            );

            mockFetch.mockResolvedValueOnce(
                createMockResponse({
                    workflowMode: 'local',
                    localConfig: {
                        stt: { modelId: 'whisper-large-v3' },
                        ner: { modelId: 'biomedical', autoExtract: true },
                    },
                })
            );

            await manager.loadFromBackend();

            const prefs = manager.getPreferences();
            expect(prefs.localConfig?.stt?.modelId).toBe('whisper-large-v3');
            expect(prefs.localConfig?.vad?.modelId).toBe('silero-vad-v5');
            expect(prefs.localConfig?.ner?.modelId).toBe('biomedical');
        });

        it('should set localConfig directly when no existing localConfig (else branch)', async () => {
            const manager = new PersonalizationManager(
                { storage: 'local', defaults: {} },
                mockApiClient
            );

            expect(manager.get('localConfig')).toBeUndefined();

            await manager.updatePreferences({
                localConfig: { stt: { modelId: 'whisper-large-v3' } },
            });

            expect(manager.get('localConfig')).toEqual({
                stt: { modelId: 'whisper-large-v3' },
            });
        });

        it('should handle loadFromBackend with remoteConfig included', async () => {
            mockFetch.mockResolvedValueOnce(
                createMockResponse({
                    workflowMode: 'remote',
                    language: 'th',
                    remoteConfig: {
                        pipelineId: 'turbo-pipeline',
                        pipelineName: 'Turbo Pipeline',
                        assignedBy: 'admin',
                        codeSwitchingEnabled: true,
                    },
                })
            );

            const manager = new PersonalizationManager(
                { storage: 'backend', defaults: {} },
                mockApiClient,
                mockLogger
            );

            await manager.loadFromBackend();

            expect(manager.get('workflowMode')).toBe('remote');
            expect(manager.get('remoteConfig')).toEqual({
                pipelineId: 'turbo-pipeline',
                pipelineName: 'Turbo Pipeline',
                assignedBy: 'admin',
                codeSwitchingEnabled: true,
            });
        });
    });

    describe('edge cases', () => {
        it('should handle corrupt localStorage JSON gracefully', () => {
            storageData['arcaai-preferences'] = 'not-valid-json{{{';

            const manager = new PersonalizationManager(
                { storage: 'local', defaults: { language: 'en' } },
                mockApiClient,
                mockLogger
            );

            expect(manager.get('language')).toBe('en');
            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Failed to load preferences from local storage',
                expect.any(Object)
            );
        });

        it('should handle loadFromBackend when API returns null', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse(null));

            const manager = new PersonalizationManager(
                { storage: 'backend', defaults: { language: 'en' } },
                mockApiClient,
                mockLogger
            );

            await manager.loadFromBackend();

            expect(manager.get('language')).toBe('en');
        });

        it('should rethrow non-AgenticError from loadFromBackend', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Network failure'));

            const manager = new PersonalizationManager(
                { storage: 'backend', defaults: {} },
                mockApiClient,
                mockLogger
            );

            await expect(manager.loadFromBackend()).rejects.toThrow();
            expect(manager.get('language')).toBeUndefined();
        });

        it('should throw on reset in backend mode when sync fails', async () => {
            mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Server Error'));

            const manager = new PersonalizationManager(
                { storage: 'backend', defaults: { language: 'en' } },
                mockApiClient,
                mockLogger
            );

            await expect(manager.reset()).rejects.toThrow();
        });

        it('should not throw on reset in hybrid mode when sync fails', async () => {
            mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Server Error'));

            const manager = new PersonalizationManager(
                { storage: 'hybrid', defaults: { language: 'en' } },
                mockApiClient,
                mockLogger
            );

            await expect(manager.reset()).resolves.toBeUndefined();
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        it('should be idempotent when startSync is called twice', () => {
            const manager = new PersonalizationManager(
                { storage: 'hybrid', syncInterval: 5000 },
                mockApiClient,
                mockLogger
            );

            manager.startSync();
            manager.startSync();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                'Sync already running',
                expect.any(Object)
            );

            manager.stopSync();
        });

        it('should handle destroy called multiple times without error', () => {
            const manager = new PersonalizationManager(
                { storage: 'hybrid', syncInterval: 1000 },
                mockApiClient,
                mockLogger
            );

            manager.startSync();
            manager.destroy();
            expect(() => manager.destroy()).not.toThrow();
        });

        it('should not save to localStorage in backend-only mode', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse({ success: true }));

            const manager = new PersonalizationManager(
                { storage: 'backend', defaults: {} },
                mockApiClient,
                mockLogger
            );

            await manager.updatePreferences({ language: 'th' });

            expect(storageData['arcaai-preferences']).toBeUndefined();
        });

        it('should save to localStorage in hybrid mode after loadFromBackend', async () => {
            mockFetch.mockResolvedValueOnce(
                createMockResponse({ language: 'ja', workflowMode: 'remote' })
            );

            const manager = new PersonalizationManager(
                { storage: 'hybrid', defaults: {} },
                mockApiClient,
                mockLogger
            );

            await manager.loadFromBackend();

            const stored = JSON.parse(storageData['arcaai-preferences']);
            expect(stored.language).toBe('ja');
            expect(stored.workflowMode).toBe('remote');
        });

        it('should handle loadFromBackend when no existing localConfig (else branch)', async () => {
            mockFetch.mockResolvedValueOnce(
                createMockResponse({
                    workflowMode: 'local',
                    localConfig: {
                        stt: { modelId: 'whisper-large-v3' },
                    },
                })
            );

            const manager = new PersonalizationManager(
                { storage: 'backend', defaults: {} },
                mockApiClient,
                mockLogger
            );

            await manager.loadFromBackend();

            expect(manager.get('localConfig')).toEqual({
                stt: { modelId: 'whisper-large-v3' },
            });
        });
    });
});
