import type { StatusColorRole } from '@arcaai/ui/components/shared';
import type { PromptTemplateCategory, PromptVariable, UpdatePromptInput } from '@arcaai/vox';
import type { PromptTemplateStatus } from './sdk-types';

/**
 * Editor-side draft logic for an "agent instruction" (a department-scoped
 * `PromptTemplate`). The create flow is owned by the existing
 * `features/tenants/agent-instruction-dialog`; this module backs the full
 * **editor** (frame 31): variable parsing from `{{double_braces}}`, the
 * draft → `UpdatePromptInput` mapping (new version on save), and the
 * presentation helpers used across the agent surface.
 */

/** The scope of every department default agent — fixed/locked in the editor UI. */
export const DEPARTMENT_SCOPE = 'DEPARTMENT_DEFAULT' as const;

export interface InstructionEditDraft {
    content: string;
    status: PromptTemplateStatus;
    /** Required by the UI for "Save as new version"; empty → omitted. */
    changeReason: string;
}

/** Extract unique `{{variable}}` names in first-seen order, trimming and ignoring empties. */
export function parseVariableNames(content: string): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    const re = /\{\{\s*([^{}]*?)\s*\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
        const name = match[1].trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
    }
    return names;
}

/** Map variable names to the SDK `PromptVariable[]` (required string vars bound at runtime). */
export function toPromptVariables(names: string[]): PromptVariable[] {
    return names.map((name) => ({ name, type: 'string', required: true }));
}

/** Editor draft → `UpdatePromptInput`. Trims content, derives variables, carries OCC token. */
export function toUpdatePromptInput(draft: InstructionEditDraft, expectedVersion?: number): UpdatePromptInput {
    const content = draft.content.trim();
    const changeReason = draft.changeReason.trim();
    return {
        content,
        status: draft.status,
        changeReason: changeReason.length > 0 ? changeReason : undefined,
        variables: toPromptVariables(parseVariableNames(content)),
        expectedVersion,
    };
}

/** Status → semantic token role (Published success · Draft warning · else neutral). */
export function promptStatusRole(status?: PromptTemplateStatus | string | null): StatusColorRole {
    switch (String(status ?? '').toUpperCase()) {
        case 'PUBLISHED':
            return 'success';
        case 'DRAFT':
            return 'warning';
        default:
            return 'neutral';
    }
}

/** Title-case status label, defaulting to "Draft". */
export function promptStatusLabel(status?: PromptTemplateStatus | string | null): string {
    const value = String(status ?? 'DRAFT').toUpperCase();
    return value.charAt(0) + value.slice(1).toLowerCase();
}

const CATEGORY_LABELS: Record<PromptTemplateCategory, string> = {
    SYSTEM: 'System',
    SUMMARY: 'Summary',
    DNA_ANALYSIS: 'DNA analysis',
    CUSTOM: 'Custom',
};

/** Humanize the `PromptTemplateCategory` enum for display. */
export function categoryLabel(category: PromptTemplateCategory | string): string {
    return CATEGORY_LABELS[category as PromptTemplateCategory] ?? String(category);
}
