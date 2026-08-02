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
  // ---------------------------------------------------------------------------
  // Capture-graph switches (TASK-597) — CONNECTION-level.
  //
  // These become `V1SdkConfig.audioSettings`, which `<ArcaCompatProvider>` reads
  // ONCE at mount, so changing them requires a disconnect/reconnect. That is why
  // they live on the Connection tab and not next to Start/Stop.
  //
  // Both default to `false`, which is exactly what the compat adapter has always
  // produced: it emits a PARTIAL `AudioPluginConfig`, that object REPLACES
  // `DEFAULT_AUDIO_CONFIG` wholesale, and `PluginManager` resolves every absent
  // plugin key to `{enabled:false}`. So `false/false` changes nothing — it only
  // makes the existing behaviour visible and, for the first time, reversible.
  // ---------------------------------------------------------------------------
  /** RNNoise browser noise suppression. */
  noiseSuppression?: boolean;
  /** Silero browser voice-activity detection. */
  voiceActivityDetection?: boolean;

  // ---------------------------------------------------------------------------
  // Stop-drain knobs (TASK-597) — PER-CAPTURE.
  //
  // These ride `AudioStartOptions` on each `startRecording()`, so they can be
  // changed between runs without touching the provider. Undefined ⇒ the SDK
  // defaults (1500 ms / 250 ms); nothing changes unless the developer opts in.
  // ---------------------------------------------------------------------------
  /** Hard ceiling on the drain wait. Undefined ⇒ SDK default (1500 ms). */
  drainTimeoutMs?: number;
  /**
   * Silence after `finalizing` that ends the drain early. `0` DISABLES the
   * early resolve, so the socket stays open for the tail final until the
   * server's terminal status or `drainTimeoutMs`. Undefined ⇒ SDK default (250 ms).
   */
  quietWindowMs?: number;

  /**
   * Last-used SMR department (code or name) — seeds the SummaryCard picker
   * (Workstream B). Optional: absent for configs saved before this field existed.
   */
  department?: string;
  /**
   * Last-used SMR visit type (e.g. `New Patient`) — seeds the SummaryCard
   * selector. Optional for the same backward-compat reason as `department`.
   */
  visitType?: string;
  /**
   * Last-used SMR doctor (user id) whose DNA writing-style is applied — seeds
   * the SummaryCard doctor picker (TASK-599 Phase E). Empty/absent ⇒ NO
   * `doctorId` is sent (department + visit-type only). Optional for the same
   * backward-compat reason as `department`.
   */
  doctorId?: string;
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
    // `?? false` (not `|| false`) so a stored `false` is honoured rather than
    // re-defaulted, and so the pair is always a real boolean by the time it
    // reaches `audioSettings` — `undefined` there would mean "say nothing",
    // which is a THIRD state the two switches must not be able to express.
    noiseSuppression: stored.noiseSuppression ?? false,
    voiceActivityDetection: stored.voiceActivityDetection ?? false,
    // Left `undefined` on purpose: absent ⇒ the SDK's own default, which is the
    // documented no-op. A number here is always a deliberate override.
    drainTimeoutMs: stored.drainTimeoutMs,
    quietWindowMs: stored.quietWindowMs,
    department: stored.department ?? import.meta.env.VITE_DEPARTMENT ?? '',
    visitType: stored.visitType ?? import.meta.env.VITE_VISIT_TYPE ?? '',
    doctorId: stored.doctorId ?? import.meta.env.VITE_DOCTOR_ID ?? '',
  };
}
