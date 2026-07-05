'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getPipelinePolicyEffective, getPipelinePolicyRow, getSystemPipelinePolicyRow, putPipelinePolicyRow } from './client';
import { pipelinePolicyKeys } from './keys';
import type { PipelinePolicyEffectiveParams, PipelinePolicyScope, UpdatePipelinePolicyRequest } from './types';

export function usePipelinePolicyEffective(params: PipelinePolicyEffectiveParams = {}) {
    return useQuery({ queryKey: pipelinePolicyKeys.effective(params), queryFn: () => getPipelinePolicyEffective(params) });
}

export function usePipelinePolicyRow(scope: PipelinePolicyScope, scopeId: string | null, enabled = true) {
    return useQuery({
        queryKey: pipelinePolicyKeys.row(scope, scopeId),
        queryFn: () => getPipelinePolicyRow(scope, scopeId),
        enabled,
    });
}

/** Platform default row — 403 for tenant admins; only mount when elevated. */
export function useSystemPipelinePolicyRow(enabled: boolean) {
    return useQuery({ queryKey: pipelinePolicyKeys.systemRow(), queryFn: getSystemPipelinePolicyRow, enabled });
}

export function usePutPipelinePolicyRow() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({
            scope,
            scopeId,
            body,
            etag,
        }: {
            scope: PipelinePolicyScope;
            scopeId: string | null;
            body: UpdatePipelinePolicyRequest;
            etag: string | null;
        }) => putPipelinePolicyRow(scope, scopeId, body, etag),
        // A row edit moves both that row and every effective resolution below it.
        onSuccess: () => queryClient.invalidateQueries({ queryKey: pipelinePolicyKeys.root }),
    });
}
