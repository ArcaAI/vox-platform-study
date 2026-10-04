/**
 * TASK-1038 B3a G12 — a browser app on an API key opens the run's SSE stream with the
 * RUN-SCOPED ticket (`POST /workflows/:slug/runs/:runId/stream-ticket`), because a browser
 * `EventSource` cannot send `X-API-Key` and `POST /auth/stream-ticket` is JWT-only.
 *
 * Proven end to end at the guard: the ticket that route mints is accepted by the SSE route's
 * ticket authentication (`JwtAuthGuard`, which checks the ticket scope against the route's
 * `@StreamScope`), and the mint answers an `sseUrl` to open with it (protocol v2 selected).
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../../guards/jwtauth.guard';
import { WorkflowsController } from '../workflows.controller';

const TENANT = '50000000-0000-0000-0000-000000000001';

function mint() {
  const issued = new Map<string, { scope: string; userId: string; tenantId: string }>();
  const streamTicketService = {
    issueTicket: vi.fn(async (input: { scope: string; userId: string; tenantId: string }) => {
      issued.set('TICKET-1', input);
      return { ticket: 'TICKET-1', expiresAt: 1, scope: input.scope };
    }),
    consumeTicket: vi.fn(async (ticket: string) => {
      const stored = issued.get(ticket) ?? null;
      issued.delete(ticket);
      return stored;
    }),
  };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'bound-human' } : undefined)), set: vi.fn() };
  const controller = new WorkflowsController(
    { getRunStatus: vi.fn(async () => ({ status: 'RUNNING' })) } as never,
    { stream: vi.fn() } as never,
    undefined,
    streamTicketService as never,
    cls as never,
  );
  return { controller, streamTicketService, cls };
}

function sseContext(params: Record<string, string>, ticket: string) {
  const request = { query: { ticket }, params, headers: {} } as Record<string, unknown>;
  return {
    request,
    context: {
      getType: () => 'http',
      getHandler: () => WorkflowsController.prototype.streamRunStatus,
      getClass: () => WorkflowsController,
      switchToHttp: () => ({ getRequest: () => request }),
    },
  };
}

describe('G12 — the run-scoped ticket opens the SSE route', () => {
  it('answers an sseUrl (protocol v2) beside the socket url', async () => {
    const { controller } = mint();
    const issued = await controller.issueRunStreamTicket('flow', 'run-9');
    expect(issued.sseUrl).toBe('/api/v1/workflows/flow/runs/run-9/stream?protocol=2&ticket=TICKET-1');
    expect(issued.url).toBe('/ws/workflows?slug=flow&runId=run-9&ticket=TICKET-1');
  });

  it('JwtAuthGuard accepts that ticket on GET :slug/runs/:runId/stream (scope workflow_run:<runId>)', async () => {
    const { controller, streamTicketService, cls } = mint();
    await controller.issueRunStreamTicket('flow', 'run-9');
    const guard = new JwtAuthGuard(new Reflector(), streamTicketService as never, cls as never);
    const { context, request } = sseContext({ slug: 'flow', runId: 'run-9' }, 'TICKET-1');

    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(request.user).toMatchObject({ id: 'bound-human', tenantId: TENANT });
  });

  it('and refuses it on another run', async () => {
    const { controller, streamTicketService, cls } = mint();
    await controller.issueRunStreamTicket('flow', 'run-9');
    const guard = new JwtAuthGuard(new Reflector(), streamTicketService as never, cls as never);
    const { context } = sseContext({ slug: 'flow', runId: 'run-OTHER' }, 'TICKET-1');
    await expect(guard.canActivate(context as never)).rejects.toThrow();
  });
});
