import type { Department } from '@/features/tenants/sdk-types';

/**
 * Map a department form draft → the SDK `create`/`update` payload
 * (`Partial<Department>`). Trims, and omits empty optional fields so the server
 * never receives `''` for an unset code/description.
 */
export interface DepartmentDraft {
    name: string;
    code?: string;
    description?: string;
}

export function toCreateDepartmentRequest(draft: DepartmentDraft): Partial<Department> {
    const request: Partial<Department> = { name: draft.name.trim() };
    const code = draft.code?.trim();
    if (code) request.code = code;
    const description = draft.description?.trim();
    if (description) request.description = description;
    return request;
}
