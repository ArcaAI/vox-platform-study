import { Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  UserSettingsRepository,
  UserSettingsFactory,
  UserVoiceProfileRepository,
  TenantFrontendConfigRepository,
  TranscriptionMode,
  ValueType,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { IUserPreferencesService } from './IUserPreferencesService';
import { UserPreferencesResponse, UpdateUserPreferencesRequest } from './dto';
import { IActiveUserContext } from '../../../interfaces';
import { BaseService } from '../../../common';

const SDK_NAMESPACE = 'arcaai-sdk';

const PREFERENCE_KEYS = {
  WORKFLOW_MODE: 'workflowMode',
  LANGUAGE: 'language',
  DNA_STYLE_ID: 'dnaStyleId',
  LOCAL_CONFIG: 'localConfig',
  CUSTOM: 'custom',
} as const;

/** @deprecated Legacy keys from flat structure -- used for backward compatibility */
const LEGACY_KEYS = {
  STT_MODEL: 'sttModel',
  STT_PROVIDER: 'sttProvider',
  NOISE_FILTER_LEVEL: 'noiseFilterLevel',
  VAD_SENSITIVITY: 'vadSensitivity',
  NER_MODEL: 'nerModel',
  CODE_SWITCHING: 'codeSwitching',
} as const;

/**
 * TASK-1012 L-6 — the `localConfig` stages whose `modelId` was a client-side model pick for a
 * browser AI stage SDK 4.0.0 removed. The published SDK still sends them, so the request DTO keeps
 * them (deprecated); this service ignores them and never persists one.
 */
const CLIENT_AI_MODEL_STAGES = ['noiseCancellation', 'stt', 'vad', 'ner'] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withoutClientModelIds(localConfig: Record<string, any>): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: Record<string, any> = { ...localConfig };
  for (const stage of CLIENT_AI_MODEL_STAGES) {
    const value = result[stage];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const { modelId: _ignored, ...rest } = value as Record<string, unknown>;
      result[stage] = rest;
    }
  }
  return result;
}

/**
 * User Preferences Service
 *
 * Aggregates key-value UserSettings into a typed UserPreferences object
 * for the SDK v2 PersonalizationManager.
 *
 * Storage strategy:
 * - Shared fields (workflowMode, language, dnaStyleId) stored as individual rows
 * - localConfig stored as a single JSON row
 *
 * There is no `remoteConfig`: the ASR engine is not a user preference. The gateway resolves the
 * session's speech-to-text AGENT (explicit slug → governing workflow → department → tenant
 * assignment) at session start; the per-user assigned-pipeline cascade this service used to
 * report retired with `AsrPipeline` (TASK-1006).
 */
@Injectable()
export class UserPreferencesService extends BaseService implements IUserPreferencesService {
  private readonly logger = new Logger(UserPreferencesService.name);

  constructor(
    private readonly userSettingsRepository: UserSettingsRepository,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    protected override readonly eventEmitter: EventEmitter2,
    /**
     * Optional because some test contexts construct this service without the voice-profile
     * dependency. In production wiring it is always provided by `UserPreferencesServiceModule`.
     */
    @Optional() private readonly voiceProfileRepository?: UserVoiceProfileRepository,
    /**
     * The tenant-scoped frontend config carries the
     * default transcription mode + lock. Optional for the same test-construction
     * reason as `voiceProfileRepository`; provided in production via
     * `CoreDatabaseModule` (already imported by `UserPreferencesServiceModule`).
     */
    @Optional() private readonly tenantFrontendConfigRepository?: TenantFrontendConfigRepository,
  ) {
    super(eventEmitter, clsService, ResourceType.UserSettings);
  }

  private get currentUserId(): string {
    const user = this.clsService.get('user');
    if (!user?.id) {
      throw new Error('User context not available');
    }
    return user.id;
  }

  async getPreferences(): Promise<UserPreferencesResponse> {
    const userId = this.currentUserId;

    const settings = await this.userSettingsRepository.findByUserAndNamespace(userId, SDK_NAMESPACE);

    const response: UserPreferencesResponse = {
      updatedAt: new Date().toISOString(),
      // Back-compat defaults (BACKEND / unlocked). The
      // effective values are resolved below and overwrite these; initializing
      // here keeps the response valid even if resolution is ever short-circuited.
      transcriptionMode: 'BACKEND',
      transcriptionModeLocked: false,
    };

    let latestUpdate = new Date(0);
    let hasLegacyKeys = false;

    for (const setting of settings) {
      if (setting.updatedAt && setting.updatedAt > latestUpdate) {
        latestUpdate = setting.updatedAt;
      }

      switch (setting.key) {
        case PREFERENCE_KEYS.WORKFLOW_MODE:
          response.workflowMode = setting.value as 'local' | 'remote';
          break;
        case PREFERENCE_KEYS.LANGUAGE:
          response.language = setting.value;
          break;
        case PREFERENCE_KEYS.DNA_STYLE_ID:
          response.dnaStyleId = setting.value;
          break;
        case PREFERENCE_KEYS.LOCAL_CONFIG:
          try {
            response.localConfig = JSON.parse(setting.value);
          } catch {
            response.localConfig = undefined;
          }
          break;
        case PREFERENCE_KEYS.CUSTOM:
          try {
            response.custom = JSON.parse(setting.value);
          } catch {
            response.custom = {};
          }
          break;

        // Backward compatibility: map legacy flat keys into localConfig
        case LEGACY_KEYS.STT_MODEL:
        case LEGACY_KEYS.NOISE_FILTER_LEVEL:
        case LEGACY_KEYS.VAD_SENSITIVITY:
        case LEGACY_KEYS.NER_MODEL:
        case LEGACY_KEYS.STT_PROVIDER:
          hasLegacyKeys = true;
          break;
        // codeSwitching is discarded -- it's a pipeline-level config now
        case LEGACY_KEYS.CODE_SWITCHING:
          break;
      }
    }

    // If we found legacy keys but no new localConfig, build localConfig from legacy data
    if (hasLegacyKeys && !response.localConfig) {
      response.localConfig = this.buildLocalConfigFromLegacy(settings);
      if (!response.workflowMode) {
        response.workflowMode = 'local';
      }
    }

    if (settings.length > 0) {
      response.updatedAt = latestUpdate.toISOString();
    }

    // Resolve the EFFECTIVE transcription mode + lock
    // server-side. Uses the workflowMode already aggregated above.
    const effectiveMode = await this.resolveEffectiveTranscriptionMode(response.workflowMode);
    response.transcriptionMode = effectiveMode.transcriptionMode;
    response.transcriptionModeLocked = effectiveMode.transcriptionModeLocked;

    // Resolve read-only activeVoiceProfile from UserVoiceProfile
    response.activeVoiceProfile = await this.resolveActiveVoiceProfile(userId);

    return response;
  }

  /**
   * Resolve the EFFECTIVE transcription mode + lock for the current user/tenant.
   *
   * Precedence (server-authoritative):
   *   1. tenant `transcriptionModeLocked` → tenant `transcriptionMode` wins; the
   *      doctor's `workflowMode` is ignored.
   *   2. unlocked + the doctor set `workflowMode` → `'local'`→LOCAL, `'remote'`→BACKEND.
   *   3. unlocked + no `workflowMode` → fall back to the tenant default.
   *
   * Defaults to `BACKEND` / unlocked when the tenant has no frontend config row
   * (matches the schema default + today's hard-wired BACKEND clinical workspace).
   */
  private async resolveEffectiveTranscriptionMode(
    workflowMode: 'local' | 'remote' | undefined,
  ): Promise<{ transcriptionMode: 'LOCAL' | 'BACKEND'; transcriptionModeLocked: boolean }> {
    const tenantId = this.tenantId;
    const tenantCfg = tenantId && this.tenantFrontendConfigRepository ? await this.tenantFrontendConfigRepository.findByTenant(tenantId) : null;

    const tenantMode: 'LOCAL' | 'BACKEND' = tenantCfg?.transcriptionMode === TranscriptionMode.LOCAL ? 'LOCAL' : 'BACKEND';
    const locked = tenantCfg?.transcriptionModeLocked ?? false;

    if (locked) {
      return { transcriptionMode: tenantMode, transcriptionModeLocked: true };
    }
    if (workflowMode === 'local') return { transcriptionMode: 'LOCAL', transcriptionModeLocked: false };
    if (workflowMode === 'remote') return { transcriptionMode: 'BACKEND', transcriptionModeLocked: false };
    return { transcriptionMode: tenantMode, transcriptionModeLocked: false };
  }

  async updatePreferences(request: UpdateUserPreferencesRequest): Promise<UserPreferencesResponse> {
    const userId = this.currentUserId;

    const updates: Array<{ key: string; value: string; dataType: ValueType }> = [];

    if (request.workflowMode !== undefined) {
      updates.push({
        key: PREFERENCE_KEYS.WORKFLOW_MODE,
        value: request.workflowMode,
        dataType: ValueType.String,
      });
    }

    if (request.language !== undefined) {
      updates.push({
        key: PREFERENCE_KEYS.LANGUAGE,
        value: request.language,
        dataType: ValueType.String,
      });
    }

    if (request.dnaStyleId !== undefined) {
      updates.push({
        key: PREFERENCE_KEYS.DNA_STYLE_ID,
        value: request.dnaStyleId,
        dataType: ValueType.String,
      });
    }

    if (request.localConfig !== undefined) {
      // Deep merge with existing localConfig
      const existing = await this.getExistingLocalConfig(userId);
      const merged = this.deepMergeLocalConfig(existing, withoutClientModelIds(request.localConfig));
      updates.push({
        key: PREFERENCE_KEYS.LOCAL_CONFIG,
        value: JSON.stringify(merged),
        dataType: ValueType.Json,
      });
    }

    if (request.custom !== undefined) {
      updates.push({
        key: PREFERENCE_KEYS.CUSTOM,
        value: JSON.stringify(request.custom),
        dataType: ValueType.Json,
      });
    }

    for (const update of updates) {
      await this.upsertSetting(userId, update.key, update.value, update.dataType);
    }

    return this.getPreferences();
  }

  async resetPreferences(): Promise<void> {
    const userId = this.currentUserId;

    const existingSettings = await this.userSettingsRepository.findByUserAndNamespace(userId, SDK_NAMESPACE);

    await this.userSettingsRepository.deleteByUserAndNamespace(userId, SDK_NAMESPACE);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      data: {
        action: 'reset_preferences',
        userId,
        namespace: SDK_NAMESPACE,
        deletedCount: existingSettings.length,
        deletedKeys: existingSettings.map((s) => s.key),
      },
    });
  }

  /**
   * Resolve the user's currently active voice profile from `UserVoiceProfile.isActive`.
   *
   * Treating voice samples as user settings: the profile itself stays in the dedicated
   * domain table (single source of truth for `isActive`), but its summary surfaces here
   * so that the SDK can read both workflow settings and the active voice sample in a
   * single round-trip and cache them together in IndexedDB.
   */
  private async resolveActiveVoiceProfile(userId: string): Promise<UserPreferencesResponse['activeVoiceProfile']> {
    if (!this.voiceProfileRepository) return undefined;

    try {
      const profile = await this.voiceProfileRepository.findActiveByUserId(userId);
      if (!profile) return undefined;
      return {
        id: profile.id,
        label: profile.label ?? undefined,
        modelId: profile.modelId ?? undefined,
        createdAt: (profile.createdAt ?? new Date()).toISOString(),
      };
    } catch (error) {
      this.logger.warn(`Failed to resolve active voice profile for user ${userId}: ${(error as Error).message}`);
      return undefined;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getExistingLocalConfig(userId: string): Promise<Record<string, any>> {
    const setting = await this.userSettingsRepository.findByUserKeyNamespace(userId, PREFERENCE_KEYS.LOCAL_CONFIG, SDK_NAMESPACE);

    if (setting?.value) {
      try {
        return JSON.parse(setting.value);
      } catch {
        return {};
      }
    }
    return {};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private deepMergeLocalConfig(existing: Record<string, any>, updates: Record<string, any>): Record<string, any> {
    const result = { ...existing };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof result[key] === 'object' && result[key] !== null) {
        result[key] = { ...result[key], ...value };
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Build localConfig from legacy flat keys for backward compatibility.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildLocalConfigFromLegacy(settings: Array<{ key: string; value: string }>): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: Record<string, any> = {};

    for (const setting of settings) {
      switch (setting.key) {
        case LEGACY_KEYS.STT_MODEL:
          config.stt = { ...config.stt, modelId: setting.value };
          break;
        case LEGACY_KEYS.NOISE_FILTER_LEVEL:
          config.noiseCancellation = {
            ...config.noiseCancellation,
            level: setting.value,
          };
          break;
        case LEGACY_KEYS.VAD_SENSITIVITY:
          config.vad = {
            ...config.vad,
            sensitivity: parseFloat(setting.value),
          };
          break;
        case LEGACY_KEYS.NER_MODEL:
          config.ner = { ...config.ner, modelId: setting.value };
          break;
      }
    }

    return Object.keys(config).length > 0 ? config : {};
  }

  private async upsertSetting(userId: string, key: string, value: string, dataType: ValueType): Promise<void> {
    const existing = await this.userSettingsRepository.findByUserKeyNamespace(userId, key, SDK_NAMESPACE);

    if (existing) {
      const previousValue = existing.value;
      existing.value = value;
      existing.dataType = dataType;
      const updated = await this.userSettingsRepository.update(existing.id, existing);

      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: updated.id,
        data: { key, value, dataType },
        previousData: { key, value: previousValue, dataType: existing.dataType },
      });
    } else {
      const newSetting = UserSettingsFactory.CreateUserSettings({
        userId,
        key,
        value,
        dataType,
        namespace: SDK_NAMESPACE,
        name: `SDK Preference: ${key}`,
        createdBy: this.requestUserId ?? undefined,
      });
      const created = await this.userSettingsRepository.create(newSetting);

      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: created.id,
        createdAt: created.createdAt,
        data: { key, value, dataType, namespace: SDK_NAMESPACE },
      });
    }
  }
}
