import { Counter, register } from 'prom-client';

/**
 * TASK-1049 F1 — how the egress enrichment's awaited platform-piece registration ended, per call that
 * offered pieces. `registered` = finished within `governedPrompt.platformRegistrationWaitMs` (the call
 * can be governed); `timeout` = abandoned at the bound (the screen finishes in the background, this call
 * is screened as untrusted, as before F1); `failed` = it threw (same fallback). A sustained `timeout`
 * rate means the authoring screen is too slow for the first call of a new piece set.
 *
 * Registered on prom-client's process-global `register` idempotently (`getSingleMetric(...) ??`), the
 * `residency-metrics.ts` precedent: a metric module must never fail a boot. One closed label.
 */
export const GOVERNED_PROMPT_PLATFORM_REGISTRATION_TOTAL = 'governed_prompt_platform_registration_total';

export type GovernedPlatformRegistrationOutcome = 'registered' | 'timeout' | 'failed';

export const governedPromptPlatformRegistrationTotal: Counter<'outcome'> =
  (register.getSingleMetric(GOVERNED_PROMPT_PLATFORM_REGISTRATION_TOTAL) as Counter<'outcome'> | undefined) ??
  new Counter({
    name: GOVERNED_PROMPT_PLATFORM_REGISTRATION_TOTAL,
    help: 'Awaited platform prompt-piece registrations on the gateway egress path. outcome=registered|timeout|failed.',
    labelNames: ['outcome'] as const,
    registers: [register],
  });
