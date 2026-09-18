export * from './dto';
export * from './speaker-label';
// TASK-951 R2 — the per-audio-span metadata timeline (pure; the gateway owns the clock).
export * from './stream-metadata-timeline';
export * from './IStreamingSessionService';
export * from './streamingSession.service';
export * from './streamingAudioBridge.service';
// TASK-985 (M-03 / BP-5) — the gateway's Prometheus contract for realtime STT. Exported so
// `apps/api`'s WS gateway emits the SAME series definitions the bridge and the session service
// do, rather than a second set that drifts.
export * from './stt-gateway.metrics';
// TASK-985 ST-5 — the gateway-side WS transport budgets.
//
// They are declared in `settings-registry/descriptors/stt-gateway.descriptors.ts`, whose own
// barrel deliberately does not `export *` every descriptor file, so `apps/api`'s WS gateway —
// which already imports this streaming surface — reaches the keys and the code defaults through
// here. NAMED, not `export *`: adding a descriptor to that file must not silently widen this
// package's public API.
export {
  STT_EGRESS_HIGH_WATERMARK_BYTES_KEY,
  STT_GATEWAY_DEFAULTS,
  STT_RESUME_GRACE_MS_KEY,
  STT_RESUME_MAX_REPLAY_AGE_MS_KEY,
  STT_SESSION_CREATE_TIMEOUT_MS_KEY,
  STT_WS_PING_INTERVAL_MS_KEY,
  STT_WS_PING_MISSES_KEY,
} from '../../settings-registry/descriptors/stt-gateway.descriptors';
export * from './streamingSession.service.module';
