import { BadRequestException, Injectable, Inject, Optional } from '@nestjs/common';
import { Client, Issuer } from 'openid-client';
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { IdpProtocol, TenantIdentityProviderEntity, TenantIdentityProviderRepository } from '@arcaai/domains';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';
import { RedisSamlCacheProvider } from './saml-redis-cache-provider';

interface CachedClient {
  client: Client;
  cachedAt: number;
}

interface OidcPersistedConfig {
  issuer: string;
  clientId: string;
}

interface CachedSamlClient {
  client: SAML;
  cachedAt: number;
}

interface SamlPersistedConfig {
  idpEntityId: string;
  idpSsoUrl: string;
  idpSigningCert: string;
  spEntityId: string;
  nameIdFormat?: string;
  /** SP signs its own outgoing AuthnRequests. @default true */
  signAuthnRequests?: boolean;
}

const SAML_REQUEST_CACHE_PREFIX = 'saml-authn-request:';
const SAML_REQUEST_TTL_SECONDS = 300;
const SAML_SIGNATURE_ALGORITHM = 'sha256';
const SAML_CLOCK_SKEW_MS = 60_000;

/**
 * TASK-498 D4 — per-tenant OIDC client resolver. Resolution is a tenant-scoped
 * repository read + a per-provider client cache — deliberately NOT
 * `AppSettingsService` (its cache is key-only and platform-tenant-wins,
 * `appSettings.service.ts:246-251` — the exact failure mode of the old global
 * OIDC stub this ticket replaces).
 */
@Injectable()
export class IdpResolverService {
  private readonly cache = new Map<string, CachedClient>();
  private readonly samlCache = new Map<string, CachedSamlClient>();

  constructor(
    private readonly providerRepository: TenantIdentityProviderRepository,
    // Optional so non-Vault deploys still boot; federation then fails closed
    // with an actionable error rather than ever falling back to plaintext.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Optional so non-Redis (dev/test) deploys still boot; the SAML request
    // cache then falls back to node-saml's own per-pod in-memory provider
    // (TASK-499 D4 — fine for single-instance dev, NOT for a multi-replica
    // deployment, matching the same tradeoff `resolveByProviderId` documents
    // for the OIDC path).
    @Optional() @Inject(IRedisCacheService) private readonly redisCache?: IRedisCacheService,
  ) {}

  /**
   * Pure builder — no cache, no persisted-config lookup. Used internally by
   * `resolveForTenant` and directly by `TenantIdpConfigService.testConnection`
   * (which must probe a candidate secret BEFORE it's sealed/persisted).
   */
  async buildClient(issuerUrl: string, clientId: string, clientSecret: string, redirectUri: string): Promise<Client> {
    const issuer = await Issuer.discover(issuerUrl);
    return new issuer.Client({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: [redirectUri],
      response_types: ['code'],
    });
  }

  /**
   * The tenant's ENABLED provider for a protocol + its cached (or freshly
   * built) OIDC client. Used by `/auth/sso/start`. When a tenant has more than
   * one ENABLED provider for the same protocol, this resolves an arbitrary one
   * — `/auth/sso/start` should prefer HRD (domain lookup → specific
   * `providerId`) whenever the caller supplies an email; explicit
   * provider-selection UI is a later ticket.
   */
  async resolveForTenant(
    tenantId: string,
    protocol: IdpProtocol,
    redirectUri: string,
  ): Promise<{ client: Client; provider: TenantIdentityProviderEntity }> {
    const provider = await this.providerRepository.findEnabledByTenantAndProtocol(tenantId, protocol);
    if (!provider) {
      throw new BadRequestException('No enabled identity provider configured for this tenant');
    }
    return this.resolveEntity(provider, redirectUri);
  }

  /**
   * Resolve by provider id directly — used by `/auth/sso/callback`, which
   * carries the `providerId` captured at `/start` time in its signed state.
   * MUST NOT assume the resolver's in-memory cache is warm: `start` and
   * `callback` can land on different pods in a multi-replica deployment, so
   * this independently re-derives the client from the repository when uncached.
   */
  async resolveByProviderId(providerId: string, redirectUri: string): Promise<{ client: Client; provider: TenantIdentityProviderEntity }> {
    const provider = await this.providerRepository.findById(providerId);
    if (!provider) {
      throw new BadRequestException('Identity provider not found');
    }
    return this.resolveEntity(provider, redirectUri);
  }

  private async resolveEntity(
    provider: TenantIdentityProviderEntity,
    redirectUri?: string,
  ): Promise<{ client: Client; provider: TenantIdentityProviderEntity }> {
    const cached = this.cache.get(provider.id);
    if (cached) {
      return { client: cached.client, provider };
    }

    if (!this.secretsService) {
      throw new BadRequestException('Identity provider federation requires the Vault secrets provider (SECRETS_PROVIDER=vault).');
    }
    if (!provider.encryptedSecretRef) {
      throw new BadRequestException('Identity provider has no sealed client secret configured');
    }

    const clientSecret = (await this.secretsService.decrypt(provider.encryptedSecretRef)).toString('utf8');
    const config = provider.config as unknown as OidcPersistedConfig;
    const client = await this.buildClient(config.issuer, config.clientId, clientSecret, redirectUri ?? '');
    this.cache.set(provider.id, { client, cachedAt: Date.now() });
    return { client, provider };
  }

  /**
   * Pure builder — no cache, no persisted-config lookup. `wantAssertionsSigned`
   * / `validateInResponseTo` / `signatureAlgorithm` / `acceptedClockSkewMs`
   * are hardcoded, NON-NEGOTIABLE per TASK-499 D4/§6 — not a tenant-admin
   * knob, so a misconfigured/compromised config row can never weaken
   * assertion validation. `wantAuthnResponseSigned: false` is deliberate:
   * requiring the outer `<Response>` element itself be signed (in addition
   * to the assertion) would reject the common "assertion-signed-only"
   * default most real IdPs (Okta, Azure AD, OneLogin) ship with — D4 only
   * requires the assertion be signed.
   */
  async buildSamlClient(config: SamlPersistedConfig, acsUrl: string, spPrivateKeyPem?: string): Promise<SAML> {
    const cacheProvider = this.redisCache
      ? new RedisSamlCacheProvider(this.redisCache, SAML_REQUEST_CACHE_PREFIX, SAML_REQUEST_TTL_SECONDS)
      : undefined;

    return new SAML({
      callbackUrl: acsUrl,
      issuer: config.spEntityId,
      idpCert: config.idpSigningCert,
      entryPoint: config.idpSsoUrl,
      identifierFormat: config.nameIdFormat,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      signatureAlgorithm: SAML_SIGNATURE_ALGORITHM,
      acceptedClockSkewMs: SAML_CLOCK_SKEW_MS,
      validateInResponseTo: ValidateInResponseTo.always,
      privateKey: config.signAuthnRequests !== false ? spPrivateKeyPem : undefined,
      ...(cacheProvider ? { cacheProvider } : {}),
    });
  }

  /** The tenant's ENABLED SAML provider + its cached (or freshly built) client. Used by the SAML `start`/metadata routes. */
  async resolveSamlForTenant(tenantId: string, acsUrl: string): Promise<{ client: SAML; provider: TenantIdentityProviderEntity }> {
    const provider = await this.providerRepository.findEnabledByTenantAndProtocol(tenantId, IdpProtocol.SAML);
    if (!provider) {
      throw new BadRequestException('No enabled identity provider configured for this tenant');
    }
    return this.resolveSamlEntity(provider, acsUrl);
  }

  /** Resolve by provider id directly — used by the SAML ACS route. Same cold-cache independence as `resolveByProviderId`. */
  async resolveSamlByProviderId(providerId: string, acsUrl: string): Promise<{ client: SAML; provider: TenantIdentityProviderEntity }> {
    const provider = await this.providerRepository.findById(providerId);
    if (!provider) {
      throw new BadRequestException('Identity provider not found');
    }
    return this.resolveSamlEntity(provider, acsUrl);
  }

  private async resolveSamlEntity(
    provider: TenantIdentityProviderEntity,
    acsUrl: string,
  ): Promise<{ client: SAML; provider: TenantIdentityProviderEntity }> {
    const cached = this.samlCache.get(provider.id);
    if (cached) {
      return { client: cached.client, provider };
    }

    const config = provider.config as unknown as SamlPersistedConfig;

    let spPrivateKeyPem: string | undefined;
    if (config.signAuthnRequests !== false) {
      if (!this.secretsService) {
        throw new BadRequestException('Identity provider federation requires the Vault secrets provider (SECRETS_PROVIDER=vault).');
      }
      if (!provider.encryptedSecretRef) {
        throw new BadRequestException('Identity provider has no sealed SP private key configured');
      }
      spPrivateKeyPem = (await this.secretsService.decrypt(provider.encryptedSecretRef)).toString('utf8');
    }

    const client = await this.buildSamlClient(config, acsUrl, spPrivateKeyPem);
    this.samlCache.set(provider.id, { client, cachedAt: Date.now() });
    return { client, provider };
  }

  /** Evict a provider's cached client — call after a config update or secret rotation. */
  invalidate(providerId: string): void {
    this.cache.delete(providerId);
    this.samlCache.delete(providerId);
  }
}
