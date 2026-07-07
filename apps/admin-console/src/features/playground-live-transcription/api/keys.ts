export const liveTranscriptionKeys = {
    root: ['playground-live-transcription'] as const,
    pipelines: () => [...liveTranscriptionKeys.root, 'pipelines'] as const,
    jobs: (params?: { page?: number; limit?: number }) => [...liveTranscriptionKeys.root, 'jobs', params ?? {}] as const,
    job: (id: string) => [...liveTranscriptionKeys.root, 'job', id] as const,
};
