export const sttConfigKeys = {
  root: ['tenant-stt-config'] as const,
  effective: () => [...sttConfigKeys.root, 'effective'] as const,
  row: () => [...sttConfigKeys.root, 'row'] as const,
  fallbackCandidates: () => [...sttConfigKeys.root, 'fallback-candidates'] as const,
  credentials: () => [...sttConfigKeys.root, 'credentials'] as const,
};
