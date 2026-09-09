/**
 * `TenantOwnedResourceInterceptor`.
 *
 * Global interceptor that, for every handler annotated with
 * `@TenantOwnedResource(...)`, resolves the addressed resource via the
 * matching repository (or service) and asserts the resource's tenant matches
 * the caller's CLS tenant before letting the handler run.
 *
 * The 404 response on tenant mismatch (DEF-C3 "no existence leak") is the
 * uniform behaviour — there is no `@PlatformAdmin()` bypass. SUPER_ADMIN
 * cross-tenant access continues to flow through service methods that opt in
 * explicitly (e.g. `TenantService.fetchById`).
 *
 * Model-specific resolution rules:
 *
 *   - `TenantBucket`      — repo.findById(id) OR repo.findByName(name);
 *                           assert `entity.tenantId === cls.tenantId`.
 *   - `TenantStorageConfig` — repo.findById(id); assert
 *                           `entity.tenantId === cls.tenantId`.
 *   - `TranscriptionJob`  — repo.findById(id); assert
 *                           `entity.tenantId === cls.tenantId`.
 *   - `Consultation`      — repo.findById(id); assert
 *                           `entity.tenantId === cls.tenantId` (Clinical
 *                           Workflow Playground WS1 — live-summary SSE).
 *   - `ConsultationJob`   — `jobService.getJobStatus(jobId)`; status struct
 *                           carries `tenantId` after W3.3. Assert
 *                           `status.tenantId === cls.tenantId`.
 *   - `StreamSession`     — `sessionId -> { tenantId, userId }` binding; assert BOTH, where
 *                           `userId` is the acting principal (a user OR, since TASK-933, a
 *                           service account — `resolveCallerPrincipalId`).
 *   - `UserVoiceProfile`  — repo.findById(id); the entity is user-scoped
 *                           (no tenantId), so we assert
 *                           `entity.userId === cls.user.id` — the same
 *                           defence-in-depth check
 *                           `VoiceProfileService.assertOwnership` already
 *                           runs, only earlier and as a uniform 404 instead
 *                           of the existing 403.
 *
 * Any future `TenantOwnedResourceModelName` addition MUST extend
 * `resolveResource` here AND the union in `tenant-owned-resource.decorator.ts`.
 */
import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { Observable } from 'rxjs';
import { DataNotFoundException } from '@arcaai/exceptions';
import { IConsultationJobService, type IActiveUserContext, isSuperAdmin } from '@arcaai/applications';
import {
  ConsultationRepository,
  TenantBucketRepository,
  TenantStorageConfigRepository,
  TranscriptionJobRepository,
  UserVoiceProfileRepository,
} from '@arcaai/domains';
import { StreamSessionTenantBindingService } from './stream-session-tenant-binding.service';
import { TENANT_OWNED_RESOURCE_KEY, type TenantOwnedResourceOptions } from './tenant-owned-resource.decorator';

/** Generic 404 used everywhere (DEF-C3 no-existence-leak). */
const RESOURCE_NOT_FOUND = 'Resource not found';

@Injectable()
export class TenantOwnedResourceInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly tenantBucketRepository: TenantBucketRepository,
    private readonly tenantStorageConfigRepository: TenantStorageConfigRepository,
    private readonly userVoiceProfileRepository: UserVoiceProfileRepository,
    private readonly transcriptionJobRepository: TranscriptionJobRepository,
    // Clinical Workflow Playground (WS1): drives the `Consultation` resolver
    // branch (pre-stream tenant check for the live-summary SSE route).
    private readonly consultationRepository: ConsultationRepository,
    @Inject(IConsultationJobService)
    private readonly consultationJobService: IConsultationJobService,
    // Drives the `StreamSession` resolver branch.
    // The binding is written by `TranscriptionJobController.createStreamSession`
    // and removed by `closeStreamSession` — the interceptor only reads it.
    // It carries `{ tenantId, userId }`, so this branch asserts BOTH the
    // owning tenant and the owning user.
    private readonly streamSessionTenantBinding: StreamSessionTenantBindingService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    await this.assertAccess(context);
    return next.handle();
  }

  /**
   * Resolve + ownership-assert the `@TenantOwnedResource` target for `context`,
   * throwing `404` on any mismatch (DEF-C3 no-existence-leak). A no-op for
   * handlers that don't carry the decorator.
   *
   * Extracted from `intercept` so the companion `TenantOwnedResourceSseGuard`
   * can run the SAME assertion BEFORE the handler executes. Interceptors throw
   * AFTER an `@Sse()` handler has already returned its event stream, so the
   * thrown 404 never reaches the client and the cross-tenant stream opens with
   * a 200. A guard runs ahead of the handler, so re-running
   * the assertion there closes the stream with a 404 before it opens.
   */
  async assertAccess(context: ExecutionContext): Promise<void> {
    const opts = this.reflector.getAllAndOverride<TenantOwnedResourceOptions | undefined>(TENANT_OWNED_RESOURCE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!opts) {
      // Handler not annotated — pass-through. Avoids any CLS/repo cost for
      // the overwhelming majority of routes that don't use the decorator.
      return;
    }

    const callerTenantId = this.cls.get('tenantId');
    const request = context.switchToHttp().getRequest<{ params?: Record<string, string> }>();
    const paramValue = request?.params?.[opts.paramName];
    if (!paramValue || typeof paramValue !== 'string') {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }

    if (!callerTenantId && opts.scope === 'super-admin' && isSuperAdmin(this.cls.get('user'))) {
      return;
    }

    if (!callerTenantId || typeof callerTenantId !== 'string') {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }

    await this.assertOwnership(opts, paramValue, callerTenantId);
  }

  /**
   * TASK-933 — the ACTING PRINCIPAL's id, for the two branches that assert an intra-tenant OWNER
   * rather than a tenant.
   *
   * A service account is on CLS `serviceAccount` and never on `user` (`UnifiedAuthGuard`: a
   * machine's actions must not be recorded against a person), so reading `user` alone answered
   * "no principal" for a machine and 404'd it on a session it had itself just created. This is
   * the READ half of the pair; the WRITE half is `TranscriptionJobController.
   * resolveStreamOwnerId()`, and the two must always resolve the same way or the owner recorded
   * at create can never be matched at use.
   *
   * Returns `undefined` when there is no principal at all, which both callers treat as a refusal
   * — unchanged, and the same fail-closed posture an ownerless legacy row already gets.
   */
  private resolveCallerPrincipalId(): string | undefined {
    const userId = this.cls.get('user')?.id;
    if (typeof userId === 'string' && userId.length > 0) return userId;
    const serviceAccountId = (this.cls.get('serviceAccount') as { id?: string } | undefined)?.id;
    return typeof serviceAccountId === 'string' && serviceAccountId.length > 0 ? serviceAccountId : undefined;
  }

  private async assertOwnership(opts: TenantOwnedResourceOptions, paramValue: string, callerTenantId: string): Promise<void> {
    switch (opts.modelName) {
      case 'TenantBucket':
        await this.assertTenantBucket(opts, paramValue, callerTenantId);
        return;
      case 'TenantStorageConfig':
        await this.assertTenantScoped(() => this.tenantStorageConfigRepository.findById(paramValue), callerTenantId);
        return;
      case 'TranscriptionJob':
        await this.assertTenantScoped(() => this.transcriptionJobRepository.findById(paramValue), callerTenantId);
        return;
      case 'Consultation':
        // Clinical Workflow Playground (WS1): the consultation row carries
        // `tenantId`, so the standard tenant-scoped assertion applies.
        await this.assertTenantScoped(() => this.consultationRepository.findById(paramValue), callerTenantId);
        return;
      case 'ConsultationJob':
        await this.assertConsultationJob(opts, paramValue, callerTenantId);
        return;
      case 'UserVoiceProfile':
        await this.assertVoiceProfileOwnership(paramValue);
        return;
      case 'StreamSession':
        // SessionId → { tenantId, userId } lookup via the
        // gateway-side binding service (the session itself lives in
        // STT / Redis, not Prisma — there is no repository to call).
        await this.assertStreamSessionOwnership(paramValue, callerTenantId);
        return;
      default:
        // Exhaustiveness — the union covers every branch. Throwing the
        // generic 404 here protects against future drift between the
        // decorator's union and the switch (e.g. a new modelName added to
        // the decorator without a matching branch).
        throw new NotFoundException(RESOURCE_NOT_FOUND);
    }
  }

  /**
   * A live STT streaming session belongs to ONE user, not to the tenant at
   * large. This branch gates `refresh-ticket`, `close`, `switch-to-fallback`
   * and `switch-to-primary`; while the comparison was tenant-only, any
   * colleague who learned a sessionId could refresh the ticket for a live
   * consultation, close it mid-dictation, or swap its engine underneath the
   * clinician.
   *
   * Both halves 404 (never 403): a foreign-tenant session and a colleague's
   * session must be indistinguishable from one that does not exist. A binding
   * with NO recorded owner (a legacy record — see the binding service's
   * ROLLOUT note) is "owner unproven" and denied, mirroring how a legacy
   * `ConsultationJob` row with no `userId` is handled under `scope: 'creator'`.
   *
   * TASK-933 — the owner is the acting PRINCIPAL, which may be a service account. That widens
   * WHO can be an owner, never how the comparison is made: a different machine, a colleague,
   * another tenant and an ownerless binding are all still 404.
   *
   * There is deliberately no super-admin bypass: a live clinical audio socket
   * is precisely the surface where a silent extra listener is the harm.
   */
  private async assertStreamSessionOwnership(sessionId: string, callerTenantId: string): Promise<void> {
    const binding = await this.streamSessionTenantBinding.lookupBinding(sessionId);
    if (binding === null || binding.tenantId !== callerTenantId) {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }
    const callerPrincipalId = this.resolveCallerPrincipalId();
    if (!callerPrincipalId || !binding.userId || binding.userId !== callerPrincipalId) {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }
  }

  private async assertTenantBucket(opts: TenantOwnedResourceOptions, paramValue: string, callerTenantId: string): Promise<void> {
    const lookup = opts.lookup ?? 'id';
    const finder =
      lookup === 'name' ? () => this.tenantBucketRepository.findByName(paramValue) : () => this.tenantBucketRepository.findById(paramValue);
    await this.assertTenantScoped(finder, callerTenantId);
  }

  private async assertTenantScoped(finder: () => Promise<{ tenantId?: string | null } | null | undefined>, callerTenantId: string): Promise<void> {
    const entity = await this.safeResolve(finder);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }
    if (!entity.tenantId || entity.tenantId !== callerTenantId) {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }
  }

  private async assertConsultationJob(opts: TenantOwnedResourceOptions, jobId: string, callerTenantId: string): Promise<void> {
    let status: { tenantId?: string | null; userId?: string | null } | null;
    try {
      status = (await this.consultationJobService.getJobStatus(jobId)) as { tenantId?: string | null; userId?: string | null } | null;
    } catch (err) {
      if (err instanceof DataNotFoundException) {
        throw new NotFoundException(RESOURCE_NOT_FOUND);
      }
      throw err;
    }
    if (status === null || status === undefined) {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }
    if (!status.tenantId || status.tenantId !== callerTenantId) {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }

    // `scope: 'creator'` adds the intra-tenant owner check. Older Redis rows
    // (written before `userId` was added to `ConsultationJobStatus`) may
    // still lack it within the 24h JOB_TTL window. Treating a missing
    // `userId` as a mismatch keeps the 404 shape uniform and avoids leaking
    // the legacy-row distinction.
    if (opts.scope === 'creator') {
      // TASK-933 — the creator may be a machine; same resolution as the StreamSession branch.
      const callerPrincipalId = this.resolveCallerPrincipalId();
      if (!callerPrincipalId) {
        throw new NotFoundException(RESOURCE_NOT_FOUND);
      }
      if (!status.userId || status.userId !== callerPrincipalId) {
        throw new NotFoundException(RESOURCE_NOT_FOUND);
      }
    }
  }

  /**
   * UserVoiceProfile is user-scoped (no tenantId column). We mirror the
   * existing service-layer `VoiceProfileService.assertOwnership` here so the
   * controller-level decorator and the service give the same answer on the
   * same probe — except the 403/Forbidden is normalised to 404 so probing
   * any voice profile id outside the caller's ownership is indistinguishable
   * from probing a non-existent id (DEF-C3 alignment).
   */
  private async assertVoiceProfileOwnership(profileId: string): Promise<void> {
    const user = this.cls.get('user');
    if (!user?.id || typeof user.id !== 'string') {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }
    const profile = await this.safeResolve(() => this.userVoiceProfileRepository.findById(profileId));
    if (profile === null || profile === undefined) {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }
    const owningUserId = (profile as { userId?: string | null }).userId;
    if (!owningUserId || owningUserId !== user.id) {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }
  }

  /**
   * Tolerate both repository failure shapes (returns `null` *or* throws
   * `DataNotFoundException`) — mirrors `assertParentInScope` in
   * `packages/applications/src/common/tenant-guards.ts`.
   */
  private async safeResolve<T>(finder: () => Promise<T | null | undefined>): Promise<T | null> {
    try {
      const value = await finder();
      return value ?? null;
    } catch (err) {
      if (err instanceof DataNotFoundException) {
        return null;
      }
      throw err;
    }
  }
}
