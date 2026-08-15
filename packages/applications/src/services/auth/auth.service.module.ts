import { Logger, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { OidcStrategy } from './oidc.strategy';
import { allowInsecureRequests, discovery } from 'openid-client';
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
      provide: 'OPENID_CLIENT',
      useFactory: async (appSettingsService: IAppSettingsService, secretsService: SecretsService) => {
        try {
          const oidc_discovery_url = appSettingsService.getValueWithDefault(
            'OIDC_DISCOVERY_URL',
            'https://example.com/.well-known/openid_configuration',
          );
          const oidc_client_id = appSettingsService.getValueWithDefault('OIDC_CLIENT_ID', 'default-client-id');
          // OIDC_CLIENT_SECRET (the only secret in this factory) reads from
          // SecretsService. The other three (DISCOVERY_URL, CLIENT_ID,
          // CALLBACK_URL) stay on AppSettings — they're public OIDC config,
          // not secrets.
          const oidc_client_secret = secretsService.getSecretSync('OIDC_CLIENT_SECRET') ?? 'default-client-secret';
          const oidc_callback_url = appSettingsService.getValueWithDefault('OIDC_CALLBACK_URL', 'http://localhost:8001/auth/callback');

          if (!oidc_discovery_url || oidc_discovery_url === 'https://example.com/.well-known/openid_configuration') {
            logger.warn('OIDC_DISCOVERY_URL not configured — OIDC authentication disabled');
            return null;
          }
          if (!oidc_client_id || oidc_client_id === 'default-client-id') {
            logger.warn('OIDC_CLIENT_ID not configured — OIDC authentication disabled');
            return null;
          }
          if (!oidc_client_secret || oidc_client_secret === 'default-client-secret') {
            logger.warn('OIDC_CLIENT_SECRET not configured — OIDC authentication disabled');
            return null;
          }

          const server = new URL(oidc_discovery_url);
          const config = await discovery(server, oidc_client_id, {
            client_secret: oidc_client_secret,
            redirect_uris: [oidc_callback_url],
            response_types: ['code'],
          });
          if (server.protocol === 'http:') {
            allowInsecureRequests(config);
          }

          logger.log(`OIDC Client initialized successfully for issuer: ${config.serverMetadata().issuer}`);

          return config;
        } catch (error) {
          logger.error(`Failed to initialize OIDC client: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      },
      inject: [IAppSettingsService, SecretsService],
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
