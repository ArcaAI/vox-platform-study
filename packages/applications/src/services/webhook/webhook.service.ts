import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import {
  ResourceType,
  SysEventType,
  EntityId,
  WebhookEntity,
  WebhookFactory,
  WebhookRepository,
  WebhookRunHistoryEntity,
  WebhookRunHistoryRepository,
} from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException } from '@arcaai/exceptions';
import { IWebhookService, CreateWebhookResult } from './IWebhookService';
import { CreateWebhookRequest, UpdateWebhookRequest } from './dto';
import { assertEqualTenants, BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { DEFAULT_GENERATED_SECRET_POLICY, GeneratedSecretPolicy, generateSecretString, resolveGeneratedSecretPolicy } from '../security/secretPolicy';
import { SUPER_ADMIN_ROLE } from '../tenant/constants';

/** Vault kv-v2 secret name for the DEDICATED webhook-secret encryption pepper ( platform-secrets.descriptors.ts `webhook.secretPepper`). */
const WEBHOOK_SECRET_PEPPER_NAME = 'WEBHOOK_SECRET_PEPPER';

/**
 * Storage-format marker for `Webhook.hashedSecret`. See the class doc below
 * for why this column holds REVERSIBLE encryption, not a one-way hash,
 * despite the name.
 */
const SECRET_STORAGE_MARKER = 'whsec1';

/**
 * Model-aware filter coercion:
 * `version` → number, `createdAt` → Date, `resourceStatus` → member-validated
 * enum, `metaData`/`subscriptionMetadata` → JSON-path support.
 */
const WEBHOOK_FILTER_MODEL = 'Webhook';

/**
 * `WebhookService` — CRUD + secret lifecycle for `Webhook` subscriptions.
 *
 * ## Why `hashedSecret` holds REVERSIBLE encryption, not a one-way hash
 *
 * The obvious pattern to copy here is `ApiKeyService.hashKeyForStorage`
 * (SHA-256, optionally HMAC-peppered) — that is exactly right for an API key,
 * because verifying an API key is "the caller re-presents the raw key on
 * every request; hash it and compare to the stored hash." A one-way digest is
 * the correct primitive for that.
 *
 * Webhook signing is a DIFFERENT operation: the PLATFORM computes an
 * HMAC-SHA256 over each outbound payload using the shared secret as the MAC
 * key, and the RECEIVER (who only ever saw the raw secret once, at creation)
 * verifies by computing the same HMAC independently. For the platform's
 * signature to be verifiable, the delivery processor must be able to recover
 * the ORIGINAL raw secret at send time — a one-way hash cannot do that by
 * definition. Storing a peppered hash here (as an early reading of this
 * ticket's research assumed) would produce a signature the receiver could
 * never reproduce, since the receiver has no way to learn the platform's
 * pepper.
 *
 * The resolution: `hashedSecret` stores AES-256-GCM CIPHERTEXT of the raw
 * secret (reversible), keyed by material derived from the dedicated
 * `WEBHOOK_SECRET_PEPPER` ( `platform-secrets.descriptors.ts`). This is the
 * same "peppered, Vault-backed, per-tenant secret never stored in plaintext"
 * shape rule `09-infrastructure-devops.md`'s `db-secret` tier describes for
 * `TenantBucket.credentialsRef` — encrypted-at-rest, decryptable only with
 * platform-held key material — just implemented as a self-contained
 * AES-256-GCM primitive here rather than a full Vault-Transit round-trip
 * (`SecretsService.encrypt`/`decrypt`), which is a reasonable stronger
 * follow-up if per-row Transit key versioning is wanted later. The column
 * name is NOT renamed (a live-column rename is a migration outside this
 * ticket's scope, same posture as the deliberately-preserved
 * `responeStatusCode` typo) — it stores what its name always half-promised:
 * a protected form of the secret, just a reversible one.
 */
@Injectable()
export class WebhookService extends BaseService implements IWebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly webhookRepository: WebhookRepository,
    // Delivery-log reads for the admin surface.
    private readonly webhookRunHistoryRepository: WebhookRunHistoryRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // WEBHOOK_SECRET_PEPPER arrives via SecretsService. Optional so legacy
    // test fixtures that construct WebhookService directly still work (they
    // get the local, un-peppered fallback key derivation — see
    // `deriveEncryptionKey` — same fallback shape as ApiKeyService's
    // `secretsService` dependency).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // The platform `security.secret.*` policy behind an issued signing secret.
    // Optional (append-only DI) so fixtures that construct this service
    // directly keep the pre-policy 32-byte hex behaviour exactly as it was.
    @Optional() @Inject(IAppSettingsService) private readonly appSettings?: IAppSettingsService,
  ) {
    super(eventEmitter, clsService, ResourceType.Webhook);
  }

  /**
   * The SUPER_ADMIN-managed `security.secret.*` policy, or the platform
   * defaults when no settings cache is wired (legacy fixtures) — identical to
   * the pre-policy behaviour, 32 bytes as 64 hex characters.
   */
  private secretPolicy(): GeneratedSecretPolicy {
    return this.appSettings ? resolveGeneratedSecretPolicy(this.appSettings) : DEFAULT_GENERATED_SECRET_POLICY;
  }

  /**
   * Generate a cryptographically secure raw webhook signing secret, drawn to
   * the CONFIGURED policy — the same `security.secret.*` policy behind
   * service-account client secrets and API keys.
   *
   * Unlike the API key, this one honours `encoding` as well as `byteLength`:
   * the secret is only ever used as an HMAC key (and stored reversibly, so a
   * subscriber can be shown it again), so no format regex constrains its
   * alphabet.
   *
   * Policy applies at ISSUANCE — `create` and `rotateSecret` — never
   * retroactively: a live webhook's subscriber is verifying signatures with
   * the secret it already holds, and rewriting that on a policy change would
   * break every in-flight integration. Tightening the policy is a prompt to
   * rotate.
   */
  generateRawSecret(): string {
    return generateSecretString(this.secretPolicy());
  }

  /**
   * @deprecated Policy-blind fallback kept for callers that have no service
   * instance. Prefer the instance method, which honours `security.secret.*`.
   */
  static generateRawSecretWithDefaults(): string {
    return generateSecretString(DEFAULT_GENERATED_SECRET_POLICY);
  }

  /**
   * Derive the AES-256-GCM key from the resolved pepper. When no pepper is
   * configured (no SecretsService wired, or the Vault key is unset), falls
   * back to a fixed string — matching `ApiKeyService`'s own
   * un-peppered-hash fallback posture: fine for legacy test fixtures and
   * env-provider dev boxes, NOT a production posture.
   */
  private static deriveEncryptionKey(pepper?: string): Buffer {
    return createHash('sha256')
      .update(pepper ?? 'hope-webhook-local-fallback-key')
      .digest();
  }

  /**
   * Encrypt a raw webhook secret for storage. REVERSIBLE (AES-256-GCM) — see
   * the class doc for why this must not be a one-way hash. Pure function:
   * takes the pepper as an explicit parameter, mirroring
   * `ApiKeyService.hashKey`'s shape.
   */
  static encryptSecret(rawSecret: string, pepper?: string): string {
    const key = WebhookService.deriveEncryptionKey(pepper);
    const iv = randomBytes(12); // 96-bit IV, the AES-GCM recommendation.
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(rawSecret, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [SECRET_STORAGE_MARKER, iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
  }

  /**
   * Recover the raw webhook secret from its stored form — the ONLY consumer
   * is the delivery processor's signing step (`webhook-delivery.processor.ts`).
   * The pepper passed here MUST be the same one resolved at encryption time
   * (same Vault key, `WEBHOOK_SECRET_PEPPER`) or decryption fails loudly
   * (GCM auth-tag mismatch) rather than silently producing garbage.
   */
  static decryptSecret(stored: string, pepper?: string): string {
    const parts = stored.split(':');
    const [marker, ivHex, authTagHex, ciphertextHex] = parts;
    if (marker !== SECRET_STORAGE_MARKER || parts.length !== 4) {
      throw new Error('Unrecognized webhook secret storage format');
    }
    const key = WebhookService.deriveEncryptionKey(pepper);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
    return plaintext.toString('utf8');
  }

  /**
   * Instance-method wrapper around `encryptSecret`. Resolves
   * `WEBHOOK_SECRET_PEPPER` from SecretsService — a DEDICATED pepper, never
   * `API_KEY_PEPPER` (see `platform-secrets.descriptors.ts` `webhook.secretPepper`
   * for the coupling-of-rotation-lifecycles rationale).
   */
  private async encryptSecretForStorage(rawSecret: string): Promise<string> {
    const pepper = (await this.secretsService?.getSecretOptional(WEBHOOK_SECRET_PEPPER_NAME)) ?? undefined;
    return WebhookService.encryptSecret(rawSecret, pepper);
  }

  /**
   * A non-SUPER_ADMIN
   * caller can no longer attribute a webhook to another tenant via the
   * DTO. Effective tenant is resolved through `resolveEffectiveTenantId`,
   * which silently pins to CLS for regular users and honors
   * `request.tenantId` only for SUPER_ADMIN (cross-tenant impersonation
   * flows, e.g. admin UI / migration tooling).
   *
   * The signing secret is ALWAYS server-generated here — `CreateWebhookRequest`
   * carries no `hashedSecret` field, so a caller can never pin a weak/known
   * value or bypass peppered hashing. The raw secret is returned exactly
   * once, in `CreateWebhookResult.rawSecret`; only its peppered hash is
   * persisted (`WebhookEntity.hashedSecret`), and no read surface re-exposes
   * either value (see `WebhookResponse.hasSecret`).
   */
  async create(request: CreateWebhookRequest): Promise<CreateWebhookResult> {
    const effectiveTenantId = this.resolveEffectiveTenantId(request.tenantId);
    const rawSecret = this.generateRawSecret();
    const hashedSecret = await this.encryptSecretForStorage(rawSecret);
    const newWebhook = WebhookFactory.CreateWebhook({
      ...request,
      hashedSecret,
      tenantId: effectiveTenantId,
      createdBy: this.requestUser?.id,
    });

    const webhook = await this.webhookRepository.create(newWebhook);

    if (!webhook) {
      throw new InternalServerErrorException(`Failed to create WebhookEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: webhook.id,
      createdAt: webhook.createdAt,
      data: webhook.toObject() as object,
    });
    return { webhook, rawSecret };
  }

  /**
   * List endpoint scoped to the
   * caller's tenant. Non-SUPER_ADMIN callers see only their own tenant's
   * webhooks; SUPER_ADMIN bypasses the filter so cross-tenant
   * administration tooling can list every webhook in the platform.
   * Mirrors the NotificationService.fetchAll posture.
   */
  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<WebhookEntity>> {
    const { limit, page } = props;
    const baseWhere = this.isSuperAdmin() ? {} : { tenantId: this.tenantId };
    const paginatedProps = withFormattedPaginatedProps(props, WEBHOOK_FILTER_MODEL);
    const countProps = withFormattedCountProps(props, WEBHOOK_FILTER_MODEL);
    const webhooks = await this.webhookRepository.findAll({
      ...paginatedProps,
      where: { ...paginatedProps.where, ...baseWhere },
    });

    const count = await this.webhookRepository.count({
      ...countProps,
      where: { ...countProps.where, ...baseWhere },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: webhooks.map((webhook: WebhookEntity) => webhook.id),
      },
    });
    return new FetchResponse<WebhookEntity>({
      data: webhooks,
      count,
      limit,
      page,
    });
  }

  /**
   * Refuse cross-tenant list
   * reads driven by the DTO `tenantId`. Pre-guard, any caller could
   * enumerate another tenant's webhooks by supplying a foreign
   * `tenantId`. SUPER_ADMIN bypasses for admin-tooling cross-tenant
   * listing (mirrors the Notification + ApiKey
   * `fetchAllByTenantId` posture).
   */
  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<WebhookEntity>> {
    const { tenantId, limit, page } = props;

    if (tenantId !== this.tenantId && !this.isSuperAdmin()) {
      throw new NotFoundException('Resource not found');
    }

    const webhooks = await this.webhookRepository.findAll({
      ...withFormattedPaginatedProps(props, WEBHOOK_FILTER_MODEL),
      where: {
        tenantId,
      },
    });
    const count = await this.webhookRepository.count({
      ...withFormattedCountProps(props, WEBHOOK_FILTER_MODEL),
      where: {
        tenantId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        tenantId,
        items: webhooks.map((webhook: WebhookEntity) => webhook.id),
      },
    });
    return new FetchResponse<WebhookEntity>({
      data: webhooks,
      count,
      limit,
      page,
    });
  }

  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<WebhookEntity>> {
    const { userId, limit, page } = props;
    const webhooks = await this.webhookRepository.findAll({
      ...withFormattedPaginatedProps(props, WEBHOOK_FILTER_MODEL),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.webhookRepository.count({
      ...withFormattedCountProps(props, WEBHOOK_FILTER_MODEL),
      where: {
        createdBy: userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: webhooks.map((webhook: WebhookEntity) => webhook.id),
      },
    });
    return new FetchResponse<WebhookEntity>({
      data: webhooks,
      count,
      limit,
      page,
    });
  }

  /**
   * Load-then-assert. Throw
   * `NotFoundException` (never `ForbiddenException`) on a cross-tenant
   * id so the API does not reveal that the row exists in another
   * tenant. SUPER_ADMIN bypasses for admin tooling.
   */
  async fetchById(id: EntityId): Promise<WebhookEntity> {
    const webhook = await this.webhookRepository.findById(id);
    if (!this.isSuperAdmin()) {
      assertEqualTenants(webhook, { tenantId: this.tenantId });
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: webhook.id,
      data: webhook.toObject() as object,
    });
    return webhook;
  }

  /**
   * Update a webhook.
   *
   * OCC migration. Writes via Compare-And-Set
   * against the row's `_version` column. The DTO's `expectedVersion` (or
   * the controller's `If-Match`-folded value, once a controller is
   * wired) is the CAS predicate; on version drift the repository raises
   * `OptimisticConcurrencyException`, which the `ExceptionInterceptor`
   * maps to `412 Precondition Failed`.
   */
  async update(id: EntityId, request: UpdateWebhookRequest): Promise<WebhookEntity> {
    // Defense-in-depth: `hashedSecret` is not a field of `UpdateWebhookRequest`
    // (the HTTP edge's `forbidNonWhitelisted` ValidationPipe already rejects
    // it), but service-to-service / Bull job callers bypass that pipe — so
    // guard here too against a request object that smuggles the key in past
    // the type system. Secrets rotate ONLY through `rotateSecret`.
    if (Object.prototype.hasOwnProperty.call(request, 'hashedSecret')) {
      throw new ArgumentInvalidException('hashedSecret cannot be set via update; use rotateSecret.');
    }

    const webhook = await this.webhookRepository.findById(id);
    // Load-then-assert defense-in-depth.
    // Throws NotFoundException on cross-tenant id BEFORE the CAS write
    // fires, so a foreign webhook is never mutated. SUPER_ADMIN bypasses
    // for admin tooling.
    if (!this.isSuperAdmin()) {
      assertEqualTenants(webhook, { tenantId: this.tenantId });
    }

    const previousData = webhook.toObject();
    const { expectedVersion, ...editableRequest } = request;
    this.updateEntity(webhook, editableRequest as UpdateWebhookRequest);

    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(webhook, expectedVersion);
    if (!webhook.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }

    // Snapshot the pre-write `_version` BEFORE the CAS bumps it, for
    // audit correlation.
    const previousVersion = webhook.version;

    const updatedWebhook = await this.webhookRepository.updateWithVersion(id, webhook, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedWebhook.id,
      data: { ...webhook.changes, previousVersion, newVersion: updatedWebhook.version },
      previousData,
    });
    return updatedWebhook;
  }

  /**
   * Rotate a webhook's signing secret — the ONLY write path that may set
   * `hashedSecret`. Generates a fresh server-side raw secret, peppered-hashes
   * it (same `encryptSecretForStorage` as `create`), and CAS-writes it via
   * `updateWithVersion` exactly like `update`. The new raw secret is
   * returned exactly once; every prior secret is immediately invalidated
   * (there is no overlap window — a webhook has at most one active secret).
   */
  async rotateSecret(id: EntityId, expectedVersion: number): Promise<CreateWebhookResult> {
    const webhook = await this.webhookRepository.findById(id);
    // Load-then-assert defense-in-depth, same posture as update()/deleteById().
    if (!this.isSuperAdmin()) {
      assertEqualTenants(webhook, { tenantId: this.tenantId });
    }

    const previousData = webhook.toObject();
    const previousVersion = webhook.version;
    const rawSecret = this.generateRawSecret();
    webhook.hashedSecret = await this.encryptSecretForStorage(rawSecret);

    const updatedWebhook = await this.webhookRepository.updateWithVersion(id, webhook, expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedWebhook.id,
      // Never log the secret material itself, hashed or raw — only the fact
      // of rotation and the version bump (same audit shape as `update`).
      data: { rotatedSecret: true, previousVersion, newVersion: updatedWebhook.version },
      previousData,
    });
    return { webhook: updatedWebhook, rawSecret };
  }

  /**
   * Load-then-assert before the
   * soft-delete write. Pre-guard, `softDelete(id)` ran directly with no
   * tenant check, so a Tenant-A user with knowledge of a foreign id
   * could delete another tenant's webhook. The new pre-load+assert
   * surfaces NotFoundException on cross-tenant ids so the foreign row
   * is never marked deleted. SUPER_ADMIN bypasses the pre-load (saves
   * a round-trip for admin tooling that legitimately deletes across
   * tenants).
   */
  async deleteById(id: EntityId): Promise<WebhookEntity> {
    if (!this.isSuperAdmin()) {
      const existing = await this.webhookRepository.findById(id);
      assertEqualTenants(existing, { tenantId: this.tenantId });
    }

    const webhook = await this.webhookRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: webhook.id,
      data: webhook.toObject() as object,
    });
    return webhook;
  }

  /**
   * The webhook's delivery log (`WebhookRunHistory`,
   * newest-first). The run-history rows carry NO tenantId, so tenancy is
   * enforced through the parent webhook: load-then-assert (404 on a
   * cross-tenant id, never 403 — no existence leak), SUPER_ADMIN bypasses
   * for admin tooling. Read-only: the append-only delivery writer is the
   * dispatch pipeline's concern, not this surface's.
   */
  async fetchRunHistory(webhookId: EntityId, props: PaginatedQuery): Promise<FetchResponse<WebhookRunHistoryEntity>> {
    const webhook = await this.webhookRepository.findById(webhookId);
    if (!this.isSuperAdmin()) {
      assertEqualTenants(webhook, { tenantId: this.tenantId });
    }

    const { limit, page } = props;
    const runs = await this.webhookRunHistoryRepository.findAll({
      where: { webhookId },
      sort: [{ createdAt: 'desc' }],
      page: page ?? 1,
      limit: limit ?? 20,
    });
    const count = await this.webhookRunHistoryRepository.count({ where: { webhookId } });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: webhook.id,
      data: { webhookId, items: runs.map((run: WebhookRunHistoryEntity) => run.id) },
    });
    return new FetchResponse<WebhookRunHistoryEntity>({
      data: runs,
      count,
      limit,
      page,
    });
  }

  /**
   * Resolve the tenantId to use for a write. Non-SUPER_ADMIN callers are
   * silently pinned to CLS; SUPER_ADMIN may override via `request.tenantId`
   * for cross-tenant impersonation. Throws `BadRequestException` if no
   * tenant context resolves (caller has no CLS AND no DTO `tenantId`
   * after the super-admin branch).
   *
   * Differs from `NotificationService.resolveEffectiveTenantId` only in
   * that a non-super-admin mismatch is silently coerced instead of
   * throwing `ForbiddenException`; webhooks are less sensitive than PHI
   * notification dispatch, so the contract mandates "row created with
   * tenant-A" on silent coercion.
   *
   * Emit a `logger.warn` ONLY on the
   * cross-tenant-coercion branch (non-SUPER_ADMIN passing a foreign
   * tenantId). Persistence is correct either way, but the warn gives
   * SOC the only signal that distinguishes a properly-formed request
   * from a foreign-tenant DTO. Same-tenant and tenantId-omitted writes
   * stay silent (benign / expected); SUPER_ADMIN cross-tenant writes
   * are explicitly allowed and also stay silent.
   */
  private resolveEffectiveTenantId(requestTenantId?: string): string {
    if (this.isSuperAdmin() && requestTenantId) return requestTenantId;
    const cls = this.tenantId;
    if (!cls) throw new BadRequestException('Tenant context required');
    if (requestTenantId && requestTenantId !== cls) {
      this.logger.warn('Webhook cross-tenant attempt coerced to CLS', {
        requestedTenantId: requestTenantId,
        callerTenantId: cls,
        userId: this.requestUser?.id,
      });
    }
    return cls;
  }

  /**
   * True when the active request user carries the SUPER_ADMIN role.
   * Mirrors the strict-default helper used by `TenantService` and
   * `AuthorizationAuditService` — falls back to `false` whenever the role
   * list is missing so the most restrictive policy applies.
   */
  private isSuperAdmin(): boolean {
    const roles = this.requestUser?.roles;
    return Array.isArray(roles) && roles.includes(SUPER_ADMIN_ROLE);
  }
}
