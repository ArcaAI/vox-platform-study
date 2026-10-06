/**
 * TASK-1047 L9 (OD-3, FC-4) — deprecation of a raw caller `system_prompt` on
 * `POST text-generations/generate`, and the governance strip.
 *
 * The route is not removed: the prompt is still forwarded, but apps/text screens it as untrusted
 * because no governance accompanies it. Sunset policy is the program-wide TASK-1045 D-37 one.
 */
import { Counter, register } from 'prom-client';

import { gatewayMetricPrefix } from '../../observability/metric-naming';

export const SYSTEM_PROMPT_DEPRECATION_TICKET = 'TASK-1047';
export const SYSTEM_PROMPT_REMOVE_IN = 'R5';
export const SYSTEM_PROMPT_SUNSET = 'Sun, 31 Jan 2027 00:00:00 GMT';
/** Field-level `route` label on the shared `deprecated_requests_total` counter. */
export const SYSTEM_PROMPT_ROUTE_LABEL = '/api/v1/text-generations/generate#system_prompt';

function counter(): Counter<'route' | 'removeIn'> {
  const name = `${gatewayMetricPrefix()}deprecated_requests_total`;
  return (
    (register.getSingleMetric(name) as Counter<'route' | 'removeIn'> | undefined) ??
    new Counter({
      name,
      help: 'Requests to routes marked @ApiDeprecated, by route template and the release that removes them.',
      labelNames: ['route', 'removeIn'] as const,
      registers: [register],
    })
  );
}

/** Marks the response deprecated and counts the request. Never throws — a metric must not break the request. */
export function markSystemPromptDeprecated(res?: { setHeader(name: string, value: string): unknown }): void {
  try {
    res?.setHeader('Deprecation', 'true');
    res?.setHeader('Sunset', SYSTEM_PROMPT_SUNSET);
    res?.setHeader(
      'X-Deprecation-Notice',
      `${SYSTEM_PROMPT_DEPRECATION_TICKET} - system_prompt removed in ${SYSTEM_PROMPT_REMOVE_IN}; use prompt_template_id via text-generations/generate/assembled or invoke an agent`,
    );
    counter().inc({ route: SYSTEM_PROMPT_ROUTE_LABEL, removeIn: SYSTEM_PROMPT_REMOVE_IN });
  } catch {
    // swallow-ok: observation only, must never break the request
  }
}

/** Deletes every spelling of `system_governance` (snake, camel, any case) — a caller can never claim governance. */
export function stripCallerGovernance(body: object): void {
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase().replace(/_/g, '') === 'systemgovernance') delete record[key];
  }
}
