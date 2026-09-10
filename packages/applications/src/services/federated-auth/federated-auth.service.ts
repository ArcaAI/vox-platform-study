import { BadRequestException, ForbiddenException, Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { authorizationCodeGrant, buildAuthorizationUrl, calculatePKCECodeChallenge, randomNonce, randomPKCECodeVerifier } from 'openid-client';
import type { Profile as SamlProfile } from '@node-saml/node-saml';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import {
  CoreDatabaseService,
  FederatedIdentityEntity,
  FederatedIdentityFactory,
  FederatedIdentityRepository,
  ResourceStatusType,
  ResourceType,
  SysEventType,
  TenantEntity,
  TenantIdentityProviderDomainRepository,
  TenantIdentityProviderEntity,
  TenantIdentityProviderRepository,
  TenantRepository,
  IdpProtocol,
  UserDepartmentFactory,
  UserDepartmentRepository,
  UserEntity,
  UserFactory,
  UserRepository,
  UserRoleAssignmentFactory,
  UserRoleAssignmentRepository,
} from '@arcaai/domains';
import { resolveJwtSecret } from '../auth/jwt-secret';
import { IdpResolverService } from '../idp-resolver/idp-resolver.service';
import { IUserRoleAssignmentService } from '../user/userRoleAssignment/IUserRoleAssignmentService';
import { IUserDepartmentService } from '../user/userDepartment/IUserDepartmentService';
import { IUserProfileService } from '../user/userProfile/IUserProfileService';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';

const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';
const STATE_TTL = '5m';
const DEFAULT_SCOPES = ['openid', 'profile', 'email'];
const SAML_ASSERTION_REPLAY_TTL_SECONDS = 300;

interface OidcPersistedConfig {
  issuer: string;
  clientId: string;
  scopes?: string[];
  claimMappings?: { email?: string; groups?: string };
  groupToRoleMap?: Record<string, string>;
  defaultRoleId: string;
  defaultDepartmentId: string;
  jitEnabled?: boolean;
}

/**
 * Field names deliberately mirror `OidcPersistedConfig` — `provisionUser`/
 * `resolveGroupRoleId` read `provider.config` through the OIDC-shaped cast
 * regardless of protocol (`resolveOrProvisionUser` is reused
 * verbatim), so this interface exists for documentation/callers of the SAML
 * methods below, not as a second code path through those two methods.
 */
interface SamlPersistedConfig {
  idpEntityId: string;
  idpSsoUrl: string;
  idpSigningCert: string;
  spEntityId: string;
  spCertificatePem?: string;
}

interface SsoStateClaims {
  tenantId: string;
  providerId: string;
  nonce: string;
  codeVerifier: string;
}

export interface BuildAuthorizeUrlParams {
  tenantKey?: string;
  email?: string;
  redirectUri: string;
}

export interface VerifyOidcCallbackParams {
  code: string;
  state: string;
  redirectUri: string;
}

export interface BuildSamlAuthnRequestParams {
  tenantKey: string;
  acsUrl: string;
}

export interface VerifySamlResponseParams {
  tenantKey: string;
  samlResponse: string;
  acsUrl: string;
}

export interface FederatedSession {
  id: string;
  username: string;
  email: string;
  roles: string[];
  permissions: string[];
  tenantId: string;
}

/**
 * Federated login round-trip orchestrator for both OIDC and
 * SAML: tenant resolution → authorize-URL/AuthnRequest construction →
 * callback/ACS verification → JIT provisioning → a `FederatedSession` the
 * controller mints a HOPE JWT from. Not a `BaseService`: it runs pre-session
 * (no CLS user/tenant exists yet — `BaseService.broadcastSysEvent` forces
 * `tenantId` from CLS, which would be `null` here), so sys-events are
 * emitted directly with the verified `provider.tenantId`.
 * `resolveOrProvisionUser` is protocol-neutral (keyed on `providerId` +
 * `subject`) — SAML's `verifySamlResponse` reuses it verbatim, same as OIDC's
 * `verifyOidcCallback`.
 */
@Injectable()
export class FederatedAuthService {
  constructor(
    private readonly idpResolver: IdpResolverService,
    private readonly providerRepository: TenantIdentityProviderRepository,
    private readonly providerDomainRepository: TenantIdentityProviderDomainRepository,
    private readonly federatedIdentityRepository: FederatedIdentityRepository,
    private readonly userRepository: UserRepository,
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    private readonly userDepartmentRepository: UserDepartmentRepository,
    private readonly tenantRepository: TenantRepository,
    @Inject(IUserRoleAssignmentService) private readonly userRoleAssignmentService: IUserRoleAssignmentService,
    @Inject(IUserDepartmentService) private readonly userDepartmentService: IUserDepartmentService,
    @Inject(IUserProfileService) private readonly userProfileService: IUserProfileService,
    private readonly eventEmitter: EventEmitter2,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    @Inject(SecretsService) private readonly secretsService: SecretsService,
    // Assertion-ID replay cache, defense-in-depth beyond
    // node-saml's own InResponseTo single-use cache. Optional so non-Redis
    // (dev/test) deploys still boot; the replay check is then skipped rather
    // than blocking login (the InResponseTo cache is the primary defense).
    @Optional() @Inject(IRedisCacheService) private readonly redisCache?: IRedisCacheService,
  ) {}

  /** D5 — HRD by verified email domain, falling back to an explicit tenantKey. */
  async buildAuthorizeUrl(params: BuildAuthorizeUrlParams): Promise<{ authorizeUrl: string }> {
    const { providerId } = await this.resolveStartTarget(params);
    const { client, provider } = await this.idpResolver.resolveByProviderId(providerId, params.redirectUri);
    const config = provider.config as unknown as OidcPersistedConfig;

    const jwtSecretKey = await this.resolveJwtSecretKey();
    if (!jwtSecretKey) {
      throw new UnauthorizedException('Authentication system not configured');
    }

    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const nonce = randomNonce();

    const stateClaims: SsoStateClaims = { tenantId: provider.tenantId, providerId: provider.id, nonce, codeVerifier };
    const state = jwt.sign(stateClaims, jwtSecretKey, { expiresIn: STATE_TTL });

    const authorizeUrl = buildAuthorizationUrl(client, {
      scope: (config.scopes ?? DEFAULT_SCOPES).join(' '),
      response_type: 'code',
      redirect_uri: params.redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      nonce,
      state,
    }).href;

    return { authorizeUrl };
  }

  /** Verifies the IdP's callback (PKCE + nonce + signature, via `openid-client`) and resolves/provisions the HOPE user. */
  async verifyOidcCallback(params: VerifyOidcCallbackParams): Promise<FederatedSession> {
    const jwtSecretKey = await this.resolveJwtSecretKey();
    if (!jwtSecretKey) {
      throw new UnauthorizedException('Authentication system not configured');
    }

    let stateClaims: SsoStateClaims;
    try {
      stateClaims = jwt.verify(params.state, jwtSecretKey) as unknown as SsoStateClaims;
    } catch {
      throw new UnauthorizedException('Invalid or expired SSO state');
    }

    const { client, provider } = await this.idpResolver.resolveByProviderId(stateClaims.providerId, params.redirectUri);

    let claims: Record<string, unknown>;
    try {
      const currentUrl = new URL(params.redirectUri);
      currentUrl.searchParams.set('code', params.code);
      currentUrl.searchParams.set('state', params.state);
      const tokenSet = await authorizationCodeGrant(client, currentUrl, {
        pkceCodeVerifier: stateClaims.codeVerifier,
        expectedNonce: stateClaims.nonce,
        expectedState: params.state,
      });
      claims = (tokenSet.claims() ?? {}) as unknown as Record<string, unknown>;
    } catch (error) {
      throw new UnauthorizedException(`OIDC callback verification failed: ${this.errorMessage(error)}`);
    }

    const subject = claims.sub as string | undefined;
    if (!subject) {
      throw new UnauthorizedException('Identity provider did not return a subject claim');
    }

    const user = await this.resolveOrProvisionUser(subject, provider, claims);
    return this.finalizeFederatedSession(user, provider, (claims.email as string | undefined) ?? '');
  }

  /** HRD (email domain → provider) with an explicit tenantKey fallback (D5). */
  private async resolveStartTarget(params: BuildAuthorizeUrlParams): Promise<{ tenantId: string; providerId: string }> {
    if (params.email) {
      const domain = params.email.split('@')[1]?.toLowerCase();
      if (domain) {
        const mapped = await this.providerDomainRepository.findByDomain(domain);
        if (mapped) {
          return { tenantId: mapped.tenantId, providerId: mapped.providerId };
        }
      }
    }

    if (!params.tenantKey) {
      throw new BadRequestException('tenantKey is required when the email domain is not mapped to a provider');
    }
    const tenant = await this.findEnabledTenantByKey(params.tenantKey);
    const provider = await this.providerRepository.findEnabledByTenantAndProtocol(tenant.id, IdpProtocol.OIDC);
    if (!provider) {
      throw new BadRequestException('No enabled identity provider configured for this tenant');
    }
    return { tenantId: tenant.id, providerId: provider.id };
  }

  /** Shared tenant-by-key lookup (D5's `tenantKey`) — used by the OIDC tenantKey fallback and both SAML methods below. */
  private async findEnabledTenantByKey(tenantKey: string): Promise<TenantEntity> {
    const tenant = await this.tenantRepository.findFirst({
      filters: { key: tenantKey, resourceStatus: { equals: ResourceStatusType.ENABLED } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    if (!tenant) {
      throw new BadRequestException('Invalid or disabled tenant');
    }
    return tenant;
  }

  /**
   * SP-initiated SAML: builds a signed AuthnRequest redirect URL
   * for the tenant's enabled SAML provider. No email HRD (SP-initiated SAML
   * is tenantKey-only, per the ticket's flow diagram) — RelayState is opaque
   * (single-use InResponseTo tracking is `RedisSamlCacheProvider`'s job, not
   * RelayState's).
   */
  async buildSamlAuthnRequest(params: BuildSamlAuthnRequestParams): Promise<{ redirectUrl: string }> {
    const tenant = await this.findEnabledTenantByKey(params.tenantKey);
    const { client } = await this.idpResolver.resolveSamlForTenant(tenant.id, params.acsUrl);
    const relayState = randomBytes(16).toString('base64url');
    const redirectUrl = await client.getAuthorizeUrlAsync(relayState, undefined, {});
    return { redirectUrl };
  }

  /**
   * SP metadata XML for the tenant's SAML provider, to register with the IdP
   * out-of-band. Servable regardless of DRAFT/ENABLED status (no secret
   * exposure risk — it's just the SP's public identity) — looked up via
   * `findByTenantId` rather than `findEnabledByTenantAndProtocol` for that
   * reason.
   */
  async getSamlServiceProviderMetadata(tenantKey: string, acsUrl: string): Promise<string> {
    const tenant = await this.findEnabledTenantByKey(tenantKey);
    const providers = await this.providerRepository.findByTenantId(tenant.id);
    const provider = providers.find((p) => p.protocol === IdpProtocol.SAML);
    if (!provider) {
      throw new BadRequestException('No SAML identity provider configured for this tenant');
    }
    const { client } = await this.idpResolver.resolveSamlByProviderId(provider.id, acsUrl);
    const config = provider.config as unknown as SamlPersistedConfig;
    return client.generateServiceProviderMetadata(null, config.spCertificatePem ?? null);
  }

  /**
   * Verifies the IdP's ACS POST (signature/Audience/Destination/InResponseTo/
   * timestamps, via `@node-saml/node-saml`'s `validatePostResponseAsync` —
   * D4) and resolves/provisions the HOPE user. `profile` (a synthesized
   * `{nameID, ...attributes}` bag) plugs directly into the same
   * `resolveOrProvisionUser`/`finalizeFederatedSession` path `verifyOidcCallback`
   * uses.
   */
  async verifySamlResponse(params: VerifySamlResponseParams): Promise<FederatedSession> {
    const tenant = await this.findEnabledTenantByKey(params.tenantKey);
    const provider = await this.providerRepository.findEnabledByTenantAndProtocol(tenant.id, IdpProtocol.SAML);
    if (!provider) {
      throw new UnauthorizedException('No enabled identity provider configured for this tenant');
    }

    const { client } = await this.idpResolver.resolveSamlByProviderId(provider.id, params.acsUrl);

    let profile: SamlProfile;
    try {
      const result = await client.validatePostResponseAsync({ SAMLResponse: params.samlResponse });
      if (!result.profile) {
        throw new Error('SAML response carried no assertion profile');
      }
      profile = result.profile;
    } catch (error) {
      throw new UnauthorizedException(`SAML response verification failed: ${this.errorMessage(error)}`);
    }

    // D4 defense-in-depth: assertion-ID replay cache, on top of node-saml's
    // own single-use InResponseTo cache (RedisSamlCacheProvider).
    if (profile.ID && this.redisCache) {
      const replayKey = `saml-assertion-seen:${profile.ID}`;
      if (await this.redisCache.exists(replayKey)) {
        throw new UnauthorizedException('SAML assertion already used');
      }
      await this.redisCache.set(replayKey, '1', SAML_ASSERTION_REPLAY_TTL_SECONDS);
    }

    const subject = profile.nameID;
    if (!subject) {
      throw new UnauthorizedException('Identity provider did not return a NameID');
    }

    const claims = profile as unknown as Record<string, unknown>;
    const user = await this.resolveOrProvisionUser(subject, provider, claims);
    return this.finalizeFederatedSession(user, provider, profile.email ?? profile.mail ?? '');
  }

  /**
   * Membership re-check (mirrors the local-login invariant, auth.controller.ts)
   * — closes the loop for a previously-JIT'd user whose role/department was
   * since revoked by an admin. Trivially satisfied right after a fresh JIT
   * provision (created in the same transaction). Shared by both
   * `verifyOidcCallback` and `verifySamlResponse` — this is a security
   * invariant, not incidental duplication, so it lives in one place.
   */
  private async finalizeFederatedSession(user: UserEntity, provider: TenantIdentityProviderEntity, email: string): Promise<FederatedSession> {
    const [roleAssignment, departmentAssignment] = await Promise.all([
      this.userRoleAssignmentService.findActiveAssignmentForUserInTenant(user.id, provider.tenantId),
      this.userDepartmentService.findActiveDepartmentForUserInTenant(user.id, provider.tenantId),
    ]);
    if (!roleAssignment || !departmentAssignment) {
      throw new UnauthorizedException('User does not have access to the specified tenant');
    }

    const roles = await this.userRoleAssignmentService.findActiveRolesForUser(user.id);
    const roleNames = roles.map((role) => role.name);
    const permissions = this.flattenPermissions(roles);

    try {
      user.lastLoginAt = new Date();
      user.lastActiveAt = new Date();
      await this.userRepository.update(user.id, user);
    } catch {
      // Non-fatal: proceed with login even if the timestamp stamp fails.
    }

    return {
      id: user.id,
      username: user.username,
      email,
      roles: roleNames,
      permissions,
      tenantId: provider.tenantId,
    };
  }

  /**
   * Idempotent resolve-or-create for a `(providerId, subject)` pair — public
   * so `DirectorySyncProcessor` reuses the exact same JIT logic
   * (transaction, group→role mapping, SUPER_ADMIN guard) for admin-triggered
   * directory pre-provisioning as `verifyOidcCallback` uses for login-time
   * JIT. `claims` is a synthesized `{sub, email, groups}` shape for a
   * directory-pull caller (no real ID token exists at that call site).
   */
  async resolveOrProvisionUser(subject: string, provider: TenantIdentityProviderEntity, claims: Record<string, unknown>): Promise<UserEntity> {
    const existingLink = await this.federatedIdentityRepository.findByProviderAndSubject(provider.id, subject);
    if (existingLink) {
      return this.resolveLinkedUser(existingLink);
    }
    return this.provisionUser(subject, provider, claims);
  }

  private async resolveLinkedUser(link: FederatedIdentityEntity): Promise<UserEntity> {
    const user = await this.userRepository.findById(link.userId);
    if (!user || user.resourceStatus !== ResourceStatusType.ENABLED) {
      throw new UnauthorizedException('Federated identity is linked to a user that is no longer active');
    }
    link.lastLoginAt = new Date();
    await this.federatedIdentityRepository.update(link.id, link);
    return user;
  }

  private async provisionUser(subject: string, provider: TenantIdentityProviderEntity, claims: Record<string, unknown>): Promise<UserEntity> {
    const config = provider.config as unknown as OidcPersistedConfig;
    if (config.jitEnabled === false) {
      throw new ForbiddenException('This identity is not provisioned in HOPE and just-in-time provisioning is disabled for this provider');
    }

    const mappedRoleId = await this.resolveGroupRoleId(claims, config);
    const roleId = mappedRoleId ?? config.defaultRoleId;

    // SUPER_ADMIN is never assignable via IdP mapping. This runs
    // pre-session (no CLS requestUser), so the CLS-gated
    // `UserRoleAssignmentService.assertAssignableRoleTier` guard would NOT
    // fire here — this explicit check is the enforcement point.
    const role = await this.databaseService.baseClient.role.findUnique({ where: { id: roleId }, select: { name: true } });
    if (role?.name === SUPER_ADMIN_ROLE) {
      throw new ForbiddenException('SUPER_ADMIN cannot be assigned via identity-provider federation');
    }

    // Namespaced, provider-scoped username: `User.username`/`externalId` are
    // PLATFORM-GLOBAL unique columns, but a subject (OIDC `sub` / SAML
    // `NameID`) is only unique WITHIN one provider — two tenants' IdPs could
    // coincidentally issue the same subject. `externalId` is deliberately
    // left unset (D2 — new links go through `FederatedIdentity`, not the
    // deprecated global-stub column). Prefix is the protocol itself so
    // `oidc:`/`saml:` never collide even if a `providerId` were ever reused
    // across protocols.
    const username = `${provider.protocol.toLowerCase()}:${provider.id}:${subject}`;
    const email = claims[config.claimMappings?.email ?? 'email'] as string | undefined;

    const { user, roleAssignment, departmentAssignment, federatedIdentity } = await this.databaseService.baseClient.$transaction(async (tx) => {
      const newUser = UserFactory.CreateUser({ username, password: '', isServiceAccount: false });
      const createdUser = await this.userRepository.create(newUser, tx);

      const roleEntity = UserRoleAssignmentFactory.CreateUserRoleAssignment({
        userId: createdUser.id,
        roleId,
        tenantId: provider.tenantId,
      });
      const createdRoleAssignment = await this.userRoleAssignmentRepository.create(roleEntity, tx);

      const departmentEntity = UserDepartmentFactory.CreateUserDepartment({
        tenantId: provider.tenantId,
        userId: createdUser.id,
        departmentId: config.defaultDepartmentId,
        isPrimary: true,
      });
      const createdDepartmentAssignment = await this.userDepartmentRepository.create(departmentEntity, tx);

      const linkEntity = FederatedIdentityFactory.CreateFederatedIdentity({
        tenantId: provider.tenantId,
        userId: createdUser.id,
        providerId: provider.id,
        subject,
        lastLoginAt: new Date(),
      });
      const createdLink = await this.federatedIdentityRepository.create(linkEntity, tx);

      return {
        user: createdUser,
        roleAssignment: createdRoleAssignment,
        departmentAssignment: createdDepartmentAssignment,
        federatedIdentity: createdLink,
      };
    });

    if (email) {
      await this.userProfileService.upsertByUserId(user.id, { email } as never);
    }

    // Emitted directly (not `BaseService.broadcastSysEvent`) — this runs
    // pre-session, so CLS has no tenant to force onto the event; the verified
    // `provider.tenantId` is the correct, non-spoofable attribution here.
    this.emitSysEvent(SysEventType.ResourceCreated, provider.tenantId, ResourceType.User, user.id, user.createdAt);
    this.emitSysEvent(SysEventType.ResourceCreated, provider.tenantId, ResourceType.UserRoleAssignment, roleAssignment.id, roleAssignment.createdAt);
    this.emitSysEvent(
      SysEventType.ResourceCreated,
      provider.tenantId,
      ResourceType.UserDepartment,
      departmentAssignment.id,
      departmentAssignment.createdAt,
    );
    this.emitSysEvent(
      SysEventType.ResourceCreated,
      provider.tenantId,
      ResourceType.FederatedIdentity,
      federatedIdentity.id,
      federatedIdentity.createdAt,
    );

    return user;
  }

  /** D3(a)/ — IdP group claim → `Role.externalName`, scoped to the configuring tenant. No match → null (caller falls back to defaultRoleId). */
  private async resolveGroupRoleId(claims: Record<string, unknown>, config: OidcPersistedConfig): Promise<string | null> {
    if (!config.groupToRoleMap) {
      return null;
    }
    const groupsClaimKey = config.claimMappings?.groups ?? 'groups';
    const groupsValue = claims[groupsClaimKey];
    const groups = Array.isArray(groupsValue) ? groupsValue.map(String) : [];

    for (const group of groups) {
      const externalName = config.groupToRoleMap[group];
      if (!externalName) continue;
      const role = await this.databaseService.baseClient.role.findFirst({
        where: { externalName, resourceStatus: ResourceStatusType.ENABLED },
        select: { id: true },
      });
      if (role) return role.id;
    }
    return null;
  }

  private flattenPermissions(roles: Array<{ permissions?: string[] }>): string[] {
    const permissions = new Set<string>();
    for (const role of roles) {
      if (role.permissions && Array.isArray(role.permissions)) {
        role.permissions.forEach((permission) => permissions.add(permission));
      }
    }
    return Array.from(permissions);
  }

  private emitSysEvent(type: SysEventType, tenantId: string, resourceType: ResourceType, resourceId: string, createdAt: Date): void {
    this.eventEmitter.emit(type, { tenantId, resourceType, resourceId, createdAt });
  }

  /**
   * TASK-944 — delegates to the ONE shared resolver, which `JwtStrategy` also verifies
   * with. This method used to open-code the two-step read and claim in a comment that
   * it "must never diverge" from the verify path; the verify path had in fact captured
   * its secret once at construction, and the claim held only because nobody rotated.
   */
  private async resolveJwtSecretKey(): Promise<string | undefined> {
    return resolveJwtSecret(this.secretsService);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
