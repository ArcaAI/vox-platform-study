/**
 * 05-agents-and-workflows.ts
 *
 * Shows: the three surfaces the other examples do not touch — running a
 * published AGENT, streaming a WORKFLOW RUN over both transports, and
 * releasing a `core.humanReview` node so a parked run finishes.
 *
 * These are the "tenant publishes a product, you call it" plane. Nothing here
 * administers anything: authoring, versioning, publishing and assignment are
 * `hope.admin.*`, which needs a service account and is a different example.
 *
 * Env vars needed:
 *   HOPE_API_URL         e.g. http://localhost:8868
 *   HOPE_API_KEY         a key with agent:invocation:write + workflow:run:write
 *   HOPE_AGENT_SLUG      optional — defaults to the first TEXT_GENERATION agent
 *   HOPE_WORKFLOW_SLUG   optional — defaults to the first published workflow
 *
 * Run: npx tsx examples/05-agents-and-workflows.ts
 */

import { HopeClient, NotFoundError, SocketUnavailableError } from '@arcaai/vox-node';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

async function main(): Promise<void> {
  const hope = new HopeClient({ baseUrl: requireEnv('HOPE_API_URL'), apiKey: requireEnv('HOPE_API_KEY') });

  // ── 1. Run a published agent ────────────────────────────────────────────────
  //
  // `list()` never returns null: `[]` means the tenant has published none, which is a
  // different fact from "the read failed" and is why this checks length rather than truthiness.
  const writers = await hope.agents.list({ task: 'TEXT_GENERATION' });
  if (writers.length === 0) {
    console.log('No TEXT_GENERATION agent is published for this tenant — nothing to invoke.');
    return;
  }
  const agentSlug = process.env.HOPE_AGENT_SLUG ?? writers[0]!.slug;

  // The input is the BODY, sent flat — it is validated against the agent's own `inputSchema`.
  // (`{ input: … }` is the WORKFLOW plane's envelope; sending it here is a 400.)
  const answer = await hope.agents.invoke(agentSlug, { text: 'Patient reports a dry cough for three days.' });
  console.log(`agent ${agentSlug} →`, answer.output);

  // A NER agent is the same call with a different output. It is ONE-SHOT: `?mode=stream` on one
  // is a gateway 400, so never reach for `invokeAndStream` here.
  const nerAgents = await hope.agents.list({ task: 'NAMED_ENTITY_RECOGNITION' });
  if (nerAgents.length > 0) {
    const ner = await hope.agents.invoke<{ entities: { text: string; label: string }[] }>(nerAgents[0]!.slug, {
      text: 'Started metformin 500mg twice daily.',
    });
    console.log(`agent ${nerAgents[0]!.slug} → ${ner.output.entities.map((e) => `${e.text}:${e.label}`).join(', ')}`);
  }

  // ── 2. Run a workflow and watch it live ─────────────────────────────────────
  const workflows = await hope.workflows.list();
  if (workflows.length === 0) {
    console.log('No workflow is published for this tenant — nothing to run.');
    return;
  }
  const slug = process.env.HOPE_WORKFLOW_SLUG ?? workflows[0]!.slug;

  // SSE is the default lane, and the only one that RESUMES: a dropped connection reconnects
  // with `Last-Event-ID` and loses no frames. `runAndStream` starts the run and reads its
  // events on the same response.
  let runId: string | undefined;
  for await (const event of hope.workflows.runAndStream(slug, { input: { note: 'Dry cough, three days.' } })) {
    runId = runId ?? (event.payload as { runId?: string } | undefined)?.runId ?? event.correlationId;
    console.log(`  ${event.type}`);
  }

  // The socket lane reads the SAME events over a WebSocket, for a deployment where something
  // in front of the gateway buffers `text/event-stream` — the symptom is a run that looks
  // stalled and then completes all at once. It needs Node 22+ (the SDK has zero dependencies,
  // so the socket is the platform global), and it does NOT resume: the ticket is single-use.
  if (runId !== undefined) {
    try {
      const status = await hope.workflows.waitForRun(slug, runId, { transport: 'socket' });
      console.log(`run ${runId} finished: ${status.status}`);
    } catch (error) {
      if (error instanceof SocketUnavailableError) console.log(`socket lane unavailable: ${error.message}`);
      else throw error;
    }
  }

  // ── 3. Release a human-review node ──────────────────────────────────────────
  //
  // A `core.humanReview` node parks the run on a PERSON and waits, durably. Everything
  // downstream of the handle that never fires is skipped, so this is the call that decides
  // whether a paused run ever finishes.
  //
  // `exists: false` is the interpreter's own answer for a review that has not started or has
  // already settled — a real outage THROWS instead, which is what keeps a reviewer UI from
  // rendering an empty queue during one.
  const nodeId = process.env.HOPE_REVIEW_NODE_ID;
  if (runId !== undefined && nodeId !== undefined) {
    try {
      const review = await hope.workflows.reviews.get(slug, runId, nodeId);
      if (review.exists) {
        // `reviewerId` is NOT a field you can send: the gateway stamps the acting user from
        // your credential, because an approval is an attribution.
        await hope.workflows.reviews.decide(slug, runId, nodeId, { decision: 'approved', comment: 'Looks right.' });
        console.log(`review ${nodeId} approved — the graph resumes down the \`approved\` handle`);
      } else {
        console.log(`review ${nodeId} is not waiting (not started, or already decided)`);
      }
    } catch (error) {
      // 404-over-403: an id from another tenant is "not yours", not "no such route".
      if (error instanceof NotFoundError) console.log(`review ${nodeId} not found for this tenant`);
      else throw error;
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
