export interface AudioConfig {
  sampleRate: number;
  format: string;
  channels: number;
  bitDepth: number;
  chunkSize: number;
  noiseCancellation: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  compressed_stream_format: string | null;
  wave_stream_format: number;
}

export interface StartSessionResponse {
  message: string;
  session_id: string;
  status: string;
  audio_config: AudioConfig;
  provider: string;
  /**
   * The RESOLVED ASR pipeline this session opened with. ADDITIVE
   * v1 clients ignore unknown keys. `provider` above is only the coarse enum
   * the caller sent, so it cannot answer "which pipeline is actually running"
   * for a caller that sent no `pipelineId` or opened on the tenant default.
   */
  pipeline_id?: string;
  /**
   * The engine live at create: `'primary'`, or `'fallback'` when the session
   * opened on the tenant fallback — by choice (`startOn: 'default'`) or because
   * the primary ASR failed to load.
   */
  active_engine?: 'primary' | 'fallback';
}
