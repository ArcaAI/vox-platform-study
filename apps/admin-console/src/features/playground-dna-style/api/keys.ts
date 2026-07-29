export const playgroundDnaKeys = {
  root: ['playground-dna-style'] as const,
  myStyle: () => [...playgroundDnaKeys.root, 'my-style'] as const,
  redactionRules: () => [...playgroundDnaKeys.root, 'redaction-rules'] as const,
  reports: () => [...playgroundDnaKeys.root, 'reports'] as const,
  versions: (reportId: string) => [...playgroundDnaKeys.root, 'versions', reportId] as const,
  settings: () => [...playgroundDnaKeys.root, 'settings'] as const,
  job: (jobId: string) => [...playgroundDnaKeys.root, 'job', jobId] as const,
};
