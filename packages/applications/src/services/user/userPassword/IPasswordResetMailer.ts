import { Logger } from '@nestjs/common';

/**
 * TASK-388 #8 — password-reset email delivery boundary.
 *
 * Kept behind a thin interface so the reset service does not depend on any
 * concrete provider (e.g. the dormant `MicrosoftGraphIntegration`, which needs
 * MS Graph secrets + a config factory to construct). Delivery is best-effort:
 * implementations MUST NOT throw — a delivery failure must never block the
 * reset (the admin flow returns the link/token directly). Productionizing real
 * delivery (wiring `MicrosoftGraphIntegration` behind this port once MS Graph
 * secrets are provisioned) is a documented follow-up.
 */
export interface PasswordResetMailPayload {
  email: string;
  resetPath: string;
  token: string;
  expiresInSeconds: number;
}

export interface IPasswordResetMailer {
  /** Returns true when the message was accepted for delivery, false otherwise. */
  sendResetLink(payload: PasswordResetMailPayload): Promise<boolean>;
}

export const IPasswordResetMailer = Symbol('IPasswordResetMailer');

/**
 * Default mailer: logs and reports `false` (not sent). Used in dev/test and any
 * environment where a real provider has not been wired. Never throws.
 */
export class LoggingPasswordResetMailer implements IPasswordResetMailer {
  private readonly logger = new Logger(LoggingPasswordResetMailer.name);

  async sendResetLink(payload: PasswordResetMailPayload): Promise<boolean> {
    this.logger.warn(
      `Password-reset email NOT delivered (no mailer provider configured). ` +
        `Would send a reset link to ${payload.email}. Convey the link via the admin response instead.`,
    );
    return false;
  }
}
