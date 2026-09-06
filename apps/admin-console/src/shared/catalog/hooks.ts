'use client';

/**
 * Cross-feature id → name catalogs. Features may not import each
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

/** Platform-wide rows (e.g. SUPER_ADMIN role assignments) use the SYSTEM tenant. */
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

/**
 * GET text-generations/providers row (TEXT provider catalog, matrix row 38). Wire shape
 * mirrors `apps/text/src/text/models/provider.py::ProviderInfo` verbatim
 * (snake_case) — the playground feature (`playground-llm/api/types.ts`) owns
 * its own copy for that surface; this one exists so the agents feature's Test
 * Bench (rule 13: features never import each other) can reuse the same
 * catalog read without depending on playground-llm.
 */
export interface TextProviderModel {
  name: string;
  size?: string;
}

export interface TextProvider {
  name: string;
  models: TextProviderModel[];
  is_available: boolean;
  is_default?: boolean;
  default_model?: string;
}

/** Tenant provider/model catalog for provider pickers outside playground-llm. */
export function useTextProviders() {
  return useQuery({
    queryKey: ['catalog', 'text-providers'],
    queryFn: () => getJson<TextProvider[]>('text-generations/providers'),
    staleTime: CATALOG_STALE_MS,
    retry: false,
  });
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

// ---------------------------------------------------------------------------
// TASK-890 §3.7 — the tenant model catalogue (BYO connections + the Hope
// provider). Replaces the prompt-test panel's dependency on the playground
// `text-generations/providers` list with the real picker-shaped catalogue.
// `useTextProviders` above stays for the playground, which owns its own copy.
// ---------------------------------------------------------------------------

export type CatalogueProviderGroup = 'byo' | 'hope';
export type CatalogueProviderClass = 'cloud-byo' | 'cloud-platform' | 'engine-served' | 'platform-self-host';
export type CatalogueModelReadiness = 'ready' | 'loadable' | 'engine_down' | 'weights_missing' | 'credential_missing' | 'unknown';

/** `GET admin/ai-models/catalogue` provider row — mirrors `CatalogueProviderResponse`. */
export interface CatalogueProvider {
  id: string;
  group: CatalogueProviderGroup;
  name: string;
  providerClass: CatalogueProviderClass | null;
  connectionId: string | null;
  usable: boolean;
  reason: string | null;
  modelCount: number;
}

/** `GET admin/ai-models/catalogue` model row — mirrors `CatalogueModelResponse`. */
export interface CatalogueModel {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  taskType: string;
  providerId: string;
  provider: string | null;
  providerClass: CatalogueProviderClass;
  readiness: CatalogueModelReadiness;
  readinessCheckedAt: string | null;
  readinessDetail: string | null;
  usable: boolean;
  unusableReason?: string | null;
}

export interface ModelCatalogue {
  providers: CatalogueProvider[];
  models: CatalogueModel[];
}

export interface ModelCatalogueParams {
  taskType?: string;
  providerGroup?: CatalogueProviderGroup;
  usableOnly?: boolean;
  [key: string]: string | number | boolean | undefined | null;
}

/** The tenant catalogue (BYO first, then the single "Hope provider" entry) for a provider>model picker. Read-only — writes stay on `/ai-providers`. */
export function useModelCatalogue(params?: ModelCatalogueParams) {
  return useQuery({
    queryKey: ['catalog', 'model-catalogue', params ?? {}],
    queryFn: () => getJson<ModelCatalogue>('admin/ai-models/catalogue', params),
    staleTime: CATALOG_STALE_MS,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// TASK-890 §3.4 — the caller tenant's consultation-context schemas, for the
// context-schema reference picker (an agent's `contextSchemaId`, a
// `core.trigger` node's reference binding).
// ---------------------------------------------------------------------------

/** `GET admin/consultation-context-schemas` row (a slim `ConsultationContextSchemaResponse` projection). */
export interface CatalogContextSchema {
  id: string;
  slug: string;
  name: string;
  status: string;
  pinnedVersionNumber: number | null;
  isDefault: boolean;
}

export function useContextSchemaCatalog() {
  return useQuery({
    queryKey: ['catalog', 'context-schemas'],
    queryFn: () => getJson<CatalogContextSchema[]>('admin/consultation-context-schemas'),
    staleTime: CATALOG_STALE_MS,
    retry: false,
  });
}

/** Select-ready options — only schemas with a PUBLISHED pin are bindable (an unpublished schema resolves nothing). */
export function useContextSchemaOptions(): { options: CatalogOption[]; isLoading: boolean; isError: boolean } {
  const { data, isLoading, isError } = useContextSchemaCatalog();
  const options = useMemo(
    () => (data ?? []).filter((schema) => schema.pinnedVersionNumber !== null).map((schema) => ({ value: schema.id, label: schema.name })),
    [data],
  );
  return { options, isLoading, isError };
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
