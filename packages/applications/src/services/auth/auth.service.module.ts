import { Logger, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { OidcStrategy } from './oidc.strategy';
import { JwtStrategy } from './jwt.strategy';
import { ClsService } from 'nestjs-cls';

import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { RedisCacheModule } from '../baseServices/redis/redis-cache.module';
import { SessionSerializer } from './session.serializer';
import { IAuthService } from './IAuthService';
import { AuthService } from './auth.service';
import { IAppSettingsService } from '../baseServices/_meta/';
import { SecretsService } from '../baseServices/_meta/secrets';
import { UserServiceModule } from '../user/user/user.service.module';
import { JwtRevocationModule } from './jwt-revocation.module';
import { RefreshTokenService, IRefreshTokenService } from './refresh-token.service';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';

const logger = new Logger('AuthServiceModule');

@Module({
  imports: [
    CommonServiceModule,
    PassportModule.register({
      defaultStrategy: 'jwt',
      session: false,
    }),
    CoreDatabaseModule,
    UserServiceModule,
    RedisCacheModule.register(),
    // The revocation authority now lives in its own module so
    // UserServiceModule can consume it without a circular import back here.
    JwtRevocationModule,
  ],
  providers: [
    {
      /**
       * RETIRED — identity has no platform credential tier.
       *
       * This factory used to build a platform-wide relying-party client from
       * `OIDC_DISCOVERY_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`. Federated
       * login is now resolved PER TENANT by `IdpResolverService`, which decrypts
       * that tenant's own `TenantIdentityProvider.encryptedSecretRef` (Vault
       * Transit) for every `/auth/sso/*` round-trip. Unlike every other provider
       * credential on this platform, identity does NOT cascade to a SYSTEM
       * fallback: a tenant federates against its own directory or not at all —
       * falling back would authenticate its users against somebody else's IdP.
       *
       * So the platform secret was not a fallback, it was a SECOND credential
       * path. It already authenticated nothing (its `OidcStrategy` is reachable
       * from no route — `OidcAuthGuard` is applied to zero controllers), but
       * leaving it wired kept `OIDC_CLIENT_SECRET` warmed at boot, seedable into
       * Vault, and one re-attached guard away from serving logins again. It also
       * forced a live `discovery()` network round-trip at module init.
       *
       * The token itself survives so `OidcStrategy` still resolves its injection
       * (it short-circuits to an inert `{}` on `null`, as it always did when OIDC
       * was unconfigured). Closure is pinned by
       * `__tests__/oidc-platform-tier-closed.test.ts`.
       */
      provide: 'OPENID_CLIENT',
      useFactory: () => null,
    },
    {
      provide: IAuthService,
      useClass: AuthService,
    },
    SessionSerializer,
    {
      provide: OidcStrategy,
      useFactory: (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: any,
        appSettingsService: IAppSettingsService,
        authService: IAuthService,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        clsService: any,
        secretsService: SecretsService,
      ) => {
        if (!client) {
          logger.warn('OIDC client not available — OidcStrategy will not be registered');
          return {};
        }
        return new OidcStrategy(client, appSettingsService, authService, clsService, secretsService);
      },
      inject: ['OPENID_CLIENT', IAppSettingsService, IAuthService, ClsService, SecretsService],
    },
    JwtStrategy,
    // The `global-kv` cascade for `refreshToken.ttlSeconds`.
    // Provided locally — its only dependency is `IAppSettingsService`, already
    // available in this graph.
    TenantSettingsService,
    {
      provide: IRefreshTokenService,
      useClass: RefreshTokenService,
    },
  ],
  exports: [
    PassportModule,
    'OPENID_CLIENT',
    IAuthService,
    OidcStrategy,
    JwtStrategy,
    // The MODULE is re-exported, not the token: Nest rejects
    // exporting a provider this module no longer declares. Re-exporting the
    // module carries its own exports through, so existing consumers
    // (AuthController) keep resolving IJwtRevocationService unchanged.
    JwtRevocationModule,
    IRefreshTokenService,
  ],
})
export class AuthServiceModule {}
