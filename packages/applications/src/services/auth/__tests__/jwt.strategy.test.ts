import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UserSession } from '../dto';

const mockClsService = {
    set: vi.fn(),
    get: vi.fn(),
};

const mockAppSettingsService = {
    getValueWithDefault: vi.fn().mockReturnValue('test-jwt-secret'),
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
        mockAppSettingsService as any,
        mockClsService as any,
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

            expect(mockClsService.set).toHaveBeenCalledTimes(1);
            expect(mockClsService.set).toHaveBeenCalledWith('user', result);
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
});
