export interface StopAudioInfo {
  sample_rate: number;
  channels: number;
  bit_depth: number;
  size_bytes: number;
}

export interface StopSessionResponse {
  message: string;
  session_id: string;
  status: string;
  audio_uploaded: boolean;
  audio_config?: StopAudioInfo;
}
