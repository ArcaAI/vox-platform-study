/**
 * TASK-1042 (C7) — `liveAudio` on `POST /workflow-runs:start`: a server-resolved channel, like
 * `subject`. Sent with EXACTLY `{ sttSessionId, maxWaitSeconds? }` (the harness model forbids
 * extra keys), and omitted entirely when the run binds no live session.
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

describe('HarnessGatewayService.startWorkflowRun — liveAudio (TASK-1042 C7)', () => {
  it('sends liveAudio with exactly sttSessionId and maxWaitSeconds', async () => {
    const { http, service } = build();
    await service.startWorkflowRun({ ...base, liveAudio: { sttSessionId: 'stt-1', maxWaitSeconds: 1800 } });
    const [, body] = http.axiosRef.post.mock.calls[0];
    expect(body.liveAudio).toEqual({ sttSessionId: 'stt-1', maxWaitSeconds: 1800 });
    expect(Object.keys(body.liveAudio).sort()).toEqual(['maxWaitSeconds', 'sttSessionId']);
  });

  it('sends only sttSessionId when no ceiling was resolved', async () => {
    const { http, service } = build();
    await service.startWorkflowRun({ ...base, liveAudio: { sttSessionId: 'stt-1' } });
    expect(http.axiosRef.post.mock.calls[0][1].liveAudio).toEqual({ sttSessionId: 'stt-1' });
  });

  it('omits the key when the run binds no live session', async () => {
    const { http, service } = build();
    await service.startWorkflowRun(base);
    expect(http.axiosRef.post.mock.calls[0][1]).not.toHaveProperty('liveAudio');
  });
});
