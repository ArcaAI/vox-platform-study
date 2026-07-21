/**
 * `CreateTenantIdpConfigRequest` protocol-conditional validation.
 *
 * `config`/`clientSecret` are required for OIDC; `samlConfig` is required for
 * SAML (`@ValidateIf`, keyed off `protocol`). The strict global ValidationPipe
 * (whitelist + forbidNonWhitelisted + forbidUnknownValues) means every
 * accepted field must be declared here — this locks the conditional contract
 * so neither branch silently drifts.
 */
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IdpProtocol } from '@arcaai/domains';
import { CreateTenantIdpConfigRequest } from '../create-tenant-idp-config.request';

const validOidcConfig = {
  issuer: 'https://acme.okta.com',
  clientId: 'client-abc',
  defaultRoleId: 'role-1',
  defaultDepartmentId: 'dept-1',
};

const validSamlConfig = {
  idpEntityId: 'https://adfs.acme.com/adfs/services/trust',
  idpSsoUrl: 'https://adfs.acme.com/adfs/ls/',
  idpSigningCert: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
  spEntityId: 'https://api.hope.dev/saml/acme',
  defaultRoleId: 'role-1',
  defaultDepartmentId: 'dept-1',
};

describe('CreateTenantIdpConfigRequest — OIDC branch (TASK-498, unchanged)', () => {
  it('accepts a valid OIDC payload', async () => {
    const dto = plainToInstance(CreateTenantIdpConfigRequest, {
      protocol: IdpProtocol.OIDC,
      displayName: 'Acme Okta',
      config: validOidcConfig,
      clientSecret: 'super-secret',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects an OIDC payload missing config', async () => {
    const dto = plainToInstance(CreateTenantIdpConfigRequest, {
      protocol: IdpProtocol.OIDC,
      displayName: 'Acme Okta',
      clientSecret: 'super-secret',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'config')).toBe(true);
  });

  it('rejects an OIDC payload missing clientSecret', async () => {
    const dto = plainToInstance(CreateTenantIdpConfigRequest, {
      protocol: IdpProtocol.OIDC,
      displayName: 'Acme Okta',
      config: validOidcConfig,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'clientSecret')).toBe(true);
  });

  it('does not require samlConfig for an OIDC payload', async () => {
    const dto = plainToInstance(CreateTenantIdpConfigRequest, {
      protocol: IdpProtocol.OIDC,
      displayName: 'Acme Okta',
      config: validOidcConfig,
      clientSecret: 'super-secret',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'samlConfig')).toBe(false);
  });
});

describe('CreateTenantIdpConfigRequest — SAML branch (TASK-499)', () => {
  it('accepts a valid SAML payload with no clientSecret and no config', async () => {
    const dto = plainToInstance(CreateTenantIdpConfigRequest, {
      protocol: IdpProtocol.SAML,
      displayName: 'Acme AD FS',
      samlConfig: validSamlConfig,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects a SAML payload missing samlConfig', async () => {
    const dto = plainToInstance(CreateTenantIdpConfigRequest, {
      protocol: IdpProtocol.SAML,
      displayName: 'Acme AD FS',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'samlConfig')).toBe(true);
  });

  it('does not require config or clientSecret for a SAML payload', async () => {
    const dto = plainToInstance(CreateTenantIdpConfigRequest, {
      protocol: IdpProtocol.SAML,
      displayName: 'Acme AD FS',
      samlConfig: validSamlConfig,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'config')).toBe(false);
    expect(errors.some((e) => e.property === 'clientSecret')).toBe(false);
  });

  it('rejects a SAML config missing required nested fields (idpSigningCert)', async () => {
    const { idpSigningCert: _omit, ...incomplete } = validSamlConfig;
    const dto = plainToInstance(CreateTenantIdpConfigRequest, {
      protocol: IdpProtocol.SAML,
      displayName: 'Acme AD FS',
      samlConfig: incomplete,
    });
    const errors = await validate(dto);
    const samlConfigError = errors.find((e) => e.property === 'samlConfig');
    expect(samlConfigError?.children?.some((c) => c.property === 'idpSigningCert')).toBe(true);
  });
});

describe('CreateTenantIdpConfigRequest — protocol (TASK-499 widened)', () => {
  it('accepts SAML as a protocol value', async () => {
    const dto = plainToInstance(CreateTenantIdpConfigRequest, {
      protocol: IdpProtocol.SAML,
      displayName: 'Acme AD FS',
      samlConfig: validSamlConfig,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'protocol')).toBe(false);
  });

  it('rejects a protocol outside OIDC/SAML', async () => {
    const dto = plainToInstance(CreateTenantIdpConfigRequest, {
      protocol: 'LDAP',
      displayName: 'Acme LDAP',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'protocol')).toBe(true);
  });
});
