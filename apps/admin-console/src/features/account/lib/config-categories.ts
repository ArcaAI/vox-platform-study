/**
 * TASK-440 — client-side categorization for the tenant Settings tab.
 *
 * Tenant config rows (GET /tenant/me/config) carry no category metadata, so
 * the Settings sub-nav groups them here from key/namespace conventions. The
 * mapping is a pure function (unknown → `general`) and the ordered category
 * list drives the rail. `controlFor` picks the type-appropriate control for a
 * row's `dataType` (the heavy CodeEditor stays a settings-screen concern — Json
 * rows use a mono textarea on this self-service screen).
 */

import type { TenantConfig } from '@/features/tenants/api/types';

export type CategoryId = 'general' | 'clinical' | 'notifications' | 'security' | 'data-residency';

export interface CategoryMeta {
    id: CategoryId;
    label: string;
    description: string;
}

/** Ordered categories rendered in the rail (matches build spec §6 / artboard 2b). */
export const CONFIG_CATEGORIES: readonly CategoryMeta[] = [
    { id: 'general', label: 'General', description: 'Organization-wide defaults and feature flags.' },
    { id: 'clinical', label: 'Clinical defaults', description: 'Consultation, transcription and clinical documentation defaults.' },
    { id: 'notifications', label: 'Notifications', description: 'Email, webhook and alert delivery settings.' },
    { id: 'security', label: 'Security', description: 'Authentication, session and access controls.' },
    { id: 'data-residency', label: 'Data & residency', description: 'Data region, retention and storage policies.' },
] as const;

export const DEFAULT_CATEGORY: CategoryId = 'general';

/**
 * Keyword rules scanned against `"<namespace> <key>"`, most-specific first.
 * A row lands in the first category whose keyword matches; unknown → general.
 */
const CATEGORY_RULES: { id: Exclude<CategoryId, 'general'>; keywords: readonly string[] }[] = [
    { id: 'security', keywords: ['security', 'auth', 'session', 'password', 'mfa', 'sso', 'login', 'lockout', 'token'] },
    { id: 'data-residency', keywords: ['residency', 'region', 'retention', 'storage', 'backup', 'data-', 'archive', 'export'] },
    { id: 'notifications', keywords: ['notif', 'email', 'webhook', 'alert', 'smtp', 'digest', 'reminder'] },
    { id: 'clinical', keywords: ['clinic', 'consult', 'transcription', 'stt', 'asr', 'diariz', 'capture', 'audio', 'summar', 'dna', 'harness', 'documentation', 'noise', 'vad'] },
];

/** Deterministically bucket a config row into a category from its key/namespace. */
export function categorize(config: Pick<TenantConfig, 'key' | 'namespace'>): CategoryId {
    const haystack = `${config.namespace ?? ''} ${config.key}`.toLowerCase();
    for (const rule of CATEGORY_RULES) {
        if (rule.keywords.some((keyword) => haystack.includes(keyword))) return rule.id;
    }
    return DEFAULT_CATEGORY;
}

/** Group rows by category, preserving input order within each bucket. */
export function groupByCategory<T extends Pick<TenantConfig, 'key' | 'namespace'>>(configs: T[]): Record<CategoryId, T[]> {
    const groups = { general: [], clinical: [], notifications: [], security: [], 'data-residency': [] } as Record<CategoryId, T[]>;
    for (const config of configs) groups[categorize(config)].push(config);
    return groups;
}

export type ControlKind = 'switch' | 'number' | 'date' | 'textarea' | 'text';

/**
 * Control for a row's `dataType` (Prisma ValueType, case-insensitive; also
 * tolerates lowercase gateway aliases like `number`/`boolean`).
 */
export function controlFor(dataType: string | null | undefined): ControlKind {
    switch ((dataType ?? '').toLowerCase()) {
        case 'boolean':
            return 'switch';
        case 'integer':
        case 'float':
        case 'double':
        case 'decimal':
        case 'number':
            return 'number';
        case 'date':
        case 'datetime':
            return 'date';
        case 'json':
        case 'array':
            return 'textarea';
        default:
            return 'text';
    }
}
