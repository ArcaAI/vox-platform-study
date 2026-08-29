/**
 * TASK-806 lane A, item 2 — DNA-REDACTION becomes a NODE.
 *
 * ## What the owner ruled, and what it replaces
 *
 * The decision was a triple: a tenant `dnaRedactionEnabled` cascade AND the doctor's own DNA
 * opt-in AND the department default `DepartmentAgent.dnaStylePolicy` VETO. TASK-815 deleted the
 * veto with `DepartmentAgent`, and the owner APPROVED that loss with a rider — *"DNA-Redaction
 * must be configured as an agent node"* — because the direction of the loss is that a
 * consultation both surviving gates enable is now actually redacted.
 *
 * So the TENANT gate moves onto the graph: a tenant enables redaction by placing an ACTIVE
 * `agent.dna_redaction` node in its governing consultation definition. The DOCTOR opt-in does NOT
 * move — it is a clinician's own preference over their own writing style, which TASK-815 §12 P-4
 * makes explicit — and the node declares whether it honours it (`requireDoctorOptIn`, default
 * true, which reproduces the surviving two-gate behaviour exactly).
 *
 * ## The `@Optional()` degradation is deliberate and is asserted
 *
 * `ConfigResolver` is constructed positionally in background job processors and a long tail of
 * unit tests. With the workflow resolvers unwired it keeps answering from the legacy
 * `dnaRedactionEnabled` cascade rather than reporting OFF — the same posture
 * `PromptResolutionService` documents for its own optional resolvers. That path is inert on real
 * data (no seed sets `dnaRedactionEnabled`, and its code default is false), so the node is the
 * only thing that can turn redaction on in a wired system.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelinePolicyFactory, PipelinePolicyScope } from '@arcaai/domains';
import { ConfigResolver } from '../config-resolver.service';

const TENANT = 'tenant-dna-1';
const DOCTOR = 'doctor-dna-1';

const pipelinePolicyRepository = { findCascadeRows: vi.fn(), findSystemDefault: vi.fn() };
const userProfileRepository = { findAll: vi.fn() };
const workflowAssignments = { resolve: vi.fn() };
const workflowDefinitionRepository = { findPublishedBySlug: vi.fn() };

function makeResolver(): ConfigResolver {
  return new ConfigResolver(
    pipelinePolicyRepository as never,
    userProfileRepository as never,
    workflowAssignments as never,
    workflowDefinitionRepository as never,
  );
}

function doctorRow(toggles: Record<string, boolean | null>) {
  return PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.DOCTOR, scopeId: DOCTOR, ...toggles });
}

function publishGraph(nodes: unknown[]): void {
  workflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'consultation-default', source: 'tenant' });
  workflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({
    id: 'wfdef-1',
    slug: 'consultation-default',
    paletteKey: 'consultation',
    graph: { version: 1, nodes, edges: [] },
  });
}

describe('DNA redaction is gated by the agent.dna_redaction NODE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([]);
    pipelinePolicyRepository.findSystemDefault.mockResolvedValue(null);
    workflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' });
    workflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);
  });

  it('an ACTIVE node + the doctor`s implicit opt-in ⇒ redaction ON', async () => {
    publishGraph([{ id: 'redact', type: 'agent.dna_redaction', config: { onError: 'degrade' } }]);

    const r = await makeResolver().resolveEffectiveDnaRedactionEnabled({ tenantId: TENANT, doctorId: DOCTOR });

    expect(r.tenantEnabled).toBe(true);
    expect(r.doctorToggle).toBeNull();
    expect(r.effective).toBe(true);
  });

  it('NO node in the governing graph ⇒ redaction OFF, whatever the doctor set', async () => {
    publishGraph([{ id: 'note', type: 'consultation.synthesize', config: {} }]);
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([doctorRow({ dnaStyleEnabled: true })]);

    const r = await makeResolver().resolveEffectiveDnaRedactionEnabled({ tenantId: TENANT, doctorId: DOCTOR });

    expect(r.tenantEnabled).toBe(false);
    expect(r.effective).toBe(false);
  });

  it('a node the tenant switched OFF is not a configured node', async () => {
    publishGraph([{ id: 'redact', type: 'agent.dna_redaction', config: { enabled: false } }]);

    const r = await makeResolver().resolveEffectiveDnaRedactionEnabled({ tenantId: TENANT, doctorId: DOCTOR });

    expect(r.effective).toBe(false);
  });

  it('the doctor`s DNA opt-OUT still vetoes an active node — the surviving second gate', async () => {
    publishGraph([{ id: 'redact', type: 'agent.dna_redaction', config: {} }]);
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([doctorRow({ dnaStyleEnabled: false })]);

    const r = await makeResolver().resolveEffectiveDnaRedactionEnabled({ tenantId: TENANT, doctorId: DOCTOR });

    expect(r.tenantEnabled).toBe(true);
    expect(r.doctorToggle).toBe(false);
    expect(r.effective).toBe(false);
  });

  it('requireDoctorOptIn:false makes the tenant`s placement sufficient', async () => {
    publishGraph([{ id: 'redact', type: 'agent.dna_redaction', config: { requireDoctorOptIn: false } }]);
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([doctorRow({ dnaStyleEnabled: false })]);

    const r = await makeResolver().resolveEffectiveDnaRedactionEnabled({ tenantId: TENANT, doctorId: DOCTOR });

    expect(r.effective).toBe(true);
  });

  it('fails CLOSED when the graph lookup throws — a note expected redacted must never slip through', async () => {
    workflowAssignments.resolve.mockRejectedValue(new Error('assignment service down'));

    const r = await makeResolver().resolveEffectiveDnaRedactionEnabled({ tenantId: TENANT, doctorId: DOCTOR });

    expect(r.effective).toBe(false);
    expect(r.tenantEnabled).toBe(false);
  });
});
