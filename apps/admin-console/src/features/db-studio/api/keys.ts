export const dbStudioKeys = {
    root: ['pstudio'] as const,
    status: () => [...dbStudioKeys.root, 'status'] as const,
};
