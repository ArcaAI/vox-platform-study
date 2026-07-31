/**
 * Persisted playground config (TASK-586 Lane F).
 *
 * Values live in localStorage ONLY, for developer convenience across
 * reloads — never in URL params/query string. The API key you paste here is
 * a throwaway tenant/dev SDK key for local experimentation, not a production
 * secret store; treat this the same as any other devtool that remembers
 * your last input.
 */

export interface PlaygroundConfig {
  /** REST origin of the v2 gateway, e.g. `http://localhost:8868`. */
  apiEndpoint: string;
  /** Tenant SDK API key (`x-api-key` parity) — required, no default. */
  apiKey: string;
  /** Tenant id, e.g. `50000000-0000-0000-0000-000000000000`. */
  tenantId: string;
  /** Streaming STT pipeline id — the "ON" (SDK-configured pipeline) target. */
  pipelineId: string;
  /**
   * Selected STT language-mode id (TASK-587 catalog, e.g. `en`/`ml`/`ml-en`/`auto`).
   * Forwarded to `useArcaSpeechToText({ options: { languageMode } })`. The live
   * selector lives in `Playground.tsx` (it needs a connected `ArcaCompatProvider`
   * to fetch the real catalog) — this field only seeds its initial value.
   */
  languageMode: string;
}

const STORAGE_KEY = 'hope-compat-playground:config';

function readStorage(): Partial<PlaygroundConfig> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<PlaygroundConfig>) : {};
  } catch {
    return {};
  }
}

export function saveStoredConfig(config: PlaygroundConfig): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearStoredConfig(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
}

/** Stored values win over the optional `VITE_*` dev prefill, which wins over an empty string. */
export function defaultConfig(): PlaygroundConfig {
  const stored = readStorage();
  return {
    apiEndpoint: stored.apiEndpoint ?? import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8868',
    apiKey: stored.apiKey ?? import.meta.env.VITE_API_KEY ?? '',
    tenantId: stored.tenantId ?? import.meta.env.VITE_TENANT_ID ?? '',
    pipelineId: stored.pipelineId ?? import.meta.env.VITE_PIPELINE_ID ?? '',
    languageMode: stored.languageMode ?? import.meta.env.VITE_LANGUAGE_MODE ?? 'en',
  };
}
