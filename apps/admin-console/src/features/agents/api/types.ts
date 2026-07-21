/**
 * Wire types mirroring the prompt-management DTOs in @arcaai/applications
 * (PromptTemplateResponse and friends — the console cannot import that server
 * package, so the shapes are declared here once, matching the gateway).
 */

import type { ResourceStatus } from '@/shared/api';

export type PromptTemplateCategory = 'SYSTEM' | 'SUMMARY' | 'DNA_ANALYSIS' | 'CUSTOM';
/**
 * Mirrors the `PromptTemplateStatus` Prisma enum
 * (`packages/database/src/prisma/db_main/prompt-template.prisma`).
 *
 * `APPROVED` was MISSING here — the retired `/prompt-studio` feature
 * declared all three while this copy stopped at PUBLISHED, so an approved row
 * coming back from the list endpoint was already outside the declared type. The
 * governance fold made it load-bearing (the approve write returns APPROVED), so
 * the type is corrected rather than worked around.
 */
export type PromptTemplateStatus = 'DRAFT' | 'PUBLISHED' | 'APPROVED';
export type PromptTemplateScope = 'TENANT_DEFAULT' | 'DEPARTMENT_DEFAULT' | 'USER_PERSONAL';

/**
 * GET /admin/prompt-templates rows (PromptTemplateResponse). `version` is the
 * OCC row token (echo as If-Match), DISTINCT from `currentVersionNumber` —
 * the human-meaningful PromptVersion history counter shown as "vN".
 */
export interface PromptTemplate {
    id: string;
    name: string;
    description?: string;
    content: string;
    category: PromptTemplateCategory;
    scope?: PromptTemplateScope;
    status: PromptTemplateStatus;
    variables?: Record<string, unknown>;
    currentVersionNumber: number;
    departmentId?: string;
    tags?: string[];
    createdAt: string;
    updatedAt: string;
    resourceStatus?: ResourceStatus;
    /** Score (0-100 per DTO example; service emits [0,1]) of the last test run. */
    lastTestScore?: number;
    lastTestAt?: string;
    version: number;
}

/**
 * List query for GET /admin/prompt-templates. NOTE: unlike the platform's
 * zero-based PaginatedQuery, this controller is ONE-based (`page || 1`);
 * page=0 silently becomes page 1.
 */
export interface ListTemplatesParams {
    category?: PromptTemplateCategory;
    status?: PromptTemplateStatus;
    departmentId?: string;
    search?: string;
    includeDisabled?: boolean;
    scope?: PromptTemplateScope;
    ownerUserId?: string;
    /** One-based page number (this endpoint deviates from the 0-based convention). */
    page?: number;
    limit?: number;
    [key: string]: string | number | boolean | undefined | null;
}

export interface CreateTemplateRequest {
    name: string;
    description?: string;
    content: string;
    category: PromptTemplateCategory;
    status?: PromptTemplateStatus;
    variables?: Record<string, unknown>;
    departmentId?: string;
    tags?: string[];
    scope?: PromptTemplateScope;
    ownerUserId?: string;
}

/** PATCH :id body — If-Match route; expectedVersion is added by the client. */
export interface UpdateTemplateRequest {
    name?: string;
    description?: string;
    content?: string;
    status?: PromptTemplateStatus;
    variables?: Record<string, unknown>;
    tags?: string[];
    /** Stored in the PromptVersion history row. */
    changeReason?: string;
    resourceStatus?: 'ENABLED' | 'DISABLED';
}

/** GET :id/versions rows (PromptVersionResponse). */
export interface PromptVersion {
    id: string;
    promptTemplateId: string;
    versionNumber: number;
    content: string;
    variables?: Record<string, unknown>;
    changeReason?: string;
    changedBy?: string;
    createdAt: string;
}

/** One line-diff segment (shape-compatible with the `diff` npm package). */
export interface PromptDiffChange {
    value: string;
    added?: boolean;
    removed?: boolean;
    count?: number;
}

export interface PromptDiffStats {
    additions: number;
    deletions: number;
    unchanged: number;
}

export interface PromptFieldDiff {
    field: string;
    changed: boolean;
    before?: string;
    after?: string;
    changes: PromptDiffChange[];
    stats: PromptDiffStats;
}

/**
 * GET :id/versions/:from/diff/:to (PromptVersionDiffResponse). Top-level
 * changes/patch/stats are the COMBINED content+variables line diff;
 * `fields[]` is the per-field breakdown.
 */
export interface PromptVersionDiff {
    promptTemplateId: string;
    fromVersion: number;
    toVersion: number;
    fields: PromptFieldDiff[];
    changes: PromptDiffChange[];
    patch: string;
    stats: PromptDiffStats;
}

/** POST :id/test body — If-Match route; expectedVersion is added by the client. */
export interface TestTemplateRequest {
    /** Sample values interpolated into the template `{{variables}}`. */
    variables?: Record<string, unknown>;
    /** Extra sample input (e.g. transcript excerpt) appended to the prompt. */
    sampleInput?: string;
}

/** Per-dimension breakdown behind the composite test score. */
export interface PromptTestMetrics {
    wordCount: number;
    nonEmpty: boolean;
    lengthScore: number;
    jsonExpected: boolean;
    jsonValid: boolean | null;
    variablesDeclared: number;
    variableCoverage: number | null;
}

/**
 * POST :id/test result (PromptTestResultResponse). `version` is the row's NEW
 * OCC token after the score/output were persisted, so the caller can keep
 * editing without a re-fetch.
 */
export interface PromptTestResult {
    id: string;
    /** Composite deterministic output-quality proxy in [0, 1]. */
    score: number;
    output: string;
    testedAt: string;
    version: number;
    metrics?: PromptTestMetrics;
}

/** GET :id/usage (PromptUsageStatsResponse — all-time, not windowed). */
export interface PromptUsageStats {
    totalUsages: number;
    lastUsedAt: string | null;
}

export interface PromptUsageByDepartment {
    departmentId: string | null;
    count: number;
}

export interface PromptUsageByDoctor {
    doctorId: string | null;
    count: number;
}

export interface PromptUsageByDay {
    /** UTC day bucket (YYYY-MM-DD). */
    day: string;
    count: number;
}

/** GET analytics/usage (PromptUsageAnalyticsResponse). */
export interface PromptUsageAnalytics {
    totalUsages: number;
    byDepartment: PromptUsageByDepartment[];
    byDoctor: PromptUsageByDoctor[];
    byDay: PromptUsageByDay[];
}

/** GET usage-records rows (PromptUsageRecordResponse — one agent run each). */
export interface PromptUsageRecord {
    id: string;
    promptTemplateId?: string | null;
    promptVersionNumber?: number | null;
    consultationId?: string | null;
    doctorId?: string | null;
    departmentId?: string | null;
    createdAt: string;
}

/** GET usage-records query — ZERO-based page (default 0), unlike the list. */
export interface ListUsageRecordsParams {
    page?: number;
    limit?: number;
    promptTemplateId?: string;
    [key: string]: string | number | boolean | undefined | null;
}

/**
 * POST assign-department body (AssignDepartmentPromptRequest). The REQUIRED
 * expectedVersion is the DEPARTMENT row's OCC version (from a prior
 * departments read) — not the template's.
 */
export interface AssignDepartmentRequest {
    departmentId: string;
    preSummaryPromptId?: string | null;
    newPatientPromptId?: string | null;
    revisitPromptId?: string | null;
    expectedVersion: number;
}

/**
 * GET /admin/departments rows (DepartmentResponse projection): the assign
 * dialog needs the id/code/name for the select, the current slot assignments,
 * and `version` as the assign-department expectedVersion source.
 */
export interface Department {
    id: string;
    code?: string;
    name?: string;
    isRootDepartment: boolean;
    preSummaryPromptId?: string;
    newPatientPromptId?: string;
    revisitPromptId?: string;
    resourceStatus?: ResourceStatus;
    createdAt: string;
    updatedAt: string;
    version: number;
}
