/**
 * UserPreferencesService Unit Tests
 *
 * Tests for the restructured workflow-oriented UserPreferencesService.
 *
 * Key behaviors tested:
 * - Workflow mode (local/remote) storage and retrieval
 * - localConfig stored as JSON, deep-merged on partial updates
 * - remoteConfig resolved at read time from admin settings (not stored)
 * - Pipeline resolution: per-user admin override > tenant-wide default
 * - Backward compatibility with legacy flat keys
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UserPreferencesService } from '../userPreferences.service';
import { ValueType, ResourceStatusType, TranscriptionMode } from '@arcaai/domains';

const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

const mockEventEmitter = {
    emit: vi.fn(),
};

const mockAppSettingsService = {
    getFromCache: vi.fn(),
    getValueFromCache: vi.fn(),
    getValueWithDefault: vi.fn(),
    hasSetting: vi.fn(),
    getAllKeys: vi.fn(),
    getCacheStats: vi.fn(),
    cacheAppSettings: vi.fn(),
    updateCacheAppSettings: vi.fn(),
    refreshCache: vi.fn(),
    stopCacheRefresh: vi.fn(),
    validateSettingValue: vi.fn(),
};

const mockAsrPipelineRepository = {
    findById: vi.fn(),
    findBySlug: vi.fn(),
    findDefault: vi.fn(),
};

const mockVoiceProfileRepository = {
    findActiveByUserId: vi.fn(),
    findAllByUserId: vi.fn(),
    activateById: vi.fn(),
    deactivateAllForUser: vi.fn(),
    createWithEmbedding: vi.fn(),
};

const createMockEntity = (overrides: Partial<{
    id: string;
    userId: string;
    key: string;
    value: string;
    dataType: ValueType;
    namespace: string;
    name: string;
    resourceStatus: ResourceStatusType;
    createdBy: string | null;
    updatedBy: string | null;
    updatedAt: Date;
    createdAt: Date;
}> = {}) => ({
    id: overrides.id ?? 'setting-id-1',
    userId: overrides.userId ?? 'user-id-1',
    key: overrides.key ?? 'language',
    value: overrides.value ?? 'en',
    dataType: overrides.dataType ?? ValueType.String,
    namespace: overrides.namespace ?? 'arcaai-sdk',
    name: overrides.name ?? 'SDK Preference: language',
    resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
    createdBy: overrides.createdBy ?? null,
    updatedBy: overrides.updatedBy ?? null,
    updatedAt: overrides.updatedAt ?? new Date('2026-01-28T10:00:00Z'),
    createdAt: overrides.createdAt ?? new Date('2026-01-28T09:00:00Z'),
});

const mockUserSettingsRepository = {
    findByUserAndNamespace: vi.fn(),
    findByUserKeyNamespace: vi.fn(),
    deleteByUserAndNamespace: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
};

// (A8/A-T6) — tenant frontend config drives the effective
// transcription mode + lock resolved server-side in getPreferences().
const mockTenantFrontendConfigRepository = {
    findByTenant: vi.fn(),
};

vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        UserSettingsFactory: {
            CreateUserSettings: vi.fn((data) => ({
                ...data,
                id: 'new-setting-id',
                resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                createdAt: new Date(),
                updatedAt: new Date(),
            })),
        },
    };
});

describe('UserPreferencesService', () => {
    let service: UserPreferencesService;

    beforeEach(() => {
        vi.clearAllMocks();

        // CLS serves both the user session ('user') and the active tenant
        // ('tenantId'). BaseService.tenantId reads the 'tenantId' key, which the
        // tenant-default resolution depends on.
        mockClsService.get.mockImplementation((key: string) => {
            if (key === 'user') return { id: 'user-id-1', tenantId: 'tenant-1' };
            if (key === 'tenantId') return 'tenant-1';
            return undefined;
        });

        // Default: no admin pipeline override, no tenant isDefault pipeline, no tenant default
        mockUserSettingsRepository.findByUserKeyNamespace.mockResolvedValue(null);
        mockAppSettingsService.getValueFromCache.mockReturnValue(null);
        mockAsrPipelineRepository.findById.mockResolvedValue(null);
        mockAsrPipelineRepository.findDefault.mockResolvedValue(null);
        mockVoiceProfileRepository.findActiveByUserId.mockResolvedValue(null);
        // Default: tenant has no frontend config row → effective mode falls back
        // to the schema default (BACKEND), unlocked.
        mockTenantFrontendConfigRepository.findByTenant.mockResolvedValue(null);

        service = new UserPreferencesService(
            mockUserSettingsRepository as any,
            mockAsrPipelineRepository as any,
            mockAppSettingsService as any,
            mockClsService as any,
            mockEventEmitter as any,
            mockVoiceProfileRepository as any,
            mockTenantFrontendConfigRepository as any,
        );
    });

    describe('getPreferences', () => {
        it('should return empty preferences when no settings exist', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);

            const result = await service.getPreferences();

            expect(result).toBeDefined();
            expect(result.updatedAt).toBeDefined();
            expect(result.workflowMode).toBeUndefined();
            expect(result.language).toBeUndefined();
            expect(result.localConfig).toBeUndefined();
            expect(mockUserSettingsRepository.findByUserAndNamespace).toHaveBeenCalledWith(
                'user-id-1',
                'arcaai-sdk',
            );
        });

        it('should aggregate workflow-oriented settings', async () => {
            const localConfig = {
                noiseCancellation: { modelId: 'rnnoise', level: 'high' },
                stt: { modelId: 'whisper-large-v3' },
                vad: { modelId: 'silero-vad-v5', sensitivity: 0.6 },
                ner: { modelId: 'biomedical', autoExtract: true },
                diarization: { enabled: true, autoEnroll: true },
            };
            const mockSettings = [
                createMockEntity({ key: 'workflowMode', value: 'local' }),
                createMockEntity({ key: 'language', value: 'en' }),
                createMockEntity({ key: 'dnaStyleId', value: 'clinical-concise-en' }),
                createMockEntity({
                    key: 'localConfig',
                    value: JSON.stringify(localConfig),
                    dataType: ValueType.Json,
                    updatedAt: new Date('2026-01-28T12:00:00Z'),
                }),
            ];
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue(mockSettings);

            const result = await service.getPreferences();

            expect(result.workflowMode).toBe('local');
            expect(result.language).toBe('en');
            expect(result.dnaStyleId).toBe('clinical-concise-en');
            expect(result.localConfig).toEqual(localConfig);
        });

        it('should parse custom JSON preferences', async () => {
            const customData = { theme: 'dark', fontSize: 14 };
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({
                    key: 'custom',
                    value: JSON.stringify(customData),
                    dataType: ValueType.Json,
                }),
            ]);

            const result = await service.getPreferences();

            expect(result.custom).toEqual(customData);
        });

        it('should handle invalid JSON in localConfig gracefully', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({
                    key: 'localConfig',
                    value: 'not-valid-json',
                    dataType: ValueType.Json,
                }),
            ]);

            const result = await service.getPreferences();

            expect(result.localConfig).toBeUndefined();
        });

        it('should use the latest updatedAt from settings', async () => {
            const latestDate = new Date('2026-01-28T15:00:00Z');
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({ key: 'language', value: 'en', updatedAt: new Date('2026-01-28T10:00:00Z') }),
                createMockEntity({ key: 'workflowMode', value: 'local', updatedAt: latestDate }),
            ]);

            const result = await service.getPreferences();

            expect(result.updatedAt).toBe(latestDate.toISOString());
        });

        it('should throw error when user context is not available', async () => {
            mockClsService.get.mockReturnValue(null);

            await expect(service.getPreferences()).rejects.toThrow('User context not available');
        });
    });

    describe('pipeline resolution (remoteConfig)', () => {
        it('should resolve remoteConfig from per-user admin override', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({ key: 'workflowMode', value: 'remote' }),
            ]);

            // Reset the default mock for findByUserKeyNamespace to handle both calls
            mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation(
                (_userId: string, key: string, namespace: string) => {
                    if (namespace === 'arcaai-admin' && key === 'assigned-pipeline') {
                        return Promise.resolve(
                            createMockEntity({
                                key: 'assigned-pipeline',
                                value: 'pipeline-123',
                                namespace: 'arcaai-admin',
                            }),
                        );
                    }
                    return Promise.resolve(null);
                },
            );

            mockAsrPipelineRepository.findById.mockResolvedValue({ name: 'Production Pipeline' });

            const result = await service.getPreferences();

            expect(result.remoteConfig).toEqual({
                pipelineId: 'pipeline-123',
                pipelineName: 'Production Pipeline',
                assignedBy: 'admin',
            });
        });

        it('should fall back to tenant-wide default when no admin override', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({ key: 'workflowMode', value: 'remote' }),
            ]);

            mockAppSettingsService.getValueFromCache.mockReturnValue('default-pipeline-456');
            mockAsrPipelineRepository.findById.mockResolvedValue({ name: 'Default Pipeline' });

            const result = await service.getPreferences();

            expect(result.remoteConfig).toEqual({
                pipelineId: 'default-pipeline-456',
                pipelineName: 'Default Pipeline',
                assignedBy: 'tenant-default',
            });
        });

        it('should return undefined remoteConfig when no pipeline is configured', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);

            const result = await service.getPreferences();

            expect(result.remoteConfig).toBeUndefined();
        });

        it('should handle pipeline name resolution failure gracefully', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
            mockAppSettingsService.getValueFromCache.mockReturnValue('pipeline-789');
            mockAsrPipelineRepository.findById.mockRejectedValue(new Error('DB error'));

            const result = await service.getPreferences();

            expect(result.remoteConfig).toEqual({
                pipelineId: 'pipeline-789',
                pipelineName: undefined,
                assignedBy: 'tenant-default',
            });
        });

        it('should prioritize admin override over tenant default', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);

            mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation(
                (_userId: string, key: string, namespace: string) => {
                    if (namespace === 'arcaai-admin' && key === 'assigned-pipeline') {
                        return Promise.resolve(
                            createMockEntity({
                                key: 'assigned-pipeline',
                                value: 'admin-pipeline',
                                namespace: 'arcaai-admin',
                            }),
                        );
                    }
                    return Promise.resolve(null);
                },
            );

            // Tenant default also exists
            mockAppSettingsService.getValueFromCache.mockReturnValue('tenant-default-pipeline');

            const result = await service.getPreferences();

            expect(result.remoteConfig?.pipelineId).toBe('admin-pipeline');
            expect(result.remoteConfig?.assignedBy).toBe('admin');
        });

        // Bugfix (impersonate doctor2): the admin override pointed at a
        // SYSTEM-owned catalog pipeline (…0002). SYSTEM pipelines are shared-READ
        // to every tenant (so findById resolves them), but they are NOT usable
        // for a customer tenant's streaming session — the streaming guard
        // (pipelineService.getById) rejects any pipeline whose tenantId != caller.
        // The resolver must therefore skip such an override and fall through to
        // the tenant's OWN default so the doctor still gets a working pipeline.
        it('should ignore a SYSTEM-catalog admin override and fall through to the tenant default', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
            mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation(
                (_userId: string, key: string, namespace: string) => {
                    if (namespace === 'arcaai-admin' && key === 'assigned-pipeline') {
                        return Promise.resolve(
                            createMockEntity({
                                key: 'assigned-pipeline',
                                value: '81000000-0000-0000-0001-000000000002',
                                namespace: 'arcaai-admin',
                            }),
                        );
                    }
                    return Promise.resolve(null);
                },
            );
            // Shared-read resolves the SYSTEM row (tenantId = SYSTEM_TENANT_ID).
            mockAsrPipelineRepository.findById.mockResolvedValue({
                name: 'Turbo Pipeline',
                tenantId: '00000000-0000-0000-0000-000000000000',
            });
            // The caller's own tenant HAS a default pipeline.
            mockAsrPipelineRepository.findDefault.mockResolvedValue({
                id: '81000000-0000-0000-0001-000000000401',
                name: 'Global Production Pipeline',
            });

            const result = await service.getPreferences();

            expect(result.remoteConfig).toEqual({
                pipelineId: '81000000-0000-0000-0001-000000000401',
                pipelineName: 'Global Production Pipeline',
                assignedBy: 'tenant-default',
            });
        });
    });

    // AsrPipeline.isDefault supersedes the GlobalSetting
    // slug default; admins control the per-tenant backend default. Additive +
    // backward-compatible: when a tenant has no isDefault pipeline we fall back
    // to the existing GlobalSetting behaviour, and the per-user admin override
    // still wins over everything.
    describe('tenant isDefault pipeline reconciliation (Q2)', () => {
        it('should prefer the tenant isDefault pipeline over the GlobalSetting default', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({ key: 'workflowMode', value: 'remote' }),
            ]);

            // Tenant has an isDefault pipeline...
            mockAsrPipelineRepository.findDefault.mockResolvedValue({
                id: 'tenant-default-pipeline-id',
                name: 'ArcaAI Production Pipeline',
            });
            // ...and a GlobalSetting default is ALSO configured (should be ignored).
            mockAppSettingsService.getValueFromCache.mockReturnValue('global-setting-pipeline');

            const result = await service.getPreferences();

            expect(mockAsrPipelineRepository.findDefault).toHaveBeenCalledWith('tenant-1');
            expect(result.remoteConfig).toEqual({
                pipelineId: 'tenant-default-pipeline-id',
                pipelineName: 'ArcaAI Production Pipeline',
                assignedBy: 'tenant-default',
            });
        });

        it('should fall back to the GlobalSetting default when no tenant isDefault pipeline exists', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({ key: 'workflowMode', value: 'remote' }),
            ]);

            mockAsrPipelineRepository.findDefault.mockResolvedValue(null);
            mockAppSettingsService.getValueFromCache.mockReturnValue('global-setting-pipeline');
            mockAsrPipelineRepository.findById.mockResolvedValue({ name: 'Global Default Pipeline' });

            const result = await service.getPreferences();

            expect(result.remoteConfig).toEqual({
                pipelineId: 'global-setting-pipeline',
                pipelineName: 'Global Default Pipeline',
                assignedBy: 'tenant-default',
            });
        });

        it('should still honor the per-user admin override ahead of the tenant isDefault pipeline', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
            mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation(
                (_userId: string, key: string, namespace: string) => {
                    if (namespace === 'arcaai-admin' && key === 'assigned-pipeline') {
                        return Promise.resolve(
                            createMockEntity({
                                key: 'assigned-pipeline',
                                value: 'admin-pipeline',
                                namespace: 'arcaai-admin',
                            }),
                        );
                    }
                    return Promise.resolve(null);
                },
            );
            mockAsrPipelineRepository.findById.mockResolvedValue({ name: 'Admin Pipeline' });
            // A tenant isDefault pipeline also exists, but the admin override wins.
            mockAsrPipelineRepository.findDefault.mockResolvedValue({
                id: 'tenant-default-pipeline-id',
                name: 'Tenant Default Pipeline',
            });

            const result = await service.getPreferences();

            expect(result.remoteConfig?.pipelineId).toBe('admin-pipeline');
            expect(result.remoteConfig?.assignedBy).toBe('admin');
            expect(mockAsrPipelineRepository.findDefault).not.toHaveBeenCalled();
        });

        it('should swallow a tenant-default lookup failure and fall back to the GlobalSetting', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
            mockAsrPipelineRepository.findDefault.mockRejectedValue(new Error('DB error'));
            mockAppSettingsService.getValueFromCache.mockReturnValue('global-setting-pipeline');
            mockAsrPipelineRepository.findById.mockResolvedValue({ name: 'Global Default Pipeline' });

            const result = await service.getPreferences();

            expect(result.remoteConfig).toEqual({
                pipelineId: 'global-setting-pipeline',
                pipelineName: 'Global Default Pipeline',
                assignedBy: 'tenant-default',
            });
        });
    });

    // (A8/A9, A-T6) — the effective transcription mode + lock is
    // resolved SERVER-SIDE in getPreferences(), mirroring the remoteConfig
    // cascade. Precedence: locked ⇒ tenant default wins (user ignored); unlocked
    // ⇒ doctor workflowMode overrides; otherwise fall back to the tenant default.
    describe('effective transcription mode (TASK-356)', () => {
        const withWorkflowMode = (mode: 'local' | 'remote') =>
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({ key: 'workflowMode', value: mode }),
            ]);

        it('locked tenant default wins over a conflicting workflowMode=local (→ BACKEND, locked)', async () => {
            withWorkflowMode('local');
            mockTenantFrontendConfigRepository.findByTenant.mockResolvedValue({
                transcriptionMode: TranscriptionMode.BACKEND,
                transcriptionModeLocked: true,
            });

            const result = await service.getPreferences();

            expect(result.transcriptionMode).toBe('BACKEND');
            expect(result.transcriptionModeLocked).toBe(true);
        });

        it('locked tenant default wins over a conflicting workflowMode=remote (→ LOCAL, locked)', async () => {
            withWorkflowMode('remote');
            mockTenantFrontendConfigRepository.findByTenant.mockResolvedValue({
                transcriptionMode: TranscriptionMode.LOCAL,
                transcriptionModeLocked: true,
            });

            const result = await service.getPreferences();

            expect(result.transcriptionMode).toBe('LOCAL');
            expect(result.transcriptionModeLocked).toBe(true);
        });

        it('unlocked + workflowMode=local overrides the tenant default (→ LOCAL)', async () => {
            withWorkflowMode('local');
            mockTenantFrontendConfigRepository.findByTenant.mockResolvedValue({
                transcriptionMode: TranscriptionMode.BACKEND,
                transcriptionModeLocked: false,
            });

            const result = await service.getPreferences();

            expect(result.transcriptionMode).toBe('LOCAL');
            expect(result.transcriptionModeLocked).toBe(false);
        });

        it('unlocked + workflowMode=remote overrides the tenant default (→ BACKEND)', async () => {
            withWorkflowMode('remote');
            mockTenantFrontendConfigRepository.findByTenant.mockResolvedValue({
                transcriptionMode: TranscriptionMode.LOCAL,
                transcriptionModeLocked: false,
            });

            const result = await service.getPreferences();

            expect(result.transcriptionMode).toBe('BACKEND');
            expect(result.transcriptionModeLocked).toBe(false);
        });

        it('unlocked + no workflowMode falls back to the tenant default (→ LOCAL)', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
            mockTenantFrontendConfigRepository.findByTenant.mockResolvedValue({
                transcriptionMode: TranscriptionMode.LOCAL,
                transcriptionModeLocked: false,
            });

            const result = await service.getPreferences();

            expect(result.transcriptionMode).toBe('LOCAL');
            expect(result.transcriptionModeLocked).toBe(false);
        });

        it('defaults to BACKEND / unlocked when the tenant has no frontend config row (back-compat)', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
            mockTenantFrontendConfigRepository.findByTenant.mockResolvedValue(null);

            const result = await service.getPreferences();

            expect(result.transcriptionMode).toBe('BACKEND');
            expect(result.transcriptionModeLocked).toBe(false);
        });
    });

    describe('updatePreferences', () => {
        beforeEach(() => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
        });

        it('should store workflowMode as String', async () => {
            mockUserSettingsRepository.create.mockImplementation((entity: any) => entity);

            await service.updatePreferences({ workflowMode: 'remote' });

            expect(mockUserSettingsRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'workflowMode',
                    value: 'remote',
                    dataType: ValueType.String,
                }),
            );
        });

        it('should store localConfig as JSON', async () => {
            mockUserSettingsRepository.create.mockImplementation((entity: any) => entity);

            const localConfig = {
                stt: { modelId: 'whisper-large-v3' },
                vad: { modelId: 'silero-vad-v5', sensitivity: 0.7 },
            };

            await service.updatePreferences({ localConfig });

            expect(mockUserSettingsRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'localConfig',
                    value: JSON.stringify(localConfig),
                    dataType: ValueType.Json,
                }),
            );
        });

        it('should deep merge localConfig with existing config', async () => {
            const existingConfig = {
                noiseCancellation: { modelId: 'rnnoise', level: 'high' },
                stt: { modelId: 'whisper-medium' },
                vad: { modelId: 'silero-vad-v5', sensitivity: 0.5 },
            };

            // Mock: existing localConfig found
            mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation(
                (_userId: string, key: string) => {
                    if (key === 'localConfig') {
                        return Promise.resolve(
                            createMockEntity({
                                id: 'existing-local-config',
                                key: 'localConfig',
                                value: JSON.stringify(existingConfig),
                                dataType: ValueType.Json,
                            }),
                        );
                    }
                    return Promise.resolve(null);
                },
            );
            mockUserSettingsRepository.update.mockImplementation((_id: string, entity: any) => entity);

            // Only update stt.modelId
            await service.updatePreferences({
                localConfig: { stt: { modelId: 'whisper-large-v3' } },
            });

            // Should deep merge: stt updated, noiseCancellation and vad preserved
            expect(mockUserSettingsRepository.update).toHaveBeenCalledWith(
                'existing-local-config',
                expect.objectContaining({
                    value: JSON.stringify({
                        noiseCancellation: { modelId: 'rnnoise', level: 'high' },
                        stt: { modelId: 'whisper-large-v3' },
                        vad: { modelId: 'silero-vad-v5', sensitivity: 0.5 },
                    }),
                }),
            );
        });

        it('should handle partial update with only shared fields', async () => {
            mockUserSettingsRepository.create.mockImplementation((entity: any) => entity);

            await service.updatePreferences({ language: 'th', dnaStyleId: 'clinical-detailed-th' });

            expect(mockUserSettingsRepository.create).toHaveBeenCalledTimes(2);
        });

        it('should not create any settings for empty update request', async () => {
            await service.updatePreferences({});

            expect(mockUserSettingsRepository.create).not.toHaveBeenCalled();
            expect(mockUserSettingsRepository.update).not.toHaveBeenCalled();
        });

        it('should store custom as JSON string', async () => {
            const customData = { theme: 'dark', shortcuts: ['ctrl+s'] };
            mockUserSettingsRepository.create.mockImplementation((entity: any) => entity);

            await service.updatePreferences({ custom: customData });

            expect(mockUserSettingsRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'custom',
                    value: JSON.stringify(customData),
                    dataType: ValueType.Json,
                }),
            );
        });
    });

    describe('resetPreferences', () => {
        it('should delete all SDK preferences for the user', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
            mockUserSettingsRepository.deleteByUserAndNamespace.mockResolvedValue(undefined);

            await service.resetPreferences();

            expect(mockUserSettingsRepository.deleteByUserAndNamespace).toHaveBeenCalledWith(
                'user-id-1',
                'arcaai-sdk',
            );
        });

        it('should throw error when user context is not available', async () => {
            mockClsService.get.mockReturnValue(null);

            await expect(service.resetPreferences()).rejects.toThrow('User context not available');
        });
    });

    describe('backward compatibility (legacy flat keys)', () => {
        it('should build localConfig from legacy keys when new keys do not exist', async () => {
            const legacySettings = [
                createMockEntity({ key: 'sttModel', value: 'whisper-large-v3' }),
                createMockEntity({ key: 'noiseFilterLevel', value: 'high' }),
                createMockEntity({ key: 'vadSensitivity', value: '0.6', dataType: ValueType.Float }),
                createMockEntity({ key: 'nerModel', value: 'biomedical' }),
                createMockEntity({ key: 'language', value: 'en' }),
            ];
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue(legacySettings);

            const result = await service.getPreferences();

            expect(result.workflowMode).toBe('local');
            expect(result.language).toBe('en');
            expect(result.localConfig).toEqual({
                stt: { modelId: 'whisper-large-v3' },
                noiseCancellation: { level: 'high' },
                vad: { sensitivity: 0.6 },
                ner: { modelId: 'biomedical' },
            });
        });

        it('should discard legacy codeSwitching key', async () => {
            const legacySettings = [
                createMockEntity({ key: 'codeSwitching', value: 'true', dataType: ValueType.Boolean }),
                createMockEntity({ key: 'language', value: 'en' }),
            ];
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue(legacySettings);

            const result = await service.getPreferences();

            expect(result.language).toBe('en');
            expect((result as any).codeSwitching).toBeUndefined();
        });

        it('should prefer new localConfig over legacy keys', async () => {
            const newLocalConfig = {
                stt: { modelId: 'whisper-large-v3-turbo' },
            };
            const mixedSettings = [
                createMockEntity({ key: 'sttModel', value: 'whisper-medium' }),
                createMockEntity({
                    key: 'localConfig',
                    value: JSON.stringify(newLocalConfig),
                    dataType: ValueType.Json,
                }),
            ];
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue(mixedSettings);

            const result = await service.getPreferences();

            expect(result.localConfig).toEqual(newLocalConfig);
        });

        it('should ignore unknown keys in stored settings', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({ key: 'language', value: 'en' }),
                createMockEntity({ key: 'unknownFutureKey', value: 'some-value' }),
            ]);

            const result = await service.getPreferences();

            expect(result.language).toBe('en');
            expect((result as any).unknownFutureKey).toBeUndefined();
        });
    });

    describe('updatePreferences — behavioral outcomes', () => {
        it('should return response with remoteConfig after update', async () => {
            mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation(
                (_userId: string, key: string, namespace: string) => {
                    if (namespace === 'arcaai-admin' && key === 'assigned-pipeline') {
                        return Promise.resolve(
                            createMockEntity({
                                key: 'assigned-pipeline',
                                value: 'admin-pipeline-id',
                                namespace: 'arcaai-admin',
                            }),
                        );
                    }
                    return Promise.resolve(null);
                },
            );
            mockAsrPipelineRepository.findById.mockResolvedValue({ name: 'Admin Pipeline' });
            mockUserSettingsRepository.create.mockImplementation((entity: any) => entity);
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({ key: 'workflowMode', value: 'remote' }),
            ]);

            const result = await service.updatePreferences({ workflowMode: 'remote' });

            expect(result.workflowMode).toBe('remote');
            expect(result.remoteConfig).toBeDefined();
            expect(result.remoteConfig?.pipelineId).toBe('admin-pipeline-id');
            expect(result.remoteConfig?.assignedBy).toBe('admin');
        });

        it('should deep merge localConfig when no existing config exists (first write)', async () => {
            mockUserSettingsRepository.findByUserKeyNamespace.mockResolvedValue(null);
            mockUserSettingsRepository.create.mockImplementation((entity: any) => entity);
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);

            const localConfig = { stt: { modelId: 'whisper-large-v3' } };
            await service.updatePreferences({ localConfig });

            expect(mockUserSettingsRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'localConfig',
                    value: JSON.stringify(localConfig),
                    dataType: ValueType.Json,
                }),
            );
        });

        it('should update existing setting and emit update audit event', async () => {
            const existingSetting = createMockEntity({
                id: 'existing-lang',
                key: 'language',
                value: 'en',
            });
            mockUserSettingsRepository.findByUserKeyNamespace.mockResolvedValue(existingSetting);
            mockUserSettingsRepository.update.mockResolvedValue(
                createMockEntity({ key: 'language', value: 'th' }),
            );
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({ key: 'language', value: 'th' }),
            ]);

            const result = await service.updatePreferences({ language: 'th' });

            expect(result.language).toBe('th');
            expect(mockUserSettingsRepository.update).toHaveBeenCalledWith(
                'existing-lang',
                expect.objectContaining({ value: 'th' }),
            );
            expect(mockEventEmitter.emit).toHaveBeenCalled();
        });
    });

    describe('resetPreferences — scope', () => {
        it('should only delete arcaai-sdk namespace, not arcaai-admin', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
            mockUserSettingsRepository.deleteByUserAndNamespace.mockResolvedValue(undefined);

            await service.resetPreferences();

            expect(mockUserSettingsRepository.deleteByUserAndNamespace).toHaveBeenCalledWith(
                'user-id-1',
                'arcaai-sdk',
            );
            expect(mockUserSettingsRepository.deleteByUserAndNamespace).not.toHaveBeenCalledWith(
                'user-id-1',
                'arcaai-admin',
            );
        });

        it('should emit audit event with deleted keys', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({ key: 'workflowMode', value: 'local' }),
                createMockEntity({ key: 'language', value: 'en' }),
            ]);
            mockUserSettingsRepository.deleteByUserAndNamespace.mockResolvedValue(undefined);

            await service.resetPreferences();

            expect(mockEventEmitter.emit).toHaveBeenCalled();
        });
    });

    describe('backward compatibility — sttProvider legacy key', () => {
        it('should not crash on sttProvider legacy key (it sets hasLegacyKeys flag)', async () => {
            const legacySettings = [
                createMockEntity({ key: 'sttProvider', value: 'backend' }),
                createMockEntity({ key: 'sttModel', value: 'whisper-medium' }),
            ];
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue(legacySettings);

            const result = await service.getPreferences();

            expect(result.workflowMode).toBe('local');
            expect(result.localConfig).toBeDefined();
            expect(result.localConfig?.stt).toEqual({ modelId: 'whisper-medium' });
        });
    });

    describe('edge cases — JSON parsing', () => {
        it('should return empty object for invalid custom JSON', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({
                    key: 'custom',
                    value: '{broken-json',
                    dataType: ValueType.Json,
                }),
            ]);

            const result = await service.getPreferences();

            expect(result.custom).toEqual({});
        });

        it('should handle getExistingLocalConfig with corrupt JSON gracefully', async () => {
            mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation(
                (_userId: string, key: string) => {
                    if (key === 'localConfig') {
                        return Promise.resolve(
                            createMockEntity({
                                id: 'corrupt-config',
                                key: 'localConfig',
                                value: 'not-json-at-all',
                                dataType: ValueType.Json,
                            }),
                        );
                    }
                    return Promise.resolve(null);
                },
            );
            mockUserSettingsRepository.create.mockImplementation((entity: any) => entity);
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);

            await expect(
                service.updatePreferences({ localConfig: { stt: { modelId: 'test' } } }),
            ).resolves.toBeDefined();
        });
    });

    describe('edge cases — updatedAt handling', () => {
        it('should handle settings with null updatedAt', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({ key: 'language', value: 'en', updatedAt: undefined as any }),
            ]);

            const result = await service.getPreferences();

            expect(result.language).toBe('en');
            expect(result.updatedAt).toBeDefined();
        });
    });

    describe('edge cases — deepMergeLocalConfig', () => {
        it('should replace array values (not merge them)', async () => {
            const existingConfig = {
                stt: { modelId: 'whisper-medium' },
                custom: { tags: ['a', 'b'] },
            };
            mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation(
                (_userId: string, key: string) => {
                    if (key === 'localConfig') {
                        return Promise.resolve(
                            createMockEntity({
                                id: 'existing-config',
                                key: 'localConfig',
                                value: JSON.stringify(existingConfig),
                                dataType: ValueType.Json,
                            }),
                        );
                    }
                    return Promise.resolve(null);
                },
            );
            mockUserSettingsRepository.update.mockImplementation((_id: string, entity: any) => entity);
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);

            await service.updatePreferences({
                localConfig: { custom: { tags: ['c'] } } as any,
            });

            expect(mockUserSettingsRepository.update).toHaveBeenCalledWith(
                'existing-config',
                expect.objectContaining({
                    value: JSON.stringify({
                        stt: { modelId: 'whisper-medium' },
                        custom: { tags: ['c'] },
                    }),
                }),
            );
        });

        it('should handle null update values by replacing existing', async () => {
            const existingConfig = {
                stt: { modelId: 'whisper-medium' },
                vad: { modelId: 'silero', sensitivity: 0.5 },
            };
            mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation(
                (_userId: string, key: string) => {
                    if (key === 'localConfig') {
                        return Promise.resolve(
                            createMockEntity({
                                id: 'existing-config',
                                key: 'localConfig',
                                value: JSON.stringify(existingConfig),
                                dataType: ValueType.Json,
                            }),
                        );
                    }
                    return Promise.resolve(null);
                },
            );
            mockUserSettingsRepository.update.mockImplementation((_id: string, entity: any) => entity);
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);

            await service.updatePreferences({
                localConfig: { vad: null } as any,
            });

            const callValue = JSON.parse(
                (mockUserSettingsRepository.update.mock.calls[0][1] as any).value,
            );
            expect(callValue.vad).toBeNull();
            expect(callValue.stt).toEqual({ modelId: 'whisper-medium' });
        });
    });

    describe('edge cases — pipeline resolution', () => {
        it('should return pipelineName as undefined when findById returns null (pipeline deleted)', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
            mockAppSettingsService.getValueFromCache.mockReturnValue('deleted-pipeline-id');
            mockAsrPipelineRepository.findById.mockResolvedValue(null);

            const result = await service.getPreferences();

            expect(result.remoteConfig).toEqual({
                pipelineId: 'deleted-pipeline-id',
                pipelineName: undefined,
                assignedBy: 'tenant-default',
            });
        });

        it('should skip admin override when value is empty string', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
            mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation(
                (_userId: string, key: string, namespace: string) => {
                    if (namespace === 'arcaai-admin' && key === 'assigned-pipeline') {
                        return Promise.resolve(
                            createMockEntity({
                                key: 'assigned-pipeline',
                                value: '',
                                namespace: 'arcaai-admin',
                            }),
                        );
                    }
                    return Promise.resolve(null);
                },
            );
            mockAppSettingsService.getValueFromCache.mockReturnValue('tenant-pipeline');
            mockAsrPipelineRepository.findById.mockResolvedValue({ name: 'Tenant Pipeline' });

            const result = await service.getPreferences();

            expect(result.remoteConfig?.pipelineId).toBe('tenant-pipeline');
            expect(result.remoteConfig?.assignedBy).toBe('tenant-default');
        });
    });

    describe('edge cases — backward compatibility', () => {
        it('should return empty localConfig when only codeSwitching legacy key exists', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({ key: 'codeSwitching', value: 'true', dataType: ValueType.Boolean }),
            ]);

            const result = await service.getPreferences();

            expect(result.localConfig).toBeUndefined();
            expect(result.workflowMode).toBeUndefined();
        });

        it('should handle legacy vadSensitivity with non-numeric value', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({ key: 'vadSensitivity', value: 'invalid' }),
            ]);

            const result = await service.getPreferences();

            expect(result.localConfig?.vad?.sensitivity).toBeNaN();
        });
    });

    describe('active voice profile resolution', () => {
        it('should resolve activeVoiceProfile from UserVoiceProfileRepository when one is active', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
            mockVoiceProfileRepository.findActiveByUserId.mockResolvedValue({
                id: 'profile-abc',
                userId: 'user-id-1',
                isActive: true,
                label: 'Dr. Smith',
                modelId: 'ecapa-tdnn-v1',
                createdAt: new Date('2026-04-01T10:00:00Z'),
            });

            const result = await service.getPreferences();

            expect(mockVoiceProfileRepository.findActiveByUserId).toHaveBeenCalledWith('user-id-1');
            expect(result.activeVoiceProfile).toEqual({
                id: 'profile-abc',
                label: 'Dr. Smith',
                modelId: 'ecapa-tdnn-v1',
                createdAt: '2026-04-01T10:00:00.000Z',
            });
        });

        it('should return undefined activeVoiceProfile when user has none active', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
            mockVoiceProfileRepository.findActiveByUserId.mockResolvedValue(null);

            const result = await service.getPreferences();

            expect(result.activeVoiceProfile).toBeUndefined();
        });

        it('should map null label/modelId to undefined', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
            mockVoiceProfileRepository.findActiveByUserId.mockResolvedValue({
                id: 'profile-min',
                userId: 'user-id-1',
                isActive: true,
                label: null,
                modelId: null,
                createdAt: new Date('2026-04-02T00:00:00Z'),
            });

            const result = await service.getPreferences();

            expect(result.activeVoiceProfile).toEqual({
                id: 'profile-min',
                label: undefined,
                modelId: undefined,
                createdAt: '2026-04-02T00:00:00.000Z',
            });
        });

        it('should swallow repository errors and return undefined activeVoiceProfile', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
            mockVoiceProfileRepository.findActiveByUserId.mockRejectedValue(
                new Error('DB unavailable'),
            );

            const result = await service.getPreferences();

            expect(result.activeVoiceProfile).toBeUndefined();
            // Other fields should still resolve normally
            expect(result.updatedAt).toBeDefined();
        });

        it('should return undefined activeVoiceProfile when voice profile repository is not provided', async () => {
            const serviceWithoutRepo = new UserPreferencesService(
                mockUserSettingsRepository as any,
                mockAsrPipelineRepository as any,
                mockAppSettingsService as any,
                mockClsService as any,
                mockEventEmitter as any,
            );
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);

            const result = await serviceWithoutRepo.getPreferences();

            expect(result.activeVoiceProfile).toBeUndefined();
        });
    });

    describe('voiceProfile sub-config in localConfig', () => {
        it('should persist voiceProfile preferences inside localConfig JSON', async () => {
            mockUserSettingsRepository.findByUserKeyNamespace.mockResolvedValue(null);
            mockUserSettingsRepository.create.mockImplementation((entity: any) => entity);
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);

            const voiceProfile = {
                autoActivateLatest: true,
                similarityThreshold: 0.85,
                useBackendAnchor: true,
            };

            await service.updatePreferences({ localConfig: { voiceProfile } } as any);

            expect(mockUserSettingsRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'localConfig',
                    value: JSON.stringify({ voiceProfile }),
                    dataType: ValueType.Json,
                }),
            );
        });

        it('should deep merge voiceProfile preferences with existing localConfig', async () => {
            const existingConfig = {
                stt: { modelId: 'whisper-medium' },
                voiceProfile: { similarityThreshold: 0.97 },
            };
            mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation(
                (_userId: string, key: string) => {
                    if (key === 'localConfig') {
                        return Promise.resolve(
                            createMockEntity({
                                id: 'existing-cfg',
                                key: 'localConfig',
                                value: JSON.stringify(existingConfig),
                                dataType: ValueType.Json,
                            }),
                        );
                    }
                    return Promise.resolve(null);
                },
            );
            mockUserSettingsRepository.update.mockImplementation((_id: string, entity: any) => entity);
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);

            await service.updatePreferences({
                localConfig: { voiceProfile: { autoActivateLatest: true } } as any,
            });

            const stored = JSON.parse(
                (mockUserSettingsRepository.update.mock.calls[0][1] as any).value,
            );
            expect(stored).toEqual({
                stt: { modelId: 'whisper-medium' },
                voiceProfile: { similarityThreshold: 0.97, autoActivateLatest: true },
            });
        });

        it('should round-trip voiceProfile preferences through getPreferences', async () => {
            const localConfig = {
                voiceProfile: {
                    autoActivateLatest: false,
                    similarityThreshold: 0.92,
                    useBackendAnchor: false,
                },
            };
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([
                createMockEntity({
                    key: 'localConfig',
                    value: JSON.stringify(localConfig),
                    dataType: ValueType.Json,
                }),
            ]);

            const result = await service.getPreferences();

            expect(result.localConfig).toEqual(localConfig);
        });
    });

    describe('error handling', () => {
        it('should propagate repository errors on getPreferences', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockRejectedValue(
                new Error('Database connection failed'),
            );

            await expect(service.getPreferences()).rejects.toThrow('Database connection failed');
        });

        it('should propagate repository errors on updatePreferences', async () => {
            mockUserSettingsRepository.findByUserKeyNamespace.mockRejectedValue(
                new Error('Database connection failed'),
            );

            await expect(service.updatePreferences({ language: 'en' })).rejects.toThrow(
                'Database connection failed',
            );
        });

        it('should propagate repository errors on resetPreferences', async () => {
            mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
            mockUserSettingsRepository.deleteByUserAndNamespace.mockRejectedValue(
                new Error('Delete failed'),
            );

            await expect(service.resetPreferences()).rejects.toThrow('Delete failed');
        });
    });
});
