/**
 * TASK-930 §4 — a RUN-SCOPED stream ticket, so a socket is reachable by a credential that is
 * not a browser session.
 *
 * `POST /auth/stream-ticket` mints `workflow_run:<runId>` tickets today, but it is `@ForbidApiKey`
 * and JWT-only by construction — it is the credential-ISSUING plane. An API key or a service
 * account therefore had no way to open `/ws/workflows` at all: the one transport that reports a
 * run as it happens was closed to exactly the callers that run workflows unattended.
 *
 * This route is the run-scoped equivalent: same ticket kind, same `StreamTicketService`, same
 * single-use 30-second semantics — but scoped to ONE run it has already proved the caller owns,
 * so no scope string arrives from the wire and nothing wider than that run can be minted.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { WorkflowsController } from '../workflows.controller';

const TENANT = '50000000-0000-0000-0000-000000000001';
const RUN_ID = 'run-42';

function make(over: { getRunStatus?: ReturnType<typeof vi.fn> } = {}) {
  const workflowExposureService = {
    getRunStatus: over.getRunStatus ?? vi.fn(async () => ({ runId: RUN_ID, status: 'RUNNING' })),
  };
  const workflowStreamService = { stream: vi.fn() };
  const streamTicketService = {
    issueTicket: vi.fn(async (input: { scope: string }) => ({ ticket: 'TICKET-abc', expiresAt: 1_700_000_030_000, scope: input.scope })),
  };
  const cls = {
    get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'u1', tenantId: TENANT } : undefined)),
  };
  const controller = new WorkflowsController(
    workflowExposureService as never,
    workflowStreamService as never,
    undefined,
    streamTicketService as never,
    cls as never,
  );
  return { controller, workflowExposureService, streamTicketService, cls };
}

describe('TASK-930 §4 — POST /workflows/:slug/runs/:runId/stream-ticket', () => {
  it('is mounted under the run and gated by the run-READ scopes on both machine planes', () => {
    const handler = WorkflowsController.prototype.issueRunStreamTicket;
    expect(Reflect.getMetadata('path', handler)).toBe(':slug/runs/:runId/stream-ticket');
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(201);

    // The JWT/CASL half — the deny-by-default boot audit refuses a route without it.
    const permissions = new Reflector().getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [handler, WorkflowsController]);
    expect(permissions).toEqual([{ action: 'read', subject: 'WorkflowRun' }]);

    // Minting a ticket is a READ of the run, not a write: the scope must match the SSE route it
    // is a socket alternative to, or a read-only credential would lose the transport.
    const keys = Reflect.getMetadataKeys(handler).map(String);
    const scopeKeys = keys.filter((key) => /scope/i.test(key));
    const values = scopeKeys.flatMap((key) => Reflect.getMetadata(key, handler) as unknown[]);
    expect(values).toContain('workflow:run:read');
    expect(values).toContain('svc:workflow:run:read');
  });

  it('proves ownership BEFORE minting, so a foreign run is a 404 and no ticket exists', async () => {
    const getRunStatus = vi.fn(async () => {
      throw new NotFoundException('Workflow run not found');
    });
    const { controller, streamTicketService } = make({ getRunStatus });

    await expect(controller.issueRunStreamTicket('report', RUN_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(streamTicketService.issueTicket).not.toHaveBeenCalled();
  });

  it('mints the `workflow_run:<runId>` scope the socket gateway checks — never a scope from the wire', async () => {
    const { controller, streamTicketService } = make();

    const result = await controller.issueRunStreamTicket('report', RUN_ID);

    expect(streamTicketService.issueTicket).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', tenantId: TENANT, scope: `workflow_run:${RUN_ID}` }),
    );
    expect(result.scope).toBe(`workflow_run:${RUN_ID}`);
  });

  it('answers the ticket, its absolute expiry and the socket URL to open with it', async () => {
    const { controller } = make();

    const result = await controller.issueRunStreamTicket('report', RUN_ID);

    expect(result).toEqual({
      ticket: 'TICKET-abc',
      expiresAt: 1_700_000_030_000,
      scope: `workflow_run:${RUN_ID}`,
      url: `/ws/workflows?slug=report&runId=${RUN_ID}&ticket=TICKET-abc`,
    });
  });

  // Built with `URLSearchParams`, not string concatenation: a slug or run id carrying `&`, `=`
  // or a space would otherwise forge extra query parameters into the URL the client then opens.
  // `+` for a space is the form-encoding `URL.searchParams.get()` decodes — which is exactly what
  // `workflow-ws.gateway.ts` reads the values back with.
  it('encodes every value it puts in the URL rather than concatenating it', async () => {
    const { controller } = make();

    const result = await controller.issueRunStreamTicket('report v2', 'run&runId=other');

    expect(result.url).toBe('/ws/workflows?slug=report+v2&runId=run%26runId%3Dother&ticket=TICKET-abc');
    expect(new URL(`http://x${result.url}`).searchParams.get('runId')).toBe('run&runId=other');
  });
});
