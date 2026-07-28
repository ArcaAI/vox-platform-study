export const consultationReviewKeys = {
  root: ['consultation-review'] as const,
  detail: (consultationId: string) => [...consultationReviewKeys.root, consultationId] as const,
};
