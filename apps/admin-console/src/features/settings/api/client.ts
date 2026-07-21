/** Global settings admin (capabilities-matrix row 15). Secrets stay masked. */

import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, request, versionFromEtag } from '@/shared/api';
import type { ListParams, Paginated, WithEtag } from '@/shared/api';
import type { CreateGlobalSettingRequest, GlobalSetting, RevealedGlobalSetting, RotateGlobalSettingRequest, SettingHistoryEntry, UpdateGlobalSettingRequest } from './types';

const BASE = 'admin/settings';

/** Audit ResourceType the gateway records for global settings. */
const HISTORY_RESOURCE_TYPE = 'GlobalSetting';

export function listGlobalSettings(params?: ListParams): Promise<Paginated<GlobalSetting>> {
    return getJson(BASE, params);
}

export function listTenantScopedSettings(tenantId: string, params?: ListParams): Promise<Paginated<GlobalSetting>> {
    return getJson(`${BASE}/tenant/${encodeURIComponent(tenantId)}`, params);
}

export function getGlobalSetting(id: string): Promise<WithEtag<GlobalSetting>> {
    return getWithEtag(`${BASE}/${encodeURIComponent(id)}`);
}

export function createGlobalSetting(body: CreateGlobalSettingRequest): Promise<GlobalSetting> {
    return postJson(BASE, body);
}

/** OCC PATCH: If-Match required; expectedVersion derived from the read ETag. */
export function updateGlobalSetting(id: string, patch: UpdateGlobalSettingRequest, etag: string): Promise<WithEtag<GlobalSetting>> {
    return patchWithEtag(`${BASE}/${encodeURIComponent(id)}`, { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

export function deleteGlobalSetting(id: string): Promise<GlobalSetting> {
    return deleteJson(`${BASE}/${encodeURIComponent(id)}`);
}

/** Step-up reveal of a secret value (re-enter password; audited). */
export function revealGlobalSetting(id: string, password: string): Promise<RevealedGlobalSetting> {
    return postJson(`${BASE}/${encodeURIComponent(id)}/reveal`, { password });
}

/**
 * Rotate a secret: atomic server-side replace under OCC (If-Match
 * required, 428/412 semantics like the update PATCH) with step-up re-auth.
 * Returns the masked setting + fresh ETag; the plaintext never comes back.
 */
export function rotateGlobalSetting(id: string, body: RotateGlobalSettingRequest, etag: string): Promise<WithEtag<GlobalSetting>> {
    return request(`${BASE}/${encodeURIComponent(id)}/rotate`, {
        method: 'POST',
        body: { ...body, expectedVersion: versionFromEtag(etag) },
        etag,
    });
}

/** Shape the audit-log envelope exposes for a setting's change history. */
interface AuditHistoryRow {
    id: string;
    action?: string;
    createdAt?: string;
    responsibleUserId?: string | null;
    responsibleUser?: { id: string; displayName: string | null; email: string | null } | null;
    data?: { version?: number; _version?: number } | null;
}

/** Best-effort projection of an audit row onto the History tab shape. */
function toHistoryEntry(row: AuditHistoryRow): SettingHistoryEntry {
    const version = row.data?.version ?? row.data?._version ?? null;
    return {
        id: row.id,
        action: row.action ?? 'UPDATE',
        createdAt: row.createdAt ?? '',
        responsibleUserId: row.responsibleUserId ?? null,
        responsibleUser: row.responsibleUser ?? null,
        version: typeof version === 'number' ? version : null,
    };
}

/**
 * Change history for a setting, read from the audit log (no dedicated versions
 * endpoint exists). Newest first, capped — this drives the drawer's History tab.
 */
export async function listSettingHistory(id: string): Promise<SettingHistoryEntry[]> {
    const envelope = await getJson<Paginated<AuditHistoryRow>>(
        `admin/audit-logs/resource/${HISTORY_RESOURCE_TYPE}/${encodeURIComponent(id)}`,
        { limit: 20 },
    );
    return (envelope.data ?? []).map(toHistoryEntry);
}
