/**
 * KnowledgeIngestClient unit tests — institutional RAG.
 *
 * The OUTBOUND half of the apps/api -> apps/harness knowledge-ingest contract.
 * Mirrors HarnessGatewayService: base URL from `HARNESS_URL` (host only), the
 * route carries the harness global `/api/v1` prefix, and the call authenticates
 * with `X-Service-Token: <HARNESS_INTERNAL_SERVICE_TOKEN>`.
 *
 * This suite pins the cross-lane URL contract: Lane A serves the endpoint at
 * `/api/v1/internal/knowledge/ingest` (FastAPI router mounted under `/api/v1`),
 * so the client MUST post there — the original `/internal/knowledge/ingest`
 * (missing `/api/v1`) would 404 against the live harness.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KnowledgeIngestClient, KnowledgeIngestRequest } from '../knowledge-ingest.client';

const createMockHttpService = (data: unknown = { chunkCount: 0, chunks: [] }) => ({
  axiosRef: {
    post: vi.fn().mockResolvedValue({ data }),
  },
});

const createMockConfigService = (harnessUrl?: string) => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'HARNESS_URL') return harnessUrl;
    return undefined;
  }),
});

const createMockSecretsService = (token?: string) => ({
  getSecretOptional: vi.fn().mockResolvedValue(token),
});

const REQUEST: KnowledgeIngestRequest = {
  tenantId: 'tenant-1',
  knowledgeDocumentId: 'doc-1',
  title: 'Sepsis Protocol',
  source: 'protocols/sepsis.md',
  mimeType: 'text/markdown',
  text: 'Give antibiotics within 1 hour.',
};

describe('KnowledgeIngestClient', () => {
  let mockHttpService: ReturnType<typeof createMockHttpService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHttpService = createMockHttpService();
  });

  const build = (harnessUrl?: string, token?: string, secrets = createMockSecretsService(token)) =>
    new KnowledgeIngestClient(
      mockHttpService as any,
      createMockConfigService(harnessUrl) as any,
      secrets as any,
    );

  it('POSTs to the harness /api/v1/internal/knowledge/ingest route (matches the FastAPI mount)', async () => {
    const client = build('http://harness:8866', 'ingest-token-xyz');

    await client.ingest(REQUEST);

    expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
    const [url, body] = mockHttpService.axiosRef.post.mock.calls[0];
    expect(url).toBe('http://harness:8866/api/v1/internal/knowledge/ingest');
    expect(body).toEqual(REQUEST);
  });

  it('defaults the harness base URL to http://localhost:8866 when HARNESS_URL is unset', async () => {
    const client = build(undefined, 'tok');

    await client.ingest(REQUEST);

    const [url] = mockHttpService.axiosRef.post.mock.calls[0];
    expect(url).toBe('http://localhost:8866/api/v1/internal/knowledge/ingest');
  });

  it('authenticates with X-Service-Token resolved from HARNESS_INTERNAL_SERVICE_TOKEN', async () => {
    const secrets = createMockSecretsService('ingest-token-xyz');
    const client = build('http://harness:8866', undefined, secrets);

    await client.ingest(REQUEST);

    expect(secrets.getSecretOptional).toHaveBeenCalledWith('HARNESS_INTERNAL_SERVICE_TOKEN');
    const [, , options] = mockHttpService.axiosRef.post.mock.calls[0];
    expect(options.headers['X-Service-Token']).toBe('ingest-token-xyz');
    expect(options.headers['Content-Type']).toBe('application/json');
  });

  it('sends an empty X-Service-Token when no secret is configured (harness guard rejects)', async () => {
    const client = build('http://harness:8866', undefined);

    await client.ingest(REQUEST);

    const [, , options] = mockHttpService.axiosRef.post.mock.calls[0];
    expect(options.headers['X-Service-Token']).toBe('');
  });

  it('tolerates a missing SecretsService (optional dependency)', async () => {
    const client = new KnowledgeIngestClient(
      mockHttpService as any,
      createMockConfigService('http://harness:8866') as any,
      undefined,
    );

    await client.ingest(REQUEST);

    const [, , options] = mockHttpService.axiosRef.post.mock.calls[0];
    expect(options.headers['X-Service-Token']).toBe('');
  });

  it('returns the harness response payload (chunk descriptors)', async () => {
    const data = {
      chunkCount: 1,
      chunks: [
        {
          chunkIndex: 0,
          text: 'Give antibiotics within 1 hour.',
          qdrantPointId: 'pt-0',
          startOffset: 0,
          endOffset: 31,
          tokenCount: 6,
          embeddingModel: 'BAAI/bge-m3',
          embeddingDim: 1024,
          status: 'APPROVED',
        },
      ],
    };
    mockHttpService = createMockHttpService(data);
    const client = build('http://harness:8866', 'tok');

    const result = await client.ingest(REQUEST);

    expect(result).toEqual(data);
  });
});
