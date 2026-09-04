export const liveTranscriptionKeys = {
  root: ['playground-live-transcription'] as const,
  asrAgents: () => [...liveTranscriptionKeys.root, 'asr-agents'] as const,
  jobs: (params?: { page?: number; limit?: number }) => [...liveTranscriptionKeys.root, 'jobs', params ?? {}] as const,
  job: (id: string) => [...liveTranscriptionKeys.root, 'job', id] as const,
};
