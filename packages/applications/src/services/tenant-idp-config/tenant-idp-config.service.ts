import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  IdpProtocol,
  IdpStatus,
  ResourceType,
  SysEventType,
  TenantIdentityProviderEntity,
  TenantIdentityProviderFactory,
  TenantIdentityProviderRepository,
} from '@arcaai/domains';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IdpResolverService } from '../idp-resolver/idp-resolver.service';
import { ITenantIdpConfigService } from './ITenantIdpConfigService';
import { TenantIdpConfigDtoMapper } from './tenant-idp-config.dto.mapper';
import { generateSamlSpKeyPair } from './saml-sp-key.util';
import {
  CreateTenantIdpConfigRequest,
  SetDirectoryCredentialsRequest,
  TenantIdpConfigResponse,
  TestConnectionResponse,
  UpdateTenantIdpConfigRequest,
} from './dto';

/**
 * `openid-client`'s `Issuer.discover` + `new issuer.Client(...)` never
 * validate `redirect_uris` over the network (only the real `/authorize`
 * round-trip does) — a stable placeholder is enough for a config-time probe.
 */
const TEST_CONNECTION_REDIRECT_URI = 'https://hope.internal/auth/sso/test-connection-probe';

/** SAML has no discovery endpoint (unlike OIDC) — a placeholder ACS URL is enough for the config-consistency smoke test below. */
const TEST_CONNECTION_ACS_URL = 'https://hope.internal/auth/sso/saml/test-connection-probe/acs';

interface SamlPersistedConfig {
  idpEntityId: string;
  idpSsoUrl: string;
  idpSigningCert: string;
  spEntityId: string;
  nameIdFormat?: string;
  signAuthnRequests?: boolean;
  spCertificatePem?: string;
}

@Injectable()
export class TenantIdpConfigService extends BaseService implements ITenantIdpConfigService {
  constructor(
    private readonly providerRepository: TenantIdentityProviderRepository,
    private readonly idpResolver: IdpResolverService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Vault-seal the OIDC client secret (D4). Optional so non-Vault deploys
    // still boot; secret writes then reject (no plaintext-at-rest fallback).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantIdentityProvider);
  }

  async list(tenantId: string): Promise<TenantIdpConfigResponse[]> {
    const rows = await this.providerRepository.findByTenantId(tenantId);
    return rows.map(TenantIdpConfigDtoMapper.toResponse);
  }

  async getById(tenantId: string, id: string): Promise<TenantIdpConfigResponse> {
    const row = await this.findOwnedRow(tenantId, id);
    return TenantIdpConfigDtoMapper.toResponse(row);
  }

  async create(tenantId: string, dto: CreateTenantIdpConfigRequest): Promise<TenantIdpConfigResponse> {
    if (!this.secretsService) {
      throw new BadRequestException('Identity provider federation requires the Vault secrets provider (SECRETS_PROVIDER=vault).');
    }

    let config: Record<string, unknown>;
    let sealedSecretRef: string;

    if (dto.protocol === IdpProtocol.SAML) {
      if (!dto.samlConfig) {
        throw new BadRequestException('samlConfig is required for a SAML provider');
      }
      // D5 — the SP key pair is generated server-side, never admin-supplied.
      // Sealed unconditionally (even when signAuthnRequests is false): the SP
      // certificate is the provider's identity for its SP metadata regardless
      // of whether it currently signs outgoing AuthnRequests.
      const spKeyPair = await generateSamlSpKeyPair({ commonName: `${dto.displayName} SAML SP` });
      sealedSecretRef = await this.secretsService.encrypt(Buffer.from(spKeyPair.privateKeyPem, 'utf8'));
      config = { ...dto.samlConfig, spCertificatePem: spKeyPair.certificatePem } as unknown as Record<string, unknown>;
    } else {
      if (!dto.config || !dto.clientSecret) {
        throw new BadRequestException('config and clientSecret are required for an OIDC provider');
      }
      sealedSecretRef = await this.secretsService.encrypt(Buffer.from(dto.clientSecret, 'utf8'));
      config = dto.config as unknown as Record<string, unknown>;
    }

    const entity = TenantIdentityProviderFactory.CreateTenantIdentityProvider({
      tenantId,
      protocol: dto.protocol,
      displayName: dto.displayName,
      config,
      encryptedSecretRef: sealedSecretRef,
      createdBy: this.requestUserId ?? undefined,
    });
    const saved = await this.providerRepository.create(entity);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
    });
    return TenantIdpConfigDtoMapper.toResponse(saved);
  }

  async update(tenantId: string, id: string, dto: UpdateTenantIdpConfigRequest): Promise<TenantIdpConfigResponse> {
    const row = await this.findOwnedRow(tenantId, id);

    const changes: Record<string, unknown> = {};
    if (dto.displayName !== undefined) changes.displayName = dto.displayName;
    if (dto.config !== undefined) changes.config = dto.config;
    if (dto.samlConfig !== undefined) {
      // Preserve the server-generated SP cert across a config replacement —
      // it isn't (and shouldn't be) part of the admin-supplied `samlConfig`.
      const existingConfig = row.config as unknown as SamlPersistedConfig;
      changes.config = { ...dto.samlConfig, spCertificatePem: existingConfig.spCertificatePem };
    }
    if (dto.clientSecret !== undefined) {
      if (!this.secretsService) {
        throw new BadRequestException('Identity provider federation requires the Vault secrets provider (SECRETS_PROVIDER=vault).');
      }
      changes.encryptedSecretRef = await this.secretsService.encrypt(Buffer.from(dto.clientSecret, 'utf8'));
    }

    await this.updateEntity(row, changes);
    const previousVersion = row.version;
    const updated = await this.providerRepository.updateWithVersion(row.id, row, dto.expectedVersion);

    // Config/secret may have changed — evict the cached client so the next
    // login/test-connection resolves fresh (D4).
    this.idpResolver.invalidate(row.id);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { previousVersion, newVersion: updated.version },
    });
    return TenantIdpConfigDtoMapper.toResponse(updated);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const row = await this.findOwnedRow(tenantId, id);
    await this.providerRepository.softDelete(row.id);
    this.idpResolver.invalidate(row.id);
    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: row.id,
    });
  }

  async testConnection(tenantId: string, id: string): Promise<TestConnectionResponse> {
    const row = await this.findOwnedRow(tenantId, id);

    if (row.protocol === IdpProtocol.SAML) {
      return this.testSamlConnection(row);
    }

    if (!this.secretsService || !row.encryptedSecretRef) {
      return { ok: false, providerStatus: row.providerStatus, error: 'No sealed client secret configured' };
    }

    let clientSecret: string;
    try {
      clientSecret = (await this.secretsService.decrypt(row.encryptedSecretRef)).toString('utf8');
    } catch (error) {
      return { ok: false, providerStatus: row.providerStatus, error: this.errorMessage(error) };
    }

    const config = row.config as unknown as { issuer: string; clientId: string };
    try {
      await this.idpResolver.buildClient(config.issuer, config.clientId, clientSecret, TEST_CONNECTION_REDIRECT_URI);
    } catch (error) {
      return { ok: false, providerStatus: row.providerStatus, error: this.errorMessage(error) };
    }

    // D7 — DRAFT flips to ENABLED only after a successful probe (prevents
    // self-lockout from a bad config). Idempotent when already ENABLED.
    row.providerStatus = IdpStatus.ENABLED;
    const updated = await this.providerRepository.update(row.id, row);
    this.idpResolver.invalidate(row.id);

    return { ok: true, providerStatus: updated.providerStatus };
  }

  /**
   * SAML has no discovery endpoint (unlike OIDC's `Issuer.discover`) — the
   * IdP is only reachable via a real browser redirect, so there's no live
   * network probe possible here. This is a config-CONSISTENCY smoke test:
   * builds a real `SAML` client from the pinned IdP cert + sealed SP key, and
   * generates SP metadata (forces node-saml to parse/serialize the cert and
   * build a well-formed `EntityDescriptor`) — catches a malformed cert or
   * missing required field before the tenant registers this with their IdP.
   */
  private async testSamlConnection(row: TenantIdentityProviderEntity): Promise<TestConnectionResponse> {
    const config = row.config as unknown as SamlPersistedConfig;

    let spPrivateKeyPem: string | undefined;
    if (config.signAuthnRequests !== false) {
      if (!this.secretsService || !row.encryptedSecretRef) {
        return { ok: false, providerStatus: row.providerStatus, error: 'No sealed SP private key configured' };
      }
      try {
        spPrivateKeyPem = (await this.secretsService.decrypt(row.encryptedSecretRef)).toString('utf8');
      } catch (error) {
        return { ok: false, providerStatus: row.providerStatus, error: this.errorMessage(error) };
      }
    }

    try {
      const client = await this.idpResolver.buildSamlClient(config, TEST_CONNECTION_ACS_URL, spPrivateKeyPem);
      client.generateServiceProviderMetadata(null, config.spCertificatePem ?? null);
    } catch (error) {
      return { ok: false, providerStatus: row.providerStatus, error: this.errorMessage(error) };
    }

    row.providerStatus = IdpStatus.ENABLED;
    const updated = await this.providerRepository.update(row.id, row);
    this.idpResolver.invalidate(row.id);

    return { ok: true, providerStatus: updated.providerStatus };
  }

  async setDirectoryCredentials(tenantId: string, id: string, dto: SetDirectoryCredentialsRequest): Promise<TenantIdpConfigResponse> {
    const row = await this.findOwnedRow(tenantId, id);

    if (!this.secretsService) {
      throw new BadRequestException('Identity provider federation requires the Vault secrets provider (SECRETS_PROVIDER=vault).');
    }

    row.directoryCredentialsRef = await this.secretsService.encrypt(Buffer.from(JSON.stringify(dto.credentials), 'utf8'));
    const updated = await this.providerRepository.update(row.id, row);

    // A stale cached client keeps the OLD credentials — evict so the next
    // sync/login resolves fresh.
    this.idpResolver.invalidate(row.id);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { action: 'directory-credentials-set' },
    });
    return TenantIdpConfigDtoMapper.toResponse(updated);
  }

  /** 404-over-403: a row that exists but belongs to another tenant reads as "not yours". */
  private async findOwnedRow(tenantId: string, id: string) {
    const row = await this.providerRepository.findById(id);
    if (!row || row.tenantId !== tenantId) {
      throw new NotFoundException('Identity provider not found');
    }
    return row;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
