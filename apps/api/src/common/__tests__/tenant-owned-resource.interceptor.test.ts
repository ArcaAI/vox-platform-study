/**
 * `TenantOwnedResourceInterceptor` — unit tests.
 *
 * Pins the runtime contract every controller applying the decorator depends on:
 *
 *  1. Handler with NO `@TenantOwnedResource` metadata → interceptor is a
 *     pass-through (next.handle() invoked, no resource lookup, no CLS read).
 *  2. Matched tenant → next.handle() invoked.
 *  3. Mismatched tenant → `NotFoundException('Resource not found')`
 *     (DEF-C3 "no existence leak").
 *  4. Missing CLS tenantId → `NotFoundException('Resource not found')`.
 *  5. Missing route param value → `NotFoundException('Resource not found')`.
 *  6. Resource not found (repository returns null OR throws
 *     `DataNotFoundException`) → `NotFoundException('Resource not found')`.
 *  7. `lookup: 'name'` routes to the repository's `findByName(name)`
 *     instead of `findById(id)`.
 *  8. `UserVoiceProfile` is a user-scoped resource — the interceptor
 *     resolves the profile, then enforces
 *     `profile.userId === cls.user.id` (existing service-layer semantic),
 *     emitting the same 404 on mismatch.
 *  9. `ConsultationJob` is resolved via `IConsultationJobService.getJobStatus(jobId)`
 *     — the status struct carries `tenantId` after W3.3.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException, type ExecutionContext, type CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataNotFoundException } from '@arcaai/exceptions';
import { of, firstValueFrom } from 'rxjs';
import { TenantOwnedResource, TENANT_OWNED_RESOURCE_KEY } from '../tenant-owned-resource.decorator';
import { TenantOwnedResourceInterceptor } from '../tenant-owned-resource.interceptor';

const NEXT_VALUE = Symbol('passthrough');
const SENTINEL_TENANT_A = 'tenant-A';
const SENTINEL_TENANT_B = 'tenant-B';

interface MockRepoSet {
  tenantBucket: { findById: ReturnType<typeof vi.fn>; findByName: ReturnType<typeof vi.fn> };
  tenantStorageConfig: { findById: ReturnType<typeof vi.fn> };
  userVoiceProfile: { findById: ReturnType<typeof vi.fn> };
  transcriptionJob: { findById: ReturnType<typeof vi.fn> };
  // Clinical Workflow Playground (WS1): backs the `Consultation` resolver branch.
  consultation: { findById: ReturnType<typeof vi.fn> };
}

interface MockServices {
  consultationJob: { getJobStatus: ReturnType<typeof vi.fn> };
  // Mocks the `StreamSession` resolver branch.
  streamSessionTenantBinding: { lookup: ReturnType<typeof vi.fn> };
}

function buildHarness(opts: { reflectorReturns?: unknown; clsState?: Record<string, unknown>; params?: Record<string, string> }) {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(opts.reflectorReturns ?? undefined),
  } as unknown as Reflector;

  const cls = {
    get: vi.fn((key: string) => opts.clsState?.[key]),
  };

  const repos: MockRepoSet = {
    tenantBucket: {
      findById: vi.fn(),
      findByName: vi.fn(),
    },
    tenantStorageConfig: {
      findById: vi.fn(),
    },
    userVoiceProfile: {
      findById: vi.fn(),
    },
    transcriptionJob: {
      findById: vi.fn(),
    },
    consultation: {
      findById: vi.fn(),
    },
  };

  const services: MockServices = {
    consultationJob: {
      getJobStatus: vi.fn(),
    },
    streamSessionTenantBinding: {
      lookup: vi.fn(),
    },
  };

  const interceptor = new TenantOwnedResourceInterceptor(
    reflector,
    cls as never,
    repos.tenantBucket as never,
    repos.tenantStorageConfig as never,
    repos.userVoiceProfile as never,
    repos.transcriptionJob as never,
    repos.consultation as never,
    services.consultationJob as never,
    services.streamSessionTenantBinding as never,
  );

  const next: CallHandler = {
    handle: vi.fn().mockReturnValue(of(NEXT_VALUE)),
  };

  const ctx = {
    getHandler: vi.fn().mockReturnValue(() => undefined),
    getClass: vi.fn().mockReturnValue(class {}),
    switchToHttp: () => ({
      getRequest: () => ({ params: opts.params ?? {} }),
    }),
  } as unknown as ExecutionContext;

  return { interceptor, reflector, cls, repos, services, ctx, next };
}

describe('TenantOwnedResourceInterceptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes through when the handler is NOT decorated', async () => {
    const harness = buildHarness({ reflectorReturns: undefined });

    const result = await firstValueFrom(await harness.interceptor.intercept(harness.ctx, harness.next));

    expect(result).toBe(NEXT_VALUE);
    expect(harness.next.handle).toHaveBeenCalledTimes(1);
    expect(harness.repos.tenantBucket.findById).not.toHaveBeenCalled();
  });

  describe('TenantBucket — id lookup', () => {
    it('passes through when the bucket tenant matches CLS tenantId', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'TenantBucket', paramName: 'id' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { id: 'bucket-1' },
      });
      harness.repos.tenantBucket.findById.mockResolvedValueOnce({
        id: 'bucket-1',
        tenantId: SENTINEL_TENANT_A,
      });

      const result = await firstValueFrom(await harness.interceptor.intercept(harness.ctx, harness.next));

      expect(result).toBe(NEXT_VALUE);
      expect(harness.repos.tenantBucket.findById).toHaveBeenCalledWith('bucket-1');
      expect(harness.next.handle).toHaveBeenCalledTimes(1);
    });

    it('throws 404 when the bucket tenant does NOT match CLS tenantId (cross-tenant probe)', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'TenantBucket', paramName: 'id' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { id: 'bucket-1' },
      });
      harness.repos.tenantBucket.findById.mockResolvedValueOnce({
        id: 'bucket-1',
        tenantId: SENTINEL_TENANT_B,
      });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
      try {
        await harness.interceptor.intercept(harness.ctx, harness.next);
      } catch (err) {
        expect((err as NotFoundException).message).toBe('Resource not found');
      }
      expect(harness.next.handle).not.toHaveBeenCalled();
    });

    it('throws 404 when CLS tenantId is missing', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'TenantBucket', paramName: 'id' },
        clsState: {},
        params: { id: 'bucket-1' },
      });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
      expect(harness.repos.tenantBucket.findById).not.toHaveBeenCalled();
      expect(harness.next.handle).not.toHaveBeenCalled();
    });

    it('allows an unscoped super admin on explicitly super-admin scoped routes', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'TenantBucket', paramName: 'id', scope: 'super-admin' },
        clsState: { user: { roles: ['SUPER_ADMIN'] } },
        params: { id: 'bucket-1' },
      });

      const result = await firstValueFrom(await harness.interceptor.intercept(harness.ctx, harness.next));

      expect(result).toBe(NEXT_VALUE);
      expect(harness.repos.tenantBucket.findById).not.toHaveBeenCalled();
      expect(harness.next.handle).toHaveBeenCalledTimes(1);
    });

    it('keeps super-admin scoped routes tenant-scoped when super admin selected a tenant', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'TenantBucket', paramName: 'id', scope: 'super-admin' },
        clsState: { tenantId: SENTINEL_TENANT_A, user: { roles: ['SUPER_ADMIN'] } },
        params: { id: 'bucket-1' },
      });
      harness.repos.tenantBucket.findById.mockResolvedValueOnce({ id: 'bucket-1', tenantId: SENTINEL_TENANT_B });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
      expect(harness.next.handle).not.toHaveBeenCalled();
    });

    it('rejects an unscoped non-super admin on explicitly super-admin scoped routes', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'TenantBucket', paramName: 'id', scope: 'super-admin' },
        clsState: { user: { roles: ['TENANT_ADMIN'] } },
        params: { id: 'bucket-1' },
      });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
      expect(harness.next.handle).not.toHaveBeenCalled();
    });

    it('throws 404 when the route param is missing or empty', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'TenantBucket', paramName: 'id' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: {},
      });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
    });

    it('throws 404 when the repository returns null', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'TenantBucket', paramName: 'id' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { id: 'bucket-1' },
      });
      harness.repos.tenantBucket.findById.mockResolvedValueOnce(null);

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
    });

    it('throws 404 when the repository throws DataNotFoundException', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'TenantBucket', paramName: 'id' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { id: 'bucket-1' },
      });
      harness.repos.tenantBucket.findById.mockRejectedValueOnce(new DataNotFoundException('TenantBucket', 'bucket-1'));

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
    });
  });

  describe('TenantBucket — name lookup (StorageController)', () => {
    it('routes to repository.findByName when lookup="name"', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'TenantBucket', paramName: 'name', lookup: 'name' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { name: 'tenant-a-audio' },
      });
      harness.repos.tenantBucket.findByName.mockResolvedValueOnce({
        id: 'bucket-1',
        name: 'tenant-a-audio',
        tenantId: SENTINEL_TENANT_A,
      });

      const result = await firstValueFrom(await harness.interceptor.intercept(harness.ctx, harness.next));

      expect(result).toBe(NEXT_VALUE);
      expect(harness.repos.tenantBucket.findByName).toHaveBeenCalledWith('tenant-a-audio');
      expect(harness.repos.tenantBucket.findById).not.toHaveBeenCalled();
    });

    it('throws 404 on cross-tenant bucket name probe', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'TenantBucket', paramName: 'name', lookup: 'name' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { name: 'tenant-b-audio' },
      });
      harness.repos.tenantBucket.findByName.mockResolvedValueOnce({
        id: 'bucket-2',
        name: 'tenant-b-audio',
        tenantId: SENTINEL_TENANT_B,
      });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
    });
  });

  describe('UserVoiceProfile — user-scoped lookup', () => {
    it('passes through when the profile.userId matches the CLS user.id', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'UserVoiceProfile', paramName: 'id' },
        clsState: {
          tenantId: SENTINEL_TENANT_A,
          user: { id: 'user-1', tenantId: SENTINEL_TENANT_A },
        },
        params: { id: 'vp-1' },
      });
      harness.repos.userVoiceProfile.findById.mockResolvedValueOnce({
        id: 'vp-1',
        userId: 'user-1',
      });

      const result = await firstValueFrom(await harness.interceptor.intercept(harness.ctx, harness.next));

      expect(result).toBe(NEXT_VALUE);
      expect(harness.repos.userVoiceProfile.findById).toHaveBeenCalledWith('vp-1');
    });

    it('throws 404 when a different user (same tenant or cross-tenant) probes the profile', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'UserVoiceProfile', paramName: 'id' },
        clsState: {
          tenantId: SENTINEL_TENANT_A,
          user: { id: 'attacker-user', tenantId: SENTINEL_TENANT_A },
        },
        params: { id: 'vp-1' },
      });
      harness.repos.userVoiceProfile.findById.mockResolvedValueOnce({
        id: 'vp-1',
        userId: 'victim-user',
      });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
      expect(harness.next.handle).not.toHaveBeenCalled();
    });

    it('throws 404 when the CLS user is missing', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'UserVoiceProfile', paramName: 'id' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { id: 'vp-1' },
      });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
      expect(harness.repos.userVoiceProfile.findById).not.toHaveBeenCalled();
    });
  });

  describe('ConsultationJob — service-resolved status struct', () => {
    it('passes through when the status struct tenant matches CLS tenantId', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'ConsultationJob', paramName: 'jobId' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { jobId: 'job-1' },
      });
      harness.services.consultationJob.getJobStatus.mockResolvedValueOnce({
        jobId: 'job-1',
        tenantId: SENTINEL_TENANT_A,
        userId: 'user-1',
      });

      const result = await firstValueFrom(await harness.interceptor.intercept(harness.ctx, harness.next));

      expect(result).toBe(NEXT_VALUE);
      expect(harness.services.consultationJob.getJobStatus).toHaveBeenCalledWith('job-1');
    });

    it('throws 404 on cross-tenant job probe', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'ConsultationJob', paramName: 'jobId' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { jobId: 'job-1' },
      });
      harness.services.consultationJob.getJobStatus.mockResolvedValueOnce({
        jobId: 'job-1',
        tenantId: SENTINEL_TENANT_B,
        userId: 'attacker',
      });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
    });

    it('throws 404 when the job status is null (missing or expired)', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'ConsultationJob', paramName: 'jobId' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { jobId: 'missing-id' },
      });
      harness.services.consultationJob.getJobStatus.mockResolvedValueOnce(null);

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
    });
  });

  describe('TranscriptionJob — tenant-scoped lookup', () => {
    it('passes through when transcription job tenant matches', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'TranscriptionJob', paramName: 'id' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { id: 'job-1' },
      });
      harness.repos.transcriptionJob.findById.mockResolvedValueOnce({
        id: 'job-1',
        tenantId: SENTINEL_TENANT_A,
      });

      const result = await firstValueFrom(await harness.interceptor.intercept(harness.ctx, harness.next));

      expect(result).toBe(NEXT_VALUE);
    });

    it('throws 404 on cross-tenant transcription-job probe', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'TranscriptionJob', paramName: 'id' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { id: 'job-1' },
      });
      harness.repos.transcriptionJob.findById.mockResolvedValueOnce({
        id: 'job-1',
        tenantId: SENTINEL_TENANT_B,
      });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
    });
  });

  describe('TenantStorageConfig — tenant-scoped lookup', () => {
    it('passes through when the config tenant matches the caller', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'TenantStorageConfig', paramName: 'id' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { id: 'cfg-1' },
      });
      harness.repos.tenantStorageConfig.findById.mockResolvedValueOnce({ id: 'cfg-1', tenantId: SENTINEL_TENANT_A });

      const result = await firstValueFrom(await harness.interceptor.intercept(harness.ctx, harness.next));

      expect(result).toBe(NEXT_VALUE);
      expect(harness.repos.tenantStorageConfig.findById).toHaveBeenCalledWith('cfg-1');
    });

    it('throws 404 on a cross-tenant storage-config probe', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'TenantStorageConfig', paramName: 'id' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { id: 'cfg-1' },
      });
      harness.repos.tenantStorageConfig.findById.mockResolvedValueOnce({ id: 'cfg-1', tenantId: SENTINEL_TENANT_B });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // `scope: 'creator'` opt-in (intra-tenant ownership).
  //
  // The default `scope` (omitted, or `'tenant'`) keeps the tenant-only
  // semantic. Setting `scope: 'creator'` additionally requires
  // `status.userId === cls.user.id` after the tenant check passes. The 404
  // (no-existence-leak) shape stays identical so a same-tenant probe of a
  // peer's job is indistinguishable from a probe of a non-existent job.
  // ─────────────────────────────────────────────────────────────────────
  describe('ConsultationJob — scope:"creator"', () => {
    it('passes through when same-tenant AND same-user (job owner)', async () => {
      const harness = buildHarness({
        reflectorReturns: {
          modelName: 'ConsultationJob',
          paramName: 'jobId',
          scope: 'creator',
        },
        clsState: {
          tenantId: SENTINEL_TENANT_A,
          user: { id: 'user-1', tenantId: SENTINEL_TENANT_A },
        },
        params: { jobId: 'job-1' },
      });
      harness.services.consultationJob.getJobStatus.mockResolvedValueOnce({
        jobId: 'job-1',
        tenantId: SENTINEL_TENANT_A,
        userId: 'user-1',
      });

      const result = await firstValueFrom(await harness.interceptor.intercept(harness.ctx, harness.next));

      expect(result).toBe(NEXT_VALUE);
      expect(harness.next.handle).toHaveBeenCalledTimes(1);
    });

    it('throws 404 on same-tenant cross-user probe (peer cannot mutate)', async () => {
      const harness = buildHarness({
        reflectorReturns: {
          modelName: 'ConsultationJob',
          paramName: 'jobId',
          scope: 'creator',
        },
        clsState: {
          tenantId: SENTINEL_TENANT_A,
          user: { id: 'attacker-user', tenantId: SENTINEL_TENANT_A },
        },
        params: { jobId: 'job-1' },
      });
      harness.services.consultationJob.getJobStatus.mockResolvedValueOnce({
        jobId: 'job-1',
        tenantId: SENTINEL_TENANT_A,
        userId: 'victim-user',
      });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
      expect(harness.next.handle).not.toHaveBeenCalled();
    });

    it('throws 404 on cross-tenant probe regardless of scope:"creator"', async () => {
      const harness = buildHarness({
        reflectorReturns: {
          modelName: 'ConsultationJob',
          paramName: 'jobId',
          scope: 'creator',
        },
        clsState: {
          tenantId: SENTINEL_TENANT_A,
          user: { id: 'user-1', tenantId: SENTINEL_TENANT_A },
        },
        params: { jobId: 'job-1' },
      });
      harness.services.consultationJob.getJobStatus.mockResolvedValueOnce({
        jobId: 'job-1',
        tenantId: SENTINEL_TENANT_B,
        userId: 'user-1',
      });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
      expect(harness.next.handle).not.toHaveBeenCalled();
    });

    it('throws 404 when scope:"creator" but CLS user is missing', async () => {
      const harness = buildHarness({
        reflectorReturns: {
          modelName: 'ConsultationJob',
          paramName: 'jobId',
          scope: 'creator',
        },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { jobId: 'job-1' },
      });
      harness.services.consultationJob.getJobStatus.mockResolvedValueOnce({
        jobId: 'job-1',
        tenantId: SENTINEL_TENANT_A,
        userId: 'user-1',
      });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
    });

    it('throws 404 when scope:"creator" but the job status carries no userId (pre-W7.A.12 Redis row)', async () => {
      const harness = buildHarness({
        reflectorReturns: {
          modelName: 'ConsultationJob',
          paramName: 'jobId',
          scope: 'creator',
        },
        clsState: {
          tenantId: SENTINEL_TENANT_A,
          user: { id: 'user-1', tenantId: SENTINEL_TENANT_A },
        },
        params: { jobId: 'job-1' },
      });
      // Legacy Redis row — tenantId present but userId absent. The
      // interceptor must 404, not crash.
      harness.services.consultationJob.getJobStatus.mockResolvedValueOnce({
        jobId: 'job-1',
        tenantId: SENTINEL_TENANT_A,
      });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * StreamSession resolver branch.
   *
   * The sessionId is opaque to Prisma; the interceptor consults the
   * gateway-side `StreamSessionTenantBindingService.lookup(sessionId)`
   * and 404s on missing binding or tenant mismatch. The handler must
   * never run for a cross-tenant probe (DEF-C3 no-existence-leak).
   */
  describe('StreamSession (lookup: "session")', () => {
    it('passes through when the bound tenant matches CLS tenantId', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'StreamSession', paramName: 'sessionId', lookup: 'session' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { sessionId: 'sess-1' },
      });
      harness.services.streamSessionTenantBinding.lookup.mockResolvedValueOnce(SENTINEL_TENANT_A);

      const result = await firstValueFrom(await harness.interceptor.intercept(harness.ctx, harness.next));

      expect(result).toBe(NEXT_VALUE);
      expect(harness.services.streamSessionTenantBinding.lookup).toHaveBeenCalledWith('sess-1');
      expect(harness.next.handle).toHaveBeenCalledTimes(1);
    });

    it('throws 404 on cross-tenant probe (bound tenant != caller)', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'StreamSession', paramName: 'sessionId', lookup: 'session' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { sessionId: 'sess-1' },
      });
      harness.services.streamSessionTenantBinding.lookup.mockResolvedValueOnce(SENTINEL_TENANT_B);

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
      expect(harness.next.handle).not.toHaveBeenCalled();
    });

    it('throws 404 when no binding exists (lookup returns null)', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'StreamSession', paramName: 'sessionId', lookup: 'session' },
        clsState: { tenantId: SENTINEL_TENANT_A },
        params: { sessionId: 'unbound-sess' },
      });
      harness.services.streamSessionTenantBinding.lookup.mockResolvedValueOnce(null);

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
      expect(harness.next.handle).not.toHaveBeenCalled();
    });

    it('throws 404 when CLS tenantId is missing (guard runs before binding lookup)', async () => {
      const harness = buildHarness({
        reflectorReturns: { modelName: 'StreamSession', paramName: 'sessionId', lookup: 'session' },
        clsState: {},
        params: { sessionId: 'sess-1' },
      });

      await expect(harness.interceptor.intercept(harness.ctx, harness.next)).rejects.toThrow(NotFoundException);
      expect(harness.services.streamSessionTenantBinding.lookup).not.toHaveBeenCalled();
    });
  });

  describe('Reflector contract', () => {
    it('looks up the metadata using TENANT_OWNED_RESOURCE_KEY via getAllAndOverride(handler, class)', async () => {
      const harness = buildHarness({ reflectorReturns: undefined });
      await firstValueFrom(await harness.interceptor.intercept(harness.ctx, harness.next));

      expect(harness.reflector.getAllAndOverride).toHaveBeenCalledTimes(1);
      const [key, targets] = (harness.reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(key).toBe(TENANT_OWNED_RESOURCE_KEY);
      expect(Array.isArray(targets)).toBe(true);
      expect((targets as unknown[]).length).toBe(2);
    });

    // Sanity-pin: the `@TenantOwnedResource` decorator from W3.1 is the
    // same key the interceptor reads. Catches drift between the two files.
    it('the W3.1 decorator emits metadata under the same key the interceptor reads', () => {
      class Probe {
        @TenantOwnedResource({ modelName: 'TenantBucket', paramName: 'id' })
        handler(): void {}
      }
      const meta = Reflect.getMetadata(TENANT_OWNED_RESOURCE_KEY, Probe.prototype.handler);
      expect(meta).toMatchObject({ modelName: 'TenantBucket', paramName: 'id' });
    });
  });
});
