/**
 * OidcStrategy Unit Tests
 *
 * Tests for the OidcStrategy that handles OpenID Connect authentication flow.
 *
 * Testing Strategy:
 * - PassportStrategy is mocked to isolate the validate() method under test
 * - Dependencies are mocked only at boundaries: client, authService, clsService, appSettingsService
 * - Tests verify real behavior: JWT creation, CLS storage, name splitting, error propagation
 * - Mock structures match real openid-client userinfo response shape
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UserSession } from '../dto';

// --- Boundary mocks ---

const mockClient = {
    userinfo: vi.fn(),
};

const mockAppSettingsService = {
    getValueWithDefault: vi.fn(),
};

const mockAuthService = {
    getOrCreateOidcUser: vi.fn(),
};

const mockClsService = {
    set: vi.fn(),
    get: vi.fn(),
};

const mockSecretsService = {
    getSecretSync: vi.fn(),
};

// --- Mock PassportStrategy (same pattern as jwt.strategy.test.ts) ---

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

vi.mock('openid-client', () => ({
    Strategy: class {},
    Client: class {},
}));

// Mock createJwt to return a deterministic token so we test the strategy's
// orchestration logic, not the JWT library itself
vi.mock('../createJwt', () => ({
    createJwt: vi.fn((payload: any) => `jwt-token-for-${payload.id}`),
}));

import { OidcStrategy } from '../oidc.strategy';
import { createJwt } from '../createJwt';

/**
 * Helper: creates an OidcStrategy instance with all boundary mocks injected.
 * appSettingsService defaults are set here to match typical configuration.
 */
function createStrategy(): OidcStrategy {
    mockAppSettingsService.getValueWithDefault.mockImplementation(
        (key: string, defaultValue: string) => {
            // TASK-302 Phase 3 Task 3.7 — JWT_SECRET_KEY now resolved via
            // SecretsService below; intentionally omitted from this map.
            const settings: Record<string, string> = {
                OIDC_SCOPES: 'openid profile email',
                OIDC_CALLBACK_URL: 'http://localhost:8001/auth/callback',
                JWT_EXPIRES_IN: '1h',
            };
            return settings[key] ?? defaultValue;
        },
    );
    mockSecretsService.getSecretSync.mockImplementation((key: string) =>
        key === 'JWT_SECRET_KEY' ? 'test-jwt-secret' : undefined,
    );

    return new OidcStrategy(
        mockClient as any,
        mockAppSettingsService as any,
        mockAuthService as any,
        mockClsService as any,
        mockSecretsService as any,
    );
}

/**
 * Creates a complete mock userinfo response matching the openid-client UserinfoResponse shape.
 * Uses 'in' operator so explicit undefined/null overrides are preserved (not defaulted).
 */
function createMockUserinfo(overrides: Partial<{ sub: string; name: string | undefined; email: string }> = {}) {
    return {
        sub: 'sub' in overrides ? overrides.sub : 'oidc-sub-123',
        name: 'name' in overrides ? overrides.name : 'John Doe',
        email: 'email' in overrides ? overrides.email : 'john@example.com',
    };
}

/**
 * Creates a complete OAuthUserResponse matching the real class shape.
 */
function createMockOAuthResponse(overrides: Partial<{
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
    phone: string | null;
    roles: string[];
    groups: string[];
    token: string | null;
}> = {}) {
    return {
        id: overrides.id ?? 'user-id-1',
        firstName: overrides.firstName ?? 'John',
        lastName: overrides.lastName ?? 'Doe',
        email: overrides.email ?? 'john@example.com',
        phone: overrides.phone ?? null,
        roles: overrides.roles ?? ['user'],
        groups: overrides.groups ?? [],
        token: overrides.token ?? null,
    };
}

describe('OidcStrategy', () => {
    let strategy: OidcStrategy;

    beforeEach(() => {
        vi.clearAllMocks();
        strategy = createStrategy();
    });

    describe('validate', () => {
        const mockTokenset = { access_token: 'mock-access-token' };

        it('should retrieve user info from token set', async () => {
            const userinfo = createMockUserinfo();
            mockClient.userinfo.mockResolvedValue(userinfo);
            mockAuthService.getOrCreateOidcUser.mockResolvedValue(createMockOAuthResponse());

            await strategy.validate(mockTokenset);

            expect(mockClient.userinfo).toHaveBeenCalledWith(mockTokenset);
        });

        it('should split full name into firstName and lastName', async () => {
            const userinfo = createMockUserinfo({ name: 'Alice Smith' });
            mockClient.userinfo.mockResolvedValue(userinfo);
            mockAuthService.getOrCreateOidcUser.mockResolvedValue(createMockOAuthResponse());

            await strategy.validate(mockTokenset);

            expect(mockAuthService.getOrCreateOidcUser).toHaveBeenCalledWith(
                expect.objectContaining({
                    firstName: 'Alice',
                    lastName: 'Smith',
                }),
            );
        });

        it('should handle missing name by using empty strings for firstName and lastName', async () => {
            const userinfo = createMockUserinfo({ name: undefined as any });
            mockClient.userinfo.mockResolvedValue(userinfo);
            mockAuthService.getOrCreateOidcUser.mockResolvedValue(createMockOAuthResponse());

            await strategy.validate(mockTokenset);

            expect(mockAuthService.getOrCreateOidcUser).toHaveBeenCalledWith(
                expect.objectContaining({
                    firstName: '',
                    lastName: '',
                }),
            );
        });

        it('should call getOrCreateOidcUser with correct params from userinfo', async () => {
            const userinfo = createMockUserinfo({
                sub: 'ext-456',
                name: 'Jane Roe',
                email: 'jane@hospital.com',
            });
            mockClient.userinfo.mockResolvedValue(userinfo);
            mockAuthService.getOrCreateOidcUser.mockResolvedValue(createMockOAuthResponse());

            await strategy.validate(mockTokenset);

            expect(mockAuthService.getOrCreateOidcUser).toHaveBeenCalledWith({
                firstName: 'Jane',
                lastName: 'Roe',
                email: 'jane@hospital.com',
                externalId: 'ext-456',
            });
        });

        it('should throw UnauthorizedException when getOrCreateOidcUser returns null', async () => {
            mockClient.userinfo.mockResolvedValue(createMockUserinfo());
            mockAuthService.getOrCreateOidcUser.mockResolvedValue(null);

            await expect(strategy.validate(mockTokenset)).rejects.toThrow(
                'User could not be found/created',
            );
        });

        it('should create JWT token for authenticated user using AppSettingsService config', async () => {
            const oauthResponse = createMockOAuthResponse({
                id: 'user-789',
                firstName: 'Bob',
                lastName: 'Builder',
                email: 'bob@example.com',
                phone: '+1555000111',
            });
            mockClient.userinfo.mockResolvedValue(createMockUserinfo());
            mockAuthService.getOrCreateOidcUser.mockResolvedValue(oauthResponse);

            await strategy.validate(mockTokenset);

            expect(createJwt).toHaveBeenCalledWith({
                id: 'user-789',
                firstName: 'Bob',
                lastName: 'Builder',
                email: 'bob@example.com',
                phone: '+1555000111',
                jwtSecretKey: 'test-jwt-secret',
                expiresIn: '1h',
            });
        });

        it('should store user session in CLS context', async () => {
            const oauthResponse = createMockOAuthResponse({
                id: 'user-cls-1',
                firstName: 'CLS',
                lastName: 'User',
                email: 'cls@test.com',
                phone: null,
            });
            mockClient.userinfo.mockResolvedValue(createMockUserinfo());
            mockAuthService.getOrCreateOidcUser.mockResolvedValue(oauthResponse);

            await strategy.validate(mockTokenset);

            expect(mockClsService.set).toHaveBeenCalledWith('user', expect.any(UserSession));
            const storedSession = mockClsService.set.mock.calls[0][1] as UserSession;
            expect(storedSession.id).toBe('user-cls-1');
            expect(storedSession.email).toBe('cls@test.com');
            expect(storedSession.token).toBe('jwt-token-for-user-cls-1');
        });

        it('should return OAuthUserResponse with token set', async () => {
            const oauthResponse = createMockOAuthResponse({ id: 'user-ret-1' });
            mockClient.userinfo.mockResolvedValue(createMockUserinfo());
            mockAuthService.getOrCreateOidcUser.mockResolvedValue(oauthResponse);

            const result = await strategy.validate(mockTokenset);

            expect(result).toBeDefined();
            expect(result!.id).toBe('user-ret-1');
            expect(result!.token).toBe('jwt-token-for-user-ret-1');
        });

        it('uses SecretsService for JWT secret and AppSettings for JWT_EXPIRES_IN', async () => {
            mockClient.userinfo.mockResolvedValue(createMockUserinfo());
            mockAuthService.getOrCreateOidcUser.mockResolvedValue(
                createMockOAuthResponse({ id: 'cfg-user' }),
            );

            // TASK-302 Phase 3 Task 3.7 — JWT secret is now sourced from
            // SecretsService; JWT_EXPIRES_IN stays on AppSettings.
            mockSecretsService.getSecretSync.mockImplementation((key: string) =>
                key === 'JWT_SECRET_KEY' ? 'custom-production-secret' : undefined,
            );
            mockAppSettingsService.getValueWithDefault.mockImplementation(
                (key: string, defaultValue: string) => {
                    const customSettings: Record<string, string> = {
                        JWT_EXPIRES_IN: '24h',
                    };
                    return customSettings[key] ?? defaultValue;
                },
            );

            await strategy.validate(mockTokenset);

            expect(createJwt).toHaveBeenCalledWith(
                expect.objectContaining({
                    jwtSecretKey: 'custom-production-secret',
                    expiresIn: '24h',
                }),
            );
        });
    });
});
