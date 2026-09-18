import 'server-only';
import { createHash } from 'node:crypto';
import { gatewayUrl } from '@/server/gateway';
import { clearSession, getSession, setSession, type SessionPayload } from '@/server/session';

interface RefreshTokenResponse {
  token: string;
  refreshToken: string;
}

interface Rotation {
  /** The gateway's new token pair, or null when it rejected the rotation. */
  tokens: Promise<RefreshTokenResponse | null>;
  expiresAt: number;
}

/**
 * How long a settled rotation keeps answering callers that still hold the
 * token it consumed.
 *
 * The gateway's refresh tokens are SINGLE-USE, and presenting a consumed one
 * is read as a reuse attack: `refresh-token.service.ts` revokes the entire
 * family, turning a recoverable 401 into an unrecoverable logout. A page load
 * fires a dozen parallel proxied calls against the same expired access token,
 * and the ones that 401 *after* the rotation finished are separate requests
 * whose cookie still carries the pre-rotation token — they must be answered
 * from here rather than replayed at the gateway. Bounded, because the entry
 * holds a live token pair in memory.
 */
const ROTATION_MEMO_MS = 30_000;

/**
 * Keyed by the refresh token being spent, NOT by process: a caller can only
 * receive the result of the rotation it actually presented, so two operators
 * 401-ing concurrently in one Node process can never be handed each other's
 * tokens.
 */
const rotations = new Map<string, Rotation>();

function rotationKey(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}

async function rotate(refreshToken: string): Promise<RefreshTokenResponse | null> {
  const response = await fetch(gatewayUrl('auth/refresh'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    cache: 'no-store',
    redirect: 'manual',
  });

  if (!response.ok) return null;
  return (await response.json()) as RefreshTokenResponse;
}

/** The in-flight (or recently settled) rotation of this token, starting one if needed. */
function rotationFor(refreshToken: string): Rotation {
  const now = Date.now();
  for (const [key, entry] of rotations) {
    if (entry.expiresAt <= now) rotations.delete(key);
  }

  const key = rotationKey(refreshToken);
  const existing = rotations.get(key);
  if (existing) return existing;

  const entry: Rotation = { tokens: rotate(refreshToken), expiresAt: now + ROTATION_MEMO_MS };
  entry.tokens.then(
    () => {
      entry.expiresAt = Date.now() + ROTATION_MEMO_MS;
    },
    () => {
      // A transport failure is not an answer — drop it so the next caller retries.
      rotations.delete(key);
    },
  );
  rotations.set(key, entry);
  return entry;
}

/**
 * Rotates the session's refresh token via the gateway and reseals the cookie.
 * Returns the updated session, or null (with the cookie cleared) when the
 * gateway rejects the rotation.
 */
export async function refreshSession(session: SessionPayload): Promise<SessionPayload | null> {
  // `cookies()` is request-scoped, so this is THIS request's view of the
  // session. When it already holds a newer refresh token than the caller's
  // snapshot, the snapshot's token is spent: replaying it would be read as
  // reuse. Answer with what the cookie already carries.
  const current = (await getSession()) ?? session;
  if (current.refreshToken !== session.refreshToken) return current;

  const tokens = await rotationFor(session.refreshToken).tokens;
  if (!tokens) {
    await clearSession();
    return null;
  }

  const updated: SessionPayload = {
    ...current,
    accessToken: tokens.token,
    refreshToken: tokens.refreshToken,
    // Keep the impersonation snapshot of the original tokens in sync so
    // revoke-impersonation restores tokens that are still valid.
    impersonation: current.impersonation
      ? { ...current.impersonation, originalAccessToken: tokens.token, originalRefreshToken: tokens.refreshToken }
      : undefined,
  };
  // Resealed per caller, in its OWN request context: only the gateway call is
  // shared. A request that merely joined another's rotation would otherwise
  // answer with no Set-Cookie, and if that other response never lands (an
  // aborted navigation, a cancelled query) the browser would keep replaying
  // the spent token.
  await setSession(updated);
  return updated;
}
