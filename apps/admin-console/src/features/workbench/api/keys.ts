export const workbenchKeys = {
  root: ['workbench'] as const,
  definitions: (params?: { page?: number; limit?: number }) => [...workbenchKeys.root, 'definitions', params ?? {}] as const,
  fixtures: (params?: { page?: number; limit?: number }) => [...workbenchKeys.root, 'fixtures', params ?? {}] as const,
  sandboxRunStatus: (definitionId: string, runId: string) => [...workbenchKeys.root, 'sandbox-run', definitionId, runId] as const,
  runTrace: (runId: string) => [...workbenchKeys.root, 'run-trace', runId] as const,
};
