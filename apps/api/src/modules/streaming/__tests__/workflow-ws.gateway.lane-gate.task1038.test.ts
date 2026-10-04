/**
 * TASK-1038 E2 (fix 1) — the `socket` lane is enforced where the WS connection is accepted.
 *
 * A run ticket is minted when the workflow admits `sse` OR `socket`, so redeeming it on the
 * socket must re-check `socket` for the run's own version: an [api, sse] workflow's ticket opens
 * the SSE stream, never the socket (close 4400, `MODE_UNSUPPORTED`, no frame).
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setOriginEnforcementResolver } from '../../../cors.config';
import { RunEventStreamHub } from '../../workflows/run-event-stream-hub';
import { WORKFLOW_RUN_TICKET_NAMESPACE, WORKFLOW_WS_CLOSE_PROTOCOL_UNSUPPORTED, WorkflowWsGateway } from '../workflow-ws.gateway';

const TENANT = '10000000-0000-0000-0000-000000000001';
const RUN = '018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43';
const snapshot = { runId: RUN, slug: 'discharge', workflowVersionNumber: 3, status: 'COMPLETED', stages: [], startedAt: null, endedAt: null };

function build(gate: ReturnType<typeof vi.fn>) {
  const tickets = { consumeTicket: vi.fn(async () => ({ scope: `${WORKFLOW_RUN_TICKET_NAMESPACE}:${RUN}`, tenantId: TENANT, userId: 'u1' })) };
  const exposure = { getRunStatus: vi.fn(async () => snapshot) };
  const cls = { set: vi.fn(), run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const hub = new RunEventStreamHub({ isRedisConfigured: () => false } as never);
  const entryGate = { assertEntryAllowed: gate };
  const gateway = new WorkflowWsGateway(tickets as never, exposure as never, cls as never, hub, undefined, undefined, entryGate as never);
  const client = { OPEN: 1, readyState: 1, send: vi.fn(), close: vi.fn(), ping: vi.fn(), on: vi.fn() };
  return { gateway, client, cls };
}

const req = { url: `/ws/workflows?slug=discharge&runId=${RUN}&ticket=t-1`, headers: {} };

describe('WorkflowWsGateway — the socket lane gate', () => {
  beforeEach(() => {
    setOriginEnforcementResolver(() => false);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => setOriginEnforcementResolver(null));

  it('asks the gate about `socket` for the run’s own version under the ticket tenant, then serves', async () => {
    const gate = vi.fn(async () => undefined);
    const t = build(gate);
    await t.gateway.handleConnection(t.client as never, req as never);
    expect(gate).toHaveBeenCalledWith('discharge', 3, 'socket');
    expect(t.client.send).toHaveBeenCalled();
    expect(t.client.close).toHaveBeenCalledWith(1000, 'run completed');
  });

  it('closes 4400 MODE_UNSUPPORTED with no frame when the workflow does not admit socket', async () => {
    const gate = vi.fn(async () => {
      throw new BadRequestException({ code: 'MODE_UNSUPPORTED', message: 'x' });
    });
    const t = build(gate);
    await t.gateway.handleConnection(t.client as never, req as never);
    expect(t.client.send).not.toHaveBeenCalled();
    expect(t.client.close).toHaveBeenCalledTimes(1);
    expect(t.client.close).toHaveBeenCalledWith(WORKFLOW_WS_CLOSE_PROTOCOL_UNSUPPORTED, 'MODE_UNSUPPORTED');
  });
});
