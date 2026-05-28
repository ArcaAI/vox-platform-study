/**
 * `TenantOwnedResourceInterceptor` — TASK-307 W3.2 / AC-7.
 *
 * Global interceptor that, for every handler annotated with
 * `@TenantOwnedResource(...)`, resolves the addressed resource via the
 * matching repository (or service) and asserts the resource's tenant matches
 * the caller's CLS tenant before letting the handler run.
 *
 * The 404 response on tenant mismatch (DEF-C3 "no existence leak") is the
 * uniform behaviour — there is no `@PlatformAdmin()` bypass per the W3 plan
 * decision (`docs/implementation/TASK-307-API-Gateway-Hardening/README.md`
 * §1.5). SUPER_ADMIN cross-tenant access continues to flow through service
 * methods that opt in explicitly (e.g. `TenantService.fetchById`).
 *
 * Model-specific resolution rules:
 *
 *   - `TenantBucket`      — repo.findById(id) OR repo.findByName(name);
 *                           assert `entity.tenantId === cls.tenantId`.
 *   - `TranscriptionJob`  — repo.findById(id); assert
 *                           `entity.tenantId === cls.tenantId`.
 *   - `ConsultationJob`   — `jobService.getJobStatus(jobId)`; status struct
 *                           carries `tenantId` after W3.3. Assert
 *                           `status.tenantId === cls.tenantId`.
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
import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { Observable } from 'rxjs';
import { DataNotFoundException } from '@arcaai/exceptions';
import { IConsultationJobService, type IActiveUserContext } from '@arcaai/applications';
import {
  TenantBucketRepository,
  TranscriptionJobRepository,
  UserVoiceProfileRepository,
} from '@arcaai/domains';
import { StreamSessionTenantBindingService } from './stream-session-tenant-binding.service';
import {
  TENANT_OWNED_RESOURCE_KEY,
  type TenantOwnedResourceOptions,
} from './tenant-owned-resource.decorator';

/** Generic 404 used everywhere (DEF-C3 no-existence-leak). */
const RESOURCE_NOT_FOUND = 'Resource not found';

@Injectable()
export class TenantOwnedResourceInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly tenantBucketRepository: TenantBucketRepository,
    private readonly userVoiceProfileRepository: UserVoiceProfileRepository,
    private readonly transcriptionJobRepository: TranscriptionJobRepository,
    @Inject(IConsultationJobService)
    private readonly consultationJobService: IConsultationJobService,
    // TASK-310 W7.A.9 (AC-3): drives the `StreamSession` resolver branch.
    // The binding is written by `TranscriptionJobController.createStreamSession`
    // and removed by `closeStreamSession` — the interceptor only reads it.
    private readonly streamSessionTenantBinding: StreamSessionTenantBindingService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const opts = this.reflector.getAllAndOverride<TenantOwnedResourceOptions | undefined>(
      TENANT_OWNED_RESOURCE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!opts) {
      // Handler not annotated — pass-through. Avoids any CLS/repo cost for
      // the overwhelming majority of routes that don't use the decorator.
      return next.handle();
    }

    const callerTenantId = this.cls.get('tenantId');
    if (!callerTenantId || typeof callerTenantId !== 'string') {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }

    const request = context.switchToHttp().getRequest<{ params?: Record<string, string> }>();
    const paramValue = request?.params?.[opts.paramName];
    if (!paramValue || typeof paramValue !== 'string') {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }

    await this.assertOwnership(opts, paramValue, callerTenantId);

    return next.handle();
  }

  private async assertOwnership(
    opts: TenantOwnedResourceOptions,
    paramValue: string,
    callerTenantId: string,
  ): Promise<void> {
    switch (opts.modelName) {
      case 'TenantBucket':
        await this.assertTenantBucket(opts, paramValue, callerTenantId);
        return;
      case 'TranscriptionJob':
        await this.assertTenantScoped(
          () => this.transcriptionJobRepository.findById(paramValue),
          callerTenantId,
        );
        return;
      case 'ConsultationJob':
        await this.assertConsultationJob(opts, paramValue, callerTenantId);
        return;
      case 'UserVoiceProfile':
        await this.assertVoiceProfileOwnership(paramValue);
        return;
      case 'StreamSession':
        // TASK-310 W7.A.9 (AC-3): sessionId → tenantId lookup via the
        // gateway-side binding service (the session itself lives in
        // STT-V2 / Redis, not Prisma — there is no repository to call).
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

  private async assertStreamSessionOwnership(sessionId: string, callerTenantId: string): Promise<void> {
    const boundTenantId = await this.streamSessionTenantBinding.lookup(sessionId);
    if (boundTenantId === null || boundTenantId !== callerTenantId) {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }
  }

  private async assertTenantBucket(
    opts: TenantOwnedResourceOptions,
    paramValue: string,
    callerTenantId: string,
  ): Promise<void> {
    const lookup = opts.lookup ?? 'id';
    const finder = lookup === 'name'
      ? () => this.tenantBucketRepository.findByName(paramValue)
      : () => this.tenantBucketRepository.findById(paramValue);
    await this.assertTenantScoped(finder, callerTenantId);
  }

  private async assertTenantScoped(
    finder: () => Promise<{ tenantId?: string | null } | null | undefined>,
    callerTenantId: string,
  ): Promise<void> {
    const entity = await this.safeResolve(finder);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }
    if (!entity.tenantId || entity.tenantId !== callerTenantId) {
      throw new NotFoundException(RESOURCE_NOT_FOUND);
    }
  }

  private async assertConsultationJob(
    opts: TenantOwnedResourceOptions,
    jobId: string,
    callerTenantId: string,
  ): Promise<void> {
    let status: { tenantId?: string | null; userId?: string | null } | null;
    try {
      status = (await this.consultationJobService.getJobStatus(jobId)) as
        | { tenantId?: string | null; userId?: string | null }
        | null;
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

    // TASK-308 AC-1 — `scope: 'creator'` adds the intra-tenant owner check.
    // The `userId` on `ConsultationJobStatus` was introduced in TASK-307
    // W3.3; pre-W7.A.12 Redis rows may still lack it (24h JOB_TTL window).
    // Treating a missing `userId` as a mismatch keeps the 404 shape uniform
    // and avoids leaking the legacy-row distinction. See ticket §2.3.
    if (opts.scope === 'creator') {
      const callerUserId = this.cls.get('user')?.id;
      if (!callerUserId || typeof callerUserId !== 'string') {
        throw new NotFoundException(RESOURCE_NOT_FOUND);
      }
      if (!status.userId || status.userId !== callerUserId) {
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
