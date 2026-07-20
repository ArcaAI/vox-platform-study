import { Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ClsService } from 'nestjs-cls';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IJwtRevocationService } from './jwt-revocation.service';
import { UserSession } from './dto';

const JWT_SECRET_PLACEHOLDER = 'default-jwt-secret-key-change-in-production';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    @Inject(SecretsService) private readonly secretsService: SecretsService,
    private readonly clsService: ClsService<IActiveUserContext>,
    @Optional()
    @Inject(IJwtRevocationService)
    private readonly jwtRevocationService?: IJwtRevocationService,
  ) {
    // TASK-302 Phase 3 Task 3.6 — JWT secret now sourced from SecretsService
    // (cache-warmed at bootstrap by main.ts).
    //
    // TASK-307 W2.1 / W7.A.6 (closes audit C-6) — refuse to start when the
    // resolved JWT secret is missing OR equals the literal placeholder.
    // Catches both:
    //   (a) the placeholder ever landing in Vault / SecretsService, and
    //   (b) a warmup miss returning undefined (no implicit fallback).
    // The thrown Error propagates out of NestFactory.create() and exits
    // the process before any request can be served — same posture as
    // `auditAdminRoutePermissions` in apps/api/src/bootstrap.
    const jwtSecret = secretsService.getSecretSync('JWT_SECRET_KEY');
    if (!jwtSecret || jwtSecret === JWT_SECRET_PLACEHOLDER) {
      new Logger(JwtStrategy.name).error(
        'JWT_SECRET_KEY resolved to the literal placeholder. SecretsService either has no value warmed under this key, or the warmed value is the development default. Refusing to boot.',
      );
      throw new Error('JWT_SECRET_KEY is the literal placeholder; refusing to boot. Set a real secret in Vault / SecretsService.');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: jwtSecret,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async validate(payload: any): Promise<UserSession> {
    await this.assertNotRevoked(payload);

    const userSession = new UserSession({
      id: payload.id,
      firstName: payload.firstName,
      lastName: payload.lastName,
      email: payload.email,
      phone: payload.phone,
      token: payload.token,
      tenantId: payload.tenantId,
      tenantCode: payload.tenantCode,
      roles: payload.roles || [],
      permissions: payload.permissions || [],
      impersonatedBy: payload.impersonatedBy,
      jti: payload.jti,
      exp: payload.exp,
      // TASK-307 W1.4: propagate the refresh-token family so /auth/logout
      // can revoke the full chain via RefreshTokenService.revokeFamily.
      refreshFamily: payload.refreshFamily,
    });

    this.clsService.set('user', userSession);
    // SEC-J (C-2): always propagate the JWT-derived tenantId into CLS so
    // downstream consumers (BaseService.tenantId) cannot be overridden by
    // a forged `x-tenant-id` header.
    this.clsService.set('tenantId', payload.tenantId);
    return userSession;
  }

  /**
   * Two independent revocation axes, both consulted before the session is built.
   *
   * - **C-4 per-token**: the `jti` was explicitly revoked (logout,
   *   revoke-impersonation).
   * - **TASK-541 A4 per-user**: the user was disabled/suspended/deleted after
   *   this token was minted, so every `iat` at or before the stamp is dead.
   *   Comparison is `iat <= notBefore` — a token minted in the same second as
   *   the deactivation must lose the tie, since the alternative is handing a
   *   just-disabled user a full token lifetime of access.
   *
   * **TASK-541 A3 — posture when the store is unreachable.** An ordinary token
   * fails OPEN: a Redis outage must not black out every authenticated request,
   * and the token remains subject to signature + expiry validation. An
   * IMPERSONATION token fails CLOSED: it is the highest-privilege credential
   * on the platform (an operator acting as another user), its revoke path is
   * the one most likely to be exercised under duress, and refusing it costs
   * only a break-glass session rather than platform availability.
   *
   * Both lookups are issued concurrently so the pair costs one round-trip of
   * wall-clock on this hot path (ioredis pipelines concurrent commands).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- passport hands the raw decoded JWT claims through untyped; validate() above takes the same shape
  private async assertNotRevoked(payload: any): Promise<void> {
    if (!this.jwtRevocationService) return;

    const jti: string | undefined = payload?.jti;
    const userId: string | undefined = payload?.id;
    const issuedAt: unknown = payload?.iat;
    const isImpersonated = Boolean(payload?.impersonatedBy);

    const checkUserNbf = typeof userId === 'string' && userId.length > 0 && typeof issuedAt === 'number';

    const [tokenCheck, userCheck] = await Promise.all([
      jti ? this.jwtRevocationService.checkRevoked(jti) : Promise.resolve(null),
      checkUserNbf ? this.jwtRevocationService.getUserNotBefore(userId as string) : Promise.resolve(null),
    ]);

    if (tokenCheck?.revoked) {
      throw new UnauthorizedException('Token has been revoked');
    }

    if (userCheck?.notBefore !== null && userCheck?.notBefore !== undefined && (issuedAt as number) <= userCheck.notBefore) {
      throw new UnauthorizedException('Token has been revoked');
    }

    if (isImpersonated && (tokenCheck?.degraded || userCheck?.degraded)) {
      throw new UnauthorizedException('Token revocation status unavailable');
    }
  }
}
