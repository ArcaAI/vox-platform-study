export const rateLimitKeys = {
    root: ['rate-limits'] as const,
    policy: () => [...rateLimitKeys.root, 'policy'] as const,
};
