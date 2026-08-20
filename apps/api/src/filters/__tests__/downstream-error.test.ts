/**
 * TASK-768 — Downstream-unreachable error contract.
 *
 * Unit tests for the SINGLE boundary that builds a client-facing body for a
 * failed call to a downstream Python service. Two owner requirements are
 * pinned here:
 *
 *   1. A transport failure maps to 503 — never 400, never an opaque 500.
 *   2. No client-facing body carries the internal host:port (or any other
 *      topology: IP, errno, URL, file path, stack frame).
 *
 * The route sweep that proves requirement 2 holds across every downstream-facing
 * route lives in `../../interceptors/__tests__/exception.interceptor.downstream.test.ts`;
 * the source sweep that stops a NEW call site reintroducing it lives in
 * `./downstream-error-leak-sweep.test.ts`.
 */
import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  DOWNSTREAM_RETRY_AFTER_SECONDS,
  buildDownstreamErrorBody,
  capabilityForPath,
  classifyDownstreamFailure,
  containsTopology,
  describeCauseForOperator,
  downstreamStatusFor,
  redactTopology,
} from '../downstream-error';

/** An `AxiosError`-shaped transport failure (no `response` — never reached the peer). */
function transportError(code: string, message = `connect ${code} 127.0.0.1:8862`) {
  return Object.assign(new Error(message), { code, isAxiosError: true, response: undefined });
}

/** An `AxiosError`-shaped upstream failure (the peer answered). */
function upstreamError(status: number, data: unknown = { detail: 'boom' }) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    code: status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
    response: { status, data },
  });
}

describe('classifyDownstreamFailure — classify by CAUSE, never by what the client sent', () => {
  // AC-1. Every errno the Node/undici/axios stack can raise when a peer is
  // unreachable. A miss here is a 500 or (worse) a 400 in production.
  const TRANSPORT_ERRNOS = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EHOSTDOWN',
    'EPIPE',
    'ECONNABORTED',
    'EADDRNOTAVAIL',
    'ERR_SOCKET_CONNECTION_TIMEOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ];

  it.each(TRANSPORT_ERRNOS)('classifies %s as a transport failure', (code) => {
    expect(classifyDownstreamFailure(transportError(code))).toBe('transport');
  });

  it.each(TRANSPORT_ERRNOS)('maps %s to 503 Service Unavailable', (code) => {
    const kind = classifyDownstreamFailure(transportError(code));
    expect(downstreamStatusFor(kind!)).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('classifies a bare "socket hang up" (no errno) as transport', () => {
    expect(classifyDownstreamFailure(new Error('socket hang up'))).toBe('transport');
  });

  it('classifies a DNS failure carried only in the message as transport', () => {
    expect(classifyDownstreamFailure(new Error('getaddrinfo EAI_AGAIN text-svc'))).toBe('transport');
  });

  it('unwraps the happy-eyeballs AggregateError from the TASK-764 evidence', () => {
    // The observed production error: `AggregateError: connect ECONNREFUSED ::1:8862;
    // connect ECONNREFUSED 127.0.0.1:8862`. The AggregateError itself carries no
    // `.code` — the errno lives on its `.errors[]` members.
    const agg = new AggregateError([transportError('ECONNREFUSED', 'connect ECONNREFUSED ::1:8862'), transportError('ECONNREFUSED')], 'AggregateError');
    expect(classifyDownstreamFailure(agg)).toBe('transport');
    expect(downstreamStatusFor(classifyDownstreamFailure(agg)!)).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('walks the `cause` chain', () => {
    const wrapped = new Error('TEXT finalize failed', { cause: transportError('ECONNREFUSED') });
    expect(classifyDownstreamFailure(wrapped)).toBe('transport');
  });

  it('classifies an upstream 5xx as upstream_server_error → 502', () => {
    const kind = classifyDownstreamFailure(upstreamError(500));
    expect(kind).toBe('upstream_server_error');
    expect(downstreamStatusFor(kind!, 500)).toBe(HttpStatus.BAD_GATEWAY);
  });

  it('classifies an upstream 4xx as upstream_client_error and PROPAGATES that status', () => {
    const kind = classifyDownstreamFailure(upstreamError(422));
    expect(kind).toBe('upstream_client_error');
    expect(downstreamStatusFor(kind!, 422)).toBe(422);
  });

  it('never lets a transport failure become a 4xx', () => {
    for (const code of TRANSPORT_ERRNOS) {
      const status = downstreamStatusFor(classifyDownstreamFailure(transportError(code))!);
      expect(status).toBeGreaterThanOrEqual(500);
    }
  });

  it('returns null for an error that is not a downstream failure at all', () => {
    expect(classifyDownstreamFailure(new Error('Tenant ID is required'))).toBeNull();
    expect(classifyDownstreamFailure(new TypeError('x is not a function'))).toBeNull();
    expect(classifyDownstreamFailure(undefined)).toBeNull();
    expect(classifyDownstreamFailure(null)).toBeNull();
    expect(classifyDownstreamFailure('a string')).toBeNull();
  });
});

describe('containsTopology — the predicate every client-facing body is held to', () => {
  it.each([
    'connect ECONNREFUSED 127.0.0.1:8862',
    'AggregateError: connect ECONNREFUSED ::1:8862; connect ECONNREFUSED 127.0.0.1:8862',
    'getaddrinfo ENOTFOUND harness',
    'connect ECONNREFUSED localhost:8866',
    'http://localhost:8862/api/v1/generate',
    '/Users/dev/hope-v2/apps/api/src/x.ts:12:5',
    'at HarnessGatewayService.start (/app/dist/main.js:1:1)',
    'ETIMEDOUT',
  ])('flags %j as topology', (s) => {
    expect(containsTopology(s)).toBe(true);
  });

  it.each(['Summarization is temporarily unavailable. Please retry.', 'Service Unavailable', 'Note generation returned an invalid response.', 'updated at 12:34'])(
    'does NOT flag %j',
    (s) => {
      expect(containsTopology(s)).toBe(false);
    },
  );
});

describe('redactTopology — strips topology while keeping an operator-legible reason', () => {
  it('removes the host:port from the evidence string', () => {
    const redacted = redactTopology('connect ECONNREFUSED 127.0.0.1:8862');
    expect(redacted).not.toMatch(/127\.0\.0\.1/);
    expect(redacted).not.toMatch(/8862/);
    // The errno is a REASON, not topology — keep it for the admin health screen.
    expect(redacted).toContain('ECONNREFUSED');
  });

  it('removes an IPv6 loopback and a bare hostname:port', () => {
    expect(redactTopology('connect ECONNREFUSED ::1:8862')).not.toMatch(/8862/);
    expect(redactTopology('connect ECONNREFUSED localhost:8866')).not.toMatch(/localhost:8866/);
  });

  it('removes a full URL', () => {
    expect(redactTopology('POST http://127.0.0.1:8862/api/v1/generate failed')).not.toMatch(/8862|127\.0\.0\.1/);
  });

  it('leaves a clean message untouched', () => {
    expect(redactTopology('Summarization is temporarily unavailable.')).toBe('Summarization is temporarily unavailable.');
  });
});

describe('capabilityForPath — names the CAPABILITY, never the topology', () => {
  it.each([
    ['/api/v1/consultations/abc/summary/async', 'Note generation'],
    ['/api/v1/admin/harness/workflows', 'Note generation'],
    ['/api/v1/consultations/abc/summary', 'Summarization'],
    ['/api/v1/admin/prompt-templates/t-1/test', 'Summarization'],
    ['/api/v1/text-generations/tasks/x/stream', 'Summarization'],
    ['/api/v1/api/smr/api/v1/summarize', 'Summarization'],
    ['/api/v1/speech/synthesize', 'Speech synthesis'],
    ['/api/v1/audio/transcription-jobs', 'Transcription'],
    ['/api/v1/api/stt/transcribe', 'Transcription'],
    ['/api/v1/text-analyses/ner', 'AI text analysis'],
    ['/api/v1/safety-checks', 'AI text analysis'],
  ])('%s → %s', (path, expected) => {
    expect(capabilityForPath(path)).toBe(expected);
  });

  it('falls back to a generic phrase for an unmapped path', () => {
    expect(capabilityForPath('/api/v1/departments')).toBe('A required downstream capability');
    expect(capabilityForPath(undefined)).toBe('A required downstream capability');
  });

  it('never returns a phrase that contains topology', () => {
    for (const p of ['/api/v1/consultations/x/summary', '/api/v1/speech/synthesize', undefined]) {
      expect(containsTopology(capabilityForPath(p))).toBe(false);
    }
  });
});

describe('buildDownstreamErrorBody — the ONLY client-facing body builder', () => {
  it('builds a stable, opaque 503 body carrying the correlationId', () => {
    const body = buildDownstreamErrorBody({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      capability: 'Summarization',
      correlationId: 'corr-1',
    });
    expect(body).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Summarization is temporarily unavailable. Please retry.',
      code: 'GATEWAY.DOWNSTREAM_UNAVAILABLE',
      correlationId: 'corr-1',
    });
  });

  it('builds a 502 body for an upstream server error', () => {
    const body = buildDownstreamErrorBody({
      status: HttpStatus.BAD_GATEWAY,
      capability: 'Note generation',
      correlationId: 'corr-2',
    });
    expect(body.statusCode).toBe(502);
    expect(body.error).toBe('Bad Gateway');
    expect(body.message).toBe('Note generation returned an invalid response.');
  });

  it('builds a sanitized body for a propagated upstream 4xx', () => {
    const body = buildDownstreamErrorBody({ status: 422, capability: 'Summarization', correlationId: 'c' });
    expect(body.statusCode).toBe(422);
    expect(body.message).toBe('Summarization rejected the request.');
  });

  // AC-2, the headline requirement.
  it('NEVER emits topology, whatever the cause looked like', () => {
    for (const status of [HttpStatus.SERVICE_UNAVAILABLE, HttpStatus.BAD_GATEWAY, 422]) {
      for (const path of ['/api/v1/consultations/x/summary', '/api/v1/admin/harness/workflows', '/api/v1/nowhere']) {
        const body = buildDownstreamErrorBody({ status, capability: capabilityForPath(path), correlationId: 'c' });
        expect(containsTopology(JSON.stringify(body))).toBe(false);
      }
    }
  });
});

describe('describeCauseForOperator — the operator gets EVERYTHING', () => {
  it('keeps the errno, the message, the host and the port for the log', () => {
    const detail = describeCauseForOperator(transportError('ECONNREFUSED'));
    expect(detail.causeCode).toBe('ECONNREFUSED');
    expect(String(detail.causeMessage)).toContain('127.0.0.1:8862');
  });

  it('records the upstream status when the peer answered', () => {
    const detail = describeCauseForOperator(upstreamError(503));
    expect(detail.upstreamStatus).toBe(503);
  });

  it('flattens an AggregateError into every member cause', () => {
    const agg = new AggregateError([transportError('ECONNREFUSED', 'connect ECONNREFUSED ::1:8862'), transportError('ECONNREFUSED')], 'AggregateError');
    expect(String(detailText(describeCauseForOperator(agg)))).toContain('8862');
  });

  function detailText(d: Record<string, unknown>) {
    return JSON.stringify(d);
  }
});

describe('Retry-After', () => {
  it('is a small positive integer number of seconds', () => {
    expect(Number.isInteger(DOWNSTREAM_RETRY_AFTER_SECONDS)).toBe(true);
    expect(DOWNSTREAM_RETRY_AFTER_SECONDS).toBeGreaterThan(0);
    expect(DOWNSTREAM_RETRY_AFTER_SECONDS).toBeLessThanOrEqual(30);
  });
});
