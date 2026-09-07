/**
 * TASK-890 black-box J6 — the inbound webhook trigger must resolve its hook row WITHOUT a
 * tenant context.
 *
 * Observed live on dev-2.2: every correctly-signed delivery to
 * `POST /api/v1/hooks/workflows/{hookId}` answered the plane's uniform 404 in ~1 ms — before
 * the signature could be compared. `WorkflowWebhookSecret` is a TENANT-SCOPED model, the hook
 * route is `@Public()`, and so the scoped Prisma client THROWS
 * `TenantScope: tenant context required for model WorkflowWebhookSecret` on the lookup; the
 * service's `.catch(() => null)` turned that into "no such hook". The row being looked up is
 * the ONLY thing that can name the tenant, so the read has to happen off the scoped client.
 *
 * The existing TASK-864 suite could not see this: it mocks the repository, and a mock applies
 * no extension. Here the scoped finder THROWS exactly what the extension throws, which is what
 * makes the test falsifiable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WebhookService } from '../../webhook/webhook.service';
import { WorkflowExposureService, signWebhookTrigger } from '../workflow-exposure.service';

const TENANT_SCOPE_THROW = () => {
  throw new Error('TenantScope: tenant context required for model WorkflowWebhookSecret operation findUnique');
};

// A STATEFUL cls double: `triggerByWebhook` adopts the row's tenant with `set` and `invoke`
// reads it back with `get`, so a `set` that forgets would hide the very handover under test.
const clsStore = new Map<string, unknown>();
const cls = { get: vi.fn((key: string) => clsStore.get(key)), set: vi.fn((key: string, value: unknown) => clsStore.set(key, value)) };
const eventEmitter = { emit: vi.fn() };
const definitions = { findPublishedBySlug: vi.fn(), findActivePublishedByTenant: vi.fn() };
const harness = { startWorkflowRun: vi.fn(), getWorkflowRun: vi.fn(), cancelWorkflowRun: vi.fn() };
const runs = { getRun: vi.fn(), recordRunStarted: vi.fn(), recordRunFinished: vi.fn() };
const config = { getConfigValue: vi.fn((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined)) };
// `findById` is the TENANT-SCOPED read; it throws here for the same reason it throws in production.
const secrets = { findById: vi.fn(TENANT_SCOPE_THROW), findByHookIdUnscoped: vi.fn(), findByTenantSlug: vi.fn(), create: vi.fn(), updateWithVersion: vi.fn() };
const secretsService = { getSecretOptional: vi.fn().mockResolvedValue(undefined) };
const s3 = { putFile: vi.fn().mockResolvedValue(undefined) };

const compiled = { formatVersion: 1, stages: [{ stageIndex: 0, nodes: [{ nodeId: 'n_trigger', type: 'core.trigger', activity: 'interpreter.core_trigger', config: {} }] }], gates: [] };

const graph = {
  version: 1,
  nodes: [
    { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api', 'webhook'] } },
    { id: 'n_output', type: 'core.output', config: { protocols: ['http-sse'] } },
  ],
  edges: [{ id: 'e1', from: 'n_trigger', fromPort: 'out', to: 'n_output', toPort: 'in' }],
};

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

const raw = JSON.stringify({ text: 'chest pain', safe_age: '70' });
const secret = 'deadbeef'.repeat(8);
const row = { id: 'hook-1', tenantId: 'tenant-1', workflowSlug: 'triage', encryptedSecret: WebhookService.encryptSecret(secret) };

beforeEach(() => {
  vi.clearAllMocks();
  clsStore.clear();
  secrets.findById.mockImplementation(TENANT_SCOPE_THROW);
  // The public route arrives with NO tenant — that is the whole point of the plane.
  harness.startWorkflowRun.mockResolvedValue({ runId: 'run-1', status: 'started' });
  runs.recordRunStarted.mockResolvedValue(undefined);
  definitions.findPublishedBySlug.mockResolvedValue({
    id: 'def-1',
    tenantId: 'tenant-1',
    slug: 'triage',
    name: 'Triage',
    description: null,
    paletteKey: 'core',
    versionNumber: 1,
    compiledConfig: compiled,
    graph,
  });
});

describe('triggerByWebhook on a tenant-less public request', () => {
  it('starts the run: the hook row is read unscoped and its tenant is adopted', async () => {
    secrets.findByHookIdUnscoped.mockResolvedValue(row);
    const ts = String(Math.floor(Date.now() / 1000));

    const result = await service().triggerByWebhook('hook-1', {
      tenantId: '',
      rawBody: raw,
      signature: signWebhookTrigger(secret, ts, raw),
      timestamp: ts,
    });

    expect(result.status).toBe('started');
    expect(secrets.findByHookIdUnscoped).toHaveBeenCalledWith('hook-1');
    expect(secrets.findById).not.toHaveBeenCalled();
    expect(cls.set).toHaveBeenCalledWith('tenantId', 'tenant-1');
  });

  it('still answers the plane`s uniform 404 for an unknown hook id', async () => {
    secrets.findByHookIdUnscoped.mockResolvedValue(null);
    const ts = String(Math.floor(Date.now() / 1000));

    await expect(
      service().triggerByWebhook('nope', { tenantId: '', rawBody: raw, signature: signWebhookTrigger(secret, ts, raw), timestamp: ts }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
