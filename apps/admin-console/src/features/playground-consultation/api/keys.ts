export const playgroundConsultationKeys = {
  root: ['playground-consultation'] as const,
  latestSummary: (consultationId: string) => [...playgroundConsultationKeys.root, 'latest-summary', consultationId] as const,
  latestPreSummary: (consultationId: string) => [...playgroundConsultationKeys.root, 'latest-pre-summary', consultationId] as const,
  namedEntities: (consultationId: string, scope: string = 'single') =>
    [...playgroundConsultationKeys.root, 'named-entities', consultationId, scope] as const,
  job: (jobId: string) => [...playgroundConsultationKeys.root, 'job', jobId] as const,
  transcriptions: (consultationId: string) => [...playgroundConsultationKeys.root, 'transcriptions', consultationId] as const,
  provenance: (consultationId: string, contextItemId: string) =>
    [...playgroundConsultationKeys.root, 'provenance', consultationId, contextItemId] as const,
  documentSectionsHydrate: (consultationId: string) => [...playgroundConsultationKeys.root, 'document-sections-hydrate', consultationId] as const,
};
