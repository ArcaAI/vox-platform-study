import type { AssembledPrompt } from '../prompt/prompt-assembly.service';

export interface LegacySmrSummaryResponse {
  summary: string;
  llmProvider?: string;
  modelName?: string;
  processingTimeMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheHit?: boolean;
  qualityScore?: number;
}

interface SmrGeneratePayload {
  prompt: string;
  system_prompt?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream: false;
  response_format?: AssembledPrompt['responseFormat'];
  context?: Record<string, unknown>;
}

interface SmrGenerateResponse {
  summary?: string;
  content?: string;
  llmProvider?: string;
  provider?: string;
  modelName?: string;
  model?: string;
  processingTimeMs?: number;
  latency_ms?: number;
  inputTokens?: number;
  outputTokens?: number;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  cacheHit?: boolean;
  cache_hit?: boolean;
  cached?: boolean;
  qualityScore?: number;
  quality_score?: number;
}

function pickNumber(source: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  if (!source) {
    return undefined;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function pickString(source: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!source) {
    return undefined;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

function shouldForwardResponseFormat(provider: string | undefined): boolean {
  if (!provider) {
    return false;
  }

  const normalized = provider.trim().toLowerCase();
  return normalized !== 'ollama';
}

export function buildSmrGeneratePayload(
  assembledPrompt: AssembledPrompt,
  options?: Record<string, unknown>,
  contextExtras?: Record<string, unknown>,
): SmrGeneratePayload {
  const context = {
    ...(options ?? {}),
    ...(contextExtras ?? {}),
  };

  const temperature = pickNumber(options, 'temperature') ?? pickNumber(assembledPrompt.hyperparameters, 'temperature');
  const maxTokens = pickNumber(options, 'max_tokens', 'maxTokens') ?? pickNumber(assembledPrompt.hyperparameters, 'max_tokens', 'maxTokens');
  const topP = pickNumber(options, 'top_p', 'topP') ?? pickNumber(assembledPrompt.hyperparameters, 'top_p', 'topP');
  const provider = pickString(options, 'provider', 'smrProvider', 'defaultSmrProvider');

  return {
    prompt: assembledPrompt.userPrompt,
    system_prompt: assembledPrompt.systemPrompt,
    provider,
    model: pickString(options, 'model', 'smrModel', 'defaultSmrModel'),
    temperature,
    max_tokens: maxTokens,
    top_p: topP,
    stream: false,
    response_format: shouldForwardResponseFormat(provider) ? (assembledPrompt.responseFormat ?? undefined) : undefined,
    context: Object.keys(context).length > 0 ? context : undefined,
  };
}

export function mapSmrGenerateResponse(responseData: SmrGenerateResponse): LegacySmrSummaryResponse {
  return {
    summary: responseData.summary ?? responseData.content ?? '',
    llmProvider: responseData.llmProvider ?? responseData.provider,
    modelName: responseData.modelName ?? responseData.model,
    processingTimeMs: responseData.processingTimeMs ?? responseData.latency_ms,
    inputTokens: responseData.inputTokens ?? responseData.usage?.prompt_tokens,
    outputTokens: responseData.outputTokens ?? responseData.usage?.completion_tokens,
    cacheHit: responseData.cacheHit ?? responseData.cache_hit ?? responseData.cached,
    qualityScore: responseData.qualityScore ?? responseData.quality_score,
  };
}
