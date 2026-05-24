import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';

const mockSecretsService = {
    getSecretSync: vi.fn().mockReturnValue('test-gateway-jwt-secret'),
};

const mockAuthService = {
    isTokenRevoked: vi.fn(),
    validateUser: vi.fn(),
    trackAuthentication: vi.fn(),
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

import { GatewayJwtStrategy } from '../gateway-auth.strategy';

function createStrategy(): GatewayJwtStrategy {
    return new GatewayJwtStrategy(
        mockSecretsService as any,
        mockAuthService as any,
    );
}

function createMockRequest(overrides?: Partial<Record<string, any>>): any {
    return {
        ip: '192.168.1.1',
        headers: { 'user-agent': 'test-browser/1.0' },
        path: '/api/patients',
        method: 'GET',
        ...overrides,
    };
}

const validPayload = {
    sub: 'user-001',
    jti: 'token-abc-123',
    roles: ['physician'],
    permissions: ['medical:read', 'patient:read'],
    organizationId: 'org-001',
};

const activeUser = {
    id: 'user-001',
    email: 'doctor@hospital.com',
    isActive: true,
    departmentId: 'dept-cardiology',
    lastLoginAt: new Date('2026-01-15T10:00:00Z'),
};

describe('GatewayJwtStrategy', () => {
    let strategy: GatewayJwtStrategy;

    beforeEach(() => {
        vi.clearAllMocks();
        mockAuthService.isTokenRevoked.mockResolvedValue(false);
        mockAuthService.validateUser.mockResolvedValue(activeUser);
        mockAuthService.trackAuthentication.mockResolvedValue(undefined);
        strategy = createStrategy();
    });

    describe('validate', () => {
        it('should return enhanced user with gateway metadata for valid token', async () => {
            const request = createMockRequest();

            const result = await strategy.validate(request, validPayload);

            expect(result).toEqual(
                expect.objectContaining({
                    id: 'user-001',
                    email: 'doctor@hospital.com',
                    roles: ['physician'],
                    permissions: ['medical:read', 'patient:read'],
                    organizationId: 'org-001',
                    departmentId: 'dept-cardiology',
                    isActive: true,
                    tokenId: 'token-abc-123',
                    gateway: expect.objectContaining({
                        accessLevel: expect.any(String),
                        rateLimit: expect.objectContaining({
                            requests: expect.any(Number),
                            windowMs: expect.any(Number),
                        }),
                        allowedEndpoints: expect.any(Array),
                    }),
                }),
            );
        });

        it('should throw UnauthorizedException when token is revoked', async () => {
            mockAuthService.isTokenRevoked.mockResolvedValue(true);
            const request = createMockRequest();

            await expect(strategy.validate(request, validPayload)).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('should throw UnauthorizedException when user is inactive', async () => {
            mockAuthService.validateUser.mockResolvedValue({
                ...activeUser,
                isActive: false,
            });
            const request = createMockRequest();

            await expect(strategy.validate(request, validPayload)).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('should throw UnauthorizedException when user not found (null)', async () => {
            mockAuthService.validateUser.mockResolvedValue(null);
            const request = createMockRequest();

            await expect(strategy.validate(request, validPayload)).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('should call trackAuthentication on success', async () => {
            const request = createMockRequest({
                ip: '10.0.0.1',
                headers: { 'user-agent': 'chrome/120' },
                path: '/api/sessions',
                method: 'POST',
            });

            await strategy.validate(request, validPayload);

            expect(mockAuthService.trackAuthentication).toHaveBeenCalledWith('user-001', {
                ip: '10.0.0.1',
                userAgent: 'chrome/120',
                endpoint: '/api/sessions',
                method: 'POST',
            });
        });

        it('should throw UnauthorizedException on any error during validation', async () => {
            mockAuthService.isTokenRevoked.mockRejectedValue(new Error('Redis connection failed'));
            const request = createMockRequest();

            await expect(strategy.validate(request, validPayload)).rejects.toThrow(
                UnauthorizedException,
            );
            await expect(strategy.validate(request, validPayload)).rejects.toThrow(
                'Authentication failed',
            );
        });
    });

    describe('determineAccessLevel', () => {
        it('should determine "admin" access level for admin role', async () => {
            const request = createMockRequest();
            const payload = { ...validPayload, roles: ['admin'] };

            const result = await strategy.validate(request, payload);

            expect(result.gateway.accessLevel).toBe('admin');
        });

        it('should determine "admin" access level for system-admin role', async () => {
            const request = createMockRequest();
            const payload = { ...validPayload, roles: ['system-admin'] };

            const result = await strategy.validate(request, payload);

            expect(result.gateway.accessLevel).toBe('admin');
        });

        it('should determine "elevated" access level for physician', async () => {
            const request = createMockRequest();
            const payload = { ...validPayload, roles: ['physician'] };

            const result = await strategy.validate(request, payload);

            expect(result.gateway.accessLevel).toBe('elevated');
        });

        it('should determine "basic" access level for regular user', async () => {
            const request = createMockRequest();
            const payload = { ...validPayload, roles: ['user'] };

            const result = await strategy.validate(request, payload);

            expect(result.gateway.accessLevel).toBe('basic');
        });
    });

    describe('determineRateLimit', () => {
        it('should set rate limit 1000/min for admin', async () => {
            const request = createMockRequest();
            const payload = { ...validPayload, roles: ['admin'] };

            const result = await strategy.validate(request, payload);

            expect(result.gateway.rateLimit).toEqual({
                requests: 1000,
                windowMs: 60000,
            });
        });

        it('should set rate limit 500/min for physician', async () => {
            const request = createMockRequest();
            const payload = { ...validPayload, roles: ['physician'] };

            const result = await strategy.validate(request, payload);

            expect(result.gateway.rateLimit).toEqual({
                requests: 500,
                windowMs: 60000,
            });
        });

        it('should set rate limit 100/min for basic user', async () => {
            const request = createMockRequest();
            const payload = { ...validPayload, roles: ['user'] };

            const result = await strategy.validate(request, payload);

            expect(result.gateway.rateLimit).toEqual({
                requests: 100,
                windowMs: 60000,
            });
        });
    });

    describe('getAllowedEndpoints', () => {
        it('should include physician endpoints for physician role', async () => {
            const request = createMockRequest();
            const payload = { ...validPayload, roles: ['physician'] };

            const result = await strategy.validate(request, payload);

            expect(result.gateway.allowedEndpoints).toContain('/api/patients/*');
            expect(result.gateway.allowedEndpoints).toContain('/api/sessions/*');
            expect(result.gateway.allowedEndpoints).toContain('/api/medical/*');
            expect(result.gateway.allowedEndpoints).toContain('/api/v1/health');
            expect(result.gateway.allowedEndpoints).toContain('/api/v1/auth/refresh');
        });

        it('should include admin wildcard for admin role', async () => {
            const request = createMockRequest();
            const payload = { ...validPayload, roles: ['admin'] };

            const result = await strategy.validate(request, payload);

            expect(result.gateway.allowedEndpoints).toContain('/api/*');
        });
    });
});
