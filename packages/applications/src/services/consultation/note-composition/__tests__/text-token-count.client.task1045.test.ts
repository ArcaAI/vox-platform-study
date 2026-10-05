/** The tokenize call carries the model and texts only; there is no tokenizer-artifact selection on the wire. */
import { describe, expect, it, vi } from 'vitest';
import { TextTokenCountClient } from '../text-token-count.client';

function client(post: ReturnType<typeof vi.fn>) {
  const http = { axiosRef: { post } };
  const config = { get: () => 'http://text:8862' };
  const secrets = { getSecretOptional: vi.fn().mockResolvedValue('real-token-value-0123456789') };
  return new TextTokenCountClient(http as never, config as never, secrets as never);
}

describe('TextTokenCountClient', () => {
  it('posts provider, model and texts, and no tokenizer spec', async () => {
    const post = vi.fn().mockResolvedValue({ data: { counts: [3], tokenizer: { id: 'engine:m' } } });
    const target = { tenantId: 't1', provider: 'lm-studio', model: 'm', allowEstimate: true, tokenizer: { hubRepo: 'x/y', file: 'tokenizer.json', sha256: 'a'.repeat(64) } };
    const result = await client(post).count(['hello'], target as never);
    expect(result).toEqual({ counts: [3], mode: 'exact', id: 'engine:m' });
    expect(post.mock.calls[0][1]).toEqual({ provider: 'lm-studio', model: 'm', texts: ['hello'] });
  });
});
