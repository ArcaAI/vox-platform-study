/**
 * TASK-768 — Downstream-unreachable error contract, at the boundary.
 *
 * `ExceptionInterceptor` is the single place that turns a failed downstream
 * call into a client-facing body. These tests drive REAL error shapes through
 * the real interceptor and assert the two owner requirements:
 *
 *   1. transport failure ⇒ 503 (+ `Retry-After`), never 400 and never an
 *      opaque 500;
 *   2. the emitted body carries no host, port, IP, errno, URL, path or stack.
 *
 * Requirement 2 is asserted as a SWEEP — every downstream-facing route × every
 * transport errno — so a new call site on any of these routes cannot
 * reintroduce the leak without turning this red.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { CallHandler, ExecutionContext, HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { firstValueFrom, throwError } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';

import { DOWNSTREAM_RETRY_AFTER_SECONDS, containsTopology } from '../../filters/downstream-error';
import { ExceptionInterceptor } from '../exception.interceptor';

/**
 * Every gateway route that forwards to a Python service (apps/text :8862,
 * apps/stt :8861, apps/guardrail :8863, apps/nlp :8864, apps/tts :8865,
 * apps/harness :8866). Adding a downstream-facing route means adding it here.
 */
const DOWNSTREAM_ROUTES = [
  ['POST', '/api/v1/consultations/c-1/summary'],
  ['POST', '/api/v1/consultations/c-1/summary/async'],
  ['POST', '/api/v1/consultations/c-1/summary/pre-summary/async'],
  ['POST', '/api/v1/admin/prompt-templates/t-1/test'],
  ['POST', '/api/v1/admin/prompt-templates/t-1/test/finalize'],
  ['POST', '/api/v1/text-generations/generate'],
  ['GET', '/api/v1/text-generations/tasks/x/stream'],
  ['POST', '/api/v1/api/smr/api/v1/summarize'],
  ['POST', '/api/v1/speech/synthesize'],
  ['POST', '/api/v1/audio/transcription-jobs'],
  ['POST', '/api/v1/api/stt/transcribe'],
  ['POST', '/api/v1/text-analyses/ner'],
  ['POST', '/api/v1/safety-checks'],
  ['GET', '/api/v1/admin/harness/workflows'],
  ['POST', '/api/v1/ai/diagnosis-suggestions'],
] as const;

/** Errnos a downed / unreachable peer actually produces. */
const TRANSPORT_ERRNOS = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'EPIPE'] as const;

/** The exact `AxiosError` shape an unreachable peer produces (no `response`). */
function axiosTransportError(code: string, port = 8862) {
  return Object.assign(new Error(`connect ${code} 127.0.0.1:${port}`), {
    name: 'AxiosError',
    code,
    isAxiosError: true,
    response: undefined,
    config: { url: `http://127.0.0.1:${port}/api/v1/generate`, method: 'post' },
  });
}

describe('ExceptionInterceptor — downstream failure mapping', () => {
  let interceptor: ExceptionInterceptor;
  let headers: Record<string, unknown>;

  beforeEach(() => {
    headers = {};
    const cls: any = { getId: () => 'corr-downstream', get: () => undefined };
    interceptor = new ExceptionInterceptor(cls);
  });

  function ctx(method: string, url: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ method, url }),
        getResponse: () => ({
          setHeader: (k: string, v: unknown) => {
            headers[k] = v;
          },
          getHeader: (k: string) => headers[k],
        }),
      }),
    } as unknown as ExecutionContext;
  }

  function handler(err: unknown): CallHandler {
    return { handle: () => throwError(() => err) };
  }

  async function run(method: string, url: string, err: unknown): Promise<HttpException> {
    try {
      await firstValueFrom(interceptor.intercept(ctx(method, url), handler(err)));
      throw new Error('expected the interceptor to rethrow');
    } catch (thrown) {
      return thrown as HttpException;
    }
  }

  // ---------------------------------------------------------------- AC-1

  it('maps the exact TASK-764 evidence (400 + host:port) to a clean 503', async () => {
    // The observed production error on POST /admin/prompt-templates/:id/test.
    const agg = new AggregateError(
      [Object.assign(new Error('connect ECONNREFUSED ::1:8862'), { code: 'ECONNREFUSED' }), axiosTransportError('ECONNREFUSED')],
      'AggregateError',
    );
    const thrown = await run('POST', '/api/v1/admin/prompt-templates/t-1/test', agg);

    expect(thrown).toBeInstanceOf(HttpException);
    expect(thrown.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(JSON.stringify(thrown.getResponse())).not.toMatch(/8862|127\.0\.0\.1|::1|ECONNREFUSED/);
  });

  it('maps the unwrapped AxiosError that escapes HarnessGatewayService to 503, not an opaque 500', async () => {
    const thrown = await run('POST', '/api/v1/consultations/c-1/summary/async', axiosTransportError('ECONNREFUSED', 8866));
    expect(thrown.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect((thrown.getResponse() as any).message).toBe('Note generation is temporarily unavailable. Please retry.');
  });

  // ------------------------------------------------- AC-1 + AC-2, as a SWEEP

  describe('route × errno sweep', () => {
    for (const [method, url] of DOWNSTREAM_ROUTES) {
      for (const code of TRANSPORT_ERRNOS) {
        it(`${method} ${url} + ${code} ⇒ 503 with no topology in the body`, async () => {
          const thrown = await run(method, url, axiosTransportError(code));

          expect(thrown.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);

          const body = JSON.stringify(thrown.getResponse());
          expect(containsTopology(body), `leaked topology in body: ${body}`).toBe(false);
          expect(body).toContain('corr-downstream');
        });
      }
    }
  });

  // ---------------------------------------------------------------- AC-5

  it('sets Retry-After on a 503', async () => {
    await run('POST', '/api/v1/consultations/c-1/summary', axiosTransportError('ECONNREFUSED'));
    expect(headers['Retry-After']).toBe(String(DOWNSTREAM_RETRY_AFTER_SECONDS));
  });

  it('sets Retry-After on a 503 raised directly by a controller', async () => {
    // `consultation.controller.ts` throws ServiceUnavailableException for the
    // seam-resolution branch. Every 503 leaving the gateway must back the
    // caller off, not just the ones this interceptor builds.
    await run('POST', '/api/v1/consultations/c-1/summary/async', new ServiceUnavailableException('Note generation is temporarily unavailable'));
    expect(headers['Retry-After']).toBe(String(DOWNSTREAM_RETRY_AFTER_SECONDS));
  });

  it('does NOT set Retry-After on a 502', async () => {
    const upstream5xx = Object.assign(new Error('Request failed with status code 502'), {
      isAxiosError: true,
      code: 'ERR_BAD_RESPONSE',
      response: { status: 502, data: { detail: 'upstream boom' } },
    });
    const thrown = await run('POST', '/api/v1/consultations/c-1/summary', upstream5xx);
    expect(thrown.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect(headers['Retry-After']).toBeUndefined();
  });

  // ---------------------------------------------------------------- AC-6

  it('propagates a genuine upstream 4xx with a sanitized body', async () => {
    const upstream4xx = Object.assign(new Error('Request failed with status code 422'), {
      isAxiosError: true,
      code: 'ERR_BAD_REQUEST',
      // The upstream body can echo the assembled clinical prompt — it must
      // never be forwarded.
      response: { status: 422, data: { detail: 'prompt too long: <PHI-bearing excerpt>' } },
    });
    const thrown = await run('POST', '/api/v1/consultations/c-1/summary', upstream4xx);
    expect(thrown.getStatus()).toBe(422);
    expect(JSON.stringify(thrown.getResponse())).not.toContain('PHI-bearing');
  });

  // -------------------------------------------------------- non-regression

  it('leaves a non-downstream error alone', async () => {
    const plain = new HttpException({ statusCode: 400, error: 'Bad Request' }, 400);
    const thrown = await run('POST', '/api/v1/departments', plain);
    expect(thrown).toBe(plain);
    expect(headers['Retry-After']).toBeUndefined();
  });
});
