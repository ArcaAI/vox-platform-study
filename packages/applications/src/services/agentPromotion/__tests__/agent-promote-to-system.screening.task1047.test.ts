/**
 * TASK-1047 D2 — promote-to-system screens the promoted pieces UNDER SYSTEM before anything is
 * written. The promoted text becomes the platform reference every tenant is provisioned from, so a
 * refusal (any of the four codes, guardrail down included) stops the promotion with no SYSTEM row,
 * no copied template and no WORM record. (The SYSTEM publish that follows re-checks through
 * `AgentService.publish`; this early screen is what keeps a refused promotion from leaving a draft.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentPromoteToSystemService } from '../agent-promote-to-system.service';
import { ActionConfirmationService } from '../../settings-registry/action-confirmation.service';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';

/** TASK-1057 — the platform action-confirmation policy at its catalogue defaults. */
const defaultConfirmations = () =>
  new ActionConfirmationService({ resolve: (key: string) => ({ key, value: HOPE_SETTINGS_REGISTRY.getOrThrow(key).default }) } as never);

const GLOBAL = '50000000-0000-0000-0000-000000000000';

const cls = {
  get: vi.fn((key: string) => (key === 'user' ? { id: 'root-1', roles: ['SUPER_ADMIN'] } : undefined)),
  set: vi.fn(),
  run: vi.fn((a: unknown, b?: unknown) => (typeof a === 'function' ? a : (b as () => unknown))()),
};
const agentRepository = { findAllVersionsBySlug: vi.fn(), findOwnActiveBySlug: vi.fn(), findMaxVersionNumber: vi.fn(), create: vi.fn() };
const fallbackRepository = { findByAgentId: vi.fn(async () => []), create: vi.fn() };
const databaseService = { baseClient: { $transaction: vi.fn(async () => Promise.reject(new Error('stop after the screen'))) } };
const registry = { screenAndRegister: vi.fn(), areGoverned: vi.fn(), currentPolicyVersion: vi.fn(), registerPlatformPieces: vi.fn() };

const source = {
  id: 'agent-global-1',
  tenantId: GLOBAL,
  slug: 'gm-summary',
  name: 'GM summary',
  task: 'TEXT_GENERATION',
  versionNumber: 3,
  status: WorkflowDefinitionStatus.PUBLISHED,
  isActive: true,
  modelId: 'model-1',
  contextSchemaId: null,
  instruction: { systemPrompt: 'Summarise {{transcript}}.' },
  compiledConfig: {
    resolvedPrompt: {
      source: 'composite',
      join: '\n\n',
      content: 'Base.',
      fragments: [
        { key: 'base', source: 'inline', content: 'Base.', when: null },
        { key: 'peds', source: 'inline', content: 'Age {{context.age}}.', when: 'x' },
      ],
    },
  },
};

const construct = () =>
  new AgentPromoteToSystemService(
    agentRepository as never,
    fallbackRepository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    databaseService as never,
    { get: vi.fn(() => ({})) } as never,
    { emit: vi.fn() } as never,
    cls as never,
    defaultConfirmations(),
    registry as never,
  );

beforeEach(() => {
  vi.clearAllMocks();
  agentRepository.findOwnActiveBySlug.mockResolvedValue(source);
});

describe('promote-to-system — screening under SYSTEM (TASK-1047 D2)', () => {
  it('screens every promoted piece (pointer-rendered) under SYSTEM before the copy', async () => {
    registry.screenAndRegister.mockResolvedValue({ passed: true, policyVersion: 'pv-1', digests: [], findings: [] });
    await construct()
      .promoteToSystem({ sourceSlug: 'gm-summary', changeReason: 'release' } as never)
      .catch(() => undefined);
    expect(registry.screenAndRegister).toHaveBeenCalledWith(SYSTEM_TENANT_ID, [
      { kind: 'FRAGMENT', sourceType: 'AGENT', sourceId: 'agent-global-1', sourceKey: 'base', text: 'Base.' },
      { kind: 'FRAGMENT', sourceType: 'AGENT', sourceId: 'agent-global-1', sourceKey: 'peds', text: 'Age [see the context_age data section below].' },
    ]);
    expect(databaseService.baseClient.$transaction).toHaveBeenCalled();
  });

  it.each(['PROMPT_SCREENING_INJECTION', 'PROMPT_SCREENING_UNSAFE', 'PROMPT_CONTAINS_PII'])(
    '%s refuses the promotion (409) and writes nothing',
    async (code) => {
      registry.screenAndRegister.mockResolvedValue({
        passed: false,
        policyVersion: 'pv-1',
        digests: [],
        findings: [{ code, pieceKind: 'FRAGMENT', pieceKey: 'peds', digest: 'd'.repeat(64), reason: 'r' }],
      });
      const error = await construct()
        .promoteToSystem({ sourceSlug: 'gm-summary', changeReason: 'release' } as never)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code, findings: [expect.objectContaining({ code, pieceKey: 'peds' })] });
      expect(databaseService.baseClient.$transaction).not.toHaveBeenCalled();
    },
  );

  it('guardrail down refuses the promotion (503) and writes nothing', async () => {
    registry.screenAndRegister.mockResolvedValue({
      passed: false,
      policyVersion: null,
      digests: [],
      findings: [{ code: 'PROMPT_SCREENING_UNAVAILABLE', pieceKind: 'FRAGMENT', pieceKey: 'base', digest: 'd'.repeat(64), reason: 'down' }],
    });
    const error = await construct()
      .promoteToSystem({ sourceSlug: 'gm-summary', changeReason: 'release' } as never)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(databaseService.baseClient.$transaction).not.toHaveBeenCalled();
  });
});
