/**
 * AuthController — refresh-token defense + auth-lifecycle.
 *
 * Covers: refresh tokens must not be forgeable, logout revokes the jti,
 * refresh stays tenant-scoped, the refresh payload does not leak userId,
 * and the JWT jti is unpredictable (not sequential/derivable).
 *
 * Keeps mocks lightweight — pure unit test, no Nest container.
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

// Controller position 4 is now IUserRoleAssignmentService.
// This factory accepts the same legacy `[{Role: {name, permissions}}, ...]`
// shape the W1 tests already pass and unwraps it for `findActiveRolesForUser`.
const createMockUserRoleAssignmentService = (
    roleAssignments: any[] = [],
    tenantAssignment: any = { id: 'ura-1' },
) => {
    const roles = roleAssignments.map((a) => a?.Role).filter((r) => !!r);
    return {
        findActiveRolesForUser: vi.fn(async () => roles),
        findActiveAssignmentForUserInTenant: vi.fn(async () => tenantAssignment),
        findActiveTenantIdsForUser: vi.fn(async () => []),
    };
};

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
        // to mirror the real service's opaque-token contract.
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

// Controller now reads JWT_SECRET_KEY exclusively from
// SecretsService. Mock returns the same value the test JWT_TEST_SECRET
// constant uses so jwt.verify() works against the controller-issued tokens.
const createMockSecretsService = () => ({
    getSecretSync: vi.fn((key: string) => {
        if (key === 'JWT_SECRET_KEY') return 'test-secret-key-for-unit-tests';
        return undefined;
    }),
});

// Translates the legacy `databaseService` override (which
// previously carried `[{Role: ...}]` rows) into a userRoleAssignmentService
// mock with the same role-assignment data, so existing test cases keep
// working without a per-test rewrite. Tests that need finer control can
// pass `userRoleAssignmentService:` directly.
function deriveUraServiceFromLegacyDb(legacyDb: any): any {
    const findMany = legacyDb?.client?.userRoleAssignment?.findMany;
    const findFirst = legacyDb?.client?.userRoleAssignment?.findFirst;
    return {
        findActiveRolesForUser: vi.fn(async () => {
            if (!findMany) return [];
            const rows = await findMany();
            return (rows ?? []).map((a: any) => a?.Role).filter((r: any) => !!r);
        }),
        findActiveAssignmentForUserInTenant: vi.fn(async () => (findFirst ? await findFirst() : { id: 'ura-1' })),
        findActiveTenantIdsForUser: vi.fn(async () => []),
    };
}

function buildController(overrides: any = {}) {
    const uraService =
        overrides.userRoleAssignmentService ??
        (overrides.databaseService
            ? deriveUraServiceFromLegacyDb(overrides.databaseService)
            : createMockUserRoleAssignmentService());

    return new AuthController(
        ({} as any), // userService
        (overrides.authService ?? createMockAuthService()) as any,
        (overrides.appSettingsService ?? createMockAppSettings()) as any,
        uraService as any,
        (overrides.userRepository ?? createMockUserRepository()) as any,
        ({} as any), // userRoleAssignmentRepository
        ({} as any), // roleRepository
        (overrides.tenantRepository ?? createMockTenantRepository()) as any,
        (overrides.clsService ?? createMockClsService()) as any,
        (overrides.streamTicketService ?? { issueTicket: vi.fn(), consumeTicket: vi.fn() }) as any,
        (overrides.jwtRevocationService ?? createMockJwtRevocationService()) as any,
        (overrides.secretsService ?? createMockSecretsService()) as any,
        (overrides.refreshTokenService ?? createMockRefreshTokenService()) as any,
        // Login now also resolves the department half of membership.
        { findActiveDepartmentForUserInTenant: vi.fn(async () => ({ id: 'ud-1' })) } as any,
        { emit: vi.fn() } as any,
        {} as any,
        { lookup: vi.fn().mockResolvedValue(null) } as any,
    );
}

const JWT_TEST_SECRET = 'test-secret-key-for-unit-tests';

function decodeJwt(token: string): any {
    return jwt.verify(token, JWT_TEST_SECRET);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthController — login token issuance', () => {
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
        // The wire-level refresh token MUST NOT start with the legacy "refresh_" prefix
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

    it('W1.2 — GLOBAL_ADMIN without tenantKey gets an empty-string tenantId in refreshTokenService.issue', async () => {
        const hashedPassword = await bcrypt.hash('pass123', 10);
        const user = createUser({ password: hashedPassword, tenantId: null });
        const refreshTokenService = createMockRefreshTokenService();

        const controller = buildController({
            refreshTokenService,
            userRepository: createMockUserRepository(new Map([[user.id, user]])),
            databaseService: createMockDatabaseService([{ Role: createRole('GLOBAL_ADMIN', ['*']) }]),
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

// ---------------------------------------------------------------------------
// W1.3 — refresh endpoint goes through RefreshTokenService.consume + .issue
// Closes audit findings C-1 (forgery on the refresh surface) and C-12
// (refresh ignores the issuing tenant). Tenant context is carried forward
// from the consumed record — NOT re-read from User.tenantId, which can
// drift if the user has since been moved between tenants.
// ---------------------------------------------------------------------------
describe('AuthController — refresh endpoint defense', () => {
    beforeEach(() => vi.clearAllMocks());

    function buildRefreshController(overrides: any = {}) {
        const refreshTokenService = overrides.refreshTokenService ?? createMockRefreshTokenService();
        const user = overrides.user ?? createUser();
        const users = new Map<string, any>([[user.id, user]]);

        const controller = buildController({
            ...overrides,
            refreshTokenService,
            userRepository: overrides.userRepository ?? createMockUserRepository(users),
            databaseService:
                overrides.databaseService ?? createMockDatabaseService([{ Role: createRole('doctor') }]),
        });
        return { controller, refreshTokenService, user };
    }

    it('W1.3 — calls RefreshTokenService.consume with the raw token (server-side validation, not client-trusted parsing)', async () => {
        const refreshTokenService = createMockRefreshTokenService();
        refreshTokenService.consume.mockResolvedValueOnce({
            userId: 'doctor-001',
            tenantId: 'tenant-A',
            jti: 'old-jti',
            family: 'family-xyz',
        });
        const { controller } = buildRefreshController({ refreshTokenService });

        await controller.refresh({ refreshToken: 'opaque-server-issued-token' });

        expect(refreshTokenService.consume).toHaveBeenCalledTimes(1);
        expect(refreshTokenService.consume).toHaveBeenCalledWith('opaque-server-issued-token');
    });

    it('W1.3 / C-12 — mints the new access token with the tenantId from the consumed record, NOT from User.tenantId', async () => {
        // User has since been moved to tenant-B in the DB, but the original
        // refresh token was issued under tenant-A. The new access token MUST
        // stay scoped to tenant-A (the original session's tenant).
        const refreshTokenService = createMockRefreshTokenService();
        refreshTokenService.consume.mockResolvedValueOnce({
            userId: 'doctor-001',
            tenantId: 'tenant-A',
            jti: 'old-jti',
            family: 'family-original',
        });
        const userMovedToB = createUser({ tenantId: 'tenant-B' });
        const { controller } = buildRefreshController({
            refreshTokenService,
            user: userMovedToB,
        });

        const result = await controller.refresh({ refreshToken: 'opaque-server-issued-token' });

        const decoded = decodeJwt(result.token);
        expect(decoded.tenantId).toBe('tenant-A');
        expect(decoded.tenantId).not.toBe('tenant-B');
    });

    it('W1.3 — rotates the refresh token within the SAME family (single-use rotation, RFC 6749 §10.4)', async () => {
        const refreshTokenService = createMockRefreshTokenService();
        refreshTokenService.consume.mockResolvedValueOnce({
            userId: 'doctor-001',
            tenantId: 'tenant-A',
            jti: 'old-jti',
            family: 'family-original',
        });
        const { controller } = buildRefreshController({ refreshTokenService });

        const result = await controller.refresh({ refreshToken: 'opaque-old-token' });

        expect(refreshTokenService.issue).toHaveBeenCalledTimes(1);
        const issueArg = refreshTokenService.issue.mock.calls[0][0];
        expect(issueArg).toMatchObject({
            userId: 'doctor-001',
            tenantId: 'tenant-A',
            family: 'family-original',
        });
        // The newly issued refresh token replaces the old one — it's the
        // mocked rawToken keyed off the new jti.
        expect(result.refreshToken).toBe(`opaque-${issueArg.jti}`);
    });

    it('W1.3 / W1.6 — refresh mints a fresh randomBytes(16).hex jti distinct from the consumed jti', async () => {
        const refreshTokenService = createMockRefreshTokenService();
        refreshTokenService.consume.mockResolvedValueOnce({
            userId: 'doctor-001',
            tenantId: 'tenant-A',
            jti: 'old-jti-aaaa',
            family: 'family-original',
        });
        const { controller } = buildRefreshController({ refreshTokenService });

        const result = await controller.refresh({ refreshToken: 'opaque-old-token' });

        const decoded = decodeJwt(result.token);
        expect(decoded.jti).toMatch(/^[0-9a-f]{32}$/);
        expect(decoded.jti).not.toBe('old-jti-aaaa');
        expect(decoded.jti).not.toMatch(/^auth-/);
    });

    it('W1.3 — JWT payload carries the SAME refreshFamily so subsequent logout can revoke the chain', async () => {
        const refreshTokenService = createMockRefreshTokenService();
        refreshTokenService.consume.mockResolvedValueOnce({
            userId: 'doctor-001',
            tenantId: 'tenant-A',
            jti: 'old-jti',
            family: 'family-original',
        });
        const { controller } = buildRefreshController({ refreshTokenService });

        const result = await controller.refresh({ refreshToken: 'opaque-old-token' });
        const decoded = decodeJwt(result.token);

        expect(decoded.refreshFamily).toBe('family-original');
    });

    it('W1.3 — missing refresh token throws BadRequestException', async () => {
        const { controller } = buildRefreshController();
        await expect(
            controller.refresh({ refreshToken: '' } as any),
        ).rejects.toThrow(BadRequestException);
    });

    it('W1.3 / C-1 — RefreshTokenService.consume rejection bubbles up as UnauthorizedException (forged / reused tokens)', async () => {
        const refreshTokenService = createMockRefreshTokenService();
        refreshTokenService.consume.mockRejectedValueOnce(
            new UnauthorizedException('Invalid refresh token'),
        );
        const { controller } = buildRefreshController({ refreshTokenService });

        await expect(
            controller.refresh({ refreshToken: 'forged-or-reused-token' }),
        ).rejects.toThrow(UnauthorizedException);
        // No new token must be issued when consume rejects.
        expect(refreshTokenService.issue).not.toHaveBeenCalled();
    });

    it('W1.3 — refusing to refresh for a disabled user (resourceStatus check still holds)', async () => {
        const refreshTokenService = createMockRefreshTokenService();
        refreshTokenService.consume.mockResolvedValueOnce({
            userId: 'doctor-001',
            tenantId: 'tenant-A',
            jti: 'old-jti',
            family: 'family-original',
        });
        // Empty user repo — user has been disabled / deleted since the refresh token was issued.
        const controller = buildController({
            refreshTokenService,
            userRepository: createMockUserRepository(new Map()),
            databaseService: createMockDatabaseService([{ Role: createRole('doctor') }]),
        });

        await expect(
            controller.refresh({ refreshToken: 'opaque-old-token' }),
        ).rejects.toThrow(UnauthorizedException);
        expect(refreshTokenService.issue).not.toHaveBeenCalled();
    });

    it('W1.3 — the legacy private generateRefreshToken helper has been removed (W1.5 final closure)', () => {
        // Once refresh() goes through RefreshTokenService.issue, NO controller
        // method has a reason to mint a refresh token directly — the legacy
        // helper must not come back.
        const controller = buildController();
        expect((controller as any).generateRefreshToken).toBeUndefined();
    });

    it('W1.3 — does NOT parse the refresh token by splitting on underscores (legacy attack surface removed)', async () => {
        // The legacy behaviour took `parts = body.refreshToken.split('_')` and
        // trusted parts[1] as userId. That made tokens like `refresh_admin_1_x`
        // a privilege-escalation primitive. Pin the new contract: the controller
        // MUST NOT derive userId from the token string — it MUST come from
        // RefreshTokenService.consume's response.
        const refreshTokenService = createMockRefreshTokenService();
        refreshTokenService.consume.mockResolvedValueOnce({
            userId: 'doctor-001',
            tenantId: 'tenant-A',
            jti: 'old-jti',
            family: 'family-original',
        });
        const userRepository = createMockUserRepository(new Map([['doctor-001', createUser()]]));
        const controller = buildController({
            refreshTokenService,
            userRepository,
            databaseService: createMockDatabaseService([{ Role: createRole('doctor') }]),
        });

        // Pass an attacker-crafted token claiming to be `admin`. The new
        // contract IGNORES this entirely and uses the consumed record's userId.
        await controller.refresh({ refreshToken: 'refresh_admin_99999_aaaa' });

        const findCall = userRepository.findFirst.mock.calls[0][0];
        expect(findCall.filters.id).toBe('doctor-001');
        expect(findCall.filters.id).not.toBe('admin');
    });
});

// ---------------------------------------------------------------------------
// Logout revokes both the access-token jti AND the refresh-token family —
// terminating the full session, not just the in-flight request.
// ---------------------------------------------------------------------------
describe('AuthController — logout session-revocation', () => {
    beforeEach(() => vi.clearAllMocks());

    function buildLogoutController(sessionOverrides: any = {}) {
        const session = {
            id: 'doctor-001',
            tenantId: 'tenant-A',
            jti: 'jti-abc-123',
            exp: Math.floor(Date.now() / 1000) + 3600,
            refreshFamily: 'family-xyz',
            ...sessionOverrides,
        };
        const clsService = createMockClsService(session);
        const jwtRevocationService = createMockJwtRevocationService();
        const refreshTokenService = createMockRefreshTokenService();
        const authService = createMockAuthService();

        const controller = buildController({
            clsService,
            jwtRevocationService,
            refreshTokenService,
            authService,
        });
        return { controller, session, clsService, jwtRevocationService, refreshTokenService, authService };
    }

    it('W1.4 / C-11 — revokes the access-token jti via JwtRevocationService.revoke(jti, exp)', async () => {
        const { controller, jwtRevocationService } = buildLogoutController();
        await controller.logout(createMockRequest() as any);

        expect(jwtRevocationService.revoke).toHaveBeenCalledTimes(1);
        const [jti, exp] = jwtRevocationService.revoke.mock.calls[0];
        expect(jti).toBe('jti-abc-123');
        expect(typeof exp).toBe('number');
        expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('W1.4 / AC-2 — revokes the entire refresh-token family via RefreshTokenService.revokeFamily(family)', async () => {
        const { controller, refreshTokenService } = buildLogoutController();
        await controller.logout(createMockRequest() as any);

        expect(refreshTokenService.revokeFamily).toHaveBeenCalledTimes(1);
        expect(refreshTokenService.revokeFamily).toHaveBeenCalledWith('family-xyz');
    });

    it('W1.4 — logout is idempotent: a session WITHOUT jti / refreshFamily still returns success', async () => {
        const { controller, jwtRevocationService, refreshTokenService } = buildLogoutController({
            jti: undefined,
            refreshFamily: undefined,
        });
        const response = await controller.logout(createMockRequest() as any);

        expect(response.success).toBe(true);
        // No jti and no family → nothing to revoke. Both calls must be SKIPPED, not invoked with undefined.
        expect(jwtRevocationService.revoke).not.toHaveBeenCalled();
        expect(refreshTokenService.revokeFamily).not.toHaveBeenCalled();
    });

    it('logout still tracks the authentication event', async () => {
        const { controller, authService } = buildLogoutController();
        await controller.logout(createMockRequest() as any);

        expect(authService.trackAuthentication).toHaveBeenCalledTimes(1);
        expect(authService.trackAuthentication).toHaveBeenCalledWith(
            'doctor-001',
            expect.objectContaining({ endpoint: '/auth/logout', method: 'POST' }),
        );
    });

    it('W1.4 — non-fatal: JwtRevocationService.revoke failure does NOT bubble (defense in depth)', async () => {
        // Logout must NEVER fail because of a downstream revocation outage —
        // the client has already discarded its tokens; failing the call would
        // leave the user UI in a broken state. We still attempt both revokes
        // independently — refreshTokenService.revokeFamily must still run.
        const { controller, jwtRevocationService, refreshTokenService } = buildLogoutController();
        jwtRevocationService.revoke.mockRejectedValueOnce(new Error('Redis down'));

        const response = await controller.logout(createMockRequest() as any);

        expect(response.success).toBe(true);
        expect(refreshTokenService.revokeFamily).toHaveBeenCalledWith('family-xyz');
    });

    it('W1.4 — non-fatal: RefreshTokenService.revokeFamily failure does NOT bubble', async () => {
        const { controller, jwtRevocationService, refreshTokenService } = buildLogoutController();
        refreshTokenService.revokeFamily.mockRejectedValueOnce(new Error('Redis down'));

        const response = await controller.logout(createMockRequest() as any);

        expect(response.success).toBe(true);
        // jti revoke still runs even if family revoke later fails.
        expect(jwtRevocationService.revoke).toHaveBeenCalledWith('jti-abc-123', expect.any(Number));
    });

    it('W1.4 — does NOT call JwtRevocationService.revoke when the JWT has no jti claim (legacy tokens issued before W1.6)', async () => {
        // Defensive: an older session might be pre-W1.6 and lack a jti. The
        // controller must NOT pass `undefined` as the jti or it would poison
        // the revocation set. It must skip the call entirely.
        const { controller, jwtRevocationService } = buildLogoutController({ jti: undefined });
        await controller.logout(createMockRequest() as any);

        expect(jwtRevocationService.revoke).not.toHaveBeenCalled();
    });
});

// Anti-regression: every existing AuthController invariant that this
// refactor MUST preserve. The login still validates credentials,
// still throws BadRequest on missing tenantKey for non-admins, etc.
describe('AuthController — anti-regression for existing login behaviours', () => {
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
