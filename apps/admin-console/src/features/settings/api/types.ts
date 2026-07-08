import type { BaseResource } from '@/shared/api';

/** GET /admin/settings rows (GlobalSettingResponse). value is '' when isSecret. */
export interface GlobalSetting extends BaseResource {
    name: string;
    description?: string;
    key: string;
    value: string;
    dataType: string;
    namespace?: string;
    /** TASK-430 — owning tenant of the row (the GLOBAL tenant holds platform defaults). */
    tenantId?: string | null;
    /** Locked platform default — only GLOBAL_ADMIN may edit. */
    locked: boolean;
    version: number;
    isSecret: boolean;
}

export interface CreateGlobalSettingRequest {
    name: string;
    description?: string;
    key: string;
    value: string;
    dataType: string;
    namespace?: string;
}

/** PATCH /admin/settings/:id body (expectedVersion added by the client). */
export interface UpdateGlobalSettingRequest {
    name?: string;
    description?: string;
    key?: string;
    value?: string;
    dataType?: string;
    namespace?: string;
}

/** POST /admin/settings/:id/reveal result — the unmasked secret. */
export interface RevealedGlobalSetting {
    id: string;
    key: string;
    value: string;
    revealedAt: string;
}

/**
 * POST /admin/settings/:id/rotate body (TASK-445) — the step-up password plus
 * the replacement secret; expectedVersion is added by the client from the
 * read ETag (OCC, same contract as the update PATCH). The response is the
 * MASKED GlobalSetting — the new plaintext is never returned.
 */
export interface RotateGlobalSettingRequest {
    password: string;
    newValue: string;
}

/**
 * A single history entry for a setting. There is no dedicated versions endpoint,
 * so the History tab is backed by the audit log
 * (`GET /admin/audit-logs/resource/GlobalSetting/:id`); this is the subset the
 * tab reads (actor · action · when · version). Kept local so the settings
 * feature does not import the audit-logs feature (rule 13: features never import
 * each other).
 */
export interface SettingHistoryEntry {
    id: string;
    action: string;
    createdAt: string;
    responsibleUserId: string | null;
    responsibleUser: { id: string; displayName: string | null; email: string | null } | null;
    /** Post-change version, when the audit payload carries one. */
    version: number | null;
}
