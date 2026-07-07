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
