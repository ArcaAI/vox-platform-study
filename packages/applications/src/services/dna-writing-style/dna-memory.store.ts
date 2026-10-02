import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { DnaSampleSource, DnaWritingSampleFactory, DnaWritingSampleRepository } from '@arcaai/domains';
import { SecretsService } from '../baseServices/_meta/secrets';

export interface StoreDnaSampleInput {
  tenantId: string;
  doctorId: string;
  source: DnaSampleSource;
  text: string;
  aiDraft?: string | null;
  writtenAt: Date;
  kind?: string | null;
  sourceRef?: string | null;
  ingestBatchId?: string | null;
  consultationId?: string | null;
  contextItemId?: string | null;
  createdBy?: string | null;
}

export type StoreDnaSampleOutcome = { stored: true; id: string } | { stored: false; duplicateOf: string };

/**
 * TASK-1034 — the one write path into DNA memory (`DnaWritingSample`).
 *
 * The text is Vault-Transit (hope-phi) ciphertext through the SAME helper the DNA report text uses
 * (`encryptStringToCiphertext`); there is no plaintext column, so a sample that cannot be encrypted
 * is not written. Dedupe is `(tenantId, doctorId, contentHash)` over a live row — re-uploading the
 * same export, or signing a note whose text was already captured as an edit, is a no-op.
 */
@Injectable()
export class DnaMemoryStore {
  constructor(
    private readonly sampleRepository: DnaWritingSampleRepository,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {}

  /** sha256 of the normalised text: trimmed, whitespace runs collapsed, case folded. */
  static contentHash(text: string): string {
    const normalised = text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
    return createHash('sha256').update(normalised, 'utf8').digest('hex');
  }

  async store(input: StoreDnaSampleInput): Promise<StoreDnaSampleOutcome> {
    const contentHash = DnaMemoryStore.contentHash(input.text);
    const existing = await this.sampleRepository.findByContentHash(input.tenantId, input.doctorId, contentHash);
    if (existing) return { stored: false, duplicateOf: existing.id };

    if (!this.secretsService) {
      throw new Error('DNA memory sample cannot be stored: no SecretsService is available to encrypt it');
    }
    const text = await this.sampleRepository.encryptText(this.secretsService, input.text);
    if (!text) throw new Error('DNA memory sample cannot be stored: empty text');
    const draft = input.aiDraft ? await this.sampleRepository.encryptText(this.secretsService, input.aiDraft) : null;

    const entity = DnaWritingSampleFactory.CreateDnaWritingSample({
      tenantId: input.tenantId,
      doctorId: input.doctorId,
      source: input.source,
      textCiphertext: text.ciphertext,
      aiDraftCiphertext: draft?.ciphertext ?? null,
      keyVersion: text.keyVersion,
      writtenAt: input.writtenAt,
      kind: input.kind ?? null,
      sourceRef: input.sourceRef ?? null,
      contentHash,
      ingestBatchId: input.ingestBatchId ?? null,
      consultationId: input.consultationId ?? null,
      contextItemId: input.contextItemId ?? null,
      createdBy: input.createdBy ?? null,
    });
    const saved = await this.sampleRepository.create(entity);
    return { stored: true, id: saved?.id ?? entity.id };
  }
}
