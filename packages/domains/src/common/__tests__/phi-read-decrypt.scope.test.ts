import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { decryptPhiRows, setPhiReadSecrets } from '../phi-read-decrypt';

/**
 * Decrypt-on-read must be scoped to the MODEL's declared ciphertext columns and
 * must never descend into opaque JSON payload columns (AuditLog.data /
 * previousData / metadata are snapshots of already-mutated entities and
 * serialize entity Buffers as `{"type":"Buffer","data":[…]}`).
 */

const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

/** Minimal SecretsService stub: ciphertext "vault:v1:<plaintext>" → "<plaintext>". */
function stubSecrets() {
  const seen: string[] = [];
  return {
    seen,
    decrypt: async (ct: string): Promise<Uint8Array> => {
      seen.push(ct);
      return Buffer.from(ct.replace(/^vault:v1:/, ''), 'utf8');
    },
  };
}

describe('decryptPhiRows — model-scoped ciphertext matching', () => {
  let secrets: ReturnType<typeof stubSecrets>;

  beforeEach(() => {
    secrets = stubSecrets();
    setPhiReadSecrets(secrets as never);
  });
  afterEach(() => setPhiReadSecrets(undefined));

  it('decrypts a genuine ciphertext column on a real model', async () => {
    const row: Record<string, unknown> = { id: 'c1', encryptedContent: enc('vault:v1:chest pain') };
    await decryptPhiRows(row, 'contextItem');
    expect(row.content).toBe('chest pain');
  });

  it('nulls the transient field when the ciphertext column is empty', async () => {
    const row: Record<string, unknown> = { id: 'c1', encryptedContent: new Uint8Array(0) };
    await decryptPhiRows(row, 'contextItem');
    expect(row.content).toBeNull();
  });

  it('decrypts json: true targets', async () => {
    const row: Record<string, unknown> = { id: 's1', encryptedCitationsMap: enc('vault:v1:{"a":1}') };
    await decryptPhiRows(row, 'summaryMeta');
    expect(row.citationsMap).toEqual({ a: 1 });
  });

  it('decrypts nested PHI rows reached through a declared relation', async () => {
    const row: Record<string, unknown> = {
      id: 'k1',
      ContextItems: [{ id: 'c1', encryptedContent: enc('vault:v1:nested phi') }],
    };
    await decryptPhiRows(row, 'consultation');
    expect((row.ContextItems as Record<string, unknown>[])[0].content).toBe('nested phi');
  });

  it('does not throw on an AuditLog row whose JSON payload contains a serialized Buffer', async () => {
    const row: Record<string, unknown> = {
      id: 'a1',
      data: {
        id: 'c1',
        encryptedContent: { type: 'Buffer', data: [118, 97, 117, 108, 116] },
      },
      previousData: null,
      metaData: null,
    };
    await expect(decryptPhiRows(row, 'auditLog')).resolves.toBeUndefined();
    expect((row.data as Record<string, unknown>).content).toBeUndefined();
  });

  it('never decrypts inside an audit JSON payload even when the value IS well-formed bytes', async () => {
    const row: Record<string, unknown> = {
      id: 'a1',
      data: { id: 'c1', encryptedContent: enc('vault:v1:secret phi') },
      previousData: { encryptedResultText: enc('vault:v1:more phi') },
      metaData: { encryptedText: enc('vault:v1:even more') },
    };
    await decryptPhiRows(row, 'auditLog');
    expect((row.data as Record<string, unknown>).content).toBeUndefined();
    expect((row.previousData as Record<string, unknown>).resultText).toBeUndefined();
    expect((row.metaData as Record<string, unknown>).text).toBeUndefined();
    expect(secrets.seen).toHaveLength(0);
  });

  it('ignores a ciphertext-looking key that is not declared on this model', async () => {
    // encryptedResultText belongs to TranscriptionJob, not ContextItem.
    const row: Record<string, unknown> = { id: 'c1', encryptedResultText: enc('vault:v1:nope') };
    await decryptPhiRows(row, 'contextItem');
    expect(row.resultText).toBeUndefined();
    expect(secrets.seen).toHaveLength(0);
  });

  it('is a no-op for an unknown model name', async () => {
    const row: Record<string, unknown> = { encryptedContent: enc('vault:v1:x') };
    await decryptPhiRows(row, 'notAModel');
    expect(row.content).toBeUndefined();
  });
});
