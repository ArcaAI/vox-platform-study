/**
 * TASK-1036 (lane B6b) — the exposure plane admits a run by the workflow's SETTINGS (OD-4):
 * `isWorkflowEntryAllowed(effectiveExposureSettings(definition), entry)` replaces the legacy
 * `core.trigger.kinds` / `core.output.protocols` checks. The entry is `api` / `webhook` (the
 * caller's connection) or `consultation` (a consultation-bound URL); `?mode=stream` additionally
 * needs the `sse` connection. Async and blocking are plain `api`.
 *
 * A definition with no settings (published before the data contract) keeps the legacy checks and
 * their error shapes for one release (D-4): a kind not declared is a 404, a mode not published is a
 * 400 naming the declared protocols.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowExposureService } from '../workflow-exposure.service';

const cls = { get: vi.fn(), set: vi.fn() };
const eventEmitter = { emit: vi.fn() };
const definitions = { findPublishedBySlug: vi.fn(), findActivePublishedByTenant: vi.fn() };
const harness = { startWorkflowRun: vi.fn(), getWorkflowRun: vi.fn(), cancelWorkflowRun: vi.fn() };
const runs = { getRun: vi.fn(), recordRunStarted: vi.fn(), recordRunFinished: vi.fn() };
const config = { getConfigValue: vi.fn((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined)) };
const s3 = { putFile: vi.fn().mockResolvedValue(undefined) };

/** A core graph whose LEGACY declarations disagree with its settings, so the test tells them apart. */
function graph(legacy: { kinds: string[]; protocols: string[] }, settings?: Record<string, unknown>) {
  return {
    version: 1,
    ...(settings ? { settings } : {}),
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: { kinds: legacy.kinds } },
      { id: 'n_output', type: 'core.output', config: { protocols: legacy.protocols } },
    ],
    edges: [{ id: 'e1', from: 'n_trigger', fromPort: 'out', to: 'n_output', toPort: 'in' }],
  };
}

const stages = [{ stageIndex: 0, nodes: [{ nodeId: 'n_trigger', type: 'core.trigger', activity: 'interpreter.core_trigger', config: {} }] }];
const compiled = (settings?: Record<string, unknown>) => ({ formatVersion: 1, stages, gates: [], ...(settings ? { settings } : {}) });

function definition(over: Record<string, unknown>) {
  return { id: 'def-1', tenantId: 'tenant-1', slug: 'triage', name: 'Triage', description: null, paletteKey: 'core', versionNumber: 1, ...over };
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
  );
}

const refusals = () => eventEmitter.emit.mock.calls.map((call) => (call[1] as { data?: { action?: string } })?.data?.action).filter(Boolean);

beforeEach(() => {
  vi.clearAllMocks();
  cls.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined));
  harness.startWorkflowRun.mockResolvedValue({ runId: 'run-1', status: 'started' });
  runs.recordRunStarted.mockResolvedValue({});
});

const legacyClosed = { kinds: ['consultation'], protocols: ['http'] };

describe('settings frozen at publish (compiledConfig.settings) gate the entry', () => {
  it('admits an api invoke the legacy trigger kinds would refuse', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(
      definition({ graph: graph(legacyClosed), compiledConfig: compiled({ connections: ['api'], sources: [] }) }),
    );
    const result = await service().invoke('triage', { input: {} }, {});
    expect(result.runId).toBeDefined();
    expect(harness.startWorkflowRun).toHaveBeenCalled();
  });

  it('refuses an api invoke when the settings do not admit `api` — the house 404, audited', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(
      definition({ graph: graph({ kinds: ['api'], protocols: ['http'] }), compiledConfig: compiled({ connections: ['webhook'], sources: [] }) }),
    );
    await expect(service().invoke('triage', { input: {} }, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.startWorkflowRun).not.toHaveBeenCalled();
    expect(refusals()).toContain('invokeRefusedByExposureSettings');
  });

  it('refuses a consultation-bound invoke when `consultation` is not a source', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(
      definition({ graph: graph({ kinds: ['consultation'], protocols: ['http'] }), compiledConfig: compiled({ connections: ['api'], sources: [] }) }),
    );
    await expect(service().invoke('triage', { input: {} }, { consultationId: 'c-1' })).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.startWorkflowRun).not.toHaveBeenCalled();
  });

  it('mode=stream needs the `sse` connection: a 400 naming the admitted connections', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(
      definition({ graph: graph({ kinds: ['api'], protocols: ['http-sse'] }), compiledConfig: compiled({ connections: ['api'], sources: [] }) }),
    );
    const error = await service()
      .invoke('triage', { input: {} }, { mode: 'stream' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(String((error as BadRequestException).message)).toContain("'sse'");
    expect(harness.startWorkflowRun).not.toHaveBeenCalled();
  });

  it('mode=stream with `sse`, and mode=blocking with `api`, both start — whatever the legacy protocols say', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(
      definition({ graph: graph(legacyClosed), compiledConfig: compiled({ connections: ['api', 'sse'], sources: [] }) }),
    );
    await service().invoke('triage', { input: {} }, { mode: 'stream' });
    expect(harness.startWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('mode=blocking needs only `api`', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(
      definition({ graph: graph({ kinds: ['api'], protocols: ['http-sse'] }), compiledConfig: compiled({ connections: ['api'], sources: [] }) }),
    );
    const svc = service();
    // Blocking waits on the stream in the controller; the service only starts the run.
    await svc.invoke('triage', { input: {} }, { mode: 'blocking' });
    expect(harness.startWorkflowRun).toHaveBeenCalledTimes(1);
  });
});

describe('the graph`s own settings (a version published before the data contract)', () => {
  it('gate the entry when the compiled artifact carries none', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(
      definition({ graph: graph(legacyClosed, { connections: ['api'], sources: [] }), compiledConfig: compiled() }),
    );
    await service().invoke('triage', { input: {} }, {});
    expect(harness.startWorkflowRun).toHaveBeenCalledTimes(1);
  });
});

describe('legacy fallback (D-4, one release) keeps its error codes', () => {
  it('a kind the trigger does not declare is still the 404 audited as invokeRefusedByTriggerKind', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(
      definition({ graph: graph({ kinds: ['consultation'], protocols: ['http'] }), compiledConfig: compiled() }),
    );
    await expect(service().invoke('triage', { input: {} }, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(refusals()).toContain('invokeRefusedByTriggerKind');
  });

  it('a mode the output does not publish is still the 400 naming the declared protocols', async () => {
    definitions.findPublishedBySlug.mockResolvedValue(
      definition({ graph: graph({ kinds: ['api'], protocols: ['http'] }), compiledConfig: compiled() }),
    );
    const error = await service()
      .invoke('triage', { input: {} }, { mode: 'stream' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(String((error as BadRequestException).message)).toContain("'http-sse'");
  });
});
