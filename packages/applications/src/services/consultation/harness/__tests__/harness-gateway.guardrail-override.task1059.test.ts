/**
 * TASK-1059 (lane O2) — `guardrailOverrideNoticeIds` on `POST /workflow-runs:start`: the notice
 * ids already overridden, carried into a superseding run. Omitted entirely when empty/absent.
 */
import { describe, it, expect, vi } from 'vitest';
import { HarnessGatewayService } from '../harness-gateway.service';

const configRef = { store: 's3', bucket: 'harness-claim-check', key: 'k', size: 1, sha256: 'a'.repeat(64), content_type: 'application/json' };

function build() {
  const http = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { runId: 'run-1', status: 'started' } }), get: vi.fn() } };
  const config = { get: vi.fn().mockReturnValue('http://harness:8866') };
  const secrets = { getSecretOptional: vi.fn().mockResolvedValue('tok') };
  return { http, service: new HarnessGatewayService(http as never, config as never, secrets as never) };
}

const base = { runId: 'run-1', sessionId: 'workflow-interpreter-run-1', workflowVersionId: 'def-1', tenantId: 't-1', configRef };

describe('HarnessGatewayService.startWorkflowRun — guardrailOverrideNoticeIds (TASK-1059 O2)', () => {
  it('sends the ids when given', async () => {
    const { http, service } = build();
    await service.startWorkflowRun({ ...base, guardrailOverrideNoticeIds: ['n-1', 'n-2'] });
    expect(http.axiosRef.post.mock.calls[0][1].guardrailOverrideNoticeIds).toEqual(['n-1', 'n-2']);
  });

  it('omits the key when absent or empty', async () => {
    const { http, service } = build();
    await service.startWorkflowRun(base);
    await service.startWorkflowRun({ ...base, guardrailOverrideNoticeIds: [] });
    expect(http.axiosRef.post.mock.calls[0][1]).not.toHaveProperty('guardrailOverrideNoticeIds');
    expect(http.axiosRef.post.mock.calls[1][1]).not.toHaveProperty('guardrailOverrideNoticeIds');
  });
});
