/**
 * 01-summary.ts
 *
 * Shows: the stateless summarization path — POST a transcript, get a
 * summary back. No consultation, no prior setup. This is the fastest way to
 * try the SDK and the migration target for an existing v1 backend
 * integration (the request/response shapes are byte-identical to v1).
 *
 * Env vars needed:
 *   HOPE_API_URL   e.g. http://localhost:8868
 *   HOPE_API_KEY   an API key with the `consultation:report:write` scope
 *                  (see the README's "Auth" section for the full scope table;
 *                  local dev keys are seeded by
 *                  packages/database/src/prisma/db_main/seed/02-apikey.ts)
 *
 * Run: npx tsx examples/01-summary.ts
 */

import { HopeClient } from '@arcaai/vox-node';

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

  const now = new Date().toISOString();
  const response = await hope.summarization.summary({
    session_data: {
      created_at: now,
      conversation_segments: [
        { speaker: 'provider', text: 'What brings you in today?', timestamp: now },
        { speaker: 'patient', text: 'I have had a headache for three days.', timestamp: now },
      ],
    },
  });

  console.log('summary_id:', response.summary_id);
  console.log('summary:', JSON.stringify(response.summary, null, 2));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
