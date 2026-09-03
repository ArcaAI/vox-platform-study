import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Job, Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { createHmac } from 'crypto';
import {
  JobQueue,
  ResourceStatusType,
  SysEvent,
  WebhookEntity,
  WebhookRepository,
  WebhookRunHistoryFactory,
  WebhookRunHistoryRepository,
  WebhookRunStatus,
} from '@arcaai/domains';
import type { SysEventJob } from '@arcaai/domains';
import { createWorkerSession } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { WebhookService } from './webhook.service';
import { SecretsService } from '../baseServices/_meta/secrets';

/**
 * The delivery side of the `Webhook` subscription model — the missing half
 * confirmed dormant by research ():
 * `JobQueue.SysEvent` has been enqueued on every mutation across the platform
 * since the sys-event pipeline shipped, but nothing has ever consumed it.
 *
 * ## Two-stage design, split across two BullMQ queues on purpose
 *
 * 1. `WebhookDeliveryProcessor` (`@Processor(JobQueue.SysEvent)`) — the
 *    MATCHER. Consumes the SAME queue every CRUD mutation already fans out
 *    to (`sysEvent.service.ts#queueSysEventJob`), finds every ENABLED
 *    `Webhook` subscribed to the fired event's `(tenantId, resourceType,
 *    resourceId)`, and fans out ONE `JobQueue.WebhookDelivery` job per match.
 * 2. `WebhookDeliveryDispatchProcessor` (`@Processor(JobQueue.WebhookDelivery)`)
 *    — the SENDER. Signs and POSTs to exactly one webhook, writes the
 *    `WebhookRunHistory` attempt row, and THROWS on failure so BullMQ's own
 *    `attempts`/backoff (not a hand-rolled retry loop) governs redelivery.
 *
 * Splitting these matters for correctness, not just tidiness: if one job
 * did BOTH (query N webhooks, POST to all N, throw once if ANY POST failed),
 * a retry of that single job would re-deliver to every webhook that already
 * SUCCEEDED, not just the one that failed. Per-webhook jobs make retry
 * failure-isolated — Tenant A's slow endpoint retrying five times never
 * re-POSTs to Tenant A's other three, already-delivered subscribers.
 *
 * Idempotency ( 's normative rule — "every consumer must be
 * idempotent on `idempotencyKey`") is enforced at TWO layers, deliberately
 * redundant: the fan-out job uses `AsyncIdempotencyKey.webhookDelivery(...)`
 * (`hook:<webhookId>:<sourceEnvelopeId>`) as the BullMQ `jobId` (cheap,
 * best-effort — a completed job's id is freed once `removeOnComplete`
 * reaps it, so this alone cannot be relied on), AND the dispatch processor
 * checks `WebhookRunHistory` for an existing `SUCCESS` row carrying the same
 * key before sending (authoritative — survives job-id reuse after
 * completion).
 */

/** Payload for a `JobQueue.WebhookDelivery` job — one webhook, one event. */
export interface WebhookDeliveryJobPayload {
  webhookId: string;
  tenantId: string;
  /** The originating envelope's identity (`SysEvent.id`) — the idempotency key's second component. */
  sourceEnvelopeId: string;
  eventType: string;
  resourceType: string;
  resourceId: string | null;
  /** ISO-8601 — the FACT time (`SysEvent.createdAt`), not enqueue time. */
  occurredAt: string;
}

/** Distinct from `SYS_EVENT_JOB_OPTIONS` (`sysEvent.service.ts`, attempts:2) — an outbound
 *  HTTP POST to a third-party endpoint needs its own, more generous retry budget. */
export const WEBHOOK_DELIVERY_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2_000 }, // 2s → 4s → 8s → 16s → 32s
  removeOnComplete: true,
  removeOnFail: false, // dead-letter inspection, same posture as SYS_EVENT_JOB_OPTIONS.
};

/** `sha256=<hex>` — the GitHub/Stripe convention: prefixed hex HMAC digest. */
const SIGNATURE_HEADER = 'X-Hope-Webhook-Signature';

/** Outbound HTTP timeout: one slow tenant endpoint must not starve the worker's concurrency. */
const DELIVERY_TIMEOUT_MS = 10_000;

/** Cap the persisted response-body snapshot so a chatty/huge receiver response can't bloat the audit row. */
const MAX_RESPONSE_BODY_CHARS = 4_000;

/**
 * `resourceType` → admin-controller path segment, for the reference-not-content
 * `fetchUrl` (the ticket: identifiers + a fetch-back URL, never
 * `SysEvent.data`/resource content in the outbound payload). BEST-EFFORT: the
 * platform has no single generic "fetch any resource by type" route today,
 * so this is an explicit map for the resource types most plausible for a
 * webhook subscription, falling back to a mechanical kebab-plural guess for
 * anything not listed. Extend the map as new subscribable resource types
 * prove out real deviations (e.g. `ApiKey` → `api-keys`, not `apikeys`).
 */
const RESOURCE_TYPE_FETCH_PATH: Readonly<Record<string, string>> = {
  ApiKey: 'api-keys',
  Webhook: 'webhooks',
  Department: 'departments',
  Consultation: 'consultations',
  User: 'users',
  Tenant: 'tenants',
};

function resourceTypePath(resourceType: string): string {
  const known = RESOURCE_TYPE_FETCH_PATH[resourceType];
  if (known) return known;
  const kebab = resourceType.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return `${kebab}s`;
}

/** `undefined`/unset ⇒ the `.env.sample` dev default, matching `API_URL`'s own documented default. */
function resolveApiBaseUrl(): string {
  return (process.env.API_URL ?? 'http://localhost:8868').replace(/\/+$/, '');
}

/** No fetchable resource for a tenant-wide/wildcard-triggering event with no concrete id. */
function buildFetchUrl(resourceType: string, resourceId: string | null): string | null {
  if (!resourceId) return null;
  return `${resolveApiBaseUrl()}/api/v1/admin/${resourceTypePath(resourceType)}/${resourceId}`;
}

/** The reference-not-content outbound payload — never `SysEvent.data` ( PHI-egress justification). */
interface WebhookOutboundPayload {
  eventType: string;
  resourceType: string;
  resourceId: string | null;
  tenantId: string;
  occurredAt: string;
  fetchUrl: string | null;
}

/**
 * Intent-derived idempotency key ( 's own named recipe for this
 * exact ticket: `hook:<subscriptionId>:<sourceEnvelopeId>`). Inlined rather
 * than importing `@arcaai/async-contract` — this is the ONE recipe from that
 * package's `AsyncIdempotencyKey.webhookDelivery` this ticket needs, and
 * pulling the whole package into `packages/applications` for one string
 * template is not worth a new workspace dependency. If a second consumer of
 * `AsyncIdempotencyKey` lands in this package, promote to the real import
 * instead of a second inlined copy.
 */
function webhookDeliveryIdempotencyKey(webhookId: string, sourceEnvelopeId: string): string {
  return `hook:${webhookId}:${sourceEnvelopeId}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 1 — the matcher
// ─────────────────────────────────────────────────────────────────────────

@Processor(JobQueue.SysEvent)
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(
    private readonly webhookRepository: WebhookRepository,
    private readonly cls: ClsService<IActiveUserContext>,
    @InjectQueue(JobQueue.WebhookDelivery) private readonly deliveryQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<SysEventJob>): Promise<void> {
    const event: SysEvent = job.data.data;

    // A tenant-less event (platform-internal, no `SysEvent.tenantId`) can
    // never match a `Webhook` row — every `Webhook.tenantId` is NOT NULL
    // (rule 02) — so this is a legitimate, silent no-op, not an error.
    if (!event?.tenantId || !event.resourceType) {
      return;
    }

    await this.cls.run(async () => {
      this.cls.set('tenantId', event.tenantId as string);
      this.cls.set('user', createWorkerSession({ tenantId: event.tenantId as string, kind: 'webhook-delivery' }));

      // Wildcard subscriptions are stored with `resourceId` as EITHER `null`
      // (the documented contract, webhook.prisma's own comment) OR `''`
      // (what `WebhookFactory.CreateWebhook`'s generated default actually
      // persists when the caller omits it — `resourceId: props.resourceId ?? ''`).
      // Matching both keeps tenant-wide subscriptions from silently never
      // firing because of that generator/doc mismatch.
      const resourceIdConditions: Array<{ resourceId: string | null }> = [{ resourceId: null }, { resourceId: '' }];
      if (event.resourceId) resourceIdConditions.push({ resourceId: event.resourceId });

      const matches = await this.webhookRepository.findAll({
        where: {
          tenantId: event.tenantId,
          resourceTypeName: event.resourceType,
          resourceStatus: ResourceStatusType.ENABLED,
          OR: resourceIdConditions,
        } as never,
      });

      if (matches.length === 0) return;

      for (const webhook of matches) {
        const payload: WebhookDeliveryJobPayload = {
          webhookId: webhook.id,
          tenantId: event.tenantId as string,
          sourceEnvelopeId: event.id,
          eventType: event.type,
          resourceType: event.resourceType,
          resourceId: event.resourceId ?? null,
          // `SysEvent.createdAt` is typed `Date`, but this event arrived through
          // BullMQ — JSON serialisation already turned it into an ISO STRING, so
          // the static type lies at runtime and calling `.toISOString()` on it
          // threw `event.createdAt.toISOString is not a function`. That killed
          // EVERY sys-event job before any delivery was enqueued, so no webhook
          // in the platform ever fired. Re-wrap so both shapes work (a `Date`
          // survives the round trip when a caller invokes this in-process).
          occurredAt: new Date(event.createdAt).toISOString(),
        };

        await this.deliveryQueue.add(JobQueue.WebhookDelivery, payload, {
          ...WEBHOOK_DELIVERY_JOB_OPTIONS,
          jobId: webhookDeliveryIdempotencyKey(webhook.id, event.id),
        });
      }

      this.logger.debug({
        message: 'Webhook delivery fan-out',
        sourceEnvelopeId: event.id,
        resourceType: event.resourceType,
        matchedWebhooks: matches.length,
      });
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 2 — the sender
// ─────────────────────────────────────────────────────────────────────────

@Processor(JobQueue.WebhookDelivery)
export class WebhookDeliveryDispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryDispatchProcessor.name);

  constructor(
    private readonly webhookRepository: WebhookRepository,
    private readonly webhookRunHistoryRepository: WebhookRunHistoryRepository,
    private readonly httpService: HttpService,
    private readonly cls: ClsService<IActiveUserContext>,
    // Optional — same fallback shape as `WebhookService`'s own dependency;
    // legacy/no-Vault test construction still works (local AES-key fallback).
    private readonly secretsService?: SecretsService,
  ) {
    super();
  }

  async process(job: Job<WebhookDeliveryJobPayload>): Promise<void> {
    const { webhookId, tenantId, sourceEnvelopeId, eventType, resourceType, resourceId, occurredAt } = job.data;

    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ tenantId, kind: 'webhook-delivery' }));

      let webhook: WebhookEntity;
      try {
        webhook = await this.webhookRepository.findById(webhookId);
      } catch {
        // The webhook was hard-deleted (or the id was never real) between
        // fan-out and dispatch — no-op, nothing to retry.
        return;
      }

      // DISABLED/soft-deleted between fan-out and dispatch — never send.
      // Explicit check (this is a raw repository read, not a service
      // passthrough — the extended client's soft-delete filter only excludes
      // DELETED, not DISABLED, per rule 02).
      if (webhook.resourceStatus !== ResourceStatusType.ENABLED) {
        return;
      }

      const idempotencyKey = webhookDeliveryIdempotencyKey(webhookId, sourceEnvelopeId);

      // Authoritative idempotency guard: a redelivered
      // fan-out job (the OUTER SysEvent job retried) must not re-send to a
      // webhook this exact event already reached successfully.
      const alreadyDelivered = await this.webhookRunHistoryRepository.findAll({
        where: {
          webhookId,
          status: WebhookRunStatus.SUCCESS,
          response: { path: ['idempotencyKey'], equals: idempotencyKey },
        } as never,
        limit: 1,
      });
      if (alreadyDelivered.length > 0) {
        return;
      }

      const rawSecret = webhook.hashedSecret ? await this.resolveRawSecret(webhook.hashedSecret) : null;

      const payload: WebhookOutboundPayload = {
        eventType,
        resourceType,
        resourceId,
        tenantId,
        occurredAt,
        fetchUrl: buildFetchUrl(resourceType, resourceId),
      };
      const body = JSON.stringify(payload);
      const signature = rawSecret ? createHmac('sha256', rawSecret).update(body).digest('hex') : null;

      const maxAttempts = job.opts?.attempts ?? 1;
      const attemptNumber = (job.attemptsMade ?? 0) + 1;
      const isFinalAttempt = attemptNumber >= maxAttempts;

      try {
        const response = await this.httpService.axiosRef.post(webhook.url, body, {
          timeout: DELIVERY_TIMEOUT_MS,
          headers: {
            'Content-Type': 'application/json',
            ...(signature ? { [SIGNATURE_HEADER]: `sha256=${signature}` } : {}),
          },
          // 2xx only counts as success; let axios resolve on any status so
          // the outcome is recorded from the response we actually got,
          // rather than losing the body/status to a thrown AxiosError.
          validateStatus: () => true,
        });

        if (response.status >= 200 && response.status < 300) {
          await this.recordAttempt(webhookId, WebhookRunStatus.SUCCESS, response.status, {
            idempotencyKey,
            body: this.capResponseBody(response.data),
          });
          return;
        }

        await this.recordAttempt(webhookId, isFinalAttempt ? WebhookRunStatus.DEAD_LETTERED : WebhookRunStatus.FAILED, response.status, {
          idempotencyKey,
          body: this.capResponseBody(response.data),
        });
        throw new Error(`Webhook ${webhookId} delivery failed: receiver responded ${response.status}`);
      } catch (error) {
        // A non-2xx status already recorded its own row above and re-threw
        // as a plain Error — don't double-record. Anything else here is a
        // network-level failure (timeout, DNS, connection refused) that
        // never reached `recordAttempt`.
        if (!(error instanceof Error) || !error.message.startsWith(`Webhook ${webhookId} delivery failed:`)) {
          await this.recordAttempt(webhookId, isFinalAttempt ? WebhookRunStatus.DEAD_LETTERED : WebhookRunStatus.FAILED, null, {
            idempotencyKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Rethrow unconditionally: BullMQ's own attempts/backoff governs
        // redelivery — this processor never hand-rolls a retry loop.
        throw error;
      }
    });
  }

  private capResponseBody(data: unknown): string {
    const raw = typeof data === 'string' ? data : JSON.stringify(data ?? null);
    return raw.length > MAX_RESPONSE_BODY_CHARS ? `${raw.slice(0, MAX_RESPONSE_BODY_CHARS)}…(truncated)` : raw;
  }

  private async resolveRawSecret(storedSecret: string): Promise<string | null> {
    try {
      const pepper = (await this.secretsService?.getSecretOptional('WEBHOOK_SECRET_PEPPER')) ?? undefined;
      return WebhookService.decryptSecret(storedSecret, pepper);
    } catch (error) {
      this.logger.error({
        message: 'Failed to decrypt webhook signing secret — delivering UNSIGNED rather than blocking the event',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Append-only telemetry row — deliberately NOT a `broadcastSysEvent` (rule
   * `04-application-services.md` /: `WebhookRunHistory` is
   * write-once attempt history, not a CRUD resource with its own lifecycle,
   * mirroring how `AuditLog` rows are written without their own fan-out.
   */
  private async recordAttempt(
    webhookId: string,
    status: WebhookRunStatus,
    responeStatusCode: number | null,
    response: Record<string, unknown>,
  ): Promise<void> {
    const entity = WebhookRunHistoryFactory.CreateWebhookRunHistory({
      webhookId,
      status,
      responeStatusCode: responeStatusCode ?? undefined,
      response: response as never,
    });
    await this.webhookRunHistoryRepository.create(entity);
  }
}
