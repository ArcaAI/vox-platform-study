/**
 * The agentic-loop knob descriptors surfaced by the global Agentic Policy
 * editor ( loop toggles + the safety/PHI kill-switches on the
 * HarnessPolicy row). One descriptor list keeps the form and the sparse-patch
 * builder in lockstep, mirroring the harness-policy feature's `policy-fields`.
 *
 * The loop knobs are NULLABLE overrides: `null` = fall back to the
 * harness env/code default. The editor renders them tri-state
 * (default / enabled / disabled); the kill-switches are plain booleans.
 */

import type { AgenticPolicy, UpdateAgenticPolicyRequest } from '../api';

export type KnobKind = 'tristate' | 'switch' | 'integer' | 'nullable-integer';

export interface KnobField {
    key: keyof AgenticPolicy & keyof UpdateAgenticPolicyRequest;
    label: string;
    kind: KnobKind;
    hint?: string;
}

export interface KnobGroup {
    title: string;
    description: string;
    fields: KnobField[];
}

export const KNOB_GROUPS: KnobGroup[] = [
    {
        title: 'Agentic loop toggles',
        description: 'Platform default for every tenant without an override. Default = inherit the harness env/code default.',
        fields: [
            { key: 'optimisticDeliveryEnabled', label: 'Optimistic delivery', kind: 'tristate', hint: 'Stream draft edits before verification settles.' },
            { key: 'atomicFactEnabled', label: 'Atomic-fact decomposition', kind: 'tristate' },
            { key: 'retrievalEnabled', label: 'Guideline retrieval', kind: 'tristate' },
            { key: 'warmStartEnabled', label: 'Warm start', kind: 'tristate' },
            { key: 'nerPriorsEnabled', label: 'NER priors', kind: 'tristate' },
            { key: 'regenFeedbackEnabled', label: 'Regeneration feedback', kind: 'tristate' },
            // Arming this alone opens nothing: a call also requires
            // the target McpServer row to be enabled, and its tools to be on the
            // allowlist. Default stays OFF.
            { key: 'mcpToolsEnabled', label: 'MCP external tools', kind: 'tristate', hint: 'Lets the loop call registered MCP servers. Also requires the server row to be enabled.' },
        ],
    },
    {
        title: 'Budgets',
        description: 'Loop re-run ceilings applied across the agentic pipeline.',
        fields: [
            { key: 'maxEditReruns', label: 'Max edit re-runs', kind: 'nullable-integer', hint: 'Empty = harness env/code default.' },
            { key: 'maxRegen', label: 'Max regen budget', kind: 'integer' },
        ],
    },
    {
        title: 'Kill-switches',
        description: 'Hard safety gates. Disabling any of these fans out to every tenant on save.',
        fields: [
            { key: 'safetyEnabled', label: 'Safety guardrail', kind: 'switch' },
            { key: 'phiEnabled', label: 'PHI detection', kind: 'switch' },
            { key: 'phiFailClosed', label: 'PHI fail-closed', kind: 'switch', hint: 'Block delivery when PHI detection errors.' },
        ],
    },
];

export const KNOB_FIELDS: KnobField[] = KNOB_GROUPS.flatMap((group) => group.fields);

/** Tri-state draft token for one nullable boolean knob. */
export type TristateDraft = 'default' | 'on' | 'off';

function tristateOf(value: boolean | null | undefined): TristateDraft {
    if (value === null || value === undefined) return 'default';
    return value ? 'on' : 'off';
}

/** Canonical draft representation of a knob value (inputs edit strings/booleans). */
export function knobDraftValue(field: KnobField, policy: AgenticPolicy): string | boolean {
    const value = policy[field.key];
    switch (field.kind) {
        case 'switch':
            return Boolean(value);
        case 'tristate':
            return tristateOf(value as boolean | null | undefined);
        case 'nullable-integer':
            return value === null || value === undefined ? '' : String(value);
        default:
            return value === null || value === undefined ? '' : String(value);
    }
}

/** Human-readable display of the current knob value ("enabled" / "default" / "2"). */
export function knobDisplayValue(field: KnobField, policy: AgenticPolicy): string {
    const value = policy[field.key];
    if (field.kind === 'switch') return value ? 'enabled' : 'disabled';
    if (field.kind === 'tristate') {
        if (value === null || value === undefined) return 'default (inherit)';
        return value ? 'enabled' : 'disabled';
    }
    if (value === null || value === undefined || value === '') return 'default (inherit)';
    return String(value);
}

/** Parse one edited draft back into its PATCH value; undefined = not sendable. */
function parseDraft(field: KnobField, draft: string | boolean): UpdateAgenticPolicyRequest[KnobField['key']] | undefined {
    switch (field.kind) {
        case 'switch':
            return Boolean(draft);
        case 'tristate': {
            const token = String(draft) as TristateDraft;
            if (token === 'default') return null;
            return token === 'on';
        }
        case 'integer': {
            const text = String(draft).trim();
            if (text === '') return undefined;
            const parsed = Number(text);
            return Number.isFinite(parsed) ? parsed : undefined;
        }
        case 'nullable-integer': {
            const text = String(draft).trim();
            if (text === '') return null;
            const parsed = Number(text);
            return Number.isFinite(parsed) ? parsed : undefined;
        }
    }
}

/**
 * Sparse patch: only knobs whose draft differs from the loaded policy are sent
 * (the gateway whitelist pipe accepts every declared knob; omitting a field
 * leaves it unchanged, and `null` clears an override to the env default).
 */
export function buildSparsePatch(policy: AgenticPolicy, drafts: Record<string, string | boolean>): UpdateAgenticPolicyRequest {
    const patch: Record<string, unknown> = {};
    for (const field of KNOB_FIELDS) {
        const draft = drafts[field.key];
        if (draft === undefined || draft === knobDraftValue(field, policy)) continue;
        const parsed = parseDraft(field, draft);
        if (parsed === undefined) continue;
        patch[field.key] = parsed;
    }
    return patch as UpdateAgenticPolicyRequest;
}
