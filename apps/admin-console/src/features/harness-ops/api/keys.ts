import type { AuditListParams, EvalRunListParams, GateEditExemplarsParams, GoldenCaseListParams, GoldenSetListParams, WorkflowListParams } from './types';

export const harnessOpsKeys = {
    root: ['harness-ops'] as const,
    audit: (params?: AuditListParams) => [...harnessOpsKeys.root, 'audit', params ?? {}] as const,
    evalRuns: (params?: EvalRunListParams) => [...harnessOpsKeys.root, 'eval-runs', params ?? {}] as const,
    evalRun: (id: string) => [...harnessOpsKeys.root, 'eval-run', id] as const,
    gateQueue: () => [...harnessOpsKeys.root, 'gate-queue'] as const,
    goldenSets: (params?: GoldenSetListParams) => [...harnessOpsKeys.root, 'golden-sets', params ?? {}] as const,
    goldenSet: (id: string) => [...harnessOpsKeys.root, 'golden-set', id] as const,
    goldenCases: (id: string, params?: GoldenCaseListParams) => [...harnessOpsKeys.root, 'golden-cases', id, params ?? {}] as const,
    gateEditExemplars: (params?: GateEditExemplarsParams) => [...harnessOpsKeys.root, 'gate-edit-exemplars', params ?? {}] as const,
    editBurden: (consultationId: string) => [...harnessOpsKeys.root, 'edit-burden', consultationId] as const,
    workflows: (params?: WorkflowListParams) => [...harnessOpsKeys.root, 'workflows', params ?? {}] as const,
    workflow: (id: string) => [...harnessOpsKeys.root, 'workflow', id] as const,
    liveSessions: () => [...harnessOpsKeys.root, 'live-sessions'] as const,
    liveSession: (id: string) => [...harnessOpsKeys.root, 'live-session', id] as const,
};
