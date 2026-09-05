export const voiceProfileKeys = {
  root: ['playground-voice-profiles'] as const,
  list: () => [...voiceProfileKeys.root, 'list'] as const,
  enrollmentTarget: (agentSlug?: string) => [...voiceProfileKeys.root, 'enrollment-target', agentSlug ?? null] as const,
};
