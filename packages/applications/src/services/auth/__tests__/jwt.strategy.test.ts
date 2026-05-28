import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UserSession } from '../dto';

const mockClsService = {
    set: vi.fn(),
    get: vi.fn(),
};

const mockSecretsService = {
    getSecretSync: vi.fn().mockReturnValue('test-jwt-secret'),
};

const mockJwtRevocationService = {
    isRevoked: vi.fn().mockResolvedValue(false),
    revoke: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@nestjs/passport', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@nestjs/passport')>();
    return {
        ...actual,
        PassportStrategy: (_Strategy: any, _name: string) => {
            return class MockPassportStrategy {
                constructor(_opts: any) {}
            };
        },
    };
});

vi.mock('passport-jwt', () => ({
    ExtractJwt: {
        fromAuthHeaderAsBearerToken: vi.fn().mockReturnValue(() => null),
    },
    Strategy: class {},
}));

import { JwtStrategy } from '../jwt.strategy';

function createStrategy(): JwtStrategy {
    return new JwtStrategy(
        mockSecretsService as any,
        mockClsService as any,
        mockJwtRevocationService as any,
    );
}

const fullPayload = {
    id: 'user-001',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    phone: '+1234567890',
    token: 'existing-token',
    tenantId: 'tenant-001',
    tenantCode: 'ACME',
    roles: ['admin', 'doctor'],
    permissions: ['read:patients', 'write:notes'],
};

describe('JwtStrategy', () => {
    let strategy: JwtStrategy;

    beforeEach(() => {
        vi.clearAllMocks();
        strategy = createStrategy();
    });

    describe('validate', () => {
        it('should create UserSession from payload with all fields', async () => {
            const result = await strategy.validate(fullPayload);

            expect(result).toBeInstanceOf(UserSession);
            expect(result.id).toBe('user-001');
            expect(result.firstName).toBe('Jane');
            expect(result.lastName).toBe('Doe');
            expect(result.email).toBe('jane@example.com');
            expect(result.phone).toBe('+1234567890');
            expect(result.token).toBe('existing-token');
            expect(result.tenantId).toBe('tenant-001');
            expect(result.tenantCode).toBe('ACME');
            expect(result.roles).toEqual(['admin', 'doctor']);
            expect(result.permissions).toEqual(['read:patients', 'write:notes']);
        });

        it('should default roles to empty array when not in payload', async () => {
            const { roles, ...payloadWithoutRoles } = fullPayload;

            const result = await strategy.validate(payloadWithoutRoles);

            expect(result.roles).toEqual([]);
        });

        it('should default permissions to empty array when not in payload', async () => {
            const { permissions, ...payloadWithoutPermissions } = fullPayload;

            const result = await strategy.validate(payloadWithoutPermissions);

            expect(result.permissions).toEqual([]);
        });

        it('should store user session in CLS context', async () => {
            const result = await strategy.validate(fullPayload);

            expect(mockClsService.set).toHaveBeenCalledWith('user', result);
        });

        it('should propagate tenantId from JWT payload into CLS context (SEC-J)', async () => {
            await strategy.validate(fullPayload);

            expect(mockClsService.set).toHaveBeenCalledWith('tenantId', 'tenant-001');
        });

        it('should propagate impersonatedBy from JWT payload into UserSession (H-2)', async () => {
            const impersonatedPayload = {
                ...fullPayload,
                impersonatedBy: 'admin-007',
            };

            const result = await strategy.validate(impersonatedPayload);

            expect(result.impersonatedBy).toBe('admin-007');
        });

        it('should leave impersonatedBy undefined when not in payload', async () => {
            const result = await strategy.validate(fullPayload);

            expect(result.impersonatedBy).toBeUndefined();
        });

        it('TASK-307 W1.4 — should propagate refreshFamily from JWT payload into UserSession (logout uses it to revoke the whole chain)', async () => {
            const payloadWithFamily = {
                ...fullPayload,
                refreshFamily: 'family-abc-123',
            };

            const result = await strategy.validate(payloadWithFamily);

            expect(result.refreshFamily).toBe('family-abc-123');
        });

        it('TASK-307 W1.4 — should leave refreshFamily undefined when payload omits it (legacy tokens issued before W1.2)', async () => {
            const result = await strategy.validate(fullPayload);

            expect(result.refreshFamily).toBeUndefined();
        });

        it('should throw UnauthorizedException when the jti has been revoked (C-4)', async () => {
            mockJwtRevocationService.isRevoked.mockResolvedValueOnce(true);
            const payloadWithJti = { ...fullPayload, jti: 'impersonate-admin-007-doctor-001-1234567890' };

            await expect(strategy.validate(payloadWithJti)).rejects.toThrowError(
                /revoked|Unauthorized/i,
            );
            expect(mockJwtRevocationService.isRevoked).toHaveBeenCalledWith(
                'impersonate-admin-007-doctor-001-1234567890',
            );
        });

        it('should accept the token when jti has NOT been revoked', async () => {
            mockJwtRevocationService.isRevoked.mockResolvedValueOnce(false);
            const payloadWithJti = { ...fullPayload, jti: 'auth-user-001-9999' };

            const result = await strategy.validate(payloadWithJti);

            expect(result.id).toBe('user-001');
        });

        it('should not consult the revocation service when payload has no jti', async () => {
            mockJwtRevocationService.isRevoked.mockClear();
            const { jti, ...payloadNoJti } = { ...fullPayload, jti: undefined } as Record<
                string,
                unknown
            >;
            void jti;

            await strategy.validate(payloadNoJti);

            expect(mockJwtRevocationService.isRevoked).not.toHaveBeenCalled();
        });

        it('should return the UserSession instance', async () => {
            const result = await strategy.validate(fullPayload);

            expect(result).toBeInstanceOf(UserSession);
            expect(result).toBeDefined();
        });

        it('should handle payload with missing optional fields', async () => {
            const minimalPayload = {
                id: 'user-002',
                email: 'minimal@example.com',
            };

            const result = await strategy.validate(minimalPayload);

            expect(result.id).toBe('user-002');
            expect(result.email).toBe('minimal@example.com');
            expect(result.firstName).toBeUndefined();
            expect(result.lastName).toBeUndefined();
            expect(result.phone).toBeUndefined();
            expect(result.token).toBeUndefined();
            expect(result.tenantId).toBeUndefined();
            expect(result.tenantCode).toBeUndefined();
            expect(result.roles).toEqual([]);
            expect(result.permissions).toEqual([]);
        });

        it('should pass the same instance to CLS and return value', async () => {
            const result = await strategy.validate(fullPayload);
            const clsArg = mockClsService.set.mock.calls[0][1];

            expect(result).toBe(clsArg);
        });
    });

    describe('TASK-307 W2.1 — JwtStrategy refuses placeholder secret', () => {
        const PLACEHOLDER = 'default-jwt-secret-key-change-in-production';

        it('throws when SecretsService resolves JWT_SECRET_KEY to the literal placeholder', () => {
            const placeholderSecrets = {
                getSecretSync: vi.fn().mockReturnValue(PLACEHOLDER),
            };

            expect(() =>
                new JwtStrategy(
                    placeholderSecrets as any,
                    mockClsService as any,
                    mockJwtRevocationService as any,
                ),
            ).toThrowError(/JWT_SECRET_KEY is the literal placeholder.*refusing to boot/);
        });

        it('throws when SecretsService returns undefined (warmup miss falls through to placeholder)', () => {
            const missingSecrets = {
                getSecretSync: vi.fn().mockReturnValue(undefined),
            };

            expect(() =>
                new JwtStrategy(
                    missingSecrets as any,
                    mockClsService as any,
                    mockJwtRevocationService as any,
                ),
            ).toThrowError(/JWT_SECRET_KEY is the literal placeholder.*refusing to boot/);
        });

        it('constructs successfully when SecretsService returns a real secret', () => {
            const realSecrets = {
                getSecretSync: vi.fn().mockReturnValue('a-real-32-byte-jwt-signing-secret-aaaa'),
            };

            expect(() =>
                new JwtStrategy(
                    realSecrets as any,
                    mockClsService as any,
                    mockJwtRevocationService as any,
                ),
            ).not.toThrow();
        });
    });
});
