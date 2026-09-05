export interface EnrollVoiceProfileRequest {
  userId: string;
  audioBuffers: Buffer[];
  label?: string;
  /**
   * TASK-887 — the ASR agent this enrollment is FOR. Diarization is a declared agent option,
   * so the agent names the `SPEAKER_EMBEDDING` model that embeds the samples and the profile
   * is stored in THAT model's space. Absent ⇒ the tenant's assigned SPEECH_TO_TEXT agent via
   * the `AgentAssignment` cascade, which is what a session with no explicit agent will run.
   */
  agentSlug?: string;
}
