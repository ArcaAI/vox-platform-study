export const playgroundConsultationKeys = {
    root: ['playground-consultation'] as const,
    pipelines: () => [...playgroundConsultationKeys.root, 'pipelines'] as const,
    latestSummary: (consultationId: string) => [...playgroundConsultationKeys.root, 'latest-summary', consultationId] as const,
    namedEntities: (consultationId: string, scope: string = 'single') =>
        [...playgroundConsultationKeys.root, 'named-entities', consultationId, scope] as const,
    job: (jobId: string) => [...playgroundConsultationKeys.root, 'job', jobId] as const,
};
