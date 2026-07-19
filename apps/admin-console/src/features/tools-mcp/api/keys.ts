export const toolsMcpKeys = {
    root: ['tools-mcp'] as const,
    list: () => [...toolsMcpKeys.root, 'list'] as const,
    detail: (id: string) => [...toolsMcpKeys.root, 'detail', id] as const,
};
