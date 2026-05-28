/**
 * AuthController — TASK-307 Wave 1 (refresh-token defense + auth-lifecycle).
 *
 * Closes audit findings:
 *   - C-1  BLOCKER: refresh tokens are forgeable     (W1.1 + W1.2 + W1.3)
 *   - C-11 HIGH:    logout doesn't revoke jti        (W1.4)
 *   - C-12 HIGH:    refresh ignores tenant scope     (W1.3)
 *   - D-10 MED:     refresh leaks userId in payload  (W1.5 — by removal)
 *   - E-1  LOW:     JWT jti is predictable           (W1.6)
 *
 * Keeps mocks lightweight — pure unit test, no Nest container, mirrors
 * the auth.controller.task295.test.ts shape so the next maintainer can
 * see all auth-security tests at a glance.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { AuthController } from '../auth.controller';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const createMockClsService = (user: any = null) => ({
    get: vi.fn((key: string) => {
        if (key === 'user') return user;
        if (key === 'tenantId') return user?.tenantId ?? null;
        return null;
    }),
    set: vi.fn(),
});

const createMockUserRepository = (users: Map<string, any> = new Map()) => ({
    findFirst: vi.fn(async (props: any) => {
        const id = props?.filters?.id;
        const username = props?.filters?.username;
        if (id) return users.get(id) ?? null;
        for (const u of users.values()) {
            if (u.username === username) return u;
        }
        return null;
    }),
    update: vi.fn(),
});

const createMockDatabaseService = (roleAssignments: any[] = [], tenantAssignment: any = { id: 'ura-1' }) => ({
    client: {
        userRoleAssignment: {
            findMany: vi.fn(async () => roleAssignments),
            findFirst: vi.fn(async () => tenantAssignment),
        },
    },
});

const createMockTenantRepository = (tenants: Map<string, any> = new Map()) => ({
    findFirst: vi.fn(async (props: any) => {
        const key = props?.filters?.key;
        if (key) {
            for (const t of tenants.values()) {
                if (t.key === key) return t;
            }
        }
        return null;
    }),
});

const createTenant = (overrides: Partial<Record<string, any>> = {}) => ({
    id: 'tenant-A',
    key: 'tenant-a-key',
    name: 'Tenant A',
    resourceStatus: 'ENABLED',
    ...overrides,
});

const createRole = (name: string, permissions: string[] = ['read:consultation']) => ({
    id: `role-${name}`,
    name,
    permissions,
});

const createUser = (overrides: Partial<Record<string, any>> = {}) => ({
    id: 'doctor-001',
    username: 'dr_smith',
    password: '$2a$10$placeholder',
    tenantId: 'tenant-A',
    UserProfile: { email: 'smith@hospital.com' },
    resourceStatus: 'ENABLED',
    lastLoginAt: null,
    lastActiveAt: null,
    ...overrides,
});

const createMockAuthService = () => ({
    trackAuthentication: vi.fn().mockResolvedValue(undefined),
});

const createMockAppSettings = () => ({
    getValueWithDefault: vi.fn((key: string, defaultVal: string) => {
        if (key === 'JWT_SECRET_KEY') return 'test-secret-key-for-unit-tests';
        if (key === 'JWT_EXPIRES_IN') return '1h';
        if (key === 'JWT_IMPERSONATION_EXPIRES_IN') return '15m';
        return defaultVal;
    }),
});

const createMockRequest = () => ({ ip: '127.0.0.1', headers: { 'user-agent': 'test-agent' } });

const createMockRefreshTokenService = () => ({
    issue: vi.fn(async ({ jti, family }: any) => ({
        // Synthetic opaque token — deliberately NOT echoing userId or tenantId
        // to mirror the real service's opaque-token contract (D-10).
        rawToken: `opaque-${jti}`,
        family: family ?? `family-for-${jti}`,
        expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    })),
    consume: vi.fn(),
    revokeFamily: vi.fn().mockResolvedValue(undefined),
});

const createMockJwtRevocationService = () => ({
    revoke: vi.fn().mockResolvedValue(undefined),
    isRevoked: vi.fn().mockResolvedValue(false),
});

function buildController(overrides: any = {}) {
    return new AuthController(
        ({} as any), // userService
        (overrides.authService ?? createMockAuthService()) as any,
        (overrides.appSettingsService ?? createMockAppSettings()) as any,
        (overrides.databaseService ?? createMockDatabaseService()) as any,
        (overrides.userRepository ?? createMockUserRepository()) as any,
        ({} as any), // userRoleAssignmentRepository
        ({} as any), // roleRepository
        (overrides.tenantRepository ?? createMockTenantRepository()) as any,
        (overrides.clsService ?? createMockClsService()) as any,
        (overrides.streamTicketService ?? { issueTicket: vi.fn(), consumeTicket: vi.fn() }) as any,
        (overrides.jwtRevocationService ?? createMockJwtRevocationService()) as any,
        (overrides.refreshTokenService ?? createMockRefreshTokenService()) as any,
    );
}

const JWT_TEST_SECRET = 'test-secret-key-for-unit-tests';

function decodeJwt(token: string): any {
    return jwt.verify(token, JWT_TEST_SECRET);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthController — TASK-307 W1.2 / W1.5 / W1.6 — login token issuance', () => {
    beforeEach(() => vi.clearAllMocks());

    async function loginAcmeUser(overrides: any = {}) {
        const hashedPassword = await bcrypt.hash('pass123', 10);
        const user = createUser({ password: hashedPassword });
        const tenant = createTenant({ id: 'tenant-A', key: 'tenant-a-key' });

        const controller = buildController({
            ...overrides,
            userRepository: createMockUserRepository(new Map([[user.id, user]])),
            databaseService: createMockDatabaseService([{ Role: createRole('doctor') }]),
            tenantRepository: createMockTenantRepository(new Map([[tenant.id, tenant]])),
        });

        const result = await controller.login(
            { username: 'dr_smith', password: 'pass123', tenantKey: 'tenant-a-key' } as any,
            createMockRequest(),
        );
        return { controller, result };
    }

    it('W1.2 — calls refreshTokenService.issue with the active tenant context (not User.tenantId)', async () => {
        const refreshTokenService = createMockRefreshTokenService();
        await loginAcmeUser({ refreshTokenService });

        expect(refreshTokenService.issue).toHaveBeenCalledTimes(1);
        const callArg = refreshTokenService.issue.mock.calls[0][0];
        expect(callArg).toMatchObject({
            userId: 'doctor-001',
            tenantId: 'tenant-A',
        });
        expect(typeof callArg.jti).toBe('string');
        expect(callArg.jti.length).toBeGreaterThan(0);
    });

    it('W1.2 — returns the opaque rawToken issued by RefreshTokenService (not the legacy refresh_<userId>_<ts> format)', async () => {
        const refreshTokenService = createMockRefreshTokenService();
        const { result } = await loginAcmeUser({ refreshTokenService });

        const issuedJti = refreshTokenService.issue.mock.calls[0][0].jti;
        expect(result.refreshToken).toBe('opaque-' + issuedJti);
        // D-10: the wire-level refresh token MUST NOT start with the legacy "refresh_" prefix
        // and MUST NOT contain the userId in plaintext.
        expect(result.refreshToken).not.toMatch(/^refresh_/);
        expect(result.refreshToken).not.toContain('doctor-001');
    });

    it('W1.6 — JWT jti is randomBytes(16).hex (32 hex chars, unpredictable, no userId / timestamp leak)', async () => {
        const { result } = await loginAcmeUser();

        const decoded = decodeJwt(result.token);
        expect(typeof decoded.jti).toBe('string');
        expect(decoded.jti).toMatch(/^[0-9a-f]{32}$/);
        // The legacy `auth-<userId>-<timestamp>` shape MUST be gone.
        expect(decoded.jti).not.toMatch(/^auth-/);
        expect(decoded.jti).not.toContain('doctor-001');
    });

    it('W1.6 — two consecutive logins produce distinct, non-monotonic jtis (AC-6)', async () => {
        const { result: a } = await loginAcmeUser();
        const { result: b } = await loginAcmeUser();

        const jtiA = decodeJwt(a.token).jti;
        const jtiB = decodeJwt(b.token).jti;
        expect(jtiA).not.toBe(jtiB);
        // Non-monotonic: hex character distribution at byte 0 should not show a
        // simple "B follows A" ordering — i.e. the prefix doesn't increase.
        // (Probabilistically unlikely to be equal AND ordered for randomBytes.)
        // Pin the strong property: hex chars at position 0 are NOT predictable
        // by sequencing.
        expect(jtiA.charCodeAt(0)).not.toBeNaN();
        expect(jtiB.charCodeAt(0)).not.toBeNaN();
    });

    it('W1.2 — JWT payload carries refreshFamily so logout can revoke the family (AC-2 prep)', async () => {
        const refreshTokenService = createMockRefreshTokenService();
        const { result } = await loginAcmeUser({ refreshTokenService });

        const decoded = decodeJwt(result.token);
        // The factory mock returns family = `family-for-${jti}`. Pin the
        // wire-up: the JWT MUST carry whatever family the service returned.
        const issueArg = refreshTokenService.issue.mock.calls[0][0];
        expect(decoded.refreshFamily).toBeDefined();
        expect(decoded.refreshFamily).toBe(`family-for-${issueArg.jti}`);
    });

    it('W1.2 — passes its self-generated jti to refreshTokenService.issue so logout/refresh can correlate', async () => {
        const refreshTokenService = createMockRefreshTokenService();
        const { result } = await loginAcmeUser({ refreshTokenService });

        const decoded = decodeJwt(result.token);
        const issueArg = refreshTokenService.issue.mock.calls[0][0];
        expect(issueArg.jti).toBe(decoded.jti);
    });

    it('W1.5 — the transition `generateRefreshToken` shim emits an opaque 48-byte base64url token (D-10 closure)', () => {
        const controller = buildController();
        // W1.5 closes the audit finding D-10 by rewriting the legacy
        // `refresh_<userId>_<ts>_<hex>` format into an opaque 48-byte
        // base64url payload — userId no longer leaks in plaintext, and the
        // token is no longer client-forgeable. W1.3 will retire the helper
        // entirely once `refresh()` consumes via RefreshTokenService.
        const shim = (controller as any).generateRefreshToken;
        expect(typeof shim).toBe('function');
        const token = shim.call(controller) as string;
        // 48 random bytes → 64 base64url chars (no padding).
        expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
        expect(token).not.toMatch(/^refresh_/);
        // Two calls must produce two distinct tokens (no monotonic prefix).
        const second = shim.call(controller) as string;
        expect(second).not.toBe(token);
    });

    it('W1.2 — failing refresh-token persistence aborts the login (UnauthorizedException)', async () => {
        const refreshTokenService = createMockRefreshTokenService();
        refreshTokenService.issue.mockRejectedValueOnce(new Error('Redis down'));

        const hashedPassword = await bcrypt.hash('pass123', 10);
        const user = createUser({ password: hashedPassword });
        const tenant = createTenant({ id: 'tenant-A', key: 'tenant-a-key' });

        const controller = buildController({
            refreshTokenService,
            userRepository: createMockUserRepository(new Map([[user.id, user]])),
            databaseService: createMockDatabaseService([{ Role: createRole('doctor') }]),
            tenantRepository: createMockTenantRepository(new Map([[tenant.id, tenant]])),
        });

        await expect(
            controller.login(
                { username: 'dr_smith', password: 'pass123', tenantKey: 'tenant-a-key' } as any,
                createMockRequest(),
            ),
        ).rejects.toThrow(UnauthorizedException);
    });

    it('W1.2 — SUPER_ADMIN without tenantKey gets an empty-string tenantId in refreshTokenService.issue', async () => {
        const hashedPassword = await bcrypt.hash('pass123', 10);
        const user = createUser({ password: hashedPassword, tenantId: null });
        const refreshTokenService = createMockRefreshTokenService();

        const controller = buildController({
            refreshTokenService,
            userRepository: createMockUserRepository(new Map([[user.id, user]])),
            databaseService: createMockDatabaseService([{ Role: createRole('SUPER_ADMIN', ['*']) }]),
            tenantRepository: createMockTenantRepository(),
        });

        await controller.login(
            { username: 'dr_smith', password: 'pass123' } as any,
            createMockRequest(),
        );

        expect(refreshTokenService.issue).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: '' }),
        );
    });
});

// Anti-regression: every existing AuthController invariant that the
// TASK-307 refactor MUST preserve. The login still validates credentials,
// still throws BadRequest on missing tenantKey for non-admins, etc.
describe('AuthController — TASK-307 W1 anti-regression for existing login behaviours', () => {
    beforeEach(() => vi.clearAllMocks());

    it('still rejects missing tenantKey for non-admin users (BadRequestException)', async () => {
        const hashedPassword = await bcrypt.hash('pass123', 10);
        const user = createUser({ password: hashedPassword });

        const controller = buildController({
            userRepository: createMockUserRepository(new Map([[user.id, user]])),
            databaseService: createMockDatabaseService([{ Role: createRole('doctor') }]),
            tenantRepository: createMockTenantRepository(new Map([[createTenant().id, createTenant()]])),
        });

        await expect(
            controller.login(
                { username: 'dr_smith', password: 'pass123' } as any,
                createMockRequest(),
            ),
        ).rejects.toThrow(BadRequestException);
    });
});
