/** TanStack Query keys for the shared sandbox seam (moved from `features/workbench/api/keys.ts`,
 *  TASK-893 — root renamed `workbench` -> `sandbox`; the `definitions` key is gone with
 *  `useWorkflowDefinitions`, see `./types.ts`'s file banner). */
export const sandboxKeys = {
  root: ['sandbox'] as const,
  fixtures: (params?: { page?: number; limit?: number }) => [...sandboxKeys.root, 'fixtures', params ?? {}] as const,
  sandboxRunStatus: (definitionId: string, runId: string) => [...sandboxKeys.root, 'sandbox-run', definitionId, runId] as const,
  runTrace: (runId: string) => [...sandboxKeys.root, 'run-trace', runId] as const,
  /**
   * TASK-1036 — the latest Test-tab run of a definition (memory only, never storage). Deliberately
   * OUTSIDE `root`: the fixture mutations invalidate `root`, and a refetch of this client-held
   * entry would wipe it.
   */
  latestRun: (definitionId: string) => ['sandbox-latest-run', definitionId] as const,
};
