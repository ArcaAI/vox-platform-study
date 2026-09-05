export const ttsConfigKeys = {
  root: ['tenant-tts-config'] as const,
  effective: () => [...ttsConfigKeys.root, 'effective'] as const,
};
