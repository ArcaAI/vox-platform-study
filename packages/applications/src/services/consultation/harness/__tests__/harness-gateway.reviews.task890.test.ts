/**
 * TASK-890 L7 — the two `core.humanReview` calls on the harness client.
 *
 * The URL shape is transcribed from the interpreter itself
 * (`apps/harness/src/harness/api/endpoints/interpreter.py`), not from prose:
 *
 *   GET  /api/v1/internal/workflow-runs/{run_id}/reviews/{node_id}
 *   POST /api/v1/internal/workflow-runs/{run_id}/reviews/{node_id}:decide
 *
 * Every route on this client lives under `/api/v1/internal` — the segment four interpreter
 * methods once shipped WITHOUT, which addressed paths FastAPI does not route and made every
 * run unreachable. That is why the prefix is asserted here rather than assumed.
 *
 * Both carry `X-Service-Token` AND `X-Tenant-Id`: a review decision is an attribution, and
 * rule 00 §"Tenant identity is mandatory on internal service calls" makes an absent header a
 * defect in the CALLER, not something the callee may default away.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HarnessGatewayService } from '../harness-gateway.service';

const http = { axiosRef: { post: vi.fn(), get: vi.fn() } };
const config = { get: vi.fn().mockImplementation((key: string) => (key === 'HARNESS_URL' ? 'http://harness:8866' : undefined)) };
const secrets = { getSecretOptional: vi.fn().mockResolvedValue('svc-token') };

const build = () => new HarnessGatewayService(http as never, config as never, secrets as never);

beforeEach(() => {
  vi.clearAllMocks();
  secrets.getSecretOptional.mockResolvedValue('svc-token');
  http.axiosRef.get.mockResolvedValue({ data: { runId: 'run-1', nodeId: 'n_review', exists: false } });
  http.axiosRef.post.mockResolvedValue({ data: { runId: 'run-1', nodeId: 'n_review', workflowId: 'run-1-review-n_review', signaled: true } });
});

describe('getWorkflowRunReview', () => {
  it('GETs the interpreter review-state route under /api/v1/internal', async () => {
    await build().getWorkflowRunReview('run-1', 'n_review', 'tenant-1');

    expect(http.axiosRef.get).toHaveBeenCalledWith('http://harness:8866/api/v1/internal/workflow-runs/run-1/reviews/n_review', expect.anything());
  });

  it('sends X-Service-Token and X-Tenant-Id', async () => {
    await build().getWorkflowRunReview('run-1', 'n_review', 'tenant-1');

    const [, options] = http.axiosRef.get.mock.calls[0]!;
    expect(options.headers).toMatchObject({ 'X-Service-Token': 'svc-token', 'X-Tenant-Id': 'tenant-1' });
  });

  it('returns the interpreter payload verbatim — exists:false is a normal answer, not an error', async () => {
    await expect(build().getWorkflowRunReview('run-1', 'n_review', 'tenant-1')).resolves.toEqual({ runId: 'run-1', nodeId: 'n_review', exists: false });
  });

  it('percent-encodes a run id and a node id that carry path characters', async () => {
    await build().getWorkflowRunReview('run/1', 'n review', 'tenant-1');

    expect(http.axiosRef.get.mock.calls[0]![0]).toBe('http://harness:8866/api/v1/internal/workflow-runs/run%2F1/reviews/n%20review');
  });
});

describe('decideWorkflowRunReview', () => {
  it('POSTs the `:decide` action with the decision body', async () => {
    await build().decideWorkflowRunReview('run-1', 'n_review', { decision: 'approved', reviewerId: 'user-9', comment: 'ok' }, 'tenant-1');

    const [url, body, options] = http.axiosRef.post.mock.calls[0]!;
    expect(url).toBe('http://harness:8866/api/v1/internal/workflow-runs/run-1/reviews/n_review:decide');
    expect(body).toEqual({ decision: 'approved', reviewerId: 'user-9', comment: 'ok', editedPayload: undefined });
    expect(options.headers).toMatchObject({ 'X-Service-Token': 'svc-token', 'X-Tenant-Id': 'tenant-1' });
  });

  it('keeps the `:decide` suffix unencoded while encoding the node id', async () => {
    await build().decideWorkflowRunReview('run-1', 'n/review', { decision: 'rejected' }, 'tenant-1');

    expect(http.axiosRef.post.mock.calls[0]![0]).toBe('http://harness:8866/api/v1/internal/workflow-runs/run-1/reviews/n%2Freview:decide');
  });

  it('propagates a harness failure rather than reporting a decision that reached nothing', async () => {
    const boom = Object.assign(new Error('Request failed with status code 503'), { isAxiosError: true, response: { status: 503 } });
    http.axiosRef.post.mockRejectedValue(boom);

    await expect(build().decideWorkflowRunReview('run-1', 'n_review', { decision: 'approved' }, 'tenant-1')).rejects.toBe(boom);
  });
});
