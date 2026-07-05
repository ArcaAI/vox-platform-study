'use client';

/**
 * TASK-424 — cross-feature id → name catalogs. Features may not import each
 * other, so the tiny read-only lookups (tenants, roles, departments) live in
 * shared with their own minimal wire types. Queries are cached (staleTime) and
 * NEVER throw at the call site: a caller without permission for a catalog
 * (e.g. tenant admin on a global list) just gets an empty catalog and the UI
 * falls back to showing the raw id.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getJson } from '@/shared/api';
import type { Paginated } from '@/shared/api';

/** Platform-wide rows (e.g. GLOBAL_ADMIN role assignments) use the SYSTEM tenant. */
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const CATALOG_STALE_MS = 5 * 60 * 1000;
/** Catalogs are small reference lists; one large page covers them. */
const CATALOG_LIMIT = 500;

interface CatalogTenant {
    id: string;
    name: string;
    key?: string;
}

interface CatalogRole {
    id: string;
    name: string;
    description?: string;
    isSystemRole?: boolean;
}

/** RBAC's custom list envelope ({ data, total, page, pageSize }). */
interface RbacEnvelope<T> {
    data: T[];
}

interface CatalogDepartment {
    id: string;
    code?: string;
    name?: string;
    isRootDepartment?: boolean;
}

export interface CatalogOption {
    value: string;
    label: string;
}

export function useTenantCatalog() {
    return useQuery({
        queryKey: ['catalog', 'tenants'],
        queryFn: () => getJson<Paginated<CatalogTenant>>('admin/tenants', { limit: CATALOG_LIMIT }),
        staleTime: CATALOG_STALE_MS,
        retry: false,
        select: (res) => res.data,
    });
}

/**
 * id → display-name map for tenants. Empty while loading or when the caller
 * cannot list tenants — render `names.get(id) ?? id` so cells degrade to ids.
 */
export function useTenantNames(): Map<string, string> {
    const { data } = useTenantCatalog();
    return useMemo(() => new Map((data ?? []).map((tenant) => [tenant.id, tenant.name || tenant.key || tenant.id])), [data]);
}

export function useRoleCatalog() {
    return useQuery({
        queryKey: ['catalog', 'roles'],
        queryFn: () => getJson<RbacEnvelope<CatalogRole>>('admin/rbac/roles', { pageSize: CATALOG_LIMIT }),
        staleTime: CATALOG_STALE_MS,
        retry: false,
        select: (res) => res.data,
    });
}

export function useDepartmentCatalog() {
    return useQuery({
        queryKey: ['catalog', 'departments'],
        queryFn: () => getJson<CatalogDepartment[]>('admin/departments', { limit: CATALOG_LIMIT }),
        staleTime: CATALOG_STALE_MS,
        retry: false,
    });
}

export function departmentLabel(department: CatalogDepartment): string {
    if (department.name && department.code) return `${department.name} (${department.code})`;
    return department.name ?? department.code ?? department.id;
}

/** Select-ready options; empty while loading/unauthorized. */
export function useRoleOptions(): { options: CatalogOption[]; isLoading: boolean; isError: boolean } {
    const { data, isLoading, isError } = useRoleCatalog();
    const options = useMemo(() => (data ?? []).map((role) => ({ value: role.id, label: role.name })), [data]);
    return { options, isLoading, isError };
}

/** Select-ready options; empty while loading/unauthorized. */
export function useDepartmentOptions(): { options: CatalogOption[]; isLoading: boolean; isError: boolean } {
    const { data, isLoading, isError } = useDepartmentCatalog();
    const options = useMemo(() => (data ?? []).map((department) => ({ value: department.id, label: departmentLabel(department) })), [data]);
    return { options, isLoading, isError };
}
