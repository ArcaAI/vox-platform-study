import type { IncomingMessage } from 'http';
import { uuidv7 } from 'uuidv7';

import { resolveClientIp, trustedProxiesFromEnv } from '../throttle/client-ip';

/**
 * The one shape a WebSocket gateway failure is logged in.
 *
 * A socket has no HTTP request, no exception filter and no CLS request id, so
 * the gateways each logged their own ad-hoc line — the message only, no stack,
 * no tenant, nothing a client could quote. This writes ONE line carrying the
 * session's identity and the Error itself (the logger formats name, message,
 * stack and cause), and returns the correlation id the gateway puts on the
 * client's `error` frame so the two can be joined.
 */
export interface WsFailureContext {
  /** Stable dotted event name, e.g. `stt_ws.message_failed`. */
  message: string;
  sessionId?: string;
  tenantId?: string | null;
  userId?: string | null;
  clientIp?: string;
  origin?: string;
  closeCode?: number;
  /** Reuse an id the client already holds; minted otherwise. */
  correlationId?: string;
  /** Defaults to `error`. */
  level?: 'warn' | 'error';
  [field: string]: unknown;
}

export function logWsFailure(
  logger: { error: (message: unknown) => void; warn: (message: unknown) => void },
  ctx: WsFailureContext,
  err: unknown,
): string {
  const { level = 'error', correlationId = uuidv7(), ...fields } = ctx;
  const error = err instanceof Error ? err : new Error(String(err));
  const line: Record<string, unknown> = { ...fields, correlationId, errorName: error.name, error };
  for (const key of Object.keys(line)) {
    if (line[key] === undefined || line[key] === null) delete line[key];
  }
  logger[level](line);
  return correlationId;
}

/** The client address for a handshake: the trusted-proxy header when the peer is a declared ingress, else the socket peer. */
export function wsClientIp(req: IncomingMessage): string | undefined {
  return resolveClientIp(req as unknown as Record<string, unknown>, trustedProxiesFromEnv()) ?? req.socket?.remoteAddress ?? undefined;
}
