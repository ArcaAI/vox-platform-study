/**
 * TASK-1038 OD-35 — the socket re-checks run ownership through `getRunStatus` under the ticket's
 * tenant AND the reader the ticket was minted under (CLS `runReader`), so a socket opened with a
 * ticket minted by API key A reads A's run — and the run-principal binding is enforced on
 * redemption exactly as on the SSE route.
 */
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunEventStreamHub } from '../../workflows/run-event-stream-hub';
import { WORKFLOW_RUN_TICKET_NAMESPACE, WORKFLOW_WS_CLOSE_AUTH_FAILED, WorkflowWsGateway } from '../workflow-ws.gateway';

const TENANT = '10000000-0000-0000-0000-000000000001';
const RUN = '018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43';
const READER = { principal: { type: 'apiKey', id: 'key-A' }, tenantWide: false };

const hub = new RunEventStreamHub({ isRedisConfigured: () => false } as never);
const socket = () => ({ OPEN: 1, readyState: 1, send: vi.fn(), close: vi.fn(), ping: vi.fn(), on: vi.fn() });
const request = { url: `/ws/workflows?slug=discharge&runId=${RUN}&ticket=t-1`, headers: {} };

function build(ticket: Record<string, unknown>, getRunStatus: ReturnType<typeof vi.fn>) {
  const cls = { set: vi.fn(), run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const tickets = { consumeTicket: vi.fn(async () => ticket) };
  return { gateway: new WorkflowWsGateway(tickets as never, { getRunStatus } as never, cls as never, hub), cls };
}

describe('WorkflowWsGateway — run reader on redemption (OD-35)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  it('restores the ticket’s reader before the ownership read', async () => {
    const getRunStatus = vi.fn(async () => ({ runId: RUN, workflowVersionNumber: 1, status: 'COMPLETED', stages: [], startedAt: null, endedAt: null }));
    const { gateway, cls } = build({ scope: `${WORKFLOW_RUN_TICKET_NAMESPACE}:${RUN}`, tenantId: TENANT, userId: 'human-1', runReader: READER }, getRunStatus);
    await gateway.handleConnection(socket() as never, request as never);
    expect(cls.set).toHaveBeenCalledWith('runReader', READER);
    expect(cls.set.mock.invocationCallOrder[cls.set.mock.calls.findIndex((c) => c[0] === 'runReader')]).toBeLessThan(getRunStatus.mock.invocationCallOrder[0]!);
  });

  it('a run the reader may not read is the generic auth close (the read answered 404)', async () => {
    const notFound = Object.assign(new Error('WorkflowRun not found'), { name: 'NotFoundException' });
    const getRunStatus = vi.fn(async () => {
      throw notFound;
    });
    const client = socket();
    const { gateway } = build({ scope: `${WORKFLOW_RUN_TICKET_NAMESPACE}:${RUN}`, tenantId: TENANT, userId: 'human-1', runReader: READER }, getRunStatus);
    await gateway.handleConnection(client as never, request as never);
    expect(client.close).toHaveBeenCalledWith(WORKFLOW_WS_CLOSE_AUTH_FAILED, expect.any(String));
    expect(client.send).not.toHaveBeenCalled();
  });
});
