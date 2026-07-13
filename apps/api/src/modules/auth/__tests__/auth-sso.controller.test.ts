import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { AuthSsoController } from '../auth-sso.controller';

function makeController() {
  const federatedAuthService = {
    buildAuthorizeUrl: vi.fn(),
    verifyOidcCallback: vi.fn(),
    getSamlServiceProviderMetadata: vi.fn(),
    buildSamlAuthnRequest: vi.fn(),
    verifySamlResponse: vi.fn(),
  };
  const appSettingsService = {
    getValueWithDefault: vi.fn((key: string, def: string) => (key === 'JWT_EXPIRES_IN' ? '1h' : def)),
  };
  const secretsService = { getSecretSync: vi.fn(() => 'jwt-secret'), getSecretOptional: vi.fn(async () => 'jwt-secret') };
  const refreshTokenService = { issue: vi.fn().mockResolvedValue({ rawToken: 'raw-refresh', family: 'fam-1', expiresAt: 0 }) };

  const controller = new AuthSsoController(
    federatedAuthService as never,
    appSettingsService as never,
    secretsService as never,
    refreshTokenService as never,
  );
  return { controller, federatedAuthService, appSettingsService, secretsService, refreshTokenService };
}

describe('AuthSsoController.start (TASK-498)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards the platform OIDC_CALLBACK_URL as redirectUri to the service', async () => {
    const { controller, federatedAuthService, appSettingsService } = makeController();
    federatedAuthService.buildAuthorizeUrl.mockResolvedValue({ authorizeUrl: 'https://idp/authorize' });

    const res = await controller.start({ tenantKey: 'acme' });

    expect(appSettingsService.getValueWithDefault).toHaveBeenCalledWith('OIDC_CALLBACK_URL', expect.any(String));
    expect(federatedAuthService.buildAuthorizeUrl).toHaveBeenCalledWith(
      expect.objectContaining({ tenantKey: 'acme', redirectUri: expect.any(String) }),
    );
    expect(res.authorizeUrl).toBe('https://idp/authorize');
  });
});

describe('AuthSsoController.callback (TASK-498)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mints a JWT + refresh token identically to local login on a verified callback', async () => {
    const { controller, federatedAuthService, refreshTokenService } = makeController();
    federatedAuthService.verifyOidcCallback.mockResolvedValue({
      id: 'user-1',
      username: 'oidc:provider-1:sub-1',
      email: 'doc@acme.com',
      roles: ['DOCTOR'],
      permissions: ['read:x'],
      tenantId: 'tenant-abc',
    });

    const res = await controller.callback('auth-code', 'signed-state');

    expect(refreshTokenService.issue).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', tenantId: 'tenant-abc' }));
    expect(res.token).toEqual(expect.any(String));
    expect(res.refreshToken).toBe('raw-refresh');
    expect(res.user.id).toBe('user-1');
    expect(res.user.roles).toEqual(['DOCTOR']);
  });

  it('lets an UnauthorizedException from the service propagate verbatim', async () => {
    const { controller, federatedAuthService } = makeController();
    federatedAuthService.verifyOidcCallback.mockRejectedValue(new UnauthorizedException('Invalid or expired SSO state'));

    await expect(controller.callback('auth-code', 'bad-state')).rejects.toThrow('Invalid or expired SSO state');
  });

  it('masks a non-Unauthorized failure behind a generic 401 (no internal-error leakage)', async () => {
    const { controller, federatedAuthService } = makeController();
    federatedAuthService.verifyOidcCallback.mockRejectedValue(new Error('unexpected db error'));

    await expect(controller.callback('auth-code', 'state')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.callback('auth-code', 'state')).rejects.not.toThrow('unexpected db error');
  });
});

describe('AuthSsoController.samlMetadata (TASK-499)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards the platform SAML_ACS_BASE_URL-derived ACS URL for the tenant', async () => {
    const { controller, federatedAuthService, appSettingsService } = makeController();
    federatedAuthService.getSamlServiceProviderMetadata.mockResolvedValue('<EntityDescriptor/>');

    const res = await controller.samlMetadata('acme');

    expect(appSettingsService.getValueWithDefault).toHaveBeenCalledWith('SAML_ACS_BASE_URL', expect.any(String));
    expect(federatedAuthService.getSamlServiceProviderMetadata).toHaveBeenCalledWith('acme', expect.stringContaining('/acme/acs'));
    expect(res).toBe('<EntityDescriptor/>');
  });
});

describe('AuthSsoController.samlStart (TASK-499)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the AuthnRequest redirect URL under the same {authorizeUrl} shape as OIDC start', async () => {
    const { controller, federatedAuthService } = makeController();
    federatedAuthService.buildSamlAuthnRequest.mockResolvedValue({ redirectUrl: 'https://adfs.acme.com/adfs/ls/?SAMLRequest=xyz' });

    const res = await controller.samlStart('acme');

    expect(federatedAuthService.buildSamlAuthnRequest).toHaveBeenCalledWith(
      expect.objectContaining({ tenantKey: 'acme', acsUrl: expect.stringContaining('/acme/acs') }),
    );
    expect(res.authorizeUrl).toBe('https://adfs.acme.com/adfs/ls/?SAMLRequest=xyz');
  });
});

describe('AuthSsoController.samlAcs (TASK-499)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mints a JWT + refresh token identically to local login on a verified ACS POST', async () => {
    const { controller, federatedAuthService, refreshTokenService } = makeController();
    federatedAuthService.verifySamlResponse.mockResolvedValue({
      id: 'user-1',
      username: 'saml:provider-1:nameid-1',
      email: 'doc@acme.com',
      roles: ['DOCTOR'],
      permissions: ['read:x'],
      tenantId: 'tenant-abc',
    });

    const res = await controller.samlAcs('acme', { SAMLResponse: 'base64response' });

    expect(federatedAuthService.verifySamlResponse).toHaveBeenCalledWith(
      expect.objectContaining({ tenantKey: 'acme', samlResponse: 'base64response', acsUrl: expect.stringContaining('/acme/acs') }),
    );
    expect(refreshTokenService.issue).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', tenantId: 'tenant-abc' }));
    expect(res.token).toEqual(expect.any(String));
    expect(res.refreshToken).toBe('raw-refresh');
    expect(res.user.id).toBe('user-1');
  });

  it('lets an UnauthorizedException from the service propagate verbatim', async () => {
    const { controller, federatedAuthService } = makeController();
    federatedAuthService.verifySamlResponse.mockRejectedValue(new UnauthorizedException('SAML response verification failed'));

    await expect(controller.samlAcs('acme', { SAMLResponse: 'tampered' })).rejects.toThrow('SAML response verification failed');
  });

  it('masks a non-Unauthorized failure behind a generic 401 (no internal-error leakage)', async () => {
    const { controller, federatedAuthService } = makeController();
    federatedAuthService.verifySamlResponse.mockRejectedValue(new Error('unexpected db error'));

    await expect(controller.samlAcs('acme', { SAMLResponse: 'x' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.samlAcs('acme', { SAMLResponse: 'x' })).rejects.not.toThrow('unexpected db error');
  });
});
