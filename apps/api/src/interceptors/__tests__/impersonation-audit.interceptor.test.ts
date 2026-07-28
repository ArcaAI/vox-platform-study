/**
 * Impersonation Audit Interceptor Tests
 *
 * The interceptor detects requests from impersonated sessions
 * (JWT contains `impersonatedBy` claim) and emits an audit event
 * via EventEmitter2.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, firstValueFrom } from 'rxjs';
import { EventTypes } from '@arcaai/domains';

describe('ImpersonationAuditInterceptor', () => {
  let interceptor: any;
  let mockClsService: any;
  let mockEventEmitter: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockClsService = {
      get: vi.fn(),
      set: vi.fn(),
    };

    mockEventEmitter = {
      emit: vi.fn(),
    };

    const { ImpersonationAuditInterceptor } = await import('../impersonation-audit.interceptor');
    interceptor = new ImpersonationAuditInterceptor(mockClsService, mockEventEmitter);
  });

  function createMockContext(
    overrides: {
      user?: any;
      ip?: string;
      userAgent?: string;
      method?: string;
      url?: string;
    } = {},
  ): ExecutionContext {
    const request = {
      ip: overrides.ip ?? '127.0.0.1',
      method: overrides.method ?? 'GET',
      url: overrides.url ?? '/api/consultations',
      headers: {
        'user-agent': overrides.userAgent ?? 'test-agent',
      },
      user: overrides.user ?? null,
    };

    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ statusCode: 200 }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  function createMockCallHandler(returnValue: any = { ok: true }): CallHandler {
    return {
      handle: () => of(returnValue),
    };
  }

  // =========================================================================
  // Core behavior: detect impersonation
  // =========================================================================

  describe('impersonation detection', () => {
    it('should pass through non-impersonated requests without emitting', async () => {
      mockClsService.get.mockReturnValue({
        id: 'user-001',
        username: 'regular_user',
      });

      const context = createMockContext();
      const result = await firstValueFrom(interceptor.intercept(context, createMockCallHandler()));

      expect(result).toEqual({ ok: true });
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should emit audit event when impersonatedBy claim is present', async () => {
      mockClsService.get.mockReturnValue({
        id: 'doctor-001',
        username: 'dr_smith',
        impersonatedBy: 'admin-001',
      });

      const context = createMockContext({
        method: 'POST',
        url: '/api/consultations/open',
      });

      await firstValueFrom(interceptor.intercept(context, createMockCallHandler()));

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        EventTypes.UserAuthenticated,
        expect.objectContaining({
          userId: 'admin-001',
          endpoint: '/api/consultations/open',
          method: 'POST',
        }),
      );
    });

    it('should include impersonatedUserId in the emitted event', async () => {
      mockClsService.get.mockReturnValue({
        id: 'doctor-001',
        username: 'dr_smith',
        impersonatedBy: 'admin-001',
      });

      const context = createMockContext({
        method: 'GET',
        url: '/api/patients',
      });

      await firstValueFrom(interceptor.intercept(context, createMockCallHandler()));

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        EventTypes.UserAuthenticated,
        expect.objectContaining({
          impersonatedUserId: 'doctor-001',
        }),
      );
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('should not fail when CLS user is null (unauthenticated)', async () => {
      mockClsService.get.mockReturnValue(null);

      const context = createMockContext();
      const result = await firstValueFrom(interceptor.intercept(context, createMockCallHandler()));

      expect(result).toEqual({ ok: true });
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should not fail when CLS user has no impersonatedBy field', async () => {
      mockClsService.get.mockReturnValue({
        id: 'user-001',
      });

      const context = createMockContext();
      const result = await firstValueFrom(interceptor.intercept(context, createMockCallHandler()));

      expect(result).toEqual({ ok: true });
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should still return the response even if event emission throws', async () => {
      mockClsService.get.mockReturnValue({
        id: 'doctor-001',
        impersonatedBy: 'admin-001',
      });
      mockEventEmitter.emit.mockImplementation(() => {
        throw new Error('event bus down');
      });

      const context = createMockContext();
      const result = await firstValueFrom(interceptor.intercept(context, createMockCallHandler({ data: 'sensitive' })));

      expect(result).toEqual({ data: 'sensitive' });
    });

    it('should capture the client IP from the request', async () => {
      mockClsService.get.mockReturnValue({
        id: 'doctor-001',
        impersonatedBy: 'admin-001',
      });

      const context = createMockContext({ ip: '192.168.1.42' });

      await firstValueFrom(interceptor.intercept(context, createMockCallHandler()));

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        EventTypes.UserAuthenticated,
        expect.objectContaining({
          ip: '192.168.1.42',
        }),
      );
    });
  });

  // =========================================================================
  // Class structure
  // =========================================================================

  describe('class structure', () => {
    it('should implement NestInterceptor interface (has intercept method)', () => {
      expect(typeof interceptor.intercept).toBe('function');
    });
  });
});
