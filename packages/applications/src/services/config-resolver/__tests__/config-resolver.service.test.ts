/**
 * ConfigResolver unit tests.
 *
 * The generalized realtime-config cascade resolver. Verifies:
 *  1. Code-default fallthrough when no policy rows exist (trace = code-default).
 *  2. SYSTEM-default acts as the platform default below an absent tenant row.
 *  3. tenant overrides system; department overrides tenant; doctor overrides
 *     department — the trace reports the winning tier.
 *  4. NULL toggles inherit (fall through to the next tier).
 *  5. Per-setting MAX SCOPE clamp: `harnessEnabled` is capped at DEPARTMENT, so a
 *     DOCTOR row's `harnessEnabled` is IGNORED (resolution stops at tenant/dept).
 *  6. `resolvePreferredPromptTemplateId` reads UserProfile.preferredPromptTemplateId.
 *
 * The repositories are mocked; the REAL PipelinePolicyFactory builds the rows so
 * nullable-toggle semantics are exercised end to end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelinePolicyFactory, PipelinePolicyScope, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { ConfigResolver } from '../config-resolver.service';

const TENANT = 'tenant-1';
const DEPT = 'dept-1';
const DOCTOR = 'doctor-1';

const pipelinePolicyRepository = {
  findCascadeRows: vi.fn(),
  findSystemDefault: vi.fn(),
};

const userProfileRepository = {
  findAll: vi.fn(),
};

function makeResolver(): ConfigResolver {
  return new ConfigResolver(pipelinePolicyRepository as never, userProfileRepository as never);
}

function tenantRow(toggles: Record<string, boolean | null>) {
  return PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.TENANT, ...toggles });
}
function deptRow(toggles: Record<string, boolean | null>) {
  return PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.DEPARTMENT, scopeId: DEPT, ...toggles });
}
function doctorRow(toggles: Record<string, boolean | null>) {
  return PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TENANT, scope: PipelinePolicyScope.DOCTOR, scopeId: DOCTOR, ...toggles });
}
function systemRow(toggles: Record<string, boolean | null>) {
  return PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: SYSTEM_TENANT_ID, scope: PipelinePolicyScope.TENANT, ...toggles });
}

describe('ConfigResolver.resolvePipelineToggles', () => {
  let resolver: ConfigResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = makeResolver();
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([]);
    pipelinePolicyRepository.findSystemDefault.mockResolvedValue(null);
  });

  it('returns the code defaults (trace=code-default) when no rows exist', async () => {
    const r = await resolver.resolvePipelineToggles({ tenantId: TENANT });

    expect(r.autoSummaryEnabled).toBe(true);
    expect(r.autoNerEnabled).toBe(true);
    expect(r.harnessEnabled).toBe(false);
    expect(r.dnaStyleEnabled).toBe(false);
    expect(r.trace.autoSummaryEnabled).toBe('code-default');
    expect(r.trace.harnessEnabled).toBe('code-default');
  });

  it('uses the SYSTEM default as the platform default below an absent tenant row', async () => {
    pipelinePolicyRepository.findSystemDefault.mockResolvedValue(
      systemRow({ autoSummaryEnabled: true, autoNerEnabled: true, harnessEnabled: true }),
    );

    const r = await resolver.resolvePipelineToggles({ tenantId: TENANT });

    expect(r.harnessEnabled).toBe(true);
    expect(r.trace.harnessEnabled).toBe('system-default');
    // dnaStyleEnabled is null on the system row → code-default
    expect(r.dnaStyleEnabled).toBe(false);
    expect(r.trace.dnaStyleEnabled).toBe('code-default');
  });

  it('lets a tenant row override the system default', async () => {
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([tenantRow({ harnessEnabled: false })]);
    pipelinePolicyRepository.findSystemDefault.mockResolvedValue(systemRow({ harnessEnabled: true }));

    const r = await resolver.resolvePipelineToggles({ tenantId: TENANT });

    expect(r.harnessEnabled).toBe(false);
    expect(r.trace.harnessEnabled).toBe('tenant');
  });

  it('lets a department row override the tenant row', async () => {
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([
      tenantRow({ autoSummaryEnabled: true }),
      deptRow({ autoSummaryEnabled: false }),
    ]);

    const r = await resolver.resolvePipelineToggles({ tenantId: TENANT, departmentId: DEPT });

    expect(r.autoSummaryEnabled).toBe(false);
    expect(r.trace.autoSummaryEnabled).toBe('department');
  });

  it('lets a doctor row override the department row for a DOCTOR-max setting', async () => {
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([
      deptRow({ autoSummaryEnabled: true }),
      doctorRow({ autoSummaryEnabled: false }),
    ]);

    const r = await resolver.resolvePipelineToggles({ tenantId: TENANT, departmentId: DEPT, doctorId: DOCTOR });

    expect(r.autoSummaryEnabled).toBe(false);
    expect(r.trace.autoSummaryEnabled).toBe('doctor');
  });

  it('CLAMPS harnessEnabled at DEPARTMENT — a doctor row cannot override it', async () => {
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([
      tenantRow({ harnessEnabled: false }),
      doctorRow({ harnessEnabled: true }), // out-of-scope: must be ignored
    ]);

    const r = await resolver.resolvePipelineToggles({ tenantId: TENANT, departmentId: DEPT, doctorId: DOCTOR });

    // doctor's harnessEnabled is ignored (max scope = department); falls to tenant.
    expect(r.harnessEnabled).toBe(false);
    expect(r.trace.harnessEnabled).toBe('tenant');
  });

  it('allows a department row to set harnessEnabled (within max scope)', async () => {
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([
      tenantRow({ harnessEnabled: false }),
      deptRow({ harnessEnabled: true }),
    ]);

    const r = await resolver.resolvePipelineToggles({ tenantId: TENANT, departmentId: DEPT });

    expect(r.harnessEnabled).toBe(true);
    expect(r.trace.harnessEnabled).toBe('department');
  });

  it('treats a NULL toggle as inherit (falls through to the next tier)', async () => {
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([tenantRow({ autoSummaryEnabled: null })]);
    pipelinePolicyRepository.findSystemDefault.mockResolvedValue(systemRow({ autoSummaryEnabled: true }));

    const r = await resolver.resolvePipelineToggles({ tenantId: TENANT });

    expect(r.autoSummaryEnabled).toBe(true);
    expect(r.trace.autoSummaryEnabled).toBe('system-default');
  });

  it('degrades to code defaults if the policy lookup throws (fail-safe realtime path)', async () => {
    pipelinePolicyRepository.findCascadeRows.mockRejectedValue(new Error('db down'));

    const r = await resolver.resolvePipelineToggles({ tenantId: TENANT });

    expect(r.autoSummaryEnabled).toBe(true);
    expect(r.harnessEnabled).toBe(false);
  });
});

describe('ConfigResolver.resolvePreferredPromptTemplateId', () => {
  let resolver: ConfigResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = makeResolver();
  });

  it('returns the doctor profile preferredPromptTemplateId, queried by userId', async () => {
    userProfileRepository.findAll.mockResolvedValue([{ preferredPromptTemplateId: 'tpl-9' }]);

    const id = await resolver.resolvePreferredPromptTemplateId(DOCTOR);

    expect(id).toBe('tpl-9');
    expect(userProfileRepository.findAll).toHaveBeenCalledWith({ where: { userId: DOCTOR } });
  });

  it('returns null when the doctor has no profile / no preferred id', async () => {
    userProfileRepository.findAll.mockResolvedValue([{ preferredPromptTemplateId: null }]);
    expect(await resolver.resolvePreferredPromptTemplateId(DOCTOR)).toBeNull();
  });

  it('returns null (no lookup) when doctorId is absent', async () => {
    expect(await resolver.resolvePreferredPromptTemplateId(undefined)).toBeNull();
    expect(userProfileRepository.findAll).not.toHaveBeenCalled();
  });

  it('returns null and swallows lookup errors', async () => {
    userProfileRepository.findAll.mockRejectedValue(new Error('db down'));
    expect(await resolver.resolvePreferredPromptTemplateId(DOCTOR)).toBeNull();
  });
});

/**
 * Effective DNA-style flag = tenant AND doctor.
 *
 * DNA style applies only when the tenant permits it (resolved over the
 * department→tenant→system cascade, DOCTOR scope EXCLUDED) AND the doctor has
 * not opted out. An unset doctor toggle is an implicit opt-in (`?? true`), so a
 * doctor under an enabled tenant is styled by default; a doctor can opt OUT
 * under an enabled tenant, but can never opt IN when the tenant flag is off.
 */
describe('ConfigResolver.resolveEffectiveDnaStyleEnabled', () => {
  let resolver: ConfigResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = makeResolver();
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([]);
    pipelinePolicyRepository.findSystemDefault.mockResolvedValue(null);
  });

  it('unset doctor toggle ⇒ effective follows the tenant flag (enabled)', async () => {
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([tenantRow({ dnaStyleEnabled: true })]);

    const r = await resolver.resolveEffectiveDnaStyleEnabled({ tenantId: TENANT, doctorId: DOCTOR });

    expect(r.tenantEnabled).toBe(true);
    expect(r.doctorToggle).toBeNull();
    expect(r.effective).toBe(true);
  });

  it('unset doctor toggle ⇒ effective follows the tenant flag (disabled)', async () => {
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([tenantRow({ dnaStyleEnabled: false })]);

    const r = await resolver.resolveEffectiveDnaStyleEnabled({ tenantId: TENANT, doctorId: DOCTOR });

    expect(r.tenantEnabled).toBe(false);
    expect(r.effective).toBe(false);
  });

  it('doctor opt-OUT under an enabled tenant ⇒ effective false', async () => {
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([
      tenantRow({ dnaStyleEnabled: true }),
      doctorRow({ dnaStyleEnabled: false }),
    ]);

    const r = await resolver.resolveEffectiveDnaStyleEnabled({ tenantId: TENANT, doctorId: DOCTOR });

    expect(r.tenantEnabled).toBe(true);
    expect(r.doctorToggle).toBe(false);
    expect(r.effective).toBe(false);
  });

  it('doctor cannot opt IN when the tenant flag is off ⇒ effective false', async () => {
    pipelinePolicyRepository.findCascadeRows.mockResolvedValue([
      tenantRow({ dnaStyleEnabled: false }),
      doctorRow({ dnaStyleEnabled: true }),
    ]);

    const r = await resolver.resolveEffectiveDnaStyleEnabled({ tenantId: TENANT, doctorId: DOCTOR });

    expect(r.tenantEnabled).toBe(false);
    expect(r.doctorToggle).toBe(true);
    expect(r.effective).toBe(false);
  });

  it('degrades to effective=false (fail-closed) if the policy lookup throws', async () => {
    pipelinePolicyRepository.findCascadeRows.mockRejectedValue(new Error('db down'));

    const r = await resolver.resolveEffectiveDnaStyleEnabled({ tenantId: TENANT, doctorId: DOCTOR });

    expect(r.effective).toBe(false);
  });
});
