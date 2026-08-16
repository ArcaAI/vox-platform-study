import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConsentGrantEntity, ConsentGrantRepository } from '@arcaai/domains';
import { ConsentDeniedException, ConsentUnavailableException } from '@arcaai/exceptions';
import { ConsentAssertInput, ConsentDecision, ConsentDenialReason, IConsultationConsentService } from './IConsultationConsentService';
import { CONSENT_INVALIDATE_EVENT, normalizeExternalPatientId } from './consent.constants';

/** Bounded-staleness backstop — see consent-design.md §4. Invalidation (below) is the real propagation path. */
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  grant: ConsentGrantEntity | null;
  expiresAtMs: number;
}

/**
 * The ABAC evaluation choke point (TASK-712, consent-abac). See
 * `IConsultationConsentService` for the contract and
 * docs/implementation/TASK-712-Consent-Abac/consent-design.md for the design
 * record — in particular §4 (why this cache is in-process/EventEmitter2-only
 * in this phase, not a cross-process Redis channel) and the "legacy-consent
 * posture" section (no exemption logic exists here; every unmatched request
 * denies, unconditionally).
 *
 * Deliberately does NOT extend `BaseService` / read CLS: `tenantId` arrives
 * as an explicit input so this is callable identically from an HTTP guard,
 * a BullMQ worker, a Temporal activity, or a tool layer — none of which
 * share the HTTP request's CLS context (§3.3 Pitfall 3 in the ticket
 * README applies here just as it does to the HTTP guard).
 */
@Injectable()
export class ConsultationConsentService implements IConsultationConsentService {
  private readonly logger = new Logger(ConsultationConsentService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly consentGrantRepository: ConsentGrantRepository) {}

  private cacheKey(tenantId: string, externalPatientId: string, purpose: string): string {
    // tenantId-leading and mandatory — .claude/rules/09-infrastructure-devops.md §Config caches rule 1.
    return `${tenantId}::${externalPatientId}::${purpose}`;
  }

  private async resolveGrant(tenantId: string, externalPatientId: string, purpose: string): Promise<ConsentGrantEntity | null> {
    const key = this.cacheKey(tenantId, externalPatientId, purpose);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.grant;
    }

    const grant = await this.consentGrantRepository.findByTenantPatientPurpose(tenantId, externalPatientId, purpose as never);
    this.cache.set(key, { grant, expiresAtMs: Date.now() + CACHE_TTL_MS });
    return grant;
  }

  async checkConsent(input: ConsentAssertInput): Promise<ConsentDecision> {
    const externalPatientId = normalizeExternalPatientId(input.externalPatientId);
    const now = new Date();

    let grant: ConsentGrantEntity | null;
    try {
      grant = await this.resolveGrant(input.tenantId, externalPatientId, input.purpose);
    } catch (error) {
      // Fail-closed: a lookup failure (unreachable dependency, tenant-scope
      // mismatch, ...) still denies, never silently allows — but it is NOT
      // the same event as a genuine 'no_grant' denial (R4, README §6): a
      // real denial is an expected compliance event; an infra hiccup wearing
      // a denial's shape is an availability incident and must alert
      // differently. `unavailable: true` (no `reason`) carries that
      // distinction to `assertConsent`, which throws a DIFFERENT exception
      // type for it.
      this.logger.error({
        message: 'assertConsent: grant lookup failed — denying (fail-closed), NOT a consent decision',
        tenantId: input.tenantId,
        externalPatientId,
        purpose: input.purpose,
        error: error instanceof Error ? error.message : String(error),
      });
      return { allowed: false, unavailable: true };
    }

    if (grant == null) {
      return this.deny('no_grant', input, externalPatientId);
    }
    if (!grant.isActive(now)) {
      const reason: ConsentDenialReason = grant.revokedAt != null && grant.revokedAt.getTime() <= now.getTime() ? 'revoked' : 'expired';
      return this.deny(reason, input, externalPatientId, grant.id);
    }
    if (!grant.coversScope(input.scope)) {
      return this.deny('scope_insufficient', input, externalPatientId, grant.id);
    }

    return { allowed: true, grantId: grant.id, expiresAt: grant.expiresAt };
  }

  async assertConsent(input: ConsentAssertInput): Promise<void> {
    const externalPatientId = normalizeExternalPatientId(input.externalPatientId);
    const decision = await this.checkConsent(input);
    if (decision.allowed) return;

    if (decision.unavailable) {
      throw new ConsentUnavailableException(`Consent could not be determined for purpose "${input.purpose}" — grant lookup failed`, {
        tenantId: input.tenantId,
        externalPatientId,
        purpose: input.purpose,
        cause: 'grant_lookup_failed',
      });
    }

    throw new ConsentDeniedException(`Consent denied for purpose "${input.purpose}" (${decision.reason ?? 'no_grant'})`, {
      tenantId: input.tenantId,
      externalPatientId,
      purpose: input.purpose,
      reason: decision.reason ?? 'no_grant',
      grantId: decision.grantId,
    });
  }

  private deny(reason: ConsentDenialReason, input: ConsentAssertInput, externalPatientId: string, grantId?: string): ConsentDecision {
    // Not a WORM audit row — see consent-design.md §6. A structured log line
    // is what this phase actually delivers; it is NOT a substitute for the
    // audited-denial invariant (INV-007/338), which stays open.
    this.logger.warn({
      message: 'assertConsent: denied',
      tenantId: input.tenantId,
      externalPatientId,
      purpose: input.purpose,
      reason,
      grantId,
      actorKind: input.actor.kind,
      actorUserId: input.actor.userId,
      consultationId: input.context?.consultationId,
      toolName: input.context?.toolName,
    });
    return { allowed: false, reason, grantId };
  }

  /**
   * In-process cache invalidation on grant create/revoke. Evicts every
   * cached entry for the (tenantId, externalPatientId[, purpose]) the event
   * names — `purpose` omitted evicts every purpose for that patient (used by
   * nothing today, kept for symmetry with a future bulk-revoke).
   */
  @OnEvent(CONSENT_INVALIDATE_EVENT)
  handleInvalidate(payload: { tenantId: string; externalPatientId: string; purpose?: string }): void {
    const externalPatientId = normalizeExternalPatientId(payload.externalPatientId);
    if (payload.purpose) {
      this.cache.delete(this.cacheKey(payload.tenantId, externalPatientId, payload.purpose));
      return;
    }
    const prefix = `${payload.tenantId}::${externalPatientId}::`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }
}
