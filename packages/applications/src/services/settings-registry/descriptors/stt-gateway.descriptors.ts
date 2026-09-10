// TASK-944 lane A — the GATEWAY-side budget for opening an STT streaming session.
//
// ## Why this key exists
//
// `StreamingSessionService.createSession` carried `timeout: 15000` as a literal on the
// gateway → `POST /internal/streaming/sessions` hop. Measured on `hope-v2-dev`
// (2026-09-10 09:37Z), the FIRST session after an STT pod restart:
//
//     stt.access  POST /internal/streaming/sessions  status_code 201  duration_ms 16870.07
//     api         StreamingSessionService  "Failed to create streaming session"
//                 error: "timeout of 15000ms exceeded"  (ECONNABORTED)
//     api         POST audio/transcription-jobs/stream/session -> 503 in 15027ms
//
// STT SUCCEEDED, 1 870 ms after the gateway had already given up and 503'd the
// clinician. A warm session is 0.1–0.5 s, so the literal failed on exactly one request
// per deploy — the first one — and never in a test.
//
// ## Why it is a descriptor and not a bigger literal
//
// A cold-start budget moves whenever the model set, the GPU contention profile or the
// weight cache changes. `09-infrastructure-devops.md` §Configuration Tiers corollary L1:
// a value that must change without a restart is not a deploy-time constant. Bumping
// `15000` to `30000` re-creates the same defect the first time a cold start crosses the
// new line, and does so on a platform where the only remedy is a redeploy. Making it
// `global-kv` / `open-to-default` means a super admin's write governs the NEXT session
// open, with no rebuild.
//
// ## Why the default is 60000
//
// The same reasoning as `consultation.realtime.textTimeoutMs`, which fixed the identical
// shape of defect one lane over: a budget must sit ABOVE the tail it protects against, or
// it converts a slow call into no call at all. The measured cold start is 16.87 s on an
// otherwise-idle cluster; whisper + embedding weights load under GPU contention. The
// timeout is not a UX dial — a warm session never reaches it, and the answer to a slow
// cold start is a warmed pod, not an early abort that turns a working STT into a 503.
//
// ## Why it lives HERE and not in `stt-runtime.descriptors.ts`
//
// Every key in that file is `consumedBy: ['stt']` — pulled BY the Python service over
// `GET /internal/effective-config`. This one is read by the GATEWAY, about its own
// outbound call, and `apps/stt` has no use for it. Declaring `consumedBy` on it would put
// a key on the pull route that no Python reader consumes; the naming follows the other
// gateway-side hop budgets (`phiRedaction.requestTimeoutMs`,
// `consultation.realtime.textTimeoutMs`) rather than the `stt.*` pull family, so the two
// namespaces stay legible.

import { SettingDescriptor } from '../registry.types';

/** The governed gateway→STT session-create budget (ms). */
export const STT_SESSION_CREATE_TIMEOUT_MS_KEY = 'sttStreaming.sessionCreateTimeoutMs';

/**
 * Code defaults for the gateway-side STT budgets — the single source of truth shared by
 * the descriptor below and `StreamingSessionService`, so the two can never disagree
 * about what "no row" means.
 */
export const STT_GATEWAY_DEFAULTS = {
  [STT_SESSION_CREATE_TIMEOUT_MS_KEY]: 60_000,
} as const;

export const STT_GATEWAY_SETTINGS: SettingDescriptor[] = [
  {
    key: STT_SESSION_CREATE_TIMEOUT_MS_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    // PLATFORM-owned. This budgets the platform's own gateway→STT hop against the
    // platform's own cold-start cost; it is not a clinical preference a tenant holds an
    // opinion about, and a per-tenant row would multiply the resolution cardinality of a
    // value read on every session open.
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    // TUNING: an absent row degrades to the code default, never to an outage.
    // (`failMode` governs an ABSENT VALUE only — a settings-backend error still
    // propagates and is never disguised as "the default".)
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: 'STT session-create timeout (ms)',
    description:
      'How long the gateway waits for `POST /internal/streaming/sessions` before aborting and answering the ' +
      'client 503. A WARM STT answers in 0.1–0.5 s; this budget only ever binds on the first session after an ' +
      'STT restart, while the pipeline loads its weights — measured at 16.87 s on an idle dev cluster, which is ' +
      'why the former hard-coded 15 000 ms failed on the first request after every single deploy while STT was ' +
      'busy returning 201. Set it above the slowest cold start you actually run, not tight: an abort here does ' +
      'not make the session faster, it discards a session STT is about to open.',
    default: STT_GATEWAY_DEFAULTS[STT_SESSION_CREATE_TIMEOUT_MS_KEY],
  },
];
