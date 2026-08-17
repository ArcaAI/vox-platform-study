/**
 * AuthController#issueStreamTicket — unit tests
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

function buildController(
  opts: {
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
    streamSessionTenantBinding?: { lookup: ReturnType<typeof vi.fn> };
    workflowRunService?: { getRun: ReturnType<typeof vi.fn> };
  } = {},
) {
  const cls = opts.cls ?? { get: () => null };
  const streamTicketService = opts.streamTicketService ?? {
    issueTicket: vi.fn(),
    consumeTicket: vi.fn(),
  };
  const jwtRevocationService = opts.jwtRevocationService ?? {
    revoke: vi.fn(),
    isRevoked: vi.fn().mockResolvedValue(false),
  };
  const consultationRepository = opts.consultationRepository ?? { findById: vi.fn() };
  // Default fail-closed: no binding bound for any session.
  const streamSessionTenantBinding = opts.streamSessionTenantBinding ?? { lookup: vi.fn().mockResolvedValue(null) };
  // Default fail-closed: no run resolvable for any (tenantId, runId).
  const workflowRunService = opts.workflowRunService ?? { getRun: vi.fn().mockRejectedValue(new Error('not found')) };

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
      {} as never, // secretsService (not exercised by stream-ticket paths)
      {} as never, // refreshTokenService
      {} as never, // userDepartmentService
      {} as never, // eventEmitter
      consultationRepository as never, // consultationRepository
      streamSessionTenantBinding as never, // streamSessionTenantBinding
      workflowRunService as never, // workflowRunService (TASK-722)
    ),
    streamTicketService,
    jwtRevocationService,
    consultationRepository,
    streamSessionTenantBinding,
    workflowRunService,
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

  it('carries impersonatedBy through to the ticket payload', async () => {
    const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 's' }));
    const { controller } = buildController({
      cls: {
        get: (key: string) => (key === 'user' ? { id: 'doctor-001', tenantId: 'tenant-acme', impersonatedBy: 'admin-007' } : null),
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

    await expect(controller.issueStreamTicket({ scope: 'consultation_job:job-1' })).rejects.toThrow(UnauthorizedException);
  });

  it('handler is bound to HTTP POST on path "stream-ticket"', () => {
    const path = Reflect.getMetadata(PATH_METADATA, AuthController.prototype.issueStreamTicket);
    const method = Reflect.getMetadata(METHOD_METADATA, AuthController.prototype.issueStreamTicket);
    expect(path).toBe('stream-ticket');
    expect(method).toBe(RequestMethod.POST);
  });

  // Defense-in-depth at mint time for live-summary tickets.
  // The SSE route is @TenantOwnedResource, but a ticket bypasses that
  // interceptor, so a `consultation_live_summary:<id>` ticket may only be
  // minted for a consultation in the caller's (active) tenant.
  describe('live-summary scope ownership', () => {
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

    it("propagates a super admin's selected X-Tenant-Id into the ticket and checks ownership against it", async () => {
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

  // The mint-time ownership assertion must cover EVERY
  // consultation-id-keyed scope, not just live-summary: the SSE route's
  // @TenantOwnedResource guard still blocks a cross-tenant stream, but the
  // ticket must not be mintable in the first place (defense-in-depth parity).
  describe('generalized consultation scope ownership', () => {
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
      expect(issueTicket).toHaveBeenCalledWith(expect.objectContaining({ scope: 'consultation_harness_progress:c-1', tenantId: 'tenant-1' }));
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

  // `stt_session:<sessionId>` silently bypassed the
  // consultation-only mint check, so any authenticated user in tenant B who
  // learned a tenant-A sessionId could mint a live-transcript WS ticket for
  // it (cross-tenant PHI egress). The mint now resolves the session's owning
  // tenant via the gateway-side binding written at session create
  // (`StreamSessionTenantBindingService.bind`) and 404s on missing OR
  // mismatched bindings — mirroring the DELETE route's
  // `assertStreamSessionOwnership` (404-over-403, no existence leak).
  describe('stt_session scope ownership', () => {
    it('mints an stt_session ticket when the session binding matches the caller tenant', async () => {
      const issueTicket = vi.fn(async () => ({ ticket: 'tkt', expiresAt: 1, scope: 'stt_session:sess-1' }));
      const lookup = vi.fn().mockResolvedValue('tenant-1');
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookup },
      });

      await controller.issueStreamTicket({ scope: 'stt_session:sess-1' });

      expect(lookup).toHaveBeenCalledWith('sess-1');
      expect(issueTicket).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', tenantId: 'tenant-1', scope: 'stt_session:sess-1' }));
    });

    it("throws NotFoundException (no existence leak) and never mints for another tenant's session", async () => {
      const issueTicket = vi.fn();
      const lookup = vi.fn().mockResolvedValue('tenant-OTHER');
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookup },
      });

      await expect(controller.issueStreamTicket({ scope: 'stt_session:sess-of-tenant-a' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('fail-closed: throws NotFoundException and never mints when NO binding exists for the session', async () => {
      const issueTicket = vi.fn();
      const lookup = vi.fn().mockResolvedValue(null);
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookup },
      });

      await expect(controller.issueStreamTicket({ scope: 'stt_session:unknown-session' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('fail-closed: a binding lookup failure (Redis blip) rejects with 404, never a mint', async () => {
      const issueTicket = vi.fn();
      const lookup = vi.fn().mockRejectedValue(new Error('redis down'));
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookup },
      });

      await expect(controller.issueStreamTicket({ scope: 'stt_session:sess-1' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it("checks ownership against a super admin's selected X-Tenant-Id (CLS tenant wins)", async () => {
      const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 'stt_session:sess-2' }));
      const lookup = vi.fn().mockResolvedValue('selected-tenant');
      const { controller } = buildController({
        cls: {
          get: (key: string) => {
            if (key === 'user') return { id: 'admin-1', tenantId: '', roles: ['SUPER_ADMIN'] };
            if (key === 'tenantId') return 'selected-tenant';
            return null;
          },
        },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookup },
      });

      await controller.issueStreamTicket({ scope: 'stt_session:sess-2' });

      expect(issueTicket).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'admin-1', tenantId: 'selected-tenant', scope: 'stt_session:sess-2' }),
      );
    });

    it('does NOT perform a session-binding lookup for consultation scopes (paths stay independent)', async () => {
      const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 'consultation_job:job-1' }));
      const lookup = vi.fn();
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookup },
      });

      await controller.issueStreamTicket({ scope: 'consultation_job:job-1' });

      expect(lookup).not.toHaveBeenCalled();
      expect(issueTicket).toHaveBeenCalled();
    });
  });

  // `workflow_run:<runId>` (TASK-722 Task 7): mint-time ownership check for the
  // exposure-plane SSE route. Reuses `IWorkflowRunService.getRun`, which already
  // 404s a foreign-tenant/unknown runId — no second lookup path.
  describe('workflow_run scope ownership', () => {
    it('mints a workflow_run ticket when the run belongs to the caller tenant', async () => {
      const issueTicket = vi.fn(async () => ({ ticket: 'tkt', expiresAt: 1, scope: 'workflow_run:run-1' }));
      const getRun = vi.fn().mockResolvedValue({ runId: 'run-1', tenantId: 'tenant-1' });
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        workflowRunService: { getRun },
      });

      await controller.issueStreamTicket({ scope: 'workflow_run:run-1' });

      expect(getRun).toHaveBeenCalledWith('tenant-1', 'run-1');
      expect(issueTicket).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', tenantId: 'tenant-1', scope: 'workflow_run:run-1' }));
    });

    it("throws NotFoundException (no existence leak) and never mints for another tenant's run", async () => {
      const issueTicket = vi.fn();
      // IWorkflowRunService.getRun itself 404s a foreign-tenant id — simulated here as a throw.
      const getRun = vi.fn().mockRejectedValue(new Error('not found'));
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        workflowRunService: { getRun },
      });

      await expect(controller.issueStreamTicket({ scope: 'workflow_run:run-of-tenant-a' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('fail-closed: throws NotFoundException and never mints when the caller has no active tenant', async () => {
      const issueTicket = vi.fn();
      const getRun = vi.fn();
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: '' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        workflowRunService: { getRun },
      });

      await expect(controller.issueStreamTicket({ scope: 'workflow_run:run-1' })).rejects.toThrow(NotFoundException);
      expect(getRun).not.toHaveBeenCalled();
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('does NOT perform a run lookup for non-workflow_run scopes (paths stay independent)', async () => {
      const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 'consultation_job:job-1' }));
      const getRun = vi.fn();
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        workflowRunService: { getRun },
      });

      await controller.issueStreamTicket({ scope: 'consultation_job:job-1' });

      expect(getRun).not.toHaveBeenCalled();
      expect(issueTicket).toHaveBeenCalled();
    });
  });
});
