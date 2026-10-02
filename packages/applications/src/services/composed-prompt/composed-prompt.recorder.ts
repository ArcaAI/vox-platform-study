/**
 * Records the composed messages an LLM call was sent — the OD-9 incident record.
 *
 * ONE helper for every writer: the gateway's text call sites (through
 * `TextRequestEnrichmentService.applyEgressSafety`, which every gateway → TEXT call runs) and the
 * harness's `POST internal/composed-prompts`.
 *
 * A record must never fail or slow the text call it describes, so `record()` is FIRE-AND-FORGET:
 * the write is scheduled on the next turn (`setImmediate`), runs behind a caught promise, and is
 * DROPPED — not queued — once too many writes are already in flight. Without a Transit-capable
 * secrets provider nothing is written: both messages carry PHI and there is no plaintext column.
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ComposedPromptRecordFactory, ComposedPromptRecordRepository, ResourceType, SysEventType, type ComposedPromptRecordEntity } from '@arcaai/domains';
import { BaseService } from '../../common/base.service';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets/SecretsService';
import type { ComposedPromptLocality } from './dto/composed-prompt.dto';

export interface ComposedPromptRecordInput {
  tenantId: string;
  consultationId?: string | null;
  agentSlug?: string | null;
  phase: string;
  provider: string;
  locality: ComposedPromptLocality;
  system: string;
  user: string;
}

/** Writes allowed in flight at once; beyond it a record is dropped rather than queued. */
export const COMPOSED_PROMPT_MAX_IN_FLIGHT = 32;

/** SHA-256 (hex) of the plaintext `system + "\n\n" + user` — matches two identical prompts without a decrypt. */
export function composedPromptDigest(system: string, user: string): string {
  return createHash('sha256').update(`${system}\n\n${user}`, 'utf8').digest('hex');
}

@Injectable()
export class ComposedPromptRecorder extends BaseService {
  private readonly logger = new Logger(ComposedPromptRecorder.name);
  private inFlight = 0;

  constructor(
    private readonly repository: ComposedPromptRecordRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super(eventEmitter, clsService, ResourceType.ComposedPromptRecord);
  }

  /** Schedule a record. Never throws, never awaits the write. */
  record(input: ComposedPromptRecordInput): void {
    if (this.inFlight >= COMPOSED_PROMPT_MAX_IN_FLIGHT) {
      this.logger.warn({ message: 'Composed-prompt record dropped: too many writes in flight', phase: input.phase });
      return;
    }
    this.inFlight += 1;
    setImmediate(() => {
      void this.write(input)
        .catch((error) =>
          // Never the messages — only that this call has no incident record.
          this.logger.warn({
            message: 'Composed-prompt record write failed',
            phase: input.phase,
            error: error instanceof Error ? error.name : 'unknown',
          }),
        )
        .finally(() => {
          this.inFlight -= 1;
        });
    });
  }

  /**
   * Encrypt and persist one record, in the record's own tenant. Answers `null` (and writes
   * nothing) when no Transit-capable secrets provider is wired.
   */
  async write(input: ComposedPromptRecordInput): Promise<ComposedPromptRecordEntity | null> {
    if (!this.secretsService) return null;
    const [system, user] = await Promise.all([
      this.repository.encryptText(this.secretsService, input.system),
      this.repository.encryptText(this.secretsService, input.user),
    ]);
    const entity = ComposedPromptRecordFactory.CreateComposedPromptRecord({
      tenantId: input.tenantId,
      consultationId: input.consultationId ?? null,
      agentSlug: input.agentSlug ?? null,
      phase: input.phase,
      provider: input.provider,
      locality: input.locality,
      systemCiphertext: system.ciphertext,
      userCiphertext: user.ciphertext,
      keyVersion: system.keyVersion ?? user.keyVersion,
      sha256: composedPromptDigest(input.system, input.user),
    });
    return this.clsService.run({ ifNested: 'inherit' }, async () => {
      this.clsService.set('tenantId', input.tenantId);
      const saved = await this.repository.create(entity);
      // Metadata only on the event: the messages are PHI and stay in the ciphertext columns.
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: saved.id,
        data: { phase: input.phase, provider: input.provider, locality: input.locality, consultationId: input.consultationId ?? null },
      });
      return saved;
    });
  }
}
