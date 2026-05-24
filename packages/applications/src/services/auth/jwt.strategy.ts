import { Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ClsService } from 'nestjs-cls';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IJwtRevocationService } from './jwt-revocation.service';
import { UserSession } from './dto';

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
    // (cache-warmed at bootstrap by main.ts). See gateway-auth.strategy.ts
    // for the same pattern.
    const jwtSecret = secretsService.getSecretSync('JWT_SECRET_KEY') ?? 'default-jwt-secret-key-change-in-production';

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: jwtSecret,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async validate(payload: any): Promise<UserSession> {
    // C-4: refuse tokens whose jti has been revoked. Best-effort — if the
    // revocation service is unavailable or omitted (tests, bootstrap edge
    // cases) the check fails open and the token is still subject to all
    // other JWT validation downstream.
    if (payload?.jti && this.jwtRevocationService) {
      const revoked = await this.jwtRevocationService.isRevoked(payload.jti);
      if (revoked) {
        throw new UnauthorizedException('Token has been revoked');
      }
    }

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
    });

    this.clsService.set('user', userSession);
    // SEC-J (C-2): always propagate the JWT-derived tenantId into CLS so
    // downstream consumers (BaseService.tenantId) cannot be overridden by
    // a forged `x-tenant-id` header.
    this.clsService.set('tenantId', payload.tenantId);
    return userSession;
  }
}
