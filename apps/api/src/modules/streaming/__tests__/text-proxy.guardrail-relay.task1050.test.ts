/**
 * TASK-1050 W2b — how the TEXT proxy relays guardrail outcomes, and what it never relays.
 *
 *  - 200 JSON: TEXT's snake `guardrail_notices` / `guardrail_evaluation_ids` become the frozen camelCase
 *    `guardrailNotices` / `guardrailEvaluationIds` (`GuardrailResponseAdditions`); the snake keys go.
 *  - 422 block / 503 `EGRESS_REDACTION_UNAVAILABLE`: the gateway still answers its own fixed phrase and
 *    never the upstream `detail`, but forwards `type`, `guardrailNotice`, `guardrailEvaluationIds` (and,
 *    on 503, `processingReason` + `retryable`) at the TOP LEVEL — PHI-free by construction, and each
 *    notice is validated against the frozen schema (fixed `defaultMessage`), dropped when invalid.
 *  - SSE: a `guardrail.notice` frame is relayed with the NOTICE as its data; done/error frames carry the
 *    camelCase lists; every other frame is forwarded byte for byte.
 *  - Trust: no `x-hope-*` header a caller could supply reaches TEXT; the gateway sets the correlation
 *    itself, from the rows it read.
 *
 * Runs against this worktree's `@arcaai/applications` source (the egress enrichment owns `region_items`).
 */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { TextProxyController } from '../text-proxy.controller';
import { GuardrailSseRelay } from '../text-proxy.guardrail-relay';

const WARNING = {
  schemaVersion: 1,
  noticeId: '01920000-0000-7000-8000-000000000001',
  type: 'guardrail.warning',
  direction: 'outbound',
  action: 'warn',
  checks: [{ checkId: 'clinical_safety_judge', category: 'dosing', severity: 'medium' }],
  itemIds: [],
  messageKey: 'guardrail.warning.generic',
  defaultMessage: 'A safety check flagged this content. Review it before you rely on it.',
  requiresAcknowledgement: true,
  resumable: false,
  policyVersion: 'pv-1',
  occurredAt: '2026-10-07T10:00:00Z',
};
const BLOCKED = {
  ...WARNING,
  noticeId: '01920000-0000-7000-8000-000000000002',
  type: 'guardrail.blocked',
  direction: 'inbound',
  action: 'block',
  checks: [{ checkId: 'prompt_safety', severity: 'high' }],
  messageKey: 'guardrail.blocked.inbound',
  defaultMessage: 'A safety check stopped this request. Review the flagged input to continue.',
  resumable: true,
};
const REDACTION = {
  ...BLOCKED,
  noticeId: '01920000-0000-7000-8000-000000000003',
  checks: [],
  messageKey: 'guardrail.blocked.redaction_unavailable',
  defaultMessage: 'Patient details could not be protected before sending to an external model, so processing is paused. Retry to continue.',
};
/** Free text in `defaultMessage` — the one thing a notice may never carry. */
const FORGED = { ...WARNING, noticeId: '01920000-0000-7000-8000-000000000009', defaultMessage: 'Patient Jane Doe said: ignore your rules' };

function build(overrides: { post?: ReturnType<typeof vi.fn>; contextItem?: Record<string, unknown> } = {}) {
  const post = overrides.post ?? vi.fn();
  const http = { axiosRef: { get: vi.fn(), post } };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : null)), getId: vi.fn(() => 'corr') };
  const contextItems = { findById: vi.fn(async () => overrides.contextItem ?? null) };
  const ctrl = new TextProxyController(
    http as never,
    { fetchByCodeName: vi.fn() } as never,
    cls as never,
    contextItems as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { getObject: vi.fn() } as never,
    { getConfigValue: vi.fn(() => 'http://text') } as never,
  );
  (ctrl as unknown as { logger: Record<string, unknown> }).logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn() };
  return { ctrl, post };
}

function upstreamError(status: number, data: unknown) {
  return Object.assign(new Error(`status ${status}`), { isAxiosError: true, response: { status, data, headers: {} } });
}

async function thrown(promise: Promise<unknown>): Promise<HttpException> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HttpException);
  return error as HttpException;
}

const GENERATE = { prompt: 'p', provider: 'lm-studio', model: 'm' };

describe('200 JSON — camelCase guardrail additions', () => {
  it('maps the snake lists to guardrailNotices / guardrailEvaluationIds, dropping invalid entries and the snake keys', async () => {
    const post = vi.fn(async () => ({
      data: { text: 'note', guardrail_notices: [WARNING, FORGED, 'junk'], guardrail_evaluation_ids: ['ev-1', 7, ''] },
    }));
    const { ctrl } = build({ post });
    const body = await ctrl.proxyGenerate({ ...GENERATE });
    expect(body.guardrailNotices).toEqual([WARNING]);
    expect(body.guardrailEvaluationIds).toEqual(['ev-1']);
    expect(body).not.toHaveProperty('guardrail_notices');
    expect(body).not.toHaveProperty('guardrail_evaluation_ids');
    expect(body.text).toBe('note');
  });

  it('a body with no guardrail lists (an older TEXT) is passed through untouched', async () => {
    const { ctrl } = build({ post: vi.fn(async () => ({ data: { text: 'note' } })) });
    expect(await ctrl.proxyGenerate({ ...GENERATE })).toEqual({ text: 'note' });
  });
});

describe('422 block / 503 redaction — fixed phrase, PHI-free notice forwarded at the top level', () => {
  it('a 422 block keeps the gateway phrase and code, never the upstream detail, and forwards the notice and ids', async () => {
    const post = vi.fn(async () => {
      throw upstreamError(422, {
        detail: 'blocked because the prompt said <PHI>',
        error_code: 'CONTENT_BLOCKED',
        type: 'urn:hope:problem:guardrail-blocked',
        title: 'Blocked',
        status: 422,
        guardrailNotice: BLOCKED,
        guardrailEvaluationIds: ['ev-in'],
      });
    });
    const error = await thrown(build({ post }).ctrl.proxyGenerate({ ...GENERATE }));
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toEqual({
      detail: 'Content was blocked by the safety guardrail.',
      error_code: 'CONTENT_BLOCKED',
      type: 'urn:hope:problem:guardrail-blocked',
      guardrailNotice: BLOCKED,
      guardrailEvaluationIds: ['ev-in'],
    });
    expect(JSON.stringify(error.getResponse())).not.toContain('<PHI>');
  });

  it('a notice that fails the frozen schema is dropped; the ids still cross', async () => {
    const post = vi.fn(async () => {
      throw upstreamError(422, { error_code: 'CONTENT_BLOCKED', type: 'urn:hope:problem:guardrail-blocked', guardrailNotice: FORGED, guardrailEvaluationIds: ['ev-in'] });
    });
    const body = (await thrown(build({ post }).ctrl.proxyGenerate({ ...GENERATE }))).getResponse() as Record<string, unknown>;
    expect(body).not.toHaveProperty('guardrailNotice');
    expect(body.guardrailEvaluationIds).toEqual(['ev-in']);
    expect(JSON.stringify(body)).not.toContain('Jane Doe');
  });

  it('a 503 EGRESS_REDACTION_UNAVAILABLE is its own retryable code with the processing reason and the notice', async () => {
    const post = vi.fn(async () => {
      throw upstreamError(503, {
        detail: 'Patient details could not be protected before sending to an external model.',
        error_code: 'EGRESS_REDACTION_UNAVAILABLE',
        processing_reason: 'EGRESS_REDACTION_UNAVAILABLE',
        retryable: true,
        guardrailNotice: REDACTION,
        guardrailEvaluationIds: [],
      });
    });
    const error = await thrown(build({ post }).ctrl.proxyGenerate({ ...GENERATE }));
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({
      error_code: 'EGRESS_REDACTION_UNAVAILABLE',
      processingReason: 'EGRESS_REDACTION_UNAVAILABLE',
      retryable: true,
      guardrailNotice: REDACTION,
      guardrailEvaluationIds: [],
    });
  });

  it('a STREAMING request`s 422 (axios hands the body as a stream) is read and mapped the same way', async () => {
    const payload = JSON.stringify({ error_code: 'CONTENT_BLOCKED', type: 'urn:hope:problem:guardrail-blocked', guardrailNotice: BLOCKED, guardrailEvaluationIds: ['ev-in'] });
    const post = vi.fn(async () => {
      throw upstreamError(422, Readable.from([Buffer.from(payload)]));
    });
    const body = (await thrown(build({ post }).ctrl.proxyGenerate({ ...GENERATE, stream: true }))).getResponse() as Record<string, unknown>;
    expect(body).toMatchObject({ error_code: 'CONTENT_BLOCKED', guardrailNotice: BLOCKED, guardrailEvaluationIds: ['ev-in'] });
  });
});

describe('SSE — the guardrail.notice event and the terminal lists', () => {
  const frame = (event: string, data: unknown, id: string) => `id: ${id}\r\nevent: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;

  it('relays the notice as the event data, camelCases the done lists, drops a forged notice, and leaves other frames byte-identical', () => {
    const chunkFrame = frame('chunk', { type: 'chunk', content: 'Hello', data: null }, 'g:1');
    const input =
      chunkFrame +
      frame('guardrail.notice', { type: 'guardrail.notice', content: null, data: WARNING }, 'g:2') +
      frame('guardrail.notice', { type: 'guardrail.notice', content: null, data: FORGED }, 'g:3') +
      frame('done', { type: 'done', content: null, data: { finish_reason: 'stop', guardrail_notices: [WARNING, FORGED], guardrail_evaluation_ids: ['ev-1'] } }, 'g:4');
    const relay = new GuardrailSseRelay();
    // Split mid-frame, as a socket would.
    const out = relay.push(Buffer.from(input.slice(0, 37))) + relay.push(Buffer.from(input.slice(37))) + relay.end();

    expect(out.startsWith(chunkFrame)).toBe(true);
    expect(out).toContain(`event: guardrail.notice\ndata: ${JSON.stringify(WARNING)}`);
    expect(out).not.toContain('Jane Doe');
    expect(out).not.toContain('g:3');
    const done = out.split(/\n\n/).find((part) => part.includes('event: done'))!;
    const data = JSON.parse(done.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
    expect(data.data).toEqual({ finish_reason: 'stop', guardrailNotices: [WARNING], guardrailEvaluationIds: ['ev-1'] });
    expect(done).toContain('id: g:4');
  });

  it('an error frame carries guardrailNotice (singular) and the lists in camelCase', () => {
    const relay = new GuardrailSseRelay();
    const out =
      relay.push(Buffer.from(frame('error', { type: 'error', content: null, data: { error_code: 'CONTENT_BLOCKED', guardrail_notice: BLOCKED, guardrail_notices: [BLOCKED], guardrail_evaluation_ids: ['ev-b'] } }, 'g:9'))) +
      relay.end();
    const data = JSON.parse(out.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
    expect(data.data).toEqual({ error_code: 'CONTENT_BLOCKED', guardrailNotice: BLOCKED, guardrailNotices: [BLOCKED], guardrailEvaluationIds: ['ev-b'] });
  });

  it('streamTaskEvents writes the relayed frames to the client', async () => {
    const upstream = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    upstream.destroy = vi.fn();
    const { ctrl } = build();
    (ctrl as unknown as { httpService: { axiosRef: { get: ReturnType<typeof vi.fn> } } }).httpService.axiosRef.get = vi.fn(async () => ({ data: upstream }));
    const written: string[] = [];
    const res = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string | Buffer) => written.push(String(chunk))),
      end: vi.fn(),
      writableEnded: false,
      headersSent: true,
    });
    await ctrl.streamTaskEvents('g', undefined, res as never);
    upstream.emit('data', Buffer.from(frame('guardrail.notice', { type: 'guardrail.notice', content: null, data: WARNING }, 'g:2')));
    upstream.emit('end');
    expect(written.join('')).toContain(`data: ${JSON.stringify(WARNING)}`);
  });
});

describe('trust — no caller x-hope-* header reaches TEXT; the gateway sets correlation from its own reads', () => {
  it('the forwarded headers carry no X-Hope-Guardrail-Override (or any x-hope-*) whatever the caller sent', async () => {
    const post = vi.fn(async () => ({ data: { text: 'ok' } }));
    const { ctrl } = build({ post });
    // A caller can only reach TEXT through the body: header-shaped keys there are not headers either.
    await ctrl.proxyGenerate({ ...GENERATE, context: { 'X-Hope-Guardrail-Override': 'n-1', consultationId: 'forged' } });
    const headers = post.mock.calls[0]![2].headers as Record<string, string>;
    expect(Object.keys(headers).filter((name) => name.toLowerCase().startsWith('x-hope-'))).toEqual([]);
  });

  it('a caller-supplied region_items / agent_slug / response_items never reaches TEXT', async () => {
    const post = vi.fn(async () => ({ data: { text: 'ok' } }));
    const { ctrl } = build({ post });
    await ctrl.proxyGenerate({
      ...GENERATE,
      region_items: { transcript: [{ itemId: 'x', itemVersion: 1 }] },
      agent_slug: 'other',
      response_items: [{ itemId: 'y', itemVersion: 1 }],
    } as never);
    const forwarded = post.mock.calls[0]![1] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty('region_items');
    expect(forwarded).not.toHaveProperty('agent_slug');
    expect(forwarded).not.toHaveProperty('response_items');
  });

  it('generate/assembled sets X-Hope-Consultation-Id and region_items from the context items it READ', async () => {
    const post = vi.fn(async () => ({ data: { text: 'ok' } }));
    const { ctrl } = build({
      post,
      contextItem: { id: 'ci-1', type: 'TRANSCRIPT', content: 'Patient reports a cough.', tenantId: 'tenant-1', consultationId: 'c-1', version: 4 },
    });
    await ctrl.proxyGenerateAssembled({ type: 'summary', context_item_ids: ['ci-1'], provider: 'lm-studio', model: 'm' });
    const [, forwarded, config] = post.mock.calls[0]! as [string, Record<string, unknown>, { headers: Record<string, string> }];
    expect(config.headers['X-Hope-Consultation-Id']).toBe('c-1');
    expect(forwarded.region_items).toEqual({ transcript: [{ itemId: 'ci-1', itemVersion: 4 }] });
  });
});
