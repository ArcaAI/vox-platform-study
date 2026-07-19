import { Logger } from '@nestjs/common';
import { MicrosoftGraphIntegration } from '../../baseServices/integrations/microsoftGraph/microsoftGraph.integration';
import { DEFAULT_PASSWORD_RESET_BASE_URL, IPasswordResetMailer, LoggingPasswordResetMailer, PasswordResetMailPayload } from './IPasswordResetMailer';
import { DevOutboxPasswordResetMailer } from './dev-outbox-mailer';

/**
 * TASK-400 — real password-reset delivery over MS Graph.
 *
 * Wraps the pre-existing `MicrosoftGraphIntegration` (client-credentials app,
 * `/users/{sender}/sendMail`) behind the `IPasswordResetMailer` port. Selection
 * is env-driven at module wiring time:
 *
 *   MSGRAPH_CLIENT_ID     — Azure AD app registration (application) id
 *   MSGRAPH_CLIENT_SECRET — client secret for that app
 *   MSGRAPH_TENANT_ID     — Azure AD tenant id
 *   MSGRAPH_SENDER        — mailbox to send from (user id or UPN; needs Mail.Send)
 *   PASSWORD_RESET_BASE_URL — public admin-app origin used to absolutize the
 *                             reset link (default http://localhost:5176)
 *
 * All four MSGRAPH_* present → `MsGraphPasswordResetMailer`; anything missing →
 * `LoggingPasswordResetMailer` (dev transport: logs, reports not-sent, never
 * throws), so the reset flows keep working without Graph provisioning.
 */

export const MSGRAPH_REQUIRED_ENV_VARS = ['MSGRAPH_CLIENT_ID', 'MSGRAPH_CLIENT_SECRET', 'MSGRAPH_TENANT_ID', 'MSGRAPH_SENDER'] as const;

const GRAPH_SCOPES = ['https://graph.microsoft.com/.default'];

export type PasswordResetMailerConfig =
  | {
      kind: 'graph';
      clientId: string;
      clientSecret: string;
      tenantId: string;
      sender: string;
      baseUrl: string;
    }
  | { kind: 'logging'; missing: string[] };

export function resolvePasswordResetMailerConfig(env: Record<string, string | undefined> = process.env): PasswordResetMailerConfig {
  const missing = MSGRAPH_REQUIRED_ENV_VARS.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    return { kind: 'logging', missing };
  }
  return {
    kind: 'graph',
    clientId: env.MSGRAPH_CLIENT_ID!.trim(),
    clientSecret: env.MSGRAPH_CLIENT_SECRET!.trim(),
    tenantId: env.MSGRAPH_TENANT_ID!.trim(),
    sender: env.MSGRAPH_SENDER!.trim(),
    baseUrl: env.PASSWORD_RESET_BASE_URL?.trim() || DEFAULT_PASSWORD_RESET_BASE_URL,
  };
}

export class MsGraphPasswordResetMailer implements IPasswordResetMailer {
  private readonly logger = new Logger(MsGraphPasswordResetMailer.name);

  constructor(
    private readonly graph: Pick<MicrosoftGraphIntegration, 'sendEmail'>,
    private readonly options: { sender: string; baseUrl: string },
  ) {}

  async sendResetLink(payload: PasswordResetMailPayload): Promise<boolean> {
    const link = `${this.options.baseUrl.replace(/\/$/, '')}${payload.resetPath}`;
    const minutes = Math.round(payload.expiresInSeconds / 60);
    const content = [
      'A password reset was requested for your HOPE account.',
      '',
      `Open this link to choose a new password (valid for ${minutes} minutes, single use):`,
      link,
      '',
      'If you did not request this, you can ignore this email — your password is unchanged.',
    ].join('\n');

    try {
      await this.graph.sendEmail(this.options.sender, 'HOPE password reset', content, [payload.email]);
      return true;
    } catch (error) {
      this.logger.warn(`MS-Graph password-reset send failed (non-fatal): ${(error as Error).message}`);
      return false;
    }
  }
}

/**
 * Module factory. Selection:
 *  - all MSGRAPH_* present → Graph transport (real delivery),
 *  - missing + non-production → dev outbox (JSONL capture, lets E2E read the token),
 *  - missing + production → plain logging no-op (never write tokens to disk in prod).
 */
export function createPasswordResetMailer(env: Record<string, string | undefined> = process.env): IPasswordResetMailer {
  const config = resolvePasswordResetMailerConfig(env);
  const logger = new Logger('PasswordResetMailer');

  if (config.kind === 'logging') {
    if (env.NODE_ENV === 'production') {
      logger.warn(`Password-reset mailer: LOG-ONLY (MS Graph not provisioned; missing: ${config.missing.join(', ')})`);
      return new LoggingPasswordResetMailer();
    }
    logger.log(`Password-reset mailer: DEV OUTBOX transport (MS Graph not provisioned; missing: ${config.missing.join(', ')})`);
    return new DevOutboxPasswordResetMailer(env.PASSWORD_RESET_OUTBOX_FILE || undefined);
  }

  logger.log(`Password-reset mailer: MS Graph transport (sender ${config.sender})`);
  const graph = new MicrosoftGraphIntegration(config.clientId, config.clientSecret, config.tenantId, GRAPH_SCOPES);
  return new MsGraphPasswordResetMailer(graph, { sender: config.sender, baseUrl: config.baseUrl });
}
