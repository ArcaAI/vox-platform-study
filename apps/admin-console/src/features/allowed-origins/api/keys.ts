export const allowedOriginKeys = {
  root: ['allowed-origins'] as const,
  list: () => [...allowedOriginKeys.root, 'list'] as const,
  detail: (id: string) => [...allowedOriginKeys.root, 'detail', id] as const,
  posture: () => [...allowedOriginKeys.root, 'posture'] as const,
};
