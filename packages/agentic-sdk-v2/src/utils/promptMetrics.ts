/**
 * @arcaai/vox - Prompt Test Metrics Mapping (TASK-389 #15 / AG12 / A5)
 *
 * Maps the backend `PromptTestMetrics` (raw, mixed-type) into the flat
 * `Record<string, number>` DISPLAY shape the admin Test Playground consumes
 * (`normalizeMetrics` renders every entry as a `[0, 1]` meter bar).
 *
 * Only the genuinely `[0, 1]` dimensions are surfaced — booleans are projected
 * to `0 | 1`, and dimensions that don't apply to the template (`jsonValid` when
 * JSON isn't expected, `variableCoverage` when no variables are declared) are
 * omitted rather than shown as a misleading `0`. The count dimensions
 * (`wordCount`, `variablesDeclared`) are intentionally excluded from the
 * `[0,1]` map — they live on `PromptTestResult.metricDetail` for callers that
 * want the raw numbers.
 */

import type { PromptTestMetrics } from '../types/prompt';

export function toPromptTestMetricScores(raw: PromptTestMetrics | null | undefined): Record<string, number> | undefined {
  if (!raw) return undefined;

  const scores: Record<string, number> = {
    length: raw.lengthScore,
    nonEmpty: raw.nonEmpty ? 1 : 0,
  };

  // Only meaningful when the template expects JSON output.
  if (raw.jsonExpected && raw.jsonValid !== null && raw.jsonValid !== undefined) {
    scores.jsonValidity = raw.jsonValid ? 1 : 0;
  }

  // Only meaningful when the template declares variables.
  if (raw.variableCoverage !== null && raw.variableCoverage !== undefined) {
    scores.variableCoverage = raw.variableCoverage;
  }

  return scores;
}
