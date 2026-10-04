/**
 * TASK-1038 E2 (fix 2) — the admin trace has its OWN ticket namespace, `workflow_run_trace`.
 *
 * The trace used to accept `workflow_run:<runId>` tickets, which the business route
 * (`POST /workflows/:slug/runs/:runId/stream-ticket`) mints for API keys and service accounts.
 * The ticket restores the BOUND HUMAN, so a machine credential whose human is a TENANT_ADMIN
 * reached the admin trace (policy A2: an API key never reaches the admin plane). Now:
 *
 * - `workflow_run_trace:<runId>` is mintable ONLY through the JWT `POST /auth/stream-ticket`
 *   (class-level `@ForbidApiKey()`, no svc scope), after the trace's own admin check
 *   (403 `RUN_TRACE_FORBIDDEN`, row-independent, first) and the run's ownership (404);
 * - the trace route's `@StreamScope` is `workflow_run_trace`, so `JwtAuthGuard` refuses a
 *   `workflow_run:` ticket there.
 */
import 'reflect-metadata';
import { DataNotFoundException } from '@arcaai/exceptions';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from '../../../guards/jwtauth.guard';
import { WorkflowRunTraceController } from '../../workflows/workflow-run-trace.controller';
import { AuthController } from '../auth.controller';

const TENANT = 'tenant-1';

function build(opts: { cls?: Record<string, unknown>; getRun?: ReturnType<typeof vi.fn>; assertCanTrace?: ReturnType<typeof vi.fn> | null }) {
  const cls = { get: (key: string) => (opts.cls ?? { user: { id: 'admin-1', tenantId: TENANT } })[key] ?? null };
  const issueTicket = vi.fn(async (input: { scope: string }) => ({ ticket: 'tkt', expiresAt: 1, scope: input.scope }));
  const getRun = opts.getRun ?? vi.fn().mockResolvedValue({ runId: 'run-1', tenantId: TENANT });
  const traceAccess = opts.assertCanTrace === null ? undefined : { assertCanTrace: opts.assertCanTrace ?? vi.fn(async () => undefined) };
  const controller = new AuthController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    cls as never,
    { issueTicket, consumeTicket: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { findById: vi.fn() } as never,
    { lookupBinding: vi.fn() } as never,
    { getRun } as never,
    { getJob: vi.fn() } as never,
    { buildAbility: vi.fn() } as never,
    traceAccess as never,
  );
  return { controller, issueTicket, getRun, traceAccess };
}

describe('POST /auth/stream-ticket — workflow_run_trace:<runId>', () => {
  it('mints for an admin of the working tenant once the run is proven theirs', async () => {
    const { controller, issueTicket, getRun, traceAccess } = build({});
    const issued = await controller.issueStreamTicket({ scope: 'workflow_run_trace:run-1' });
    expect(traceAccess!.assertCanTrace).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, user: expect.objectContaining({ id: 'admin-1' }) }),
    );
    expect(getRun).toHaveBeenCalledWith(TENANT, 'run-1');
    expect(issueTicket).toHaveBeenCalledWith(expect.objectContaining({ scope: 'workflow_run_trace:run-1', tenantId: TENANT }));
    expect(issued.scope).toBe('workflow_run_trace:run-1');
  });

  it('refuses 403 RUN_TRACE_FORBIDDEN before any run lookup for a caller who may not trace', async () => {
    const assertCanTrace = vi.fn(async () => {
      throw new ForbiddenException({ code: 'RUN_TRACE_FORBIDDEN', message: 'x' });
    });
    const { controller, issueTicket, getRun } = build({ assertCanTrace });
    await expect(controller.issueStreamTicket({ scope: 'workflow_run_trace:run-1' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(getRun).not.toHaveBeenCalled();
    expect(issueTicket).not.toHaveBeenCalled();
  });

  it('refuses 404 for a foreign or unknown run', async () => {
    const getRun = vi.fn().mockRejectedValue(new DataNotFoundException('WorkflowRun', 'run-1'));
    const { controller, issueTicket } = build({ getRun });
    await expect(controller.issueStreamTicket({ scope: 'workflow_run_trace:run-1' })).rejects.toBeInstanceOf(NotFoundException);
    expect(issueTicket).not.toHaveBeenCalled();
  });

  it('fails closed (403) when the trace access check is not wired', async () => {
    const { controller, issueTicket } = build({ assertCanTrace: null });
    await expect(controller.issueStreamTicket({ scope: 'workflow_run_trace:run-1' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(issueTicket).not.toHaveBeenCalled();
  });

  it('refuses a service-account context outright, before the admin check', async () => {
    const { controller, issueTicket, traceAccess } = build({
      cls: { user: { id: 'bound-human', tenantId: TENANT }, serviceAccount: { id: 'sa-1' } },
    });
    await expect(controller.issueStreamTicket({ scope: 'workflow_run_trace:run-1' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(traceAccess!.assertCanTrace).not.toHaveBeenCalled();
    expect(issueTicket).not.toHaveBeenCalled();
  });
});

describe('the admin trace route refuses a business-plane workflow_run ticket', () => {
  function guardFor(stored: { scope: string } | null) {
    const streamTicketService = { consumeTicket: vi.fn(async () => (stored ? { ...stored, userId: 'bound-human', tenantId: TENANT } : null)) };
    const cls = { set: vi.fn(), get: vi.fn() };
    const guard = new JwtAuthGuard(new Reflector(), streamTicketService as never, cls as never);
    const request = { query: { ticket: 'T' }, params: { runId: 'run-1' }, headers: {} } as Record<string, unknown>;
    const context = {
      getType: () => 'http',
      getHandler: () => WorkflowRunTraceController.prototype.streamTrace,
      getClass: () => WorkflowRunTraceController,
      switchToHttp: () => ({ getRequest: () => request }),
    };
    return { guard, context };
  }

  it('a workflow_run:<runId> ticket (mintable by an API key) is refused on the trace', async () => {
    const { guard, context } = guardFor({ scope: 'workflow_run:run-1' });
    await expect(guard.canActivate(context as never)).rejects.toThrow();
  });

  it('a workflow_run_trace:<runId> ticket is accepted', async () => {
    const { guard, context } = guardFor({ scope: 'workflow_run_trace:run-1' });
    await expect(guard.canActivate(context as never)).resolves.toBe(true);
  });
});
