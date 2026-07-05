import type { PipelinePolicyEffectiveParams, PipelinePolicyScope } from './types';

export const pipelinePolicyKeys = {
    root: ['pipeline-policy'] as const,
    effective: (params: PipelinePolicyEffectiveParams) => [...pipelinePolicyKeys.root, 'effective', params] as const,
    row: (scope: PipelinePolicyScope, scopeId: string | null) => [...pipelinePolicyKeys.root, 'row', scope, scopeId ?? ''] as const,
    systemRow: () => [...pipelinePolicyKeys.root, 'system-row'] as const,
};
