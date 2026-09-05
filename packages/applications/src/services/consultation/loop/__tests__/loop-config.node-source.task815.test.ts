/**
 * `LoopConfigService` resolves against the GOVERNING WORKFLOW
 * DEFINITION and the tenant's context schema, not against a `DepartmentAgent`.
 *
 * ## What each field's source became
 *
 * | Field | Was | Is |
 * |---|---|---|
 * | `agentId` | the default agent's row id | the governing definition's SLUG (its stable identity across versions) |
 * | `agentConfigVersionId` | the agent's latest `DepartmentAgentVersion` id | the `WorkflowDefinition` row id — rows ARE versions, so the row IS the immutable pin |
 * | `subscriptions` | `agent.subscribedKinds` x the schema's primitives | every kind the servable schema DECLARES x the same primitives |
 * | `startActions` / `endingActions` | the endpoint list, extended/vetoed by the agent's two levers | the endpoint list alone |
 * | `agents[]` / `reasoningEnabled` | the department's PRIMARY/SPECIALIST roster | `[]` / `false` — the roster retires with `DepartmentAgentRole` |
 *
 * The PYTHON FIELD NAMES do not move. `ConsultationLoopConfig.agent_id` and
 * `agent_config_version_id` are replay-sensitive — they thread through workflow
 * history — so this ticket replaces the identifier SOURCE and keeps the wire
 * names, which is the replay-safe half of the two options the ticket allows.
 *
 * `ILoopConfigService` and `LoopConfigResponse` survive unchanged: the contract
 * is the deliverable, the implementation is what was rebuilt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopConfigService } from '../loop-config.service';
import { CONSULTATION_ENDPOINT_ACTIONS_DEFAULT } from '../endpoint-sequence';

const TENANT = 'tenant-1';
const DEPARTMENT = 'dept-1';
const CONSULTATION = 'consultation-1';

const consultationRepository = { findById: vi.fn() };
const contextSchemaRepository = { findDefaultForScope: vi.fn() };
const contextSchemaVersionRepository = { findBySchemaAndVersionNumber: vi.fn() };
const workflowAssignments = { resolve: vi.fn() };
const workflowDefinitionRepository = { findPublishedBySlug: vi.fn() };
const eventEmitter = { emit: vi.fn() };
const cls = { get: vi.fn(() => undefined) };
const tenantSettings = { resolvePlatform: vi.fn(() => ({ value: 900 })), resolve: vi.fn(() => ({ value: undefined })) };

const DEFINITION = {
  schemaVersion: '1.0',
  kinds: [
    { key: 'audio_stream', label: 'Audio', primitive: 'STREAM_AUDIO', phiClass: 'PHI', cardinality: 'ONE', lifecycle: 'DURING', producedBy: ['CLIENT'] },
    { key: 'work_note', label: 'Work Note', primitive: 'TEXT', phiClass: 'PHI', cardinality: 'MANY', lifecycle: 'ANY', producedBy: ['CLIENT'] },
    { key: 'attachment', label: 'Attachment', primitive: 'DOCUMENT', phiClass: 'PHI', cardinality: 'MANY', lifecycle: 'ANY', producedBy: ['CLIENT'] },
  ],
  outputs: [{ key: 'soap_note', label: 'SOAP Note', primitive: 'TEXT' }],
};

function makeService(): LoopConfigService {
  return new LoopConfigService(
    consultationRepository as never,
    contextSchemaRepository as never,
    contextSchemaVersionRepository as never,
    eventEmitter as never,
    cls as never,
    tenantSettings as never,
    workflowAssignments as never,
    workflowDefinitionRepository as never,
  );
}

function servableSchema() {
  contextSchemaRepository.findDefaultForScope.mockImplementation(async (_t: string, scope: string) =>
    scope === 'DEPARTMENT' ? { id: 'schema-1', status: 'PUBLISHED', pinnedVersionNumber: 2 } : null,
  );
  contextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue({ id: 'schema-version-1', definition: DEFINITION });
}

describe('LoopConfigService — resolved from the governing definition', () => {
  let service: LoopConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    consultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: TENANT, departmentId: DEPARTMENT });
    contextSchemaRepository.findDefaultForScope.mockResolvedValue(null);
    contextSchemaVersionRepository.findBySchemaAndVersionNumber.mockResolvedValue(null);
    workflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'consultation-default', source: 'department' });
    workflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({ id: 'wfdef-row-7', slug: 'consultation-default', paletteKey: 'consultation' });
    tenantSettings.resolvePlatform.mockReturnValue({ value: 900 });
    tenantSettings.resolve.mockReturnValue({ value: undefined });
    service = makeService();
  });

  it('pins the definition SLUG as agentId and the definition ROW as agentConfigVersionId', async () => {
    servableSchema();

    const config = await service.resolveForConsultation(TENANT, CONSULTATION);

    expect(workflowAssignments.resolve).toHaveBeenCalledWith(TENANT, 'consultation', DEPARTMENT);
    expect(config.enabled).toBe(true);
    expect(config.agentId).toBe('consultation-default');
    // WorkflowDefinition rows ARE versions, so the row id IS the immutable pin —
    // the same guarantee `DepartmentAgentVersion.id` used to give.
    expect(config.agentConfigVersionId).toBe('wfdef-row-7');
    expect(config.contextSchemaVersionId).toBe('schema-version-1');
  });

  it('subscribes to every DECLARED kind except STREAM_AUDIO, with the per-primitive action defaults', async () => {
    servableSchema();

    const config = await service.resolveForConsultation(TENANT, CONSULTATION);

    // `audio_stream` is declared by the schema and deliberately NOT subscribed:
    // an audio stream is a session whose lifecycle the recording controller
    // already owns. Subscribing it would put a second livedoc start/stop into
    // the loop — which is exactly why the seeded day-1 agent omitted it.
    expect(config.subscriptions).toEqual([
      { kindKey: 'work_note', actions: ['client.emit'] },
      { kindKey: 'attachment', actions: ['document.extract_text', 'client.emit'] },
    ]);
    // No subscription is inert: an empty action list is the "running but does
    // nothing" failure mode.
    expect(config.subscriptions.every((s) => s.actions.length > 0)).toBe(true);
  });

  it('runs the platform endpoint sequence when the governing graph declares no endpoint node, and never drives the livedoc lifecycle', async () => {
    servableSchema();

    const config = await service.resolveForConsultation(TENANT, CONSULTATION);

    // TASK-882: the stage is read off the governing graph — node presence + `enabled`, in edge
    // order. A graph that declares no endpoint node (this one) runs the platform default.
    expect(config.startActions).toEqual([]);
    expect(config.endingActions).toEqual(['session.timeout', 'harness.finalize', 'summary.finalize', 'feedback.capture']);
    expect(config.endingActions).not.toContain('livedoc.stop');
    // …and the platform default it is derived FROM does contain it, so this is
    // the audio scoping doing its job rather than a coincidence of the default.
    expect(CONSULTATION_ENDPOINT_ACTIONS_DEFAULT).toContain('livedoc.stop');
  });

  it('honours the endpoint chain the governing graph declares, in edge order (TASK-882)', async () => {
    servableSchema();
    workflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({
      id: 'wfdef-row-7',
      slug: 'consultation-default',
      paletteKey: 'consultation',
      graph: {
        version: 1,
        nodes: [
          { id: 'lock', type: 'summary.finalize', config: {} },
          { id: 'fin', type: 'core.action', config: { actionKey: 'harness.finalize' } },
          { id: 'fb', type: 'feedback.capture', config: { enabled: false } },
        ],
        edges: [
          { id: 'e1', from: 'fin', fromPort: 'next', to: 'lock', toPort: 'after' },
          { id: 'e2', from: 'lock', fromPort: 'next', to: 'fb', toPort: 'after' },
        ],
      },
    });

    const config = await service.resolveForConsultation(TENANT, CONSULTATION);

    expect(config.endingActions).toEqual(['harness.finalize', 'summary.finalize']);
  });

  it('retires the deliberative lane with DepartmentAgentRole — empty roster, reasoning off', async () => {
    servableSchema();

    const config = await service.resolveForConsultation(TENANT, CONSULTATION);

    // The PRIMARY/SPECIALIST roster was expressed entirely in `DepartmentAgentRole`,
    // an enum this ticket drops. The graph substrate has no equivalent, so the
    // lane retires with it — and the Python model's defaults (`agents=[]`,
    // `reasoning_enabled=False`) are exactly this, which is what keeps the
    // frozen loop replay fixture green.
    expect(config.agents).toEqual([]);
    expect(config.reasoningEnabled).toBe(false);
  });

  it('is ENABLED on the schema alone when no definition is assigned', async () => {
    servableSchema();
    workflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' });

    const config = await service.resolveForConsultation(TENANT, CONSULTATION);

    expect(config.enabled).toBe(true);
    expect(config.agentId).toBeNull();
    expect(config.agentConfigVersionId).toBeNull();
    expect(config.contextSchemaVersionId).toBe('schema-version-1');
  });

  it('is DISABLED when neither a definition nor a servable schema resolves', async () => {
    workflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' });

    const config = await service.resolveForConsultation(TENANT, CONSULTATION);

    expect(config.enabled).toBe(false);
    expect(config.subscriptions).toEqual([]);
    expect(config.idleTimeoutSeconds).toBeNull();
  });

  it('NEVER throws — a definition read failure degrades to no definition', async () => {
    servableSchema();
    workflowDefinitionRepository.findPublishedBySlug.mockRejectedValue(new Error('db down'));

    const config = await service.resolveForConsultation(TENANT, CONSULTATION);

    expect(config.enabled).toBe(true);
    expect(config.agentId).toBeNull();
  });

  it('refuses a cross-tenant consultation without leaking it', async () => {
    consultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: 'other-tenant', departmentId: DEPARTMENT });

    const config = await service.resolveForConsultation(TENANT, CONSULTATION);

    expect(config.enabled).toBe(false);
    expect(config.consultationId).toBeNull();
    expect(config.departmentId).toBeNull();
  });

  it('stays disabled for a consultation with no department', async () => {
    consultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: TENANT, departmentId: null });

    const config = await service.resolveForConsultation(TENANT, CONSULTATION);

    expect(config.enabled).toBe(false);
    expect(config.consultationId).toBe(CONSULTATION);
    expect(config.departmentId).toBeNull();
  });
});
