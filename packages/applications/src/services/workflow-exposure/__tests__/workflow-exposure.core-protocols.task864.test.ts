/**
 * TASK-864 A6 — the exposure plane over a `core` graph: `?mode=` bounded by the Output's
 * declared protocols, the trigger kinds a Trigger declares, the class-based boundary, the
 * inbound webhook trigger (HMAC over the raw body, replay window, one 404 for every refusal),
 * secret rotation, and the CANCELED write on cancel.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WebhookService } from '../../webhook/webhook.service';
import { exposureBoundaryViolation } from '../exposure-palette-policy';
import { WorkflowExposureService, modeRefusal, signWebhookTrigger } from '../workflow-exposure.service';

const cls = { get: vi.fn(), set: vi.fn() };
const eventEmitter = { emit: vi.fn() };
const definitions = { findPublishedBySlug: vi.fn(), findActivePublishedByTenant: vi.fn() };
const harness = { startWorkflowRun: vi.fn(), getWorkflowRun: vi.fn(), cancelWorkflowRun: vi.fn() };
const runs = { getRun: vi.fn(), recordRunStarted: vi.fn(), recordRunFinished: vi.fn() };
const config = { getConfigValue: vi.fn((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined)) };
const s3 = { putFile: vi.fn().mockResolvedValue(undefined) };
// `findByHookIdUnscoped`, not `findById`: the public hook route carries no tenant, and this
// model is tenant-scoped — see `workflow-exposure.webhook-tenantless.bbj6.test.ts` (J6).
const secrets = { findByHookIdUnscoped: vi.fn(), findByTenantSlug: vi.fn(), create: vi.fn(), updateWithVersion: vi.fn() };
const secretsService = { getSecretOptional: vi.fn().mockResolvedValue(undefined) };

function coreGraph(protocols: string[], kinds: string[] = ['api', 'webhook']) {
  return {
    version: 1,
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: { kinds } },
      { id: 'n_output', type: 'core.output', config: { protocols } },
    ],
    edges: [{ id: 'e1', from: 'n_trigger', fromPort: 'out', to: 'n_output', toPort: 'in' }],
  };
}

const compiled = { formatVersion: 1, stages: [{ stageIndex: 0, nodes: [{ nodeId: 'n_trigger', type: 'core.trigger', activity: 'interpreter.core_trigger', config: {} }] }], gates: [] };

function definition(over: Record<string, unknown> = {}) {
  return { id: 'def-1', tenantId: 'tenant-1', slug: 'triage', name: 'Triage', description: null, paletteKey: 'core', versionNumber: 1, compiledConfig: compiled, graph: coreGraph(['http-sse']), ...over };
}

function service(): WorkflowExposureService {
  return new WorkflowExposureService(
    definitions as never,
    harness as never,
    runs as never,
    config as never,
    eventEmitter as never,
    cls as never,
    s3 as never,
    undefined,
    undefined,
    undefined,
    secrets as never,
    secretsService as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  cls.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined));
  harness.startWorkflowRun.mockResolvedValue({ runId: 'run-1', status: 'started' });
  runs.recordRunStarted.mockResolvedValue({});
  runs.recordRunFinished.mockResolvedValue({});
});

describe('modeRefusal — ?mode bounded by the Output protocols', () => {
  it('async is always allowed; a legacy graph is unrestricted', () => {
    expect(modeRefusal(coreGraph(['http-sse']), 'async')).toBeNull();
    expect(modeRefusal(coreGraph(['http-sse']), undefined)).toBeNull();
    expect(modeRefusal({ nodes: [{ id: 'a', type: 'core.start', config: {} }] }, 'blocking')).toBeNull();
  });

  it('blocking needs http, stream needs http-sse', () => {
    expect(modeRefusal(coreGraph(['http-sse']), 'blocking')).toContain("'http'");
    expect(modeRefusal(coreGraph(['http-sse']), 'stream')).toBeNull();
    expect(modeRefusal(coreGraph(['http']), 'stream')).toContain("'http-sse'");
    expect(modeRefusal(coreGraph(['http', 'http-sse', 'socket']), 'blocking')).toBeNull();
  });
});

describe('invoke over a core graph', () => {
  it('refuses mode=blocking with a 400 naming the declared protocols when http is not published', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(definition());
    await expect(service().invoke('triage', { input: {} }, { mode: 'blocking' })).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.startWorkflowRun).not.toHaveBeenCalled();
  });

  it('starts the run for mode=stream and records the api trigger', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(definition());
    const result = await service().invoke('triage', { input: { text: 'hi' } }, { mode: 'stream' });
    expect(result.runId).toBeDefined();
    expect(runs.recordRunStarted).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'api invoke' }));
  });

  it('a Trigger that does not declare the api kind is a 404 on the api plane', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(definition({ graph: coreGraph(['http-sse'], ['consultation']) }));
    await expect(service().invoke('triage', { input: {} }, {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the class-based boundary: a core graph with a clinical-write action is refused unbound, admitted bound', () => {
    const graph = { nodes: [{ id: 'a', type: 'core.trigger', config: { kinds: ['api'] } }, { id: 'p', type: 'core.action', config: { actionKey: 'consultation.persistDraft' } }] };
    expect(exposureBoundaryViolation({ paletteKey: 'core', graph, compiledConfig: compiled })).toContain('consultation.persistDraft');
    expect(exposureBoundaryViolation({ paletteKey: 'core', graph, compiledConfig: compiled }, { consultationBound: true })).toBeNull();
    const clean = { nodes: [{ id: 'a', type: 'core.trigger', config: {} }, { id: 'o', type: 'core.output', config: {} }, { id: 'g', type: 'core.action', config: { actionKey: 'guard.phi' } }] };
    expect(exposureBoundaryViolation({ paletteKey: 'core', graph: clean, compiledConfig: compiled })).toBeNull();
  });
});

describe('cancelRun writes CANCELED on the read model (G9)', () => {
  it('records the terminal status at the cancel, not on a later read', async () => {
    runs.getRun.mockResolvedValue({ runId: 'run-1', workflowSlug: 'triage', workflowVersionId: 'def-1', sessionId: 'workflow-interpreter-run-1' });
    harness.cancelWorkflowRun.mockResolvedValue({ runId: 'run-1', status: 'cancel_requested' });
    await service().cancelRun('triage', 'run-1');
    expect(runs.recordRunFinished).toHaveBeenCalledWith(expect.objectContaining({ status: 'CANCELED', runId: 'run-1', terminalReason: 'cancelled_by_caller' }));
  });
});

describe('the inbound webhook trigger', () => {
  const raw = JSON.stringify({ text: 'chest pain', age: 70 });
  const secret = 'deadbeef'.repeat(8);
  const row = { id: 'hook-1', tenantId: 'tenant-1', workflowSlug: 'triage', encryptedSecret: WebhookService.encryptSecret(secret) };
  const now = () => String(Math.floor(Date.now() / 1000));

  it('a correctly signed body starts a run under the secret`s tenant with trigger=webhook', async () => {
    secrets.findByHookIdUnscoped.mockResolvedValue(row);
    definitions.findPublishedBySlug.mockResolvedValue(definition());
    const ts = now();
    const result = await service().triggerByWebhook('hook-1', { tenantId: '', rawBody: raw, signature: signWebhookTrigger(secret, ts, raw), timestamp: ts });
    expect(result.status).toBe('started');
    expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
    expect(runs.recordRunStarted).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'webhook' }));
    expect(harness.startWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ payload: { text: 'chest pain', age: 70 } }));
  });

  it.each([
    ['a wrong signature', (ts: string) => ({ signature: signWebhookTrigger('other', ts, raw), timestamp: ts })],
    ['a stale timestamp', () => ({ signature: signWebhookTrigger(secret, '1', raw), timestamp: '1' })],
    ['a missing signature', (ts: string) => ({ signature: undefined, timestamp: ts })],
    ['a tampered body', (ts: string) => ({ signature: signWebhookTrigger(secret, ts, raw + ' '), timestamp: ts })],
  ])('%s is the same 404 — the public plane discloses nothing', async (_name, headers) => {
    secrets.findByHookIdUnscoped.mockResolvedValue(row);
    definitions.findPublishedBySlug.mockResolvedValue(definition());
    const ts = now();
    await expect(service().triggerByWebhook('hook-1', { tenantId: '', rawBody: raw, ...headers(ts) })).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.startWorkflowRun).not.toHaveBeenCalled();
  });

  it('an unknown hook id is a 404', async () => {
    secrets.findByHookIdUnscoped.mockResolvedValue(null);
    await expect(service().triggerByWebhook('nope', { tenantId: '', rawBody: raw, signature: 'sha256=x', timestamp: now() })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a Trigger without the webhook kind refuses a signed request', async () => {
    secrets.findByHookIdUnscoped.mockResolvedValue(row);
    definitions.findPublishedBySlug.mockResolvedValue(definition({ graph: coreGraph(['http-sse'], ['api']) }));
    const ts = now();
    await expect(service().triggerByWebhook('hook-1', { tenantId: '', rawBody: raw, signature: signWebhookTrigger(secret, ts, raw), timestamp: ts })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('rotateWebhookSecret', () => {
  it('issues a secret exactly once and persists only ciphertext', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(definition());
    secrets.findByTenantSlug.mockResolvedValue(null);
    secrets.create.mockImplementation(async (entity: { id?: string; encryptedSecret: string }) => ({ ...entity, id: 'hook-9' }));
    const result = await service().rotateWebhookSecret('triage');
    expect(result.secret).toHaveLength(64);
    expect(result.hookUrl).toBe('/api/v1/hooks/workflows/hook-9');
    const persisted = secrets.create.mock.calls[0]![0] as { encryptedSecret: string };
    expect(persisted.encryptedSecret).not.toContain(result.secret);
    expect(WebhookService.decryptSecret(persisted.encryptedSecret)).toBe(result.secret);
    expect(eventEmitter.emit).toHaveBeenCalled();
  });

  it('rotates in place when a secret exists, and 404s an unknown slug', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(definition());
    const existing = { id: 'hook-1', version: 3, encryptedSecret: 'old', rotatedAt: new Date(0) };
    secrets.findByTenantSlug.mockResolvedValue(existing);
    secrets.updateWithVersion.mockImplementation(async (_id: string, entity: unknown) => entity);
    await service().rotateWebhookSecret('triage');
    expect(secrets.updateWithVersion).toHaveBeenCalledWith('hook-1', expect.anything(), 3);
    definitions.findPublishedBySlug.mockResolvedValue(null);
    await expect(service().rotateWebhookSecret('ghost')).rejects.toBeInstanceOf(NotFoundException);
  });
});
