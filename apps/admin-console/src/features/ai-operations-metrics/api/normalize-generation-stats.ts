/**
 * Normalize AD-1 GenerationStats from either snake_case (trajectory / live
 * emitters) or camelCase (legacy console shape) into the camelCase view model
 * used by Metrics rollups and the Runs StepStats panel.
 */

export interface NormalizedGenerationStats {
  ttftMs?: number;
  totalMs?: number;
  tokensPerSecond?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  stopReason?: string;
  provider?: string;
  model?: string;
}

function pickNumber(raw: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickString(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Accept snake_case and/or camelCase stats; return camelCase for UI consumers. */
export function normalizeGenerationStats(stats: Record<string, unknown> | null | undefined): NormalizedGenerationStats | null {
  if (!stats || typeof stats !== 'object') return null;

  const normalized: NormalizedGenerationStats = {};
  const ttftMs = pickNumber(stats, 'ttftMs', 'ttft_ms');
  if (ttftMs !== undefined) normalized.ttftMs = ttftMs;

  const totalMs = pickNumber(stats, 'totalMs', 'total_ms');
  if (totalMs !== undefined) normalized.totalMs = totalMs;

  const tokensPerSecond = pickNumber(stats, 'tokensPerSecond', 'tokens_per_second');
  if (tokensPerSecond !== undefined) normalized.tokensPerSecond = tokensPerSecond;

  const promptTokens = pickNumber(stats, 'promptTokens', 'prompt_tokens');
  if (promptTokens !== undefined) normalized.promptTokens = promptTokens;

  // AD-1 uses predicted_tokens; console historically used completionTokens.
  const completionTokens = pickNumber(stats, 'completionTokens', 'completion_tokens', 'predicted_tokens');
  if (completionTokens !== undefined) normalized.completionTokens = completionTokens;

  const totalTokens = pickNumber(stats, 'totalTokens', 'total_tokens');
  if (totalTokens !== undefined) normalized.totalTokens = totalTokens;

  const stopReason = pickString(stats, 'stopReason', 'stop_reason');
  if (stopReason !== undefined) normalized.stopReason = stopReason;

  const provider = pickString(stats, 'provider');
  if (provider !== undefined) normalized.provider = provider;

  const model = pickString(stats, 'model');
  if (model !== undefined) normalized.model = model;

  return normalized;
}
