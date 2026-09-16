/**
 * What the consultation dispatcher hands the interpreter when the governing trigger FOLLOWS
 * the tenant's schema pin, and what it answers when asked the same question WITHOUT dispatching.
 *
 * Two behaviours, one derivation:
 *
 *   1. the per-run claim-checked config is minted from the EFFECTIVE bytes, never from the
 *      published ones, so a run started today is validated against the schema the tenant has
 *      pinned today;
 *   2. `previewGoverningWorkflow` answers the same question for `open`'s pre-dispatch check —
 *      from the same resolution, so a payload `open` accepted cannot be refused by the run it
 *      then starts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationWorkflowDispatchService } from '../consultation-workflow-dispatch.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CONSULTATION = 'c-1';
const DEPARTMENT = 'd-1';
const USER = 'u-1';

const PINNED_V4 = {
  kinds: [
    { key: 'encounter', primitive: 'STRUCTURED', fields: { type: 'object', properties: { note: { type: 'string' } } } },
    { key: 'referral', primitive: 'STRUCTURED', fields: { type: 'object', properties: { reason: { type: 'string' } } } },
  ],
};

/** A compiled artifact whose trigger was frozen against v1 and binds by the tenant's pin. */
function compiledFollowingLatest() {
  return {
    formatVersion: 1,
    stages: [
      {
        index: 0,
        nodes: [
          {
            nodeId: 'n_trigger',
            type: 'core.trigger',
            activity: 'interpreter.core_trigger',
            config: {
              contextSchema: {
                contextSchemaId: 'schema-1',
                followsLatest: true,
                resolved: { type: 'object', additionalProperties: false, properties: { encounter: { type: 'object' } } },
              },
            },
          },
        ],
      },
    ],
    checksum: 'abc',
  };
}

const definition = {
  id: 'wd-1',
  slug: 'arcaai-consultation-v1',
  versionNumber: 3,
  name: 'ArcaAI Consultation',
  paletteKey: 'core',
  compiledConfig: compiledFollowingLatest(),
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    assignments: { resolve: vi.fn().mockResolvedValue({ workflowDefinitionSlug: definition.slug, source: 'tenant' }) },
    definitionRepository: { findPublishedBySlug: vi.fn().mockResolvedValue(definition) },
    consultationRepository: { findById: vi.fn().mockResolvedValue({ id: CONSULTATION, metadata: null }), update: vi.fn().mockResolvedValue({}) },
    workflowRunService: { recordRunStarted: vi.fn().mockResolvedValue({}) },
    harnessGateway: { startWorkflowRun: vi.fn().mockResolvedValue({ status: 'RUNNING' }) },
    s3Service: { putFile: vi.fn().mockResolvedValue(undefined) },
    effectiveTriggerSchema: {
      resolve: vi.fn(),
      currentPin: vi.fn().mockResolvedValue({ versionNumber: 4, definition: PINNED_V4 }),
    },
    ...overrides,
  };
}

function makeService(deps: ReturnType<typeof makeDeps>) {
  return new ConsultationWorkflowDispatchService(
    deps.assignments as never,
    deps.definitionRepository as never,
    deps.consultationRepository as never,
    deps.workflowRunService as never,
    deps.harnessGateway as never,
    deps.s3Service as never,
    undefined,
    undefined,
    undefined,
    deps.effectiveTriggerSchema as never,
  );
}

/** The bytes actually handed to the claim-check store, parsed back. */
function claimCheckedConfig(deps: ReturnType<typeof makeDeps>): Record<string, unknown> {
  const call = deps.s3Service.putFile.mock.calls.at(-1)!;
  const body = call[2] as Buffer | string;
  return JSON.parse(typeof body === 'string' ? body : body.toString('utf8'));
}

function triggerContextSchema(config: Record<string, unknown>): Record<string, unknown> {
  const stages = config.stages as Array<{ nodes: Array<{ nodeId: string; config: Record<string, unknown> }> }>;
  return stages.flatMap((stage) => stage.nodes).find((node) => node.nodeId === 'n_trigger')!.config.contextSchema as Record<string, unknown>;
}

describe('dispatchForConsultation — the per-run config carries the EFFECTIVE trigger schema', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('mints the claim check from bytes whose trigger holds the tenant CURRENT pin, not the published one', async () => {
    const result = await makeService(deps).dispatchForConsultation({
      consultationId: CONSULTATION,
      tenantId: TENANT,
      departmentId: DEPARTMENT,
      userId: USER,
    });

    expect(result.dispatched).toBe(true);
    const contextSchema = triggerContextSchema(claimCheckedConfig(deps));
    expect(Object.keys((contextSchema.resolved as { properties: Record<string, unknown> }).properties)).toEqual(['encounter', 'referral']);
    expect(contextSchema.effectiveVersionNumber).toBe(4);
  });

  it('reads the pin for the schema the TRIGGER names, in the consultation tenant', async () => {
    await makeService(deps).dispatchForConsultation({ consultationId: CONSULTATION, tenantId: TENANT, departmentId: DEPARTMENT, userId: USER });

    expect(deps.effectiveTriggerSchema.currentPin).toHaveBeenCalledWith(TENANT, 'schema-1');
  });

  it('dispatches against the PUBLISHED bytes when the pin cannot be read — a schema outage never stops an open', async () => {
    deps.effectiveTriggerSchema.currentPin.mockResolvedValue(null);

    const result = await makeService(deps).dispatchForConsultation({
      consultationId: CONSULTATION,
      tenantId: TENANT,
      departmentId: DEPARTMENT,
      userId: USER,
    });

    expect(result.dispatched).toBe(true);
    expect(Object.keys((triggerContextSchema(claimCheckedConfig(deps)).resolved as { properties: Record<string, unknown> }).properties)).toEqual([
      'encounter',
    ]);
  });

  it('reads no pin at all for a PINNED trigger', async () => {
    const pinned = compiledFollowingLatest();
    (pinned.stages[0].nodes[0].config.contextSchema as Record<string, unknown>).followsLatest = false;
    deps.definitionRepository.findPublishedBySlug.mockResolvedValue({ ...definition, compiledConfig: pinned });

    await makeService(deps).dispatchForConsultation({ consultationId: CONSULTATION, tenantId: TENANT, departmentId: DEPARTMENT, userId: USER });

    expect(deps.effectiveTriggerSchema.currentPin).not.toHaveBeenCalled();
  });

  it('dispatches unchanged when the resolver is not wired at all', async () => {
    const svc = new ConsultationWorkflowDispatchService(
      deps.assignments as never,
      deps.definitionRepository as never,
      deps.consultationRepository as never,
      deps.workflowRunService as never,
      deps.harnessGateway as never,
      deps.s3Service as never,
    );

    expect(
      (await svc.dispatchForConsultation({ consultationId: CONSULTATION, tenantId: TENANT, departmentId: DEPARTMENT, userId: USER })).dispatched,
    ).toBe(true);
  });
});

describe('previewGoverningWorkflow — the same answer, without dispatching anything', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('names the workflow the cascade would select and the schema a run would be checked against', async () => {
    const preview = await makeService(deps).previewGoverningWorkflow({ tenantId: TENANT, departmentId: DEPARTMENT });

    expect(preview).toMatchObject({ workflowDefinitionSlug: definition.slug, boundSchemaVersion: 4 });
    expect(Object.keys((preview!.resolved as { properties: Record<string, unknown> }).properties)).toEqual(['encounter', 'referral']);
    expect(deps.harnessGateway.startWorkflowRun).not.toHaveBeenCalled();
    expect(deps.workflowRunService.recordRunStarted).not.toHaveBeenCalled();
    expect(deps.s3Service.putFile).not.toHaveBeenCalled();
  });

  it('honours the caller SELECTION over the cascade, exactly as dispatch does', async () => {
    await makeService(deps).previewGoverningWorkflow({ tenantId: TENANT, departmentId: DEPARTMENT, workflowDefinitionSlug: 'chosen-one' });

    expect(deps.assignments.resolve).not.toHaveBeenCalled();
    expect(deps.definitionRepository.findPublishedBySlug).toHaveBeenCalledWith(TENANT, 'chosen-one');
  });

  it('answers null — inconclusive, never a refusal — when no assignment resolves', async () => {
    deps.assignments.resolve.mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' });

    expect(await makeService(deps).previewGoverningWorkflow({ tenantId: TENANT, departmentId: DEPARTMENT })).toBeNull();
  });

  it('answers null when the definition is gone, has no compiled config, or the lookup throws', async () => {
    const svc = makeService(deps);

    deps.definitionRepository.findPublishedBySlug.mockResolvedValue(null);
    expect(await svc.previewGoverningWorkflow({ tenantId: TENANT, departmentId: DEPARTMENT })).toBeNull();

    deps.definitionRepository.findPublishedBySlug.mockResolvedValue({ ...definition, compiledConfig: null });
    expect(await svc.previewGoverningWorkflow({ tenantId: TENANT, departmentId: DEPARTMENT })).toBeNull();

    deps.definitionRepository.findPublishedBySlug.mockRejectedValue(new Error('database unavailable'));
    expect(await svc.previewGoverningWorkflow({ tenantId: TENANT, departmentId: DEPARTMENT })).toBeNull();
  });

  it('answers null when the trigger froze no schema — there is nothing to check a payload against', async () => {
    deps.definitionRepository.findPublishedBySlug.mockResolvedValue({
      ...definition,
      compiledConfig: { formatVersion: 1, stages: [{ index: 0, nodes: [{ nodeId: 'n_trigger', type: 'core.trigger', config: {} }] }], checksum: 'a' },
    });

    expect(await makeService(deps).previewGoverningWorkflow({ tenantId: TENANT, departmentId: DEPARTMENT })).toBeNull();
  });
});
