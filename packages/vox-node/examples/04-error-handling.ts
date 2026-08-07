/**
 * 04-error-handling.ts
 *
 * Shows: catching the typed error hierarchy, including the 404-over-403
 * nuance — a NotFoundError from HOPE can mean "this id belongs to a
 * different tenant", not just "this id does not exist". See the README's
 * "NotFoundError — read this before filing a bug" section.
 *
 * Env vars needed:
 *   HOPE_API_URL   e.g. http://localhost:8868
 *   HOPE_API_KEY   any valid API key (this example deliberately queries an
 *                  id that likely does not belong to it, to demonstrate the
 *                  404 path)
 *
 * Run: npx tsx examples/04-error-handling.ts
 */

import {
  AuthenticationError,
  HopeAPIError,
  HopeClient,
  NotFoundError,
  PermissionError,
  QuotaExceededError,
  RateLimitError,
} from '@arcaai/vox-node';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

async function main(): Promise<void> {
  const hope = new HopeClient({
    baseUrl: requireEnv('HOPE_API_URL'),
    apiKey: requireEnv('HOPE_API_KEY'),
  });

  // A well-formed but almost certainly non-owned/non-existent id, to
  // demonstrate the 404 path without needing a specific fixture.
  const probeId = '00000000-0000-7000-8000-000000000000';

  try {
    await hope.consultations.get(probeId);
    console.log('Unexpectedly found a consultation with the probe id.');
  } catch (err) {
    if (err instanceof NotFoundError) {
      // HOPE returns 404 for BOTH "never existed" and "exists, but belongs
      // to a different tenant" (404-over-403 posture) — a 404 here is not
      // proof the id is wrong. See NotFoundError's own docstring/the
      // README's callout before assuming this is a client bug.
      console.log('NotFoundError (expected for a probe id):', err.message);
    } else if (err instanceof AuthenticationError) {
      console.error('Auth failed — check HOPE_API_KEY:', err.message);
    } else if (err instanceof PermissionError) {
      console.error('Permission denied — a privilege boundary, not tenancy:', err.message);
    } else if (err instanceof RateLimitError) {
      console.error('Rate limited; retry after (ms):', err.retryAfterMs, err.message);
    } else if (err instanceof QuotaExceededError) {
      console.error('Quota exceeded:', err.message);
    } else if (err instanceof HopeAPIError) {
      // Catches every other HopeAPIError subclass uniformly (status/code/requestId).
      console.error(`HopeAPIError [${err.status}] ${err.code ?? ''}:`, err.message, 'requestId:', err.requestId);
    } else {
      throw err;
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
