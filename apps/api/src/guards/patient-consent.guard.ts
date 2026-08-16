/**
 * `PatientConsentGuard` — the HTTP front door of the consent-abac choke
 * point (TASK-712). Registered as a global `APP_GUARD` in `app.module.ts`,
 * strictly AFTER `UnifiedAuthGuard` (needs the resolved CLS tenant/user) and
 * BEFORE `RequiresIfMatchGuard` (a consent denial should never let a
 * revoke-with-If-Match request get as far as the OCC check).
 *
 * Enforcement is ON BY DEFAULT and UNCONDITIONAL — there is no
 * `consent.enabled` kill-switch. A kill-switch defaults OFF
 * (`.claude/rules/09-infrastructure-devops.md` §Configuration Tiers), which
 * for an enforcement toggle would default the gate OPEN: exactly the
 * outcome this ticket exists to prevent. The rollout lever is COVERAGE
 * (which routes carry `@RequiresConsent`/`@ConsentExempt`), audited at boot
 * by `../bootstrap/consent-route-coverage-audit.ts` — not a runtime flag
 * here.
 *
 * This guard is declarative-only for coverage: a route with NEITHER
 * `@RequiresConsent` nor `@ConsentExempt` is a silent no-op here (same
 * posture as `RequiresIfMatchGuard` for its own metadata) — the boot audit,
 * not this guard, is what refuses to start over a missing decorator.
 *
 * Pitfall 3 (ticket README §3.3): NEVER read `request.ability` here. The
 * API-key auth path builds no CASL ability at all (F-08); a guard that
 * consulted it would be a silent no-op on every API-key call, which is
 * exactly the failure class this ticket exists to remove. Tenant and user
 * come from CLS (populated by `UnifiedAuthGuard` on BOTH the JWT and
 * API-key paths); patient id comes from route params or a loaded
 * consultation, never from an ability-derived subject instance.
 */
import { CanActivate, ExecutionContext, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { CONSENT_EXEMPT_KEY, IConsultationConsentService, REQUIRES_CONSENT_KEY, RequiresConsentMetadata, SKIP_AUTH_KEY } from '@arcaai/applications';
import { ConsultationRepository } from '@arcaai/domains';

interface RequestLike {
  params?: Record<string, string | undefined>;
}

@Injectable()
export class PatientConsentGuard implements CanActivate {
  private readonly logger = new Logger(PatientConsentGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService,
    @Inject(IConsultationConsentService)
    private readonly consentService: IConsultationConsentService,
    private readonly consultationRepository: ConsultationRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const handler = context.getHandler();
    const cls = context.getClass();

    // @Public() routes never authenticated — nothing to gate on.
    const isPublic = this.reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [handler, cls]);
    if (isPublic) {
      return true;
    }

    // Explicit exemption wins over an absent decorator being silently
    // treated the same way — see the boot audit for why the two are NOT
    // equivalent from a coverage-tracking standpoint, even though both
    // no-op here.
    const exemptReason = this.reflector.getAllAndOverride<string | undefined>(CONSENT_EXEMPT_KEY, [handler, cls]);
    if (exemptReason !== undefined) {
      return true;
    }

    const metadata = this.reflector.getAllAndOverride<RequiresConsentMetadata | undefined>(REQUIRES_CONSENT_KEY, [handler, cls]);
    if (!metadata) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestLike>();
    const tenantId = (this.cls.get('tenantId') as string | undefined) ?? '';
    const user = this.cls.get('user') as { id?: string } | undefined;

    const externalPatientId = await this.resolvePatientId(request, metadata, tenantId);

    // `assertConsent` throws `ConsentDeniedException` (403) or
    // `ConsentUnavailableException` (503) — both propagate unchanged;
    // `exception.interceptor.ts` maps them (R4: never the same status for
    // "denied" and "we could not check").
    await this.consentService.assertConsent({
      tenantId,
      externalPatientId,
      purpose: metadata.purpose,
      scope: metadata.scope,
      actor: { userId: user?.id, kind: 'user' },
      context: { consultationId: request.params?.id },
    });

    return true;
  }

  /**
   * Resolution order (ticket README Task 9): explicit
   * `opts.patientIdParam` -> the `:patientId` route param -> the loaded
   * consultation's `patientId` (via `:id`). Never guesses silently — a
   * route with none of these throws, which is a decorator-wiring bug the
   * boot audit and this failure both point at.
   */
  private async resolvePatientId(request: RequestLike, metadata: RequiresConsentMetadata, tenantId: string): Promise<string> {
    const params = request.params ?? {};

    if (metadata.patientIdParam) {
      const value = params[metadata.patientIdParam];
      if (!value) {
        throw new Error(`@RequiresConsent: route param "${metadata.patientIdParam}" is missing on this request`);
      }
      return value;
    }

    if (params.patientId) {
      return params.patientId;
    }

    if (params.id) {
      const consultation = await this.consultationRepository.findById(params.id);
      // Defense-in-depth, mirroring ConsentGrantService.revoke's
      // load-then-assert: a cross-tenant consultation id must 404, not leak
      // a consent decision about another tenant's patient. The tenant-scope
      // Prisma extension already filters this at the query layer for most
      // paths; this check makes the guard correct even if that changes.
      if (consultation.tenantId !== tenantId) {
        this.logger.warn({ message: 'PatientConsentGuard: cross-tenant consultation id', consultationId: params.id });
        throw new NotFoundException(`Consultation ${params.id} not found`);
      }
      return consultation.patientId;
    }

    throw new Error('@RequiresConsent: could not resolve a patient id — no patientIdParam, :patientId, or :id route param');
  }
}
