import { describe, expect, it } from 'vitest';
import {
    draftToRule,
    draftsToRules,
    emptyRuleDraft,
    isBuilderRepresentable,
    parseRulesText,
    ruleToDraft,
    rulesToDrafts,
    serializeRules,
    type PolicyRuleDraft,
} from '../policy-rules';

describe('draftToRule', () => {
    it('builds a minimal rule from action + subject, omitting empty members', () => {
        const rule = draftToRule({ action: 'read', subject: 'Consultation', conditions: [], fields: '', inverted: false, reason: '' });
        expect(rule).toEqual({ action: 'read', subject: 'Consultation' });
    });

    it('includes non-empty conditions and trims keys', () => {
        const rule = draftToRule({
            action: 'manage',
            subject: 'Consultation',
            conditions: [
                { key: ' tenantId ', value: '${context.tenantId}' },
                { key: '', value: 'ignored' },
            ],
            fields: '',
            inverted: false,
            reason: '',
        });
        expect(rule.conditions).toEqual({ tenantId: '${context.tenantId}' });
    });

    it('splits fields on commas and drops blanks', () => {
        const rule = draftToRule({ action: 'read', subject: 'User', conditions: [], fields: 'id, , email ,name', inverted: false, reason: '' });
        expect(rule.fields).toEqual(['id', 'email', 'name']);
    });

    it('emits inverted + reason only when inverted is set', () => {
        const denied = draftToRule({ action: 'delete', subject: 'User', conditions: [], fields: '', inverted: true, reason: 'Users are archived, not deleted' });
        expect(denied).toMatchObject({ inverted: true, reason: 'Users are archived, not deleted' });
        const allowed = draftToRule({ action: 'delete', subject: 'User', conditions: [], fields: '', inverted: false, reason: 'ignored' });
        expect(allowed.inverted).toBeUndefined();
        expect(allowed.reason).toBeUndefined();
    });
});

describe('isBuilderRepresentable', () => {
    it('accepts flat rules with string action/subject, primitive conditions, string fields', () => {
        expect(
            isBuilderRepresentable([
                { action: 'read', subject: 'Consultation', conditions: { tenantId: '${context.tenantId}' }, fields: ['id'] },
                { action: 'delete', subject: 'User', inverted: true, reason: 'archived only' },
            ]),
        ).toBe(true);
    });

    it('rejects array actions, nested conditions, unknown keys, and non-arrays', () => {
        expect(isBuilderRepresentable([{ action: ['read', 'list'], subject: 'User' }])).toBe(false);
        expect(isBuilderRepresentable([{ action: 'read', subject: 'User', conditions: { age: { $gt: 18 } } }])).toBe(false);
        expect(isBuilderRepresentable([{ action: 'read', subject: 'User', extra: true }])).toBe(false);
        expect(isBuilderRepresentable([])).toBe(false);
        expect(isBuilderRepresentable('nope')).toBe(false);
    });
});

describe('round-trip (rule ↔ draft)', () => {
    it('round-trips a representable rule-set through drafts and back', () => {
        const rules = [
            { action: 'manage', subject: 'Consultation', conditions: { tenantId: '${context.tenantId}', doctorId: '${user.id}' } },
            { action: 'read', subject: 'User', fields: ['id', 'email'] },
            { action: 'delete', subject: 'User', inverted: true, reason: 'Users cannot be deleted, only archived' },
        ];
        expect(draftsToRules(rulesToDrafts(rules))).toEqual(rules);
    });

    it('stringifies non-string condition values when reading into a draft', () => {
        const draft = ruleToDraft({ action: 'read', subject: 'User', conditions: { isActive: true } });
        expect(draft.conditions).toEqual([{ key: 'isActive', value: 'true' }]);
    });
});

describe('serializeRules + parseRulesText', () => {
    it('serializes drafts to pretty JSON that parses back to the same rules', () => {
        const drafts: PolicyRuleDraft[] = [{ ...emptyRuleDraft(), action: 'list', subject: 'AuditLog' }];
        const text = serializeRules(drafts);
        const parsed = parseRulesText(text);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(parsed.rules).toEqual([{ action: 'list', subject: 'AuditLog' }]);
    });

    it('rejects empty, non-array, and invalid JSON', () => {
        expect(parseRulesText('')).toMatchObject({ ok: false });
        expect(parseRulesText('{}')).toMatchObject({ ok: false });
        expect(parseRulesText('[]')).toMatchObject({ ok: false });
        expect(parseRulesText('[{')).toMatchObject({ ok: false });
    });
});
