'use client';

/**
 * @arcaai/vox/compat - v1 config → v2 AgenticConfig adapter
 *
 * Pure function. No baked-in default apiKey/encryptionKey
 * an omitted `credentials.apiKey` THROWS.
 */

import type { AgenticConfig, AudioPluginConfig, LoggingConfig } from '../types';
import type { V1SdkConfig, V1AudioSettings } from './types';

/**
 * Ensure the REST base carries the gateway's `/api/v1` prefix.
 *
 * v1 apps configured `apiEndpoint` as the bare origin (`https://api.arcaai.com`).
 * v2's `AgenticClient` treats `baseUrl` as already carrying `/api/v1` (its
 * endpoint constants omit the prefix — see `src/core/constants.ts`, and real
 * consumers such as ui-playground set `http://localhost:8868/api/v1`). So the
 * adapter normalizes the origin up to `/api/v1`, which is what the delegated v2
 * session/audio hooks need. The `useText` compat hook derives the origin back off this
 * value for the `/api/smr/...` shim paths, which live OUTSIDE `/api/v1`.
 */
function ensureApiV1Base(apiEndpoint: string): string {
  const trimmed = apiEndpoint.trim().replace(/\/+$/, '');
  return /\/api\/v1$/.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
}

/**
 * Map the v1 audio settings + pipeline id onto v2's `AudioPluginConfig`.
 *
 * Only keys the caller stated a preference for are emitted, so a v1 config that
 * predates a given switch keeps producing the exact object it always did.
 *
 * Worth knowing about the keys that are NOT emitted: `AgenticProvider` resolves
 * `cfg.audio ?? DEFAULT_AUDIO_CONFIG` — it does NOT merge — and
 * `PluginManager.getConfig()` resolves a missing plugin key to
 * `{ enabled: false }`. So the moment this adapter emits ANY audio config (which
 * it does for every `sttPipelineId`), every stage it omits is OFF, not
 * defaulted. Stating a preference explicitly is therefore the only way a compat
 * app can turn a stage ON as well as off.
 *
 * Since the fallback itself is also safe: `DEFAULT_AUDIO_CONFIG` declares
 * VAD and noise cancellation OFF (STT stays ON). So a compat app that supplies
 * neither `audioSettings` nor `sttPipelineId` — where this returns `undefined` and
 * the provider uses the default — no longer inherits VAD/noise or triggers an
 * unsolicited Silero/RNNoise model fetch. Opt in per stage to turn them on.
 */
function mapAudioSettings(audio: V1AudioSettings | undefined, sttPipelineId: string | undefined): AudioPluginConfig | undefined {
  if (!audio && !sttPipelineId) return undefined;

  const config: AudioPluginConfig = {};

  if (audio?.noiseSuppression !== undefined) {
    config.noiseFilter = { enabled: !!audio.noiseSuppression, level: 'medium' };
  }

  // The VAD counterpart of `noiseSuppression`. `enabled: false`
  // removes the stage from the capture graph entirely (`TranscriptionPipeline`
  // only ever constructs processors for stages in `getEnabledStages()`), so the
  // backend receives ungated audio.
  if (audio?.voiceActivityDetection !== undefined) {
    config.vad = { enabled: !!audio.voiceActivityDetection };
  }

  if (sttPipelineId) {
    // A pipelineId routes STT to the backend streaming provider.
    config.stt = { enabled: true, provider: 'backend', pipelineId: sttPipelineId, requireTenantClaim: false };
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Forward the v1 logging config, defaulting each deployment-stage-gated
 * transport's `environment` to the top-level {@link V1SdkConfig.environment}.
 *
 * Why the default matters: the Clarity and Highlight transports are fail-closed
 * on a production DEPLOYMENT, and when their `environment` is undeclared they
 * fall back to `NODE_ENV`. Every browser bundler sets `NODE_ENV === 'production'`
 * for ANY optimised build — including the one deployed to staging — so a compat
 * app that declared `environment: 'staging'` at the top level, exactly as this
 * adapter already reads it for `debug`, would still see the transport silently
 * refuse to activate. Propagating the declared stage is what makes the single
 * `environment` field mean the same thing everywhere.
 *
 * An explicit per-transport `environment` always wins.
 */
function mapLogging(logging: LoggingConfig, environment: V1SdkConfig['environment']): LoggingConfig {
  if (!environment) return logging;
  const withStage = <T extends { environment?: string }>(transport: T | undefined): T | undefined =>
    transport ? { ...transport, environment: transport.environment ?? environment } : undefined;

  return {
    ...logging,
    ...(logging.clarity ? { clarity: withStage(logging.clarity) } : {}),
    ...(logging.highlight ? { highlight: withStage(logging.highlight) } : {}),
  };
}

export function mapV1ConfigToAgenticConfig(v1: V1SdkConfig): AgenticConfig {
  const apiKey = v1.credentials?.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      '[@arcaai/vox/compat] mapV1ConfigToAgenticConfig: credentials.apiKey is required. ' +
        'HOPE-v2 does not provide a default API key — supply your tenant API key.',
    );
  }

  return {
    api: {
      baseUrl: ensureApiV1Base(v1.apiEndpoint),
      wsUrl: v1.websocketUrl,
      apiKey,
    },
    audio: mapAudioSettings(v1.audioSettings, v1.sttPipelineId),
    debug: v1.environment === 'development' ? true : undefined,
    // Observability passthrough. The transports own their activation gates, so
    // this enables nothing by itself. Spread only when stated, so a v1 app that
    // omits it produces the exact pre-logging config object.
    ...(v1.logging ? { logging: mapLogging(v1.logging, v1.environment) } : {}),
  };
}
