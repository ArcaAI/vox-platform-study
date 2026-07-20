import type { BaseResource, VersionedResource } from '@/shared/api';

/** Commercial plan (TenantPlan enum on the gateway). */
export type TenantPlan = 'ENTERPRISE' | 'PRO' | 'TRIAL' | 'STARTER';

/** GET /admin/tenants[...] rows (TenantResponse). */
export interface Tenant extends VersionedResource {
    name: string;
    key: string;
    description?: string;
    plan: TenantPlan | null;
    tags: string[];
}

export interface CreateTenantRequest {
    name: string;
    /** Optional — auto-generated from `name` when omitted (TASK-497 D3). */
    key?: string;
    description?: string;
    plan?: TenantPlan;
    tags?: string[];
}

/** TASK-497 §3.5 — the tenant's initial TENANT_ADMIN, for POST /admin/tenants/provision. */
export type ProvisionTenantAdmin =
    | { mode: 'existing'; userId: string }
    | { mode: 'new-local'; email: string; username?: string; password: string };

export interface ProvisionTenantRequest {
    tenantName: string;
    /** Optional — auto-generated from `tenantName` when omitted (TASK-497 D3). */
    tenantKey?: string;
    plan?: TenantPlan;
    admin: ProvisionTenantAdmin;
}

/** POST /admin/tenants/provision response (TenantProvisionResponse). */
export interface TenantProvisionResult {
    tenant: Tenant;
    adminUserId: string;
    tenantKey: string;
}

/** PATCH /admin/tenants/:id body (expectedVersion is added by the client). */
export interface UpdateTenantRequest {
    name?: string;
    key?: string;
    description?: string;
    resourceStatus?: 'ENABLED' | 'DISABLED';
    plan?: TenantPlan;
}

/** GET /admin/tenants/:id/usage (TenantUsageResponse). */
export interface TenantUsage {
    totalUsers: number;
    totalDepartments: number;
    totalPromptTemplates: number;
    totalPipelines: number;
    storageUsedBytes: number;
    storageQuotaBytes: number | null;
    transcriptionMinutes: number;
    summaries24h: number;
    totalConsultations: number;
}

/** GET /admin/tenants/configs/:identifier rows (TenantConfigResponse). */
export interface TenantConfig extends BaseResource {
    name: string;
    description?: string | null;
    key: string;
    defaultValue?: string | null;
    value: string;
    dataType: string;
    namespace?: string | null;
    tenantId: string;
    tenantCode?: string | null;
    /** Locked platform-owned default — global-admin-only write. */
    locked?: boolean;
    version: number;
}

/** One row of the bulk PATCH /admin/tenants/configs/:identifier body. */
export interface UpdateTenantConfigItem {
    id: string;
    value: string;
    description?: string;
    /** Per-row OCC token — the bulk update is all-or-nothing on drift (412). */
    expectedVersion: number;
}

/** GET/PUT /admin/tenant-frontend-config (TenantFrontendConfigResponse). */
export interface TenantFrontendConfig {
    id: string;
    tenantId: string;
    asrModel?: string | null;
    noiseCancel: boolean;
    vad: boolean;
    voiceEnrollment: boolean;
    diarization: boolean;
    captureRawAudio: boolean;
    /** Server-computed platform capability; disables the toggle when false. */
    platformRawCaptureCapable: boolean;
    transcriptionMode: 'LOCAL' | 'BACKEND';
    transcriptionModeLocked: boolean;
    captureMode?: 'RAW' | 'PROCESSED' | null;
    configJson?: Record<string, unknown> | null;
    resourceStatus?: string;
    createdAt: string;
    updatedAt: string;
    version: number;
}

/** PUT /admin/tenant-frontend-config body (upsert; all fields optional). */
export interface UpsertTenantFrontendConfigRequest {
    asrModel?: string | null;
    noiseCancel?: boolean;
    vad?: boolean;
    voiceEnrollment?: boolean;
    diarization?: boolean;
    captureRawAudio?: boolean;
    transcriptionMode?: 'LOCAL' | 'BACKEND';
    transcriptionModeLocked?: boolean;
    captureMode?: 'RAW' | 'PROCESSED' | null;
    configJson?: Record<string, unknown> | null;
    /** OCC token for updates of an existing row (omit on first upsert). */
    expectedVersion?: number;
}

/**
 * POST /admin/tenants/:id/pipelines/resync result (TASK-531, global admin only).
 * Reconciliation counts for one run against the SYSTEM pipeline templates.
 */
export interface PipelineResyncSummary {
    /** SYSTEM templates the tenant did not have; cloned in as locked copies. */
    added: number;
    /** Pristine locked copies advanced to the template's current config. */
    fastForwarded: number;
    /** Rows left alone — customized, unlocked, drifted, or already current. */
    skipped: number;
}
