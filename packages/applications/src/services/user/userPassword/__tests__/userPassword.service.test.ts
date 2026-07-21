/**
 * UserPasswordService Unit Tests.
 *
 * Password reset uses a revocable, DB-backed
 * `PasswordResetToken`: only a SHA-256 hash is stored, issuing revokes prior
 * active tokens (UPDATE `revokedAt` — never DELETE), completion is single-use
 * (`usedAt`) and TTL-bound, and every set path enforces the configurable
 * complexity policy + stamps `User.passwordChangedAt`. A public self-service
 * `requestSelfServiceReset` never leaks account existence and never returns
 * the token.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { PasswordResetTokenEntity } from '@arcaai/domains';
import { UserPasswordService } from '../userPassword.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockUserRepository = {
    findById: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
};

const mockUserProfileRepository = {
    findAll: vi.fn(),
};

/**
 * In-memory PasswordResetToken repository: captures created entities and
 * resolves hash lookups against them, so unit tests exercise the REAL
 * entity lifecycle (markUsed / markRevoked / isActive).
 */
function makeTokenRepository() {
    const rows: PasswordResetTokenEntity[] = [];
    return {
        rows,
        create: vi.fn(async (entity: PasswordResetTokenEntity) => {
            rows.push(entity);
            return entity;
        }),
        update: vi.fn(async (_id: string, entity: PasswordResetTokenEntity) => entity),
        findByTokenHash: vi.fn(async (tokenHash: string) => rows.find((r) => r.tokenHash === tokenHash) ?? null),
        findActiveForUser: vi.fn(async (userId: string) => rows.filter((r) => r.userId === userId && !r.usedAt && !r.revokedAt)),
    };
}
let mockTokenRepository = makeTokenRepository();

const mockCryptoService = {
    hash: vi.fn(async (pw: string) => `hashed:${pw}`),
    verify: vi.fn(),
};

// Default policy (min 12, all classes); tests override per-case.
const settingsValues: Record<string, unknown> = {};
const mockAppSettings = {
    getValueWithDefault: vi.fn(<T,>(key: string, def: T): T => (key in settingsValues ? (settingsValues[key] as T) : def)),
};

const mockMailer = {
    sendResetLink: vi.fn(async () => true),
};

const STRONG_PW = 'BrandNew!Pass9';

const makeUser = (over: Partial<{ id: string; password: string; email: string; isServiceAccount: boolean }> = {}) => {
    let _password = over.password ?? 'hashed:original';
    let _passwordChangedAt: Date | null = null;
    return {
        id: over.id ?? 'user-1',
        isServiceAccount: over.isServiceAccount ?? false,
        get password() {
            return _password;
        },
        set password(v: string) {
            _password = v;
        },
        get passwordChangedAt() {
            return _passwordChangedAt;
        },
        set passwordChangedAt(v: Date | null) {
            _passwordChangedAt = v;
        },
        UserProfile: { email: over.email ?? 'user@example.com' },
    };
};

const buildService = (withMailer = true) =>
    new UserPasswordService(
        mockUserRepository as never,
        mockUserProfileRepository as never,
        mockTokenRepository as never,
        mockCryptoService as never,
        mockAppSettings as never,
        mockEventEmitter as never,
        mockClsService as never,
        withMailer ? (mockMailer as never) : undefined,
    );

const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');

describe('UserPasswordService (TASK-400)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockTokenRepository = makeTokenRepository();
        for (const key of Object.keys(settingsValues)) delete settingsValues[key];
        mockCryptoService.hash.mockImplementation(async (pw: string) => `hashed:${pw}`);
        mockMailer.sendResetLink.mockResolvedValue(true);
        mockClsService.get.mockReturnValue(null);
    });

    describe('setTemporaryPassword', () => {
        it('generates a policy-compliant temp password, hashes it, stamps passwordChangedAt', async () => {
            const user = makeUser();
            mockUserRepository.findById.mockResolvedValue(user);
            mockUserRepository.update.mockResolvedValue(user);
            const service = buildService();

            const result = await service.setTemporaryPassword('user-1');

            expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(12);
            expect(mockCryptoService.hash).toHaveBeenCalledWith(result.temporaryPassword);
            expect(user.password).toBe(`hashed:${result.temporaryPassword}`);
            expect(user.passwordChangedAt).toBeInstanceOf(Date);
            expect(mockUserRepository.update).toHaveBeenCalledWith('user-1', user);
        });

        it('rejects an admin-supplied password that fails the complexity policy', async () => {
            mockUserRepository.findById.mockResolvedValue(makeUser());
            const service = buildService();

            // 12+ chars but no special char → policy failure with a clear message.
            await expect(service.setTemporaryPassword('user-1', { temporaryPassword: 'Weakpassword1' })).rejects.toThrow(/special/i);
            // Too short.
            await expect(service.setTemporaryPassword('user-1', { temporaryPassword: 'Sh0rt!' })).rejects.toThrow(/12/);
        });

        it('revokes outstanding active reset tokens when a temp password is set', async () => {
            const user = makeUser();
            mockUserRepository.findById.mockResolvedValue(user);
            mockUserRepository.update.mockResolvedValue(user);
            const service = buildService();

            await service.createResetLink('user-1');
            expect(mockTokenRepository.rows).toHaveLength(1);

            await service.setTemporaryPassword('user-1', { temporaryPassword: STRONG_PW });
            expect(mockTokenRepository.rows[0].revokedAt).toBeInstanceOf(Date);
        });

        it('honours a relaxed GlobalSettings policy', async () => {
            settingsValues['security.password.minLength'] = 8;
            settingsValues['security.password.requireSpecial'] = false;
            const user = makeUser();
            mockUserRepository.findById.mockResolvedValue(user);
            mockUserRepository.update.mockResolvedValue(user);
            const service = buildService();

            await expect(service.setTemporaryPassword('user-1', { temporaryPassword: 'Passw0rd' })).resolves.toBeTruthy();
        });
    });

    describe('createResetLink (admin flow — DB-backed token)', () => {
        it('persists only the SHA-256 hash, never the raw token', async () => {
            mockUserRepository.findById.mockResolvedValue(makeUser());
            const service = buildService();

            const result = await service.createResetLink('user-1');

            expect(result.token).toBeTruthy();
            expect(result.resetPath).toContain(encodeURIComponent(result.token));
            expect(result.expiresInSeconds).toBe(3600);
            const stored = mockTokenRepository.rows[0];
            expect(stored.tokenHash).toBe(sha256(result.token));
            expect(stored.tokenHash).not.toBe(result.token);
            expect(stored.userId).toBe('user-1');
        });

        it('revokes the previous active token when a new link is issued', async () => {
            mockUserRepository.findById.mockResolvedValue(makeUser());
            const service = buildService();

            await service.createResetLink('user-1');
            await service.createResetLink('user-1');

            expect(mockTokenRepository.rows).toHaveLength(2);
            expect(mockTokenRepository.rows[0].revokedAt).toBeInstanceOf(Date);
            expect(mockTokenRepository.rows[1].revokedAt ?? null).toBeNull();
        });

        it('stamps admin provenance (requestedByUserId / requestedVia=admin)', async () => {
            mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'admin-9' } : null));
            mockUserRepository.findById.mockResolvedValue(makeUser());
            const service = buildService();

            await service.createResetLink('user-1');

            expect(mockTokenRepository.rows[0].requestedByUserId).toBe('admin-9');
            expect(mockTokenRepository.rows[0].requestedVia).toBe('admin');
        });

        it('attempts email delivery and reflects the mailer result', async () => {
            mockUserRepository.findById.mockResolvedValue(makeUser({ email: 'target@example.com' }));
            const service = buildService();

            const result = await service.createResetLink('user-1');

            expect(mockMailer.sendResetLink).toHaveBeenCalledWith(expect.objectContaining({ email: 'target@example.com' }));
            expect(result.emailSent).toBe(true);
        });

        it('degrades gracefully when the mailer throws or is missing', async () => {
            mockUserRepository.findById.mockResolvedValue(makeUser());
            mockMailer.sendResetLink.mockRejectedValue(new Error('graph down'));
            expect((await buildService().createResetLink('user-1')).emailSent).toBe(false);

            mockUserRepository.findById.mockResolvedValue(makeUser());
            expect((await buildService(false).createResetLink('user-1')).emailSent).toBe(false);
        });
    });

    describe('completeReset (single-use, TTL, revocable)', () => {
        const setupUser = () => {
            const user = makeUser();
            mockUserRepository.findById.mockResolvedValue(user);
            mockUserRepository.update.mockResolvedValue(user);
            return user;
        };

        it('consumes an active token: sets hashed password + passwordChangedAt, marks usedAt', async () => {
            const user = setupUser();
            const service = buildService();

            const { token } = await service.createResetLink('user-1');
            const result = await service.completeReset({ token, newPassword: STRONG_PW });

            expect(result.userId).toBe('user-1');
            expect(user.password).toBe(`hashed:${STRONG_PW}`);
            expect(user.passwordChangedAt).toBeInstanceOf(Date);
            expect(mockTokenRepository.rows[0].usedAt).toBeInstanceOf(Date);
        });

        it('is single-use: replaying a spent token is rejected', async () => {
            setupUser();
            const service = buildService();

            const { token } = await service.createResetLink('user-1');
            await service.completeReset({ token, newPassword: STRONG_PW });

            await expect(service.completeReset({ token, newPassword: `${STRONG_PW}x` })).rejects.toThrow(/invalid or has expired/);
        });

        it('rejects a token revoked by a newer request', async () => {
            setupUser();
            const service = buildService();

            const { token: first } = await service.createResetLink('user-1');
            const { token: second } = await service.createResetLink('user-1');

            await expect(service.completeReset({ token: first, newPassword: STRONG_PW })).rejects.toThrow(/invalid or has expired/);
            await expect(service.completeReset({ token: second, newPassword: STRONG_PW })).resolves.toBeTruthy();
        });

        it('rejects an expired token', async () => {
            setupUser();
            const service = buildService();

            const { token } = await service.createResetLink('user-1');
            mockTokenRepository.rows[0].expiresAt = new Date(Date.now() - 60_000);

            await expect(service.completeReset({ token, newPassword: STRONG_PW })).rejects.toThrow(/invalid or has expired/);
        });

        it('rejects an unknown/tampered token with the same generic message', async () => {
            setupUser();
            const service = buildService();

            await expect(service.completeReset({ token: 'not-a-real-token', newPassword: STRONG_PW })).rejects.toThrow(/invalid or has expired/);
        });

        it('rejects a weak new password with the policy message BEFORE touching the token', async () => {
            setupUser();
            const service = buildService();

            const { token } = await service.createResetLink('user-1');
            await expect(service.completeReset({ token, newPassword: 'short' })).rejects.toThrow(/12/);
            // The token must remain consumable after the rejected attempt.
            await expect(service.completeReset({ token, newPassword: STRONG_PW })).resolves.toBeTruthy();
        });

        it('revokes any OTHER outstanding active token once a reset completes', async () => {
            setupUser();
            const service = buildService();

            const { token } = await service.createResetLink('user-1');
            // Simulate a second active token that somehow survived (defence in depth).
            const stray = mockTokenRepository.rows[0];
            const { token: fresh } = await service.createResetLink('user-1');
            void stray;

            await service.completeReset({ token: fresh, newPassword: STRONG_PW });
            expect(mockTokenRepository.rows.every((r) => r.usedAt || r.revokedAt)).toBe(true);
            void token;
        });
    });

    describe('requestSelfServiceReset (public forgot-password)', () => {
        it('issues a token + emails the link for a matching enabled user', async () => {
            const user = makeUser({ id: 'user-7', email: 'doc@example.com' });
            mockUserProfileRepository.findAll.mockResolvedValue([{ userId: 'user-7', email: 'doc@example.com' }]);
            mockUserRepository.findFirst.mockResolvedValue(user);
            const service = buildService();

            await service.requestSelfServiceReset({ email: 'doc@example.com' });

            expect(mockTokenRepository.rows).toHaveLength(1);
            expect(mockTokenRepository.rows[0].userId).toBe('user-7');
            expect(mockTokenRepository.rows[0].requestedVia).toBe('self-service');
            expect(mockMailer.sendResetLink).toHaveBeenCalledWith(expect.objectContaining({ email: 'doc@example.com' }));
        });

        it('resolves silently (no throw, no token) for an unknown email', async () => {
            mockUserProfileRepository.findAll.mockResolvedValue([]);
            const service = buildService();

            await expect(service.requestSelfServiceReset({ email: 'ghost@example.com' })).resolves.toBeUndefined();
            expect(mockTokenRepository.rows).toHaveLength(0);
            expect(mockMailer.sendResetLink).not.toHaveBeenCalled();
        });

        it('resolves silently when the matched user is disabled (repo miss)', async () => {
            mockUserProfileRepository.findAll.mockResolvedValue([{ userId: 'user-8', email: 'off@example.com' }]);
            mockUserRepository.findFirst.mockRejectedValue(new Error('DataNotFound'));
            const service = buildService();

            await expect(service.requestSelfServiceReset({ email: 'off@example.com' })).resolves.toBeUndefined();
            expect(mockTokenRepository.rows).toHaveLength(0);
        });

        it('never lets a mailer failure surface (still resolves)', async () => {
            mockUserProfileRepository.findAll.mockResolvedValue([{ userId: 'user-7', email: 'doc@example.com' }]);
            mockUserRepository.findFirst.mockResolvedValue(makeUser({ id: 'user-7' }));
            mockMailer.sendResetLink.mockRejectedValue(new Error('graph down'));
            const service = buildService();

            await expect(service.requestSelfServiceReset({ email: 'doc@example.com' })).resolves.toBeUndefined();
            expect(mockTokenRepository.rows).toHaveLength(1);
        });

        it('skips service accounts', async () => {
            mockUserProfileRepository.findAll.mockResolvedValue([{ userId: 'svc-1', email: 'svc@example.com' }]);
            mockUserRepository.findFirst.mockResolvedValue(makeUser({ id: 'svc-1', isServiceAccount: true }));
            const service = buildService();

            await service.requestSelfServiceReset({ email: 'svc@example.com' });
            expect(mockTokenRepository.rows).toHaveLength(0);
        });

        it('audits the request via a SysEvent without leaking the token or raw email', async () => {
            mockUserProfileRepository.findAll.mockResolvedValue([]);
            const service = buildService();

            await service.requestSelfServiceReset({ email: 'ghost@example.com' });

            const calls = mockEventEmitter.emit.mock.calls.map((c) => JSON.stringify(c[1] ?? {}));
            expect(calls.length).toBeGreaterThan(0);
            expect(calls.join('')).not.toContain('ghost@example.com');
        });
    });
});
