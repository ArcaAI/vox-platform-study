'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListParams } from '@/shared/api';
import {
    createModel,
    deleteModel,
    discoverModels,
    getModel,
    getModelBySlug,
    listModels,
    listModelsPaginated,
    registerDiscoveredModel,
    updateModel,
} from './client';
import { aiModelKeys } from './keys';
import type { CreateModelRequest, RegisterDiscoveredModelRequest, UpdateModelRequest } from './types';

export function useModels() {
    return useQuery({ queryKey: aiModelKeys.all(), queryFn: listModels });
}

export function useModelsPaginated(params?: ListParams) {
    return useQuery({ queryKey: aiModelKeys.list(params), queryFn: () => listModelsPaginated(params), placeholderData: keepPreviousData });
}

export function useModel(id: string) {
    return useQuery({ queryKey: aiModelKeys.detail(id), queryFn: () => getModel(id), enabled: !!id });
}

export function useModelBySlug(slug: string) {
    return useQuery({ queryKey: aiModelKeys.bySlug(slug), queryFn: () => getModelBySlug(slug), enabled: !!slug });
}

function useInvalidateModels() {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: aiModelKeys.root });
}

export function useCreateModel() {
    const invalidate = useInvalidateModels();
    return useMutation({ mutationFn: (body: CreateModelRequest) => createModel(body), onSuccess: invalidate });
}

export function useUpdateModel() {
    const invalidate = useInvalidateModels();
    return useMutation({
        mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateModelRequest; etag: string }) => updateModel(id, patch, etag),
        onSuccess: invalidate,
    });
}

export function useDeleteModel() {
    const invalidate = useInvalidateModels();
    return useMutation({ mutationFn: (id: string) => deleteModel(id), onSuccess: invalidate });
}

/**
 * TASK-528 — live merge view. `enabled` gates the probe so it fires only when
 * the drawer is open (the registry grid must never wait on an engine probe);
 * a 30 s `staleTime` keeps re-opens instant while `probedAt` + the Refresh
 * button make staleness explicit rather than silent.
 */
export function useModelDiscovery(provider: string | undefined, enabled: boolean) {
    return useQuery({
        queryKey: aiModelKeys.discovery(provider),
        queryFn: () => discoverModels(provider),
        enabled,
        staleTime: 30_000,
        retry: false,
    });
}

/**
 * Registering invalidates the whole `ai-models` root, so BOTH the drawer entry
 * (→ `registered`) and the registry grid behind it refresh — no manual reload.
 */
export function useRegisterDiscoveredModel() {
    const invalidate = useInvalidateModels();
    return useMutation({
        mutationFn: (body: RegisterDiscoveredModelRequest) => registerDiscoveredModel(body),
        onSuccess: invalidate,
    });
}
