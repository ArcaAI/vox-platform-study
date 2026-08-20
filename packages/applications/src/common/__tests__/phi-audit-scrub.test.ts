import { describe, expect, it } from 'vitest';
import { PHI_CIPHERTEXT_FIELDS, PHI_MODEL_CIPHERTEXT, ResourceType } from '@arcaai/domains';
import { PHI_CIPHERTEXT_REDACTION, PHI_PLAINTEXT_REDACTION, scrubPhiForAudit } from '../phi-audit-scrub';

/**
 * A ContextItem audit snapshot as it actually reaches the audit queue: the
 * Vault ciphertext Buffer alongside the DECRYPTED transient plaintext.
 */
function contextItemSnapshot() {
  return {
    id: 'ci-1',
    tenantId: 't-1',
    consultationId: 'c-1',
    type: 'TRANSCRIPT',
    version: 3,
    encryptedContent: Buffer.from('vault:v1:abcdef'),
    keyVersion: 1,
    content: 'advance before stale approve',
  };
}

describe('scrubPhiForAudit', () => {
  it('removes the decrypted plaintext transient from a PHI snapshot', () => {
    const scrubbed = scrubPhiForAudit(contextItemSnapshot(), ResourceType.ContextItem) as Record<string, unknown>;

    expect(scrubbed.content).toBe(PHI_PLAINTEXT_REDACTION);
    expect(JSON.stringify(scrubbed)).not.toContain('advance before stale approve');
  });

  it('removes the raw ciphertext buffer as well', () => {
    const scrubbed = scrubPhiForAudit(contextItemSnapshot(), ResourceType.ContextItem) as Record<string, unknown>;

    expect(scrubbed.encryptedContent).toBe(PHI_CIPHERTEXT_REDACTION);
    expect(JSON.stringify(scrubbed)).not.toContain('"type":"Buffer"');
  });

  it('keeps non-PHI fields intact so the audit row still says WHAT changed', () => {
    const scrubbed = scrubPhiForAudit(contextItemSnapshot(), ResourceType.ContextItem) as Record<string, unknown>;

    expect(scrubbed.id).toBe('ci-1');
    expect(scrubbed.tenantId).toBe('t-1');
    expect(scrubbed.type).toBe('TRANSCRIPT');
    expect(scrubbed.version).toBe(3);
    expect(scrubbed.keyVersion).toBe(1);
    // The FIELD NAME survives — a reader can still see `content` was written.
    expect(Object.keys(scrubbed)).toContain('content');
    expect(Object.keys(scrubbed)).toContain('encryptedContent');
  });

  it('scrubs a plaintext transient even when the ciphertext sibling is absent (unencrypted dev write)', () => {
    const scrubbed = scrubPhiForAudit({ id: 'ci-1', content: 'chest pain radiating to jaw' }, ResourceType.ContextItem) as Record<
      string,
      unknown
    >;

    expect(scrubbed.content).toBe(PHI_PLAINTEXT_REDACTION);
  });

  it('scrubs nested PHI rows pulled in through a parent snapshot', () => {
    const scrubbed = scrubPhiForAudit(
      { id: 'c-1', title: 'Consultation', ContextItems: [contextItemSnapshot()] },
      ResourceType.Consultation,
    ) as { title: string; ContextItems: Record<string, unknown>[] };

    expect(scrubbed.title).toBe('Consultation');
    expect(scrubbed.ContextItems[0].content).toBe(PHI_PLAINTEXT_REDACTION);
    expect(scrubbed.ContextItems[0].encryptedContent).toBe(PHI_CIPHERTEXT_REDACTION);
  });

  it('does NOT over-redact a generic field name on a non-PHI resource', () => {
    // `metadata`/`details`/`notes` are PHI transients on SOME models, but a
    // Webhook snapshot carries no ciphertext sibling and is not a PHI model.
    const scrubbed = scrubPhiForAudit({ id: 'w-1', metadata: { retries: 2 }, details: 'delivery failed' }, ResourceType.Webhook) as Record<
      string,
      unknown
    >;

    expect(scrubbed.metadata).toEqual({ retries: 2 });
    expect(scrubbed.details).toBe('delivery failed');
  });

  it('passes through non-object payloads unchanged', () => {
    expect(scrubPhiForAudit(null)).toBeNull();
    expect(scrubPhiForAudit(undefined)).toBeUndefined();
  });

  it('does not mutate the caller-supplied snapshot', () => {
    const original = contextItemSnapshot();
    scrubPhiForAudit(original, ResourceType.ContextItem);

    expect(original.content).toBe('advance before stale approve');
  });
});

describe('scrubPhiForAudit — parity with PHI_CIPHERTEXT_FIELDS', () => {
  it('scrubs EVERY registered ciphertext column and its plaintext transient', () => {
    const payload: Record<string, unknown> = {};
    for (const [cipherKey, target] of Object.entries(PHI_CIPHERTEXT_FIELDS)) {
      payload[cipherKey] = Buffer.from('vault:v1:zzz');
      payload[target.plaintext] = `SENSITIVE-${target.plaintext}`;
    }

    const scrubbed = scrubPhiForAudit(payload) as Record<string, unknown>;

    for (const [cipherKey, target] of Object.entries(PHI_CIPHERTEXT_FIELDS)) {
      expect(scrubbed[cipherKey], cipherKey).toBe(PHI_CIPHERTEXT_REDACTION);
      expect(scrubbed[target.plaintext], target.plaintext).toBe(PHI_PLAINTEXT_REDACTION);
    }
    expect(JSON.stringify(scrubbed)).not.toContain('SENSITIVE-');
  });

  it('every model-scoped ciphertext column is known to the field registry', () => {
    const known = new Set(Object.keys(PHI_CIPHERTEXT_FIELDS));
    for (const [model, columns] of Object.entries(PHI_MODEL_CIPHERTEXT)) {
      for (const column of columns) {
        expect(known.has(column), `${model}.${column} is not in PHI_CIPHERTEXT_FIELDS`).toBe(true);
      }
    }
  });

});
