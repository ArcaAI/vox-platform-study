/**
 * 03-consultation-async.ts
 *
 * Shows: the recommended pattern for long transcripts — hand generation off
 * to a background job with `generateAsync`, then wait for it with
 * `jobs.waitFor` (which prefers live SSE and falls back to polling).
 *
 * Requires an existing consultation id (this SDK does not create
 * consultations — see the README's "The two summarization families"
 * section). Substitute one from your own HOPE tenant.
 *
 * Env vars needed:
 *   HOPE_API_URL       e.g. http://localhost:8868
 *   HOPE_API_KEY       an API key with `consultation:report:write` AND
 *                       `consultation:session:read` (or `consultation:*`)
 *   HOPE_CONSULTATION_ID  an existing consultation id in your tenant
 *
 * Run: npx tsx examples/03-consultation-async.ts
 */

import { HopeClient, isTerminalJobStatus } from '@arcaai/vox-node';

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
  const consultationId = requireEnv('HOPE_CONSULTATION_ID');

  const { jobId } = await hope.consultations.summaries.generateAsync(consultationId, {
    transcription: 'Patient reports a three-day headache, no fever, no visual disturbance.',
  });
  console.log('submitted job:', jobId);

  const job = await hope.jobs.waitFor(jobId, { pollIntervalMs: 2000 });

  // isTerminalJobStatus() accepts both job-status vocabularies HOPE uses
  // (see the README's "Known gateway quirks" section, G5) — waitFor() only
  // ever resolves once one of them is terminal, so this check is just
  // demonstrating the helper, not doing real work here.
  console.log('terminal:', isTerminalJobStatus(job.status), 'status:', job.status);
  console.log('result:', job.result);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
