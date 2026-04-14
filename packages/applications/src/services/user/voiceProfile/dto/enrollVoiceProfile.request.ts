export interface EnrollVoiceProfileRequest {
  userId: string;
  audioBuffers: Buffer[];
  label?: string;
}
