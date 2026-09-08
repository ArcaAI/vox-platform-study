/**
 * Connection config for the compat SDK, persisted in localStorage so a reload
 * keeps the last values. The API key you paste is a throwaway tenant/dev SDK
 * key for local experimentation — treat this like any other devtool that
 * remembers your last input, not a secret store.
 */
export interface AppConfig {
  /** REST origin of the gateway, e.g. `http://localhost:8868`. */
  apiEndpoint: string;
  /** Tenant SDK API key — required, no default. */
  apiKey: string;
  /**
   * Streaming/batch ASR pipeline id — DEPRECATED at the gateway (removed in R4), kept because
   * `useArcaSpeechToText` and `useArcaBatchTranscription` accept no agent slug yet.
   */
  pipelineId: string;
  /**
   * The published ASR Agent the live capture session selects (TASK-931). Empty means the
   * tenant's agent assignment decides.
   */
  sttAgentSlug: string;
  /** Language (or code-switch mode id) used for live + batch transcription. */
  language: string;
}

/** The predefined languages this app offers. */
export const LANGUAGES: { id: string; label: string }[] = [
  { id: 'en', label: 'English (en)' },
  { id: 'ml', label: 'Malayalam (ml)' },
  { id: 'ml-en', label: 'Malayalam + English (ml-en)' },
  { id: 'vi', label: 'Vietnamese (vi)' },
  { id: 'vi-en', label: 'Vietnamese + English (vi-en)' },
  { id: 'auto', label: 'Auto-detect (auto)' },
];

const STORAGE_KEY = 'quick-compat-app:config';

export const EMPTY_CONFIG: AppConfig = {
  apiEndpoint: 'http://localhost:8868',
  apiKey: '',
  pipelineId: '',
  sttAgentSlug: '',
  language: 'en',
};

export function loadConfig(): AppConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? { ...EMPTY_CONFIG, ...(JSON.parse(raw) as Partial<AppConfig>) } : EMPTY_CONFIG;
  } catch {
    return EMPTY_CONFIG;
  }
}

export function saveConfig(config: AppConfig): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/**
 * The gateway's WebSocket base. v1 configs carried it separately; here it is
 * derived from the REST origin so there is one field to get wrong instead of two.
 */
export function websocketUrlFor(apiEndpoint: string): string {
  return apiEndpoint.trim().replace(/\/+$/, '').replace(/^http/, 'ws');
}
