/**
 * TASK-391 #24 (ST1) — pure helpers for the Global Settings surface.
 *
 * Backed by the real `GlobalSetting` model (`globalSetting.prisma` / seed
 * `11-global-setting.ts`): settings carry a `namespace` (general · feature-flags
 * · stt · smr · guardrail · ux-constants · admin · rate-limit) and a `locked`
 * write-guard (only super-admins may change locked rows — the server is the
 * source of truth; the console mirrors it by disabling the controls).
 */

import type { GlobalSetting } from '@arcaai/vox';

/** Canonical namespace order (design §5.6 section-nav order); unknowns follow, ungrouped last. */
const NAMESPACE_ORDER = ['general', 'feature-flags', 'stt', 'smr', 'guardrail', 'ux-constants', 'admin', 'rate-limit'];

/** Pretty labels for the known namespaces; unknown namespaces render verbatim. */
const NAMESPACE_LABELS: Record<string, string> = {
    general: 'General',
    'feature-flags': 'Feature flags',
    stt: 'STT',
    smr: 'SMR',
    guardrail: 'Guardrail',
    'ux-constants': 'UX constants',
    admin: 'Admin',
    'rate-limit': 'Rate limits',
};

export interface SettingGroup {
    /** Raw namespace key (`''` when the setting has no namespace). */
    key: string;
    /** Display label for the group subheader. */
    label: string;
    settings: GlobalSetting[];
}

/**
 * A setting is locked when the server flags `locked === true` (write-guarded).
 * Takes `unknown` (rather than `{ locked?: unknown }`) so a `GlobalSetting` — whose
 * `locked` lives under its `[key: string]: unknown` index signature, not a named
 * field — is accepted without tripping TS's weak-type "no common properties" check.
 */
export function isSettingLocked(setting: unknown): boolean {
    return typeof setting === 'object' && setting !== null && (setting as { locked?: unknown }).locked === true;
}

/** Human label for a namespace; `''`/nullish → "Other". */
export function namespaceLabel(namespace?: string | null): string {
    const ns = (namespace ?? '').trim();
    if (!ns) return 'Other';
    return NAMESPACE_LABELS[ns] ?? ns;
}

function namespaceRank(key: string): number {
    const i = NAMESPACE_ORDER.indexOf(key);
    if (i >= 0) return i;
    if (key === '') return Number.MAX_SAFE_INTEGER; // ungrouped ("Other") sorts last
    return NAMESPACE_ORDER.length; // unknown, non-empty namespaces sit between known + "Other"
}

/**
 * Group settings by namespace, ordered by the canonical section order (known
 * namespaces first, then unknown alphabetically, then ungrouped). Within a group
 * the original order is preserved. Pure — the UI renders a subheader per group.
 */
export function groupByNamespace(settings: GlobalSetting[]): SettingGroup[] {
    const map = new Map<string, GlobalSetting[]>();
    for (const s of settings) {
        const key = (typeof s.namespace === 'string' ? s.namespace.trim() : '') || '';
        const bucket = map.get(key);
        if (bucket) bucket.push(s);
        else map.set(key, [s]);
    }
    return [...map.entries()]
        .sort(([a], [b]) => {
            const ra = namespaceRank(a);
            const rb = namespaceRank(b);
            return ra !== rb ? ra - rb : a.localeCompare(b);
        })
        .map(([key, groupSettings]) => ({ key, label: namespaceLabel(key), settings: groupSettings }));
}
