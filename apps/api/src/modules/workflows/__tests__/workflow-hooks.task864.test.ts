/**
 * TASK-864 A6 — the API half: the inbound webhook route is PUBLIC and hands the service the raw
 * body; `startRun` threads `?mode=` to the service and attaches the completion watcher; the
 * run-completion consumer maps the interpreter's terminal vocabulary and records under the run's
 * tenant.
 */
import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { SKIP_AUTH_KEY, terminalStatusOf } from '@arcaai/applications';
import { WorkflowHooksController } from '../workflow-hooks.controller';
import { RunEventStreamHub } from '../run-event-stream-hub';
import { WorkflowRunCompletionService } from '../workflow-run-completion.service';
import { WorkflowsController } from '../workflows.controller';

const reflector = new Reflector();

describe('WorkflowHooksController', () => {
  it('POST hooks/workflows/:hookId is @Public() — an external system has no HOPE credential', () => {
    const handler = WorkflowHooksController.prototype.trigger;
    expect(reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [handler, WorkflowHooksController])).toBe(true);
  });

  it('hands the service the RAW body bytes and the two signature headers', async () => {
    const service = { triggerByWebhook: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'started', statusUrl: '/s', streamUrl: '/st' }) };
    const controller = new WorkflowHooksController(service as never);
    const raw = '{"text":"chest pain"}';
    const result = await controller.trigger('hook-1', { rawBody: Buffer.from(raw) } as never, 'sha256=abc', '1700000000', 'idem-1');
    expect(service.triggerByWebhook).toHaveBeenCalledWith('hook-1', {
      tenantId: '',
      rawBody: raw,
      signature: 'sha256=abc',
      timestamp: '1700000000',
      idempotencyKey: 'idem-1',
    });
    expect(result.runId).toBe('run-1');
  });

  it('refuses a request with no body before touching the service', async () => {
    const service = { triggerByWebhook: vi.fn() };
    const controller = new WorkflowHooksController(service as never);
    await expect(controller.trigger('hook-1', {} as never, 'sha256=abc', '1', undefined)).rejects.toThrow();
    expect(service.triggerByWebhook).not.toHaveBeenCalled();
  });
});

describe('WorkflowsController.startRun (TASK-864)', () => {
  it('threads ?mode= to the service and attaches the completion watcher under the caller tenant', async () => {
    const exposure = { invoke: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'started', statusUrl: '/x', streamUrl: '/x/stream' }) };
    const stream = { stream: vi.fn(), awaitTerminal: vi.fn() };
    const completion = { watch: vi.fn().mockReturnValue(true) };
    const controller = new WorkflowsController(exposure as never, stream as never, completion as never);
    const res = { status: vi.fn() };
    const result = await controller.startRun('triage', { input: {} }, { user: { tenantId: 'tenant-1' } } as never, res as never, 'async', undefined);
    expect(exposure.invoke).toHaveBeenCalledWith('triage', { input: {} }, { idempotencyKey: undefined, apiKeyId: undefined, mode: 'async' });
    expect(completion.watch).toHaveBeenCalledWith('tenant-1', 'run-1');
    expect(result).toEqual(expect.objectContaining({ runId: 'run-1' }));
  });

  // TASK-1036 live check: an API-key run's bound human carried `tenantId: ''`, the `??` chain kept
  // the empty string, and the watcher wrote under no tenant — `TenantScope: tenant context
  // required`, so the run's delivered result was never persisted (GET …/result answered 204).
  // The watcher must use the tenant the run was started under: the request's CLS tenant.
  it('attaches the watcher under the CLS tenant the run started in, never an empty one', async () => {
    const exposure = { invoke: vi.fn().mockResolvedValue({ runId: 'run-1', status: 'started', statusUrl: '/x', streamUrl: '/x/stream' }) };
    const completion = { watch: vi.fn().mockReturnValue(true) };
    const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined)) };
    const controller = new WorkflowsController(
      exposure as never,
      { stream: vi.fn(), awaitTerminal: vi.fn() } as never,
      completion as never,
      undefined /* stream tickets */,
      cls as never,
    );
    await controller.startRun('triage', { input: {} }, { user: { tenantId: '' }, apiKey: { id: 'key-1' } } as never, { status: vi.fn() } as never, 'async', undefined);
    expect(completion.watch).toHaveBeenCalledWith('tenant-1', 'run-1');
  });
});

describe('WorkflowRunCompletionService', () => {
  it('maps the interpreter`s terminal vocabulary onto the read model`s', () => {
    expect(terminalStatusOf('SUCCEEDED')).toBe('COMPLETED');
    expect(terminalStatusOf('DEGRADED')).toBe('COMPLETED');
    expect(terminalStatusOf('FAILED')).toBe('FAILED');
    expect(terminalStatusOf('CANCELLED')).toBe('CANCELED');
    expect(terminalStatusOf('TIMED_OUT')).toBe('TIMED_OUT');
    expect(terminalStatusOf('RUNNING')).toBeNull();
  });

  it('does not attach a watcher when no push transport is configured, and never throws', () => {
    const runs = { recordRunFinished: vi.fn() };
    const cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
    // TASK-1038: the push transport is the shared hub; an unconfigured one reports unavailable.
    const hub = new RunEventStreamHub({ isRedisConfigured: () => false } as never);
    const service = new WorkflowRunCompletionService(runs as never, cls as never, hub);
    expect(service.watch('tenant-1', 'run-1')).toBe(false);
    expect(service.activeWatchers).toBe(0);
  });
});
