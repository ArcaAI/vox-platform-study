/**
 * Prompt Studio client. Gateway-relative paths under the
 * /api/hope BFF proxy. The approve action is an OCC WRITE requiring If-Match
 * (GLOBAL_ADMIN-only server-side): expectedVersion is folded from the detail
 * read's ETag. Templates are tenant-owned, so the screen runs behind the
 * working-tenant gate.
 */

import { getJson, getWithEtag, request, versionFromEtag } from '@/shared/api';
import type { Paginated, WithEtag } from '@/shared/api';
import type { ListTemplatesParams, PromptTemplate, PromptVersion, PromptVersionDiff } from './types';

const BASE = 'admin/prompt-templates';
const templatePath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

/** NOTE: `page` is ONE-based on this endpoint (`page || 1` server-side). */
export function listTemplates(params?: ListTemplatesParams): Promise<Paginated<PromptTemplate>> {
    return getJson(BASE, params);
}

/** Detail read keeping the ETag for the later approve (If-Match). */
export function getTemplate(id: string): Promise<WithEtag<PromptTemplate>> {
    return getWithEtag(templatePath(id));
}

export function listVersions(id: string): Promise<PromptVersion[]> {
    return getJson(`${templatePath(id)}/versions`);
}

/** Server-side line-diff between two version numbers. */
export function diffVersions(id: string, from: number, to: number): Promise<PromptVersionDiff> {
    return getJson(`${templatePath(id)}/versions/${from}/diff/${to}`);
}

/**
 * Approve for clinical use (GLOBAL_ADMIN only). If-Match REQUIRED; expectedVersion
 * folded from the read ETag. Missing header → 428, version drift → 412,
 * non-global-admin → 403. Idempotent: approving an already-approved row returns it.
 */
export async function approveTemplate(id: string, reason: string | undefined, etag: string): Promise<PromptTemplate> {
    const response = await request<PromptTemplate>(`${templatePath(id)}/approve`, {
        method: 'POST',
        body: { expectedVersion: versionFromEtag(etag), ...(reason ? { reason } : {}) },
        etag,
    });
    return response.data;
}
