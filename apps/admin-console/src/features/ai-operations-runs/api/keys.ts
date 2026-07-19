import type { ListSessionsParams } from './types';

export const aiRunsKeys = {
    root: ['ai-operations-runs'] as const,
    sessions: (params?: ListSessionsParams) => [...aiRunsKeys.root, 'sessions', params ?? {}] as const,
    steps: (sessionId: string, runId: string) => [...aiRunsKeys.root, 'steps', sessionId, runId] as const,
    gateQueue: () => [...aiRunsKeys.root, 'gate-queue'] as const,
};
