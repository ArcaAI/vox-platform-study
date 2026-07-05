/**
 * Wire types mirroring the pipeline-policy DTOs in @arcaai/applications
 * (PipelinePolicyResponse, PipelinePolicyEffectiveResponse,
 * UpdatePipelinePolicyRequest) — declared here once, field-for-field.
 */

/** Cascade tier of an editable row (PipelinePolicyScope enum). */
export type PipelinePolicyScope = 'TENANT' | 'DEPARTMENT' | 'DOCTOR';

/** Where a row response was resolved from (PipelinePolicySource). */
export type PipelinePolicySource = 'tenant' | 'department' | 'doctor' | 'system-default' | 'code-default';

/** Which cascade tier supplied a resolved toggle (ConfigResolutionSource). */
export type PipelinePolicyTraceSource = 'doctor' | 'department' | 'tenant' | 'system-default' | 'code-default';

/** The three toggles this admin surface may write (+ read-only dnaStyleEnabled). */
export type PipelineToggleKey = 'autoSummaryEnabled' | 'autoNerEnabled' | 'harnessEnabled';

/**
 * GET/PUT /admin/harness/pipeline-policy/row — ONE raw, editable policy row.
 * Toggles are NULLABLE: null = inherit from the next cascade tier up.
 * `version` is the OCC token (0 = code-default placeholder, no ETag emitted).
 */
export interface PipelinePolicyRow {
    id: string | null;
    tenantId: string;
    scope: PipelinePolicyScope;
    scopeId: string | null;
    source: PipelinePolicySource;
    autoSummaryEnabled: boolean | null;
    autoNerEnabled: boolean | null;
    harnessEnabled: boolean | null;
    /** Doctor self-service storage — read-only on this admin surface. */
    dnaStyleEnabled: boolean | null;
    updatedAt: string | null;
    version: number;
}

/**
 * GET /admin/harness/pipeline-policy — the RESOLVED effective cascade for a
 * `tenant [+department] [+doctor]` context; `trace` reports the winning tier
 * per toggle. Read-only (no version).
 */
export interface PipelinePolicyEffective {
    tenantId: string;
    departmentId: string | null;
    doctorId: string | null;
    autoSummaryEnabled: boolean;
    autoNerEnabled: boolean;
    harnessEnabled: boolean;
    dnaStyleEnabled: boolean;
    trace: Record<string, PipelinePolicyTraceSource>;
}

/** Optional context for the effective-cascade read. */
export interface PipelinePolicyEffectiveParams {
    departmentId?: string;
    doctorId?: string;
    [key: string]: string | number | boolean | undefined | null;
}

/**
 * PUT body (UpdatePipelinePolicyRequest) — three-valued semantics per toggle:
 * omit = unchanged, true/false = pin at this scope, null = clear the pin
 * (inherit). `dnaStyleEnabled` is deliberately absent (doctor self-service).
 * `reason` lands on the WORM PipelinePolicyChange row.
 */
export interface UpdatePipelinePolicyRequest {
    autoSummaryEnabled?: boolean | null;
    autoNerEnabled?: boolean | null;
    harnessEnabled?: boolean | null;
    reason?: string;
    expectedVersion?: number;
}
