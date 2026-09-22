/**
 * `TranscriptionJobRepository.findTelemetryByConsultation` — a projected read
 * that must never pull a transcript through Vault.
 *
 * The consultation telemetry pane needs three scalars per job (`servedBy`,
 * `resultWordCount`, `resultCharCount`). The entity finder
 * (`findByConsultation`) returns whole rows, and whole rows carry
 * `encryptedResultText` / `encryptedResultMetadata` — which the base `db`
 * getter's decrypt-on-read wrapper then sends to Vault as a BATCH decrypt. That
 * made an admin reporting read the thing that decrypted PHI, which is precisely
 * what the write-time counters exist to avoid (TASK-999 D-3(a)).
 *
 * `findMany` IS a decrypting method. What makes the projected read safe is that
 * the walker skips any registered ciphertext column absent from the row
 * (`phi-read-decrypt.ts`: `if (!(key in row)) continue`). So the invariant is
 * not "we call a different method" — it is "the `select` names no ciphertext
 * column". These tests pin that, cross-checked against the registry itself so a
 * newly-encrypted column cannot quietly slip into the projection later.
 */
import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { PHI_MODEL_CIPHERTEXT } from '../../common/phi-read-decrypt';
import { TranscriptionJobRepository } from '../generated/core/TranscriptionJobRepository';

function makeRepo(rows: unknown[] = []) {
  const delegate = { findMany: vi.fn().mockResolvedValue(rows) };
  const uow = { getDatabaseService: () => ({ transcriptionJob: delegate }) };
  const repo = new TranscriptionJobRepository(uow as never);
  return { repo, delegate };
}

describe('TranscriptionJobRepository.findTelemetryByConsultation', () => {
  // RED before TASK-999's fix: the telemetry service called `findByConsultation`,
  // so this projection did not exist at all.
  it('selects ONLY the telemetry scalars — no ciphertext column reaches the walker', async () => {
    const { repo, delegate } = makeRepo();

    await repo.findTelemetryByConsultation('consultation-1');

    expect(delegate.findMany).toHaveBeenCalledTimes(1);
    const arg = delegate.findMany.mock.calls[0][0] as { select: Record<string, boolean>; where: Record<string, unknown> };
    expect(arg.where).toEqual({ consultationId: 'consultation-1' });
    expect(Object.keys(arg.select).sort()).toEqual(['id', 'resultCharCount', 'resultWordCount', 'servedBy']);
  });

  // The load-bearing assertion: stated against the registry, not a hardcoded
  // pair of names, so encrypting a NEW TranscriptionJob column fails here the
  // moment someone adds it to the projection.
  it('names no registered TranscriptionJob ciphertext column in its select', async () => {
    const { repo, delegate } = makeRepo();

    await repo.findTelemetryByConsultation('consultation-1');

    const arg = delegate.findMany.mock.calls[0][0] as { select: Record<string, boolean> };
    const selected = Object.keys(arg.select);
    const ciphertextColumns = PHI_MODEL_CIPHERTEXT.transcriptionJob;

    expect(ciphertextColumns.length).toBeGreaterThan(0);
    for (const column of ciphertextColumns) {
      expect(selected).not.toContain(column);
    }
    // Belt and braces: nothing shaped like a ciphertext column either.
    expect(selected.filter((key) => key.startsWith('encrypted'))).toEqual([]);
  });

  it('returns the projected rows newest-first, unmapped', async () => {
    const rows = [
      { id: 'job-2', servedBy: { chainIndex: -1, source: 'primary' }, resultWordCount: 12, resultCharCount: 80 },
      { id: 'job-1', servedBy: null, resultWordCount: null, resultCharCount: null },
    ];
    const { repo, delegate } = makeRepo(rows);

    const result = await repo.findTelemetryByConsultation('consultation-1');

    expect(result).toEqual(rows);
    const arg = delegate.findMany.mock.calls[0][0] as { orderBy: unknown };
    expect(arg.orderBy).toEqual([{ createdAt: 'desc' }]);
  });
});
