'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListParams } from '@/shared/api';
import { createApiKey, deleteApiKey, getApiKey, getApiKeyUsage, getScopes, listApiKeys, revokeApiKey, rotateApiKey, updateApiKey } from './client';
import { apiKeyKeys } from './keys';
import type { CreateApiKeyRequest, UpdateApiKeyRequest } from './types';

export function useApiKeyScopes() {
    return useQuery({ queryKey: apiKeyKeys.scopes(), queryFn: getScopes, staleTime: Infinity });
}

export function useApiKeys(params?: ListParams) {
    return useQuery({ queryKey: apiKeyKeys.list(params), queryFn: () => listApiKeys(params) });
}

export function useApiKey(id: string) {
    return useQuery({ queryKey: apiKeyKeys.detail(id), queryFn: () => getApiKey(id), enabled: !!id });
}

export function useApiKeyUsage(id: string) {
    return useQuery({ queryKey: apiKeyKeys.usage(id), queryFn: () => getApiKeyUsage(id), enabled: !!id });
}

function useInvalidateApiKeys() {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: apiKeyKeys.root });
}

export function useCreateApiKey() {
    const invalidate = useInvalidateApiKeys();
    return useMutation({ mutationFn: (body: CreateApiKeyRequest) => createApiKey(body), onSuccess: invalidate });
}

export function useUpdateApiKey() {
    const invalidate = useInvalidateApiKeys();
    return useMutation({
        mutationFn: ({ id, body }: { id: string; body: UpdateApiKeyRequest }) => updateApiKey(id, body),
        onSuccess: invalidate,
    });
}

export function useRevokeApiKey() {
    const invalidate = useInvalidateApiKeys();
    return useMutation({ mutationFn: (id: string) => revokeApiKey(id), onSuccess: invalidate });
}

export function useRotateApiKey() {
    const invalidate = useInvalidateApiKeys();
    return useMutation({ mutationFn: (id: string) => rotateApiKey(id), onSuccess: invalidate });
}

export function useDeleteApiKey() {
    const invalidate = useInvalidateApiKeys();
    return useMutation({ mutationFn: (id: string) => deleteApiKey(id), onSuccess: invalidate });
}
