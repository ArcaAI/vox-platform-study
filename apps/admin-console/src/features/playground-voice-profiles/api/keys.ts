export const voiceProfileKeys = {
    root: ['playground-voice-profiles'] as const,
    list: () => [...voiceProfileKeys.root, 'list'] as const,
};
