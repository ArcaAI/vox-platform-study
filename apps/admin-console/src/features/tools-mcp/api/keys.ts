export const toolsMcpKeys = {
  root: ['tools-mcp'] as const,
  list: () => [...toolsMcpKeys.root, 'list'] as const,
  detail: (id: string) => [...toolsMcpKeys.root, 'detail', id] as const,
  /** The per-tenant MCP master gate read off the effective harness policy (OD-11). */
  gate: () => [...toolsMcpKeys.root, 'gate'] as const,
};
