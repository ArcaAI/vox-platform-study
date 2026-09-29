/**
 * UserPreferencesService Unit Tests
 *
 * Tests for the restructured workflow-oriented UserPreferencesService.
 *
 * Key behaviors tested:
 * - Workflow mode (local/remote) storage and retrieval
 * - localConfig stored as JSON, deep-merged on partial updates
 * - No remoteConfig: the ASR engine is the gateway-resolved agent, not a preference (TASK-1006)
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

const mockVoiceProfileRepository = {
  findActiveByUserId: vi.fn(),
  findAllByUserId: vi.fn(),
  activateById: vi.fn(),
  deactivateAllForUser: vi.fn(),
  createWithEmbedding: vi.fn(),
};

const createMockEntity = (
  overrides: Partial<{
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
  }> = {},
) => ({
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

    mockUserSettingsRepository.findByUserKeyNamespace.mockResolvedValue(null);
    mockVoiceProfileRepository.findActiveByUserId.mockResolvedValue(null);
    // Default: tenant has no frontend config row → effective mode falls back
    // to the schema default (BACKEND), unlocked.
    mockTenantFrontendConfigRepository.findByTenant.mockResolvedValue(null);

    service = new UserPreferencesService(
      mockUserSettingsRepository as any,
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
      expect(mockUserSettingsRepository.findByUserAndNamespace).toHaveBeenCalledWith('user-id-1', 'arcaai-sdk');
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

  describe('no remoteConfig (TASK-1006)', () => {
    it('never reports a remoteConfig — the ASR engine is the gateway-resolved agent, not a user preference', async () => {
      // Even with the retired per-user admin override row still present in the table.
      mockUserSettingsRepository.findByUserKeyNamespace.mockResolvedValue(
        createMockEntity({ key: 'assigned-pipeline', value: 'admin-pipeline-id', namespace: 'arcaai-admin' }),
      );
      mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);

      const result = await service.getPreferences();

      expect(result).not.toHaveProperty('remoteConfig');
      expect(mockUserSettingsRepository.findByUserKeyNamespace).not.toHaveBeenCalled();
    });
  });

  describe('effective transcription mode', () => {
    const withWorkflowMode = (mode: 'local' | 'remote') =>
      mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([createMockEntity({ key: 'workflowMode', value: mode })]);

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
        noiseCancellation: { level: 'high' },
        vad: { sensitivity: 0.7 },
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
      mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation((_userId: string, key: string) => {
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
      });
      mockUserSettingsRepository.update.mockImplementation((_id: string, entity: any) => entity);

      // Only update vad.sensitivity
      await service.updatePreferences({
        localConfig: { vad: { sensitivity: 0.9 } },
      });

      // Should deep merge: vad updated, noiseCancellation and stt preserved
      expect(mockUserSettingsRepository.update).toHaveBeenCalledWith(
        'existing-local-config',
        expect.objectContaining({
          value: JSON.stringify({
            noiseCancellation: { modelId: 'rnnoise', level: 'high' },
            stt: { modelId: 'whisper-medium' },
            vad: { modelId: 'silero-vad-v5', sensitivity: 0.9 },
          }),
        }),
      );
    });

    // TASK-1012 L-6 — `localConfig.{noiseCancellation,stt,vad,ner}.modelId` were client-side model
    // picks for the browser AI stages SDK 4.0.0 removed. SDK 4.0.0 still round-trips them, so the
    // fields stay declared (deprecated) but are IGNORED: a write never persists one.
    it('ignores (never persists) the deprecated client-AI modelIds', async () => {
      mockUserSettingsRepository.create.mockImplementation((entity: any) => entity);

      await service.updatePreferences({
        localConfig: {
          noiseCancellation: { modelId: 'rnnoise', level: 'high' },
          stt: { modelId: 'whisper-large-v3' },
          vad: { modelId: 'silero-vad-v5', sensitivity: 0.6 },
          ner: { modelId: 'biomedical', autoExtract: true },
        },
      });

      const stored = mockUserSettingsRepository.create.mock.calls.find(([entity]: any[]) => entity.key === 'localConfig')?.[0];
      expect(JSON.parse(stored.value)).toEqual({
        noiseCancellation: { level: 'high' },
        stt: {},
        vad: { sensitivity: 0.6 },
        ner: { autoExtract: true },
      });
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

      expect(mockUserSettingsRepository.deleteByUserAndNamespace).toHaveBeenCalledWith('user-id-1', 'arcaai-sdk');
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
    it('should return the stored preferences after update, with no remoteConfig', async () => {
      mockUserSettingsRepository.create.mockImplementation((entity: any) => entity);
      mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([createMockEntity({ key: 'workflowMode', value: 'remote' })]);

      const result = await service.updatePreferences({ workflowMode: 'remote' });

      expect(result.workflowMode).toBe('remote');
      expect(result).not.toHaveProperty('remoteConfig');
    });

    it('should deep merge localConfig when no existing config exists (first write)', async () => {
      mockUserSettingsRepository.findByUserKeyNamespace.mockResolvedValue(null);
      mockUserSettingsRepository.create.mockImplementation((entity: any) => entity);
      mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);

      const localConfig = { vad: { sensitivity: 0.4 } };
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
      mockUserSettingsRepository.update.mockResolvedValue(createMockEntity({ key: 'language', value: 'th' }));
      mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([createMockEntity({ key: 'language', value: 'th' })]);

      const result = await service.updatePreferences({ language: 'th' });

      expect(result.language).toBe('th');
      expect(mockUserSettingsRepository.update).toHaveBeenCalledWith('existing-lang', expect.objectContaining({ value: 'th' }));
      expect(mockEventEmitter.emit).toHaveBeenCalled();
    });
  });

  describe('resetPreferences — scope', () => {
    it('should only delete arcaai-sdk namespace, not arcaai-admin', async () => {
      mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
      mockUserSettingsRepository.deleteByUserAndNamespace.mockResolvedValue(undefined);

      await service.resetPreferences();

      expect(mockUserSettingsRepository.deleteByUserAndNamespace).toHaveBeenCalledWith('user-id-1', 'arcaai-sdk');
      expect(mockUserSettingsRepository.deleteByUserAndNamespace).not.toHaveBeenCalledWith('user-id-1', 'arcaai-admin');
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
      mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation((_userId: string, key: string) => {
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
      });
      mockUserSettingsRepository.create.mockImplementation((entity: any) => entity);
      mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);

      await expect(service.updatePreferences({ localConfig: { stt: { modelId: 'test' } } })).resolves.toBeDefined();
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
      mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation((_userId: string, key: string) => {
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
      });
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
      mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation((_userId: string, key: string) => {
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
      });
      mockUserSettingsRepository.update.mockImplementation((_id: string, entity: any) => entity);
      mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);

      await service.updatePreferences({
        localConfig: { vad: null } as any,
      });

      const callValue = JSON.parse((mockUserSettingsRepository.update.mock.calls[0][1] as any).value);
      expect(callValue.vad).toBeNull();
      expect(callValue.stt).toEqual({ modelId: 'whisper-medium' });
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
      mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([createMockEntity({ key: 'vadSensitivity', value: 'invalid' })]);

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
      mockVoiceProfileRepository.findActiveByUserId.mockRejectedValue(new Error('DB unavailable'));

      const result = await service.getPreferences();

      expect(result.activeVoiceProfile).toBeUndefined();
      // Other fields should still resolve normally
      expect(result.updatedAt).toBeDefined();
    });

    it('should return undefined activeVoiceProfile when voice profile repository is not provided', async () => {
      const serviceWithoutRepo = new UserPreferencesService(mockUserSettingsRepository as any, mockClsService as any, mockEventEmitter as any);
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
      mockUserSettingsRepository.findByUserKeyNamespace.mockImplementation((_userId: string, key: string) => {
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
      });
      mockUserSettingsRepository.update.mockImplementation((_id: string, entity: any) => entity);
      mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);

      await service.updatePreferences({
        localConfig: { voiceProfile: { autoActivateLatest: true } } as any,
      });

      const stored = JSON.parse((mockUserSettingsRepository.update.mock.calls[0][1] as any).value);
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
      mockUserSettingsRepository.findByUserAndNamespace.mockRejectedValue(new Error('Database connection failed'));

      await expect(service.getPreferences()).rejects.toThrow('Database connection failed');
    });

    it('should propagate repository errors on updatePreferences', async () => {
      mockUserSettingsRepository.findByUserKeyNamespace.mockRejectedValue(new Error('Database connection failed'));

      await expect(service.updatePreferences({ language: 'en' })).rejects.toThrow('Database connection failed');
    });

    it('should propagate repository errors on resetPreferences', async () => {
      mockUserSettingsRepository.findByUserAndNamespace.mockResolvedValue([]);
      mockUserSettingsRepository.deleteByUserAndNamespace.mockRejectedValue(new Error('Delete failed'));

      await expect(service.resetPreferences()).rejects.toThrow('Delete failed');
    });
  });
});
