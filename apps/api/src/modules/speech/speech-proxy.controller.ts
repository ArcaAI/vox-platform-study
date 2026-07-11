import { Authorize, IConfigService, SecretsService } from '@arcaai/applications';
import { HttpService } from '@nestjs/axios';
import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  Post,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AxiosError } from 'axios';
import type { Response } from 'express';

// The gateway forwards the body verbatim; tts-v2 owns strict validation. A plain
// interface (not a class-validator DTO) means the global ValidationPipe skips it,
// preserving pass-through (mirrors SmrProxyController).
interface SpeechSynthesizeRequest {
  input: string;
  voice: string;
  response_format?: 'pcm' | 'wav' | 'mp3';
  speed?: number;
  stream_format?: 'audio' | 'sse';
  model?: string;
}

interface UpstreamErrorPayload {
  detail?: string;
  message?: string;
  [key: string]: unknown;
}

const RETRIABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']);
// Only connect-phase failures prove the request never reached tts-v2. Synthesis
// is compute-costly (and streams), so the non-idempotent POST retries ONLY on
// these — anything else may mean synthesis already started.
const CONNECT_PHASE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND']);

@ApiTags('speech')
@ApiBearerAuth()
@Controller('speech')
export class SpeechProxyController {
  private readonly logger = new Logger(SpeechProxyController.name);

  constructor(
    private readonly httpService: HttpService,
    @Inject(IConfigService) private readonly configService: IConfigService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {}

  // TTS base URL resolves through the typed IConfigService accessor; direct
  // process.env.TTS_URL reads in modules/** are lint-banned.
  private getTtsBaseUrl(): string {
    return this.configService.getConfigValue('TTS_URL');
  }

  private getForwardHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const serviceToken = this.secretsService?.getSecretSync('TTS_SERVICE_TOKEN');
    if (serviceToken) {
      headers['X-Service-Token'] = serviceToken;
    }
    return headers;
  }

  private isRetriable(err: unknown): boolean {
    const code = (err as AxiosError)?.code;
    if (code && RETRIABLE_CODES.has(code)) return true;
    const status = (err as AxiosError)?.response?.status;
    return status === 502 || status === 503 || status === 504;
  }

  private isConnectPhaseFailure(err: unknown): boolean {
    const axiosError = err as AxiosError;
    if (axiosError?.response) return false; // upstream responded → request delivered
    const code = axiosError?.code;
    return typeof code === 'string' && CONNECT_PHASE_CODES.has(code);
  }

  private buildUpstreamException(err: unknown, fallbackMessage: string): HttpException {
    const axiosError = err as AxiosError<UpstreamErrorPayload | string>;
    const status = axiosError.response?.status;
    const payload = axiosError.response?.data;
    // Never forward or log the upstream body — a synthesis error can echo the
    // input text (PHI). Record only non-content metadata + the status.
    if (payload !== undefined && payload !== null && payload !== '') {
      this.logger.error({
        message: 'TTS upstream error (body redacted — may contain PHI)',
        upstreamStatus: status,
        upstreamBodyRedacted: true,
      });
    }
    if (typeof status === 'number') {
      return new HttpException({ detail: fallbackMessage }, status);
    }
    return new HttpException({ detail: fallbackMessage }, HttpStatus.BAD_GATEWAY);
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    context: string,
    maxRetries = 2,
    isRetriable: (err: unknown) => boolean = (err) => this.isRetriable(err),
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries && isRetriable(err)) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt), 4000);
          this.logger.warn({ message: `Retrying ${context}`, attempt: attempt + 1, maxRetries, delayMs });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        break;
      }
    }
    throw lastErr;
  }

  @Post('synthesize')
  @Authorize()
  @ApiOperation({ summary: 'Synthesize speech via TTS v2 (batch audio, streamed audio, or SSE)' })
  async synthesize(@Body() body: SpeechSynthesizeRequest, @Res() res: Response): Promise<void> {
    const base = this.getTtsBaseUrl();

    try {
      const upstream = await this.withRetry(
        () =>
          this.httpService.axiosRef.post(`${base}/api/v1/audio/speech`, body, {
            headers: { ...this.getForwardHeaders(), Accept: 'application/octet-stream, text/event-stream' },
            responseType: 'stream',
            timeout: 300_000,
          }),
        'TTS synthesize',
        // Non-idempotent: retry only when the request provably never left the gateway.
        2,
        (err) => this.isConnectPhaseFailure(err),
      );

      // Mirror the upstream content type (audio/pcm, audio/wav, audio/mpeg, or
      // text/event-stream) and stream bytes through untouched — no compression
      // (no-transform), no buffering (X-Accel-Buffering), no caching (PHI).
      const contentType = (upstream.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const stream = upstream.data;
      stream.on('data', (chunk: Buffer) => {
        res.write(chunk);
      });
      stream.on('end', () => {
        res.end();
      });
      stream.on('error', (err: Error) => {
        this.logger.error({ message: 'TTS audio stream error', error: err.message });
        res.end();
      });
      res.on('close', () => {
        stream.destroy();
      });
    } catch (err) {
      const axiosError = err as AxiosError<UpstreamErrorPayload | string>;
      const upstreamStatus = axiosError.response?.status;
      const payload = axiosError.response?.data;
      if (payload !== undefined && payload !== null && payload !== '') {
        this.logger.error({
          message: 'TTS synthesize upstream error (body redacted — may contain PHI)',
          upstreamStatus,
          upstreamBodyRedacted: true,
        });
      } else {
        this.logger.error({
          message: 'Failed to proxy synthesize to TTS',
          error: err instanceof Error ? err.message : String(err),
          code: axiosError.code,
          upstreamStatus,
        });
      }
      // flushHeaders only runs after a successful upstream connect, so on this
      // path headers are not yet sent — respond with a generic status.
      if (!res.headersSent) {
        const status = typeof upstreamStatus === 'number' ? upstreamStatus : HttpStatus.BAD_GATEWAY;
        res.status(status).json({ detail: 'TTS service unavailable' });
      } else {
        res.end();
      }
    }
  }

  @Get('voices')
  @Authorize()
  @ApiOperation({ summary: 'List available TTS voices (stable internal ids + providers)' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async voices(): Promise<any> {
    const base = this.getTtsBaseUrl();
    try {
      const response = await this.withRetry(
        () => this.httpService.axiosRef.get(`${base}/api/v1/voices`, { headers: this.getForwardHeaders(), timeout: 5_000 }),
        'TTS voices',
      );
      return response.data;
    } catch (err) {
      this.logger.error({
        message: 'Failed to list TTS voices',
        error: err instanceof Error ? err.message : String(err),
        upstreamStatus: (err as AxiosError)?.response?.status,
      });
      throw this.buildUpstreamException(err, 'TTS service unavailable');
    }
  }
}
