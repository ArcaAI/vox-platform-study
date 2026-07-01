/**
 * UserPasswordService Unit Tests (TASK-388 #8 — reset-password).
 *
 * Covers the two admin flows (set temporary password, create reset link) plus
 * the public single-use completion. The reset token is a stateless signed JWT
 * carrying a `pv` (password-version) claim = a hash of the user's CURRENT
 * password hash, so completing a reset (which changes the hash) invalidates the
 * token — single-use without a DB table.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as jwt from 'jsonwebtoken';
import { UserPasswordService } from '../userPassword.service';

const JWT_SECRET = 'test-reset-secret';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockUserRepository = {
    findById: vi.fn(),
    update: vi.fn(),
};

const mockCryptoService = {
    hash: vi.fn(async (pw: string) => `hashed:${pw}`),
    verify: vi.fn(),
};

const mockSecretsService = {
    getSecretSync: vi.fn(() => JWT_SECRET),
    getSecretOptional: vi.fn(async () => JWT_SECRET),
};

const mockMailer = {
    sendResetLink: vi.fn(async () => true),
};

const makeUser = (over: Partial<{ id: string; password: string; email: string }> = {}) => {
    let _password = over.password ?? 'hashed:original';
    return {
        id: over.id ?? 'user-1',
        get password() {
            return _password;
        },
        set password(v: string) {
            _password = v;
        },
        UserProfile: { email: over.email ?? 'user@example.com' },
    };
};

const buildService = (withMailer = true) =>
    new UserPasswordService(
        mockUserRepository as never,
        mockCryptoService as never,
        mockSecretsService as never,
        mockEventEmitter as never,
        mockClsService as never,
        withMailer ? (mockMailer as never) : undefined,
    );

describe('UserPasswordService (TASK-388 #8)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCryptoService.hash.mockImplementation(async (pw: string) => `hashed:${pw}`);
        mockSecretsService.getSecretSync.mockReturnValue(JWT_SECRET);
        mockMailer.sendResetLink.mockResolvedValue(true);
    });

    describe('setTemporaryPassword', () => {
        it('generates a temp password, hashes it, persists, and returns the plaintext', async () => {
            const user = makeUser();
            mockUserRepository.findById.mockResolvedValue(user);
            mockUserRepository.update.mockResolvedValue(user);
            const service = buildService();

            const result = await service.setTemporaryPassword('user-1');

            expect(result.temporaryPassword).toBeTruthy();
            expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(8);
            // The stored hash is derived from the returned plaintext (login-compatible).
            expect(mockCryptoService.hash).toHaveBeenCalledWith(result.temporaryPassword);
            expect(user.password).toBe(`hashed:${result.temporaryPassword}`);
            expect(mockUserRepository.update).toHaveBeenCalledWith('user-1', user);
        });

        it('uses an admin-supplied temporary password when provided', async () => {
            const user = makeUser();
            mockUserRepository.findById.mockResolvedValue(user);
            mockUserRepository.update.mockResolvedValue(user);
            const service = buildService();

            const result = await service.setTemporaryPassword('user-1', { temporaryPassword: 'ChosenPass1' });

            expect(result.temporaryPassword).toBe('ChosenPass1');
            expect(mockCryptoService.hash).toHaveBeenCalledWith('ChosenPass1');
        });

        it('rejects an admin-supplied password shorter than 8 chars', async () => {
            mockUserRepository.findById.mockResolvedValue(makeUser());
            const service = buildService();

            await expect(service.setTemporaryPassword('user-1', { temporaryPassword: 'short' })).rejects.toThrow();
        });
    });

    describe('createResetLink', () => {
        it('mints a verifiable single-use JWT and returns a reset path', async () => {
            mockUserRepository.findById.mockResolvedValue(makeUser());
            const service = buildService();

            const result = await service.createResetLink('user-1');

            const decoded = jwt.verify(result.token, JWT_SECRET) as Record<string, unknown>;
            expect(decoded.sub).toBe('user-1');
            expect(decoded.purpose).toBe('password_reset');
            expect(typeof decoded.pv).toBe('string');
            expect(result.resetPath).toContain(result.token);
            expect(result.expiresInSeconds).toBeGreaterThan(0);
        });

        it('attempts email delivery and reflects the mailer result', async () => {
            mockUserRepository.findById.mockResolvedValue(makeUser({ email: 'target@example.com' }));
            const service = buildService();

            const result = await service.createResetLink('user-1');

            expect(mockMailer.sendResetLink).toHaveBeenCalledWith(
                expect.objectContaining({ email: 'target@example.com' }),
            );
            expect(result.emailSent).toBe(true);
        });

        it('degrades gracefully (emailSent=false, no throw) when the mailer throws', async () => {
            mockUserRepository.findById.mockResolvedValue(makeUser());
            mockMailer.sendResetLink.mockRejectedValue(new Error('graph down'));
            const service = buildService();

            const result = await service.createResetLink('user-1');

            expect(result.emailSent).toBe(false);
            expect(result.token).toBeTruthy();
        });

        it('degrades gracefully when no mailer is configured', async () => {
            mockUserRepository.findById.mockResolvedValue(makeUser());
            const service = buildService(false);

            const result = await service.createResetLink('user-1');

            expect(result.emailSent).toBe(false);
            expect(result.token).toBeTruthy();
        });
    });

    describe('completeReset', () => {
        it('verifies the token and sets the new (hashed) password', async () => {
            const user = makeUser();
            mockUserRepository.findById.mockResolvedValue(user);
            mockUserRepository.update.mockResolvedValue(user);
            const service = buildService();

            const { token } = await service.createResetLink('user-1');
            const result = await service.completeReset({ token, newPassword: 'BrandNewPass1' });

            expect(result.userId).toBe('user-1');
            expect(mockCryptoService.hash).toHaveBeenCalledWith('BrandNewPass1');
            expect(user.password).toBe('hashed:BrandNewPass1');
            expect(mockUserRepository.update).toHaveBeenCalledWith('user-1', user);
        });

        it('rejects a new password shorter than 8 chars', async () => {
            const user = makeUser();
            mockUserRepository.findById.mockResolvedValue(user);
            const service = buildService();

            const { token } = await service.createResetLink('user-1');
            await expect(service.completeReset({ token, newPassword: 'short' })).rejects.toThrow();
        });

        it('is single-use: a token minted against the old hash fails after the password changed', async () => {
            const service = buildService();
            // Mint the token against the original hash.
            mockUserRepository.findById.mockResolvedValue(makeUser({ password: 'hashed:original' }));
            const { token } = await service.createResetLink('user-1');

            // Password has since changed → pv no longer matches.
            mockUserRepository.findById.mockResolvedValue(makeUser({ password: 'hashed:changed' }));
            await expect(service.completeReset({ token, newPassword: 'BrandNewPass1' })).rejects.toThrow();
        });

        it('rejects an invalid/tampered token', async () => {
            mockUserRepository.findById.mockResolvedValue(makeUser());
            const service = buildService();

            await expect(service.completeReset({ token: 'not-a-jwt', newPassword: 'BrandNewPass1' })).rejects.toThrow();
        });

        it('rejects a token signed with a different secret', async () => {
            mockUserRepository.findById.mockResolvedValue(makeUser());
            const service = buildService();
            const foreign = jwt.sign({ sub: 'user-1', purpose: 'password_reset', pv: 'x' }, 'other-secret', { expiresIn: '1h' });

            await expect(service.completeReset({ token: foreign, newPassword: 'BrandNewPass1' })).rejects.toThrow();
        });
    });
});
