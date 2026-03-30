import { Logger, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { OidcStrategy } from './oidc.strategy';
import { Issuer } from 'openid-client';
import { JwtStrategy } from './jwt.strategy';
import { GatewayJwtStrategy } from './gateway-auth.strategy';
import { ClsService } from 'nestjs-cls';

import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { SessionSerializer } from './session.serializer';
import { IAuthService } from './IAuthService';
import { AuthService } from './auth.service';
import { IAppSettingsService } from '../baseServices/_meta/';
import { UserServiceModule } from '../user/user/user.service.module';

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
  ],
  providers: [
    {
      provide: 'OPENID_CLIENT',
      useFactory: async (appSettingsService: IAppSettingsService) => {
        try {
          const oidc_discovery_url = appSettingsService.getValueWithDefault(
            'OIDC_DISCOVERY_URL',
            'https://example.com/.well-known/openid_configuration',
          );
          const oidc_client_id = appSettingsService.getValueWithDefault('OIDC_CLIENT_ID', 'default-client-id');
          const oidc_client_secret = appSettingsService.getValueWithDefault('OIDC_CLIENT_SECRET', 'default-client-secret');
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
      inject: [IAppSettingsService],
    },
    {
      provide: IAuthService,
      useClass: AuthService,
    },
    SessionSerializer,
    {
      provide: OidcStrategy,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useFactory: (client: any, appSettingsService: IAppSettingsService, authService: IAuthService, clsService: any) => {
        if (!client) {
          logger.warn('OIDC client not available — OidcStrategy will not be registered');
          return {};
        }
        return new OidcStrategy(client, appSettingsService, authService, clsService);
      },
      inject: ['OPENID_CLIENT', IAppSettingsService, IAuthService, ClsService],
    },
    JwtStrategy,
    GatewayJwtStrategy,
  ],
  exports: [PassportModule, 'OPENID_CLIENT', IAuthService, OidcStrategy, JwtStrategy, GatewayJwtStrategy],
})
export class AuthServiceModule {}
