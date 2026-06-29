/**
 * CASL policy-rule model + pure helpers for the visual rule-builder (TASK-374).
 *
 * A policy holds an array of CASL ability rules
 * (`{ action, subject, conditions?, fields?, inverted?, reason? }`). The builder
 * edits these as structured "drafts"; the validated-JSON textarea is the
 * "advanced" fallback. These helpers convert between the two representations and
 * decide whether a given rule-set is expressible in the builder (else the editor
 * opens in advanced/JSON mode so nothing is lost). Vocabulary is grounded in
 * `knowledge/04_ACCESS_CONTROL.md`.
 */

/** Actions the policy engine understands (`manage` matches any action). */
export const POLICY_ACTIONS = ['manage', 'create', 'read', 'list', 'update', 'delete', 'archive', 'export'] as const;

/** RBAC subjects (Prisma model names + the `all` wildcard). */
export const POLICY_SUBJECTS = ['all', 'User', 'Consultation', 'ContextItem', 'Media', 'Tenant', 'Role', 'Policy', 'AuditLog'] as const;

/** Suggested CASL condition variables resolved at runtime (knowledge/04). */
export const POLICY_CONDITION_VARIABLES = ['${user.id}', '${user.tenantId}', '${context.tenantId}'] as const;

export interface ConditionDraft {
    key: string;
    value: string;
}

/** The builder's editable view of a single CASL rule. */
export interface PolicyRuleDraft {
    action: string;
    subject: string;
    conditions: ConditionDraft[];
    /** Comma-separated field-restriction list (empty = all fields). */
    fields: string;
    inverted: boolean;
    reason: string;
}

/** A built CASL rule object (what is validated by the server + persisted). */
export interface CaslRule {
    action: string;
    subject: string;
    conditions?: Record<string, unknown>;
    fields?: string[];
    inverted?: boolean;
    reason?: string;
}

const KNOWN_RULE_KEYS = new Set(['action', 'subject', 'conditions', 'fields', 'inverted', 'reason']);

export function emptyRuleDraft(): PolicyRuleDraft {
    return { action: 'read', subject: 'Consultation', conditions: [], fields: '', inverted: false, reason: '' };
}

/** Build a CASL rule from a draft, omitting empty optional members. */
export function draftToRule(draft: PolicyRuleDraft): CaslRule {
    const rule: CaslRule = { action: draft.action, subject: draft.subject };

    const conditions: Record<string, string> = {};
    for (const c of draft.conditions) {
        const key = c.key.trim();
        if (key) conditions[key] = c.value;
    }
    if (Object.keys(conditions).length > 0) rule.conditions = conditions;

    const fields = draft.fields
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean);
    if (fields.length > 0) rule.fields = fields;

    if (draft.inverted) {
        rule.inverted = true;
        const reason = draft.reason.trim();
        if (reason) rule.reason = reason;
    }

    return rule;
}

export function draftsToRules(drafts: PolicyRuleDraft[]): CaslRule[] {
    return drafts.map(draftToRule);
}

/** Serialize builder drafts to the pretty JSON the advanced textarea shows. */
export function serializeRules(drafts: PolicyRuleDraft[]): string {
    return JSON.stringify(draftsToRules(drafts), null, 2);
}

function isPrimitive(v: unknown): boolean {
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** Whether a single rule can be round-tripped through the builder without loss. */
function isRuleBuilderRepresentable(rule: unknown): boolean {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
    const r = rule as Record<string, unknown>;
    if (typeof r.action !== 'string') return false; // array actions → advanced
    if (typeof r.subject !== 'string') return false; // array subjects → advanced
    if (r.conditions !== undefined) {
        if (typeof r.conditions !== 'object' || r.conditions === null || Array.isArray(r.conditions)) return false;
        if (!Object.values(r.conditions as Record<string, unknown>).every(isPrimitive)) return false; // nested operators → advanced
    }
    if (r.fields !== undefined && !(Array.isArray(r.fields) && r.fields.every((f) => typeof f === 'string'))) return false;
    if (r.inverted !== undefined && typeof r.inverted !== 'boolean') return false;
    if (r.reason !== undefined && typeof r.reason !== 'string') return false;
    return Object.keys(r).every((k) => KNOWN_RULE_KEYS.has(k));
}

/** Whether an entire rule-set is editable in the builder (else use advanced JSON). */
export function isBuilderRepresentable(rules: unknown): rules is CaslRule[] {
    return Array.isArray(rules) && rules.length > 0 && rules.every(isRuleBuilderRepresentable);
}

/** Parse an existing (builder-representable) rule into a draft. */
export function ruleToDraft(rule: CaslRule): PolicyRuleDraft {
    const conditions: ConditionDraft[] = rule.conditions
        ? Object.entries(rule.conditions).map(([key, value]) => ({ key, value: typeof value === 'string' ? value : String(value) }))
        : [];
    return {
        action: rule.action,
        subject: rule.subject,
        conditions,
        fields: Array.isArray(rule.fields) ? rule.fields.join(', ') : '',
        inverted: rule.inverted === true,
        reason: typeof rule.reason === 'string' ? rule.reason : '',
    };
}

export function rulesToDrafts(rules: CaslRule[]): PolicyRuleDraft[] {
    return rules.map(ruleToDraft);
}

/** Parse the advanced-mode JSON textarea into a rules array (or an error). */
export function parseRulesText(text: string): { ok: true; rules: unknown[] } | { ok: false; error: string } {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: 'Rules are required.' };
    try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) return { ok: false, error: 'Rules must be a JSON array of CASL rules.' };
        if (parsed.length === 0) return { ok: false, error: 'At least one rule is required.' };
        return { ok: true, rules: parsed };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON.' };
    }
}
