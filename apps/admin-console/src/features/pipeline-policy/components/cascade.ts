/**
 * Cascade math shared by the resolve card, the matrix grid and the row
 * editor. The API exposes raw scope rows (nullable pins) plus ONE resolved
 * effective read with a per-toggle trace; inherited values and the pre-save
 * preview are derived from those client-side, falling back to "not
 * derivable" instead of guessing when a tier is not readable.
 */

import type {
    PipelinePolicyEffective,
    PipelinePolicyRow,
    PipelinePolicyScope,
    PipelinePolicyTraceSource,
    PipelineToggleKey,
} from '../api';

export const EM_DASH = '\u2014';

/** Matrix tiers, top of the cascade first. SYSTEM is read-only here. */
export type CascadeTier = 'SYSTEM' | PipelinePolicyScope;

export interface ToggleColumn {
    key: PipelineToggleKey;
    /** Short matrix column header per frame 39. */
    heading: string;
    /** Human name used by the editor. */
    label: string;
    /** nuqs `key` filter value (also the resolve-card display name). */
    param: string;
}

export const TOGGLE_COLUMNS: ToggleColumn[] = [
    { key: 'autoSummaryEnabled', heading: 'auto-sum', label: 'Auto-summary', param: 'auto-summary' },
    { key: 'autoNerEnabled', heading: 'auto-NER', label: 'Auto-NER', param: 'auto-ner' },
    { key: 'harnessEnabled', heading: 'routing', label: 'Harness routing', param: 'routing' },
];

/**
 * TASK-532 (E3-L2) — toggles only a GLOBAL_ADMIN may write.
 *
 * `harnessEnabled` gates guardrail's primary caller (the harness) and
 * `autoNerEnabled` gates NLP auto-extraction; per the owner directive both AI
 * services are controlled by global admins only. The authoritative source is the
 * `globalOnly` flag on the `pipeline.*` registry descriptors, enforced in
 * `PipelinePolicyService.upsertRow` — this mirror exists only so the console can
 * disable the control instead of letting the save 403.
 */
export const GLOBAL_ONLY_TOGGLE_KEYS: PipelineToggleKey[] = ['harnessEnabled', 'autoNerEnabled'];

/** Copy shown under a governed toggle (rule 11 §5: visible reason). */
export const GLOBAL_ONLY_TOGGLE_HINT = 'Global admins only';

export function toggleColumnByParam(param: string): ToggleColumn {
    return TOGGLE_COLUMNS.find((column) => column.param === param) ?? TOGGLE_COLUMNS[0];
}

/** Boolean display: routing is a harness-vs-legacy choice, the rest on/off. */
export function toggleLabel(key: PipelineToggleKey, value: boolean): string {
    if (key === 'harnessEnabled') return value ? 'harness' : 'legacy';
    return value ? 'on' : 'off';
}

/** Tri-state editor value for one nullable pin. */
export type TriState = 'inherit' | 'on' | 'off';

export function pinToTri(pin: boolean | null): TriState {
    if (pin === null) return 'inherit';
    return pin ? 'on' : 'off';
}

export function triToPin(tri: TriState): boolean | null {
    if (tri === 'inherit') return null;
    return tri === 'on';
}

export function triOptionLabel(key: PipelineToggleKey, tri: TriState): string {
    if (tri === 'inherit') return `Inherit (${EM_DASH})`;
    return toggleLabel(key, tri === 'on');
}

/** Loaded cascade inputs. null = not loaded / not readable, never an error. */
export interface CascadeRows {
    effective: PipelinePolicyEffective | null;
    /** SYSTEM-tenant platform row — readable by elevated sessions only. */
    systemRow: PipelinePolicyRow | null;
    tenantRow: PipelinePolicyRow | null;
    departmentRow: PipelinePolicyRow | null;
    doctorRow: PipelinePolicyRow | null;
}

const TRACE_TIER: Record<PipelinePolicyTraceSource, CascadeTier | null> = {
    doctor: 'DOCTOR',
    department: 'DEPARTMENT',
    tenant: 'TENANT',
    'system-default': 'SYSTEM',
    'code-default': null,
};

/** The tier whose pin won the effective resolution (null = code default). */
export function winningTier(key: PipelineToggleKey, effective: PipelinePolicyEffective | null): CascadeTier | null {
    const source = effective?.trace[key];
    return source ? TRACE_TIER[source] : null;
}

/**
 * The SYSTEM tier's pin. Elevated sessions read the row itself; tenant
 * sessions derive it from the trace — when SYSTEM wins, the effective value
 * IS the pin; when the code default wins, SYSTEM holds no pin; when a lower
 * tier wins the pin is not observable (undefined).
 */
export function systemPin(key: PipelineToggleKey, rows: CascadeRows): boolean | null | undefined {
    if (rows.systemRow) return rows.systemRow[key];
    const source = rows.effective?.trace[key];
    if (source === 'system-default') return rows.effective ? rows.effective[key] : undefined;
    if (source === 'code-default') return null;
    return undefined;
}

/**
 * The value a `null` (inherit) pin at `tier` resolves to, walking the loaded
 * pins upward (department → tenant → SYSTEM → code default). Returns null
 * when the answer is not derivable from this session's reads.
 */
export function resolveInherited(key: PipelineToggleKey, tier: CascadeTier, rows: CascadeRows): boolean | null {
    const codeDefault = (): boolean | null => {
        const effective = rows.effective;
        // The code default is only observable when nothing above it pins the toggle.
        return effective && effective.trace[key] === 'code-default' ? effective[key] : null;
    };
    const fromSystemDown = (): boolean | null => {
        const pin = systemPin(key, rows);
        if (pin === true || pin === false) return pin;
        return codeDefault();
    };
    if (tier === 'SYSTEM') return codeDefault();
    if (tier === 'TENANT') return fromSystemDown();
    if (tier === 'DEPARTMENT') return rows.tenantRow?.[key] ?? fromSystemDown();
    return rows.departmentRow?.[key] ?? rows.tenantRow?.[key] ?? fromSystemDown();
}

export interface PreviewLine {
    column: ToggleColumn;
    value: boolean;
    /** Winning-tier attribution, e.g. 'dept CARD', 'tenant', 'code default'. */
    from: string;
}

/**
 * Recompute the effective value per toggle with `draftPins` applied at
 * `editedScope` (frame 39: preview recomputes before save) — nearest defined
 * pin wins, doctor → department → tenant → SYSTEM → code default. When an
 * unreadable tier above still pins the toggle, the currently-served
 * effective value is the best available answer.
 */
export function previewResolution(
    draftPins: Record<PipelineToggleKey, boolean | null>,
    editedScope: PipelinePolicyScope,
    rows: CascadeRows,
    context: { department: string | null; doctor: string | null },
): PreviewLine[] {
    return TOGGLE_COLUMNS.map((column) => {
        const key = column.key;
        const pinAt = (scope: PipelinePolicyScope): boolean | null => {
            if (scope === editedScope) return draftPins[key];
            if (scope === 'TENANT') return rows.tenantRow?.[key] ?? null;
            if (scope === 'DEPARTMENT') return rows.departmentRow?.[key] ?? null;
            return rows.doctorRow?.[key] ?? null;
        };

        const doctor = pinAt('DOCTOR');
        if (doctor !== null) return { column, value: doctor, from: context.doctor ? `doctor ${context.doctor}` : 'doctor' };
        const department = pinAt('DEPARTMENT');
        if (department !== null) return { column, value: department, from: context.department ? `dept ${context.department}` : 'department' };
        const tenant = pinAt('TENANT');
        if (tenant !== null) return { column, value: tenant, from: 'tenant' };
        const system = systemPin(key, rows);
        if (system === true || system === false) return { column, value: system, from: 'system' };
        const effective = rows.effective;
        if (effective && effective.trace[key] === 'code-default') return { column, value: effective[key], from: 'code default' };
        return { column, value: effective ? effective[key] : false, from: 'current effective' };
    });
}
