/**
 * ConfigResolver — TASK-882: the graph-node config resolver.
 *
 * `PipelinePolicy` is retired. What used to be a five-toggle policy cascade is now read off the
 * assigned consultation graph (node presence + `enabled`) and, for the one clinician-owned
 * preference, off the doctor's own `UserSettings` row:
 *
 *  - auto-summary        = the graph's generation node(s) are enabled (default ON — an absent
 *                          graph or a graph with no generation node keeps today's behaviour)
 *  - DNA writing style   = an enabled `agent.dna_style` node (tenant gate) AND the doctor's
 *                          `dna.styleEnabled` preference (unset = implicit opt-in)
 *  - DNA redaction       = an enabled `agent.dna_redaction` node AND (unless the node says
 *                          `requireDoctorOptIn: false`) that same doctor preference
 *  - preferred prompt    = `UserProfile.preferredPromptTemplateId` (unchanged)
 *
 * Every DNA read fails CLOSED (OFF) on a degraded lookup; auto-summary fails toward its code
 * default (ON), which is the direction that never silently loses a note.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigResolver } from '../config-resolver.service';
import { DNA_STYLE_PREFERENCE } from '../dna-style-preference';

const TENANT = 'tenant-1';
const DEPT = 'dept-1';
const DOCTOR = 'doctor-1';

const userProfileRepository = { findAll: vi.fn() };
const workflowAssignments = { resolve: vi.fn() };
const workflowDefinitionRepository = { findPublishedBySlug: vi.fn() };
const userSettingsRepository = { findByUserKeyNamespace: vi.fn() };

function makeResolver(): ConfigResolver {
  return new ConfigResolver(userProfileRepository as never, workflowAssignments as never, workflowDefinitionRepository as never, userSettingsRepository as never);
}

type Node = { id: string; type: string; config?: Record<string, unknown> };
function publishGraph(nodes: Node[]) {
  workflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'consultation-soap', source: 'tenant' });
  workflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({ graph: { version: 1, nodes: nodes.map((n) => ({ ...n, config: n.config ?? {} })), edges: [] } });
}
function noGraph() {
  workflowAssignments.resolve.mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' });
  workflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);
}
function preference(value: 'true' | 'false' | null, version = 1) {
  userSettingsRepository.findByUserKeyNamespace.mockResolvedValue(value === null ? null : { id: 'us-1', value, version });
}

beforeEach(() => {
  vi.clearAllMocks();
  noGraph();
  preference(null);
  userProfileRepository.findAll.mockResolvedValue([]);
});

describe('ConfigResolver.resolveAutoSummaryEnabled — the generation node`s `enabled`', () => {
  it('ON when the workflow resolvers are unwired (code default)', async () => {
    await expect(new ConfigResolver().resolveAutoSummaryEnabled({ tenantId: TENANT })).resolves.toBe(true);
  });

  it('ON when no consultation graph is assigned (code default)', async () => {
    await expect(makeResolver().resolveAutoSummaryEnabled({ tenantId: TENANT })).resolves.toBe(true);
  });

  it('ON when the graph declares no generation node at all (nothing to switch off)', async () => {
    publishGraph([{ id: 'guard', type: 'core.action', config: { actionKey: 'guard.phi' } }]);
    await expect(makeResolver().resolveAutoSummaryEnabled({ tenantId: TENANT })).resolves.toBe(true);
  });

  it('ON when the graph`s generation node is enabled', async () => {
    publishGraph([{ id: 'synth', type: 'core.agent', config: { agentRef: { slug: 'soap' } } }]);
    await expect(makeResolver().resolveAutoSummaryEnabled({ tenantId: TENANT })).resolves.toBe(true);
  });

  it('OFF when every generation node the graph declares is switched off', async () => {
    publishGraph([
      { id: 'synth', type: 'core.agent', config: { agentRef: { slug: 'soap' }, enabled: false } },
      { id: 'sum', type: 'core.agent', config: { agentRef: { slug: 'summary' }, enabled: false } },
    ]);
    await expect(makeResolver().resolveAutoSummaryEnabled({ tenantId: TENANT })).resolves.toBe(false);
  });

  it('a core.agent node counts as a generation node; one of several still enabled keeps it ON', async () => {
    publishGraph([{ id: 'a', type: 'core.agent', config: { agentRef: { slug: 'soap' } } }]);
    await expect(makeResolver().resolveAutoSummaryEnabled({ tenantId: TENANT })).resolves.toBe(true);
    publishGraph([
      { id: 'a', type: 'core.agent', config: { agentRef: { slug: 'soap' }, enabled: false } },
      { id: 'b', type: 'core.agent', config: { agentRef: { slug: 'summary' } } },
    ]);
    await expect(makeResolver().resolveAutoSummaryEnabled({ tenantId: TENANT })).resolves.toBe(true);
  });

  it('a core.action is a generation node only when its DELEGATE is generation-classed', async () => {
    // TASK-893 — the class lookup resolves the INSTANCE through the contract's `classesOf`, so a
    // delegated node answers with its ACTION's classes. No KEPT action is `generation`-classed
    // (every agent-shaped key became `core.agent`), which is exactly why a graph of actions alone
    // declares no generation node and auto-summary stays at its ON default.
    publishGraph([{ id: 'a', type: 'core.action', config: { actionKey: 'summary.finalize', enabled: false } }]);
    await expect(makeResolver().resolveAutoSummaryEnabled({ tenantId: TENANT })).resolves.toBe(true);
  });

  it('resolves the assignment for the consultation`s department', async () => {
    publishGraph([{ id: 'synth', type: 'core.agent', config: { agentRef: { slug: 'soap' } } }]);
    await makeResolver().resolveAutoSummaryEnabled({ tenantId: TENANT, departmentId: DEPT });
    expect(workflowAssignments.resolve).toHaveBeenCalledWith(TENANT, 'consultation', DEPT);
  });

  it('degrades to ON (never silently loses a note) when the lookup throws', async () => {
    workflowAssignments.resolve.mockRejectedValue(new Error('down'));
    await expect(makeResolver().resolveAutoSummaryEnabled({ tenantId: TENANT })).resolves.toBe(true);
  });
});

describe('ConfigResolver.resolveDoctorDnaPreference — the clinician`s own opt-out', () => {
  it('reads the `dna` / `styleEnabled` UserSettings row of the doctor', async () => {
    preference('false', 4);
    await expect(makeResolver().resolveDoctorDnaPreference(DOCTOR)).resolves.toEqual({ enabled: false, version: 4 });
    expect(userSettingsRepository.findByUserKeyNamespace).toHaveBeenCalledWith(DOCTOR, DNA_STYLE_PREFERENCE.key, DNA_STYLE_PREFERENCE.namespace);
  });

  it('reports no opinion (null, version 0) when the doctor has no row, no doctor, or no repository', async () => {
    await expect(makeResolver().resolveDoctorDnaPreference(DOCTOR)).resolves.toEqual({ enabled: null, version: 0 });
    await expect(makeResolver().resolveDoctorDnaPreference(null)).resolves.toEqual({ enabled: null, version: 0 });
    await expect(new ConfigResolver().resolveDoctorDnaPreference(DOCTOR)).resolves.toEqual({ enabled: null, version: 0 });
  });

  it('a malformed value is no opinion, and a failed read is no opinion (never a throw)', async () => {
    preference('maybe' as never, 2);
    await expect(makeResolver().resolveDoctorDnaPreference(DOCTOR)).resolves.toEqual({ enabled: null, version: 2 });
    userSettingsRepository.findByUserKeyNamespace.mockRejectedValue(new Error('down'));
    await expect(makeResolver().resolveDoctorDnaPreference(DOCTOR)).resolves.toEqual({ enabled: null, version: 0 });
  });
});

describe('ConfigResolver.resolveEffectiveDnaStyleEnabled — the agent.dna_style NODE and the doctor', () => {
  it('OFF when the workflow resolvers are unwired — fail closed', async () => {
    await expect(new ConfigResolver().resolveEffectiveDnaStyleEnabled({ tenantId: TENANT, doctorId: DOCTOR })).resolves.toEqual({
      effective: false,
      tenantEnabled: false,
      doctorToggle: null,
      doctorPreferenceVersion: 0,
    });
  });

  it('OFF when the governing graph declares no DNA writing-style node, whatever the doctor set', async () => {
    publishGraph([{ id: 'synth', type: 'consultation.synthesize' }]);
    preference('true');
    const r = await makeResolver().resolveEffectiveDnaStyleEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(r.tenantEnabled).toBe(false);
    expect(r.effective).toBe(false);
  });

  it('an ACTIVE node + the doctor`s implicit opt-in ⇒ ON', async () => {
    publishGraph([{ id: 'style', type: 'agent.dna_style', config: { onError: 'degrade' } }]);
    const r = await makeResolver().resolveEffectiveDnaStyleEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(r).toEqual({ effective: true, tenantEnabled: true, doctorToggle: null, doctorPreferenceVersion: 0 });
  });

  it('the doctor`s explicit opt-OUT vetoes an active node — the clinician owns their writing style', async () => {
    publishGraph([{ id: 'style', type: 'agent.dna_style' }]);
    preference('false', 3);
    const r = await makeResolver().resolveEffectiveDnaStyleEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(r).toEqual({ effective: false, tenantEnabled: true, doctorToggle: false, doctorPreferenceVersion: 3 });
  });

  it('TASK-932 — a `core.agent` declaring `dna.enabled` is the DNA node of the `core` vocabulary', async () => {
    publishGraph([{ id: 'n_finalize', type: 'core.agent', config: { agentRef: { slug: 'casenote-finalization' }, dna: { enabled: true } } }]);
    const r = await makeResolver().resolveEffectiveDnaStyleEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(r).toEqual({ effective: true, tenantEnabled: true, doctorToggle: null, doctorPreferenceVersion: 0 });
  });

  it('TASK-932 — a `core.agent` WITHOUT `dna.enabled` declares no DNA pass', async () => {
    publishGraph([{ id: 'n_finalize', type: 'core.agent', config: { agentRef: { slug: 'casenote-finalization' } } }]);
    preference('true');
    const r = await makeResolver().resolveEffectiveDnaStyleEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(r.tenantEnabled).toBe(false);
    expect(r.effective).toBe(false);
  });

  it('a node the tenant switched OFF is not a configured node', async () => {
    publishGraph([{ id: 'style', type: 'agent.dna_style', config: { enabled: false } }]);
    preference('true');
    const r = await makeResolver().resolveEffectiveDnaStyleEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(r.tenantEnabled).toBe(false);
    expect(r.effective).toBe(false);
  });

  it('a core.action delegating to agent.dna_style is the same declaration', async () => {
    publishGraph([{ id: 'style', type: 'core.action', config: { actionKey: 'agent.dna_style' } }]);
    const r = await makeResolver().resolveEffectiveDnaStyleEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(r.effective).toBe(true);
  });

  it('fails CLOSED when the graph lookup throws', async () => {
    workflowAssignments.resolve.mockRejectedValue(new Error('assignment service down'));
    preference('true');
    const r = await makeResolver().resolveEffectiveDnaStyleEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(r.effective).toBe(false);
    expect(r.tenantEnabled).toBe(false);
  });
});

describe('ConfigResolver.resolveEffectiveDnaRedactionEnabled — the agent.dna_redaction NODE and the doctor', () => {
  it('OFF when the workflow resolvers are unwired — no legacy cascade answers any more', async () => {
    const r = await new ConfigResolver().resolveEffectiveDnaRedactionEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(r.effective).toBe(false);
    expect(r.tenantEnabled).toBe(false);
  });

  it('an ACTIVE node + the doctor`s implicit opt-in ⇒ redaction ON', async () => {
    publishGraph([{ id: 'redact', type: 'agent.dna_redaction', config: { onError: 'degrade' } }]);
    const r = await makeResolver().resolveEffectiveDnaRedactionEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(r.tenantEnabled).toBe(true);
    expect(r.doctorToggle).toBeNull();
    expect(r.effective).toBe(true);
  });

  it('NO node in the governing graph ⇒ redaction OFF, whatever the doctor set', async () => {
    publishGraph([{ id: 'note', type: 'consultation.synthesize' }]);
    preference('true');
    const r = await makeResolver().resolveEffectiveDnaRedactionEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(r.effective).toBe(false);
  });

  it('a node the tenant switched OFF is not a configured node', async () => {
    publishGraph([{ id: 'redact', type: 'agent.dna_redaction', config: { enabled: false } }]);
    const r = await makeResolver().resolveEffectiveDnaRedactionEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(r.effective).toBe(false);
  });

  it('the doctor`s DNA opt-OUT still vetoes an active node — the surviving second gate', async () => {
    publishGraph([{ id: 'redact', type: 'agent.dna_redaction' }]);
    preference('false');
    const r = await makeResolver().resolveEffectiveDnaRedactionEnabled({ tenantId: TENANT, doctorId: DOCTOR });
    expect(r.tenantEnabled).toBe(true);
    expect(r.doctorToggle).toBe(false);
    expect(r.effective).toBe(false);
  });

  it('requireDoctorOptIn:false makes the tenant`s placement sufficient', async () => {
    publishGraph([{ id: 'redact', type: 'agent.dna_redaction', config: { requireDoctorOptIn: false } }]);
    preference('false');
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

describe('ConfigResolver.resolvePreferredPromptTemplateId', () => {
  it('returns the doctor profile preferredPromptTemplateId, queried by userId', async () => {
    userProfileRepository.findAll.mockResolvedValue([{ preferredPromptTemplateId: 'tpl-9' }]);
    await expect(makeResolver().resolvePreferredPromptTemplateId(DOCTOR)).resolves.toBe('tpl-9');
    expect(userProfileRepository.findAll).toHaveBeenCalledWith({ where: { userId: DOCTOR } });
  });

  it('returns null when the doctor has no profile / no preferred id / no repository', async () => {
    userProfileRepository.findAll.mockResolvedValue([{ preferredPromptTemplateId: null }]);
    await expect(makeResolver().resolvePreferredPromptTemplateId(DOCTOR)).resolves.toBeNull();
    await expect(new ConfigResolver().resolvePreferredPromptTemplateId(DOCTOR)).resolves.toBeNull();
  });
});
