import { PassportStrategy } from '@nestjs/passport';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { IAppSettingsService } from '../baseServices/_meta/appSettings';
import { SecretsService } from '../baseServices/_meta/secrets';
import { fetchUserInfo, skipSubjectCheck, type Configuration, type TokenEndpointResponse, type TokenEndpointResponseHelpers } from 'openid-client';
import { IAuthService } from './IAuthService';
import { UnauthorizedException } from '@arcaai/exceptions';
import { createJwt, StringValue } from './createJwt';
import { resolveJwtSecret } from './jwt-secret';
import { ClsService } from 'nestjs-cls';
import { OAuthUserResponse, UserSession } from './dto';
import { IActiveUserContext } from '../../interfaces';

// openid-client v6 is ESM-only; the Passport strategy lives on the
// `./passport` export. Nest/applications compile to CJS. Vitest/Vite's
// CJS interop of that subpath often puts the constructor on `.default`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const oidcPassport = require('openid-client/passport') as {
  Strategy?: new (options: object, verify?: (...args: unknown[]) => void) => object;
  default?: { Strategy?: new (options: object, verify?: (...args: unknown[]) => void) => object };
};
const Strategy = oidcPassport.Strategy ?? oidcPassport.default?.Strategy;
if (!Strategy) {
  throw new Error('openid-client/passport Strategy failed to load');
}
/**
 * OidcStrategy is a class that extends the PassportStrategy for OpenID Connect (OIDC) authentication.
 * It is responsible for validating OIDC tokens and managing user sessions.
 */
@Injectable()
export class OidcStrategy extends PassportStrategy(Strategy, 'oidc') {
  private readonly logger: Logger = new Logger(OidcStrategy.name);

  /**
   * Constructor for OidcStrategy.
   * @param config - The openid-client Configuration used for requests to the OIDC provider.
   * @param authService - The authentication service for handling user authentication logic.
   * @param clsService - The context-local storage service for managing user context.
   */
  constructor(
    @Inject('OPENID_CLIENT') private config: Configuration,
    @Inject(IAppSettingsService) private appSettingsService: IAppSettingsService,
    @Inject(IAuthService) private authService: IAuthService,
    private readonly clsService: ClsService<IActiveUserContext>,
    @Inject(SecretsService) private readonly secretsService: SecretsService,
  ) {
    const oidcScopes = appSettingsService.getValueWithDefault('OIDC_SCOPES', 'openid profile email');
    const oidcCallbackUrl = appSettingsService.getValueWithDefault('OIDC_CALLBACK_URL', 'http://localhost:8001/auth/callback');

    super({
      config,
      callbackURL: oidcCallbackUrl,
      scope: oidcScopes,
      passReqToCallback: false,
    });

    this.logger.debug({
      message: 'OIDC strategy initialized',
      callbackUrl: oidcCallbackUrl,
      scopes: oidcScopes,
    });
  }

  /**
   * Validates the provided token set and retrieves or creates the user.
   * @param tokenset - The token set received from the OIDC provider.
   * @returns A promise that resolves to an OAuthUserResponse or null if validation fails.
   * @throws UnauthorizedException if the user could not be found or created.
   */
  async validate(tokenset: TokenEndpointResponse & TokenEndpointResponseHelpers): Promise<OAuthUserResponse | null> {
    const subject = tokenset.claims?.()?.sub ?? skipSubjectCheck;
    const userinfo = await fetchUserInfo(this.config, tokenset.access_token, subject);

    // Split the user's full name into first and last names.
    const splitName = userinfo.name?.split(' ');
    const firstName = splitName ? splitName[0] : '';
    const lastName = splitName ? splitName[1] : '';

    // Attempt to retrieve or create the user based on the OIDC information.
    const oauthUserResponse = await this.authService.getOrCreateOidcUser({
      firstName,
      lastName,
      email: userinfo.email as string,
      externalId: userinfo.sub as string,
    });

    // If the user could not be found or created, throw an UnauthorizedException.
    if (!oauthUserResponse) {
      throw new UnauthorizedException('User could not be found/created');
    }

    // TASK-944 — the SAME resolver `JwtStrategy` verifies with, so this mint can
    // never sign against a secret the guard will not accept.
    //
    // This line used to be a bare `getSecretSync` with a hard-coded development
    // string as its nullish fallback. `getSecretSync` is cache-only by design, so one
    // lapsed TTL was enough to make an OIDC login mint a token signed with that
    // literal — which NO verifier would ever accept, producing a silent 401
    // indistinguishable from a bad password. A missing secret is now a refusal, never
    // a substituted value. (`auth-secrets-migration.test.ts` scans this file's TEXT
    // for that fallback, so the retired literal is deliberately not written out here.)
    // JWT_EXPIRES_IN stays on AppSettings — it is not a secret.
    const jwtSecretKey = await resolveJwtSecret(this.secretsService);
    if (!jwtSecretKey) {
      throw new UnauthorizedException('Authentication system not configured');
    }
    const jwtExpiresIn = this.appSettingsService.getValueWithDefault('JWT_EXPIRES_IN', '1h') as StringValue;

    oauthUserResponse.token = createJwt({
      id: oauthUserResponse.id,
      firstName: oauthUserResponse.firstName,
      lastName: oauthUserResponse.lastName,
      email: oauthUserResponse.email,
      phone: oauthUserResponse.phone,
      jwtSecretKey,
      expiresIn: jwtExpiresIn,
    });

    // Create a new user session with the authenticated user's information.
    const userSession = new UserSession({
      id: oauthUserResponse.id,
      firstName: oauthUserResponse.firstName,
      lastName: oauthUserResponse.lastName,
      email: oauthUserResponse.email,
      phone: oauthUserResponse.phone,
      token: oauthUserResponse.token,
    });

    // Store the user session in the context-local storage.
    this.clsService.set('user', userSession);
    return oauthUserResponse; // Return the OAuth user response.
  }
}
