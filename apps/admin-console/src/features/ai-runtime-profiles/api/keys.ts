/** Query keys for the platform runtime-profile plane. */
export const runtimeProfileKeys = {
  root: ['ai-runtime-profiles'] as const,
  list: () => [...runtimeProfileKeys.root, 'list'] as const,
  row: (provider: string, modelSlug: string) => [...runtimeProfileKeys.root, 'row', provider, modelSlug] as const,
  resolved: (provider: string, modelSlug: string) => [...runtimeProfileKeys.root, 'resolved', provider, modelSlug] as const,
};
