/**
 * TASK-985 (M-03 / BP-5) — the gateway's Prometheus surface for realtime STT.
 *
 * ## Why this file exists
 *
 * Before it, `grep -n "Counter\|Histogram\|Gauge" apps/api/src/modules/streaming/stt-ws.gateway.ts`
 * returned NOTHING. The gateway is the hop that owns first-partial latency, commit latency,
 * egress back-pressure and the Redis relay, and not one of those was measurable on the cluster:
 * a regression that doubled time-to-first-caption, or one that silently discarded every partial
 * of a consultation, was visible only in a per-session debug log nobody scrapes. The dossier's
 * whole measurement plan (D7 §1.3) needs these series to exist before any arm can be run.
 *
 * ## Why it lives in `packages/applications` and not `apps/api/src/observability/`
 *
 * D7 §1.3 proposed `apps/api/src/observability/stt-metrics.ts`. Two of the seven series are
 * emitted from `StreamingAudioBridgeService` / `StreamingSessionService`, which live HERE and
 * cannot import from `apps/api`. Splitting one contract across two files so that half of it can
 * sit at the suggested path would mean two places to keep the names, labels and buckets in step —
 * exactly the drift a metric contract exists to prevent. One module, imported by both sides.
 *
 * ## Registration
 *
 * `prom-client` exposes a process-global default `register`, which
 * `@willsoto/nestjs-prometheus` serves at `GET /metrics`. Registration is idempotent
 * (`getSingleMetric(...) ?? new X(...)`) because this module is imported by two packages and a
 * test file may import it more than once per process — a second `new Histogram({name})` on the
 * same register THROWS, and a metric module must never be able to fail a boot.
 *
 * ## PHI and cardinality
 *
 * No tenant id, no user id, no session id, no text. `agentSlug` is the ONLY label with any
 * cardinality risk and it is discussed on {@link STT_GATEWAY_UNKNOWN_AGENT}.
 */
import { Counter, Histogram, register } from 'prom-client';

/**
 * The `agentSlug` value used when the session's ASR agent is not known to the gateway.
 *
 * ### The cardinality note D7 §3 requires, stated where the label is produced
 *
 * `agentSlug` is bounded ONLY while tenants use the cloned SYSTEM reference set: every tenant
 * clones the SAME small set of `SPEECH_TO_TEXT` agents (`00-project-context.md` §"Content is
 * cloned; configuration cascades"), so slugs REPEAT across tenants rather than multiplying, and
 * the platform-wide distinct count stays in the low tens.
 *
 * That is a property of today's content model, not a guarantee of this file. **If a tenant is
 * ever allowed to author a free-form agent slug, this label must be dropped to a constant** —
 * one series per tenant-authored slug is unbounded growth on a histogram with ten buckets. Do
 * NOT "fix" that by labelling with `tenantId` (PHI-adjacent, and the existing
 * `STREAMING_AUDIO_DURATION` rule already forbids it) or with the agent's UUID (one series per
 * session-worth of history).
 *
 * Until `StreamSessionMeta` carries the slug (see the cross-lane request in the TASK-985 L-GW
 * report), every gateway session reports this constant — honest, and cardinality 1.
 */
export const STT_GATEWAY_UNKNOWN_AGENT = 'unknown';

/** Seconds from the first forwarded audio frame to the session's first partial transcript. */
export const STT_GATEWAY_FIRST_PARTIAL_SECONDS = 'stt_gateway_first_partial_seconds';

/**
 * Seconds from the wall-clock instant the audio at a final's `endTime` was forwarded, to the
 * instant that final reached the gateway. This is the "how long after I stopped speaking did the
 * sentence go solid" number, measured against the session's own AUDIO CLOCK rather than against
 * a wall clock the client and the server would each read differently.
 */
export const STT_GATEWAY_COMMIT_LATENCY_SECONDS = 'stt_gateway_commit_latency_seconds';

/** Transcripts the gateway could not deliver because the client socket was over its watermark. */
export const STT_GATEWAY_AUDIO_EGRESS_DROPPED_TOTAL = 'stt_gateway_audio_egress_dropped_total';

/** Audio frames whose XADD to `stt:audio:{sessionId}` rejected. The SERVER half of M-67. */
export const STT_GATEWAY_AUDIO_INGEST_DROPPED_TOTAL = 'stt_gateway_audio_ingest_dropped_total';

/**
 * Audio frames the CLIENT reports it discarded before they ever reached the gateway, read off
 * the `{type:'client_stats'}` frame (M-67). Deliberately a SEPARATE series from
 * {@link STT_GATEWAY_AUDIO_INGEST_DROPPED_TOTAL}: one is a fact the server observed, the other
 * is a claim the client made, and summing them would make an unverifiable number look measured.
 */
export const STT_GATEWAY_CLIENT_AUDIO_DROPPED_TOTAL = 'stt_gateway_client_audio_dropped_total';

/** Seconds between a result being written to `stt:result:{id}` and the gateway parsing it. */
export const STT_GATEWAY_RELAY_LAG_SECONDS = 'stt_gateway_relay_lag_seconds';

/**
 * Session teardowns that produced NO usage summary, so no `transcribe.stream` ledger row.
 *
 * D8 §8 N-5: `removeSession` treated HTTP 204 and "no summary built" identically, with no warn
 * and no counter, which is why the M-23 ledger loss needed a code read to find. Non-zero here
 * means metered clinical work was not billed.
 */
export const STT_STREAM_TEARDOWN_SUMMARY_MISSING_TOTAL = 'stt_stream_teardown_summary_missing_total';

export const sttGatewayFirstPartialSeconds: Histogram<'agentSlug'> =
  (register.getSingleMetric(STT_GATEWAY_FIRST_PARTIAL_SECONDS) as Histogram<'agentSlug'> | undefined) ??
  new Histogram({
    name: STT_GATEWAY_FIRST_PARTIAL_SECONDS,
    help: 'Seconds from the first audio frame forwarded upstream to the first partial transcript relayed to the client, per session.',
    labelNames: ['agentSlug'] as const,
    buckets: [0.25, 0.5, 1, 1.5, 2, 3, 5, 10],
    registers: [register],
  });

export const sttGatewayCommitLatencySeconds: Histogram<'agentSlug'> =
  (register.getSingleMetric(STT_GATEWAY_COMMIT_LATENCY_SECONDS) as Histogram<'agentSlug'> | undefined) ??
  new Histogram({
    name: STT_GATEWAY_COMMIT_LATENCY_SECONDS,
    help: "Seconds from forwarding the audio at a final transcript's endTime to relaying that final, measured on the session's audio clock.",
    labelNames: ['agentSlug'] as const,
    buckets: [0.5, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15],
    registers: [register],
  });

export const sttGatewayAudioEgressDroppedTotal: Counter<'kind'> =
  (register.getSingleMetric(STT_GATEWAY_AUDIO_EGRESS_DROPPED_TOTAL) as Counter<'kind'> | undefined) ??
  new Counter({
    name: STT_GATEWAY_AUDIO_EGRESS_DROPPED_TOTAL,
    help: 'Transcripts dropped on the WS egress path because the client socket exceeded its high watermark. kind=partial|final.',
    labelNames: ['kind'] as const,
    registers: [register],
  });

export const sttGatewayAudioIngestDroppedTotal: Counter<string> =
  (register.getSingleMetric(STT_GATEWAY_AUDIO_INGEST_DROPPED_TOTAL) as Counter<string> | undefined) ??
  new Counter({
    name: STT_GATEWAY_AUDIO_INGEST_DROPPED_TOTAL,
    help: 'Audio frames the gateway failed to write to the Redis audio stream. Unlabelled on purpose (transport-level signal).',
    registers: [register],
  });

export const sttGatewayClientAudioDroppedTotal: Counter<string> =
  (register.getSingleMetric(STT_GATEWAY_CLIENT_AUDIO_DROPPED_TOTAL) as Counter<string> | undefined) ??
  new Counter({
    name: STT_GATEWAY_CLIENT_AUDIO_DROPPED_TOTAL,
    help: 'Audio frames the CLIENT reported discarding before send, from its end-of-session client_stats frame. A claim, not an observation.',
    registers: [register],
  });

export const sttGatewayRelayLagSeconds: Histogram<string> =
  (register.getSingleMetric(STT_GATEWAY_RELAY_LAG_SECONDS) as Histogram<string> | undefined) ??
  new Histogram({
    name: STT_GATEWAY_RELAY_LAG_SECONDS,
    help: 'Seconds between the Redis result entry being written by STT and the gateway parsing it. Unlabelled on purpose.',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [register],
  });

export const sttStreamTeardownSummaryMissingTotal: Counter<'status'> =
  (register.getSingleMetric(STT_STREAM_TEARDOWN_SUMMARY_MISSING_TOTAL) as Counter<'status'> | undefined) ??
  new Counter({
    name: STT_STREAM_TEARDOWN_SUMMARY_MISSING_TOTAL,
    help: 'Streaming teardowns that yielded no usage summary, so emitted no transcribe.stream ledger row. Labelled by the upstream HTTP status.',
    labelNames: ['status'] as const,
    registers: [register],
  });

/**
 * Observe the relay lag encoded in a Redis Stream entry id.
 *
 * A Redis entry id is `<ms>-<seq>`, and the `<ms>` half is the server's own clock at XADD — so
 * the lag is readable with NO wire-format change and no extra field for STT to write. Negative
 * values (gateway clock behind the Redis node's) clamp to 0 rather than being discarded: a
 * clamped 0 says "as fast as we can tell", a discard would silently thin the histogram exactly
 * when clocks disagree.
 *
 * Never throws: a metric must not be able to break a caption relay.
 */
export function observeRelayLagFromEntryId(entryId: string | undefined): void {
  if (!entryId) return;
  const ms = Number(entryId.split('-')[0]);
  if (!Number.isFinite(ms) || ms <= 0) return;
  sttGatewayRelayLagSeconds.observe(Math.max(0, Date.now() - ms) / 1000);
}
