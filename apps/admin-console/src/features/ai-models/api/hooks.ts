'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListParams } from '@/shared/api';
import { createModel, deleteModel, getModel, getModelBySlug, listModels, listModelsPaginated, updateModel } from './client';
import { aiModelKeys } from './keys';
import type { CreateModelRequest, UpdateModelRequest } from './types';

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
