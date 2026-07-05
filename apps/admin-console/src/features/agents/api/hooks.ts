'use client';

/**
 * TanStack Query v5 hooks for the agents surface. Mutations invalidate the
 * whole ['agents'] namespace — an admin console prefers fresh reads over
 * cache cleverness (rule 13). The one deliberate exception: useTestTemplate
 * invalidates NOTHING — a test run is a dry-run tool, and its result carries
 * the row's new OCC version directly.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    activateVersion,
    assignDepartment,
    createTemplate,
    deleteTemplate,
    diffVersions,
    getTemplate,
    getUsageAnalytics,
    getUsageStats,
    listDepartments,
    listTemplates,
    listUsageRecords,
    listVersions,
    testTemplate,
    updateTemplate,
} from './client';
import { agentKeys } from './keys';
import type {
    AssignDepartmentRequest,
    CreateTemplateRequest,
    ListTemplatesParams,
    ListUsageRecordsParams,
    TestTemplateRequest,
    UpdateTemplateRequest,
} from './types';

export function useTemplates(params?: ListTemplatesParams) {
    return useQuery({ queryKey: agentKeys.list(params), queryFn: () => listTemplates(params) });
}

/** Detail read: `data.data` is the template, `data.etag` feeds PATCH/test. */
export function useTemplate(id: string) {
    return useQuery({ queryKey: agentKeys.detail(id), queryFn: () => getTemplate(id), enabled: !!id });
}

export function useVersions(id: string) {
    return useQuery({ queryKey: agentKeys.versions(id), queryFn: () => listVersions(id), enabled: !!id });
}

/** Diff of two picked versions; held off until both sides differ. */
export function useVersionDiff(id: string, from: number | null, to: number | null) {
    return useQuery({
        queryKey: agentKeys.diff(id, from ?? 0, to ?? 0),
        queryFn: () => diffVersions(id, from as number, to as number),
        enabled: !!id && from !== null && to !== null && from !== to,
    });
}

export function useUsageStats(id: string) {
    return useQuery({ queryKey: agentKeys.usage(id), queryFn: () => getUsageStats(id), enabled: !!id });
}

export function useUsageAnalytics(promptTemplateId?: string) {
    return useQuery({ queryKey: agentKeys.analytics(promptTemplateId), queryFn: () => getUsageAnalytics(promptTemplateId) });
}

export function useUsageRecords(params?: ListUsageRecordsParams) {
    return useQuery({ queryKey: agentKeys.usageRecords(params), queryFn: () => listUsageRecords(params) });
}

export function useDepartments() {
    return useQuery({ queryKey: agentKeys.departments(), queryFn: listDepartments });
}

function useInvalidateAgents() {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: agentKeys.root });
}

export function useCreateTemplate() {
    const invalidate = useInvalidateAgents();
    return useMutation({ mutationFn: (body: CreateTemplateRequest) => createTemplate(body), onSuccess: invalidate });
}

export function useUpdateTemplate() {
    const invalidate = useInvalidateAgents();
    return useMutation({
        mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateTemplateRequest; etag: string }) => updateTemplate(id, patch, etag),
        onSuccess: invalidate,
    });
}

export function useDeleteTemplate() {
    const invalidate = useInvalidateAgents();
    return useMutation({ mutationFn: (id: string) => deleteTemplate(id), onSuccess: invalidate });
}

export function useActivateVersion() {
    const invalidate = useInvalidateAgents();
    return useMutation({
        mutationFn: ({ id, versionNumber }: { id: string; versionNumber: number }) => activateVersion(id, versionNumber),
        onSuccess: invalidate,
    });
}

/** Dry-run tool: deliberately NO cache invalidation (see module doc). */
export function useTestTemplate() {
    return useMutation({
        mutationFn: ({ id, body, etag }: { id: string; body: TestTemplateRequest; etag: string }) => testTemplate(id, body, etag),
    });
}

export function useAssignDepartment() {
    const invalidate = useInvalidateAgents();
    return useMutation({ mutationFn: (body: AssignDepartmentRequest) => assignDepartment(body), onSuccess: invalidate });
}
