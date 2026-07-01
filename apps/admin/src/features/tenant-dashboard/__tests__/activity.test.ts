import { describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { actionCode, activityDotRole, actorOf, formatRelativeTime, humanizeAction, scopeToTenant, toActivityItems } from '../activity';
import type { AuditLogEntry } from '@arcaai/vox';

const e = (over: Partial<AuditLogEntry> = {}): AuditLogEntry => ({ id: 'a1', ...over }) as AuditLogEntry;

describe('activity (audit → view model)', () => {
    describe('humanizeAction', () => {
        it('sentence-cases the action token', () => {
            expect(humanizeAction(e({ action: 'TENANT_UPDATED' }))).toBe('Tenant updated');
            expect(humanizeAction(e({ action: 'user.created' }))).toBe('User created');
        });
        it('falls back to eventType then a generic label', () => {
            expect(humanizeAction(e({ eventType: 'DEPARTMENT_DELETED' }))).toBe('Department deleted');
            expect(humanizeAction(e())).toBe('Activity');
        });
    });

    describe('actorOf', () => {
        it('prefers display name, then email, then id, then System', () => {
            expect(actorOf(e({ responsibleUser: { id: 'u1', displayName: 'Dr Vega' } }))).toBe('Dr Vega');
            expect(actorOf(e({ responsibleUser: { id: 'u1', email: 'vega@x.io' } }))).toBe('vega@x.io');
            expect(actorOf(e({ responsibleUserId: 'u1' }))).toBe('u1');
            expect(actorOf(e())).toBe('System');
        });
    });

    describe('actionCode', () => {
        it('returns the raw machine token (uppercased), empty when absent', () => {
            expect(actionCode(e({ action: 'tenant_updated' }))).toBe('TENANT_UPDATED');
            expect(actionCode(e({ eventType: 'USER_CREATED' }))).toBe('USER_CREATED');
            expect(actionCode(e())).toBe('');
        });
    });

    describe('activityDotRole', () => {
        it('destructive when success === false', () => {
            expect(activityDotRole(e({ success: false }))).toBe('destructive');
        });
        it('warning for destructive-intent actions that did not explicitly fail', () => {
            expect(activityDotRole(e({ action: 'TENANT_DISABLED', success: true }))).toBe('warning');
            expect(activityDotRole(e({ action: 'USER_ARCHIVED' }))).toBe('warning');
            expect(activityDotRole(e({ action: 'API_KEY_REVOKED' }))).toBe('warning');
        });
        it('success when success === true and not destructive-intent', () => {
            expect(activityDotRole(e({ action: 'TENANT_UPDATED', success: true }))).toBe('success');
        });
        it('neutral otherwise', () => {
            expect(activityDotRole(e({ action: 'TENANT_VIEWED' }))).toBe('neutral');
        });
    });

    describe('scopeToTenant', () => {
        it('drops cross-tenant rows but keeps rows with no tenantId', () => {
            const rows = [e({ id: '1', tenantId: 't1' }), e({ id: '2', tenantId: 't2' }), e({ id: '3', tenantId: null })];
            expect(scopeToTenant(rows, 't1').map((r) => r.id)).toEqual(['1', '3']);
        });
    });

    describe('formatRelativeTime', () => {
        const now = new Date('2026-06-30T12:00:00.000Z');
        it('returns an em-dash for missing/invalid input', () => {
            expect(formatRelativeTime(undefined, now)).toBe('—');
            expect(formatRelativeTime('not-a-date', now)).toBe('—');
        });
        it('shows "just now" under a minute', () => {
            expect(formatRelativeTime('2026-06-30T11:59:40.000Z', now)).toBe('just now');
        });
        it('shows compact minutes/hours/days', () => {
            expect(formatRelativeTime('2026-06-30T11:55:00.000Z', now)).toBe('5m ago');
            expect(formatRelativeTime('2026-06-30T09:00:00.000Z', now)).toBe('3h ago');
            expect(formatRelativeTime('2026-06-28T12:00:00.000Z', now)).toBe('2d ago');
        });
        it('falls back to an absolute date beyond a week', () => {
            const old = '2026-05-01T12:00:00.000Z';
            expect(formatRelativeTime(old, now)).toBe(format(new Date(old), 'MMM d, yyyy'));
        });
    });

    describe('toActivityItems', () => {
        it('maps entries to the activity view model', () => {
            const items = toActivityItems([
                e({ id: 'x', action: 'TENANT_UPDATED', success: true, responsibleUser: { id: 'u', displayName: 'Ada' }, createdAt: '2026-06-30T00:00:00Z' }),
            ]);
            expect(items[0]).toEqual({
                id: 'x',
                title: 'Tenant updated',
                actor: 'Ada',
                code: 'TENANT_UPDATED',
                dotRole: 'success',
                timestamp: '2026-06-30T00:00:00Z',
            });
        });
    });
});
