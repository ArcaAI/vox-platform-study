// PHI-redaction descriptors (the gateway side of `POST /api/guardrail/redact`).
//
// Companion to `guardrail.redact.chunkChars` in `service-runtime.descriptors.ts`:
// that key bounds what guardrail does per extraction call, this one bounds how
// long the CALLER waits for the whole request. They are deliberately separate
// keys in separate families because they are read by different processes —
// guardrail pulls its chunk budget over `/internal/effective-config`, while the
// gateway reads this one straight from the AppSettings cache — and an operator
// tuning one should not be forced to reason about the other's transport.
//
// Registered rather than left as a code constant because the safe value is
// environment-dependent: it tracks the redaction worker's real throughput, which
// differs between a CPU-only dev box and a production node.

import { SettingDescriptor } from '../registry.types';

/** Code default, mirrored by `DEFAULT_REDACT_TIMEOUT_MS` in the redactor. */
export const PHI_REDACTION_DEFAULTS = {
  'phiRedaction.requestTimeoutMs': 120_000,
} as const;

export type PhiRedactionKey = keyof typeof PHI_REDACTION_DEFAULTS;

export const PHI_REDACTION_SETTINGS: SettingDescriptor[] = [
  {
    key: 'phiRedaction.requestTimeoutMs',
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    // Platform-owned: the ceiling tracks the shared redaction worker's
    // throughput, which is not a per-tenant property.
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    // TUNING, not selection: an unwritten row must degrade to the code default,
    // not turn every redaction call into a failure. Note the tier semantics —
    // this governs an ABSENT value only; a timeout that actually fires still
    // propagates as an error and aborts the job, which is the fail-closed
    // posture `IPhiRedactor` requires.
    failMode: 'open-to-default',
    category: 'Service Runtime',
    label: 'PHI redaction request timeout (ms)',
    description:
      'How long the gateway waits for `POST /api/guardrail/redact` before aborting. Guardrail processes ' +
      'long inputs as a sequence of bounded chunks, so the work is roughly linear in corpus size — at the ' +
      'DNA processor`s 100,000-character cap that is on the order of 15s on a CPU-only worker. A timeout ' +
      'here aborts the calling job by design (fail-closed: no job ever proceeds with unredacted PHI), so ' +
      'set it above the slowest corpus you actually redact rather than tight.',
    default: PHI_REDACTION_DEFAULTS['phiRedaction.requestTimeoutMs'],
  },
];
