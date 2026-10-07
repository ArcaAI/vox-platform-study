/**
 * TASK-1050 W2b round 2 — `POST admin/guardrail/screen`, the console playground's "Test my rules".
 *
 * Screens the caller's text under the WORKING TENANT's effective rules by calling guardrail's own screen
 * (`/api/v1/guardrail/screen/{inbound|outbound}`) with the internal token, `X-Tenant-Id` = that tenant,
 * `X-Request-Id`, and `caller: 'playground'`; answers the full verdict in camelCase. It persists nothing
 * and echoes no content: envelope, sanitized text and PII span values never leave the gateway.
 */
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuardrailRuleTestService } from '../guardrail-rule-test.service';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const WARNING = {
  schemaVersion: 1,
  noticeId: '01920000-0000-7000-8000-000000000001',
  type: 'guardrail.warning',
  direction: 'inbound',
  action: 'warn',
  checks: [{ checkId: 'unsafe_content_judge', category: 'self_harm', severity: 'medium' }],
  itemIds: [],
  messageKey: 'guardrail.warning.generic',
  defaultMessage: 'A safety check flagged this content. Review it before you rely on it.',
  requiresAcknowledgement: false,
  resumable: false,
  policyVersion: 'pv-7',
  occurredAt: '2026-10-07T10:00:00Z',
};

const SCREEN = {
  decision: 'allow',
  guardrail_decision: 'warn',
  direction: 'inbound',
  reasons: [],
  tenant_id: TENANT_A,
  checks: [
    { name: 'prompt_safety', outcome: 'pass', verdict: 'pass', action: 'block', actionTaken: 'none', score: 0.02, category: null, reason: null, model: 'm', latencyMs: 4 },
    { name: 'unsafe_content_judge', outcome: 'flag', verdict: 'flag', action: 'warn', actionTaken: 'warn', score: 0.91, category: 'self_harm', reason: 'unsafe_content', regionKeys: ['user'] },
  ],
  envelope: '<<<UNTRUSTED>>> the caller text <<<END>>>',
  sanitization: { text: 'the caller text' },
  pii_spans: [{ label: 'person', start: 0, end: 3, text: 'Ann', score: 0.9 }],
  notices: [WARNING, { ...WARNING, noticeId: 'x', defaultMessage: 'Ann said something' }],
  evaluation_id: 'ev-1',
  policy_version: 'pv-7',
};

describe('GuardrailRuleTestService', () => {
  let post: ReturnType<typeof vi.fn>;
  let user: { id: string; tenantId: string; roles: string[] };
  let workingTenant: string | undefined;
  let service: GuardrailRuleTestService;

  beforeEach(() => {
    post = vi.fn(async () => ({ data: SCREEN }));
    user = { id: 'admin-a', tenantId: TENANT_A, roles: ['TENANT_ADMIN'] };
    workingTenant = TENANT_A;
    const cls = { get: vi.fn((key: string) => (key === 'user' ? user : key === 'tenantId' ? workingTenant : undefined)) };
    const config = { get: vi.fn(() => 'http://guardrail') };
    const secrets = { getSecretOptional: vi.fn(async () => 'svc-token') };
    service = new GuardrailRuleTestService({ axiosRef: { post } } as never, config as never, cls as never, secrets as never);
  });

  it('inbound: calls guardrail with the working tenant, the internal token and caller playground', async () => {
    await service.screen({ direction: 'inbound', text: 'Please summarise this.' });
    const [url, body, options] = post.mock.calls[0]! as [string, Record<string, unknown>, { headers: Record<string, string> }];
    expect(url).toBe('http://guardrail/api/v1/guardrail/screen/inbound');
    expect(body).toEqual({ text: 'Please summarise this.', kind: 'prompt', wrap: false, include_pii_spans: false, caller: 'playground' });
    expect(options.headers['X-Tenant-Id']).toBe(TENANT_A);
    expect(options.headers['X-Service-Token']).toBe('svc-token');
  });

  it('inbound with regions sends the regions (and no text), each with its trust', async () => {
    await service.screen({ direction: 'inbound', text: '', regions: [{ key: 'transcript', text: 'Patient said…', trust: 'data' }] });
    const body = post.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.text).toBe('');
    expect(body.regions).toEqual([{ key: 'transcript', text: 'Patient said…', trust: 'data' }]);
  });

  it('outbound: the text is the response, regions are its source regions', async () => {
    await service.screen({ direction: 'outbound', text: 'Take 50 tablets.', regions: [{ key: 'transcript', text: 'source', trust: 'data' }] });
    const [url, body] = post.mock.calls[0]! as [string, Record<string, unknown>];
    expect(url).toBe('http://guardrail/api/v1/guardrail/screen/outbound');
    expect(body).toEqual({ response: 'Take 50 tablets.', source_regions: [{ key: 'transcript', text: 'source' }], caller: 'playground' });
  });

  it('answers the camelCase verdict: four-way decision, per-check outcome, valid notices, ids — and no content', async () => {
    const result = await service.screen({ direction: 'inbound', text: 'Please summarise this.' });
    expect(result).toEqual({
      direction: 'inbound',
      decision: 'warn',
      checks: [
        { name: 'prompt_safety', verdict: 'pass', action: 'block', actionTaken: 'none', score: 0.02, category: null, reason: null },
        { name: 'unsafe_content_judge', verdict: 'flag', action: 'warn', actionTaken: 'warn', score: 0.91, category: 'self_harm', reason: 'unsafe_content' },
      ],
      notices: [WARNING],
      evaluationId: 'ev-1',
      policyVersion: 'pv-7',
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('UNTRUSTED');
    expect(serialized).not.toContain('Ann');
  });

  it('falls back to the binary decision when guardrail states no four-way one', async () => {
    post.mockResolvedValue({ data: { ...SCREEN, guardrail_decision: null, decision: 'block' } });
    expect((await service.screen({ direction: 'inbound', text: 'x' })).decision).toBe('block');
  });

  it('a tenant admin aiming at another tenant is 404; no working tenant is 400 — before any call', async () => {
    workingTenant = TENANT_B;
    await expect(service.screen({ direction: 'inbound', text: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    workingTenant = undefined;
    await expect(service.screen({ direction: 'inbound', text: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    expect(post).not.toHaveBeenCalled();
  });

  it('a super admin screens under its WORKING tenant`s rules', async () => {
    user = { id: 'root', tenantId: '00000000-0000-0000-0000-000000000000', roles: ['SUPER_ADMIN'] };
    workingTenant = TENANT_B;
    await service.screen({ direction: 'inbound', text: 'x' });
    expect((post.mock.calls[0]![2] as { headers: Record<string, string> }).headers['X-Tenant-Id']).toBe(TENANT_B);
  });

  it('text and regions together, or neither, is 400', async () => {
    await expect(service.screen({ direction: 'inbound', text: 'x', regions: [{ key: 'a', text: 'b', trust: 'data' }] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.screen({ direction: 'inbound', text: '' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a guardrail failure is 503 GUARDRAIL_UNAVAILABLE and never relays the upstream body', async () => {
    post.mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 500, data: { detail: 'Ann said…' } } }));
    const error = await service.screen({ direction: 'inbound', text: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((error as ServiceUnavailableException).getResponse())).not.toContain('Ann');
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'GUARDRAIL_UNAVAILABLE' });
  });

  it('guardrail rejecting the request shape (422) is a 400, still without its body', async () => {
    post.mockRejectedValue(Object.assign(new Error('422'), { response: { status: 422, data: { detail: 'Ann' } } }));
    const error = await service.screen({ direction: 'inbound', text: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify((error as BadRequestException).getResponse())).not.toContain('Ann');
  });
});
