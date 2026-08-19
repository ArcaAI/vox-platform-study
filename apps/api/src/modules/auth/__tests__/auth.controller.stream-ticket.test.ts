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
    streamSessionTenantBinding?: { lookupBinding: ReturnType<typeof vi.fn> };
    workflowRunService?: { getRun: ReturnType<typeof vi.fn> };
    dnaQueue?: { getJob: ReturnType<typeof vi.fn> };
    policyEngine?: { buildAbility: ReturnType<typeof vi.fn> };
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
  const streamSessionTenantBinding = opts.streamSessionTenantBinding ?? { lookupBinding: vi.fn().mockResolvedValue(null) };
  // Default fail-closed: no run resolvable for any (tenantId, runId).
  const workflowRunService = opts.workflowRunService ?? { getRun: vi.fn().mockRejectedValue(new Error('not found')) };
  // H-02: default fail-closed — no DNA job resolvable for any id.
  const dnaQueue = opts.dnaQueue ?? { getJob: vi.fn().mockResolvedValue(null) };
  // H-02: default fail-closed — the caller holds no ability at all.
  const policyEngine = opts.policyEngine ?? { buildAbility: vi.fn().mockResolvedValue({ can: () => false }) };

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
      dnaQueue as never, // dnaQueue (finding H-02)
      policyEngine as never, // policyEngine (finding H-02 — admin arm of the dna_job mint)
    ),
    streamTicketService,
    jwtRevocationService,
    consultationRepository,
    streamSessionTenantBinding,
    workflowRunService,
    dnaQueue,
    policyEngine,
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

    // H-02: a bare 's' is no longer a mintable scope (fail-closed registry);
    // this test is about the tenant fallback, so use a real known scope.
    await controller.issueStreamTicket({ scope: 'consultation_job:job-1' });

    expect(issueTicket).toHaveBeenCalledWith({
      userId: 'user-1',
      tenantId: 'tenant-from-cls',
      scope: 'consultation_job:job-1',
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

  // `stt_session:<sessionId>` mint-time ownership.
  //
  // Round 1 closed the CROSS-TENANT hole (the scope silently bypassed the
  // consultation-only check, so any user in tenant B who learned a tenant-A
  // sessionId could mint a live-transcript WS ticket for it).
  //
  // The comparison was still tenant-only, so a
  // COLLEAGUE — same tenant, different user — could mint a ticket for a live
  // consultation and take the socket over. The binding now records the owning
  // USER as well, and the mint requires BOTH to match. Missing binding,
  // missing owner, tenant mismatch and owner mismatch all 404 (no existence
  // leak), mirroring the `StreamSession` interceptor branch.
  describe('stt_session scope ownership', () => {
    const bindingFor = (tenantId: string, userId: string | null) => vi.fn().mockResolvedValue({ tenantId, userId });

    it('mints an stt_session ticket for the session OWNER', async () => {
      const issueTicket = vi.fn(async () => ({ ticket: 'tkt', expiresAt: 1, scope: 'stt_session:sess-1' }));
      const lookupBinding = bindingFor('tenant-1', 'user-1');
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookupBinding },
      });

      await controller.issueStreamTicket({ scope: 'stt_session:sess-1' });

      expect(lookupBinding).toHaveBeenCalledWith('sess-1');
      expect(issueTicket).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', tenantId: 'tenant-1', scope: 'stt_session:sess-1' }));
    });

    it("throws NotFoundException (no existence leak) and never mints for another tenant's session", async () => {
      const issueTicket = vi.fn();
      const lookupBinding = bindingFor('tenant-OTHER', 'user-9');
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookupBinding },
      });

      await expect(controller.issueStreamTicket({ scope: 'stt_session:sess-of-tenant-a' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    // THE HIJACK CASE: same tenant, different user. This is the mint
    // that handed an attacker a valid WS ticket for a colleague's live
    // consultation.
    it("throws NotFoundException and never mints for a COLLEAGUE's session (same tenant, different user)", async () => {
      const issueTicket = vi.fn();
      const lookupBinding = bindingFor('tenant-1', 'user-victim');
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-attacker', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookupBinding },
      });

      await expect(controller.issueStreamTicket({ scope: 'stt_session:sess-of-colleague' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('fail-closed: a binding with NO recorded owner (legacy record) never mints', async () => {
      const issueTicket = vi.fn();
      const lookupBinding = bindingFor('tenant-1', null);
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookupBinding },
      });

      await expect(controller.issueStreamTicket({ scope: 'stt_session:sess-legacy' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('fail-closed: throws NotFoundException and never mints when NO binding exists for the session', async () => {
      const issueTicket = vi.fn();
      const lookupBinding = vi.fn().mockResolvedValue(null);
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookupBinding },
      });

      await expect(controller.issueStreamTicket({ scope: 'stt_session:unknown-session' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('fail-closed: a binding lookup failure (Redis blip) rejects with 404, never a mint', async () => {
      const issueTicket = vi.fn();
      const lookupBinding = vi.fn().mockRejectedValue(new Error('redis down'));
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookupBinding },
      });

      await expect(controller.issueStreamTicket({ scope: 'stt_session:sess-1' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it("checks ownership against a super admin's selected X-Tenant-Id (CLS tenant wins) — and still requires ownership", async () => {
      const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 'stt_session:sess-2' }));
      const lookupBinding = bindingFor('selected-tenant', 'admin-1');
      const { controller } = buildController({
        cls: {
          get: (key: string) => {
            if (key === 'user') return { id: 'admin-1', tenantId: '', roles: ['SUPER_ADMIN'] };
            if (key === 'tenantId') return 'selected-tenant';
            return null;
          },
        },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookupBinding },
      });

      await controller.issueStreamTicket({ scope: 'stt_session:sess-2' });

      expect(issueTicket).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'admin-1', tenantId: 'selected-tenant', scope: 'stt_session:sess-2' }),
      );
    });

    // There is deliberately NO super-admin bypass: a live consultation socket
    // is exactly the surface where a silent third listener is the harm. A
    // super admin who does not own the session gets the same 404 as anyone
    // else.
    it("gives a SUPER_ADMIN no bypass over another user's session", async () => {
      const issueTicket = vi.fn();
      const lookupBinding = bindingFor('selected-tenant', 'clinician-1');
      const { controller } = buildController({
        cls: {
          get: (key: string) => {
            if (key === 'user') return { id: 'admin-1', tenantId: '', roles: ['SUPER_ADMIN'] };
            if (key === 'tenantId') return 'selected-tenant';
            return null;
          },
        },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookupBinding },
      });

      await expect(controller.issueStreamTicket({ scope: 'stt_session:sess-2' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('does NOT perform a session-binding lookup for consultation scopes (paths stay independent)', async () => {
      const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 'consultation_job:job-1' }));
      const lookupBinding = vi.fn();
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookupBinding },
      });

      await controller.issueStreamTicket({ scope: 'consultation_job:job-1' });

      expect(lookupBinding).not.toHaveBeenCalled();
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

  // `tts_session:<sessionId>` (TASK-755 G-2): the LAST stream-ticket scope
  // prefix with no branch at mint. Deliberately NOT an ownership check —
  // Option A ("document-and-assert"): TTS has no server-side session resource
  // to look up, so this asserts only what is knowable (well-formed bounded id
  // + an active tenant). See `assertTtsSessionScopeShape` for the full
  // rationale and the trigger that would upgrade this to Option B.
  describe('tts_session scope shape (TASK-755 G-2)', () => {
    it('mints a well-formed tts_session ticket for a caller with an active tenant, scope preserved', async () => {
      const issueTicket = vi.fn(async () => ({ ticket: 'tkt', expiresAt: 1, scope: 'tts_session:sess-1' }));
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      });

      const result = await controller.issueStreamTicket({ scope: 'tts_session:sess-1' });

      expect(issueTicket).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', tenantId: 'tenant-1', scope: 'tts_session:sess-1' }));
      expect(result.scope).toBe('tts_session:sess-1');
    });

    it('mints for a crypto.randomUUID() session id (the shape the SDK actually sends)', async () => {
      const scope = 'tts_session:0f9c1e2a-7b3d-4c8e-9a11-5d6e7f801234';
      const issueTicket = vi.fn(async () => ({ ticket: 'tkt', expiresAt: 1, scope }));
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      });

      await controller.issueStreamTicket({ scope });

      expect(issueTicket).toHaveBeenCalledWith(expect.objectContaining({ scope }));
    });

    it('mints for the SDK non-crypto fallback id shape (`tts-<ts>-<rand>`)', async () => {
      const scope = 'tts_session:tts-1755500000000-123456789';
      const issueTicket = vi.fn(async () => ({ ticket: 'tkt', expiresAt: 1, scope }));
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      });

      await controller.issueStreamTicket({ scope });

      expect(issueTicket).toHaveBeenCalledWith(expect.objectContaining({ scope }));
    });

    it('rejects an empty-suffix tts_session scope with NotFoundException and never mints', async () => {
      const issueTicket = vi.fn();
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      });

      await expect(controller.issueStreamTicket({ scope: 'tts_session:' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('rejects a malformed (character-illegal) session id and never mints', async () => {
      const issueTicket = vi.fn();
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      });

      await expect(controller.issueStreamTicket({ scope: 'tts_session:../../etc/passwd' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('rejects an unbounded (over-long) session id and never mints', async () => {
      const issueTicket = vi.fn();
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      });

      await expect(controller.issueStreamTicket({ scope: `tts_session:${'a'.repeat(129)}` })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('fail-closed: throws NotFoundException and never mints when the caller has no active tenant', async () => {
      const issueTicket = vi.fn();
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: '' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      });

      await expect(controller.issueStreamTicket({ scope: 'tts_session:sess-1' })).rejects.toThrow(NotFoundException);
      expect(issueTicket).not.toHaveBeenCalled();
    });

    it('uses the same rejection message as the stt_session branch (no cross-scope enumeration signal)', async () => {
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket: vi.fn(), consumeTicket: vi.fn() },
        // Default binding lookup returns null ⇒ the stt_session branch 404s.
      });

      const ttsErr = await controller.issueStreamTicket({ scope: 'tts_session:' }).catch((e: Error) => e);
      const sttErr = await controller.issueStreamTicket({ scope: 'stt_session:sess-1' }).catch((e: Error) => e);

      expect(ttsErr).toBeInstanceOf(NotFoundException);
      expect(sttErr).toBeInstanceOf(NotFoundException);
      expect((ttsErr as Error).message).toBe((sttErr as Error).message);
    });

    it('does NOT touch the session-binding or run lookups for tts_session scopes (paths stay independent)', async () => {
      const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 'tts_session:sess-1' }));
      const lookupBinding = vi.fn();
      const getRun = vi.fn();
      const findById = vi.fn();
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
        streamSessionTenantBinding: { lookupBinding },
        workflowRunService: { getRun },
        consultationRepository: { findById },
      });

      await controller.issueStreamTicket({ scope: 'tts_session:sess-1' });

      expect(lookupBinding).not.toHaveBeenCalled();
      expect(getRun).not.toHaveBeenCalled();
      expect(findById).not.toHaveBeenCalled();
      expect(issueTicket).toHaveBeenCalled();
    });

    it('leaves non-tts scopes untouched — an ordinary consultation_job scope still mints', async () => {
      const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 'consultation_job:job-1' }));
      const { controller } = buildController({
        cls: { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) },
        streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      });

      await controller.issueStreamTicket({ scope: 'consultation_job:job-1' });

      expect(issueTicket).toHaveBeenCalled();
    });
  });
});


/**
 * Finding H-02 — `dna_job:<jobId>` mint-time ownership, and a scope registry
 * that fails CLOSED on an unrecognised namespace.
 */
describe('AuthController.issueStreamTicket — dna_job ownership (H-02)', () => {
  const OWNED = { tenantId: 'tenant-1', doctorId: 'user-1', userId: 'user-1' };
  const jobWith = (data: unknown) => ({
    getJob: vi.fn(async () => ({ id: 'job-1', data, progress: 10, returnvalue: undefined, failedReason: undefined, getState: async () => 'active' })),
  });
  const callerCls = { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) };

  it('mints a dna_job ticket for the job OWNER', async () => {
    const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 'dna_job:job-1' }));
    const { controller } = buildController({
      cls: callerCls,
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      dnaQueue: jobWith(OWNED),
    });

    await controller.issueStreamTicket({ scope: 'dna_job:job-1' });

    expect(issueTicket).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', scope: 'dna_job:job-1' }));
  });

  it("throws NotFoundException and never mints for a COLLEAGUE's job (same tenant, different doctor)", async () => {
    const issueTicket = vi.fn();
    const { controller } = buildController({
      cls: callerCls,
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      dnaQueue: jobWith({ tenantId: 'tenant-1', doctorId: 'victim', userId: 'victim' }),
    });

    await expect(controller.issueStreamTicket({ scope: 'dna_job:job-1' })).rejects.toThrow(NotFoundException);
    expect(issueTicket).not.toHaveBeenCalled();
  });

  // The mint is the UNION of the doctor rule and the admin rule, because the
  // scope string does not say which surface the ticket is for. Applying only
  // the doctor rule left the ADMIN SSE route unmintable — dead for the Admin
  // Console, which can read the same job over HTTP. The route still re-asserts
  // the surface-specific rule at consume time.
  const adminCls = (tenantId: string) => ({
    get: (key: string) => {
      if (key === 'user') return { id: 'admin-1', tenantId };
      if (key === 'tenantId') return tenantId;
      return null;
    },
  });
  // `POST /auth/stream-ticket` is a bare `@Authorize()` route, so the auth
  // guard never builds an ability for it and CLS carries none — the mint asks
  // the PolicyEngine directly.
  const adminEngine = { buildAbility: vi.fn().mockResolvedValue({ can: (a: string, sub: string) => a === 'manage' && sub === 'DnaWritingStyleReport' }) };

  it("a same-tenant admin holding manage:DnaWritingStyleReport CAN mint for a clinician's job", async () => {
    const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 'dna_job:job-1' }));
    const { controller } = buildController({
      cls: adminCls('tenant-1'),
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      dnaQueue: jobWith({ tenantId: 'tenant-1', doctorId: 'some-doctor', userId: 'some-doctor' }),
      policyEngine: adminEngine,
    });

    await controller.issueStreamTicket({ scope: 'dna_job:job-1' });

    expect(issueTicket).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-1', scope: 'dna_job:job-1' }));
  });

  it('an admin in a DIFFERENT tenant CANNOT mint (the admin arm is tenant-bound)', async () => {
    const issueTicket = vi.fn();
    const { controller } = buildController({
      cls: adminCls('tenant-OTHER'),
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      dnaQueue: jobWith({ tenantId: 'tenant-1', doctorId: 'some-doctor', userId: 'some-doctor' }),
      policyEngine: adminEngine,
    });

    await expect(controller.issueStreamTicket({ scope: 'dna_job:job-1' })).rejects.toThrow(NotFoundException);
    expect(issueTicket).not.toHaveBeenCalled();
  });

  it('a same-tenant user WITHOUT the admin ability still cannot mint for a colleague (C-01 stays closed)', async () => {
    const issueTicket = vi.fn();
    const { controller } = buildController({
      cls: callerCls,
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      dnaQueue: jobWith({ tenantId: 'tenant-1', doctorId: 'victim', userId: 'victim' }),
    });

    await expect(controller.issueStreamTicket({ scope: 'dna_job:job-1' })).rejects.toThrow(NotFoundException);
    expect(issueTicket).not.toHaveBeenCalled();
  });

  it('an admin ability does NOT rescue a cross-tenant legacy payload (fail closed survives the union)', async () => {
    const issueTicket = vi.fn();
    const { controller } = buildController({
      cls: adminCls('tenant-1'),
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      dnaQueue: jobWith({ jobId: 'job-1' }),
      policyEngine: adminEngine,
    });

    await expect(controller.issueStreamTicket({ scope: 'dna_job:job-1' })).rejects.toThrow(NotFoundException);
    expect(issueTicket).not.toHaveBeenCalled();
  });

  it("throws NotFoundException and never mints for another tenant's job", async () => {
    const issueTicket = vi.fn();
    const { controller } = buildController({
      cls: callerCls,
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      dnaQueue: jobWith({ tenantId: 'tenant-OTHER', doctorId: 'user-1', userId: 'user-1' }),
    });

    await expect(controller.issueStreamTicket({ scope: 'dna_job:job-1' })).rejects.toThrow(NotFoundException);
    expect(issueTicket).not.toHaveBeenCalled();
  });

  it('fail-closed: a legacy job payload with no owner fields never mints', async () => {
    const issueTicket = vi.fn();
    const { controller } = buildController({
      cls: callerCls,
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      dnaQueue: jobWith({ jobId: 'job-1' }),
    });

    await expect(controller.issueStreamTicket({ scope: 'dna_job:job-1' })).rejects.toThrow(NotFoundException);
    expect(issueTicket).not.toHaveBeenCalled();
  });

  it('fail-closed: an unknown job id never mints', async () => {
    const issueTicket = vi.fn();
    const { controller } = buildController({
      cls: callerCls,
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
    });

    await expect(controller.issueStreamTicket({ scope: 'dna_job:nope' })).rejects.toThrow(NotFoundException);
    expect(issueTicket).not.toHaveBeenCalled();
  });
});

describe('AuthController.issueStreamTicket — scope registry fails closed (H-02)', () => {
  const callerCls = { get: (key: string) => (key === 'user' ? { id: 'user-1', tenantId: 'tenant-1' } : null) };

  it('rejects an unrecognised scope namespace instead of minting it', async () => {
    const issueTicket = vi.fn();
    const { controller } = buildController({ cls: callerCls, streamTicketService: { issueTicket, consumeTicket: vi.fn() } });

    await expect(controller.issueStreamTicket({ scope: 'totally_made_up:res-1' })).rejects.toThrow(NotFoundException);
    expect(issueTicket).not.toHaveBeenCalled();
  });

  it('rejects a scope with no namespace separator at all', async () => {
    const issueTicket = vi.fn();
    const { controller } = buildController({ cls: callerCls, streamTicketService: { issueTicket, consumeTicket: vi.fn() } });

    await expect(controller.issueStreamTicket({ scope: 's' })).rejects.toThrow(NotFoundException);
    expect(issueTicket).not.toHaveBeenCalled();
  });

  it.each(['transcription_job:t-1', 'text_task:task-1'])('still mints the known namespace %s', async (scope) => {
    const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope }));
    const { controller } = buildController({ cls: callerCls, streamTicketService: { issueTicket, consumeTicket: vi.fn() } });

    await controller.issueStreamTicket({ scope });

    expect(issueTicket).toHaveBeenCalledWith(expect.objectContaining({ scope }));
  });

  it('consultation_job stays exempt from ownership lookup and still mints', async () => {
    const issueTicket = vi.fn(async () => ({ ticket: 't', expiresAt: 1, scope: 'consultation_job:job-1' }));
    const findById = vi.fn();
    const { controller } = buildController({
      cls: callerCls,
      streamTicketService: { issueTicket, consumeTicket: vi.fn() },
      consultationRepository: { findById },
    });

    await controller.issueStreamTicket({ scope: 'consultation_job:job-1' });

    expect(findById).not.toHaveBeenCalled();
    expect(issueTicket).toHaveBeenCalled();
  });
});
