/**
 * 02-presummary-stream.ts
 *
 * Shows: streaming a pre-summary — iterating `delta` events as they arrive
 * (for a live "typing" UI or log), then reading the terminal `result` via
 * `.result()` on a SEPARATE call. The underlying async generator can only be
 * consumed once, so this example makes two separate stream requests rather
 * than mixing `for await` and `.result()` on the same one.
 *
 * Env vars needed:
 *   HOPE_API_URL   e.g. http://localhost:8868
 *   HOPE_API_KEY   an API key with the `consultation:report:write` scope
 *
 * Run: npx tsx examples/02-presummary-stream.ts
 */

import { HopeClient, HopeStreamError } from '@arcaai/vox-node';

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

  const request = {
    current_department: 'General Medicine',
    formatted_vitals: 'BP 120/80, HR 72, Temp 98.6F',
  };

  // 1. Print deltas as they stream in.
  console.log('--- streaming deltas ---');
  for await (const event of hope.summarization.preSummaryStream(request)) {
    if (event.type === 'delta' || event.type === 'reasoning') {
      process.stdout.write(event.text);
    } else if (event.type === 'error') {
      throw new HopeStreamError(event.detail);
    }
    // event.type === 'result' also arrives here when iterating directly;
    // this example ignores it and re-fetches the terminal value below via
    // .result() on a fresh stream instead, to demonstrate both styles.
  }
  console.log('\n--- deltas done ---\n');

  // 2. Or, if you only want the final answer: collapse a stream to its
  // terminal payload with `.result()`.
  const result = await hope.summarization.preSummaryStream(request).result();
  console.log('pre_summary:', result.pre_summary);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
