'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { approveTemplate, diffVersions, getTemplate, listTemplates, listVersions } from './client';
import { promptStudioKeys } from './keys';
import type { ListTemplatesParams } from './types';

export function useTemplates(params?: ListTemplatesParams) {
    return useQuery({ queryKey: promptStudioKeys.list(params), queryFn: () => listTemplates(params) });
}

export function useTemplate(id: string | null) {
    return useQuery({ queryKey: promptStudioKeys.detail(id ?? ''), queryFn: () => getTemplate(id as string), enabled: !!id });
}

export function useVersions(id: string | null) {
    return useQuery({ queryKey: promptStudioKeys.versions(id ?? ''), queryFn: () => listVersions(id as string), enabled: !!id });
}

export function useVersionDiff(id: string | null, from: number | null, to: number | null) {
    return useQuery({
        queryKey: promptStudioKeys.diff(id ?? '', from, to),
        queryFn: () => diffVersions(id as string, from as number, to as number),
        enabled: !!id && from !== null && to !== null && from !== to,
    });
}

export function useApproveTemplate() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, reason, etag }: { id: string; reason?: string; etag: string }) => approveTemplate(id, reason, etag),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: promptStudioKeys.root }),
    });
}
