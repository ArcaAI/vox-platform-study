import { Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { TENANTLESS, internalServiceHeaders, resolveInternalAccessToken } from '../../../common';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { NOTE_TOKEN_ESTIMATE_ID, type NoteTokenizerMode } from './note-plan.types';

/**
 * Token counts for note-budget planning, from `apps/text` `POST /api/v1/tokenize`.
 *
 * Order (D-23): the serving engine's tokenizer, then the sha-pinned HF tokenizer the model row
 * declares (`AiModel._metadata.tokenizer`), both decided by `apps/text`; when it answers 501
 * `TOKENIZER_UNAVAILABLE` — or cannot be reached — the conservative estimate `ceil(utf8Bytes / 2)`,
 * which only ever over-counts, and the plan records `tokenizer.mode = 'estimate'`. With the
 * estimate disallowed the refusal propagates. Counts are content-only; the planner adds the
 * chat-template allowance itself.
 */

export interface TokenizerSpec {
  hubRepo: string;
  file: string;
  sha256: string;
}

export interface TokenCountTarget {
  tenantId: string;
  provider: string;
  model: string;
  tokenizer?: TokenizerSpec | null;
  providerOverrides?: Record<string, unknown> | null;
  allowEstimate: boolean;
}

export interface TokenCountResult {
  counts: number[];
  mode: NoteTokenizerMode;
  id: string;
}

export const TOKENIZER_UNAVAILABLE = 'TOKENIZER_UNAVAILABLE';

export class NoteTokenizerUnavailableError extends Error {
  readonly code = TOKENIZER_UNAVAILABLE;
}

/** Conservative estimate (over-counts only): `ceil(utf8Bytes / 2)`. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 2);
}

export function estimateCounts(texts: readonly string[]): TokenCountResult {
  return { counts: texts.map(estimateTokens), mode: 'estimate', id: NOTE_TOKEN_ESTIMATE_ID };
}

/** Anything that can count tokens for a plan — the HTTP client, or a fixture. */
export interface NoteTokenCounter {
  count(texts: readonly string[], target: TokenCountTarget): Promise<TokenCountResult>;
}

export const NoteTokenCounterToken = Symbol('NoteTokenCounter');

interface TokenizeResponseBody {
  counts?: unknown;
  tokenizer?: { source?: unknown; id?: unknown };
}

@Injectable()
export class TextTokenCountClient implements NoteTokenCounter {
  private readonly logger = new Logger(TextTokenCountClient.name);
  private readonly textServiceUrl: string;

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService,
    @Optional() private readonly secretsService?: SecretsService,
  ) {
    // Bootstrap TRANSPORT address (rule 00): the only sanctioned env default.
    this.textServiceUrl = configService.get<string>('TEXT_URL') ?? 'http://localhost:8862';
  }

  async count(texts: readonly string[], target: TokenCountTarget): Promise<TokenCountResult> {
    if (texts.length === 0) return { counts: [], mode: 'exact', id: `${target.provider}:${target.model}` };
    let status: number | null = null;
    try {
      const response = await this.httpService.axiosRef.post<TokenizeResponseBody>(
        `${this.textServiceUrl}/api/v1/tokenize`,
        {
          provider: target.provider,
          model: target.model,
          texts,
          ...(target.tokenizer ? { tokenizer: target.tokenizer } : {}),
          ...(target.providerOverrides ? { provider_overrides: target.providerOverrides } : {}),
        },
        {
          headers: internalServiceHeaders({
            serviceToken: await resolveInternalAccessToken(this.secretsService, 'INTERNAL_ACCESS_TOKEN'),
            tenantId: target.tenantId,
            tenantlessReason: TENANTLESS.CONTROL_PLANE,
          }),
        },
      );
      const counts = response.data?.counts;
      if (Array.isArray(counts) && counts.length === texts.length && counts.every((n) => Number.isInteger(n) && n >= 0)) {
        const id = typeof response.data?.tokenizer?.id === 'string' ? response.data.tokenizer.id : `${target.provider}:${target.model}`;
        return { counts: counts as number[], mode: 'exact', id };
      }
      this.logger.warn({ message: 'Tokenize response malformed — counting with the estimate', provider: target.provider, model: target.model });
    } catch (error) {
      status = (error as { response?: { status?: number } })?.response?.status ?? null;
      this.logger.warn({
        message: 'Exact token count unavailable — counting with the conservative estimate when allowed',
        provider: target.provider,
        model: target.model,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!target.allowEstimate) {
      throw new NoteTokenizerUnavailableError(
        `No exact tokenizer is available for ${target.provider}:${target.model}${status ? ` (HTTP ${status})` : ''} and the estimate is disabled.`,
      );
    }
    return estimateCounts(texts);
  }
}
