import { PassportStrategy } from '@nestjs/passport';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { IAppSettingsService } from '../baseServices/_meta/appSettings';
import { Strategy, Client } from 'openid-client';
import { IAuthService } from './IAuthService';
import { UnauthorizedException } from '@arcaai/exceptions';
import { createJwt, StringValue } from './createJwt';
import { ClsService } from 'nestjs-cls';
import { OAuthUserResponse, UserSession } from './dto';
import { IActiveUserContext } from '../../interfaces';
/**
 * OidcStrategy is a class that extends the PassportStrategy for OpenID Connect (OIDC) authentication.
 * It is responsible for validating OIDC tokens and managing user sessions.
 */
@Injectable()
export class OidcStrategy extends PassportStrategy(Strategy, 'oidc') {
  private readonly logger: Logger = new Logger(OidcStrategy.name);

  /**
   * Constructor for OidcStrategy.
   * @param client - The OpenID client used for making requests to the OIDC provider.
   * @param authService - The authentication service for handling user authentication logic.
   * @param clsService - The context-local storage service for managing user context.
   */
  constructor(
    @Inject('OPENID_CLIENT') private client: Client,
    @Inject(IAppSettingsService) private appSettingsService: IAppSettingsService,
    @Inject(IAuthService) private authService: IAuthService,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {
    const oidcScopes = appSettingsService.getValueWithDefault('OIDC_SCOPES', 'openid profile email');
    const oidcCallbackUrl = appSettingsService.getValueWithDefault('OIDC_CALLBACK_URL', 'http://localhost:8001/auth/callback');

    super({
      client,
      params: {
        response_type: 'code',
        scope: oidcScopes,
        redirect_uri: oidcCallbackUrl,
      },
      passReqToCallback: false,
      usePKCE: false,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async validate(tokenset: any): Promise<OAuthUserResponse | null> {
    const userinfo = await this.client.userinfo(tokenset); // Retrieve user information from the token set.

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

    // Create a JWT token for the authenticated user.
    // JWT configuration is now managed via AppSettingsService (database-stored settings)
    const jwtSecretKey = this.appSettingsService.getValueWithDefault('JWT_SECRET_KEY', 'default-secret-key');
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
