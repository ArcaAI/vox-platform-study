export const ttsConfigKeys = {
  root: ['tenant-tts-config'] as const,
  effective: () => [...ttsConfigKeys.root, 'effective'] as const,
  row: () => [...ttsConfigKeys.root, 'row'] as const,
  catalog: () => [...ttsConfigKeys.root, 'catalog'] as const,
};
