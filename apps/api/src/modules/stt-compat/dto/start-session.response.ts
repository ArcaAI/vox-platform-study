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
}
