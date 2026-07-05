export const pstudioKeys = {
    root: ['pstudio'] as const,
    status: () => [...pstudioKeys.root, 'status'] as const,
};
