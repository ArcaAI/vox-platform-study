import * as v from 'valibot';

export type ConfigPermission = 'system' | 'admin' | 'user';

export interface ConfigFieldMeta {
  permission: ConfigPermission;
  section: string;
  key: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Valibot schemas — Tier 0 defaults baked into .default() calls
// ---------------------------------------------------------------------------

export const AudioConfigSchema = v.object({
  sampleRate: v.optional(v.pipe(v.number(), v.minValue(8000), v.maxValue(48000)), 16000),
  noiseSuppression: v.optional(v.boolean(), true),
  noiseFilterLevel: v.optional(v.picklist(['low', 'medium', 'high']), 'medium'),
  echoCancellation: v.optional(v.boolean(), true),
  autoGainControl: v.optional(v.boolean(), true),
  vadEnabled: v.optional(v.boolean(), false),
  vadThreshold: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.5),
  diarization: v.optional(v.boolean(), false),
  codeSwitching: v.optional(v.boolean(), false),
});

export const SttConfigSchema = v.object({
  provider: v.optional(v.picklist(['local', 'backend', 'auto']), 'local'),
  defaultModel: v.optional(v.string(), 'whisper-tiny'),
  availableModels: v.optional(v.array(v.object({ id: v.string(), name: v.string(), size: v.optional(v.string()) })), [
    { id: 'whisper-tiny', name: 'Whisper Tiny', size: '~75 MB' },
    { id: 'whisper-base', name: 'Whisper Base', size: '~150 MB' },
    { id: 'whisper-small', name: 'Whisper Small', size: '~500 MB' },
  ]),
  language: v.optional(v.string(), 'en'),
});

export const UiConfigSchema = v.object({
  theme: v.optional(v.picklist(['light', 'dark', 'system']), 'system'),
  density: v.optional(v.picklist(['compact', 'normal', 'comfortable']), 'normal'),
  language: v.optional(v.string(), 'en'),
});

export const SmrConfigSchema = v.object({
  provider: v.optional(v.string(), 'openai'),
  model: v.optional(v.string(), 'gpt-4o'),
});

export const FeatureFlagsSchema = v.object({
  realTimeTranscription: v.optional(v.boolean(), true),
  nerExtraction: v.optional(v.boolean(), false),
  dnaStyle: v.optional(v.boolean(), false),
  crossChainSummary: v.optional(v.boolean(), false),
  tts: v.optional(v.boolean(), false),
});

export const AppConfigSchema = v.object({
  audio: v.optional(AudioConfigSchema, {}),
  stt: v.optional(SttConfigSchema, {}),
  ui: v.optional(UiConfigSchema, {}),
  smr: v.optional(SmrConfigSchema, {}),
  features: v.optional(FeatureFlagsSchema, {}),
});

export type AppConfig = v.InferOutput<typeof AppConfigSchema>;
export type AudioConfig = v.InferOutput<typeof AudioConfigSchema>;
export type SttConfig = v.InferOutput<typeof SttConfigSchema>;
export type UiConfig = v.InferOutput<typeof UiConfigSchema>;
export type SmrConfig = v.InferOutput<typeof SmrConfigSchema>;
export type FeatureFlags = v.InferOutput<typeof FeatureFlagsSchema>;

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// ---------------------------------------------------------------------------
// Permission metadata — declares which tier owns each field
// ---------------------------------------------------------------------------

export const CONFIG_PERMISSIONS: Record<string, ConfigFieldMeta> = {
  'audio.sampleRate': { permission: 'admin', section: 'audio', key: 'sampleRate', label: 'Sample Rate' },
  'audio.noiseSuppression': { permission: 'user', section: 'audio', key: 'noiseSuppression', label: 'Noise Suppression' },
  'audio.noiseFilterLevel': { permission: 'user', section: 'audio', key: 'noiseFilterLevel', label: 'Noise Filter Level' },
  'audio.echoCancellation': { permission: 'user', section: 'audio', key: 'echoCancellation', label: 'Echo Cancellation' },
  'audio.autoGainControl': { permission: 'user', section: 'audio', key: 'autoGainControl', label: 'Auto Gain Control' },
  'audio.vadEnabled': { permission: 'user', section: 'audio', key: 'vadEnabled', label: 'Voice Activity Detection' },
  'audio.vadThreshold': { permission: 'admin', section: 'audio', key: 'vadThreshold', label: 'VAD Sensitivity' },
  'audio.diarization': { permission: 'user', section: 'audio', key: 'diarization', label: 'Speaker Diarization' },
  'audio.codeSwitching': { permission: 'admin', section: 'audio', key: 'codeSwitching', label: 'Code-Switching' },

  'stt.provider': { permission: 'admin', section: 'stt', key: 'provider', label: 'STT Provider' },
  'stt.defaultModel': { permission: 'admin', section: 'stt', key: 'defaultModel', label: 'Default STT Model' },
  'stt.availableModels': { permission: 'admin', section: 'stt', key: 'availableModels', label: 'Available Models' },
  'stt.language': { permission: 'user', section: 'stt', key: 'language', label: 'Transcription Language' },

  'ui.theme': { permission: 'user', section: 'ui', key: 'theme', label: 'Theme' },
  'ui.density': { permission: 'user', section: 'ui', key: 'density', label: 'UI Density' },
  'ui.language': { permission: 'user', section: 'ui', key: 'language', label: 'UI Language' },

  'smr.provider': { permission: 'admin', section: 'smr', key: 'provider', label: 'Summary Provider' },
  'smr.model': { permission: 'admin', section: 'smr', key: 'model', label: 'Summary Model' },

  'features.realTimeTranscription': { permission: 'admin', section: 'features', key: 'realTimeTranscription', label: 'Real-Time Transcription' },
  'features.nerExtraction': { permission: 'admin', section: 'features', key: 'nerExtraction', label: 'NER Extraction' },
  'features.dnaStyle': { permission: 'admin', section: 'features', key: 'dnaStyle', label: 'DNA-Style Notes' },
  'features.crossChainSummary': { permission: 'admin', section: 'features', key: 'crossChainSummary', label: 'Cross-Chain Summary' },
  'features.tts': { permission: 'admin', section: 'features', key: 'tts', label: 'Text-to-Speech' },
};

export const SYSTEM_DEFAULTS: AppConfig = v.parse(AppConfigSchema, {});

export function getFieldPermission(path: string): ConfigPermission {
  return CONFIG_PERMISSIONS[path]?.permission ?? 'admin';
}

export function canUserEditField(path: string, lockedPaths: ReadonlySet<string>): boolean {
  if (lockedPaths.has(path)) return false;
  const meta = CONFIG_PERMISSIONS[path];
  if (!meta) return false;
  return meta.permission === 'user';
}

export function getUserEditableFields(): string[] {
  return Object.entries(CONFIG_PERMISSIONS)
    .filter(([, meta]) => meta.permission === 'user')
    .map(([path]) => path);
}
