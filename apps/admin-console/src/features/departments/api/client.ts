/**
 * Department administration client (frame 30, capabilities-matrix row 23).
 * Envelope note: the list/roots/children reads return PLAIN ARRAYS (the
 * controller's `@ApiEndpoint(multi: true)` is Swagger-only sugar); only
 * :id/users answers with the house `Paginated` envelope.
 */

import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, versionFromEtag } from '@/shared/api';
import type { ListParams, Paginated, WithEtag } from '@/shared/api';
import type {
    CreateDepartmentRequest,
    Department,
    DepartmentMember,
    ListDepartmentsParams,
    UpdateDepartmentPromptConfigRequest,
    UpdateDepartmentRequest,
} from './types';

const BASE = 'admin/departments';

export function listDepartments(params?: ListDepartmentsParams): Promise<Department[]> {
    return getJson(BASE, params);
}

export function listRootDepartments(): Promise<Department[]> {
    return getJson(`${BASE}/roots`);
}

export function listDepartmentChildren(id: string): Promise<Department[]> {
    return getJson(`${BASE}/${encodeURIComponent(id)}/children`);
}

/** Detail read keeping the ETag for the later If-Match PATCH. */
export function getDepartment(id: string): Promise<WithEtag<Department>> {
    return getWithEtag(`${BASE}/${encodeURIComponent(id)}`);
}

export function getDepartmentByCode(code: string): Promise<WithEtag<Department>> {
    return getWithEtag(`${BASE}/code/${encodeURIComponent(code)}`);
}

export function listDepartmentUsers(id: string, params?: ListParams): Promise<Paginated<DepartmentMember>> {
    return getJson(`${BASE}/${encodeURIComponent(id)}/users`, params);
}

export function createDepartment(body: CreateDepartmentRequest): Promise<Department> {
    return postJson(BASE, body);
}

/** OCC PATCH: If-Match header + body expectedVersion derived from the ETag. */
export function updateDepartment(id: string, patch: UpdateDepartmentRequest, etag: string): Promise<WithEtag<Department>> {
    return patchWithEtag(`${BASE}/${encodeURIComponent(id)}`, { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

/** OCC PATCH of the prompt slots (bridges to Agents & Prompt Templates). */
export function updateDepartmentPromptConfig(
    id: string,
    patch: UpdateDepartmentPromptConfigRequest,
    etag: string,
): Promise<WithEtag<Department>> {
    return patchWithEtag(`${BASE}/${encodeURIComponent(id)}/prompt-config`, { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

/** Soft delete (400 when the department still has children). */
export function deleteDepartment(id: string): Promise<Department> {
    return deleteJson(`${BASE}/${encodeURIComponent(id)}`);
}
