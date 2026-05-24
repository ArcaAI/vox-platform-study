import { Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ClsService } from 'nestjs-cls';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { IActiveUserContext } from '../../interfaces';
import { IAppSettingsService } from '../baseServices/_meta/appSettings';
import { IJwtRevocationService } from './jwt-revocation.service';
import { UserSession } from './dto';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    private readonly clsService: ClsService<IActiveUserContext>,
    @Optional()
    @Inject(IJwtRevocationService)
    private readonly jwtRevocationService?: IJwtRevocationService,
  ) {
    const jwtSecret = appSettingsService.getValueWithDefault('JWT_SECRET_KEY', 'default-jwt-secret-key-change-in-production');

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
