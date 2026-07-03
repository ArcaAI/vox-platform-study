import { appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { IPasswordResetMailer, PasswordResetMailPayload } from './IPasswordResetMailer';

/**
 * TASK-400 — dev/test transport: captures would-be reset emails to a local
 * JSONL outbox so the live E2E suite (and a developer) can read the token
 * WITHOUT the API ever returning it. Non-production only — the factory never
 * selects this in production. Reports `false` (not delivered) and never throws.
 */

export const DEFAULT_PASSWORD_RESET_OUTBOX_FILE = join(tmpdir(), 'hope-password-reset-outbox.jsonl');

export class DevOutboxPasswordResetMailer implements IPasswordResetMailer {
  private readonly logger = new Logger(DevOutboxPasswordResetMailer.name);

  constructor(private readonly outboxFile: string = DEFAULT_PASSWORD_RESET_OUTBOX_FILE) {}

  async sendResetLink(payload: PasswordResetMailPayload): Promise<boolean> {
    try {
      appendFileSync(this.outboxFile, `${JSON.stringify({ ...payload, capturedAt: new Date().toISOString() })}\n`, 'utf8');
      this.logger.log(`Password-reset link captured to dev outbox (${this.outboxFile}) for ${payload.email} — NOT delivered.`);
    } catch (error) {
      this.logger.warn(`Dev outbox write failed (non-fatal): ${(error as Error).message}`);
    }
    return false; // capture is not delivery
  }
}
