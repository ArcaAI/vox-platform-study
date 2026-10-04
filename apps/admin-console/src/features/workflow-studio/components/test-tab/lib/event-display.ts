/**
 * How the Test tab's Events list reads (TASK-1036 §10.2): one category per type plus a Warnings
 * flag, one readable line per event, `+time` from the run's start, and PHI masking.
 *
 * Values only ever appear in the line when PHI is shown; `hidePhi` replaces each with `•••`
 * (labels, paths, codes and counts are not patient data and stay).
 */
import type { RunEvent } from '@/shared/sandbox/api/run-protocol';

export const EVENT_CATEGORIES = ['steps', 'model', 'guardrails', 'data', 'audio', 'warnings'] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const EVENT_CATEGORY_LABEL: Record<EventCategory, string> = {
  steps: 'Steps',
  model: 'Model',
  guardrails: 'Guardrails',
  data: 'Data',
  audio: 'Audio',
  warnings: 'Warnings',
};

const PRIMARY: Record<RunEvent['type'], Exclude<EventCategory, 'warnings'>> = {
  'run.started': 'steps',
  'run.completed': 'steps',
  'run.failed': 'steps',
  'run.cancelled': 'steps',
  'run.resync': 'steps',
  'node.started': 'steps',
  'node.completed': 'steps',
  'node.failed': 'steps',
  ping: 'steps',
  'prompt.composed': 'model',
  'model.request': 'model',
  'output.text.delta': 'model',
  'guardrail.inbound': 'guardrails',
  'guardrail.outbound': 'guardrails',
  'input.validated': 'data',
  'data.bound': 'data',
  'binding.warning': 'data',
  'consultation.read': 'data',
  'output.data': 'data',
  'output.validated': 'data',
  'transcript.partial': 'audio',
  'transcript.final': 'audio',
  'output.audio.delta': 'audio',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Something an admin debugging the run should look at. */
export function isWarningEvent(event: RunEvent): boolean {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case 'binding.warning':
    case 'node.failed':
    case 'run.failed':
    case 'run.resync':
      return true;
    case 'node.completed':
      return data.status === 'DEGRADED' || (typeof data.warnings === 'number' && data.warnings > 0);
    case 'run.completed':
      return data.degraded === true;
    case 'guardrail.inbound':
    case 'guardrail.outbound':
      return data.action !== 'ALLOW';
    case 'input.validated':
    case 'output.validated':
      return data.valid !== true;
    default:
      return false;
  }
}

export function categoriesOf(event: RunEvent): EventCategory[] {
  const primary = PRIMARY[event.type] ?? 'steps';
  return isWarningEvent(event) ? [primary, 'warnings'] : [primary];
}

export function countByCategory(events: readonly RunEvent[]): Record<EventCategory, number> {
  const counts: Record<EventCategory, number> = { steps: 0, model: 0, guardrails: 0, data: 0, audio: 0, warnings: 0 };
  for (const event of events) for (const category of categoriesOf(event)) counts[category] += 1;
  return counts;
}

const MASK = '•••';

export interface DescribeOptions {
  hidePhi?: boolean;
}

/** A compact, single-line rendering of a value — never a dump. */
export function formatValue(value: unknown, max = 80): string {
  if (value === undefined) return '—';
  if (typeof value === 'string') return `“${value.length > max ? `${value.slice(0, max)}…` : value}”`;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function formatDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function sourceText(source: unknown): string {
  if (!isRecord(source)) return '?';
  if (source.kind === 'value') return 'a fixed value';
  if (source.kind === 'template') return typeof source.template === 'string' ? `template ${source.template}` : 'a template';
  return typeof source.path === 'string' ? source.path : '?';
}

function errorText(error: unknown): string {
  if (!isRecord(error)) return 'unknown error';
  return `${String(error.code ?? 'ERROR')} — ${String(error.message ?? '')}`.trim();
}

/** One line for the Events list. `labelOf` names a step by its label, never its raw id. */
export function describeEvent(event: RunEvent, labelOf: (nodeId: string) => string, options: DescribeOptions = {}): string {
  const data = event.data as Record<string, unknown>;
  const value = (raw: unknown, max?: number) => (options.hidePhi ? MASK : formatValue(raw, max));

  switch (event.type) {
    case 'run.started':
      return `Started ${String(data.slug ?? 'the run')}${typeof data.versionNumber === 'number' ? ` v${data.versionNumber}` : ''}`;
    case 'run.completed':
      return `Completed in ${formatDuration(data.durationMs)}${data.degraded === true ? ' (degraded)' : ''}`;
    case 'run.failed':
      return `${data.status === 'TIMED_OUT' ? 'Timed out' : 'Failed'}: ${errorText(data.error)}`;
    case 'run.cancelled':
      return `Cancelled${typeof data.reason === 'string' && data.reason ? `: ${options.hidePhi ? MASK : data.reason}` : ''}`;
    case 'run.resync':
      return `Resynced from a snapshot (${String(data.reason ?? 'gap')})`;
    case 'ping':
      return 'Keep-alive';
    case 'node.started': {
      const attempt = typeof data.attempt === 'number' && data.attempt > 1 ? ` (attempt ${data.attempt})` : '';
      return `Started${attempt}`;
    }
    case 'node.completed': {
      const status = data.status === 'DEGRADED' ? 'Degraded' : data.status === 'SKIPPED' ? 'Skipped' : 'Done';
      const parts = [`${status} in ${formatDuration(data.durationMs)}`];
      if (isRecord(data.tokens)) parts.push(`${Number(data.tokens.in ?? 0).toLocaleString('en-US')} in / ${Number(data.tokens.out ?? 0).toLocaleString('en-US')} out tokens`);
      if (typeof data.warnings === 'number' && data.warnings > 0) parts.push(count(data.warnings, 'warning'));
      return parts.join(' · ');
    }
    case 'node.failed':
      return `Failed: ${errorText(data.error)}${data.willRetry === true ? ' Retrying.' : ''}`;
    case 'output.text.delta':
      return `${String(data.field ?? 'text')} += ${value(data.text, 60)}`;
    case 'output.audio.delta':
      return `${String(data.field ?? 'audio')}: audio chunk (${String(data.format ?? '?')})`;
    case 'output.data':
      return `${String(data.field ?? 'value')} = ${value(data.value)}`;
    case 'input.validated': {
      const schema = isRecord(data.schema) ? `${String(data.schema.slug)}${typeof data.schema.versionNumber === 'number' ? ` v${data.schema.versionNumber}` : ''}` : 'its schema';
      const problems = Array.isArray(data.problems) ? data.problems : [];
      return data.valid === true ? `Input matches ${schema}` : `Input does not match ${schema}: ${options.hidePhi ? MASK : String(problems[0] ?? '')}`;
    }
    case 'data.bound': {
      const inputs = Array.isArray(data.inputs) ? data.inputs.filter(isRecord) : [];
      if (inputs.length === 0) return 'No inputs bound';
      return inputs
        .map((input) => `${String(input.input)} ← ${sourceText(input.source)} = ${input.empty === true ? 'optional, rendered empty' : value(input.value, 40)}`)
        .join(' · ');
    }
    case 'binding.warning':
      return `${String(data.input ?? '')}: ${String(data.message ?? data.code ?? '')}`;
    case 'consultation.read': {
      const fields = Array.isArray(data.fields) ? data.fields.length : 0;
      return `Read ${count(fields, 'consultation field')} (${data.snapshot === 'run-start' ? 'at run start' : 'at step start'})`;
    }
    case 'transcript.partial':
      return `Partial: ${value(data.text, 60)}`;
    case 'transcript.final':
      return `Final: ${value(data.text, 80)}`;
    case 'prompt.composed': {
      const layers = Array.isArray(data.layers) ? data.layers.length : 0;
      const tokens = typeof data.tokensTotal === 'number' ? `, ${count(data.tokensTotal, 'token')}` : '';
      return `Prompt composed: ${count(layers, 'layer')}, ${count(Number(data.charsTotal ?? 0), 'character')}${tokens}`;
    }
    case 'model.request': {
      const flags = [`attempt ${String(data.attempt ?? 1)}`, ...(data.fallback === true ? ['fallback'] : []), ...(data.stream === true ? ['streaming'] : [])];
      return `${String(data.provider ?? '?')} · ${String(data.model ?? '?')}, ${flags.join(', ')}`;
    }
    case 'guardrail.inbound':
    case 'guardrail.outbound':
      return `${event.type === 'guardrail.inbound' ? 'Inbound' : 'Outbound'} guardrail: ${String(data.action ?? '?')}, ${count(Number(data.detected ?? 0), 'finding')}`;
    case 'output.validated': {
      const field = typeof data.field === 'string' ? data.field : 'Output';
      const problems = Array.isArray(data.problems) ? data.problems : [];
      return data.valid === true ? `${field} matches its contract` : `${field} does not match its contract: ${options.hidePhi ? MASK : String(problems[0] ?? '')}`;
    }
    default:
      return (event as RunEvent).type;
  }
}

/** `+1.3 s` — time since the run's first event. */
export function relativeTime(ts: string, originTs: string | undefined): string {
  if (!originTs) return '';
  const delta = Date.parse(ts) - Date.parse(originTs);
  if (!Number.isFinite(delta)) return '';
  return `+${formatDuration(Math.max(0, delta))}`;
}

/** Search over the type, the step's label and the event's line (case-insensitive). */
export function matchesEventQuery(event: RunEvent, query: string, labelOf: (nodeId: string) => string, options: DescribeOptions = {}): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [event.type, event.nodeId ? labelOf(event.nodeId) : '', describeEvent(event, labelOf, options)].join(' ').toLowerCase();
  return haystack.includes(needle);
}
