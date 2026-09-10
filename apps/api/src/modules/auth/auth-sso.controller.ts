import {
  FederatedAuthService,
  FederatedSession,
  IAppSettingsService,
  IRefreshTokenService,
  SecretsService,
  createJwt,
  resolveJwtSecret,
} from '@arcaai/applications';
import { Controller, Get, Header, HttpCode, HttpStatus, Inject, Param, Post, Query, UnauthorizedException, Body } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'crypto';
import { Public } from '../../decorators';
import { LoginResponse, LoginUserResponse, SamlAcsRequest, SsoStartRequest, SsoStartResponse } from './dto';

/**
 * AuthSsoController (OIDC + SAML) — the tenant-scoped
 * federated login round-trips:
 * - OIDC: `POST /auth/sso/start` (HRD/tenantKey → authorize URL + PKCE +
 *   signed state) and `GET /auth/sso/callback`.
 * - SAML: `GET /auth/sso/saml/:tenantKey/metadata` (SP metadata for IdP
 *   registration), `POST /auth/sso/saml/:tenantKey/start` (SP-initiated
 *   AuthnRequest redirect — a separate route from OIDC's `start`, not a
 *   branch of it, so the already-shipped/tested OIDC path is untouched), and
 *   `POST /auth/sso/saml/:tenantKey/acs`.
 *
 * All legs are pre-session — `@Public()`, throttled like `/auth/login`.
 * Downstream of a successful callback/ACS is IDENTICAL to local login (see
 * `mintSession`): the same `createJwt` + `RefreshTokenService.issue` mint
 * path, so `UnifiedAuthGuard` / `jwt.strategy` / `policy.engine` authorize a
 * federated session exactly as they do a password session.
 */
@ApiTags('auth')
@Controller('auth/sso')
export class AuthSsoController {
  constructor(
    private readonly federatedAuthService: FederatedAuthService,
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    @Inject(SecretsService) private readonly secretsService: SecretsService,
    @Inject(IRefreshTokenService) private readonly refreshTokenService: IRefreshTokenService,
  ) {}

  /**
   * The gateway's own public callback URL, registered with every tenant's
   * IdP as the OIDC `redirect_uri`. A platform-wide constant (state carries
   * the tenant/provider distinction) — same `AppSettingsService` key the
   * retired global OIDC stub used, so existing deployments' config carries
   * over unchanged.
   */
  private redirectUri(): string {
    return this.appSettingsService.getValueWithDefault('OIDC_CALLBACK_URL', 'http://localhost:8868/api/v1/auth/sso/callback') as string;
  }

  /**
   * The gateway's own public SAML ACS base URL, registered with every
   * tenant's IdP as the ACS `Location` (per-tenant path, unlike OIDC's
   * single shared `redirect_uri` — SAML's ACS route carries `:tenantKey`).
   */
  private samlAcsUrl(tenantKey: string): string {
    const base = this.appSettingsService.getValueWithDefault('SAML_ACS_BASE_URL', 'http://localhost:8868/api/v1/auth/sso/saml') as string;
    return `${base}/${tenantKey}/acs`;
  }

  // TASK-944 — the ONE shared resolver, which `JwtStrategy` also verifies with.
  private async resolveJwtSecretKey(): Promise<string | undefined> {
    return resolveJwtSecret(this.secretsService);
  }

  @Post('start')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Begin a tenant-scoped OIDC login (HRD by email, or explicit tenantKey)' })
  @ApiResponse({ status: 200, type: SsoStartResponse })
  @ApiResponse({ status: 400, description: 'Neither a mapped email domain nor a tenantKey resolved a provider' })
  async start(@Body() request: SsoStartRequest): Promise<SsoStartResponse> {
    const { authorizeUrl } = await this.federatedAuthService.buildAuthorizeUrl({
      email: request.email,
      tenantKey: request.tenantKey,
      redirectUri: this.redirectUri(),
    });
    return { authorizeUrl };
  }

  @Get('callback')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Complete the IdP's OIDC callback and mint a HOPE session" })
  @ApiQuery({ name: 'code', required: true })
  @ApiQuery({ name: 'state', required: true })
  @ApiResponse({ status: 200, type: LoginResponse })
  @ApiResponse({ status: 401, description: 'Invalid/expired state, failed verification, or revoked membership' })
  async callback(@Query('code') code: string, @Query('state') state: string): Promise<LoginResponse> {
    try {
      const session = await this.federatedAuthService.verifyOidcCallback({ code, state, redirectUri: this.redirectUri() });
      return await this.mintSession(session);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Authentication failed');
    }
  }

  @Get('saml/:tenantKey/metadata')
  @Public()
  @Header('Content-Type', 'application/xml')
  @ApiOperation({ summary: "This SP's SAML metadata for the tenant's configured IdP — register with the IdP out-of-band" })
  @ApiParam({ name: 'tenantKey' })
  @ApiResponse({ status: 200, description: 'SAML SP EntityDescriptor XML' })
  @ApiResponse({ status: 400, description: 'No SAML identity provider configured for this tenant' })
  async samlMetadata(@Param('tenantKey') tenantKey: string): Promise<string> {
    return this.federatedAuthService.getSamlServiceProviderMetadata(tenantKey, this.samlAcsUrl(tenantKey));
  }

  @Post('saml/:tenantKey/start')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Begin a tenant-scoped SAML login (SP-initiated AuthnRequest redirect)' })
  @ApiParam({ name: 'tenantKey' })
  @ApiResponse({ status: 200, type: SsoStartResponse })
  @ApiResponse({ status: 400, description: 'No enabled SAML identity provider configured for this tenant' })
  async samlStart(@Param('tenantKey') tenantKey: string): Promise<SsoStartResponse> {
    const { redirectUrl } = await this.federatedAuthService.buildSamlAuthnRequest({ tenantKey, acsUrl: this.samlAcsUrl(tenantKey) });
    return { authorizeUrl: redirectUrl };
  }

  @Post('saml/:tenantKey/acs')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete the SAML ACS POST (assertion validation, D4) and mint a HOPE session' })
  @ApiParam({ name: 'tenantKey' })
  @ApiResponse({ status: 200, type: LoginResponse })
  @ApiResponse({ status: 401, description: 'Invalid/tampered/expired/replayed assertion, or revoked membership' })
  async samlAcs(@Param('tenantKey') tenantKey: string, @Body() body: SamlAcsRequest): Promise<LoginResponse> {
    try {
      const session = await this.federatedAuthService.verifySamlResponse({
        tenantKey,
        samlResponse: body.SAMLResponse,
        acsUrl: this.samlAcsUrl(tenantKey),
      });
      return await this.mintSession(session);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Authentication failed');
    }
  }

  /** Shared OIDC-callback/SAML-ACS tail: mint a HOPE JWT + refresh token, identical to `AuthController.login`'s mint path. */
  private async mintSession(session: FederatedSession): Promise<LoginResponse> {
    const jwtSecretKey = await this.resolveJwtSecretKey();
    if (!jwtSecretKey) {
      throw new UnauthorizedException('Authentication system not configured');
    }
    const jwtExpiresIn = this.appSettingsService.getValueWithDefault('JWT_EXPIRES_IN', '1h') as string;
    const jti = randomBytes(16).toString('hex');

    const issued = await this.refreshTokenService.issue({ userId: session.id, tenantId: session.tenantId, jti });

    // Built as a standalone object (not an inline literal at the call site)
    // so it can carry the legacy `username` claim `auth.controller.ts` also
    // signs — matches its token payload shape exactly.
    const tokenPayload = {
      id: session.id,
      username: session.username,
      email: session.email,
      roles: session.roles,
      permissions: session.permissions,
      tenantId: session.tenantId,
      jti,
      refreshFamily: issued.family,
      jwtSecretKey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expiresIn: jwtExpiresIn as any,
    };
    const token = createJwt(tokenPayload);

    const userResponse = new LoginUserResponse({
      id: session.id,
      username: session.username,
      email: session.email,
      roles: session.roles,
      permissions: session.permissions,
      tenantId: session.tenantId,
    });

    return { user: userResponse, token, refreshToken: issued.rawToken };
  }
}
