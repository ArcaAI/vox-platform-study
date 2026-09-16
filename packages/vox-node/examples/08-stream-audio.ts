/**
 * 08-stream-audio.ts
 *
 * Shows: pushing audio a server already has into a consultation — a telephony
 * bridge, a recording relay, an ingest worker.
 *
 * This SDK is a socket CLIENT, not an inference stack: it opens HOPE's STT
 * stream protocol and sends bytes. Which ASR model runs is the tenant's
 * decision — name a published `SPEECH_TO_TEXT` agent with `agentSlug`, or name
 * nothing and let the tenant's assignment cascade choose. Realtime capture from
 * a BROWSER is the browser SDK's job, not this one's.
 *
 * Audio format: PCM16 little-endian, mono. Anything else is silence to the
 * recognizer.
 *
 * Env vars needed:
 *   HOPE_API_URL              e.g. http://localhost:8868
 *   HOPE_SVC_CLIENT_ID        a service-account client id
 *   HOPE_SVC_CLIENT_SECRET    its secret
 *   HOPE_CONSULTATION_ID      an already-open consultation (see 07)
 *   HOPE_AUDIO_PCM16          path to a raw PCM16 LE mono file
 *
 * Run: npx tsx examples/08-stream-audio.ts
 */

import { readFileSync } from 'node:fs';
import { HopeClient, SocketUnavailableError } from '@arcaai/vox-node';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

async function main(): Promise<void> {
  const hope = new HopeClient({
    baseUrl: requireEnv('HOPE_API_URL'),
    serviceAccount: { clientId: requireEnv('HOPE_SVC_CLIENT_ID'), clientSecret: requireEnv('HOPE_SVC_CLIENT_SECRET') },
  });
  const consultationId = requireEnv('HOPE_CONSULTATION_ID');

  // ── 1. Session, then recording ──────────────────────────────────────────────
  //
  // `context` (≤ 4 KB) is echoed VERBATIM on every transcript of this session, so a downstream
  // consumer can attribute a segment without a second lookup. It is validated against the ASR
  // agent's own frozen context schema.
  const session = await hope.stt.createStreamSession({ context: { source: 'telephony-bridge' } });
  await hope.consultations.recording.start(consultationId, { sessionId: session.sessionId });

  // ── 2. Open the socket and push bytes ───────────────────────────────────────
  //
  // The handshake carries a SINGLE-USE ticket, never a credential — which is why a reconnect
  // mints a fresh one rather than replaying this handshake. Node 22+: the socket is
  // `globalThis.WebSocket` and nothing else, because this SDK has zero runtime dependencies.
  try {
    const socket = hope.stt.socket(session);
    socket.on('transcript', (event) => console.log(`${event.isFinal ? 'final' : 'partial'}: ${event.text}`));
    socket.on('error', (event) => console.error('stt error:', event));
    await socket.connect();

    // `setMetadata` declares what is true from HERE in the audio onward — one microphone at a
    // time, sticky until the next call. Every transcript then carries the metadata in force over
    // its own audio.
    socket.setMetadata({ mic_id: 'caller' });

    const pcm = readFileSync(requireEnv('HOPE_AUDIO_PCM16'));
    const CHUNK = 32_000; // ~1s at 16 kHz mono PCM16
    for (let offset = 0; offset < pcm.length; offset += CHUNK) {
      socket.sendPcm16(pcm.subarray(offset, offset + CHUNK));
    }

    // `finalize()` flushes the tail of the last utterance and ENDS the session — it is the last
    // thing you send, not mid-stream punctuation. The session cannot be resumed afterwards.
    socket.finalize();
    socket.close();
  } catch (error) {
    // Named rather than polyfilled: a runtime with no WebSocket must fail loudly, not degrade
    // into the transport the caller ruled out.
    if (error instanceof SocketUnavailableError) console.error(`no WebSocket in this runtime: ${error.message}`);
    else throw error;
  }

  // ── 3. Stop ─────────────────────────────────────────────────────────────────
  await hope.consultations.recording.stop(consultationId);
  await hope.stt.closeStreamSession(session.sessionId);
  console.log('recording stopped; the note is being written');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
