/**
 * PasswordResetToken domain unit tests (factory + entity lifecycle).
 *
 * The entity is the single source of truth for token-state semantics:
 *   - `isActive(now)`  — not used, not revoked, not expired
 *   - `markUsed(now)`  / `markRevoked(now)` — UPDATE-only lifecycle stamps
 */
import { describe, expect, it } from 'vitest';
import { PasswordResetTokenFactory } from '../PasswordResetTokenFactory';

const HASH = 'a'.repeat(64);
const NOW = new Date('2026-07-02T10:00:00Z');
const IN_1H = new Date('2026-07-02T11:00:00Z');

describe('PasswordResetTokenFactory', () => {
    it('creates an active token with defaults (purpose, no usedAt/revokedAt)', () => {
        const token = PasswordResetTokenFactory.CreatePasswordResetToken({
            userId: 'user-1',
            tokenHash: HASH,
            expiresAt: IN_1H,
        });

        expect(token.id).toBeTruthy();
        expect(token.userId).toBe('user-1');
        expect(token.tokenHash).toBe(HASH);
        expect(token.purpose).toBe('password_reset');
        expect(token.expiresAt).toEqual(IN_1H);
        expect(token.usedAt ?? null).toBeNull();
        expect(token.revokedAt ?? null).toBeNull();
        expect(token.isActive(NOW)).toBe(true);
    });

    it('carries audit provenance (requestedByUserId / requestedVia)', () => {
        const token = PasswordResetTokenFactory.CreatePasswordResetToken({
            userId: 'user-1',
            tokenHash: HASH,
            expiresAt: IN_1H,
            requestedByUserId: 'admin-9',
            requestedVia: 'admin',
        });

        expect(token.requestedByUserId).toBe('admin-9');
        expect(token.requestedVia).toBe('admin');
    });

    // The `email_verification` purpose stashes the pending
    // tenant name (captured at POST /auth/register) here until POST
    // /auth/register/verify consumes the token, since the token's own
    // columns carry only token-management metadata.
    it('carries an arbitrary metaData payload', () => {
        const token = PasswordResetTokenFactory.CreatePasswordResetToken({
            userId: 'user-1',
            tokenHash: HASH,
            expiresAt: IN_1H,
            purpose: 'email_verification',
            metaData: { pendingTenantName: 'Acme Health' },
        });

        expect(token.purpose).toBe('email_verification');
        expect(token.metaData).toEqual({ pendingTenantName: 'Acme Health' });
    });

    it('defaults metaData to null when omitted', () => {
        const token = PasswordResetTokenFactory.CreatePasswordResetToken({
            userId: 'user-1',
            tokenHash: HASH,
            expiresAt: IN_1H,
        });

        expect(token.metaData ?? null).toBeNull();
    });

    it('validate() rejects a missing tokenHash / userId / expiresAt', () => {
        const build = (over: Partial<{ tokenHash: string; userId: string; expiresAt: Date }>) =>
            PasswordResetTokenFactory.CreatePasswordResetToken({
                userId: over.userId ?? 'user-1',
                tokenHash: over.tokenHash ?? HASH,
                expiresAt: over.expiresAt ?? IN_1H,
            });

        expect(() => build({ tokenHash: '' }).validate()).toThrow();
        expect(() => build({ userId: '' }).validate()).toThrow();
        expect(() => build({}).validate()).not.toThrow();
    });

    describe('lifecycle semantics', () => {
        const make = () =>
            PasswordResetTokenFactory.CreatePasswordResetToken({ userId: 'user-1', tokenHash: HASH, expiresAt: IN_1H });

        it('is NOT active once expired', () => {
            const token = make();
            expect(token.isActive(new Date('2026-07-02T11:00:01Z'))).toBe(false);
        });

        it('markUsed stamps usedAt and deactivates (single-use)', () => {
            const token = make();
            token.markUsed(NOW);
            expect(token.usedAt).toEqual(NOW);
            expect(token.isActive(NOW)).toBe(false);
        });

        it('markRevoked stamps revokedAt and deactivates', () => {
            const token = make();
            token.markRevoked(NOW);
            expect(token.revokedAt).toEqual(NOW);
            expect(token.isActive(NOW)).toBe(false);
        });

        it('lifecycle stamps register as tracked changes (UPDATE-only persistence)', () => {
            const token = make();
            token.markUsed(NOW);
            expect(token.hasChanges).toBe(true);
            expect(Object.keys(token.changes)).toContain('usedAt');
        });
    });
});
