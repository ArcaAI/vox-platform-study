/**
 * AuthController#issueStreamTicket — unit tests (TASK-263 W0-1)
 *
 * Verifies the new `POST /auth/stream-ticket` endpoint that issues a
 * single-use, 30-second SSE ticket scoped to a specific resource. The
 * caller is identified by the existing JWT context (ClsService).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AuthController } from '../auth.controller';

function buildController(opts: {
  cls?: { get: (key: string) => unknown };
  streamTicketService?: {
    issueTicket: ReturnType<typeof vi.fn>;
    consumeTicket: ReturnType<typeof vi.fn>;
  };
  jwtRevocationService?: {
    revoke: ReturnType<typeof vi.fn>;
    isRevoked: ReturnType<typeof vi.fn>;
  };
  consultationRepository?: { findById: ReturnType<typeof vi.fn> };
} = {}) {
  const cls = opts.cls ?? { get: () => null };
  const streamTicketService =
    opts.streamTicketService ?? {
      issueTicket: vi.fn(),
      consumeTicket: vi.fn(),
    };
  const jwtRevocationService =
    opts.jwtRevocationService ?? {
      revoke: vi.fn(),
      isRevoked: vi.fn().mockResolvedValue(false),
    };
  const consultationRepository = opts.consultationRepository ?? { findById: vi.fn() };

  return {
    controller: new AuthController(
      {} as never, // userService
      {} as never, // authService
      {} as never, // appSettingsService
      {} as never, // userRoleAssignmentService
      {} as never, // userRepository
      {} as never, // userRoleAssignmentRepository
      {} as never, // roleRepository
      {} as never, // tenantRepository
      cls as never, // clsService
      streamTicketService as never, // streamTicketService
      jwtRevocationService as never, // jwtRevocationService
      {} as never, // secretsService (TASK-307 W2.3; not exercised by stream-ticket paths)
      {} as never, // refreshTokenService
      {} as never, // userDepartmentService
      {} as never, // eventEmitter
      consultationRepository as never, // consultationRepository (TASK-341 B4)
    ),
    streamTicketService,
    jwtRevocationService,
    consultationRepository,
  };
}

describe('AuthController.issueStreamTicket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('issues a ticket scoped to the requested resource for the authenticated user', async () => {
    const issueTicket = vi.fn(async () => ({
      ticket: 'tkt-1',
      expiresAt: 1700000030000,
      scope: 'consultation_job:job-1',
    }));
    const { controller } = buildController({
      cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
    });

    const result = await controller.issueStreamTicket({ scope: 'consultation_job:job-1' });

    expect(issueTicket).toHaveBeenCalledWith({
      userId: 'user-1',
      tenantId: 'tenant-1',
      scope: 'consultation_job:job-1',
      impersonatedBy: null,
    });
    expect(result).toEqual({
      ticket: 'tkt-1',
      expiresAt: 1700000030000,
      scope: 'consultation_job:job-1',
    });
  });

  it('falls back to tenantId from CLS context when not on the user object', async () => {
    const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 's' }));
    const { controller } = buildController({
      cls: {
        get: (key: string) => {
          if (key === 'user') return { id: 'user-1' };
          if (key === 'tenantId') return 'tenant-from-cls';
          return null;
        },
      },
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
    });

    await controller.issueStreamTicket({ scope: 's' });

    expect(issueTicket).toHaveBeenCalledWith({
      userId: 'user-1',
      tenantId: 'tenant-from-cls',
      scope: 's',
      impersonatedBy: null,
    });
  });

  it('carries impersonatedBy through to the ticket payload (TASK-295 SEC-A5-6)', async () => {
    const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 's' }));
    const { controller } = buildController({
      cls: {
        get: (key: string) =>
          key === 'user'
            ? { id: 'doctor-001', tenantId: 'tenant-acme', impersonatedBy: 'admin-007' }
            : null,
      },
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
    });

    await controller.issueStreamTicket({ scope: 'consultation_job:job-1' });

    expect(issueTicket).toHaveBeenCalledWith({
      userId: 'doctor-001',
      tenantId: 'tenant-acme',
      scope: 'consultation_job:job-1',
      impersonatedBy: 'admin-007',
    });
  });

  it('throws UnauthorizedException when no user is present in the CLS context', async () => {
    const { controller } = buildController({
      cls: { get: () => null },
    });

    await expect(
      controller.issueStreamTicket({ scope: 'consultation_job:job-1' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('handler is bound to HTTP POST on path "stream-ticket"', () => {
    const path = Reflect.getMetadata(PATH_METADATA, AuthController.prototype.issueStreamTicket);
    const method = Reflect.getMetadata(METHOD_METADATA, AuthController.prototype.issueStreamTicket);
    expect(path).toBe('stream-ticket');
    expect(method).toBe(RequestMethod.POST);
  });

  // TASK-341 B4 — defense-in-depth at mint time for live-summary tickets.
  // The SSE route is @TenantOwnedResource, but a ticket bypasses that
  // interceptor, so a `consultation_live_summary:<id>` ticket may only be
  // minted for a consultation in the caller's (active) tenant.
  describe('live-summary scope ownership (TASK-341 B4)', () => {
    it('mints a live-summary ticket when the consultation belongs to the caller tenant', async () => {
      const issueTicket = vi.fn(async () => ({ ticket: 'tkt', expiresAt: 1, scope: 'consultation_live_summary:c-1' }));
      const findById = vi.fn().mockResolvedValue({ id: 'c-1', tenantId: 'tenant-1' });
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        consultationRepository: { findById },
      });

      await controller.issueStreamTicket({ scope: 'consultation_live_summary:c-1' });

      expect(findById).toHaveBeenCalledWith('c-1');
      expect(issueTicket).toHaveBeenCalledWith({
        userId: 'user-1',
        tenantId: 'tenant-1',
        scope: 'consultation_live_summary:c-1',
        impersonatedBy: null,
      });
    });

    it('throws NotFoundException and never mints when the consultation is missing', async () => {
      const issueTicket = vi.fn();
      const findById = vi.fn().mockRejectedValue(new Error('not found'));
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        consultationRepository: { findById },
      });

      await expect(controller.issueStreamTicket({ scope: 'consultation_live_summary:missing' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('throws NotFoundException (no existence leak) when the consultation belongs to another tenant', async () => {
      const issueTicket = vi.fn();
      const findById = vi.fn().mockResolvedValue({ id: 'c-9', tenantId: 'tenant-OTHER' });
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        consultationRepository: { findById },
      });

      await expect(controller.issueStreamTicket({ scope: 'consultation_live_summary:c-9' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it("propagates a super-admin's selected X-Tenant-Id into the ticket and checks ownership against it", async () => {
      const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 'consultation_live_summary:c-2' }));
      const findById = vi.fn().mockResolvedValue({ id: 'c-2', tenantId: 'selected-tenant' });
      const { controller } = buildController({
        cls: {
          get: (key: string) => {
            if (key === 'user') return { id: 'admin-1', tenantId: '', roles: ['SUPER_ADMIN'] };
            if (key === 'tenantId') return 'selected-tenant';
            return null;
          },
        },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        consultationRepository: { findById },
      });

      await controller.issueStreamTicket({ scope: 'consultation_live_summary:c-2' });

      expect(issueTicket).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'admin-1', tenantId: 'selected-tenant', scope: 'consultation_live_summary:c-2' }),
      );
    });

    it('does NOT perform an ownership lookup for jobId-keyed scopes (consultation_job)', async () => {
      const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 'consultation_job:job-1' }));
      const findById = vi.fn();
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        consultationRepository: { findById },
      });

      await controller.issueStreamTicket({ scope: 'consultation_job:job-1' });

      expect(findById).not.toHaveBeenCalled();
      expect(issueTicket).toHaveBeenCalled();
    });
  });

  // TASK-348 / MIN-1 — the mint-time ownership assertion must cover EVERY
  // consultation-id-keyed scope, not just live-summary: the SSE route's
  // @TenantOwnedResource guard still blocks a cross-tenant stream, but the
  // ticket must not be mintable in the first place (defense-in-depth parity).
  describe('generalized consultation scope ownership (TASK-348 MIN-1)', () => {
    it('mints a harness-progress ticket when the consultation belongs to the caller tenant', async () => {
      const issueTicket = vi.fn(async () => ({ ticket: 'tkt', expiresAt: 1, scope: 'consultation_harness_progress:c-1' }));
      const findById = vi.fn().mockResolvedValue({ id: 'c-1', tenantId: 'tenant-1' });
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        consultationRepository: { findById },
      });

      await controller.issueStreamTicket({ scope: 'consultation_harness_progress:c-1' });

      expect(findById).toHaveBeenCalledWith('c-1');
      expect(issueTicket).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'consultation_harness_progress:c-1', tenantId: 'tenant-1' }),
      );
    });

    it("throws NotFoundException and never mints a harness-progress ticket for another tenant's consultation", async () => {
      const issueTicket = vi.fn();
      const findById = vi.fn().mockResolvedValue({ id: 'c-9', tenantId: 'tenant-OTHER' });
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        consultationRepository: { findById },
      });

      await expect(controller.issueStreamTicket({ scope: 'consultation_harness_progress:c-9' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('throws NotFoundException and never mints when the harness-progress consultation is missing', async () => {
      const issueTicket = vi.fn();
      const findById = vi.fn().mockRejectedValue(new Error('not found'));
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        consultationRepository: { findById },
      });

      await expect(controller.issueStreamTicket({ scope: 'consultation_harness_progress:missing' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('fail-closed: an UNKNOWN consultation_* scope is ownership-checked (no unchecked namespace can ship)', async () => {
      const issueTicket = vi.fn();
      // The id is treated as a consultation id; an unresolvable one must 404.
      const findById = vi.fn().mockResolvedValue(null);
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        consultationRepository: { findById },
      });

      await expect(controller.issueStreamTicket({ scope: 'consultation_future_feed:c-1' })).rejects.toThrow(NotFoundException);
      expect(findById).toHaveBeenCalledWith('c-1');
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('fail-closed: a consultation-id-keyed scope with an EMPTY id is rejected', async () => {
      const issueTicket = vi.fn();
      const findById = vi.fn();
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        consultationRepository: { findById },
      });

      await expect(controller.issueStreamTicket({ scope: 'consultation_harness_progress:' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });
  });
});
