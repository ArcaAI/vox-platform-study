import { Logger, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { OidcStrategy } from './oidc.strategy';
import { Issuer } from 'openid-client';
import { JwtStrategy } from './jwt.strategy';
import { GatewayJwtStrategy } from './gateway-auth.strategy';
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
import { JwtRevocationService, IJwtRevocationService } from './jwt-revocation.service';
import { RefreshTokenService, IRefreshTokenService } from './refresh-token.service';

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
          // TASK-302 Phase 3 Task 3.8 — OIDC_CLIENT_SECRET (the only secret in
          // this factory) now reads from SecretsService. The other three
          // (DISCOVERY_URL, CLIENT_ID, CALLBACK_URL) stay on AppSettings —
          // they're public OIDC config, not secrets.
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

          const issuer = await Issuer.discover(oidc_discovery_url);
          const client = new issuer.Client({
            client_id: oidc_client_id,
            client_secret: oidc_client_secret,
            redirect_uris: [oidc_callback_url],
            response_types: ['code'],
          });

          logger.log(`OIDC Client initialized successfully for issuer: ${issuer.issuer}`);

          return client;
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
    GatewayJwtStrategy,
    {
      provide: IJwtRevocationService,
      useClass: JwtRevocationService,
    },
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
    GatewayJwtStrategy,
    IJwtRevocationService,
    IRefreshTokenService,
  ],
})
export class AuthServiceModule {}
