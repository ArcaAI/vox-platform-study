import type { StatusColorRole } from '@arcaai/ui/components/shared';

/**
 * Formatters for the **Test Playground** (frame 33). The score is an honest
 * SMR-derived **quality proxy** in [0, 1]; per-metric breakdowns
 * (faithfulness / coverage / conciseness) are a TARGET — `PromptTestResult` has no
 * `metrics` field today, so `normalizeMetrics` renders them only when a future
 * backend supplies them. All tones use semantic tokens (never raw green/red).
 */
const EM_DASH = '\u2014';

/** Score → 2-decimal string, em-dash when missing. */
export function formatScore(score: number | null | undefined): string {
  return score == null ? EM_DASH : score.toFixed(2);
}

/** Score in [0,1] → integer percent for the meter bars (0 when missing). */
export function scorePercent(score: number | null | undefined): number {
  return score == null ? 0 : Math.round(score * 100);
}

/** Score → semantic token role by threshold (≥.85 success · ≥.6 warning · else destructive). */
export function scoreToneRole(score: number | null | undefined): StatusColorRole {
  if (score == null) return 'neutral';
  if (score >= 0.85) return 'success';
  if (score >= 0.6) return 'warning';
  return 'destructive';
}

export interface PlaygroundMetric {
  key: string;
  label: string;
  value: number;
  percent: number;
  role: StatusColorRole;
}

function humanize(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Normalize an optional metrics record into display rows (empty when absent — TARGET). */
export function normalizeMetrics(metrics: Record<string, number> | null | undefined): PlaygroundMetric[] {
  if (!metrics) return [];
  return Object.entries(metrics).map(([key, value]) => ({
    key,
    label: humanize(key),
    value,
    percent: scorePercent(value),
    role: scoreToneRole(value),
  }));
}

/** Build `TestPromptInput.variables` — only declared names that have a non-empty value. */
export function resolveTestVariables(names: string[], values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const value = values[name];
    if (value != null && String(value).trim() !== '') out[name] = value;
  }
  return out;
}
